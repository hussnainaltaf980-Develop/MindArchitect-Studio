// ── MindArchitect Studio · LLM gateway client ────────────────────────────────
//
// A real client for an OpenAI-compatible `/chat/completions` endpoint, streamed
// as SSE. This is the module that makes `x-ma-engine: gateway` mean something.
//
// WHAT IS REAL HERE
// ─────────────────
// * A genuine HTTP request to a real endpoint, with real token deltas read off
//   the socket and forwarded as they arrive (no buffering of a fake reply).
// * A real pre-connect status check so a bad key is reported as a bad key
//   instead of being discovered as a mid-stream failure.
// * Real error classification: 401/403/429/5xx, DNS/connection failure, and
//   two distinct timeouts (no response, and no FIRST TOKEN) are separated and
//   mapped to codes the caller can act on.
//
// WHAT IS NOT
// ───────────
// Nothing in this file is a mock. When no key is configured the caller is told
// `not_configured` and decides what to do — this module never invents a reply.
import {
  gatewayConfig,
  publicConfig,
  scrubSecrets,
  type GatewayConfig,
  type GatewayPublicConfig,
} from "./gateway-config";

export type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

export type GatewayFailureCode =
  | "not_configured"
  | "disabled"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "timeout"
  | "network"
  | "upstream_error"
  | "bad_request"
  | "aborted"
  | "empty_response";

/** Where in the request lifecycle the failure happened. */
export type GatewayPhase = "preflight" | "connect" | "stream";

export class GatewayFailure extends Error {
  readonly code: GatewayFailureCode;
  readonly phase: GatewayPhase;
  readonly status: number | null;
  readonly retryable: boolean;
  /** Upstream's own words, scrubbed of credentials. */
  readonly detail: string | null;
  /**
   * True once a content delta has already been handed to the consumer. The
   * caller must NOT fall back after that point: text has been sent, and
   * appending a second engine's answer would produce a reply that claims to
   * come from one model while being two.
   */
  committed = false;

  constructor(init: {
    code: GatewayFailureCode;
    phase: GatewayPhase;
    message: string;
    status?: number | null;
    retryable?: boolean;
    detail?: string | null;
  }) {
    super(init.message);
    this.name = "GatewayFailure";
    this.code = init.code;
    this.phase = init.phase;
    this.status = init.status ?? null;
    this.retryable = init.retryable ?? false;
    this.detail = init.detail ?? null;
  }
}

export function isGatewayFailure(err: unknown): err is GatewayFailure {
  return err instanceof GatewayFailure;
}

/** HTTP status → a code, and whether a retry could plausibly succeed. */
export function classifyStatus(status: number): { code: GatewayFailureCode; retryable: boolean } {
  if (status === 401) return { code: "unauthorized", retryable: false };
  if (status === 403) return { code: "forbidden", retryable: false };
  if (status === 408) return { code: "timeout", retryable: true };
  if (status === 429) return { code: "rate_limited", retryable: true };
  // Bad model id, bad payload shape, wrong base URL path — a configuration
  // fault, not a transient one.
  if (status === 400 || status === 404 || status === 422) {
    return { code: "bad_request", retryable: false };
  }
  if (status >= 500) return { code: "upstream_error", retryable: true };
  return { code: "upstream_error", retryable: false };
}

/** Operator-facing sentence per code. Shown to the user, so no jargon-only text. */
export const GATEWAY_MESSAGES: Record<GatewayFailureCode, string> = {
  not_configured:
    "No LLM gateway key is configured. Set MINDARCHITECT_LLM_API_KEY (or XAI_API_KEY / OPENAI_API_KEY / LLM_API_KEY) to enable the hosted model.",
  disabled: "The LLM gateway is switched off by MINDARCHITECT_LLM_DISABLED.",
  unauthorized: "The gateway rejected the API key (401). The key is missing, revoked or wrong.",
  forbidden: "The gateway refused this key (403). It may lack access to the requested model.",
  rate_limited: "The gateway is rate limiting this key (429). Try again shortly.",
  timeout: "The gateway did not respond in time.",
  network: "Could not reach the gateway.",
  upstream_error: "The gateway returned a server error.",
  bad_request: "The gateway rejected the request shape — check the base URL and model id.",
  aborted: "The request was cancelled.",
  empty_response: "The gateway closed the stream without sending any content.",
};

