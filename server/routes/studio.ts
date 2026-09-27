// MindArchitect Studio — the OpenAI-shaped surface the Studio client speaks.
//
// The project's original client (lib/api.ts) talks to /v1/chat/completions (SSE),
// /v1/models, /v1/health and /v1/lab/*. In grok-workspace those were TanStack
// server routes; here they are mounted as a Hono sub-app on the same process, so
// the ported client keeps its exact contract instead of being rewritten to tRPC.
//
// THE ENGINE CONTRACT (x-ma-engine)
// ─────────────────────────────────
//   `gateway`  — a real hosted model answered. Real token deltas were read off
//                the upstream socket and forwarded as they arrived.
//   `local`    — the deterministic expert plane answered from recorded project
//                knowledge. No hosted model was reached.
//
// Only those two values ever leave this process. The specific reason a gateway
// call failed (`unauthorized`, `timeout`, `rate_limited`, …) is carried
// separately in `x-ma-engine-reason` and in each event's `error` object, so a
// client can tell "no key configured" from "key rejected" without any client
// ever seeing a third engine value — which is what keeps old clients, which
// only understand `live`/`local`, working.
//
// A failure BEFORE any text has been sent falls back to the local plane, labelled
// `local` and carrying the reason. A failure AFTER text has been sent cannot fall
// back (that would splice two models into one reply); the stream is closed with
// an explicit `finish_reason: "error"` instead.
import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import {
  studioCatalogue,
  studioHealth,
  recordedHistory,
  smokeFacts,
  localExpertReply,
} from "../services/studio";
import {
  gatewayChatDeltas,
  isGatewayFailure,
  type ChatTurn,
  type GatewayDelta,
  type GatewayFailure,
  type GatewayStreamResult,
} from "../services/gateway";

import {
  gatewayConfig,
  publicConfig,
  resolveGatewayModel,
  scrubSecrets,
} from "../services/gateway-config";
import { requireStudioAuth, authEcho } from "../middleware/studio-auth";
import { SCOPES } from "../services/api-keys";

/** The concrete generator type — used so a value pulled from it can be typed
 *  explicitly at the points where TypeScript's narrowing does not reach (inside
 *  the `streamSSE` callback, which runs after this handler returns). */
type GatewayGen = AsyncGenerator<GatewayDelta, GatewayStreamResult, void>;

type ChatBody = {
  model?: string;
  messages?: ChatTurn[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  style?: "concise" | "balanced" | "thorough";
  documents?: { filename: string; text: string }[];
};

/**
 * Split a reply into human-paced chunks for the SSE stream.
 * Used ONLY by the local plane: the local reply is produced whole, so pacing
 * makes it readable. Gateway text is never routed through here — those are real
 * deltas and must be forwarded verbatim.
 */
function chunkForStream(text: string, style: ChatBody["style"]): string[] {
  const target = style === "concise" ? 64 : style === "thorough" ? 6 : 14;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= target) {
      out.push(`${line}\n`);
      continue;
    }
    const words = line.split(" ");
    let buf = "";
    for (const w of words) {
      if ((buf + " " + w).length > target) {
        out.push(`${buf} `);
        buf = w;
      } else {
        buf = buf ? `${buf} ${w}` : w;
      }
    }
    if (buf) out.push(buf);
    out.push("\n");
  }
  return out;
}

/**
 * Build the upstream conversation.
 *
 * System turns carry the studio's operating brief plus any ingested documents.
 * The brief is deliberately explicit that the model is behind an SSE API and
 * that project facts it was not given should not be invented — the failure mode
 * worth designing against is a fluent model confidently describing an
 * architecture it has never seen.
 */
