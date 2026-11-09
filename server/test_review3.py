"""Regression tests for the v0.6.0 browser review (docs/reviews/2026-10-22-v0.6.0.md, findings RV6-Mnn / RV6-mnn).

Each test names the finding it pins. Fixtures use ``server/testsupport.py`` builders, temporary databases and no AI
provider (AI keys stay empty).
"""

from __future__ import annotations

import unittest

from server import analytics, identity, testsupport
from server import db as dbmod
from server.test_exports import _dicts
from server.test_grading import CLS, GradingApiCase, TWO_QUESTIONS
from server.testsupport import TEACHER_KEY, ApiTestCase, fake_kiwi_identity

LIVE = "live-review3"


class ReleasedLatePenaltyTests(GradingApiCase):
    def test_student_sees_the_automatic_late_penalty_of_a_released_grade(self):  # RV6-M01
        rec = self.hw(due_at="2026-10-20T00:00:00+00:00", grades_visibility="on_release",
                      late_policy={"mode": "accept_until", "untilAt": "2026-10-27T00:00:00+00:00", "penaltyPctPerDay": 10},
                      questions=[dict(TWO_QUESTIONS[0], type="text")] + TWO_QUESTIONS[1:])
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"}, at="2026-10-22T20:00:00+00:00")   # 68 h late
        items = {"q1": {"score": 9, "comment": ""}, "q2": {"score": 10, "comment": ""}}
        status, saved = self.put_grade(sub, {"items": items, "action": "save"})
        self.assertEqual((status, saved["total"], saved["adjustment"]["points"]), (200, 13, -6), saved)
        status, own = self.request(f"/api/submissions?classId={CLS}&studentId=s1", student="s1")
        self.assertEqual(status, 200, own)
        self.assertEqual((own[0]["status"], own[0]["grade"], own[0]["adjustment"]), ("waiting_for_teacher", None, None))
        status, released = self.put_grade(sub, {"items": items, "action": "release"})
        self.assertEqual((status, released["submission"]["gradeStatus"]), (200, "released"), released)
        status, own = self.request(f"/api/submissions?classId={CLS}&studentId=s1", student="s1")
        mine = own[0]
        self.assertEqual((mine["grade"], mine["maxPoints"]), (13, 20))
        self.assertEqual(mine["adjustment"], {"points": -6, "reason": "Late penalty (auto)"})
        self.assertEqual((mine["isLate"], mine["lateSeconds"]), (True, 68 * 3600))
        self.assertEqual(sum(i["score"] for i in mine["items"].values()) + mine["adjustment"]["points"], mine["grade"])

    def test_released_grade_without_adjustment_has_none(self):  # RV6-M01
        rec = self.hw(grades_visibility="on_release")
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"})
        self.put_grade(sub, {"items": {"q1": {"score": 10, "comment": ""}, "q2": {"score": 8, "comment": ""}}, "action": "release"})
        status, own = self.request(f"/api/submissions?classId={CLS}&studentId=s1", student="s1")
        self.assertEqual((status, own[0]["grade"], own[0]["adjustment"]), (200, 18, None))


class ShortLabelTests(unittest.TestCase):
    def test_short_labels_ignore_version_numbers_and_dates(self):  # RV6-M04
        cases = {
            ("Review-v0.6.0-Homework", "homework"): "Review-v0.6.0-Homework",
            ("Review v0.4 Homework", "homework"): "Review v0.4 Homework",
            ("Review-v0.6.0-Exercise", "practice"): "Review-v0.6.0-Exercise",
            ("Review-TeacherEval-20261021", "homework"): "Review-TeacherEval-2026…",
            ("Week 3 HW", "homework"): "HW3",
            ("HW3", "homework"): "HW3",
            ("Homework #2", "homework"): "HW2",
            ("In-class 1", "practice"): "IC1",
            ("Lab 04: joins", "homework"): "HW4",
            ("W3 HW", "homework"): "HW3",
            ("Chapter 3.2 review", "homework"): "Chapter 3.2 review",
        }
        for (title, kind), label in cases.items():
            with self.subTest(title=title):
                self.assertEqual(analytics.short_assignment_label(title, kind), label)

    def test_labels_are_unique_within_a_course(self):  # RV6-M04
        labels = analytics.unique_short_labels([("a", "Week 3 HW", "homework"), ("b", "Week 3 HW (redo)", "homework"),
                                                ("c", "Quiz", "homework"), ("d", "Quiz", "homework"),
                                                ("e", "Week 4 HW", "homework")])
        self.assertEqual(labels, {"a": "Week 3 HW", "b": "Week 3 HW (redo)", "c": "Quiz", "d": "Quiz (2)", "e": "HW4"})
        self.assertEqual(len(set(labels.values())), len(labels))


