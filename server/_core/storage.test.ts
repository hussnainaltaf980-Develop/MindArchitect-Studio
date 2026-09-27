import { beforeEach, describe, expect, it, vi } from "vitest";

// Both mocks are hoisted by vitest, so storage.ts sees them at import time.
// This matters: env.ts calls required("DATABASE_URL") at module load and db.ts
// opens a DB driver (node-postgres pool or Neon HTTP) — neither can run here.
vi.mock("./env", () => ({
  env: { storage: { presignUrl: "https://platform.test/presign", token: "tok.sig" } },
}));

// Minimal Drizzle stand-in. Every builder method returns the same chainable
// object and the object itself is thenable, so any call order resolves to the
// preset result. `calls` records which entry points ran, in order, which is what
// the delete-ordering test asserts on.
//
// `timeline` is a SEPARATE, shared log that also receives a "fetch" entry
// (pushed by the wrapper around fetchMock below). `calls` alone cannot prove
// relative ordering between the DB and the platform HTTP call — it only
// records DB entry points — so anything that asserts "X happens before Y"
// across that boundary must assert on `timeline`, not `calls`.
const dbState: {
  result: unknown[];
  calls: string[];
  timeline: string[];
  values?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  conflictSet?: Record<string, unknown>;
} = { result: [], calls: [], timeline: [] };

vi.mock("./db", () => {
  const chain = (entry: string) => {
    dbState.calls.push(entry);
    dbState.timeline.push(`db:${entry}`);
    const obj: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "set", "returning"]) {
      obj[m] = () => obj;
    }
    // values(), limit() and offset() additionally RECORD their argument — the
    // row shape and the limit/offset floors are behaviours worth asserting, and
    // a fake that swallowed them would let tests named after those behaviours
    // pass without checking.
    obj.values = (v: Record<string, unknown>) => {
      dbState.values = v;
      return obj;
    };
    obj.limit = (n: number) => {
      dbState.limit = n;
      return obj;
    };
    obj.offset = (n: number) => {
      dbState.offset = n;
      return obj;
    };
    // onConflictDoUpdate's `set` object is also worth recording: it's the only
    // way to pin which columns a re-commit is allowed to touch (see the
    // owner-is-immutable test below).
    obj.onConflictDoUpdate = (arg: { set: Record<string, unknown> }) => {
      dbState.conflictSet = arg.set;
      return obj;
    };
    obj.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(dbState.result).then(ok, err);
    return obj;
  };
  return {
    db: { select: () => chain("select"), insert: () => chain("insert"), delete: () => chain("delete") },
    schema: {},
  };
});

// LOAD-BEARING: this must stay a top-level `await import`, not a static import.
// vi.mock calls are hoisted above the `const dbState` declaration, and the ./db
// factory closes over dbState — a static import would evaluate that factory
// before dbState is initialized and throw "Cannot access before initialization".
// Do not "tidy" this into `import { ... } from "./storage"`.
const { StorageError, storageCommit, storageGet, storageListByOwner, storageListAll,
        storageDeleteOwned, storageDeleteAny, storageDeleteAnonymous, storagePutUrl,
        storageCountByOwner, storageCountAll, serveAppStorage } = await import("./storage");

// fetchMock is what tests configure/assert on (mockResolvedValue, mock.calls);
// the actual global `fetch` is a thin wrapper that logs to the shared
// dbState.timeline before delegating, so mockResolvedValue() on fetchMock
// keeps working exactly as before.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => {
  dbState.timeline.push("fetch");
  return fetchMock(...args);
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  dbState.result = [];
  dbState.calls = [];
  dbState.timeline = [];
  dbState.values = undefined;
  dbState.limit = undefined;
  dbState.offset = undefined;
  dbState.conflictSet = undefined;
});

const ROW = {
  id: "f1", key: "docs/report.pdf", ownerId: "u1", name: "report.pdf",
  size: 20481, contentType: "application/pdf", createdAt: new Date(0),
};

