// ── AGENT-OWNED: business data-access ───────────────────────────────────────
// All raw Drizzle lives here so the tRPC procedures stay thin.
//
// Every read is filtered by ownerId. That is not defensive style — it is the
// only thing standing between two users' workspaces, because an id is a
// capability everywhere else in this app.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { atomic, db, isUniqueViolation } from "./_core/db";
import {
  workspaces,
  workspaceFiles,
  sessions,
  dependencies,
  runs,
  runMetrics,
  settings,
} from "../drizzle/schema";
import { seedFilesFor, type SeedFile } from "./services/workspace-seed";

/** A name a user can act on, rather than a 500 they can only retry. */
export class WorkspaceNameTakenError extends Error {
  constructor(name: string) {
    super(`You already have a workspace named "${name}". Pick a different name.`);
  }
}

/** Thrown when a write would clobber a file someone else has since changed. */
export class StaleWriteError extends Error {
  constructor(path: string) {
    super(
      `"${path}" changed on the server since you loaded it. ` +
        `Reopen the file to adopt the newer version, or save again to overwrite.`,
    );
  }
}

// ── workspaces ──────────────────────────────────────────────────────────────

export async function listWorkspaces(ownerId: string) {
  return db
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerId, ownerId))
    .orderBy(desc(workspaces.createdAt));
}

export async function getWorkspace(id: string, ownerId: string) {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.ownerId, ownerId)));
  return row ?? null;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workspace"
  );
}

/**
 * Create a workspace and seed its file tree.
 *
 * Both writes go through `atomic` because a workspace whose files failed to
 * insert is a broken workspace that LOOKS created — the user opens it and finds
 * an empty tree with no explanation. Creating the pair is the unit.
 */
export async function createWorkspace(input: {
  ownerId: string;
  name: string;
  template: string;
  runtime: string;
  deviceLabel: string | null;
}) {
  const id = crypto.randomUUID();
  const seed: SeedFile[] = seedFilesFor(input.template);

  try {
    const [created, files] = await atomic((d) => [
      d
        .insert(workspaces)
        .values({
          id,
          ownerId: input.ownerId,
          name: input.name,
          slug: slugify(input.name),
          template: input.template,
          runtime: input.runtime,
          deviceLabel: input.deviceLabel,
          status: "ready",
        })
        .returning(),
      d
        .insert(workspaceFiles)
        .values(
          seed.map((f) => ({
            ownerId: input.ownerId,
            workspaceId: id,
            path: f.path,
            content: f.content,
            language: f.language,
            sizeBytes: Buffer.byteLength(f.content, "utf8"),
          })),
        )
        .returning(),
    ]);
    return { workspace: created[0] ?? null, fileCount: files.length };
  } catch (e) {
    // Never pattern-match the DB error message: Drizzle wraps it behind
    // "Failed query: <sql>", so /unique/.test(message) matches nothing and the
    // duplicate escapes as an opaque 500.
    if (isUniqueViolation(e, "workspaces_owner_slug_uniq")) {
      throw new WorkspaceNameTakenError(input.name);
    }
    throw e;
  }
}

export async function deleteWorkspace(id: string, ownerId: string) {
  // Dependents cascade at the DB level (onDelete: "cascade"), so one guarded
  // delete removes the files, sessions, runs and metrics with it.
  const deleted = await db
    .delete(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.ownerId, ownerId)))
    .returning();
  return deleted.length > 0;
}

export async function touchWorkspace(id: string, ownerId: string) {
  await db
    .update(workspaces)
    .set({ updatedAt: new Date() })
    .where(and(eq(workspaces.id, id), eq(workspaces.ownerId, ownerId)));
}

// ── files ───────────────────────────────────────────────────────────────────

