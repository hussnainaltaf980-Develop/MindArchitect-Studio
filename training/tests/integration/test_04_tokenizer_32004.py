"""Integration 4 — 32,004 vocab tokenizer: roundtrip, reserved BPE range, bounds."""

from __future__ import annotations

import pytest

from mindarchitect.tokenizer.tokenizer import BYTE_OFFSET, MIN_VOCAB, ByteTokenizer

VOCAB = 32004


def test_roundtrip_code_and_whitespace():
    tok = ByteTokenizer(vocab_size=VOCAB)
    text = "def add(a, b):\n    return a + b\n"
    assert tok.decode(tok.encode(text)) == text
    assert tok.decode(tok.encode("  leading\n\t")) == "  leading\n\t"


def test_byte_ids_fit_and_reserved_range_is_oob_for_encode_only():
    tok = ByteTokenizer(vocab_size=VOCAB)
    ids = tok.encode("A")
    assert ids == [BYTE_OFFSET + ord("A")]
    assert ids[0] < MIN_VOCAB
    assert tok.vocab_contains(VOCAB - 1)
    assert not tok.vocab_contains(VOCAB)
    with pytest.raises(ValueError):
        tok.decode([VOCAB])
