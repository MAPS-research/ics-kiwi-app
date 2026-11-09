"""Homework submission v2, attempt starts, drafts and the student submission list — owned by ASSESS.

The first three tests were moved from server/test_app.py by FOUNDATION (unchanged in intent). The rest cover
ASSESS-01/02/07/11/12/21/22 (spec §9.1), autocheck rows (§17.1) and the gate leftover (preview submissions on drafts).
"""

import json
import unittest
from datetime import timedelta

from server import app
from server import db as dbmod
from server.test_assignments import AssessCase, homework_input, iso
from server.testsupport import ApiTestCase, freeze_time


class SubmissionTests(ApiTestCase):
    def test_concurrent_submission_attempt_numbers_are_unique(self):
        from concurrent.futures import ThreadPoolExecutor

        data = {"kind": "homework", "title": "Review concurrency", "unitId": "r-basics",
                "questions": [{"id": "q1", "type": "text", "prompt": "Explain.", "points": 10}]}
        _, w = self.request("/api/work?classId=concurrent", "POST", data, "test-teacher-key")
        self.request("/api/work/" + w["id"] + "/status?classId=concurrent", "POST", {"status": "published"}, "test-teacher-key")
        self.demo_session("concurrent", "s1")  # mint once before the parallel requests
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(
                lambda n: self.request("/api/work/" + w["id"] + "/submit?classId=concurrent", "POST",
                                       {"studentId": "s1", "studentName": "Ada", "answers": {"q1": str(n)}}, student="s1"),
                range(4)))
        self.assertTrue(all(s == 201 for s, _ in results), results)
        self.assertEqual(sorted(r["attempt"] for _, r in results), [1, 2, 3, 4])

    def test_retry_does_not_duplicate_submission_or_answer_telemetry(self):
        data = {"kind": "homework", "title": "Review retry", "unitId": "r-basics",
                "questions": [{"id": "q1", "type": "text", "prompt": "Explain.", "points": 10}]}
        _, w = self.request("/api/work?classId=retry", "POST", data, "test-teacher-key")
        self.request("/api/work/" + w["id"] + "/status?classId=retry", "POST", {"status": "published"}, "test-teacher-key")
        body = {"studentId": "s1", "studentName": "Ada", "sessionId": "browser", "requestId": "request-1", "answers": {"q1": "A vector"}}
        _, first = self.request("/api/work/" + w["id"] + "/submit?classId=retry", "POST", body, student="s1")
        _, again = self.request("/api/work/" + w["id"] + "/submit?classId=retry", "POST", body, student="s1")
        self.assertEqual(first["id"], again["id"])
        self.assertTrue(again["replayed"])
        _, m = self.request("/api/teacher/analytics/metrics?classId=retry", key="test-teacher-key")
        self.assertEqual(m["attempts"], 1)
        self.assertEqual(self.request("/api/work/" + w["id"] + "/submit?classId=retry", "POST",
                                      {**body, "answers": {"q1": "Changed"}}, student="s1")[0], 400)
        _, page = self.request("/api/teacher/work-page?classId=retry&view=grading", key="test-teacher-key")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["submissions"][0]["id"], first["id"])
        self.assertEqual(len(page["assignments"]), 1)

    def test_legacy_submission_recovery_preserves_snapshot_and_is_idempotent(self):
        data = {"kind": "homework", "title": "Review legacy", "unitId": "r-basics",
                "questions": [{"id": "q1", "type": "text", "prompt": "Explain.", "points": 10}]}
        _, w = self.request("/api/work?classId=legacy-sub", "POST", data, "test-teacher-key")
        with app.connection() as db:
            db.execute(
                "INSERT INTO submissions (id,assignment_id,class_id,student_id,student_name,attempt,answers_json,submitted_at,grade) VALUES (?,?,?,?,?,?,?,?,?)",
                ("sub-legacy", w["id"], "legacy-sub", "s1", "Ada", 1, '{"q1":"Original answer"}', "2026-10-01T12:00:00+00:00", 9))
            app.migrations.base_schema(db)  # legacy recovery moved to base_schema
            app.migrations.base_schema(db)
            events = db.execute("SELECT * FROM events WHERE class_id='legacy-sub' AND event_type='answer_submitted'").fetchall()
            self.assertEqual(len(events), 1)
            payload = json.loads(events[0]["payload_json"])
            self.assertTrue(payload["recoveredFromSubmission"])
            self.assertEqual(payload["answer"], "Original answer")
            self.assertEqual(events[0]["created_at"], "2026-10-01T12:00:00+00:00")
            self.assertEqual(db.execute("SELECT grade FROM submissions WHERE id='sub-legacy'").fetchone()[0], 9)


ANSWERS = {"q1": "4", "q2": "A list of one type"}