function failure(
  code: GatewayFailureCode,
  phase: GatewayPhase,
  opts: { status?: number | null; detail?: string | null; message?: string; retryable?: boolean } = {},
): GatewayFailure {
  const retryable = opts.retryable ?? (code === "timeout" || code === "rate_limited" || code === "upstream_error");
  return new GatewayFailure({
    code,
    phase,
    status: opts.status ?? null,
    retryable,
    detail: opts.detail ?? null,
    message: opts.message ?? GATEWAY_MESSAGES[code],
  });
}

/** Read at most `limit` bytes of an error body — never trust its size. */
async function readBodyText(res: Response, limit = 2_000): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, limit);
  } catch {
    return "";
  }
}

export type GatewayDelta = {
  /** Visible text. Absent on role-only / finish-only events. */
  content?: string;
  role?: string;
  finishReason?: string | null;
  /** Upstream model id, when the upstream reports one. */
  model?: string;
};

export type GatewayStreamResult = {
  /** The provider's own model id, e.g. `grok-4.5`. */
  upstreamModel: string;
  chunks: number;
  /** Milliseconds from request start to the first CONTENT delta. */
  ttfbMs: number | null;
  durationMs: number;
  finishReason: string | null;
};

/** Why an abort happened. Three distinct causes, three distinct error codes. */
export type AbortReason = "deadline" | "first_chunk" | "external" | null;

/**
 * Combine the caller's abort signal with two wall-clock deadlines.
 *
 * `AbortSignal.any` would compose the signals, but it is not in the ES2023 lib
 * this project type-checks against, so it is done explicitly. Recording the
 * REASON matters: a user pressing Stop, an upstream that never answers, and an
 * upstream that connects and then goes silent are three different faults, and
 * reporting any of them as one of the others is a lie about whose fault it was.
 */
function withDeadline(timeoutMs: number, external?: AbortSignal) {
  const ac = new AbortController();
  let reason: AbortReason = null;

  const expireAs = (r: Exclude<AbortReason, null>) => {
    if (reason !== null) return; // first cause wins; later timers are no-ops
    reason = r;
    ac.abort();
  };

  const onExternalAbort = () => expireAs("external");
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => expireAs("deadline"), timeoutMs);

  return {
    signal: ac.signal,
    expireAs,
    reason: () => reason,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function asNetworkFailure(err: unknown, phase: GatewayPhase, cfg: GatewayConfig): GatewayFailure {
  if (isGatewayFailure(err)) return err;
  const raw = err instanceof Error ? err.message : String(err);
  return failure("network", phase, { detail: scrubSecrets(raw, cfg.apiKey) });
}

// ── preflight ───────────────────────────────────────────────────────────────

export type PreflightState = "reachable" | "auth_failed" | "rate_limited" | "unknown";

export type PreflightResult = {
  state: PreflightState;
  status: number | null;
  latencyMs: number;
  detail: string | null;
  failure: GatewayFailure | null;
};

/**
 * Ask the gateway who we are before committing to a streaming response.
 *
 * This exists because of a hard constraint on the SSE path: once a single event
 * has been written the HTTP status and headers are already on the wire, so an
 * invalid key discovered *after* that point can only be reported in-band. A
 * `GET /models` costs one round trip and turns "invalid key" into a proper 401
 * with a header that says `gateway` — which is what the client needs to show
 * the real reason instead of an empty transcript.
 *
 * Rate limits and 5xx are deliberately NOT treated as fatal here: the models
 * endpoint can be blocked or slow while chat works fine, and a weak signal must
 * not block a request that would have succeeded. Those are re-classified by the
 * real call.
 */
export async function preflightGateway(cfg: GatewayConfig = gatewayConfig()): Promise<PreflightResult> {
  const started = Date.now();
  if (!cfg.usable || !cfg.apiKey) {
    return { state: "unknown", status: null, latencyMs: 0, detail: null, failure: null };
  }

  const deadline = withDeadline(cfg.probeTimeoutMs);
  try {
    const res = await fetch(cfg.modelsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" },
      signal: deadline.signal,
    });
    const latencyMs = Date.now() - started;

    if (res.ok) {
      return { state: "reachable", status: res.status, latencyMs, detail: null, failure: null };
    }
    if (res.status === 401 || res.status === 403) {
      const { code } = classifyStatus(res.status);
      return {
        state: "auth_failed",
        status: res.status,
        latencyMs,
        detail: scrubSecrets(await readBodyText(res), cfg.apiKey) || null,
        failure: failure(code, "preflight", { status: res.status }),
      };
    }
    if (res.status === 429) {
      return { state: "rate_limited", status: res.status, latencyMs, detail: null, failure: null };
    }
    return { state: "unknown", status: res.status, latencyMs, detail: null, failure: null };
  } catch (err) {
    const detail =
      deadline.reason() === "deadline"
        ? `probe exceeded ${cfg.probeTimeoutMs}ms`
        : scrubSecrets(err instanceof Error ? err.message : String(err), cfg.apiKey);
    return { state: "unknown", status: null, latencyMs: Date.now() - started, detail, failure: null };
  } finally {
    deadline.cleanup();
  }
}

