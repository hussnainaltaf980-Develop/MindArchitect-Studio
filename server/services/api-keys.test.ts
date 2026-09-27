// ── Platform API key tests ──────────────────────────────────────────────────
//
// These run against the REAL database (`pnpm test` provisions the same dev
// instance the app uses), because the security properties under test — atomic
// rate limiting, hash-only storage, revoked/expired classification — all live in
// SQL. Mocking the database here would test the mock.
//
// The one thing every test in this file must not do is assert on a plaintext key
// after creation. `createApiKey` returns it once; after that the row is
// inspected for what it DOES contain (a digest, a prefix) and for what it must
// NOT (the plaintext).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../_core/db";
import { apiKeys, users } from "../../drizzle/schema";
import {
  ALL_SCOPES,
  ApiKeyError,
  DEFAULT_SCOPES,
  DEFAULT_RATE_LIMIT_PER_HOUR,
  KEY_PREFIX,
  authenticateApiKey,
  createApiKey,
  deleteApiKey,
  generateKey,
  hashKey,
  keyStatus,
  listApiKeys,
  looksLikeApiKey,
  parseBearer,
  revokeApiKey,
  rotateApiKey,
  SCOPES,
} from "./api-keys";

const stamp = Date.now();
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  const [a] = await db
    .insert(users)
    .values({ email: `apikeys-${stamp}@test.local`, name: "Key Owner" })
    .returning({ id: users.id });
  const [b] = await db
    .insert(users)
    .values({ email: `apikeys-other-${stamp}@test.local`, name: "Someone Else" })
    .returning({ id: users.id });
  userId = a.id;
  otherUserId = b.id;
});

afterAll(async () => {
  // Keys cascade from users, so this also proves the FK is wired.
  await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
});

// ── generation ──────────────────────────────────────────────────────────────
describe("key generation", () => {
  it("produces a recognisable, high-entropy key with a stored digest", () => {
    const k = generateKey();
    expect(k.plaintext.startsWith(KEY_PREFIX)).toBe(true);
    expect(k.plaintext.length).toBeGreaterThan(40);
    expect(looksLikeApiKey(k.plaintext)).toBe(true);

    // Stored form must be a digest, and must not contain the secret.
    expect(k.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.keyHash).not.toContain(k.plaintext);
    expect(k.prefix).toBe(k.plaintext.slice(0, 12));
    expect(k.last4).toBe(k.plaintext.slice(-4));
  });

  it("never repeats — 500 draws, all distinct", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generateKey().plaintext);
    expect(seen.size).toBe(500);
  });

  it("hashing is deterministic and hex", () => {
    const key = "ma_live_fixed-value_for-hashing";
    expect(hashKey(key)).toBe(hashKey(key));
    expect(hashKey(key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a key-shaped string that is too short", () => {
    expect(looksLikeApiKey("ma_live_short")).toBe(false);
    expect(looksLikeApiKey("sk-proj-somethingElse")).toBe(false);
  });

  it("parses only a well-formed Bearer header", () => {
    expect(parseBearer("Bearer ma_live_abc")).toBe("ma_live_abc");
    expect(parseBearer("bearer   ma_live_abc  ")).toBe("ma_live_abc");
    expect(parseBearer("Basic abc")).toBe(null);
    expect(parseBearer("ma_live_abc")).toBe(null); // missing the scheme
    expect(parseBearer(undefined)).toBe(null);
  });
});

