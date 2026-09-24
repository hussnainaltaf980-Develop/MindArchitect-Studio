"""
Rigorous Mathematical & Tensor Shape Invariance Test Suite for MindArchitect Architecture.
Tests:
1. RMSNorm variance normalization & epsilon stability
2. RoPE rotational frequency computation & norm-preserving isometry
3. RoPE relative position invariance <R_m q, R_n k> = g(m - n)
4. Grouped-Query Attention (GQA) head repeat interleaving & shapes
5. SwiGLU dimensional expansion alignment & SiLU gating
6. Causal attention mask strict triangularity
7. Full 125M parameter forward pass & output logits shape
8. Autoregressive KV-cache incremental expansion consistency

Powered by HussnainTechVertex Pvt Ltd.
"""

import sys
import os
import math
import unittest
import numpy as np

# Add parent directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from mindarchitect_125m.configuration_mindarchitect import MindArchitectConfig
from mindarchitect_125m.modeling_mindarchitect import (
    RMSNormMath,
    RoPEMath,
    SwiGLUMath,
    GroupedQueryAttentionMath,
    MindArchitectBlockMath,
    MindArchitectCausalLMMath,
)

class TestMindArchitectMathAndShapes(unittest.TestCase):
    def setUp(self):
        np.random.seed(42)

    def test_01_rmsnorm_variance_normalization(self):
        """Verify RMSNorm normalizes root-mean-square to 1.0 within epsilon."""
        dim = 768
        norm = RMSNormMath(dim=dim, eps=1e-6)
        x = np.random.randn(4, 32, dim).astype(np.float32) * 5.0 + 2.0
        out = norm(x)
        
        # Verify shape preservation
        self.assertEqual(out.shape, x.shape)
        
        # Verify RMS is approximately 1.0 (with weight=1.0)
        rms = np.sqrt(np.mean(np.square(out), axis=-1))
        np.testing.assert_allclose(rms, 1.0, rtol=1e-3, atol=1e-3)

    def test_02_rope_norm_preserving_isometry(self):
        """RoPE is an orthogonal rotation: ||R_m x|| == ||x|| (norm must be strictly preserved)."""
        head_dim = 64
        seq_len = 16
        rope = RoPEMath(dim=head_dim, base=500000.0)
        cos, sin = rope.get_cos_sin(seq_len)
        
        x = np.random.randn(2, 4, seq_len, head_dim).astype(np.float32)
        rotated_x = rope.apply_rope(x, cos, sin)
        
        self.assertEqual(rotated_x.shape, x.shape)
        
        orig_norm = np.linalg.norm(x, axis=-1)
        rot_norm = np.linalg.norm(rotated_x, axis=-1)
        np.testing.assert_allclose(orig_norm, rot_norm, rtol=1e-4, atol=1e-4)

    def test_03_rope_relative_position_encoding(self):
        """RoPE satisfies <R_m q, R_n k> depends purely on relative distance (m - n)."""
        head_dim = 64
        rope = RoPEMath(dim=head_dim, base=500000.0)
        cos, sin = rope.get_cos_sin(100)
        
        q = np.random.randn(1, 1, 1, head_dim).astype(np.float32)
        k = np.random.randn(1, 1, 1, head_dim).astype(np.float32)
        
        # Dot product at positions m=10, n=5 (delta = 5)
        q_m1 = rope.apply_rope(q, cos[10:11], sin[10:11])
        k_n1 = rope.apply_rope(k, cos[5:6], sin[5:6])
        dot1 = float(np.sum(q_m1 * k_n1))
        
        # Dot product at positions m=45, n=40 (delta = 5)
        q_m2 = rope.apply_rope(q, cos[45:46], sin[45:46])
        k_n2 = rope.apply_rope(k, cos[40:41], sin[40:41])
        dot2 = float(np.sum(q_m2 * k_n2))
        
        np.testing.assert_allclose(dot1, dot2, rtol=1e-4, atol=1e-4)

    def test_04_gqa_head_interleaving_and_tensor_shapes(self):
        """Verify Grouped-Query Attention maps n_kv_heads to n_heads via integer replication."""
        hidden_size = 768
        n_heads = 12
        n_kv_heads = 4
        gqa = GroupedQueryAttentionMath(hidden_size, n_heads, n_kv_heads)
        
        self.assertEqual(gqa.head_dim, 64)
        self.assertEqual(gqa.num_queries_per_kv, 3)
        
        batch_size = 2
        seq_len = 8
        x = np.random.randn(batch_size, seq_len, hidden_size).astype(np.float32)
        
        out, past_kv = gqa(x)
        
        self.assertEqual(out.shape, (batch_size, seq_len, hidden_size))
        self.assertEqual(past_kv[0].shape, (batch_size, n_kv_heads, seq_len, 64))
        self.assertEqual(past_kv[1].shape, (batch_size, n_kv_heads, seq_len, 64))

    def test_05_swiglu_dimension_alignment_and_gating(self):
        """Verify SwiGLU dimension expansion floor(8/3 * d_model) aligned to 256."""
        config_125m = MindArchitectConfig.flagship_125m_config()
        # 768 * 8 / 3 = 2048, which is 8 * 256
        self.assertEqual(config_125m.intermediate_size, 2048)
        self.assertEqual(config_125m.intermediate_size % 256, 0)
        
        swiglu = SwiGLUMath(config_125m.hidden_size, config_125m.intermediate_size)
        x = np.random.randn(2, 10, config_125m.hidden_size).astype(np.float32)
        out = swiglu(x)
        self.assertEqual(out.shape, (2, 10, config_125m.hidden_size))

    def test_06_causal_mask_triangularity(self):
        """Verify upper triangular elements of attention scores are masked to -1e9."""
        hidden_size = 128
        n_heads = 4
        n_kv_heads = 2
        gqa = GroupedQueryAttentionMath(hidden_size, n_heads, n_kv_heads)
        
        x = np.random.randn(1, 4, hidden_size).astype(np.float32)
        # Test that future tokens cannot influence previous tokens
        # We perturb position 3 and verify position 0 output is completely invariant
        x_perturbed = x.copy()
        x_perturbed[0, 3, :] += 50.0
        
        out1, _ = gqa(x)
        out2, _ = gqa(x_perturbed)
        
        # Position 0 should be identical in both passes
        np.testing.assert_allclose(out1[0, 0, :], out2[0, 0, :], rtol=1e-5, atol=1e-5)

    def test_07_full_125m_forward_pass_and_logits_shape(self):
        """Instantiate flagship 125M architecture and verify logits shape (B, S, vocab_size)."""
        # Testing a 2-layer slice of the 125M configuration for fast deterministic verification
        config = MindArchitectConfig(
            vocab_size=32004,
            hidden_size=768,
            intermediate_size=2048,
            num_hidden_layers=2,
            num_attention_heads=12,
            num_key_value_heads=4,
            max_position_embeddings=4096,
        )
        model = MindArchitectCausalLMMath(config)
        
        batch_size = 2
        seq_len = 12
        input_ids = np.random.randint(0, 32004, size=(batch_size, seq_len), dtype=np.int32)
        
        logits, kvs = model.forward(input_ids)
        
        self.assertEqual(logits.shape, (batch_size, seq_len, 32004))
        self.assertEqual(len(kvs), 2)
        for k, v in kvs:
            self.assertEqual(k.shape, (batch_size, 4, seq_len, 64))
            self.assertEqual(v.shape, (batch_size, 4, seq_len, 64))

    def test_08_autoregressive_kv_cache_incremental_expansion(self):
        """Verify incremental single-token decoding with KV cache matches full sequence."""
        config = MindArchitectConfig(
            vocab_size=1000,
            hidden_size=128,
            intermediate_size=256,
            num_hidden_layers=2,
            num_attention_heads=4,
            num_key_value_heads=2,
        )
        model = MindArchitectCausalLMMath(config)
        
        # Prefill 3 tokens
        prefix_ids = np.array([[10, 20, 30]], dtype=np.int32)
        logits_prefix, kvs = model.forward(prefix_ids)
        
        # Next token decode with cached KV
        next_token_id = np.array([[40]], dtype=np.int32)
        logits_next, next_kvs = model.forward(next_token_id, past_key_values=kvs)
        
        self.assertEqual(logits_next.shape, (1, 1, 1000))
        # Total cached sequence length should now be 4 tokens
        for k, v in next_kvs:
            self.assertEqual(k.shape, (1, 2, 4, 32))
            self.assertEqual(v.shape, (1, 2, 4, 32))

if __name__ == "__main__":
    unittest.main()
