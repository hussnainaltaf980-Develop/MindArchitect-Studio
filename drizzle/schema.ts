import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  bigint,
  integer,
  boolean,
  doublePrecision,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM TABLE — managed by the scaffold. The Agent MUST NOT redefine or drop
// the auth columns here; it only ADDS business tables below (DESIGN §5.1).
// ─────────────────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"), // null for SSO-linked users (future)
  name: text("name"),
  role: text("role").notNull().default("user"), // 'user' | 'admin'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// SYSTEM TABLE — managed by the scaffold, written by server/_core/storage.ts.
export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("files_owner_idx").on(t.ownerId), index("files_created_idx").on(t.createdAt)],
);

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS TABLES — the MindArchitect workspace domain.
//
// Every table FKs to users.id with onDelete: "cascade" so deleting an account
// takes its workspaces, files, sessions, runs and metrics with it, and every
// table indexes its owner column because every read is owner-scoped.
// ─────────────────────────────────────────────────────────────────────────────

// A workspace is the unit a user opens: a repo checkout plus an environment.
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Slug is per-owner unique (see the unique index below), which is what makes
    // it safe to show as a short human handle without a global-namespace grab.
    slug: text("slug").notNull(),
    // Which starter tree this workspace was created from. Recorded rather than
    // implied: the file list is a snapshot, so without this there is no way to
    // tell a MindArchitect workspace from a blank one.
    template: text("template").notNull().default("mindarchitect-training"),
    // 'gpu' when a CUDA device was actually detected at creation, else 'cpu'.
    // Stored, not assumed — see device.ts. This value is what the UI labels the
    // workspace with, so it must reflect a probe, never an aspiration.
    runtime: text("runtime").notNull().default("cpu"),
    deviceLabel: text("device_label"),
    status: text("status").notNull().default("ready"), // 'ready' | 'provisioning' | 'error'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workspaces_owner_idx").on(t.ownerId, t.createdAt),
    uniqueIndex("workspaces_owner_slug_uniq").on(t.ownerId, t.slug),
  ],
);

// The workspace's editable file tree. Content lives in the row rather than in
// object storage on purpose: these are small source files that the editor reads
// and writes constantly, and a storage round-trip per save would make the
// editor feel broken.
export const workspaceFiles = pgTable(
  "workspace_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull().default(""),
    language: text("language").notNull().default("plaintext"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workspace_files_ws_idx").on(t.workspaceId, t.path),
    uniqueIndex("workspace_files_ws_path_uniq").on(t.workspaceId, t.path),
  ],
);

// A session is one running environment attached to a workspace. The previous
// repo hardcoded a device string into its manifest; a row per session is what
// lets the UI show what is actually running and when it was last seen.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"), // 'running' | 'stopped'
    device: text("device").notNull().default("cpu"), // 'cuda' | 'mps' | 'cpu'
    gpuName: text("gpu_name"),
    vramGb: doublePrecision("vram_gb"),
    cpuCount: integer("cpu_count"),
    memoryCapMb: integer("memory_cap_mb"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("sessions_ws_idx").on(t.workspaceId, t.startedAt)],
);

// Dependency preflight results, one row per package per workspace.
export const dependencies = pgTable(
  "dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    versionReq: text("version_req").notNull(),
    installedVersion: text("installed_version"),
    // 'installed' | 'missing' | 'outdated' | 'unknown'
    status: text("status").notNull().default("unknown"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dependencies_ws_idx").on(t.workspaceId, t.name),
    uniqueIndex("dependencies_ws_name_uniq").on(t.workspaceId, t.name),
  ],
);

// A training or serving run, with its outcome recorded honestly.
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("train"), // 'train' | 'serve'
    status: text("status").notNull().default("queued"), // queued|running|completed|stopped|failed
    configJson: jsonb("config_json").notNull().default({}),
    maxSteps: integer("max_steps"),
    completedSteps: integer("completed_steps").notNull().default(0),
    initialLoss: doublePrecision("initial_loss"),
    finalLoss: doublePrecision("final_loss"),
    bestValLoss: doublePrecision("best_val_loss"),
    bestValStep: integer("best_val_step"),
    testLoss: doublePrecision("test_loss"),
    // Whether early stopping fired. Stored because it is the difference between
    // "ran the whole schedule" and "stopped at its best point", and the two runs
    // are not comparable — the previous 300-step run's final weights were the
    // most overfit ones precisely because nothing stopped it.
    stoppedEarly: boolean("stopped_early").notNull().default(false),
    // The tokenizer floor this run should be read against. A single number, so
    // the UI cannot accidentally compare a loss to the wrong baseline.
    randomGuessFloor: doublePrecision("random_guess_floor"),
    notes: text("notes"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("runs_ws_idx").on(t.workspaceId, t.startedAt)],
);

