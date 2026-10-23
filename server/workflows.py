"""Compatibility shim (FOUNDATION, frozen): v0.5.1 ``workflows`` names now live in their owners' modules.

``assignments`` (ASSESS) · ``submissions`` (ASSESS) · ``grading`` (GRADE) · ``roster`` (PEOPLE).
Old imports such as ``from server import workflows; workflows.save_work(...)`` keep working.
"""

from __future__ import annotations

import sqlite3

from server import grading as _grading
from server import migrations as _migrations
from server.assignments import (  # noqa: F401  (re-exports)
    check_practice, get_work, list_work, save_work, serialize_work, set_status, validate_work, work_options,
)
from server.db import now  # noqa: F401
from server.grading import grade, hub  # noqa: F401
from server.roster import import_roster  # noqa: F401
from server.submissions import list_submissions, submit  # noqa: F401
from server import assignments as _assignments


def init(db: sqlite3.Connection) -> None:
    """Tables are created by ``migrations.base_schema`` (kept for old callers; idempotent)."""
    _migrations.base_schema(db)


def work_page(db: sqlite3.Connection, class_id: str, args: dict) -> dict:
    view = args.get("view", "assignments")
    if view == "grading":
        return _grading.work_page(db, class_id, args)
    if view == "assignments":
        return _assignments.work_page(db, class_id, args)
    raise ValueError("Unsupported work page")
