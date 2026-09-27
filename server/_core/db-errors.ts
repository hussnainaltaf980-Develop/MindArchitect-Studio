// Reading a failed write. Kept in its own leaf module (no env, no driver, no
// imports at all) so anything — _core, server/db.ts, a router — can ask "was
// that a duplicate?" without dragging a DB connection into the process.
//
// Postgres reports a violated UNIQUE index as SQLSTATE 23505. The catch is that
// Drizzle never re-throws the driver's error: it wraps it in a
// `DrizzleQueryError` whose OWN message is
//
//     Failed query: insert into "users" (...) values (default, $1, $2, ...)
//     params: someone@example.com,$2b$10$…,Name
//
// and hangs the real error off `.cause`. So `catch (e) { /unique/.test(e.message) }`
// reads the wrapper, matches nothing, and the duplicate escapes as an
// INTERNAL_SERVER_ERROR that quotes the SQL — and every bound param, password
// hash included — back to the browser. Walk the cause chain instead.

/** SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/** Postgres's own wording, used as a fallback when a driver drops the code. */
const UNIQUE_VIOLATION_TEXT = /duplicate key value violates unique constraint(?: "([^"]+)")?/i;

/**
 * True when `e` (or anything it wraps) is a UNIQUE-index violation.
 *
 * Pass `constraint` when a table has more than one unique index and the answer
 * changes the message — e.g. `isUniqueViolation(e, "notes_owner_title_unique")`.
 * Omit it when the table has exactly one, as `users` does with `email`.
 */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const seen = new Set<unknown>(); // `.cause` chains can loop; don't spin on one
  for (let err: unknown = e; err && typeof err === "object" && !seen.has(err); ) {
    seen.add(err);
    const { code, constraint: name, message, cause } = err as Record<string, unknown>;
    const text = typeof message === "string" ? message : "";
    const matched = UNIQUE_VIOLATION_TEXT.exec(text);
    if (String(code) === UNIQUE_VIOLATION || matched) {
      // The driver's own `constraint` field when it has one, else whatever
      // Postgres quoted in the message.
      const violated = typeof name === "string" ? name : (matched?.[1] ?? "");
      if (!constraint || violated === constraint) return true;
    }
    err = cause;
  }
  return false;
}
