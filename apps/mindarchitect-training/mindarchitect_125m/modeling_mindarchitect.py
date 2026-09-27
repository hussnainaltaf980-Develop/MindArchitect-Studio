"""
MindArchitect Foundation Model Architecture (125M Flagship & Smoke Scales)
Implements: Grouped-Query Attention (GQA), Rotary Position Embeddings (RoPE),
Pre-RMSNorm, SwiGLU Feed-Forward Networks, and Causal Masking.

Provides dual-mode execution:
1. Exact mathematical reference implementation (NumPy/SciPy) for host shape/math tests
2. PyTorch CausalLM module for full GPU acceleration and training convergence
Powered by HussnainTechVertex Pvt Ltd.
"""

import math
from typing import Optional, Tuple, Dict, Any, List
import numpy as np

# ==============================================================================
# Part 1: Exact Mathematical Reference Implementation (NumPy)
# ==============================================================================

class RMSNormMath:
    def __init__(self, dim: int, eps: float = 1e-6):
        self.dim = dim
        self.eps = eps
        self.weight = np.ones(dim, dtype=np.float32)

    def __call__(self, x: np.ndarray) -> np.ndarray:
        # x: (..., dim)
        variance = np.mean(np.square(x), axis=-1, keepdims=True)
        normed = x * (1.0 / np.sqrt(variance + self.eps))
        return normed * self.weight

class RoPEMath:
    def __init__(self, dim: int, max_position_embeddings: int = 4096, base: float = 500000.0):
        self.dim = dim
        self.max_position_embeddings = max_position_embeddings
        self.base = base
        # Calculate inv_freq: base^(-(2i)/dim) for i in 0..dim//2
        half_dim = dim // 2
        self.inv_freq = 1.0 / (base ** (np.arange(0, dim, 2, dtype=np.float32) / dim))

    def get_cos_sin(self, seq_len: int) -> Tuple[np.ndarray, np.ndarray]:
        t = np.arange(seq_len, dtype=np.float32)
        freqs = np.outer(t, self.inv_freq)  # (seq_len, dim // 2)
        emb = np.concatenate([freqs, freqs], axis=-1)  # (seq_len, dim)
        cos = np.cos(emb)
        sin = np.sin(emb)
        return cos, sin

    def rotate_half(self, x: np.ndarray) -> np.ndarray:
        # x: (..., dim)
        half = x.shape[-1] // 2
        x1 = x[..., :half]
        x2 = x[..., half:]
        return np.concatenate([-x2, x1], axis=-1)

    def apply_rope(self, x: np.ndarray, cos: np.ndarray, sin: np.ndarray) -> np.ndarray:
        # x: (batch, n_heads, seq_len, head_dim)
        # cos, sin: (seq_len, head_dim) -> broadcast over batch and n_heads
        cos = cos[np.newaxis, np.newaxis, :, :]
        sin = sin[np.newaxis, np.newaxis, :, :]
        return (x * cos) + (self.rotate_half(x) * sin)

class SwiGLUMath:
    def __init__(self, hidden_size: int, intermediate_size: int):
        self.hidden_size = hidden_size
        self.intermediate_size = intermediate_size
        # Xavier/He uniform initialization
        scale = 1.0 / math.sqrt(hidden_size)
        self.w_gate = np.random.uniform(-scale, scale, (hidden_size, intermediate_size)).astype(np.float32)
        self.w_up = np.random.uniform(-scale, scale, (hidden_size, intermediate_size)).astype(np.float32)
        scale_down = 1.0 / math.sqrt(intermediate_size)
        self.w_down = np.random.uniform(-scale_down, scale_down, (intermediate_size, hidden_size)).astype(np.float32)

    @staticmethod
    def silu(x: np.ndarray) -> np.ndarray:
        return x / (1.0 + np.exp(-np.clip(x, -30.0, 30.0)))

    def __call__(self, x: np.ndarray) -> np.ndarray:
        gate = self.silu(np.matmul(x, self.w_gate))
        up = np.matmul(x, self.w_up)
        return np.matmul(gate * up, self.w_down)

