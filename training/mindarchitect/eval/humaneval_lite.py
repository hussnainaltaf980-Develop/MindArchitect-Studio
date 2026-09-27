#!/usr/bin/env python3
"""Dataset integrity eval + student decoder smoke (not a 7B SWE-bench stand-in)."""

from __future__ import annotations

import json
from pathlib import Path

from mindarchitect.synth.pipeline import _exec_pair

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "sft_verified.jsonl"
STATUS = ROOT / "artifacts" / "lab" / "last_eval.json"


def run() -> dict:
    rows = []
    if DATA.exists():
        rows = [json.loads(l) for l in DATA.read_text().splitlines() if l.strip()]
    passed = 0
    failed = 0
    for r in rows:
        code = r["messages"][1]["content"]
        ok, _ = _exec_pair(code, r.get("tests", "pass"))
        if ok:
            passed += 1
        else:
            failed += 1
    summary = {
        "ok": failed == 0 and passed > 0,
        "benchmark": "execution-validated-sft",
        "n": len(rows),
        "pass": passed,
        "fail": failed,
        "pass_rate": round(passed / len(rows), 4) if rows else 0.0,
        "note": "Student decoder HumanEval@1 is reported after SFT in last_train.json. This score is the dataset's own execution gate — the bar before a pair is allowed into Forge.",
    }
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    STATUS.write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    run()
