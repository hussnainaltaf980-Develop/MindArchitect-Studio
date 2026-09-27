import { useEffect, useState } from "react";
import { Cpu, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStudio } from "@/stores/studio-store";

// Cognitive-run traces. A run appears here the moment Deep Reasoning is used,
// with its branch plan and step timeline read from the studio store.
export function AgentsPanel() {
  const traces = useStudio((s) => s.traces);
  const activeRunId = useStudio((s) => s.activeRunId);
  const ordered = Object.keys(traces).reverse();
  const active = activeRunId ? traces[activeRunId] : undefined;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-full max-w-sm shrink-0 overflow-y-auto scroll-thin border-r border-line p-3 lg:w-80">
        <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wider text-subtle">
          Cognitive runs
        </p>
        {ordered.length === 0 ? (
          <div className="px-1">
            <p className="text-sm text-muted">No runs yet.</p>
            <button
              type="button"
              className="mt-3 h-11 rounded-md bg-chrome px-4 text-sm font-medium text-bg"
              onClick={() => {
                useStudio.getState().setDeepReasoning(true);
                useStudio.getState().setView("chat");
              }}
            >
              Arm Deep Reasoning
            </button>
          </div>
        ) : (
          ordered.map((id) => {
            const t = traces[id];
            return (
              <button
                key={id}
                type="button"
                onClick={() => useStudio.getState().setActiveRun(id)}
                className={cn(
                  "mb-1 w-full rounded-md border px-3 py-2.5 text-left",
                  id === activeRunId
                    ? "border-signal/40 bg-lift"
                    : "border-line bg-surface hover:bg-lift/60",
                )}
              >
                <p className="truncate text-xs text-fg">{t?.run_id ?? "Run"}</p>
                <p className="mt-0.5 font-mono text-[10px] text-subtle">{id}</p>
                <p className="mt-1 text-[11px] text-muted">
                  {t?.status} · {t?.steps.length ?? 0} steps · {t?.engine}
                </p>
              </button>
            );
          })
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto scroll-thin p-4 sm:p-6">
        {!active ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <GitBranch className="size-5 text-subtle" />
            <p className="mt-3 text-sm text-muted">Select a run to read its trace.</p>
          </div>
        ) : (
          <div className="mx-auto max-w-xl">
            <div className="flex items-center gap-2">
              <Cpu className="size-4 text-signal" />
              <h3 className="font-display text-lg text-fg">{active.run_id}</h3>
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-2">
              <Meta label="Status" value={active.status} tone={active.status === "completed" ? "ok" : "warn"} />
              <Meta label="Engine" value={active.engine} tone={active.engine === "live" ? "ok" : "warn"} />
              <Meta label="Elapsed" value={`${(active.total_ms / 1000).toFixed(1)}s`} />
            </dl>
            <ol className="mt-6 space-y-2">
              {active.steps.map((s) => (
                <li
                  key={s.id}
                  className="rounded-md border border-line bg-surface px-3 py-2.5"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-fg">{s.label}</p>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 font-mono text-[10px]",
                        s.status === "done"
                          ? "bg-ok/15 text-ok"
                          : s.status === "running"
                            ? "bg-warn/15 text-warn"
                            : "bg-lift text-subtle",
                      )}
                    >
                      {s.status}
                    </span>
                  </div>
                  {s.detail ? (
                    <p className="mt-1 text-[11px] leading-relaxed text-muted">{s.detail}</p>
                  ) : null}
                </li>
              ))}
            </ol>
            {active.answer ? (
              <p className="mt-6 rounded-lg border border-line bg-inset px-3 py-3 text-sm text-chrome">
                {active.answer}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-subtle">{label}</p>
      <p
        className={cn(
          "mt-0.5 font-mono text-xs",
          tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-chrome",
        )}
      >
        {value}
      </p>
    </div>
  );
}

// ── Memory ────────────────────────────────────────────────────────────────────
// Three tiers, persisted on this device. Working/episodic are derived from the
// studio store; semantic is user-authored — an honest stand-in for a vector
// store, and labelled as such in the panel copy.
export function MemoryPanel() {
  const conversations = useStudio((s) => s.conversations);
  const traces = useStudio((s) => s.traces);
  const [layer, setLayer] = useState<"working" | "episodic" | "semantic">("working");
  const [facts, setFacts] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  const STORAGE_KEY = "ma.studio.facts.v1";
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setFacts(JSON.parse(raw) as string[]);
    } catch {
      /* ignore */
    }
  }, []);

  const persist = (next: string[]) => {
    setFacts(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const LAYERS = [
    { id: "working" as const, label: "Working", hint: "Current session context" },
    { id: "episodic" as const, label: "Episodic", hint: "Completed cognitive runs" },
    { id: "semantic" as const, label: "Semantic", hint: "Stable facts you store" },
  ];

  const items =
    layer === "working"
      ? conversations.slice(0, 12).map((c) => ({
          id: c.id,
          content: `${c.title} — ${c.messages.length} message(s)`,
        }))
      : layer === "episodic"
        ? Object.values(traces).map((t) => ({
            id: t.run_id,
            content: `${t.status} · ${t.engine} · ${t.steps.length} steps · ${(t.total_ms / 1000).toFixed(1)}s`,
          }))
        : facts.map((f, i) => ({ id: `fact_${i}`, content: f }));

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto scroll-thin px-4 py-8 sm:px-8">
      <h2 className="font-display text-xl font-medium text-fg">Hierarchical memory</h2>
      <p className="mt-1 text-sm text-muted">
        Three tiers: working context, episodic traces from Deep Reasoning, and semantic facts.
      </p>

      <div className="mt-5 flex gap-1 rounded-lg bg-surface p-1">
        {LAYERS.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => setLayer(l.id)}
            className={cn(
              "flex-1 rounded-md px-3 py-2 text-xs font-medium",
              layer === l.id ? "bg-lift text-fg" : "text-muted hover:text-fg",
            )}
          >
            {l.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-subtle">{LAYERS.find((l) => l.id === layer)?.hint}</p>

      {layer === "semantic" ? (
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            persist([draft.trim(), ...facts]);
            setDraft("");
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Store a fact…"
            className="h-11 flex-1 rounded-md border border-line bg-inset px-3 text-sm text-fg outline-none placeholder:text-subtle"
          />
          <button
            type="submit"
            className="h-11 rounded-md bg-chrome px-4 text-sm font-medium text-bg"
          >
            Remember
          </button>
        </form>
      ) : null}

      <ul className="mt-6 space-y-2">
        {items.length === 0 ? (
          <li className="text-sm text-muted">Empty layer.</li>
        ) : (
          items.map((m) => (
            <li key={m.id} className="rounded-md border border-line bg-surface px-4 py-3">
              <p className="whitespace-pre-wrap text-sm text-chrome">{m.content}</p>
              <div className="mt-2 flex items-center justify-between text-[11px] text-subtle">
                <span className="font-mono">{m.id}</span>
                {layer === "semantic" ? (
                  <button
                    type="button"
                    className="text-muted hover:text-danger"
                    onClick={() =>
                      persist(facts.filter((f) => `fact_${facts.indexOf(f)}` !== m.id))
                    }
                  >
                    Forget
                  </button>
                ) : null}
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

// ── Documents ─────────────────────────────────────────────────────────────────
export function DocumentsPanel() {
  const docs = useStudio((s) => s.documents);
  const [dragOver, setDragOver] = useState(false);

  const ingest = async (files: FileList | File[] | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const text = await file.text();
      const words = text.split(/\s+/).filter(Boolean).length;
      useStudio.getState().addDocument({
        id: `doc_${Date.now().toString(36)}_${file.name}`,
        filename: file.name,
        sizeBytes: file.size,
        text,
        chunkCount: Math.max(1, Math.ceil(words / 400)),
        createdAt: new Date().toISOString(),
      });
    }
  };

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto scroll-thin px-4 py-8 sm:px-8">
      <h2 className="font-display text-xl font-medium text-fg">Documents</h2>
      <p className="mt-1 text-sm text-muted">
        Ingest text into the studio's context store. Chunks are attached to Deep Reasoning
        context when present.
      </p>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void ingest(e.dataTransfer.files);
        }}
        className={cn(
          "mt-6 flex w-full cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-10 text-sm",
          dragOver
            ? "border-signal/60 bg-signal/5 text-fg"
            : "border-line bg-surface text-muted hover:border-signal/40 hover:text-fg",
        )}
      >
        <span className="mb-2 text-base">Drop files or click to choose</span>
        <span className="text-xs text-subtle">.txt, .md, .py, .json, .csv, .yml</span>
        <input
          type="file"
          multiple
          accept=".txt,.md,.py,.json,.csv,.yml,.yaml"
          className="hidden"
          onChange={(e) => void ingest(e.target.files)}
        />
      </label>

      <ul className="mt-6 space-y-2">
        {docs.map((d) => (
          <li
            key={d.id}
            className="flex items-center justify-between rounded-md border border-line bg-surface px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-fg">{d.filename}</p>
              <p className="tabular text-[11px] text-subtle">
                {d.chunkCount} chunks · {(d.sizeBytes / 1024).toFixed(1)} KB
              </p>
            </div>
            <button
              type="button"
              onClick={() => useStudio.getState().removeDocument(d.id)}
              className="rounded-md px-3 py-2 text-xs text-subtle hover:text-danger"
              aria-label={`Delete ${d.filename}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
