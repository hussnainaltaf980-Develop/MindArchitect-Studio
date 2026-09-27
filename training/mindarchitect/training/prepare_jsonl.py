"""Turn Code Alpaca JSON into the smoke train.jsonl slice."""

from __future__ import annotations

import json
from pathlib import Path


def record_to_text(row: dict) -> str:
    inst = str(row.get("instruction") or "").strip()
    inp = str(row.get("input") or "").strip()
    out = str(row.get("output") or "").strip()
    parts = [f"### Instruction\n{inst}"]
    if inp and inp not in {"< noinput >", ""}:
        parts.append(f"### Input\n{inp}")
    parts.append(f"### Response\n{out}")
    return "\n\n".join(parts)


def write_train_jsonl(
    src: str | Path,
    dest: str | Path,
    *,
    limit: int = 256,
) -> int:
    src_p, dest_p = Path(src), Path(dest)
    dest_p.parent.mkdir(parents=True, exist_ok=True)
    raw = json.loads(src_p.read_text())
    n = 0
    with dest_p.open("w") as fh:
        for row in raw[:limit]:
            text = record_to_text(row)
            if len(text) < 8:
                continue
            fh.write(json.dumps({"text": text}, ensure_ascii=False) + "\n")
            n += 1
    return n


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    n = write_train_jsonl(
        "/workspace/attachments/code_alpaca_20k.json",
        root / "data" / "train.jsonl",
        limit=256,
    )
    print(f"wrote {n} rows")