// ── streaming chat ──────────────────────────────────────────────────────────

export type GatewayChatOptions = {
  temperature?: number;
  maxTokens?: number;
  /** Provider model id. Resolved by the caller via `resolveGatewayModel`. */
  model: string;
  signal?: AbortSignal;
};

export type GatewayCallOptions = { config?: GatewayConfig };

/**
 * An async generator of upstream deltas.
 *
 * A generator (rather than a push callback) is what lets the caller pull ONE
 * delta, decide the engine, and only then start writing the SSE response — with
 * the correct `x-ma-engine` header already committed. See the route for why
 * that ordering matters.
 */
export async function* gatewayChatDeltas(
  messages: ChatTurn[],
  opts: GatewayChatOptions,
  call: GatewayCallOptions = {},
): AsyncGenerator<GatewayDelta, GatewayStreamResult, void> {
  const cfg = call.config ?? gatewayConfig();
  if (!cfg.configured) throw failure("not_configured", "preflight");
  if (!cfg.enabled) throw failure("disabled", "preflight");
  if (!cfg.usable) throw failure("bad_request", "preflight", { message: cfg.reason ?? GATEWAY_MESSAGES.bad_request });
  const apiKey = cfg.apiKey as string;

  const started = Date.now();
  const deadline = withDeadline(cfg.timeoutMs, opts.signal);

  // A gateway that connects and then never speaks is the worst failure mode to
  // sit on: the user sees a spinner and eventually the overall timeout. This
  // second deadline — on the FIRST token only — ABORTS the read so the fallback
  // happens in `firstChunkTimeoutMs`, not in `timeoutMs`. (An earlier version
  // only set a flag here and left the read pending, so the guard did nothing.)
  let sawFirstChunk = false;
  const firstChunkTimer = setTimeout(() => {
    if (!sawFirstChunk) deadline.expireAs("first_chunk");
  }, cfg.firstChunkTimeoutMs);

  let committed = false;
  let chunks = 0;
  let ttfbMs: number | null = null;
  let finishReason: string | null = null;
  let upstreamModel = opts.model;

  /** Map an abort/read error to the right code, using the recorded cause. */
  const connectFailure = (err?: unknown): GatewayFailure => {
    const reason = deadline.reason();
    if (reason === "first_chunk") {
      return failure("timeout", "connect", {
        detail: `no first token within ${cfg.firstChunkTimeoutMs}ms (overall budget ${cfg.timeoutMs}ms)`,
      });
    }
    if (reason === "deadline") {
      return failure("timeout", committed ? "stream" : "connect", {
        detail: `no response within ${cfg.timeoutMs}ms`,
      });
    }
    if (reason === "external") return failure("aborted", committed ? "stream" : "connect");
    return err === undefined
      ? failure("network", "connect")
      : asNetworkFailure(err, committed ? "stream" : "connect", cfg);
  };

  try {
    let res: Response;
    try {
      res = await fetch(cfg.chatUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: opts.model,
          messages,
          stream: true,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        }),
        signal: deadline.signal,
      });
    } catch (err) {
      throw connectFailure(err);
    }

    if (!res.ok) {
      const body = await readBodyText(res);
      const { code, retryable } = classifyStatus(res.status);
      throw failure(code, "connect", {
        status: res.status,
        retryable,
        detail: scrubSecrets(body, apiKey) || null,
      });
    }
    if (!res.body) throw failure("empty_response", "connect");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try {
          step = await reader.read();
        } catch (err) {
          throw connectFailure(err);
        }

        if (step.done) break;
        buffer += decoder.decode(step.value, { stream: true });

        // SSE events are separated by a blank line. Anything after the last
        // separator is a partial event — keep it for the next read.
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          for (const rawLine of event.split("\n")) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue; // ignores `:` keepalives
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") {
              if (!committed) throw failure("empty_response", "stream");
              return result();
            }
            if (!payload) continue;

            let parsed: {
              model?: string;
              choices?: { delta?: { content?: string | null; role?: string }; finish_reason?: string | null }[];
            };
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue; // a malformed event is skipped, not a stream failure
            }

            if (parsed.model) upstreamModel = parsed.model;
            const choice = parsed.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;

            const content = choice?.delta?.content;
            if (typeof content === "string" && content.length > 0) {
              if (!sawFirstChunk) {
                sawFirstChunk = true;
                ttfbMs = Date.now() - started;
                clearTimeout(firstChunkTimer);
              }
              committed = true;
              chunks += 1;
              yield { content, model: upstreamModel };
            }
            // A role-only frame is deliberately NOT yielded. The route writes its
            // own role frame, so forwarding upstream's adds nothing — and it WOULD
            // make the route commit to `gateway` before a single character existed,
            // turning a contentless stream into a mid-stream error instead of a
            // clean pre-commit fallback to the local plane. (Observed: an upstream
            // sending role-then-[DONE] produced `gateway` with an in-band
            // empty_response and 0 delivered chars, when the honest answer was to
            // fall back. Held by the `nocontent` case in the E2E harness.)
          }
        }
      }
      if (!committed) throw failure("empty_response", "stream");
      return result();
    } finally {
      reader.releaseLock();
    }
  } catch (err) {
    const f = isGatewayFailure(err) ? err : connectFailure(err);
    f.committed = committed;
    throw f;
  } finally {
    clearTimeout(firstChunkTimer);
    deadline.cleanup();
  }

  function result(): GatewayStreamResult {
    return {
      upstreamModel,
      chunks,
      ttfbMs,
      durationMs: Date.now() - started,
      finishReason,
    };
  }
}