// ── lifecycle ───────────────────────────────────────────────────────────────
describe("create / list / revoke", () => {
  it("creates a key, returns the plaintext exactly once, and stores no plaintext", async () => {
    const created = await createApiKey({ ownerId: userId, name: "CI pipeline" });
    expect(created.plaintext.startsWith(KEY_PREFIX)).toBe(true);
    expect(created.key.name).toBe("CI pipeline");
    expect(created.key.status).toBe("active");
    expect(created.key.scopes.sort()).toEqual([...DEFAULT_SCOPES].sort());

    // The PUBLIC shape must not carry the secret, in any variant.
    const serialised = JSON.stringify(created.key);
    expect(serialised).not.toContain(created.plaintext);
    expect(serialised).not.toContain("keyHash");
    expect("plaintext" in created.key).toBe(false);

    // The ROW must hold a digest and not the secret.
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.key.id));
    expect(row.keyHash).toBe(hashKey(created.plaintext));
    expect(row.keyHash).not.toBe(created.plaintext);
    expect(JSON.stringify(row)).not.toContain(created.plaintext);

    // …and a list response must not either.
    const listed = await listApiKeys(userId);
    expect(JSON.stringify(listed)).not.toContain(created.plaintext);
  });

  it("rejects a blank name and an unknown scope", async () => {
    await expect(createApiKey({ ownerId: userId, name: "   " })).rejects.toBeInstanceOf(ApiKeyError);
    await expect(
      createApiKey({ ownerId: userId, name: "bad scope", scopes: ["admin:everything" as never] }),
    ).rejects.toBeInstanceOf(ApiKeyError);
  });

  it("honours a custom hourly limit and clamps it to the maximum", async () => {
    const a = await createApiKey({ ownerId: userId, name: "low", rateLimitPerHour: 7 });
    expect(a.key.rateLimitPerHour).toBe(7);
    const b = await createApiKey({ ownerId: userId, name: "huge", rateLimitPerHour: 10 ** 9 });
    expect(b.key.rateLimitPerHour).toBeLessThanOrEqual(100_000);
  });

  it("revokes idempotently and preserves the original revocation time", async () => {
    const created = await createApiKey({ ownerId: userId, name: "to revoke" });
    const revoked = await revokeApiKey(userId, created.key.id, "test");
    expect(revoked?.status).toBe("revoked");
    const firstTime = revoked?.revokedAt;

    // A second revoke must not rewrite when it happened.
    const again = await revokeApiKey(userId, created.key.id, "test again");
    expect(again?.revokedAt).toBe(firstTime);
    expect(again?.revokedReason).toBe("test");
  });

  it("will not let one account touch another account's key", async () => {
    const mine = await createApiKey({ ownerId: userId, name: "private" });

    // Revoking with the wrong owner finds nothing…
    const stolen = await revokeApiKey(otherUserId, mine.key.id, "not mine");
    expect(stolen).toBe(null);

    // …and the key is still active.
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, mine.key.id));
    expect(row.revokedAt).toBe(null);

    // Deleting with the wrong owner is refused too.
    expect(await deleteApiKey(otherUserId, mine.key.id)).toBe(false);
    expect(await deleteApiKey(userId, mine.key.id)).toBe(true);
  });

  it("rotates: issues a working replacement and revokes the old one", async () => {
    const old = await createApiKey({ ownerId: userId, name: "rotate me" });
    const rotated = await rotateApiKey(userId, old.key.id);
    expect(rotated).not.toBe(null);

    // The NEW key works…
    const ok = await authenticateApiKey(rotated!.plaintext, SCOPES.CHAT);
    expect(ok.ok).toBe(true);

    // …the OLD one is refused as revoked, not as invalid.
    const dead = await authenticateApiKey(old.plaintext, SCOPES.CHAT);
    expect(dead.ok).toBe(false);
    if (!dead.ok) {
      expect(dead.code).toBe("revoked_key");
      expect(dead.httpStatus).toBe(403);
    }
  });
});

// ── authentication ──────────────────────────────────────────────────────────
describe("authentication", () => {
  it("401s a missing key with guidance, not a bare refusal", async () => {
    const out = await authenticateApiKey(null, SCOPES.CHAT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("missing_key");
      expect(out.httpStatus).toBe(401);
      expect(out.message).toContain("Bearer");
    }
  });

  it("401s an unknown-but-well-formed key", async () => {
    const out = await authenticateApiKey(`ma_live_${"a".repeat(43)}`, SCOPES.CHAT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("invalid_key");
      expect(out.httpStatus).toBe(401);
    }
  });

  it("401s a malformed key without revealing that the shape was wrong", async () => {
    const garbage = await authenticateApiKey("not-a-key-at-all", SCOPES.CHAT);
    const unknown = await authenticateApiKey(`ma_live_${"b".repeat(43)}`, SCOPES.CHAT);
    expect(garbage.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (!garbage.ok && !unknown.ok) {
      // Identical outward answer, so probing cannot distinguish the two.
      expect(garbage.code).toBe(unknown.code);
      expect(garbage.httpStatus).toBe(unknown.httpStatus);
      expect(garbage.message).toBe(unknown.message);
    }
  });

  it("authenticates a live key and reports the remaining budget", async () => {
    const created = await createApiKey({ ownerId: userId, name: "valid", rateLimitPerHour: 50 });
    const out = await authenticateApiKey(created.plaintext, SCOPES.CHAT);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.key.id).toBe(created.key.id);
      expect(out.limit).toBe(50);
      expect(out.remaining).toBe(49); // one spent by this very call
      expect(new Date(out.windowResetsAt).getTime()).toBeGreaterThan(Date.now() - 1000);
    }
  });

  it("403s a revoked key — distinct from 401, so the caller knows to rotate", async () => {
    const created = await createApiKey({ ownerId: userId, name: "revoked" });
    await revokeApiKey(userId, created.key.id, "leaked");

    const out = await authenticateApiKey(created.plaintext, SCOPES.CHAT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("revoked_key");
      expect(out.httpStatus).toBe(403); // NOT 401
      expect(out.message).toContain("revoked");
    }
  });

  it("403s an expired key and names the date", async () => {
    const created = await createApiKey({ ownerId: userId, name: "expired", expiresInDays: 1 });
    // Backdate the expiry rather than waiting a day.
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(apiKeys.id, created.key.id));

    const out = await authenticateApiKey(created.plaintext, SCOPES.CHAT);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("expired_key");
      expect(out.httpStatus).toBe(403);
      expect(out.message).toContain("expired");
    }
  });

  it("403s a key without the required scope", async () => {
    const created = await createApiKey({
      ownerId: userId,
      name: "models only",
      scopes: [SCOPES.MODELS],
    });
    const has = await authenticateApiKey(created.plaintext, SCOPES.MODELS);
    expect(has.ok).toBe(true);

    const lacks = await authenticateApiKey(created.plaintext, SCOPES.CHAT);
    expect(lacks.ok).toBe(false);
    if (!lacks.ok) {
      expect(lacks.code).toBe("insufficient_scope");
      expect(lacks.httpStatus).toBe(403);
    }
  });

  it("counts usage and records lastUsedAt", async () => {
    const created = await createApiKey({ ownerId: userId, name: "counted" });
    expect(created.key.requestCount).toBe(0);
    expect(created.key.lastUsedAt).toBe(null);

    await authenticateApiKey(created.plaintext, SCOPES.CHAT);
    await authenticateApiKey(created.plaintext, SCOPES.CHAT);

    const listed = (await listApiKeys(userId)).find((k) => k.id === created.key.id);
    expect(listed?.requestCount).toBe(2);
    expect(listed?.lastUsedAt).not.toBe(null);
  });
});

