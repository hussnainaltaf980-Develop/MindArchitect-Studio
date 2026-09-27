"""Byte tokenizer: round-trips, specials, vocab bounds, whitespace."""

from __future__ import annotations

import pytest

from mindarchitect.tokenizer.tokenizer import BYTE_OFFSET, EOS, PAD, UNK, ByteTokenizer, MIN_VOCAB


def test_roundtrip_plain_ascii():
    tok = ByteTokenizer()
    text = "MindArchitect Forge V-5.6"
    assert tok.decode(tok.encode(text)) == text


def test_roundtrip_whitespace_preserved():
    tok = ByteTokenizer()
    text = "  leading\t\ttabs\n\nnewlines  trailing  "
    assert tok.decode(tok.encode(text)) == text


def test_roundtrip_empty_string():
    tok = ByteTokenizer()
    assert tok.encode("") == []
    assert tok.decode([]) == ""


def test_roundtrip_unicode():
    tok = ByteTokenizer()
    text = "اردو العربية 日本語 🧠"
    assert tok.decode(tok.encode(text)) == text


def test_bos_eos_specials_roundtrip_when_kept():
    tok = ByteTokenizer()
    ids = tok.encode("ab", add_bos=True, add_eos=True)
    assert ids[0] == 1 and ids[-1] == EOS
    assert tok.decode(ids, skip_special=True) == "ab"
    assert tok.decode(ids, skip_special=False).startswith("<bos>")
    assert tok.decode(ids, skip_special=False).endswith("<eos>")


def test_inline_special_token_strings():
    tok = ByteTokenizer()
    ids = tok.encode("hello<unk>world")
    assert UNK in ids
    assert tok.decode(ids, skip_special=True) == "helloworld"


def test_vocab_bounds_reject_oob():
    tok = ByteTokenizer(vocab_size=320)
    with pytest.raises(ValueError):
        tok.decode([320])
    with pytest.raises(ValueError):
        tok.decode([-1])
    assert tok.vocab_contains(0)
    assert tok.vocab_contains(319)
    assert not tok.vocab_contains(320)


def test_min_vocab_covers_all_bytes():
    tok = ByteTokenizer(vocab_size=MIN_VOCAB)
    ids = [BYTE_OFFSET + b for b in range(256)]
    tok._check_bounds(ids)  # must not raise
    with pytest.raises(ValueError):
        ByteTokenizer(vocab_size=MIN_VOCAB - 1)


def test_pad_id_is_zero():
    assert PAD == 0
    tok = ByteTokenizer()
    assert tok.decode([PAD, BYTE_OFFSET + ord("A")], skip_special=True) == "A"