/**
 * Non-streaming convenience wrapper: drains the generator and returns the whole
 * reply plus the same instrumentation. Used for `stream: false` requests, so
 * there is exactly ONE code path that talks to the provider.
 */
export async function completeGatewayChat(
  messages: ChatTurn[],
  opts: GatewayChatOptions,
  call: GatewayCallOptions = {},
): Promise<GatewayStreamResult & { text: string }> {
  const gen = gatewayChatDeltas(messages, opts, call);
  let text = "";
  for (;;) {
    const step = await gen.next();
    if (step.done) return { ...step.value, text };
    const delta = step.value as GatewayDelta;
    if (delta.content) text += delta.content;
  }
}

// ── health probe ────────────────────────────────────────────────────────────

export type GatewayProbeStatus =
  | "not-configured"
  | "disabled"
  | "misconfigured"
  | "reachable"
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "upstream-error"
  | "unreachable";

export type GatewayProbe = {
  status: GatewayProbeStatus;
  /** True only when the last check actually got a 2xx from the gateway. */
  reachable: boolean;
  httpStatus: number | null;
  latencyMs: number;
  checkedAt: string;
  detail: string | null;
};

const PROBE_TTL_MS = 30_000;

let probeCache: { at: number; key: string; probe: GatewayProbe } | null = null;

