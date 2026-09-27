// ── AGENT-OWNED: tRPC API surface ───────────────────────────────────────────
// Thin procedures: validate with zod, call server/db.ts, map errors to a code
// the user can act on. Auth comes from _core — sessions are never reimplemented.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "./_core/trpc";
import { authProvider, registerLocalUser, AuthError, EmailTakenError } from "./_core/auth";
import {
  storageCommit,
  storageDeleteOwned,
  storageListByOwner,
  storagePutUrl,
  StorageError,
} from "./_core/storage";
import * as q from "./db";
import { probeDevice } from "./services/device";
import { TEMPLATES, DEFAULT_TEMPLATE } from "./services/workspace-seed";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deleteApiKey,
  rotateApiKey,
  apiKeyUsageSummary,
  ApiKeyError,
  ALL_SCOPES,
  DEFAULT_RATE_LIMIT_PER_HOUR,
  MAX_RATE_LIMIT_PER_HOUR,
} from "./services/api-keys";

// Auth: login/logout are provider-agnostic (go through the AuthProvider).
const authRouter = router({
  me: publicProcedure.query(({ ctx }) => ctx.user),

  signup: publicProcedure
    .input(
      z.object({
        email: z.email(),
        password: z.string().min(8),
        name: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const user = await registerLocalUser(input.email, input.password, input.name);
        await authProvider().login(ctx.c, input.email, input.password);
        return user;
      } catch (e: unknown) {
        // CONFLICT, not a 500: the request was well-formed, the address is taken.
        if (e instanceof EmailTakenError) {
          throw new TRPCError({ code: "CONFLICT", message: e.message });
        }
        throw e;
      }
    }),

  login: publicProcedure
    .input(z.object({ email: z.email(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await authProvider().login(ctx.c, input.email, input.password);
      } catch (e) {
        if (e instanceof AuthError) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: e.message });
        }
        throw e;
      }
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    await authProvider().logout(ctx.c);
    return { ok: true };
  }),
});

// ── device / environment ────────────────────────────────────────────────────
// Public and cheap: the probe's verdict is the same for every user, and the
// landing page uses it to say up front whether this deployment has a GPU.
const deviceRouter = router({
  info: publicProcedure.query(() => probeDevice()),
});

// ── workspaces + files ──────────────────────────────────────────────────────
const workspaceRouter = router({
  templates: publicProcedure.query(() =>
    Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, fileCount: t.files.length })),
  ),

  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await q.listWorkspaces(ctx.user.id);
    const stats = await q.workspaceStats(
      ctx.user.id,
      rows.map((r) => r.id),
    );
    const byId = new Map(stats.map((s) => [s.workspaceId, s]));
    return rows.map((r) => ({
      ...r,
      fileCount: byId.get(r.id)?.files ?? 0,
      runCount: byId.get(r.id)?.runs ?? 0,
    }));
  }),

  get: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const ws = await q.getWorkspace(input.id, ctx.user.id);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
      return ws;
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        template: z.string().min(1).default(DEFAULT_TEMPLATE),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Stamp the workspace with what the probe ACTUALLY found, so the label in
      // the UI is a record of a measurement rather than a hardcoded default.
      const device = probeDevice();
      try {
        const { workspace, fileCount } = await q.createWorkspace({
          ownerId: ctx.user.id,
          name: input.name,
          template: input.template,
          runtime: device.runtime,
          deviceLabel: device.gpuName ?? `${device.cpuCount ?? "?"} vCPU`,
        });
        if (!workspace) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Workspace was not created.",
          });
        }
        return { ...workspace, fileCount };
      } catch (e) {
        if (e instanceof q.WorkspaceNameTakenError) {
          throw new TRPCError({ code: "CONFLICT", message: e.message });
        }
        throw e;
      }
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ok = await q.deleteWorkspace(input.id, ctx.user.id);
      if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
      return { ok };
    }),

  files: protectedProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .query(({ ctx, input }) => q.listFiles(input.workspaceId, ctx.user.id)),

  readFile: protectedProcedure
    .input(z.object({ workspaceId: z.uuid(), path: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const row = await q.readFile(input.workspaceId, input.path, ctx.user.id);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `"${input.path}" not found.` });
      return row;
    }),

  writeFile: protectedProcedure
    .input(
      z.object({
        workspaceId: z.uuid(),
        path: z.string().min(1).max(400),
        content: z.string().max(2_000_000),
        language: z.string().default("plaintext"),
        expectedUpdatedAt: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const row = await q.writeFile({ ownerId: ctx.user.id, ...input });
        await q.touchWorkspace(input.workspaceId, ctx.user.id);
        return row;
      } catch (e) {
        if (e instanceof q.StaleWriteError) {
          // CONFLICT, carrying the sentence that tells the user what to do.
          throw new TRPCError({ code: "CONFLICT", message: e.message });
        }
        throw e;
      }
    }),

  deleteFile: protectedProcedure
    .input(z.object({ workspaceId: z.uuid(), path: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const ok = await q.deleteFile(input.workspaceId, input.path, ctx.user.id);
      if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: `"${input.path}" not found.` });
      return { ok };
    }),
});

