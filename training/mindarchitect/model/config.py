from __future__ import annotations

from dataclasses import dataclass

# Shared with the byte tokenizer reserved-range layout (4 specials + 256 bytes + BPE room).
VOCAB_SIZE_V1 = 32_004


@dataclass(frozen=True)
class ModelConfig:
    """Decoder-only MindArchitect topology.

    Invariants (enforced in ``__post_init__``):
      * ``num_attention_heads * head_dim == hidden_size``
      * ``num_attention_heads % num_key_value_heads == 0``  (GQA)
      * ``intermediate_size > hidden_size``                 (SwiGLU width)
    """

    vocab_size: int = 1024
    hidden_size: int = 256
    intermediate_size: int = 682
    num_layers: int = 6
    num_attention_heads: int = 8
    num_key_value_heads: int = 2
    head_dim: int = 32
    max_seq_len: int = 256
    rope_theta: float = 10000.0
    rms_norm_eps: float = 1e-5
    tie_embeddings: bool = True
    dropout: float = 0.0

    def __post_init__(self) -> None:
        if self.num_attention_heads * self.head_dim != self.hidden_size:
            raise ValueError(
                f"hidden_size {self.hidden_size} != heads {self.num_attention_heads} "
                f"* head_dim {self.head_dim}"
            )
        if self.num_attention_heads % self.num_key_value_heads != 0:
            raise ValueError("num_attention_heads must be divisible by num_key_value_heads")
        if self.intermediate_size <= self.hidden_size:
            raise ValueError("SwiGLU intermediate_size must exceed hidden_size")
        if self.head_dim % 2 != 0:
            raise ValueError("RoPE head_dim must be even")
        if self.vocab_size < 260:
            raise ValueError("vocab_size must cover 4 specials + 256 UTF-8 bytes")

    @property
    def n_rep(self) -> int:
        return self.num_attention_heads // self.num_key_value_heads

    @property
    def kv_dim(self) -> int:
        return self.num_key_value_heads * self.head_dim


# Headless CI sanity runner (~4M). Untied embeddings × vocab 32004 ≈ 4.1M params.
FORGE_SMOKE = ModelConfig(
    vocab_size=VOCAB_SIZE_V1,
    hidden_size=64,
    intermediate_size=160,
    num_layers=2,
    num_attention_heads=4,
    num_key_value_heads=2,
    head_dim=16,
    max_seq_len=128,
    rope_theta=10000.0,
    tie_embeddings=False,
)

# MindArchitect Forge V-5.6 native trunk used for the converged adapter.
FORGE_V56 = ModelConfig(
    vocab_size=512,
    hidden_size=128,
    intermediate_size=384,
    num_layers=6,
    num_attention_heads=8,
    num_key_value_heads=2,
    head_dim=16,
    max_seq_len=128,
    rope_theta=10000.0,
)
