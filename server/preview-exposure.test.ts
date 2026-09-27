// Guards the two `server` options in vite.config.ts that decide what a stranger
// on the public internet can reach. Both are invisible in normal use — nothing
// about a working preview tells you either one is still set — and both fail in
// directions that are hard to attribute, so they get a test rather than a
// comment alone.
//
// WHY THIS IS A PUBLIC SURFACE AT ALL. The platform mints preview share links
// (`create_preview_share_link`) whose holder is by definition outside the
// project, and the host router proxies that hostname straight to this dev
// server's port. Dev is the only mode that matters here: a published app runs a
// single Hono process with no Vite, so none of this exists in prod.
//
// Asserted through Vite's own `resolveConfig` + `isFileServingAllowed`, not by
// reading the config source, so the check follows the effective behaviour —
// including the `fs.deny` defaults this file never restates.
import path from "node:path";
import { isFileServingAllowed, resolveConfig, type ResolvedConfig } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

let config: ResolvedConfig;

beforeAll(async () => {
  config = await resolveConfig(
    { configFile: path.join(ROOT, "vite.config.ts") },
    "serve",
  );
});

/** What a browser would actually ask for: `/@fs` + the absolute path. */
const served = (rel: string) =>
  isFileServingAllowed(config, `/@fs${path.join(ROOT, rel)}`);

describe("dev server file exposure", () => {
  // The client needs these; narrowing fs.allow must not cost the app its own
  // source. `shared/` is reachable through the `@shared/*` alias.
  it.each(["client/src/main.tsx", "client/src/App.tsx", "shared/types.ts"])(
    "serves %s",
    (rel) => expect(served(rel)).toBe(true),
  );

  // `server/` is the app's auth wiring and tRPC procedure definitions, and
  // `drizzle/` is its schema. Neither leaks a credential, but together they are
  // the map of which procedures a visitor can call without logging in — which
  // is the one thing a share-link visitor would want them for. With Vite's
  // default fs.allow (the workspace root) every one of these returned true.
  it.each([
    "server/routers.ts",
    "server/_core/auth.ts",
    "server/_core/index.ts",
    "drizzle/schema.ts",
  ])("does not serve %s", (rel) => expect(served(rel)).toBe(false));

  // Covered by Vite's default `fs.deny`, not by fs.allow. Pinned because the
  // consequence is different in kind: DATABASE_URL and JWT_SECRET live here.
  it.each([".env", ".env.local", ".env.example"])(
    "does not serve %s",
    (rel) => expect(served(rel)).toBe(false),
  );
});

describe("dev server host validation", () => {
  // Vite defaults `allowedHosts` to `[]`, which 403s every Host that is not an
  // IP or localhost. Previews survive that default today only because the
  // upstream proxy rewrites Host before the request lands here — an
  // implementation detail of infrastructure this repo does not own. Listing the
  // domains is what makes previews keep working the day it stops.
  it.each([
    ".preview.teamily.run",
    ".preview.chainopera.run",
    ".proxy.daytona.works",
  ])("allows %s", (host) => {
    expect(config.server.allowedHosts).toContain(host);
  });

  // `true` disables host validation entirely. It is the obvious thing to reach
  // for when a new preview domain 403s, and it silently reopens DNS rebinding
  // against this origin. Add the domain to the list instead.
  it("does not disable host validation wholesale", () => {
    expect(config.server.allowedHosts).not.toBe(true);
  });
});
