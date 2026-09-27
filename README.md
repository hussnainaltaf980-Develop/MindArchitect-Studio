# MindArchitect Studio

A workspace for the MindArchitect model hierarchy — chat against the layered
engine plane, train the Forge student in the Lab, run a real shell in the Console,
and issue API keys so your own code can call the models.

This repository is the **complete working tree**: the ported Studio frontend, the
LLM gateway reply plane, the platform API key system, the training pipeline and
corpus, the PTY console bridge, tests, configs and evidence.

---

## Quick start

```bash
pnpm install
cp .env.example .env      # then fill in DATABASE_URL and JWT_SECRET
pnpm db:migrate           # creates the tables, including api_keys
pnpm dev                  # SPA on :3000, API on :3001
```

Open <http://localhost:3000>, click **Create account**, and you are in.

### Environment

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres DSN. Validated **at import time**, so a missing value fails at startup rather than on first query. |
| `DB_DRIVER` | no | `tcp` (default) or `http` for a Neon-style serverless endpoint. |
| `JWT_SECRET` | **yes** | Signs the session JWT. Validated at import time, so it is required in development too. Generate with `openssl rand -base64 32`. |
| `PORT` / `API_PORT` | no | Dev ports. Default `3000` / `3001`. |
| `MINDARCHITECT_LLM_API_KEY` | no | Turns on the **live gateway**. Without it the Studio answers from the local expert plane. |
| `MINDARCHITECT_LLM_BASE_URL` | no | Overrides the provider endpoint. Derived from whichever provider key is present when unset. |
| `MINDARCHITECT_LLM_MODEL` | no | Overrides the model id. **Derives from the same provider as the key** when unset — setting one without the other is the bug that produces a 404 against a correct endpoint. |
| `MINDARCHITECT_LLM_DISABLED` | no | Kill switch. Set to `1` to force the local plane even with a key configured. |
| `MINDARCHITECT_KEY_RATE_LIMIT_PER_HOUR` | no | Default hourly budget for newly created API keys. Default `120`. |

### Scripts

```bash
pnpm dev          # SPA + API with HMR
pnpm build        # client bundle + prod server
pnpm start        # run the built server
pnpm test         # vitest (loads .env via server/_core/test-setup.ts)
pnpm typecheck    # tsc --noEmit
pnpm db:migrate   # drizzle-kit generate + migrate
```

---

## Layout

```
client/                 React SPA (wouter router)
  src/_core/            auth provider, gates, session client
  src/components/       Studio shell + panels (chat, agents, lab, memory,
                        documents, models, settings), model selector
  src/lib/              model catalogue, API client (SSE), brand, utils
  src/pages/            Login, Signup, Studio
  src/stores/           Zustand studio store (persisted)
  public/brand/         Logo and mark assets
server/                 API
  routes/studio.ts      /v1 chat (SSE), models, health, lab
  routes/pty.ts         WebSocket → kernel pseudo-terminal bridge
  services/gateway.ts   streaming LLM gateway client + error taxonomy
  services/gateway-config.ts   env-only config resolution (never hardcoded)
  _core/                platform auth, db, trpc base
shared/                 shared types/constants
drizzle/                schema + SQL migrations
training/               training pipeline (PyTorch)
  mindarchitect/        model definition (GQA + RoPE), config
  scripts/              train_smoke.py, train_longctx.py, BPE trainer,
                        corpus generators, evaluation
  data_v3/              the v3 corpus: train/validation/test splits,
                        BPE tokenizer, corpus + coverage metadata
  artifacts/            checkpoints (loss history, manifest, config)
  tests/                pytorch/numpy parity and shape tests
tools/                  verification harnesses (gateway live-check, etc.)
```

---

## The reply plane — gateway or local, and it says which

`POST /v1/chat/completions` streams over SSE and reports **which engine answered**
via the `x-ma-engine` response header and a `ma_engine` field on every event:

| Situation | `x-ma-engine` | reason |
|---|---|---|
| No key configured / kill switch | `local` | `not_configured` / `disabled` |
| 401 / 403 | `local` | `unauthorized` / `forbidden` |
| 429 · timeout · 5xx · unreachable | `local` | `rate_limited` / `timeout` / `upstream_error` / `network` |
| Upstream died **after** partial text | `gateway` | in-band error, `partial: true` |
| Gateway answered | `gateway` | `ok` |

The header is written before the first body byte, so header and body cannot
disagree. Once real tokens have been delivered the stream **stays** on `gateway`
and reports the breakage in-band, rather than silently swapping in a different
engine's answer. `GET /v1/health` reports `configured` / `enabled` / `usable` /
`reachable` / `status` / `keySource` / `baseUrl`, with the key redacted.

A valid `MINDARCHITECT_LLM_API_KEY` is the **only** thing standing between this
path and a live completion; see `tools/verify-gateway-live.sh`.

---

## The training pipeline

Honest numbers, measured, with the artifacts that produced them in `training/`.

| | value |
|---|---|
| corpus | 4,662 examples, 86 generator families, 5 categories |
| splits | template-held-out; leak check clean |
| tokenizer | BPE, 7,035 of 32,004 ids reachable |
| training | 1,000 / 1,000 steps, cosine reaches `min_lr` exactly |
| checkpoints | `smoke-b-full-v10` (full schedule), `smoke-a-earlystop-v10` (patience) |

**This is not a capable model.** 4,662 synthetic examples on a tokenizer using
22% of its vocabulary. The pipeline is validated end to end; the model is not a
product. Per-category evaluation and the failure modes are recorded in the
checkpoint manifests.

Run it yourself (CPU is fine, slowly):

```bash
cd training
python scripts/train_smoke.py --help
python scripts/train_longctx.py --help
```

---

## Known limits

- **The Studio's public preview sits behind the platform's own auth gate.** Run it
  locally with `pnpm dev` and sign up there.
- **`/v1/lab/*` replays the recorded run** and labels itself
  `provenance: "recorded"`. No GPU on the build host, so claiming a fresh run
  would be false.
- **No live gateway completion has been verified with a valid key.** The request
  path, auth classification and key redaction were verified against the real
  provider host (a real 401); a successful completion needs a working key.
- **Undeclared dependency:** `server/services/pglite_registry.mjs` imports
  `@electric-sql/pglite`, which is not in any manifest.
- The corpus is **generated, not curated**.
- `.env` is deliberately absent from this repository; use `.env.example`.