export async function listFiles(workspaceId: string, ownerId: string) {
  return db
    .select({
      id: workspaceFiles.id,
      path: workspaceFiles.path,
      language: workspaceFiles.language,
      sizeBytes: workspaceFiles.sizeBytes,
      updatedAt: workspaceFiles.updatedAt,
    })
    .from(workspaceFiles)
    .where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.ownerId, ownerId)))
    .orderBy(asc(workspaceFiles.path));
}

export async function readFile(workspaceId: string, path: string, ownerId: string) {
  const [row] = await db
    .select()
    .from(workspaceFiles)
    .where(
      and(
        eq(workspaceFiles.workspaceId, workspaceId),
        eq(workspaceFiles.path, path),
        eq(workspaceFiles.ownerId, ownerId),
      ),
    );
  return row ?? null;
}

/**
 * Upsert a file's contents.
 *
 * `expectedUpdatedAt` is the optimistic-concurrency guard: the client sends the
 * `updatedAt` it loaded, and the WHERE clause re-checks it in SQL. Zero rows
 * updated IS the signal that someone else saved first — which is exactly the
 * case that should be surfaced rather than silently swallowed.
 */
export async function writeFile(input: {
  workspaceId: string;
  ownerId: string;
  path: string;
  content: string;
  language: string;
  expectedUpdatedAt?: string | null;
}) {
  const now = new Date();
  const values = {
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    path: input.path,
    content: input.content,
    language: input.language,
    sizeBytes: Buffer.byteLength(input.content, "utf8"),
    updatedAt: now,
  };

  if (!input.expectedUpdatedAt) {
    // No guard supplied: a plain upsert. Used by "create new file" and by the
    // seed path, where there is no prior version to be stale against.
    const rows = await db
      .insert(workspaceFiles)
      .values(values)
      .onConflictDoUpdate({
        target: [workspaceFiles.workspaceId, workspaceFiles.path],
        set: {
          content: values.content,
          language: values.language,
          sizeBytes: values.sizeBytes,
          updatedAt: values.updatedAt,
        },
      })
      .returning();
    return rows[0];
  }

  // Guarded path. The version the client READ is what the WHERE re-checks, so a
  // caller that loaded an older revision updates zero rows and is told to
  // reload instead of overwriting the newer text.
  const expected = new Date(input.expectedUpdatedAt);
  const rows = await db
    .update(workspaceFiles)
    .set({
      content: values.content,
      language: values.language,
      sizeBytes: values.sizeBytes,
      updatedAt: values.updatedAt,
    })
    .where(
      and(
        eq(workspaceFiles.workspaceId, input.workspaceId),
        eq(workspaceFiles.path, input.path),
        eq(workspaceFiles.ownerId, input.ownerId),
        eq(workspaceFiles.updatedAt, expected),
      ),
    )
    .returning();

  if (rows.length === 0) {
    // Distinguish "someone else saved first" from "the file is gone", because
    // the two need different words and different user actions.
    const current = await readFile(input.workspaceId, input.path, input.ownerId);
    if (!current) throw new StaleWriteError(input.path);
    if (current.updatedAt.getTime() === expected.getTime()) {
      // Same version — the guard matched nothing for another reason (e.g. the
      // language column changed underneath). Retry once unguarded so a benign
      // mismatch cannot wedge the editor.
      const retry = await db
        .insert(workspaceFiles)
        .values(values)
        .onConflictDoUpdate({
          target: [workspaceFiles.workspaceId, workspaceFiles.path],
          set: {
            content: values.content,
            language: values.language,
            sizeBytes: values.sizeBytes,
            updatedAt: values.updatedAt,
          },
        })
        .returning();
      return retry[0];
    }
    throw new StaleWriteError(input.path);
  }
  return rows[0];
}

export async function deleteFile(workspaceId: string, path: string, ownerId: string) {
  const rows = await db
    .delete(workspaceFiles)
    .where(
      and(
        eq(workspaceFiles.workspaceId, workspaceId),
        eq(workspaceFiles.path, path),
        eq(workspaceFiles.ownerId, ownerId),
      ),
    )
    .returning();
  return rows.length > 0;
}

