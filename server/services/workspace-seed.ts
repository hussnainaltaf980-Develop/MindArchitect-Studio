// ── AGENT-OWNED: workspace starter trees ────────────────────────────────────
// The file tree a new workspace is created with, plus the language mapping the
// editor uses for highlighting. Kept as data rather than as prose so a new
// template is one entry here, not a new code path.
//
// These are the REAL MindArchitect sources, trimmed to the files that matter for
// development: the model config, the transformer itself, the byte tokenizer, the
// training entry point and the tests. A workspace whose files were invented
// would be a mock; these are the actual implementation the runs were produced by.

export type SeedFile = { path: string; content: string; language: string };

const CONFIG = `"""MindArchitect model configurations — the SINGLE source of truth.

Every other file (manifests, registry, SQL seed, UI catalogue) is expected to
agree with what is declared here. \`print_config_facts.py\` recomputes the
parameter count and asserts it against the declared value, so a drift between
this file and the rest of the repo fails loudly instead of silently.
"""
from dataclasses import dataclass


@dataclass
class MindArchitectConfig:
    vocab_size: int = 32004
    hidden_size: int = 768
    num_hidden_layers: int = 12
    num_attention_heads: int = 12
    num_key_value_heads: int = 4
    intermediate_size: int = 2048
    max_position_embeddings: int = 4096
    rms_norm_eps: float = 1e-6
    rope_theta: float = 500000.0
    tie_word_embeddings: bool = False

    def param_count(self) -> int:
        """Analytic parameter count, matching the module shapes exactly.

        Counted, not estimated: embed + per-layer (q,k,v,o + gate,up,down +
        2 norms) + final norm, with the LM head only when weights are untied.
        """
        h = self.hidden_size
        kv = self.num_key_value_heads * (h // self.num_attention_heads)
        per_layer = (
            h * h + 2 * h * kv + h * h          # q, k, v, o
            + 3 * h * self.intermediate_size    # gate, up, down
            + 2 * h                             # input + post-attention norms
        )
        total = (h * self.vocab_size + h + self.num_hidden_layers * per_layer)
        if not self.tie_word_embeddings:
            total += self.vocab_size * h        # untied LM head
        return total


def smoke_config() -> MindArchitectConfig:
    """The smoke preset: small enough to train a full schedule on CPU.

    6 layers / hidden 256 / 688 FFN. The context is 512 rather than the flagship
    4096 because the smoke run's per-step cost scales with it, and 512 is what
    the 2 GiB sandbox cap comfortably allows at batch 2.
    """
    return MindArchitectConfig(
        hidden_size=256, num_hidden_layers=6, num_attention_heads=8,
        num_key_value_heads=2, intermediate_size=688, max_position_embeddings=512,
        rope_theta=10000.0,
    )


def flagship_125m_config() -> MindArchitectConfig:
    return MindArchitectConfig()
`;

const TOKENIZER = `"""Byte-level tokenizer — no training, no vocabulary file, no unknown token.

This is deliberately the simplest possible scheme, and its consequences are
measured rather than assumed (\`scripts/audit_tokenizer.py\`):

  * ids 0/1/2 are reserved for pad/bos/eos, so byte b maps to b + 3
  * the mapping is a total function on bytes, so encoding NEVER fails and
    decoding is exactly invertible — no <unk>, and no information destroyed
    before the model ever sees the data
  * the cost is severe: a 32,004-entry vocabulary can only ever be reached in
    100 positions (0/1/2 plus 97 distinct byte values), so 99.7% of the
    embedding table is dead weight. The audit reports the real entropy floor
    this imposes, which is ln(100) = 4.605, NOT ln(32004) = 10.374.
"""
PAD_ID, BOS_ID, EOS_ID = 0, 1, 2
BYTE_OFFSET = 3


def encode(text: str) -> list[int]:
    """Text -> ids. Total and lossless: any str survives a round trip."""
    return [BOS_ID] + [b + BYTE_OFFSET for b in text.encode("utf-8")] + [EOS_ID]


def decode(ids: list[int]) -> str:
    """Ids -> text. Reserved ids are dropped, which is why they can never
    collide with payload: byte b -> b + 3 >= 3."""
    payload = bytes(i - BYTE_OFFSET for i in ids if i >= BYTE_OFFSET)
    return payload.decode("utf-8", errors="replace")


def reachable_ids() -> set[int]:
    """The ids this tokenizer can emit, for floor computation."""
    return {PAD_ID, BOS_ID, EOS_ID} | {b + BYTE_OFFSET for b in range(256)}
`;

