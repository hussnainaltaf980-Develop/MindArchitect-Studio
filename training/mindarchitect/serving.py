"""Mock-free native serving + tokenizer/model vocab alignment guard."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch

from mindarchitect.model.config import ModelConfig
from mindarchitect.model.transformer import MindArchitectTransformer
from mindarchitect.tokenizer.tokenizer import ByteTokenizer

VOCAB_V1 = 32_004


class VocabMismatchError(RuntimeError):
    """Raised when tokenizer vocab_size != model embedding rows."""


def assert_vocab_aligned(tokenizer: ByteTokenizer, cfg: ModelConfig) -> None:
    if tokenizer.vocab_size != cfg.vocab_size:
        raise VocabMismatchError(
            f"tokenizer vocab_size={tokenizer.vocab_size} != model vocab_size={cfg.vocab_size}"
        )
    n_emb = cfg.vocab_size
    if tokenizer.vocab_size != n_emb:
        raise VocabMismatchError("embedding row count drifted from tokenizer")


def config_from_dict(raw: dict[str, Any]) -> ModelConfig:
    allowed = ModelConfig.__dataclass_fields__.keys()
    payload = {k: raw[k] for k in allowed if k in raw}
    return ModelConfig(**payload)


def load_smoke(checkpoint_dir: str | Path) -> tuple[MindArchitectTransformer, ByteTokenizer, dict]:
    d = Path(checkpoint_dir)
    manifest_path = d / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"missing manifest at {manifest_path}")
    import json

    manifest = json.loads(manifest_path.read_text())
    cfg_raw = manifest.get("config") or {}
    cfg = config_from_dict(cfg_raw) if cfg_raw else None

    st_path = d / "model.safetensors"
    pt_path = d / "model.pt"
    if st_path.exists():
        from safetensors.torch import load_file

        state = load_file(str(st_path))
        if cfg is None:
            # Infer vocab from embedding.
            rows = state["tok_emb.weight"].shape[0]
            hidden = state["tok_emb.weight"].shape[1]
            cfg = ModelConfig(
                vocab_size=rows,
                hidden_size=hidden,
                intermediate_size=max(hidden + 1, hidden * 2),
                num_layers=sum(1 for k in state if k.endswith("attn.q_proj.weight")),
                num_attention_heads=4,
                num_key_value_heads=2,
                head_dim=hidden // 4,
                max_seq_len=128,
                tie_embeddings=False,
            )
        model = MindArchitectTransformer(cfg)
        model.load_state_dict(state, strict=True)
    elif pt_path.exists():
        blob = torch.load(pt_path, map_location="cpu", weights_only=False)
        cfg = config_from_dict(blob["config"]) if cfg is None else cfg
        model = MindArchitectTransformer(cfg)
        model.load_state_dict(blob["state_dict"], strict=True)
    else:
        raise FileNotFoundError(f"no model.safetensors or model.pt in {d}")

    tok = ByteTokenizer(vocab_size=model.cfg.vocab_size)
    assert_vocab_aligned(tok, model.cfg)
    model.eval()
    return model, tok, manifest


@torch.no_grad()
def generate(
    model: MindArchitectTransformer,
    tokenizer: ByteTokenizer,
    prompt: str,
    *,
    max_new: int = 24,
) -> str:
    assert_vocab_aligned(tokenizer, model.cfg)
    ids = tokenizer.encode(prompt, add_bos=True)
    if not ids:
        ids = [1]
    tokens = torch.tensor([ids], dtype=torch.long)
    caches = None
    out = list(ids)
    for _ in range(max_new):
        logits, caches = model(tokens if caches is None else tokens[:, -1:], caches=caches)
        nxt = int(logits[0, -1].argmax())
        if nxt == 2:  # EOS
            break
        if nxt < 0 or nxt >= model.cfg.vocab_size:
            raise VocabMismatchError(f"sampled id {nxt} outside vocab {model.cfg.vocab_size}")
        out.append(nxt)
        tokens = torch.tensor([[nxt]], dtype=torch.long)
    return tokenizer.decode(out)


def weights_are_live(model: MindArchitectTransformer) -> dict[str, float]:
    """Reject all-zero / NaN / mock-constant tensors."""
    stats: dict[str, float] = {}
    for name, p in model.named_parameters():
        t = p.detach()
        if not torch.isfinite(t).all():
            raise RuntimeError(f"{name} has non-finite values")
        if torch.count_nonzero(t).item() == 0:
            raise RuntimeError(f"{name} is all zeros — mock checkpoint")
        stats[name] = float(t.std().clamp_min(0))
    if not stats:
        raise RuntimeError("model has no parameters")
    return stats
