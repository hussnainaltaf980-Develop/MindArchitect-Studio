#!/usr/bin/env node
// ── Mock OpenAI-compatible gateway ───────────────────────────────────────────
//
// THIS IS A MOCK. It is not a model, it has no weights, and it is not a
// provider. It exists to prove the gateway client's real behaviour — streaming,
// header selection, and error classification — without spending a live API key,
// because a sandbox cannot verify a hosted provider it has no credentials for.
//
// It speaks the subset of the OpenAI protocol the client uses:
//   GET  /<scenario>/models            → the preflight probe
//   POST /<scenario>/chat/completions  → SSE stream of token deltas
//
// The scenario is the FIRST PATH SEGMENT, so one process serves every failure
// mode and the harness only has to change the base URL:
//
//   ok          200 + a streamed reply (the happy path)
//   auth        401 on both endpoints (a revoked key)
//   ratelimit   /models 200, chat 429
//   servererror /models 200, chat 500
//   die         /models 200, chat sends 2 tokens then kills the socket
//   stall       /models 200, chat accepts and never speaks
//   nocontent   /models 200, chat sends a role frame and [DONE] with no text
//   badauth     401 on /models only (chat would work) — preflight catches it
//
// SWITCHABLE MODE
// ---------------
// The first segment `live` reads the scenario from a state FILE at request time
// (SCENARIO_FILE, default /tmp/mock-scenario.txt; missing file = `ok`). That lets
// one long-lived app process be pointed at this mock ONCE and then driven through
// every failure mode by rewriting one file — instead of restarting the app (and
// re-paying its ~20s boot) six times to change a base URL.
//
// Usage: node tools/mock-gateway.mjs [port]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 4599);
const SCENARIOS = [
  "ok",
  "auth",
  "ratelimit",
  "servererror",
  "die",
  "stall",
  "nocontent",
  "badauth",
  "switch",
];
const SCENARIO_FILE = process.env.MOCK_SCENARIO_FILE ?? "/tmp/mock-scenario.txt";

/** Resolve `live` to whatever the state file currently says. */
function currentScenario(pathScenario) {
  if (pathScenario !== "switch") return pathScenario;
  try {
    const value = readFileSync(SCENARIO_FILE, "utf8").trim();
    return SCENARIOS.includes(value) ? value : "ok";
  } catch {
    return "ok";
  }
}

const REPLY_TOKENS = [
  "MindArchitect ",
  "gateway ",
  "stream ",
  "**verified**. ",
  "Token 5 of 5.",
];

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** A short streamed reply: role frame, N content deltas, finish, [DONE]. */
function streamReply(res, model, tokenCount = REPLY_TOKENS.length) {
  sseHead(res);
  sseChunk(res, {
    id: "chatcmpl_mock",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  let i = 0;
  const tick = () => {
    if (i >= tokenCount) {
      sseChunk(res, {
        id: "chatcmpl_mock",
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    sseChunk(res, {
      id: "chatcmpl_mock",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content: REPLY_TOKENS[i] }, finish_reason: null }],
    });
    i += 1;
    setTimeout(tick, 15);
  };
  setTimeout(tick, 15);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  // Join the REST of the path — `/ok/chat/completions` is two segments after the
  // scenario, so parts[1] alone would be "chat" and 404 every chat request.
  const pathScenario = parts[0] ?? "ok";
  const endpoint = parts.slice(1).join("/");
  const scenario = pathScenario === "switch" ? currentScenario("switch") : pathScenario;

  if (!SCENARIOS.includes(pathScenario)) {
    return sendJson(res, 404, { error: { message: `unknown mock scenario: ${scenario}` } });
  }
  if (scenario === "auth" || scenario === "badauth") {
    return sendJson(res, 401, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } });
  }

  if (endpoint === "models") {
    // The ratelimit scenario throttles the PROBE too, which is the interesting
    // case: a 429 on /models must not be treated as fatal for chat.
    if (scenario === "ratelimit") {
      return sendJson(res, 429, { error: { message: "Rate limit reached for requests" } });
    }
    return sendJson(res, 200, { object: "list", data: [{ id: "grok-4.5", object: "model" }] });
  }

  if (endpoint === "chat/completions") {
    if (scenario === "ratelimit") {
      return sendJson(res, 429, { error: { message: "Rate limit reached for requests", type: "rate_limit_error" } });
    }
    if (scenario === "servererror") {
      return sendJson(res, 500, { error: { message: "internal server error" } });
    }
    if (scenario === "stall") {
      sseHead(res); // headers only — deliberately never any body
      return;
    }
    if (scenario === "nocontent") {
      sseHead(res);
      sseChunk(res, {
        id: "chatcmpl_mock",
        object: "chat.completion.chunk",
        model: "grok-4.5",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    if (scenario === "die") {
      sseHead(res);
      sseChunk(res, {
        id: "chatcmpl_mock",
        object: "chat.completion.chunk",
        model: "grok-4.5",
        choices: [{ index: 0, delta: { content: "partial before the " } }],
      });
      setTimeout(() => {
        sseChunk(res, {
          id: "chatcmpl_mock",
          object: "chat.completion.chunk",
          model: "grok-4.5",
          choices: [{ index: 0, delta: { content: "socket died" } }],
        });
        // Hard-kill the connection mid-stream — no finish frame, no [DONE].
        setTimeout(() => res.socket?.destroy(), 25);
      }, 25);
      return;
    }
    return streamReply(res, "grok-4.5");
  }

  return sendJson(res, 404, { error: { message: `unknown endpoint: ${url.pathname}` } });
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[mock-gateway] LISTENING on http://127.0.0.1:${PORT} — scenarios: ${SCENARIOS.join(", ")}`);
});
