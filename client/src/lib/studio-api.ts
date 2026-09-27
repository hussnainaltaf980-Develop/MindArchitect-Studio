// Studio transport. The project's client talks to the OpenAI-shaped surface:
// /v1/chat/completions (SSE), /v1/models, /v1/health, /v1/lab/*. Those routes
// exist in the original app as server handlers; here they are served by this
// app's Hono API so the SAME client code has something real to read.
export type ChatRole = "system" | "user" | "assistant";
export type ChatTurn = { role: ChatRole; content: string };

/**
 * Reply verbosity. Defined HERE rather than in the store because it is a
 * transport option that is sent to the server — and because defining it in the
 * store made `studio-store ⇄ studio-api` a cycle.
 */
export type ReplyStyle = "concise" | "balanced" | "thorough";

const SSE_DONE = "[DONE]";

/**
 * Which plane produced a reply.
 *
 * `gateway` = a hosted model answered and its deltas streamed through.
 * `local`   = the deterministic expert plane answered from recorded project
 *             knowledge. No hosted model was reached.
 *
 * The header and every event carry exactly one of these, so a client never has
 * to infer the engine from the text.
 */
export type EnginePlane = "gateway" | "local";

const ENGINE_PLANES: readonly string[] = ["gateway", "local"];

function asPlane(raw: string | undefined | null): EnginePlane | null {
  return raw && ENGINE_PLANES.includes(raw) ? (raw as EnginePlane) : null;
}

function extractData(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) return null;
  return line.slice(5).trim();
}

export type GatewayStatus = {
  configured: boolean;
  enabled: boolean;
  usable: boolean;
  reachable: boolean;
  status: string;
  /** The NAME of the env var the key came from — never any part of its value. */
  keySource: string | null;
  /** Which variable switched the gateway off, when one did. */
  disabledBy: string | null;
  baseUrl: string;
  baseUrlIsDefault: boolean;
  model: string;
  /** True when the model id came from the provider default, not an explicit env var. */
  modelIsDefault: boolean;
  httpStatus: number | null;
  latencyMs: number;
  checkedAt: string;
  detail: string | null;
  timeoutMs: number;
  firstChunkTimeoutMs: number;
};

export type CatalogueEntry = {
  id: string;
  name: string;
  badge: string;
  series: string;
  role: string;
  vibe: string;
  ctx: string;
  params: string;
  competitor: string;
  available: boolean;
  minTier: string;
  status: string;
  note: string;
  routing?: string;
  probe?: {
    final_loss?: number;
    final_ppl?: number;
    token_accuracy?: number;
    param_count?: number;
  };
};

export async function fetchModels(): Promise<{
  data: CatalogueEntry[];
  gateway_live: boolean;
  gateway?: GatewayStatus;
  generated_at: string;
}> {
  const response = await fetch("/v1/models");
  if (!response.ok) throw new Error(`Registry ${response.status}`);
  return (await response.json()) as {
    data: CatalogueEntry[];
    gateway_live: boolean;
    gateway?: GatewayStatus;
    generated_at: string;
  };
}

export type HealthPayload = {
  status: string;
  service: string;
  version: string;
  gateway_live: boolean;
  gateway?: GatewayStatus;
  gateway_reason?: string | null;
  cognitive: string;
  forge: { available: boolean; status?: unknown; final_loss?: unknown; param_count?: unknown };
  smoke?: {
    available?: boolean;
    vocab_size?: unknown;
    param_count?: unknown;
    final_loss?: unknown;
  };
  uptime_s: number;
};

/** `force` bypasses the server's 30s probe cache — used by the re-probe button. */
export async function fetchHealth(force = false): Promise<HealthPayload> {
  const response = await fetch(force ? "/v1/health?force=1" : "/v1/health");
  if (!response.ok) throw new Error("Health probe failed");
  return (await response.json()) as HealthPayload;
}

export type LabStatus = {
  dataset_rows: number;
  verified_rows: number;
  last_train: Record<string, unknown> | null;
  last_eval: Record<string, unknown> | null;
  last_synth: Record<string, unknown> | null;
};

export async function labStatus(): Promise<LabStatus> {
  const response = await fetch("/v1/lab/status");
  if (!response.ok) throw new Error("Lab status failed");
  return (await response.json()) as LabStatus;
}

export async function labRun(
  kind: "synthesize" | "train" | "eval",
): Promise<{ ok: boolean; log?: string; error?: string; result?: unknown }> {
  const response = await fetch(`/v1/lab/${kind}`, { method: "POST" });
  const data = (await response.json()) as {
    ok: boolean;
    log?: string;
    error?: string;
    result?: unknown;
  };
  if (!response.ok) throw new Error(data.error || `${kind} failed`);
  return data;
}

/** Streaming chat completion over SSE. */
export async function streamChatCompletion(
  messages: ChatTurn[],
  opts: {
    signal?: AbortSignal;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    style?: ReplyStyle;
    documents?: { filename: string; text: string }[];
    memories?: string[];
    onToken: (token: string) => void;
    onEngine?: (engine: EnginePlane, reason: string) => void;
  },
): Promise<void> {
  const response = await fetch("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      model: opts.model ?? "mindarchitect-synapse-v5.0",
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1400,
      style: opts.style ?? "balanced",
      documents: opts.documents,
      memories: opts.memories,
    }),
    signal: opts.signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(detail.slice(0, 280) || `Chat failed (${response.status})`);
  }

  // The header is the authoritative statement of which plane answered — it is
  // written before the first body byte, so it cannot disagree with the stream.
  const headerEngine = asPlane(response.headers.get("x-ma-engine"));
  const headerReason = response.headers.get("x-ma-engine-reason") ?? "ok";
  if (headerEngine) opts.onEngine?.(headerEngine, headerReason);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        for (const raw of event.split("\n")) {
          const payload = extractData(raw);
          if (payload === null) continue;
          if (payload === SSE_DONE) return;
          try {
            const chunk = JSON.parse(payload) as {
              ma_engine?: string;
              ma_engine_reason?: string;
              error?: { code?: string; message?: string };
              choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
            };
            const plane = asPlane(chunk.ma_engine);
            if (plane) opts.onEngine?.(plane, chunk.ma_engine_reason ?? "ok");

            // A mid-stream gateway failure arrives in-band: the status line is
            // long gone, so this is the only place it can be reported. Surface
            // it instead of ending on a silently truncated reply.
            if (chunk.error) {
              throw new Error(
                chunk.error.message
                  ? `${chunk.error.message}${chunk.error.code ? ` (${chunk.error.code})` : ""}`
                  : "The gateway stream failed.",
              );
            }

            const choice = chunk.choices?.[0];
            const token = choice?.delta?.content;
            if (token) opts.onToken(token);
            if (choice?.finish_reason === "error") {
              throw new Error("The gateway stream ended early. The reply above is partial.");
            }
          } catch {
            /* skip malformed SSE */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
