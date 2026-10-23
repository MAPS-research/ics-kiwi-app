"""Coverage for ``server/analytics.py`` (INSIGHTS, spec §13.4, §6.7): explorer groups the acceptance tests do not reach
(reading, question activities, study sessions) and every explorer filter, answers by question for each target kind,
question activity cursors and aliases, policy labels, timeline filters, trends/curves/time-on-task edge cases and the
v0.5.1 legacy table and session queries. Queries run directly against a temporary database built with the
``testsupport`` writers (no HTTP server)."""

from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from server import testsupport  # noqa: F401  (empties the AI keys before anything reads them)
from server import ai_policy, analytics, app, course_config, readers, telemetry
from server import db as dbmod
from server.analytics import ExplorerQuery

C = "cov-analytics"
T0 = "2026-10-20T02:00:00+00:00"
QUESTIONS = [
    {"id": "q1", "type": "fill", "prompt": "What does mean(c(2, 4, 6)) return?", "points": 10, "choices": [],
     "starterCode": "", "answer": "4", "explanation": "", "tags": ["means"]},
    {"id": "q2", "type": "choice", "prompt": "Which function counts rows?", "points": 10, "choices": ["nrow", "ncol", "length"],
     "starterCode": "", "answer": "nrow", "explanation": ""},
]


def at(minutes: int) -> str:
    base = dbmod.parse_iso(T0)
    if base is None:
        raise ValueError(f"bad base time {T0!r}")
    return (base + timedelta(minutes=minutes)).isoformat()


def client_event(db: Any, sid: str, kind: str, payload: dict, *, minutes: int, question_id: str | None = None,
                 surface: str = "workspace") -> int:
    ident = testsupport.student_identity(db, C, sid)
    with testsupport._clock_at(at(minutes)):
        result = telemetry.add_event(db, ident, {"classId": C, "studentId": sid, "studentName": sid, "sessionId": "b1",
                                                 "type": kind, "questionId": question_id, "payload": payload,
                                                 "surface": surface, "schemaVersion": 2})
    return int(result.id or 0)