describe("callStorage protocol (via storageGet/storageCommit)", () => {
  it("sends op, path and the app token as Bearer", async () => {
    fetchMock.mockResolvedValue(ok({ size: 20481, contentType: "application/pdf" }));
    dbState.result = [ROW];
    await storageCommit("docs/report.pdf", { ownerId: "u1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://platform.test/presign");
    expect(init.headers.authorization).toBe("Bearer tok.sig");
    expect(JSON.parse(init.body)).toMatchObject({ op: "head", path: "docs/report.pdf" });
  });

  it("maps a 404 from the platform to StorageError('not_found')", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await expect(storageCommit("gone.png")).rejects.toMatchObject({ code: "not_found" });
  });

  it("maps any other non-ok status to StorageError('failed')", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(storageCommit("a.png")).rejects.toMatchObject({ code: "failed" });
  });
});

describe("storageCommit", () => {
  it("HEADs the object BEFORE touching the database", async () => {
    fetchMock.mockResolvedValue(ok({ size: 1, contentType: "image/png" }));
    dbState.result = [ROW];
    await storageCommit("a.png");
    // The whole point of the protocol: no insert may happen without a HEAD.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dbState.calls).toEqual(["insert"]);
    // dbState.calls alone doesn't prove ORDER relative to the HTTP call — a
    // rewrite that inserted first and HEADed after would still produce
    // fetchMock called once and dbState.calls === ["insert"]. The shared
    // timeline is what actually pins "fetch before insert".
    expect(dbState.timeline).toEqual(["fetch", "db:insert"]);
  });

  it("does NOT insert when the object is missing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await expect(storageCommit("gone.png")).rejects.toThrow(StorageError);
    expect(dbState.calls).toEqual([]);   // never reached the DB
  });

  it("derives name from the key's basename when not given", async () => {
    fetchMock.mockResolvedValue(ok({ size: 1, contentType: null }));
    dbState.result = [ROW];
    await storageCommit("docs/nested/report.pdf");
    expect(dbState.values).toMatchObject({ key: "docs/nested/report.pdf", name: "report.pdf" });
  });

  it("takes size/contentType from the HEAD response while name is caller-supplied", async () => {
    // NOTE: opts has no size/contentType fields at all — that type shape is what
    // makes "never from the caller" true, not this test. What this test actually
    // checks is that the two values that DO come from somewhere (name from opts,
    // size/contentType from the HEAD response) land in the row correctly.
    fetchMock.mockResolvedValue(ok({ size: 999, contentType: "image/png" }));
    dbState.result = [ROW];
    await storageCommit("a.png", { ownerId: "u1", name: "renamed.png" });
    expect(dbState.values).toMatchObject({ name: "renamed.png", size: 999, contentType: "image/png" });
  });

  it("strips leading slashes from the key", async () => {
    fetchMock.mockResolvedValue(ok({ size: 1, contentType: null }));
    dbState.result = [ROW];
    await storageCommit("///a.png");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).path).toBe("a.png");
  });

  it("rejects when the key is already owned by a different user", async () => {
    dbState.result = [{ ...ROW, ownerId: "someone-else" }];
    await expect(storageCommit("docs/report.pdf", { ownerId: "u1" })).rejects.toMatchObject({
      code: "forbidden",
    });
    // Must fail before ever reaching the platform or writing to the DB.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbState.calls).not.toContain("insert");
  });

  it("skips the ownership check (and proceeds) when no ownerId is passed", async () => {
    // Mirror of the previous test: the SAME conflicting row exists, but since the
    // caller passes no ownerId, assertNotOwnedByOther's opt-in guard never runs
    // and the commit proceeds normally. Pins the opt-in behaviour deliberately.
    dbState.result = [{ ...ROW, ownerId: "someone-else" }];
    fetchMock.mockResolvedValue(ok({ size: 1, contentType: null }));
    await expect(storageCommit("docs/report.pdf")).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dbState.calls).toContain("insert");
  });

  it("never updates the owner on a re-commit, even when a conflicting ownerId is passed", async () => {
    // Owner is fixed at first commit; onConflictDoUpdate's `set` must therefore
    // omit ownerId entirely, so re-committing under a different caller-supplied
    // ownerId cannot silently reassign an existing row.
    dbState.result = [{ ...ROW, ownerId: "u1" }];
    fetchMock.mockResolvedValue(ok({ size: 1, contentType: null }));
    await storageCommit("docs/report.pdf", { ownerId: "u1", name: "new.pdf" });
    expect(dbState.values).toMatchObject({ ownerId: "u1", name: "new.pdf" });
    expect(dbState.conflictSet).toEqual({ name: "new.pdf", size: 1, contentType: null });
    expect(dbState.conflictSet).not.toHaveProperty("ownerId");
  });
});

