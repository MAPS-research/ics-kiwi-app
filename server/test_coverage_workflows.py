"""Coverage for the ``server/workflows.py`` compatibility shim (FOUNDATION): v0.5.1 imports keep working, ``init`` is
idempotent and ``work_page`` dispatches to the owners' pages (ASSESS authoring list, GRADE grading list)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from server import testsupport  # noqa: F401  (empties the AI keys before anything reads them)
from server import app, assignments, grading, roster, submissions, workflows

C = "cov-workflows"


class WorkflowsShimTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "coverage.sqlite3"
        app.init_db()
        self.db = app.connection()
        testsupport.create_course(self.db, C)
        testsupport.add_roster(self.db, C, "s1", display_name="Ada Chen")
        self.work = testsupport.publish_work(self.db, C, title="Week 2 Homework")
        self.submission = testsupport.make_autochecked_submission(self.db, C, "s1", self.work.id, {"q1": "4", "q2": "Values"})

    def tearDown(self) -> None:
        self.db.close()
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def test_reexports_point_at_the_owner_modules(self) -> None:
        self.assertIs(workflows.save_work, assignments.save_work)
        self.assertIs(workflows.list_work, assignments.list_work)
        self.assertIs(workflows.grade, grading.grade)
        self.assertIs(workflows.hub, grading.hub)
        self.assertIs(workflows.import_roster, roster.import_roster)
        self.assertIs(workflows.submit, submissions.submit)

    def test_init_is_idempotent(self) -> None:
        workflows.init(self.db)
        workflows.init(self.db)
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM assignments WHERE id = ?", (self.work.id,)).fetchone())

    def test_work_page_views(self) -> None:
        authoring = workflows.work_page(self.db, C, {})
        self.assertEqual([a["id"] for a in authoring["assignments"]], [self.work.id])
        self.assertEqual(authoring["submissions"], [])
        self.assertEqual(authoring["pageSize"], 20)
        grading_page = workflows.work_page(self.db, C, {"view": "grading", "assignmentId": self.work.id})
        self.assertEqual([s["id"] for s in grading_page["submissions"]], [self.submission])
        self.assertEqual(grading_page["pageSize"], 10)
        with self.assertRaises(ValueError):
            workflows.work_page(self.db, C, {"view": "calendar"})


if __name__ == "__main__":
    unittest.main()
