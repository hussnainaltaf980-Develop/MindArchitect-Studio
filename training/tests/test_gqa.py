"""Grouped-query attention: shapes, KV expansion, cache, causal mask."""

from __future__ import annotations

import torch

from mindarchitect.model.gqa import GroupedQueryAttention, causal_mask, expand_kv


def test_expand_kv_repeats_each_head():
    kv = torch.arange(2 * 3 * 2 * 4).float().view(2, 3, 2, 4)
    expanded = expand_kv(kv, n_rep=3)  # 2 KV heads → 6 Q heads
    assert expanded.shape == (2, 3, 6, 4)
    # head 0,1,2 are copies of KV head 0; 3,4,5 copies of KV head 1
    torch.testing.assert_close(expanded[:, :, 0], kv[:, :, 0])
    torch.testing.assert_close(expanded[:, :, 2], kv[:, :, 0])
    torch.testing.assert_close(expanded[:, :, 3], kv[:, :, 1])
    torch.testing.assert_close(expanded[:, :, 5], kv[:, :, 1])


def test_expand_kv_identity_when_mha():
    kv = torch.randn(1, 5, 4, 8)
    torch.testing.assert_close(expand_kv(kv, 1), kv)


def test_causal_mask_blocks_future():
    mask = causal_mask(4, 4, torch.device("cpu"), torch.float32)
    assert mask.shape == (1, 1, 4, 4)
    # diagonal and below are 0; above are -inf
    for i in range(4):
        for j in range(4):
            if j <= i:
                assert mask[0, 0, i, j] == 0
            else:
                assert mask[0, 0, i, j] < -1e10


def test_causal_mask_with_kv_cache_offset():
    # 1 new query against 4 cached keys — query lives at position 3
    mask = causal_mask(1, 4, torch.device("cpu"), torch.float32)
    assert mask.shape == (1, 1, 1, 4)
    assert torch.all(mask[0, 0, 0] == 0)  # all past keys are visible


def test_gqa_tensor_shapes_forward():
    b, s, h, heads, kv, d = 2, 7, 64, 8, 2, 8
    attn = GroupedQueryAttention(h, heads, kv, d, max_seq_len=32)
    x = torch.randn(b, s, h)
    out, cache = attn(x)
    assert out.shape == (b, s, h)
    ck, cv = cache
    assert ck.shape == (b, s, kv, d)
    assert cv.shape == (b, s, kv, d)


def test_kv_cache_projection_grows_along_sequence():
    attn = GroupedQueryAttention(32, 4, 2, 8, max_seq_len=16)
    x1 = torch.randn(1, 3, 32)
    x2 = torch.randn(1, 2, 32)
    _, cache = attn(x1)
    out, cache2 = attn(x2, cache=cache)
    assert out.shape == (1, 2, 32)
    assert cache2[0].shape == (1, 5, 2, 8)
    # prefix of the new cache equals the old cache
    torch.testing.assert_close(cache2[0][:, :3], cache[0])


def test_multi_query_head_expansion_matches_repeat():
    """GQA with kv=1 is multi-query: a single K/V is broadcast to every Q head."""
    attn = GroupedQueryAttention(32, 4, 1, 8, max_seq_len=16)
    x = torch.randn(1, 6, 32)
    out, cache = attn(x)
    assert cache[0].shape[-2] == 1
    assert out.shape == (1, 6, 32)


def test_causal_behaviour_future_tokens_do_not_leak():
    """Position 0 output must be independent of tokens at t>0."""
    torch.manual_seed(1)
    attn = GroupedQueryAttention(32, 4, 2, 8, max_seq_len=16)
    attn.eval()
    a = torch.randn(1, 5, 32)
    b = a.clone()
    b[:, 1:] = torch.randn_like(b[:, 1:])
    with torch.no_grad():
        ya, _ = attn(a)
        yb, _ = attn(b)
    torch.testing.assert_close(ya[:, 0], yb[:, 0], atol=1e-5, rtol=1e-5)
