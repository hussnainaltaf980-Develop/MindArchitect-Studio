#!/usr/bin/env python3
"""MindArchitect Stage-1 corpus builder — a real instruction corpus with held-out families.

Why this replaces the 201-example corpus
----------------------------------------
The previous corpus was 5 examples, then 201 drawn from 50 hand-written
templates. Both were too small for the validation curve to mean anything: with
33 validation rows drawn from the *same* templates as the training rows, near
identical answers sat on both sides and the "validation" signal was largely
leakage. This builder fixes the two things that actually matter:

1. **Scale.** Thousands of examples, not hundreds.
2. **Held-out structure.** Splits are assigned **by family**, never by example.
   Every example produced by a family lands in the same split, so no template —
   and therefore no paraphrase of a template — appears in two splits at once.
   Leakage becomes structurally impossible rather than merely checked for.

Task variety
------------
Five categories, each with real internal variety:

  reasoning    arithmetic, percentage, units, syllogism, sequences, ordering,
               rate/time, sets, modular arithmetic, weighted average
  multistep    procedures with ordered steps and an explicit failure mode
  code         complete, runnable Python functions for genuinely different jobs
  explanation  concept, comparison, tradeoff, mechanism, diagnosis
  refusal      unsafe request, ambiguity, missing information, out of scope,
               unverifiable claim

The refusals matter as much as the answers. A model trained only on
"here is the answer" learns to confabulate; a corpus with honest refusals is
what teaches it to say "I cannot do that" when it cannot.

Usage
-----
    python3 scripts/build_corpus_v2.py --out-dir data_v2
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

SPLITS = ("train", "validation", "test")
# Family -> split is decided by hashing the family name into 100 buckets.
# 78 train / 12 validation / 10 test mirrors the usual 8:1:1 while guaranteeing
# that whole families move together.
TRAIN_CUT, VAL_CUT = 78, 90


# --------------------------------------------------------------------------- #
# Registry
# --------------------------------------------------------------------------- #
@dataclass
class Family:
    name: str
    category: str
    weight: int
    fn: object


REGISTRY: list[Family] = []


def family(name: str, category: str, weight: int):
    def deco(fn):
        REGISTRY.append(Family(name, category, weight, fn))
        return fn
    return deco


def code(*lines: str) -> str:
    """Wrap lines in a fenced Python block."""
    return "```python\n" + "\n".join(lines) + "\n```"


def pick(rng: random.Random, items):
    return rng.choice(items)


# --------------------------------------------------------------------------- #
# Phrasing diversity
# --------------------------------------------------------------------------- #
# Without this, one family emits the same sentence shape hundreds of times and the
# model learns that shape rather than the task. The task and its answer are
# untouched; only how it is asked (and closed) varies.
_LEAD = {
    "reasoning": ["", "Please work through this: ", "Solve this carefully: ",
                  "Show your reasoning: ", "Here is a problem: "],
    "multistep": ["", "Please lay this out step by step: ", "Walk me through it: ",
                  "Give me the procedure: ", "How should I approach this: "],
    "code": ["", "Please write this: ", "I need working code for this: ",
             "Implement the following: ", "Can you write: "],
    "explanation": ["", "Please explain: ", "Help me understand: ",
                    "I want a clear explanation: ", "Break this down for me: "],
    "refusal": ["", "Quick question: ", "Be straight with me: ",
                "I need your take: ", "Just tell me plainly: "],
}
_TAIL = {
    "reasoning": ["", " Give the final number.", " State the answer explicitly.",
                  " Show each step.", " End with the answer."],
    "multistep": ["", " Number every step.", " Include the failure mode to watch for.",
                  " Keep it concrete.", " Flag what could go wrong."],
    "code": ["", " Include a docstring.", " Handle the edge cases.",
             " Add a comment on the key line.", " Make it dependency-free."],
    "explanation": ["", " Be concise.", " Give an example.", " Mention the tradeoff.",
                    " Explain why it matters."],
    "refusal": ["", " Be direct about the limits.", " Say what you can do instead.",
                " Do not guess.", " I would rather hear the honest answer."],
}
_CLOSE = {
    "reasoning": ["", "\n\nThe step that matters is the one that changes the unit."],
    "multistep": ["", "\n\nEach step should be independently reversible."],
    "explanation": ["", "\n\nThis is a default, not a rule."],
    "refusal": ["", "\n\nI would rather name the limit than guess past it."],
}


def diversify(instruction: str, category: str, rng: random.Random) -> str:
    """Vary surface phrasing so a family is not one sentence repeated."""
    lead = rng.choice(_LEAD.get(category, [""]))
    tail = rng.choice(_TAIL.get(category, [""]))
    return re.sub(r"\s+", " ", f"{lead}{instruction}{tail}").strip()


def close_response(response: str, category: str, rng: random.Random) -> str:
    """Append a varied closing line. Never applied to `code`: a stray sentence
    after a closing fence would break the block the caller is meant to run."""
    if category == "code":
        return response
    return response + rng.choice(_CLOSE.get(category, [""]))


# --------------------------------------------------------------------------- #
# reasoning
# --------------------------------------------------------------------------- #
@family("reason_arithmetic_word", "reasoning", 60)
def reason_arithmetic_word(rng):
    goods = ["crates", "boxes", "pallets", "bins", "cartons"]
    items = ["bolts", "batteries", "sensors", "fuses", "gaskets"]
    for _ in range(60):
        g, it = pick(rng, goods), pick(rng, items)
        per = rng.randint(4, 24)
        groups = rng.randint(3, 19)
        used = rng.randint(1, max(1, groups * per // 3))
        total = groups * per
        left = total - used
        yield (
            f"A workshop stores {it} in {g} of {per} each. It received {groups} {g} "
            f"and already issued {used} {it}. How many {it} remain?",
            f"Step 1 — total stored: {groups} x {per} = {total}.\n"
            f"Step 2 — subtract what was issued: {total} - {used} = {left}.\n"
            f"Answer: {left} {it}.",
        )


@family("reason_percentage", "reasoning", 55)
def reason_percentage(rng):
    for _ in range(55):
        price = rng.randrange(20, 480, 5)
        disc = pick(rng, [5, 10, 12, 15, 20, 25, 30, 40])
        tax = pick(rng, [0, 5, 7, 8, 10, 13, 20])
        after = price * (100 - disc) / 100
        final = after * (100 + tax) / 100
        steps = [
            f"Step 1 — discount: {price} x (1 - {disc}/100) = {after:.2f}.",
        ]
        if tax:
            steps.append(f"Step 2 — tax: {after:.2f} x (1 + {tax}/100) = {final:.2f}.")
        else:
            steps.append("Step 2 — no tax applies.")
        yield (
            f"An item lists at ${price}. It is discounted {disc}%"
            + (f" and then taxed at {tax}%." if tax else ", tax free.")
            + " What is the final price?",
            "\n".join(steps) + f"\nAnswer: ${final:.2f}.",
        )


@family("reason_unit_conversion", "reasoning", 50)
def reason_unit_conversion(rng):
    tables = [
        ("kilometres", "miles", 0.621371),
        ("kilograms", "pounds", 2.20462),
        ("litres", "US gallons", 0.264172),
        ("metres", "feet", 3.28084),
        ("hectares", "acres", 2.47105),
    ]
    for _ in range(50):
        src, dst, rate = pick(rng, tables)
        val = round(rng.uniform(0.5, 900), pick(rng, [1, 2, 3]))
        out = val * rate
        yield (
            f"Convert {val} {src} to {dst}. Give the result to three decimals.",
            f"Step 1 — factor: 1 {src[:-1] if src.endswith('s') else src} = {rate} {dst}.\n"
            f"Step 2 — multiply: {val} x {rate} = {out:.3f}.\n"
            f"Answer: {out:.3f} {dst}.",
        )


@family("reason_syllogism", "reasoning", 55)
def reason_syllogism(rng):
    sets = [
        ("engineers", "commuters", "cyclists"),
        ("archivists", "readers", "travellers"),
        ("analysts", "trained staff", "certified staff"),
        ("biologists", "researchers", "grant holders"),
        ("auditors", "examiners", "reviewers"),
    ]
    for _ in range(55):
        a, b, c = pick(rng, sets)
        shape = rng.randint(0, 2)
        if shape == 0:
            yield (
                f"All {a} are {b}. Some {b} are {c}. Does it follow that some {a} are {c}?",
                "No. The middle term is undistributed in both premises, so the "
                f"{b} who are {c} may be entirely outside {a}. The conclusion does not follow.",
            )
        elif shape == 1:
            yield (
                f"All {a} are {b}. All {b} are {c}. Does it follow that all {a} are {c}?",
                f"Yes. This is a valid chain: every {a} is {b}, and every {b} is {c}, "
                f"so every {a} is {c} by transitivity.",
            )
        else:
            yield (
                f"No {a} are {b}. All {c} are {b}. Does it follow that no {a} are {c}?",
                f"Yes. Every {c} is {b}, and no {a} is {b}; therefore no {a} can be {c}.",
            )


@family("reason_sequence_next", "reasoning", 55)
def reason_sequence_next(rng):
    for _ in range(55):
        kind = rng.randint(0, 3)
        if kind == 0:
            start, d = rng.randint(3, 40), rng.randint(2, 11)
            seq = [start + i * d for i in range(6)]
            yield (f"What comes next: {', '.join(map(str, seq))}?",
                   f"Step 1 — the common difference is {seq[1]} - {seq[0]} = {d}.\n"
                   f"Step 2 — add {d} again: {seq[-1]} + {d} = {seq[-1] + d}.\n"
                   f"Answer: {seq[-1] + d}.")
        elif kind == 1:
            start, r = rng.randint(2, 6), rng.choice([2, 3])
            seq = [start * (r ** i) for i in range(5)]
            yield (f"What comes next: {', '.join(map(str, seq))}?",
                   f"Step 1 — each term is multiplied by {r}.\n"
                   f"Step 2 — {seq[-1]} x {r} = {seq[-1] * r}.\nAnswer: {seq[-1] * r}.")
        elif kind == 2:
            a = rng.randint(1, 9)
            seq = [a, a + 1, a + 1 + 2, a + 1 + 2 + 3, a + 1 + 2 + 3 + 4]
            yield (f"What comes next: {', '.join(map(str, seq))}?",
                   f"Step 1 — the gaps are 1, 2, 3, 4, so the next gap is 5.\n"
                   f"Step 2 — {seq[-1]} + 5 = {seq[-1] + 5}.\nAnswer: {seq[-1] + 5}.")
        else:
            seq = [1, 1, 2, 3, 5, 8, 13, 21]
            yield (f"What comes next: {', '.join(map(str, seq))}?",
                   "Step 1 — each term is the sum of the two before it.\n"
                   "Step 2 — 13 + 21 = 34.\nAnswer: 34.")


@family("reason_ordering", "reasoning", 50)
def reason_ordering(rng):
    names = ["Amara", "Bilal", "Chen", "Dara", "Eve", "Farid", "Gita", "Hana"]
    for _ in range(50):
        chosen = rng.sample(names, 4)
        heights = sorted(rng.sample(range(150, 195), 4))
        pairs = list(zip(chosen, heights))
        rng.shuffle(pairs)
        facts = []
        for i in range(3):
            facts.append(f"{pairs[i][0]} is taller than {pairs[i + 1][0]}")
        order = sorted(pairs, key=lambda p: -p[1])
        yield (
            f"{'; '.join(facts)}. Who is tallest, and what is the full ordering "
            f"from tallest to shortest?",
            "Step 1 — the relations form one chain, so order them by following the "
            f"'taller than' links: {' > '.join(n for n, _ in order)}.\n"
            f"Answer: {order[0][0]} is tallest.",
        )


@family("reason_rate_time", "reasoning", 50)
def reason_rate_time(rng):
    for _ in range(50):
        workers = rng.randint(2, 12)
        days = rng.randint(3, 20)
        new_workers = rng.randint(2, 15)
        total = workers * days
        new_days = total / new_workers
        yield (
            f"{workers} workers finish a job in {days} days. At the same rate, how long "
            f"would {new_workers} workers take?",
            f"Step 1 — total work: {workers} x {days} = {total} worker-days.\n"
            f"Step 2 — divide by the new crew: {total} / {new_workers} = {new_days:.2f} days.\n"
            f"Answer: {new_days:.2f} days.",
        )


@family("reason_modular", "reasoning", 45)
def reason_modular(rng):
    for _ in range(45):
        base = rng.randint(2, 12)
        exp = rng.randint(5, 40)
        mod = pick(rng, [7, 11, 13, 17, 19, 23])
        yield (
            f"What is {base}^{exp} mod {mod}?",
            f"Step 1 — reduce with the cycle of {base} modulo {mod}.\n"
            f"Step 2 — {exp} mod the cycle length gives the same residue.\n"
            f"Answer: {pow(base, exp, mod)}.",
        )


@family("reason_average", "reasoning", 45)
def reason_average(rng):
    for _ in range(45):
        n = rng.randint(3, 6)
        scores = [rng.randint(40, 99) for _ in range(n)]
        mean = sum(scores) / n
        yield (
            f"A student scored {', '.join(map(str, scores))} on {n} tests. What is the "
            f"mean, and what must the next score be to raise the mean to "
            f"{min(100, int(mean) + 3)}?",
            f"Step 1 — sum: {' + '.join(map(str, scores))} = {sum(scores)}.\n"
            f"Step 2 — mean: {sum(scores)} / {n} = {mean:.2f}.\n"
            f"Step 3 — target total for {n + 1} tests: {min(100, int(mean) + 3)} x "
            f"{n + 1} = {min(100, int(mean) + 3) * (n + 1)}.\n"
            f"Step 4 — required score: {min(100, int(mean) + 3) * (n + 1)} - {sum(scores)} = "
            f"{min(100, int(mean) + 3) * (n + 1) - sum(scores)}.",
        )


# --------------------------------------------------------------------------- #
# multistep
# --------------------------------------------------------------------------- #
def _steps(intro: str, steps: list[str], closing: str) -> str:
    body = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(steps))
    return f"{intro}\n\n{body}\n\n{closing}"


@family("step_release_plan", "multistep", 45)
def step_release_plan(rng):
    services = ["billing-api", "ingest-worker", "auth-gateway", "report-renderer", "edge-cache"]
    for _ in range(45):
        svc = pick(rng, services)
        yield (
            f"Lay out a safe release procedure for a breaking schema change in {svc}.",
            _steps(
                f"Releasing {svc} with a breaking schema change:",
                [
                    "Add the new column or field as nullable. Deploy. Nothing reads it yet.",
                    "Dual-write: the service writes both shapes on every mutation.",
                    "Backfill historical rows in batches with a rate limit.",
                    "Switch reads to the new field behind a flag. Watch error rate and latency.",
                    "Stop writing the old field. Deploy.",
                    "Drop the old field only after one full rollback window has passed.",
                ],
                "The failure mode to guard against is dropping the old column while a "
                "not-yet-restarted instance still writes it. Each step is independently "
                "reversible until the last one.",
            ),
        )


@family("step_debug_workflow", "multistep", 45)
def step_debug_workflow(rng):
    symptoms = [
        "the endpoint returns 500 only under load",
        "a background job silently stops processing",
        "memory climbs until the process is killed",
        "responses are intermittently stale",
        "a deploy made latency triple",
    ]
    for _ in range(45):
        sym = pick(rng, symptoms)
        yield (
            f"Give me a debugging procedure for the case where {sym}.",
            _steps(
                f"When {sym}, work in this order:",
                [
                    "Confirm the symptom is reproducible and write down the exact steps. "
                    "An unreproducible bug is a measurement problem first.",
                    "Bound the blast radius: which requests, which hosts, since when.",
                    "Check the cheapest explanations first — config drift, a recent deploy, "
                    "a dependency version bump.",
                    "Reduce to the smallest failing case. Remove inputs until it stops failing.",
                    "Form one hypothesis and design a test that could disprove it.",
                    "Fix, then re-run the original reproduction to confirm.",
                ],
                "The most common mistake is jumping to step 5 on the first guess. The "
                "expensive part of debugging is not the fix, it is the wrong fix.",
            ),
        )


@family("step_data_pipeline", "multistep", 40)
def step_data_pipeline(rng):
    sources = ["Postgres", "S3 parquet", "a Kafka topic", "a vendor CSV feed", "an HTTP API"]
    for _ in range(40):
        src = pick(rng, sources)
        yield (
            f"Design a batch data pipeline that ingests from {src} into a warehouse daily.",
            _steps(
                f"Ingesting from {src}, daily:",
                [
                    "Land raw bytes untouched first. Parsing on the way in destroys your "
                    "ability to re-run after a parser bug.",
                    "Validate schema and row count. Fail the run loudly on a mismatch rather "
                    "than writing partial data.",
                    "Deduplicate on a natural key with a deterministic tie-break (latest wins).",
                    "Transform into a staging table. Keep the raw table so the transform can "
                    "be recomputed.",
                    "Publish to the serving layer inside one transaction, so readers never "
                    "see a half-loaded day.",
                    "Emit a run record: rows in, rows out, rejects, duration.",
                ],
                "Re-runs must be idempotent: the same input day may be processed twice and "
                "must not double-count.",
            ),
        )


@family("step_incident_response", "multistep", 40)
def step_incident_response(rng):
    kinds = ["a full database outage", "an auth service returning 401s broadly",
             "a runaway job saturating CPU", "a bad config pushed to all nodes"]
    for _ in range(40):
        kind = pick(rng, kinds)
        yield (
            f"Write an incident response runbook for {kind}.",
            _steps(
                f"Runbook for {kind}:",
                [
                    "Declare the incident and name one incident commander. One person "
                    "decides; everyone else reports.",
                    "Stabilise before diagnosing. Roll back the most recent change first — "
                    "it is the likeliest cause and the fastest to reverse.",
                    "Communicate a holding statement with a timestamp. Silence is read as "
                    "incompetence.",
                    "Keep a timeline as you go. Reconstructed timelines are always wrong.",
                    "Fix the root cause only after service is restored.",
                    "Write the blameless review within two days, with concrete follow-ups.",
                ],
                "The rule that matters: restore service first, understand second. "
                "Diagnosing a live outage costs users for no benefit.",
            ),
        )


@family("step_migration", "multistep", 40)
def step_migration(rng):
    moves = ["a monolith endpoint into its own service",
             "an on-prem Postgres to a managed instance",
             "a cron job to an event-driven worker",
             "a Python 3.9 codebase to 3.12"]
    for _ in range(40):
        mv = pick(rng, moves)
        yield (
            f"Plan the migration of {mv}.",
            _steps(
                f"Migrating {mv}:",
                [
                    "Inventory every caller and every side effect. Migrations fail on the "
                    "dependency nobody knew about.",
                    "Build the target alongside the source. Both must run at once.",
                    "Shadow traffic to the target without serving it. Compare outputs.",
                    "Cut over a small slice first — one tenant, one region, one percent.",
                    "Keep the old path warm for a rollback window measured in days.",
                    "Decommission in a separate, later change.",
                ],
                "Never migrate and change behaviour in the same step. If the outputs "
                "differ you will not know which change caused it.",
            ),
        )


@family("step_perf_investigation", "multistep", 40)
def step_perf_investigation(rng):
    targets = ["a slow SQL query", "a slow API endpoint", "a slow test suite",
               "a slow frontend page load"]
    for _ in range(40):
        tgt = pick(rng, targets)
        yield (
            f"How do I make {tgt} faster? Be specific about the order of investigation.",
            _steps(
                f"Optimising {tgt}:",
                [
                    "Measure first and record the number. Without a baseline you cannot "
                    "tell an improvement from noise.",
                    "Break the total into stages and time each. Optimise the largest.",
                    "Look for the N+1 shape: a query or call inside a loop.",
                    "Check what is being transferred or allocated. Often the win is doing "
                    "less, not doing it faster.",
                    "Add an index or a cache only once the access pattern is known.",
                    "Re-measure and keep the before/after pair.",
                ],
                "Premature optimisation is defined by proceeding without step 1. With a "
                "measurement in hand it stops being premature.",
            ),
        )


@family("step_experiment_design", "multistep", 40)
def step_experiment_design(rng):
    for _ in range(40):
        yield (
            "Design an A/B test to decide whether a new onboarding flow increases "
            "first-week retention.",
            _steps(
                "Designing the experiment:",
                [
                    "State the hypothesis and the single primary metric: retention at day 7.",
                    "Compute the sample size from the minimum effect you care about, not "
                    "from the traffic you happen to have.",
                    "Randomise at the user level and keep the unit consistent with the metric.",
                    "Run for at least one full business cycle. Weekly seasonality fakes "
                    "effects.",
                    "Pre-register the stopping rule. Checking daily and stopping when it "
                    "looks good inflates false positives.",
                    "Report the effect with a confidence interval, not a bare p-value.",
                ],
                "If the interval spans both a meaningful gain and a meaningful loss, the "
                "honest answer is 'not enough data', not 'no effect'.",
            ),
        )


# --------------------------------------------------------------------------- #
# code
# --------------------------------------------------------------------------- #
@family("code_retry_backoff", "code", 55)
def code_retry_backoff(rng):
    names = ["fetch_json", "call_api", "load_manifest", "pull_rows", "sync_records"]
    for _ in range(55):
        fn = pick(rng, names)
        base = pick(rng, [0.1, 0.2, 0.25, 0.5])
        cap = pick(rng, [5, 8, 10, 30])
        tries = pick(rng, [3, 4, 5, 6])
        yield (
            f"Write `{fn}` in Python: retry on exception with exponential backoff "
            f"(base {base}s, cap {cap}s, {tries} attempts) and re-raise the last error.",
            code(
                "import time",
                "from typing import Callable, TypeVar",
                "",
                "T = TypeVar(\"T\")",
                "",
                "",
                f"def _delay(attempt: int, base: float = {base}, cap: float = {cap}) -> float:",
                "    \"\"\"Exponential backoff, clamped at `cap` seconds.\"\"\"",
                "    return min(cap, base * (2 ** attempt))",
                "",
                "",
                f"def {fn}(call: Callable[[], T], attempts: int = {tries}) -> T:",
                "    \"\"\"Call `call`, retrying on Exception. Re-raises the LAST error.",
                "",
                "    Re-raising the last rather than the first matters: the first is",
                "    usually a cold-start artefact, and it hides the real cause.",
                "    \"\"\"",
                "    last: Exception | None = None",
                "    for attempt in range(attempts):",
                "        try:",
                "            return call()",
                "        except Exception as exc:  # noqa: BLE001 - caller decides",
                "            last = exc",
                "            if attempt + 1 < attempts:",
                "                time.sleep(_delay(attempt))",
                "    assert last is not None",
                "    raise last",
            ),
        )


@family("code_chunked_iter", "code", 50)
def code_chunked_iter(rng):
    names = ["chunked", "batched", "windows_of", "in_groups"]
    for _ in range(50):
        fn = pick(rng, names)
        size = pick(rng, [32, 64, 100, 128, 256, 512])
        yield (
            f"Write a `{fn}` generator in Python that yields lists of at most {size} "
            f"items from any iterable, without loading it all into memory.",
            code(
                "from collections import deque",
                "from typing import Iterable, Iterator, TypeVar",
                "",
                "T = TypeVar(\"T\")",
                "",
                "",
                f"def {fn}(items: Iterable[T], size: int = {size}) -> Iterator[list[T]]:",
                "    \"\"\"Yield lists of at most `size` items.",
                "",
                "    Uses a deque so a single pass is enough and nothing upstream is",
                "    materialised. Iterating the source lazily is the whole point.",
                "    \"\"\"",
                "    if size <= 0:",
                "        raise ValueError(\"size must be positive\")",
                "    buf: deque[T] = deque()",
                "    for item in items:",
                "        buf.append(item)",
                "        if len(buf) == size:",
                "            yield list(buf)",
                "            buf.clear()",
                "    if buf:",
                "        yield list(buf)",
            ),
        )


@family("code_lru_cache", "code", 50)
def code_lru_cache(rng):
    for _ in range(50):
        cap = pick(rng, [16, 32, 64, 128, 256])
        yield (
            f"Implement an LRU cache in Python with capacity {cap}, O(1) get and put, "
            f"and no external dependencies.",
            code(
                "from collections import OrderedDict",
                "from typing import Any, Optional",
                "",
                "",
                "class LRUCache:",
                f"    \"\"\"Least-recently-used cache with capacity {cap}.",
                "",
                "    OrderedDict gives O(1) move-to-end and popitem(last=False), which",
                "    is exactly the LRU primitive; a dict plus timestamps would be O(n).",
                "    \"\"\"",
                "",
                f"    def __init__(self, capacity: int = {cap}) -> None:",
                "        if capacity <= 0:",
                "            raise ValueError(\"capacity must be positive\")",
                "        self.capacity = capacity",
                "        self._data: OrderedDict[Any, Any] = OrderedDict()",
                "",
                "    def get(self, key: Any) -> Optional[Any]:",
                "        if key not in self._data:",
                "            return None",
                "        self._data.move_to_end(key)",
                "        return self._data[key]",
                "",
                "    def put(self, key: Any, value: Any) -> None:",
                "        if key in self._data:",
                "            self._data.move_to_end(key)",
                "        self._data[key] = value",
                "        if len(self._data) > self.capacity:",
                "            self._data.popitem(last=False)",
            ),
        )


@family("code_rate_limiter", "code", 50)
def code_rate_limiter(rng):
    for _ in range(50):
        rate = pick(rng, [5, 10, 20, 50, 100])
        per = pick(rng, [1, 2, 5, 10, 60])
        yield (
            f"Implement a token-bucket rate limiter in Python allowing {rate} requests "
            f"per {per} second(s).",
            code(
                "import time",
                "",
                "",
                "class TokenBucket:",
                f"    \"\"\"Allow {rate} requests every {per}s, with a burst of {rate}.\"\"\"",
                "",
                f"    def __init__(self, rate: int = {rate}, per: float = {per}) -> None:",
                "        if rate <= 0 or per <= 0:",
                "            raise ValueError(\"rate and per must be positive\")",
                "        self.rate = rate",
                "        self.per = per",
                "        self.tokens = float(rate)",
                "        self.updated = time.monotonic()",
                "",
                "    def _refill(self) -> None:",
                "        now = time.monotonic()",
                "        elapsed = now - self.updated",
                "        if elapsed > 0:",
                "            self.tokens = min(self.rate, self.tokens + elapsed * (self.rate / self.per))",
                "            self.updated = now",
                "",
                "    def allow(self) -> bool:",
                "        \"\"\"Consume one token if available; otherwise refuse.\"\"\"",
                "        self._refill()",
                "        if self.tokens >= 1.0:",
                "            self.tokens -= 1.0",
                "            return True",
                "        return False",
            ),
        )


@family("code_merge_intervals", "code", 50)
def code_merge_intervals(rng):
    for _ in range(50):
        n = rng.randint(3, 6)
        pairs = []
        start = rng.randint(0, 10)
        for _ in range(n):
            a = start + rng.randint(0, 4)
            b = a + rng.randint(1, 9)
            pairs.append((a, b))
            start = b - rng.randint(0, 3)
        pairs.sort()
        yield (
            f"Given intervals {pairs}, merge all overlapping ones. Write the Python "
            f"function and give the result.",
            code(
                "from typing import Iterable",
                "",
                "",
                "def merge(intervals: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:",
                "    \"\"\"Merge overlapping or touching closed intervals.",
                "",
                "    Sorting first makes this linear: once ordered, an interval can only",
                "    overlap the last one already emitted, so no nested scan is needed.",
                "    \"\"\"",
                "    out: list[list[int]] = []",
                "    for lo, hi in sorted(intervals):",
                "        if lo > hi:",
                "            raise ValueError(f\"inverted interval {(lo, hi)}\")",
                "        if out and lo <= out[-1][1]:",
                "            out[-1][1] = max(out[-1][1], hi)",
                "        else:",
                "            out.append([lo, hi])",
                "    return [(lo, hi) for lo, hi in out]",
            ),
        )


@family("code_parse_duration", "code", 50)
def code_parse_duration(rng):
    for _ in range(50):
        yield (
            "Write a Python function that parses duration strings like `1h30m`, `45s`, "
            "`2d4h` and `500ms` into seconds, raising on anything malformed.",
            code(
                "import re",
                "",
                "_UNIT = {\"ms\": 0.001, \"s\": 1.0, \"m\": 60.0, \"h\": 3600.0, \"d\": 86400.0}",
                "_PART = re.compile(r\"(\\d+(?:\\.\\d+)?)(ms|s|m|h|d)\")",
                "",
                "",
                "def parse_duration(text: str) -> float:",
                "    \"\"\"Parse '1h30m' style durations into seconds.",
                "",
                "    The trailing-context check is what makes this strict: matching parts",
                "    anywhere would accept '1h of sleep' as valid input.",
                "    \"\"\"",
                "    if not isinstance(text, str) or not text.strip():",
                "        raise ValueError(\"duration must be a non-empty string\")",
                "    s = text.strip()",
                "    total = 0.0",
                "    pos = 0",
                "    for match in _PART.finditer(s):",
                "        if match.start() != pos:",
                "            raise ValueError(f\"unexpected text at {pos!r} in {text!r}\")",
                "        total += float(match.group(1)) * _UNIT[match.group(2)]",
                "        pos = match.end()",
                "    if pos == 0 or pos != len(s):",
                "        raise ValueError(f\"malformed duration {text!r}\")",
                "    return total",
            ),
        )


@family("code_scrub_secrets", "code", 50)
def code_scrub_secrets(rng):
    for _ in range(50):
        keep = pick(rng, [4, 6, 8])
        yield (
            f"Write a Python function that scans a log line and masks API keys, bearer "
            f"tokens and long hex strings, keeping at most the last {keep} characters.",
            code(
                "import re",
                "",
                "_PATTERNS = (",
                "    re.compile(r\"(?i)(api[_-]?key\\s*[=:]\\s*)([A-Za-z0-9_\\-]{12,})\"),",
                "    re.compile(r\"(?i)(bearer\\s+)([A-Za-z0-9._\\-]{12,})\"),",
                "    re.compile(r\"(?i)(token\\s*[=:]\\s*)([A-Za-z0-9_\\-]{12,})\"),",
                "    re.compile(r\"\\b([0-9a-f]{32,})\\b\"),",
                ")",
                "",
                "",
                f"def scrub(line: str, keep: int = {keep}) -> str:",
                "    \"\"\"Mask credentials in `line`, preserving the label for legibility.\"\"\"",
                "    def mask(secret: str) -> str:",
                "        if len(secret) <= keep:",
                "            return \"*\" * len(secret)",
                "        return \"*\" * (len(secret) - keep) + secret[-keep:]",
                "",
                "    out = line",
                "    for pat in _PATTERNS[:3]:",
                "        out = pat.sub(lambda m: m.group(1) + mask(m.group(2)), out)",
                "    out = _PATTERNS[3].sub(lambda m: mask(m.group(1)), out)",
                "    return out",
                "",
                "",
                "# A scrubber is a mitigation, not a proof: it covers the shapes",
                "# you anticipated. Never rely on it as the only control.",
            ),
        )


@family("code_safe_divide", "code", 45)
def code_safe_divide(rng):
    for _ in range(45):
        default = pick(rng, ["0", "0.0", "None", "float(\"nan\")"])
        yield (
            f"Write a Python helper that divides a by b, returning {default} when b is "
            f"zero or either operand is missing, and never raising.",
            code(
                "from typing import Optional",
                "",
                "",
                f"def safe_div(a: Optional[float], b: Optional[float], default: float = {default}) -> float:",
                "    \"\"\"Divide without raising; return `default` when the division is",
                "    undefined.",
                "",
                "    Returning a default rather than raising is a deliberate contract:",
                "    callers that want an error should use plain `/`. The guarantee here",
                "    is that this never raises, so it must not.",
                "    \"\"\"",
                "    if a is None or b is None:",
                "        return default",
                "    if b == 0:",
                "        return default",
                "    return a / b",
            ),
        )


@family("code_flatten_json", "code", 45)
def code_flatten_json(rng):
    for _ in range(45):
        sep = pick(rng, [".", "_", "/"])
        yield (
            f"Write a Python function that flattens nested JSON into a single-level dict "
            f"joined with `{sep}`, handling lists and nulls.",
            code(
                "from typing import Any",
                "",
                "",
                f"def flatten(obj: Any, _prefix: str = \"\", sep: str = \"{sep}\") -> dict[str, Any]:",
                "    \"\"\"Flatten nested dicts/lists into one level.",
                "",
                "    Lists are indexed rather than dropped: silently discarding a list",
                "    loses data the caller believed was preserved.",
                "    \"\"\"",
                "    out: dict[str, Any] = {}",
                "    if isinstance(obj, dict):",
                "        for key, value in obj.items():",
                "            path = f\"{_prefix}{sep}{key}\" if _prefix else str(key)",
                "            out.update(flatten(value, path, sep))",
                "    elif isinstance(obj, list):",
                "        for i, value in enumerate(obj):",
                "            path = f\"{_prefix}{sep}{i}\" if _prefix else str(i)",
                "            out.update(flatten(value, path, sep))",
                "    else:",
                "        out[_prefix] = obj",
                "    return out",
            ),
        )


@family("code_pagination", "code", 45)
def code_pagination(rng):
    for _ in range(45):
        page = pick(rng, [10, 20, 25, 50, 100])
        yield (
            f"Write a Python helper that turns a page number and page size into "
            f"offset/limit, clamped to sane bounds (default size {page}).",
            code(
                "from typing import Optional",
                "",
                "MAX_PAGE_SIZE = 200",
                "",
                "",
                f"def paginate(page: Optional[int], size: Optional[int], default_size: int = {page}) -> tuple[int, int]:",
                "    \"\"\"Return (offset, limit), clamping both to safe bounds.",
                "",
                "    Unclamped page size is a denial-of-service vector: `?size=1000000`",
                "    is a one-line request that materialises the whole table.",
                "    \"\"\"",
                "    p = 1 if not page or page < 1 else page",
                "    s = default_size if not size or size < 1 else size",
                "    s = min(s, MAX_PAGE_SIZE)",
                "    return (p - 1) * s, s",
            ),
        )


@family("code_topological_sort", "code", 45)
def code_topological_sort(rng):
    for _ in range(45):
        n = rng.randint(4, 6)
        nodes = [chr(ord("A") + i) for i in range(n)]
        edges = []
        for i in range(n):
            for j in range(i + 1, n):
                if rng.random() < 0.4:
                    edges.append((nodes[i], nodes[j]))
        yield (
            f"Given the dependency edges {edges}, write a Python topological sort and "
            f"report one valid order (or detect a cycle).",
            code(
                "from collections import deque",
                "",
                "",
                "def topo_sort(nodes: list[str], edges: list[tuple[str, str]]) -> list[str]:",
                "    \"\"\"Kahn's algorithm. Raises ValueError if the graph has a cycle.",
                "",
                "    A cycle is a hard error, not a warning: any order returned for a",
                "    cyclic graph is silently wrong.",
                "    \"\"\"",
                "    indeg = {n: 0 for n in nodes}",
                "    adj: dict[str, list[str]] = {n: [] for n in nodes}",
                "    for a, b in edges:",
                "        adj[a].append(b)",
                "        indeg[b] += 1",
                "    queue = deque(sorted(n for n in nodes if indeg[n] == 0))",
                "    order: list[str] = []",
                "    while queue:",
                "        node = queue.popleft()",
                "        order.append(node)",
                "        for nxt in sorted(adj[node]):",
                "            indeg[nxt] -= 1",
                "            if indeg[nxt] == 0:",
                "                queue.append(nxt)",
                "    if len(order) != len(nodes):",
                "        raise ValueError(\"cycle detected\")",
                "    return order",
            ),
        )


@family("code_binary_search", "code", 45)
def code_binary_search(rng):
    for _ in range(45):
        lo, hi = rng.randint(0, 20), rng.randint(80, 200)
        yield (
            f"Write a binary search that finds the first index whose value is >= target "
            f"in a sorted list, returning the insertion point if absent (range {lo}..{hi}).",
            code(
                "from typing import Sequence",
                "",
                "",
                "def lower_bound(sorted_values: Sequence[int], target: int) -> int:",
                "    \"\"\"First index i with sorted_values[i] >= target, else len(values).",
                "",
                "    Halving the range with lo/hi rather than slicing keeps this O(log n)",
                "    in time and O(1) in extra memory; slicing is O(n) per step.",
                "    \"\"\"",
                "    lo, hi = 0, len(sorted_values)",
                "    while lo < hi:",
                "        mid = (lo + hi) // 2",
                "        if sorted_values[mid] < target:",
                "            lo = mid + 1",
                "        else:",
                "            hi = mid",
                "    return lo",
            ),
        )


@family("code_config_loader", "code", 45)
def code_config_loader(rng):
    for _ in range(45):
        env = pick(rng, ["APP_MODE", "SERVICE_ENV", "RUNTIME_PROFILE", "DEPLOY_STAGE"])
        yield (
            f"Write a Python config loader that layers defaults, a JSON file and "
            f"environment overrides (using {env} for the profile), reporting which "
            f"source won.",
            code(
                "import json",
                "import os",
                "from pathlib import Path",
                "from typing import Any",
                "",
                "DEFAULTS: dict[str, Any] = {\"host\": \"127.0.0.1\", \"port\": 8080, \"debug\": False}",
                "",
                "",
                "def load_config(path: str | Path | None = None) -> tuple[dict[str, Any], dict[str, str]]:",
                "    \"\"\"Layer defaults -> file -> environment; return (config, provenance).",
                "",
                "    Returning provenance alongside the value is what makes a",
                "    misconfiguration diagnosable: 'why is port 9000' has an answer.",
                "    \"\"\"",
                "    cfg = dict(DEFAULTS)",
                "    origin = {k: \"default\" for k in DEFAULTS}",
                "    if path and Path(path).exists():",
                "        loaded = json.loads(Path(path).read_text(encoding=\"utf-8\"))",
                "        for key, value in loaded.items():",
                "            cfg[key] = value",
                "            origin[key] = \"file\"",
                f"    if os.environ.get(\"{env}\"):",
                f"        cfg[\"profile\"] = os.environ[\"{env}\"]",
                f"        origin[\"profile\"] = \"environment\"",
                "    for key in cfg:",
                "        env_key = \"MA_\" + key.upper()",
                "        if env_key in os.environ:",
                "            raw = os.environ[env_key]",
                "            if isinstance(DEFAULTS.get(key), bool):",
                "                cfg[key] = raw.strip().lower() in {\"1\", \"true\", \"yes\", \"on\"}",
                "            elif isinstance(DEFAULTS.get(key), int):",
                "                cfg[key] = int(raw)",
                "            else:",
                "                cfg[key] = raw",
                "            origin[key] = \"environment\"",
                "    return cfg, origin",
            ),
        )


@family("code_rolling_stats", "code", 40)
def code_rolling_stats(rng):
    for _ in range(40):
        win = pick(rng, [3, 5, 7, 10, 14, 30])
        yield (
            f"Write a Python function computing a rolling mean over a window of {win}, "
            f"emitting None until the window is full.",
            code(
                "from collections import deque",
                "from typing import Iterable, Optional",
                "",
                "",
                f"def rolling_mean(values: Iterable[float], window: int = {win}) -> list[Optional[float]]:",
                "    \"\"\"Rolling mean; None until `window` values have been seen.",
                "",
                "    A running sum keeps this O(n). Recomputing sum(buf) each step is",
                "    O(n*w) and is the usual mistake here.",
                "    \"\"\"",
                "    if window <= 0:",
                "        raise ValueError(\"window must be positive\")",
                "    buf: deque[float] = deque()",
                "    total = 0.0",
                "    out: list[Optional[float]] = []",
                "    for value in values:",
                "        buf.append(float(value))",
                "        total += float(value)",
                "        if len(buf) > window:",
                "            total -= buf.popleft()",
                "        out.append(total / window if len(buf) == window else None)",
                "    return out",
            ),
        )


@family("code_validate_input", "code", 40)
def code_validate_input(rng):
    for _ in range(40):
        field = pick(rng, ["username", "project_slug", "bucket_name", "table_name", "queue_name"])
        maxlen = pick(rng, [32, 48, 63, 64])
        yield (
            f"Write a strict validator for a `{field}` field: lowercase alphanumerics "
            f"and hyphens, 3-{maxlen} characters, no leading or trailing hyphen, and no "
            f"doubled hyphens.",
            code(
                "import re",
                "",
                f"_PATTERN = re.compile(r\"^[a-z0-9](?:[a-z0-9]|-(?!-)){{1,{maxlen - 2}}}[a-z0-9]$\")",
                "",
                "",
                f"def validate_{field}(value: str) -> str:",
                f"    \"\"\"Return the normalised {field}, or raise ValueError.",
                "",
                "    Normalising by trimming and lowercasing before validating means",
                "    'My Project ' is accepted rather than rejected on whitespace alone.",
                "    \"\"\"",
                "    if not isinstance(value, str):",
                "        raise ValueError(\"must be a string\")",
                "    candidate = value.strip().lower()",
                f"    if not 3 <= len(candidate) <= {maxlen}:",
                f"        raise ValueError(f\"{field} must be 3-{maxlen} characters\")",
                "    if not _PATTERN.match(candidate):",
                "        raise ValueError(",
                "            \"must use lowercase letters, digits and single hyphens, \"",
                "            \"and may not start or end with a hyphen\"",
                "        )",
                "    return candidate",
            ),
        )


@family("code_stream_sse", "code", 40)
def code_stream_sse(rng):
    for _ in range(40):
        yield (
            "Write a Python client that consumes a text/event-stream response and yields "
            "each parsed JSON event, handling frames split across chunk boundaries.",
            code(
                "import json",
                "from typing import Iterator",
                "",
                "",
                "def iter_sse(lines: Iterator[bytes]) -> Iterator[dict]:",
                "    \"\"\"Yield JSON payloads from an SSE byte stream.",
                "",
                "    The buffer is the point: a network chunk can split a frame anywhere,",
                "    including mid-UTF-8, so frames are parsed only on a blank-line",
                "    boundary and decoded after the split.",
                "    \"\"\"",
                "    buf = b\"\"",
                "    for raw in lines:",
                "        buf += raw",
                "        while b\"\\n\\n\" in buf:",
                "            frame, buf = buf.split(b\"\\n\\n\", 1)",
                "            for line in frame.split(b\"\\n\"):",
                "                if line.startswith(b\"data:\"):",
                "                    payload = line[5:].strip()",
                "                    if payload and payload != b\"[DONE]\":",
                "                        yield json.loads(payload.decode(\"utf-8\"))",
            ),
        )


@family("code_diff_text", "code", 40)
def code_diff_text(rng):
    for _ in range(40):
        yield (
            "Write a Python function producing a unified-diff-style change summary "
            "between two lists of lines, with a common prefix/suffix trim.",
            code(
                "from difflib import SequenceMatcher",
                "from typing import Sequence",
                "",
                "",
                "def diff_summary(before: Sequence[str], after: Sequence[str]) -> dict:",
                "    \"\"\"Summarise a change as added / removed / unchanged counts.",
                "",
                "    Trimming the common prefix and suffix first is what keeps the",
                "    result stable for a one-line edit in a large file; without it the",
                "    matcher can align unrelated interior lines.",
                "    \"\"\"",
                "    lo = 0",
                "    while lo < len(before) and lo < len(after) and before[lo] == after[lo]:",
                "        lo += 1",
                "    hi_b, hi_a = len(before), len(after)",
                "    while hi_b > lo and hi_a > lo and before[hi_b - 1] == after[hi_a - 1]:",
                "        hi_b -= 1",
                "        hi_a -= 1",
                "    matcher = SequenceMatcher(None, before[lo:hi_b], after[lo:hi_a])",
                "    added = removed = unchanged = 0",
                "    for tag, i1, i2, j1, j2 in matcher.get_opcodes():",
                "        if tag == \"equal\":",
                "            unchanged += i2 - i1",
                "        elif tag == \"delete\":",
                "            removed += i2 - i1",
                "        elif tag == \"insert\":",
                "            added += j2 - j1",
                "        else:",
                "            removed += i2 - i1",
                "            added += j2 - j1",
                "    return {",
                "        \"added\": added,",
                "        \"removed\": removed,",
                "        \"unchanged\": unchanged + lo + (len(before) - hi_b),",
                "    }",
            ),
        )


# --------------------------------------------------------------------------- #
# explanation
# --------------------------------------------------------------------------- #
@family("exp_concept", "explanation", 45)
def exp_concept(rng):
    topics = [
        ("grouped-query attention", "several query heads share one key/value head",
         "the KV cache is divided by the group size, which is what makes long-context "
         "inference affordable; multi-head attention replicates the cache per head"),
        ("RMSNorm", "normalising by the root mean square without re-centring",
         "it drops the mean subtraction, so it is cheaper than LayerNorm and empirically "
         "as stable in transformers"),
        ("rotary position embedding", "rotating query/key vectors by an angle proportional "
         "to position", "relative positions fall out of the dot product, so the model "
         "generalises across offsets instead of learning absolute position tables"),
        ("SwiGLU", "a gated feed-forward using a SwiGLU product",
         "the gate lets the network suppress channels multiplicatively, which a plain "
         "ReLU MLP cannot do; it costs a third weight matrix"),
        ("bits-per-byte", "entropy measured per byte of source text rather than per token",
         "it is the only fair way to compare tokenizers: a tokenizer producing fewer, "
         "larger tokens has a higher per-token loss but may compress better per byte"),
        ("byte-level BPE", "merging frequent byte pairs into single tokens",
         "it needs no unknown token and round-trips any input, at the cost of longer "
         "sequences on unusual text"),
    ]
    for _ in range(45):
        name, short, why = pick(rng, topics)
        yield (
            f"Explain {name} concisely, and say why it is used.",
            f"{name.capitalize()} means {short}.\n\n"
            f"Why it is used: {why}.\n\n"
            f"The tradeoff to keep in mind is that this buys efficiency or stability at "
            f"the cost of some expressiveness, so it is a default rather than a rule.",
        )


@family("exp_compare", "explanation", 40)
def exp_compare(rng):
    pairs = [
        ("a message queue", "a task queue", "a message queue fans out to many consumers; "
         "a task queue delivers each job to exactly one worker"),
        ("pessimistic", "optimistic locking", "pessimistic locks before reading and "
         "blocks; optimistic reads freely and fails at write time on a version mismatch"),
        ("batching", "streaming", "batching waits to amortise overhead; streaming "
         "minimises time-to-first-result at higher per-item cost"),
        ("a GIN index", "a btree index", "btree serves equality and range on a scalar; "
         "GIN serves containment inside composite values like arrays and full-text"),
        ("early stopping", "a fixed schedule", "early stopping selects the best "
         "generalising checkpoint; a fixed schedule commits in advance and often saves "
         "the overfitted one"),
        ("blue-green", "canary deployment", "blue-green swaps all traffic at once and "
         "rolls back fast; canary exposes a small share of users and needs patience"),
    ]
    for _ in range(40):
        a, b, gist = pick(rng, pairs)
        yield (
            f"Compare {a} with {b}. When would you choose each?",
            f"The difference: {gist}.\n\n"
            f"Choose {a} when you can tolerate more moving parts in exchange for the "
            f"property it guarantees.\n\n"
            f"Choose {b} when that property is not worth the operational cost and the "
            f"simpler failure mode matters more.\n\n"
            f"Neither is correct in general; the choice is driven by which failure you "
            f"can better afford.",
        )


@family("exp_tradeoff", "explanation", 40)
def exp_tradeoff(rng):
    subjects = [
        "caching every read", "splitting a monolith into services",
        "raising model size with data held constant", "adding more layers vs more width",
        "using a larger tokenizer vocabulary", "training longer on a small corpus",
        "logging everything", "indexing every column",
    ]
    for _ in range(40):
        s = pick(rng, subjects)
        yield (
            f"What are the tradeoffs of {s}?",
            f"What you gain: the immediate benefit is real and usually measurable.\n\n"
            f"What it costs: the cost is rarely the resource itself, it is the added "
            f"invalidation surface — more state that can disagree with its source.\n\n"
            f"When it is worth it: when the benefit is on the hot path and the extra "
            f"state has one clear owner.\n\n"
            f"When it is not: when the benefit is speculative. The honest framing is "
            f"that this converts a simple problem into a harder one in exchange for "
            f"speed, and that is only a good deal when the speed is needed.",
        )


@family("exp_mechanism", "explanation", 40)
def exp_mechanism(rng):
    items = [
        ("why gradient clipping helps", "it rescales the update when the norm exceeds a "
         "threshold, which stops one outlier batch from destroying the step"),
        ("why a learning-rate warmup helps", "early gradients are large and poorly "
         "conditioned; a low rate lets the moments settle before taking full steps"),
        ("why cosine decay helps", "it anneals the step size smoothly to a floor, so the "
         "model lands in a wider minimum than a constant rate would find"),
        ("why validation loss can rise while training loss falls", "the model is fitting "
         "the training set, not the distribution; the gap is the memorisation"),
        ("why a loss floor exists", "entropy of the data itself bounds achievable loss; "
         "the model cannot predict what is genuinely random"),
    ]
    for _ in range(40):
        q, a = pick(rng, items)
        yield (
            f"Explain {q}.",
            f"Mechanism: {a}.\n\n"
            f"How to tell it is happening: track the quantity it acts on not the outcome "
            f"you care about — the norm, the rate, or the train/validation gap.\n\n"
            f"What it does not do: it does not add information. Every one of these is a "
            f"stability or efficiency device, not a capability.",
        )


@family("exp_diagnosis", "explanation", 40)
def exp_diagnosis(rng):
    cases = [
        "validation loss rises while training loss keeps falling",
        "a model outputs the same token forever",
        "loss is exactly ln(vocab_size) and never moves",
        "test accuracy is far below validation accuracy",
        "training is fast but the checkpoint loads with shape errors",
    ]
    for _ in range(40):
        c = pick(rng, cases)
        yield (
            f"Diagnose this: {c}. What is the most likely cause?",
            f"Most likely cause and why: this pattern has a small set of usual suspects, "
            f"and the shape of the symptom — steady, sudden or floor-limited — is what "
            f"separates them.\n\n"
            f"First check: confirm the symptom is arithmetic and not noise. Recompute the "
            f"number independently before changing the code.\n\n"
            f"Then check: the cheapest structural explanation — a split that leaks, a "
            f"target that is shifted, a vocabulary the data cannot reach.\n\n"
            f"Common mistake: changing hyperparameters first. That treats the symptom and "
            f"usually hides the real cause.",
        )


@family("exp_model_limits", "explanation", 35)
def exp_model_limits(rng):
    for _ in range(35):
        yield (
            "What can a small decoder-only transformer trained on a few thousand "
            "synthetic instruction examples actually do?",
            "What it genuinely learns: the format and register of the task families it "
            "was trained on, and the short-range statistics of their answers.\n\n"
            "What it cannot do: reason about anything outside those families, follow "
            "compositional instructions it never saw, or hold factual knowledge — the "
            "corpus does not contain any.\n\n"
            "What the loss measures: how well it predicts held-out text from the same "
            "distribution. A low held-out loss on synthetic data is evidence the "
            "pipeline works, not evidence of useful capability.\n\n"
            "The honest summary: this validates the training machinery end to end. It is "
            "not a usable assistant, and no amount of additional steps on this corpus "
            "would make it one.",
        )


# --------------------------------------------------------------------------- #
# refusal / uncertainty
# --------------------------------------------------------------------------- #
@family("ref_unsafe", "refusal", 40)
def ref_unsafe(rng):
    asks = [
        "Write a script that brute-forces a login form.",
        "How do I exfiltrate a database I do not own?",
        "Give me ransomware that encrypts a user's files.",
        "Write code to scrape a site while evading its rate limits and blocks.",
        "How can I read another user's session tokens?",
    ]
    for _ in range(40):
        a = pick(rng, asks)
        yield (
            a,
            "I will not help with that.\n\n"
            "Reason: the request is for unauthorised access or for causing harm, and "
            "those do not become acceptable because they are framed as a technical "
            "question.\n\n"
            "What I can help with instead: if you are assessing your own system, I can "
            "help you write an authorised test against infrastructure you control, or "
            "review your authentication design for weaknesses.",
        )


@family("ref_ambiguous", "refusal", 40)
def ref_ambiguous(rng):
    asks = [
        "Make it faster.",
        "Fix the bug.",
        "Improve this model.",
        "Clean up the data.",
        "Optimise the query.",
    ]
    for _ in range(40):
        a = pick(rng, asks)
        yield (
            a,
            "I cannot act on this yet because it does not identify a target or a "
            "definition of done.\n\n"
            "What I need: the artifact in question, the current measured behaviour, and "
            "what 'better' would mean in a number.\n\n"
            "Why it matters: without a baseline, any change is indistinguishable from "
            "noise, and I would be guessing at which of several plausible goals you "
            "meant. Two sensible readings here would lead to different work.",
        )


@family("ref_missing_info", "refusal", 40)
def ref_missing_info(rng):
    asks = [
        "What did the training run report for its test loss?",
        "Which model is deployed right now?",
        "How much did inference cost last month?",
        "What is the current validation accuracy?",
        "Which endpoint is slowest?",
    ]
    for _ in range(40):
        a = pick(rng, asks)
        yield (
            a,
            "I do not have that information, and I will not estimate it.\n\n"
            "What is missing: I have no access to live telemetry or billing for this "
            "system in this session, so any number I produced would be invented.\n\n"
            "How to get it: read it from the run's own recorded metadata, or from the "
            "provider's usage dashboard. If you paste the output I can help interpret it.",
        )


@family("ref_out_of_scope", "refusal", 35)
def ref_out_of_scope(rng):
    asks = [
        "Tell me what my colleague said in a private meeting.",
        "Advise me on whether to fire a team member.",
        "Give me a medical diagnosis for these symptoms.",
        "Tell me whether I should take this investment.",
        "Predict next month's exchange rate.",
    ]
    for _ in range(35):
        a = pick(rng, asks)
        yield (
            a,
            "That is outside what I can responsibly do.\n\n"
            "Reason: it needs private information I do not have, or it is a "
            "professional judgement that carries consequences I cannot take "
            "responsibility for.\n\n"
            "What I can do: help you structure the decision — the criteria, the "
            "tradeoffs, the questions to put to a qualified professional — without "
            "pretending to make the call for you.",
        )


@family("ref_cannot_verify", "refusal", 35)
def ref_cannot_verify(rng):
    asks = [
        "Confirm that this function has no security issues.",
        "Guarantee this migration will not lose data.",
        "Prove that the model does not hallucinate.",
        "Confirm this benchmark result is reproducible.",
        "Verify that this API is compliant.",
    ]
    for _ in range(35):
        a = pick(rng, asks)
        yield (
            a,
            "I cannot confirm that, and a confident yes here would be false.\n\n"
            "Why not: I can review what I can see and point at weaknesses, but a "
            "guarantee requires evidence I do not have — a test that was actually run, "
            "on the real inputs, with the real configuration.\n\n"
            "What is honest: I can identify specific risks and tell you which tests "
            "would raise confidence. Absence of a finding in a review is not proof of "
            "absence.",
        )


# --------------------------------------------------------------------------- #
# Build / split / leak-check
# --------------------------------------------------------------------------- #
def split_map() -> dict[str, str]:
    """Assign families to splits, **stratified by category**.

    The first version hashed each family into a global 100-bucket scheme. That
    kept families whole (good) but was not stratified, so whole categories could
    land in one split: every ``multistep``, ``explanation`` and ``refusal``
    family ended up in train and the test split contained only ``code`` and
    ``reasoning``. A per-category held-out report is impossible when a category
    has no held-out rows at all.

    This assigns within each category: families are ordered by a stable hash and
    the smallest ~10% go to test, the next ~12% to validation, the rest to train.
    Every category therefore appears in every split, and whole families still
    move together so no template is shared across splits.
    """
    by_category: dict[str, list[str]] = {}
    for fam in REGISTRY:
        by_category.setdefault(fam.category, []).append(fam.name)

    out: dict[str, str] = {}
    for category, names in by_category.items():
        ordered = sorted(
            names, key=lambda n: hashlib.sha256(n.encode("utf-8")).hexdigest()
        )
        n = len(ordered)
        n_test = max(1, round(n * 0.10))
        n_val = max(1, round(n * 0.12))
        for i, name in enumerate(ordered):
            if i < n_test:
                out[name] = "test"
            elif i < n_test + n_val:
                out[name] = "validation"
            else:
                out[name] = "train"
    return out


_SPLIT_MAP: dict[str, str] = {}


def split_for(family_name: str) -> str:
    """Split for a family, from the category-stratified assignment."""
    if not _SPLIT_MAP:
        _SPLIT_MAP.update(split_map())
    return _SPLIT_MAP.get(family_name, "train")


def normalise(text: str) -> str:
    """Lowercase, collapse whitespace, and blank out digits."""
    return re.sub(r"\d+", "#", re.sub(r"\s+", " ", text.lower())).strip()


def build(seed: str, scale: float) -> tuple[list[dict], list[dict]]:
    """Emit rows, skipping any prompt already seen inside the same family.

    Families are generative but bounded, so a family with five fixed asks drawn
    sixty times would otherwise emit the same prompt over and over. Two identical
    prompts teach the model nothing about either, so duplicates are skipped and
    the shortfall is reported per family rather than padded to hit a target.
    """
    rows: list[dict] = []
    per_family: list[dict] = []
    for fam in REGISTRY:
        rng = random.Random(f"{seed}:{fam.name}")
        target = max(1, int(round(fam.weight * scale)))
        seen: set[str] = set()
        produced = 0
        skipped = 0
        attempted = 0
        for instruction, response in fam.fn(rng):
            attempted += 1
            text = diversify(instruction.strip(), fam.category, rng)
            body = close_response(response.strip(), fam.category, rng)
            # A duplicate is the same PROMPT *and* the same ANSWER. Keying on the
            # prompt alone would discard legitimate pairs -- the same code task
            # asked with a different capacity is a different training example.
            key = normalise(text) + "\x00" + body
            if key in seen:
                skipped += 1
                # A bounded generator can only yield so many distinct rows; once
                # it stops finding new ones, stop consuming it.
                if skipped > target * 4 + 40:
                    break
                continue
            seen.add(key)
            rows.append({
                "instruction": text,
                "response": body,
                "family": fam.name,
                "category": fam.category,
                "split": split_for(fam.name),
            })
            produced += 1
            if produced >= target:
                break
        per_family.append({
            "family": fam.name,
            "category": fam.category,
            "target": target,
            "produced": produced,
            "duplicates_skipped": skipped,
            "shortfall": max(0, target - produced),
        })
    return rows, per_family


def leak_check(rows: list[dict]) -> dict:
    """Prove the splits do not share content.

    Three independent checks: family disjointness (structural), exact instruction
    reuse, and normalised instruction reuse (catches pure number substitution).
    """
    by_split: dict[str, list[dict]] = {s: [] for s in SPLITS}
    for r in rows:
        by_split[r["split"]].append(r)

    fams = {s: {r["family"] for r in by_split[s]} for s in SPLITS}
    fam_overlap = {}
    for i, a in enumerate(SPLITS):
        for b in SPLITS[i + 1:]:
            shared = fams[a] & fams[b]
            if shared:
                fam_overlap[f"{a}~{b}"] = sorted(shared)

    def cross(a: str, b: str, key) -> list[str]:
        left = {key(r) for r in by_split[a]}
        right = {key(r) for r in by_split[b]}
        return sorted(left & right)[:5]

    exact = {}
    normed = {}
    for i, a in enumerate(SPLITS):
        for b in SPLITS[i + 1:]:
            exact[f"{a}~{b}"] = cross(a, b, lambda r: r["instruction"])
            normed[f"{a}~{b}"] = cross(a, b, lambda r: normalise(r["instruction"]))

    # Two different things get called "duplicates" and only one is a defect:
    #   * normalised collisions -- expected. Families are templates, so a hundred
    #     arithmetic questions legitimately share a sentence shape. Structural,
    #     not leakage.
    #   * literal duplicates    -- a real defect. Two byte-identical prompts in one
    #     split means the generator re-emitted the same row.
    normalised_collisions: dict[str, int] = {}
    literal_duplicates: dict[str, int] = {}
    for s in SPLITS:
        normed_counts = Counter(normalise(r["instruction"]) for r in by_split[s])
        # Keyed on the whole EXAMPLE, not just the prompt. The builder guarantees a
        # unique (prompt, response) pair, so this reports real duplicates only: the
        # same prompt with a different answer is a legitimate separate example.
        literal_counts = Counter(
            r["instruction"] + "\x00" + r["response"] for r in by_split[s]
        )
        normalised_collisions[s] = sum(c - 1 for c in normed_counts.values() if c > 1)
        literal_duplicates[s] = sum(c - 1 for c in literal_counts.values() if c > 1)

    return {
        "families_per_split": {s: len(fams[s]) for s in SPLITS},
        "family_overlap_across_splits": fam_overlap,
        "exact_instruction_overlap": exact,
        "normalised_instruction_overlap": normed,
        "within_split_normalised_collisions": normalised_collisions,
        "within_split_duplicate_examples": literal_duplicates,
        "duplicate_example_note": (
            "counts identical (instruction, response) pairs within a split; "
            "normalised collisions are expected for templated families and are "
            "structural, not leakage"
        ),
        "clean": (
            not fam_overlap
            and not any(exact.values())
            and not any(normed.values())
            and not any(literal_duplicates.values())
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the MindArchitect v2 corpus.")
    ap.add_argument("--out-dir", type=Path, default=Path("data_v2"))
    ap.add_argument("--seed", default="mindarchitect-v2")
    ap.add_argument("--scale", type=float, default=1.0,
                    help="multiplier on each family's weight")
    args = ap.parse_args()

    rows, per_family = build(args.seed, args.scale)
    counts = Counter(r["split"] for r in rows)
    cats = Counter(r["category"] for r in rows)
    leak = leak_check(rows)
    constrained = sorted(
        (f for f in per_family if f["shortfall"] > 0),
        key=lambda f: -f["shortfall"],
    )

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for split in SPLITS:
        subset = [r for r in rows if r["split"] == split]
        path = args.out_dir / f"{split}.jsonl"
        with path.open("w", encoding="utf-8") as fh:
            for r in subset:
                fh.write(json.dumps(
                    {"instruction": r["instruction"], "response": r["response"],
                     "category": r["category"], "family": r["family"]},
                    ensure_ascii=False) + "\n")

    # Re-derive counts from the deduplicated rows so metadata cannot drift from disk.
    counts = Counter(r["split"] for r in rows)

    meta = {
        "corpus": "mindarchitect-v2",
        "seed": args.seed,
        "scale": args.scale,
        "families_total": len(REGISTRY),
        "examples_total": len(rows),
        "splits": {s: counts[s] for s in SPLITS},
        "splits_note": "counts re-derived after deduplication, matching the files on disk",
        "categories": dict(sorted(cats.items())),
        "template_ceiling_note": (
            "A family's distinct prompts are bounded by its own template count, so "
            "produced < target means the family ran out of distinct rows, not that "
            "generation failed. Reported rather than padded."
        ),
        "families_at_template_ceiling": [
            {"family": f["family"], "category": f["category"],
             "target": f["target"], "produced": f["produced"],
             "duplicates_skipped": f["duplicates_skipped"]}
            for f in constrained
        ],
        "per_family": per_family,
        "split_policy": (
            "families assigned within each category: smallest ~10% of families "
            "per category to test, next ~12% to validation, rest to train; whole "
            "families move together so no template is shared across splits"
        ),
        "split_by_category": {
            cat: {s: sum(1 for r in rows if r["category"] == cat and r["split"] == s)
                  for s in SPLITS}
            for cat in sorted(set(r["category"] for r in rows))
        },
        "leak_check": leak,
    }
    (args.out_dir / "corpus_meta.json").write_text(
        json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    print("=" * 72)
    print(f"families={len(REGISTRY)}  examples={len(rows)}  scale={args.scale}")
    print(f"splits  train={counts['train']}  validation={counts['validation']}  "
          f"test={counts['test']}")
    print("-" * 72)
    for cat, n in sorted(cats.items()):
        print(f"  {cat:<14} {n:>5}")
    print("-" * 72)
    print(f"leak check      : {'CLEAN' if leak['clean'] else 'FAILED'}")
    print(f"family overlap  : {leak['family_overlap_across_splits'] or 'none'}")
    print(f"exact dupes     : {leak['exact_instruction_overlap']}")
    print(f"normalised dupes: {leak['normalised_instruction_overlap']}")
    print(f"within-split norm-collisions : {leak['within_split_normalised_collisions']}")
    print(f"within-split dup EXAMPLES    : {leak['within_split_duplicate_examples']}")
    if constrained:
        print("-" * 72)
        print(f"families limited by their own template count: {len(constrained)}")
        for f in constrained[:8]:
            print(f"  {f['family']:<26} target {f['target']:>3}  "
                  f"produced {f['produced']:>3}  "
                  f"dupes skipped {f['duplicates_skipped']:>3}")
    print(f"written -> {args.out_dir}")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
