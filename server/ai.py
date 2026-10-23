"""OpenAI provider adapter, concurrency slots and rate budgets (AIRUN; spec §12.7).

``invoke(request, class_id, student_id, meta=None)`` keeps its name and positional signature (tests patch
``app.ai.invoke`` with fakes). It makes exactly one provider call, fills ``meta`` (response id, token usage, latency)
and raises ``contracts.AiError`` (429/502/503) for every failure. Capacity is enforced around it by ``ai_runtime``:
``_slots`` (``KIWI_AI_CONCURRENCY`` concurrent calls, bounded wait queue) and ``_rates`` (atomic per-student, per-class
and per-address budgets with refunds). Policy and request-building names moved to ``ai_policy``/``ai_runtime`` and
are re-exported here for compatibility.
Role precedence follows https://developers.openai.com/api/docs/guides/text#message-roles-and-instruction-following
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
from collections import deque
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from server import ai_policy, ai_runtime
from server.ai_runtime import SYSTEM, build_request, is_novel, validate_question  # noqa: F401  (re-exports)
from server.contracts import AiError

DEFAULT_POLICY = ai_policy.LEGACY_DEFAULT_POLICY
PROVIDER_URL = "https://api.openai.com/v1/responses"
PROVIDER_TIMEOUT_S = 50
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
    return bool(os.environ.get("OPENAI_API_KEY") or os.environ.get("OPEN_AI_TEST_KEY"))


def init(db) -> None:
    """Startup hygiene (spec §4.4): pending AI calls older than 10 minutes become ``interrupted``."""
    ai_runtime.init(db)


def policy(db, class_id, unit_id):
    return ai_policy.policy(db, class_id, unit_id)


def public_policy(db, class_id, unit_id):
    return ai_policy.public_policy(db, class_id, unit_id, available())


def save_policy(db, class_id, data, unit_ids, now=None, *, created_by="instructor", created_by_role="instructor"):
    return ai_policy.save_policy(db, class_id, data, unit_ids, created_by=created_by, created_by_role=created_by_role)


def _provider_error(error: Exception) -> AiError:
    if isinstance(error, HTTPError):
        if error.code == 429:
            return AiError(429, "rate_limited", "The AI service is receiving too many requests. Please wait a minute and try again.",
                           {"reason": "provider_rate_limit"})
        return AiError(502, "ai_provider_error", "The AI service could not complete the request. Please retry.",
                       {"reason": f"provider_http_{error.code}"})
    reason = getattr(error, "reason", None)
    if isinstance(error, (TimeoutError, socket.timeout)) or isinstance(reason, (TimeoutError, socket.timeout)):
        return AiError(502, "ai_provider_error", "The AI service took too long to answer. Please retry.", {"reason": "timeout"})
    return AiError(502, "ai_provider_error", "The AI service could not be reached. Please retry in a moment.", {"reason": "network"})


def invoke(request, class_id, student_id, meta=None):
    """Call the Responses API once; returns the reply text or raises ``AiError``. Never holds a database transaction."""
    if not available():
        raise AiError(503, "ai_unavailable", "AI is unavailable. Configure the server API key to enable teacher-controlled AI.")
    key = os.environ.get("OPENAI_API_KEY") or os.environ.get("OPEN_AI_TEST_KEY")
    started = time.monotonic()
    http = Request(PROVIDER_URL, data=json.dumps(request).encode(),
                   headers={"Content-Type": "application/json", "Authorization": "Bearer " + str(key)}, method="POST")
    try:
        with urlopen(http, timeout=PROVIDER_TIMEOUT_S) as response:
            raw = response.read()
    except (HTTPError, URLError, TimeoutError, socket.timeout, OSError) as error:
        raise _provider_error(error) from error
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise AiError(502, "ai_invalid_output", "The AI service sent a response the Lab could not read. Please retry.",
                      {"reason": "provider_json"}) from error
    if not isinstance(result, dict):
        raise AiError(502, "ai_invalid_output", "The AI service sent a response the Lab could not read. Please retry.")
    if isinstance(meta, dict):
        usage = result.get("usage") or {}
        meta.update(response_id=result.get("id"), input_tokens=usage.get("input_tokens"),
                    output_tokens=usage.get("output_tokens"),
                    reasoning_tokens=(usage.get("output_tokens_details") or {}).get("reasoning_tokens"),
                    latency_ms=int((time.monotonic() - started) * 1000))
    if result.get("status") != "completed":
        reason = (result.get("incomplete_details") or {}).get("reason") if isinstance(result.get("incomplete_details"), dict) else None
        raise AiError(502, "ai_incomplete",
                      "AI output was incomplete. Please retry or ask your teacher to increase the output token limit.",
                      {"reason": reason or "incomplete"})
    text = "\n".join(part.get("text", "") for item in result.get("output", []) if item.get("type") == "message"
                     for part in item.get("content", []) if part.get("type") == "output_text").strip()
    if not text:
        raise AiError(502, "ai_invalid_output", "AI returned an empty response. Please retry.", {"reason": "empty"})
    return text


__all__ = ["DEFAULT_POLICY", "SYSTEM", "Capacity", "RateBudget", "available", "build_request", "init", "invoke",
           "is_novel", "policy", "public_policy", "save_policy", "validate_question", "ai_runtime"]