class GroupedQueryAttentionMath:
    def __init__(self, hidden_size: int, n_heads: int, n_kv_heads: int, max_seq_len: int = 4096, rope_base: float = 500000.0):
        self.hidden_size = hidden_size
        self.n_heads = n_heads
        self.n_kv_heads = n_kv_heads
        self.head_dim = hidden_size // n_heads
        self.num_queries_per_kv = n_heads // n_kv_heads
        
        self.rope = RoPEMath(self.head_dim, max_seq_len, rope_base)
        
        scale = 1.0 / math.sqrt(hidden_size)
        self.q_proj = np.random.uniform(-scale, scale, (hidden_size, n_heads * self.head_dim)).astype(np.float32)
        self.k_proj = np.random.uniform(-scale, scale, (hidden_size, n_kv_heads * self.head_dim)).astype(np.float32)
        self.v_proj = np.random.uniform(-scale, scale, (hidden_size, n_kv_heads * self.head_dim)).astype(np.float32)
        self.out_proj = np.random.uniform(-scale, scale, (n_heads * self.head_dim, hidden_size)).astype(np.float32)

    def repeat_kv(self, x: np.ndarray) -> np.ndarray:
        """Repeats KV heads across query head groups for GQA."""
        if self.num_queries_per_kv == 1:
            return x
        # x: (batch, n_kv_heads, seq_len, head_dim)
        return np.repeat(x, self.num_queries_per_kv, axis=1)

    def __call__(self, x: np.ndarray, past_kv: Optional[Tuple[np.ndarray, np.ndarray]] = None) -> Tuple[np.ndarray, Tuple[np.ndarray, np.ndarray]]:
        batch_size, seq_len, _ = x.shape
        
        q = np.matmul(x, self.q_proj).reshape(batch_size, seq_len, self.n_heads, self.head_dim).transpose(0, 2, 1, 3)
        k = np.matmul(x, self.k_proj).reshape(batch_size, seq_len, self.n_kv_heads, self.head_dim).transpose(0, 2, 1, 3)
        v = np.matmul(x, self.v_proj).reshape(batch_size, seq_len, self.n_kv_heads, self.head_dim).transpose(0, 2, 1, 3)
        
        cos, sin = self.rope.get_cos_sin(seq_len)
        q = self.rope.apply_rope(q, cos, sin)
        k = self.rope.apply_rope(k, cos, sin)
        
        if past_kv is not None:
            past_k, past_v = past_kv
            k = np.concatenate([past_k, k], axis=2)
            v = np.concatenate([past_v, v], axis=2)
            
        current_kv = (k, v)
        
        # GQA Repeat interleave
        k_rep = self.repeat_kv(k)
        v_rep = self.repeat_kv(v)
        
        # Scaled dot-product attention
        scores = np.matmul(q, k_rep.transpose(0, 1, 3, 2)) / math.sqrt(self.head_dim)
        
        # Causal mask
        total_kv_len = k_rep.shape[2]
        causal_mask = np.triu(np.full((seq_len, total_kv_len), -1e9, dtype=np.float32), k=total_kv_len - seq_len + 1)
        scores = scores + causal_mask[np.newaxis, np.newaxis, :, :]
        
        # Softmax
        scores_max = np.max(scores, axis=-1, keepdims=True)
        exp_scores = np.exp(scores - scores_max)
        attn_weights = exp_scores / np.sum(exp_scores, axis=-1, keepdims=True)
        
        # Context projection
        context = np.matmul(attn_weights, v_rep).transpose(0, 2, 1, 3).reshape(batch_size, seq_len, -1)
        output = np.matmul(context, self.out_proj)
        
        return output, current_kv

class MindArchitectBlockMath:
    def __init__(self, hidden_size: int, n_heads: int, n_kv_heads: int, intermediate_size: int, rms_eps: float = 1e-6, rope_base: float = 500000.0):
        self.input_layernorm = RMSNormMath(hidden_size, eps=rms_eps)
        self.self_attn = GroupedQueryAttentionMath(hidden_size, n_heads, n_kv_heads, rope_base=rope_base)
        self.post_attention_layernorm = RMSNormMath(hidden_size, eps=rms_eps)
        self.mlp = SwiGLUMath(hidden_size, intermediate_size)

    def __call__(self, x: np.ndarray, past_kv: Optional[Tuple[np.ndarray, np.ndarray]] = None) -> Tuple[np.ndarray, Tuple[np.ndarray, np.ndarray]]:
        # Pre-norm Self Attention with Residual
        normed_attn_in = self.input_layernorm(x)
        attn_out, next_kv = self.self_attn(normed_attn_in, past_kv=past_kv)
        x = x + attn_out
        
        # Pre-norm SwiGLU MLP with Residual
        normed_mlp_in = self.post_attention_layernorm(x)
        mlp_out = self.mlp(normed_mlp_in)
        x = x + mlp_out
        
        return x, next_kv

