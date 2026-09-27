#!/usr/bin/env python3
"""Retrain Forge Smoke at vocab_size=32004 on a tiny train.jsonl slice.

Writes safetensors + manifest to artifacts/checkpoints/smoke/.
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

import torch
from torch.optim import AdamW

from mindarchitect.export.to_safetensors import export_model
from mindarchitect.model.config import FORGE_SMOKE, VOCAB_SIZE_V1
from mindarchitect.model.transformer import MindArchitectTransformer
from mindarchitect.serving import assert_vocab_aligned
from mindarchitect.tokenizer import ByteTokenizer
from mindarchitect.training.prepare_jsonl import write_train_jsonl

ROOT = Path(__file__).resolve().parents[2]
CKPT_DIR = ROOT / "artifacts" / "checkpoints" / "smoke"
DATA = ROOT / "data" / "sft_verified.jsonl"
ALPACA_JSONL = ROOT / "data" / "train.jsonl"
ALPACA = Path("/workspace/attachments/code_alpaca_20k.json")


def load_rows(tok: ByteTokenizer, seq_len: int, src: Path, limit: int = 64) -> torch.Tensor:
    texts: list[str] = []
    with src.open() as fh:
        for line in fh:
            if not line.strip():
                continue
            rec = json.loads(line)
            texts.append(rec.get("text") or rec.get("messages", [{}])[-1].get("content", ""))
            if len(texts) >= limit:
                break
    stream: list[int] = []
    for t in texts:
        stream.extend(tok.encode(str(t), add_bos=True, add_eos=True))
    need = max(len(stream), seq_len * 16)
    while len(stream) < need:
        stream.extend(stream[:seq_len] or [0] * seq_len)
    rows = [stream[i : i + seq_len] for i in range(0, seq_len * 32, seq_len)]
    return torch.tensor(rows, dtype=torch.long)


def main(steps: int = 24, batch_size: int = 4, seq_len: int = 64, lr: float = 4e-3) -> dict:
    torch.manual_seed(32_004)
    src = DATA if DATA.exists() else ALPACA_JSONL
    if not src.exists():
        n = write_train_jsonl(ALPACA, ALPACA_JSONL, limit=256)
        print(f"prepared train.jsonl rows={n}", flush=True)
        src = ALPACA_JSONL

    cfg = FORGE_SMOKE
    assert cfg.vocab_size == VOCAB_SIZE_V1
    tok = ByteTokenizer(vocab_size=cfg.vocab_size)
    assert_vocab_aligned(tok, cfg)
    data = load_rows(tok, seq_len=seq_len, src=src)
    # Guard: no id outside vocab.
    if int(data.max()) >= cfg.vocab_size:
        raise RuntimeError("train.jsonl produced an id outside vocab_size")

    model = MindArchitectTransformer(cfg)
    n_params = model.param_count()
    opt = AdamW(model.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.01)
    model.train()
    history: list[dict] = []
    t0 = time.time()
    rng = torch.Generator().manual_seed(32004)

    for step in range(1, steps + 1):
        idx = torch.randint(0, data.size(0), (batch_size,), generator=rng)
        loss = model.loss(data[idx])
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        rec = {
            "step": step,
            "loss": round(float(loss.detach()), 4),
            "ppl": round(math.exp(min(20.0, float(loss.detach()))), 3),
        }
        if step == 1 or step % 4 == 0 or step == steps:
            history.append(rec)
            print(f"smoke step={step:03d} loss={rec['loss']:.4f} ppl={rec['ppl']:.3f}", flush=True)

    elapsed = time.time() - t0
    model.eval()
    with torch.no_grad():
        final_loss = float(model.loss(data[:8]))
        final_ppl = math.exp(min(20.0, final_loss))
        logits, _ = model(data[:2, : seq_len - 1])
        acc = float((logits.argmax(-1) == data[:2, 1:seq_len]).float().mean())

    extra = {
        "run": "forge_smoke_v32004",
        "final_loss": round(final_loss, 4),
        "final_ppl": round(final_ppl, 3),
        "token_accuracy": round(acc, 4),
        "steps": steps,
        "elapsed_s": round(elapsed, 2),
        "train_jsonl": str(DATA),
        "vocab_size": cfg.vocab_size,
        "tie_embeddings": cfg.tie_embeddings,
        "history": history,
        "replaces": "vocab-320-smoke",
    }
    manifest = export_model(model, CKPT_DIR, extra_manifest=extra)
    (CKPT_DIR / "metrics.json").write_text(json.dumps(extra | {"param_count": n_params}, indent=2))
    probe = Path("/workspace/src/lib/smoke-probe.json")
    probe.write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"param_count": n_params, **{k: extra[k] for k in ("final_loss", "final_ppl", "vocab_size")}}, indent=2), flush=True)
    return extra | {"param_count": n_params, "manifest": manifest}


if __name__ == "__main__":
    main()