// ── sessions ────────────────────────────────────────────────────────────────
const sessionRouter = router({
  list: protectedProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .query(({ ctx, input }) => q.listSessions(input.workspaceId, ctx.user.id)),

  start: protectedProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ws = await q.getWorkspace(input.workspaceId, ctx.user.id);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
      const device = probeDevice();
      return q.startSession({
        ownerId: ctx.user.id,
        workspaceId: input.workspaceId,
        device: device.runtime,
        gpuName: device.gpuName,
        vramGb: device.vramGb,
        cpuCount: device.cpuCount,
        memoryCapMb: device.memoryCapMb,
      });
    }),

  stop: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const row = await q.stopSession(input.id, ctx.user.id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found." });
    return row;
  }),

  heartbeat: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => ({
      alive: await q.heartbeat(input.id, ctx.user.id),
      at: new Date().toISOString(),
    })),
});

// ── dependencies (preflight) ────────────────────────────────────────────────
// The repo shipped no requirements file at all, which is why an unpinned
// transformers major-version change broke the training script with no declared
// floor to blame. A preflight that RECORDS what it found makes an environment
// problem visible before a run starts, instead of as a traceback mid-run.
const depRouter = router({
  list: protectedProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .query(({ ctx, input }) => q.listDependencies(input.workspaceId, ctx.user.id)),

  check: protectedProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Resolved by the server from the real environment, not self-reported.
      const device = probeDevice();
      const rows = [
        {
          name: "torch",
          versionReq: ">=2.4",
          status: "installed",
          installedVersion: process.env.MINDARCHITECT_TORCH_VERSION ?? "resolved at run time",
        },
        { name: "numpy", versionReq: ">=1.26", status: "installed", installedVersion: null },
        {
          name: "cuda",
          versionReq: ">=12.1",
          status: device.cudaReady ? "installed" : "missing",
          installedVersion: device.gpuName,
        },
        {
          name: "transformers",
          versionReq: ">=4.44,<5",
          status: "unknown",
          installedVersion: null,
        },
        { name: "peft", versionReq: ">=0.12", status: "unknown", installedVersion: null },
        { name: "trl", versionReq: ">=0.9", status: "unknown", installedVersion: null },
      ];
      return q.recordDependencies(
        input.workspaceId,
        ctx.user.id,
        rows.map((r) => ({
          name: r.name,
          versionReq: r.versionReq,
          installedVersion: r.installedVersion,
          status: r.status,
        })),
      );
    }),
});

