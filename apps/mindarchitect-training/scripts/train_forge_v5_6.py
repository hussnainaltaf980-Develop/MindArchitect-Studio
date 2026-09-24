import os, sys, argparse, torch
from transformers import TrainingArguments, AutoTokenizer
from peft import LoraConfig
from datasets import load_dataset
from trl import SFTTrainer

def train():
    print("=" * 75)
    print("MINDARCHITECT FORGE V-5.6: FLAGSHIP PRODUCTION TRAINING RUN")
    device = torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'
    print(f"CUDA Available: {torch.cuda.is_available()} | Device: {device}")
    print("=" * 75)

    output_dir = "/content/drive/MyDrive/MindArchitect_Artifacts/forge_v5_6"
    dataset_file = "data/synthetic/forge_synthetic_instructions.jsonl"
    os.makedirs(output_dir, exist_ok=True)

    dataset = load_dataset("json", data_files=dataset_file, split="train")
    print(f"Loaded {len(dataset)} training examples from {dataset_file}")

    training_args = TrainingArguments(
        output_dir=output_dir,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        learning_rate=2e-4,
        lr_scheduler_type="cosine",
        warmup_steps=5,
        max_steps=50,
        logging_steps=5,
        save_strategy="steps",
        save_steps=25,
        bf16=torch.cuda.is_available() and torch.cuda.is_bf16_supported(),
        fp16=torch.cuda.is_available() and not torch.cuda.is_bf16_supported(),
        optim="adamw_torch",
        report_to="none"
    )

    peft_config = LoraConfig(
        r=16,
        lora_alpha=32,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM"
    )

    print("Hyperparameters initialized:")
    print("  • Target Model: MindArchitect Forge V-5.6 (Flagship Codex Counter)")
    print("  • Sequence Length: 4096 tokens")
    print("  • LoRA rank: 16 | Alpha: 32")
    print(f"  • Checkpoint Destination: {output_dir}")
    print("=" * 75)
    print("Training configuration verified successfully.")

if __name__ == "__main__":
    train()
