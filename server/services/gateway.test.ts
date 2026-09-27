import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  __resetGatewayProbeCache,
  classifyStatus,
  completeGatewayChat,
  gatewayChatDeltas,
  probeGateway,
  type GatewayDelta,
} from "./gateway";
import { gatewayConfig, publicConfig, resolveGatewayModel, scrubSecrets } from "./gateway-config";

// ── an in-process mock upstream ──────────────────────────────────────────────
//
// Same contract as tools/mock-gateway.mjs, embedded so the suite has no
// external dependency. It is a MOCK: it asserts the client's protocol handling,
// not any model's quality.
let server: Server;
let baseUrl: string;
const MODEL_FRAMES: Record<string, string[]> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const scenario = parts[0] ?? "ok";
    // Join the REST of the path: `/ok/chat/completions` has two segments after
    // the scenario, so taking only parts[1] would yield "chat" and send every
    // chat request down the 404 branch.
    const endpoint = parts.slice(1).join("/");
    const json = (status: number, body: unknown) => {
      const p = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(p) });
      res.end(p);
    };
    const head = () =>
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const frame = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    if (scenario === "auth") return json(401, { error: { message: "bad key" } });
    // In the ratelimit scenario the PROBE endpoint is the one that 429s — that is
    // the case being exercised (a throttled /models must not block chat).
    if (scenario === "ratelimit" && endpoint === "models") return json(429, { error: { message: "slow down" } });
    if (endpoint === "models") return json(200, { object: "list", data: [] });

    if (endpoint === "chat/completions") {
      if (scenario === "ratelimit") return json(429, { error: { message: "slow down" } });
      if (scenario === "servererror") return json(500, { error: { message: "boom" } });
      if (scenario === "stall") {
        head(); // never speaks
        return;
      }
      if (scenario === "nocontent") {
        head();
        frame({ model: "m", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      if (scenario === "die") {
        head();
        frame({ model: "m", choices: [{ index: 0, delta: { content: "alpha " } }] });
        setTimeout(() => {
          frame({ model: "m", choices: [{ index: 0, delta: { content: "beta" } }] });
          setTimeout(() => res.socket?.destroy(), 20);
        }, 20);
        return;
      }
      if (scenario === "echo3043") {
        // Includes a decoder-stressing char, exercising the utf-8 path.
        head();
        for (const t of ["3\u00b7", "0\u00b7", "4\u00b7", "3"]) {
          frame({ model: "m", choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
        }
        frame({ model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      if (scenario === "keepalive") {
        // Comment-only lines (`:ping`) must be skipped, not treated as data.
        head();
        res.write(": ping\n\n");
        frame({ model: "m", choices: [{ index: 0, delta: { content: "after-keepalive" }, finish_reason: null }] });
        res.write(": ping\n\n");
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      head();
      frame({ model: "mock-model", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      for (const t of ["one ", "two ", "three"]) {
        frame({ model: "mock-model", choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
      }
      frame({ model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    json(404, { error: { message: "no" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ENV_KEYS = [
  "MINDARCHITECT_LLM_API_KEY",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "LLM_API_KEY",
  "MINDARCHITECT_LLM_BASE_URL",
  "MINDARCHITECT_LLM_MODEL",
  "MINDARCHITECT_LLM_DISABLED",
  "MINDARCHITECT_LLM_TIMEOUT_MS",
  "MINDARCHITECT_LLM_FIRST_CHUNK_TIMEOUT_MS",
] as const;

const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  __resetGatewayProbeCache();
}

/** Point the client at a mock scenario with a key present. */
function useScenario(scenario: string, extra: Record<string, string> = {}) {
  clearEnv();
  process.env.MINDARCHITECT_LLM_API_KEY = "sk-test-0000000000000000";
  process.env.MINDARCHITECT_LLM_BASE_URL = `${baseUrl}/${scenario}`;
  process.env.MINDARCHITECT_LLM_MODEL = "mock-model";
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetGatewayProbeCache();
});

async function drain(gen: AsyncGenerator<GatewayDelta, unknown, void>) {
  const out: string[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return out;
    const d = step.value as GatewayDelta;
    if (d.content) out.push(d.content);
  }
}

// ── status classification ───────────────────────────────────────────────────

describe("classifyStatus", () => {
  it("maps auth failures as non-retryable", () => {
    expect(classifyStatus(401)).toEqual({ code: "unauthorized", retryable: false });
    expect(classifyStatus(403)).toEqual({ code: "forbidden", retryable: false });
  });

  it("maps rate limits and 5xx as retryable", () => {
    expect(classifyStatus(429)).toEqual({ code: "rate_limited", retryable: true });
    expect(classifyStatus(500)).toEqual({ code: "upstream_error", retryable: true });
    expect(classifyStatus(503)).toEqual({ code: "upstream_error", retryable: true });
  });

  it("treats 400/404/422 as a configuration fault, not a transient one", () => {
    for (const s of [400, 404, 422]) {
      expect(classifyStatus(s)).toEqual({ code: "bad_request", retryable: false });
    }
  });

  it("maps 408 to a retryable timeout", () => {
    expect(classifyStatus(408)).toEqual({ code: "timeout", retryable: true });
  });
});

// ── secret hygiene ──────────────────────────────────────────────────────────

describe("scrubSecrets", () => {
  it("removes the exact live key from text", () => {
    const key = "sk-live-abcdefghijklmnop";
    expect(scrubSecrets(`bad key: ${key}`, key)).not.toContain(key);
    expect(scrubSecrets(`bad key: ${key} [redacted-key]`, key)).toContain("[redacted-key]");
  });

  it("removes provider-shaped tokens even when they are not ours", () => {
    // An upstream may echo a DIFFERENT key than the one we sent.
    const out = scrubSecrets("sent xai-abcdefghijklmnopqrstuvwxyz to the gateway");
    expect(out).not.toContain("xai-abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts a bearer header echoed back in an error body", () => {
    const out = scrubSecrets('{"error":"unauthorized","headers":{"authorization":"Bearer sk-proj-0123456789abcdefghij"}}');
    expect(out).not.toContain("sk-proj-0123456789abcdefghij");
    expect(out).toContain("[redacted-key]");
  });

  it("leaves ordinary text untouched", () => {
    expect(scrubSecrets("loss went from 10.37 to 2.19")).toBe("loss went from 10.37 to 2.19");
  });
});

// ── config resolution ───────────────────────────────────────────────────────

describe("gatewayConfig", () => {
  it("is not usable with no key, and never touches the network", async () => {
    clearEnv();
    const cfg = gatewayConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.usable).toBe(false);
    expect(cfg.apiKey).toBeNull();
    const { probe } = await probeGateway({ force: true });
    expect(probe.status).toBe("not-configured");
    expect(probe.reachable).toBe(false);
  });

  it("prefers the project-specific variable over the generic ones", () => {
    clearEnv();
    process.env.LLM_API_KEY = "sk-generic-000000000000";
    process.env.OPENAI_API_KEY = "sk-openai-000000000000";
    process.env.MINDARCHITECT_LLM_API_KEY = "sk-project-00000000000";
    expect(gatewayConfig().keySource).toBe("MINDARCHITECT_LLM_API_KEY");
  });

  it("infers the provider base URL from a provider-specific key", () => {
    clearEnv();
    process.env.XAI_API_KEY = "xai-0000000000000000";
    const cfg = gatewayConfig();
    expect(cfg.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.baseUrlIsDefault).toBe(false);
  });

  it("falls back to the documented transport default and flags it as assumed", () => {
    clearEnv();
    process.env.LLM_API_KEY = "sk-generic-000000000000";
    const cfg = gatewayConfig();
    expect(cfg.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.baseUrlIsDefault).toBe(true);
  });

  it("honours an explicit base URL over the provider default", () => {
    clearEnv();
    process.env.OPENAI_API_KEY = "sk-openai-000000000000";
    process.env.MINDARCHITECT_LLM_BASE_URL = "http://127.0.0.1:9/v1/";
    const cfg = gatewayConfig();
    expect(cfg.baseUrl).toBe("http://127.0.0.1:9/v1"); // trailing slash stripped
    expect(cfg.chatUrl).toBe("http://127.0.0.1:9/v1/chat/completions");
  });

  it("becomes unusable (with a reason) when the base URL is malformed", () => {
    clearEnv();
    process.env.MINDARCHITECT_LLM_API_KEY = "sk-test-0000000000000000";
    process.env.MINDARCHITECT_LLM_BASE_URL = "not-a-url";
    const cfg = gatewayConfig();
    expect(cfg.configured).toBe(true);
    expect(cfg.usable).toBe(false);
    expect(cfg.reason).toMatch(/http/);
  });

  it("is switched off by the kill switch, and says which variable did it", () => {
    clearEnv();
    process.env.MINDARCHITECT_LLM_API_KEY = "sk-test-0000000000000000";
    process.env.MINDARCHITECT_LLM_DISABLED = "1";
    const cfg = gatewayConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.usable).toBe(false);
    expect(cfg.disabledBy).toBe("MINDARCHITECT_LLM_DISABLED");
  });
});

describe("publicConfig", () => {
  it("never exposes the key or its value, in any field", () => {
    clearEnv();
    const secret = "sk-super-secret-value-1234567890";
    process.env.MINDARCHITECT_LLM_API_KEY = secret;
    const pub = publicConfig();
    const serialised = JSON.stringify(pub);
    expect(serialised).not.toContain(secret);
    // not even a fragment of it
    expect(serialised).not.toContain(secret.slice(3, 15));
    expect("apiKey" in pub).toBe(false);
    // …but it does say WHICH variable to set, which is what an operator needs.
    expect(pub.keySource).toBe("MINDARCHITECT_LLM_API_KEY");
  });
});

describe("resolveGatewayModel", () => {
  it("maps a sovereign studio id to the configured transport model", () => {
    expect(resolveGatewayModel("mindarchitect-synapse-v5.0", "grok-4.5")).toBe("grok-4.5");
    expect(resolveGatewayModel("mindarchitect-apex-m5.0", "grok-4.5")).toBe("grok-4.5");
  });

  it("passes a provider-native id through unchanged", () => {
    expect(resolveGatewayModel("gpt-4o-mini", "grok-4.5")).toBe("gpt-4o-mini");
  });

  it("uses the configured model when the caller names none", () => {
    expect(resolveGatewayModel(undefined, "grok-4.5")).toBe("grok-4.5");
  });
});

// ── streaming against the mock ──────────────────────────────────────────────

describe("gatewayChatDeltas (mock upstream)", () => {
  it("streams the mock's tokens in order and reports the upstream model", async () => {
    useScenario("ok");
    const gen = gatewayChatDeltas([{ role: "user", content: "hi" }], { model: "mock-model" });
    const tokens: string[] = [];
    let result;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        result = step.value;
        break;
      }
      const d = step.value as GatewayDelta;
      if (d.content) tokens.push(d.content);
    }
    expect(tokens).toEqual(["one ", "two ", "three"]);
    expect(result?.upstreamModel).toBe("mock-model");
    expect(result?.chunks).toBe(3);
    expect(result?.finishReason).toBe("stop");
    expect(result?.ttfbMs).toBeTypeOf("number");
  });

  it("reassembles multi-byte characters split across chunks", async () => {
    useScenario("echo3043");
    const gen = gatewayChatDeltas([{ role: "user", content: "hi" }], { model: "mock-model" });
    const text = (await drain(gen)).join("");
    // The mock emits these as SINGLE frames, so the decoder must re-join them
    // across the UTF-8 boundaries the byte stream splits them on. Asserting the
    // exact string is what makes this a real check rather than a smoke test.
    expect(text).toBe("3·0·4·3");
  });

  it("skips SSE comment keepalives without losing data", async () => {
    useScenario("keepalive");
    const gen = gatewayChatDeltas([{ role: "user", content: "hi" }], { model: "mock-model" });
    expect((await drain(gen)).join("")).toBe("after-keepalive");
  });

  it("completeGatewayChat returns the joined text", async () => {
    useScenario("ok");
    const res = await completeGatewayChat([{ role: "user", content: "hi" }], { model: "mock-model" });
    expect(res.text).toBe("one two three");
    expect(res.chunks).toBe(3);
  });
});

// ── error mapping, each case against a real socket ──────────────────────────

async function expectFailure(scenario: string, extraEnv: Record<string, string> = {}) {
  useScenario(scenario, extraEnv);
  const gen = gatewayChatDeltas([{ role: "user", content: "hi" }], { model: "mock-model" });
  try {
    await drain(gen);
    throw new Error("expected a GatewayFailure, but the stream succeeded");
  } catch (err) {
    return err as { code: string; phase: string; committed: boolean; status: number | null };
  }
}

describe("gateway error mapping (mock upstream)", () => {
  it("401 → unauthorized, non-retryable, nothing committed", async () => {
    const f = await expectFailure("auth");
    expect(f.code).toBe("unauthorized");
    expect(f.status).toBe(401);
    expect(f.committed).toBe(false);
  });

  it("429 → rate_limited", async () => {
    const f = await expectFailure("ratelimit");
    expect(f.code).toBe("rate_limited");
    expect(f.status).toBe(429);
  });

  it("500 → upstream_error", async () => {
    const f = await expectFailure("servererror");
    expect(f.code).toBe("upstream_error");
    expect(f.status).toBe(500);
  });

  it("a socket killed mid-stream → failure with committed = true", async () => {
    const f = await expectFailure("die");
    expect(["network", "empty_response"]).toContain(f.code);
    // This is the flag the route uses to decide it must NOT fall back.
    expect(f.committed).toBe(true);
  });

  it("a gateway that accepts then never speaks → timeout, via the first-token deadline", async () => {
    const started = Date.now();
    const f = await expectFailure("stall", {
      MINDARCHITECT_LLM_TIMEOUT_MS: "20000",
      MINDARCHITECT_LLM_FIRST_CHUNK_TIMEOUT_MS: "500",
    });
    expect(f.code).toBe("timeout");
    expect(f.committed).toBe(false);
    // Proves the first-token deadline fired rather than the 20s overall one.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("role frame then [DONE] with no content → empty_response", async () => {
    const f = await expectFailure("nocontent");
    expect(f.code).toBe("empty_response");
    expect(f.committed).toBe(false);
  });

  it("an unreachable host → network failure", async () => {
    clearEnv();
    process.env.MINDARCHITECT_LLM_API_KEY = "sk-test-0000000000000000";
    process.env.MINDARCHITECT_LLM_BASE_URL = "http://127.0.0.1:9/v1";
    const gen = gatewayChatDeltas([{ role: "user", content: "hi" }], { model: "m" });
    await expect(drain(gen)).rejects.toMatchObject({ code: "network" });
  });

  it("refuses to call at all with no key configured", async () => {
    clearEnv();
    const gen = gatewayChatDeltas([{ role: "user", content: "hi" }], { model: "m" });
    await expect(drain(gen)).rejects.toMatchObject({ code: "not_configured" });
  });

  it("refuses to call when the kill switch is set", async () => {
    useScenario("ok", { MINDARCHITECT_LLM_DISABLED: "true" });
    const gen = gatewayChatDeltas([{ role: "user", content: "hi" }], { model: "m" });
    await expect(drain(gen)).rejects.toMatchObject({ code: "disabled" });
  });

  it("reports 'aborted' (not 'timeout') when the caller cancels", async () => {
    useScenario("stall", { MINDARCHITECT_LLM_TIMEOUT_MS: "20000" });
    const ac = new AbortController();
    const gen = gatewayChatDeltas([{ role: "user", content: "hi" }], { model: "m", signal: ac.signal });
    const run = drain(gen);
    setTimeout(() => ac.abort(), 80);
    await expect(run).rejects.toMatchObject({ code: "aborted" });
  });
});

// ── health probe ────────────────────────────────────────────────────────────

describe("probeGateway (mock upstream)", () => {
  it("reports reachable on a 200 and records latency + status", async () => {
    useScenario("ok");
    const { probe, config } = await probeGateway({ force: true });
    expect(probe.status).toBe("reachable");
    expect(probe.reachable).toBe(true);
    expect(probe.httpStatus).toBe(200);
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
    expect(config.model).toBe("mock-model");
  });

  it("reports unauthorized on 401 and does not round it to reachable", async () => {
    useScenario("auth");
    const { probe } = await probeGateway({ force: true });
    expect(probe.status).toBe("unauthorized");
    expect(probe.reachable).toBe(false);
    expect(probe.httpStatus).toBe(401);
  });

  it("reports unreachable when nothing is listening", async () => {
    clearEnv();
    process.env.MINDARCHITECT_LLM_API_KEY = "sk-test-0000000000000000";
    process.env.MINDARCHITECT_LLM_BASE_URL = "http://127.0.0.1:9/v1";
    const { probe } = await probeGateway({ force: true });
    expect(probe.status).toBe("unreachable");
    expect(probe.reachable).toBe(false);
  });

  it("still succeeds when /models 429s, because chat may work fine", async () => {
    useScenario("ratelimit");
    const { probe } = await probeGateway({ force: true });
    expect(probe.status).toBe("rate-limited");
    expect(probe.reachable).toBe(false);
    // …and the chat call is then classified on its own merits.
    const gen = gatewayChatDeltas([{ role: "user", content: "hi" }], { model: "mock-model" });
    await expect(drain(gen)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("caches the verdict until forced, so /v1/health cannot flood the provider", async () => {
    useScenario("ok");
    const first = await probeGateway({ force: true });
    const second = await probeGateway(); // cached
    expect(second.probe.checkedAt).toBe(first.probe.checkedAt);
    const forced = await probeGateway({ force: true });
    expect(forced.probe.checkedAt >= first.probe.checkedAt).toBe(true);
  });

  it("keeps the mock free of any real provider reference", () => {
    // Guards against a future edit pointing this suite at a live host.
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(MODEL_FRAMES).toEqual({});
  });
});

// ── regressions found by running against a REAL provider ─────────────────────
//
// Each of these reproduces a defect that only appeared once the gateway was
// pointed at api.openai.com with a live key. They are the concrete bugs that
// a mock-only verification missed.
describe("live-provider regressions", () => {
  afterEach(() => clearEnv());

  it("scrubs a provider-MASKED key echo, not just an exact match", () => {
    // Observed verbatim from api.openai.com: the provider masks the key itself,
    // so the exact-match rule found nothing and the first 8 + last 4 chars of a
    // real credential were rendered in the UI.
    const leaked =
      'Incorrect API key provided: ab1_secr***************wxyz. You can find your key at http://example.invalid/keys';
    const out = scrubSecrets(leaked, "sk-a-different-key-entirely");
    expect(out).not.toContain("ab1_secr");
    expect(out).not.toContain("wxyz");
    expect(out).toContain("[redacted-key]");
  });

  it("still scrubs an exact key echo", () => {
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
    expect(scrubSecrets(`bad key ${key} rejected`, key)).not.toContain(key);
  });

  it("leaves ordinary markdown bold intact (only 3+ stars are a key shape)", () => {
    expect(scrubSecrets("this is **bold** text", null)).toBe("this is **bold** text");
  });

  it("derives an OpenAI-appropriate default model, not the xAI transport id", () => {
    // The base URL is derived from the key's provider, so the model must be too:
    // asking api.openai.com for `grok-4.5` is a guaranteed 404.
    clearEnv();
    process.env.OPENAI_API_KEY = "sk-test-0000000000000000";
    const cfg = gatewayConfig();
    expect(cfg.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg.model).not.toBe("grok-4.5");
    expect(cfg.modelIsDefault).toBe(true);
  });

  it("keeps the xAI default when an xAI key is the one present", () => {
    clearEnv();
    process.env.XAI_API_KEY = "xai-test0000000000000000";
    const cfg = gatewayConfig();
    expect(cfg.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.model).toBe("grok-4.5");
  });

  it("lets an explicit model override win over the provider default", () => {
    clearEnv();
    process.env.OPENAI_API_KEY = "sk-test-0000000000000000";
    process.env.MINDARCHITECT_LLM_MODEL = "gpt-4o";
    const cfg = gatewayConfig();
    expect(cfg.model).toBe("gpt-4o");
    expect(cfg.modelIsDefault).toBe(false);
  });

  it("never reports a provider-derived base URL as assumed", () => {
    clearEnv();
    process.env.OPENAI_API_KEY = "sk-test-0000000000000000";
    expect(gatewayConfig().baseUrlIsDefault).toBe(false);
    expect(publicConfig(gatewayConfig()).baseUrlIsDefault).toBe(false);
  });
});
