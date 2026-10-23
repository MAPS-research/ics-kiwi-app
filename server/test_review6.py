"""Regression tests for the minor findings of the v0.6.0 blocker retest (B-m01, B-m02 / decision D8).

Each test names the finding it pins. Fixtures use ``server/testsupport.py`` builders, temporary databases and no AI
provider (AI keys stay empty).
"""

from __future__ import annotations

import unittest
from datetime import timedelta

from server import analytics, attention, grading, grading_rules, readers, testsupport
from server import db as dbmod
from server.test_attention import only
from server.test_exports import _dicts
from server.test_grading import CLS, GradingApiCase, TWO_QUESTIONS
from server.test_insights import KEY, NOW, client_event
from server.testsupport import TEACHER_KEY, ApiTestCase

PAST = "2026-01-01T00:00:00+00:00"


def _at(days: float = 0, minutes: float = 0) -> str:
    moment = dbmod.parse_iso(NOW) - timedelta(days=days, minutes=minutes)
    return moment.isoformat(timespec="milliseconds")


class LastSeenAndLearningActionTests(ApiTestCase):
    """B-m01: Needs attention and the roster use two named stamps — last seen (any student event) and last learning
    action (answers, code runs, AI questions, submissions) — so "no activity" never contradicts "last active"."""

    def setUp(self) -> None:
        super().setUp()
        self.clock = testsupport.freeze_time(NOW)
        self.cls = "seen"
        self.create_course(self.cls)
        with self.db() as db:
            for sid in ("s1", "s2", "s3"):
                testsupport.add_roster(db, self.cls, sid, display_name=f"Name {sid}")
            testsupport.update_settings(db, self.cls, only("no_activity", days=7))
            testsupport.publish_work(db, self.cls, title="Week 1 HW")   # the roster grace does not apply
            # s1: a code run 11 days ago, then only passive events (page view, heartbeat) and a lecture view today
            client_event(db, self.cls, "s1", "code_run", {"code": "1", "ok": True}, at=_at(days=11), surface="workspace")
            client_event(db, self.cls, "s1", "material_viewed", {"materialId": "m1", "page": 1}, at=_at(minutes=30))
            client_event(db, self.cls, "s1", "page_view", {"route": "/student/assignments"}, at=_at(minutes=2))
            # s2: page views only (Bo in the review); s3: nothing at all
            client_event(db, self.cls, "s2", "page_view", {"route": "/student"}, at=_at(days=1))

    def tearDown(self) -> None:
        self.clock.__exit__(None, None, None)
        super().tearDown()

    def test_learning_action_types_are_explicit(self):
        self.assertEqual(set(analytics.LEARNING_ACTION_TYPES), {
            "answer_submitted", "answer_draft", "work_answer_saved", "kiwi_check_answer", "code_run", "code_shared",
            "ai_question", "hint_requested", "work_submitted"})
        for passive in ("page_view", "study_heartbeat", "visibility", "idle", "material_viewed", "question_viewed"):
            self.assertNotIn(passive, analytics.LEARNING_ACTION_TYPES)

    def test_attention_names_the_rule_and_the_last_seen_time(self):
        status, data = self.request(f"/api/teacher/attention?classId={self.cls}", key=KEY)
        self.assertEqual(status, 200, data)
        found = {s["studentId"]: s["reasons"] for s in data["students"]}
        s1 = found["s1"][0]
        self.assertEqual((s1["rule"], s1["text"]), ("no_activity", "No learning actions for 11 days"))
        self.assertEqual(s1["lastSeenAt"][:16], _at(minutes=2)[:16])
        self.assertEqual(s1["at"][:16], _at(days=11)[:16])
        s2 = found["s2"][0]
        self.assertEqual(s2["text"], "No learning actions recorded yet")
        self.assertEqual(s2["lastSeenAt"][:16], _at(days=1)[:16])
        s3 = found["s3"][0]
        self.assertEqual((s3["text"], s3["lastSeenAt"]), ("No learning actions recorded yet", None))
        self.assertEqual(data["descriptions"]["no_activity"],
                         "No learning actions (answers, code runs, AI questions, submissions) for 7+ days")

    def test_roster_and_profile_carry_both_stamps_from_the_same_rule(self):
        status, roster = self.request(f"/api/teacher/roster?classId={self.cls}", key=KEY)
        self.assertEqual(status, 200, roster)
        rows = {r["studentId"]: r for r in roster["students"]}
        self.assertEqual(rows["s1"]["lastActive"][:16], _at(minutes=2)[:16])          # last seen
        self.assertEqual(rows["s1"]["lastLearningAction"][:16], _at(days=11)[:16])
        self.assertEqual((rows["s2"]["lastLearningAction"], rows["s3"]["lastActive"]), (None, None))
        status, profile = self.request(f"/api/teacher/students/s1/profile?classId={self.cls}", key=KEY)
        self.assertEqual(status, 200, profile)
        self.assertEqual(profile["header"]["lastActive"], rows["s1"]["lastActive"])
        self.assertEqual(profile["header"]["lastLearningAction"], rows["s1"]["lastLearningAction"])
        with self.db() as db:
            stamps = analytics.activity_stamps(db, self.cls, ["s1", "s2", "s3"])
            status, data = self.request(f"/api/teacher/attention?classId={self.cls}", key=KEY)
        reason = next(s for s in data["students"] if s["studentId"] == "s1")["reasons"][0]
        self.assertEqual((reason["lastSeenAt"], reason["at"]), (stamps["s1"].last_seen, stamps["s1"].last_learning_action))
        self.assertEqual(stamps["s3"], analytics.ActivityStamps(None, None, None))

    def test_a_recent_learning_action_clears_the_rule(self):
        with self.db() as db:
            client_event(db, self.cls, "s1", "code_run", {"code": "2", "ok": False}, at=_at(days=6, minutes=1380),
                         surface="workspace")   # 6 days 23 h: just below the threshold
        status, data = self.request(f"/api/teacher/attention?classId={self.cls}", key=KEY)
        self.assertNotIn("s1", {s["studentId"] for s in data["students"]})


