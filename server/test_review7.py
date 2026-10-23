"""Regression tests for the round-7 known minors (K-m01, K-m03) and the deployment fixes found while writing the docs
(the API binds its port before migrating; ``.env`` duplicates).

Each test names the finding it pins. Fixtures use ``server/testsupport.py`` builders, temporary databases and no AI
provider (AI keys stay empty). Nothing here listens on a fixed port: sockets bind port 0.
"""

from __future__ import annotations

import errno
import io
import os
import socket
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

from server import analytics, app, migrations, readers, testsupport
from server import db as dbmod
from server.test_grading import CLS, GradingApiCase, TWO_QUESTIONS
from server.test_insights import KEY, NOW, client_event
from server.testsupport import TEACHER_KEY, ApiTestCase

PAST = "2026-01-01T00:00:00+00:00"


def _at(days: float = 0, minutes: float = 0) -> str:
    moment = dbmod.parse_iso(NOW) - timedelta(days=days, minutes=minutes)
    return moment.isoformat(timespec="milliseconds")


class ActiveMeansLearningActionTests(ApiTestCase):
    """K-m01: Home's glance *Active N of M*, Course metrics, the explorer's population and trend buckets count students
    with a learning action (B-m01's definition); the explorer has *Last learning action* and *Last seen* (any event)."""

    def setUp(self) -> None:
        super().setUp()
        self.clock = testsupport.freeze_time(NOW)
        self.cls = "km01"
        self.create_course(self.cls)
        with self.db() as db:
            for sid in ("s1", "s2", "s3"):
                testsupport.add_roster(db, self.cls, sid, display_name=f"Name {sid}")
            # s1 (Bo in the review): a practice-settings change (category "action", not a learning action), then a page view
            client_event(db, self.cls, "s1", "practice_settings_changed", {"field": "difficulty", "from": 2, "to": 3},
                         at=_at(minutes=20), surface="practice")
            client_event(db, self.cls, "s1", "page_view", {"route": "/student"}, at=_at(minutes=5))
            # s2: a code run yesterday and a page view now
            client_event(db, self.cls, "s2", "code_run", {"code": "1", "ok": True}, at=_at(days=1), surface="workspace")
            client_event(db, self.cls, "s2", "page_view", {"route": "/student/assignments"}, at=_at(minutes=1))
            # s3: page views only
            client_event(db, self.cls, "s3", "page_view", {"route": "/student"}, at=_at(minutes=30))

    def tearDown(self) -> None:
        self.clock.__exit__(None, None, None)
        super().tearDown()

    def get(self, path: str) -> dict:
        status, data = self.request(path, key=KEY)
        self.assertEqual(status, 200, data)
        return data

    def test_the_glance_and_course_metrics_count_learning_actions_only(self):
        glance = self.get(f"/api/teacher/home?classId={self.cls}")["glance"]
        self.assertEqual((glance["activeStudents"]["value"], glance["enrolled"]), (1, 3))   # was 2/3 (s1's settings change)
        metrics = self.get(f"/api/teacher/metrics?classId={self.cls}")
        self.assertEqual((metrics["active"]["value"], metrics["enrolled"]), (1, 3))
        # P-m02: the per-active average counts learning actions only, matching its denominator (s1's settings change is not
        # a learning action, so 1 learning action / 1 active student; it used to read 2.0 from every action-category event)
        self.assertEqual(metrics["loggedActionsPerActive"]["value"], 1.0)

    def test_the_explorer_population_and_trends_use_the_same_rule(self):
        table = self.get(f"/api/teacher/analytics/table?classId={self.cls}&v=2&group=students")
        self.assertEqual(table["population"], {"enrolled": 3, "active": 1})
        trends = self.get(f"/api/teacher/trends?classId={self.cls}&preset=last_7_days")
        self.assertEqual(sum(b["active"] for b in trends["buckets"]), 1)

    def test_explorer_rows_carry_last_seen_and_last_learning_action_from_one_definition(self):
        table = self.get(f"/api/teacher/analytics/table?classId={self.cls}&v=2&group=students")
        rows = {r["studentId"]: r for r in table["rows"]}
        with self.db() as db:
            stamps = analytics.activity_stamps(db, self.cls, ["s1", "s2", "s3"])
        for sid in ("s1", "s2", "s3"):
            self.assertEqual((rows[sid]["lastActive"], rows[sid]["lastLearningAction"]),
                             (stamps[sid].last_seen, stamps[sid].last_learning_action), sid)
        self.assertEqual(rows["s1"]["lastActive"][:16], _at(minutes=5)[:16])   # a page view is "seen"
        self.assertIsNone(rows["s1"]["lastLearningAction"])
        self.assertEqual(rows["s2"]["lastLearningAction"][:16], _at(days=1)[:16])
        self.assertEqual(rows["s3"]["lastActive"][:16], _at(minutes=30)[:16])  # telemetry-only students are seen too
        self.assertEqual(rows["s3"]["interactions"], 0)                         # counts still leave telemetry out

    def test_last_learning_action_sorts(self):
        table = self.get(f"/api/teacher/analytics/table?classId={self.cls}&v=2&group=students&sort=lastLearningAction")
        self.assertEqual([r["studentId"] for r in table["rows"]][0], "s2")

    def test_the_helper_matches_the_learning_action_types(self):
        sql = analytics.learning_action_sql("x")
        self.assertTrue(sql.startswith("x.event_type IN ("))
        for kind in analytics.LEARNING_ACTION_TYPES:
            self.assertIn(f"'{kind}'", sql)
        self.assertNotIn("practice_settings_changed", sql)


