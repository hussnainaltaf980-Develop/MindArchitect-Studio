"""Integration 1 — tokenizer / model vocab must match; mismatches raise."""

from __future__ import annotations

import pytest

from mindarchitect.model.config import FORGE_SMOKE, VOCAB_SIZE_V1, ModelConfig
from mindarchitect.model.transformer import MindArchitectTransformer
from mindarchitect.serving import VocabMismatchError, assert_vocab_aligned
from mindarchitect.tokenizer import ByteTokenizer


def test_smoke_vocab_is_32004():
    assert FORGE_SMOKE.vocab_size == VOCAB_SIZE_V1 == 32004
    tok = ByteTokenizer(vocab_size=FORGE_SMOKE.vocab_size)
    assert_vocab_aligned(tok, FORGE_SMOKE)


def test_mismatch_is_blocked():
    tok = ByteTokenizer(vocab_size=512)
    with pytest.raises(VocabMismatchError):
        assert_vocab_aligned(tok, FORGE_SMOKE)


def test_embedding_rows_equal_vocab():
    model = MindArchitectTransformer(FORGE_SMOKE)
    assert model.tok_emb.weight.shape[0] == 32004
    assert model.lm_head.weight.shape[0] == 32004
    tok = ByteTokenizer(vocab_size=32004)
    assert_vocab_aligned(tok, model.cfg)
