"""Grouped-Query Attention (Ainslie et al., 2023).

Query heads = H, key/value heads = K, with H % K == 0. Each KV head is
repeated ``H/K`` times so the attention scores stay (B, H, S, S).
"""

from __future__ import annotations

import math

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor

from .rope import RotaryEmbedding, apply_rotary_emb


def expand_kv(kv: Tensor, n_rep: int) -> Tensor:
    """(B, S, K, D) → (B, S, H, D) by repeating each KV head ``n_rep`` times."""
    if n_rep == 1:
        return kv
    b, s, k, d = kv.shape
    return kv[:, :, :, None, :].expand(b, s, k, n_rep, d).reshape(b, s, k * n_rep, d)


def causal_mask(q_len: int, k_len: int, device: torch.device, dtype: torch.dtype) -> Tensor:
    """Lower-triangular mask of shape (1, 1, Q, K) with 0 / -inf.

    When decoding with a KV cache, ``k_len >= q_len`` and the query occupies
    the last ``q_len`` key positions.
    """
    q_idx = torch.arange(q_len, device=device)[:, None]
    k_idx = torch.arange(k_len, device=device)[None, :]
    # Queries sit at positions [k_len - q_len, k_len)
    q_pos = k_idx.new_tensor(k_len - q_len) + q_idx
    allowed = k_idx <= q_pos
    mask = torch.zeros(q_len, k_len, device=device, dtype=dtype)
    mask = mask.masked_fill(~allowed, torch.finfo(dtype).min)
    return mask.view(1, 1, q_len, k_len)


class GroupedQueryAttention(nn.Module):
    def __init__(
        self,
        hidden_size: int,
        num_heads: int,
        num_kv_heads: int,
        head_dim: int,
        rope_theta: float = 10000.0,
        max_seq_len: int = 2048,
        dropout: float = 0.0,
    ) -> None:
        super().__init__()
        if num_heads % num_kv_heads != 0:
            raise ValueError("GQA requires num_heads % num_kv_heads == 0")
        self.num_heads = num_heads
        self.num_kv_heads = num_kv_heads
        self.head_dim = head_dim
        self.n_rep = num_heads // num_kv_heads
        self.scale = 1.0 / math.sqrt(head_dim)

        self.q_proj = nn.Linear(hidden_size, num_heads * head_dim, bias=False)
        self.k_proj = nn.Linear(hidden_size, num_kv_heads * head_dim, bias=False)
        self.v_proj = nn.Linear(hidden_size, num_kv_heads * head_dim, bias=False)
        self.o_proj = nn.Linear(num_heads * head_dim, hidden_size, bias=False)
        self.rope = RotaryEmbedding(head_dim, max_seq_len=max_seq_len, theta=rope_theta)
        self.attn_drop = nn.Dropout(dropout)

    def forward(
        self,
        x: Tensor,
        *,
        cache: tuple[Tensor, Tensor] | None = None,
        freqs: tuple[Tensor, Tensor] | None = None,
    ) -> tuple[Tensor, tuple[Tensor, Tensor]]:
        b, s, _ = x.shape
        q = self.q_proj(x).view(b, s, self.num_heads, self.head_dim)
        k = self.k_proj(x).view(b, s, self.num_kv_heads, self.head_dim)
        v = self.v_proj(x).view(b, s, self.num_kv_heads, self.head_dim)

        offset = 0 if cache is None else cache[0].shape[1]
        if freqs is None:
            cos, sin = self.rope(s, offset=offset)
        else:
            cos, sin = freqs
        # cos/sin: (S, D) — apply along the sequence axis of (B, S, H, D)
        q = apply_rotary_emb(q, cos, sin)
        k = apply_rotary_emb(k, cos, sin)

        if cache is not None:
            k = torch.cat([cache[0], k], dim=1)
            v = torch.cat([cache[1], v], dim=1)
        new_cache = (k, v)

        k_exp = expand_kv(k, self.n_rep)
        v_exp = expand_kv(v, self.n_rep)

        # (B, H, S_q, D) @ (B, H, D, S_k)
        q_h = q.permute(0, 2, 1, 3)
        k_h = k_exp.permute(0, 2, 3, 1)
        v_h = v_exp.permute(0, 2, 1, 3)
        scores = torch.matmul(q_h, k_h) * self.scale
        scores = scores + causal_mask(q_h.shape[2], k_h.shape[3], scores.device, scores.dtype)
        attn = self.attn_drop(F.softmax(scores, dim=-1, dtype=torch.float32).to(q.dtype))
        ctx = torch.matmul(attn, v_h).permute(0, 2, 1, 3).contiguous()
        out = self.o_proj(ctx.view(b, s, self.num_heads * self.head_dim))
        return out, new_cache
