// ── vitest bootstrap ────────────────────────────────────────────────────────
//
// Loads the app's `.env` before any test module is imported.
//
// WHY THIS EXISTS
// ───────────────
// Vitest does not read `.env` on its own. `process.env.DATABASE_URL` was
// therefore undefined inside every test, and `_core/env.ts` throws on a missing
// required variable at module load. The consequence was quiet and specific: any
// test whose import graph reached `_core/db` — directly or through
// `server/db.ts`, which pulls it in — died with "Missing required env var:
// DATABASE_URL" before a single assertion ran. That is what made
// `server/routers.test.ts` fail the moment `routers.ts` grew an import of a
// service that touches the database.
//
// It is loaded here rather than inside each test so the rule is uniform: tests
// run against the same configuration the app does, which is the only way a test
// can tell you something true about the app.
//
// The parser is deliberately ~20 lines of stdlib instead of a `dotenv`
// dependency: this must never be the reason a suite fails to start, and
// `KEY=value`, `#` comments and quoted values are the whole format we write.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this file to the package root (the dir holding package.json). */
function findAppRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes; keep any trailing whitespace inside.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment wins over the file, so CI can override a value without
    // editing a checked-in file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const appRoot = findAppRoot(here);
loadEnvFile(resolve(appRoot, ".env"));
// `.env.test` is optional and overrides `.env` — the hook for pointing a suite
// at a scratch database without touching the dev one.
loadEnvFile(resolve(appRoot, ".env.test"));

// Defaults for anything the app needs to *load* but a test never exercises.
// `_core/env.ts` validates DATABASE_URL at import time; a suite that has no
// database still has to get past that. A value that cannot connect is fine —
// nothing here opens a connection — but the string must exist.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://localhost:5432/mindarchitect_test_unavailable";
}
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}
