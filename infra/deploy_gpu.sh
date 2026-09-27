#!/usr/bin/env bash
# ==============================================================================
# MindArchitect Studio: Turnkey GPU Deployment & Convergence Harness
# Target: NVIDIA RTX A6000 (48GB VRAM) / A100 / H100
# Powered by HussnainTechVertex Pvt Ltd
# ==============================================================================

set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

MODE="${1:-turnkey}" # 'train', 'serve', 'smoke', 'turnkey'
CHECKPOINT_DIR="${CHECKPOINT_DIR:-/models/checkpoints/forge_v5_6}"
DATASET_PATH="${DATASET_PATH:-${PROJECT_ROOT}/data/synthetic/forge_synthetic_instructions.jsonl}"
PORT="${PORT:-8000}"

echo "========================================================================"
echo "   __  __ _           _    ____      ____     _  _     _               "
echo "  |  \/  (_)_ __   __| |  / /\ \    / ___|___| || |   / \   _ __ ___  "
echo "  | |\/| | | '_ \ / _\` | / /  \ \  | |   / _ \ || |_ / _ \ | '_ \` _ \ "
echo "  | |  | | | | | | (_| |/ /    \ \ | |__|  __/_  _// ___ \| | | | | |"
echo "  |_|  |_|_|_| |_|\__,_/_/      \_\ \____\___| |_| /_/   \_\_| |_| |_|"
echo "========================================================================"
echo "HussnainTechVertex Pvt Ltd - Sovereign AI Engineering Infrastructure"
echo "Target Model: MindArchitect Forge V-5.6 (Codex 5.6 Counter)"
echo "Selected Execution Mode: [${MODE}]"
echo "========================================================================"

check_gpu() {
    echo "==> Verifying GPU Hardware Acceleration..."
    if command -v nvidia-smi &> /dev/null; then
        nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
        echo "CUDA Acceleration detected."
    else
        echo "[WARNING] nvidia-smi not detected. Proceeding in emulation mode."
    fi
}

run_train() {
    echo "==> [Task 3 Option B] Initiating Forge V-5.6 Production Training Pipeline..."
    python3 ${PROJECT_ROOT}/apps/mindarchitect-training/scripts/generate_synthetic_data.py
    
    python3 ${PROJECT_ROOT}/apps/mindarchitect-training/scripts/train_forge_v5_6.py \
        --dataset "${DATASET_PATH}" \
        --output-dir "${CHECKPOINT_DIR}" \
        --max-steps 2000

    echo "==> [Task 3 Option B] Registering Converged Flagship Checkpoint..."
    python3 ${PROJECT_ROOT}/apps/mindarchitect-training/scripts/register_checkpoint.py \
        --model-id mindarchitect-forge-v5.6 \
        --checkpoint-path "${CHECKPOINT_DIR}" \
        --status ACTIVE \
        --param-scale "7B/14B MoE" \
        --series "V-Series"
    echo "==> Checkpoint status transitioned from CHECKPOINT_REQUIRED to ACTIVE."
}

run_serve() {
    echo "==> Launching vLLM Low-Latency Real-Time Inference Daemon on Port ${PORT}..."
    if [ ! -d "${CHECKPOINT_DIR}" ]; then
        echo "[ALERT] Checkpoint directory not found at ${CHECKPOINT_DIR}."
        echo "        Note: In accordance with registry rules, model status remains CHECKPOINT_REQUIRED."
        echo "        Starting API Gateway in staging mode..."
    fi

    # Launch vLLM server with PagedAttention and Dynamic Prefix Caching
    exec python3 -m vllm.entrypoints.openai.api_server \
        --model "${CHECKPOINT_DIR}" \
        --served-model-name "mindarchitect-forge-v5.6" \
        --max-model-len 16384 \
        --gpu-memory-utilization 0.92 \
        --enable-prefix-caching \
        --port "${PORT}"
}

run_smoke() {
    echo "==> Running Host Smoke Verification..."
    python3 ${PROJECT_ROOT}/apps/mindarchitect-training/scripts/train_smoke.py
}

check_gpu

case "${MODE}" in
    train)
        run_train
        ;;
    serve)
        run_serve
        ;;
    smoke)
        run_smoke
        ;;
    turnkey)
        run_train
        run_serve
        ;;
    *)
        echo "Unknown mode: ${MODE}. Usage: $0 [train|serve|smoke|turnkey]"
        exit 1
        ;;
esac
