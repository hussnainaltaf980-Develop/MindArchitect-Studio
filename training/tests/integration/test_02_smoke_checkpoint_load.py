"""Integration 2 — load the 32004 smoke safetensors artifact and run a forward."""

from __future__ import annotations

from pathlib import Path

import torch

from mindarchitect.serving import load_smoke

CKPT = Path(__file__).resolve().parents[2] / "artifacts" / "checkpoints" / "smoke"


def test_smoke_checkpoint_exists():
    assert (CKPT / "model.safetensors").is_file(), "retrain smoke first"
    assert (CKPT / "manifest.json").is_file()


def test_load_and_forward_shapes():
    model, tok, manifest = load_smoke(CKPT)
    assert manifest["vocab_size"] == 32004
    assert model.cfg.vocab_size == tok.vocab_size == 32004
    tokens = torch.randint(0, 260, (2, 8))  # byte range is always valid
    logits, caches = model(tokens)
    assert logits.shape == (2, 8, 32004)
    assert len(caches) == model.cfg.num_layers
    assert torch.isfinite(logits).all()