// ── rate limiting ───────────────────────────────────────────────────────────
describe("rate limiting", () => {
  it("allows exactly the budget then 429s with Retry-After", async () => {
    const limit = 3;
    const created = await createApiKey({
      ownerId: userId,
      name: "tight limit",
      rateLimitPerHour: limit,
    });

    for (let i = 0; i < limit; i += 1) {
      const out = await authenticateApiKey(created.plaintext, SCOPES.CHAT);
      expect(out.ok, `call ${i + 1} of ${limit} should be allowed`).toBe(true);
    }

    const refused = await authenticateApiKey(created.plaintext, SCOPES.CHAT);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("rate_limited");
      expect(refused.httpStatus).toBe(429);
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });

  it("does NOT count a refused request against the quota", async () => {
    const created = await createApiKey({
      ownerId: userId,
      name: "refusal accounting",
      rateLimitPerHour: 2,
    });
    await authenticateApiKey(created.plaintext, SCOPES.CHAT);
    await authenticateApiKey(created.plaintext, SCOPES.CHAT);
    await authenticateApiKey(created.plaintext, SCOPES.CHAT); // refused
    await authenticateApiKey(created.plaintext, SCOPES.CHAT); // refused

    const listed = (await listApiKeys(userId)).find((k) => k.id === created.key.id);
    // Four calls, two allowed: the counter must read 2, not 4. A limiter that
    // counts its own refusals lets a client inflate its own usage.
    expect(listed?.requestCount).toBe(2);
  });

  it("resets the window once an hour has passed", async () => {
    const created = await createApiKey({
      ownerId: userId,
      name: "window reset",
      rateLimitPerHour: 1,
    });
    expect((await authenticateApiKey(created.plaintext, SCOPES.CHAT)).ok).toBe(true);
    expect((await authenticateApiKey(created.plaintext, SCOPES.CHAT)).ok).toBe(false);

    // Age the window past the boundary.
    await db
      .update(apiKeys)
      .set({ windowStart: new Date(Date.now() - 3_700_000) })
      .where(eq(apiKeys.id, created.key.id));

    const afterReset = await authenticateApiKey(created.plaintext, SCOPES.CHAT);
    expect(afterReset.ok).toBe(true);
    if (afterReset.ok) expect(afterReset.remaining).toBe(0); // the single slot is now spent
  });

  it("enforces the limit atomically under concurrency", async () => {
    const limit = 5;
    const created = await createApiKey({
      ownerId: userId,
      name: "concurrent",
      rateLimitPerHour: limit,
    });

    // 25 simultaneous calls against a limit of 5. If enforcement were a
    // read-then-write, more than 5 would succeed; the conditional UPDATE is what
    // makes the count exact.
    const results = await Promise.all(
      Array.from({ length: 25 }, () => authenticateApiKey(created.plaintext, SCOPES.CHAT)),
    );
    expect(results.filter((r) => r.ok).length).toBe(limit);

    const listed = (await listApiKeys(userId)).find((k) => k.id === created.key.id);
    expect(listed?.requestCount).toBe(limit);
  });
});

