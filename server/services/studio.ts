// MindArchitect Studio — server-side data for the Models and health surfaces.
//
// The catalogue ids, badges, context windows and declared parameter counts are
// the project's own (lib/models.ts). What is NOT carried over is the project's
// hardcoded status text: `available` and `status` are derived here from the
// artifacts that actually exist in this deployment, so the UI reports a
// measurement instead of an aspiration.
//
// GATEWAY STATUS IS A MEASUREMENT TOO. `gatewayLive()` used to mean "an env var
// is non-empty", which tells you a string is present — not that the endpoint is
// reachable or that the key is accepted. Every gateway field below now comes
// from a real probe (services/gateway.ts → probeGateway), including the HTTP
// status and latency it observed.
import { existsSync, readFileSync } from "node:fs";
import { probeGateway, type GatewayProbe } from "./gateway";
import { scrubSecrets, type GatewayPublicConfig } from "./gateway-config";

export type CatalogueEntry = {
  id: string;
  name: string;
  series: "V" | "M" | "CI";
  badge: string;
  role: string;
  vibe: string;
  ctx: string;
  params: string;
  competitor: string;
  minTier: string;
  routing: "chat" | "cognitive" | "embed" | "guard" | "ci";
  available: boolean;
  status: string;
  note: string;
  probe?: {
    final_loss?: number;
    final_ppl?: number;
    token_accuracy?: number;
    param_count?: number;
  };
};

const CATALOGUE: Omit<CatalogueEntry, "available" | "status" | "note">[] = [
  {
    id: "mindarchitect-forge-v5.6",
    name: "MindArchitect Forge V-5.6",
    series: "V",
    badge: "FORGE",
    role: "Flagship full-stack code and architecture engine",
    vibe: "Heavy lifting. Compiles Next.js, PyTorch layers, Docker — from raw material.",
    ctx: "64K",
    params: "P0 20.5M",
    competitor: "Codex 5.6",
    minTier: "pro",
    routing: "chat",
  },
  {
    id: "mindarchitect-apex-m5.0",
    name: "MindArchitect Apex M-5.0",
    series: "M",
    badge: "APEX",
    role: "Sovereign deep reasoning and Tree-of-Thought flagship",
    vibe: "The peak. Structural intelligence — not a musical opus.",
    ctx: "32K",
    params: "target 7B",
    competitor: "Claude Opus 5",
    minTier: "developer",
    routing: "cognitive",
  },
  {
    id: "mindarchitect-synapse-v5.0",
    name: "MindArchitect Synapse V-5.0",
    series: "V",
    badge: "SYNAPSE",
    role: "High-throughput agentic and tool-calling engine",
    vibe: "Lightning-fast neural connections. Real-time orchestration.",
    ctx: "8K",
    params: "target 1.3B",
    competitor: "Claude Sonnet 5",
    minTier: "free",
    routing: "chat",
  },
  {
    id: "mindarchitect-cortex-v5.6",
    name: "MindArchitect Cortex V-5.6",
    series: "V",
    badge: "CORTEX",
    role: "High-parameter enterprise reasoning core",
    vibe: "Outer layer of the stack: complex logic, memory, highest-level thought.",
    ctx: "64K",
    params: "target 34B",
    competitor: "GPT-5.6",
    minTier: "pro",
    routing: "chat",
  },
  {
    id: "mindarchitect-matrix-v1",
    name: "MindArchitect Matrix",
    series: "V",
    badge: "MATRIX",
    role: "Database, vector and schema specialist",
    vibe: "PostgreSQL, TimescaleDB hypertables, pgvector — the data tier.",
    ctx: "8K",
    params: "335M",
    competitor: "—",
    minTier: "free",
    routing: "embed",
  },
  {
    id: "mindarchitect-logic-v5.0",
    name: "MindArchitect Logic 5.0",
    series: "V",
    badge: "LOGIC",
    role: "Pure algorithmic and ReAct execution guard",
    vibe: "Debugs agent loops, resolves dependency hell, stops bad syntax at the gate.",
    ctx: "8K",
    params: "279M",
    competitor: "—",
    minTier: "free",
    routing: "guard",
  },
  {
    id: "mindarchitect-forge-smoke-4m",
    name: "MindArchitect Forge Smoke (dev 4M)",
    series: "CI",
    badge: "CI",
    role: "Headless CI sanity runner for the native decoder",
    vibe: "Not tenant-routable. pytest + gradient-flow only. Vocab 32,004.",
    ctx: "128",
    params: "4M",
    competitor: "—",
    minTier: "ci",
    routing: "ci",
  },
];

