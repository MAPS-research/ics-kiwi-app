"""Capacity script test (AIRUN-22): 60 students chat within 2 s against a slow fake provider (KIWI_AI_CONCURRENCY=4,
queue wait 20 s). Every request ends ``ok`` or ``busy`` (no 500, no "database is locked"), each has exactly one
``ai_calls`` row, and ``POST /api/events`` issued in parallel stays fast because no transaction spans a provider call."""

from __future__ import annotations

import threading
import time
import unittest
from unittest.mock import patch

from server import app
from server.test_ai_runtime import C, AirunCase, Fake
from server.testsupport import TEACHER_KEY

STUDENTS = 60


class CapacityScriptTest(AirunCase):
    def test_airun_22_sixty_students_with_a_slow_provider(self):
        app.ai._slots.configure(slots=4, wait_s=20, max_waiters=32)
        students = [f"cap-{index:02d}" for index in range(STUDENTS)]
        for student in students:
            self.demo_session(C, student)
        self.demo_session(C, "demo-bo")
        results: dict[str, int] = {}
        event_times: list[tuple[int, float]] = []
        lock = threading.Lock()
        fake = Fake(latency=0.5, default="Break the task into two smaller steps.")

        def chat(index: int, student: str) -> None:
            status, _ = self.chat(f"Question {index}", student=student, thread=f"t-{student}", client_addr=f"10.1.0.{index}")
            with lock:
                results[student] = status

        def event(index: int) -> None:
            started = time.monotonic()
            status, _ = self.request(f"/api/events?classId={C}", "POST", {
                "classId": C, "studentId": "demo-bo", "sessionId": "cap", "type": "code_run",
                "payload": {"ok": True, "code": f"x <- {index}"}}, student="demo-bo")
            with lock:
                event_times.append((status, time.monotonic() - started))

        with patch.object(app.ai, "invoke", fake):
            threads = [threading.Thread(target=chat, args=(i, s)) for i, s in enumerate(students)]
            started = time.monotonic()
            for thread in threads:
                thread.start()
                time.sleep(2.0 / STUDENTS)  # all 60 requests within 2 s
            events = [threading.Thread(target=event, args=(i,)) for i in range(10)]
            for thread in events:
                thread.start()
                time.sleep(0.1)
            for thread in threads + events:
                thread.join(60)
            self.assertLess(time.monotonic() - started, 40)
        self.assertEqual(len(results), STUDENTS)
        self.assertTrue(set(results.values()) <= {200, 503}, results)
        self.assertGreaterEqual(list(results.values()).count(200), 4)
        rows = self.rows("SELECT student_id, status FROM ai_calls WHERE parent_call_id IS NULL")
        self.assertEqual(len(rows), STUDENTS)
        self.assertEqual(len({r["student_id"] for r in rows}), STUDENTS)
        self.assertTrue({r["status"] for r in rows} <= {"ok", "busy"}, {r["status"] for r in rows})
        self.assertEqual(sum(1 for r in rows if r["status"] == "ok"), list(results.values()).count(200))
        self.assertEqual(fake.count, list(results.values()).count(200))
        self.assertEqual(len(event_times), 10)
        for status, seconds in event_times:
            self.assertIn(status, (200, 201))
            self.assertLess(seconds, 2.0)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM service_incidents")[0][0], 0)
        self.assertIsNotNone(TEACHER_KEY)


if __name__ == "__main__":
    unittest.main()
