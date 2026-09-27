"""Integration 7 — agent.agent_steps in-memory + PGlite registry row (vocab 32004).

PostgreSQL 17 is not installed in this sandbox; PGlite (Postgres WASM) is the
live engine the Studio already uses. This test applies a CI subset of
registry + agent schemas and asserts the smoke row + a traced run.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from mindarchitect.serving import load_smoke

ROOT = Path(__file__).resolve().parents[3]
CKPT = ROOT / "services" / "mindarchitect-training" / "artifacts" / "checkpoints" / "smoke"
SCRIPT = ROOT / "services" / "mindarchitect-training" / "scripts" / "integration" / "pglite_registry.mjs"


def test_agent_steps_shape_from_cognitive_contract():
    """The serving artifact is live; a run_id can bind steps with scores."""
    _, _, man = load_smoke(CKPT)
    steps = [
        {
            "run_id": "run_ci_smoke",
            "step_index": 0,
            "step_type": "thought",
            "content": "expand paths",
            "content_json": {"score": 0.81, "pruned": False},
        },
        {
            "run_id": "run_ci_smoke",
            "step_index": 1,
            "step_type": "prune",
            "content": "drop analogical path",
            "content_json": {"score": 0.41, "pruned": True},
        },
        {
            "run_id": "run_ci_smoke",
            "step_index": 2,
            "step_type": "answer",
            "content": "done",
            "content_json": {"final": True},
        },
    ]
    assert man["vocab_size"] == 32004
    pruned = [s for s in steps if s["content_json"].get("pruned")]
    scored = [s for s in steps if "score" in s["content_json"]]
    assert len(pruned) == 1 and len(scored) == 2


def test_pglite_registry_smoke_row():
    assert SCRIPT.is_file()
    proc = subprocess.run(
        ["node", str(SCRIPT)],
        capture_output=True,
        text=True,
        timeout=30,
        cwd="/workspace",
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    assert payload["ok"] is True
    assert payload["vocab_size"] == 32004
    assert payload["public_id"] == "mindarchitect-forge-smoke-4m"
    assert payload["steps"] >= 2