class RevisionDraftCarryTests(GradingApiCase):
    """K-m03: the first open of a revision brings the student's draft over from the closed original."""

    def revise(self, rec, *, retire: bool = True, edit=None) -> dict:
        status, copy = self.request(f"/api/teacher/assignments/{rec.id}/duplicate?classId={CLS}", "POST",
                                    {"asRevision": True, "retireOriginalOnPublish": retire}, TEACHER_KEY)
        self.assertEqual(status, 201, copy)
        if edit is not None:
            status, body = self.request(f"/api/teacher/assignments/{copy['id']}?classId={CLS}", key=TEACHER_KEY)
            self.assertEqual(status, 200, body)
            status, body = self.request(f"/api/teacher/assignments/{copy['id']}?classId={CLS}", "PUT",
                                        {**edit(body), "baseUpdatedAt": body["updatedAt"]}, TEACHER_KEY)
            self.assertEqual(status, 200, body)
        status, published = self.request(f"/api/teacher/assignments/{copy['id']}/publish?classId={CLS}", "POST", {}, TEACHER_KEY)
        self.assertEqual(status, 200, published)
        return published

    def draft(self, student: str, work_id: str) -> dict:
        status, data = self.request(f"/api/drafts/{work_id}?classId={CLS}&studentId={student}", student=student)
        self.assertEqual(status, 200, data)
        return data

    def save(self, student: str, work_id: str, answers: dict) -> None:
        status, data = self.request(f"/api/drafts/{work_id}?classId={CLS}", "PUT",
                                    {"studentId": student, "answers": answers, "clientTs": dbmod.now_ms()}, student=student)
        self.assertEqual(status, 200, data)

    def qmap(self, revision_id: str) -> dict[str, str]:
        """original question id → revision question id."""
        with self.db() as db:
            rec = readers.load_assignment(db, CLS, revision_id)
            stored = db.execute("SELECT question_id_map_json FROM assignments WHERE id=?", (revision_id,)).fetchone()[0]
        mapping = analytics._loads(stored, {})
        return {old: new for new, old in mapping.items() if new in {q["id"] for q in rec.questions}}

    def setUp(self) -> None:
        super().setUp()
        self.original = self.hw(title="Files HW", questions=TWO_QUESTIONS)   # due in the future: closed early by the revision
        self.save("s1", self.original.id, {"q1": "4", "q2": "  "})          # an answer and a blank one

    def test_the_draft_follows_the_student_to_the_revision_once(self):
        revision = self.revise(self.original)
        ids = self.qmap(revision["id"])
        first = self.draft("s1", revision["id"])
        self.assertEqual(first["copiedFrom"], {"assignmentId": self.original.id, "title": "Files HW"})
        self.assertEqual({qid: a["value"] for qid, a in first["answers"].items()}, {ids["q1"]: "4"})   # blanks stay behind
        self.assertEqual(first["assignmentVersion"], revision["version"])
        again = self.draft("s1", revision["id"])
        self.assertNotIn("copiedFrom", again)
        self.assertEqual(again["answers"], first["answers"])
        kept = self.draft("s1", self.original.id)                                # the original keeps its draft
        self.assertEqual(kept["answers"]["q1"]["value"], "4")
        with self.db() as db:
            events = db.execute("SELECT COUNT(*) FROM events WHERE event_type='answer_draft' AND attribution_assignment_id=?",
                                (revision["id"],)).fetchone()[0]
            stamps = analytics.activity_stamps(db, CLS, ["s1"])["s1"]
        self.assertEqual(events, 0)                                              # copying is not a learning action
        self.assertIsNotNone(stamps.last_learning_action)
        status, book = self.request(f"/api/teacher/gradebook?classId={CLS}", key=TEACHER_KEY)
        cells = {(r["studentId"], c["assignmentId"]): c for r in book["rows"] for c in r["cells"]}
        self.assertEqual(cells[("s1", revision["id"])]["draftAnswered"], 1)      # "started" on the version they can submit

    def test_an_existing_revision_draft_is_never_overwritten(self):
        revision = self.revise(self.original)
        ids = self.qmap(revision["id"])
        self.save("s1", revision["id"], {ids["q2"]: "my new words"})
        data = self.draft("s1", revision["id"])
        self.assertNotIn("copiedFrom", data)
        self.assertEqual({qid: a["value"] for qid, a in data["answers"].items()}, {ids["q2"]: "my new words"})

    def test_an_emptied_revision_draft_counts_as_a_draft(self):
        revision = self.revise(self.original)
        ids = self.qmap(revision["id"])
        self.save("s1", revision["id"], {ids["q1"]: ""})
        data = self.draft("s1", revision["id"])
        self.assertNotIn("copiedFrom", data)
        self.assertEqual(data["answers"][ids["q1"]]["value"], "")

    def test_no_copy_while_the_original_still_accepts_work(self):
        revision = self.revise(self.original, retire=False)
        data = self.draft("s1", revision["id"])
        self.assertNotIn("copiedFrom", data)
        self.assertEqual(data["answers"], {})

    def test_no_copy_for_a_student_who_submitted_the_original(self):
        self.submit("s2", self.original, {"q1": "4", "q2": "words"})
        self.save("s2", self.original.id, {"q1": "5"})
        revision = self.revise(self.original)
        data = self.draft("s2", revision["id"])
        self.assertNotIn("copiedFrom", data)
        self.assertEqual(data["answers"], {})

    def test_questions_added_or_removed_in_the_revision(self):
        def edit(body: dict) -> dict:
            kept = [q for q in body["questions"] if q["prompt"] != TWO_QUESTIONS[1]["prompt"]]
            new = {**TWO_QUESTIONS[1], "id": "q-added", "prompt": "A new question."}
            return {**body, "questions": [*kept, new]}

        self.save("s1", self.original.id, {"q2": "words"})
        revision = self.revise(self.original, edit=edit)
        data = self.draft("s1", revision["id"])
        self.assertEqual(data["copiedFrom"]["assignmentId"], self.original.id)
        self.assertEqual(list(data["answers"].values())[0]["value"], "4")
        self.assertEqual(len(data["answers"]), 1)    # q2 was removed; the added question starts empty

    def test_a_revision_of_a_revision_reaches_the_first_version(self):
        first = self.revise(self.original)
        with self.db() as db:
            first_rec = readers.load_assignment(db, CLS, first["id"])
        second = self.revise(first_rec)
        data = self.draft("s1", second["id"])
        self.assertEqual(data["copiedFrom"]["assignmentId"], self.original.id)
        self.assertEqual(list(data["answers"].values())[0]["value"], "4")
        with self.db() as db:   # the middle version, never opened, has no draft rows
            self.assertEqual(db.execute("SELECT COUNT(*) FROM answer_drafts WHERE assignment_id=?", (first["id"],)).fetchone()[0], 0)

    def test_an_assignment_that_is_no_revision_is_untouched(self):
        other = self.hw(title="Other HW")
        with self.db() as db, dbmod.write_tx(db):
            row = db.execute("SELECT * FROM assignments WHERE id=?", (other.id,)).fetchone()
            from server import submissions
            self.assertIsNone(submissions.carry_revision_draft(db, CLS, row, "s1", preview=False))


