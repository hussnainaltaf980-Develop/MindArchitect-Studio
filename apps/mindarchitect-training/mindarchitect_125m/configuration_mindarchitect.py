"""
Configuration class for MindArchitect 125M Foundation Architecture.
Powered by HussnainTechVertex Pvt Ltd.
"""

from typing import Optional, Dict, Any

class MindArchitectConfig:
    def __init__(
        self,
        vocab_size: int = 32004,
        hidden_size: int = 768,
        intermediate_size: Optional[int] = None,
        num_hidden_layers: int = 12,
        num_attention_heads: int = 12,
        num_key_value_heads: int = 4,
        max_position_embeddings: int = 4096,
        rope_theta: float = 500000.0,
        rms_norm_eps: float = 1e-6,
        initializer_range: float = 0.02,
        tie_word_embeddings: bool = False,
        **kwargs
    ):
        self.vocab_size = vocab_size
        self.hidden_size = hidden_size
        self.head_dim = hidden_size // num_attention_heads
        
        # Calculate SwiGLU hidden dim if not explicitly provided: floor(8/3 * hidden_size) aligned to 256
        if intermediate_size is None:
            raw_ff = int(8 * hidden_size / 3)
            # Align to multiple of 256
            self.intermediate_size = ((raw_ff + 255) // 256) * 256
        else:
            self.intermediate_size = intermediate_size

        self.num_hidden_layers = num_hidden_layers
        self.num_attention_heads = num_attention_heads
        self.num_key_value_heads = num_key_value_heads
        self.max_position_embeddings = max_position_embeddings
        self.rope_theta = rope_theta
        self.rms_norm_eps = rms_norm_eps
        self.initializer_range = initializer_range
        self.tie_word_embeddings = tie_word_embeddings
        
        for k, v in kwargs.items():
            setattr(self, k, v)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "vocab_size": self.vocab_size,
            "hidden_size": self.hidden_size,
            "head_dim": self.head_dim,
            "intermediate_size": self.intermediate_size,
            "num_hidden_layers": self.num_hidden_layers,
            "num_attention_heads": self.num_attention_heads,
            "num_key_value_heads": self.num_key_value_heads,
            "max_position_embeddings": self.max_position_embeddings,
            "rope_theta": self.rope_theta,
            "rms_norm_eps": self.rms_norm_eps,
            "initializer_range": self.initializer_range,
            "tie_word_embeddings": self.tie_word_embeddings,
        }

    @classmethod
    def smoke_config(cls) -> "MindArchitectConfig":
        """Small ~28.5M configuration designed for CPU host verification."""
        return cls(
            vocab_size=32004,
            hidden_size=256,
            intermediate_size=688,
            num_hidden_layers=6,
            num_attention_heads=8,
            num_key_value_heads=2,
            max_position_embeddings=512,
            rope_theta=10000.0,
            rms_norm_eps=1e-5,
        )

    @classmethod
    def flagship_125m_config(cls) -> "MindArchitectConfig":
        """125M Flagship Base configuration."""
        return cls(
            vocab_size=32004,
            hidden_size=768,
            intermediate_size=2048,
            num_hidden_layers=12,
            num_attention_heads=12,
            num_key_value_heads=4,
            max_position_embeddings=4096,
            rope_theta=500000.0,
            rms_norm_eps=1e-6,
        )
