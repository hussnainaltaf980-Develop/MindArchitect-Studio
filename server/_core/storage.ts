import type { Context } from "hono";
import { and, count, desc, eq, isNull, type SQL } from "drizzle-orm";
import { env } from "./env";
import { db } from "./db";
import { files } from "../../drizzle/schema";

// Scoped file storage client (DESIGN §5.6). The app NEVER holds raw S3 creds —
// it holds one durable scoped credential (APP_STORAGE_TOKEN) and asks the
// platform presign endpoint for a short-lived signed URL per operation. The
// platform clamps every key to this app's prefix (the hard isolation boundary).
type Op = "put" | "get" | "head" | "delete";

export type StorageErrorCode = "not_found" | "forbidden" | "not_configured" | "failed";

/** Storage failures carry a code so routers can map them to tRPC errors.
 *  Same pattern as AuthError in _core/auth.ts. */
export class StorageError extends Error {
  constructor(message: string, readonly code: StorageErrorCode) {
    super(message);
    this.name = "StorageError";
  }
}

/** One row of the `files` index. */
export type FileRecord = typeof files.$inferSelect;

/** Strip leading slashes, then REJECT anything that could make this app's
 *  notion of the key diverge from the platform's.
 *
 *  The platform runs `posixpath.normpath` on the key before it ever touches
 *  storage, but this function does NOT normalize — it CANONICALIZES-OR-REJECTS.
 *  Silently normalizing (e.g. collapsing "a/b/../report.pdf" to "a/report.pdf")
 *  would still leave `files.key` holding the un-collapsed string while the
 *  platform head/put/delete/get all clamp to the collapsed one — two different
 *  strings pointing at the same object, which is exactly the aliasing that lets
 *  one user's `assertNotOwnedByOther` lookup miss another user's row (see the
 *  final-review writeup: a committed "./report.pdf" and an existing
 *  "report.pdf" alias the SAME object, but the `unique` index on `key` never
 *  fires because the strings differ).
 *
 *  So: split on "/" and throw StorageError("forbidden") if the key is empty,
 *  or if ANY segment is "" (catches "a//b"), "." or ".." (catch the traversal
 *  aliases). What survives is guaranteed byte-identical to what the platform
 *  computes, because normpath is a no-op on a string with no such segments.
 *
 *  Named to signal it can throw — every call site must let that throw
 *  propagate (StorageError, code "forbidden"), not swallow it. */
function canonicalKey(relKey: string): string {
  const stripped = relKey.replace(/^\/+/, "");
  if (!stripped) throw new StorageError("empty storage key", "forbidden");
  for (const segment of stripped.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new StorageError(`unsafe storage key (diverges from platform normalization): ${relKey}`, "forbidden");
    }
  }
  return stripped;
}

/** Single call into the platform storage endpoint. The app holds one durable
 *  scoped token and never any object-store credential (DESIGN §5.6); the
 *  platform clamps every key to this app's prefix. */
