"""grading_rules: gradebook cell states/labels, shared counts and integrity flags (GRADE, spec §7.5, §9.2).

Fixtures come from ``server/testsupport.py`` builders only, so these tests pass with FOUNDATION baselines.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from server import app, grading_rules, readers, telemetry, testsupport
from server import db as dbmod

CLS = "c1"
NOW = "2026-10-22T00:00:00+00:00"
PAST_DUE = "2026-10-20T00:00:00+00:00"
FUTURE_DUE = "2026-10-25T00:00:00+00:00"
THREE_QUESTIONS = [
    {"id": "q1", "type": "fill", "prompt": "mean(c(2,4,6))?", "points": 10, "choices": [], "starterCode": "", "answer": "4"},
    {"id": "q2", "type": "fill", "prompt": "sum(1:3)?", "points": 5, "choices": [], "starterCode": "", "answer": "6"},
    {"id": "q3", "type": "text", "prompt": "Explain NA.", "points": 5, "choices": [], "starterCode": "", "answer": ""},
]
LONG_ANSWER = "A vector is an ordered sequence of values that all share one type."


def set_grade(db, submission_id: str, status: str, grade: float | None) -> None:
    """Rows as grading.save_grade writes them (status + total)."""
    with dbmod.write_tx(db):
        db.execute("UPDATE submissions SET grade_status=?, grade=?, graded_by='instructor', released_at=? WHERE id=?",
                   (status, grade, NOW if status == "released" else None, submission_id))


class GradingRulesTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self._previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "rules.sqlite3"
        app.init_db()
        self.db = app.connection()
        testsupport.create_course(self.db, CLS)
        for student in ("s1", "s2", "s3"):
            testsupport.add_roster(self.db, CLS, student, display_name=student.upper())

    def tearDown(self) -> None:
        self.db.close()
        dbmod.set_clock(None)
        app.DB_PATH = self._previous
        self.temp.cleanup()

    def homework(self, **kwargs):
        kwargs.setdefault("questions", THREE_QUESTIONS)
        return testsupport.publish_work(self.db, CLS, **kwargs)


class CellLabelTests(unittest.TestCase):
    def test_every_state_label(self):
        label = grading_rules.cell_label
        self.assertEqual(label("released", 18, 20, 1), "18/20 · 1 submission")
        self.assertEqual(label("released", 18.5, 20, 2), "18.5/20 · 2 submissions")
        self.assertEqual(label("draft", 16, 20, 1), "Draft 16/20")
        self.assertEqual(label("submitted_ungraded", None, 20, 1), "Submitted · ungraded")
        self.assertEqual(label("newer_ungraded", 16, 20, 2), "16/20 · newer attempt ungraded")
        self.assertEqual(label("missing", None, 20, 0), "Missing")
        self.assertEqual(label("missing", None, 20, 0, draft_answered=2, draft_total=3), "Missing · started (2/3 answered)")
        self.assertEqual(label("not_due", None, 20, 0), "Not due yet")
        self.assertEqual(label("not_due", None, 20, 0, draft_answered=1, draft_total=2), "Not due yet · started")
        self.assertEqual(label("not_submitted", None, 20, 0), "Not started")
        self.assertEqual(label("not_submitted", None, 20, 0, draft_answered=2, draft_total=3), "Started · 2/3 answered")

    def test_points_formatting(self):
        self.assertEqual(grading_rules.fmt_points(20.0), "20")
        self.assertEqual(grading_rules.fmt_points(16.25), "16.25")
        self.assertEqual(grading_rules.fmt_points(None), "–")


class GradebookCellTests(GradingRulesTestCase):
    def cell(self, rec, student, policy="latest"):
        return readers.gradebook_cell(self.db, rec, student, policy, NOW)

    def test_no_submission_states_with_and_without_drafts(self):
        later = self.homework(due_at=FUTURE_DUE)
        self.assertEqual((self.cell(later, "s1")["state"], self.cell(later, "s1")["label"]), ("not_due", "Not due yet"))
        two = self.homework(due_at=FUTURE_DUE, questions=THREE_QUESTIONS[:2])
        testsupport.make_draft(self.db, CLS, "s1", two.id, {"q1": "4"})
        cell = self.cell(two, "s1")
        self.assertEqual((cell["state"], cell["label"], cell["draftAnswered"], cell["draftTotal"]),
                         ("not_due", "Not due yet · started", 1, 2))
        past = self.homework(due_at=PAST_DUE)
        self.assertEqual((self.cell(past, "s2")["state"], self.cell(past, "s2")["label"]), ("missing", "Missing"))
        testsupport.make_draft(self.db, CLS, "s2", past.id, {"q1": "4", "q2": "6"})
        self.assertEqual(self.cell(past, "s2")["label"], "Missing · started (2/3 answered)")
        undated = self.homework(due_at=None)
        self.assertEqual(self.cell(undated, "s3")["label"], "Not started")
        testsupport.make_draft(self.db, CLS, "s3", undated.id, {"q1": "4", "q3": "x"})
        self.assertEqual(self.cell(undated, "s3")["label"], "Started · 2/3 answered")

    def test_empty_draft_answers_and_preview_drafts_do_not_count(self):
        rec = self.homework(due_at=PAST_DUE)
        testsupport.make_draft(self.db, CLS, "s1", rec.id, {"q1": ""})
        testsupport.make_draft(self.db, CLS, "preview-instructor", rec.id, {"q1": "4"}, preview=True)
        self.assertEqual(self.cell(rec, "s1")["label"], "Missing")

    def test_submission_states_latest_and_highest(self):
        rec = self.homework(due_at=PAST_DUE)
        first = testsupport.make_autochecked_submission(self.db, CLS, "s1", rec.id, {"q1": "4", "q2": "6", "q3": "t"},
                                                        at="2026-10-19T00:00:00+00:00")
        cell = self.cell(rec, "s1")
        self.assertEqual((cell["state"], cell["label"], cell["latestSubmissionId"]), ("submitted_ungraded", "Submitted · ungraded", first))
        set_grade(self.db, first, "draft", 16)
        self.assertEqual((self.cell(rec, "s1")["state"], self.cell(rec, "s1")["label"]), ("draft", "Draft 16/20"))
        set_grade(self.db, first, "released", 16)
        cell = self.cell(rec, "s1")
        self.assertEqual((cell["state"], cell["label"], cell["scoredSubmissionId"]), ("released", "16/20 · 1 submission", first))
        second = testsupport.make_autochecked_submission(self.db, CLS, "s1", rec.id, {"q1": "5", "q2": "6", "q3": "t"},
                                                         at="2026-10-21T00:00:00+00:00")
        cell = self.cell(rec, "s1")
        self.assertEqual((cell["state"], cell["label"], cell["score"], cell["attempts"]),
                         ("newer_ungraded", "16/20 · newer attempt ungraded", 16, 2))
        self.assertEqual((cell["latestSubmissionId"], cell["scoredSubmissionId"]), (second, first))
        self.assertTrue(cell["late"])
        set_grade(self.db, second, "released", 12)
        self.assertEqual(self.cell(rec, "s1")["label"], "12/20 · 2 submissions")
        highest = self.cell(rec, "s1", "highest")
        self.assertEqual((highest["state"], highest["score"], highest["scoredSubmissionId"], highest["label"]),
                         ("released", 16, first, "16/20 · 2 submissions"))

    def test_preview_submissions_never_count(self):
        rec = self.homework(due_at=PAST_DUE)
        testsupport.make_autochecked_submission(self.db, CLS, "preview-instructor", rec.id, {"q1": "4", "q2": "6", "q3": "t"},
                                                preview=True)
        self.assertEqual(self.cell(rec, "preview-instructor")["state"], "missing")

    def test_student_outside_the_audience_is_not_assigned(self):
        group = testsupport.make_group(self.db, CLS, "section", "Section A", ["s1"])
        rec = self.homework(due_at=PAST_DUE, audience={"type": "groups", "groupIds": [group]})
        self.assertEqual(self.cell(rec, "s1")["label"], "Missing")
        outside = self.cell(rec, "s2")
        self.assertEqual((outside["state"], outside["label"]), ("not_submitted", "Not assigned"))


class GradingCountsTests(GradingRulesTestCase):
    def test_to_release_draft_graded_and_group_filter(self):
        rec = self.homework(due_at=PAST_DUE, grades_visibility="on_release")
        group = testsupport.make_group(self.db, CLS, "section", "Section A", ["s1", "s2"])
        ids = {s: testsupport.make_autochecked_submission(self.db, CLS, s, rec.id, {"q1": "4", "q2": "6", "q3": "t"},
                                                         at="2026-10-19T00:00:00+00:00") for s in ("s1", "s2", "s3")}
        set_grade(self.db, ids["s1"], "draft", 18)
        set_grade(self.db, ids["s2"], "released", 15)
        counts = readers.grading_counts(self.db, CLS)
        self.assertEqual(counts, {"toGrade": 1, "late": 0, "draft": 1, "toRelease": 1, "flagged": 0, "graded": 2, "all": 3})
        grouped = readers.grading_counts(self.db, CLS, rec.id, group)
        self.assertEqual((grouped["toGrade"], grouped["toRelease"], grouped["all"]), (0, 1, 2))

    def test_only_latest_attempt_counts(self):
        rec = self.homework(due_at=FUTURE_DUE)
        old = testsupport.make_autochecked_submission(self.db, CLS, "s1", rec.id, {"q1": "4", "q2": "6", "q3": "t"})
        set_grade(self.db, old, "released", 20)
        testsupport.make_autochecked_submission(self.db, CLS, "s1", rec.id, {"q1": "5", "q2": "6", "q3": "t"})
        counts = readers.grading_counts(self.db, CLS)
        self.assertEqual((counts["toGrade"], counts["graded"], counts["all"]), (1, 0, 1))


class FlagTests(GradingRulesTestCase):
    def test_ai_final_answer_paste_and_identical_flags(self):
        rec = self.homework(due_at=FUTURE_DUE)
        answers = {"q1": "4", "q2": "6", "q3": LONG_ANSWER}
        testsupport.make_chat_turn(self.db, CLS, "s1", "What is q1?", "It is 4.", assignment_id=rec.id, flagged=True,
                                   guard_status="redacted", at="2026-10-21T00:00:00+00:00")
        s1 = testsupport.make_autochecked_submission(self.db, CLS, "s1", rec.id, {**answers, "q3": "short"},
                                                     at="2026-10-21T01:00:00+00:00")
        s2 = testsupport.make_autochecked_submission(self.db, CLS, "s2", rec.id, answers, at="2026-10-21T01:00:00+00:00")
        s3 = testsupport.make_autochecked_submission(self.db, CLS, "s3", rec.id, {**answers, "q3": "  " + LONG_ANSWER.upper()},
                                                     at="2026-10-21T01:00:00+00:00")
        flags = grading_rules.flags_for(self.db, CLS, [s1, s2, s3])
        self.assertEqual([f["kind"] for f in flags[s1]], ["ai_final_answer"])
        self.assertEqual([f["kind"] for f in flags[s2]], ["identical_answer"])
        self.assertEqual(flags[s2][0]["text"], "Same answer as 1 other student on Q3")   # S-m06: names the question
        self.assertEqual([f["kind"] for f in flags[s3]], ["identical_answer"])
        self.assertEqual(readers.grading_counts(self.db, CLS)["flagged"], 3)

    def test_large_paste_from_ai_reply(self):
        rec = self.homework(due_at=FUTURE_DUE)
        ident = testsupport.student_identity(self.db, CLS, "s1")
        for length in (120, 260):
            telemetry.add_event(self.db, ident, {
                "classId": CLS, "studentId": "s1", "studentName": "S1", "sessionId": "browser-1", "type": "paste",
                "payload": {"target": "answer", "length": length, "matchesAiReply": True, "assignmentId": rec.id}})
        sub = testsupport.make_autochecked_submission(self.db, CLS, "s1", rec.id, {"q1": "4", "q2": "6", "q3": "t"})
        self.assertEqual([f["kind"] for f in grading_rules.flags_for(self.db, CLS, [sub])[sub]], ["paste_from_ai"])

    def test_flags_ignore_unflagged_turns_short_pastes_and_later_turns(self):
        rec = self.homework(due_at=FUTURE_DUE)
        testsupport.make_chat_turn(self.db, CLS, "s1", "Hint?", "Try mean().", assignment_id=rec.id,
                                   at="2026-10-20T00:00:00+00:00")
        sub = testsupport.make_autochecked_submission(self.db, CLS, "s1", rec.id, {"q1": "4", "q2": "6", "q3": "t"},
                                                      at="2026-10-21T00:00:00+00:00")
        testsupport.make_chat_turn(self.db, CLS, "s1", "Answer?", "4", assignment_id=rec.id, flagged=True,
                                   at="2026-10-21T05:00:00+00:00")
        self.assertEqual(grading_rules.flags_for(self.db, CLS, [sub])[sub], [])
        self.assertEqual(readers.grading_counts(self.db, CLS)["flagged"], 0)


if __name__ == "__main__":
    unittest.main()
