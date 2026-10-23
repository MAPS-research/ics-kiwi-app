"""Small local API for course settings, assignments and learning telemetry (FOUNDATION, frozen).

The browser runs R with webR. This server never executes student code. Bind to loopback for the local
pilot. ``app.py`` is bootstrap only: environment, database path, ``init_db()``, and a thin ``Handler``
that delegates every method to ``router.dispatch`` (routes live in ``server/routes/``).
"""

from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if __package__ in (None, ""):  # python3 server/app.py
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import ai, analytics, auth, course_config, kiwi_bridge, migrations, router, telemetry, workflows  # noqa: E402,F401
from server import db as dbmod  # noqa: E402
from server import routes  # noqa: E402,F401  (registers every endpoint)

ROOT = Path(__file__).resolve().parents[1]


def load_dotenv() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_dotenv()
DB_PATH = Path(os.environ.get("KIWI_DB_PATH", ROOT / "data" / "kiwi-lab.sqlite3"))
TEACHER_KEY = os.environ.get("KIWI_TEACHER_KEY", "")   # no default: the standalone teacher workspace fails closed
# Read at call time so tests can assign app.DB_PATH / app.TEACHER_KEY after import.
dbmod.set_path_provider(lambda: DB_PATH)
auth.set_teacher_key_provider(lambda: TEACHER_KEY)

DEFAULT_COURSE = course_config.DEFAULT_COURSE
course_for = course_config.course_for
validate_course = course_config.validate_course
valid_id = router.valid_id
add_event = telemetry.add_event
events_for = telemetry.events_for
summary_for = telemetry.summary_for
now = dbmod.now
_QUERY = re.compile(r"\?[^\s\"']*")


def connection():
    return dbmod.connection()


def init_db() -> None:
    """v0.5.1 base schema → core and workstream migrations (backup first) → derived-index maintenance."""
    with connection() as db:
        db.execute("PRAGMA journal_mode=WAL")
        migrations.base_schema(db)
        migrations.run(db)
        telemetry.init(db)
        kiwi_bridge.init(db)
        ai.init(db)  # CR-AIRUN-1, §4.4: ai_calls pending > 10 min → interrupted (AIRUN-24)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        router.dispatch(self, "GET")

    def do_POST(self) -> None:
        router.dispatch(self, "POST")

    def do_PUT(self) -> None:
        router.dispatch(self, "PUT")

    def do_PATCH(self) -> None:
        router.dispatch(self, "PATCH")

    def do_DELETE(self) -> None:
        router.dispatch(self, "DELETE")

    def log_request(self, code: object = "-", size: object = "-") -> None:
        path = (self.path or "").split("?", 1)[0]
        self.log_message("%s %s %s", self.command, path, str(code))

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - BaseHTTPRequestHandler signature
        """Log ``method path status`` (and errors) without query strings or client addresses."""
        try:
            text = format % args
        except (TypeError, ValueError):
            text = str(format)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        sys.stderr.write(f"[{stamp}] {_QUERY.sub('', text)}\n")


def main() -> None:
    try:
        init_db()
    except migrations.MigrationError as exc:
        sys.stderr.write(f"Kiwi Lab API did not start: {exc}\n")
        raise SystemExit(1) from exc
    port = int(os.environ.get("KIWI_API_PORT", "8101"))
    print(f"Kiwi Lab API: http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    from server import app as _app  # one canonical module instance (providers registered by server.app)

    _app.main()
