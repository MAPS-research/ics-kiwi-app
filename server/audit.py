"""Audit trail: staff mutations and staff reads of student data (spec §5.5; FOUNDATION, frozen)."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Mapping

from server import db as dbmod

MAX_JSON = 20000
REDACTED_KEYS = frozenset({"search", "q", "studentId", "email", "emails", "kiwiEmail", "studentEmail", "prompt",
                           "note", "reason", "text", "name", "displayName", "purpose", "token", "key"})


def actor_label(identity: Any) -> str:
    """Kiwi caller username, ``staff.display_name``, or ``Instructor (local key)``."""
    if identity is None:
        return ""
    if identity.kind == "teacher_key":
        return "Instructor (local key)"
    return (identity.display_name or identity.user_id or "")[:200]


def _json(value: object) -> str:
    if value is None:
        return ""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return text if len(text) <= MAX_JSON else text[:MAX_JSON] + "…[truncated]"


def strip_params(params: Mapping[str, object] | None) -> dict[str, object]:
    """Remove search terms, student ids, emails and free text (keys kept with ``[redacted]``)."""
    clean: dict[str, object] = {}
    for key, value in (params or {}).items():
        if key in REDACTED_KEYS or (isinstance(value, str) and "@" in value):
            clean[key] = "[redacted]"
        elif isinstance(value, str):
            clean[key] = value[:200]
        else:
            clean[key] = value
    return clean


def record_action(db: sqlite3.Connection, req: Any, action: str, target_type: str, target_id: str = "",
                  before: object = None, after: object = None) -> None:
    identity = req.identity
    db.execute(
        """INSERT INTO teacher_actions (class_id, actor_id, actor_kind, actor_role, actor_label, action, target_type,
        target_id, before_json, after_json, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (req.class_id, (identity.user_id or "") if identity else "", identity.kind if identity else "anonymous",
         identity.actor_role if identity else "unknown", actor_label(identity), action, target_type,
         str(target_id or "")[:200], _json(before), _json(after), req.request_id, dbmod.now()),
    )


def record_access(db: sqlite3.Connection, req: Any, category: str, endpoint: str, params: Mapping[str, object] | None,
                  row_count: int | None, purpose: str = "") -> None:
    identity = req.identity
    db.execute(
        """INSERT INTO data_access_log (class_id, actor_id, actor_kind, actor_role, actor_label, category, endpoint,
        params_json, row_count, purpose, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (req.class_id, (identity.user_id or "") if identity else "", identity.kind if identity else "anonymous",
         identity.actor_role if identity else "unknown", actor_label(identity), category, endpoint,
         json.dumps(strip_params(params), ensure_ascii=False, sort_keys=True), row_count, (purpose or "")[:500],
         req.request_id, dbmod.now()),
    )
