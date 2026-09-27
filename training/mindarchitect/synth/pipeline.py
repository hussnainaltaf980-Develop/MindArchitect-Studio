#!/usr/bin/env python3
"""Evol-Instruct + execution-validation pipeline.

Local verified corpus always runs (no teacher spend). Optional teacher calls
(grok-4.5) are capped and user-triggered only.
"""

from __future__ import annotations

import hashlib
import json
import os
import textwrap
import traceback
import urllib.error
import urllib.request
from pathlib import Path

from mindarchitect.synth.tasks import EVOLUTIONS, TASKS

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "sft_verified.jsonl"
STATUS = ROOT / "artifacts" / "lab" / "last_synth.json"
MAX_TEACHER = 3


def _exec_pair(code: str, tests: str) -> tuple[bool, str]:
    ns: dict = {}
    try:
        exec(compile(code, "<sol>", "exec"), ns, ns)
        exec(compile(tests, "<test>", "exec"), ns, ns)
        return True, "pass"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def _row(instruction: str, code: str, tests: str, source: str, evolved_from: str | None = None) -> dict:
    text = (
        "### Instruction\n"
        f"{instruction.strip()}\n\n"
        "### Response\n"
        f"{code.strip()}\n"
    )
    return {
        "messages": [
            {"role": "user", "content": instruction.strip()},
            {"role": "assistant", "content": code.strip()},
        ],
        "text": text,
        "tests": tests,
        "source": source,
        "evolved_from": evolved_from,
        "hash": hashlib.sha256(text.encode()).hexdigest()[:16],
    }


def _teacher(prompt: str, max_tokens: int = 700) -> str | None:
    key = os.environ.get("XAI_API_KEY")
    if not key:
        return None
    body = json.dumps(
        {
            "model": "grok-4.5",
            "temperature": 0.4,
            "max_tokens": max_tokens,
            "messages": [
                {
                    "role": "system",
                    "content": "You write Python solutions only. Return a single fenced python block, no prose.",
                },
                {"role": "user", "content": prompt},
            ],
        }
    ).encode()
    req = urllib.request.Request(
        "https://api.x.ai/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            payload = json.loads(resp.read().decode())
        text = payload["choices"][0]["message"]["content"]
        if "```" in text:
            text = text.split("```", 2)[1]
            if text.startswith("python"):
                text = text[6:]
        return textwrap.dedent(text).strip() + "\n"
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, IndexError, TimeoutError):
        return None


def run(limit: int = 40, teacher_calls: int = 0) -> dict:
    kept: list[dict] = []
    rejected = 0
    teacher_used = 0
    logs: list[str] = []

    for task in TASKS[:limit]:
        ok, why = _exec_pair(task["code"], task["tests"])
        if ok:
            kept.append(_row(task["instruction"], task["code"], task["tests"], "seed"))
            logs.append(f"PASS seed {task['id']}")
        else:
            rejected += 1
            logs.append(f"FAIL seed {task['id']} {why}")

        for evo in EVOLUTIONS[:1]:
            evolved_instruction = task["instruction"] + " " + evo
            code = task["code"]
            if teacher_used < teacher_calls:
                gen = _teacher(
                    f"Instruction:\n{evolved_instruction}\n\nTests that must pass:\n{task['tests']}\n"
                )
                teacher_used += 1
                if gen:
                    code = gen
            ok, why = _exec_pair(code, task["tests"])
            if ok:
                kept.append(_row(evolved_instruction, code, task["tests"], "evol", task["id"]))
                logs.append(f"PASS evol {task['id']}")
            else:
                # keep the original solution under the evolved instruction only if tests still pass
                ok2, _ = _exec_pair(task["code"], task["tests"])
                if ok2:
                    kept.append(_row(evolved_instruction, task["code"], task["tests"], "evol-ref", task["id"]))
                    logs.append(f"PASS evol-ref {task['id']}")
                else:
                    rejected += 1
                    logs.append(f"FAIL evol {task['id']} {why}")

    # exact dedup
    seen: set[str] = set()
    uniq: list[dict] = []
    for r in kept:
        if r["hash"] in seen:
            continue
        seen.add(r["hash"])
        uniq.append(r)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as fh:
        for r in uniq:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    summary = {
        "ok": True,
        "dataset": str(OUT),
        "verified_rows": len(uniq),
        "rejected": rejected,
        "teacher_calls": teacher_used,
        "seeds": min(limit, len(TASKS)),
        "log": logs[-40:],
    }
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    STATUS.write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    run(teacher_calls=int(os.environ.get("MA_TEACHER_CALLS", "0")))
