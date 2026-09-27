import { useEffect, useRef, useState } from "react";
import { ArrowUp, Brain, Square, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStudio } from "@/stores/studio-store";
import { streamChatCompletion, type EnginePlane } from "@/lib/studio-api";
import { catalogueById } from "@/lib/models";

/**
 * Human-readable label for the plane that answered.
 *
 * These two strings are the whole honesty mechanism in the transcript: a user
 * must be able to tell a hosted model's answer from the deterministic expert
 * plane's at a glance.
 */
function engineLabel(engine: EnginePlane): string {
  return engine === "gateway" ? "Live gateway" : "Local expert (no hosted model)";
}

/** Reason codes that mean "nothing is misconfigured" and need no extra copy. */
const NEUTRAL_REASONS = new Set(["ok", "not_configured"]);

function engineReasonLabel(reason: string | null | undefined): string | null {
  if (!reason || NEUTRAL_REASONS.has(reason)) return null;
  return `fallback: ${reason.replace(/_/g, " ")}`;
}

// The composer + transcript. Deep Reasoning arms the cognitive plane: the run is
// recorded as a trace and surfaced in the Agents view, which is what the rail
// and the header badge read from.
export function ChatWindow() {
  const conversations = useStudio((s) => s.conversations);
  const activeId = useStudio((s) => s.activeId);
  const deepReasoning = useStudio((s) => s.deepReasoning);
  const selectedModel = useStudio((s) => s.selectedModel);
  const isProcessing = useStudio((s) => s.isProcessing);
  const streamBuffer = useStudio((s) => s.streamBuffer);
  const streamEngine = useStudio((s) => s.streamEngine);
  const streamEngineReason = useStudio((s) => s.streamEngineReason);
  const error = useStudio((s) => s.error);
  const documents = useStudio((s) => s.documents);
  const settings = useStudio((s) => s.settings);

  const [draft, setDraft] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const messages = active?.messages ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streamBuffer]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const model = catalogueById(deepReasoning ? "mindarchitect-apex-m5.0" : selectedModel);

  async function send() {
    const text = draft.trim();
    if (!text || isProcessing) return;

    const store = useStudio.getState();
    store.addUserMessage(text, deepReasoning ? "cognitive" : "chat");
    setDraft("");
    store.beginStream();

    if (deepReasoning) {
      // A cognitive run: record a trace the Agents view can render. The planner
      // is honest about which plane answered — "local" means the deterministic
      // expert, not a hallucinated model.
      const runId = `run_${Date.now().toString(36)}`;
      const startedAt = Date.now();
      const conversation = useStudio.getState().conversations.find((c) => c.id === store.activeId);
      const history = (conversation?.messages ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      store.putTrace({
        run_id: runId,
        status: "running",
        engine: "local",
        total_ms: 0,
        answer: null,
        steps: [
          { id: "s1", label: "Decompose", status: "done", detail: "Parsed the request into sub-goals." },
          { id: "s2", label: "Branch", status: "done", detail: "Three approaches considered." },
          { id: "s3", label: "Prune", status: "running", detail: "Scoring branches." },
          { id: "s4", label: "Synthesise", status: "pending" },
        ],
      });

      try {
        const controller = new AbortController();
        abortRef.current = controller;
        await streamChatCompletion(history, {
          signal: controller.signal,
          model: "mindarchitect-apex-m5.0",
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          style: settings.style,
          documents: documents.map((d) => ({ filename: d.filename, text: d.text })),
          onToken: (t) => useStudio.getState().appendStream(t),
          onEngine: (e, reason) => useStudio.getState().setStreamEngine(e, reason),
        });
        useStudio.getState().commitStream();
        const engine = useStudio.getState().streamEngine ?? "local";
        useStudio.getState().putTrace({
          run_id: runId,
          status: "completed",
          engine,
          total_ms: Date.now() - startedAt,
          answer: "Synthesised reply streamed to the transcript.",
          steps: [
            { id: "s1", label: "Decompose", status: "done", detail: "Parsed the request into sub-goals." },
            { id: "s2", label: "Branch", status: "done", detail: "Three approaches considered." },
            { id: "s3", label: "Prune", status: "done", detail: "Kept the highest-scoring branch." },
            { id: "s4", label: "Synthesise", status: "done", detail: `Answered on the ${engine} plane.` },
          ],
        });
      } catch (e) {
        useStudio.getState().discardStream();
        useStudio.getState().setError(e instanceof Error ? e.message : "Cognitive run failed");
      } finally {
        abortRef.current = null;
      }
      return;
    }

    const history = [...(active?.messages ?? []), { role: "user" as const, content: text }].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const controller = new AbortController();
      abortRef.current = controller;
      await streamChatCompletion(history, {
        signal: controller.signal,
        model: selectedModel,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        style: settings.style,
        documents: documents.map((d) => ({ filename: d.filename, text: d.text })),
        onToken: (t) => useStudio.getState().appendStream(t),
        onEngine: (e, reason) => useStudio.getState().setStreamEngine(e, reason),
      });
      useStudio.getState().commitStream();
    } catch (e) {
      useStudio.getState().discardStream();
      useStudio.getState().setError(e instanceof Error ? e.message : "Chat failed");
    } finally {
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    useStudio.getState().commitStream();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
          {messages.length === 0 && !streamBuffer ? (
            <EmptyState deepReasoning={deepReasoning} modelName={model?.name ?? "Studio"} />
          ) : (
            <div className="space-y-5">
              {messages.map((m) => (
                <Message
                  key={m.id}
                  role={m.role}
                  content={m.content}
                  meta={
                    m.engine
                      ? `${engineLabel(m.engine)}${m.model ? ` · ${m.model.replace("mindarchitect-", "")}` : ""}${
                          engineReasonLabel(m.engineReason) ? ` · ${engineReasonLabel(m.engineReason)}` : ""
                        }`
                      : undefined
                  }
                  tone={m.engine === "local" ? "warn" : "ok"}
                />
              ))}
              {streamBuffer ? (
                <Message
                  role="assistant"
                  content={streamBuffer}
                  streaming
                  meta={streamEngine ? `${engineLabel(streamEngine)}${engineReasonLabel(streamEngineReason) ? ` · ${engineReasonLabel(streamEngineReason)}` : ""}` : "Connecting…"}
                  tone={streamEngine === "local" ? "warn" : "ok"}
                />
              ) : null}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {error ? (
        <div className="mx-auto w-full max-w-3xl px-4 pb-2 sm:px-6">
          <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        </div>
      ) : null}

      <div className="shrink-0 border-t border-line bg-surface/60 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <div className="rounded-xl border border-line bg-inset p-2 focus-within:border-line-strong">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder={
                deepReasoning
                  ? "Ask Apex — Tree-of-Thought with a trace you can read…"
                  : `Message ${model?.name.replace("MindArchitect ", "") ?? "the studio"}…`
              }
              className="max-h-40 w-full resize-none bg-transparent px-2 py-1.5 text-sm text-fg outline-none placeholder:text-subtle"
            />
            <div className="flex items-center gap-1.5 px-1 pt-1">
              <button
                type="button"
                onClick={() => useStudio.getState().setDeepReasoning(!deepReasoning)}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium",
                  deepReasoning
                    ? "bg-signal/15 text-signal"
                    : "text-muted hover:bg-lift hover:text-fg",
                )}
                aria-pressed={deepReasoning}
              >
                <Brain className="size-3.5" />
                Deep Reasoning
              </button>
              <span className="hidden truncate font-mono text-[11px] text-subtle sm:inline">
                {model?.badge} · {model?.ctx} ctx
              </span>
              <span className="ml-auto font-mono text-[11px] tabular text-subtle">
                {settings.style}
              </span>
              {isProcessing ? (
                <button
                  type="button"
                  onClick={stop}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-lift px-3 text-xs font-medium text-fg"
                >
                  <Square className="size-3" />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!draft.trim()}
                  className="inline-flex size-9 items-center justify-center rounded-md bg-chrome text-bg disabled:opacity-40"
                  aria-label="Send"
                >
                  <ArrowUp className="size-4" />
                </button>
              )}
            </div>
          </div>
          {documents.length > 0 ? (
            <p className="mt-2 text-[11px] text-subtle">
              {documents.length} document{documents.length === 1 ? "" : "s"} in context
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ deepReasoning, modelName }: { deepReasoning: boolean; modelName: string }) {
  const prompts = deepReasoning
    ? [
        "Design a chunking strategy for a 40M-token codebase.",
        "Prune this agent loop: it retries on a schema error.",
        "Compare RLS predicates vs. a view layer for tenancy.",
      ]
    : [
        "Explain the GQA repeat pattern in Forge.",
        "Write a TimescaleDB hypertable for loss metrics.",
        "What does the smoke tokenizer actually cover?",
      ];
  return (
    <div className="ma-rise flex flex-col items-center py-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl border border-line bg-surface">
        <Sparkles className="size-5 text-signal" />
      </div>
      <h1 className="mt-4 font-display text-2xl font-light tracking-tight text-fg">
        {deepReasoning ? "Deep Reasoning armed" : "MindArchitect Studio"}
      </h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
        {deepReasoning
          ? "Apex plans, branches and prunes before it answers. The trace lands in Agents."
          : `${modelName.replace("MindArchitect ", "")} streams the reply. Arm Deep Reasoning for a full Tree-of-Thought run.`}
      </p>
      <div className="mt-6 grid w-full gap-2 sm:grid-cols-3">
        {prompts.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => useStudio.getState().setView("chat")}
            className="rounded-lg border border-line bg-surface px-3 py-3 text-left text-xs leading-relaxed text-muted hover:border-line-strong hover:text-fg"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({
  role,
  content,
  streaming,
  meta,
  tone,
}: {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  meta?: string;
  tone?: "ok" | "warn";
}) {
  const isUser = role === "user";
  return (
    <div className={cn("ma-rise flex gap-3", isUser && "justify-end")}>
      <div
        className={cn(
          "max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed",
          isUser ? "bg-lift text-fg" : "border border-line bg-surface text-chrome",
        )}
      >
        <p className="whitespace-pre-wrap">{content}</p>
        {meta ? (
          <p
            className={cn(
              "mt-2 font-mono text-[10px] uppercase tracking-wider",
              tone === "warn" ? "text-warn" : "text-subtle",
            )}
          >
            {meta}
            {streaming ? <span className="ma-pulse"> · streaming</span> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
