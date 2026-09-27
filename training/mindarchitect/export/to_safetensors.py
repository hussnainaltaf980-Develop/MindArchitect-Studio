"""Export a native decoder checkpoint to safetensors + sidecar config."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import torch
from safetensors.torch import save_file

from mindarchitect.model.config import ModelConfig
from mindarchitect.model.transformer import MindArchitectTransformer


def export_model(
    model: MindArchitectTransformer,
    dest_dir: str | Path,
    *,
    extra_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    cfg: ModelConfig = model.cfg
    state = {k: v.detach().contiguous().cpu() for k, v in model.state_dict().items()}
    save_file(state, str(dest / "model.safetensors"))
    torch.save(
        {"config": cfg.__dict__, "state_dict": {k: v for k, v in state.items()}, "param_count": model.param_count()},
        dest / "model.pt",
    )
    (dest / "config.json").write_text(json.dumps(cfg.__dict__, indent=2))
    manifest = {
        "public_id": "mindarchitect-forge-smoke-4m",
        "display_name": "MindArchitect Forge Smoke (dev 4M)",
        "available": True,
        "status": "available",
        "vocab_size": cfg.vocab_size,
        "param_count": model.param_count(),
        "architecture": "GQA/RoPE/RMSNorm/SwiGLU",
        "native": True,
        "format": "safetensors",
        "checkpoint": str(dest / "model.safetensors"),
        "config": cfg.__dict__,
        **(extra_manifest or {}),
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True, help="directory with model.pt")
    p.add_argument("--dest", required=True)
    args = p.parse_args()
    blob = torch.load(args.src, map_location="cpu", weights_only=False)
    cfg = ModelConfig(**blob["config"])
    model = MindArchitectTransformer(cfg)
    model.load_state_dict(blob["state_dict"])
    print(json.dumps(export_model(model, args.dest), indent=2))
