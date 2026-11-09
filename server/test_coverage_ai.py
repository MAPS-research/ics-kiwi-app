"""Coverage for ``server/ai.py`` (AIRUN, spec §12.7): concurrency and rate limiting; the official API adapter is covered in test_kiwi_api.py. ``Capacity`` slots/queue and
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
