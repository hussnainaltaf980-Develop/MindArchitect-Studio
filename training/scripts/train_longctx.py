#!/usr/bin/env python3
"""Forge Smoke — long-context training with held-out splits and early stopping.

The shipped `train_smoke.py` has three defects this runner fixes:

1. **Windows cut through examples.** `load_rows()` concatenates the corpus into
   one stream and slices it into `seq_len` blocks, so a training row is an
   arbitrary fragment. At `seq_len=64` every one of the 201 corpus examples was
   truncated; the model only ever saw fragment boundaries.
2. **No held-out evaluation.** It scored `data[:8]` — the same rows it trained
   on. Loss could not distinguish memorisation from learning.
3. **No learning-rate schedule and no early stopping.** It ran a fixed step
   count and saved the final (overfitted) weights.

This runner packs **one example per window**, trains on `train.jsonl`, selects
on `validation.jsonl`, and reports an untouched `test.jsonl` loss. The best
validation state is snapshotted to disk and restored before export.

The sequence-length extension is expressed in `effective_seq_len` below, and it
is reported per tokenizer: with the trained BPE (deliverable 1) a full example
is at most 338 tokens, so `seq_len=512` covers the corpus whole; the byte-level
tokenizer needs `seq_len=1536` to do the same.

Usage
-----
    python3 scripts/train_longctx.py --tokenizer byte --seq-len 256   --tag baseline
    python3 scripts/train_longctx.py --tokenizer byte --seq-len 1536  --tag byte-1536
    python3 scripts/train_longctx.py --tokenizer bpe  --seq-len 512   --tag bpe-512
"""

from __future__ import annotations

import argparse
import gc
import json
import math
import os
import shutil
import sys
import time
from dataclasses import replace
from pathlib import Path

# This sandbox caps the cgroup at 2 GiB while the host reports 48 CPUs. PyTorch
# sizes its allocator arenas per thread, so the default thread count fragments
# the whole budget away and the kernel OOM-kills the run (observed: exit 137 at
# ~step 110). Bounding threads and glibc arenas keeps peak RSS inside the cap.
os.environ.setdefault("MALLOC_ARENA_MAX", "2")
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

import torch
from torch.optim import AdamW

torch.set_num_threads(min(4, os.cpu_count() or 1))

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mindarchitect.export.to_safetensors import export_model  # noqa: E402
from mindarchitect.model.config import FORGE_SMOKE, VOCAB_SIZE_V1  # noqa: E402
from mindarchitect.model.transformer import MindArchitectTransformer  # noqa: E402
from mindarchitect.serving import assert_vocab_aligned  # noqa: E402
from mindarchitect.tokenizer import ByteTokenizer  # noqa: E402

from bpe_tokenizer import render_example  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
# Corpus directory. Rebound by --data-dir in main(); a module-level global so
# the existing load_split(..., DATA / "train.jsonl") call sites keep working
# unchanged and there is exactly one place the corpus path is decided.
DATA = ROOT / "data"
LN2 = math.log(2.0)
BOS, EOS = 1, 2


# --------------------------------------------------------------------------- #
# Tokenizers
# --------------------------------------------------------------------------- #
class ByteBackend:
    name = "byte"

    def __init__(self, vocab_size: int) -> None:
        self.tok = ByteTokenizer(vocab_size=vocab_size)

    def encode(self, text: str) -> list[int]:
        return self.tok.encode(text, add_bos=True, add_eos=True)


class BpeBackend:
    name = "bpe"

    def __init__(self, path: Path) -> None:
        from tokenizers import Tokenizer

        if not path.exists():
            raise FileNotFoundError(
                f"missing BPE artifact at {path} — run scripts/bpe_tokenizer.py first"
            )
        self.tok = Tokenizer.from_file(str(path))
        self.artifact_size = self.tok.get_vocab_size()

    def encode(self, text: str) -> list[int]:
        return [BOS, *self.tok.encode(text).ids, EOS]


def build_backend(kind: str, vocab_size: int) -> ByteBackend | BpeBackend:
    if kind == "byte":
        return ByteBackend(vocab_size)
    return BpeBackend(DATA / "bpe_tokenizer.json")


