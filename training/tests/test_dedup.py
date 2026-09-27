"""Exact-hash deduplication: first-wins, empties, token sequences, boundaries."""

from __future__ import annotations

from mindarchitect.data.filter.exact_dedup import ExactDeduper, hash_sequence


def test_identical_strings_collapse():
    d = ExactDeduper()
    kept = d.filter(["alpha", "beta", "alpha", "gamma", "beta"])
    assert kept == ["alpha", "beta", "gamma"]
    assert d.kept == 3 and d.dropped == 2


def test_empty_string_is_a_legal_record_once():
    d = ExactDeduper()
    assert d.add("") is True
    assert d.add("") is False
    assert "" in d
    assert len(d) == 1


def test_whitespace_is_not_folded():
    d = ExactDeduper()
    assert d.add("x") is True
    assert d.add("x ") is True
    assert d.add(" x") is True
    assert d.add("x") is False
    assert d.kept == 3


def test_token_sequence_hashing_is_order_sensitive():
    a = hash_sequence([1, 2, 3])
    b = hash_sequence([3, 2, 1])
    c = hash_sequence([1, 2, 3])
    assert a != b
    assert a == c


def test_bytes_and_str_of_same_utf8_share_digest():
    assert hash_sequence("café") == hash_sequence("café".encode("utf-8"))


def test_filter_preserves_first_occurrence_order():
    d = ExactDeduper()
    src = ["u", "v", "u", "w", "v", "x"]
    assert d.filter(src) == ["u", "v", "w", "x"]


def test_boundary_single_and_long():
    d = ExactDeduper()
    assert d.add("a") is True
    long = "z" * 10_000
    assert d.add(long) is True
    assert d.add(long) is False
    assert len(d) == 2
