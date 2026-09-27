#!/usr/bin/env python3
"""Stage 2 — train the tokenizer on the expanded corpus and audit its coverage.

What this measures, and why each number matters
-----------------------------------------------
A tokenizer imposes a *loss floor* before any model is involved: no model can
beat the entropy of the token stream it is handed. Reporting loss without that
floor is unfalsifiable, and comparing two tokenizers by nats/token alone is
actively misleading, because a tokenizer that emits fewer, larger tokens scores a
higher loss per token while compressing the same text better.

So this reports three things together:

  * **reachable ids** — how much of the declared 32,004-row embedding table the
    tokenizer can ever address. Dead rows are parameters that can never be
    usefully trained, which is the concrete cost of a mismatched vocabulary.
  * **random-guess floor** `ln(reachable)` in nats/token — an absolute floor
    assuming a uniform output distribution.
  * **bits per byte** — entropy divided by source bytes. This is the only
    fair cross-tokenizer comparison, and it is the number to read.

Fitting discipline
------------------
Merges are learned from the **train split only**. Fitting on validation or test
text would mean the tokenizer had already seen the held-out strings, which makes
every downstream evaluation optimistic. Coverage is then *measured* across all
splits, which is legitimate: measurement is not fitting.

Usage
-----
    python3 scripts/tokenizer_audit_v2.py --data-dir data --out-dir data
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bpe_tokenizer import (  # noqa: E402
    BYTE_OFFSET,
    LN2,
    SPECIALS,
    all_texts,
    bigram_conditional_entropy,
    encode_ids,
    load_splits,
    measure,
    train_bpe,
    ByteLevelTokenizer,
)


def report(label: str, metrics, extra: dict | None = None) -> dict:
    d = metrics.as_dict()
    if extra:
        d.update(extra)
    return d


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", type=Path, default=Path("data"))
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument("--vocab-size", type=int, default=32_004)
    ap.add_argument("--min-frequency", type=int, default=1)
    args = ap.parse_args()

    out_dir = args.out_dir or args.data_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    splits = load_splits(args.data_dir)
    if "train" not in splits:
        print(f"no train split under {args.data_dir}", file=sys.stderr)
        return 2

    fit_texts = all_texts({"train": splits["train"]})
    eval_texts = all_texts(splits)

    print("=" * 76)
    print(f"fitting merges on TRAIN ONLY: {len(fit_texts)} examples")
    print(f"measuring coverage over ALL splits: {len(eval_texts)} examples")
    print("=" * 76)

    # ---- baseline: the shipped byte-level tokenizer ------------------------- #
    byte_tok = ByteLevelTokenizer()
    byte_all = measure(byte_tok, eval_texts, byte_tok.label, byte_tok.vocab_size)
    per_split_byte = {
        name: measure(byte_tok, all_texts({name: rows}), f"byte/{name}", byte_tok.vocab_size)
        for name, rows in splits.items()
    }

    # ---- trained BPE -------------------------------------------------------- #
    print(f"\ntraining BPE (target vocab {args.vocab_size}) on train only ...")
    bpe = train_bpe(fit_texts, args.vocab_size, args.min_frequency)
    achieved = bpe.get_vocab_size()
    artifact = out_dir / "bpe_tokenizer.json"
    bpe.save(str(artifact))

    bpe_all = measure(bpe, eval_texts, f"BPE (target {args.vocab_size})", args.vocab_size)
    per_split_bpe = {
        name: measure(bpe, all_texts({name: rows}), f"bpe/{name}", args.vocab_size)
        for name, rows in splits.items()
    }

    # Held-out-only view: fit never saw these strings.
    held_out = [n for n in splits if n != "train"]
    held_out_texts = all_texts({n: splits[n] for n in held_out})
    bpe_held = measure(bpe, held_out_texts, "BPE (held-out)", args.vocab_size)
    byte_held = measure(byte_tok, held_out_texts, "byte (held-out)", byte_tok.vocab_size)

    # ---- report ------------------------------------------------------------- #
    payload = {
        "corpus": {
            "splits": {n: len(rows) for n, rows in splits.items()},
            "train_examples_used_for_fitting": len(fit_texts),
            "examples_evaluated": len(eval_texts),
            "total_bytes": byte_all.total_bytes,
        },
        "fit_policy": "BPE merges fitted on the train split only; coverage measured on all splits",
        "bpe": {
            "target_vocab_size": args.vocab_size,
            "achieved_vocab_size": achieved,
            "artifact": str(artifact),
            "special_token_ids": {s: i for i, s in enumerate(SPECIALS)},
            "min_frequency": args.min_frequency,
        },
        "byte_level_all_splits": report("byte", byte_all),
        "bpe_all_splits": report("bpe", bpe_all),
        "byte_level_held_out": report("byte-held", byte_held),
        "bpe_held_out": report("bpe-held", bpe_held),
        "per_split": {
            name: {
                "n_examples": len(rows),
                "byte": {k: v for k, v in per_split_byte[name].as_dict().items()
                         if k in ("reachable_ids", "total_tokens", "unigram_bits_per_byte",
                                  "bigram_bits_per_byte", "token_length_percentiles")},
                "bpe": {k: v for k, v in per_split_bpe[name].as_dict().items()
                        if k in ("reachable_ids", "total_tokens", "unigram_bits_per_byte",
                                 "bigram_bits_per_byte", "token_length_percentiles")},
            }
            for name, rows in splits.items()
        },
        "comparison": {
            "reachable_ids_before": byte_all.reachable_ids,
            "reachable_ids_after": bpe_all.reachable_ids,
            "reachable_gain": bpe_all.reachable_ids - byte_all.reachable_ids,
            "reachable_pct_before": round(byte_all.reachable_pct, 4),
            "reachable_pct_after": round(bpe_all.reachable_pct, 4),
            "dead_slots_before": byte_all.dead_slots,
            "dead_slots_after": bpe_all.dead_slots,
            "floor_nats_before": round(byte_all.random_floor_nats, 6),
            "floor_nats_after": round(bpe_all.random_floor_nats, 6),
            "tokens_before": byte_all.total_tokens,
            "tokens_after": bpe_all.total_tokens,
            "token_compression": round(byte_all.total_tokens / bpe_all.total_tokens, 4)
            if bpe_all.total_tokens else 0.0,
            "bytes_per_token_before": round(byte_all.bytes_per_token, 4),
            "bytes_per_token_after": round(bpe_all.bytes_per_token, 4),
            "unigram_bits_per_byte_before": round(byte_all.unigram_bits_per_byte, 6),
            "unigram_bits_per_byte_after": round(bpe_all.unigram_bits_per_byte, 6),
            "unigram_bpb_delta_pct": round(
                100.0 * (bpe_all.unigram_bits_per_byte - byte_all.unigram_bits_per_byte)
                / byte_all.unigram_bits_per_byte, 4) if byte_all.unigram_bits_per_byte else 0.0,
            "bigram_bits_per_byte_before": round(byte_all.bigram_bits_per_byte, 6),
            "bigram_bits_per_byte_after": round(bpe_all.bigram_bits_per_byte, 6),
            "held_out_unigram_bpb_before": round(byte_held.unigram_bits_per_byte, 6),
            "held_out_unigram_bpb_after": round(bpe_held.unigram_bits_per_byte, 6),
        },
        "seq_len_fit": {
            "note": "examples whose token length fits entirely inside a window",
            "byte_level": {str(w): int((byte_all.lengths and
                                        sum(1 for n in byte_all.lengths if n <= w)) or 0)
                           for w in (128, 256, 512, 1024, 2048, 4096)},
            "bpe": {str(w): int(sum(1 for n in bpe_all.lengths if n <= w))
                    for w in (128, 256, 512, 1024, 2048, 4096)},
        },
    }
    (out_dir / "tokenizer_coverage.json").write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    # ---- console ------------------------------------------------------------ #
    c = payload["comparison"]
    print("\n" + "=" * 76)
    print(f"{'metric':<36}{'byte-level':>18}{'BPE':>20}")
    print("=" * 76)
    def row(name: str, a, b) -> None:
        print(f"{name:<36}{str(a):>18}{str(b):>20}")
    row("reachable ids", c["reachable_ids_before"], c["reachable_ids_after"])
    row("reachable % of 32004", f"{c['reachable_pct_before']:.2f}%", f"{c['reachable_pct_after']:.2f}%")
    row("dead embedding rows", c["dead_slots_before"], c["dead_slots_after"])
    row("random floor nats/token", f"{c['floor_nats_before']:.4f}", f"{c['floor_nats_after']:.4f}")
    row("tokens (all splits)", c["tokens_before"], c["tokens_after"])
    row("bytes/token", f"{c['bytes_per_token_before']:.3f}", f"{c['bytes_per_token_after']:.3f}")
    row("bits/byte (unigram)", f"{c['unigram_bits_per_byte_before']:.4f}", f"{c['unigram_bits_per_byte_after']:.4f}")
    row("bits/byte (bigram)", f"{c['bigram_bits_per_byte_before']:.4f}", f"{c['bigram_bits_per_byte_after']:.4f}")
    row("bits/byte HELD-OUT", f"{c['held_out_unigram_bpb_before']:.4f}", f"{c['held_out_unigram_bpb_after']:.4f}")
    row("p50 tokens/example", byte_all.percentiles().get("p50"), bpe_all.percentiles().get("p50"))
    row("p99 tokens/example", byte_all.percentiles().get("p99"), bpe_all.percentiles().get("p99"))
    row("max tokens/example", byte_all.percentiles().get("max"), bpe_all.percentiles().get("max"))
    print("=" * 76)
    print(f"achieved BPE vocab : {achieved} (target {args.vocab_size})")
    print(f"tokenizer artifact : {artifact}")
    print(f"coverage report    : {out_dir / 'tokenizer_coverage.json'}")
    print(f"seq_len 512 fits   : byte {payload['seq_len_fit']['byte_level']['512']}/"
          f"{len(eval_texts)}   bpe {payload['seq_len_fit']['bpe']['512']}/{len(eval_texts)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