class MindArchitectCausalLMMath:
    def __init__(self, config):
        self.config = config
        scale = 1.0 / math.sqrt(config.hidden_size)
        self.embed_tokens = np.random.uniform(-scale, scale, (config.vocab_size, config.hidden_size)).astype(np.float32)
        self.layers = [
            MindArchitectBlockMath(
                config.hidden_size,
                config.num_attention_heads,
                config.num_key_value_heads,
                config.intermediate_size,
                rms_eps=config.rms_norm_eps,
                rope_base=config.rope_theta
            )
            for _ in range(config.num_hidden_layers)
        ]
        self.final_norm = RMSNormMath(config.hidden_size, eps=config.rms_norm_eps)
        if config.tie_word_embeddings:
            self.lm_head = self.embed_tokens.T
        else:
            self.lm_head = np.random.uniform(-scale, scale, (config.hidden_size, config.vocab_size)).astype(np.float32)

    def forward(self, input_ids: np.ndarray, past_key_values: Optional[List[Tuple[np.ndarray, np.ndarray]]] = None) -> Tuple[np.ndarray, List[Tuple[np.ndarray, np.ndarray]]]:
        # input_ids: (batch_size, seq_len)
        hidden_states = self.embed_tokens[input_ids]
        
        next_kvs = []
        for i, layer in enumerate(self.layers):
            layer_past = past_key_values[i] if past_key_values is not None else None
            hidden_states, next_kv = layer(hidden_states, past_kv=layer_past)
            next_kvs.append(next_kv)
            
        hidden_states = self.final_norm(hidden_states)
        logits = np.matmul(hidden_states, self.lm_head)
        return logits, next_kvs


# ==============================================================================
# Part 2: PyTorch Accelerated Architecture (Available on GPU/Colab/Server hosts)
# ==============================================================================

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    class PyTorchRMSNorm(nn.Module):
        def __init__(self, dim: int, eps: float = 1e-6):
            super().__init__()
            self.eps = eps
            self.weight = nn.Parameter(torch.ones(dim))

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            variance = x.pow(2).mean(-1, keepdim=True)
            return x * torch.rsqrt(variance + self.eps) * self.weight

    class PyTorchSwiGLU(nn.Module):
        def __init__(self, hidden_size: int, intermediate_size: int):
            super().__init__()
            self.gate_proj = nn.Linear(hidden_size, intermediate_size, bias=False)
            self.up_proj = nn.Linear(hidden_size, intermediate_size, bias=False)
            self.down_proj = nn.Linear(intermediate_size, hidden_size, bias=False)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            return self.down_proj(F.silu(self.gate_proj(x)) * self.up_proj(x))

    class PyTorchMindArchitectAttention(nn.Module):
        def __init__(self, hidden_size: int, n_heads: int, n_kv_heads: int):
            super().__init__()
            self.n_heads = n_heads
            self.n_kv_heads = n_kv_heads
            self.head_dim = hidden_size // n_heads
            self.q_proj = nn.Linear(hidden_size, n_heads * self.head_dim, bias=False)
            self.k_proj = nn.Linear(hidden_size, n_kv_heads * self.head_dim, bias=False)
            self.v_proj = nn.Linear(hidden_size, n_kv_heads * self.head_dim, bias=False)
            self.o_proj = nn.Linear(n_heads * self.head_dim, hidden_size, bias=False)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            B, S, _ = x.shape
            q = self.q_proj(x).view(B, S, self.n_heads, self.head_dim).transpose(1, 2)
            k = self.k_proj(x).view(B, S, self.n_kv_heads, self.head_dim).transpose(1, 2)
            v = self.v_proj(x).view(B, S, self.n_kv_heads, self.head_dim).transpose(1, 2)
            
            if self.n_kv_heads != self.n_heads:
                repeats = self.n_heads // self.n_kv_heads
                k = k.repeat_interleave(repeats, dim=1)
                v = v.repeat_interleave(repeats, dim=1)
                
            scores = torch.matmul(q, k.transpose(-2, -1)) / math.sqrt(self.head_dim)
            causal_mask = torch.triu(torch.full((S, S), float('-inf'), device=x.device), diagonal=1)
            scores = scores + causal_mask
            attn_weights = F.softmax(scores, dim=-1)
            output = torch.matmul(attn_weights, v).transpose(1, 2).contiguous().view(B, S, -1)
            return self.o_proj(output)

    class PyTorchMindArchitectForCausalLM(nn.Module):
        def __init__(self, config):
            super().__init__()
            self.config = config
            self.embed_tokens = nn.Embedding(config.vocab_size, config.hidden_size)
            self.layers = nn.ModuleList([
                nn.ModuleDict({
                    "input_layernorm": PyTorchRMSNorm(config.hidden_size, eps=config.rms_norm_eps),
                    "self_attn": PyTorchMindArchitectAttention(config.hidden_size, config.num_attention_heads, config.num_key_value_heads),
                    "post_attention_layernorm": PyTorchRMSNorm(config.hidden_size, eps=config.rms_norm_eps),
                    "mlp": PyTorchSwiGLU(config.hidden_size, config.intermediate_size)
                })
                for _ in range(config.num_hidden_layers)
            ])
            self.norm = PyTorchRMSNorm(config.hidden_size, eps=config.rms_norm_eps)
            self.lm_head = nn.Linear(config.hidden_size, config.vocab_size, bias=False)

        def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
            x = self.embed_tokens(input_ids)
            for layer in self.layers:
                x = x + layer["self_attn"](layer["input_layernorm"](x))
                x = x + layer["mlp"](layer["post_attention_layernorm"](x))
            x = self.norm(x)
            return self.lm_head(x)

except ImportError:
    pass
