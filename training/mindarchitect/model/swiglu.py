from __future__ import annotations

import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor


class SwiGLU(nn.Module):
    """SwiGLU FFN: ``silu(x W_g) ⊙ (x W_u) W_d`` (Shazeer, 2020)."""

    def __init__(self, hidden_size: int, intermediate_size: int, dropout: float = 0.0) -> None:
        super().__init__()
        self.gate_proj = nn.Linear(hidden_size, intermediate_size, bias=False)
        self.up_proj = nn.Linear(hidden_size, intermediate_size, bias=False)
        self.down_proj = nn.Linear(intermediate_size, hidden_size, bias=False)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: Tensor) -> Tensor:
        gated = F.silu(self.gate_proj(x)) * self.up_proj(x)
        return self.dropout(self.down_proj(gated))
