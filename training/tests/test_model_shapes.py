"""End-to-end shape, residual, and projection invariants of the native decoder."""

from __future__ import annotations

import torch

from mindarchitect.model.config import FORGE_SMOKE, ModelConfig
from mindarchitect.model.transformer import DecoderBlock, MindArchitectTransformer


def _tiny() -> ModelConfig:
    return FORGE_SMOKE


def test_config_rejects_broken_head_math():
    try:
        ModelConfig(hidden_size=64, num_attention_heads=5, head_dim=16, num_key_value_heads=1, intermediate_size=128)
        assert False
    except ValueError:
        pass


def test_config_rejects_gqa_indivisible():
    try:
        ModelConfig(hidden_size=64, num_attention_heads=4, head_dim=16, num_key_value_heads=3, intermediate_size=128)
        assert False
    except ValueError:
        pass


def test_forward_logits_shape():
    cfg = _tiny()
    model = MindArchitectTransformer(cfg)
    tokens = torch.randint(0, cfg.vocab_size, (3, 11))
    logits, caches = model(tokens)
    assert logits.shape == (3, 11, cfg.vocab_size)
    assert len(caches) == cfg.num_layers
    for ck, cv in caches:
        assert ck.shape == (3, 11, cfg.num_key_value_heads, cfg.head_dim)
        assert cv.shape == ck.shape


def test_residual_adds_preserve_hidden_dim():
    cfg = _tiny()
    block = DecoderBlock(cfg)
    x = torch.randn(2, 9, cfg.hidden_size)
    y, _ = block(x)
    assert y.shape == x.shape
    # Residual path is live: output is not equal to a fresh random tensor of same shape,
    # and differs from input (attention + ffn moved it).
    assert not torch.allclose(y, x)


def test_feed_forward_projection_dims():
    cfg = _tiny()
    block = DecoderBlock(cfg)
    assert block.ffn.gate_proj.out_features == cfg.intermediate_size
    assert block.ffn.up_proj.out_features == cfg.intermediate_size
    assert block.ffn.down_proj.out_features == cfg.hidden_size
    x = torch.randn(1, 4, cfg.hidden_size)
    y = block.ffn(x)
    assert y.shape == x.shape


def test_tied_embeddings_share_storage():
    cfg = ModelConfig(
        vocab_size=320,
        hidden_size=64,
        intermediate_size=160,
        num_layers=1,
        num_attention_heads=4,
        num_key_value_heads=2,
        head_dim=16,
        max_seq_len=32,
        tie_embeddings=True,
    )
    model = MindArchitectTransformer(cfg)
    assert model.lm_head.weight.data_ptr() == model.tok_emb.weight.data_ptr()


def test_smoke_embeddings_are_untied_at_32004():
    cfg = FORGE_SMOKE
    assert cfg.vocab_size == 32004
    assert cfg.tie_embeddings is False
    model = MindArchitectTransformer(cfg)
    assert model.lm_head.weight.data_ptr() != model.tok_emb.weight.data_ptr()
    assert model.tok_emb.weight.shape[0] == 32004


def test_loss_is_scalar_and_finite():
    cfg = _tiny()
    model = MindArchitectTransformer(cfg)
    tokens = torch.randint(0, cfg.vocab_size, (2, 8))
    loss = model.loss(tokens)
    assert loss.ndim == 0
    assert torch.isfinite(loss)


def test_hidden_propagates_across_all_layers():
    cfg = _tiny()
    model = MindArchitectTransformer(cfg)
    tokens = torch.randint(0, cfg.vocab_size, (1, 5))
    x = model.tok_emb(tokens)
    assert x.shape[-1] == cfg.hidden_size
    for block in model.blocks:
        x, _ = block(x)
        assert x.shape == (1, 5, cfg.hidden_size)
    x = model.final_norm(x)
    assert x.shape[-1] == cfg.hidden_size
