-- Seed Sovereign V-Series, M-Series, and Specialized Model Registry
-- Anchoring MindArchitect Studio directly against heavyweights: Codex 5.6, Claude Opus 5, GPT-5.6

INSERT INTO model_registry (
    model_id,
    display_name,
    series,
    version,
    competitor_target,
    specialization,
    status,
    context_window,
    parameter_scale,
    tensor_parallel_size,
    is_default
) VALUES
-- 1. Flagship Full-Stack Developer Model (Direct Codex 5.5 / 5.6 Counter)
(
    'mindarchitect-forge-v5.6',
    'MindArchitect Forge V-5.6',
    'V-Series',
    '5.6',
    'OpenAI Codex 5.5 / 5.6',
    'Ultimate full-stack developer model. Generates Next.js frontends, writes PyTorch layers, and configures Docker environments autonomously.',
    'CHECKPOINT_REQUIRED',
    131072,
    '7B / 14B MoE',
    1,
    TRUE
),
-- 2. Flagship Deep-Reasoning Engine (Direct Claude Opus 5 Counter)
(
    'mindarchitect-apex-m5.0',
    'MindArchitect Apex M-5.0',
    'M-Series',
    '5.0',
    'Claude Opus 5',
    'The flagship deep-reasoning engine. Peak cognitive architecture for mathematical proofs, complex systems synthesis, and formal verification.',
    'CHECKPOINT_REQUIRED',
    131072,
    '70B MoE',
    2,
    FALSE
),
-- 3. Lightning Agentic Model (Direct Claude Sonnet 5 / 4.6 Counter)
(
    'mindarchitect-synapse-m5.0',
    'MindArchitect Synapse M-5.0',
    'M-Series',
    '5.0',
    'Claude Sonnet 5 / 4.6',
    'Fast, highly efficient agentic model. Lightning-fast neural connections optimized for real-time tool orchestration, sub-second TTFT, and ReAct loops.',
    'CHECKPOINT_REQUIRED',
    65536,
    '14B Dense',
    1,
    FALSE
),
-- 4. High-Parameter Enterprise Model (Direct GPT-5.6 Terra / Sol Counter)
(
    'mindarchitect-cortex-v5.6',
    'MindArchitect Cortex V-5.6',
    'V-Series',
    '5.6',
    'GPT-5.6 Terra / Sol',
    'High-parameter enterprise model. Outer layer reasoning engine responsible for complex enterprise logic, memory indexing, and highest-level policy analysis.',
    'CHECKPOINT_REQUIRED',
    131072,
    '32B / 128B MoE',
    2,
    FALSE
),
-- 5. Data-Tier Specialist (Specialized Code Ecosystem)
(
    'mindarchitect-matrix-v5.0',
    'MindArchitect Matrix V-5.0',
    'Specialized',
    '5.0',
    'Database Engineering & Vector Embeddings',
    'Data-tier specialist. Explicitly trained for PostgreSQL schemas, TimescaleDB hypertables, Qdrant HNSW indexing, and vector search optimizations.',
    'CHECKPOINT_REQUIRED',
    65536,
    '7B Dense',
    1,
    FALSE
),
-- 6. Pure Algorithmic Model (Specialized Code Ecosystem)
(
    'mindarchitect-logic-m5.0',
    'MindArchitect Logic M-5.0',
    'Specialized',
    '5.0',
    'Algorithmic Debugging & AST Optimization',
    'Pure algorithmic model. Designed for debugging complex ReAct agent loops, resolving dependency hell, and fixing syntax errors before runtime.',
    'CHECKPOINT_REQUIRED',
    65536,
    '7B Dense',
    1,
    FALSE
),
-- 7. Local Host Verification & Smoke Model (Task 3 Option A)
(
    'mindarchitect-forge-smoke',
    'MindArchitect Forge Smoke (Local Host)',
    'Development',
    'smoke-1.0',
    'Local Host CI/CD Smoke Verification',
    'Truthful local CI/CD verification model trained on host. Validates GQA, RoPE, RMSNorm, and SwiGLU forward/backward pipeline.',
    'DEVELOPMENT_ONLY',
    2048,
    '28.5M',
    1,
    FALSE
)
ON CONFLICT (model_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    series = EXCLUDED.series,
    version = EXCLUDED.version,
    competitor_target = EXCLUDED.competitor_target,
    specialization = EXCLUDED.specialization,
    status = EXCLUDED.status,
    context_window = EXCLUDED.context_window,
    parameter_scale = EXCLUDED.parameter_scale,
    updated_at = NOW();
