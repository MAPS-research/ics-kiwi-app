"""Event ingestion, attribution, the question-activity index and Data health (owned by TELEMETRY).

Spec §11 (protocol), §4.4 (derived rebuilds), §13.10 (outages). ``add_event`` validates against the event-type
registry (``server/event_schema.py``), truncates instead of rejecting for size, deduplicates by ``eventId`` with the
partial-index upsert, stamps identity/group/version, derives attribution (``derive``), counts heartbeats once per
30-second bucket and indexes the event into a question activity with the v3 context key (no browser tab).
Rejections are logged in ``event_rejections`` and raised as ``EventRejected`` (a ``ValueError``), which the routes
answer with 422 ``{status: "rejected"}``.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable

from server import db as dbmod
from server import event_schema, readers
from server import identity as identitymod
from server.contracts import AddEventResult
from server.router import ApiError, valid_id

COUNTERS = ("interactions", "attempts", "checked", "correct", "codeRuns", "codeErrors", "codeSuccesses", "aiQuestions")
# v0.6 session counters (§11.6); kept out of COUNTERS so v0.5.1-shaped analytics SQL keeps working.
NEW_COUNTERS = ("actions", "telemetryEvents", "clientChecked", "clientCorrect")
PRACTICE_TYPES = frozenset({
    "question_generated", "question_viewed", "answer_submitted", "code_run", "code_edited", "hint_requested",
    "question_skipped", "difficulty_changed", "topic_changed", "ai_question", "similar_requested", "explanation_shown",
    "answer_revealed", "hint_shown", "paste",
})
ASSIGNMENT_LEVEL_TYPES = frozenset({"work_submitted", "answer_draft", "feedback_viewed"})
# Navigation/presence telemetry is stored but never opens a question activity (heartbeats credit activeSeconds instead).
# SB-M01: ``grade_released`` is a staff action stored on the student's row; it is not the student's activity.
NOT_INDEXED = frozenset({"study_heartbeat", "page_view", "visibility", "idle", "telemetry_gap", "grade_released"})
CODE_TYPES = frozenset({"code_run", "code_edited", "code_shared", "kiwi_check_answer", "kiwi_file_action",
                        "r_package_install", "data_file_loaded"})
QUESTION_ACTIVITY_RULE = ("A question activity groups one student's work on one question, item or thread; events less than "
                          "30 minutes apart belong to the same activity, across browser tabs.")
SESSION_GAP = timedelta(minutes=30)
HEARTBEAT_MS = 30000
HEARTBEAT_SECONDS = 30
# (tag, rebuild) pairs registered by other modules; TELEMETRY's own rebuilds are listed by ``own_rebuilds()``.
DERIVED_REBUILDS: list[tuple[str, Callable[[sqlite3.Connection], None]]] = []
BATCH = 1000
FIELD_LIMITS = {"code": 60000, "output": 40000, "stdout": 40000, "prompt": 20000, "response": 100000}
HEAD_TAIL_FIELDS = frozenset({"output", "stdout"})
MAX_PAYLOAD_CHARS = event_schema.DEFAULT_LIMITS["payload_chars"]
MAX_KEYS = event_schema.DEFAULT_LIMITS["max_keys"]
MAX_DEPTH = event_schema.DEFAULT_LIMITS["max_depth"]
MAX_STRING = event_schema.DEFAULT_LIMITS["string"]
MAX_ARRAY = event_schema.DEFAULT_LIMITS["array"]
RESERVED_KEYS = ("_truncated", "_clientReported")
EVENT_COLUMNS = (
    "class_id", "student_id", "student_name", "session_id", "event_type", "question_id", "payload_json", "created_at",
    "source", "event_id", "schema_version", "received_at", "client_ts_ms", "client_seq", "tz_offset_min", "surface",
    "actor_role", "is_preview", "identity_verified", "practice_mode", "attribution_assignment_id",
    "related_assignment_id", "item_id", "checked_by", "section_group_id", "condition_group_id", "assignment_version",
    "policy_version_id", "ai_call_id", "chat_turn_id", "heartbeat_bucket", "heartbeat_counted", "truncated_json",
    "category",
)
_STARTED_AT = time.time()


class EventRejected(ValueError):
    """A per-event rejection (logged in ``event_rejections``); ``result.status == 'rejected'``."""

    def __init__(self, result: AddEventResult):
        super().__init__(result.message)
        self.result = result


class _Invalid(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# -- small helpers ----------------------------------------------------------------------------------------
def _loads(value: object) -> dict:
    if isinstance(value, dict):
        return value
    try:
        data = json.loads(value) if isinstance(value, str) else {}
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _get(row: Any, key: str, default: object = None) -> object:
    try:
        value = row[key]
    except (KeyError, IndexError):
        return default
    return default if value is None else value


def _parse(value: object) -> datetime | None:
    try:
        return dbmod.parse_iso(value)
    except ValueError:
        return None


def _ms(value: object) -> int | None:
    parsed = _parse(value)
    return int(parsed.timestamp() * 1000) if parsed else None


def _int_or_none(value: object) -> int | None:
    if type(value) is int:
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _material_unit(db: sqlite3.Connection, class_id: str, material_id: str) -> str:
    if not material_id:
        return ""
    row = db.execute("SELECT unit_id FROM material_unit_map WHERE class_id=? AND material_id=? ORDER BY valid_from DESC LIMIT 1",
                     (class_id, material_id)).fetchone()
    if row:
        return row["unit_id"]
    row = db.execute("SELECT unit_id FROM kiwi_materials WHERE class_id=? AND id=?", (class_id, material_id)).fetchone()
    return row["unit_id"] if row else ""


# -- attribution (§11.5) ----------------------------------------------------------------------------------
def derive(db: sqlite3.Connection, row: dict) -> dict:
    """§11.5 attribution: {practice_mode, attribution_assignment_id, related_assignment_id, item_id, checked_by,
    category} (+ ``unit_id``). Pure with respect to the event row; reads assignments, items and material maps."""
    payload = _loads(row.get("payload") if isinstance(row.get("payload"), dict) else row.get("payload_json"))
    event_type = str(row.get("event_type") or row.get("type") or "")
    class_id = str(row.get("class_id") or "")
    question_id = str(row.get("question_id") or "")
    surface = str(row.get("surface") or payload.get("surface") or "")
    out = {"practice_mode": "other", "attribution_assignment_id": "", "related_assignment_id": "", "item_id": "",
           "checked_by": "", "category": event_schema.category(event_type), "unit_id": str(payload.get("unitId") or "")}
    if (row.get("source") or "lab") == "kiwi":
        material = str(payload.get("materialId") or "")
        out["practice_mode"] = "lecture" if material else "kiwi"
        out["unit_id"] = _material_unit(db, class_id, material)
    else:
        item = str(payload.get("itemId") or (question_id if question_id.startswith("gi-") else ""))
        item_row = None
        if item:
            out["item_id"] = item
            item_row = db.execute("SELECT origin, related_assignment_id, unit_id FROM generated_items WHERE class_id=? AND id=?",
                                  (class_id, item)).fetchone()
        aid = payload.get("assignmentId") if isinstance(payload.get("assignmentId"), str) else ""
        assignment = db.execute("SELECT kind, unit_id FROM assignments WHERE class_id=? AND id=?", (class_id, aid)).fetchone() if aid else None
        if surface == "similar" or (item_row is not None and item_row["origin"] == "similar"):
            out["practice_mode"] = "similar"
            related = payload.get("relatedAssignmentId") or aid or (item_row["related_assignment_id"] if item_row else "")
            out["related_assignment_id"] = str(related or "")
        elif assignment is not None:
            ids = readers.question_ids_any_version(db, class_id, aid)
            if not question_id or question_id in ids or event_type in ASSIGNMENT_LEVEL_TYPES:
                out["practice_mode"] = "homework" if assignment["kind"] == "homework" else "in-class"
                out["attribution_assignment_id"] = aid
            else:  # legacy similar items carried the parent assignment id
                out["practice_mode"] = "similar"
                out["related_assignment_id"] = aid
            out["unit_id"] = assignment["unit_id"] or out["unit_id"]
        elif (surface == "free-practice" or (item_row is not None and item_row["origin"] == "free")
              or (not aid and event_type in PRACTICE_TYPES and question_id.startswith("q-"))):
            out["practice_mode"] = "free"
        elif surface in ("workspace", "ask-kiwi") or (not aid and not question_id):
            out["practice_mode"] = "workspace"
        if item_row is not None and not out["unit_id"]:
            out["unit_id"] = item_row["unit_id"]
        attribution = payload.get("attribution")
        if out["practice_mode"] == "workspace" and isinstance(attribution, dict) and attribution.get("chapter") == "unattributed":
            out["unit_id"] = ""  # [AU-D4-M6] no silent "current chapter" for the independent workspace
    correct = payload.get("correct")
    stored = row.get("checked_by")
    if isinstance(correct, bool):
        if row.get("server") or stored == "server":
            out["checked_by"] = "server"
        elif row.get("client") or stored == "client":
            out["checked_by"] = "client"
        elif int(row.get("schema_version") or 1) == 1 and event_type == "answer_submitted" and out["practice_mode"] == "in-class":
            out["checked_by"] = "legacy_server"
        else:
            out["checked_by"] = "client"
    return out


# -- counters & index (§11.6) -----------------------------------------------------------------------------
def event_counters(event_type: str, p: dict, checked_by: str | None = None, category: str | None = None) -> dict:
    """Session counter increments for one event. ``checked``/``correct`` count server-checked attempts only (v3);
    without ``checked_by`` (v0.5.1 callers) every boolean ``correct`` counts as before."""
    client_reported = bool(p.get("_clientReported"))
    attempt = event_type == "answer_submitted" and not client_reported
    has_bool = isinstance(p.get("correct"), bool)
    if checked_by is None:
        server_checked = attempt and has_bool
        client_checked = False
    else:
        server_checked = attempt and has_bool and checked_by == "server"
        client_checked = event_type == "answer_submitted" and has_bool and checked_by == "client"
    kind = category if category is not None else event_schema.category(event_type)
    return {"interactions": 1, "attempts": int(attempt), "checked": int(server_checked),
            "correct": int(server_checked and p["correct"]), "codeRuns": int(event_type == "code_run"),
            "codeErrors": int(event_type == "code_run" and p.get("ok") is False),
            "codeSuccesses": int(event_type == "code_run" and p.get("ok") is True),
            "aiQuestions": int(event_type in ("ai_question", "hint_requested") and p.get("ok") is not False),
            "actions": int(kind == "action"), "telemetryEvents": int(kind == "telemetry"),
            "clientChecked": int(client_checked), "clientCorrect": int(client_checked and p["correct"])}


def _origin(mode: str, item_id: str) -> str:
    if mode in ("homework", "in-class"):
        return "teacher"
    if mode == "free":
        return "ai-free"
    if mode == "similar":
        return "ai-similar"
    return ""


DEFAULT_TITLES = {"code": "R workspace", "thread": "AI tutor conversation", "reading": "Lecture page",
                  "submission": "Homework submission", "activity": "Other activity"}
EVENT_TITLES = {"difficulty_changed": "Practice settings", "topic_changed": "Practice settings",
                "profile_updated": "Practice settings", "work_opened": "Assignment opened"}


def _kind(event_type: str, key_question: str, payload: dict) -> str:
    if event_type == "work_submitted":
        return "submission"
    if key_question:
        return "question"
    if event_type == "material_viewed":
        return "reading"
    if payload.get("threadId") and event_type not in ("code_run", "code_shared"):
        return "thread"
    if event_type in CODE_TYPES:
        return "code"
    return "activity"


def _stem(text: object, limit: int = 80) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _item_prompt(db: sqlite3.Connection, class_id: str, item_id: str) -> str:
    if not item_id:
        return ""
    row = db.execute("SELECT item_json FROM generated_items WHERE class_id=? AND id=?", (class_id, item_id)).fetchone()
    if not row:
        return ""
    item = _loads(row["item_json"])
    return str(item.get("title") or item.get("prompt") or "")


def _title(db: sqlite3.Connection, row: Any, payload: dict, kind: str, mode: str, aid: str, qid: str, item: str) -> str:
    if kind == "submission":
        attempt = _int_or_none(payload.get("attempt"))
        late = " · Late" if payload.get("late") is True else ""   # RV6-m07
        return f"Homework submission · Attempt {attempt}{late}" if attempt else f"Homework submission{late}"
    title = str(payload.get("questionTitle") or payload.get("title") or "")[:500]
    if aid and qid and mode in ("homework", "in-class"):
        work = db.execute("SELECT questions_json FROM assignments WHERE class_id=? AND id=?", (row["class_id"], aid)).fetchone()
        if work:
            question = next((q for q in _loads_list(work["questions_json"]) if q.get("id") == qid), None)
            if question and question.get("prompt"):
                title = str(question["prompt"])[:500]
    if mode == "similar":
        return "Similar practice (AI) · " + _stem(_item_prompt(db, row["class_id"], item) or title or payload.get("prompt") or "exercise")
    if mode == "free" and row["source"] == "lab":
        return "Free practice (AI) · " + _stem(_item_prompt(db, row["class_id"], item) or title or "exercise")
    return title


def _loads_list(value: object) -> list[dict]:
    try:
        data = json.loads(value) if isinstance(value, str) else value
    except json.JSONDecodeError:
        return []
    return [q for q in data if isinstance(q, dict)] if isinstance(data, list) else []


def _context(db: sqlite3.Connection, row: Any, payload: dict) -> dict:
    """Derived context of a stored event row (unit, attribution, question/item key, kind, key)."""
    derived = derive(db, {**dict(row), "payload": payload})
    source = row["source"] or "lab"
    if _get(row, "practice_mode", ""):  # derived at write time or by sessions-v3
        mode = str(row["practice_mode"])
        attr = str(_get(row, "attribution_assignment_id", ""))
        related = str(_get(row, "related_assignment_id", ""))
        item = str(_get(row, "item_id", "") or "")
    else:  # a raw row that was never derived (e.g. inserted by an old writer or a test)
        mode, attr, related, item = (derived["practice_mode"], derived["attribution_assignment_id"],
                                     derived["related_assignment_id"], derived["item_id"])
    qid = str(row["question_id"] or "")
    key_question = qid or item
    kind = _kind(row["event_type"], key_question, payload)
    material = str(payload.get("materialId") or "")[:100] if source == "kiwi" else ""
    thread = "" if key_question else str(payload.get("threadId") or "")[:120]
    if kind == "submission":
        thread = f"attempt-{_int_or_none(payload.get('attempt')) or 0}"
    unit = derived["unit_id"][:100]
    unit_slot = ("m:" + material) if source == "kiwi" else unit
    key = json.dumps([source, unit_slot, attr, related, key_question, thread, kind, mode], ensure_ascii=False)
    return {"unit": unit, "mode": mode, "attr": attr, "related": related, "qid": qid, "item": item, "kind": kind,
            "material": material, "thread": thread, "key": key}


def _credit_heartbeat(db: sqlite3.Connection, row: Any, payload: dict) -> None:
    """A counted heartbeat adds 30 s to the latest matching question activity active in the last 30 minutes (§11.4)."""
    ctx = _context(db, row, payload)
    created = _parse(row["created_at"])
    if created is None:
        return
    low = dbmod.iso_seconds(created - SESSION_GAP)
    key = ctx["qid"] or ctx["item"]
    match = db.execute(
        """SELECT id FROM learning_sessions WHERE classId=? AND studentId=? AND source='lab' AND unitId=? AND assignmentId=?
        AND (questionId=? OR (?!='' AND itemId=?)) AND lastActive>=? ORDER BY lastActive DESC, id DESC LIMIT 1""",
        (row["class_id"], row["student_id"], ctx["unit"], ctx["attr"], key, key, key, low)).fetchone()
    if match:
        db.execute("UPDATE learning_sessions SET activeSeconds=activeSeconds+? WHERE id=?", (HEARTBEAT_SECONDS, match["id"]))


def _merge_sessions(db: sqlite3.Connection, class_id: str, keep: str, absorbed: list[str]) -> None:
    """Fold ``absorbed`` question activities into ``keep``: events, counters, time span; old ids become aliases."""
    summed = (*COUNTERS, *NEW_COUNTERS, "activeSeconds")
    marks = ",".join("?" for _ in absorbed)
    totals = db.execute(f"SELECT MIN(startedAt) s, MAX(lastActive) l, {', '.join(f'SUM({c}) {c}' for c in summed)} "
                        f"FROM learning_sessions WHERE id IN ({marks})", absorbed).fetchone()
    db.execute(f"""UPDATE learning_sessions SET startedAt=MIN(startedAt, ?), lastActive=MAX(lastActive, ?),
        {', '.join(f'{c}={c}+?' for c in summed)} WHERE id=?""",
               (totals["s"], totals["l"], *[int(totals[c] or 0) for c in summed], keep))
    db.execute(f"UPDATE events SET learning_session_id=? WHERE learning_session_id IN ({marks})", (keep, *absorbed))
    db.execute(f"UPDATE learning_session_aliases SET new_id=? WHERE new_id IN ({marks})", (keep, *absorbed))
    stamp = dbmod.now()
    for old_id in absorbed:
        db.execute("""INSERT INTO learning_session_aliases (old_id, new_id, class_id, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(old_id) DO UPDATE SET new_id=excluded.new_id""", (old_id, keep, class_id, stamp))
    db.execute(f"DELETE FROM learning_sessions WHERE id IN ({marks})", absorbed)


def index_event(db: sqlite3.Connection, row: Any) -> None:
    """Attach one stored event to a question activity (v3 context key, §11.6); heartbeats credit activeSeconds."""
    payload = _loads(row["payload_json"])
    if row["event_type"] in NOT_INDEXED:
        db.execute("UPDATE events SET learning_session_id='' WHERE id=?", (row["id"],))
        if row["event_type"] == "study_heartbeat" and _get(row, "heartbeat_counted", 0):
            _credit_heartbeat(db, row, payload)
        return
    ctx = _context(db, row, payload)
    created = _parse(row["created_at"])
    if created is None:
        raise ValueError("Event has an invalid created_at")
    low, high = dbmod.iso_seconds(created - SESSION_GAP), dbmod.iso_seconds(created + SESSION_GAP + timedelta(seconds=1))
    matches = db.execute(
        """SELECT id FROM learning_sessions WHERE classId=? AND studentId=? AND contextKey=? AND lastActive>=? AND startedAt<=?
        ORDER BY lastActive DESC, id DESC""",
        (row["class_id"], row["student_id"], ctx["key"], low, high)).fetchall()
    old = matches[0] if matches else None
    if len(matches) > 1:
        # A late (out-of-order) event bridges activities that are now < 30 min apart: merge them so the live index
        # matches a sessions-v3 rebuild (review 2, CORRECTNESS-06).
        _merge_sessions(db, row["class_id"], old["id"], [m["id"] for m in matches[1:]])
    title = _title(db, row, payload, ctx["kind"], ctx["mode"], ctx["attr"], ctx["qid"], ctx["item"])
    sid = old["id"] if old else f"learn-{uuid.uuid4().hex}"
    if not old:
        default = (EVENT_TITLES.get(row["event_type"]) or DEFAULT_TITLES.get(ctx["kind"], "Question activity"))  # NM26
        db.execute(
            """INSERT INTO learning_sessions
            (id,classId,studentId,studentName,browserSession,contextKey,unitId,assignmentId,questionId,kind,title,startedAt,
             lastActive,source,materialId,practiceMode,origin,relatedAssignmentId,itemId,threadId,actorRole,isPreview)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (sid, row["class_id"], row["student_id"], row["student_name"] or "", row["session_id"] or "", ctx["key"], ctx["unit"],
             ctx["attr"], ctx["qid"] or ctx["item"], ctx["kind"], title or default, row["created_at"], row["created_at"],
             row["source"] or "lab", ctx["material"], ctx["mode"], _origin(ctx["mode"], ctx["item"]), ctx["related"], ctx["item"],
             ctx["thread"] if not (ctx["qid"] or ctx["item"]) and ctx["kind"] != "submission" else "",
             str(_get(row, "actor_role", "unknown")), int(_get(row, "is_preview", 0) or 0)))
    counters = event_counters(row["event_type"], payload, str(_get(row, "checked_by", "")), str(_get(row, "category", "")) or None)
    columns = COUNTERS[1:] + NEW_COUNTERS
    db.execute(
        f"""UPDATE learning_sessions SET startedAt=MIN(startedAt, ?), lastActive=MAX(lastActive, ?),
        interactions=interactions+1, {', '.join(f'{c}={c}+?' for c in columns)},
        title=CASE WHEN ?!='' THEN ? ELSE title END WHERE id=?""",
        (row["created_at"], row["created_at"], *[counters[c] for c in columns], title, title, sid))
    db.execute("UPDATE events SET learning_session_id=? WHERE id=?", (sid, row["id"]))