class BindBeforeMigrateTests(unittest.TestCase):
    """The API binds its port before it migrates the database, so a busy port never leaves a migrated database behind."""

    def test_a_busy_port_stops_the_start_before_the_database_is_opened(self):
        holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        holder.bind(("127.0.0.1", 0))
        holder.listen(1)
        port = holder.getsockname()[1]
        err = io.StringIO()
        try:
            with patch.object(app, "init_db") as init_db, patch.dict(os.environ, {"KIWI_API_PORT": str(port)}), \
                    redirect_stderr(err), self.assertRaises(SystemExit) as caught:
                app.main()
        finally:
            holder.close()
        self.assertEqual(caught.exception.code, 1)
        init_db.assert_not_called()
        self.assertIn(f"port {port} on 127.0.0.1 is already in use", err.getvalue())
        self.assertIn("the database was not opened", err.getvalue())

    def test_other_bind_errors_name_the_port(self):
        failing = MagicMock(side_effect=OSError(errno.EACCES, "Permission denied"))
        err = io.StringIO()
        with patch.object(app, "ThreadingHTTPServer", failing), patch.object(app, "init_db") as init_db, \
                patch.dict(os.environ, {"KIWI_API_PORT": "8719"}), redirect_stderr(err), self.assertRaises(SystemExit):
            app.main()
        init_db.assert_not_called()
        self.assertIn("cannot listen on 127.0.0.1:8719 (Permission denied)", err.getvalue())

    def test_binds_then_migrates_then_announces_and_serves(self):
        order: list[str] = []
        server = MagicMock()
        server.serve_forever.side_effect = lambda: order.append("serve")

        def bind(address, handler):
            order.append(f"bind {address[1]}")
            return server

        out = io.StringIO()
        with patch.object(app, "ThreadingHTTPServer", side_effect=bind), \
                patch.object(app, "init_db", side_effect=lambda: order.append("migrate")), \
                patch.dict(os.environ, {"KIWI_API_PORT": "8718"}), redirect_stdout(out):
            app.main()
        self.assertEqual(order, ["bind 8718", "migrate", "serve"])
        self.assertEqual(out.getvalue(), "Kiwi Lab API: http://127.0.0.1:8718\n")   # printed once it really listens

    def test_a_failed_migration_releases_the_port(self):
        server = MagicMock()
        err = io.StringIO()
        with patch.object(app, "ThreadingHTTPServer", return_value=server), \
                patch.object(app, "init_db", side_effect=migrations.MigrationError("snapshot is newer")), \
                redirect_stderr(err), self.assertRaises(SystemExit) as caught:
            app.main()
        self.assertEqual(caught.exception.code, 1)
        server.server_close.assert_called_once()
        server.serve_forever.assert_not_called()
        self.assertIn("Kiwi Lab API did not start: snapshot is newer", err.getvalue())

    def test_an_unexpected_startup_error_also_releases_the_port(self):
        server = MagicMock()
        with patch.object(app, "ThreadingHTTPServer", return_value=server), \
                patch.object(app, "init_db", side_effect=RuntimeError("disk full")), self.assertRaises(RuntimeError):
            app.main()
        server.server_close.assert_called_once()


