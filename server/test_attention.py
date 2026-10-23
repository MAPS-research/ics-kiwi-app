"""Students needing attention and What to re-teach (INSIGHTS-03, INSIGHTS-21 server side, §13.2–13.3).

Fixtures are written the way the owning writers store them (``testsupport`` builders for server checks, chat turns and
submissions; ``telemetry.add_event`` for client code runs). Each rule has a case just below its threshold.
"""

import unittest

from server import db as dbmod
from server import testsupport
from server.test_insights import KEY, NOW, TWO_QUESTIONS, client_event, q
from server.testsupport import ApiTestCase

DAY = "2026-10-21T01:00:00+00:00"


def only(rule_id: str, **params: int) -> dict:
    """Course settings patch that enables exactly one attention rule."""
    from server import course_config

    rules = []
    for default in course_config.ATTENTION_RULE_DEFAULTS:
        rule = {"id": default["id"], "enabled": default["id"] == rule_id, "params": dict(default["params"])}
        if default["id"] == rule_id:
            rule["params"].update(params)
        rules.append(rule)
    return {"attentionRules": {"rules": rules}}


class AttentionTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.clock = testsupport.freeze_time(NOW)
        self.cls = "attn"
        self.create_course(self.cls)

    def tearDown(self) -> None:
        self.clock.__exit__(None, None, None)
        super().tearDown()

    def roster(self, *ids: str) -> None:
        with self.db() as db:
            for sid in ids:
                testsupport.add_roster(db, self.cls, sid, display_name=f"Name {sid}")

    def enable(self, rule_id: str, **params: int) -> None:
        with self.db() as db:
            testsupport.update_settings(db, self.cls, only(rule_id, **params))

    def reasons(self, **params) -> dict[str, list[dict]]:
        status, data = self.request(f"/api/teacher/attention?classId={self.cls}&{q(**params)}", key=KEY)
        self.assertEqual(status, 200, data)
        return {s["studentId"]: s["reasons"] for s in data["students"]}

    def test_no_activity_after_days_and_new_roster_grace(self):
        self.roster("s1", "s2", "s3")
        self.enable("no_activity", days=7)
        with self.db() as db:
            client_event(db, self.cls, "s1", "code_run", {"code": "1", "ok": True}, at="2026-10-14T00:30:00+00:00", surface="workspace")
            client_event(db, self.cls, "s2", "code_run", {"code": "1", "ok": True}, at="2026-10-15T02:00:00+00:00", surface="workspace")
        found = self.reasons()
        self.assertEqual([r["text"] for r in found["s1"]], ["No activity 8 days"])
        self.assertNotIn("s2", found)  # 6 days 23 h: just below the threshold
        self.assertNotIn("s3", found)  # joined today and nothing published yet
        with self.db() as db:
            testsupport.publish_work(db, self.cls, title="Week 1 HW")
        self.assertEqual([r["text"] for r in self.reasons()["s3"]], ["No activity recorded yet"])

    def test_missing_work_counts_past_due_homework_in_audience(self):
        self.roster("s1", "s2")
        self.enable("missing_work", count=1)
        with self.db() as db:
            hw = testsupport.publish_work(db, self.cls, title="Week 2 HW", due_at="2026-10-21T00:00:00+00:00")
            testsupport.publish_work(db, self.cls, title="Week 5 HW", due_at="2026-11-21T00:00:00+00:00")
            testsupport.make_autochecked_submission(db, self.cls, "s2", hw.id, {"q1": "4", "q2": "x"})
        found = self.reasons()
        self.assertEqual([r["text"] for r in found["s1"]], ["Missing Week 2 HW"])
        self.assertIn("/assignments/", found["s1"][0]["href"])
        self.assertNotIn("s2", found)
        self.enable("missing_work", count=2)
        self.assertEqual(self.reasons(), {})  # one missing assignment is below count=2
        with self.db() as db:
            testsupport.publish_work(db, self.cls, title="Week 3 HW", due_at="2026-10-21T12:00:00+00:00")
        self.assertEqual([r["text"] for r in self.reasons()["s1"]], ["Missing 2 assignments"])

    def test_stuck_question_errors_without_success(self):
        self.roster("s1", "s2", "s3", "s4")
        self.enable("stuck_question", errors=5)
        with self.db() as db:
            hw = testsupport.publish_work(db, self.cls, kind="practice", title="Week 3 Homework", questions=TWO_QUESTIONS)
            for sid, errors in (("s1", 6), ("s2", 4), ("s3", 6), ("s4", 6)):
                for i in range(errors):
                    client_event(db, self.cls, sid, "code_run", {"assignmentId": hw.id, "code": "mean(", "ok": False, "error": "e"},
                                 question_id="q1", at=f"2026-10-21T01:0{i}:00+00:00", surface="assignment")
            client_event(db, self.cls, "s3", "code_run", {"assignmentId": hw.id, "code": "mean(x)", "ok": True},
                         question_id="q1", at="2026-10-21T01:09:00+00:00", surface="assignment")
            testsupport.make_server_check(db, self.cls, "s4", hw.id, "q1", "mean(x)", True, at="2026-10-21T01:09:00+00:00")
        found = self.reasons()
        self.assertEqual(found["s1"][0]["text"], "6 errors on IC3 Q1, no success")
        self.assertEqual(set(found), {"s1"})  # 4 errors (below), a success, or a correct check do not trigger

    def test_repeated_ai_help_on_one_question(self):
        self.roster("s1", "s2")
        self.enable("repeated_ai_help", questions=6)
        with self.db() as db:
            hw = testsupport.publish_work(db, self.cls, title="Week 3 Homework", questions=TWO_QUESTIONS)
            for sid, n in (("s1", 7), ("s2", 5)):
                for i in range(n):
                    testsupport.make_chat_turn(db, self.cls, sid, f"Hint {i}?", "Try again.", assignment_id=hw.id, question_id="q2",
                                               surface="assignment", at=f"2026-10-21T02:0{i}:00+00:00")
        found = self.reasons()
        self.assertEqual(found["s1"][0]["text"], "Asked AI 7× on HW3 Q2")
        self.assertNotIn("s2", found)

    def test_low_accuracy_server_checks_in_current_chapter_only(self):
        self.roster("s1", "s2", "s3", "s4", "s5")
        self.enable("low_accuracy", pct=50, minChecked=6)
        with self.db() as db:
            hw = testsupport.publish_work(db, self.cls, kind="practice", title="Week 3 practice", unit_id="data-wrangling",
                                          questions=TWO_QUESTIONS)
            old = testsupport.publish_work(db, self.cls, kind="practice", title="Week 1 practice", unit_id="r-basics",
                                           questions=TWO_QUESTIONS)
            plan = {"s1": (8, 3), "s2": (5, 0), "s3": (6, 3)}
            for sid, (n, right) in plan.items():
                for i in range(n):
                    testsupport.make_server_check(db, self.cls, sid, hw.id, "q1", "a", i < right, at=f"2026-10-21T01:{i:02d}:00+00:00")
            legacy_ids = [testsupport.make_server_check(db, self.cls, "s4", hw.id, "q1", "a", False, at=f"2026-10-21T02:{i:02d}:00+00:00")
                          for i in range(8)]
            with dbmod.write_tx(db):
                db.executemany("UPDATE events SET checked_by = 'legacy_server', schema_version = 1, rejudged_correct = NULL WHERE id = ?",
                               [(i,) for i in legacy_ids])
            for i in range(8):  # another chapter does not count
                testsupport.make_server_check(db, self.cls, "s5", old.id, "q1", "a", False, at=f"2026-10-21T03:{i:02d}:00+00:00")
        found = self.reasons()
        self.assertEqual(found["s1"][0]["text"], "38% correct on Ch 03 practice (8 checks)")
        self.assertEqual(set(found), {"s1"})  # 5 checks (< minChecked), exactly 50 %, not re-judged legacy, other chapter

    def test_late_pattern_only_when_enabled(self):
        self.roster("s1", "s2")
        with self.db() as db:
            works = [testsupport.publish_work(db, self.cls, title=f"Week {i} HW", due_at="2026-10-10T00:00:00+00:00") for i in (1, 2)]
            for work in works:
                testsupport.make_autochecked_submission(db, self.cls, "s1", work.id, {"q1": "4", "q2": "x"}, at="2026-10-12T00:00:00+00:00")
            testsupport.make_autochecked_submission(db, self.cls, "s2", works[0].id, {"q1": "4", "q2": "x"}, at="2026-10-12T00:00:00+00:00")
            testsupport.make_autochecked_submission(db, self.cls, "s2", works[1].id, {"q1": "4", "q2": "x"}, at="2026-10-09T00:00:00+00:00")
            testsupport.update_settings(db, self.cls, only("no_activity", days=60))
        self.assertEqual(self.reasons(), {})  # late_pattern is off by default
        self.enable("late_pattern", count=2, days=21)
        found = self.reasons()
        self.assertEqual(found["s1"][0]["text"], "2 late submissions in 3 weeks")
        self.assertNotIn("s2", found)

    def test_ordering_disabled_rules_and_rule_editing(self):
        self.roster("s1", "s2")
        with self.db() as db:
            hw = testsupport.publish_work(db, self.cls, title="Week 2 HW", due_at="2026-10-01T00:00:00+00:00")
            client_event(db, self.cls, "s2", "code_run", {"code": "1", "ok": True}, at="2026-10-21T00:30:00+00:00", surface="workspace")
            testsupport.update_settings(db, self.cls, {"attentionRules": {"rules": [
                {"id": "no_activity", "enabled": True, "params": {"days": 7}},
                {"id": "missing_work", "enabled": True, "params": {"count": 1}}]}})
        status, data = self.request(f"/api/teacher/attention?classId={self.cls}", key=KEY)
        self.assertEqual([s["studentId"] for s in data["students"]], ["s1", "s2"])  # two reasons before one
        self.assertEqual(len(data["students"][0]["reasons"]), 2)
        self.assertEqual(data["students"][0]["studentName"], "Name s1")
        self.assertIn("missing_work", data["descriptions"])
        rules = self.request(f"/api/teacher/attention/rules?classId={self.cls}", key=KEY)[1]
        for rule in rules["rules"]:
            rule["enabled"] = False
        status, saved = self.request(f"/api/teacher/attention/rules?classId={self.cls}", "PUT", rules, key=KEY)
        self.assertEqual(status, 200, saved)
        self.assertEqual(self.request(f"/api/teacher/attention?classId={self.cls}", key=KEY)[1]["students"], [])
        bad = {"rules": [{"id": "no_activity", "enabled": True, "params": {"days": 0}}]}
        status, error = self.request(f"/api/teacher/attention/rules?classId={self.cls}", "PUT", bad, key=KEY)
        self.assertEqual((status, error["code"]), (400, "invalid_request"))
        self.assertIn("days", error["error"])
        with self.db() as db:
            action = db.execute("SELECT action FROM teacher_actions WHERE class_id = ? ORDER BY id DESC", (self.cls,)).fetchone()
            self.assertEqual(action[0], "attention_rules_update")
        self.assertEqual(hw.title, "Week 2 HW")