# -- validation & truncation (§11.2 steps 3-4) -------------------------------------------------------------
def _type_ok(kind: str, value: object) -> bool:
    if value is None or kind == "any":
        return True
    if kind == "string":
        return isinstance(value, str)
    if kind == "integer":
        return (isinstance(value, int) and not isinstance(value, bool)) or (isinstance(value, float) and value.is_integer())
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "array":
        return isinstance(value, list)
    if kind == "object":
        return isinstance(value, dict)
    return True


def _depth(value: object) -> int:
    if isinstance(value, dict):
        return 1 + max((_depth(v) for v in value.values()), default=0)
    if isinstance(value, list):
        return 1 + max((_depth(v) for v in value), default=0)
    return 0


TYPE_WORDS = {"string": "a string", "integer": "an integer", "number": "a number", "boolean": "a boolean", "array": "an array",
              "object": "an object"}


def validate_payload(event_type: str, payload: dict) -> None:
    """Registry validation: object, ≤ 64 keys, depth ≤ 4, types checked for registered keys only (unknown keys kept)."""
    if len(payload) > MAX_KEYS:
        raise _Invalid("invalid_payload", f"payload has more than {MAX_KEYS} keys")
    if _depth(payload) > MAX_DEPTH:
        raise _Invalid("invalid_payload", f"payload is nested deeper than {MAX_DEPTH} levels")
    for key, (kind, _description, _free) in event_schema.fields(event_type).items():
        if key in payload and not _type_ok(kind, payload[key]):
            raise _Invalid("invalid_payload", f"payload.{key} must be {TYPE_WORDS.get(kind, kind)}")


