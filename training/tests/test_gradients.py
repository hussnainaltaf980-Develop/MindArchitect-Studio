"""Gradient-flow sanity: every native parameter receives a non-zero grad."""

from __future__ import annotations

import torch

from mindarchitect.model.config import FORGE_SMOKE
from mindarchitect.model.transformer import MindArchitectTransformer


def test_backward_reaches_every_layer():
    torch.manual_seed(42)
    cfg = FORGE_SMOKE
    model = MindArchitectTransformer(cfg)
    model.train()
    tokens = torch.randint(0, cfg.vocab_size, (2, 12))
    loss = model.loss(tokens)
    loss.backward()

    missing: list[str] = []
    for name, p in model.named_parameters():
        if p.grad is None or p.grad.abs().sum().item() == 0:
            missing.append(name)
    assert missing == [], f"zero/missing grads: {missing}"
    assert torch.isfinite(loss)
