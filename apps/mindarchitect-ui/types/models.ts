export type ModelSeries = 'V-Series' | 'M-Series' | 'Specialized' | 'Development';

export type ModelStatus = 'ACTIVE' | 'CHECKPOINT_REQUIRED' | 'DEVELOPMENT_ONLY' | 'DEPRECATED';

export interface SovereignModel {
  model_id: string;
  display_name: string;
  series: ModelSeries;
  version: string;
  competitor_target: string;
  specialization: string;
  status: ModelStatus;
  context_window: number;
  parameter_scale: string;
  is_default?: boolean;
}

export const SOVEREIGN_MODEL_CATALOG: SovereignModel[] = [
  {
    model_id: 'mindarchitect-forge-v5.6',
    display_name: 'MindArchitect Forge V-5.6',
    series: 'V-Series',
    version: '5.6',
    competitor_target: 'OpenAI Codex 5.5 / 5.6',
    specialization: 'Full-stack generation: Next.js frontends, PyTorch layers, Docker architectures.',
    status: 'CHECKPOINT_REQUIRED',
    context_window: 131072,
    parameter_scale: '7B / 14B MoE',
    is_default: true,
  },
  {
    model_id: 'mindarchitect-apex-m5.0',
    display_name: 'MindArchitect Apex M-5.0',
    series: 'M-Series',
    version: '5.0',
    competitor_target: 'Claude Opus 5',
    specialization: 'Flagship deep-reasoning engine: Formal mathematical proofs and architectural synthesis.',
    status: 'CHECKPOINT_REQUIRED',
    context_window: 131072,
    parameter_scale: '70B MoE',
    is_default: false,
  },
  {
    model_id: 'mindarchitect-synapse-m5.0',
    display_name: 'MindArchitect Synapse M-5.0',
    series: 'M-Series',
    version: '5.0',
    competitor_target: 'Claude Sonnet 5 / 4.6',
    specialization: 'Lightning agentic orchestrator: Sub-second TTFT, real-time ReAct loop execution.',
    status: 'CHECKPOINT_REQUIRED',
    context_window: 65536,
    parameter_scale: '14B Dense',
    is_default: false,
  },
  {
    model_id: 'mindarchitect-cortex-v5.6',
    display_name: 'MindArchitect Cortex V-5.6',
    series: 'V-Series',
    version: '5.6',
    competitor_target: 'GPT-5.6 Terra / Sol',
    specialization: 'High-parameter enterprise model: High-level policy thought and memory graph routing.',
    status: 'CHECKPOINT_REQUIRED',
    context_window: 131072,
    parameter_scale: '32B / 128B MoE',
    is_default: false,
  },
  {
    model_id: 'mindarchitect-matrix-v5.0',
    display_name: 'MindArchitect Matrix V-5.0',
    series: 'Specialized',
    version: '5.0',
    competitor_target: 'PostgreSQL & Vector Infrastructure',
    specialization: 'Data-tier specialist: PostgreSQL schemas, TimescaleDB hypertables, Qdrant HNSW indexing.',
    status: 'CHECKPOINT_REQUIRED',
    context_window: 65536,
    parameter_scale: '7B Dense',
    is_default: false,
  },
  {
    model_id: 'mindarchitect-logic-m5.0',
    display_name: 'MindArchitect Logic M-5.0',
    series: 'Specialized',
    version: '5.0',
    competitor_target: 'ReAct Agent Loops & Runtime Debugging',
    specialization: 'Pure algorithmic model: Resolving dependency hell, syntax errors, and AST logic bugs.',
    status: 'CHECKPOINT_REQUIRED',
    context_window: 65536,
    parameter_scale: '7B Dense',
    is_default: false,
  },
  {
    model_id: 'mindarchitect-forge-smoke',
    display_name: 'MindArchitect Forge Smoke (Local Host)',
    series: 'Development',
    version: 'smoke-1.0',
    competitor_target: 'Host Verification',
    specialization: 'Truthful local CI/CD verification model (~28.5M params). Proves complete pipeline functionality.',
    status: 'DEVELOPMENT_ONLY',
    context_window: 2048,
    parameter_scale: '28.5M',
    is_default: false,
  },
];