def unknown_keys(event_type: str, payload: dict) -> list[str]:
    registered = event_schema.fields(event_type)
    return sorted(k for k in payload if k not in registered and not k.startswith("_"))


def _cut(text: str, limit: int, head_tail: bool) -> str:
    if len(text) <= limit:
        return text
    if head_tail:
        half = max(limit // 2, 1)
        return text[:half] + f"\n…[truncated {len(text) - 2 * half} chars]…\n" + text[-half:]
    return text[:limit]


def _limit_for(event_type: str, path: str) -> tuple[int, bool]:
    top = "." not in path and "[" not in path
    if not top:
        return MAX_STRING, False
    registry = (event_schema.REGISTRY.get(event_type) or {}).get("limits") or {}
    limit = registry.get(path) or FIELD_LIMITS.get(path) or MAX_STRING
    return int(limit), path in HEAD_TAIL_FIELDS


def _shrink(event_type: str, value: object, path: str, truncated: dict[str, int]) -> object:
    if isinstance(value, str):
        limit, head_tail = _limit_for(event_type, path)
        if len(value) > limit:
            truncated.setdefault(path, len(value))
            return _cut(value, limit, head_tail)
        return value
    if isinstance(value, list):
        items = value
        if len(value) > MAX_ARRAY:
            truncated.setdefault(path, len(value))
            items = value[:MAX_ARRAY]
        return [_shrink(event_type, v, f"{path}[{i}]", truncated) for i, v in enumerate(items)]
    if isinstance(value, dict):
        return {k: _shrink(event_type, v, f"{path}.{k}" if path else str(k), truncated) for k, v in value.items()}
    return value


def _largest_string(value: object, path: str = "") -> tuple[int, str, Any, Any]:
    """(length, path, container, key) of the largest string leaf."""
    best: tuple[int, str, Any, Any] = (-1, "", None, None)
    items: Iterable[tuple[Any, object]] = value.items() if isinstance(value, dict) else enumerate(value) if isinstance(value, list) else ()
    for key, child in items:
        child_path = (f"{path}.{key}" if path else str(key)) if isinstance(value, dict) else f"{path}[{key}]"
        if isinstance(child, str):
            if len(child) > best[0]:
                best = (len(child), child_path, value, key)
        elif isinstance(child, (dict, list)):
            candidate = _largest_string(child, child_path)
            if candidate[0] > best[0]:
                best = candidate
    return best


TRUNCATED_MARK = "…[truncated]"
MAX_TRUNCATED_PATHS = 50


def _size(value: object) -> int:
    return len(json.dumps(value, ensure_ascii=False))


def truncate_payload(event_type: str, payload: dict) -> tuple[dict, dict[str, int]]:
    """Per-field limits, then cut until the serialized payload fits ``MAX_PAYLOAD_CHARS`` (never reject for size).

    1. the largest strings are cut while that is effective (a few big text fields: code, output, prompts);
    2. if the payload is still too large (many small values, review 2 CORRECTNESS-04), the largest top-level values are
       replaced with ``TRUNCATED_MARK``, largest first, until it fits; 3. as a last resort only the marker is kept.
    The result always fits; the replaced paths (with their original sizes) are recorded in ``_truncated``.
    """
    truncated: dict[str, int] = {}
    out = _shrink(event_type, payload, "", truncated)
    assert isinstance(out, dict)
    budget = MAX_PAYLOAD_CHARS - 4000  # room for the (bounded) _truncated record
    size = _size(out)
    for _ in range(200):
        if size <= budget:
            break
        length, path, container, key = _largest_string(out)
        excess = size - budget
        # WHY: stop when cutting strings cannot close the gap quickly (e.g. 12,000 strings of 300 characters).
        if container is None or length <= 100 or (length - 100) * 8 < excess:
            break
        new_length = max(100, length - excess - 64)
        truncated.setdefault(path, length)
        container[key] = _cut(container[key], new_length, path in HEAD_TAIL_FIELDS)
        size = _size(out)
    if size > budget:
        sizes = sorted(((_size(v), k) for k, v in out.items() if not str(k).startswith("_")), reverse=True)
        for child_size, key in sizes:
            if size <= budget:
                break
            out[key] = TRUNCATED_MARK
            truncated[str(key)] = max(truncated.get(str(key), 0), child_size)
            size = _size(out)
        if size > budget:  # e.g. thousands of long keys: keep only the marker
            kept = {k: v for k, v in out.items() if k in ("_clientReported", "source")}
            out = {**kept, "_dropped": TRUNCATED_MARK}
            truncated["*"] = size
    if truncated:
        record = dict(sorted(truncated.items(), key=lambda kv: (-kv[1], kv[0]))[:MAX_TRUNCATED_PATHS])
        if len(truncated) > MAX_TRUNCATED_PATHS:
            record["_morePaths"] = len(truncated) - MAX_TRUNCATED_PATHS
        truncated = record
        out["_truncated"] = dict(truncated)
    return out, truncated


# -- ingestion (§11.2) ------------------------------------------------------------------------------------
def _clamped_time(received: datetime, client_ts: object) -> datetime:
    ts = _int_or_none(client_ts)
    if ts is None:
        return received
    try:
        occurred = datetime.fromtimestamp(ts / 1000, timezone.utc)
    except (OverflowError, OSError, ValueError):
        return received
    if received - timedelta(hours=72) <= occurred <= received + timedelta(minutes=5):
        return occurred
    return received


def record_rejection(db: sqlite3.Connection, class_id: str, student_id: str, event_id: str, event_type: str, code: str,
                     message: str) -> None:
    with dbmod.write_tx(db):
        db.execute(
            """INSERT INTO event_rejections (class_id, student_id, client_event_id, event_type, code, message, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (class_id, str(student_id or "")[:100], str(event_id or "")[:100], str(event_type or "")[:60], code, message[:500],
             dbmod.now()))


def count_ingest(db: sqlite3.Connection, class_id: str, kind: str) -> None:
    """Per-minute ingestion counter (``event_ingest_stats``, CR-T5); ``minute`` is the UTC ``YYYY-MM-DDTHH:MM`` prefix."""
    with dbmod.write_tx(db):
        db.execute("""INSERT INTO event_ingest_stats (class_id, minute, kind, count) VALUES (?, ?, ?, 1)
            ON CONFLICT(class_id, minute, kind) DO UPDATE SET count = count + 1""", (class_id, dbmod.now()[:16], kind))


def _reject(db: sqlite3.Connection, class_id: str, student_id: str, event_id: str, event_type: str, code: str,
            message: str) -> EventRejected:
    record_rejection(db, class_id, student_id, event_id, event_type, code, message)
    return EventRejected(AddEventResult(None, event_id, "rejected", code, message, {}))


def _stored_name(identity: Any, linked: bool, body_name: object) -> str:
    """Legacy ``events.student_name``: '' in linked classes (names live only in the roster, labels are resolved at
    read time [AU-D4-10]); standalone demo classes keep the v0.5.1 value (body name, else the session name).

    WHY (deviation): FOUNDATION-08 (frozen ``test_core``) asserts the standalone raw value; it is never used as a label.
    """
    if linked:
        return ""
    if isinstance(body_name, str) and 1 <= len(body_name.strip()) <= 100:
        return body_name.strip()
    if getattr(identity, "preview", False):
        return "Preview student"
    return str(getattr(identity, "display_name", "") or getattr(identity, "student_id", "") or "Student")[:100]


def add_event(db: sqlite3.Connection, identity: Any, event: dict, *, server: bool = False,
              actor_role: str | None = None) -> AddEventResult:
    """Store one event for ``identity`` (a student, demo or preview identity) and index it (§11.2).

    ``server=True``: a server-written event (trusted ``correct``/``checked_by``, payload types not checked).
    ``actor_role`` (server events only): who performed the action when it was not the student, e.g. the staff role
    that released a grade (SB-M01); such rows leave the student population and every "last active" measure.
    Raises ``EventRejected`` (logged in ``event_rejections``) for a per-event rejection, ``ApiError(403)`` when the event
    belongs to another course or student, and ``ValueError`` when ``event`` is not an object.
    """
    if not isinstance(event, dict):
        raise ValueError("Invalid event format")
    class_id = event.get("classId") or identity.class_id
    if class_id != identity.class_id:
        raise ApiError(403, "forbidden", "Activity belongs to another course")
    student_id = event.get("studentId") or identity.student_id
    if identity.student_id and student_id != identity.student_id:
        raise ApiError(403, "forbidden", "Student activity belongs to another user")
    raw_event_id = event.get("eventId")
    client_event_id = raw_event_id if isinstance(raw_event_id, str) else ""
    kind = event.get("type")
    kind_text = kind if isinstance(kind, str) else ""
    if raw_event_id is not None and not valid_id(raw_event_id):
        raise _reject(db, class_id, student_id or "", client_event_id[:100], kind_text, "invalid_payload", "eventId has an invalid format")
    session_id = event.get("sessionId") or ("server" if server else None)
    for key, value in (("studentId", student_id), ("sessionId", session_id)):
        if not valid_id(value):
            raise _reject(db, class_id, str(student_id or ""), client_event_id, kind_text, "invalid_payload", f"{key} has an invalid format")
    if not event_schema.is_known(kind):
        raise _reject(db, class_id, student_id, client_event_id, kind_text, "invalid_payload", f"Unsupported event type: {kind_text[:60]}")
    payload = event.get("payload", {})
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise _reject(db, class_id, student_id, client_event_id, kind, "invalid_payload", "payload must be an object")
    question_id = event.get("questionId")
    if question_id is not None and not valid_id(question_id):
        raise _reject(db, class_id, student_id, client_event_id, kind, "invalid_payload", "questionId has an invalid format")
    schema_version = 2 if server or event.get("schemaVersion") == 2 else 1
    client_reported = False
    if not server:
        payload = {k: v for k, v in payload.items() if k not in RESERVED_KEYS}
        if payload.get("source") == "kiwi":  # anti-spoof: clients cannot pose as native Kiwi rows (KEEP)
            payload = {k: v for k, v in payload.items() if not k.startswith("upstream")}
            payload["source"] = "lab"
        try:
            validate_payload(kind, payload)
        except _Invalid as exc:
            raise _reject(db, class_id, student_id, client_event_id, kind, exc.code, exc.message) from None
        if event_schema.is_server_owned(kind):
            mode = event_schema.server_owned_mode()
            enforce_rejects = mode == "enforce" and (schema_version == 2 or kind != "answer_submitted")
            if enforce_rejects:
                raise _reject(db, class_id, student_id, client_event_id, kind, "server_owned_event",
                              f"{kind} events are written by the server; the client copy was not stored")
            client_reported = True
            payload["_clientReported"] = True
    if kind == "study_heartbeat" and question_id is None and valid_id(payload.get("questionId")):
        question_id = payload["questionId"]
    payload, truncated = truncate_payload(kind, payload)
    serialized = json.dumps(payload, ensure_ascii=False)
    if len(serialized) > MAX_PAYLOAD_CHARS:  # truncate_payload guarantees the limit; never store an oversized row
        raise _reject(db, class_id, student_id, client_event_id, kind, "payload_too_large",
                      f"payload is larger than {MAX_PAYLOAD_CHARS:,} characters")
    event_id = raw_event_id if isinstance(raw_event_id, str) else (uuid.uuid4().hex if server else None)
    received_dt = dbmod.utcnow()
    created_dt = _clamped_time(received_dt, event.get("clientTs")) if schema_version == 2 else received_dt
    received = received_dt.isoformat(timespec="milliseconds")
    created = created_dt.isoformat(timespec="milliseconds")
    surface = event.get("surface") if isinstance(event.get("surface"), str) else payload.get("surface")
    surface = surface[:40] if isinstance(surface, str) else ""
    draft = {"class_id": class_id, "source": "lab", "event_type": kind, "question_id": question_id, "payload": payload,
             "schema_version": schema_version, "surface": surface, "server": server,
             "client": not server or client_reported}
    with dbmod.write_tx(db):
        linked = identitymod.class_linked(db, class_id)
        name = _stored_name(identity, linked, event.get("studentName"))
        derived = derive(db, draft)
        if client_reported:
            derived["checked_by"] = "client" if isinstance(payload.get("correct"), bool) else ""
        section, condition = readers.group_stamp(db, class_id, student_id)
        aid = payload.get("assignmentId")
        version = readers.current_version(db, class_id, aid) if isinstance(aid, str) and aid else None
        bucket = int(created_dt.timestamp() * 1000) // HEARTBEAT_MS if kind == "study_heartbeat" else None
        counted = 0
        if bucket is not None and db.execute(
                "SELECT 1 FROM events WHERE class_id=? AND student_id=? AND heartbeat_bucket=? AND heartbeat_counted=1",
                (class_id, student_id, bucket)).fetchone() is None:
            counted = 1
        if (not identity.is_staff and not identity.preview and identitymod.is_roster_eligible(student_id)
                and db.execute("SELECT 1 FROM roster WHERE class_id=? AND student_id=?", (class_id, student_id)).fetchone() is None):
            caller = str(getattr(identity, "display_name", "") or "")
            identitymod.ensure_roster(db, class_id, student_id, source="activity",
                                      display_name="" if (linked or "@" in caller or caller == student_id) else caller,
                                      kiwi_email=caller if "@" in caller else "")
        values = [
            class_id, student_id, name, session_id, kind, question_id, serialized, created, "lab", event_id, schema_version,
            received, _int_or_none(event.get("clientTs")), _int_or_none(event.get("seq")), _int_or_none(event.get("tzOffsetMin")),
            surface, (actor_role if server and actor_role else identity.actor_role), int(bool(identity.preview)),
            int(bool(identity.verified)),
            derived["practice_mode"], derived["attribution_assignment_id"], derived["related_assignment_id"],
            derived["item_id"], derived["checked_by"], section, condition, version,
            _int_or_none(payload.get("policyVersionId")) if server else None,
            _int_or_none(payload.get("aiCallId")) if server else None,
            _int_or_none(payload.get("chatTurnId")) if server else None, bucket, counted,
            json.dumps(truncated, sort_keys=True) if truncated else "", derived["category"],
        ]
        sql = (f"INSERT INTO events ({', '.join(EVENT_COLUMNS)}) VALUES ({', '.join('?' for _ in EVENT_COLUMNS)}) "
               "ON CONFLICT(class_id, event_id) WHERE event_id IS NOT NULL DO NOTHING")
        try:
            cur = db.execute(sql, values)
        except sqlite3.IntegrityError as exc:
            # idx_events_heartbeat_counted is the safety net for concurrent heartbeats in one bucket (§11.4)
            if not counted or "heartbeat" not in str(exc):
                raise
            values[EVENT_COLUMNS.index("heartbeat_counted")] = 0
            cur = db.execute(sql, values)
        if cur.rowcount == 0:
            existing = db.execute("SELECT id, created_at FROM events WHERE class_id=? AND event_id=?", (class_id, event_id)).fetchone()
            count_ingest(db, class_id, "duplicate")  # CR-T5: a duplicate receipt is not a rejection
            return AddEventResult(existing["id"] if existing else None, event_id or "", "duplicate", "", "", {},
                                  existing["created_at"] if existing else None)
        row = db.execute("SELECT * FROM events WHERE id=?", (cur.lastrowid,)).fetchone()
        index_event(db, row)
    return AddEventResult(cur.lastrowid, event_id or "", "created", "", "", dict(truncated), created)


def ingest(db: sqlite3.Connection, identity: Any, event: object) -> AddEventResult:
    """``add_event`` for client batches: rejections come back as a ``rejected`` result instead of raising."""
    if not isinstance(event, dict):
        exc = _reject(db, identity.class_id, identity.student_id or "", "", "", "invalid_payload", "Each event must be an object")
        return exc.result
    try:
        return add_event(db, identity, event)
    except EventRejected as exc:
        return exc.result


# -- derived rebuilds (§4.4) ------------------------------------------------------------------------------
def _meta(db: sqlite3.Connection, version: str) -> bool:
    return db.execute("SELECT 1 FROM telemetry_meta WHERE version=?", (version,)).fetchone() is not None


EMPTY_SUFFIX = ":empty"


def rebuild_done(db: sqlite3.Connection, tag: str) -> bool:
    """A rebuild ran (``tag``) or was not needed because the database had no events yet (``tag:empty``)."""
    return _meta(db, tag) or _meta(db, tag + EMPTY_SUFFIX)


def _mark(db: sqlite3.Connection, version: str) -> None:
    with dbmod.write_tx(db):
        db.execute("INSERT OR IGNORE INTO telemetry_meta (version) VALUES (?)", (version,))


def _has_events(db: sqlite3.Connection) -> bool:
    return db.execute("SELECT 1 FROM events LIMIT 1").fetchone() is not None


def _backup_taken_this_startup(db: sqlite3.Connection) -> bool:
    """True when this process already backed up this database (e.g. the pre-migration backup of this start-up).

    WHY: one backup before the first change of a start-up keeps the pre-v0.6 state; a second copy taken after the
    migrations would only duplicate it (FOUNDATION-10 asserts one backup per migrated snapshot).
    """
    from server import migrations

    for path in migrations.list_backups(db):
        try:
            if path.stat().st_mtime >= _STARTED_AT - 1:
                return True
        except OSError:
            continue
    return False


def _derived_update(db: sqlite3.Connection, row: sqlite3.Row) -> None:
    payload = _loads(row["payload_json"])
    d = derive(db, {**dict(row), "payload": payload})
    bucket, counted = None, 0
    if row["event_type"] == "study_heartbeat":
        created = _ms(row["created_at"])
        bucket = created // HEARTBEAT_MS if created is not None else None
        if bucket is not None and db.execute(
                "SELECT 1 FROM events WHERE class_id=? AND student_id=? AND heartbeat_bucket=? AND heartbeat_counted=1",
                (row["class_id"], row["student_id"], bucket)).fetchone() is None:
            counted = 1
    checked_by = d["checked_by"]
    if payload.get("_clientReported"):
        checked_by = "client" if isinstance(payload.get("correct"), bool) else ""
    db.execute(
        """UPDATE events SET practice_mode=?, attribution_assignment_id=?, related_assignment_id=?, item_id=?, checked_by=?,
        category=?, heartbeat_bucket=?, heartbeat_counted=? WHERE id=?""",
        (d["practice_mode"], d["attribution_assignment_id"], d["related_assignment_id"], d["item_id"], checked_by,
         d["category"], bucket, counted, row["id"]))


def rebuild_sessions_v3(db: sqlite3.Connection) -> None:
    """``sessions-v3`` (§4.4): map old ids → re-derive → re-index with the v3 key → aliases → meta, then clear the map.

    Restartable: an interruption before the meta row restarts from step 2 with the preserved map.
    """
    if db.execute("SELECT 1 FROM learning_session_v2_map LIMIT 1").fetchone() is None:
        with dbmod.write_tx(db):  # (1) one transaction, before anything is deleted
            db.execute("""INSERT OR IGNORE INTO learning_session_v2_map (event_id, old_session_id)
                SELECT id, learning_session_id FROM events WHERE learning_session_id IS NOT NULL AND learning_session_id != ''""")
    with dbmod.write_tx(db):
        db.execute("UPDATE events SET heartbeat_counted=0 WHERE heartbeat_counted != 0")
    after: tuple[str, int] = ("", 0)
    while True:  # (2) derived columns, payloads untouched
        with dbmod.write_tx(db):
            rows = db.execute("SELECT * FROM events WHERE (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?",
                              (*after, BATCH)).fetchall()
            for row in rows:
                _derived_update(db, row)
        if not rows:
            break
        after = (rows[-1]["created_at"], rows[-1]["id"])
    with dbmod.write_tx(db):  # (3) re-index with the v3 context key
        db.execute("DELETE FROM learning_sessions")
        db.execute("UPDATE events SET learning_session_id=NULL")
    while True:
        with dbmod.write_tx(db):
            rows = db.execute("SELECT * FROM events WHERE learning_session_id IS NULL ORDER BY created_at, id LIMIT ?",
                              (BATCH,)).fetchall()
            for row in rows:
                index_event(db, row)
        if not rows:
            break
    with dbmod.write_tx(db):  # (4) aliases: the new activity holding most of each old session's events
        stamp = dbmod.now()
        best: dict[str, tuple[str, str]] = {}
        for item in db.execute(
                """SELECT m.old_session_id old, e.learning_session_id new, e.class_id cls, COUNT(*) n
                FROM learning_session_v2_map m JOIN events e ON e.id = m.event_id
                WHERE e.learning_session_id IS NOT NULL AND e.learning_session_id != ''
                GROUP BY m.old_session_id, e.learning_session_id ORDER BY m.old_session_id, n DESC, MIN(e.id)"""):
            best.setdefault(item["old"], (item["new"], item["cls"]))
        for old_id, (new_id, class_id) in best.items():
            db.execute("""INSERT INTO learning_session_aliases (old_id, new_id, class_id, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(old_id) DO UPDATE SET new_id=excluded.new_id, class_id=excluded.class_id""",
                       (old_id, new_id, class_id, stamp))
    with dbmod.write_tx(db):  # (5) meta first, then the map is emptied (same transaction)
        db.execute("INSERT OR IGNORE INTO telemetry_meta (version) VALUES ('sessions-v3')")
        db.execute("DELETE FROM learning_session_v2_map")


def rejudge_legacy(db: sqlite3.Connection, tag: str | None = None) -> None:
    """``legacy-rejudge:<JUDGING_VERSION>`` (§4.4): re-judge v0.5.1 in-class checks whose question set is unchanged."""
    from server import judging

    tag = tag or f"legacy-rejudge:{judging.JUDGING_VERSION}"
    with dbmod.write_tx(db):
        db.execute("UPDATE events SET rejudged_correct=NULL WHERE checked_by='legacy_server'")
    rows = db.execute("SELECT id, class_id, question_id, payload_json, created_at FROM events WHERE checked_by='legacy_server' "
                      "ORDER BY id").fetchall()
    cache: dict[tuple[str, str], Any] = {}
    updates: list[tuple[int | None, int]] = []
    for row in rows:
        payload = _loads(row["payload_json"])
        aid = payload.get("assignmentId") if isinstance(payload.get("assignmentId"), str) else ""
        if not aid:
            continue
        key = (row["class_id"], aid)
        if key not in cache:
            cache[key] = readers.load_assignment(db, row["class_id"], aid, include_deleted=True)
        rec = cache[key]
        if rec is None:
            continue
        edited, attempted = _parse(rec.updated_at), _parse(row["created_at"])
        if edited is None or attempted is None or edited > attempted:
            continue  # the question set at attempt time may differ from the current one
        question = readers.assignment_question(rec, row["question_id"] or "")
        if question is None:
            continue
        run_output = payload.get("runOutput") if isinstance(payload.get("runOutput"), str) else None
        result = judging.check(question, str(payload.get("answer") or ""), run_output or None)
        updates.append((None if result.correct is None else int(bool(result.correct)), row["id"]))
    with dbmod.write_tx(db):
        db.executemany("UPDATE events SET rejudged_correct=? WHERE id=?", updates)
        db.execute("INSERT OR IGNORE INTO telemetry_meta (version) VALUES (?)", (tag,))


def own_rebuilds() -> list[tuple[str, Callable[[sqlite3.Connection], None]]]:
    from server import judging

    tag = f"legacy-rejudge:{judging.JUDGING_VERSION}"
    return [("sessions-v3", rebuild_sessions_v3), (tag, lambda db: rejudge_legacy(db, tag))]


def init(db: sqlite3.Connection) -> None:
    """Derived-index maintenance: v0.5.1 upkeep, registered rebuilds, ``sessions-v3`` and ``legacy-rejudge`` (backup
    first), then index any unindexed event."""
    from server import migrations

    db.create_function("normalize_question", 1, lambda text: " ".join(str(text or "").casefold().split()))
    with dbmod.write_tx(db):
        if not _meta(db, "sessions-v2"):
            db.execute("DELETE FROM learning_sessions")
            db.execute("UPDATE events SET learning_session_id=NULL")
            db.execute("INSERT INTO telemetry_meta (version) VALUES ('sessions-v2')")
        if not _meta(db, "known-code-results-v1"):
            db.execute("""UPDATE learning_sessions SET codeSuccesses=(SELECT COUNT(*) FROM events e
                WHERE e.learning_session_id=learning_sessions.id AND e.event_type='code_run'
                AND json_extract(e.payload_json,'$.ok')=1)""")
            db.execute("INSERT INTO telemetry_meta (version) VALUES ('known-code-results-v1')")
    for tag, rebuild in DERIVED_REBUILDS:
        if not _meta(db, tag):
            if db.in_transaction:
                db.commit()
            migrations.backup_once(db, tag)
            rebuild(db)
    for tag, rebuild in own_rebuilds():
        if rebuild_done(db, tag):
            continue
        if db.in_transaction:
            db.commit()
        if not _has_events(db):
            # Nothing to rebuild (and no backup) on an empty database; events written from now on use the v3 index.
            # WHY a separate marker: the plain tag stays free for registered rebuilds (FOUNDATION-15).
            _mark(db, tag + EMPTY_SUFFIX)
            continue
        if not _backup_taken_this_startup(db):
            migrations.backup_once(db, tag)
        rebuild(db)
    # Original payloads and timestamps remain intact. Run once for each unindexed event.
    while True:
        with dbmod.write_tx(db):
            rows = db.execute("SELECT * FROM events WHERE learning_session_id IS NULL ORDER BY created_at,id LIMIT 1000").fetchall()
            for row in rows:
                index_event(db, row)
        if not rows:
            break


# -- reads ------------------------------------------------------------------------------------------------
def _event_record(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "classId": row["class_id"], "studentId": row["student_id"], "studentName": row["student_name"],
            "sessionId": row["session_id"], "type": row["event_type"], "questionId": row["question_id"],
            "payload": json.loads(row["payload_json"]), "createdAt": row["created_at"]}


def event_record_v2(row: sqlite3.Row) -> dict:
    """``EventRecord`` (§7.3) with the v0.6 provenance fields."""
    truncated = _loads(row["truncated_json"]) if row["truncated_json"] else {}
    return {**_event_record(row), "receivedAt": row["received_at"], "source": row["source"] or "lab",
            "upstreamId": row["upstream_id"], "learningSessionId": row["learning_session_id"] or None,
            "practiceMode": row["practice_mode"], "checkedBy": row["checked_by"], "actorRole": row["actor_role"],
            "isPreview": bool(row["is_preview"]), **({"truncated": truncated} if truncated else {})}


def _event_filters(class_id: str, student_id: str | None, event_type: str | None, frm: str | None,
                   to: str | None) -> tuple[str, list[object]]:
    where = ["class_id = ?"]
    params: list[object] = [class_id]
    if student_id:
        where.append("student_id = ?")
        params.append(student_id)
    if event_type:
        where.append("event_type = ?")
        params.append(event_type)
    if frm:
        where.append("created_at >= ?")
        params.append(frm)
    if to:
        where.append("created_at < ?")
        params.append(to)
    return " AND ".join(where), params


def events_for(class_id: str, student_id: str | None = None, limit: int = 100, before_id: int | None = None, *,
               db: sqlite3.Connection | None = None, event_type: str | None = None, frm: str | None = None,
               to: str | None = None) -> list[dict]:
    """v0.5.1 ``EventRecord[]`` (newest first), with optional type/time filters."""
    if db is None:
        with dbmod.connection() as owned:
            return events_for(class_id, student_id, limit, before_id, db=owned, event_type=event_type, frm=frm, to=to)
    where, params = _event_filters(class_id, student_id, event_type, frm, to)
    if before_id is not None:
        where += " AND id < ?"
        params.append(before_id)
    params.append(min(max(limit, 1), 500))
    return [_event_record(row) for row in db.execute(f"SELECT * FROM events WHERE {where} ORDER BY id DESC LIMIT ?", params)]


def events_page(db: sqlite3.Connection, class_id: str, *, student_id: str | None, event_type: str | None, frm: str | None,
                to: str | None, after: int | None, limit: int) -> dict:
    """Paged ``{events, nextCursor, hasMore}`` (newest first; the cursor is the last id of the page)."""
    where, params = _event_filters(class_id, student_id, event_type, frm, to)
    if after is not None:
        where += " AND id < ?"
        params.append(after)
    rows = db.execute(f"SELECT * FROM events WHERE {where} ORDER BY id DESC LIMIT ?", (*params, limit + 1)).fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"events": [event_record_v2(r) for r in rows], "nextCursor": str(rows[-1]["id"]) if more and rows else None,
            "hasMore": more}


def summary_for(class_id: str, *, db: sqlite3.Connection | None = None) -> dict:
    """v0.5.1 ``/api/teacher/summary`` shape."""
    if db is None:
        with dbmod.connection() as owned:
            return summary_for(class_id, db=owned)
    rows = db.execute(
        """SELECT student_id, MAX(student_name) name, COUNT(*) events,
        SUM(CASE WHEN event_type='code_run' THEN 1 ELSE 0 END) runs,
        SUM(CASE WHEN event_type='answer_submitted' THEN 1 ELSE 0 END) answers,
        MAX(created_at) last_active FROM events WHERE class_id=? GROUP BY student_id ORDER BY last_active DESC""",
        (class_id,)).fetchall()
    return {"students": [dict(row) for row in rows], "totalEvents": sum(row["events"] for row in rows)}


# -- Data health (§13.10, TELEMETRY-16/20) ------------------------------------------------------------------
TURNED_AWAY = ("rate_limited", "busy", "unavailable", "daily_quota")
FAILED = ("provider_error", "incomplete", "invalid_output", "interrupted")
OK_STATUSES = ("ok", "local", "leak_retried_clean", "leak_redacted")
GAP_MERGE = timedelta(minutes=10)


def _range_sql(column: str, frm: str | None, to: str | None) -> tuple[str, list[str]]:
    parts, params = [], []
    if frm:
        parts.append(f"{column} >= ?")
        params.append(frm)
    if to:
        parts.append(f"{column} < ?")
        params.append(to)
    return (" AND " + " AND ".join(parts)) if parts else "", params


def _iso_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).replace(microsecond=0).isoformat(timespec="seconds")


def outage_periods(db: sqlite3.Connection, class_id: str, frm: str | None, to: str | None) -> list[dict]:
    """Client gaps (overlapping or < 10 min apart) and consecutive incident minutes, merged into periods."""
    low = _ms(frm) if frm else None
    high = _ms(to) if to else None
    gaps: list[tuple[int, int, int, str]] = []
    for row in db.execute("SELECT session_id, student_id, payload_json, created_at FROM events WHERE class_id=? "
                          "AND event_type='telemetry_gap'", (class_id,)):
        p = _loads(row["payload_json"])
        start = _int_or_none(p.get("fromTs")) or _ms(row["created_at"]) or 0
        end = _int_or_none(p.get("toTs")) or start
        start, end = min(start, end), max(start, end)
        if (high is not None and start >= high) or (low is not None and end < low):
            continue
        gaps.append((start, end, int(_int_or_none(p.get("droppedCount")) or 0), f"{row['student_id']}:{row['session_id']}"))
    periods: list[dict] = []
    current: dict | None = None
    for start, end, count, browser in sorted(gaps):
        if current is not None and start - current["_end"] < GAP_MERGE.total_seconds() * 1000:
            current["_end"] = max(current["_end"], end)
            current["count"] += count
            current["_browsers"].add(browser)
            continue
        current = {"_start": start, "_end": end, "kind": "client_gap", "count": count, "_browsers": {browser}}
        periods.append(current)
    out = [{"from": _iso_ms(p["_start"]), "to": _iso_ms(p["_end"]), "kind": "client_gap", "count": p["count"],
            "browsers": len(p["_browsers"])} for p in periods]
    minute_low = frm[:16] if frm else None
    minute_high = to[:16] if to else None
    for kind in ("server_error", "kiwi_unreachable"):
        sql = "SELECT minute, count FROM service_incidents WHERE class_id=? AND kind=?"
        params: list[object] = [class_id, kind]
        if minute_low:
            sql += " AND minute >= ?"
            params.append(minute_low)
        if minute_high:
            sql += " AND minute <= ?"
            params.append(minute_high)
        block: dict | None = None
        for row in db.execute(sql + " ORDER BY minute", params):
            at = datetime.fromisoformat(row["minute"] + ":00+00:00")
            if block is not None and at - block["_last"] <= timedelta(minutes=1):
                block["_last"] = at
                block["count"] += row["count"]
                continue
            block = {"_first": at, "_last": at, "count": row["count"], "kind": kind}
            out.append(block)
    result = []
    for p in out:
        if "_first" in p:
            result.append({"from": p["_first"].isoformat(timespec="seconds"),
                           "to": (p["_last"] + timedelta(minutes=1)).isoformat(timespec="seconds"),
                           "kind": p["kind"], "count": p["count"]})
        else:
            result.append(p)
    return sorted(result, key=lambda p: (p["from"], p["kind"]))


def _time_range(db: sqlite3.Connection, class_id: str, frm: str | None, to: str | None) -> dict:
    from server import course_config

    schedule = readers.settings(db, class_id).get("schedule") or {}
    now = dbmod.utcnow()
    if frm and to:
        return course_config.time_range("custom", schedule, now=now, custom_from=frm, custom_to=to).as_dict()
    first = db.execute("SELECT MIN(created_at) FROM events WHERE class_id=?", (class_id,)).fetchone()[0]
    return course_config.time_range("whole_term", schedule, now=now, first_event_at=first).as_dict()


def data_health(db: sqlite3.Connection, class_id: str, frm: str | None, to: str | None) -> dict:
    """``DataHealth`` (§7.3) for one course and range (``from`` inclusive, ``to`` exclusive)."""
    from server import kiwi_bridge

    rng, rp = _range_sql("COALESCE(e.received_at, e.created_at)", frm, to)
    base = f"FROM events e WHERE e.class_id=? AND COALESCE(e.source,'lab')='lab'{rng}"
    bp = [class_id, *rp]

    def one(sql: str, params: Iterable[object] = ()) -> int:
        value = db.execute(sql, tuple(params)).fetchone()[0]
        return int(value or 0)

    received = one(f"SELECT COUNT(*) {base}", bp)
    rej_rng, rej_p = _range_sql("received_at", frm, to)
    dup_rng, dup_p = _range_sql("minute", frm[:16] if frm else frm, to[:16] if to else to)
    rejected = [{"code": r["code"], "count": r["n"]} for r in db.execute(
        f"SELECT code, COUNT(*) n FROM event_rejections WHERE class_id=? AND code != 'duplicate'{rej_rng} GROUP BY code "
        "ORDER BY n DESC, code", (class_id, *rej_p))]
    events = {
        "received": received,
        # CR-T5: event_ingest_stats per minute; event_rejections(code='duplicate') rows come from pre-CR-T5 builds.
        "duplicatesIgnored": one(f"SELECT COALESCE(SUM(count), 0) FROM event_ingest_stats WHERE class_id=? AND kind='duplicate'"
                                 f"{dup_rng}", (class_id, *dup_p))
                             + one(f"SELECT COUNT(*) FROM event_rejections WHERE class_id=? AND code='duplicate'{rej_rng}",
                                   (class_id, *rej_p)),
        "truncated": one(f"SELECT COUNT(*) {base} AND e.truncated_json != ''", bp),
        "clientGapsReported": one(f"SELECT COALESCE(SUM(json_extract(e.payload_json, '$.droppedCount')), 0) {base} "
                                  "AND e.event_type='telemetry_gap' AND json_valid(e.payload_json)", bp),
        "clockSkewOver5Min": one(
            f"SELECT COUNT(*) {base} AND e.schema_version=2 AND e.client_ts_ms IS NOT NULL AND e.received_at IS NOT NULL "
            "AND ABS(e.client_ts_ms - CAST((julianday(e.received_at) - 2440587.5) * 86400000 AS INTEGER)) > 300000", bp),
        "rejected": rejected,
    }
    trng, tp = _range_sql("t.created_at", frm, to)
    turns = one(f"SELECT COUNT(*) FROM chat_turns t WHERE t.class_id=?{trng}", (class_id, *tp))
    with_event = one(f"SELECT COUNT(*) FROM chat_turns t WHERE t.class_id=?{trng} AND EXISTS (SELECT 1 FROM events x "
                     "WHERE x.class_id=t.class_id AND x.chat_turn_id=t.id)", (class_id, *tp))
    # mismatch: v0.6 turns (not the 'legacy' surface) that have no analytics event; pre-0.6 turns were reported by the
    # browser instead and are counted in legacyClientOnly.
    missing = one(f"SELECT COUNT(*) FROM chat_turns t WHERE t.class_id=?{trng} AND COALESCE(t.surface,'legacy') != 'legacy' "
                  "AND NOT EXISTS (SELECT 1 FROM events x WHERE x.class_id=t.class_id AND x.chat_turn_id=t.id)", (class_id, *tp))
    ai_turns = {"serverTurns": turns, "withServerEvent": with_event,
                "legacyClientOnly": one(f"SELECT COUNT(*) {base} AND e.event_type='ai_question' AND e.chat_turn_id IS NULL", bp),
                "mismatch": missing}
    crng, cp = _range_sql("c.requested_at", frm, to)
    # RV6-m06: "Test this rule" runs (surface teacher_test) are staff tests, not student AI requests; counted apart.
    by_status = {r["status"]: r["n"] for r in db.execute(
        f"SELECT status, COUNT(*) n FROM ai_calls c WHERE c.class_id=? AND COALESCE(c.surface, '') != 'teacher_test'{crng} "
        "GROUP BY status", (class_id, *cp))}
    teacher_tests = one(f"SELECT COUNT(*) FROM ai_calls c WHERE c.class_id=? AND c.surface = 'teacher_test'{crng}",
                        (class_id, *cp))
    ai_calls = {"total": sum(by_status.values()), "ok": sum(by_status.get(s, 0) for s in OK_STATUSES),
                "turnedAway": sum(by_status.get(s, 0) for s in TURNED_AWAY),
                # review 2 (TEACHER-13): refusals by course rules (chapter closed, Ask Kiwi off, homework match…)
                "blocked": sum(n for s, n in by_status.items() if s.startswith("blocked_")),
                "failed": sum(by_status.get(s, 0) for s in FAILED), "byStatus": by_status, "teacherTests": teacher_tests,
                # SB-m13: answered by the chapter's local guidance (no AI key), part of "ok"
                "local": by_status.get("local", 0)}
    ai_calls["other"] = ai_calls["total"] - ai_calls["ok"] - ai_calls["turnedAway"] - ai_calls["blocked"] - ai_calls["failed"]
    hb_received = one(f"SELECT COUNT(*) {base} AND e.event_type='study_heartbeat'", bp)
    hb_counted = one(f"SELECT COUNT(*) {base} AND e.event_type='study_heartbeat' AND e.heartbeat_counted=1", bp)
    staff = ", ".join(f"'{r}'" for r in ("instructor", "ta", "viewer", "staff"))
    ident = {
        "unverifiedEvents": one(f"SELECT COUNT(*) {base} AND e.identity_verified=0", bp),
        "nonRosterIdentities": one(f"SELECT COUNT(DISTINCT e.student_id) {base} AND e.student_id NOT LIKE 'preview-%' AND NOT EXISTS "
                                   "(SELECT 1 FROM roster r WHERE r.class_id=e.class_id AND r.student_id=e.student_id)", bp),
        "previewEvents": one(f"SELECT COUNT(*) {base} AND (e.is_preview=1 OR e.student_id LIKE 'preview-%')", bp),
        "staffEvents": one(f"SELECT COUNT(*) {base} AND e.actor_role IN ({staff})", bp),
    }
    irng, ip = _range_sql("g.created_at", frm, to)
    items = db.execute(
        f"""SELECT COUNT(*) total, SUM(verification='verified') verified, SUM(verification='mismatch') mismatch,
        SUM(status LIKE 'rejected_%') rejected, SUM(status='flagged') flagged,
        SUM(COALESCE(source, '') LIKE 'local%') local FROM generated_items g WHERE g.class_id=?{irng}""",
        (class_id, *ip)).fetchone()
    # SB-m13: ``local`` = local template items (no AI key), part of ``total``
    generated = {k: int(items[k] or 0) for k in ("total", "verified", "mismatch", "rejected", "flagged", "local")}
    unknown: dict[str, dict] = {}
    for row in db.execute(f"SELECT e.id, e.event_type, e.payload_json {base} AND e.schema_version=2 AND json_valid(e.payload_json)", bp):
        keys = unknown_keys(row["event_type"], _loads(row["payload_json"]))
        if keys:
            entry = unknown.setdefault(row["event_type"], {"type": row["event_type"], "keys": set(), "count": 0})
            entry["keys"].update(keys)
            entry["count"] += 1
    client = {
        "aiRequestsUnreached": one(f"SELECT COUNT(*) {base} AND e.event_type='ai_request_unreached'", bp),
        "serverOwnedFromClient": one(f"SELECT COUNT(*) {base} AND json_valid(e.payload_json) "
                                     "AND json_extract(e.payload_json, '$._clientReported') = 1", bp),
        "unknownPayloadKeys": [{"type": v["type"], "keys": sorted(v["keys"]), "count": v["count"]}
                               for v in sorted(unknown.values(), key=lambda v: (-v["count"], v["type"]))],
    }
    legacy = one("SELECT COUNT(*) FROM events WHERE class_id=? AND checked_by='legacy_server'", (class_id,))
    rejudged = one("SELECT COUNT(*) FROM events WHERE class_id=? AND checked_by='legacy_server' AND rejudged_correct IS NOT NULL",
                   (class_id,))
    kiwi = {**kiwi_bridge.status(db, class_id), "perStudent": kiwi_bridge.per_student(db, class_id)}
    return {
        "range": _time_range(db, class_id, frm, to), "aiTurns": ai_turns, "aiCalls": ai_calls, "events": events,
        "heartbeats": {"received": hb_received, "counted": hb_counted, "duplicates": max(0, hb_received - hb_counted)},
        "identity": ident, "generatedItems": generated, "clientReported": client,
        "legacyChecks": {"legacyServer": legacy, "rejudged": rejudged, "notRejudged": max(0, legacy - rejudged)},
        "outages": outage_periods(db, class_id, frm, to), "kiwi": kiwi, "retentionDue": retention_due(db, class_id),
    }


def retention_due(db: sqlite3.Connection, class_id: str) -> dict[str, int]:
    """Rows older than ``privacy.retentionDays`` (none when no retention period is set)."""
    days = (readers.settings(db, class_id).get("privacy") or {}).get("retentionDays")
    if not isinstance(days, int) or days <= 0:
        return {}
    cutoff = dbmod.iso_seconds(dbmod.utcnow() - timedelta(days=days))
    return {
        "events": int(db.execute("SELECT COUNT(*) FROM events WHERE class_id=? AND created_at < ?", (class_id, cutoff)).fetchone()[0]),
        "chatTurns": int(db.execute("SELECT COUNT(*) FROM chat_turns WHERE class_id=? AND created_at < ?",
                                    (class_id, cutoff)).fetchone()[0]),
        "submissions": int(db.execute("SELECT COUNT(*) FROM submissions WHERE class_id=? AND submitted_at < ?",
                                      (class_id, cutoff)).fetchone()[0]),
    }
