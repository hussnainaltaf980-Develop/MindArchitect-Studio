import "dotenv/config"; // load .env into process.env before env.ts reads it.
// No-op when .env is absent (platform injects real env) and never overrides
// already-set vars — so it's safe in prod. MUST stay the first import.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveAppStorage } from "./storage";
import { getJob } from "./jobs";
import { mountClient } from "./serve";
import { v1Router } from "../routes/studio";
import { env } from "./env";

// Single process: tRPC API + OpenAI-shaped studio API + scoped storage proxy +
// job callbacks + (prod) SPA.
const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

// MindArchitect Studio's own surface, at the paths its client already speaks:
// /v1/chat/completions (SSE), /v1/models, /v1/health, /v1/lab/*.
app.route("/v1", v1Router);

// tRPC — all app business endpoints live under /trpc (agent writes routers.ts).
app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, c) => createContext(c),
  }),
);

// Scoped per-app file storage (DESIGN §5.6): 307 → short-lived signed S3 URL.
app.all("/app-storage/*", (c) => serveAppStorage(c));

// Platform-signed scheduled-job callback (DESIGN §8.4). The body runs in THIS
// app's runtime; the platform only triggers on schedule. Until the platform
// signature scheme exists we REQUIRE (and, later, verify) a signature header,
// so a registered job can never be triggered by an anonymous caller.
// TODO(§8.4): replace the presence check with real HMAC verification.
app.post("/api/_jobs/:name", async (c) => {
  const signature = c.req.header("x-platform-signature");
  if (!signature /* || !verifyPlatformSignature(c, signature) */) {
    return c.text("unauthorized (job callback signature required — DESIGN §8.4)", 401);
  }
  const handler = getJob(c.req.param("name"));
  if (!handler) return c.text("no such job", 404);
  try {
    await handler();
    return c.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[jobs] "${c.req.param("name")}" failed`, err);
    return c.text("job failed", 500);
  }
});

// Client: prod serves built SPA here; dev is served by Vite (which proxies API).
mountClient(app);

const port = env.isProd ? env.port : env.apiPort;
serve({ fetch: app.fetch, port });
// eslint-disable-next-line no-console
console.log(`[server] listening on :${port} (${env.isProd ? "prod" : "dev-api"})`);
