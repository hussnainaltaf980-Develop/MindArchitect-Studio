// ── MindArchitect Studio · request authentication ───────────────────────────
//
// One middleware that answers a single question for the /v1 surface: WHO is
// calling, and are they allowed to?
//
// Two credentials are accepted, and the ORDER MATTERS:
//
//   1. `Authorization: Bearer ma_live_…` — a platform API key. If this header is
//      present it is the ONLY thing consulted. A bad key must never fall back to
//      the session cookie: that would turn an expired key into a silent success
//      for anyone with a browser session, which is the opposite of what a
//      developer rotating a key expects to see.
//   2. The session cookie — how the Studio UI itself calls these routes. The
//      browser is already authenticated; requiring a key there would be asking
//      users to paste a secret into the app that issued it.
//
// Failure codes are deliberate and distinct, because a caller needs to know what
// to DO about it:
//
//   401  no credential at all, or a key that matches nothing  → authenticate
//   403  a real key that is revoked, expired or under-scoped  → fix the key
//   429  over the hourly limit                                → wait
//
// A revoked key answering 403 rather than 401 is the whole point: the identity
// is known and the answer is no. Collapsing the two leaves a developer staring
// at "invalid key" for a key that is in fact valid but withdrawn.
import type { Context, Next } from "hono";
import {
  authenticateApiKey,
  parseBearer,
  type AuthOutcome,
  type PublicApiKey,
  type Scope,
} from "../services/api-keys";
import { authProvider } from "../_core/auth";

export type StudioAuthVariables = {
  /** Set when a platform API key authenticated the request. */
  apiKey: PublicApiKey;
  /** Set when the session cookie did. Null for key-authenticated calls. */
  sessionUser: { id: string; email: string; name?: string | null } | null;
  /** Which of the two was used. Handy for logging without touching secrets. */
  authMode: "api_key" | "session";
};

/** Shape of the error body. Deliberately mirrors the OpenAI error envelope. */
function errorBody(code: string, message: string) {
  return { error: { message, type: "invalid_request_error", code, param: null } };
}

/**
 * Build the middleware for a route that needs `scope`.
 *
 * `allowSession` defaults to true (the Studio UI). Set it false for a route that
 * is API-only — then the session cookie is not even consulted and the caller
 * must present a key.
 */
export function requireStudioAuth(opts: { scope: Scope; allowSession?: boolean }) {
  const allowSession = opts.allowSession ?? true;

  return async (c: Context, next: Next) => {
    const header = c.req.header("authorization");
    const presented = parseBearer(header);

    // ── path 1: an Authorization header was offered ──────────────────────────
    // Also catches `Authorization: <something not Bearer>`: `parseBearer` returns
    // null for it, but the header EXISTS, so this is not "anonymous" — it is a
    // malformed credential attempt and must not silently fall through to the
    // session.
    if (header !== undefined) {
      const outcome: AuthOutcome = await authenticateApiKey(presented, opts.scope);

      if (outcome.ok) {
        c.set("apiKey", outcome.key);
        c.set("sessionUser", null);
        c.set("authMode", "api_key");
        // Rate-limit headers on the WAY OUT, not just on a 429. A client that can
        // only learn its budget by being refused cannot pace itself.
        c.header("x-ratelimit-limit", String(outcome.limit));
        c.header("x-ratelimit-remaining", String(outcome.remaining));
        c.header("x-ratelimit-reset", outcome.windowResetsAt);
        await next();
        return;
      }

      const status = outcome.httpStatus;
      if (outcome.code === "rate_limited" && outcome.retryAfterSeconds) {
        c.header("retry-after", String(outcome.retryAfterSeconds));
      }
      // `insufficient_scope` is only reachable once the key is proven live, so it
      // is genuinely a 403 even though the credential itself is fine.
      return c.json(errorBody(outcome.code, outcome.message), status);
    }

    // ── path 2: no Authorization header ─────────────────────────────────────
    if (!allowSession) {
      return c.json(
        errorBody(
          "missing_key",
          "This endpoint requires an API key. Send it as `Authorization: Bearer ma_live_…`.",
        ),
        401,
      );
    }

    const user = await authProvider().getSession(c);
    if (!user) {
      return c.json(
        errorBody(
          "missing_key",
          "Not authenticated. Either sign in to MindArchitect Studio or send an API key " +
            "as `Authorization: Bearer ma_live_…`.",
        ),
        401,
      );
    }

    c.set("apiKey", null as unknown as PublicApiKey);
    c.set("sessionUser", { id: user.id, email: user.email, name: user.name ?? null });
    c.set("authMode", "session");
    await next();
  };
}

/**
 * Attach the authenticated subject to a response, for the client's benefit.
 *
 * Returns ONLY non-secret fields. Note what is absent: no key hash, no plaintext,
 * no prefix. A caller already knows which key it used; echoing anything back just
 * creates a second place a credential can be logged.
 */
export function authEcho(c: Context) {
  const mode = c.get("authMode") as StudioAuthVariables["authMode"] | undefined;
  const key = c.get("apiKey") as PublicApiKey | null | undefined;
  const user = c.get("sessionUser") as StudioAuthVariables["sessionUser"] | undefined;
  return {
    mode: mode ?? "session",
    keyId: key?.id ?? null,
    keyName: key?.name ?? null,
    scopes: key?.scopes ?? null,
    userId: user?.id ?? null,
  };
}