describe("storageGet", () => {
  it("returns the row when present", async () => {
    dbState.result = [ROW];
    expect(await storageGet("docs/report.pdf")).toEqual(ROW);
  });

  it("returns null when absent (not an error — 'no such row' is a normal result)", async () => {
    dbState.result = [];
    expect(await storageGet("nope.png")).toBeNull();
  });
});

describe("storageListByOwner / storageListAll", () => {
  it("returns the rows the query produced", async () => {
    dbState.result = [ROW];
    expect(await storageListByOwner("u1")).toEqual([ROW]);
  });

  it("caps limit at 200 instead of erroring", async () => {
    dbState.result = [];
    await storageListByOwner("u1", { limit: 9999 });
    expect(dbState.limit).toBe(200);
  });

  it("defaults limit to 50", async () => {
    dbState.result = [];
    await storageListByOwner("u1");
    expect(dbState.limit).toBe(50);
  });

  it("storageListAll needs no ownerId — it is the explicit escape hatch", async () => {
    dbState.result = [ROW];
    expect(await storageListAll()).toEqual([ROW]);
  });
});

describe("storageDeleteOwned", () => {
  it("deletes the ROW first, then the object", async () => {
    dbState.result = [ROW];
    fetchMock.mockResolvedValue(ok({ deleted: true, path: "docs/report.pdf" }));
    expect(await storageDeleteOwned("u1", "docs/report.pdf")).toBe(true);
    expect(dbState.calls).toEqual(["delete"]);
    // Row-then-object: the reverse order could leave a row whose download 404s.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      op: "delete", path: "docs/report.pdf",
    });
    // dbState.calls alone doesn't prove ORDER relative to the HTTP call — see
    // the identical caveat on storageCommit's "HEADs before DB" test. The
    // shared timeline is what actually pins "delete row before delete object".
    expect(dbState.timeline).toEqual(["db:delete", "fetch"]);
  });

  it("returns false and does NOT delete the object when no row matched", async () => {
    dbState.result = [];   // absent, or owned by someone else — indistinguishable on purpose
    expect(await storageDeleteOwned("u1", "nope.png")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("storageDeleteAny", () => {
  it("deletes regardless of owner — the explicit admin escape hatch", async () => {
    dbState.result = [{ ...ROW, ownerId: "someone-else" }];
    fetchMock.mockResolvedValue(ok({ deleted: true, path: "docs/report.pdf" }));
    expect(await storageDeleteAny("docs/report.pdf")).toBe(true);
    expect(dbState.calls).toEqual(["delete"]);
    expect(dbState.timeline).toEqual(["db:delete", "fetch"]);
  });
});

describe("storagePutUrl overwrite guard", () => {
  it("refuses to sign a PUT for a key indexed under another owner", async () => {
    dbState.result = [{ ...ROW, ownerId: "someone-else" }];
    await expect(storagePutUrl("docs/report.pdf", "application/pdf", { ownerId: "u1" }))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();   // never even asked for a URL
  });

  it("signs normally for the same owner (re-upload is legitimate)", async () => {
    dbState.result = [ROW];   // ownerId "u1"
    fetchMock.mockResolvedValue(ok({ url: "https://s3/put" }));
    const r = await storagePutUrl("docs/report.pdf", "application/pdf", { ownerId: "u1" });
    expect(r).toEqual({ uploadUrl: "https://s3/put", publicPath: "/app-storage/docs/report.pdf" });
  });

  it("skips the guard entirely when no ownerId is passed (anonymous uploads)", async () => {
    dbState.result = [{ ...ROW, ownerId: "someone-else" }];
    fetchMock.mockResolvedValue(ok({ url: "https://s3/put" }));
    await expect(storagePutUrl("docs/report.pdf", "application/pdf")).resolves.toMatchObject({
      uploadUrl: "https://s3/put",
    });
  });
});

// ── C1: canonicalKey must reject every key whose string differs from what the
// platform's posixpath.normpath clamp would compute. Each of these four is a
// key-aliasing input verified empirically in the final-review writeup — a row
// indexed under any of them would alias an existing, differently-spelled row
// without the DB `unique` index on `key` ever firing. Exercised through
// storageGet (the thinnest wrapper around canonicalKey) so the assertion is
// about canonicalKey itself, not any one call site's error handling.
describe("canonicalKey rejects platform-divergent keys (C1a)", () => {
  it.each([
    ["./report.pdf"],
    ["shared//report.pdf"],
    ["a/b/../report.pdf"],
    ["abc-/../shared/report.pdf"],
  ])("rejects %s", async (key) => {
    await expect(storageGet(key)).rejects.toMatchObject({ code: "forbidden" });
    // Rejected before ever reaching the platform. (db.select()/.from() are
    // synchronous query-builder calls that fire before the `.where(...)`
    // argument — where canonicalKey lives — is even evaluated, so they show up
    // in dbState.calls regardless; nothing is actually sent until awaited, and
    // the throw happens before that await. fetchMock not being called is what
    // actually proves the platform was never touched.)
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty key", async () => {
    await expect(storageGet("")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a key that is only slashes (canonicalizes to empty)", async () => {
    await expect(storageGet("///")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("still accepts a plain, already-canonical key", async () => {
    dbState.result = [ROW];
    await expect(storageGet("report.pdf")).resolves.toEqual(ROW);
  });

  it("still accepts a nested, already-canonical key", async () => {
    dbState.result = [ROW];
    await expect(storageGet("docs/report.pdf")).resolves.toEqual(ROW);
  });
});

// The exploit in the writeup doesn't stop at storageGet — it goes through
// storageCommit (to index the alias) and storageDeleteOwned (to delete the
// victim's object via the aliased row). Both must reject too, and reject
// BEFORE touching the platform or the DB.
describe("canonicalKey rejection propagates through every entry point (C1a)", () => {
  it("storageCommit rejects a divergent key before HEADing the platform", async () => {
    await expect(storageCommit("./report.pdf", { ownerId: "attacker" })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbState.calls).toEqual([]);
  });

  it("storageDeleteOwned rejects a divergent key before deleting any row", async () => {
    await expect(storageDeleteOwned("attacker", "abc-/../shared/report.pdf")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbState.calls).toEqual([]);
  });

  it("storagePutUrl rejects a divergent key derived from an unsanitized name", async () => {
    await expect(
      storagePutUrl("<uuid>-/../shared/report.pdf", "application/pdf", { ownerId: "attacker" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("serveAppStorage (C1b)", () => {
  function fakeContext(path: string) {
    const state: { header?: [string, string]; redirect?: [string, number]; text?: [string, number] } = {};
    const c = {
      req: { path },
      header: (name: string, value: string) => {
        state.header = [name, value];
      },
      redirect: (url: string, status: number) => {
        state.redirect = [url, status];
        return { ok: true, status } as unknown as Response;
      },
      text: (body: string, status: number) => {
        state.text = [body, status];
        return { ok: false, status } as unknown as Response;
      },
    };
    return { c: c as unknown as import("hono").Context, state };
  }

  it("redirects to the signed GET URL for a canonical key", async () => {
    fetchMock.mockResolvedValue(ok({ url: "https://s3/get?sig=1" }));
    const { c, state } = fakeContext("/app-storage/report.pdf");
    await serveAppStorage(c);
    expect(state.redirect).toEqual(["https://s3/get?sig=1", 307]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ op: "get", path: "report.pdf" });
  });

  it("404s (not 500) on a platform-divergent key, without ever calling the platform", async () => {
    const { c, state } = fakeContext("/app-storage/./report.pdf");
    await serveAppStorage(c);
    expect(state.text).toEqual(["Not found", 404]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s on an embedded double-slash (the un-normalized case that used to reach the wire)", async () => {
    // Before this fix, serveAppStorage never normalized at all: "shared//report.pdf"
    // would have gone straight onto the wire, diverging from the platform's own
    // posixpath.normpath clamp to "shared/report.pdf" — the same aliasing C1
    // closes off everywhere else.
    const { c, state } = fakeContext("/app-storage/shared//report.pdf");
    await serveAppStorage(c);
    expect(state.text).toEqual(["Not found", 404]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s on an empty key", async () => {
    const { c, state } = fakeContext("/app-storage/");
    await serveAppStorage(c);
    expect(state.text).toEqual(["Not found", 404]);
  });
});

describe("page() floor clamp (M1)", () => {
  it("clamps a negative limit to 1, not -1 (Postgres errors on LIMIT -1)", async () => {
    dbState.result = [];
    await storageListByOwner("u1", { limit: -1 });
    expect(dbState.limit).toBe(1);
  });

  it("clamps a negative offset to 0", async () => {
    dbState.result = [];
    await storageListByOwner("u1", { offset: -50 });
    expect(dbState.offset).toBe(0);
  });

  it("still caps an oversized limit at 200", async () => {
    dbState.result = [];
    await storageListAll({ limit: 9999 });
    expect(dbState.limit).toBe(200);
  });
});

describe("storageDeleteAnonymous (I4)", () => {
  it("deletes an anonymous (owner-less) row", async () => {
    dbState.result = [{ ...ROW, ownerId: null }];
    fetchMock.mockResolvedValue(ok({ deleted: true }));
    expect(await storageDeleteAnonymous("docs/report.pdf")).toBe(true);
    expect(dbState.calls).toEqual(["delete"]);
  });

  it("returns false and never touches the platform when the row has an owner", async () => {
    dbState.result = [];   // the WHERE (isNull(ownerId)) excludes an owned row
    expect(await storageDeleteAnonymous("docs/report.pdf")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("storageCountByOwner / storageCountAll (I7)", () => {
  it("storageCountByOwner returns the count for that owner", async () => {
    dbState.result = [{ value: 3 }];
    expect(await storageCountByOwner("u1")).toBe(3);
  });

  it("storageCountAll returns the total count", async () => {
    dbState.result = [{ value: 42 }];
    expect(await storageCountAll()).toBe(42);
  });

  it("both return 0 when the query yields no row", async () => {
    dbState.result = [];
    expect(await storageCountByOwner("u1")).toBe(0);
    expect(await storageCountAll()).toBe(0);
  });
});

describe("cross-boundary key-normalization assertion", () => {
  it("throws when the platform echoes a path different from the one sent", async () => {
    // The platform clamped './report.pdf' down to 'report.pdf'. If our own
    // canonicalKey ever stopped rejecting that input, this echo is the only
    // signal that we are indexing one key while the platform touches another.
    fetchMock.mockResolvedValue(ok({ size: 1, contentType: null, path: "report.pdf" }));
    await expect(storageCommit("docs/report.pdf")).rejects.toMatchObject({ code: "forbidden" });
    expect(dbState.calls).toEqual([]); // never reached the DB
  });

  it("accepts a matching echo", async () => {
    fetchMock.mockResolvedValue(ok({ size: 1, contentType: null, path: "docs/report.pdf" }));
    dbState.result = [ROW];
    await expect(storageCommit("docs/report.pdf")).resolves.toEqual(ROW);
  });

  it("tolerates a response with no path field (ops that do not echo one)", async () => {
    fetchMock.mockResolvedValue(ok({ size: 1, contentType: null }));
    dbState.result = [ROW];
    await expect(storageCommit("docs/report.pdf")).resolves.toEqual(ROW);
  });
});
