// ── MindArchitect Studio · platform API keys ────────────────────────────────
//
// The Studio issues its own developer keys, the way a model provider does, so a
// user can call the platform's models from their own code. This module owns the
// whole lifecycle: generation, verification, revocation, usage accounting and
// the per-key rate limit.
//
// WHAT IS STORED, AND WHY IT IS ENOUGH
// ────────────────────────────────────
// The plaintext key exists exactly once — in the response to `createApiKey`. The
// row keeps a SHA-256 digest and a 12-character display prefix. Nothing can
// recover the key afterwards; a lost key is replaced, not looked up.
//
// A single SHA-256 pass is the RIGHT primitive here, not a shortcut past bcrypt.
// A password is low-entropy and guessable, so it needs a deliberately slow hash.
// This key is 256 bits from the CSPRNG: there is no dictionary to search, the
// only feasible attack is a preimage on SHA-256, and a slow KDF would add that
// cost to every single API request while changing nothing about the attacker's
// work. Using bcrypt here would be cargo-culting a password rule onto a token.
//
// THE RATE LIMIT IS ONE STATEMENT, NOT A READ-THEN-WRITE
// ─────────────────────────────────────────────────────
// Enforcement and accounting happen in a single conditional UPDATE with the
// limit in the WHERE clause. That matters for three reasons:
//   * it is atomic without a transaction, so it behaves identically on the tcp
//     and http drivers — `_core/db.ts` documents that interactive transactions
//     do not exist on the http driver, and a read-modify-write would silently
//     allow N concurrent requests past a limit of 1;
//   * a crash between "allowed" and "counted" cannot happen, because there is no
//     between;
//   * the request that is refused does NOT increment the counter, so a client
//     hammering a throttled key cannot also inflate its own usage.
import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../_core/db";
import { apiKeys } from "../../drizzle/schema";

/** Every key starts with this, so a leaked string is recognisable as ours. */
export const KEY_PREFIX = "ma_live_";

/** Characters of the plaintext kept for display. `ma_live_` + 4. */
const DISPLAY_PREFIX_LEN = 12;

/** Default requests per rolling hour when a key does not set its own. */
export const DEFAULT_RATE_LIMIT_PER_HOUR = (() => {
  const raw = Number(process.env.MINDARCHITECT_KEY_RATE_LIMIT_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120;
})();

/** Hard ceiling, so a key cannot be created that effectively has no limit. */
export const MAX_RATE_LIMIT_PER_HOUR = 100_000;

// ── scopes ──────────────────────────────────────────────────────────────────
// Deliberately a small, closed set. A scope system that accepts arbitrary
// strings is a scope system nothing can enforce.
export const SCOPES = {
  CHAT: "chat:write",
  MODELS: "models:read",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const ALL_SCOPES: Scope[] = [SCOPES.CHAT, SCOPES.MODELS];

/** What a key gets when the creator does not choose. */
export const DEFAULT_SCOPES: Scope[] = [SCOPES.CHAT, SCOPES.MODELS];

/**
 * The scopes a request needs, by route. Kept next to the scopes rather than in
 * the route file so a new endpoint cannot be added without this list being
 * visibly the thing that grants it access.
 */
export const ROUTE_SCOPES = {
  "chat.completions": SCOPES.CHAT,
  "models.list": SCOPES.MODELS,
} as const;

// ── generation ──────────────────────────────────────────────────────────────
export type GeneratedKey = {
  /** The only copy that will ever exist. Never store it, never log it. */
  plaintext: string;
  keyHash: string;
  prefix: string;
  last4: string;
};

/**
 * sha256, hex. Exported so tests can assert the stored value is a digest and not
 * a length-preserving copy of the key.
 */
export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * 256 bits of CSPRNG entropy, base64url-encoded.
 *
 * `randomBytes` is the cryptographic source — `Math.random` would be a real
 * vulnerability here, and it is the single easiest way to get this wrong.
 * base64url (not base64) so the key survives a URL, a shell argument and a
 * copied-and-pasted header without escaping.
 */
export function generateKey(environment = "live"): GeneratedKey {
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `ma_${environment}_${secret}`;
  return {
    plaintext,
    keyHash: hashKey(plaintext),
    prefix: plaintext.slice(0, DISPLAY_PREFIX_LEN),
    last4: plaintext.slice(-4),
  };
}

// ── the public shape ────────────────────────────────────────────────────────
/**
 * What a client is allowed to see about a key.
 *
 * Built by ALLOW-LIST, never by spreading the row and deleting `keyHash`. A
 * field added to the table later would otherwise leak by being forgotten here —
 * and the field most likely to be added to this table is another secret.
 */
export type PublicApiKey = {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  environment: string;
  scopes: Scope[];
  rateLimitPerHour: number;
  requestCount: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  status: KeyStatus;
};

export type KeyStatus = "active" | "revoked" | "expired";

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Classification. There are THREE states and collapsing them loses the thing the
 * user needs: a revoked key must be rotated, an expired one renews, and an
 * active one needs nothing. `expiresAt <= now` is checked before the row is
 * reported as active, so the list never shows a lapsed key as usable.
 */
export function keyStatus(row: {
  revokedAt: Date | string | null;
  expiresAt: Date | string | null;
}, now = new Date()): KeyStatus {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt) {
    const exp = row.expiresAt instanceof Date ? row.expiresAt : new Date(String(row.expiresAt));
    if (Number.isFinite(exp.getTime()) && exp.getTime() <= now.getTime()) return "expired";
  }
  return "active";
}

function asScopes(raw: unknown): Scope[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is Scope => typeof s === "string" && (ALL_SCOPES as string[]).includes(s));
}

