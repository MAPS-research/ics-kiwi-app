"""Coverage for the ``server/app.py`` bootstrap (FOUNDATION): ``.env`` loading rules, request logging without query
strings, and ``main`` startup (migration failure exits 1; the HTTP server is faked, nothing listens)."""

from __future__ import annotations

import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from server import testsupport  # noqa: F401  (empties the AI keys before anything reads them)
from server import app, migrations


class LoadDotenvTests(unittest.TestCase):
    def test_reads_values_without_overriding_the_environment(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            Path(root, ".env").write_text(
                "# comment\n\nNOT_AN_ASSIGNMENT\nCOVERAGE_DOTENV_A = \"quoted value\"\nCOVERAGE_DOTENV_B='single'\n"
                "COVERAGE_DOTENV_C=from-file\nCOVERAGE_DOTENV_D=a=b\n")
            with patch.object(app, "ROOT", Path(root)), patch.dict(os.environ, {"COVERAGE_DOTENV_C": "from-env"}):
                app.load_dotenv()
                self.assertEqual(os.environ["COVERAGE_DOTENV_A"], "quoted value")
                self.assertEqual(os.environ["COVERAGE_DOTENV_B"], "single")
                self.assertEqual(os.environ["COVERAGE_DOTENV_C"], "from-env")
                self.assertEqual(os.environ["COVERAGE_DOTENV_D"], "a=b")
                self.assertNotIn("NOT_AN_ASSIGNMENT", os.environ)
        for key in ("COVERAGE_DOTENV_A", "COVERAGE_DOTENV_B", "COVERAGE_DOTENV_D"):
            os.environ.pop(key, None)

    def test_missing_file_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as root, patch.object(app, "ROOT", Path(root)):
            before = dict(os.environ)
            app.load_dotenv()
            self.assertEqual(dict(os.environ), before)


class LoggingTests(unittest.TestCase):
    def test_log_message_strips_query_strings(self) -> None:
        err = io.StringIO()
        with redirect_stderr(err):
            app.Handler.log_message(SimpleNamespace(), "%s %s", "GET", "/api/teacher/roster?classId=c1&token=abc")  # type: ignore[arg-type]
        line = err.getvalue()
        self.assertRegex(line, r"^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] GET /api/teacher/roster\n$")
        self.assertNotIn("token", line)

    def test_log_message_survives_a_bad_format(self) -> None:
        err = io.StringIO()
        with redirect_stderr(err):
            app.Handler.log_message(SimpleNamespace(), "%d items", "many")  # type: ignore[arg-type]
        self.assertTrue(err.getvalue().rstrip().endswith("%d items"))

    def test_log_request_drops_the_query(self) -> None:
        seen: list[str] = []
        handler = SimpleNamespace(path="/api/events?classId=c1", command="POST",
                                  log_message=lambda fmt, *args: seen.append(fmt % args))
        app.Handler.log_request(handler, 201)  # type: ignore[arg-type]
        handler.path = None
        app.Handler.log_request(handler)  # type: ignore[arg-type]
        self.assertEqual(seen, ["POST /api/events 201", "POST  -"])


class MainTests(unittest.TestCase):
    def test_migration_failure_exits_with_status_1(self) -> None:
        err = io.StringIO()
        # WHY the fake server: main() binds the port before migrating; a test must never bind the live API port
        with patch.object(app, "ThreadingHTTPServer"), \
                patch.object(app, "init_db", side_effect=migrations.MigrationError("snapshot is newer")), redirect_stderr(err), \
                self.assertRaises(SystemExit) as caught:
            app.main()
        self.assertEqual(caught.exception.code, 1)
        self.assertIn("Kiwi Lab API did not start: snapshot is newer", err.getvalue())

    def test_serves_on_the_configured_loopback_port(self) -> None:
        started: list[tuple] = []

        class FakeServer:
            def __init__(self, address: tuple, handler: type) -> None:
                started.append((address, handler))

            def serve_forever(self) -> None:
                started.append(("served",))

        out = io.StringIO()
        with patch.object(app, "init_db"), patch.object(app, "ThreadingHTTPServer", FakeServer), \
                patch.dict(os.environ, {"KIWI_API_PORT": "8199"}), redirect_stdout(out):
            app.main()
        self.assertEqual(started, [(("127.0.0.1", 8199), app.Handler), ("served",)])
        self.assertEqual(out.getvalue(), "Kiwi Lab API: http://127.0.0.1:8199\n")


if __name__ == "__main__":
    unittest.main()
