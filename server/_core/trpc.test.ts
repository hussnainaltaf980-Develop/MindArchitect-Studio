import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { DrizzleQueryError } from "drizzle-orm/errors";

import { router, publicProcedure } from "./trpc";

// The exact error a duplicate signup produced before this was handled: Drizzle's
// wrapper, whose message is the INSERT plus every bound value — email, bcrypt
// hash, name.
function drizzleFailure() {
  return new DrizzleQueryError(
    'insert into "users" ("id", "email", "password_hash", "name") values (default, $1, $2, $3) returning "id"',
    ["asce1885@gmail.com", "$2b$10$lz3khdQ4ZWLRwguG/EufKu", "asce"],
    Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
      code: "23505",
    }),
  );
}

const testRouter = router({
  unhandled: publicProcedure.query(() => {
    throw drizzleFailure();
  }),
  handled: publicProcedure.query(() => {
    throw new TRPCError({ code: "CONFLICT", message: "That email is already registered." });
  }),
});

async function call(path: string): Promise<{ status: number; body: string }> {
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    req: new Request(`http://app.test/trpc/${path}`),
    router: testRouter,
    createContext: () => ({ c: {}, db: {}, user: null }) as never,
  });
  return { status: res.status, body: await res.text() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// A router that forgets to translate a DB failure is a WHEN, not an IF — each
// app's routers.ts is written per-app. tRPC's default formatter puts
// `error.message` on the wire verbatim, so that oversight used to hand the
// browser the SQL statement and its params (2026-08-26, auth.signup on a
// published app). The floor is set here, once, for every procedure.
describe("errorFormatter", () => {
  it("never puts the failed query or its bound params on the wire", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const { status, body } = await call("unhandled");

    expect(status).toBe(500);
    expect(body).not.toMatch(/Failed query|insert into|params:|password_hash|\$2b\$|asce1885@gmail\.com/);
    expect(logged).toHaveBeenCalled(); // the detail survives — server-side only
  });

  it("answers a 500 with something a person can read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { body } = await call("unhandled");

    expect(JSON.parse(body).error.json.message).toBe("Something went wrong. Please try again.");
  });

  it("leaves a deliberate TRPCError's message alone — that one is written for the user", async () => {
    const { status, body } = await call("handled");

    expect(status).toBe(409);
    expect(JSON.parse(body).error.json.message).toBe("That email is already registered.");
  });
});