class SubmitV2Tests(AssessCase):
    cls = "submit"

    def submit(self, work_id, answers=None, request_id="r1", student="demo-ada", **extra):
        return self.s(f"/api/work/{work_id}/submit", "POST", {"answers": answers or ANSWERS, "requestId": request_id, **extra},
                      student=student)

    def test_late_policy(self):  # ASSESS-01 [F01, TH01, AU-D1-01, AU-T-12]
        late = {"mode": "not_accepted", "untilAt": None, "graceMinutes": 0, "penaltyPctPerDay": 0}
        work = self.published(homework_input(dueAt=iso(timedelta(days=-1)), latePolicy=late))
        status, body = self.submit(work["id"])
        self.assertEqual((status, body["code"]), (409, "late_not_accepted"))
        with self.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM submissions").fetchone()[0], 0)
        marked = self.published(homework_input(title="Marked", dueAt=iso(timedelta(days=-1))))
        status, result = self.submit(marked["id"])
        self.assertEqual(status, 201, result)
        self.assertTrue(result["late"])
        self.assertAlmostEqual(result["lateSeconds"], 86400, delta=30)
        with self.db() as db:
            row = db.execute("SELECT is_late, late_seconds FROM submissions WHERE id=?", (result["id"],)).fetchone()
        self.assertEqual(row["is_late"], 1)
        _, detail = self.s(f"/api/work/{marked['id']}")
        self.assertEqual(detail["state"], "past_due")
        until = {"mode": "accept_until", "untilAt": iso(timedelta(hours=-1)), "graceMinutes": 0, "penaltyPctPerDay": 0}
        closed = self.published(homework_input(title="Until", dueAt=iso(timedelta(days=-1)), latePolicy=until))
        self.assertEqual(self.submit(closed["id"])[1]["code"], "late_not_accepted")
        grace = {"mode": "not_accepted", "untilAt": None, "graceMinutes": 30, "penaltyPctPerDay": 0}
        in_grace = self.published(homework_input(title="Grace", dueAt=iso(timedelta(minutes=-10)), latePolicy=grace))
        status, result = self.submit(in_grace["id"])
        self.assertEqual((status, result["late"]), (201, False))
        hard = self.published(homework_input(title="Hard close", closeAt=iso(timedelta(minutes=-1))))
        self.assertEqual(self.submit(hard["id"])[1]["code"], "assignment_closed")

    def test_attempt_limit_open_date_and_solutions_after_submit(self):  # ASSESS-02 [F01, AU-D1-13]
        question = {"id": "q1", "type": "fill", "prompt": "?", "points": 10, "answer": "4", "studentExplanation": "Sum / n."}
        work = self.published(homework_input(maxAttempts=2, solutionsVisibility="after_submit", questions=[question]))
        _, before = self.s(f"/api/work/{work['id']}")
        self.assertNotIn("studentExplanation", before["questions"][0])
        self.assertEqual(self.submit(work["id"], {"q1": "4"}, "a")[0], 201)
        _, after = self.s(f"/api/work/{work['id']}")
        self.assertEqual(after["questions"][0]["studentExplanation"], "Sum / n.")
        self.assertEqual(self.submit(work["id"], {"q1": "5"}, "b")[0], 201)
        status, body = self.submit(work["id"], {"q1": "6"}, "c")
        self.assertEqual((status, body["code"]), (409, "max_attempts_reached"))
        _, other = self.s(f"/api/work/{work['id']}", student="demo-bo")
        self.assertNotIn("studentExplanation", other["questions"][0])
        later = self.create(homework_input(title="Later"))
        self.t(f"/api/teacher/assignments/{later['id']}/publish", "POST", {"openAt": iso(timedelta(days=1))})
        status, body = self.submit(later["id"])
        self.assertEqual((status, body["code"]), (409, "not_open_yet"))

    def test_incomplete_and_invalid_choice(self):  # ASSESS-12 [AU-D1-14], ASSESS-07
        work = self.published(homework_input())
        status, body = self.submit(work["id"], {"q1": "4", "q-removed": "old"})
        self.assertEqual((status, body["code"]), (400, "incomplete_submission"))
        self.assertEqual(body["details"], {"missing": ["q2"], "extra": ["q-removed"]})
        status, body = self.submit(work["id"], {"q1": "4", "q2": "   "})
        self.assertEqual(body["details"]["missing"], ["q2"])
        choice = {"id": "c1", "type": "choice", "prompt": "?", "points": 5, "choices": ["A", "B"], "answer": "A"}
        work = self.published(homework_input(title="Choice", questions=[choice]))
        status, body = self.submit(work["id"], {"c1": "C"})
        self.assertEqual((status, body["code"]), (400, "invalid_request"))
        self.assertEqual(self.submit(work["id"], {"c1": "B"}, "ok")[0], 201)

    def test_autocheck_rows_and_events(self):  # §17.1 submit v2
        work = self.published(homework_input())
        status, result = self.submit(work["id"], {"q1": "4.0", "q2": "Explanation"})
        self.assertEqual(status, 201, result)
        self.assertEqual(result["autoChecked"], {"q1": True, "q2": None})
        with self.db() as db:
            sub = db.execute("SELECT * FROM submissions WHERE id=?", (result["id"],)).fetchone()
            self.assertEqual(json.loads(sub["autocheck_json"])["q1"]["reason"], "numeric_tolerance")
            self.assertEqual((sub["grade_status"], sub["assignment_version"], sub["actor_role"]), ("ungraded", 1, "demo"))
            items = {r["question_id"]: r for r in db.execute("SELECT * FROM submission_item_scores WHERE submission_id=?", (result["id"],))}
            self.assertEqual((items["q1"]["auto_correct"], items["q1"]["auto_score"]), (1, 10.0))
            self.assertIsNone(items["q2"]["auto_correct"])
            events = db.execute("SELECT event_type, checked_by, question_id, assignment_version FROM events ORDER BY id").fetchall()
            self.assertEqual([e["event_type"] for e in events], ["answer_submitted", "answer_submitted", "work_submitted"])
            self.assertEqual([e["checked_by"] for e in events], ["server", "", ""])
            self.assertTrue(all(e["assignment_version"] == 1 for e in events))
            grade_event = db.execute("SELECT action, actor_label FROM grade_events WHERE submission_id=?", (result["id"],)).fetchone()
            self.assertEqual((grade_event["action"], grade_event["actor_label"]), ("autocheck", "Auto-check"))
            self.assertIsNotNone(db.execute("SELECT frozen_at FROM assignments WHERE id=?", (work["id"],)).fetchone()[0])

    def test_replay_writes_no_events(self):  # ASSESS-21 [AU-D3-21]
        work = self.published(homework_input())
        _, first = self.submit(work["id"], request_id="same")
        with self.db() as db:
            count = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        status, again = self.submit(work["id"], request_id="same")
        self.assertEqual((status, again["id"], again["replayed"]), (201, first["id"], True))
        with self.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0], count)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM submissions").fetchone()[0], 1)

    def test_time_limits(self):  # ASSESS-22 [AU-D1-13]
        start = dbmod.utcnow()
        with freeze_time(start) as clock:
            limit = {"minutes": 30, "onExpiry": "reject"}
            work = self.published(homework_input(timeLimit=limit))
            status, body = self.submit(work["id"])
            self.assertEqual((status, body["code"]), (409, "attempt_not_started"))
            status, started = self.s(f"/api/work/{work['id']}/start", "POST", {})
            self.assertEqual(status, 201, started)
            self.assertEqual(started["attempt"], 1)
            status, again = self.s(f"/api/work/{work['id']}/start", "POST", {})
            self.assertEqual(again["startedAt"], started["startedAt"])
            clock.advance(minutes=29)
            status, result = self.submit(work["id"], request_id="in-time")
            self.assertEqual(status, 201, result)
            self.assertAlmostEqual(result["timeUsedSeconds"], 1740, delta=2)
            self.assertFalse(result["overTime"])
            self.s(f"/api/work/{work['id']}/start", "POST", {})
            self.assertEqual(self.s(f"/api/drafts/{work['id']}", "PUT",
                                    {"answers": {"q1": "9"}, "clientTs": dbmod.now_ms(), "assignmentVersion": 1})[0], 200)
            clock.advance(minutes=33)
            status, body = self.submit(work["id"], request_id="too-late")
            self.assertEqual((status, body["code"]), (409, "time_limit_exceeded"))
            _, draft = self.s(f"/api/drafts/{work['id']}")
            self.assertEqual(draft["answers"]["q1"]["value"], "9")
            marked = self.published(homework_input(title="Marked", timeLimit={"minutes": 30, "onExpiry": "submit_marked"}))
            self.s(f"/api/work/{marked['id']}/start", "POST", {})
            clock.advance(minutes=33)
            status, result = self.submit(marked["id"], request_id="marked")
            self.assertEqual((status, result["overTime"]), (201, True))
            self.assertAlmostEqual(result["timeUsedSeconds"], 33 * 60, delta=2)
            with self.db() as db:
                row = db.execute("SELECT over_time, time_used_seconds, attempt_started_at FROM submissions WHERE id=?",
                                 (result["id"],)).fetchone()
                self.assertEqual(row["over_time"], 1)
                self.assertIsNotNone(row["attempt_started_at"])
                self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE event_type='attempt_started'").fetchone()[0], 3)
            untimed = self.published(homework_input(title="Untimed"))
            self.assertEqual(self.s(f"/api/work/{untimed['id']}/start", "POST", {})[0], 400)

    def test_timed_auto_submit_accepts_blank_answers(self):
        work = self.published(homework_input(timeLimit={"minutes": 5, "onExpiry": "submit_marked"}))
        self.s(f"/api/work/{work['id']}/start", "POST", {})
        status, result = self.submit(work["id"], {"q1": "4"}, autoSubmit=True)
        self.assertEqual(status, 201, result)
        with self.db() as db:
            answers = json.loads(db.execute("SELECT answers_json FROM submissions WHERE id=?", (result["id"],)).fetchone()[0])
        self.assertEqual(answers, {"q1": "4", "q2": ""})
        untimed = self.published(homework_input(title="Untimed"))
        self.assertEqual(self.submit(untimed["id"], {"q1": "4"}, autoSubmit=True)[1]["code"], "incomplete_submission")

    def test_student_submission_list_hides_unreleased_grades(self):
        work = self.published(homework_input())
        _, sub = self.submit(work["id"])
        with self.db() as db:
            db.execute("UPDATE submissions SET grade=15, feedback='Good', grade_status='draft' WHERE id=?", (sub["id"],))
            db.execute("UPDATE submission_item_scores SET score=8, comment='ok' WHERE submission_id=? AND question_id='q1'",
                       (sub["id"],))
        _, mine = self.s(f"/api/submissions?assignmentId={work['id']}")
        self.assertEqual((mine[0]["status"], mine[0]["grade"], mine[0]["feedback"], mine[0]["items"]),
                         ("waiting_for_teacher", None, None, None))
        self.assertEqual(mine[0]["maxPoints"], 20)
        with self.db() as db:
            db.execute("UPDATE submissions SET grade_status='released' WHERE id=?", (sub["id"],))
        _, mine = self.s("/api/submissions")
        self.assertEqual((mine[0]["status"], mine[0]["grade"], mine[0]["feedback"]), ("released", 15, "Good"))
        self.assertEqual(mine[0]["items"]["q1"], {"score": 8, "comment": "ok"})
        _, other = self.s("/api/submissions", student="demo-bo")
        self.assertEqual(other, [])