// Per-step metrics. One row per logged step per split.
export const runMetrics = pgTable(
  "run_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    step: integer("step").notNull(),
    split: text("split").notNull().default("train"), // 'train' | 'validation' | 'test'
    loss: doublePrecision("loss"),
    lr: doublePrecision("lr"),
    gradNorm: doublePrecision("grad_norm"),
  },
  (t) => [
    index("run_metrics_run_idx").on(t.runId, t.step),
    uniqueIndex("run_metrics_run_step_split_uniq").on(t.runId, t.step, t.split),
  ],
);

// Per-user key/value defaults (threads, seq len, seed, template).
export const settings = pgTable(
  "settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("settings_owner_key_uniq").on(t.ownerId, t.key)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Platform API keys — the Studio's own developer keys, the way a model provider
// issues them.
//
// The security model, in one place, because getting any part of it wrong is what
// turns a convenience feature into a credential leak:
//
//   * The plaintext key EXISTS ONCE — in the response to the create call. It is
//     never persisted and cannot be recovered. What is stored is a SHA-256 digest
//     plus a short display PREFIX. A digest is sufficient (and correct) here
//     because the key is 256 bits of CSPRNG output, not a human password: there
//     is no dictionary to attack, so a slow KDF would buy nothing and cost a
//     hash on every API request.
//   * `prefix` is shown in the list UI so a human can tell keys apart and match
//     one to a secret store. Eight characters of a 256-bit key do not narrow a
//     search meaningfully.
//   * Revocation is a timestamp, not a delete, so an audit trail survives and a
//     revoked key is distinguishable from one that never existed — which is what
//     lets the API answer 403 instead of 401.
//   * Usage is counted per key (`requestCount`, `lastUsedAt`, and a rolling
//     `windowStart`/`windowCount` for the rate limiter) so a key's cost is
//     attributable to the account that created it.
//   * A DB trigger is NOT used for the counter: writes happen through the same
//     `atomic` unit as the request bookkeeping so a crash cannot leave a counter
//     incremented without a recorded use (see services/api-keys.ts).
// ─────────────────────────────────────────────────────────────────────────────
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Owning account. Every read is owner-scoped; a key id is not a capability.
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Human label. Free text, because naming keys is how people manage them.
    name: text("name").notNull(),
    // SHA-256 of the full plaintext key, hex. UNIQUE so a collision (or a
    // duplicated insert) is a database error rather than two rows that both
    // "work" for one secret.
    keyHash: text("key_hash").notNull(),
    // First 12 chars of the plaintext ("ma_live_" + 4), for display and support.
    // Never sufficient to use a key.
    prefix: text("prefix").notNull(),
    // Last 4 chars, for the same reason a card shows its last four: recognising
    // which secret is in which vault.
    last4: text("last4").notNull(),
    // e.g. "ma_live". Carried so a future "ma_test" environment is a row value,
    // not a migration.
    environment: text("environment").notNull().default("live"),
    // JSON array of scope strings. [] means "the default set". Kept as text[]
    // semantics via jsonb so adding a scope needs no migration.
    scopes: jsonb("scopes").notNull().default([]),
    // Requests allowed per rolling hour. Null = the platform default.
    rateLimitPerHour: integer("rate_limit_per_hour"),
    requestCount: bigint("request_count", { mode: "number" }).notNull().default(0),
    // Rolling fixed-window counters for the limiter. A fixed window is deliberate:
    // it is O(1) to enforce and honest about its own boundary behaviour, unlike a
    // token bucket that needs a background refill.
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
    windowCount: integer("window_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // Non-null = revoked. Never overwritten, so the revocation time is auditable.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Optional expiry, distinct from revocation: an expired key lapsed on
    // schedule, a revoked one was withdrawn. The API reports the difference.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Who revoked it, when it was not the owner acting in the UI (rotation
    // scripts, incident response). Null for a UI revocation.
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_keys_hash_uniq").on(t.keyHash),
    index("api_keys_owner_idx").on(t.ownerId, t.createdAt),
  ],
);