class _RevisionCase(GradingApiCase):
    """A homework (due in the past) revised once; s1 submitted the original, s2 only the revision, s3 neither."""

    def revise(self, rec, **body) -> dict:
        status, copy = self.request(f"/api/teacher/assignments/{rec.id}/duplicate?classId={CLS}", "POST",
                                    {"asRevision": True, "retireOriginalOnPublish": True, **body}, TEACHER_KEY)
        self.assertEqual(status, 201, copy)
        status, published = self.request(f"/api/teacher/assignments/{copy['id']}/publish?classId={CLS}", "POST", {}, TEACHER_KEY)
        self.assertEqual(status, 200, published)
        return published

    def lineage(self):
        rec = self.hw(title="Files HW", due_at=PAST, questions=TWO_QUESTIONS)
        self.submit("s1", rec, {"q1": "4", "q2": "words"})
        revision = self.revise(rec)
        with self.db() as db:
            revised = readers.load_assignment(db, CLS, revision["id"])
        self.submit("s2", revised, {"q1": "4", "q2": "words"})
        older = self.hw(title="Older homework", due_at="2026-01-02T00:00:00+00:00")   # nobody submitted it
        return rec, revised, older


class MissingWorkLineageTests(_RevisionCase):
    """B-m02 / D8: a homework and its published revisions count once in Missing work, everywhere."""

    def test_one_rule_counts_a_lineage_once(self):
        rec, revised, older = self.lineage()
        with self.db() as db:
            missing = analytics.missing_work(db, CLS, ["s1", "s2", "s3"], dbmod.utcnow())
        self.assertEqual({sid: [m.id for m in items] for sid, items in missing.items()},
                         {"s1": [older.id], "s2": [older.id], "s3": [revised.id, older.id]})
        head = missing["s3"][0]
        self.assertEqual((head.title, head.original_title), (revised.title, "Files HW"))
        self.assertIsNone(missing["s3"][1].original_title)

    def test_roster_profile_home_attention_and_explorer_agree(self):
        rec, revised, older = self.lineage()
        status, roster = self.request(f"/api/teacher/roster?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, roster)
        rows = {r["studentId"]: r for r in roster["students"]}
        self.assertEqual({sid: r["missingWork"] for sid, r in rows.items()}, {"s1": 1, "s2": 1, "s3": 2})
        self.assertEqual(rows["s3"]["missingWorkItems"], [
            {"assignmentId": revised.id, "title": revised.title, "originalTitle": "Files HW"},
            {"assignmentId": older.id, "title": "Older homework", "originalTitle": None}])
        for sid, expected in (("s1", 1), ("s2", 1), ("s3", 2)):
            status, profile = self.request(f"/api/teacher/students/{sid}/profile?classId={CLS}", key=TEACHER_KEY)
            self.assertEqual((status, profile["header"]["missing"]), (200, expected), profile)
            states = [a["cell"]["state"] for a in profile["assignments"]]
            self.assertEqual(states.count("missing"), expected, profile["assignments"])
        status, home = self.request(f"/api/teacher/home?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, home)
        listed = {m["assignmentId"]: m for m in home["needsAction"]["missingPastDue"]}
        self.assertNotIn(rec.id, listed)                                   # the closed original is not counted again
        self.assertEqual((listed[revised.id]["count"], listed[revised.id]["originalTitle"]), (1, "Files HW"))
        self.assertEqual((listed[older.id]["count"], listed[older.id]["originalTitle"]), (3, None))
        with self.db() as db:
            testsupport.update_settings(db, CLS, only("missing_work", count=1))
        status, data = self.request(f"/api/teacher/attention?classId={CLS}", key=TEACHER_KEY)
        reasons = {s["studentId"]: s["reasons"][0] for s in data["students"]}
        self.assertEqual((reasons["s1"]["text"], reasons["s3"]["text"]), ("Missing Older homework", "Missing 2 assignments"))
        self.assertIn("new version of Files HW", reasons["s3"]["title"])
        status, table = self.request(f"/api/teacher/analytics/table?classId={CLS}&v=2&group=students", key=TEACHER_KEY)
        self.assertEqual(status, 200, table)
        self.assertEqual({r["studentId"]: r["missingWork"] for r in table["rows"]}, {"s1": 1, "s2": 1, "s3": 2})

    def test_cells_status_csv_and_assignment_lists_follow_the_rule(self):
        rec, revised, older = self.lineage()
        status, book = self.request(f"/api/teacher/gradebook?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, book)
        cells = {(r["studentId"], c["assignmentId"]): c for r in book["rows"] for c in r["cells"]}
        self.assertEqual((cells[("s1", revised.id)]["label"], cells[("s1", revised.id)]["onOriginal"]), ("Submitted the original", True))
        self.assertEqual((cells[("s2", rec.id)]["state"], cells[("s2", rec.id)]["label"]), ("not_submitted", "Submitted the new version"))
        self.assertEqual(cells[("s2", rec.id)]["revisionTitle"], revised.title)
        replaced = cells[("s3", rec.id)]
        self.assertEqual((replaced["state"], replaced["label"], replaced["countedOnId"]),
                         ("not_submitted", "Replaced by the new version", revised.id))
        head = cells[("s3", revised.id)]
        self.assertEqual((head["state"], head["revisionOfTitle"]), ("missing", "Files HW"))
        status, raw = self.request(f"/api/teacher/exports/assignment-status.csv?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200)
        states = {(r["student_id"], r["assignment_id"]): r["state"] for r in _dicts(raw)}
        self.assertEqual(states[("s3", rec.id)], "Replaced by the new version")
        self.assertEqual(states[("s3", revised.id)], "Missing")
        self.assertEqual(states[("s2", rec.id)], "Submitted the new version")
        self.assertEqual(states[("s1", revised.id)], "Submitted the original")
        self.assertEqual(sum(1 for (sid, _aid), state in states.items() if sid == "s3" and state.startswith("Missing")), 2)
        status, listed = self.request(f"/api/teacher/assignments?classId={CLS}", key=TEACHER_KEY)
        stats = {a["id"]: a["stats"] for a in listed["assignments"]}
        self.assertEqual((stats[rec.id]["missing"], stats[revised.id]["missing"], stats[older.id]["missing"]), (0, 1, 3))
        for work, expected in ((rec, []), (revised, ["s3"]), (older, ["s1", "s2", "s3"])):
            status, popover = self.request(f"/api/teacher/assignments/{work.id}/students?classId={CLS}&state=missing",
                                           key=TEACHER_KEY)
            self.assertEqual((status, sorted(s["studentId"] for s in popover["students"])), (200, expected), popover)

    def test_every_missing_cell_is_an_item_of_the_rule(self):
        rec, revised, older = self.lineage()
        with self.db() as db:
            now = dbmod.utcnow()
            rule = analytics.missing_work(db, CLS, ["s1", "s2", "s3"], now)
            for sid in ("s1", "s2", "s3"):
                cells = {w.id for w in analytics.published_homework(db, CLS)
                         if grading_rules.gradebook_cell(db, w, sid, "latest", now)["state"] == "missing"}
                self.assertEqual(cells, {m.id for m in rule[sid]}, sid)

    def test_an_open_revision_is_not_missing_yet(self):
        rec = self.hw(title="Files HW", due_at=PAST)
        self.revise(rec, shiftDays=365)   # due 2027-01-01
        with self.db() as db:
            missing = analytics.missing_work(db, CLS, ["s3"], dbmod.utcnow())
            cell = grading_rules.gradebook_cell(db, rec, "s3", "latest", dbmod.utcnow())
        self.assertEqual(missing["s3"], [])
        self.assertEqual(cell["label"], "Replaced by the new version")

    def test_a_revision_for_another_group_leaves_the_original_as_the_students_version(self):
        rec = self.hw(title="Files HW", due_at=PAST)
        with self.db() as db:
            group = testsupport.make_group(db, CLS, "cohort", "Retake", ["s1"])
        revision = self.revise(rec)
        with self.db() as db, dbmod.write_tx(db):
            db.execute("UPDATE assignments SET audience_json=? WHERE id=?",
                       (dbmod.json_dumps({"type": "groups", "groupIds": [group]}), revision["id"]))
        with self.db() as db:
            missing = analytics.missing_work(db, CLS, ["s1", "s3"], dbmod.utcnow())
        self.assertEqual([m.id for m in missing["s1"]], [revision["id"]])
        self.assertEqual([(m.id, m.original_title) for m in missing["s3"]], [(rec.id, None)])

    def test_status_label_names_lineage_states(self):
        base = {"draftAnswered": 0, "state": "not_submitted"}
        self.assertEqual(grading.status_label({**base, "onOriginal": True}), "Submitted the original")
        self.assertEqual(grading.status_label({**base, "onRevision": True}), "Submitted the new version")
        self.assertEqual(grading.status_label({**base, "countedOnId": "w2"}), "Replaced by the new version")
        self.assertEqual(grading.status_label(base), "Not started")

    def test_attention_text_without_a_revision_is_unchanged(self):
        self.hw(title="Week 2 HW", due_at=PAST)
        with self.db() as db:
            testsupport.update_settings(db, CLS, only("missing_work", count=1))
            scope = analytics.make_scope(db, CLS)
            found = attention.evaluate(db, scope)
        reason = next(s for s in found["students"] if s["studentId"] == "s1")["reasons"][0]
        self.assertEqual((reason["text"], reason["title"]), ("Missing Week 2 HW", "Week 2 HW"))


if __name__ == "__main__":
    unittest.main()
