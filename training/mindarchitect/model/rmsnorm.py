from __future__ import annotations

import torch
from torch import Tensor, nn


class RMSNorm(nn.Module):
    """Root-mean-square normalisation (Zhang & Sennrich, 2019). No mean centering."""

    def __init__(self, dim: int, eps: float = 1e-5) -> None:
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x: Tensor) -> Tensor:
        orig_dtype = x.dtype
        x32 = x.float()
        rms = torch.rsqrt(x32.pow(2).mean(dim=-1, keepdim=True) + self.eps)
        return (x32 * rms * self.weight.float()).to(orig_dtype)
