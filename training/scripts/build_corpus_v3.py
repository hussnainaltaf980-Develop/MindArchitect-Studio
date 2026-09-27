#!/usr/bin/env python3
"""MindArchitect v3 instruction corpus -- expands v2 by ADDING families.

WHY A SEPARATE SCRIPT RATHER THAN A BIGGER SCALE ON v2
──────────────────────────────────────────────────────
v2's ``--scale`` multiplies each family's weight, but a family is a bounded
generator: it yields a fixed, finite set of distinct (prompt, answer) pairs and
the builder stops consuming it once it stops finding new ones. The v9 run made
this visible in its own metadata -- 33 of 44 families sat at their template
ceiling, and raising ``--scale`` would only have burned CPU re-generating rows
that get skipped as duplicates.

Reachable vocabulary grows with *distinct content*, not with row count over an
unchanged template pool. So the way to move the reachable-id count is to add
NEW task shapes and NEW domains -- which is what this module does. It imports
v2's machinery (dedup, category-stratified splitting, leak checking) and appends
40 further families across the same five categories.

The split policy, the duplicate key (whole example, not prompt alone), and the
leak check are all inherited unchanged, so v3's metadata is directly comparable
with v2's.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import random
import sys
from collections import Counter
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

# Import v2 by path: its filename is not a valid module name (`build_corpus_v2`
# is, but the directory is not a package), and importing it as a module gives us
# `family`, `code`, `pick`, `build`, `leak_check` and the REGISTRY -- the exact
# behaviour we want to inherit rather than re-derive.
_SPEC = importlib.util.spec_from_file_location("_corpus_v2", _HERE / "build_corpus_v2.py")
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - the path is pinned above
    raise ImportError("cannot load build_corpus_v2.py from alongside this script")
v2 = importlib.util.module_from_spec(_SPEC)
# Registered BEFORE exec_module. `@dataclass` resolves a class's field annotations
# through `sys.modules[cls.__module__].__dict__`, so a module executed WITHOUT
# being registered crashes on its first dataclass with
# "'NoneType' object has no attribute '__dict__'" -- which is exactly how this
# failed the first time.
sys.modules["_corpus_v2"] = v2
_SPEC.loader.exec_module(v2)

# Captured at IMPORT time, before this module's own `@family` decorators run and
# append to the shared registry. Reading `len(v2.REGISTRY)` inside main() would
# instead report the combined count for both the inherited and the new families.
V2_FAMILY_COUNT = len(v2.REGISTRY)

family = v2.family
code = v2.code
pick = v2.pick
SPLITS = v2.SPLITS


def _ints(rng, lo, hi, n):
    """n distinct integers in [lo, hi]. Distinctness is what keeps a family from
    spending its budget on rows the dedup pass will discard."""
    return rng.sample(range(lo, hi + 1), min(n, hi - lo + 1))


# ═══════════════════════════════════════════════════════════════════════════ #
# reasoning -- quantitative families, each numerically verified before it is
# emitted (the stated answer is computed, never asserted)
# ═══════════════════════════════════════════════════════════════════════════ #
@family("reason_work_rate", "reasoning", 95)
def reason_work_rate(rng):
    jobs = ["painting a hall", "paving a driveway", "assembling a rig", "laying cable",
            "clearing a trail", "digging a trench", "insulating a loft"]
    names = ["Ana", "Bruno", "Chen", "Dara", "Emil", "Farah", "Gita", "Hugo", "Ines"]
    for _ in range(95):
        job, a, b = pick(rng, jobs), pick(rng, names), pick(rng, names)
        ta, tb = rng.randint(4, 26), rng.randint(4, 26)
        if a == b or ta == tb:
            continue
        together = (ta * tb) / (ta + tb)
        yield (
            f"{a} can finish {job} in {ta} hours. {b} can finish the same job in "
            f"{tb} hours. Working together, how long will it take?",
            f"Step 1 — combine the rates: 1/{ta} + 1/{tb} = {(ta + tb)}/{ta * tb} jobs per hour.\n"
            f"Step 2 — invert for the time: {ta * tb}/{ta + tb} = {together:.3f} hours.\n"
            f"Answer: {together:.3f} hours ({together * 60:.1f} minutes).",
        )


@family("reason_mixture", "reasoning", 90)
def reason_mixture(rng):
    liquids = ["antifreeze", "brine", "syrup", "solvent", "diluent"]
    for _ in range(90):
        name = pick(rng, liquids)
        v1, p1 = rng.randint(20, 400, ), rng.choice([10, 15, 20, 25, 30, 40, 50])
        v2v, p2 = rng.randint(20, 400), rng.choice([60, 70, 75, 80, 85, 90])
        total = v1 + v2v
        conc = (v1 * p1 + v2v * p2) / total
        yield (
            f"A tank holds {v1} litres of {p1}% {name}. How much {p2}% {name} must be "
            f"added to reach a target concentration, and what is the resulting "
            f"concentration if all {v2v} litres are added?",
            f"Step 1 — total solute: {v1} x {p1}/100 + {v2v} x {p2}/100 = "
            f"{(v1 * p1 / 100 + v2v * p2 / 100):.2f} litres.\n"
            f"Step 2 — total volume: {v1} + {v2v} = {total} litres.\n"
            f"Step 3 — concentration: {(v1 * p1 / 100 + v2v * p2 / 100):.2f}/{total} = "
            f"{conc:.2f}%.\nAnswer: {conc:.2f}% {name}.",
        )


@family("reason_probability", "reasoning", 90)
def reason_probability(rng):
    for _ in range(90):
        red, blue, green = rng.randint(2, 14), rng.randint(2, 14), rng.randint(0, 8)
        draw = rng.randint(2, 3)
        n = red + blue + green
        if n < draw + 1:
            continue
        p_same = 1.0
        for k in range(draw):
            p_same *= (red - k) / (n - k)
        yield (
            f"A bag holds {red} red, {blue} blue and {green} green marbles. Draw "
            f"{draw} without replacement. What is the probability that all {draw} are red?",
            f"Step 1 — first draw: {red}/{n}.\n"
            + "\n".join(
                f"Step {i + 2} — draw {i + 2}: {red - i}/{n - i}." for i in range(draw - 1)
            )
            + f"\nStep {draw + 1} — multiply along the chain: {p_same:.6f}.\n"
            f"Answer: {p_same:.6f} ({p_same * 100:.3f}%).",
        )


@family("reason_interest", "reasoning", 90)
def reason_interest(rng):
    for _ in range(90):
        principal = rng.randrange(500, 50_000, 100)
        rate = rng.choice([2.5, 3.0, 3.75, 4.0, 4.5, 5.0, 6.25, 7.5])
        years = rng.randint(2, 25)
        simple = principal * (1 + rate / 100 * years)
        compound = principal * (1 + rate / 100) ** years
        yield (
            f"${principal:,} is invested at {rate}% per year for {years} years. Compare "
            f"the simple-interest and compound-interest totals.",
            f"Step 1 — simple: {principal:,} x (1 + {rate}/100 x {years}) = {simple:,.2f}.\n"
            f"Step 2 — compound: {principal:,} x (1 + {rate}/100)^{years} = {compound:,.2f}.\n"
            f"Step 3 — difference: {compound - simple:,.2f}.\n"
            f"Answer: simple {simple:,.2f}, compound {compound:,.2f}, "
            f"advantage {compound - simple:,.2f}.",
        )


@family("reason_geometry", "reasoning", 85)
def reason_geometry(rng):
    import math

    shapes = ["cylinder", "cone", "sphere", "cuboid", "prism"]
    for _ in range(85):
        s = pick(rng, shapes)
        r, h = rng.randint(2, 30), rng.randint(3, 60)
        if s == "cylinder":
            v, f = math.pi * r * r * h, f"pi x {r}^2 x {h}"
        elif s == "cone":
            v, f = math.pi * r * r * h / 3, f"pi x {r}^2 x {h} / 3"
        elif s == "sphere":
            v, f = 4 / 3 * math.pi * r ** 3, f"4/3 x pi x {r}^3"
        elif s == "cuboid":
            v, f = r * r * h, f"{r} x {r} x {h}"
        else:
            v, f = 0.5 * r * h * r, f"1/2 x {r} x {h} x {r}"
        yield (
            f"A closed {s} has radius {r} cm and height {h} cm. Give its volume in "
            f"cubic centimetres to two decimals.",
            f"Step 1 — the formula for a {s} is {f}.\n"
            f"Step 2 — substitute: {v:.4f} before rounding.\n"
            f"Answer: {v:.2f} cm^3.",
        )


@family("reason_speed_distance", "reasoning", 85)
def reason_speed_distance(rng):
    cities = ["Northport", "Ashford", "Belmont", "Carver", "Dunwich", "Elmstead"]
    for _ in range(85):
        a, b = pick(rng, cities), pick(rng, cities)
        if a == b:
            continue
        d = rng.randint(60, 900)
        v1 = rng.randint(30, 120)
        v2 = rng.randint(30, 120)
        meet = d / (v1 + v2)
        yield (
            f"{a} and {b} are {d} km apart. A train leaves {a} at {v1} km/h and another "
            f"leaves {b} at {v2} km/h, both heading toward each other. When do they meet?",
            f"Step 1 — closing speed: {v1} + {v2} = {v1 + v2} km/h.\n"
            f"Step 2 — time: {d} / {v1 + v2} = {meet:.4f} h.\n"
            f"Step 3 — distance from {a}: {v1} x {meet:.4f} = {v1 * meet:.2f} km.\n"
            f"Answer: {meet:.4f} hours ({meet * 60:.1f} minutes).",
        )


@family("reason_bit_math", "reasoning", 90)
def reason_bit_math(rng):
    for _ in range(90):
        n = rng.randint(3, 48)
        v = rng.randint(1, 1 << min(n, 24))
        yield (
            f"With {n} bits, what is the largest unsigned integer, how many distinct "
            f"values can be represented, and what is {v} in hexadecimal and binary?",
            f"Step 1 — largest value: 2^{n} - 1 = {(1 << n) - 1:,}.\n"
            f"Step 2 — distinct values: 2^{n} = {1 << n:,}.\n"
            f"Step 3 — {v} in hex is 0x{v:X}, in binary 0b{v:b}.\n"
            f"Answer: max {(1 << n) - 1:,}, count {1 << n:,}, "
            f"{v} = 0x{v:X} = 0b{v:b}.",
        )


@family("reason_date_math", "reasoning", 85)
def reason_date_math(rng):
    import datetime

    for _ in range(85):
        y = rng.randint(1990, 2035)
        m = rng.randint(1, 12)
        d = rng.randint(1, 28)
        delta = rng.randint(-900, 900)
        start = datetime.date(y, m, d)
        end = start + datetime.timedelta(days=delta)
        yield (
            f"Starting from {start.isoformat()}, move {delta:+d} days. What is the "
            f"resulting date and which day of the week is it?",
            f"Step 1 — anchor: {start.isoformat()} ({start.strftime('%A')}).\n"
            f"Step 2 — apply the offset {delta:+d} days.\n"
            f"Answer: {end.isoformat()}, a {end.strftime('%A')} "
            f"({abs(delta)} days {'forward' if delta >= 0 else 'back'}).",
        )


@family("reason_graph_paths", "reasoning", 80)
def reason_graph_paths(rng):
    # A DAG over a small grid: count monotone lattice paths, which has a closed
    # form, so the stated answer is exact.
    import math

    for _ in range(80):
        r, c = rng.randint(2, 12), rng.randint(2, 12)
        paths = math.comb(r + c, r)
        yield (
            f"A robot on a {r + 1} by {c + 1} grid starts top-left and may move only "
            f"right or down. How many distinct routes reach the bottom-right corner?",
            f"Step 1 — every route is exactly {r} down-steps and {c} right-steps.\n"
            f"Step 2 — count the arrangements: C({r + c}, {r}) = {paths:,}.\n"
            f"Answer: {paths:,} distinct routes.",
        )


# ═══════════════════════════════════════════════════════════════════════════ #
# multistep -- procedures with ordering, failure modes and reversibility
# ═══════════════════════════════════════════════════════════════════════════ #
@family("step_ci_pipeline", "multistep", 90)
def step_ci_pipeline(rng):
    stacks = ["Node + pnpm", "Python + uv", "Go modules", "Rust + cargo", "Java + Gradle"]
    for i in range(90):
        stack = pick(rng, stacks)
        minutes = rng.randint(3, 25)
        yield (
            f"Design a CI pipeline for a {stack} service where the full test suite takes "
            f"{minutes} minutes. Lay out the stages.",
            f"Step 1 — split the suite by signal, not by duration. Fast unit tests gate "
            f"every push; the slow integration set runs once the fast set is green.\n"
            f"Step 2 — cache the dependency layer keyed on the lockfile digest, so an "
            f"unchanged lockfile skips resolution entirely.\n"
            f"Step 3 — run lint and typecheck in parallel with unit tests; they share no "
            f"state and only the slowest one determines the stage time.\n"
            f"Step 4 — make the {minutes}-minute suite a post-merge job on a schedule, not "
            f"a PR gate. A gate that slow gets bypassed, and a bypassed gate is worse than "
            f"none because it looks like coverage.\n"
            f"Failure mode to watch: an unpinned runner image, which makes 'works on my "
            f"machine' the default state.\n"
            f"Each stage must be independently re-runnable, so a flake does not force a "
            f"full replay.",
        )


@family("step_db_migration_plan", "multistep", 90)
def step_db_migration_plan(rng):
    changes = ["add a NOT NULL column", "split one table into two", "change a column type",
               "add a foreign key to a live table", "rename a heavily used table",
               "drop a column still read by an old deploy"]
    for _ in range(90):
        ch = pick(rng, changes)
        yield (
            f"We need to {ch} on a table with continuous writes. Give the migration plan.",
            f"Step 1 — expand, do not rewrite. Ship a schema that coexists with the old "
            f"one before any data changes.\n"
            f"Step 2 — backfill in bounded batches with a sleep between them, so writes "
            f"keep their lock budget. An unbounded UPDATE on a busy table is an outage.\n"
            f"Step 3 — dual-write, then read from the new shape once the backfill has "
            f"converged and the lag is zero.\n"
            f"Step 4 — contract only after every reader is on the new shape, in a separate "
            f"deploy. Dropping in the same release is what makes a rollback impossible.\n"
            f"Step 5 — rehearse the rollback on a restored copy and time it.\n"
            f"Watch for: a migration that is safe to run twice. If it is not, a retry after "
            f"a transient failure corrupts data. Every step should be independently reversible.",
        )


@family("step_incident_triage", "multistep", 85)
def step_incident_triage(rng):
    signals = ["error rate is up tenfold", "p99 latency doubled", "a queue is backing up",
               "replicas are being OOM-killed", "one region is returning 502s",
               "write throughput collapsed but reads are fine"]
    for _ in range(85):
        s = pick(rng, signals)
        yield (
            f"Alert fires: {s}. Walk me through triage in order.",
            f"Step 1 — establish blast radius before diagnosis. Which users, which routes, "
            f"and since when. This decides whether to mitigate or investigate.\n"
            f"Step 2 — if the blast radius is growing, roll back the last deploy first and "
            f"diagnose afterwards. Mitigation is not diagnosis and does not need the cause.\n"
            f"Step 3 — correlate the onset against deploy times, config changes and traffic "
            f"shifts. The timestamp is the strongest clue available.\n"
            f"Step 4 — check the dependency boundary. Half of all 'our service is broken' "
            f"is an upstream that changed.\n"
            f"Step 5 — write the timeline down as you go; memory reconstructs it wrongly.\n"
            f"Watch for: the second symptom. A flooded queue and a saturated database are "
            f"usually one cause, and treating them as two makes the fix worse.",
        )


@family("step_capacity_plan", "multistep", 85)
def step_capacity_plan(rng):
    for _ in range(85):
        rps = rng.randint(50, 20_000)
        headroom = rng.choice([1.5, 2.0, 2.5, 3.0])
        yield (
            f"Plan capacity for a service serving {rps:,} requests per second at peak, "
            f"targeting {headroom}x headroom.",
            f"Step 1 — establish the per-request cost, not the request count. Measure CPU "
            f"seconds and resident bytes per request; throughput follows from those.\n"
            f"Step 2 — size for peak x headroom: {rps:,} x {headroom} = "
            f"{int(rps * headroom):,} rps of capacity.\n"
            f"Step 3 — add the fixed floor. Every instance carries a base cost, so a small "
            f"average with a spiky peak is sized by the spike, not the average.\n"
            f"Step 4 — decide the scaling trigger on a leading indicator (queue depth, "
            f"concurrency) rather than a lagging one (CPU), or every scale-up arrives late.\n"
            f"Step 5 — state the failure mode: at the ceiling, latency degrades before "
            f"errors appear, so alert on latency first.\n"
            f"Each step is independently checkable against a load test.",
        )


@family("step_perf_investigation", "multistep", 85)
def step_perf_investigation(rng):
    symptoms = ["an endpoint got slower after a release", "startup takes 40 seconds",
                "memory grows until the process dies", "a batch job now takes all night",
                "the first request after idle is very slow"]
    for _ in range(85):
        s = pick(rng, symptoms)
        yield (
            f"Investigate: {s}. Give the ordered approach.",
            f"Step 1 — measure before changing anything. Profile the real path with real "
            f"data; an intuition about the bottleneck is wrong more often than right.\n"
            f"Step 2 — bisect the change. If it appeared after a release, compare the two "
            f"revisions on identical input rather than reasoning about the diff.\n"
            f"Step 3 — separate the candidates: allocation, lock contention, I/O wait, and "
            f"network. Each shows a different profile shape, so the shape names the cause.\n"
            f"Step 4 — fix the largest term only, then re-measure. Optimising a 5% term "
            f"while a 60% term stands is the classic wasted week.\n"
            f"Watch for: a benchmark that does not reproduce the regression. If it cannot "
            f"reproduce it, it cannot confirm the fix either. Each optimisation must be "
            f"independently measured.",
        )


@family("step_data_backfill", "multistep", 85)
def step_data_backfill(rng):
    for _ in range(85):
        mb = rng.randint(20, 900)
        yield (
            f"Backfill a derived field across {mb} million rows behind a live service. "
            f"Lay out the procedure.",
            f"Step 1 — make the job idempotent and resumable before the first run. "
            f"A backfill that cannot resume from a cursor restarts from zero on every "
            f"interruption.\n"
            f"Step 2 — bound each batch and record its high-water mark, so progress is a "
            f"row in a table rather than a number in someone's shell history.\n"
            f"Step 3 — throttle against a measured signal: replication lag or lock wait, "
            f"not a guessed sleep.\n"
            f"Step 4 — validate on a sample as it goes. A wrong formula discovered at row "
            f"{mb} million is a full replay.\n"
            f"Step 5 — reconcile at the end: counts, checksums, and a spot check of rows "
            f"written on the boundary between batches, where off-by-one errors live.\n"
            f"The failure mode to design against is spreading load across replicas without "
            f"checking they are read-only — the writes land on one node and the rest serve "
            f"stale data.",
        )


@family("step_security_review", "multistep", 80)
def step_security_review(rng):
    surfaces = ["a public file upload", "a webhook receiver", "a multi-tenant admin API",
                "an SSRF-prone URL fetcher", "a password reset flow", "a JWT session cookie"]
    for _ in range(80):
        s = pick(rng, surfaces)
        yield (
            f"Review {s} for security. Give the ordered review steps.",
            f"Step 1 — write the trust boundary down first. Everything inside it is "
            f"trusted implicitly; that assumption is where the vulnerabilities are.\n"
            f"Step 2 — enumerate the inputs crossing that boundary and check each against "
            f"its parser, not against a blocklist.\n"
            f"Step 3 — check authorisation separately from authentication. Being logged in "
            f"and being allowed are different questions and only one is usually tested.\n"
            f"Step 4 — look for the resource that is fetched or executed, since that is "
            f"where reachability turns into impact.\n"
            f"Step 5 — verify the failure path denies rather than allows.\n"
            f"Watch for: a control that is present but not enforced on every route. The "
            f"uncovered route is the vulnerability, and each control must be independently "
            f"verified to fail closed.",
        )


# ═══════════════════════════════════════════════════════════════════════════ #
# code -- new function-level tasks, each with a runnable implementation
# ═══════════════════════════════════════════════════════════════════════════ #
@family("code_json_validate", "code", 90)
def code_json_validate(rng):
    for _ in range(90):
        n = rng.randint(1, 6)
        fields = [f'"f{i}": {pick(rng, ["str", "int", "bool", "list", "dict"])}' for i in range(n)]
        yield (
            f"Write a dependency-free validator that checks a mapping for required "
            f"fields and their expected types ({', '.join(fields)}).",
            code(
                "REQUIRED = {",
                *[f"    {f.split(': ')[0]}: {f.split(': ')[1]}," for f in fields],
                "}",
                "",
                "def validate(row):",
                '    """Return (ok, errors) for one mapping."""',
                "    errors = []",
                "    for name, kind in REQUIRED.items():",
                "        if name not in row:",
                '            errors.append(f"missing field: {name}")',
                "            continue",
                "        value = row[name]",
                "        if kind == \"int\" and isinstance(value, bool):",
                '            errors.append(f"{name} is bool, expected int")',
                "            continue",
                "        if not isinstance(value, TYPES[kind]):",
                '            errors.append(f"{name} is {type(value).__name__}, expected {kind}")',
                "    return (not errors), errors",
                "",
                "TYPES = {\"str\": str, \"int\": int, \"bool\": bool, \"list\": list, \"dict\": dict}",
            ),
        )


@family("code_csv_to_json", "code", 85)
def code_csv_to_json(rng):
    for _ in range(85):
        delim = pick(rng, [",", ";", "\\t", "|"])
        yield (
            f"Write a converter that turns delimited text (delimiter {delim!r}) with a "
            f"header row into a list of dictionaries, handling quoted fields and blanks.",
            code(
                "import csv",
                "import io",
                "",
                "def rows_to_dicts(text, delimiter=\",\"):",
                '    """Parse delimited text into dicts keyed by the header row."""',
                "    reader = csv.reader(io.StringIO(text), delimiter=delimiter)",
                "    try:",
                "        header = next(reader)",
                "    except StopIteration:",
                "        return []",
                "    header = [h.strip() for h in header]",
                "    out = []",
                "    for line in reader:",
                "        if not any(field.strip() for field in line):",
                "            continue  # blank row, not a record",
                "        if len(line) < len(header):",
                "            line = line + [\"\"] * (len(header) - len(line))",
                "        out.append({k: v for k, v in zip(header, line)})",
                "    return out",
            ),
        )


@family("code_retry_jitter", "code", 85)
def code_retry_jitter(rng):
    for _ in range(85):
        base = pick(rng, [0.05, 0.1, 0.25, 0.5, 1.0])
        cap = rng.choice([5, 10, 30, 60])
        yield (
            f"Write a retry helper with exponential backoff starting at {base}s, a cap of "
            f"{cap}s, and full jitter. It must not retry a permanent failure.",
            code(
                "import random",
                "import time",
                "",
                f"BASE_DELAY = {base}",
                f"MAX_DELAY = {cap}",
                "",
                "def delay_for(attempt):",
                '    """Full jitter: uniform over [0, exponential ceiling]."""',
                "    ceiling = min(MAX_DELAY, BASE_DELAY * (2 ** attempt))",
                "    return random.uniform(0, ceiling)",
                "",
                "def retry(call, attempts=5, retry_on=(Exception,), sleep=time.sleep):",
                '    """Retry transient failures only; re-raise anything else at once."""',
                "    for attempt in range(attempts):",
                "        try:",
                "            return call()",
                "        except retry_on as err:",
                "            if attempt == attempts - 1:",
                "                raise",
                "            sleep(delay_for(attempt))",
                "    raise AssertionError(\"unreachable\")",
            ),
        )


@family("code_sliding_window", "code", 85)
def code_sliding_window(rng):
    for _ in range(85):
        k = rng.randint(2, 10)
        yield (
            f"Write a function returning the maximum sum of any {k} consecutive elements, "
            f"in O(n) time, plus the index where that window starts.",
            code(
                "def best_window(values, k):",
                '    """Maximum sum over any window of length k, and its start index."""',
                "    if k <= 0 or k > len(values):",
                "        raise ValueError(\"window must fit inside the sequence\")",
                "    running = sum(values[:k])",
                "    best_sum, best_at = running, 0",
                "    for i in range(k, len(values)):",
                "        running += values[i] - values[i - k]",
                "        if running > best_sum:",
                "            best_sum, best_at = running, i - k + 1",
                "    return best_sum, best_at",
            ),
        )


@family("code_levenshtein", "code", 85)
def code_levenshtein(rng):
    for _ in range(85):
        yield (
            "Write an edit-distance function with O(min(n, m)) memory and a full "
            "traceback of the operations, not just the count."
            if rng.random() < 0.5
            else "Write an edit-distance function that returns both the distance and the "
            "list of insert/delete/substitute operations that achieves it.",
            code(
                "def edit_ops(a, b):",
                '    """Levenshtein distance plus the operation list that achieves it."""',
                "    prev = list(range(len(b) + 1))",
                "    rows = [prev[:]]",
                "    for i, ca in enumerate(a, 1):",
                "        cur = [i]",
                "        for j, cb in enumerate(b, 1):",
                "            cur.append(min(",
                "                prev[j] + 1,        # delete",
                "                cur[j - 1] + 1,     # insert",
                "                prev[j - 1] + (ca != cb),  # keep or substitute",
                "            ))",
                "        rows.append(cur)",
                "        prev = cur",
                "    ops = []",
                "    i, j = len(a), len(b)",
                "    while i or j:",
                "        if i and j and rows[i][j] == rows[i - 1][j - 1] + (a[i - 1] != b[j - 1]):",
                "            if a[i - 1] != b[j - 1]:",
                "                ops.append((\"substitute\", i - 1, b[j - 1]))",
                "            i, j = i - 1, j - 1",
                "        elif i and rows[i][j] == rows[i - 1][j] + 1:",
                "            ops.append((\"delete\", i - 1, None))",
                "            i -= 1",
                "        else:",
                "            ops.append((\"insert\", i, b[j - 1]))",
                "            j -= 1",
                "    return rows[-1][-1], list(reversed(ops))",
            ),
        )


@family("code_topk_heap", "code", 85)
def code_topk_heap(rng):
    for _ in range(85):
        k = rng.randint(2, 50)
        yield (
            f"Write a function returning the {k} largest items from a stream using a "
            f"bounded heap, so memory stays O({k}) regardless of stream length.",
            code(
                "import heapq",
                "",
                "def top_k(stream, k):",
                '    """The k largest items, streamed; memory is O(k)."""',
                "    if k <= 0:",
                "        return []",
                "    heap = []",
                "    for item in stream:",
                "        if len(heap) < k:",
                "            heapq.heappush(heap, item)",
                "        elif item > heap[0]:",
                "            heapq.heapreplace(heap, item)",
                "    return sorted(heap, reverse=True)",
            ),
        )


@family("code_url_parse", "code", 85)
def code_url_parse(rng):
    for _ in range(85):
        yield (
            "Write a function that splits a URL into scheme, host, port, path, query and "
            "fragment, applying the scheme's default port when none is given.",
            code(
                "from urllib.parse import urlsplit, parse_qsl",
                "",
                "DEFAULT_PORTS = {\"http\": 80, \"https\": 443, \"ftp\": 21, \"ws\": 80, \"wss\": 443}",
                "",
                "def dissect(url):",
                '    """Structured view of a URL with the default port resolved."""',
                "    parts = urlsplit(url)",
                "    scheme = parts.scheme.lower()",
                "    if not scheme or not parts.netloc:",
                "        raise ValueError(\"absolute URL with a scheme and host is required\")",
                "    return {",
                "        \"scheme\": scheme,",
                "        \"host\": parts.hostname,",
                "        \"port\": parts.port or DEFAULT_PORTS.get(scheme),",
                "        \"path\": parts.path or \"/\",",
                "        \"query\": dict(parse_qsl(parts.query, keep_blank_values=True)),",
                "        \"fragment\": parts.fragment,",
                "    }",
            ),
        )


@family("code_roman", "code", 85)
def code_roman(rng):
    for _ in range(85):
        n = rng.randint(1, 3999)
        vals = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
                (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]
        rem, out = n, []
        for v, sym in vals:
            while rem >= v:
                out.append(sym)
                rem -= v
        yield (
            f"Write a function converting an integer to Roman numerals and back, and "
            f"state what {n} is in Roman numerals.",
            code(
                "PAIRS = [",
                *[f"    ({v}, \"{s}\")," for v, s in vals],
                "]",
                "",
                "def to_roman(value):",
                '    """Integer to Roman numerals, for 1 <= value <= 3999."""',
                "    if not 0 < value < 4000:",
                "        raise ValueError(\"Roman numerals cover 1..3999\")",
                "    out = []",
                "    for size, symbol in PAIRS:",
                "        while value >= size:",
                "            out.append(symbol)",
                "            value -= size",
                "    return \"\".join(out)",
                "",
                "def from_roman(text):",
                '    """Roman numerals back to an integer, by left-to-right subtraction."""',
                "    index = {symbol: size for size, symbol in PAIRS}",
                "    total, prev = 0, 0",
                "    for char in reversed(text.upper()):",
                "        size = index[char]",
                "        total += -size if size < prev else size",
                "        prev = size",
                "    return total",
            )
            + f"\n\n{str(n)} in Roman numerals is {''.join(out)}.",
        )


@family("code_matrix", "code", 85)
def code_matrix(rng):
    for _ in range(85):
        r, c = rng.randint(2, 6), rng.randint(2, 6)
        yield (
            f"Write matrix multiplication and transposition for a {r}x{c} matrix without "
            f"external libraries, and note the complexity of each.",
            code(
                "def transpose(matrix):",
                '    """Rows become columns. O(r x c) time and space."""',
                "    if not matrix:",
                "        return []",
                "    return [list(row) for row in zip(*matrix)]",
                "",
                "def matmul(a, b):",
                '    """Standard triple loop. O(r x k x c) time."""',
                "    if len(a[0]) != len(b):",
                "        raise ValueError(\"inner dimensions must agree\")",
                "    bt = transpose(b)",
                "    return [[sum(x * y for x, y in zip(row, col)) for col in bt] for row in a]",
            ),
        )


@family("code_word_wrap", "code", 85)
def code_word_wrap(rng):
    for _ in range(85):
        width = rng.randint(20, 100)
        yield (
            f"Write a greedy word-wrap that breaks text to {width} columns without "
            f"splitting a word, and reports any word that cannot fit.",
            code(
                f"DEFAULT_WIDTH = {width}",
                "",
                "def wrap(text, width=DEFAULT_WIDTH):",
                '    """Greedy wrap. Returns (lines, oversized_words)."""',
                "    if width <= 0:",
                "        raise ValueError(\"width must be positive\")",
                "    lines, oversized = [], []",
                "    current = \"\"",
                "    for word in text.split():",
                "        if len(word) > width:",
                "            oversized.append(word)",
                "        if not current:",
                "            current = word",
                "        elif len(current) + 1 + len(word) <= width:",
                "            current = current + \" \" + word",
                "        else:",
                "            lines.append(current)",
                "            current = word",
                "    if current:",
                "        lines.append(current)",
                "    return lines, oversized",
            ),
        )


@family("code_config_merge", "code", 85)
def code_config_merge(rng):
    for _ in range(85):
        depth = rng.randint(2, 5)
        yield (
            f"Write a deep-merge for config mappings ({depth} levels) where lists replace "
            f"rather than concatenate, and null explicitly clears a key.",
            code(
                "def deep_merge(base, overlay):",
                '    """Recursive merge: dicts merge, everything else replaces."""',
                "    out = dict(base)",
                "    for key, value in overlay.items():",
                "        if value is None:",
                "            out.pop(key, None)   # explicit null clears",
                "        elif isinstance(value, dict) and isinstance(out.get(key), dict):",
                "            out[key] = deep_merge(out[key], value)",
                "        else:",
                "            out[key] = value     # lists replace, they do not extend",
                "    return out",
            ),
        )


@family("code_cron_parse", "code", 80)
def code_cron_parse(rng):
    for _ in range(80):
        field = pick(rng, ["minute", "hour", "day of month", "month", "day of week"])
        spec = pick(rng, ["*/5", "0", "1-5", "0,15,30,45", "6-18/2", "*"])
        yield (
            f"Write a parser for a single cron field ({field}) supporting *, ranges, "
            f"steps and lists, then explain what {spec!r} means.",
            code(
                "def parse_field(expr, low, high):",
                '    """Expand one cron field into the set of values it matches."""',
                "    values = set()",
                "    for part in expr.split(\",\"):",
                "        step = 1",
                "        if \"/\" in part:",
                "            part, _, raw_step = part.partition(\"/\")",
                "            step = int(raw_step)",
                "            if step <= 0:",
                "                raise ValueError(\"step must be positive\")",
                "        if part == \"*\":",
                "            start, end = low, high",
                "        elif \"-\" in part:",
                "            lo, _, hi = part.partition(\"-\")",
                "            start, end = int(lo), int(hi)",
                "        else:",
                "            start = end = int(part)",
                "        if not (low <= start <= end <= high):",
                "            raise ValueError(\"field value out of range\")",
                "        values.update(range(start, end + 1, step))",
                "    return values",
            ),
        )


# ═══════════════════════════════════════════════════════════════════════════ #
# explanation -- mechanism and comparison, with the tradeoff named
# ═══════════════════════════════════════════════════════════════════════════ #
@family("exp_cap_theorem", "explanation", 80)
def exp_cap_theorem(rng):
    topics = [
        ("a distributed system cannot have consistency, availability and partition "
         "tolerance at once", "you get to choose which two you keep during a partition, "
         "and the partition is not optional"),
        ("a state machine replicated by consensus needs a quorum", "any two majorities "
         "overlap, so a decision cannot be made twice for the same slot"),
        ("a cache cannot be both strongly consistent and always fast", "the fast copy is "
         "a copy, and a copy can be stale; consistency costs a round trip"),
        ("a sort cannot be faster than its comparison bound", "comparison sorts learn "
         "O(1) bits per comparison, so O(n log n) comparisons are the information floor"),
        ("backpressure is required wherever a producer can outrun a consumer", "buffers "
         "only move the failure from latency to memory, and memory is finite"),
        ("a distributed counter cannot be both available and exactly consistent",
         "concurrent increments on different nodes cannot both be observed without "
         "communication"),
    ]
    for _ in range(80):
        what, why = pick(rng, topics)
        yield (
            f"Explain why {what}.",
            f"Mechanism: {why}. The constraint follows from the communication pattern, "
            f"not from any particular implementation, which is why no amount of "
            f"engineering removes it.\n\n"
            f"What people get wrong: treating it as a bug to fix. It is a boundary to "
            f"choose against, and the choice should be made explicitly and written down.\n\n"
            f"How to tell which side you are on: measure what happens during the "
            f"unavailable case. Whatever degrades first names the property you gave up.\n\n"
            f"Each of these is a default framing, not a rule — the useful step is "
            f"deciding where you stand on it.",
        )


@family("exp_index_types", "explanation", 80)
def exp_index_types(rng):
    kinds = [
        ("B-tree", "ordered, supports range scans and equality, and stays balanced under "
                   "writes at O(log n)"),
        ("hash", "equality only, O(1) lookup, and useless for a range predicate"),
        ("GIN", "inverted over composite values, which is what makes array and full-text "
                "search possible at all"),
        ("GiST", "a tree over a lossy predicate — right for geometry and nearest-neighbour "
                 "on spatial types"),
        ("BRIN", "a summary per block range, tiny and cheap, and only useful when the "
                 "column is naturally clustered"),
        ("partial", "an index over a predicate, so it stays small and only helps the "
                    "queries matching that predicate"),
    ]
    for _ in range(80):
        name, why = pick(rng, kinds)
        yield (
            f"Explain when a {name} index is the right choice and when it is not.",
            f"What it is: {name} — {why}.\n\n"
            f"When it wins: the predicate shape matches the index structure. An index "
            f"only helps if the query's access pattern is the one it was built for.\n\n"
            f"When it loses: writes pay for every index, so an unused index is pure cost. "
            f"Check the usage statistics before adding another one.\n\n"
            f"The tradeoff to state plainly: indexes convert write throughput into read "
            f"latency. There is no version of this that is free.\n\n"
            f"This is a default, not a rule.",
        )


@family("exp_cache_strategy", "explanation", 80)
def exp_cache_strategy(rng):
    policies = [
        ("write-through", "the write waits for both the cache and the store, so "
                          "consistency is immediate and write latency doubles"),
        ("write-back", "the write lands in the cache and reaches the store later, so "
                       "writes are fast and a crash can lose the tail"),
        ("read-through", "a miss populates the cache, which keeps the read path simple "
                         "and makes a cold miss expensive"),
        ("TTL-only", "entries expire on a clock rather than on a change, which is simple "
                     "and bounded in staleness but never correct at the boundary"),
        ("explicit invalidation", "the writer removes the entry, which is precise when "
                                 "every writer cooperates and silently wrong when one "
                                 "forgets"),
    ]
    for _ in range(80):
        name, why = pick(rng, policies)
        yield (
            f"Explain the {name} cache policy and the failure mode it invites.",
            f"Mechanism: {why}.\n\n"
            f"The failure mode: staleness that is invisible in testing because the test "
            f"never writes from a second path. Any cache that can serve a value no longer "
            f"in the store is a correctness question, not a performance one.\n\n"
            f"How to bound it: state the maximum acceptable staleness as a number and "
            f"pick the policy that provably meets it.\n\n"
            f"What it does not do: it does not make the underlying operation cheaper, "
            f"only less frequent. The tradeoff is that you have moved the cost, not removed it.",
        )


@family("exp_queue_semantics", "explanation", 80)
def exp_queue_semantics(rng):
    topics = [
        ("at-most-once delivery", "the message is sent and forgotten, so loss is silent "
                                  "and duplication is impossible"),
        ("at-least-once delivery", "the consumer acknowledges after processing, so loss "
                                   "requires a consumer that never dies and duplication "
                                   "is expected"),
        ("exactly-once delivery", "it does not exist end to end; what exists is "
                                  "at-least-once plus an idempotent consumer"),
        ("a dead-letter queue", "it holds messages that failed repeatedly, which stops "
                                "one poison message from blocking a partition forever"),
        ("ordering guarantees", "they hold per partition, not per topic, which is why "
                                "partition key choice determines what order you get"),
        ("a visibility timeout", "it hides an in-flight message so another worker does "
                                 "not take it, and it is a guess about processing time"),
    ]
    for _ in range(80):
        name, why = pick(rng, topics)
        yield (
            f"Explain {name} and what it means for the consumer.",
            f"Definition: {why}.\n\n"
            f"Consequence: the consumer's contract changes with the delivery guarantee, "
            f"and idempotency is what makes the usual choice safe. A consumer that cannot "
            f"be safely run twice cannot be used with at-least-once.\n\n"
            f"The design question to answer first: what should happen when this message "
            f"is processed twice? If the answer is 'nothing bad', the rest follows.\n\n"
            f"This is a default framing, not a rule.",
        )


@family("exp_http_semantics", "explanation", 80)
def exp_http_semantics(rng):
    topics = [
        ("why 401 and 403 are different", "401 means the request lacked valid credentials "
                                          "and retrying with them could succeed; 403 "
                                          "means the identity is known and refused"),
        ("why 429 needs a Retry-After header", "the client cannot distinguish a throttle "
                                                "from an outage without being told when "
                                                "to come back"),
        ("why POST is not idempotent but PUT is", "PUT replaces the resource at a known "
                                                  "URI, so repeating it is a no-op; POST "
                                                  "appends and repeating it appends twice"),
        ("why caching a 200 with a query string fails", "the cache key includes the query, "
                                                        "so personal data behind a shared "
                                                        "key is served to the wrong user"),
        ("why a 5xx should not be retried blindly", "some are permanent, and a retry storm "
                                                    "against a failing dependency turns "
                                                    "a brownout into an outage"),
        ("why HEAD and GET must agree", "a HEAD that reports different metadata makes "
                                        "every conditional request unreliable"),
    ]
    for _ in range(80):
        name, why = pick(rng, topics)
        yield (
            f"Explain {name}.",
            f"Reason: {why}.\n\n"
            f"Why it matters in practice: each of these is a contract the client relies "
            f"on, and breaking it produces behaviour that looks like a client bug.\n\n"
            f"Where to enforce it: at the boundary, so every handler inherits the rule "
            f"rather than each one re-implementing it slightly differently.\n\n"
            f"The tradeoff: strict semantics cost some convenience, and the convenience "
            f"is what creates the ambiguity later. This is a default, not a rule.",
        )


@family("exp_numeric_precision", "explanation", 80)
def exp_numeric_precision(rng):
    topics = [
        ("0.1 + 0.2 is not exactly 0.3", "binary floating point cannot represent most "
                                         "decimal fractions exactly, so the sum lands on "
                                         "the nearest representable value"),
        ("money should not be a float", "binary fractions cannot represent cents exactly, "
                                        "so rounding error accumulates and a cent goes "
                                        "missing across a batch"),
        ("a float comparison needs a tolerance", "two computations that are algebraically "
                                                  "equal produce different bits, so "
                                                  "equality is the wrong test"),
        ("large integers lose precision in a float", "the mantissa has 53 bits, so above "
                                                     "2^53 consecutive integers are no "
                                                     "longer separable"),
        ("float32 training needs loss scaling", "small gradients underflow to zero in "
                                                "half precision, so scaling keeps them "
                                                "representable"),
        ("a running sum of many small values drifts", "each addition rounds, and the "
                                                      "errors are biased in one direction"),
    ]
    for _ in range(80):
        name, why = pick(rng, topics)
        yield (
            f"Explain why {name}.",
            f"Mechanism: {why}.\n\n"
            f"The fix: choose the representation that matches the requirement — a decimal "
            f"type for money, an integer count for exact quantities, a tolerance for "
            f"physical measurements. The bug is almost never the arithmetic; it is the "
            f"representation choice.\n\n"
            f"How to detect it: compare against an independently computed exact result "
            f"rather than against another float.\n\n"
            f"What it does not mean: floating point is not broken. It is exact for what "
            f"it is defined on, which is a different set than what people assume.",
        )


@family("exp_observability", "explanation", 80)
def exp_observability(rng):
    topics = [
        ("logs, metrics and traces answer different questions", "logs explain one event, "
                                                                 "metrics show a trend, and "
                                                                 "traces show where time went"),
        ("a p99 latency hides the shape of the distribution", "the average and the tail "
                                                              "can move in opposite "
                                                              "directions"),
        ("an alert must be actionable", "a symptom-only alert trains people to ignore it, "
                                        "and an ignored alert is worse than none"),
        ("cardinality is what breaks a metrics system", "a label with unbounded values "
                                                        "creates a series per user and "
                                                        "exhausts the index"),
        ("sampling changes what a trace can tell you", "a sampled trace cannot reconstruct "
                                                       "a rare path reliably"),
        ("a dashboard is not a detection mechanism", "nobody watches a dashboard during an "
                                                     "incident; the alert is what fires"),
    ]
    for _ in range(80):
        name, why = pick(rng, topics)
        yield (
            f"Explain why {name}.",
            f"The point: {why}.\n\n"
            f"Practical consequence: choose the signal by the question you will ask during "
            f"an incident, not by what is easy to emit. Otherwise the data exists and "
            f"cannot answer the thing you need.\n\n"
            f"The tradeoff: observability costs storage and money, so the discipline is "
            f"deciding what to keep at full fidelity and what to aggregate.\n\n"
            f"This is a default, not a rule.",
        )


# ═══════════════════════════════════════════════════════════════════════════ #
# refusal / uncertainty -- the honest non-answer, which is a capability
# ═══════════════════════════════════════════════════════════════════════════ #
@family("ref_legal_advice", "refusal", 80)
def ref_legal_advice(rng):
    asks = ["Is this contract clause enforceable in my jurisdiction?",
            "Can I be sued for republishing an API response?",
            "Does my privacy policy need updating for this data?",
            "Is this non-compete still valid?",
            "Do I need to register as a data controller?",
            "Can I use this dataset for training commercially?"]
    for _ in range(80):
        q = pick(rng, asks)
        yield (
            q,
            "I cannot answer that as advice. Legal questions turn on jurisdiction, the "
            "exact wording, the date, and facts about your situation that are not in "
            "front of me — and a confident-sounding answer to the wrong jurisdiction is "
            "worse than no answer, because it is acted on.\n\n"
            "What I can do: summarise the general shape of the question, point at the "
            "kind of source that governs it, and list the facts a lawyer would ask you "
            "for first.\n\n"
            "What you should do: take it to someone licensed in your jurisdiction. I "
            "would rather name the limit than guess past it.",
        )


@family("ref_medical_advice", "refusal", 80)
def ref_medical_advice(rng):
    asks = ["Is this rash something to worry about?",
            "What dose should I take?",
            "Can I stop this prescription early?",
            "Do these two supplements interact?",
            "Should I go to the emergency room?",
            "What does this lab result mean for me?"]
    for _ in range(80):
        q = pick(rng, asks)
        yield (
            q,
            "I am not able to answer that, and I want to be direct about why: it needs "
            "your history, your other medications and an examination, none of which I "
            "have. Guessing here is the one kind of error that can cause real harm.\n\n"
            "If this is urgent — chest pain, difficulty breathing, sudden weakness, a "
            "reaction that is spreading — treat it as urgent and get help now rather "
            "than reading further.\n\n"
            "What I can do: explain the general mechanism in plain terms and help you "
            "write down the questions to ask your clinician, so the appointment is more "
            "useful. I would rather name the limit than guess past it.",
        )


@family("ref_financial_prediction", "refusal", 80)
def ref_financial_prediction(rng):
    asks = ["Will this stock go up next quarter?",
            "Is now a good time to buy a house?",
            "What will the exchange rate be in six months?",
            "Should I put my savings in this fund?",
            "Is this a bubble that will pop?",
            "Will interest rates fall next year?"]
    for _ in range(80):
        q = pick(rng, asks)
        yield (
            q,
            "I cannot predict that, and nobody can do it reliably — if someone claims "
            "they can, that claim is the thing to be sceptical of. Prices already "
            "reflect what is publicly known; the part that moves them next is, by "
            "construction, not yet known.\n\n"
            "What I can do: lay out the factors that drive the outcome, show what would "
            "have to be true for each scenario, and explain the risks on both sides. "
            "That is analysis, which is useful, rather than a forecast, which is a guess "
            "with a number attached.\n\n"
            "For a decision about your own money, a licensed adviser who knows your "
            "situation is the right source. I would rather name the limit than guess past it.",
        )


@family("ref_stale_knowledge", "refusal", 80)
def ref_stale_knowledge(rng):
    subjects = ["the current price of a cloud instance",
                "the latest stable version of a library",
                "who holds a particular public office",
                "this week's release notes",
                "the current rate limit of an API",
                "whether a specific outage is ongoing"]
    for _ in range(80):
        s = pick(rng, subjects)
        yield (
            f"What is {s}?",
            f"I do not know that with confidence, because {s} changes over time and I "
            f"have no live connection to a source for it. Anything I produced from "
            f"memory would be a snapshot presented as current, which is the failure "
            f"mode worth avoiding.\n\n"
            "What I can do: tell you where the authoritative source is, explain how to "
            "read it, and interpret whatever you paste back to me.\n\n"
            "If you can share the current value, I will work with it directly. I would "
            "rather name the limit than guess past it.",
        )


@family("ref_incomplete_spec", "refusal", 80)
def ref_incomplete_spec(rng):
    specs = ["build the API", "make the dashboard faster", "add authentication",
             "fix the performance problem", "migrate the database", "improve the tests",
             "set up monitoring"]
    for _ in range(80):
        s = pick(rng, specs)
        yield (
            f"Can you {s}?",
            f"Yes, but not from this — '{s}' does not yet identify something buildable, "
            f"and starting anyway means inventing requirements and presenting them as "
            f"yours.\n\n"
            "What I need to know:\n"
            "1. What is the input, and what should the output be?\n"
            "2. What already exists that this must fit into?\n"
            "3. What is the constraint that decides success — latency, correctness, "
            "cost, or deadline?\n"
            "4. What must explicitly not change?\n\n"
            "Answer those and I will start; or say 'pick sensible defaults and show me', "
            "and I will choose, state each choice, and mark the ones worth revisiting.",
        )


@family("ref_no_access", "refusal", 80)
def ref_no_access(rng):
    things = ["the production database", "your local filesystem",
              "the company Slack", "your email inbox", "the internal wiki",
              "the deployment logs"]
    for _ in range(80):
        t = pick(rng, things)
        yield (
            f"Can you look at {t} and tell me what is wrong?",
            f"No — I have no access to {t} from here, and I am not going to describe "
            f"what it contains as though I had read it. An invented diagnosis of a "
            f"system I never touched is worse than no diagnosis, because it is "
            f"plausible enough to act on.\n\n"
            "What I can do: give you the exact command or query to run, explain what "
            "each result would mean, and then interpret the output when you paste it "
            "back. That keeps the evidence real.\n\n"
            "I would rather name the limit than guess past it.",
        )


@family("ref_ambiguous_scope", "refusal", 80)
def ref_ambiguous_scope(rng):
    pairs = [
        ("delete the old records", "old means a timestamp, a status, or a table name"),
        ("make it secure", "which threat model, against whom"),
        ("clean up the codebase", "formatting, dead code, or structure"),
        ("optimise the query", "latency, throughput, or cost"),
        ("add caching", "which layer, and what staleness is acceptable"),
    ]
    for _ in range(80):
        ask, ambiguity = pick(rng, pairs)
        yield (
            f"Please {ask}.",
            f"Before I touch anything: '{ask}' is ambiguous in a way that changes the "
            f"outcome — {ambiguity}. Picking for you here would be me choosing, not you, "
            f"and the difference would only surface after the change.\n\n"
            "Confirm the reading you want and I will proceed. If you would rather not "
            "choose, I will take the most conservative reading, state it explicitly in "
            "the response, and list the interpretations I rejected so you can correct "
            "me cheaply.\n\n"
            "I would rather ask than guess past it.",
        )


# ═══════════════════════════════════════════════════════════════════════════ #
# Build
# ═══════════════════════════════════════════════════════════════════════════ #
def main() -> int:
    ap = argparse.ArgumentParser(description="Build the MindArchitect v3 corpus (v2 + 40 families).")
    ap.add_argument("--out-dir", type=Path, default=Path("data_v3"))
    ap.add_argument("--seed", default="mindarchitect-v3")
    ap.add_argument("--scale", type=float, default=1.0,
                    help="multiplier on each family's weight (v2 and v3 families alike)")
    ap.add_argument("--v2-scale", type=float, default=1.0,
                    help="multiplier applied to the inherited v2 families only")
    args = ap.parse_args()

    n_v2 = V2_FAMILY_COUNT
    # v3 families are appended to the SAME registry, so v2's category-stratified
    # splitter sees them and the leak check covers them.
    n_v3 = len(v2.REGISTRY) - n_v2
    limits_v2 = [(f.name, f.weight) for f in v2.REGISTRY[:n_v2]]
    for i, (name, weight) in enumerate(limits_v2):
        v2.REGISTRY[i].weight = max(1, int(round(weight * args.v2_scale)))

    rows, per_family = v2.build(args.seed, args.scale)
    leak = v2.leak_check(rows)
    counts = Counter(r["split"] for r in rows)
    cats = Counter(r["category"] for r in rows)
    fams = Counter(f["category"] for f in per_family)
    constrained = sorted((f for f in per_family if f["shortfall"] > 0),
                         key=lambda f: -f["shortfall"])

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for split in SPLITS:
        subset = [r for r in rows if r["split"] == split]
        with (args.out_dir / f"{split}.jsonl").open("w", encoding="utf-8") as fh:
            for r in subset:
                fh.write(json.dumps(
                    {"instruction": r["instruction"], "response": r["response"],
                     "category": r["category"], "family": r["family"]},
                    ensure_ascii=False) + "\n")

    meta = {
        "corpus": "mindarchitect-v3",
        "seed": args.seed,
        "scale": args.scale,
        "v2_scale": args.v2_scale,
        "derivation": "v2 families (weights scaled) + 40 new v3 families, one registry",
        "families_total": len(v2.REGISTRY),
        "families_inherited": n_v2,
        "families_v3": n_v3,
        "families_per_category": dict(sorted(fams.items())),
        "examples_total": len(rows),
        "splits": {s: counts[s] for s in SPLITS},
        "categories": dict(sorted(cats.items())),
        "families_at_template_ceiling": [
            {"family": f["family"], "category": f["category"], "target": f["target"],
             "produced": f["produced"], "duplicates_skipped": f["duplicates_skipped"]}
            for f in constrained
        ],
        "families_with_headroom": sum(1 for f in per_family if f["shortfall"] == 0),
        "per_family": per_family,
        "split_policy": (
            "families assigned within each category: smallest ~10% of families per "
            "category to test, next ~12% to validation, rest to train; whole families "
            "move together so no template is shared across splits"
        ),
        "split_by_category": {
            cat: {s: sum(1 for r in rows if r["category"] == cat and r["split"] == s)
                  for s in SPLITS}
            for cat in sorted(set(r["category"] for r in rows))
        },
        "leak_check": leak,
    }
    (args.out_dir / "corpus_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    print("=" * 72)
    print(f"families={len(v2.REGISTRY)} ({n_v2} inherited + {len(v2.REGISTRY) - n_v2} new)"
          f"  examples={len(rows)}  scale={args.scale}")
    print(f"splits  train={counts['train']}  validation={counts['validation']}  test={counts['test']}")
    print("-" * 72)
    for cat, n in sorted(cats.items()):
        print(f"  {cat:<14} {n:>6}   ({fams[cat]} families)")
    print("-" * 72)
    print(f"leak check      : {'CLEAN' if leak['clean'] else 'FAILED'}")
    print(f"family overlap  : {leak['family_overlap_across_splits'] or 'none'}")
    print(f"dup examples    : {leak['within_split_duplicate_examples']}")
    print(f"families at ceiling: {len(constrained)} of {len(per_family)}")
    print(f"meta -> {args.out_dir / 'corpus_meta.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
