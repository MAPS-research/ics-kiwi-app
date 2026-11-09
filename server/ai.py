"""Kiwi App API adapter, concurrency slots and rate budgets.

``invoke(request, class_id, student_id, meta=None)`` keeps its name and positional signature (tests patch
``app.ai.invoke`` with fakes). It makes one approved Kiwi contextual-chat call and records the available latency/provenance
and raises ``contracts.AiError`` (429/502/503) for every failure. Capacity is enforced around it by ``ai_runtime``:
``_slots`` (``KIWI_AI_CONCURRENCY`` concurrent calls, bounded wait queue) and ``_rates`` (atomic per-student, per-class
and per-address budgets with refunds). Policy and request-building names moved to ``ai_policy``/``ai_runtime`` and
are re-exported here for compatibility.
Kiwi owns the approved prompt; Lab rules are task data, not provider system messages.
"""

from __future__ import annotations

import os
import threading
import time
from collections import deque

from server import ai_policy, ai_runtime, kiwi_api
from server.ai_runtime import SYSTEM, build_request, is_novel, validate_question  # noqa: F401  (re-exports)
from server.contracts import AiError

DEFAULT_POLICY = ai_policy.LEGACY_DEFAULT_POLICY
PROVIDER_TIMEOUT_S = 120
MAX_WAITERS = 32


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except ValueError:
        return default
    return min(max(value, lo), hi)


def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    try:
        value = float(os.environ.get(name, "") or default)
    except ValueError:
        return default
    return min(max(value, lo), hi)


class Capacity:
    """Process-wide provider slots with a bounded FIFO-ish wait (``acquire`` → queue ms, or ``None`` = busy)."""

    def __init__(self, slots: int, wait_s: float, max_waiters: int = MAX_WAITERS) -> None:
        self._cond = threading.Condition()
        self.slots = slots
        self.wait_s = wait_s
        self.max_waiters = max_waiters
        self.active = 0
        self.waiting = 0

    @classmethod
    def from_env(cls) -> "Capacity":
        return cls(_env_int("KIWI_AI_CONCURRENCY", 4, 1, 64), _env_float("KIWI_AI_QUEUE_WAIT_S", 20.0, 0.0, 120.0))

    def configure(self, *, slots: int | None = None, wait_s: float | None = None, max_waiters: int | None = None) -> None:
        with self._cond:
            if slots is not None:
                self.slots = max(1, int(slots))
            if wait_s is not None:
                self.wait_s = max(0.0, float(wait_s))
            if max_waiters is not None:
                self.max_waiters = max(0, int(max_waiters))
            self._cond.notify_all()

    def acquire(self) -> int | None:
        started = time.monotonic()
        with self._cond:
            if self.active < self.slots and self.waiting == 0:
                self.active += 1
                return 0
            if self.waiting >= self.max_waiters:
                return None
            self.waiting += 1
            try:
                deadline = started + self.wait_s
                while self.active >= self.slots:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return None
                    self._cond.wait(remaining)
                self.active += 1
                return int((time.monotonic() - started) * 1000)
            finally:
                self.waiting -= 1

    def release(self) -> None:
        with self._cond:
            self.active = max(0, self.active - 1)
            self._cond.notify()


class RateBudget:
    """Sliding 60-second request budgets reserved atomically for several keys at once (one lock)."""

    WINDOW = 60.0
    MAX_KEYS = 5000

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hits: dict[tuple, deque[float]] = {}

    def _prune(self, bucket: deque[float], now: float) -> None:
        while bucket and now - bucket[0] > self.WINDOW:
            bucket.popleft()

    def reserve(self, limits: list[tuple[tuple, int]]) -> tuple[bool, object]:
        """``(True, reservation)`` when every key is under its limit (all recorded), else ``(False, failing_key)``.

        A limit ``<= 0`` means unlimited. Rejected requests record nothing (they do not consume budget).
        """
        now = time.monotonic()
        with self._lock:
            for key, limit in limits:
                bucket = self._hits.setdefault(key, deque())
                self._prune(bucket, now)
                if limit > 0 and len(bucket) >= limit:
                    return False, key
            for key, _limit in limits:
                self._hits[key].append(now)
            if len(self._hits) > self.MAX_KEYS:
                for key in [k for k, b in self._hits.items() if not b or now - b[-1] > self.WINDOW]:
                    del self._hits[key]
            return True, [(key, now) for key, _limit in limits]

    def refund(self, reservation: object) -> None:
        if not isinstance(reservation, list):
            return
        with self._lock:
            for key, stamp in reservation:
                bucket = self._hits.get(key)
                if bucket is None:
                    continue
                try:
                    bucket.remove(stamp)
                except ValueError:
                    continue  # already outside the window

    def count(self, key: tuple) -> int:
        now = time.monotonic()
        with self._lock:
            bucket = self._hits.get(key)
            if not bucket:
                return 0
            self._prune(bucket, now)
            return len(bucket)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


_slots = Capacity.from_env()
_rates = RateBudget()
_rate_lock = threading.Lock()  # kept for v0.5.1 compatibility (no longer used)


def available() -> bool:
    return kiwi_api.ai_available()


def init(db) -> None:
    """Startup hygiene (spec §4.4): pending AI calls older than 10 minutes become ``interrupted``."""
    ai_runtime.init(db)


def policy(db, class_id, unit_id):
    return ai_policy.policy(db, class_id, unit_id)


def public_policy(db, class_id, unit_id):
    return ai_policy.public_policy(db, class_id, unit_id, available())


def save_policy(db, class_id, data, unit_ids, now=None, *, created_by="instructor", created_by_role="instructor"):
    return ai_policy.save_policy(db, class_id, data, unit_ids, created_by=created_by, created_by_role=created_by_role)


def invoke(request, class_id, student_id, meta=None):
    """Run the approved Kiwi prompt using this request's verified App identity."""
    started = time.monotonic()
    result = kiwi_api.contextual_chat(request, class_id, student_id, meta)
    if isinstance(meta, dict):
        meta["latency_ms"] = int((time.monotonic() - started) * 1000)
    return result


__all__ = ["DEFAULT_POLICY", "SYSTEM", "Capacity", "RateBudget", "available", "build_request", "init", "invoke",
           "is_novel", "policy", "public_policy", "save_policy", "validate_question", "ai_runtime"]