class ReteachTests(ApiTestCase):
    def test_candidates_rank_weakest_first_and_marks_round_trip(self):
        cls = "reteach"
        self.create_course(cls)
        with self.db() as db:
            for sid in ("s1", "s2", "s3", "s4"):
                testsupport.add_roster(db, cls, sid)
            hw = testsupport.publish_work(db, cls, kind="practice", title="Week 3 Homework", questions=TWO_QUESTIONS)
            other = testsupport.publish_work(db, cls, kind="practice", title="Week 4 Homework",
                                             questions=[{"id": "q1", "type": "fill", "prompt": "1+1?", "answer": "2", "points": 10}])
            for sid, first in (("s1", False), ("s2", False), ("s3", True)):
                testsupport.make_server_check(db, cls, sid, hw.id, "q1", "x", first, at="2026-10-21T01:00:00+00:00")
                if not first:
                    testsupport.make_server_check(db, cls, sid, hw.id, "q1", "mean(x)", True, at="2026-10-21T01:05:00+00:00",
                                                  attempt_index=2)
            for sid in ("s1", "s2", "s3", "s4"):
                testsupport.make_server_check(db, cls, sid, other.id, "q1", "2", True)
            for sid in ("s1", "s2"):  # only two students: not a candidate
                testsupport.make_server_check(db, cls, sid, hw.id, "q2", "?", False)
        status, data = self.request(f"/api/teacher/reteach?classId={cls}", key=KEY)
        self.assertEqual(status, 200, data)
        top = data["candidates"][0]
        self.assertEqual((top["assignmentId"], top["questionId"], top["label"], top["students"]), (hw.id, "q1", "IC3 Q1", 3))
        self.assertEqual((top["firstTryCorrectPct"], top["meanTriesToCorrect"]), (33.3, 1.7))
        self.assertEqual([c["label"] for c in data["candidates"]], ["IC3 Q1", "IC4 Q1"])
        body = {"targetKind": "question", "assignmentId": hw.id, "questionId": "q1", "unitId": hw.unit_id, "label": "IC3 Q1 mean()",
                "note": "Start Tuesday with this"}
        status, mark = self.request(f"/api/teacher/reteach?classId={cls}", "POST", body, key=KEY)
        self.assertEqual(status, 201, mark)
        data = self.request(f"/api/teacher/reteach?classId={cls}", key=KEY)[1]
        self.assertTrue(data["candidates"][0]["marked"])
        self.assertEqual([m["id"] for m in data["marked"]], [mark["id"]])
        status, done = self.request(f"/api/teacher/reteach/{mark['id']}?classId={cls}", "PATCH", {"resolved": True}, key=KEY)
        self.assertEqual(status, 200)
        self.assertIsNotNone(done["resolvedAt"])
        self.assertEqual(self.request(f"/api/teacher/reteach?classId={cls}", key=KEY)[1]["marked"], [])
        self.assertEqual(len(self.request(f"/api/teacher/reteach?classId={cls}&includeResolved=1", key=KEY)[1]["marked"]), 1)
        self.assertEqual(self.request(f"/api/teacher/reteach?classId={cls}", "POST", {"targetKind": "x", "label": "y"}, key=KEY)[0], 400)
        self.assertEqual(self.request(f"/api/teacher/reteach/999?classId={cls}", "PATCH", {"resolved": True}, key=KEY)[0], 404)
        with self.db() as db:
            actions = [r[0] for r in db.execute("SELECT action FROM teacher_actions WHERE class_id = ? ORDER BY id", (cls,))]
        self.assertEqual(actions, ["reteach_mark", "reteach_update"])


if __name__ == "__main__":
    unittest.main()