# --------------------------------------------------------------------------- #
# Dataset: one example per window
# --------------------------------------------------------------------------- #
def load_split(
    backend, seq_len: int, path: Path, pad_id: int = 0
) -> tuple[torch.Tensor, dict]:
    """Pack each example into its own window. Returns (tokens, stats)."""
    rows: list[list[int]] = []
    raw_len: list[int] = []
    if not path.exists():
        return torch.zeros((0, seq_len), dtype=torch.long), {"n": 0}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        ids = backend.encode(render_example(json.loads(line)))
        raw_len.append(len(ids))
        if len(ids) < 2:  # need at least one target token
            continue
        ids = ids[:seq_len]
        if len(ids) < seq_len:
            ids = ids + [pad_id] * (seq_len - len(ids))
        rows.append(ids)
    if not rows:
        return torch.zeros((0, seq_len), dtype=torch.long), {"n": 0}
    stats = {
        "n": len(rows),
        "raw_tokens_min": min(raw_len),
        "raw_tokens_max": max(raw_len),
        "raw_tokens_mean": round(sum(raw_len) / len(raw_len), 1),
        "truncated": sum(1 for n in raw_len if n > seq_len),
        "truncated_pct": round(100.0 * sum(1 for n in raw_len if n > seq_len) / len(raw_len), 2),
    }
    return torch.tensor(rows, dtype=torch.long), stats


@torch.no_grad()
def evaluate(model, data: torch.Tensor, batch: int = 1, limit: int | None = None) -> float:
    """Mean cross-entropy over a split, masked for padding.

    Chunked deliberately: the logits tensor is (B, S, 32004), so at S=1536 a
    single batch of 4 allocates ~800 MB before softmax intermediates. Batches
    are kept small and each one is released explicitly so peak memory stays
    well under the 2 GiB cgroup cap.
    """
    if data.size(0) == 0:
        return float("nan")
    rows = data if limit is None else data[:limit]
    model.eval()
    total, n = 0.0, 0
    for i in range(0, rows.size(0), batch):
        chunk = rows[i : i + batch]
        if chunk.size(0) < 2:
            chunk = rows[:2]
        logits, _ = model(chunk[:, :-1])
        tgt = chunk[:, 1:]
        loss = torch.nn.functional.cross_entropy(
            logits.reshape(-1, logits.size(-1)), tgt.reshape(-1), ignore_index=0
        )
        total += float(loss) * chunk.size(0)
        n += chunk.size(0)
        del logits, tgt, loss
        gc.collect()
    model.train()
    return total / max(n, 1)


