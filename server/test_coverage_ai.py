"""Coverage for ``server/ai.py`` (AIRUN, spec §12.7): the provider adapter ``invoke`` against a faked ``urlopen`` (no
network, AI keys stay empty — ``available`` is patched), provider error mapping, ``Capacity`` slots/queue and
``RateBudget`` reservations, refunds and pruning, plus the v0.5.1 compatibility wrappers."""

from __future__ import annotations

import json
import os
import socket
import tempfile
import threading
import time
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from server import testsupport  # noqa: F401  (empties the AI keys before anything reads them)
from server import ai, app, course_config
from server import db as dbmod
from server.contracts import AiError


class _Response:
    """Context-manager stand-in for the ``urlopen`` response."""

    def __init__(self, raw: bytes) -> None:
        self.raw = raw

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self) -> bytes:
        return self.raw


def _completed(*texts: str, **extra: Any) -> dict:
    return {"status": "completed", "id": "resp_1",
            "usage": {"input_tokens": 120, "output_tokens": 30, "output_tokens_details": {"reasoning_tokens": 8}},
            "output": [{"type": "reasoning", "summary": []},
                       {"type": "message", "content": [*({"type": "output_text", "text": t} for t in texts),
                                                       {"type": "refusal", "refusal": "ignored"}]}],
            **extra}


class InvokeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sent: list[tuple[Any, float]] = []
        patcher = patch.object(ai, "available", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _invoke(self, raw: bytes | Exception, meta: Any = None) -> str:
        def fake_urlopen(request: Any, timeout: float) -> _Response:
            self.sent.append((request, timeout))
            if isinstance(raw, Exception):
                raise raw
            return _Response(raw)

        with patch.object(ai, "urlopen", side_effect=fake_urlopen):
            return ai.invoke({"model": "gpt-5.4-mini", "input": [{"role": "user", "content": "hi"}]}, "c1", "s1", meta)

    def _error(self, raw: bytes | Exception) -> AiError:
        with self.assertRaises(AiError) as caught:
            self._invoke(raw)
        return caught.exception

    def test_unavailable_without_a_key(self) -> None:
        with patch.object(ai, "available", return_value=False), self.assertRaises(AiError) as caught:
            ai.invoke({}, "c1", "s1")
        self.assertEqual((caught.exception.status, caught.exception.code), (503, "ai_unavailable"))

    def test_success_joins_output_text_and_fills_meta(self) -> None:
        meta: dict = {}
        text = self._invoke(json.dumps(_completed("Hello", "World")).encode(), meta)
        self.assertEqual(text, "Hello\nWorld")
        self.assertEqual(meta["response_id"], "resp_1")
        self.assertEqual((meta["input_tokens"], meta["output_tokens"], meta["reasoning_tokens"]), (120, 30, 8))
        self.assertIsInstance(meta["latency_ms"], int)
        request, timeout = self.sent[0]
        self.assertEqual(timeout, ai.PROVIDER_TIMEOUT_S)
        self.assertEqual(request.full_url, ai.PROVIDER_URL)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertTrue(request.get_header("Authorization").startswith("Bearer "))
        self.assertEqual(json.loads(request.data)["model"], "gpt-5.4-mini")

    def test_meta_is_optional_and_usage_may_be_missing(self) -> None:
        self.assertEqual(self._invoke(json.dumps({**_completed("x"), "usage": None}).encode(), "not a dict"), "x")
        meta: dict = {}
        self._invoke(json.dumps({**_completed("x"), "usage": {"input_tokens": 1}}).encode(), meta)
        self.assertIsNone(meta["reasoning_tokens"])

    def test_provider_rate_limit(self) -> None:
        error = self._error(HTTPError(ai.PROVIDER_URL, 429, "Too Many Requests", {}, BytesIO(b"")))
        self.assertEqual((error.status, error.code, error.details), (429, "rate_limited", {"reason": "provider_rate_limit"}))

    def test_provider_http_errors(self) -> None:
        error = self._error(HTTPError(ai.PROVIDER_URL, 500, "Server Error", {}, BytesIO(b"")))
        self.assertEqual((error.status, error.code, error.details), (502, "ai_provider_error", {"reason": "provider_http_500"}))

    def test_timeouts(self) -> None:
        for raised in (TimeoutError("slow"), socket.timeout("slow"), URLError(socket.timeout("slow")), URLError(TimeoutError())):
            with self.subTest(raised=repr(raised)):
                error = self._error(raised)
                self.assertEqual((error.status, error.details), (502, {"reason": "timeout"}))
                self.assertIn("took too long", error.message)

    def test_network_errors(self) -> None:
        for raised in (URLError("Name or service not known"), ConnectionResetError("reset"), OSError("unreachable")):
            with self.subTest(raised=repr(raised)):
                error = self._error(raised)
                self.assertEqual((error.code, error.details), ("ai_provider_error", {"reason": "network"}))

    def test_unreadable_bodies(self) -> None:
        for raw in (b"<html>gateway</html>", b"\xff\xfe\x00garbage"):
            with self.subTest(raw=raw):
                error = self._error(raw)
                self.assertEqual((error.code, error.details), ("ai_invalid_output", {"reason": "provider_json"}))
        error = self._error(b"[1, 2]")
        self.assertEqual((error.status, error.code), (502, "ai_invalid_output"))

    def test_incomplete_responses(self) -> None:
        error = self._error(json.dumps({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}).encode())
        self.assertEqual((error.code, error.details), ("ai_incomplete", {"reason": "max_output_tokens"}))
        self.assertIn("output token limit", error.message)
        for details in ("bad", None, {}):
            with self.subTest(details=details):
                error = self._error(json.dumps({"status": "failed", "incomplete_details": details}).encode())
                self.assertEqual(error.details, {"reason": "incomplete"})

    def test_empty_text(self) -> None:
        for body in (_completed("  "), {"status": "completed", "output": [{"type": "message", "content": []}]},
                     {"status": "completed"}):
            with self.subTest(body=body):
                error = self._error(json.dumps(body).encode())
                self.assertEqual((error.code, error.details), ("ai_invalid_output", {"reason": "empty"}))


class AvailableTests(unittest.TestCase):
    def test_available_reads_the_environment(self) -> None:
        with patch.dict(os.environ, {"OPENAI_API_KEY": "", "OPEN_AI_TEST_KEY": ""}):
            self.assertFalse(ai.available())


class CapacityTests(unittest.TestCase):
    def test_from_env_clamps_and_ignores_bad_values(self) -> None:
        cases = [({"KIWI_AI_CONCURRENCY": "1000", "KIWI_AI_QUEUE_WAIT_S": "-3"}, (64, 0.0)),
                 ({"KIWI_AI_CONCURRENCY": "0", "KIWI_AI_QUEUE_WAIT_S": "999"}, (1, 120.0)),
                 ({"KIWI_AI_CONCURRENCY": "four", "KIWI_AI_QUEUE_WAIT_S": "soon"}, (4, 20.0)),
                 ({"KIWI_AI_CONCURRENCY": "", "KIWI_AI_QUEUE_WAIT_S": ""}, (4, 20.0))]
        for env, expected in cases:
            with self.subTest(env=env), patch.dict(os.environ, env):
                capacity = ai.Capacity.from_env()
                self.assertEqual((capacity.slots, capacity.wait_s), expected)
                self.assertEqual(capacity.max_waiters, ai.MAX_WAITERS)

    def test_configure_clamps(self) -> None:
        capacity = ai.Capacity(4, 20.0)
        capacity.configure(slots=0, wait_s=-1, max_waiters=-5)
        self.assertEqual((capacity.slots, capacity.wait_s, capacity.max_waiters), (1, 0.0, 0))
        capacity.configure()
        self.assertEqual((capacity.slots, capacity.wait_s, capacity.max_waiters), (1, 0.0, 0))

    def test_immediate_slots_and_release(self) -> None:
        capacity = ai.Capacity(2, 1.0)
        self.assertEqual(capacity.acquire(), 0)
        self.assertEqual(capacity.acquire(), 0)
        self.assertEqual(capacity.active, 2)
        capacity.release()
        capacity.release()
        capacity.release()  # never below zero
        self.assertEqual(capacity.active, 0)

    def test_busy_when_the_queue_is_full(self) -> None:
        capacity = ai.Capacity(1, 5.0, max_waiters=0)
        self.assertEqual(capacity.acquire(), 0)
        self.assertIsNone(capacity.acquire())
        self.assertEqual(capacity.waiting, 0)

    def test_queue_wait_times_out(self) -> None:
        capacity = ai.Capacity(1, 0.05)
        capacity.acquire()
        started = time.monotonic()
        self.assertIsNone(capacity.acquire())
        self.assertGreaterEqual(time.monotonic() - started, 0.04)
        self.assertEqual(capacity.waiting, 0)
        zero = ai.Capacity(1, 0.0)
        zero.acquire()
        self.assertIsNone(zero.acquire())

    def test_waiter_gets_the_released_slot(self) -> None:
        capacity = ai.Capacity(1, 5.0)
        capacity.acquire()
        result: list[int | None] = []
        waiter = threading.Thread(target=lambda: result.append(capacity.acquire()))
        waiter.start()
        for _ in range(200):
            if capacity.waiting:
                break
            time.sleep(0.005)
        self.assertEqual(capacity.waiting, 1)
        capacity.release()
        waiter.join(5)
        self.assertEqual(len(result), 1)
        self.assertIsInstance(result[0], int)
        self.assertGreaterEqual(result[0], 0)
        self.assertEqual((capacity.active, capacity.waiting), (1, 0))


class RateBudgetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = 1000.0
        # WHY: replace ``ai.time`` only (not the global ``time.monotonic``) so other modules keep the real clock.
        patcher = patch.object(ai, "time", SimpleNamespace(monotonic=lambda: self.clock))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.budget = ai.RateBudget()

    def test_reserves_every_key_or_none(self) -> None:
        student, klass = ("student", "c1", "s1"), ("class", "c1")
        ok, reservation = self.budget.reserve([(student, 2), (klass, 0)])
        self.assertTrue(ok)
        self.assertEqual(reservation, [(student, 1000.0), (klass, 1000.0)])
        self.assertTrue(self.budget.reserve([(student, 2), (klass, 0)])[0])
        ok, failing = self.budget.reserve([(klass, 0), (student, 2)])
        self.assertFalse(ok)
        self.assertEqual(failing, student)
        self.assertEqual(self.budget.count(klass), 2)  # the rejected request recorded nothing
        self.assertEqual(self.budget.count(("missing",)), 0)

    def test_window_slides(self) -> None:
        key = ("student", "c1", "s1")
        self.budget.reserve([(key, 1)])
        self.assertFalse(self.budget.reserve([(key, 1)])[0])
        self.clock += ai.RateBudget.WINDOW + 1
        self.assertEqual(self.budget.count(key), 0)
        self.assertTrue(self.budget.reserve([(key, 1)])[0])

    def test_refunds(self) -> None:
        key = ("student", "c1", "s1")
        ok, reservation = self.budget.reserve([(key, 1)])
        self.budget.refund(reservation)
        self.assertEqual(self.budget.count(key), 0)
        self.budget.refund(reservation)  # already removed
        self.budget.refund(("not", "a", "list"))
        self.budget.reset()
        self.budget.refund(reservation)  # bucket gone after reset
        self.assertEqual(self.budget.count(key), 0)

    def test_old_keys_are_dropped_past_the_key_limit(self) -> None:
        self.budget.MAX_KEYS = 2
        self.budget.reserve([(("a",), 5)])
        self.budget.reserve([(("b",), 5)])
        self.clock += ai.RateBudget.WINDOW + 1
        self.budget.reserve([(("c",), 5)])
        self.assertEqual(set(self.budget._hits), {("c",)})


class CompatibilityWrapperTests(unittest.TestCase):
    """``ai.policy`` / ``public_policy`` / ``save_policy`` / ``init`` delegate to ``ai_policy`` / ``ai_runtime``."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "coverage.sqlite3"
        app.init_db()
        self.db = app.connection()
        testsupport.create_course(self.db, "c1")
        self.unit = course_config.course_for("c1", self.db)["units"][0]["id"]

    def tearDown(self) -> None:
        self.db.close()
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def test_policy_round_trip(self) -> None:
        self.assertEqual(ai.policy(self.db, "c1", self.unit), ai.DEFAULT_POLICY)
        public = ai.public_policy(self.db, "c1", self.unit)
        self.assertNotIn("systemPrompt", public)
        self.assertFalse(public["aiAvailable"])
        saved = ai.save_policy(self.db, "c1", {**ai.DEFAULT_POLICY, "unitId": self.unit, "systemPrompt": "  Be brief.  "},
                               [self.unit], created_by="coverage", created_by_role="instructor")
        self.assertEqual(saved["systemPrompt"], "Be brief.")
        self.assertEqual(ai.policy(self.db, "c1", self.unit)["systemPrompt"], "Be brief.")

    def test_init_marks_stale_pending_calls(self) -> None:
        with dbmod.write_tx(self.db):  # (``with connection`` would close a ManagedConnection)
            self.db.execute(
                """INSERT INTO ai_calls (request_id, class_id, student_id, actor_role, is_preview, identity_verified, action,
                surface, policy_source, platform_rules_version, model, status, requested_at)
                VALUES ('r-old', 'c1', 's1', 'student', 0, 0, 'chat', 'ask-kiwi', 'platform', 'platform-rules-v2', 'm',
                'pending', '2020-01-01T00:00:00.000+00:00')""")
        ai.init(self.db)
        self.assertEqual(self.db.execute("SELECT status FROM ai_calls WHERE request_id='r-old'").fetchone()[0], "interrupted")


if __name__ == "__main__":
    unittest.main()