class AssignmentIndexLabelTests(ApiTestCase):
    def test_question_refs_name_the_assignment(self):  # RV6-M04
        self.create_course("c1")
        with self.db() as db:
            one = testsupport.publish_work(db, "c1", title="Review-v0.6.0-Homework", questions=TWO_QUESTIONS)
            two = testsupport.publish_work(db, "c1", title="Review v0.4 Homework", questions=TWO_QUESTIONS)
            index = analytics.assignment_index(db, "c1")
        self.assertEqual(analytics.question_ref(index, one.id, "q1"), "Review-v0.6.0-Homework Q1")
        self.assertEqual(analytics.question_ref(index, two.id, "q2"), "Review v0.4 Homework Q2")


class VerifiedOnlyRoleExportTests(ApiTestCase):
    """RV6-M07 / decision D3: every viewer and researcher export is forced to allowUnverified=0."""

    def setUp(self) -> None:
        super().setUp()
        with self.db() as db:
            db.execute("INSERT INTO kiwi_links (class_id, name) VALUES (?, ?)", (LIVE, LIVE))
            for sid in ("k1", "k2"):
                testsupport.add_roster(db, LIVE, sid, source="kiwi", kiwi_email=f"{sid}@example.edu")
                db.execute("UPDATE roster SET consent_override='yes' WHERE class_id=? AND student_id=?", (LIVE, sid))
            testsupport.make_chat_turn(db, LIVE, "k1", "VERIFIEDTURN", "r", at="2026-10-03T00:00:00+00:00")
            testsupport.make_chat_turn(db, LIVE, "k2", "DEMOTURN", "r", thread_id="t2", at="2026-10-03T00:00:00+00:00")
            with dbmod.write_tx(db):
                # a demo/unverified identity in a linked course (e.g. a row written before the course was linked)
                for table in ("chat_turns", "ai_calls", "events"):
                    db.execute(f"UPDATE {table} SET identity_verified=0 WHERE class_id=? AND student_id='k2'", (LIVE,))
                db.execute("""INSERT INTO staff (id, class_id, display_name, role, kiwi_user_id, created_by, created_at)
                           VALUES ('staff-r3', ?, 'Shen', 'researcher', 'r1', 'test', ?)""", (LIVE, dbmod.now()))
            self.rid = identity.research_id(db, LIVE, "k1")

    def test_researcher_per_type_exports_leave_out_unverified_identities(self):
        with fake_kiwi_identity("staff", False, True, "professor", class_id=LIVE, user_id="r1") as token:
            for path in ("ai-conversations.csv", "activity.csv"):
                with self.subTest(path=path):
                    status, raw = self.request(f"/api/teacher/exports/{path}?classId={LIVE}&pseudonymize=0&consent=all",
                                               token=token)
                    self.assertEqual(status, 200, raw)
                    self.assertEqual(self.last_headers.get("X-Export-Verified-Only"), "1")
                    self.assertNotIn(b"DEMOTURN", raw)
                    self.assertNotIn(b"k1@example.edu", raw)
                    self.assertEqual({r["research_id"] for r in _dicts(raw)}, {self.rid})
            status, raw = self.request(f"/api/teacher/exports/ai-conversations.csv?classId={LIVE}", token=token)
            self.assertIn(b"VERIFIEDTURN", raw)
        with fake_kiwi_identity("staff", True, True, class_id=LIVE, user_id="t1") as token:
            status, raw = self.request(f"/api/teacher/exports/ai-conversations.csv?classId={LIVE}", token=token)
            self.assertEqual(status, 200, raw)
            self.assertIn(b"DEMOTURN", raw)   # the instructor's teaching export still has every row
            self.assertIsNone(self.last_headers.get("X-Export-Verified-Only"))
        with self.db() as db:
            rows = {tuple(r) for r in db.execute("SELECT actor_role, category FROM data_access_log WHERE class_id=?", (LIVE,))}
        self.assertIn(("researcher", "export"), rows)


