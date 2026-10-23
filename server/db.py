"""SQLite connection helpers, transactions, clock and canonical JSON (FOUNDATION, frozen).

The database path is read at call time through a provider that ``server/app.py``
registers, so tests can assign ``app.DB_PATH`` after import.
"""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

ROOT = Path(__file__).resolve().parents[1]

_path_provider: Callable[[], Path] | None = None
_clock: Callable[[], datetime] | None = None


def set_path_provider(provider: Callable[[], Path] | None) -> None:
    """Register the function that returns the current database path (``app.DB_PATH``)."""
    global _path_provider
    _path_provider = provider


def path() -> Path:
    if _path_provider is not None:
        return Path(_path_provider())
    return Path(os.environ.get("KIWI_DB_PATH", ROOT / "data" / "kiwi-lab.sqlite3"))


class ManagedConnection(sqlite3.Connection):
    """``with connection() as db`` commits (or rolls back) and then closes the connection."""

    def __exit__(self, exc_type, exc, tb):  # type: ignore[override]
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            self.close()


def connection(db_path: Path | str | None = None) -> sqlite3.Connection:
    target = Path(db_path) if db_path is not None else path()
    target.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(target, timeout=10, factory=ManagedConnection)
    db.row_factory = sqlite3.Row
    return db


def set_clock(clock: Callable[[], datetime] | None) -> None:
    """Test hook: ``set_clock(lambda: datetime(...))``; ``None`` restores the real clock."""
    global _clock
    _clock = clock


def utcnow() -> datetime:
    value = _clock() if _clock is not None else datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def now() -> str:
    """ISO-8601 UTC with milliseconds, e.g. ``2026-10-22T06:01:21.123+00:00``."""
    return utcnow().isoformat(timespec="milliseconds")


def now_ms() -> int:
    return int(utcnow().timestamp() * 1000)


def iso_seconds(value: datetime) -> str:
    """Second-precision UTC bound ``YYYY-MM-DDTHH:MM:SS+00:00`` (floored)."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat(timespec="seconds")


def parse_iso(value: object) -> datetime | None:
    """Parse an ISO-8601 string (``Z`` or offset; naive values are UTC). ``None``/'' → ``None``.

    Raises ``ValueError`` with a readable message for malformed values.
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Invalid date-time value") from exc
    else:
        raise ValueError("Invalid date-time value")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@contextmanager
def write_tx(db: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """``BEGIN IMMEDIATE`` … ``COMMIT`` unless the connection is already inside a transaction.

    Nested use joins the outer transaction (the outer owner commits or rolls back).
    """
    if db.in_transaction:
        yield db
        return
    db.execute("BEGIN IMMEDIATE")
    try:
        yield db
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    else:
        if db.in_transaction:
            db.execute("COMMIT")


def json_dumps(value: Any) -> str:
    """Canonical JSON: sorted keys, no spaces, UTF-8 text."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def table_columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in db.execute(f"PRAGMA table_info({table})")}


def table_exists(db: sqlite3.Connection, table: str) -> bool:
    return (
        db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        is not None
    )
