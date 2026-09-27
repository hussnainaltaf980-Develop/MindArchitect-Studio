// makeCaller exists so a generated app never re-derives how to call its own
// router. A real run invented its own `makeCaller`, then spent 24 turns
// reverse-engineering tRPC's createCaller out of node_modules to fix it. Living
// in _core means the agent imports it and cannot lose it: _core is frozen.
import { describe, expect, it, vi } from "vitest";

// makeCaller imports appRouter (../routers), which imports ./auth and
// ./storage (both read env.jwtSecret / env.databaseUrl at module load) plus
// the business-layer ../db. Three things get mocked below, all for the same
// reason: none of them can run in a unit test.
//
//   ./auth, ./storage — read env + open real integrations at module load.
//   ./db               — builds a real DB driver from env.databaseUrl.
//
// ../db is deliberately left REAL, unlike those three: it is AGENT-OWNED and
// differs per app (event-signup's exports are not slot-booking's), so this
// file can't know its shape ahead of time. What every app's ../db actually
// imports is `./db` above — this _core driver module — for a `db` handle and
// (sometimes) `atomic`. Mocking `./db` (the frozen leaf) instead of `../db`
// (the per-app business layer) means the real ../db module loads for
// whichever app is overlaid, so every export it happens to have — including
// a router-level zod constant like `MAX_NAME` — exists, and `appRouter`
// builds against the genuine module instead of a stand-in this file would
// have to keep re-guessing per app.
//
// `db` below can't be a bare `{}`: mini-crm's ../db builds a subquery
// (`db.select(...).from(...).groupBy(...).as(...)`) at MODULE level, so a
// stub with no `.select` throws the instant ../db is imported — before any
// test in this file even runs. It is instead a REAL drizzle instance over an
// unconnected pg.Pool: building a query performs no I/O and pg.Pool opens no
// socket until a query actually runs, so any app's module-level query
// construction — mini-crm's or otherwise — loads fine, and every OTHER app's
// ../db (which only touches `db` inside function bodies this test never
// calls) is unaffected either way. `atomic` stays a bare vi.fn(): no sample's
// ../db calls it at module level, only inside function bodies.
vi.mock("./db", async () => {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("../../drizzle/schema");
  const pool = new pg.Pool({ connectionString: "postgres://x" });
  pool.on("error", () => {}); // never queried, but an unhandled 'error' kills the test process
  return { db: drizzle(pool, { schema }), atomic: vi.fn() };
});

vi.mock("./auth", () => {
  class AuthError extends Error {}
  return {
    authProvider: () => ({ login: vi.fn(), logout: vi.fn(), getSession: vi.fn() }),
    registerLocalUser: vi.fn(),
    AuthError,
    EmailTakenError: class EmailTakenError extends AuthError {},
  };
});

vi.mock("./storage", () => ({
  storageCommit: vi.fn(),
  storageDeleteOwned: vi.fn(),
  storageListByOwner: vi.fn(),
  storagePutUrl: vi.fn(),
  StorageError: class StorageError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

const { makeCaller } = await import("./test-caller");

describe("makeCaller", () => {
  it("returns a caller with an anonymous context by default", () => {
    const caller = makeCaller();
    expect(caller).toBeDefined();
  });

  it("lets a test override the current user", () => {
    const caller = makeCaller({ user: { id: "u1" } as never });
    expect(caller).toBeDefined();
  });
});
