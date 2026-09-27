import type { Context as HonoContext } from "hono";
import { db } from "./db";
import { authProvider } from "./auth";

// tRPC request context. Carries the Hono context (for cookie writes in auth
// mutations), the db handle, and the resolved user (null if anonymous).
export async function createContext(c: HonoContext) {
  const user = await authProvider().getSession(c);
  return { c, db, user };
}

export type AppContext = Awaited<ReturnType<typeof createContext>>;
