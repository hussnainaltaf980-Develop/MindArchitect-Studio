"""Synthetic Forge corpus — generated on-box, no external snapshots."""

from __future__ import annotations

from mindarchitect.tokenizer import ByteTokenizer

SNIPPETS = [
    "def add(a, b):\n    return a + b\n",
    "def relu(x):\n    return x if x > 0 else 0\n",
    "class Node:\n    def __init__(self, v):\n        self.v = v\n        self.next = None\n",
    "SELECT id, tenant_id FROM agent.agent_runs WHERE status = 'running';\n",
    "CREATE INDEX steps_run_order_idx ON agent.agent_steps (run_id, step_index);\n",
    "async def fetch(url):\n    async with httpx.AsyncClient() as c:\n        return await c.get(url)\n",
    "for i, x in enumerate(xs):\n    if x is None:\n        continue\n    yield i, x\n",
    "import torch\nfrom torch import nn\nclass RMSNorm(nn.Module):\n    pass\n",
    "fn main() {\n    let mut s = String::from(\"forge\");\n    s.push_str(\" v5.6\");\n}\n",
    "export function cn(...xs: string[]) {\n    return xs.filter(Boolean).join(\" \");\n}\n",
    "WITH rec AS (\n  SELECT id FROM core.tenants WHERE slug = $1\n) SELECT * FROM rec;\n",
    "def rope(theta, dim):\n    return [theta ** (-2 * i / dim) for i in range(dim // 2)]\n",
    "if err != nil {\n    return fmt.Errorf(\"gqa expand: %w\", err)\n}\n",
    "const FORGE = \"mindarchitect-forge-v5.6\";\nconsole.log(FORGE);\n",
    "def softmax(x):\n    m = max(x)\n    e = [math.exp(v - m) for v in x]\n    s = sum(e)\n    return [v / s for v in e]\n",
]


def build_corpus(tokenizer: ByteTokenizer, seq_len: int, n: int) -> list[list[int]]:
    """Pack snippets into fixed-length sequences with BOS/EOS."""
    stream: list[int] = []
    i = 0
    while len(stream) < n * seq_len:
        piece = SNIPPETS[i % len(SNIPPETS)]
        stream.extend(tokenizer.encode(piece, add_bos=True, add_eos=True))
        i += 1
    rows = []
    for k in range(n):
        chunk = stream[k * seq_len : (k + 1) * seq_len]
        if len(chunk) < seq_len:
            chunk = chunk + [0] * (seq_len - len(chunk))
        rows.append(chunk)
    return rows