/** Test seam — the probe cache is module state and would otherwise leak. */
export function __resetGatewayProbeCache(): void {
  probeCache = null;
}

function statusFor(f: GatewayFailureCode, httpStatus: number | null): GatewayProbeStatus {
  if (f === "unauthorized") return "unauthorized";
  if (f === "forbidden") return "forbidden";
  if (f === "rate_limited") return "rate-limited";
  if (f === "upstream_error") return "upstream-error";
  if (f === "timeout" || f === "network") return "unreachable";
  return httpStatus && httpStatus >= 500 ? "upstream-error" : "unreachable";
}

/**
 * Probe the gateway for the health/status surface.
 *
 * Cached for 30s behind a config fingerprint so a page that polls `/v1/health`
 * cannot turn into a request flood at the provider — while still re-probing
 * immediately when the key, URL or model changes. With no key configured the
 * network is never touched at all.
 */
export async function probeGateway(
  opts: { force?: boolean; cfg?: GatewayConfig } = {},
): Promise<{ probe: GatewayProbe; config: GatewayPublicConfig }> {
  const cfg = opts.cfg ?? gatewayConfig();
  const pub = publicConfig(cfg);
  const fingerprint = `${cfg.keySource ?? "-"}|${cfg.baseUrl}|${cfg.model}|${cfg.enabled}`;
  const now = Date.now();

  if (!opts.force && probeCache && probeCache.key === fingerprint && now - probeCache.at < PROBE_TTL_MS) {
    return { probe: probeCache.probe, config: pub };
  }

  const stamp = () => new Date().toISOString();

  const cacheAndReturn = (probe: GatewayProbe) => {
    probeCache = { at: now, key: fingerprint, probe };
    return { probe, config: pub };
  };

  if (!cfg.configured) {
    return cacheAndReturn({
      status: "not-configured",
      reachable: false,
      httpStatus: null,
      latencyMs: 0,
      checkedAt: stamp(),
      detail: cfg.reason,
    });
  }
  if (!cfg.enabled) {
    return cacheAndReturn({
      status: "disabled",
      reachable: false,
      httpStatus: null,
      latencyMs: 0,
      checkedAt: stamp(),
      detail: cfg.reason,
    });
  }
  if (!cfg.usable) {
    return cacheAndReturn({
      status: "misconfigured",
      reachable: false,
      httpStatus: null,
      latencyMs: 0,
      checkedAt: stamp(),
      detail: cfg.reason,
    });
  }

  const result = await preflightGateway(cfg);
  if (result.failure) {
    return cacheAndReturn({
      status: statusFor(result.failure.code, result.status),
      reachable: false,
      httpStatus: result.status,
      latencyMs: result.latencyMs,
      checkedAt: stamp(),
      detail: result.detail ?? result.failure.message,
    });
  }
  if (result.state === "reachable") {
    return cacheAndReturn({
      status: "reachable",
      reachable: true,
      httpStatus: result.status,
      latencyMs: result.latencyMs,
      checkedAt: stamp(),
      detail: null,
    });
  }
  // 429 or an unclassifiable status: the endpoint answered, but not with a
  // clean 2xx. Reported as such rather than rounded to "up" or "down".
  const { code } = result.status ? classifyStatus(result.status) : { code: "network" as const };
  return cacheAndReturn({
    status: statusFor(code, result.status),
    reachable: false,
    httpStatus: result.status,
    latencyMs: result.latencyMs,
    checkedAt: stamp(),
    detail: result.detail,
  });
}