// The trained smoke decoder's recorded run, from the project's own probe file
// (src/lib/smoke-probe.json). Used as the CI line's status and as the Lab's
// replay source — the SAME numbers the project recorded, not invented ones.
const SMOKE_PROBE = {
  vocab_size: 32004,
  param_count: 4182848,
  architecture: "GQA/RoPE/RMSNorm/SwiGLU",
  final_loss: 3.3931,
  final_ppl: 29.758,
  token_accuracy: 0.119,
  steps: 24,
  elapsed_s: 2.91,
  history: [
    { step: 1, loss: 10.414, ppl: 33323.294 },
    { step: 4, loss: 9.315, ppl: 11102.962 },
    { step: 8, loss: 7.8295, ppl: 2513.782 },
    { step: 12, loss: 6.1264, ppl: 457.805 },
    { step: 16, loss: 4.5305, ppl: 92.801 },
    { step: 20, loss: 3.6311, ppl: 37.756 },
    { step: 24, loss: 3.3197, ppl: 27.653 },
  ],
};

/** Where the project's training artifacts live, if this deployment has them. */
const PROBE_CANDIDATES = [
  "/workspace/mindarchitect_v7/repo/src/lib/forge-probe.json",
  "/workspace/mindarchitect_v6/workspace/services/mindarchitect-training/artifacts/forge-probe.json",
];