class DraftTests(AssessCase):
    cls = "drafts"

    def put(self, work_id, answers, client_ts, student="demo-ada", version=1):
        return self.s(f"/api/drafts/{work_id}", "PUT", {"answers": answers, "clientTs": client_ts, "assignmentVersion": version},
                      student=student)

    def test_drafts_restore_and_ignore_stale_writes(self):  # ASSESS-11 [DA07, AU-D3-08]
        work = self.published(homework_input())
        status, draft = self.put(work["id"], {"q1": "4"}, 2000)
        self.assertEqual(status, 200, draft)
        self.assertEqual(draft["answers"]["q1"]["value"], "4")
        with self.db() as db:
            event = db.execute("SELECT payload_json, event_type FROM events WHERE event_type='answer_draft'").fetchone()
        payload = json.loads(event["payload_json"])
        self.assertEqual((payload["length"], payload["questionId"]), (1, "q1"))
        self.assertEqual(len(payload["valueHash"]), 16)
        self.assertNotIn("value", payload)
        status, stale = self.put(work["id"], {"q1": "old tab"}, 1000)
        self.assertEqual((status, stale["answers"]["q1"]["value"]), (200, "4"))
        _, restored = self.s(f"/api/drafts/{work['id']}")  # "another browser": same account, no local state
        self.assertEqual(restored["answers"]["q1"]["value"], "4")
        self.assertEqual(restored["assignmentVersion"], 1)
        _, newer = self.put(work["id"], {"q1": "5", "q2": "words"}, 3000)
        self.assertEqual({k: v["value"] for k, v in newer["answers"].items()}, {"q1": "5", "q2": "words"})
        with self.db() as db:  # throttled: q1 changed twice within 15 s → one answer_draft event for q1
            counts = dict(db.execute("SELECT question_id, COUNT(*) FROM events WHERE event_type='answer_draft' GROUP BY question_id").fetchall())
        self.assertEqual(counts, {"q1": 1, "q2": 1})
        self.assertEqual(self.put(work["id"], {"q1": "x" * 16001}, 4000)[0], 400)
        _, other = self.s(f"/api/drafts/{work['id']}", student="demo-bo")
        self.assertEqual(other["answers"], {})

    def test_drafts_require_a_visible_assignment(self):
        draft = self.create(homework_input())
        self.assertEqual(self.put(draft["id"], {"q1": "4"}, 1)[0], 404)
        with self.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM answer_drafts").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