class AnalyticsCoverageTests(unittest.TestCase):
    temp: tempfile.TemporaryDirectory
    previous: Path

    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        cls.previous = app.DB_PATH
        app.DB_PATH = Path(cls.temp.name) / "coverage.sqlite3"
        dbmod.set_clock(None)
        app.init_db()
        db = app.connection()
        cls.db = db
        testsupport.create_course(db, C)
        cls.course = course_config.course_for(C, db)
        cls.u1, cls.u2 = cls.course["units"][0]["id"], cls.course["units"][1]["id"]
        for sid, name in (("s1", "Ada Chen"), ("s2", "Bo Li"), ("s3", "Cy Wu")):
            testsupport.add_roster(db, C, sid, display_name=name)
        cls.section = testsupport.make_group(db, C, "section", "Section A", ["s1", "s2"])
        cls.practice = testsupport.publish_work(db, C, kind="practice", title="Week 3 practice", questions=QUESTIONS, unit_id=cls.u1)
        cls.homework = testsupport.publish_work(db, C, kind="homework", title="Week 4 Homework", questions=QUESTIONS, unit_id=cls.u2,
                                                due_at="2026-10-01T00:00:00+00:00")
        pid = cls.practice.id
        cls.checks = [
            testsupport.make_server_check(db, C, "s1", pid, "q1", "4", True, at=at(0)),
            testsupport.make_server_check(db, C, "s1", pid, "q2", "nrow", True, at=at(2)),
            testsupport.make_server_check(db, C, "s2", pid, "q1", "3", False, at=at(3)),
            testsupport.make_server_check(db, C, "s2", pid, "q2", "ncol", False, at=at(4)),
        ]
        cls.free_item = testsupport.make_free_item_attempt(db, C, "s1", cls.u1, question_type="choice", difficulty=3,
                                                           at=at(5))
        cls.similar_item = testsupport.make_similar_attempt(db, C, "s2", pid, "q1", at=at(6))
        client_event(db, "s1", "code_run", {"code": "mean(x)", "ok": False, "error": "object 'x' not found"}, minutes=45)
        client_event(db, "s1", "code_run", {"code": "x <- 1; mean(x)", "ok": True, "output": "[1] 1"}, minutes=46)
        with dbmod.write_tx(db):
            cls.unit_policy = ai_policy.save_version(db, C, "unit", cls.u1, "", ai_policy.platform_default(), created_by="t",
                                                     created_by_role="instructor")["id"]
            cls.course_policy = ai_policy.save_version(db, C, "course", "", cls.section, ai_policy.platform_default(),
                                                       created_by="t", created_by_role="instructor")["id"]
            cls.orphan_policy = ai_policy.save_version(db, C, "course", "", "grp-gone", ai_policy.platform_default(),
                                                       created_by="t", created_by_role="instructor")["id"]
        testsupport.make_chat_turn(db, C, "s3", "Why is the mean NA?", "Check is.na().", unit_id=cls.u1, at=at(10),
                                   policy_version_id=cls.unit_policy)
        with dbmod.write_tx(db):
            db.execute("INSERT INTO kiwi_materials (class_id, id, title, document_ids, unit_id) VALUES (?, 'mat-1', 'Lecture 1', "
                       "'[\"doc-1\"]', '')", (C,))
            db.execute("INSERT INTO material_unit_map (class_id, material_id, unit_id, valid_from, changed_by) VALUES "
                       "(?, 'mat-1', ?, '2026-01-01T00:00:00Z', 't')", (C, cls.u2))
        testsupport.make_native_event(db, C, "s3", kind="frontend-interaction-pdf-change", at="2026-10-20T03:00:00.000Z",
                                      material={"documentId": "doc-1", "id": "mat-1", "title": "Lecture 1", "unitId": cls.u1})
        testsupport.make_native_event(db, C, "s3", kind="frontend-interaction-pdf-change", at="2026-10-20T03:01:00.000Z",
                                      material={"documentId": "doc-2", "id": "mat-2", "title": "Lecture 2", "unitId": cls.u1})
        testsupport.make_native_event(db, C, "s3", prompt="What is a join?", response="It combines tables.",
                                      at="2026-10-20T03:05:00.000Z")
        cls.submission = testsupport.make_autochecked_submission(db, C, "s1", cls.homework.id, {"q1": "4", "q2": "nrow"},
                                                                 grade_status="draft", grade=20, at=at(60))
        cls.session_id = db.execute("SELECT learning_session_id FROM events WHERE id = ?", (cls.checks[0],)).fetchone()[0]
        with dbmod.write_tx(db):
            db.execute("INSERT INTO learning_session_aliases (old_id, new_id, class_id, created_at) VALUES ('ls-old', ?, ?, ?)",
                       (cls.session_id, C, dbmod.now()))
            db.execute("INSERT INTO learning_session_aliases (old_id, new_id, class_id, created_at) VALUES ('ls-dangling', "
                       "'ls-missing', ?, ?)", (C, dbmod.now()))
        cls.scope = analytics.make_scope(db, C)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.db.close()
        app.DB_PATH = cls.previous
        cls.temp.cleanup()

    # helpers ----------------------------------------------------------------------------------------------------
    def explore(self, **kwargs: Any) -> dict:
        scope = kwargs.pop("scope", self.scope)
        return analytics.explore(self.db, scope, ExplorerQuery(**kwargs))

    # explorer groups ----------------------------------------------------------------------------------------------
    def test_reading_rows_use_material_titles_and_current_chapter_map(self) -> None:
        rows = {r["materialId"]: r for r in self.explore(group="reading")["rows"]}
        self.assertEqual(set(rows), {"mat-1", "mat-2"})
        self.assertEqual((rows["mat-1"]["label"], rows["mat-1"]["unitId"]), ("Lecture 1", self.u2))  # material_unit_map wins
        self.assertEqual(rows["mat-2"]["label"], "mat-2")  # no kiwi_materials row: the id is the label
        self.assertEqual(rows["mat-1"]["views"], 1)
        self.assertEqual(self.explore(group="reading", activity="ai")["rows"], [])
        self.assertEqual(len(self.explore(group="reading", activity="reading")["rows"]), 2)

    def test_question_activity_rows_and_filters(self) -> None:
        everything = self.explore(group="question-activities", page_size=100)
        self.assertGreater(everything["total"], 0)
        self.assertEqual(everything["total"], len(everything["rows"]))
        self.assertEqual(everything["population"], {"enrolled": 3, "active": 3})
        for row in everything["rows"]:
            self.assertIn(row["result"], analytics.SESSION_RESULT_ORDER)
            self.assertNotIn("contextKey", row)
            self.assertNotIn("browserSession", row)
        by_student = self.explore(group="question-activities", student_id="s1", page_size=100)["rows"]
        self.assertTrue(by_student and all(r["studentId"] == "s1" for r in by_student))
        kiwi = self.explore(group="question-activities", where="kiwi", page_size=100)["rows"]
        self.assertTrue(kiwi and all(r["source"] == "kiwi" for r in kiwi))
        material = self.explore(group="question-activities", material_id="mat-1")["rows"]
        self.assertEqual([r["materialId"] for r in material], ["mat-1"])
        practice = self.explore(group="question-activities", assignment_id=self.practice.id, page_size=100)["rows"]
        self.assertTrue(practice and all(self.practice.id in (r["assignmentId"], r.get("relatedAssignmentId")) for r in practice))
        work = self.explore(group="question-activities", work=self.practice.id, page_size=100)["rows"]
        self.assertEqual({r["id"] for r in work}, {r["id"] for r in practice})
        q1 = self.explore(group="question-activities", question_id="q1", page_size=100)["rows"]
        self.assertTrue(q1 and all("q1" in (r["questionId"], r.get("itemId")) for r in q1))
        free = self.explore(group="question-activities", work="free")["rows"]
        self.assertTrue(free and all(r["practiceMode"] == "free" for r in free))
        assigned = self.explore(group="question-activities", work="assigned", page_size=100)["rows"]
        self.assertTrue(all(r["practiceMode"] in ("homework", "in-class") for r in assigned))
        similar = self.explore(group="question-activities", origin="ai-similar")["rows"]
        self.assertTrue(similar and all(r["practiceMode"] == "similar" for r in similar))
        self.assertTrue(all(r["practiceMode"] == "free" for r in self.explore(group="question-activities", origin="ai-free")["rows"]))
        teacher = self.explore(group="question-activities", origin="teacher", page_size=100)["rows"]
        self.assertTrue(all(r["practiceMode"] in ("homework", "in-class") for r in teacher))
        unit = self.explore(group="question-activities", unit_id=self.u1, page_size=100)["rows"]
        self.assertTrue(unit and all(r["unitId"] == self.u1 for r in unit))
        unattributed = self.explore(group="question-activities", unit_id="unattributed", page_size=100)["rows"]
        self.assertTrue(all(r["unitId"] == "" for r in unattributed))
        for activity in analytics.ACTIVITY_FILTERS:
            with self.subTest(activity=activity):
                self.assertLessEqual(self.explore(group="question-activities", activity=activity, page_size=100)["total"],
                                     everything["total"])
        self.assertTrue(all(r["codeErrors"] > 0 for r in self.explore(group="question-activities", activity="errors")["rows"]))

    def test_question_activity_search_types_paging_and_sorting(self) -> None:
        ada = self.explore(group="question-activities", search="ada", page_size=100)["rows"]
        self.assertTrue(ada and all(r["studentId"] == "s1" for r in ada))
        self.assertEqual(self.explore(group="question-activities", search="Ada", name_mode="pseudonyms")["rows"], [])
        self.assertTrue(self.explore(group="question-activities", search="s-00", name_mode="pseudonyms")["rows"])
        typed = self.explore(group="question-activities", question_type="choice", page_size=100)["rows"]
        self.assertTrue(all(r["questionType"] == "choice" for r in typed))
        self.assertTrue(all(r["difficulty"] == 3 for r in self.explore(group="question-activities", difficulty=3)["rows"]))
        self.explore(group="question-activities", policy_version_id=self.unit_policy)
        first = self.explore(group="question-activities", page=1, page_size=1)
        second = self.explore(group="question-activities", page=2, page_size=1)
        self.assertEqual(first["total"], second["total"])
        self.assertNotEqual(first["rows"][0]["id"], second["rows"][0]["id"])
        oldest = self.explore(group="question-activities", sort="startedAt", direction="asc", page_size=1)["rows"][0]
        newest = self.explore(group="question-activities", sort="startedAt", direction="desc", page_size=1)["rows"][0]
        self.assertLessEqual(oldest["startedAt"], newest["startedAt"])
        with self.assertRaises(ValueError):
            self.explore(group="question-activities", sort="payload_json")
        window = analytics.make_scope(self.db, C, from_=at(40), to=at(50))
        recent = self.explore(group="question-activities", scope=window, page_size=100)["rows"]
        self.assertTrue(recent and all(r["lastActive"] >= at(40)[:10] for r in recent))

    def test_study_sessions_split_after_thirty_minutes(self) -> None:
        rows = self.explore(group="study-sessions", student_id="s1", page_size=100)["rows"]
        labels = sorted(r["label"] for r in rows)
        self.assertGreaterEqual(len(labels), 2)  # checks at 02:00, code runs at 02:45, submission at 03:00
        self.assertEqual(labels[0], "Study session 1")
        self.assertTrue(all(r["id"].startswith("s1:") and r["students"] == 1 for r in rows))
        runs = self.explore(group="study-sessions", student_id="s1", activity="runs", page_size=100)["rows"]
        self.assertTrue(runs and all(r["codeRuns"] > 0 for r in runs))
        self.assertTrue(all(r["studentId"] == "s2" for r in self.explore(group="study-sessions", search="bo li")["rows"]))

    def test_students_chapters_assignments_and_questions_under_every_filter(self) -> None:
        variants: list[dict[str, Any]] = [
            {}, {"where": "lab"}, {"where": "kiwi"}, {"work": "free"}, {"work": "assigned"}, {"work": "all"},
            {"work": self.practice.id}, {"origin": "teacher"}, {"origin": "ai-free"}, {"origin": "ai-similar"},
            {"unit_id": self.u1}, {"unit_id": "unattributed"}, {"assignment_id": self.practice.id}, {"question_id": "q1"},
            {"student_id": "s1"}, {"material_id": "mat-1"}, {"question_type": "choice"}, {"difficulty": 3},
            {"policy_version_id": self.unit_policy}, {"tag": "means"}, {"search": "ada"}, {"search": "S-001", "name_mode": "pseudonyms"},
            {"activity": "attempts"}, {"activity": "unknown"}, {"fold": False},
        ]
        for group in ("students", "chapters", "assignments", "questions"):
            for variant in variants:
                with self.subTest(group=group, variant=variant):
                    table = self.explore(group=group, **variant)
                    self.assertEqual(set(table), {"rows", "total", "page", "pageSize", "population"})
                    self.assertLessEqual(len(table["rows"]), table["total"])
        students = {r["studentId"]: r for r in self.explore(group="students")["rows"]}
        self.assertEqual(set(students), {"s1", "s2", "s3"})
        self.assertEqual(students["s1"]["groupNames"], ["Section A"])
        self.assertEqual(students["s2"]["missingWork"], 1)  # past-due homework without a submission
        self.assertEqual(students["s1"]["missingWork"], 0)
        self.assertEqual([r["studentId"] for r in self.explore(group="students", student_id="s2")["rows"]], ["s2"])
        self.assertEqual([r["studentId"] for r in self.explore(group="students", search="cy")["rows"]], ["s3"])
        chapters = self.explore(group="chapters", unit_id="unattributed")["rows"]
        self.assertEqual([r["id"] for r in chapters], ["unattributed"])
        free = self.explore(group="assignments", work="free")["rows"]
        self.assertEqual(free, [])
        listed = {r["assignmentId"] for r in self.explore(group="assignments", unit_id=self.u2)["rows"]}
        self.assertEqual(listed, {self.homework.id})

    def test_explorer_rejects_unknown_views(self) -> None:
        with self.assertRaises(ValueError):
            self.explore(group="sessions-v9")
        with self.assertRaises(ValueError):
            self.explore(group="students", activity="sleeping")
        with self.assertRaises(ValueError):
            self.explore(group="students", sort="payload_json")

    def test_staff_scope_and_group_scope(self) -> None:
        staff = analytics.make_scope(self.db, C, include_staff=True)
        self.assertIn("s1", {r["studentId"] for r in self.explore(group="students", scope=staff)["rows"]})
        grouped = analytics.make_scope(self.db, C, group_id=self.section)
        self.assertEqual({r["studentId"] for r in self.explore(group="students", scope=grouped)["rows"]}, {"s1", "s2"})
        self.assertEqual(analytics.enrolled_ids(self.db, grouped), ["s1", "s2"])

    def test_linked_classes_count_only_kiwi_students(self) -> None:
        linked = "cov-linked"
        testsupport.create_course(self.db, linked)
        with dbmod.write_tx(self.db):
            self.db.execute("INSERT INTO kiwi_links (class_id, name) VALUES (?, 'Linked course')", (linked,))
        testsupport.add_roster(self.db, linked, "k1", source="kiwi", kiwi_email="k1@example.edu")
        testsupport.add_roster(self.db, linked, "local1")
        scope = analytics.make_scope(self.db, linked)
        self.assertTrue(scope.linked)
        self.assertEqual(analytics.enrolled_ids(self.db, scope), ["k1"])

    def test_wants_v2_and_session_results(self) -> None:
        self.assertTrue(analytics.wants_v2({"group": "reading"}))
        self.assertTrue(analytics.wants_v2({"group": "students", "where": "lab"}))
        self.assertFalse(analytics.wants_v2({"group": "students", "where": ""}))
        cases = [({"checked": 1, "correct": 1}, "Correct"), ({"checked": 2, "correct": 0}, "Not yet correct"),
                 ({"attempts": 1}, "Answered"), ({"codeRuns": 3}, "Ran code"), ({"aiQuestions": 1}, "Asked AI"), ({}, "Viewed")]
        for row, expected in cases:
            self.assertEqual(analytics.session_result(row), expected)

    # answers by question -------------------------------------------------------------------------------------------
    def test_answers_for_an_assignment_pad_unchosen_options(self) -> None:
        data = analytics.answers_by_question(self.db, self.scope, assignment_id=self.practice.id)["questions"]
        self.assertEqual([q["questionId"] for q in data], ["q1", "q2"])
        q2 = data[1]
        self.assertEqual(q2["label"], "IC3 Q2")
        answers = {a["answer"]: a for a in q2["answers"]}
        self.assertEqual(set(answers), {"nrow", "ncol", "length"})
        self.assertEqual((answers["nrow"]["correct"], answers["ncol"]["incorrect"], answers["length"]["attempts"]), (1, 1, 0))
        one = analytics.answers_by_question(self.db, self.scope, assignment_id=self.practice.id, question_id="q1", limit=1)
        self.assertEqual(len(one["questions"]), 1)
        self.assertTrue(one["questions"][0]["hasMore"])
        with self.assertRaises(ValueError):
            analytics.answers_by_question(self.db, self.scope, assignment_id="nope")

    def test_answers_for_items_units_and_questions(self) -> None:
        free = analytics.answers_by_question(self.db, self.scope, item_group=f"f:{self.u1}:choice")["questions"]
        self.assertEqual([q["questionId"] for q in free], [self.free_item])
        self.assertEqual(free[0]["origin"], "ai-free")
        self.assertTrue(free[0]["label"].startswith("Free practice (AI) · "))
        similar = analytics.answers_by_question(self.db, self.scope, item_group=f"s:{self.practice.id}:q1:")["questions"]
        self.assertEqual([(q["questionId"], q["origin"]) for q in similar], [(self.similar_item, "ai-similar")])
        direct = analytics.answers_by_question(self.db, self.scope, question_id=self.free_item)["questions"]
        self.assertEqual(direct[0]["totalAttempts"], 1)
        missing = analytics.answers_by_question(self.db, self.scope, question_id="gi-missing")["questions"]
        self.assertEqual((missing[0]["origin"], missing[0]["prompt"], missing[0]["totalAttempts"]), ("ai-free", "", 0))
        unit = analytics.answers_by_question(self.db, self.scope, unit_id=self.u2)["questions"]
        self.assertEqual({q["assignmentId"] for q in unit}, {self.homework.id})
        by_question = analytics.answers_by_question(self.db, self.scope, question_id="q2")["questions"]
        self.assertEqual({q["assignmentId"] for q in by_question}, {self.practice.id, self.homework.id})
        with self.assertRaises(ValueError):
            analytics.answers_by_question(self.db, self.scope, item_group="x:what")
        with self.assertRaises(ValueError):
            analytics.answers_by_question(self.db, self.scope)

    # question activity -----------------------------------------------------------------------------------------------
    def test_question_activity_cursor_alias_and_errors(self) -> None:
        data = analytics.question_activity(self.db, C, self.session_id)
        self.assertNotIn("aliasOf", data)
        self.assertGreaterEqual(len(data["events"]), 1)
        first = data["events"][0]["id"]
        page = analytics.question_activity(self.db, C, self.session_id, limit=0)
        self.assertEqual((page["events"], page["hasMore"]), ([], True))
        rest = analytics.question_activity(self.db, C, self.session_id, after=first)
        self.assertTrue(all(e["id"] != first for e in rest["events"]))
        moved = analytics.question_activity(self.db, C, "ls-old")
        self.assertEqual((moved["aliasOf"], moved["activity"]["id"]), ("ls-old", self.session_id))
        with self.assertRaises(LookupError):
            analytics.question_activity(self.db, C, "ls-dangling")
        with self.assertRaises(LookupError):
            analytics.question_activity(self.db, C, "ls-unknown")
        with self.assertRaises(ValueError):
            analytics.question_activity(self.db, C, self.session_id, after=10 ** 9)

    # labels ------------------------------------------------------------------------------------------------------------
    def test_policy_labels(self) -> None:
        self.assertEqual(analytics.policy_label(self.db, C, None, self.course), "Default rules")
        self.assertEqual(analytics.policy_label(self.db, C, "3", self.course), "Default rules")
        self.assertEqual(analytics.policy_label(self.db, C, 10 ** 9, self.course), "Default rules")
        self.assertEqual(analytics.policy_label(self.db, C, self.unit_policy, self.course), "Ch 01 rules v1")
        self.assertEqual(analytics.policy_label(self.db, C, self.course_policy, self.course), "Course rules v1 · Section A")
        self.assertEqual(analytics.policy_label(self.db, C, self.orphan_policy, self.course), "Course rules v1 · grp-gone")

    def test_small_label_helpers(self) -> None:
        self.assertEqual(analytics.short_assignment_label("Midterm review", "practice"), "Midterm review")
        self.assertEqual(analytics.short_assignment_label("A very long assignment title", "homework"), "A very long assignment…")
        self.assertEqual(analytics.short_assignment_label("", "homework"), "Assignment")
        index = analytics.assignment_index(self.db, C)
        self.assertEqual(analytics.question_ref(index, "missing", "q1"), "q1")
        self.assertEqual(analytics.question_ref(index, self.practice.id, "q9"), "IC3")
        self.assertEqual(analytics.chapter_short(self.course, ""), "Not linked to a chapter")
        self.assertEqual(analytics.chapter_short(self.course, "custom-unit"), "custom-unit")
        self.assertEqual(analytics.unit_title(self.course, ""), "Not linked to a chapter")
        self.assertEqual(analytics._loads("{broken", {"d": 1}), {"d": 1})
        self.assertEqual(analytics.free_practice_label({"units": [{"access": "open"}]}), "Ch 01")
        self.assertEqual(analytics.free_practice_label({"units": [{"access": "hidden"}]}), "Off")
        self.assertEqual(analytics.free_practice_label({"units": [{"access": "open"}, {"effectiveAccess": "review"}]}), "Ch 01–02")

    # timeline -------------------------------------------------------------------------------------------------------------
    def test_timeline_filters_and_cursor_errors(self) -> None:
        full = analytics.timeline(self.db, C, "s1")
        self.assertTrue(full["events"])
        windowed = analytics.timeline(self.db, C, "s1", from_=at(40), to=at(50))
        self.assertTrue(windowed["events"])
        self.assertTrue(all(at(40)[:16] <= e["at"][:16] for e in windowed["events"]))
        lab = analytics.timeline(self.db, C, "s3", where="lab")
        kiwi = analytics.timeline(self.db, C, "s3", where="kiwi")
        self.assertTrue(kiwi["events"])
        self.assertNotEqual(len(lab["events"]), len(kiwi["events"]))
        unit = analytics.timeline(self.db, C, "s1", unit_id=self.u1)
        self.assertLess(len(unit["events"]), len(full["events"]))  # the U2 homework submission and its grade drop out
        graded = analytics.timeline(self.db, C, "s1", assignment_id=self.homework.id, from_="2026-01-01T00:00:00+00:00",
                                    to="2030-01-01T00:00:00+00:00")
        self.assertEqual(graded["status"]["gradeStatus"], "draft")
        untouched = analytics.timeline(self.db, C, "s3", assignment_id=self.homework.id)
        self.assertIsNone(untouched["status"]["gradeStatus"])
        with self.assertRaises(ValueError):
            analytics.timeline(self.db, C, "s1", after="not-a-cursor")
        with self.assertRaises(LookupError):
            analytics.timeline(self.db, C, "s1", assignment_id="nope")

    # metrics, trends, curves, time on task ------------------------------------------------------------------------------
    def test_trends_curves_and_time_on_task_edges(self) -> None:
        later = analytics.make_scope(self.db, C, from_="2026-10-30T00:00:00+00:00", to="2026-10-01T00:00:00+00:00")
        self.assertEqual(analytics.week_buckets(self.db, later), [])
        # one Monday-aligned week in the course time zone (Asia/Shanghai): Mon 10/19 00:00 – Mon 10/26 00:00 local
        unit = analytics.trends(self.db, analytics.make_scope(self.db, C, from_="2026-10-18T16:00:00+00:00",
                                                              to="2026-10-25T16:00:00+00:00"), unit_id=self.u1)
        self.assertEqual(len(unit["buckets"]), 1)
        self.assertGreater(unit["buckets"][0]["attempts"], 0)
        for origin in ("teacher", "ai-free", "ai-similar", ""):
            with self.subTest(origin=origin):
                points = analytics.learning_curves(self.db, self.scope, unit_id=self.u1, origin=origin)["points"]
                self.assertTrue(all(1 <= p["attemptIndex"] <= 10 for p in points))
        by_unit = analytics.time_on_task(self.db, self.scope, unit_id=self.u2)["questions"]
        self.assertEqual({q["assignmentId"] for q in by_unit}, {self.homework.id})
        with self.assertRaises(ValueError):
            analytics.time_on_task(self.db, self.scope, assignment_id="nope")

    def test_bad_time_zone_falls_back(self) -> None:
        settings = dict(readers.settings(self.db, C))
        broken = {**settings, "schedule": {**settings.get("schedule", {}), "timezone": "Mars/Olympus"}}
        with dbmod.write_tx(self.db):
            self.db.execute("UPDATE course_settings SET settings_json = ? WHERE class_id = ?", (dbmod.json_dumps(broken), C))
        try:
            self.assertEqual(str(analytics._zone(self.db, C)), course_config.DEFAULT_TIMEZONE)
        finally:
            with dbmod.write_tx(self.db):
                self.db.execute("UPDATE course_settings SET settings_json = ? WHERE class_id = ?", (dbmod.json_dumps(settings), C))

    def test_home_lists_and_ai_status(self) -> None:
        now = datetime(2026, 10, 22, 1, 0, tzinfo=timezone.utc)
        item = analytics.assignment_list_item(self.db, self.scope, self.practice, now)
        self.assertEqual(item["stats"]["attempted"], 2)
        self.assertEqual(item["stats"]["firstTryCorrectPct"], 50.0)
        status = analytics.ai_status(self.db, C)
        self.assertFalse(status["configured"])
        self.assertIsNone(status["model"])
        with patch.dict(os.environ, {"KIWI_AI_CONCURRENCY": "many", "KIWI_MODEL_ALLOWLIST": "a, b,,"}):
            status = analytics.ai_status(self.db, C)
        self.assertEqual((status["concurrency"], status["modelAllowlist"]), (4, ["a", "b"]))

    # v0.5.1 legacy queries ----------------------------------------------------------------------------------------------
    def test_legacy_table_filters_and_sorts(self) -> None:
        for group in ("students", "sessions", "questions", "topics", "assignments", "materials"):
            for extra in ({}, {"search": "ada"}, {"active": "7d"}, {"activity": "runs"}, {"published": "homework"},
                          {"unitId": "unattributed"}, {"sort": "label", "direction": "asc"}):
                with self.subTest(group=group, extra=extra):
                    result = analytics.table(self.db, {"classId": C, "group": group, **extra})
                    self.assertLessEqual(len(result["rows"]), result["total"])
        with self.assertRaises(ValueError):
            analytics.table(self.db, {"classId": C, "group": "nope"})
        with self.assertRaises(ValueError):
            analytics.table(self.db, {"classId": C, "group": "students", "sort": "payload_json"})

    def test_legacy_session_events_cursor(self) -> None:
        data = analytics.session_events(self.db, C, self.session_id)
        self.assertTrue(data["events"])
        after = analytics.session_events(self.db, C, self.session_id, before=data["events"][0]["id"])
        self.assertTrue(all(e["id"] != data["events"][0]["id"] for e in after["events"]))
        with self.assertRaises(ValueError):
            analytics.session_events(self.db, C, self.session_id, before=10 ** 9)
        with self.assertRaises(ValueError):
            analytics.session_events(self.db, C, "ls-unknown")


if __name__ == "__main__":
    unittest.main()
