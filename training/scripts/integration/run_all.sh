#!/usr/bin/env bash
# Seven integration scripts for the 32004-vocab smoke checkpoint.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
cd "$ROOT"
echo "[integration] pytest tests/integration"
python3 -m pytest -q tests/integration
echo "[integration] pglite registry"
node scripts/integration/pglite_registry.mjs
echo "[integration] all green"
