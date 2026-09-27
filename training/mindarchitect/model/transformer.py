from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor

from .config import ModelConfig
from .gqa import GroupedQueryAttention
from .rmsnorm import RMSNorm
from .swiglu import SwiGLU


class DecoderBlock(nn.Module):
    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        self.attn_norm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
        self.attn = GroupedQueryAttention(
            hidden_size=cfg.hidden_size,
            num_heads=cfg.num_attention_heads,
            num_kv_heads=cfg.num_key_value_heads,
            head_dim=cfg.head_dim,
            rope_theta=cfg.rope_theta,
            max_seq_len=cfg.max_seq_len,
            dropout=cfg.dropout,
        )
        self.ffn_norm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
        self.ffn = SwiGLU(cfg.hidden_size, cfg.intermediate_size, cfg.dropout)

    def forward(
        self, x: Tensor, cache: tuple[Tensor, Tensor] | None = None
    ) -> tuple[Tensor, tuple[Tensor, Tensor]]:
        h, cache = self.attn(self.attn_norm(x), cache=cache)
        x = x + h
        x = x + self.ffn(self.ffn_norm(x))
        return x, cache


class MindArchitectTransformer(nn.Module):
    """Native causal decoder. Weights start at random — never loaded from an external base."""

    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self.tok_emb = nn.Embedding(cfg.vocab_size, cfg.hidden_size)
        self.blocks = nn.ModuleList([DecoderBlock(cfg) for _ in range(cfg.num_layers)])
        self.final_norm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
        self.lm_head = nn.Linear(cfg.hidden_size, cfg.vocab_size, bias=False)
        if cfg.tie_embeddings:
            self.lm_head.weight = self.tok_emb.weight
        self.apply(self._init_weights)

    @staticmethod
    def _init_weights(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            nn.init.trunc_normal_(module.weight, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.trunc_normal_(module.weight, std=0.02)

    def param_count(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def forward(
        self,
        tokens: Tensor,
        *,
        caches: list[tuple[Tensor, Tensor] | None] | None = None,
    ) -> tuple[Tensor, list[tuple[Tensor, Tensor]]]:
        """Return ``(logits (B,S,V), layer_caches)``."""
        x = self.tok_emb(tokens)
        new_caches: list[tuple[Tensor, Tensor]] = []
        for i, block in enumerate(self.blocks):
            cache = None if caches is None else caches[i]
            x, cache = block(x, cache=cache)
            new_caches.append(cache)
        logits = self.lm_head(self.final_norm(x))
        return logits, new_caches

    def loss(self, tokens: Tensor, chunk: int = 512) -> Tensor:
        """Next-token cross-entropy. ``tokens`` is (B, S); predicts S-1 steps.

        The vocabulary projection is chunked along the *token* axis. Building the
        full logits tensor costs ``B * S * vocab_size * 4`` bytes — at B=1,
        S=1536, vocab=32004 that is ~197 MB, and autograd retains a same-sized
        gradient for every one, which is what OOM-killed the long-context runs
        under this sandbox's 2 GiB cgroup cap. Chunking bounds the peak at
        ``chunk * vocab_size * 4`` while leaving the arithmetic identical: each
        chunk contributes a summed loss and the total is divided by the token
        count, so the gradient is still the exact mean over tokens.
        """
        x = self.tok_emb(tokens[:, :-1])
        x, _ = self._run_blocks(x, None)
        flat = self.final_norm(x).reshape(-1, self.tok_emb.embedding_dim)
        target = tokens[:, 1:].reshape(-1)
        n_tokens = flat.size(0)
        if n_tokens == 0:  # pragma: no cover - guarded by callers
            return F.cross_entropy(self.lm_head(flat), target)
        step = max(1, min(chunk, n_tokens))
        total: Tensor | None = None
        for start in range(0, n_tokens, step):
            piece = self.lm_head(flat[start : start + step])
            piece_loss = F.cross_entropy(
                piece, target[start : start + step], reduction="sum"
            )
            total = piece_loss if total is None else total + piece_loss
        return total / n_tokens

    def _run_blocks(
        self, x: Tensor, caches: list[tuple[Tensor, Tensor] | None] | None
    ) -> tuple[Tensor, list[tuple[Tensor, Tensor]]]:
        """Run the decoder stack, optionally against a per-layer KV cache."""
        new_caches: list[tuple[Tensor, Tensor]] = []
        for i, block in enumerate(self.blocks):
            cache = None if caches is None else caches[i]
            x, cache = block(x, cache=cache)
            new_caches.append(cache)
        return x, new_caches
