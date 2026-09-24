"""
Sovereign Model Registry Service
Governs model metadata, capability routing, and state verification.
"""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel

class ModelMetadata(BaseModel):
    model_id: str
    display_name: str
    series: str  # 'V-Series', 'M-Series', 'Specialized', 'Development'
    version: str
    competitor_target: str
    specialization: str
    status: str  # 'ACTIVE', 'CHECKPOINT_REQUIRED', 'DEVELOPMENT_ONLY', 'DEPRECATED'
    context_window: int
    parameter_scale: str
    is_default: bool = False

SOVEREIGN_MODELS: List[ModelMetadata] = [
    ModelMetadata(
        model_id="mindarchitect-forge-v5.6",
        display_name="MindArchitect Forge V-5.6",
        series="V-Series",
        version="5.6",
        competitor_target="OpenAI Codex 5.5 / 5.6",
        specialization="The ultimate full-stack developer model. Generates Next.js frontends, writes PyTorch layers, and configures Docker environments autonomously.",
        status="CHECKPOINT_REQUIRED",
        context_window=131072,
        parameter_scale="7B / 14B MoE",
        is_default=True,
    ),
    ModelMetadata(
        model_id="mindarchitect-apex-m5.0",
        display_name="MindArchitect Apex M-5.0",
        series="M-Series",
        version="5.0",
        competitor_target="Claude Opus 5",
        specialization="The flagship deep-reasoning engine. Structural peak of intelligence for mathematical formalization, systems proofs, and high-entropy planning.",
        status="CHECKPOINT_REQUIRED",
        context_window=131072,
        parameter_scale="70B MoE",
        is_default=False,
    ),
    ModelMetadata(
        model_id="mindarchitect-synapse-m5.0",
        display_name="MindArchitect Synapse M-5.0",
        series="M-Series",
        version="5.0",
        competitor_target="Claude Sonnet 5 / 4.6",
        specialization="Fast, highly efficient agentic model. Lightning-fast neural connections designed for real-time task orchestration, sub-second TTFT, and ReAct loops.",
        status="CHECKPOINT_REQUIRED",
        context_window=65536,
        parameter_scale="14B Dense",
        is_default=False,
    ),
    ModelMetadata(
        model_id="mindarchitect-cortex-v5.6",
        display_name="MindArchitect Cortex V-5.6",
        series="V-Series",
        version="5.6",
        competitor_target="GPT-5.6 Terra / Sol",
        specialization="High-parameter enterprise model. Outer layer reasoning engine responsible for complex enterprise logic, memory indexing, and highest-level policy thought.",
        status="CHECKPOINT_REQUIRED",
        context_window=131072,
        parameter_scale="32B / 128B MoE",
        is_default=False,
    ),
    ModelMetadata(
        model_id="mindarchitect-matrix-v5.0",
        display_name="MindArchitect Matrix V-5.0",
        series="Specialized",
        version="5.0",
        competitor_target="Data-Tier Infrastructure & Vector Optimization",
        specialization="Data-tier specialist explicitly trained for PostgreSQL schemas, TimescaleDB hypertables, Qdrant HNSW indexing, and vector search optimizations.",
        status="CHECKPOINT_REQUIRED",
        context_window=65536,
        parameter_scale="7B Dense",
        is_default=False,
    ),
    ModelMetadata(
        model_id="mindarchitect-logic-m5.0",
        display_name="MindArchitect Logic M-5.0",
        series="Specialized",
        version="5.0",
        competitor_target="Pure Algorithmic & ReAct Loop Debugging",
        specialization="Pure algorithmic model designed for debugging complex ReAct agent loops, resolving dependency hell, and fixing syntax errors before runtime.",
        status="CHECKPOINT_REQUIRED",
        context_window=65536,
        parameter_scale="7B Dense",
        is_default=False,
    ),
    ModelMetadata(
        model_id="mindarchitect-forge-smoke",
        display_name="MindArchitect Forge Smoke (Local Host)",
        series="Development",
        version="smoke-1.0",
        competitor_target="Host CI/CD Verification",
        specialization="Truthfully registered host verification model (~28.5M params). Proves end-to-end GQA, RoPE, RMSNorm, and SwiGLU forward/backward training pipeline.",
        status="DEVELOPMENT_ONLY",
        context_window=2048,
        parameter_scale="28.5M",
        is_default=False,
    ),
]

class ModelRegistryService:
    @staticmethod
    def list_models(series: Optional[str] = None) -> List[ModelMetadata]:
        if series:
            return [m for m in SOVEREIGN_MODELS if m.series.lower() == series.lower()]
        return SOVEREIGN_MODELS

    @staticmethod
    def get_model(model_id: str) -> Optional[ModelMetadata]:
        for m in SOVEREIGN_MODELS:
            if m.model_id == model_id:
                return m
        return None
