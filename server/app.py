"""Small local API for course settings, assignments and learning telemetry (FOUNDATION, frozen).

The browser runs R with webR. This server never executes student code. Bind to loopback for the local
pilot. ``app.py`` is bootstrap only: environment, database path, ``init_db()``, and a thin ``Handler``
that delegates every method to ``router.dispatch`` (routes live in ``server/routes/``).
"""

from __future__ import annotations

import errno
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
    """``<repo>/.env`` into the environment: real environment variables win, and the first line of a name wins.

    A name set on more than one line gets one warning on stderr naming it (never its value). The same rule as
    ``readEnv`` in ``scripts/local-kiwi/config.mjs``, so the API and the demo scripts agree on which line counts.
    """
    path = ROOT / ".env"
    if not path.exists():
        return
    seen: set[str] = set()
    repeated: list[str] = []
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key in seen:
            if key not in repeated:
                repeated.append(key)
            continue   # WHY: the first line wins, as in config.mjs (a later line never replaces it)
        seen.add(key)
        os.environ.setdefault(key, value.strip().strip("\"'"))
    if repeated:
        sys.stderr.write(f"Warning: .env sets {', '.join(repeated)} on more than one line; the first line of each is used.\n")


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
_ADDRESS_IN_USE = {errno.EADDRINUSE, 48, 98}   # macOS 48, Linux 98


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
    """Bind the port, then migrate, then serve.

    WHY bind first: a busy port used to crash the API *after* ``init_db`` had already migrated the database (and
    written its backup), with another process still using the file. Now a taken port stops the start before the
    database is opened. The listening socket queues requests that arrive while migrations run.
    """
    port = int(os.environ.get("KIWI_API_PORT", "8101"))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as exc:
        reason = f"port {port} on 127.0.0.1 is already in use" if exc.errno in _ADDRESS_IN_USE else \
            f"cannot listen on 127.0.0.1:{port} ({exc.strerror or exc})"
        sys.stderr.write(f"Kiwi Lab API did not start: {reason}. Stop the other process "
                         f"(lsof -nP -iTCP:{port} -sTCP:LISTEN) or set KIWI_API_PORT; the database was not opened.\n")
        raise SystemExit(1) from exc
    try:
        init_db()
    except migrations.MigrationError as exc:
        server.server_close()
        sys.stderr.write(f"Kiwi Lab API did not start: {exc}\n")
        raise SystemExit(1) from exc
    except BaseException:
        server.server_close()
        raise
    print(f"Kiwi Lab API: http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    from server import app as _app  # one canonical module instance (providers registered by server.app)

    _app.main()