function readForgeProbe(): Record<string, unknown> | null {
  for (const p of PROBE_CANDIDATES) {
    try {
      if (!existsSync(p)) continue;
      return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * The gateway's real state, from a probe. `force` bypasses the probe cache —
 * used by the Settings panel's "re-probe" button, which exists precisely so an
 * operator can avoid waiting out the TTL after fixing a key.
 */
export async function gatewayStatus(force = false): Promise<{
  probe: GatewayProbe;
  config: GatewayPublicConfig;
}> {
  return probeGateway({ force });
}

/**
 * True only when the gateway is configured AND the last probe reached it.
 * Kept as a convenience for callers that only need the boolean; it is a
 * measurement, not an env var check.
 */
export async function gatewayReachable(force = false): Promise<boolean> {
  const { probe } = await gatewayStatus(force);
  return probe.reachable;
}

export async function studioCatalogue(): Promise<{
  data: CatalogueEntry[];
  gateway_live: boolean;
  gateway: GatewayPublicConfig;
  gateway_probe: GatewayProbe;
  generated_at: string;
}> {
  const { probe, config } = await gatewayStatus();
  const live = probe.reachable;
  const forge = readForgeProbe();
  const forgeAvailable = Boolean(forge?.available);

  // A configured-but-unreachable gateway is a THIRD state, not a synonym for
  // "no key". Collapsing it into either boolean would hide a real fault.
  const chatStatus = live ? "live-gateway" : config.configured ? "gateway-degraded" : "local-expert";
  const chatNote = live
    ? `Answered by the live inference gateway (${config.model}) and streamed token by token.`
    : config.configured
      ? `Gateway configured but not reachable — ${summariseDetail(scrubSecrets(probe.detail ?? probe.status, null)) ?? probe.status}. Falling back to the local expert plane.`
      : "Answered by the local expert plane — project knowledge, not a hosted model.";

  const data = CATALOGUE.map<CatalogueEntry>((m) => {
    if (m.id === "mindarchitect-forge-v5.6") {
      // Available ONLY if a checkpoint probe was actually found on disk.
      return {
        ...m,
        available: forgeAvailable,
        status: forgeAvailable ? "checkpoint-probed" : "no-checkpoint",
        note: forgeAvailable
          ? `Checkpoint probe found on disk. loss=${String(forge?.final_loss ?? "—")} ppl=${String(forge?.final_ppl ?? "—")}`
          : "No converged Forge V-5.6 checkpoint in this deployment. Train in Lab.",
        probe: forgeAvailable
          ? {
              final_loss: forge?.final_loss as number | undefined,
              final_ppl: forge?.final_ppl as number | undefined,
              token_accuracy: forge?.token_accuracy as number | undefined,
              param_count: forge?.param_count as number | undefined,
            }
          : undefined,
      };
    }
    if (m.routing === "cognitive") {
      return {
        ...m,
        available: true,
        status: live ? "live-tot" : "local-tot",
        note: live
          ? "Tree-of-Thought + Reflexion on the live planner."
          : config.configured
            ? "Gateway configured but unreachable — Tree-of-Thought runs on the local planner."
            : "Tree-of-Thought + Reflexion on the local planner (no gateway key configured).",
      };
    }
    if (m.routing === "chat") {
      return { ...m, available: true, status: chatStatus, note: chatNote };
    }
    if (m.routing === "ci") {
      return {
        ...m,
        available: true,
        status: "ci",
        note: `Recorded CI run: ${SMOKE_PROBE.steps} steps · loss ${SMOKE_PROBE.final_loss} · ${SMOKE_PROBE.param_count.toLocaleString("en-US")} params · ${SMOKE_PROBE.architecture}`,
        probe: {
          final_loss: SMOKE_PROBE.final_loss,
          final_ppl: SMOKE_PROBE.final_ppl,
          token_accuracy: SMOKE_PROBE.token_accuracy,
          param_count: SMOKE_PROBE.param_count,
        },
      };
    }
    return {
      ...m,
      available: true,
      status: "local-expert",
      note: `${m.role} — specialist line on the local expert plane.`,
    };
  });

  return {
    data,
    gateway_live: live,
    gateway: config,
    gateway_probe: probe,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Turn a provider's error body into one readable line.
 *
 * Providers answer with a JSON envelope. Interpolated raw into a status card,
 * that renders as a wall of escaped JSON (observed in the Models panel: the
 * whole `{"error":{"message":…}}` blob became the paragraph text). Preferring
 * `error.message` keeps the honesty — the user still reads the provider's own
 * words — while making it legible.
 */
function summariseDetail(detail: string | null): string | null {
  if (!detail) return null;
  const trimmed = detail.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
      const msg = parsed?.error?.message ?? parsed?.message;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
    } catch {
      // Not JSON after all — fall through to the plain-text path.
    }
  }
  return trimmed.replace(/\s+/g, " ");
}

export async function studioHealth(force = false) {
  const { probe, config } = await gatewayStatus(force);
  const forge = readForgeProbe();
  // Scrub on the way out, not only where the detail was produced. An upstream
  // error body is the one field here that is attacker/provider-controlled text,
  // so it is re-scrubbed at the boundary that hands it to a client — defence in
  // depth against a new echo shape the classifier did not anticipate.
  const safeDetail = probe.detail ? scrubSecrets(probe.detail, null) : null;
  const summary = summariseDetail(safeDetail);
  const safeReason = summary ?? config.reason;
  return {
    // Healthy means "this app is serving". An UNCONFIGURED gateway is a normal,
    // fully-working configuration — reporting `degraded` for it was wrong, and
    // it also made health lie about which fault needed attention: a missing key
    // and an invalid key rendered identically. Now only a gateway that is
    // configured AND unreachable, or actually failing, degrades the service.
    status: probe.reachable || !config.configured ? "ok" : "degraded",
    service: "mindarchitect-studio",
    version: "5.6.0",
    // `gateway_live` keeps its old meaning for existing clients, but now it is
    // "the gateway answered a real request", not "an env var was set".
    gateway_live: probe.reachable,
    gateway_reason: probe.reachable ? null : safeReason,
    gateway: {
      configured: config.configured,
      enabled: config.enabled,
      usable: config.usable,
      reachable: probe.reachable,
      status: probe.status,
      keySource: config.keySource,
      /** Which variable turned the gateway OFF, when one did. */
      disabledBy: config.disabledBy,
      baseUrl: config.baseUrl,
      baseUrlIsDefault: config.baseUrlIsDefault,
      model: config.model,
      modelIsDefault: config.modelIsDefault,
      httpStatus: probe.httpStatus,
      latencyMs: probe.latencyMs,
      checkedAt: probe.checkedAt,
      detail: summary,
      timeoutMs: config.timeoutMs,
      firstChunkTimeoutMs: config.firstChunkTimeoutMs,
    },
    cognitive: probe.reachable ? "up" : "local",
    forge: {
      available: Boolean(forge?.available),
      status: forge?.status ?? "unknown",
      final_loss: forge?.final_loss ?? null,
      param_count: forge?.param_count ?? null,
    },
    smoke: {
      available: true,
      vocab_size: SMOKE_PROBE.vocab_size,
      param_count: SMOKE_PROBE.param_count,
      final_loss: SMOKE_PROBE.final_loss,
    },
    uptime_s: Math.round(process.uptime()),
    generated_at: new Date().toISOString(),
  };
}

/** The recorded loss history the Lab replays when asked to train. */
export function recordedHistory(): { step: number; loss: number }[] {
  return SMOKE_PROBE.history.map((h) => ({ step: h.step, loss: h.loss }));
}

export function smokeFacts() {
  return SMOKE_PROBE;
}

/**
 * The local expert plane. No hosted model is reached: this answers from the
 * project's own knowledge — architecture, vocabulary, training findings — and
 * says so. It is deterministic and cannot hallucinate a citation.
 *
 * `gatewayNote` is appended when the local plane is answering because the
 * gateway failed, so the transcript never reads as if the local reply were the
 * hosted model's. A fallback that is indistinguishable from success is worse
 * than no fallback.
 */
export function localExpertReply(prompt: string, gatewayNote?: string | null): string {
  const p = prompt.toLowerCase();
  const lines: string[] = [];

  if (/gqa|grouped|attention|repeat|kv\b/.test(p)) {
    lines.push(
      "**GQA repeat.** Forge keeps `num_key_value_heads` narrower than `num_attention_heads`, so the k/v projections are computed once and then repeated across head groups before attention.",
      "",
      "In the smoke preset that is 4 query heads against 2 kv heads — every kv head serves 2 query heads. The point is cache size at decode time: the KV cache scales with kv heads, not query heads, so this is a 2× reduction on the smoke config and far more at flagship scale.",
      "",
      "Two things the audit found worth knowing: RoPE is applied to q and k *before* the cache concat using each token's absolute position (applying it after is what made the cached decode disagree with a full pass), and the attention mask must not be built from `torch.full(-inf)` — that path produces NaN.",
    );
  } else if (/timescale|hypertable|sql|schema|database|pgvector/.test(p)) {
    lines.push(
      "**TimescaleDB hypertable for loss metrics.** The project's runs/metrics pair maps onto a hypertable cleanly:",
      "",
      "```sql",
      "CREATE TABLE run_metrics (",
      "  run_id     uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,",
      "  step       integer NOT NULL,",
      "  split      text NOT NULL DEFAULT 'train',",
      "  loss       double precision,",
      "  lr         double precision,",
      "  grad_norm  double precision,",
      "  recorded_at timestamptz NOT NULL DEFAULT now(),",
      "  UNIQUE (run_id, step, split)",
      ");",
      "SELECT create_hypertable('run_metrics', 'recorded_at', chunk_time_interval => INTERVAL '1 day');",
      "```",
      "",
      "The UNIQUE constraint must include the time column for a hypertable — which is why the partition key here is `recorded_at` and the natural key `(run_id, step, split)` is a separate constraint.",
    );
  } else if (/tokeniz|vocab|bpe|entropy|floor|coverage/.test(p)) {
    lines.push(
      "**Tokenizer coverage.** The shipped tokenizer is byte-level: byte *b* maps to id *b+3*, with 0/1/2 reserved. So only ids 3–258 are ever reachable — 100 of 32,004 slots, with 31,904 dead (99.7%).",
      "",
      "That matters for reading any loss number: the true random-guess floor is **ln(100) ≈ 4.605**, not `ln(32004) ≈ 10.374`. A loss sitting at 6 is *not* \"still random\" — it is well below the floor the project was comparing against.",
      "",
      "Training BPE on the corpus raised reachable ids to 2,672 and cut bytes/token from 1.00 to 3.94 — 2.29 bits/byte against the byte-level 4.90.",
    );
  } else if (/rope|position|rotary/.test(p)) {
    lines.push(
      "**RoPE in Forge.** Angles come from an inverse-frequency schedule, and the *position index* must be each token's absolute offset in the sequence — not its offset within the current forward call.",
      "",
      "That distinction is the whole bug class here. When angles are computed from `get_cos_sin(seq_len)` and a cached token is decoded at position *N*, it receives the angles for position 0 instead. Measured drift against a one-shot full-sequence pass was **max |Δ| = 0.228** — real, and invisible if a test only asserts shapes.",
      "",
      "The fix applies `rotate_half` before the KV concat, using `position_ids` carried through the decode loop. The NumPy reference and the PyTorch path then agree to ~1.5e-06 on logits.",
    );
  } else if (/loss|train|converg|early|overfit|checkpoint/.test(p)) {
    lines.push(
      "**Training status, recorded.** The smoke decoder trains for real now — backward pass, AdamW, cosine schedule to `min_lr`:",
      "",
      "- 300-step run: loss **10.3595 → 0.005681**, `loss_delta` −10.353823",
      "- That run overfit: train 0.0057 while **validation rose to 7.6685**, best val at step 30",
      "- With a template-held-out split and early stopping: **final val 1.8787**, best val **2.1917 @ step 160**, stopped at 190, held-out **test 2.3633**",
      "- Checkpoint: **57 tensors**, 20,542,720 params, full **32,004-row** embedding table",
      "",
      "The old signature was train→0.0057 while val→7.67 — memorising 4 examples. The corrected curve is the one worth quoting.",
    );
  } else {
    lines.push(
      "**Local expert plane.** No hosted model answered this, so the reply is composed from the project's own recorded knowledge rather than generated:",
      "",
      "- **Model**: native decoder-only transformer — RMSNorm · RoPE · GQA · SwiGLU · causal mask",
      "- **Smoke preset**: 6 layers, 20.5M params, vocab 32,004, context 512",
      "- **Checkpoint**: 57 tensors, trained with AdamW + early stopping on a template-held-out split",
      "- **Studio**: Chat · Agents · Lab · Documents · Memory · Models · Settings",
      "",
      "Ask about GQA, RoPE, the TimescaleDB schema, tokenizer coverage, or the training curve and this plane will answer in detail — from what was actually measured, not generated.",
    );
  }

  if (gatewayNote) {
    lines.push("", "---", "", `> **Engine notice.** ${gatewayNote}`);
  }

  return lines.join("\n");
}
