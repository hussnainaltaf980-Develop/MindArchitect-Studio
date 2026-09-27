#!/usr/bin/env node
/** CI subset of registry + agent schemas on PGlite (Postgres WASM). */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Repo-relative, so this runs from any checkout instead of only the author's machine.
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolve(HERE, "..", "..");


const CKPT = process.env.SMOKE_CKPT
  ?? resolve(SERVICE_ROOT, "artifacts", "checkpoints", "smoke", "model.safetensors");

const db = new PGlite();
await db.waitReady;

await db.exec(`
create schema if not exists registry;
create schema if not exists agent;

create table if not exists registry.models (
  public_id   text primary key,
  display_name text not null,
  vocab_size  integer not null check (vocab_size > 0),
  weights_uri text not null,
  tenant_routable boolean not null default false
);

create table if not exists agent.agent_runs (
  run_id    text primary key,
  tenant_id text not null,
  prompt    text not null,
  status    text not null,
  answer    text,
  engine    text not null
);

create table if not exists agent.agent_steps (
  id           text primary key,
  run_id       text not null references agent.agent_runs(run_id) on delete cascade,
  step_index   integer not null,
  step_type    text not null,
  content      text not null,
  content_json jsonb not null default '{}'::jsonb,
  pruned       boolean not null default false,
  score        double precision
);

insert into registry.models (public_id, display_name, vocab_size, weights_uri, tenant_routable)
values (
  'mindarchitect-forge-smoke-4m',
  'MindArchitect Forge Smoke (dev 4M)',
  32004,
  'file://${CKPT}',
  false
);

insert into agent.agent_runs (run_id, tenant_id, prompt, status, answer, engine)
values ('run_ci_smoke', 'tenant_ci', 'sanity', 'completed', 'ok', 'native');

insert into agent.agent_steps (id, run_id, step_index, step_type, content, content_json, pruned, score)
values
  ('s1', 'run_ci_smoke', 0, 'thought', 'path A', '{"branch_id":"A"}'::jsonb, false, 0.81),
  ('s2', 'run_ci_smoke', 1, 'prune', 'path B dropped', '{"branch_id":"B"}'::jsonb, true, 0.41);
`);

const model = await db.query(
  "select public_id, vocab_size, tenant_routable from registry.models where public_id = $1",
  ["mindarchitect-forge-smoke-4m"],
);
const steps = await db.query("select count(*)::int as n from agent.agent_steps where run_id = $1", [
  "run_ci_smoke",
]);

const row = model.rows[0];
const ok =
  row &&
  Number(row.vocab_size) === 32004 &&
  row.tenant_routable === false &&
  existsSync(CKPT) &&
  Number(steps.rows[0].n) >= 2;

const payload = {
  ok: Boolean(ok),
  public_id: row?.public_id ?? null,
  vocab_size: Number(row?.vocab_size ?? 0),
  steps: Number(steps.rows[0]?.n ?? 0),
  engine: "pglite",
  checkpoint_present: existsSync(CKPT),
};
process.stdout.write(JSON.stringify(payload) + "\n");
process.exit(ok ? 0 : 1);