# --------------------------------------------------------------------------- #
# Training
# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description="Forge Smoke long-context training.")
    ap.add_argument("--tokenizer", choices=["byte", "bpe"], default="byte")
    ap.add_argument("--seq-len", type=int, default=512)
    ap.add_argument("--max-steps", type=int, default=600)
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=1)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--min-lr-ratio", type=float, default=0.1)
    ap.add_argument("--warmup", type=int, default=20)
    ap.add_argument("--weight-decay", type=float, default=0.01)
    ap.add_argument("--patience", type=int, default=60, help="early-stop patience in steps")
    ap.add_argument("--min-delta", type=float, default=1e-4)
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument(
        "--vocab-size",
        type=int,
        default=None,
        help=(
            "Override the output-layer width. The BPE artifact only reaches ~2.7k ids, so "
            "the full 32,004-way layer spends 91.7% of its capacity on ids that can never "
            "be produced. Narrowing it (aligned to 256) is the honest way to test whether "
            "the dead vocabulary is what stops the BPE run from generalising."
        ),
    )
    ap.add_argument("--data-dir", type=Path, default=None,
                    help="Corpus directory holding train/validation/test.jsonl. "
                         "Defaults to <training>/data.")
    ap.add_argument("--tag", default="longctx")
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument("--no-probe-write", action="store_true")
    args = ap.parse_args()

    global DATA
    if args.data_dir is not None:
        DATA = args.data_dir if args.data_dir.is_absolute() else (ROOT / args.data_dir)
    out_dir = args.out_dir or (ROOT / "artifacts" / "checkpoints" / f"smoke-{args.tag}")
    seq_len = args.seq_len

    torch.manual_seed(args.seed)
    backend = build_backend(args.tokenizer, VOCAB_SIZE_V1)

    # Single source of truth: FORGE_SMOKE, with max_seq_len raised to the window.
    vocab_size = args.vocab_size or VOCAB_SIZE_V1
    if vocab_size % 256:
        raise SystemExit("--vocab-size must be a multiple of 256")
    cfg = replace(
        FORGE_SMOKE,
        max_seq_len=max(FORGE_SMOKE.max_seq_len, seq_len),
        vocab_size=vocab_size,
    )
    assert cfg.vocab_size >= 260, "vocab must cover 4 specials + 256 bytes"
    if args.tokenizer == "byte":
        assert_vocab_aligned(backend.tok, cfg)

    train, s_tr = load_split(backend, seq_len, DATA / "train.jsonl")
    val, s_va = load_split(backend, seq_len, DATA / "validation.jsonl")
    test, s_te = load_split(backend, seq_len, DATA / "test.jsonl")
    if train.numel() == 0:
        print("no training rows found", file=sys.stderr)
        return 2
    if int(train.max()) >= cfg.vocab_size:
        raise RuntimeError("corpus produced an id outside vocab_size")

    model = MindArchitectTransformer(cfg)
    n_params = model.param_count()
    n_tensors = len(model.state_dict())

    print("=" * 74)
    print(f"tag={args.tag}  tokenizer={backend.name}  seq_len={seq_len}  "
          f"cfg.max_seq_len={cfg.max_seq_len}")
    print(f"rows  train={s_tr['n']}  val={s_va['n']}  test={s_te['n']}")
    print(f"raw tokens/example  min={s_tr['raw_tokens_min']}  mean={s_tr['raw_tokens_mean']}  "
          f"max={s_tr['raw_tokens_max']}")
    print(f"truncated at this window: {s_tr['truncated']}/{s_tr['n']} "
          f"({s_tr['truncated_pct']}%)")
    print(f"params={n_params:,}  tensors={n_tensors}")
    print("=" * 74, flush=True)

    decay, no_decay = [], []
    for n, p in model.named_parameters():
        (no_decay if p.ndim < 2 or "norm" in n else decay).append(p)
    opt = AdamW(
        [{"params": decay, "weight_decay": args.weight_decay},
         {"params": no_decay, "weight_decay": 0.0}],
        lr=args.lr, betas=(0.9, 0.95),
    )

    def lr_at(step: int) -> float:
        if step < args.warmup:
            return args.lr * (step + 1) / args.warmup
        prog = (step - args.warmup) / max(1, args.max_steps - args.warmup)
        prog = min(1.0, max(0.0, prog))
        return args.lr * (args.min_lr_ratio + (1 - args.min_lr_ratio) * 0.5 * (1 + math.cos(math.pi * prog)))

    rng = torch.Generator().manual_seed(args.seed)
    history: list[dict] = []
    val_history: list[dict] = []
    best = {"val": float("inf"), "step": 0}
    best_path = Path("/tmp") / f"best_{args.tag}.pt"
    patience_left = args.patience
    t0 = time.time()
    model.train()

    for step in range(1, args.max_steps + 1):
        for g in opt.param_groups:
            g["lr"] = lr_at(step - 1)
        opt.zero_grad(set_to_none=True)
        step_loss = 0.0
        for _ in range(args.grad_accum):
            idx = torch.randint(0, train.size(0), (args.batch_size,), generator=rng)
            loss = model.loss(train[idx]) / args.grad_accum
            loss.backward()
            step_loss += float(loss.detach())
        gnorm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()

        if step == 1 or step % 10 == 0 or step == args.max_steps:
            vl = evaluate(model, val, limit=8) if val.size(0) else float("nan")
            rec = {"step": step, "loss": round(step_loss, 4), "lr": round(lr_at(step - 1), 8),
                   "gnorm": round(float(gnorm), 4)}
            if not math.isnan(vl):
                rec["val_loss"] = round(vl, 4)
                val_history.append({"step": step, "val_loss": round(vl, 4)})
            history.append(rec)
            print(f"step {step:4d}/{args.max_steps} | loss {step_loss:8.4f} | "
                  f"val {vl:8.4f} | lr {lr_at(step-1):.3e} | gnorm {float(gnorm):6.3f}",
                  flush=True)

            if not math.isnan(vl):
                if vl < best["val"] - args.min_delta:
                    best = {"val": vl, "step": step}
                    patience_left = args.patience
                    torch.save({k: v.detach().cpu().clone() for k, v in model.state_dict().items()}, best_path)
                else:
                    patience_left -= 10
                    if patience_left <= 0:
                        print(f"\nearly stop: no val improvement for {args.patience} steps "
                              f"(best {best['val']:.4f} @ step {best['step']})", flush=True)
                        break

    elapsed = time.time() - t0

    if best_path.exists():
        model.load_state_dict(torch.load(best_path, map_location="cpu", weights_only=True))
        restored = True
    else:
        restored = False

    train_loss = evaluate(model, train, limit=16)
    val_loss = evaluate(model, val)
    test_loss = evaluate(model, test)

    final_step = history[-1]["step"] if history else 0
    losses = [h["loss"] for h in history if "loss" in h]
    initial_loss = losses[0] if losses else float("nan")
    floor = math.log(cfg.vocab_size)
    reachable = min(cfg.vocab_size, 260 if args.tokenizer == "byte" else backend.artifact_size)
    effective_floor = math.log(reachable)

    extra = {
        "run": f"forge_smoke_longctx_{args.tag}",
        "tag": args.tag,
        "tokenizer": backend.name,
        "seed": args.seed,
        "seq_len": seq_len,
        "cfg_max_seq_len": cfg.max_seq_len,
        "requested_steps": args.max_steps,
        "completed_steps": final_step,
        "early_stopped": final_step < args.max_steps,
        "best_val_step": best["step"],
        "best_val_loss": round(best["val"], 4) if math.isfinite(best["val"]) else None,
        "best_state_restored": restored,
        "initial_loss": round(initial_loss, 4),
        "final_loss": round(train_loss, 4),
        "val_loss": round(val_loss, 4),
        "test_loss": round(test_loss, 4),
        "test_ppl": round(math.exp(min(20.0, test_loss)), 4),
        "loss_delta": round(train_loss - initial_loss, 4),
        "loss_delta_convention": "final_loss - initial_loss; negative means improvement",
        "random_floor_nats": round(floor, 4),
        "random_floor_definition": f"ln(vocab_size) = ln({cfg.vocab_size})",
        "tokenizer_effective_floor_nats": round(effective_floor, 4),
        "tokenizer_effective_floor_definition":
            f"ln(reachable ids) = ln({reachable}) — the floor this tokenizer actually imposes",
        "batch_size": args.batch_size,
        "grad_accum": args.grad_accum,
        "effective_batch": args.batch_size * args.grad_accum,
        "lr": args.lr,
        "min_lr": round(args.lr * args.min_lr_ratio, 8),
        "final_lr": round(lr_at(max(0, final_step - 1)), 8),
        "elapsed_s": round(elapsed, 2),
        "vocab_size": cfg.vocab_size,
        "param_count": n_params,
        "tensor_count": n_tensors,
        "splits": {"train": s_tr, "validation": s_va, "test": s_te},
        "history": history,
        "val_history": val_history,
    }

    manifest = export_model(model, out_dir, extra_manifest=extra)
    (out_dir / "checkpoint_meta.json").write_text(
        json.dumps({k: v for k, v in extra.items() if k != "history"}, indent=2) + "\n",
        encoding="utf-8",
    )
    (out_dir / "loss_history_full.json").write_text(json.dumps(history, indent=2), encoding="utf-8")

    if not args.no_probe_write:
        probe = Path("/workspace/src/lib/smoke-probe.json")
        if probe.parent.exists():
            probe.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print("\n" + "=" * 74)
    print(f"initial {initial_loss:.4f} -> final train {train_loss:.4f}   "
          f"(delta {train_loss - initial_loss:+.4f})")
    print(f"val {val_loss:.4f}   TEST {test_loss:.4f}  ppl {math.exp(min(20.0, test_loss)):.4f}")
    print(f"steps {final_step}/{args.max_steps}  best val {best['val']:.4f} @ {best['step']}  "
          f"elapsed {elapsed:.1f}s")
    print(f"floor ln({cfg.vocab_size})={floor:.4f}   "
          f"tokenizer-aware floor ln({reachable})={effective_floor:.4f}")
    print(f"saved -> {out_dir}")
    print("=" * 74)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
