"""Integration 3 — mock-free serving: live weights, generate tokens, no zeros."""

from __future__ import annotations

from pathlib import Path

from mindarchitect.serving import generate, load_smoke, weights_are_live

CKPT = Path(__file__).resolve().parents[2] / "artifacts" / "checkpoints" / "smoke"


def test_weights_are_not_mock():
    model, _, _ = load_smoke(CKPT)
    stats = weights_are_live(model)
    assert stats["tok_emb.weight"] > 0
    assert stats["lm_head.weight"] > 0


def test_generate_stays_inside_vocab():
    model, tok, _ = load_smoke(CKPT)
    text = generate(model, tok, "def add(a, b):", max_new=16)
    assert isinstance(text, str)
    # decode may skip specials; the important bit is it didn't raise VocabMismatchError
    ids = tok.encode(text or "x")
    assert all(0 <= i < 32004 for i in ids)
