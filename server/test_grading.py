"""Grading and the gradebook — owned by GRADE (spec §6.4, §9.2 GRADE-01…14).

``test_teacher_workflow_answer_redaction_grading_and_hub`` was moved from server/test_app.py by FOUNDATION
(unchanged in intent). Every other test builds its rows with ``server/testsupport.py`` builders only.
"""

from __future__ import annotations

import csv
import io
import json
import unittest
from datetime import timedelta
from urllib.parse import quote

from server import analytics, auth, db as dbmod, readers
from server import testsupport
from server.testsupport import TEACHER_KEY, ApiTestCase

CLS = "c1"
LIVE = "live-course"
FUTURE_DUE = "2030-01-01T00:00:00+00:00"
TWO_QUESTIONS = [
    {"id": "q1", "type": "fill", "prompt": "What does mean(c(2, 4, 6)) return?", "points": 10, "choices": [],
     "starterCode": "", "answer": "4", "explanation": "Rubric: 10 for 4."},
    {"id": "q2", "type": "text", "prompt": "Explain what a vector is.", "points": 10, "choices": [], "starterCode": "",
     "answer": "", "explanation": "Rubric: mention one type."},
]
FOUR_TYPES = [
    {"id": "c", "type": "choice", "prompt": "Pick", "points": 5, "choices": ["A", "B"], "starterCode": "", "answer": "A"},
    {"id": "f", "type": "fill", "prompt": "Fill", "points": 5, "choices": [], "starterCode": "", "answer": "4"},
    {"id": "p", "type": "predict", "prompt": "Predict", "points": 5, "choices": [], "starterCode": "", "answer": "[1] 3"},
    {"id": "t", "type": "text", "prompt": "Explain", "points": 5, "choices": [], "starterCode": "", "answer": ""},
]
LONG = "The left join keeps every row of the first table and matches the second one."


def rows_of(raw: bytes) -> list[list[str]]:
    text = raw.decode("utf-8")
    return list(csv.reader(io.StringIO(text.lstrip("﻿"))))