class DotenvDuplicateTests(unittest.TestCase):
    """``.env``: the first line of a name wins (as in ``scripts/local-kiwi/config.mjs``) and duplicates are named once."""

    def test_first_line_wins_and_the_warning_names_keys_only(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, ".env").write_text("REVIEW7_DUP=first-secret-value\nREVIEW7_ONE=x\nREVIEW7_DUP=second-secret-value\n"
                                          "REVIEW7_DUP=third\nREVIEW7_TWO=a\nREVIEW7_TWO=b\n")
            err = io.StringIO()
            try:
                with patch.object(app, "ROOT", Path(root)), redirect_stderr(err):
                    app.load_dotenv()
                self.assertEqual((os.environ["REVIEW7_DUP"], os.environ["REVIEW7_TWO"]), ("first-secret-value", "a"))
            finally:
                for key in ("REVIEW7_DUP", "REVIEW7_ONE", "REVIEW7_TWO"):
                    os.environ.pop(key, None)
        warning = err.getvalue()
        self.assertEqual(warning, "Warning: .env sets REVIEW7_DUP, REVIEW7_TWO on more than one line; "
                                  "the first line of each is used.\n")
        for value in ("first-secret-value", "second-secret-value", "third"):
            self.assertNotIn(value, warning)

    def test_no_warning_without_duplicates(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, ".env").write_text("REVIEW7_SINGLE=1\n# REVIEW7_SINGLE=2\n")
            err = io.StringIO()
            try:
                with patch.object(app, "ROOT", Path(root)), redirect_stderr(err):
                    app.load_dotenv()
                self.assertEqual(os.environ["REVIEW7_SINGLE"], "1")
            finally:
                os.environ.pop("REVIEW7_SINGLE", None)
        self.assertEqual(err.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
