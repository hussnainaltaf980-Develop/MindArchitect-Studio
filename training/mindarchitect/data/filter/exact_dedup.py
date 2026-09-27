"""Exact-match dataset hashing / deduplication.

A record is identified by the SHA-256 of its canonical bytes. First
occurrence wins; later identical payloads are dropped. Near-duplicates
(different whitespace, different case) are *not* collapsed — that is
MinHash/LSH territory, not this filter.
"""

from __future__ import annotations

import hashlib
from typing import Iterable, Sequence


def hash_sequence(payload: str | bytes | Sequence[int]) -> str:
    if isinstance(payload, str):
        data = payload.encode("utf-8")
    elif isinstance(payload, (bytes, bytearray)):
        data = bytes(payload)
    else:
        data = b"\xff".join(int(t).to_bytes(4, "little", signed=False) for t in payload)
    return hashlib.sha256(data).hexdigest()


class ExactDeduper:
    def __init__(self) -> None:
        self._seen: dict[str, int] = {}  # digest → first index
        self.kept = 0
        self.dropped = 0

    def add(self, payload: str | bytes | Sequence[int], index: int | None = None) -> bool:
        """Return True if this is the first time ``payload`` has been seen."""
        digest = hash_sequence(payload)
        if digest in self._seen:
            self.dropped += 1
            return False
        self._seen[digest] = self.kept if index is None else index
        self.kept += 1
        return True

    def filter(self, records: Iterable[str | bytes | Sequence[int]]) -> list:
        out = []
        for rec in records:
            if self.add(rec):
                out.append(rec)
        return out

    def __contains__(self, payload: str | bytes | Sequence[int]) -> bool:
        return hash_sequence(payload) in self._seen

    def __len__(self) -> int:
        return len(self._seen)