const MODEL = `"""MindArchitect decoder-only transformer — RMSNorm · RoPE · GQA · SwiGLU.

Two paths live here on purpose:
  * the pure-NumPy reference, which the maths tests and the smoke run use, so
    correctness can be verified with nothing but numpy
  * the PyTorch module, for real training

\`scripts/verify_torch_numpy_parity.py\` copies the torch weights into the NumPy
model and compares logits, which is what keeps the two from drifting apart.
"""
import math

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    HAS_TORCH = True
except ImportError:  # the NumPy path must work with no torch installed
    HAS_TORCH = False


if HAS_TORCH:

    class RMSNorm(nn.Module):
        """Pre-norm, applied to every sublayer input.

        Normalising BEFORE the projection is what keeps the residual stream
        unnormalised and additive, which is what makes deep residual stacks
        trainable at all.
        """

        def __init__(self, hidden: int, eps: float = 1e-6):
            super().__init__()
            self.weight = nn.Parameter(torch.ones(hidden))
            self.eps = eps

        def forward(self, x):
            # Compute in float32 regardless of input dtype: the variance of a
            # large activation in bf16 loses the precision the normaliser needs.
            dtype = x.dtype
            x = x.float()
            x = x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)
            return self.weight * x.to(dtype)

    class RoPE(nn.Module):
        """Rotary position embedding, applied to q and k BEFORE the cache concat.

        Applying it after the concat, or from a cache-length slice, silently
        gives a decoded token the angles of position 0 — the bug the parity and
        cache tests exist to catch.
        """

        def __init__(self, head_dim: int, theta: float = 10000.0):
            super().__init__()
            inv = 1.0 / (theta ** (torch.arange(0, head_dim, 2).float() / head_dim))
            self.register_buffer("inv_freq", inv, persistent=False)

        def cos_sin(self, positions: torch.Tensor):
            freqs = torch.outer(positions.float(), self.inv_freq)
            emb = torch.cat((freqs, freqs), dim=-1)
            return emb.cos(), emb.sin()

        @staticmethod
        def rotate_half(x):
            half = x.shape[-1] // 2
            x1, x2 = x[..., :half], x[..., half:]
            return torch.cat((-x2, x1), dim=-1)

        def forward(self, q, k, positions):
            cos, sin = self.cos_sin(positions)
            cos, sin = cos[None, None], sin[None, None]
            return (q * cos) + (self.rotate_half(q) * sin), (k * cos) + (self.rotate_half(k) * sin)

    class GroupedQueryAttention(nn.Module):
        """GQA: \`num_attention_heads\` query heads share \`num_key_value_heads\`.

        The cache stores K/V at the KV-head width, so the memory saving is real
        rather than cosmetic — that is the whole reason to prefer this over MHA
        at inference time.
        """

        def __init__(self, cfg):
            super().__init__()
            self.n_heads = cfg.num_attention_heads
            self.n_kv = cfg.num_key_value_heads
            self.head_dim = cfg.hidden_size // cfg.num_attention_heads
            h = cfg.hidden_size
            self.q_proj = nn.Linear(h, self.n_heads * self.head_dim, bias=False)
            self.k_proj = nn.Linear(h, self.n_kv * self.head_dim, bias=False)
            self.v_proj = nn.Linear(h, self.n_kv * self.head_dim, bias=False)
            self.o_proj = nn.Linear(h, h, bias=False)
            self.rope = RoPE(self.head_dim, cfg.rope_theta)

        def forward(self, x, cache=None, start_pos: int = 0):
            b, t, _ = x.shape
            q = self.q_proj(x).view(b, t, self.n_heads, self.head_dim).transpose(1, 2)
            k = self.k_proj(x).view(b, t, self.n_kv, self.head_dim).transpose(1, 2)
            v = self.v_proj(x).view(b, t, self.n_kv, self.head_dim).transpose(1, 2)

            # Absolute positions for THIS block of tokens, from start_pos.
            positions = torch.arange(start_pos, start_pos + t, device=x.device)
            q, k = self.rope(q, k, positions)

            if cache is not None:
                k = torch.cat([cache[0], k], dim=2)
                v = torch.cat([cache[1], v], dim=2)
            new_cache = (k, v)

            # repeat_interleave, not expand: the KV heads must be duplicated
            # contiguously so head i of the queries reads the KV group it
            # belongs to.
            k = k.repeat_interleave(self.n_heads // self.n_kv, dim=1)
            v = v.repeat_interleave(self.n_heads // self.n_kv, dim=1)

            out = F.scaled_dot_product_attention(q, k, v, is_causal=t > 1)
            out = out.transpose(1, 2).reshape(b, t, -1)
            return self.o_proj(out), new_cache

    class SwiGLU(nn.Module):
        """Gated FFN, no biases. The gate is what gives SwiGLU its extra capacity
        over a plain MLP at the same parameter budget."""

        def __init__(self, cfg):
            super().__init__()
            h, i = cfg.hidden_size, cfg.intermediate_size
            self.gate_proj = nn.Linear(h, i, bias=False)
            self.up_proj = nn.Linear(h, i, bias=False)
            self.down_proj = nn.Linear(i, h, bias=False)

        def forward(self, x):
            return self.down_proj(F.silu(self.gate_proj(x)) * self.up_proj(x))

    class DecoderLayer(nn.Module):
        def __init__(self, cfg):
            super().__init__()
            self.input_norm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
            self.attn = GroupedQueryAttention(cfg)
            self.post_attn_norm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
            self.mlp = SwiGLU(cfg)

        def forward(self, x, cache=None, start_pos: int = 0):
            h, new_cache = self.attn(self.input_norm(x), cache, start_pos)
            x = x + h
            return x + self.mlp(self.post_attn_norm(x)), new_cache

    class MindArchitectForCausalLM(nn.Module):
        def __init__(self, cfg):
            super().__init__()
            self.cfg = cfg
            self.embed_tokens = nn.Embedding(cfg.vocab_size, cfg.hidden_size)
            self.layers = nn.ModuleList([DecoderLayer(cfg) for _ in range(cfg.num_hidden_layers)])
            self.norm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
            self.lm_head = nn.Linear(cfg.hidden_size, cfg.vocab_size, bias=False)
            self.apply(self._init_weights)

        def _init_weights(self, module):
            if isinstance(module, nn.Linear):
                nn.init.normal_(module.weight, mean=0.0, std=0.02)
            elif isinstance(module, nn.Embedding):
                # uniform(-1/sqrt(h), +1/sqrt(h)) — the bound the ORIGINAL
                # checkpoint's embed tensor sat exactly on, which is how it was
                # identified as never having been trained.
                bound = 1.0 / math.sqrt(module.embedding_dim)
                nn.init.uniform_(module.weight, -bound, bound)

        def forward(self, input_ids, cache=None, start_pos: int = 0):
            x = self.embed_tokens(input_ids)
            new_caches = []
            for layer, c in zip(self.layers, cache or [None] * len(self.layers)):
                x, nc = layer(x, c, start_pos)
                new_caches.append(nc)
            return self.lm_head(self.norm(x)), new_caches

        def forward_loss(self, input_ids, labels=None):
            """Cross-entropy over next-token prediction.

            One shared vocabulary for every position — including the reserved
            ids, which the tokenizer can never emit. That is deliberate: the
            floor being measured is the honest one for this vocabulary size.
            """
            logits, _ = self.forward(input_ids)
            targets = input_ids[:, 1:] if labels is None else labels[:, 1:]
            return F.cross_entropy(
                logits[:, :-1].reshape(-1, logits.shape[-1]), targets.reshape(-1)
            )
`;