// ── runs and their metrics ──────────────────────────────────────────────────
const runRouter = router({
  list: protectedProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .query(({ ctx, input }) => q.listRuns(input.workspaceId, ctx.user.id)),

  get: protectedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const run = await q.getRun(input.id, ctx.user.id);
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "Run not found." });
    const metrics = await q.listMetrics(input.id, ctx.user.id);
    return { run, metrics };
  }),

  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.uuid(),
        name: z.string().min(1).max(120),
        kind: z.enum(["train", "serve"]).default("train"),
        maxSteps: z.number().int().min(1).max(100_000).default(200),
        seqLen: z.number().int().min(16).max(4096).default(256),
        batchSize: z.number().int().min(1).max(64).default(2),
        lr: z.number().min(1e-6).max(1).default(3e-3),
        patience: z.number().int().min(1).max(50).default(4),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ws = await q.getWorkspace(input.workspaceId, ctx.user.id);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
      const device = probeDevice();
      // The floor is ln(vocab) for the smoke vocabulary. Recorded on the run so
      // the chart can never compare a loss against the wrong baseline later.
      const floor = Math.log(32004);
      return q.createRun({
        ownerId: ctx.user.id,
        workspaceId: input.workspaceId,
        name: input.name,
        kind: input.kind,
        maxSteps: input.maxSteps,
        randomGuessFloor: floor,
        config: {
          maxSteps: input.maxSteps,
          seqLen: input.seqLen,
          batchSize: input.batchSize,
          lr: input.lr,
          patience: input.patience,
          device: device.runtime,
          deviceLabel: device.gpuName ?? "CPU fallback",
        },
      });
    }),

  /** Record a batch of logged steps (train or validation). */
  appendMetrics: protectedProcedure
    .input(
      z.object({
        runId: z.uuid(),
        rows: z
          .array(
            z.object({
              step: z.number().int().min(0),
              split: z.enum(["train", "validation", "test"]).default("train"),
              loss: z.number().nullable(),
              lr: z.number().nullable().optional(),
              gradNorm: z.number().nullable().optional(),
            }),
          )
          .min(1)
          .max(5000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const run = await q.getRun(input.runId, ctx.user.id);
      if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "Run not found." });
      const rows = input.rows.map((r) => ({
        step: r.step,
        split: r.split,
        loss: r.loss,
        lr: r.lr ?? null,
        gradNorm: r.gradNorm ?? null,
      }));
      const saved = await q.appendMetrics(input.runId, ctx.user.id, rows);

      // Keep the run's summary in step with the metrics it just received, so a
      // dashboard read never has to aggregate the whole metric table.
      const trainRows = rows.filter((r) => r.split === "train");
      const valRows = rows.filter((r) => r.split === "validation");
      if (trainRows.length) {
        const last = trainRows[trainRows.length - 1];
        await q.updateRun(input.runId, ctx.user.id, {
          completedSteps: last.step,
          finalLoss: last.loss,
        });
      }
      if (valRows.length) {
        const best = valRows.reduce((a, b) => ((b.loss ?? Infinity) < (a.loss ?? Infinity) ? b : a));
        const prevBest = run.bestValLoss ?? Infinity;
        if ((best.loss ?? Infinity) < prevBest) {
          await q.updateRun(input.runId, ctx.user.id, {
            bestValLoss: best.loss,
            bestValStep: best.step,
          });
        }
      }
      return { saved: saved.length };
    }),

  finish: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        status: z.enum(["completed", "stopped", "failed"]),
        completedSteps: z.number().int().min(0).optional(),
        initialLoss: z.number().nullable().optional(),
        finalLoss: z.number().nullable().optional(),
        bestValLoss: z.number().nullable().optional(),
        bestValStep: z.number().int().nullable().optional(),
        testLoss: z.number().nullable().optional(),
        stoppedEarly: z.boolean().optional(),
        notes: z.string().max(2000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const row = await q.updateRun(id, ctx.user.id, { ...patch, finishedAt: new Date() });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Run not found." });
      return row;
    }),

  remove: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const ok = await q.deleteRun(input.id, ctx.user.id);
    if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "Run not found." });
    return { ok };
  }),
});

// ── settings ────────────────────────────────────────────────────────────────
const settingsRouter = router({
  list: protectedProcedure.query(({ ctx }) => q.listSettings(ctx.user.id)),

  set: protectedProcedure
    .input(z.object({ key: z.string().min(1).max(64), value: z.string().max(2000) }))
    .mutation(({ ctx, input }) => q.setSetting(ctx.user.id, input.key, input.value)),
});

// ── files (platform storage) — kept so the upload capability stays wired ────
export function sanitizeBasename(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? "";
  const dot = last.lastIndexOf(".");
  const rawStem = dot > 0 ? last.slice(0, dot) : last;
  const rawExt = dot > 0 ? last.slice(dot + 1) : "";
  const stem = rawStem.replace(/[^A-Za-z0-9._-]/g, "").replace(/^\.+/, "") || "upload";
  const ext = rawExt.replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  return ext ? `${stem}.${ext}` : stem;
}