// ── status classification ───────────────────────────────────────────────────
describe("status", () => {
  it("distinguishes active, revoked and expired", () => {
    expect(keyStatus({ revokedAt: null, expiresAt: null })).toBe("active");
    expect(keyStatus({ revokedAt: new Date(), expiresAt: null })).toBe("revoked");
    expect(keyStatus({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) })).toBe("expired");
    expect(keyStatus({ revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) })).toBe("active");
    // Revocation wins over expiry when both apply: withdrawn is the stronger fact.
    expect(keyStatus({ revokedAt: new Date(), expiresAt: new Date(Date.now() - 1000) })).toBe("revoked");
  });

  it("treats an unparseable expiry as active rather than silently locked out", () => {
    expect(keyStatus({ revokedAt: null, expiresAt: "not-a-date" })).toBe("active");
  });
});

// ── limits ──────────────────────────────────────────────────────────────────
describe("account ceiling", () => {
  it("refuses a key beyond the per-account maximum", async () => {
    const [fresh] = await db
      .insert(users)
      .values({ email: `apikeys-many-${stamp}@test.local`, name: "Many Keys" })
      .returning({ id: users.id });

    try {
      for (let i = 0; i < 25; i += 1) {
        await createApiKey({ ownerId: fresh.id, name: `k${i}` });
      }
      await expect(createApiKey({ ownerId: fresh.id, name: "one too many" })).rejects.toBeInstanceOf(
        ApiKeyError,
      );

      // Revoking frees a slot, so the ceiling counts ACTIVE keys.
      const all = await listApiKeys(fresh.id);
      await revokeApiKey(fresh.id, all[0].id, "free a slot");
      const reclaimed = await createApiKey({ ownerId: fresh.id, name: "after revoke" });
      expect(reclaimed.key.status).toBe("active");
    } finally {
      await db.delete(users).where(eq(users.id, fresh.id));
    }
  });
});

// ── defaults ────────────────────────────────────────────────────────────────
describe("defaults", () => {
  it("exposes a coherent scope set and a sane default budget", () => {
    expect(ALL_SCOPES.length).toBeGreaterThan(0);
    expect(DEFAULT_SCOPES.every((s) => ALL_SCOPES.includes(s))).toBe(true);
    expect(DEFAULT_RATE_LIMIT_PER_HOUR).toBeGreaterThan(0);
  });

  it("keeps a key's scopes intact through a list round-trip", async () => {
    const created = await createApiKey({
      ownerId: userId,
      name: "scope round-trip",
      scopes: [SCOPES.MODELS],
    });
    const listed = (await listApiKeys(userId)).find((k) => k.id === created.key.id);
    expect(listed?.scopes).toEqual([SCOPES.MODELS]);
  });

  it("drops junk scopes rather than echoing them back", async () => {
    const created = await createApiKey({ ownerId: userId, name: "junk scopes" });
    // Simulate a row written before a scope was renamed.
    await db
      .update(apiKeys)
      .set({ scopes: ["chat:write", "legacy:scope"] as unknown as object })
      .where(eq(apiKeys.id, created.key.id));

    const listed = (await listApiKeys(userId)).find((k) => k.id === created.key.id);
    expect(listed?.scopes).toEqual(["chat:write"]);
  });
});

// ── the one that must never pass ────────────────────────────────────────────
describe("secret hygiene", () => {
  it("no stored row anywhere contains a plaintext key", async () => {
    const created = await createApiKey({ ownerId: userId, name: "hygiene" });

    // Read EVERY column back raw and scan the whole serialisation. If a plaintext
    // key ever reached a column, this is what catches it.
    const rows = await db.select().from(apiKeys).where(eq(apiKeys.ownerId, userId));
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain(created.plaintext);
    // The digest is expected — assert it IS present, so the scan above is
    // demonstrably looking at the right row and can actually fail.
    expect(blob).toContain(hashKey(created.plaintext));

    // Last4 and prefix are intentionally present, and are not the secret.
    expect(blob).toContain(created.key.last4);
    expect(created.plaintext.includes(created.key.last4)).toBe(true);
    expect(created.plaintext.length).toBeGreaterThan(created.key.prefix.length);
  });

  it("an error message for a bad key never echoes the key", async () => {
    const secret = `ma_live_${"z".repeat(43)}`;
    const out = await authenticateApiKey(secret, SCOPES.CHAT);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).not.toContain(secret);
  });

  it("cleans up revoked-and-deleted keys without orphaning", async () => {
    const created = await createApiKey({ ownerId: userId, name: "delete me" });
    expect(await deleteApiKey(userId, created.key.id)).toBe(true);
    const [gone] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.key.id));
    expect(gone).toBeUndefined();
  });
});
