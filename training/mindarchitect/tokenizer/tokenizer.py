"""UTF-8 byte tokenizer with a reserved special-token range.

Vocab layout
------------
0..3   specials: <pad> <bos> <eos> <unk>
4..259 UTF-8 bytes 0x00..0xFF   (id = byte + 4)
260+   unused (reserved for future BPE merges)

Round-trips are exact, including leading/trailing/internal whitespace,
because the codec never strips and never folds case.
"""

from __future__ import annotations

from dataclasses import dataclass

PAD, BOS, EOS, UNK = 0, 1, 2, 3
SPECIAL_TOKENS = {
    "<pad>": PAD,
    "<bos>": BOS,
    "<eos>": EOS,
    "<unk>": UNK,
}
BYTE_OFFSET = 4
MIN_VOCAB = BYTE_OFFSET + 256  # 260


@dataclass
class ByteTokenizer:
    vocab_size: int = 512

    def __post_init__(self) -> None:
        if self.vocab_size < MIN_VOCAB:
            raise ValueError(f"vocab_size must be >= {MIN_VOCAB} to cover UTF-8 bytes")
        self._id_to_special = {v: k for k, v in SPECIAL_TOKENS.items()}

    def encode(self, text: str, *, add_bos: bool = False, add_eos: bool = False) -> list[int]:
        if not isinstance(text, str):
            raise TypeError("encode expects str")
        ids: list[int] = []
        if add_bos:
            ids.append(BOS)
        i = 0
        # Honour explicit special-token strings if the caller planted them.
        while i < len(text):
            hit = None
            for tok, tid in SPECIAL_TOKENS.items():
                if text.startswith(tok, i):
                    hit = (len(tok), tid)
                    break
            if hit is not None:
                ids.append(hit[1])
                i += hit[0]
                continue
            for b in text[i].encode("utf-8"):
                ids.append(BYTE_OFFSET + b)
            i += 1
        if add_eos:
            ids.append(EOS)
        self._check_bounds(ids)
        return ids

    def decode(self, ids: list[int], *, skip_special: bool = True) -> str:
        self._check_bounds(ids)
        buf = bytearray()
        out: list[str] = []
        for i in ids:
            if i in self._id_to_special:
                if buf:
                    out.append(buf.decode("utf-8", errors="replace"))
                    buf.clear()
                if not skip_special:
                    out.append(self._id_to_special[i])
                continue
            buf.append(i - BYTE_OFFSET)
        if buf:
            out.append(buf.decode("utf-8", errors="replace"))
        return "".join(out)

    def _check_bounds(self, ids: list[int]) -> None:
        for i in ids:
            if i < 0 or i >= self.vocab_size:
                raise ValueError(f"token id {i} outside vocab [0, {self.vocab_size})")

    def vocab_contains(self, token_id: int) -> bool:
        return 0 <= token_id < self.vocab_size
