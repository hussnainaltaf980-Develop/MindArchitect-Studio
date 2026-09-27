// Canonical way to call appRouter from a test. The agent is forbidden to edit
// _core, which is exactly why this lives here: the pattern cannot be rewritten
// away by a full-file rewrite of routers.test.ts, and the agent has nothing left
// to rediscover.
//
// routers.ts pulls in _core/auth and _core/storage, which both import _core/db
// → a real DB driver from env.databaseUrl, and _core/auth also reads
// env.jwtSecret at module load. None of that can run in a unit test, so a
// caller of makeCaller must mock the _core leaves — ./auth, ./storage, and
// ./db (the driver module both of those, and the business-layer ../db, build
// on) — same pattern as storage.test.ts mocking ./env and ./db for
// storage.ts. Leave ../db itself real: its exports differ per app, so a
// hand-written mock of it is only ever correct for the one app it was written
// against. ./_core/trpc is left real here too: it only imports @trpc/server +
// superjson + a TYPE from ./context (erased at build time), so it has no
// runtime dependency on env/db and needs no mock.
import { appRouter } from "../routers";
import type { AppContext } from "./context";

export function makeCaller(overrides: Partial<AppContext> = {}) {
  const base = {
    c: undefined,
    db: undefined,
    user: null,
    ...overrides,
  } as unknown as AppContext;
  return appRouter.createCaller(base);
}
