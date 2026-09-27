"""RoPE: frequencies, conjugate rotations, shift invariance, extrapolation."""

from __future__ import annotations

import math

import torch

from mindarchitect.model.rope import RotaryEmbedding, apply_rotary_emb, precompute_freqs, rotate_half


def test_frequency_formula_matches_closed_form():
    dim, seq, theta = 32, 16, 10000.0
    cos, sin = precompute_freqs(dim, seq, theta)
    t = torch.arange(seq).float()
    for i in range(dim // 2):
        freq = theta ** (-2 * i / dim)
        expected = t * freq
        # even and odd slots of pair i share θ_i
        torch.testing.assert_close(cos[:, 2 * i], expected.cos(), atol=1e-5, rtol=1e-5)
        torch.testing.assert_close(sin[:, 2 * i], expected.sin(), atol=1e-5, rtol=1e-5)
        torch.testing.assert_close(cos[:, 2 * i + 1], expected.cos(), atol=1e-5, rtol=1e-5)
        torch.testing.assert_close(sin[:, 2 * i + 1], expected.sin(), atol=1e-5, rtol=1e-5)


def test_even_head_dim_required():
    try:
        precompute_freqs(15, 8)
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_rotate_half_is_a_90_degree_turn():
    x = torch.tensor([1.0, 2.0, 3.0, 4.0])
    y = rotate_half(x)
    assert torch.allclose(y, torch.tensor([-2.0, 1.0, -4.0, 3.0]))


def test_conjugate_rotation_inverts():
    """Applying +θ then -θ (conjugate) recovers the original vector."""
    rng = torch.Generator().manual_seed(0)
    x = torch.randn(2, 8, 4, 16, generator=rng)
    cos, sin = precompute_freqs(16, 8)
    rotated = apply_rotary_emb(x, cos, sin)
    recovered = apply_rotary_emb(rotated, cos, -sin)
    torch.testing.assert_close(recovered, x, atol=1e-5, rtol=1e-5)


def test_identity_at_position_zero():
    x = torch.randn(1, 1, 2, 16)
    cos, sin = precompute_freqs(16, 1)
    # position 0 → angle 0 → cos=1, sin=0
    assert torch.allclose(cos[0], torch.ones_like(cos[0]), atol=1e-6)
    assert torch.allclose(sin[0], torch.zeros_like(sin[0]), atol=1e-6)
    torch.testing.assert_close(apply_rotary_emb(x, cos, sin), x, atol=1e-6, rtol=1e-6)


def test_relative_shift_invariance():
    """⟨RoPE(q,m), RoPE(k,n)⟩ == ⟨RoPE(q,m+s), RoPE(k,n+s)⟩."""
    rng = torch.Generator().manual_seed(7)
    dim, s = 16, 12
    q = torch.randn(dim, generator=rng)
    k = torch.randn(dim, generator=rng)
    cos, sin = precompute_freqs(dim, s + 4)
    pairs = []
    for m, n in [(1, 4), (3, 8), (0, 5)]:
        qm = apply_rotary_emb(q, cos[m], sin[m])
        kn = apply_rotary_emb(k, cos[n], sin[n])
        pairs.append(torch.dot(qm, kn))
    # Same relative offset Δ=3
    m, n, shift = 2, 5, 3
    a = torch.dot(apply_rotary_emb(q, cos[m], sin[m]), apply_rotary_emb(k, cos[n], sin[n]))
    b = torch.dot(
        apply_rotary_emb(q, cos[m + shift], sin[m + shift]),
        apply_rotary_emb(k, cos[n + shift], sin[n + shift]),
    )
    torch.testing.assert_close(a, b, atol=1e-5, rtol=1e-5)


def test_linear_extrapolation_compresses_angles():
    dim, seq, scale = 16, 32, 2.0
    cos_s, sin_s = precompute_freqs(dim, seq, scale=scale)
    cos_1, sin_1 = precompute_freqs(dim, seq // 2, scale=1.0)
    # Position t under scale=2 matches position t/2 under scale=1 (even t)
    for t in range(0, seq, 2):
        torch.testing.assert_close(cos_s[t], cos_1[t // 2], atol=1e-5, rtol=1e-5)
        torch.testing.assert_close(sin_s[t], sin_1[t // 2], atol=1e-5, rtol=1e-5)


def test_module_offset_matches_precomputed():
    rope = RotaryEmbedding(head_dim=16, max_seq_len=64, theta=10000.0)
    cos, sin = rope(8, offset=4)
    cos_full, sin_full = precompute_freqs(16, 12)
    torch.testing.assert_close(cos, cos_full[4:12])
    torch.testing.assert_close(sin, sin_full[4:12])


def test_unit_modulus_of_complex_pair():
    cos, sin = precompute_freqs(32, 24)
    # For each frequency slot, cos²+sin² = 1
    mag = cos[:, 0::2] ** 2 + sin[:, 0::2] ** 2
    torch.testing.assert_close(mag, torch.ones_like(mag), atol=1e-5, rtol=1e-5)
    _ = math  # keep import live for reviewers grepping closed-form