class GradingApiCase(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create_course(CLS)
        with self.db() as db:
            for sid, name in (("s1", "Ada Chen"), ("s2", "Bo Lin"), ("s3", "Cy Wu")):
                testsupport.add_roster(db, CLS, sid, display_name=name)

    # -- helpers ----------------------------------------------------------------------------------
    def hw(self, cls: str = CLS, **kwargs):
        kwargs.setdefault("questions", TWO_QUESTIONS)
        kwargs.setdefault("due_at", FUTURE_DUE)
        with self.db() as db:
            return testsupport.publish_work(db, cls, **kwargs)

    def submit(self, student: str, rec, answers: dict, cls: str = CLS, **kwargs) -> str:
        with self.db() as db:
            return testsupport.make_autochecked_submission(db, cls, student, rec.id, answers, **kwargs)

    def put_grade(self, sub: str, body: dict, key: str | None = TEACHER_KEY, cls: str = CLS, **kwargs):
        return self.request(f"/api/teacher/submissions/{sub}/grade?classId={cls}", "PUT", body, key, **kwargs)

    def detail(self, sub: str, key: str | None = TEACHER_KEY, cls: str = CLS, **kwargs):
        status, body = self.request(f"/api/teacher/submissions/{sub}?classId={cls}", key=key, **kwargs)
        self.assertEqual(status, 200, body)
        return body

    def queue(self, query: str = "", key: str | None = TEACHER_KEY, cls: str = CLS, **kwargs):
        status, body = self.request(f"/api/teacher/grading/queue?classId={cls}{query}", key=key, **kwargs)
        self.assertEqual(status, 200, body)
        return body

    def staff_key(self, role: str, name: str, cls: str = CLS) -> str:
        key = auth.new_staff_key()
        with self.db() as db, dbmod.write_tx(db):
            db.execute("""INSERT INTO staff (id, class_id, display_name, role, key_hash, key_prefix, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'instructor', ?)""",
                       (f"staff-{role}{len(name)}", cls, name, role, auth.hash_staff_key(key), auth.key_prefix(key), dbmod.now()))
        return key

    def events(self, event_type: str) -> list:
        with self.db() as db:
            return [dict(r) for r in db.execute("SELECT * FROM events WHERE event_type=? ORDER BY id", (event_type,))]


class GradingTests(ApiTestCase):
    def test_teacher_workflow_answer_redaction_grading_and_hub(self):
        cls = "css190"
        status, result = self.request(
            f"/api/teacher/samples?classId={cls}", "POST", key="test-teacher-key"
        )
        self.assertEqual(status, 201)
        self.assertEqual(result["created"], 5)
        status, student_list = self.request(f"/api/work?classId={cls}", student="s1")
        self.assertEqual(status, 200)
        self.assertEqual(student_list, [])
        status, teacher_list = self.request(
            f"/api/work?classId={cls}", key="test-teacher-key"
        )
        self.assertEqual(status, 200)
        self.assertTrue(all(work["status"] == "draft" for work in teacher_list))
        practice = next(work for work in teacher_list if work["kind"] == "practice")
        homework = next(
            work for work in teacher_list if work["title"].startswith("Homework 4")
        )
        self.assertIn("answer", practice["questions"][0])
        for work in (practice, homework):
            status, _ = self.request(
                f"/api/work/{work['id']}/status?classId={cls}",
                "POST",
                {"status": "published"},
                "test-teacher-key",
            )
            self.assertEqual(status, 200)
        status, student_list = self.request(f"/api/work?classId={cls}", student="s1")
        self.assertEqual(status, 200)
        self.assertEqual(len(student_list), 2)
        self.assertNotIn("answer", student_list[0]["questions"][0])
        self.assertNotIn("explanation", student_list[0]["questions"][0])
        status, checked = self.request(
            f"/api/work/{practice['id']}/check?classId={cls}",
            "POST",
            {
                "studentId": "s1",
                "studentName": "Ada",
                "questionId": "p1",
                "answer": "seq(1, 5, by = 2)",
            }, student="s1")
        self.assertEqual(status, 200)
        self.assertTrue(checked["correct"])
        status, submitted = self.request(
            f"/api/work/{homework['id']}/submit?classId={cls}",
            "POST",
            {
                "studentId": "s1",
                "studentName": "Ada",
                "answers": {"h4a": "sum(edges$to == 'B')", "h4b": "Reciprocity"},
            }, student="s1")
        self.assertEqual(status, 201)
        self.assertEqual(submitted["attempt"], 1)
        status, second = self.request(
            f"/api/work/{homework['id']}/submit?classId={cls}",
            "POST",
            {
                "studentId": "s1",
                "studentName": "Ada",
                "answers": {"h4a": "2", "h4b": "reciprocal"},
            }, student="s1")
        self.assertEqual(second["attempt"], 2)
        status, _ = self.request(
            f"/api/submissions/{second['id']}/grade?classId={cls}",
            "POST",
            {"grade": 18, "feedback": "解释清楚"},
        )
        self.assertEqual(status, 401)
        status, _ = self.request(
            f"/api/submissions/{second['id']}/grade?classId={cls}",
            "POST",
            {"grade": 18, "feedback": "解释清楚"},
            "test-teacher-key",
        )
        self.assertEqual(status, 200)
        status, own = self.request(f"/api/submissions?classId={cls}&studentId=s1", student="s1")
        self.assertEqual(len(own), 2)
        self.assertEqual(own[0]["grade"], 18)
        status, _ = self.request(f"/api/teacher/hub?classId={cls}")
        self.assertEqual(status, 401)
        status, hub = self.request(
            f"/api/teacher/hub?classId={cls}", key="test-teacher-key"
        )
        self.assertEqual(status, 200)
        self.assertEqual(hub["students"][0]["attemptsByAssignment"][homework["id"]], 2)
        self.assertEqual(hub["students"][0]["scoreByAssignment"][homework["id"]], 18)


class GradeSaveTests(GradingApiCase):
    def test_grade01_item_scores_draft_history_and_no_release(self):
        rec = self.hw(grades_visibility="on_release")
        sub = self.submit("s1", rec, {"q1": "4", "q2": "An ordered set of one type."})
        status, detail = self.put_grade(sub, {"items": {"q1": {"score": 8, "comment": "Show the division."},
                                                        "q2": {"score": 9, "comment": ""}}, "action": "save"})
        self.assertEqual(status, 200, detail)
        self.assertEqual((detail["total"], detail["maxPoints"], detail["submission"]["gradeStatus"]), (17, 20, "draft"))
        self.assertEqual({i["questionId"]: (i["score"], i["comment"]) for i in detail["items"]},
                         {"q1": (8, "Show the division."), "q2": (9, "")})
        with self.db() as db:
            items = db.execute("SELECT question_id, score, comment, overridden FROM submission_item_scores "
                               "WHERE submission_id=? ORDER BY question_id", (sub,)).fetchall()
            self.assertEqual([tuple(r) for r in items], [("q1", 8.0, "Show the division.", 1), ("q2", 9.0, "", 0)])
            event = db.execute("SELECT * FROM grade_events WHERE submission_id=? ORDER BY id DESC", (sub,)).fetchone()
            self.assertEqual((event["action"], event["total_before"], event["total_after"], event["status_before"],
                              event["status_after"], event["actor_label"]),
                             ("save_draft", None, 17.0, "ungraded", "draft", "Instructor (local key)"))
            self.assertEqual(json.loads(event["items_after_json"])["q1"], {"comment": "Show the division.", "score": 8})
            self.assertIsNone(json.loads(event["items_before_json"])["q1"]["score"])
            row = db.execute("SELECT grade, grade_status, released_at FROM submissions WHERE id=?", (sub,)).fetchone()
            self.assertEqual((row["grade"], row["grade_status"], row["released_at"]), (17.0, "draft", None))
            audit_row = db.execute("SELECT action, target_id FROM teacher_actions WHERE action='grade_save'").fetchone()
            self.assertEqual(tuple(audit_row), ("grade_save", sub))
        self.assertEqual(self.events("grade_released"), [])
        # The student's own list (ASSESS, §6.3) shows nothing until release, then the released total.
        status, own = self.request(f"/api/submissions?classId={CLS}&studentId=s1", student="s1")
        self.assertEqual(status, 200, own)
        self.assertEqual((own[0]["grade"], own[0]["feedback"]), (None, None))
        status, _ = self.put_grade(sub, {"items": {}, "action": "release"})
        self.assertEqual(status, 200)
        status, own = self.request(f"/api/submissions?classId={CLS}&studentId=s1", student="s1")
        self.assertEqual(own[0]["grade"], 17)

    def test_grade02_autocheck_prefill_overridden_and_needs_review(self):
        rec = self.hw(questions=FOUR_TYPES)
        sub = self.submit("s1", rec, {"c": "A", "f": "4", "p": "[1] 4", "t": "words"},
                          auto={"c": True, "f": True, "p": False, "t": None})
        detail = self.detail(sub)
        items = {i["questionId"]: i for i in detail["items"]}
        self.assertEqual((items["c"]["autoCorrect"], items["c"]["autoScore"], items["c"]["score"]), (True, 5, 5))
        self.assertEqual((items["p"]["autoCorrect"], items["p"]["score"]), (False, 0))
        self.assertEqual((items["t"]["autoCorrect"], items["t"]["score"], items["t"]["autoReason"]), (None, None, "not_gradable"))
        self.assertFalse(any(i["overridden"] for i in detail["items"]))
        self.assertIsNone(detail["total"])
        status, saved = self.put_grade(sub, {"items": {"p": {"score": 3, "comment": "Off by one"}, "t": {"score": 4, "comment": ""}},
                                             "action": "save"})
        self.assertEqual(status, 200, saved)
        items = {i["questionId"]: i for i in saved["items"]}
        self.assertEqual({k: v["overridden"] for k, v in items.items()}, {"c": False, "f": False, "p": True, "t": False})
        self.assertEqual(saved["total"], 17)

    def test_partial_save_keeps_needs_grading_and_release_requires_every_score(self):
        rec = self.hw()
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"})
        status, saved = self.put_grade(sub, {"items": {"q1": {"score": 10, "comment": ""}}, "action": "save"})
        self.assertEqual(status, 200, saved)
        self.assertEqual((saved["submission"]["gradeStatus"], saved["total"]), ("ungraded", None))
        status, error = self.put_grade(sub, {"items": {}, "action": "release"})
        self.assertEqual((status, error["code"]), (400, "invalid_request"))
        self.assertEqual(error["details"]["missing"], ["q2"])

    def test_validation_errors_are_readable(self):
        rec = self.hw()
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"})
        cases = [
            ({"items": {"q1": {"score": 11, "comment": ""}}, "action": "save"}, "Score for question 1 must be from 0 to 10"),
            ({"items": {"zz": {"score": 1, "comment": ""}}, "action": "save"}, "Unknown question"),
            ({"items": {}, "action": "publish"}, "action must be"),
            ({"items": {}, "adjustment": {"points": 2, "reason": "bonus"}, "action": "save"}, "Adjustment"),
            ({"items": {"q1": {"score": True, "comment": ""}}, "action": "save"}, "Score for question 1"),
            ({"items": [], "action": "save"}, "items must be an object"),
        ]
        for body, message in cases:
            status, error = self.put_grade(sub, body)
            self.assertEqual((status, error["code"]), (400, "invalid_request"), body)
            self.assertIn(message, error["error"])
        status, error = self.request(f"/api/teacher/submissions/sub-missing/grade?classId={CLS}", "PUT",
                                     {"items": {}, "action": "save"}, TEACHER_KEY)
        self.assertEqual((status, error["code"]), (404, "not_found"))

    def test_stale_base_grade_event_is_rejected(self):
        rec = self.hw()
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"})
        base = self.detail(sub)["latestGradeEventId"]
        self.assertIsNotNone(base)
        body = {"items": {"q1": {"score": 10, "comment": ""}, "q2": {"score": 5, "comment": ""}}, "action": "save"}
        status, first = self.put_grade(sub, {**body, "baseGradeEventId": base})
        self.assertEqual(status, 200, first)
        status, error = self.put_grade(sub, {**body, "baseGradeEventId": base})
        self.assertEqual((status, error["code"]), (409, "stale_version"))
        status, again = self.put_grade(sub, {**body, "baseGradeEventId": first["latestGradeEventId"]})
        self.assertEqual(status, 200, again)

    def test_grade04_feedback_preserved_and_history_labels(self):
        rec = self.hw()
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"})
        items = {"q1": {"score": 10, "comment": ""}, "q2": {"score": 6, "comment": "Mention the type."}}
        status, _ = self.put_grade(sub, {"items": items, "feedback": "Good start.", "action": "save"})
        self.assertEqual(status, 200)
        ta_key = self.staff_key("ta", "Wang (TA)")
        status, saved = self.put_grade(sub, {"items": {"q2": {"score": 7, "comment": "Better."}}, "action": "save"}, key=ta_key)
        self.assertEqual(status, 200, saved)
        self.assertEqual((saved["submission"]["feedback"], saved["total"]), ("Good start.", 17))
        labels = [h["actorLabel"] for h in saved["history"] if h["action"] == "save_draft"]
        self.assertEqual(labels, ["Instructor (local key)", "Wang (TA)"])
        self.assertTrue(all(not h["actorLabel"].startswith("staff-") for h in saved["history"]))
        self.assertEqual(saved["history"][0]["action"], "autocheck")

    def test_grade04_kiwi_grader_label_is_the_username(self):
        with self.db() as db, dbmod.write_tx(db):
            db.execute("INSERT INTO kiwi_links (class_id, name) VALUES (?, ?)", (LIVE, LIVE))
        self.create_course(LIVE)
        with self.db() as db:
            testsupport.add_roster(db, LIVE, "kiwi-s1", source="kiwi", kiwi_email="ada@example.edu")
        rec = self.hw(cls=LIVE)
        sub = self.submit("kiwi-s1", rec, {"q1": "4", "q2": "words"}, cls=LIVE)
        with testsupport.fake_kiwi_identity("ta", can_view=True, user_role="ta", class_id=LIVE, user_id="kiwi-ta-7",
                                            username="ta@css-kiwi.local") as token:
            status, saved = self.put_grade(sub, {"items": {"q2": {"score": 5, "comment": ""}}, "action": "save"},
                                           key=None, cls=LIVE, token=token)
            self.assertEqual(status, 200, saved)
            queue = self.queue(key=None, cls=LIVE, token=token)
        self.assertEqual(saved["history"][-1]["actorLabel"], "ta@css-kiwi.local")
        self.assertNotIn("kiwi-ta-7", json.dumps(saved["history"]))
        self.assertEqual(queue["counts"]["toGrade"], 0)

    def test_grade14_auto_late_penalty_and_remove(self):
        due = "2026-10-20T00:00:00+00:00"
        rec = self.hw(due_at=due, late_policy={"mode": "accept_marked", "penaltyPctPerDay": 10},
                      questions=[dict(TWO_QUESTIONS[0], type="text")] + TWO_QUESTIONS[1:])
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"}, at="2026-10-21T02:00:00+00:00")
        detail = self.detail(sub)
        self.assertEqual(detail["late"], {"lateHours": 26.0, "penaltyPctPerDay": 10})
        self.assertEqual(detail["adjustment"], {"points": -4, "reason": "Late penalty (auto)", "auto": True})
        self.assertIn("Late · 26 h", [f["text"] for f in detail["flags"]])
        full = {"q1": {"score": 10, "comment": ""}, "q2": {"score": 10, "comment": ""}}
        status, saved = self.put_grade(sub, {"items": full, "adjustment": detail["adjustment"], "action": "save"})
        self.assertEqual((status, saved["total"], saved["adjustment"]["points"]), (200, 16, -4))
        status, removed = self.put_grade(sub, {"items": full, "adjustment": {"points": 0, "reason": "Late penalty removed"},
                                               "action": "save"})
        self.assertEqual((status, removed["total"]), (200, 20))
        self.assertEqual(removed["adjustment"], {"points": 0, "reason": "Late penalty removed", "auto": False})
        with self.db() as db:
            row = db.execute("SELECT adjustment_points, adjustment_reason FROM submissions WHERE id=?", (sub,)).fetchone()
            self.assertEqual(tuple(row), (0.0, "Late penalty removed"))
            actions = [r[0] for r in db.execute("SELECT action FROM grade_events WHERE submission_id=? ORDER BY id", (sub,))]
        self.assertIn("adjust", actions)

    def test_auto_late_penalty_applies_when_the_first_save_omits_it(self):
        rec = self.hw(due_at="2026-10-20T00:00:00+00:00", late_policy={"penaltyPctPerDay": 10},
                      questions=[dict(TWO_QUESTIONS[0], type="text")] + TWO_QUESTIONS[1:])
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"}, at="2026-10-20T05:00:00+00:00")
        status, saved = self.put_grade(sub, {"items": {"q1": {"score": 10, "comment": ""}, "q2": {"score": 10, "comment": ""}},
                                             "action": "save"})
        self.assertEqual((status, saved["total"], saved["adjustment"]["reason"]), (200, 18, "Late penalty (auto)"))


class ReleaseTests(GradingApiCase):
    def test_grade05_ta_permissions_and_save_always_draft(self):
        rec = self.hw(grades_visibility="immediately")
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"})
        ta = self.staff_key("ta", "Wang (TA)")
        status, me = self.request(f"/api/me?classId={CLS}", key=ta)
        self.assertIn("grade", me["permissions"])
        self.assertIn("viewAiRules", me["permissions"])
        self.assertNotIn("manageAiRules", me["permissions"])
        self.assertNotIn("releaseGrades", me["permissions"])
        body = {"items": {"q1": {"score": 10, "comment": ""}, "q2": {"score": 8, "comment": ""}}, "action": "save"}
        status, saved = self.put_grade(sub, body, key=ta)
        self.assertEqual((status, saved["submission"]["gradeStatus"]), (200, "draft"))
        status, error = self.put_grade(sub, {**body, "action": "release"}, key=ta)
        self.assertEqual((status, error["code"]), (403, "role_required"))
        status, error = self.request(f"/api/teacher/assignments/{rec.id}/release?classId={CLS}", "POST", {}, ta)
        self.assertEqual((status, error["code"]), (403, "role_required"))
        status, error = self.request(f"/api/submissions/{sub}/grade?classId={CLS}", "POST", {"grade": 18}, ta)
        self.assertEqual(status, 403)
        status, error = self.request(f"/api/teacher/submissions/{sub}/unrelease?classId={CLS}", "POST", {}, ta)
        self.assertEqual(status, 403)
        status, saved = self.put_grade(sub, body)   # instructor: save is still a draft with grades_visibility=immediately
        self.assertEqual(saved["submission"]["gradeStatus"], "draft")
        with self.db() as db:
            testsupport.update_settings(db, CLS, {"grading": {"taCanRelease": True, "defaultGradesVisibility": "on_release"}})
        status, released = self.put_grade(sub, {**body, "action": "release"}, key=ta)
        self.assertEqual((status, released["submission"]["gradeStatus"]), (200, "released"))
        self.assertEqual(len(self.events("grade_released")), 1)

    def test_release_and_unrelease_write_events_and_history(self):
        rec = self.hw(grades_visibility="on_release")
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"})
        body = {"items": {"q1": {"score": 10, "comment": ""}, "q2": {"score": 7, "comment": ""}}, "action": "release"}
        status, released = self.put_grade(sub, body)
        self.assertEqual((status, released["submission"]["gradeStatus"]), (200, "released"))
        event = self.events("grade_released")[0]
        payload = json.loads(event["payload_json"])
        self.assertEqual((event["student_id"], payload["submissionId"], payload["total"], payload["maxPoints"],
                          payload["releasedBy"]), ("s1", sub, 17, 20, "Instructor (local key)"))
        status, back = self.request(f"/api/teacher/submissions/{sub}/unrelease?classId={CLS}", "POST", {}, TEACHER_KEY)
        self.assertEqual((status, back["submission"]["gradeStatus"], back["total"]), (200, "draft", 17))
        self.assertEqual(back["history"][-1]["action"], "unrelease")
        status, error = self.request(f"/api/teacher/submissions/{sub}/unrelease?classId={CLS}", "POST", {}, TEACHER_KEY)
        self.assertEqual(status, 400)

    def test_grade12_bulk_release_of_twelve_drafts(self):
        rec = self.hw(grades_visibility="on_release")
        with self.db() as db:
            for n in range(12):
                testsupport.add_roster(db, CLS, f"b{n:02d}", display_name=f"Bulk {n:02d}")
        subs = [self.submit(f"b{n:02d}", rec, {"q1": "4", "q2": "w"}) for n in range(12)]
        preview = self.submit("preview-instructor", rec, {"q1": "4", "q2": "w"}, preview=True)
        for sub in subs + [preview]:
            status, _ = self.put_grade(sub, {"items": {"q2": {"score": 5, "comment": ""}}, "action": "save"})
            self.assertEqual(status, 200)
        with self.db() as db:
            from server import readers
            counts = readers.grading_counts(db, CLS, rec.id)
        self.assertEqual((counts["toRelease"], counts["toGrade"]), (12, 0))
        status, result = self.request(f"/api/teacher/assignments/{rec.id}/release?classId={CLS}", "POST", {}, TEACHER_KEY)
        self.assertEqual((status, result), (200, {"released": 12}))
        with self.db() as db:
            from server import readers
            self.assertEqual(readers.grading_counts(db, CLS, rec.id)["toRelease"], 0)
            self.assertEqual(db.execute("SELECT grade_status FROM submissions WHERE id=?", (preview,)).fetchone()[0], "draft")
            bulk = db.execute("SELECT COUNT(*) FROM grade_events WHERE action='bulk_release'").fetchone()[0]
        self.assertEqual((len(self.events("grade_released")), bulk), (12, 12))
        status, result = self.request(f"/api/teacher/assignments/{rec.id}/release?classId={CLS}", "POST",
                                      {"submissionIds": [preview]}, TEACHER_KEY)
        self.assertEqual(result, {"released": 1})


class QueueTests(GradingApiCase):
    def test_grade03_latest_attempts_counts_flags_and_earlier_attempts(self):
        rec = self.hw()
        first = self.submit("s1", rec, {"q1": "4", "q2": "short"}, at="2026-10-19T00:00:00+00:00")
        self.put_grade(first, {"items": {"q2": {"score": 5, "comment": ""}}, "action": "release"})
        latest = self.submit("s1", rec, {"q1": "5", "q2": "short"}, at="2026-10-19T02:00:00+00:00")
        with self.db() as db:
            testsupport.make_chat_turn(db, CLS, "s2", "Answer?", "It is 4.", assignment_id=rec.id, flagged=True,
                                       guard_status="redacted", at="2026-10-19T03:00:00+00:00")
        flagged_ai = self.submit("s2", rec, {"q1": "4", "q2": LONG}, at="2026-10-19T04:00:00+00:00")
        identical = self.submit("s3", rec, {"q1": "4", "q2": "  " + LONG}, at="2026-10-19T05:00:00+00:00")
        self.submit("preview-instructor", rec, {"q1": "4", "q2": "x"}, preview=True)
        queue = self.queue()
        self.assertEqual(queue["counts"]["toGrade"], 3)
        self.assertEqual(queue["counts"]["flagged"], 2)
        self.assertEqual([c["submission"]["id"] for c in queue["cards"]], [latest, flagged_ai, identical])
        self.assertEqual(queue["order"], [latest, flagged_ai, identical])
        card = queue["cards"][0]
        self.assertEqual([a["id"] for a in card["earlierAttempts"]], [first])
        self.assertEqual(card["earlierAttempts"][0]["gradeStatus"], "released")
        self.assertEqual(card["studentLabel"], "Ada Chen")
        everything = self.queue("&show=all")
        self.assertEqual(everything["total"], 4)
        flagged = self.queue("&show=flagged")
        self.assertEqual({c["submission"]["id"] for c in flagged["cards"]}, {flagged_ai, identical})
        kinds = {c["submission"]["id"]: {f["kind"] for f in c["flags"]} for c in flagged["cards"]}
        self.assertEqual(kinds[flagged_ai], {"ai_final_answer", "identical_answer"})
        self.assertEqual(kinds[identical], {"identical_answer"})
        self.assertEqual(self.queue("&show=graded")["total"], 0)
        with_preview = self.queue("&show=all&includePreview=1")
        self.assertEqual(with_preview["total"], 5)
        old = self.detail(first)
        self.assertIn("newer_attempt", {f["kind"] for f in old["flags"]})

    def test_filters_search_group_and_student(self):
        rec = self.hw()
        other = self.hw(title="Other homework")
        group = None
        with self.db() as db:
            group = testsupport.make_group(db, CLS, "section", "Section A", ["s1"])
        a = self.submit("s1", rec, {"q1": "4", "q2": "x"}, at="2026-10-19T01:00:00+00:00")
        b = self.submit("s2", rec, {"q1": "4", "q2": "x"}, at="2026-10-19T02:00:00+00:00")
        c = self.submit("s3", other, {"q1": "4", "q2": "x"}, at="2026-10-19T03:00:00+00:00")
        self.assertEqual(self.queue(f"&assignmentId={rec.id}")["order"], [a, b])
        self.assertEqual(self.queue(f"&groupId={group}")["order"], [a])
        self.assertEqual(self.queue("&studentId=s3")["order"], [c])
        self.assertEqual(self.queue("&search=bo%20lin")["order"], [b])
        self.assertEqual(self.queue("&search=S-002", name_mode="pseudonyms")["order"], [b])
        self.assertEqual(self.queue("&search=bo", name_mode="pseudonyms")["order"], [])
        pseudo = self.queue(f"&assignmentId={rec.id}", name_mode="pseudonyms")
        self.assertEqual([c["studentLabel"] for c in pseudo["cards"]], ["S-001", "S-002"])
        self.assertEqual(pseudo["cards"][0]["submission"]["studentName"], "S-001")
        status, error = self.request(f"/api/teacher/grading/queue?classId={CLS}&show=bogus", key=TEACHER_KEY)
        self.assertEqual(status, 400)

    def test_by_question_groups_identical_answers(self):
        rec = self.hw()
        for n, (sid, answer) in enumerate((("s1", "left_join(a, b)"), ("s2", "left_join(a,  b) "), ("s3", "merge(a, b)"))):
            self.submit(sid, rec, {"q1": "4", "q2": answer}, at=f"2026-10-19T0{n + 1}:00:00+00:00")
        queue = self.queue(f"&assignmentId={rec.id}&view=question&questionId=q2")
        self.assertEqual(queue["view"], "question")
        self.assertEqual([(g["sampleAnswer"].strip(), len(g["submissionIds"])) for g in queue["groups"]],
                         [("left_join(a, b)", 2), ("merge(a, b)", 1)])
        status, error = self.request(f"/api/teacher/grading/queue?classId={CLS}&view=question", key=TEACHER_KEY)
        self.assertEqual(status, 400)

    def test_grade10_pagination_without_a_silent_cap(self):
        rec = self.hw()
        with self.db() as db:
            for n in range(105):
                testsupport.add_roster(db, CLS, f"p{n:03d}", display_name=f"Student {n:03d}")
                testsupport.make_autochecked_submission(db, CLS, f"p{n:03d}", rec.id, {"q1": "4", "q2": "x"})
        first = self.queue()
        self.assertEqual((first["total"], first["page"], first["pageSize"], len(first["cards"]), len(first["order"])),
                         (105, 1, 10, 10, 105))
        last = self.queue("&page=11")
        self.assertEqual(len(last["cards"]), 5)
        status, book = self.request(f"/api/teacher/gradebook?classId={CLS}&pageSize=50&page=3", key=TEACHER_KEY)
        self.assertEqual((status, book["total"], len(book["rows"]), book["pageSize"]), (200, 108, 8, 50))

    def test_process_summary_counts_work_on_the_assignment(self):
        rec = self.hw()
        with self.db() as db:
            ident = testsupport.student_identity(db, CLS, "s1")
            from server import telemetry
            for ok in (True, False):
                telemetry.add_event(db, ident, {"classId": CLS, "studentId": "s1", "studentName": "Ada", "sessionId": "b1",
                                                "type": "code_run", "payload": {"code": "mean(x)", "ok": ok, "assignmentId": rec.id}})
            testsupport.make_chat_turn(db, CLS, "s1", "Hint?", "Try mean().", assignment_id=rec.id)
        sub = self.submit("s1", rec, {"q1": "4", "q2": "x"})
        process = self.detail(sub)["process"]
        self.assertEqual((process["askKiwiMode"], process["aiQuestions"], process["codeRuns"], process["codeErrors"]),
                         ("hints_only", 1, 2, 1))
        self.assertEqual(process["timelineUrl"], f"/teacher/students/s/s1/assignments/{rec.id}")

    def test_viewer_cannot_open_the_queue_but_reads_the_gradebook(self):
        self.hw()
        viewer = self.staff_key("viewer", "Shen (viewer)")
        status, _ = self.request(f"/api/teacher/grading/queue?classId={CLS}", key=viewer)
        self.assertEqual(status, 403)
        status, book = self.request(f"/api/teacher/gradebook?classId={CLS}", key=viewer)
        self.assertEqual(status, 200)
        with self.db() as db:
            logged = db.execute("SELECT category, endpoint FROM data_access_log ORDER BY id DESC").fetchone()
        self.assertEqual(tuple(logged), ("gradebook", "/api/teacher/gradebook"))


class GradebookTests(GradingApiCase):
    def test_grade06_and_grade11_cells_header_groups_and_in_class_columns(self):
        rec = self.hw(title="Week 3 HW", due_at="2030-10-24T15:59:00+00:00")
        practice = self.hw(kind="practice", title="Warm-up", questions=[TWO_QUESTIONS[0]], due_at=None)
        with self.db() as db:
            section = testsupport.make_group(db, CLS, "section", "Section A", ["s1", "s2"])
            testsupport.make_group(db, CLS, "condition", "Hints", ["s1"])
            testsupport.make_server_check(db, CLS, "s1", practice.id, "q1", "4", True)
            testsupport.make_server_check(db, CLS, "s2", practice.id, "q1", "5", False)
            testsupport.make_server_check(db, CLS, "s2", practice.id, "q1", "4", True)
        sub = self.submit("s1", rec, {"q1": "4", "q2": "x"})
        self.put_grade(sub, {"items": {"q2": {"score": 7, "comment": ""}}, "action": "save"})
        status, book = self.request(f"/api/teacher/gradebook?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, book)
        self.assertEqual(book["columns"][0]["header"], "Week 3 HW (20 pts) · Due 10/24")
        self.assertEqual(book["inClassColumns"], [{"assignmentId": practice.id, "title": "Warm-up"}])
        rows = {r["studentId"]: r for r in book["rows"]}
        self.assertEqual(rows["s1"]["cells"][0]["label"], "Draft 17/20")
        self.assertEqual((rows["s1"]["section"], rows["s1"]["condition"], rows["s1"]["pseudonym"]), ("Section A", "Hints", "S-001"))
        self.assertEqual(rows["s1"]["inClass"], [{"assignmentId": practice.id, "completionPct": 100, "accuracyPct": 100,
                                                   "correctFirstTryPct": 100}])
        # RV6-M03: wrong then right is "correct eventually 100% · first try 0%", the wording of Exercise results
        self.assertEqual(rows["s2"]["inClass"][0], {"assignmentId": practice.id, "completionPct": 100, "accuracyPct": 100,
                                                    "correctFirstTryPct": 0})
        self.assertEqual(rows["s3"]["inClass"][0]["completionPct"], 0)
        self.assertEqual(rows["s3"]["cells"][0]["label"], "Not due yet")
        self.put_grade(sub, {"items": {}, "action": "release"})
        status, book = self.request(f"/api/teacher/gradebook?classId={CLS}&groupId={section}", key=TEACHER_KEY)
        self.assertEqual([r["studentId"] for r in book["rows"]], ["s1", "s2"])
        self.assertEqual(book["rows"][0]["cells"][0]["label"], "17/20 · 1 submission")
        self.assertEqual(book["rows"][0]["cells"][0]["state"], "released")

    def test_highest_policy_search_and_pseudonyms(self):
        rec = self.hw(due_at="2026-10-01T00:00:00+00:00")
        first = self.submit("s2", rec, {"q1": "4", "q2": "x"}, at="2026-09-30T00:00:00+00:00")
        self.put_grade(first, {"items": {"q2": {"score": 8, "comment": ""}}, "action": "release"})
        second = self.submit("s2", rec, {"q1": "5", "q2": "x"}, at="2026-09-30T01:00:00+00:00")
        self.put_grade(second, {"items": {"q2": {"score": 2, "comment": ""}}, "action": "release"})
        status, book = self.request(f"/api/teacher/gradebook?classId={CLS}&policy=highest&search=bo", key=TEACHER_KEY)
        self.assertEqual([r["studentName"] for r in book["rows"]], ["Bo Lin"])
        self.assertEqual(book["rows"][0]["cells"][0]["label"], "18/20 · 2 submissions")
        status, book = self.request(f"/api/teacher/gradebook?classId={CLS}", key=TEACHER_KEY, name_mode="pseudonyms")
        self.assertEqual([r["studentName"] for r in book["rows"]], ["S-001", "S-002", "S-003"])
        self.assertEqual(book["rows"][1]["cells"][0]["label"], "2/20 · 2 submissions")
        self.assertEqual(book["rows"][0]["cells"][0]["label"], "Missing")

    def test_legacy_hub_excludes_preview_rows(self):
        rec = self.hw()
        self.submit("preview-instructor", rec, {"q1": "4", "q2": "x"}, preview=True)
        status, hub = self.request(f"/api/teacher/hub?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200)
        self.assertNotIn("preview-instructor", [s["studentId"] for s in hub["students"]])


class ExportTests(GradingApiCase):
    def setUp(self) -> None:
        super().setUp()
        with self.db() as db:
            testsupport.add_roster(db, CLS, "s4", display_name="=HYPERLINK(\"x\")", kiwi_email="evil@example.edu")
            testsupport.add_roster(db, CLS, "s5", display_name="Excluded Student")
            with dbmod.write_tx(db):
                db.execute("UPDATE roster SET excluded=1, exclusion_reason='TA test account' WHERE class_id=? AND student_id='s5'", (CLS,))
            self.group_a = testsupport.make_group(db, CLS, "section", "Section A", ["s1", "s4"])
            testsupport.make_group(db, CLS, "condition", "Hints", ["s1"])
        self.rec = self.hw(title="Week 3 HW", due_at="2026-10-20T00:00:00+00:00")
        released = self.submit("s1", self.rec, {"q1": "4", "q2": "x"}, at="2026-10-21T00:00:00+00:00")
        self.put_grade(released, {"items": {"q2": {"score": 6, "comment": ""}}, "feedback": "+1 well argued", "action": "release"})
        drafted = self.submit("s4", self.rec, {"q1": "4", "q2": "x"}, at="2026-10-19T00:00:00+00:00")
        self.put_grade(drafted, {"items": {"q2": {"score": 3, "comment": ""}}, "action": "save"})
        self.submit("s5", self.rec, {"q1": "4", "q2": "x"})
        self.submit("preview-instructor", self.rec, {"q1": "4", "q2": "x"}, preview=True)

    def download(self, path: str, key: str = TEACHER_KEY) -> tuple[int, bytes]:
        status, raw = self.request(f"/api/teacher/exports/{path}", key=key)
        return status, raw

    def test_grade08_wide_long_released_only_groups_and_neutralization(self):
        status, raw = self.download(f"grades.csv?classId={CLS}&layout=wide&releasedOnly=1")
        self.assertEqual(status, 200, raw)
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
        self.assertIn(b"\r\n", raw)
        self.assertIn("attachment", self.last_headers.get("Content-Disposition", ""))
        table = rows_of(raw)
        self.assertEqual(table[0], ["Student ID", "Name", "Email", "Section", "Condition", "Week 3 HW [20]", "Week 3 HW Late",
                                    "Week 3 HW Feedback"])
        rows = {r[0]: r for r in table[1:]}
        self.assertEqual(set(rows), {"s1", "s2", "s3", "s4"})
        self.assertEqual(rows["s1"][1:], ["Ada Chen", "", "Section A", "Hints", "16", "yes", "'+1 well argued"])
        self.assertEqual(rows["s4"][1], "'=HYPERLINK(\"x\")")
        self.assertEqual(rows["s4"][2], "evil@example.edu")
        self.assertEqual(rows["s4"][5], "")
        status, raw = self.download(f"grades.csv?classId={CLS}&layout=wide&releasedOnly=0&groupIds={self.group_a}")
        rows = {r[0]: r for r in rows_of(raw)[1:]}
        self.assertEqual(set(rows), {"s1", "s4"})
        self.assertEqual(rows["s4"][5], "13")
        status, raw = self.download(f"grades.csv?classId={CLS}&layout=long")
        table = rows_of(raw)
        self.assertEqual(table[0], ["student_id", "name", "email", "section", "condition", "assignment_id", "assignment_title",
                                    "max_points", "score", "status", "late", "late_hours", "over_time", "attempt_used",
                                    "score_policy", "graded_by", "released_at", "feedback"])
        s1 = next(r for r in table[1:] if r[0] == "s1")
        self.assertEqual((s1[3], s1[4], s1[8], s1[9], s1[10], s1[12], s1[14], s1[15]),
                         ("Section A", "Hints", "16", "released", "yes", "no", "latest", "Instructor (local key)"))

    def test_grade13_status_csv_states_and_pseudonymize(self):
        with self.db() as db:
            testsupport.make_draft(db, CLS, "s2", self.rec.id, {"q1": "4"})
        status, raw = self.download(f"assignment-status.csv?classId={CLS}")
        self.assertEqual(status, 200, raw)
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
        table = rows_of(raw)
        self.assertEqual(table[0], ["student_id", "student", "email", "section", "condition", "assignment_id", "assignment",
                                    "due_at", "state", "late", "attempts", "last_active", "draft_answered", "draft_updated_at"])
        rows = {r[0]: r for r in table[1:]}
        self.assertEqual({k: v[8] for k, v in rows.items()},
                         {"s1": "Released", "s2": "Missing · started", "s3": "Missing", "s4": "Draft"})
        self.assertEqual(rows["s2"][12], "1")
        self.assertEqual(rows["s4"][1], "'=HYPERLINK(\"x\")")
        status, raw = self.download(f"assignment-status.csv?classId={CLS}&pseudonymize=1")
        table = rows_of(raw)
        self.assertTrue(all(r[0].startswith("P") and r[1] == r[0] and r[2] == "" for r in table[1:]))
        self.assertNotIn(b"Ada", raw)

    def test_exports_require_export_grades(self):
        viewer = self.staff_key("viewer", "Shen (viewer)")
        status, _ = self.download(f"grades.csv?classId={CLS}", key=viewer)
        self.assertEqual(status, 403)
        ta = self.staff_key("ta", "Wang (TA)")
        status, _ = self.download(f"assignment-status.csv?classId={CLS}", key=ta)
        self.assertEqual(status, 200)
        with self.db() as db:
            logged = db.execute("SELECT category, row_count FROM data_access_log WHERE category='export'").fetchall()
        self.assertTrue(logged)


class ExerciseResultsTests(GradingApiCase):
    def test_grade09_first_try_eventually_stuck_and_group_filter(self):
        practice = self.hw(kind="practice", title="Warm-up", due_at=None,
                           questions=[TWO_QUESTIONS[0], dict(TWO_QUESTIONS[0], id="q9", prompt="Second")])
        with self.db() as db:
            group = testsupport.make_group(db, CLS, "section", "Section A", ["s1", "s2"])
            now = dbmod.utcnow()
            old = (now - timedelta(minutes=30)).isoformat()
            testsupport.make_server_check(db, CLS, "s1", practice.id, "q1", "4", True)
            for n, answer in enumerate(("5", "6", "5")):
                testsupport.make_server_check(db, CLS, "s2", practice.id, "q1", answer, False, attempt_index=n + 1)
            testsupport.make_server_check(db, CLS, "s3", practice.id, "q1", "5", False, at=old)
            testsupport.make_server_check(db, CLS, "s3", practice.id, "q1", "4", True, at=old, attempt_index=2)
            testsupport.make_server_check(db, CLS, "preview-instructor", practice.id, "q1", "9", False, preview=True)
        status, results = self.request(f"/api/teacher/assignments/{practice.id}/results?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, results)
        self.assertEqual(results["enrolled"], 3)
        q1 = results["questions"][0]
        self.assertEqual((q1["attempted"], q1["correctFirstTryPct"], q1["correctEventuallyPct"]), (3, 33, 67))
        self.assertEqual(q1["topWrongAnswers"][0], {"answer": "5", "students": 2})
        self.assertEqual([(s["studentName"], s["wrongAttempts"]) for s in q1["stuck"]], [("Bo Lin", 3)])
        self.assertEqual(results["questions"][1]["attempted"], 0)
        self.assertIsNone(results["questions"][1]["correctFirstTryPct"])
        self.assertTrue(q1["label"].startswith("Q1 · "))
        students = {s["studentId"]: s for s in results["students"]}
        self.assertEqual((students["s3"]["correct"], students["s3"]["attempted"]), (1, 1))
        status, grouped = self.request(f"/api/teacher/assignments/{practice.id}/results?classId={CLS}&groupId={group}",
                                       key=TEACHER_KEY)
        self.assertEqual((grouped["enrolled"], grouped["questions"][0]["attempted"]), (2, 2))
        recent = dbmod.iso_seconds(dbmod.utcnow() - timedelta(minutes=10))
        status, ranged = self.request(f"/api/teacher/assignments/{practice.id}/results?classId={CLS}&from={quote(recent)}",
                                      key=TEACHER_KEY)
        self.assertEqual(ranged["questions"][0]["attempted"], 2)
        status, missing = self.request(f"/api/teacher/assignments/work-missing/results?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 404)
        viewer = self.staff_key("viewer", "Shen (viewer)")
        status, _ = self.request(f"/api/teacher/assignments/{practice.id}/results?classId={CLS}", key=viewer)
        self.assertEqual(status, 200)

    def test_rt02_first_try_agrees_across_assignments_row_results_and_gradebook(self):
        """RT-02: a check on a question no longer in the exercise and a client-reported check change none of the three."""
        practice = self.hw(kind="practice", title="Legacy practice", due_at=None,
                           questions=[TWO_QUESTIONS[0], dict(TWO_QUESTIONS[0], id="q-old", prompt="Removed later")])
        with self.db() as db:
            testsupport.make_server_check(db, CLS, "s1", practice.id, "q-old", "4", True, at="2026-10-01T01:00:00+00:00")
            testsupport.make_server_check(db, CLS, "s1", practice.id, "q1", "5", False, at="2026-10-01T01:01:00+00:00")
            testsupport.make_server_check(db, CLS, "s1", practice.id, "q1", "4", True, at="2026-10-01T01:02:00+00:00",
                                          attempt_index=2)
            client = testsupport.make_server_check(db, CLS, "s2", practice.id, "q1", "4", True, at="2026-10-01T01:03:00+00:00")
            with dbmod.write_tx(db):
                db.execute("UPDATE events SET checked_by = 'client' WHERE id = ?", (client,))
                # the question was removed from the exercise afterwards (its old answers keep their attribution)
                db.execute("UPDATE assignments SET questions_json = ? WHERE id = ?", (json.dumps([TWO_QUESTIONS[0]]), practice.id))
        status, listing = self.request(f"/api/teacher/assignments?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, listing)
        stats = {a["id"]: a for a in listing["assignments"]}[practice.id]["stats"]
        self.assertEqual((stats["attempted"], stats["firstTryCorrectPct"]), (1, 0))  # was 2 students and 50 %
        status, results = self.request(f"/api/teacher/assignments/{practice.id}/results?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, results)
        self.assertEqual([(q["questionId"], q["correctFirstTryPct"], q["correctEventuallyPct"]) for q in results["questions"]],
                         [("q1", 0, 100)])
        status, book = self.request(f"/api/teacher/gradebook?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, book)
        cell = {r["studentId"]: r for r in book["rows"]}["s1"]["inClass"][0]
        self.assertEqual((cell["accuracyPct"], cell["correctFirstTryPct"]), (100, 0))
        with self.db() as db:  # Home's assignment line uses the same definition
            rec = readers.load_assignment(db, CLS, practice.id)
            home = analytics.assignment_list_item(db, analytics.make_scope(db, CLS), rec, dbmod.utcnow())["stats"]
        self.assertEqual((home["attempted"], home["firstTryCorrectPct"]), (1, 0.0))


if __name__ == "__main__":
    unittest.main()
