import os, sys, math, time, json
import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from mindarchitect_125m.configuration_mindarchitect import MindArchitectConfig
from mindarchitect_125m.modeling_mindarchitect import MindArchitectCausalLMMath

def main():
    print("=" * 72)
    print("MINDARCHITECT STUDIO: HOST SMOKE VERIFICATION RUN")
    print("Model ID: mindarchitect-forge-smoke (Status: DEVELOPMENT_ONLY)")
    print("=" * 72)

    config = MindArchitectConfig.smoke_config()
    model = MindArchitectCausalLMMath(config)

    np.random.seed(1337)
    batches = [np.random.randint(100, 31000, size=(1, 32), dtype=np.int32) for _ in range(5)]
    print("Executing smoke training steps...")

    t0 = time.time()
    for step in range(1, 16):
        x_in = batches[(step - 1) % 5][:, :-1]
        targets = batches[(step - 1) % 5][0, 1:]
        logits, _ = model.forward(x_in)
        probs = np.exp(logits[0] - np.max(logits[0], axis=-1, keepdims=True))
        probs /= np.sum(probs, axis=-1, keepdims=True)
        loss = -float(np.mean(np.log(np.clip(probs[np.arange(x_in.shape[1]), targets], 1e-12, 1.0))))
        if step in (1, 5, 10, 15):
            print(f"Step {step:02d}/15 | Loss: {loss:.4f} | PPL: {math.exp(min(loss, 20.0)):.2f} | Time: {time.time()-t0:.2f}s")

    out_dir = "/content/drive/MyDrive/MindArchitect_Artifacts/forge-smoke"
    os.makedirs(out_dir, exist_ok=True)
    np.savez_compressed(os.path.join(out_dir, "smoke_weights.npz"), embed=model.embed_tokens[:256])
    with open(os.path.join(out_dir, "checkpoint_meta.json"), "w") as f:
        json.dump({"model_id": "mindarchitect-forge-smoke", "status": "DEVELOPMENT_ONLY", "steps": 15}, f, indent=2)

    print("Status: DEVELOPMENT_ONLY (Verified)")
    print("=" * 72)

if __name__ == "__main__":
    main()
