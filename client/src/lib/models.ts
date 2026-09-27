// The sovereign model hierarchy — the project's own catalogue, unchanged.
// Its ids, badges, context windows and declared parameter counts are the
// registry's vocabulary; the Lab and Models panels read status against them.
export type ModelSeries = "V" | "M" | "CI";

export type CatalogueModel = {
  id: string;
  name: string;
  series: ModelSeries;
  badge: string;
  role: string;
  vibe: string;
  ctx: string;
  params: string;
  competitor: string;
  available: boolean;
  minTier: string;
  routing: "chat" | "cognitive" | "embed" | "guard" | "ci";
};

export const CATALOGUE: CatalogueModel[] = [
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
    available: true,
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
    available: true,
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
    available: true,
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
    available: true,
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
    available: true,
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
    available: true,
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
    available: true,
    minTier: "ci",
    routing: "ci",
  },
];

export const CHAT_MODELS = CATALOGUE.filter((m) => m.routing === "chat" || m.routing === "cognitive");

export const DEFAULT_CHAT_MODEL = "mindarchitect-synapse-v5.0";
export const DEFAULT_COGNITIVE_MODEL = "mindarchitect-apex-m5.0";

/** Transport map: sovereign names stay in the UI; the gateway talks to xAI as grok-4.5. */
export const TRANSPORT_MODEL = "grok-4.5";

export function catalogueById(id: string): CatalogueModel | undefined {
  return CATALOGUE.find((m) => m.id === id);
}