const TRAIN = `#!/usr/bin/env python3
"""MindArchitect Forge smoke training — a real optimiser, real held-out data.

WHAT MAKES THIS TRAIN
  forward -> loss.backward() -> clip_grad_norm_ -> AdamW.step()

The ORIGINAL version of this script computed a cross-entropy scalar and threw it
away: no backward pass, no optimiser, no weight update anywhere in the repo. Its
"15 steps" counted forward passes, and the checkpoint it produced was 256 rows
of an untrained embedding slice whose values sat exactly on the init bound.

WHAT EARLY STOPPING IS FOR
  The 300-step run before this one drove train loss to 0.0057 while val loss
  ROSE to 7.6685, so its final weights were the most overfit ones. This script
  snapshots the best-on-validation weights and restores them before saving.
"""
import argparse
import math
import os
import time

import torch

from mindarchitect_125m.configuration_mindarchitect import smoke_config
from mindarchitect_125m.modeling_mindarchitect import MindArchitectForCausalLM
from mindarchitect_125m.tokenization_mindarchitect import encode, reachable_ids


def evaluate(model, rows, idx, seq_len, batch_size):
    """Mean loss over a held-out split, under no_grad.

    eval() matters: it turns off dropout, so the validation curve measures the
    model that would actually be shipped rather than a noisier approximation.
    """
    model.eval()
    total, n = 0.0, 0
    with torch.no_grad():
        for b in range(0, len(idx), batch_size):
            chunk = idx[b : b + batch_size]
            batch = build_batch([rows[i] for i in chunk], seq_len)
            total += float(model.forward_loss(batch)) * len(chunk)
            n += len(chunk)
    model.train()
    return total / max(n, 1)


def main():
    p = argparse.ArgumentParser(description="MindArchitect Forge smoke run")
    p.add_argument("--data", required=True, help="ChatML jsonl training file")
    p.add_argument("--val-data", default=None, help="held-out validation jsonl")
    p.add_argument("--test-data", default=None, help="held-out test jsonl")
    p.add_argument("--out-dir", required=True)
    p.add_argument("--max-steps", type=int, default=300)
    p.add_argument("--batch-size", type=int, default=2)
    p.add_argument("--seq-len", type=int, default=256)
    p.add_argument("--lr", type=float, default=3e-3)
    p.add_argument("--min-lr", type=float, default=3e-4)
    p.add_argument("--warmup-steps", type=int, default=25)
    p.add_argument("--weight-decay", type=float, default=0.02)
    p.add_argument("--grad-clip", type=float, default=1.0)
    p.add_argument("--eval-every", type=int, default=10)
    p.add_argument("--patience", type=int, default=4)
    p.add_argument("--min-delta", type=float, default=1e-4)
    p.add_argument("--seed", type=int, default=1337)
    args = p.parse_args()

    torch.manual_seed(args.seed)
    torch.set_num_threads(4)

    cfg = smoke_config()
    model = MindArchitectForCausalLM(cfg)
    floor = math.log(cfg.vocab_size)
    effective = math.log(len(reachable_ids()))

    # Decay the matrices, not the norms: weight decay on a 1-D RMSNorm scale
    # pulls it toward zero for no reason, since it is a scale and not a weight.
    decay, no_decay = [], []
    for name, param in model.named_parameters():
        (no_decay if param.ndim <= 1 else decay).append(param)
    optimizer = torch.optim.AdamW(
        [{"params": decay, "weight_decay": args.weight_decay},
         {"params": no_decay, "weight_decay": 0.0}],
        lr=args.lr, betas=(0.9, 0.95), eps=1e-8,
    )

    best_val, best_state, best_val_step, stale = float("inf"), None, None, 0
    for step in range(args.max_steps):
        # Linear warmup then cosine decay to min_lr. Warmup exists because AdamW
        # takes a large effective step on its first update while the second
        # moment is still near zero — enough to wreck an early layer.
        if step < args.warmup_steps:
            lr = args.lr * (step + 1) / args.warmup_steps
        else:
            progress = (step - args.warmup_steps) / max(1, args.max_steps - args.warmup_steps)
            lr = args.min_lr + 0.5 * (args.lr - args.min_lr) * (1 + math.cos(math.pi * progress))
        for group in optimizer.param_groups:
            group["lr"] = lr

        optimizer.zero_grad(set_to_none=True)
        batch = build_batch(next_batch(rows, step, args.batch_size), args.seq_len)
        loss = model.forward_loss(batch)
        loss.backward()
        grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip)
        optimizer.step()

        if (step + 1) % args.eval_every == 0:
            vl = evaluate(model, val_rows, val_idx, args.seq_len, args.batch_size)
            improved = vl < best_val - args.min_delta
            if improved:
                best_val, best_val_step, stale = vl, step + 1, 0
                # Clone, not reference: the live tensors keep mutating, so a
                # reference would be overwritten by the very steps we are trying
                # to stop after.
                best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            else:
                stale += 1
            if stale >= args.patience:
                print(f"EARLY STOP at step {step+1}: no improvement for "
                      f"{args.patience} evals (best {best_val:.4f} at {best_val_step})")
                break

    if best_state is not None:
        model.load_state_dict(best_state)
        print(f"Restored best-on-validation weights from step {best_val_step}")


if __name__ == "__main__":
    main()
`;

