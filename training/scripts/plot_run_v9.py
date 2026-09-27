#!/usr/bin/env python3
"""Render the run's loss curve from its recorded history.

Reads `loss_history_full.json` and `checkpoint_meta.json` and draws the figure
used in the report: train loss, held-out validation loss, the tokenizer's random
floor, and the early-stopping point. Nothing is smoothed or interpolated — every
plotted point is a value the run actually recorded.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--checkpoint", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--title", default="MindArchitect Forge smoke — BPE @ seq_len 512")
    args = ap.parse_args()

    hist = json.loads((args.checkpoint / "loss_history_full.json").read_text())
    meta = json.loads((args.checkpoint / "checkpoint_meta.json").read_text())

    steps = [h["step"] for h in hist]
    train = [h["loss"] for h in hist]
    val = [(h["step"], h["val_loss"]) for h in hist if "val_loss" in h]

    fig, ax = plt.subplots(figsize=(11.5, 6.4), dpi=150)
    ax.plot(steps, train, lw=1.6, color="#2563eb", label="train loss (per step, no smoothing)")
    if val:
        ax.plot([s for s, _ in val], [v for _, v in val], lw=2.0,
                color="#dc2626", marker="o", ms=3, label="held-out validation loss")

    floor = meta.get("tokenizer_effective_floor_nats")
    if floor:
        ax.axhline(floor, ls="--", lw=1.2, color="#6b7280",
                   label=f"random-guess floor  ln({meta.get('tokenizer_reachable_ids','?')}) = {floor:.4f}")

    best_step, best_val = meta.get("best_val_step"), meta.get("best_val_loss")
    if best_step and best_val:
        ax.scatter([best_step], [best_val], s=110, zorder=5, color="#f59e0b",
                   edgecolor="black", linewidth=0.8,
                   label=f"best val {best_val:.4f} @ step {best_step}")

    if meta.get("early_stopped"):
        ax.axvline(meta["completed_steps"], ls=":", lw=1.4, color="#7c3aed",
                   label=f"early stop @ {meta['completed_steps']}")

    ax.set_xlabel("training step")
    ax.set_ylabel("cross-entropy (nats / token)")
    ax.set_title(f"{args.title}\n"
                 f"{meta.get('completed_steps')}/{meta.get('requested_steps')} steps · "
                 f"{meta.get('param_count', 0):,} params · best val {best_val} · "
                 f"test {meta.get('test_loss')} · final lr {meta.get('final_lr')}",
                 fontsize=10)
    ax.grid(alpha=0.25, linestyle="-", linewidth=0.5)
    ax.legend(fontsize=8.5, loc="center right", framealpha=0.95)
    fig.tight_layout()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.out)
    print(f"wrote {args.out}")
    print(f"points: {len(steps)} train, {len(val)} validation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