async function callStorage<T>(op: Op, path: string, contentType?: string): Promise<T> {
  if (!env.storage.presignUrl || !env.storage.token) {
    throw new StorageError(
      "App storage not configured (APP_STORAGE_PRESIGN_URL / APP_STORAGE_TOKEN).",
      "not_configured",
    );
  }
  const res = await fetch(env.storage.presignUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.storage.token}` },
    body: JSON.stringify({ op, path, contentType }),
  });
  if (res.status === 404) throw new StorageError(`no such object: ${path}`, "not_found");
  if (!res.ok) throw new StorageError(`storage ${op} failed: ${res.status}`, "failed");
  const body = (await res.json()) as T & { path?: string };

  // Cross-boundary invariant: the platform echoes the key it ACTUALLY acted on,
  // after its own clamping. `canonicalKey` above is written to produce exactly
  // that string, so the two must agree — and if they ever stop agreeing, this is
  // the only place that can notice. When they silently disagreed, an app could
  // index `./x.pdf` while the platform touched `x.pdf`, which let one end user
  // delete another's object through an ownership check that matched the wrong
  // row. Neither repo's tests can catch that (each mocks the other), so assert
  // it at runtime on every call and fail loudly rather than aliasing.
  if (typeof body.path === "string" && body.path !== path) {
    throw new StorageError(
      `storage key normalization disagrees with the platform: sent ${path}, platform used ${body.path}`,
      "forbidden",
    );
  }
  return body;
}

/** Look up one indexed file by its relative key. `null` means "no such row" —
 *  a normal result, which is why this returns null instead of throwing. */
export async function storageGet(relKey: string): Promise<FileRecord | null> {
  const [row] = await db.select().from(files).where(eq(files.key, canonicalKey(relKey))).limit(1);
  return row ?? null;
}

/** Reject a write when the key is already indexed under a DIFFERENT owner.
 *  Opt-in: anonymous/public uploads pass no ownerId and skip the check. */
async function assertNotOwnedByOther(relKey: string, ownerId?: string | null): Promise<void> {
  if (!ownerId) return;
  const existing = await storageGet(relKey);
  if (existing?.ownerId && existing.ownerId !== ownerId) {
    throw new StorageError(`key already owned by another user: ${canonicalKey(relKey)}`, "forbidden");
  }
}

/** Record an upload that has ALREADY landed in object storage.
 *
 *  The browser PUTs straight to the signed URL, so this server never sees the
 *  upload complete — hence the explicit commit. It HEADs the object first, so
 *  (a) a row can only exist if the object does, and (b) size/contentType come
 *  from storage rather than from the client, which could lie about both.
 *
 *  Re-committing the same key (e.g. after a deliberate overwrite) updates the
 *  row in place. Throws StorageError("not_found") if the object isn't there —
 *  and writes nothing.
 *
 *  The owner is set only on the FIRST commit of a key; a re-commit updates
 *  name/size/contentType but never the owner, even if a different `ownerId` is
 *  passed. Visible consequence: an anonymous upload (ownerId null) can never
 *  later be claimed by a logged-in user via re-commit.
 */
export async function storageCommit(
  relKey: string,
  opts: { ownerId?: string | null; name?: string } = {},
): Promise<FileRecord> {
  const key = canonicalKey(relKey);
  await assertNotOwnedByOther(key, opts.ownerId);
  const meta = await callStorage<{ size: number; contentType: string | null }>("head", key);
  const values = {
    key,
    ownerId: opts.ownerId ?? null,
    name: opts.name ?? key.split("/").pop() ?? key,
    size: meta.size,
    contentType: meta.contentType,
  };
  const [row] = await db
    .insert(files)
    .values(values)
    .onConflictDoUpdate({
      target: files.key,
      set: { name: values.name, size: values.size, contentType: values.contentType },
    })
    .returning();
  return row;
}

const MAX_LIMIT = 200;

/** Clamp limit to [1, MAX_LIMIT] and offset to >= 0. Without the lower clamp,
 *  a caller-supplied negative limit (e.g. `limit: -1`) reaches Postgres as
 *  `LIMIT -1`, which Postgres rejects with an error instead of an empty page. */
function page(opts: { limit?: number; offset?: number }) {
  return {
    limit: Math.max(1, Math.min(opts.limit ?? 50, MAX_LIMIT)),
    offset: Math.max(0, opts.offset ?? 0),
  };
}

/** Files owned by ONE user, newest first.
 *
 *  `ownerId` is a required positional argument on purpose: the unsafe call
 *  (listing every user's files) must be spelled out as storageListAll, so it
 *  cannot happen by forgetting an optional field. */
export async function storageListByOwner(
  ownerId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<FileRecord[]> {
  const { limit, offset } = page(opts);
  return db.select().from(files).where(eq(files.ownerId, ownerId))
    .orderBy(desc(files.createdAt)).limit(limit).offset(offset);
}

/** EVERY file in the app, newest first. Not user-scoped — pair it with
 *  adminProcedure, never with protectedProcedure. */
export async function storageListAll(
  opts: { limit?: number; offset?: number } = {},
): Promise<FileRecord[]> {
  const { limit, offset } = page(opts);
  return db.select().from(files).orderBy(desc(files.createdAt)).limit(limit).offset(offset);
}

/** Total number of files owned by ONE user. Pairs with storageListByOwner —
 *  exists so a pager can be built without changing that function's return
 *  shape (a bare array) in already-frozen apps. Same positional-ownerId
 *  reasoning as storageListByOwner. */
export async function storageCountByOwner(ownerId: string): Promise<number> {
  const [row] = await db.select({ value: count() }).from(files).where(eq(files.ownerId, ownerId));
  return row?.value ?? 0;
}

/** Total number of files in the app. Not user-scoped — pair it with
 *  adminProcedure, never with protectedProcedure. Pairs with storageListAll. */
export async function storageCountAll(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(files);
  return row?.value ?? 0;
}

/** Shared body for storageDeleteOwned/storageDeleteAny: delete the row, then
 *  the object, and report whether a row actually matched.
 *
 *  Row-then-object is deliberate. If the object delete fails we leak an
 *  invisible orphan, which the platform's own File storage panel can still see
 *  and remove; the reverse order would leave a row whose download 404s in the
 *  app's UI.
 *
 *  Returns false when no row matched (never existed, or excluded by `where` —
 *  e.g. owned by someone else). Those are NOT distinguished, so this cannot be
 *  used to probe which keys exist. Nothing is deleted from storage in that
 *  case. */
async function deleteRowThenObject(key: string, where: SQL | undefined): Promise<boolean> {
  const removed = await db.delete(files).where(where).returning();
  if (removed.length === 0) return false;
  await callStorage<{ deleted: boolean }>("delete", key);
  return true;
}

/** Delete one indexed file OWNED BY `ownerId`.
 *
 *  `ownerId` is a required positional argument on purpose — same reasoning as
 *  storageListByOwner: the unsafe, unscoped delete must be spelled out as
 *  storageDeleteAny, so it cannot happen by forgetting an optional field. Keys
 *  are visible in /app-storage/<key> URLs, so an unscoped delete reachable by
 *  a caller-supplied key would let one user delete another user's file. */
export async function storageDeleteOwned(ownerId: string, relKey: string): Promise<boolean> {
  const key = canonicalKey(relKey);
  return deleteRowThenObject(key, and(eq(files.key, key), eq(files.ownerId, ownerId)));
}

/** Delete one indexed file REGARDLESS OF OWNER. Not user-scoped — pair it
 *  with adminProcedure, never with protectedProcedure. This is the
 *  explicitly-named unsafe escape hatch (mirrors storageListAll): a business
 *  router should almost never call this with a caller-supplied key. */
export async function storageDeleteAny(relKey: string): Promise<boolean> {
  const key = canonicalKey(relKey);
  return deleteRowThenObject(key, eq(files.key, key));
}

/** Delete one indexed file that has NO OWNER (a public/anonymous upload, e.g.
 *  a contact-form attachment). Scoped with `isNull(files.ownerId)`, so a row
 *  that DOES have an owner is excluded — same false-return semantics as
 *  storageDeleteOwned: "no row matched" and "matched but excluded" are not
 *  distinguished, and nothing is deleted from storage in that case.
 *
 *  Exists so "let the visitor remove the attachment they just added" has a
 *  compliant primitive: without it, that recipe has no scoped delete to reach
 *  for and an LLM is liable to call storageDeleteAny from a publicProcedure,
 *  which lets any visitor delete any file by key. */
export async function storageDeleteAnonymous(relKey: string): Promise<boolean> {
  const key = canonicalKey(relKey);
  return deleteRowThenObject(key, and(eq(files.key, key), isNull(files.ownerId)));
}

/** Signed PUT URL; the caller uploads the bytes to it directly, then calls
 *  storageCommit(relKey) to index the result.
 *
 *  Pass `ownerId` on any authenticated path. Keys are visible in
 *  /app-storage/<key> URLs, so without it one logged-in user could request a
 *  PUT URL for another user's file and overwrite it. The check is opt-in
 *  because public/anonymous uploads have no owner to compare against, and it
 *  only covers files already committed — hence the random key prefix in the
 *  filesRouter example. */
export async function storagePutUrl(
  relKey: string,
  contentType?: string,
  opts: { ownerId?: string | null } = {},
): Promise<{ uploadUrl: string; publicPath: string }> {
  const key = canonicalKey(relKey);
  await assertNotOwnedByOther(key, opts.ownerId);
  const { url } = await callStorage<{ url: string }>("put", key, contentType);
  return { uploadUrl: url, publicPath: `/app-storage/${key}` };
}

/** Hono handler for GET /app-storage/* — 307-redirects to a short-lived signed
 *  GET URL. Mounted by _core/index.ts; app code just links to /app-storage/...
 *
 *  Routed through canonicalKey like every other entry point: without it,
 *  "/app-storage//x.png" would reach the wire with a leading slash the
 *  platform's own normpath would collapse, the same key-aliasing this file's
 *  canonicalKey exists to close off. A rejected key falls through to the
 *  existing catch and renders as a 404, never a 500. */
export async function serveAppStorage(c: Context): Promise<Response> {
  const raw = c.req.path.replace(/^\/app-storage\//, "");
  try {
    const key = canonicalKey(raw);
    const { url } = await callStorage<{ url: string }>("get", key);
    c.header("Cache-Control", "no-store");
    return c.redirect(url, 307);
  } catch {
    return c.text("Not found", 404);
  }
}