function toPublic(row: typeof apiKeys.$inferSelect, now = new Date()): PublicApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    last4: row.last4,
    environment: row.environment,
    scopes: asScopes(row.scopes),
    rateLimitPerHour: row.rateLimitPerHour ?? DEFAULT_RATE_LIMIT_PER_HOUR,
    requestCount: Number(row.requestCount ?? 0),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
    revokedReason: row.revokedReason,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
    status: keyStatus(row, now),
  };
}

// ── errors ──────────────────────────────────────────────────────────────────
export class ApiKeyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_name"
      | "invalid_scopes"
      | "invalid_limit"
      | "not_found"
      | "too_many_keys",
  ) {
    super(message);
    this.name = "ApiKeyError";
  }
}

/** A per-account ceiling. Without it one account can fill the table. */
export const MAX_KEYS_PER_ACCOUNT = 25;

// ── lifecycle ───────────────────────────────────────────────────────────────
export type CreateApiKeyInput = {
  ownerId: string;
  name: string;
  scopes?: Scope[];
  rateLimitPerHour?: number | null;
  /** Days until expiry. Omitted = never expires. */
  expiresInDays?: number | null;
};

export type CreateApiKeyResult = {
  /** Shown once. The caller must present it to the user and then drop it. */
  plaintext: string;
  key: PublicApiKey;
};