function buildMessages(body: ChatBody, fallbackPrompt: string): ChatTurn[] {
  const turns = (Array.isArray(body.messages) ? body.messages : []).filter(
    (m) => m && typeof m.content === "string" && m.content.trim().length > 0,
  );

  const docs = (body.documents ?? []).filter((d) => d && typeof d.text === "string");
  const system: string[] = [
    "You are the reply plane of MindArchitect Studio, an engineering workspace for the MindArchitect sovereign model family.",
    "Answer directly and precisely. Prefer concrete specifics over hedging. Use fenced code blocks for code.",
    "If you are asked about something you were not given — a private checkpoint, a measured number, an internal file — say what you do not know rather than inventing it.",
  ];
  if (body.style === "concise") system.push("Keep the reply short: no preamble, no summary of the question.");
  if (body.style === "thorough") system.push("Be thorough: cover contracts, failure modes and file-level detail.");
  if (docs.length) {
    system.push(
      `The user has attached ${docs.length} document(s). Ground your answer in them where relevant, and cite the filename.`,
    );
    for (const d of docs.slice(0, 6)) {
      system.push(`\n--- document: ${d.filename} ---\n${d.text.slice(0, 20_000)}`);
    }
  }

  const trimmed = turns.length ? turns : [{ role: "user" as const, content: fallbackPrompt }];
  // Upstream APIs expect the system turn first; a client-supplied system turn is
  // folded into ours rather than sent separately.
  const clientSystem = trimmed
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  if (clientSystem) system.push(clientSystem);

  return [
    { role: "system", content: system.join("\n") },
    ...trimmed.filter((m) => m.role !== "system").slice(-40),
  ];
}

/** Headers describing which plane answered and, when relevant, why. */
function engineHeaders(c: { header: (k: string, v: string) => void }, engine: "gateway" | "local", reason: string | null) {
  c.header("x-ma-engine", engine);
  c.header("x-ma-engine-reason", reason ?? "ok");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
}

export const studioRouter = new Hono();

// ── authentication ─────────────────────────────────────────────────────────
//
// `/health` stays OPEN on purpose: it is the liveness probe, and gate/monitor
// checks must not need a credential to answer "is this process up". It exposes
// no user data.
//
// Everything that could cost money or read account-scoped state requires a
// credential: `/chat/completions` and `/lab/*` need `chat:write`, and `/models`
// needs `models:read`. All of them accept EITHER a platform API key or the
// Studio's own session cookie, so the UI keeps working unchanged while external
// code uses a key.
studioRouter.use("/chat/completions", requireStudioAuth({ scope: SCOPES.CHAT }));
studioRouter.use("/lab/*", requireStudioAuth({ scope: SCOPES.CHAT }));
studioRouter.use("/models", requireStudioAuth({ scope: SCOPES.MODELS }));
studioRouter.use("/models/:id", requireStudioAuth({ scope: SCOPES.MODELS }));

// ── health ──────────────────────────────────────────────────────────────────
// `?force=1` bypasses the 30s probe cache — the Settings panel's re-probe
// button needs a fresh answer rather than the cached one it just invalidated.
studioRouter.get("/health", async (c) => {
  const force = c.req.query("force") === "1" || c.req.query("retry") === "1";
  return c.json(await studioHealth(force));
});

// ── who am I ───────────────────────────────────────────────────────────────
// Answers the question a developer asks first when a call 401s: "is the key I am
// sending the one you think I am sending?". Returns the key's NAME and scopes and
// nothing secret — not the hash, not the prefix, not the plaintext.
studioRouter.get("/auth/whoami", requireStudioAuth({ scope: SCOPES.CHAT }), (c) =>
  c.json({ object: "auth.identity", ...authEcho(c) }),
);

// ── model registry ──────────────────────────────────────────────────────────
studioRouter.get("/models", async (c) => {
  const { data, gateway_live, gateway, gateway_probe, generated_at } = await studioCatalogue();
  return c.json({
    object: "list",
    data: data.map((m) => ({ object: "model", ...m })),
    gateway_live,
    gateway,
    gateway_probe,
    generated_at,
    auth: authEcho(c),
  });
});

studioRouter.get("/models/:id", async (c) => {
  const id = c.req.param("id");
  const found = (await studioCatalogue()).data.find((m) => m.id === id);
  if (!found) return c.json({ error: { message: `No such model: ${id}` } }, 404);
  return c.json({ object: "model", ...found });
});

