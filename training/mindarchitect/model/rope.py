"""Rotary Position Embeddings (Su et al., 2021).

Frequencies:  θ_i = base ** (-2i / d)  for i in 0..d/2-1.
A pair (x_{2i}, x_{2i+1}) is rotated by m·θ_i. Relative inner products
depend only on (m-n), which is the RoPE shift-invariance property.
"""

from __future__ import annotations

import torch
from torch import Tensor, nn


def precompute_freqs(
    head_dim: int,
    seq_len: int,
    theta: float = 10000.0,
    scale: float = 1.0,
    *,
    device: torch.device | None = None,
    dtype: torch.dtype = torch.float32,
) -> tuple[Tensor, Tensor]:
    """Return ``cos, sin`` of shape ``(seq_len, head_dim)``.

    ``scale`` > 1 linearly compresses positions (context extrapolation):
    the angle at index t becomes ``(t / scale) * θ``.
    """
    if head_dim % 2 != 0:
        raise ValueError("head_dim must be even for RoPE")
    inv_freq = 1.0 / (
        theta ** (torch.arange(0, head_dim, 2, device=device, dtype=torch.float32) / head_dim)
    )
    t = torch.arange(seq_len, device=device, dtype=torch.float32) / scale
    freqs = torch.outer(t, inv_freq)  # (S, D/2)
    # Llama even/odd pairing: θ_i is shared by dimensions (2i, 2i+1)
    emb = freqs.repeat_interleave(2, dim=-1)  # (S, D)
    return emb.cos().to(dtype=dtype), emb.sin().to(dtype=dtype)


def rotate_half(x: Tensor) -> Tensor:
    """Map (x_even, x_odd) → (-x_odd, x_even) — the 2-D rotation companion."""
    even, odd = x[..., ::2], x[..., 1::2]
    return torch.stack((-odd, even), dim=-1).flatten(-2)


def apply_rotary_emb(x: Tensor, cos: Tensor, sin: Tensor) -> Tensor:
    """Rotate ``x`` of shape (..., S, D) by the (S, D) cos/sin tables."""
    # Broadcast cos/sin across any leading batch / head dims.
    if cos.ndim == 2 and x.ndim == 4:
        # x: (B, S, H, D)  cos/sin: (S, D)
        cos = cos[None, :, None, :]
        sin = sin[None, :, None, :]
    elif cos.ndim < x.ndim:
        while cos.ndim < x.ndim:
            cos = cos.unsqueeze(0)
            sin = sin.unsqueeze(0)
    return (x * cos) + (rotate_half(x) * sin)


class RotaryEmbedding(nn.Module):
    def __init__(
        self,
        head_dim: int,
        max_seq_len: int = 2048,
        theta: float = 10000.0,
    ) -> None:
        super().__init__()
        self.head_dim = head_dim
        self.theta = float(theta)
        self.max_seq_len = max_seq_len
        cos, sin = precompute_freqs(head_dim, max_seq_len, theta)
        self.register_buffer("cos_cached", cos, persistent=False)
        self.register_buffer("sin_cached", sin, persistent=False)

    def forward(self, seq_len: int, offset: int = 0, scale: float = 1.0) -> tuple[Tensor, Tensor]:
        end = offset + seq_len
        if scale != 1.0 or end > self.cos_cached.shape[0]:
            return precompute_freqs(
                self.head_dim,
                end,
                self.theta,
                scale=scale,
                device=self.cos_cached.device,
                dtype=self.cos_cached.dtype,
            )
        return self.cos_cached[offset:end], self.sin_cached[offset:end]