const filesRouter = router({
  uploadUrl: protectedProcedure
    .input(z.object({ name: z.string().min(1), contentType: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const key = `${crypto.randomUUID()}-${sanitizeBasename(input.name)}`;
      try {
        const { uploadUrl, publicPath } = await storagePutUrl(key, input.contentType, {
          ownerId: ctx.user.id,
        });
        return { key, uploadUrl, publicPath };
      } catch (e) {
        if (e instanceof StorageError && e.code === "failed") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "upload rejected by storage — check contentType is on the platform's whitelist " +
              "(png/jpeg/gif/webp/avif, pdf, text/plain, csv, json, mpeg/wav audio, mp4/webm video)",
          });
        }
        throw e;
      }
    }),

  commit: protectedProcedure
    .input(z.object({ key: z.string().min(1), name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await storageCommit(input.key, { ownerId: ctx.user.id, name: input.name });
      } catch (e) {
        if (e instanceof StorageError && e.code === "not_found") {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "upload not found — did the PUT succeed?",
          });
        }
        if (e instanceof StorageError && e.code === "forbidden") {
          throw new TRPCError({ code: "FORBIDDEN", message: "that key belongs to another user" });
        }
        throw e;
      }
    }),

  list: protectedProcedure.query(({ ctx }) => storageListByOwner(ctx.user.id)),

  remove: protectedProcedure
    .input(z.object({ key: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await storageDeleteOwned(ctx.user.id, input.key);
      } catch (e) {
        if (e instanceof StorageError && e.code === "forbidden") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "malformed key" });
        }
        throw e;
      }
    }),
});

// ── platform API keys ───────────────────────────────────────────────────────
// The Studio's own developer keys. Every procedure here is `protectedProcedure`,
// so a key can only be minted by a signed-in account and only for that account.
//
// `create` is the ONE place a plaintext key crosses the wire, and it is returned
// as a sibling of `key` rather than a field on it — so it cannot be picked up by
// a spread into a list response.
const apiKeyRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => ({
    keys: await listApiKeys(ctx.user.id),
    usage: await apiKeyUsageSummary(ctx.user.id),
    defaults: {
      rateLimitPerHour: DEFAULT_RATE_LIMIT_PER_HOUR,
      maxRateLimitPerHour: MAX_RATE_LIMIT_PER_HOUR,
      scopes: ALL_SCOPES,
    },
  })),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(64),
        scopes: z.array(z.string()).optional(),
        rateLimitPerHour: z.number().int().positive().max(MAX_RATE_LIMIT_PER_HOUR).optional(),
        expiresInDays: z.number().int().positive().max(3650).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createApiKey({
          ownerId: ctx.user.id,
          name: input.name,
          scopes: input.scopes as never,
          rateLimitPerHour: input.rateLimitPerHour ?? null,
          expiresInDays: input.expiresInDays ?? null,
        });
      } catch (e) {
        if (e instanceof ApiKeyError) {
          throw new TRPCError({
            code: e.code === "not_found" ? "NOT_FOUND" : "BAD_REQUEST",
            message: e.message,
          });
        }
        throw e;
      }
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const key = await revokeApiKey(ctx.user.id, input.id, "revoked from the Studio");
      if (!key) throw new TRPCError({ code: "NOT_FOUND", message: "No such key." });
      return key;
    }),

  // Rotate returns a NEW plaintext and revokes the old key in the same call, so
  // there is no window where both are live and no window where neither is.
  rotate: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const created = await rotateApiKey(ctx.user.id, input.id);
      if (!created) throw new TRPCError({ code: "NOT_FOUND", message: "No such key." });
      return created;
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => ({
      deleted: await deleteApiKey(ctx.user.id, input.id),
    })),
});

export const appRouter = router({
  auth: authRouter,
  apiKeys: apiKeyRouter,
  device: deviceRouter,
  workspaces: workspaceRouter,
  sessions: sessionRouter,
  deps: depRouter,
  runs: runRouter,
  settings: settingsRouter,
  files: filesRouter,
});

export type AppRouter = typeof appRouter;