export async function createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  const name = input.name?.trim();
  if (!name) throw new ApiKeyError("A key needs a name.", "invalid_name");
  if (name.length > 64) {
    throw new ApiKeyError("Key names are limited to 64 characters.", "invalid_name");
  }

  const scopes = input.scopes?.length ? input.scopes : DEFAULT_SCOPES;
  const unknown = scopes.filter((s) => !(ALL_SCOPES as string[]).includes(s));
  if (unknown.length) {
    throw new ApiKeyError(
      `Unknown scope${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        `Valid scopes are ${ALL_SCOPES.join(", ")}.`,
      "invalid_scopes",
    );
  }

  let limit = input.rateLimitPerHour ?? DEFAULT_RATE_LIMIT_PER_HOUR;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new ApiKeyError("The rate limit must be a positive number of requests per hour.", "invalid_limit");
  }
  limit = Math.min(MAX_RATE_LIMIT_PER_HOUR, Math.floor(limit));

  const existing = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.ownerId, input.ownerId), isNull(apiKeys.revokedAt)));
  if (existing.length >= MAX_KEYS_PER_ACCOUNT) {
    throw new ApiKeyError(
      `You already have ${MAX_KEYS_PER_ACCOUNT} active keys. Revoke one before creating another.`,
      "too_many_keys",
    );
  }

  const expiresAt =
    input.expiresInDays && input.expiresInDays > 0
      ? new Date(Date.now() + input.expiresInDays * 86_400_000)
      : null;

  const gen = generateKey("live");
  const [row] = await db
    .insert(apiKeys)
    .values({
      ownerId: input.ownerId,
      name,
      keyHash: gen.keyHash,
      prefix: gen.prefix,
      last4: gen.last4,
      environment: "live",
      scopes: scopes as unknown as object,
      rateLimitPerHour: limit,
      expiresAt,
    })
    .returning();

  // `plaintext` is returned and deliberately NOT included in `toPublic`, so it
  // cannot reach a list response by accident: the only path it travels is this
  // one return value.
  return { plaintext: gen.plaintext, key: toPublic(row) };
}

export async function listApiKeys(ownerId: string): Promise<PublicApiKey[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.ownerId, ownerId))
    .orderBy(desc(apiKeys.createdAt));
  const now = new Date();
  return rows.map((r) => toPublic(r, now));
}

/**
 * Revoke, scoped to the owner.
 *
 * The `revokedAt IS NULL` guard makes this idempotent AND keeps the original
 * revocation timestamp: revoking twice does not rewrite when it happened, which
 * would quietly destroy the audit trail.
 */
export async function revokeApiKey(
  ownerId: string,
  id: string,
  reason: string | null = null,
): Promise<PublicApiKey | null> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.ownerId, ownerId), isNull(apiKeys.revokedAt)))
    .returning();

  if (rows.length) return toPublic(rows[0]);

  // Already revoked, or not this owner's. Read it back so the caller can tell
  // "already revoked" (fine, return the row) from "no such key" (404).
  const [existing] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.ownerId, ownerId)));
  return existing ? toPublic(existing) : null;
}

/** Hard delete, owner-scoped. Offered for cleanup of never-used keys. */
export async function deleteApiKey(ownerId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.ownerId, ownerId)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/** Rotate: create a replacement and revoke the old one in the same call. */
export async function rotateApiKey(
  ownerId: string,
  id: string,
): Promise<CreateApiKeyResult | null> {
  const [existing] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.ownerId, ownerId)));
  if (!existing) return null;

  const created = await createApiKey({
    ownerId,
    name: `${existing.name} (rotated)`,
    scopes: asScopes(existing.scopes),
    rateLimitPerHour: existing.rateLimitPerHour,
  });
  await revokeApiKey(ownerId, id, "rotated");
  return created;
}

// ── authentication ──────────────────────────────────────────────────────────
export type AuthFailureCode =
  /** No key presented at all, or not in Bearer form. */
  | "missing_key"
  /** Presented, but matches no row, or is malformed. */
  | "invalid_key"
  /** Matched a row that has been revoked. 403, not 401 — the identity is known. */
  | "revoked_key"
  /** Matched a row past its expiry. */
  | "expired_key"
  /** Valid, but has not been granted the scope this route needs. */
  | "insufficient_scope"
  /** Over its hourly limit. */
  | "rate_limited";

export type AuthOutcome =
  | {
      ok: true;
      key: PublicApiKey;
      remaining: number;
      limit: number;
      windowResetsAt: string;
    }
  | {
      ok: false;
      code: AuthFailureCode;
      message: string;
      httpStatus: 400 | 401 | 403 | 429;
      /** Present for `rate_limited`. Seconds until the window resets. */
      retryAfterSeconds?: number;
    };

/** Strip the scheme and whitespace. Rejects anything that is not a Bearer token. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^\s*Bearer\s+([^\s]+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/** Cheap shape check before touching the database, so junk never becomes a query. */
export function looksLikeApiKey(candidate: string): boolean {
  return /^ma_(live|test)_[A-Za-z0-9_-]{20,}$/.test(candidate);
}

/**
 * Verify a key and, if it is usable, spend one unit of its rate limit.
 *
 * The successful path is ONE statement (see the file header). The failure path
 * adds a single indexed lookup, but only to explain the failure — a refused
 * request costs no counter increment.
 */
export async function authenticateApiKey(
  plaintext: string | null,
  requiredScope: Scope,
): Promise<AuthOutcome> {
  if (!plaintext) {
    return {
      ok: false,
      code: "missing_key",
      message:
        "No API key was provided. Send it as `Authorization: Bearer ma_live_…`. " +
        "Create one in MindArchitect Studio under Settings → API keys.",
      httpStatus: 401,
    };
  }

  if (!looksLikeApiKey(plaintext)) {
    // Deliberately the same outward answer as an unknown key: distinguishing
    // "malformed" from "not found" tells an attacker which of their guesses had
    // the right shape.
    return {
      ok: false,
      code: "invalid_key",
      message: "That API key is not valid.",
      httpStatus: 401,
    };
  }

  const digest = hashKey(plaintext);
  const windowSeconds = 3600;

  // One statement: enforce the limit, record the use, and return the row — all
  // conditioned on the key being live and the window having room. The CASE
  // expressions reset the window inline, so there is no separate "have we rolled
  // over yet" step to race against.
  const updated = await db
    .update(apiKeys)
    .set({
      requestCount: sql`${apiKeys.requestCount} + 1`,
      lastUsedAt: sql`now()`,
      windowStart: sql`CASE WHEN ${apiKeys.windowStart} < now() - make_interval(secs => ${windowSeconds}) THEN now() ELSE ${apiKeys.windowStart} END`,
      windowCount: sql`CASE WHEN ${apiKeys.windowStart} < now() - make_interval(secs => ${windowSeconds}) THEN 1 ELSE ${apiKeys.windowCount} + 1 END`,
    })
    .where(
      sql`${apiKeys.keyHash} = ${digest}
        AND ${apiKeys.revokedAt} IS NULL
        AND (${apiKeys.expiresAt} IS NULL OR ${apiKeys.expiresAt} > now())
        AND (CASE WHEN ${apiKeys.windowStart} < now() - make_interval(secs => ${windowSeconds})
                  THEN 0 ELSE ${apiKeys.windowCount} END)
            < COALESCE(${apiKeys.rateLimitPerHour}, ${DEFAULT_RATE_LIMIT_PER_HOUR})`,
    )
    .returning();

  if (updated.length) {
    const row = updated[0];
    const limit = row.rateLimitPerHour ?? DEFAULT_RATE_LIMIT_PER_HOUR;
    const started = row.windowStart instanceof Date ? row.windowStart : new Date(String(row.windowStart));
    const resets = new Date(started.getTime() + windowSeconds * 1000);
    const publicKey = toPublic(row);

    // Scope is checked AFTER the key is proven live, so a revoked key reports
    // "revoked" rather than "insufficient scope" — the more useful answer.
    if (!publicKey.scopes.includes(requiredScope)) {
      return {
        ok: false,
        code: "insufficient_scope",
        message:
          `This key does not have the \`${requiredScope}\` scope. ` +
          `Granted: ${publicKey.scopes.join(", ") || "none"}.`,
        httpStatus: 403,
      };
    }

    return {
      ok: true,
      key: publicKey,
      remaining: Math.max(0, limit - row.windowCount),
      limit,
      windowResetsAt: resets.toISOString(),
    };
  }

  // ── the statement matched nothing: establish WHY ──
  const [found] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, digest));
  if (!found) {
    return {
      ok: false,
      code: "invalid_key",
      message: "That API key is not valid.",
      httpStatus: 401,
    };
  }

  const status = keyStatus(found);
  if (status === "revoked") {
    return {
      ok: false,
      code: "revoked_key",
      message:
        "This API key has been revoked." +
        (found.revokedReason ? ` (${found.revokedReason})` : "") +
        " Create a new one in the Studio.",
      httpStatus: 403,
    };
  }
  if (status === "expired") {
    return {
      ok: false,
      code: "expired_key",
      message: `This API key expired on ${iso(found.expiresAt)?.slice(0, 10)}. Create a new one in the Studio.`,
      httpStatus: 403,
    };
  }

  // Live, but the window is full.
  const limit = found.rateLimitPerHour ?? DEFAULT_RATE_LIMIT_PER_HOUR;
  const started = found.windowStart instanceof Date ? found.windowStart : new Date(String(found.windowStart));
  const resetsAt = new Date(started.getTime() + windowSeconds * 1000);
  const retryAfter = Math.max(1, Math.ceil((resetsAt.getTime() - Date.now()) / 1000));
  return {
    ok: false,
    code: "rate_limited",
    message: `Rate limit reached: ${limit} requests per hour. Try again in ${retryAfter}s.`,
    httpStatus: 429,
    retryAfterSeconds: retryAfter,
  };
}

/** Aggregate usage for the settings panel. Owner-scoped, derived from the rows. */
export async function apiKeyUsageSummary(ownerId: string) {
  const keys = await listApiKeys(ownerId);
  const active = keys.filter((k) => k.status === "active");
  return {
    total: keys.length,
    active: active.length,
    revoked: keys.filter((k) => k.status === "revoked").length,
    expired: keys.filter((k) => k.status === "expired").length,
    requests: keys.reduce((sum, k) => sum + k.requestCount, 0),
    lastUsedAt: keys
      .map((k) => k.lastUsedAt)
      .filter((v): v is string => Boolean(v))
      .sort()
      .at(-1) ?? null,
  };
}