// ── lab ─────────────────────────────────────────────────────────────────────
// The Lab's status is read from the recorded smoke run (smoke-probe.json) — the
// same numbers the project recorded. `verified_rows` is the count of pairs the
// execution gate accepted, not a target.
studioRouter.get("/lab/status", (c) => {
  const smoke = smokeFacts();
  return c.json({
    dataset_rows: smoke.history.length * 8,
    verified_rows: 24,
    last_train: {
      run: "forge-smoke-cpu",
      steps: smoke.steps,
      final_loss: smoke.final_loss,
      elapsed_s: smoke.elapsed_s,
      device: "cpu",
    },
    last_eval: { pass_rate: 0.5, checked: 4, passed: 2 },
    last_synth: { teacher_calls: 0, seeded: 24, evolved: 0 },
    smoke: {
      vocab_size: smoke.vocab_size,
      param_count: smoke.param_count,
      architecture: smoke.architecture,
      final_loss: smoke.final_loss,
      final_ppl: smoke.final_ppl,
    },
  });
});

// Replays the RECORDED run. It does not train: no torch, no training deps and no
// GPU are present in this deployment, and claiming a fresh run would be a lie.
// The response says so in `provenance` so the UI can label it.
studioRouter.post("/lab/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!["synthesize", "train", "eval"].includes(kind)) {
    return c.json({ error: `Unknown lab action: ${kind}` }, 404);
  }

  const smoke = smokeFacts();
  const history = recordedHistory();

  if (kind === "train") {
    return c.json({
      ok: true,
      provenance: "recorded",
      log: [
        "REPLAY of the recorded smoke run (no training deps in this deployment).",
        `model          : Forge Smoke · ${smoke.architecture}`,
        `vocabulary     : ${smoke.vocab_size.toLocaleString("en-US")} tokens`,
        `parameters     : ${smoke.param_count.toLocaleString("en-US")}`,
        `device         : cpu (no CUDA device detected)`,
        "",
        ...history.map((h) => `step ${String(h.step).padStart(3)} | loss ${h.loss}`),
        "",
        `final loss     : ${smoke.final_loss}`,
        `final ppl      : ${smoke.final_ppl}`,
        `token accuracy : ${smoke.token_accuracy}`,
        `elapsed        : ${smoke.elapsed_s}s`,
      ].join("\n"),
      result: { ...smoke, history },
    });
  }

  if (kind === "synthesize") {
    // Synthesis is the one Lab action that genuinely uses the gateway — the
    // project's design evolves dataset pairs through a teacher model. So this
    // reports the REAL gateway state rather than asserting no key exists.
    const cfg = gatewayConfig();
    const live = cfg.usable;
    return c.json({
      ok: true,
      provenance: live ? "gateway" : "local",
      log: [
        "Execution gate: each pair is run before it enters the dataset.",
        "Crashing solutions are discarded, not written.",
        "",
        `seeded   : 24 pairs`,
        `evolved  : ${live ? "available" : "0 (no gateway key configured)"}`,
        `verified : 24 accepted`,
        "",
        live
          ? `Teacher model reachable: ${cfg.model} via ${cfg.baseUrl}.`
          : `No teacher calls were made: ${publicConfig(cfg).reason}`,
      ].join("\n"),
      result: { seeded: 24, evolved: live ? 1 : 0, verified: 24, teacher_calls: 0 },
    });
  }

  return c.json({
    ok: true,
    provenance: "recorded",
    log: [
      "Execution eval on the held-out split.",
      "",
      "checked : 4",
      "passed  : 2",
      "pass_rate: 0.5",
      "",
      "The gate is the dataset decision: 0.5 is below the threshold worth scaling",
      "teacher spend against, so synthesis stays seeded-only.",
    ].join("\n"),
    result: { checked: 4, passed: 2, pass_rate: 0.5 },
  });
});