// ── sessions ────────────────────────────────────────────────────────────────

export async function listSessions(workspaceId: string, ownerId: string) {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.ownerId, ownerId)))
    .orderBy(desc(sessions.startedAt));
}

export async function startSession(input: {
  ownerId: string;
  workspaceId: string;
  device: string;
  gpuName: string | null;
  vramGb: number | null;
  cpuCount: number | null;
  memoryCapMb: number | null;
}) {
  // A workspace can only have one live session; stop any other first so the
  // "running" count in the UI cannot drift above one per workspace.
  await db
    .update(sessions)
    .set({ status: "stopped", endedAt: new Date() })
    .where(
      and(
        eq(sessions.workspaceId, input.workspaceId),
        eq(sessions.ownerId, input.ownerId),
        eq(sessions.status, "running"),
      ),
    );

  const [row] = await db
    .insert(sessions)
    .values({
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      status: "running",
      device: input.device,
      gpuName: input.gpuName,
      vramGb: input.vramGb,
      cpuCount: input.cpuCount,
      memoryCapMb: input.memoryCapMb,
    })
    .returning();
  return row;
}

export async function stopSession(id: string, ownerId: string) {
  const rows = await db
    .update(sessions)
    .set({ status: "stopped", endedAt: new Date() })
    .where(and(eq(sessions.id, id), eq(sessions.ownerId, ownerId)))
    .returning();
  return rows[0] ?? null;
}

export async function heartbeat(id: string, ownerId: string) {
  const rows = await db
    .update(sessions)
    .set({ lastHeartbeat: new Date() })
    .where(and(eq(sessions.id, id), eq(sessions.ownerId, ownerId), eq(sessions.status, "running")))
    .returning();
  return rows.length > 0;
}

// ── dependencies ────────────────────────────────────────────────────────────

export async function listDependencies(workspaceId: string, ownerId: string) {
  return db
    .select()
    .from(dependencies)
    .where(and(eq(dependencies.workspaceId, workspaceId), eq(dependencies.ownerId, ownerId)))
    .orderBy(asc(dependencies.name));
}

/**
 * Replace the dependency preflight result set for a workspace.
 *
 * Driven off the unique (workspace_id, name) index, so re-running the check
 * updates rows in place instead of accumulating a duplicate set each time.
 */
export async function recordDependencies(
  workspaceId: string,
  ownerId: string,
  rows: { name: string; versionReq: string; installedVersion: string | null; status: string }[],
) {
  if (rows.length === 0) return [];
  return db
    .insert(dependencies)
    .values(
      rows.map((r) => ({
        ownerId,
        workspaceId,
        name: r.name,
        versionReq: r.versionReq,
        installedVersion: r.installedVersion,
        status: r.status,
        checkedAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [dependencies.workspaceId, dependencies.name],
      set: {
        versionReq: sql`excluded.version_req`,
        installedVersion: sql`excluded.installed_version`,
        status: sql`excluded.status`,
        checkedAt: sql`excluded.checked_at`,
      },
    })
    .returning();
}

// ── runs ────────────────────────────────────────────────────────────────────

export async function listRuns(workspaceId: string, ownerId: string) {
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), eq(runs.ownerId, ownerId)))
    .orderBy(desc(runs.startedAt));
}

export async function getRun(id: string, ownerId: string) {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.ownerId, ownerId)));
  return row ?? null;
}

export async function createRun(input: {
  ownerId: string;
  workspaceId: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  maxSteps: number | null;
  randomGuessFloor: number | null;
}) {
  const [row] = await db
    .insert(runs)
    .values({
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      name: input.name,
      kind: input.kind,
      status: "running",
      configJson: input.config,
      maxSteps: input.maxSteps,
      randomGuessFloor: input.randomGuessFloor,
    })
    .returning();
  return row;
}

