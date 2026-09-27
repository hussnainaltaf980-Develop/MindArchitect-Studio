import { beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";

// Hoisted, so auth.ts sees them at import time: env.ts calls
// required("DATABASE_URL")/required("JWT_SECRET") at module load, and db.ts
// opens a real driver — neither can run in a unit test.
vi.mock("./env", () => ({
  env: { jwtSecret: "test-secret", appSlug: "test", isProd: false, authProvider: "local" },
}));

const insert: { throws?: unknown; values?: Record<string, unknown> } = {};

vi.mock("./db", () => ({
  db: {
    insert: () => ({
      values(v: Record<string, unknown>) {
        insert.values = v;
        return {
          async returning() {
            if (insert.throws) throw insert.throws;
            return [{ id: "u_1", email: v.email, name: v.name, role: "user" }];
          },
        };
      },
    }),
  },
}));

const { registerLocalUser, EmailTakenError, AuthError } = await import("./auth");

/** What signup actually gets back from Postgres on a second registration. */
function duplicateEmailError() {
  return new DrizzleQueryError(
    'insert into "users" ("id", "email", "password_hash", "name") values (default, $1, $2, $3)',
    ["asce1885@gmail.com", "$2b$10$lz3khdQ4ZWLRwguG/EufKu", "asce"],
    Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
      code: "23505",
      constraint: "users_email_unique",
    }),
  );
}

beforeEach(() => {
  insert.throws = undefined;
  insert.values = undefined;
});

describe("registerLocalUser", () => {
  it("rejects a second signup on the same email with EmailTakenError", async () => {
    insert.throws = duplicateEmailError();

    await expect(registerLocalUser("asce1885@gmail.com", "hunter2hunter2", "asce")).rejects.toBeInstanceOf(
      EmailTakenError,
    );
  });

  // The user-visible half of the bug: the thrown message is what the signup
  // form prints, and the old 500 printed the INSERT statement plus every bound
  // param — the bcrypt hash of the password included — into the page.
  it("says the email is taken without quoting the query or the password hash", async () => {
    insert.throws = duplicateEmailError();

    const err = await registerLocalUser("asce1885@gmail.com", "hunter2hunter2", "asce").then(
      () => new Error("expected registerLocalUser to reject"),
      (e: Error) => e,
    );

    expect(err.message).toMatch(/already registered/i);
    expect(err.message).not.toMatch(/insert into|Failed query|params:|\$2b\$/);
  });

  it("stays an AuthError, so callers that only know that type still catch it", async () => {
    insert.throws = duplicateEmailError();

    await expect(registerLocalUser("a@b.co", "hunter2hunter2")).rejects.toBeInstanceOf(AuthError);
  });

  it("lets any other write failure through untouched", async () => {
    const outage = new DrizzleQueryError("insert into \"users\" ...", [], new Error("connection terminated"));
    insert.throws = outage;

    await expect(registerLocalUser("a@b.co", "hunter2hunter2")).rejects.toBe(outage);
  });
});
