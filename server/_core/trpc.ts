import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { AppContext } from "./context";

/** All a client ever learns about an unhandled server failure. */
export const OPAQUE_SERVER_ERROR = "Something went wrong. Please try again.";

// tRPC's default formatter copies `error.message` straight onto the wire. For a
// TRPCError you threw on purpose that is exactly right — the message was
// written for the user. For anything that merely ESCAPED a procedure it is a
// leak: Drizzle's failure message is `Failed query: <the whole INSERT>\nparams:
// <every bound value>`, so a duplicate signup used to answer 500 with the SQL
// and the bcrypt password hash in it, which the signup form then printed on the
// page (2026-08-26, auth.signup on a published app).
//
// Translate expected failures in your router (see `authRouter`/`filesRouter` in
// routers.ts) — a CONFLICT/BAD_REQUEST you raise keeps its message. This is only
// the floor under the ones nobody translated.
const t = initTRPC.context<AppContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    if (error.code !== "INTERNAL_SERVER_ERROR") return shape;
    // eslint-disable-next-line no-console
    console.error("[trpc] unhandled error", error.cause ?? error); // detail stays server-side
    // `stack` (dev only) starts with the same message — drop it with the rest.
    const { stack: _stack, ...data } = shape.data;
    return { ...shape, message: OPAQUE_SERVER_ERROR, data };
  },
});

export const router = t.router;
export const middleware = t.middleware;

/** Open to anyone. */
export const publicProcedure = t.procedure;

/** Requires an authenticated user; narrows ctx.user to non-null for downstream
 *  middleware/procedures. Inlined into .use() (not via a standalone middleware())
 *  so the ctx narrowing actually chains — a standalone middleware re-infers its
 *  input ctx from the root, where user is nullable. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Requires role === 'admin'. Builds on protectedProcedure, so ctx.user is non-null. */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});
