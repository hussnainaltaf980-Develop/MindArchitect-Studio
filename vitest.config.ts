import { defineConfig } from "vitest/config";
import path from "node:path";

// Vitest needs its OWN config: vite.config.ts sets `root: client/` (so the dev
// server serves the SPA), and vitest would inherit that root and silently never
// discover `server/**/*.test.ts` — exactly the tests AGENT.md tells the agent to
// write. Keep the repo root as the test root and spell the include globs out.
//
// environment: "node" — tests target the business seams (routers/db/services),
// not the DOM; jsdom is deliberately not a dependency.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client/src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    root: import.meta.dirname,
    environment: "node",
    // Loads `.env` before any test module is imported. Vitest does not read it
    // itself, and `_core/env.ts` throws on a missing DATABASE_URL at IMPORT time
    // — so without this, every suite whose import graph reaches `_core/db` (via
    // server/db.ts, or via a router that calls a DB-backed service) dies before
    // its first assertion with "Missing required env var". See
    // server/_core/test-setup.ts.
    setupFiles: [path.resolve(import.meta.dirname, "server/_core/test-setup.ts")],
    include: [
      "client/src/**/*.test.{ts,tsx}",
      "server/**/*.test.ts",
      "shared/**/*.test.ts",
    ],
  },
});
