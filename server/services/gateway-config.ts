// ── MindArchitect Studio · LLM gateway configuration ─────────────────────────
//
// Everything the reply plane needs to reach a hosted model, resolved from the
// environment AT CALL TIME so a key rotation takes effect without a restart.
//
// SECURITY POSTURE
// ────────────────
// The API key:
//   * is read from process.env ONLY — never hardcoded, never defaulted, never
//     written to disk, never logged;
//   * is NEVER returned to a client. `publicConfig()` deliberately exposes the
//     variable NAME it was found in and no part of its value, because the
//     Settings panel needs to tell an operator which knob to turn, and a key
//     prefix or suffix is still key material;
//   * is stripped out of upstream error text before it is surfaced (see
//     `scrubSecrets`), since a misconfigured upstream can echo it back.
//
// `_core/env.ts` is the platform's validated-env module and is not ours to
// edit, so these OPTIONAL keys are read here. Nothing in this module has a side
// effect at import time — every read happens inside `gatewayConfig()`.

/**
 * Variable names searched for a key, in priority order. The project-specific
 * name wins, so an operator can pin a key for this app without changing what
 * every other process on the host sees.
 */
export const KEY_SOURCES = [
  "MINDARCHITECT_LLM_API_KEY",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "LLM_API_KEY",
] as const;

export type GatewayKeySource = (typeof KEY_SOURCES)[number] | null;

/** Provider default when the key came from a provider-specific variable. */
const PROVIDER_BASE_URLS: Partial<Record<NonNullable<GatewayKeySource>, string>> = {
  XAI_API_KEY: "https://api.x.ai/v1",
  OPENAI_API_KEY: "https://api.openai.com/v1",
};

/**
 * Used when the key came from a generic variable and no base URL was set. The
 * project's own catalogue declares its transport as xAI's `grok-4.5`
 * (client/src/lib/models.ts → TRANSPORT_MODEL), so that provider is the
 * documented assumption rather than one this module invented — and
 * `baseUrlIsDefault` is set so the UI can say the URL was ASSUMED.
 */
export const ASSUMED_BASE_URL = "https://api.x.ai/v1";

/** Matches the client's declared transport. Overridable per deployment. */
export const DEFAULT_TRANSPORT_MODEL = "grok-4.5";

/**
 * Provider-appropriate default model.
 *
 * The transport default (`grok-4.5`) is an xAI model id. Sending it to OpenAI
 * is a guaranteed 404 — which is exactly what happened the first time this ran
 * against a real OPENAI_API_KEY: the app pointed itself at api.openai.com and
 * then asked it for a Grok. The base URL is derived from the key's provider, so
 * the model id must be too. Anything unrecognised still falls back to the
 * transport default.
 */
const PROVIDER_DEFAULT_MODELS: Partial<Record<NonNullable<GatewayKeySource>, string>> = {
  OPENAI_API_KEY: "gpt-4o-mini",
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 8_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

/** Treats "1", "true", "yes", "on" (any case) as set. Everything else is off. */
function isTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function readNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Trailing slashes are stripped so `${base}/chat/completions` never doubles up. */
function normaliseBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * A base URL is only usable if it is an absolute http(s) origin+path with no
 * whitespace. Anything else would produce a `fetch` failure at request time
 * whose message points at the network rather than at the typo — so it is
 * rejected here, with a reason the operator can act on.
 */
function validateBaseUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return "must start with http:// or https://";
  if (/\s/.test(url)) return "must not contain whitespace";
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return "has no host";
    return null;
  } catch {
    return "is not a valid URL";
  }
}

export type GatewayPublicConfig = {
  configured: boolean;
  enabled: boolean;
  usable: boolean;
  /** The NAME of the variable the key came from — never any part of its value. */
  keySource: GatewayKeySource;
  baseUrl: string;
  baseUrlIsDefault: boolean;
  model: string;
  modelIsDefault: boolean;
  timeoutMs: number;
  firstChunkTimeoutMs: number;
  probeTimeoutMs: number;
  chatUrl: string;
  modelsUrl: string;
  /** Why the gateway is not usable, when it is not. Null when it is. */
  reason: string | null;
  /** The variable that switched the gateway off, when one did. */
  disabledBy: string | null;
};

export type GatewayConfig = GatewayPublicConfig & {
  /** Key material. Stays inside the server — never serialise this object. */
  apiKey: string | null;
};

