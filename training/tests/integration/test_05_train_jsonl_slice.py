"""Integration 5 — train.jsonl exists, encodes inside vocab 32004."""

from __future__ import annotations

import json
from pathlib import Path

from mindarchitect.tokenizer import ByteTokenizer

DATA = Path(__file__).resolve().parents[2] / "data" / "train.jsonl"

# The corpus stores instruction/response pairs (optionally with a "text" field
# already rendered). Both shapes are accepted so the test tracks the data rather
# than one particular serialisation of it.
def _render(row: dict) -> str:
    if isinstance(row.get("text"), str) and row["text"].strip():
        return row["text"]
    parts = ["### Instruction", str(row.get("instruction", "")).strip()]
    if row.get("input"):
        parts += ["", "### Input", str(row["input"]).strip()]
    parts += ["", "### Response", str(row.get("response", row.get("output", ""))).strip(), ""]
    return "\n".join(parts)


def test_train_jsonl_non_empty():
    assert DATA.is_file(), f"missing corpus at {DATA}"
    rows = [json.loads(l) for l in DATA.read_text().splitlines() if l.strip()]
    assert len(rows) >= 32
    assert all(_render(r).strip() for r in rows)


def test_slice_encodes_inside_vocab():
    tok = ByteTokenizer(vocab_size=32004)
    with DATA.open() as fh:
        first = _render(json.loads(next(fh)))
    ids = tok.encode(first, add_bos=True, add_eos=True)
    assert ids[0] == 1 and ids[-1] == 2
    assert max(ids) < 32004
