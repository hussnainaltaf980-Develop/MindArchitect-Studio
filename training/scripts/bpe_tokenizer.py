"""MindArchitect BPE tokenizer — trained on the real instruction corpus.

Why this exists
---------------
The shipped tokenizer (`mindarchitect/tokenizer/tokenizer.py`) is *byte-level*:
id 0..3 are specials and id = byte + 4 for the 256 UTF-8 bytes, i.e. only ids
``4..259`` are ever produced. Against the model's declared ``vocab_size = 32_004``
that leaves **31 744 ids unreachable (99.19 %)**, so the `ln(32004) = 10.3736`
"random-guess floor" the training script quotes is not the floor this tokenizer
imposes — the real one is `ln(100) = 4.6052`.

This module trains a real byte-level BPE over the instruction corpus at the same
declared vocab size, then measures:

  * reachable-id count and vocabulary coverage
  * the random-guess floor `ln(V_reachable)` in nats/token
  * empirical unigram and bigram conditional entropy of the token stream
  * bytes-per-token and the resulting **bits per byte** ceiling

The bits/byte number is the only fair way to compare the two tokenizers: BPE
trades a *higher* nats/token floor for far fewer tokens per text, which is a
strict win per byte.

Usage
-----
    python3 -m scripts.bpe_tokenizer --vocab-size 32004 --out-dir data
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from tokenizers import Tokenizer, decoders, models, pre_tokenizers, trainers

# Matches mindarchitect/tokenizer/tokenizer.py so PAD/BOS/EOS/UNK keep their ids.
SPECIALS = ["<pad>", "<bos>", "<eos>", "<unk>"]
PAD, BOS, EOS, UNK = 0, 1, 2, 3
BYTE_OFFSET = 4
LN2 = math.log(2.0)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = REPO_ROOT / "data"
SPLITS = ("train.jsonl", "validation.jsonl", "test.jsonl")


# --------------------------------------------------------------------------- #
# Corpus
# --------------------------------------------------------------------------- #
def render_example(row: dict) -> str:
    """Deterministic instruction/response rendering for both corpus schemas."""
    if "text" in row and isinstance(row["text"], str):
        return row["text"]
    instruction = str(row.get("instruction", "")).strip()
    response = str(row.get("response", row.get("output", ""))).strip()
    parts = ["### Instruction", instruction]
    if row.get("input"):
        parts += ["", "### Input", str(row["input"]).strip()]
    parts += ["", "### Response", response, ""]
    return "\n".join(parts)


def load_splits(data_dir: Path) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for name in SPLITS:
        path = data_dir / name
        if not path.exists():
            continue
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                row["_text"] = render_example(row)
                rows.append(row)
        out[name.replace(".jsonl", "")] = rows
    return out


def all_texts(splits: dict[str, list[dict]]) -> list[str]:
    return [r["_text"] for rows in splits.values() for r in rows]


# --------------------------------------------------------------------------- #
# Entropy maths
# --------------------------------------------------------------------------- #
def unigram_entropy(stream: list[int]) -> float:
    n = len(stream)
    if n == 0:
        return 0.0
    counts = Counter(stream)
    return -sum((c / n) * math.log(c / n) for c in counts.values())


def bigram_conditional_entropy(stream: list[int]) -> float:
    """H(next | prev) in nats — the ceiling for a first-order model."""
    if len(stream) < 2:
        return 0.0
    pairs = Counter(zip(stream, stream[1:]))
    prev = Counter(stream[:-1])
    total = len(stream) - 1
    return -sum(
        (c / total) * math.log(c / prev[a]) for (a, _b), c in pairs.items() if prev[a]
    )


@dataclass
class TokenizerMetrics:
    label: str
    vocab_size: int
    reachable_ids: int
    total_tokens: int
    total_bytes: int
    n_examples: int
    unigram_nats: float
    bigram_nats: float
    lengths: list[int] = field(default_factory=list)

    @property
    def bytes_per_token(self) -> float:
        return self.total_bytes / self.total_tokens if self.total_tokens else 0.0

    @property
    def random_floor_nats(self) -> float:
        return math.log(self.reachable_ids) if self.reachable_ids else 0.0

    @property
    def unigram_bits_per_token(self) -> float:
        return self.unigram_nats / LN2

    @property
    def bigram_bits_per_token(self) -> float:
        return self.bigram_nats / LN2

    @property
    def unigram_bits_per_byte(self) -> float:
        b = self.bytes_per_token
        return self.unigram_bits_per_token / b if b else 0.0

    @property
    def bigram_bits_per_byte(self) -> float:
        b = self.bytes_per_token
        return self.bigram_bits_per_token / b if b else 0.0

    @property
    def dead_slots(self) -> int:
        return self.vocab_size - self.reachable_ids

    @property
    def reachable_pct(self) -> float:
        return 100.0 * self.reachable_ids / self.vocab_size if self.vocab_size else 0.0

    def percentiles(self) -> dict[str, float]:
        if not self.lengths:
            return {}
        s = sorted(self.lengths)
        def pct(p: float) -> float:
            idx = min(len(s) - 1, max(0, int(round(p / 100 * (len(s) - 1)))))
            return float(s[idx])
        return {
            "min": float(s[0]),
            "p50": pct(50),
            "p90": pct(90),
            "p99": pct(99),
            "max": float(s[-1]),
            "mean": sum(s) / len(s),
        }

    def as_dict(self) -> dict:
        return {
            "label": self.label,
            "vocab_size": self.vocab_size,
            "reachable_ids": self.reachable_ids,
            "reachable_pct": round(self.reachable_pct, 4),
            "dead_vocabulary_slots": self.dead_slots,
            "dead_pct": round(100.0 - self.reachable_pct, 4),
            "n_examples": self.n_examples,
            "total_tokens": self.total_tokens,
            "total_bytes": self.total_bytes,
            "bytes_per_token": round(self.bytes_per_token, 4),
            "random_floor_nats_per_token": round(self.random_floor_nats, 6),
            "unigram_nats_per_token": round(self.unigram_nats, 6),
            "bigram_nats_per_token": round(self.bigram_nats, 6),
            "unigram_bits_per_byte": round(self.unigram_bits_per_byte, 6),
            "bigram_bits_per_byte": round(self.bigram_bits_per_byte, 6),
            "token_length_percentiles": self.percentiles(),
        }


# --------------------------------------------------------------------------- #
# Tokenizers
# --------------------------------------------------------------------------- #
class ByteLevelTokenizer:
    """Reference re-implementation of the shipped byte tokenizer (id = byte+4)."""

    label = "byte-level (shipped)"
    vocab_size = 32_004

    def encode(self, text: str) -> list[int]:
        return [BYTE_OFFSET + b for b in text.encode("utf-8")]


def train_bpe(texts: list[str], vocab_size: int, min_frequency: int = 1) -> Tokenizer:
    tok = Tokenizer(models.BPE(unk_token="<unk>"))
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=True)
    tok.decoder = decoders.ByteLevel()
    trainer = trainers.BpeTrainer(
        vocab_size=vocab_size,
        min_frequency=min_frequency,
        special_tokens=SPECIALS,               # ids 0..3
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),  # ids 4..259
        show_progress=False,
    )
    tok.train_from_iterator(texts, trainer=trainer, length=len(texts))
    return tok


def encode_ids(tok, text: str) -> list[int]:
    """Works for both the ``tokenizers.Tokenizer`` and the byte reference."""
    out = tok.encode(text)
    return out.ids if hasattr(out, "ids") else list(out)


def measure(tok, texts: list[str], label: str, vocab_size: int) -> TokenizerMetrics:
    reachable: set[int] = set()
    stream: list[int] = []
    lengths: list[int] = []
    total_bytes = 0
    for t in texts:
        ids = encode_ids(tok, t)
        stream.extend(ids)
        reachable.update(ids)
        lengths.append(len(ids))
        total_bytes += len(t.encode("utf-8"))
    return TokenizerMetrics(
        label=label,
        vocab_size=vocab_size,
        reachable_ids=len(reachable),
        total_tokens=len(stream),
        total_bytes=total_bytes,
        n_examples=len(texts),
        unigram_nats=unigram_entropy(stream),
        bigram_nats=bigram_conditional_entropy(stream),
        lengths=lengths,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Train + audit MindArchitect BPE.")
    ap.add_argument("--vocab-size", type=int, default=32_004)
    ap.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument("--min-frequency", type=int, default=1)
    args = ap.parse_args()

    out_dir = args.out_dir or args.data_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    splits = load_splits(args.data_dir)
    if not splits:
        print(f"no corpus found under {args.data_dir}")
        return 2
    texts = all_texts(splits)
    print(f"corpus: {len(texts)} examples from {list(splits)}")

    # --- baseline: the shipped byte tokenizer -------------------------------
    byte_tok = ByteLevelTokenizer()
    byte_metrics = measure(byte_tok, texts, byte_tok.label, byte_tok.vocab_size)

    # --- trained BPE --------------------------------------------------------
    print(f"training BPE (target vocab {args.vocab_size}) ...")
    bpe = train_bpe(texts, args.vocab_size, args.min_frequency)
    achieved = bpe.get_vocab_size()
    bpe_metrics = measure(bpe, texts, f"BPE (target {args.vocab_size})", args.vocab_size)

    tok_path = out_dir / "bpe_tokenizer.json"
    bpe.save(str(tok_path))

    # --- report -------------------------------------------------------------
    report = {
        "corpus": {
            "splits": list(splits),
            "n_examples": len(texts),
            "total_bytes": byte_metrics.total_bytes,
        },
        "bpe": {
            "target_vocab_size": args.vocab_size,
            "achieved_vocab_size": achieved,
            "special_token_ids": {s: i for i, s in enumerate(SPECIALS)},
            "artifact": str(tok_path),
            "min_frequency": args.min_frequency,
        },
        "byte_level": byte_metrics.as_dict(),
        "bpe_metrics": bpe_metrics.as_dict(),
        "comparison": {
            "reachable_ids_before": byte_metrics.reachable_ids,
            "reachable_ids_after": bpe_metrics.reachable_ids,
            "reachable_gain": bpe_metrics.reachable_ids - byte_metrics.reachable_ids,
            "reachable_pct_before": round(byte_metrics.reachable_pct, 4),
            "reachable_pct_after": round(bpe_metrics.reachable_pct, 4),
            "floor_nats_before": round(byte_metrics.random_floor_nats, 6),
            "floor_nats_after": round(bpe_metrics.random_floor_nats, 6),
            "tokens_before": byte_metrics.total_tokens,
            "tokens_after": bpe_metrics.total_tokens,
            "token_compression": round(byte_metrics.total_tokens / bpe_metrics.total_tokens, 4)
            if bpe_metrics.total_tokens
            else 0.0,
            "bits_per_byte_before": round(byte_metrics.unigram_bits_per_byte, 6),
            "bits_per_byte_after": round(bpe_metrics.unigram_bits_per_byte, 6),
            "bits_per_byte_delta_pct": round(
                100.0 * (bpe_metrics.unigram_bits_per_byte - byte_metrics.unigram_bits_per_byte)
                / byte_metrics.unigram_bits_per_byte,
                4,
            )
            if byte_metrics.unigram_bits_per_byte
            else 0.0,
            "bigram_bits_per_byte_before": round(byte_metrics.bigram_bits_per_byte, 6),
            "bigram_bits_per_byte_after": round(bpe_metrics.bigram_bits_per_byte, 6),
        },
        "seq_len_fit": {
            "note": "how many of the corpus examples fit whole in a window",
            "bpe": {
                str(w): sum(1 for n in bpe_metrics.lengths if n <= w)
                for w in (128, 256, 512, 1024, 2048)
            },
            "byte_level": {
                str(w): sum(1 for n in byte_metrics.lengths if n <= w)
                for w in (128, 256, 512, 1024, 2048)
            },
        },
    }

    (out_dir / "tokenizer_coverage.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )

    # --- console summary ----------------------------------------------------
    print("\n" + "=" * 74)
    print(f"{'metric':<34}{'byte-level':>18}{'BPE':>20}")
    print("=" * 74)
    def row(name: str, a: object, b: object) -> None:
        print(f"{name:<34}{str(a):>18}{str(b):>20}")
    row("reachable ids", byte_metrics.reachable_ids, bpe_metrics.reachable_ids)
    row("reachable %", f"{byte_metrics.reachable_pct:.2f}%", f"{bpe_metrics.reachable_pct:.2f}%")
    row("dead slots", byte_metrics.dead_slots, bpe_metrics.dead_slots)
    row("tokens (corpus)", byte_metrics.total_tokens, bpe_metrics.total_tokens)
    row("bytes/token", f"{byte_metrics.bytes_per_token:.3f}", f"{bpe_metrics.bytes_per_token:.3f}")
    row("random floor nats/tok", f"{byte_metrics.random_floor_nats:.4f}", f"{bpe_metrics.random_floor_nats:.4f}")
    row("unigram nats/token", f"{byte_metrics.unigram_nats:.4f}", f"{bpe_metrics.unigram_nats:.4f}")
    row("bits/byte (unigram)", f"{byte_metrics.unigram_bits_per_byte:.4f}", f"{bpe_metrics.unigram_bits_per_byte:.4f}")
    row("bits/byte (bigram)", f"{byte_metrics.bigram_bits_per_byte:.4f}", f"{bpe_metrics.bigram_bits_per_byte:.4f}")
    row("p50 tokens/example", byte_metrics.percentiles().get("p50"), bpe_metrics.percentiles().get("p50"))
    row("max tokens/example", byte_metrics.percentiles().get("max"), bpe_metrics.percentiles().get("max"))
    print("=" * 74)
    print(f"achieved BPE vocab : {achieved} (target {args.vocab_size})")
    print(f"artifact           : {tok_path}")
    print(f"report             : {out_dir / 'tokenizer_coverage.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