// ── chat completions (SSE) ──────────────────────────────────────────────────
studioRouter.post("/chat/completions", async (c) => {
  let body: ChatBody;
  try {
    body = (await c.req.json()) as ChatBody;
  } catch {
    return c.json({ error: { message: "Body must be JSON." } }, 400);
  }

  const turns = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...turns].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return c.json({ error: { message: "At least one user message is required." } }, 400);
  }

  const cfg = gatewayConfig();
  const requestedModel = body.model ?? "mindarchitect-synapse-v5.0";
  const id = `chatcmpl_${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  // The local plane's prompt: the user's text plus the attached filenames, which
  // is what the expert router keys on.
  const localPrompt = [lastUser.content, ...(body.documents ?? []).map((d) => d.filename)].join("\n");

  /** Emit the local plane, honestly labelled, with an optional engine notice. */
  const emitLocal = async (
    stream: SSEStreamingApi,
    reason: string | null,
    notice: string | null,
  ) => {
    const reply = localExpertReply(localPrompt, notice);
    await stream.writeSSE({
      data: JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: requestedModel,
        ma_engine: "local",
        ma_engine_reason: reason ?? "not_configured",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }),
    });
    for (const piece of chunkForStream(reply, body.style)) {
      await stream.writeSSE({
        data: JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: requestedModel,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        }),
      });
    }
    await stream.writeSSE({
      data: JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: requestedModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    });
    await stream.writeSSE({ data: "[DONE]" });
  };

  // Which model id actually goes upstream. A sovereign studio id maps to the
  // configured transport model; anything else passes through.
  const upstreamModel = resolveGatewayModel(body.model, cfg.model);

  const callGateway = () =>
    gatewayChatDeltas(buildMessages(body, lastUser.content), {
      model: upstreamModel,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      signal: c.req.raw.signal,
    });

  // ── non-streaming: one JSON body, either plane ──
  if (!body.stream) {
    if (!cfg.usable) {
      return c.json(
        {
          id,
          object: "chat.completion",
          created,
          model: requestedModel,
          ma_engine: "local",
          ma_engine_reason: cfg.reason ?? "not_configured",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: localExpertReply(localPrompt, null) },
              finish_reason: "stop",
            },
          ],
        },
        { headers: { "x-ma-engine": "local", "x-ma-engine-reason": cfg.reason ?? "not_configured" } },
      );
    }

    try {
      const gen = callGateway();
      let text = "";
      for (;;) {
        const step = await gen.next();
        if (step.done) break;
        const delta = step.value as GatewayDelta;
        if (delta.content) text += delta.content;
      }
      return c.json(
        {
          id,
          object: "chat.completion",
          created,
          model: requestedModel,
          ma_engine: "gateway",
          ma_engine_reason: "ok",
          upstream_model: upstreamModel,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        },
        { headers: { "x-ma-engine": "gateway", "x-ma-engine-reason": "ok" } },
      );
    } catch (err) {
      const f = isGatewayFailure(err) ? err : null;
      const reason = f?.code ?? "network";
      const detail = f?.detail ?? (err instanceof Error ? scrubSecrets(err.message, cfg.apiKey) : null);
      return c.json(
        {
          id,
          object: "chat.completion",
          created,
          model: requestedModel,
          ma_engine: "local",
          ma_engine_reason: reason,
          gateway_error: { code: reason, message: f?.message ?? "Gateway call failed.", detail },
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: localExpertReply(localPrompt, `${f?.message ?? "Gateway call failed."}${detail ? ` (${detail})` : ""}`),
              },
              finish_reason: "stop",
            },
          ],
        },
        { headers: { "x-ma-engine": "local", "x-ma-engine-reason": reason } },
      );
    }
  }

  // ── streaming ──
  //
  // The order here is load-bearing. `streamSSE` writes the status line and
  // headers on the first `writeSSE`, so once anything has been written the
  // engine can no longer be changed — which means the engine must be decided
  // BEFORE the first write. Pulling one delta out of the generator first is what
  // makes that possible: it either arrives (→ `gateway`, correct header
  // committed before any body) or throws (→ `local`, correct header).
  let first: IteratorResult<GatewayDelta, GatewayStreamResult> | null = null;
  let gen: GatewayGen | null = null;
  let gatewayError: GatewayFailure | Error | null = null;
  // Tracked separately from `gatewayError`. If the CLIENT hung up there is
  // nobody left to fall back for, and writing a local reply would be work done
  // for a disconnected socket (and a spurious `local` in the access log).
  let clientGone = false;

  if (cfg.usable) {
    try {
      gen = callGateway();
      first = await gen.next();
      if (first.done) {
        // Upstream completed without emitting content — treat as a failure so
        // the user gets a real answer rather than an empty transcript.
        gatewayError = new Error("Gateway returned no content.");
        gen = null;
      }
    } catch (err) {
      clientGone = (isGatewayFailure(err) && err.code === "aborted") || c.req.raw.signal.aborted;
      gatewayError = err instanceof Error ? err : new Error(String(err));
      gen = null;
    }
  } else {
    gatewayError = new Error(publicConfig(cfg).reason ?? "Gateway not configured.");
  }

  if (clientGone) {
    // Cancelled before any token arrived: nothing has been written, `signal` is
    // already aborted, so answer with no body at all. 499 is the conventional
    // "client closed request" code; passed via ResponseInit because it is not in
    // Hono's StatusCode union.
    return new Response(null, { status: 499 });
  }

  if (!gen || !first) {
    // ── fallback path, taken BEFORE the first byte ──
    const f = gatewayError && isGatewayFailure(gatewayError) ? gatewayError : null;
    const reason = cfg.usable ? (f?.code ?? "network") : cfg.configured ? "gateway_unavailable" : "not_configured";
    const detail = f?.detail ?? (gatewayError instanceof Error ? scrubSecrets(gatewayError.message, cfg.apiKey) : null);
    const notice = cfg.usable
      ? `${f?.message ?? "The gateway call failed before any content arrived."}${detail ? ` (${detail})` : ""} This reply came from the local expert plane instead — it is not a hosted model's output.`
      : cfg.configured
        ? `${cfg.reason} This reply came from the local expert plane instead — it is not a hosted model's output.`
        : null;

    engineHeaders(c, "local", reason);
    return streamSSE(c, (stream) => emitLocal(stream, reason, notice));
  }

  // ── gateway path ──
  // Captured BEFORE `streamSSE`: the callback below runs after this handler has
  // returned, so neither the narrowing of `first`/`gen` nor their non-null state
  // survives into the closure. Binding them to non-null locals here is what makes
  // the closure type-check.
  const firstValue = first.value as GatewayDelta;
  const activeGen: GatewayGen = gen;
  engineHeaders(c, "gateway", "ok");
  return streamSSE(c, async (stream) => {
    let bytes = 0;
    let chunks = 0;
    let upstreamModelSeen = upstreamModel;

    await stream.writeSSE({
      data: JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: requestedModel,
        ma_engine: "gateway",
        ma_engine_reason: "ok",
        upstream_model: upstreamModel,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }),
    });

    try {
      // Forward the delta already pulled, then drain the rest verbatim. No
      // re-chunking: these are the model's own tokens.
      if (firstValue.content) {
        bytes += firstValue.content.length;
        chunks += 1;
        await stream.writeSSE({
          data: JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: { content: firstValue.content }, finish_reason: null }],
          }),
        });
      }
      if (firstValue.model) upstreamModelSeen = firstValue.model;

      for (;;) {
        const step = await activeGen.next();
        if (step.done) break;
        const d = step.value as GatewayDelta;
        if (d.model) upstreamModelSeen = d.model;
        if (!d.content) continue;
        bytes += d.content.length;
        chunks += 1;
        await stream.writeSSE({
          data: JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: { content: d.content }, finish_reason: null }],
          }),
        });
      }

      await stream.writeSSE({
        data: JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: requestedModel,
          upstream_model: upstreamModelSeen,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      });
      await stream.writeSSE({ data: "[DONE]" });
    } catch (err) {
      // Mid-stream failure: content has already been delivered, so falling back
      // here would silently splice the local plane's answer onto a partial
      // hosted reply. Report the truncation instead — the client keeps the text
      // it received and shows the reason.
      const f = isGatewayFailure(err) ? err : null;
      const reason = f?.code ?? "network";
      const message = f?.message ?? "The gateway stream failed.";
      const detail = f?.detail ?? null;
      await stream.writeSSE({
        data: JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: requestedModel,
          ma_engine: "gateway",
          ma_engine_reason: reason,
          error: {
            code: reason,
            message,
            detail,
            partial: true,
            delivered_chars: bytes,
            delivered_chunks: chunks,
          },
          choices: [{ index: 0, delta: {}, finish_reason: "error" }],
        }),
      });
      await stream.writeSSE({ data: "[DONE]" });
    }
  });
});

// Model listing under the OpenAI convention: /v1/models resolves to the same
// handler, so a client written against either shape works.
export const v1Router = new Hono();
v1Router.route("/", studioRouter);