export async function updateRun(
  id: string,
  ownerId: string,
  patch: Partial<{
    status: string;
    completedSteps: number;
    initialLoss: number | null;
    finalLoss: number | null;
    bestValLoss: number | null;
    bestValStep: number | null;
    testLoss: number | null;
    stoppedEarly: boolean;
    notes: string | null;
    finishedAt: Date | null;
  }>,
) {
  const rows = await db
    .update(runs)
    .set(patch)
    .where(and(eq(runs.id, id), eq(runs.ownerId, ownerId)))
    .returning();
  return rows[0] ?? null;
}

export async function deleteRun(id: string, ownerId: string) {
  const rows = await db
    .delete(runs)
    .where(and(eq(runs.id, id), eq(runs.ownerId, ownerId)))
    .returning();
  return rows.length > 0;
}

/** Append a run's logged steps. Idempotent per (run, step, split). */
export async function appendMetrics(
  runId: string,
  ownerId: string,
  rows: {
    step: number;
    split: string;
    loss: number | null;
    lr: number | null;
    gradNorm: number | null;
  }[],
) {
  if (rows.length === 0) return [];
  return db
    .insert(runMetrics)
    .values(
      rows.map((m) => ({
        ownerId,
        runId,
        step: m.step,
        split: m.split,
        loss: m.loss,
        lr: m.lr,
        gradNorm: m.gradNorm,
      })),
    )
    .onConflictDoUpdate({
      target: [runMetrics.runId, runMetrics.step, runMetrics.split],
      set: { loss: sql`excluded.loss`, lr: sql`excluded.lr`, gradNorm: sql`excluded.grad_norm` },
    })
    .returning();
}

export async function listMetrics(runId: string, ownerId: string) {
  return db
    .select({
      step: runMetrics.step,
      split: runMetrics.split,
      loss: runMetrics.loss,
      lr: runMetrics.lr,
      gradNorm: runMetrics.gradNorm,
    })
    .from(runMetrics)
    .where(and(eq(runMetrics.runId, runId), eq(runMetrics.ownerId, ownerId)))
    .orderBy(asc(runMetrics.step));
}

// ── settings ────────────────────────────────────────────────────────────────

export async function listSettings(ownerId: string) {
  return db.select().from(settings).where(eq(settings.ownerId, ownerId)).orderBy(asc(settings.key));
}

export async function setSetting(ownerId: string, key: string, value: string) {
  const [row] = await db
    .insert(settings)
    .values({ ownerId, key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [settings.ownerId, settings.key],
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
    })
    .returning();
  return row;
}

/** Workspace summary counts, for the dashboard/list view. */
export async function workspaceStats(ownerId: string, workspaceIds: string[]) {
  if (workspaceIds.length === 0) return [] as { workspaceId: string; files: number; runs: number }[];
  const fileCounts = await db
    .select({ workspaceId: workspaceFiles.workspaceId, n: sql<number>`count(*)::int` })
    .from(workspaceFiles)
    .where(
      and(eq(workspaceFiles.ownerId, ownerId), inArray(workspaceFiles.workspaceId, workspaceIds)),
    )
    .groupBy(workspaceFiles.workspaceId);
  const runCounts = await db
    .select({ workspaceId: runs.workspaceId, n: sql<number>`count(*)::int` })
    .from(runs)
    .where(and(eq(runs.ownerId, ownerId), inArray(runs.workspaceId, workspaceIds)))
    .groupBy(runs.workspaceId);
  const byId = new Map<string, { workspaceId: string; files: number; runs: number }>();
  for (const id of workspaceIds) byId.set(id, { workspaceId: id, files: 0, runs: 0 });
  for (const f of fileCounts) {
    const e = byId.get(f.workspaceId);
    if (e) e.files = Number(f.n);
  }
  for (const r of runCounts) {
    const e = byId.get(r.workspaceId);
    if (e) e.runs = Number(r.n);
  }
  return [...byId.values()];
}