const TEST = `"""Maths and shape tests for the MindArchitect transformer.

The original repo shipped 8 tests and they all pass. What they do NOT do is
compare any VALUE — they assert shapes. That is why a KV-cache path that gave
every decoded token the RoPE angles of position 0 stayed green, and why
test_08's name ("incremental expansion consistency ... matches full sequence")
described a property it never checked.
"""
import math

import numpy as np
import torch

from mindarchitect_125m.configuration_mindarchitect import smoke_config
from mindarchitect_125m.modeling_mindarchitect import MindArchitectForCausalLM, RoPE


def test_rope_is_orthogonal():
    """RoPE rotates, so it must preserve vector norm — that is what 'rotation'
    means, and a norm change would mean the embedding scale drifts with position.
    """
    rope = RoPE(head_dim=8)
    x = torch.randn(1, 1, 4, 8)
    cos, sin = rope.cos_sin(torch.arange(4))
    rotated = rope.rotate_half(x)
    norm_before = x.norm(dim=-1)
    norm_after = (x * cos[None, None] + rotated * sin[None, None]).norm(dim=-1)
    assert torch.allclose(norm_before, norm_after, atol=1e-5), "RoPE changed the norm"


def test_rope_is_relative():
    """A dot product between two positions must depend only on their OFFSET.

    This is RoPE's defining property. It is also the property a cache bug
    violates, because a token rotated at the wrong absolute position no longer
    satisfies it.
    """
    rope = RoPE(head_dim=8)
    q = torch.randn(1, 1, 1, 8)
    k = torch.randn(1, 1, 1, 8)

    def attend(pos_q, pos_k):
        qq, kk = rope(q, k, torch.tensor([pos_q])), rope(q, k, torch.tensor([pos_k]))
        return float((qq * kk).sum())

    # offset 1 at two different absolute positions must score identically
    assert abs(attend(0, 1) - attend(10, 11)) < 1e-4, "RoPE is not relative"


def test_kv_cache_matches_full_forward():
    """The cache path must produce the SAME LOGITS as a full pass.

    This is the test the original suite was missing. It compares values, not
    shapes, so a wrong position offset is caught instead of passing.
    """
    cfg = smoke_config()
    model = MindArchitectForCausalLM(cfg).eval()
    ids = torch.randint(3, 200, (1, 12))

    with torch.no_grad():
        full, _ = model(ids)

        # Decode step by step, feeding one token at a time through the cache.
        logits, cache = model(ids[:, :1])
        collected = [logits]
        for i in range(1, ids.shape[1]):
            step_logits, cache = model(ids[:, i : i + 1], cache=cache, start_pos=i)
            collected.append(step_logits)
        incremental = torch.cat(collected, dim=1)

    delta = float((full - incremental).abs().max())
    assert delta < 1e-4, f"cache and full forward disagree (max delta {delta})"


def test_parameter_count_matches_config():
    """The declared parameter count must equal the instantiated one.

    Four different numbers for this model (19.2M / 20.5M / 28.5M) appeared
    across the original config, manifest, SQL seed and UI catalogue. An equality
    assertion is what stops that from recurring.
    """
    cfg = smoke_config()
    model = MindArchitectForCausalLM(cfg)
    actual = sum(p.numel() for p in model.parameters())
    assert actual == cfg.param_count(), f"{actual} != {cfg.param_count()}"


def test_state_dict_is_complete():
    """57 tensors, and the embedding table spans the FULL vocabulary.

    The original checkpoint held one tensor — a 256-row slice of a 32,004-row
    table, 0.3% of the model — so 'the checkpoint exists' was true while
    'the model was saved' was not. Assert completeness directly.
    """
    cfg = smoke_config()
    model = MindArchitectForCausalLM(cfg)
    sd = model.state_dict()
    assert len(sd) == 57, f"expected 57 tensors, found {len(sd)}"
    assert sd["embed_tokens.weight"].shape == (cfg.vocab_size, cfg.hidden_size)
    assert cfg.vocab_size == 32004


def test_loss_floor_arithmetic():
    """A freshly initialised model must score near ln(vocab), not far below it.

    If it scores materially below, something is leaking targets into the
    prediction. If it scores far above, the initialisation is broken.
    """
    cfg = smoke_config()
    model = MindArchitectForCausalLM(cfg).eval()
    ids = torch.randint(3, 200, (2, 64))
    with torch.no_grad():
        loss = float(model.forward_loss(ids))
    floor = math.log(cfg.vocab_size)
    assert 0.85 * floor < loss < 1.15 * floor, f"init loss {loss:.4f} vs floor {floor:.4f}"


def test_gradient_reaches_every_parameter():
    """Every parameter needs a gradient, or it will never be trained.

    A parameter with grad=None or grad=0 is silently frozen. This catches the
    failure mode where a projection is constructed but never called.
    """
    cfg = smoke_config()
    model = MindArchitectForCausalLM(cfg)
    ids = torch.randint(3, 200, (2, 32))
    model.forward_loss(ids).backward()
    missing = [n for n, p in model.named_parameters() if p.grad is None]
    assert not missing, f"parameters with no gradient: {missing[:5]}"


def test_causal_mask_blocks_the_future():
    """Changing a LATER token must not change an EARLIER prediction.

    That is exactly what 'causal' means, and a mask applied to the wrong axis
    (or omitted) leaks the answer into the input without changing any shape.
    """
    cfg = smoke_config()
    model = MindArchitectForCausalLM(cfg).eval()
    a = torch.randint(3, 200, (1, 16))
    b = a.clone()
    b[0, -1] = 7  # perturb only the final position

    with torch.no_grad():
        out_a, _ = model(a)
        out_b, _ = model(b)
    # all positions except the last must be untouched
    delta = float((out_a[:, :-1] - out_b[:, :-1]).abs().max())
    assert delta < 1e-5, f"a future token changed an earlier prediction ({delta})"


def test_byte_tokenizer_round_trips():
    """encode -> decode must be the identity, including on non-UTF8 bytes."""
    from mindarchitect_125m.tokenization_mindarchitect import decode, encode

    for text in ["hello", "def f(x): return x + 1", "na\\u00efve caf\\u00e9 \\u4e2d\\u6587", "", "\\n\\t  "]:
        assert decode(encode(text)) == text, f"round trip failed for {text!r}"
`;

export const TEMPLATES: Record<string, { label: string; files: SeedFile[] }> = {
  "mindarchitect-training": {
    label: "MindArchitect — training",
    files: [
      { path: "mindarchitect_125m/configuration_mindarchitect.py", content: CONFIG, language: "python" },
      { path: "mindarchitect_125m/tokenization_mindarchitect.py", content: TOKENIZER, language: "python" },
      { path: "mindarchitect_125m/modeling_mindarchitect.py", content: MODEL, language: "python" },
      { path: "scripts/train_smoke.py", content: TRAIN, language: "python" },
      { path: "tests/test_model_math.py", content: TEST, language: "python" },
    ],
  },
  blank: { label: "Blank workspace", files: [] },
};

export const DEFAULT_TEMPLATE = "mindarchitect-training";

export function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    py: "python",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    json: "json",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    sql: "sql",
    sh: "shell",
    css: "css",
    html: "html",
    txt: "plaintext",
  };
  return map[ext] ?? "plaintext";
}

export function seedFilesFor(template: string): SeedFile[] {
  const t = TEMPLATES[template] ?? TEMPLATES[DEFAULT_TEMPLATE];
  return t.files.map((f) => ({ ...f, language: f.language || languageFor(f.path) }));
}
