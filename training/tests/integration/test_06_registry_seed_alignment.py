"""Integration 6 — registry seed + smoke manifest agree on vocab 32004."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SEED = ROOT / "mindarchitect-api" / "app" / "db" / "sql" / "seed.sql"
if not SEED.exists():
    SEED = ROOT / "services" / "mindarchitect-api" / "app" / "db" / "sql" / "seed.sql"
MANIFEST = ROOT / "services" / "mindarchitect-training" / "artifacts" / "checkpoints" / "smoke" / "manifest.json"


def _smoke_block(sql: str) -> str:
    start = sql.index("mindarchitect-forge-smoke-4m")
    return sql[start : start + 1800]


def test_seed_vocab_is_32004():
    sql = SEED.read_text()
    block = _smoke_block(sql)
    # The smoke INSERT lists vocab_size just before activation 'swiglu'.
    m = re.search(r"\n\s*(32004)\s*,\s*'swiglu'", block)
    assert m, f"smoke seed vocab is not 32004 in block:\n{block[:400]}"


def test_manifest_matches_seed():
    man = json.loads(MANIFEST.read_text())
    assert man["vocab_size"] == 32004
    assert man["available"] is True
    assert Path(man["checkpoint"]).name == "model.safetensors"
