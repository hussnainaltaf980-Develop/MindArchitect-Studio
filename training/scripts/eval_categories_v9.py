#!/usr/bin/env python3
"""Stage 4 — held-out evaluation of the trained model, per task category.

Two different questions, measured separately
--------------------------------------------
Loss tells you how well the model *predicts* held-out text when it is handed the
true prefix. That is the right way to compare training runs, but on its own it
flatters a small model: a model that has learned "answers in these families look
like this" scores decently without being able to produce a correct answer.

So this reports both:

1. **Teacher-forced loss** per category — nats/token and bits/byte on the
   untouched test split, with the true prefix given.
2. **Free-running accuracy** — the model generates the continuation itself with
   no access to the reference, and the result is compared to it. Exact match,
   token F1, and a first-token match rate.

The gap between (1) and (2) is the honest story. A model can have low loss and
near-zero generation accuracy; reporting only the loss would hide that.

Every category is reported, including the ones that fail, with a concrete
failure example quoted verbatim.

Usage
-----
    python3 scripts/eval_categories_v9.py \
        --checkpoint artifacts/checkpoints/smoke-bpe512-v9 --data-dir data
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

os.environ.setdefault("MALLOC_ARENA_MAX", "2")
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

import torch  # noqa: E402

torch.set_num_threads(min(4, os.cpu_count() or 1))

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bpe_tokenizer import render_example  # noqa: E402
from mindarchitect.model.config import ModelConfig  # noqa: E402
from mindarchitect.model.transformer import MindArchitectTransformer  # noqa: E402

BOS, EOS, PAD = 1, 2, 0
LN2 = math.log(2.0)

# The rendered prompt ends with this marker; generation starts after it.
RESPONSE_MARKER = "### Response"


def load_model(ckpt: Path) -> tuple[MindArchitectTransformer, dict]:
    blob = torch.load(ckpt / "model.pt", map_location="cpu", weights_only=False)
    cfg = ModelConfig(**blob["config"])
    model = MindArchitectTransformer(cfg)
    model.load_state_dict(blob["state_dict"])
    model.eval()
    return model, blob


def split_prompt_response(text: str) -> tuple[str, str]:
    """Split the rendered example at the response marker."""
    idx = text.find(RESPONSE_MARKER)
    if idx < 0:
        return text, ""
    cut = idx + len(RESPONSE_MARKER)
    return text[:cut], text[cut:]


@torch.no_grad()
def teacher_forced_nll(model, tokens: list[int]) -> tuple[float, int]:
    """Mean NLL over the response tokens only, given the true prefix.

    Scoring only the response is deliberate: the prompt is near-identical across
    a family, so including it would let a model score well by predicting a
    repeated header.
    """
    if len(tokens) < 2:
        return float("nan"), 0
    seq = torch.tensor([tokens], dtype=torch.long)
    logits, _ = model(seq[:, :-1])
    targets = seq[:, 1:]
    logp = torch.log_softmax(logits.float(), dim=-1)
    picked = logp.gather(-1, targets.unsqueeze(-1)).squeeze(-1)
    mask = targets.ne(PAD)
    nll = -picked[mask]
    if nll.numel() == 0:
        return float("nan"), 0
    return float(nll.mean()), int(nll.numel())


@torch.no_grad()
def generate(model, prompt_tokens: list[int], max_new: int, cfg,
             repetition_penalty: float = 1.15) -> list[int]:
    """Greedy decode with a mild repetition penalty.

    Greedy rather than sampled so the result is reproducible. The penalty is small
    and exists only to stop the degenerate repeat-forever mode a tiny model falls
    into; it is not a quality trick and does not make the output correct.
    """
    ids = list(prompt_tokens)
    out: list[int] = []
    for _ in range(max_new):
        window = ids[-cfg.max_seq_len:]
        seq = torch.tensor([window], dtype=torch.long)
        logits, _ = model(seq)
        scores = logits[0, -1].clone()
        if out and repetition_penalty != 1.0:
            recent = torch.tensor(sorted(set(out[-24:])), dtype=torch.long)
            scores[recent] = scores[recent] / repetition_penalty
        nxt = int(scores.argmax().item())
        if nxt == EOS:
            break
        out.append(nxt)
        ids.append(nxt)
    return out


def token_f1(pred: str, ref: str) -> float:
    p = pred.split()
    r = ref.split()
    if not p or not r:
        return 0.0
    common = Counter(p) & Counter(r)
    overlap = sum(common.values())
    if overlap == 0:
        return 0.0
    precision = overlap / len(p)
    recall = overlap / len(r)
    return 2 * precision * recall / (precision + recall)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--checkpoint", type=Path, required=True)
    ap.add_argument("--data-dir", type=Path, default=Path("data"))
    ap.add_argument("--split", default="test")
    ap.add_argument("--max-new", type=int, default=64)
    ap.add_argument("--gen-limit", type=int, default=8,
                    help="examples per category to run free generation on")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    model, blob = load_model(args.checkpoint)
    cfg = model.cfg
    meta = json.loads((args.checkpoint / "checkpoint_meta.json").read_text())

    # Tokenizer, from the same artifact the model was trained against.
    tok_path = args.data_dir / "bpe_tokenizer.json"
    if not tok_path.exists():
        print(f"missing tokenizer artifact {tok_path}", file=sys.stderr)
        return 2
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(str(tok_path))

    def encode(text: str) -> list[int]:
        return [BOS, *tok.encode(text).ids, EOS]

    def encode_prompt(text: str) -> list[int]:
        # NO trailing EOS. Appending EOS asked the model to predict the token
        # after end-of-sequence, so greedy decoding emitted EOS immediately and
        # every generation came back empty. The prompt is a prefix to continue,
        # not a completed sequence.
        return [BOS, *tok.encode(text).ids]

    rows = []
    for line in (args.data_dir / f"{args.split}.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    if not rows:
        print(f"no rows in split {args.split}", file=sys.stderr)
        return 2

    by_cat: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_cat[r.get("category", "unknown")].append(r)

    categories: dict[str, dict] = {}
    print("=" * 88)
    print(f"held-out evaluation  split={args.split}  rows={len(rows)}  "
          f"tokenizer=bpe  vocab={cfg.vocab_size}")
    print(f"checkpoint best_val={meta['best_val_loss']} @ step {meta['best_val_step']}  "
          f"test_loss={meta['test_loss']}  steps={meta['completed_steps']}")
    print("=" * 88)

    for cat, cat_rows in sorted(by_cat.items()):
        nlls, ntoks, nbytes = [], 0, 0
        exact = first_ok = 0
        f1s: list[float] = []
        gen_n = 0
        failures: list[dict] = []

        for r in cat_rows:
            text = render_example(r)
            prompt, response = split_prompt_response(text)
            full = encode(text)

            # --- teacher-forced loss ---------------------------------------- #
            nll, n = teacher_forced_nll(model, full)
            if not math.isnan(nll):
                nlls.append(nll)
                ntoks += n
                nbytes += len(text.encode("utf-8"))

            # --- free-running generation ------------------------------------ #
            if gen_n < args.gen_limit:
                gen_n += 1
                p_ids = encode_prompt(prompt)
                new = generate(model, p_ids, args.max_new, cfg)
                pred = tok.decode(new)
                ref = response.lstrip()
                # Compare on the first line of the answer, where a small model
                # either has the format or has nothing.
                pred_first = pred.strip().splitlines()[0] if pred.strip() else ""
                ref_first = ref.strip().splitlines()[0] if ref.strip() else ""
                hit = pred_first.strip() == ref_first.strip()
                first_ok += int(hit)
                f1 = token_f1(pred, ref)
                f1s.append(f1)
                exact += int(pred.strip() == ref.strip())
                if not hit and len(failures) < 3:
                    failures.append({
                        "instruction": r["instruction"][:150],
                        "expected_first_line": ref_first[:150],
                        "predicted": pred.strip()[:150],
                    })

        mean_nll = sum(nlls) / len(nlls) if nlls else float("nan")
        bpb = mean_nll / LN2 / (nbytes / ntoks) if ntoks else float("nan")
        categories[cat] = {
            "n_examples": len(cat_rows),
            "teacher_forced_nats_per_token": round(mean_nll, 4),
            "teacher_forced_perplexity": round(math.exp(min(20.0, mean_nll)), 3)
            if not math.isnan(mean_nll) else None,
            "bits_per_byte": round(bpb, 4),
            "generation_examples_tested": gen_n,
            "first_line_match": first_ok,
            "first_line_match_pct": round(100.0 * first_ok / gen_n, 1) if gen_n else 0.0,
            "exact_match": exact,
            "mean_token_f1": round(sum(f1s) / len(f1s), 4) if f1s else 0.0,
            "failure_examples": failures,
        }
        mark = "OK  " if (gen_n and first_ok / gen_n >= 0.5) else "WEAK"
        print(f"{mark} {cat:<12} n={len(cat_rows):>4}  "
              f"NLL {mean_nll:7.4f}  ppl {math.exp(min(20.0, mean_nll)):9.2f}  "
              f"bpb {bpb:6.4f}  first-line {first_ok}/{gen_n}  "
              f"F1 {categories[cat]['mean_token_f1']:.3f}")

    overall_tokens = sum(c["n_examples"] for c in categories.values())
    macro_nll = sum(c["teacher_forced_nats_per_token"] * c["n_examples"]
                    for c in categories.values()) / overall_tokens
    overall_first = sum(c["first_line_match"] for c in categories.values())
    overall_gen = sum(c["generation_examples_tested"] for c in categories.values())

    summary = {
        "checkpoint": str(args.checkpoint),
        "split": args.split,
        "rows": len(rows),
        "vocab_size": cfg.vocab_size,
        "param_count": blob.get("param_count"),
        "tokenizer": "bpe",
        "macro_teacher_forced_nats_per_token": round(macro_nll, 4),
        "macro_perplexity": round(math.exp(min(20.0, macro_nll)), 3),
        "random_floor_nats": round(meta["tokenizer_effective_floor_nats"], 4) if meta.get(
            "tokenizer_effective_floor_nats") else None,
        "generation_examples_tested": overall_gen,
        "generation_first_line_matches": overall_first,
        "generation_first_line_match_pct": round(100.0 * overall_first / overall_gen, 1)
        if overall_gen else 0.0,
        "categories_ok": sorted(k for k, v in categories.items()
                                if v["generation_examples_tested"]
                                and v["first_line_match_pct"] >= 50.0),
        "categories_weak": sorted(k for k, v in categories.items()
                                  if not (v["generation_examples_tested"]
                                          and v["first_line_match_pct"] >= 50.0)),
        "per_category": categories,
        "interpretation": (
            "Teacher-forced loss measures prediction given the true prefix. "
            "First-line match measures free-running generation with no reference. "
            "The gap between them is the honest capability signal."
        ),
    }

    out = args.out or (args.checkpoint / "eval_categories.json")
    out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    print("=" * 88)
    print(f"macro NLL       : {macro_nll:.4f} nats/token  "
          f"(ppl {math.exp(min(20.0, macro_nll)):.2f})")
    floor = summary["random_floor_nats"]
    if floor:
        print(f"random floor    : {floor:.4f} nats/token  ->  "
              f"{100 * (1 - macro_nll / floor):.1f}% below uniform")
    print(f"free generation : {overall_first}/{overall_gen} first-line matches "
          f"({summary['generation_first_line_match_pct']}%)")
    print(f"categories ok   : {summary['categories_ok'] or 'none'}")
    print(f"categories weak : {summary['categories_weak'] or 'none'}")
    print(f"report          : {out}")
    print("=" * 88)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