function build(): GatewayConfig {
  const envName = KEY_SOURCES.find((name) => Boolean(process.env[name])) ?? null;
  const apiKey = envName ? (process.env[envName] as string) : null;

  const disabledBy = isTruthy(process.env.MINDARCHITECT_LLM_DISABLED)
    ? "MINDARCHITECT_LLM_DISABLED"
    : null;

  const explicitBase = process.env.MINDARCHITECT_LLM_BASE_URL;
  // `baseUrlIsDefault` must mean "a human did not tell us where to go", so the
  // UI can warn that the URL was a guess. A provider-derived URL (from
  // XAI_API_KEY, OPENAI_API_KEY, …) is authoritative — the provider IS the
  // source of its own endpoint — so only the generic-key fallback to
  // ASSUMED_BASE_URL counts as assumed. Flagging the provider case would raise
  // a false alarm in the UI.
  const derivedBase = envName ? PROVIDER_BASE_URLS[envName] : undefined;
  const baseUrlIsAssumed = !explicitBase && !derivedBase;
  const baseUrl = normaliseBaseUrl(explicitBase ?? derivedBase ?? ASSUMED_BASE_URL);

  const defaultModel = (envName && PROVIDER_DEFAULT_MODELS[envName]) || DEFAULT_TRANSPORT_MODEL;
  const modelIsAssumed = !process.env.MINDARCHITECT_LLM_MODEL?.trim();
  const model = process.env.MINDARCHITECT_LLM_MODEL?.trim() || defaultModel;

  const timeoutMs = readNumber("MINDARCHITECT_LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000, 600_000);
  const firstChunkTimeoutMs = readNumber(
    "MINDARCHITECT_LLM_FIRST_CHUNK_TIMEOUT_MS",
    DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
    500,
    timeoutMs,
  );
  const probeTimeoutMs = readNumber("MINDARCHITECT_LLM_PROBE_TIMEOUT_MS", DEFAULT_PROBE_TIMEOUT_MS, 250, 30_000);

  const urlProblem = validateBaseUrl(baseUrl);

  // usabel requires a key, no kill switch, and a base URL that could work.
  let reason: string | null = null;
  if (disabledBy) {
    reason = `Gateway disabled by ${disabledBy}.`;
  } else if (!envName) {
    reason = `No gateway key configured (looked for ${KEY_SOURCES.join(", ")}).`;
  } else if (urlProblem) {
    reason = `MINDARCHITECT_LLM_BASE_URL ${urlProblem}.`;
  }

  const configured = Boolean(envName);
  const enabled = !disabledBy;
  const usable = configured && enabled && !urlProblem;

  return {
    configured,
    enabled,
    usable,
    keySource: envName,
    apiKey,
    baseUrl,
    baseUrlIsDefault: baseUrlIsAssumed,
    model,
    /** True when the model id came from the provider default, not an explicit env var. */
    modelIsDefault: modelIsAssumed,
    timeoutMs,
    firstChunkTimeoutMs,
    probeTimeoutMs,
    chatUrl: `${baseUrl}/chat/completions`,
    modelsUrl: `${baseUrl}/models`,
    reason,
    disabledBy,
  };
}

/** Resolve the gateway configuration from the environment, fresh, every call. */
export function gatewayConfig(): GatewayConfig {
  return build();
}

/**
 * The serialisable view. Built by ALLOW-LIST, not by deleting `apiKey` from the
 * full object — so a field added to the config later cannot leak by being
 * forgotten here.
 */
export function publicConfig(cfg: GatewayConfig = gatewayConfig()): GatewayPublicConfig {
  return {
    configured: cfg.configured,
    enabled: cfg.enabled,
    usable: cfg.usable,
    keySource: cfg.keySource,
    baseUrl: cfg.baseUrl,
    baseUrlIsDefault: cfg.baseUrlIsDefault,
    model: cfg.model,
    modelIsDefault: cfg.modelIsDefault,
    timeoutMs: cfg.timeoutMs,
    firstChunkTimeoutMs: cfg.firstChunkTimeoutMs,
    probeTimeoutMs: cfg.probeTimeoutMs,
    chatUrl: cfg.chatUrl,
    modelsUrl: cfg.modelsUrl,
    reason: cfg.reason,
    disabledBy: cfg.disabledBy,
  };
}

/**
 * Remove anything that looks like the credential from arbitrary text.
 *
 * An upstream that rejects a request sometimes echoes the Authorization header
 * (or the key) in its error body. That body is surfaced to the user so the
 * failure is honest — so it must be scrubbed first, or the error path becomes
 * the leak path. Both the live key and generic provider token shapes are
 * matched, because the echoed value is not always byte-identical to ours.
 */
export function scrubSecrets(text: string, secret?: string | null): string {
  let out = text;
  if (secret) out = out.split(secret).join("[redacted-key]");
  // Generic shapes: sk-…, sk-proj-…, xai-…, or any 24+ char run that looks
  // like a bearer token.
  out = out.replace(/\b(?:sk|xai|gsk|api)[-_][A-Za-z0-9_-]{12,}\b/g, "[redacted-key]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, "Bearer [redacted-key]");
  // PROVIDER-MASKED echoes: "ab1_secr***************wxyz".
  //
  // Providers often mask the key themselves before echoing it, and the masked
  // form is not byte-identical to ours — so the exact-match rule above misses it
  // and the first 8 + last 4 characters leak. That is the LIVE case observed
  // against api.openai.com, not a hypothetical. The shape is distinctive: an
  // alphanumeric run containing 3+ consecutive asterisks. Markdown bold uses at
  // most two, so a token with three is a masked credential.
  out = out.replace(/\b[A-Za-z0-9_-]*\*{3,}[A-Za-z0-9_*-]*\b/g, "[redacted-key]");
  return out;
}

/**
 * Which model id to send upstream.
 *
 * The Studio speaks its own sovereign ids (`mindarchitect-synapse-v5.0`) and the
 * gateway speaks provider ids (`grok-4.5`). A sovereign id is mapped to the
 * configured transport model; anything else is passed through unchanged, which
 * lets an operator pin a real provider id in the Studio's model setting without
 * a code change. The sovereign id is still what the response reports back, so
 * the UI stays consistent — the upstream id is exposed alongside it.
 */
export function resolveGatewayModel(requested: string | undefined, configured: string): string {
  if (!requested) return configured;
  if (requested.startsWith("mindarchitect-")) return configured;
  return requested;
}
