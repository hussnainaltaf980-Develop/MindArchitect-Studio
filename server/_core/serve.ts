import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

// The ONE place the runtime touches the filesystem (DESIGN §5.1). In prod the
// single Hono process serves the built SPA from dist/public + an index.html
// SPA fallback. In dev this is a no-op: Vite owns the client on PORT and proxies
// API calls here. Swapping this shim (e.g. edge Static Assets) is all it takes
// to move off Node — business code never reads fs.
const PUBLIC_DIR = "dist/public";

export function mountClient(app: Hono): void {
  if (!env.isProd) return;
  app.use("/*", serveStatic({ root: `./${PUBLIC_DIR}` }));
  app.get("*", async (c) => {
    const html = await readFile(path.resolve(PUBLIC_DIR, "index.html"), "utf-8");
    return c.html(html);
  });
}