class TimelineAndCsvTests(GradingApiCase):
    def test_timeline_marks_late_submissions_and_titles_the_adjustment(self):  # RV6-m07
        rec = self.hw(due_at="2026-10-20T00:00:00+00:00", grades_visibility="on_release",
                      late_policy={"mode": "accept_marked", "penaltyPctPerDay": 10},
                      questions=[dict(TWO_QUESTIONS[0], type="text")] + TWO_QUESTIONS[1:])
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"}, at="2026-10-22T20:00:00+00:00")
        items = {"q1": {"score": 9, "comment": ""}, "q2": {"score": 10, "comment": ""}}
        status, _ = self.put_grade(sub, {"items": items, "action": "save"})
        self.assertEqual(status, 200)
        status, timeline = self.request(f"/api/teacher/timeline?classId={CLS}&studentId=s1&assignmentId={rec.id}", key=TEACHER_KEY)
        self.assertEqual(status, 200, timeline)
        titles = [e["title"] for e in timeline["events"]]
        self.assertIn("Homework submission · Attempt 1 · Late", titles)
        self.assertEqual(titles.count("Draft 13/20"), 1, titles)          # one Save draft → one draft entry
        self.assertIn("Late penalty −6 (auto)", titles)
        self.assertEqual(analytics.adjustment_title({"points": 0, "reason": "Late penalty removed"}), "Late penalty removed")
        self.assertEqual(analytics.adjustment_title({"points": 1.5, "reason": "Bonus"}), "Bonus +1.5")

    def test_status_csv_uses_one_timestamp_format(self):  # RV6-m08
        self.hw(title="Week 3 HW", due_at="2026-10-20T15:59:00.000Z")
        self.hw(title="Week 4 HW", due_at="2026-10-27T15:59:00+00:00")
        status, raw = self.request(f"/api/teacher/exports/assignment-status.csv?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, raw)
        rows = _dicts(raw)
        self.assertEqual({r["due_at"] for r in rows}, {"2026-10-20T15:59:00+00:00", "2026-10-27T15:59:00+00:00"})
        from server import grading

        self.assertEqual(grading.csv_time("2026-10-22T06:01:21.123+00:00"), "2026-10-22T06:01:21+00:00")
        self.assertEqual(grading.csv_time("2026-10-22T14:01:21+08:00"), "2026-10-22T06:01:21+00:00")
        self.assertEqual((grading.csv_time(None), grading.csv_time("")), ("", ""))


class EditorCheckTests(ApiTestCase):
    def test_try_the_auto_check_judges_complete_code_on_the_typed_output(self):  # RV6-m03
        self.create_course("c1")
        question = {"id": "q1", "type": "complete", "prompt": "Print 80", "points": 10, "choices": [], "starterCode": "x <- ",
                    "referenceCode": "x <- 80\nprint(x)", "expectedOutput": "[1] 80", "grading": {"autoCheck": True}}
        status, result = self.request("/api/teacher/assignments/new/preview-check?classId=c1", "POST",
                                      {"question": question, "answer": question["referenceCode"], "runOutput": "80"}, key=TEACHER_KEY)
        self.assertEqual((status, result["correct"], result["basis"]), (200, True, "client_run_output"), result)
        status, result = self.request("/api/teacher/assignments/new/preview-check?classId=c1", "POST",
                                      {"question": question, "answer": "", "runOutput": "[1] 81"}, key=TEACHER_KEY)
        self.assertEqual((status, result["correct"]), (200, False), result)


class DataHealthTests(ApiTestCase):
    def test_teacher_rule_tests_are_not_student_ai_requests(self):  # RV6-m06
        from server import telemetry

        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Ada Chen")
            testsupport.make_chat_turn(db, "c1", "s1", "Why NA?", "Use na.rm.")
            with dbmod.write_tx(db):
                db.execute("""INSERT INTO ai_calls (request_id, class_id, student_id, actor_role, is_preview, action, surface,
                           platform_rules_version, status, requested_at) VALUES ('test-1', 'c1', 'preview-instructor',
                           'instructor', 1, 'test_chat', 'teacher_test', 'platform-rules-v2', 'ok', ?)""", (dbmod.now(),))
            health = telemetry.data_health(db, "c1", None, None)
        self.assertEqual((health["aiCalls"]["total"], health["aiCalls"]["ok"]), (1, 1))
        self.assertEqual(health["aiCalls"]["teacherTests"], 1)


class TopicRuleTests(unittest.TestCase):
    def test_default_topics_need_text_analysis_words(self):  # RV6-m09
        from server import conversations, course_config

        rules = course_config.TOPIC_RULE_DEFAULTS
        self.assertNotIn("Text preprocessing", conversations.topic_of("Do not start with any token", rules))
        self.assertNotIn("Joins and keys", conversations.topic_of("What key do I press to run code?", rules))
        self.assertIn("Text preprocessing", conversations.topic_of("Why does unnest_tokens drop my stop words?", rules))
        self.assertIn("Text preprocessing", conversations.topic_of("How do I tokenize the lyrics?", rules))
        self.assertIn("Joins and keys", conversations.topic_of("Which join key matches tailnum?", rules))
        self.assertIsNone(analytics.question_theme("Do not start with any token"))
        # a course created with the first v0.6.0 defaults follows the corrected keywords; edited rules stay as they are
        old = [{"label": "Text preprocessing", "keywords": ["token", "stop word", "stopword", "lowercase", "corpus", "lyrics"]},
               {"label": "Joins and keys", "keywords": ["join", "merge", "tailnum", "key", "by ="]}]
        merged = course_config.merge_settings({"topicRules": old})["topicRules"]
        self.assertIn("unnest_tokens", merged[0]["keywords"])
        self.assertEqual(merged[1], old[1])
        self.assertEqual(analytics.question_theme("count tokens per song"), "Text preprocessing")


class TemplateApplyTests(ApiTestCase):
    def test_template_chapters_come_first_without_number_prefixes(self):  # RV6-m10
        self.create_course("dst")
        body = {"templateKey": "socs-sh-190-spring-2026", "mode": "preview"}
        status, preview = self.request("/api/teacher/course-package/import?classId=dst", "POST", body, key=TEACHER_KEY)
        self.assertEqual(status, 200, preview)
        added = [c for c in preview["chapters"] if c["action"] == "add"]
        self.assertEqual(added[0]["title"], "Introduction to CSS")
        self.assertFalse(any(c["title"][:2].isdigit() for c in added))
        self.assertTrue(any("become Chapters 01–12" in w for w in preview["warnings"]), preview["warnings"])
        status, applied = self.request("/api/teacher/course-package/import?classId=dst", "POST", {**body, "mode": "apply"},
                                       key=TEACHER_KEY)
        self.assertEqual(status, 200, applied)
        with self.db() as db:
            from server import course_config

            course = course_config.course_for("dst", db)
        ids = [u["id"] for u in course["units"]]
        self.assertEqual(ids[:12], [c["id"] for c in added])
        self.assertEqual(analytics.chapter_number(course, added[0]["id"]), 1)
        weeks = {u["title"]: u["week"] for u in course["units"][:12]}
        # D4 correction: week labels follow the slides' schedule tables, which skip the break weeks (Apr 13 = Week 11).
        self.assertEqual((weeks["LLMs for text analysis"], weeks["Social network analysis I"], weeks["Social network analysis II"]),
                         (11, 12, 13))


if __name__ == "__main__":
    unittest.main()
