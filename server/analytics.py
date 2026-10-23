"""Insights queries: explorer v2, answers by question, question activity, timelines, metrics, trends, Home
(owned by INSIGHTS; spec §9.6, §13.1, §13.4, §13.7, §13.9).

Every v0.6 query reads the ``events`` table with its derived columns (``practice_mode``, ``checked_by``, ``category``,
``attribution_assignment_id`` …, §11.5) and restricts rows with ``identity.population_sql`` at query time (P10).
"Server-checked" means ``checked_by='server'`` plus legacy checks with a non-NULL ``rejudged_correct`` (§13.9).

Session indexing moved to ``server/telemetry.py`` (TELEMETRY); ``init``, ``event_counters``, ``index_event`` and
``COUNTERS`` stay importable here as delegators. The v0.5.1 query functions (``metrics``, ``table``, ``evidence``,
``session_events``) are kept at the end of this module for the legacy endpoints (§6.9).
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from server import course_config, identity, readers, telemetry
from server import db as dbmod
from server.contracts import AssignmentRecord

COUNTERS = telemetry.COUNTERS
event_counters = telemetry.event_counters
index_event = telemetry.index_event


def init(db):
    """Delegates to ``telemetry.init`` (derived-index maintenance)."""
    telemetry.init(db)


# ─── shared scope & population ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Scope:
    """Who and when a query covers: class, population options, time window (``to`` exclusive), one group."""

    class_id: str
    linked: bool
    from_: str | None = None
    to: str | None = None
    group_id: str | None = None
    include_staff: bool = False


def make_scope(db: sqlite3.Connection, class_id: str, *, from_: str | None = None, to: str | None = None,
               group_id: str | None = None, include_staff: bool = False) -> Scope:
    return Scope(class_id, identity.class_linked(db, class_id), from_ or None, to or None, group_id or None, include_staff)


def unranged(scope: Scope) -> Scope:
    return replace(scope, from_=None, to=None)


def ranged(scope: Scope, from_: str | None, to: str | None) -> Scope:
    return replace(scope, from_=from_ or None, to=to or None)


def _group_clause(alias: str, student_col: str, class_col: str = "class_id") -> str:
    return (f"EXISTS (SELECT 1 FROM group_members gm WHERE gm.class_id = {alias}.{class_col} AND gm.group_id = ? "
            f"AND gm.student_id = {alias}.{student_col})")


def pop_sql(scope: Scope, alias: str = "e", *, cols: dict[str, str] = identity.EVENT_COLS,
            time_col: str | None = "created_at") -> tuple[str, list]:
    """Class + population (+ group, + time window) condition for a table with event-style columns."""
    parts = [f"{alias}.{cols['class_id']} = ?"]
    params: list[object] = [scope.class_id]
    population, extra = identity.population_sql(alias, class_linked=scope.linked, cols=cols,
                                                include_staff=scope.include_staff)
    parts.append(population)
    params.extend(extra)
    if scope.group_id:
        parts.append(_group_clause(alias, cols["student_id"], cols["class_id"]))
        params.append(scope.group_id)
    if time_col:
        if scope.from_:
            parts.append(f"{alias}.{time_col} >= ?")
            params.append(scope.from_)
        if scope.to:
            parts.append(f"{alias}.{time_col} < ?")
            params.append(scope.to)
    return " AND ".join(parts), params


def enrolled_ids(db: sqlite3.Connection, scope: Scope) -> list[str]:
    """Active, non-excluded roster students (linked: Kiwi students who are not course staff), optionally one group."""
    sql = "SELECT r.student_id FROM roster r WHERE r.class_id = ? AND r.status = 'active' AND r.excluded = 0"
    params: list[object] = [scope.class_id]
    if scope.linked:
        sql += (" AND r.source = 'kiwi' AND NOT EXISTS (SELECT 1 FROM kiwi_staff_seen k WHERE k.class_id = r.class_id"
                " AND k.kiwi_user_id = r.student_id)")
    if identity.consent_only():
        sql += " AND " + identity.consent_clause("r.class_id", "r.student_id")
    if scope.group_id:
        sql += " AND " + _group_clause("r", "student_id")
        params.append(scope.group_id)
    sql += " ORDER BY r.pseudonym_seq, r.student_id"
    return [row[0] for row in db.execute(sql, params)]


# ─── Last seen and last learning action (B-m01, §13.9) ─────────────────────────────────────────
#
# Two named stamps instead of one "activity": *last seen* is the newest event of any kind the student wrote (page views,
# heartbeats and lecture views included); *last learning action* is the newest answer, code run, AI question or
# submission. The roster, the student profile and the "No learning actions" attention rule read both from here.
LEARNING_ACTION_TYPES = (
    "answer_submitted", "answer_draft", "work_answer_saved", "kiwi_check_answer",   # answers (Lab and Kiwi scratchpad)
    "code_run", "code_shared",                                                       # code runs (Lab and Kiwi scratchpad)
    "ai_question", "hint_requested",                                                 # AI questions (+ legacy hints)
    "work_submitted",                                                                # submissions
)


@dataclass(frozen=True)
class ActivityStamps:
    last_seen: str | None
    last_learning_action: str | None
    first_seen: str | None


def activity_stamps(db: sqlite3.Connection, class_id: str, student_ids: Iterable[str] | None = None) -> dict[str, ActivityStamps]:
    """``ActivityStamps`` per student from their own non-preview events (staff actors never count); a student without
    events gets ``ActivityStamps(None, None, None)``."""
    marks = ", ".join("?" for _ in LEARNING_ACTION_TYPES)
    found = {row[0]: ActivityStamps(row[1], row[2], row[3]) for row in db.execute(
        f"""SELECT student_id, MAX(created_at), MAX(CASE WHEN event_type IN ({marks}) THEN created_at END), MIN(created_at)
        FROM events WHERE class_id = ? AND is_preview = 0 AND student_id NOT LIKE 'preview-%'
        AND {identity.STUDENT_ACTOR_SQL} GROUP BY student_id""", (*LEARNING_ACTION_TYPES, class_id))}
    if student_ids is None:
        return found
    return {sid: found.get(sid, ActivityStamps(None, None, None)) for sid in student_ids}


def metric(value: float | None, previous: float | None, denominator: dict | None = None) -> dict:
    """``Metric`` (§7.7): ``deltaPct = round((value − previous) / previous × 100)`` when previous > 0."""
    delta = None
    if value is not None and previous is not None and previous > 0:
        delta = round((value - previous) / previous * 100)
    out: dict[str, object] = {"value": value, "previous": previous, "deltaPct": delta}
    if denominator is not None:
        out["denominator"] = denominator
    return out


def _pct(numerator: float | None, denominator: float | None, digits: int = 1) -> float | None:
    if not denominator:
        return None
    return round(100.0 * float(numerator or 0) / float(denominator), digits)


def _loads(value: object, default: Any) -> Any:
    if not isinstance(value, str) or not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


# ─── event expressions (alias ``e`` with the EV_JOINS below) ───────────────────────────────────

EV_JOINS = """LEFT JOIN assignments a ON a.class_id = e.class_id
        AND a.id = COALESCE(NULLIF(e.attribution_assignment_id, ''), NULLIF(e.related_assignment_id, ''))
    LEFT JOIN generated_items gi ON gi.class_id = e.class_id AND gi.id = e.item_id AND e.item_id != ''
    LEFT JOIN learning_sessions ls ON ls.id = e.learning_session_id"""
UNIT_EXPR = ("COALESCE(NULLIF(a.unit_id, ''), NULLIF(gi.unit_id, ''), NULLIF(ls.unitId, ''), "
             "NULLIF(CAST(json_extract(e.payload_json, '$.unitId') AS TEXT), ''), '')")
JCORRECT = "json_extract(e.payload_json, '$.correct')"
JOK = "json_extract(e.payload_json, '$.ok')"
CHECKED = (f"(e.event_type = 'answer_submitted' AND ((e.checked_by = 'server' AND {JCORRECT} IN (0, 1)) "
           "OR (e.checked_by = 'legacy_server' AND e.rejudged_correct IS NOT NULL)))")
CORRECT = f"(CASE WHEN e.checked_by = 'server' THEN {JCORRECT} ELSE e.rejudged_correct END)"
TEACHER = "e.practice_mode IN ('homework', 'in-class')"
# P2: client copies of server-owned events (TELEMETRY marks them ``_clientReported``) are kept but not counted as attempts.
NOT_CLIENT_COPY = "COALESCE(json_extract(e.payload_json, '$._clientReported'), 0) = 0"
ATTEMPT = f"(e.event_type = 'answer_submitted' AND {NOT_CLIENT_COPY})"
AI_QUESTION = f"(e.event_type IN ('ai_question', 'hint_requested') AND COALESCE({JOK}, 1) != 0 AND {NOT_CLIENT_COPY})"
TELEMETRY_TYPES = ("study_heartbeat", "page_view", "visibility", "idle", "telemetry_gap")

AGGREGATES = {
    "interactions": "COUNT(*)",
    "actions": "SUM(e.category = 'action')",
    "attempts": f"SUM({ATTEMPT})",
    "checked": f"SUM(CASE WHEN {CHECKED} AND {TEACHER} THEN 1 ELSE 0 END)",
    "correct": f"SUM(CASE WHEN {CHECKED} AND {TEACHER} THEN {CORRECT} ELSE 0 END)",
    "simChecked": f"SUM(CASE WHEN {CHECKED} AND e.practice_mode = 'similar' THEN 1 ELSE 0 END)",
    "simCorrect": f"SUM(CASE WHEN {CHECKED} AND e.practice_mode = 'similar' THEN {CORRECT} ELSE 0 END)",
    "aiChecked": f"SUM(CASE WHEN {CHECKED} AND e.practice_mode IN ('free', 'similar') THEN 1 ELSE 0 END)",
    "aiCorrect": f"SUM(CASE WHEN {CHECKED} AND e.practice_mode IN ('free', 'similar') THEN {CORRECT} ELSE 0 END)",
    "clientChecked": f"SUM(e.event_type = 'answer_submitted' AND e.checked_by = 'client' AND {JCORRECT} IN (0, 1))",
    "clientCorrect": f"SUM(e.event_type = 'answer_submitted' AND e.checked_by = 'client' AND {JCORRECT} = 1)",
    "legacyChecked": f"SUM(e.event_type = 'answer_submitted' AND e.checked_by = 'legacy_server' AND {JCORRECT} IN (0, 1))",
    "legacyCorrect": f"SUM(e.event_type = 'answer_submitted' AND e.checked_by = 'legacy_server' AND {JCORRECT} = 1)",
    "codeRuns": "SUM(e.event_type = 'code_run')",
    "codeErrors": f"SUM(e.event_type = 'code_run' AND {JOK} = 0)",
    "codeSuccesses": f"SUM(e.event_type = 'code_run' AND {JOK} = 1)",
    "aiQuestions": f"SUM({AI_QUESTION})",
    "kiwiAiQuestions": f"SUM({AI_QUESTION} AND e.source = 'kiwi')",
    "views": "SUM(e.event_type = 'material_viewed')",
    "students": "COUNT(DISTINCT e.student_id)",
    "lastActive": "MAX(e.created_at)",
    "firstAt": "MIN(e.created_at)",
}
_AGG_SELECT = ", ".join(f"COALESCE({sql}, 0) AS {name}" if name not in ("lastActive", "firstAt") else f"{sql} AS {name}"
                        for name, sql in AGGREGATES.items())


# ─── course & assignment lookups ───────────────────────────────────────────────────────────────

QUESTION_TYPE_LABELS = {"choice": "Multiple choice", "fill": "Fill in the blank", "predict": "Predict output",
                        "complete": "Complete code", "explain": "Explain in words", "text": "Written response"}


def chapter_number(course: dict, unit_id: str) -> int | None:
    ids = [u["id"] for u in course.get("units", [])]
    return ids.index(unit_id) + 1 if unit_id in ids else None


def chapter_short(course: dict, unit_id: str) -> str:
    number = chapter_number(course, unit_id)
    return f"Ch {number:02d}" if number else ("Not linked to a chapter" if not unit_id else unit_id)


def unit_title(course: dict, unit_id: str) -> str:
    return next((u["title"] for u in course.get("units", []) if u["id"] == unit_id), "") or (
        "Not linked to a chapter" if not unit_id else unit_id)


# RV6-M04: only a number that follows a sequence word ("Week 3", "HW 2", "Lab 4", "In-class 1") names the assignment;
# version numbers and dates ("Review-v0.6.0-Homework", "Eval-20261021") do not.
_SEQUENCE_NUMBER = re.compile(
    r"(?<![a-z])(?:week|wk|homework|hw|assignment|problem\s*set|pset|ps|lab|exercise|ex|in[- ]?class|ic|quiz|session|"
    r"unit|chapter|ch|module|lecture|day|part|w(?=\d))\s*[-#:.]?\s*0*(\d{1,2})(?!\d|\.\d)", re.IGNORECASE)
SHORT_TITLE_LENGTH = 24


def _short_title(title: str) -> str:
    text = " ".join((title or "Assignment").split()) or "Assignment"
    return text if len(text) <= SHORT_TITLE_LENGTH else text[:SHORT_TITLE_LENGTH - 1].rstrip() + "…"


def short_assignment_label(title: str, kind: str) -> str:
    """``Week 3 Homework`` → ``HW3``; in-class exercises → ``IC3``; other titles are shortened (≤ 24 characters)."""
    match = _SEQUENCE_NUMBER.search(title or "")
    if match:
        return ("HW" if kind == "homework" else "IC") + str(int(match.group(1)))
    return _short_title(title)


def unique_short_labels(records: list[tuple[str, str, str]]) -> dict[str, str]:
    """``(id, title, kind)`` in creation order → short labels that never repeat within a course (RV6-M04).

    Two assignments that would share ``HW3`` use their shortened titles instead; identical titles get ``(2)``, ``(3)``.
    """
    first = {rid: short_assignment_label(title, kind) for rid, title, kind in records}
    counts: dict[str, int] = {}
    for label in first.values():
        counts[label] = counts.get(label, 0) + 1
    out: dict[str, str] = {}
    seen: dict[str, int] = {}
    for rid, title, _kind in records:
        label = first[rid] if counts[first[rid]] == 1 else _short_title(title)
        seen[label] = seen.get(label, 0) + 1
        out[rid] = label if seen[label] == 1 else f"{label} ({seen[label]})"
    return out


@dataclass
class AssignmentInfo:
    id: str
    title: str
    kind: str
    unit_id: str
    status: str
    short: str
    questions: dict[str, tuple[int, dict]]
    deleted: bool


def assignment_index(db: sqlite3.Connection, class_id: str) -> dict[str, AssignmentInfo]:
    out: dict[str, AssignmentInfo] = {}
    records = [readers.record_from_row(row)
               for row in db.execute("SELECT * FROM assignments WHERE class_id = ? ORDER BY created_at, id", (class_id,))]
    labels = unique_short_labels([(rec.id, rec.title, rec.kind) for rec in records])
    for rec in records:
        out[rec.id] = AssignmentInfo(rec.id, rec.title, rec.kind, rec.unit_id, rec.status, labels[rec.id],
                                     {q["id"]: (i + 1, q) for i, q in enumerate(rec.questions) if isinstance(q.get("id"), str)},
                                     bool(rec.deleted_at))
    return out


def question_ref(index: dict[str, AssignmentInfo], assignment_id: str, question_id: str) -> str:
    """``HW3 Q2`` (or the assignment short label alone when the question is unknown)."""
    info = index.get(assignment_id)
    if not info:
        return question_id or ""
    position = info.questions.get(question_id, (None, None))[0]
    return f"{info.short} Q{position}" if position else info.short


def _clip(text: object, limit: int = 120) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


# ─── explorer v2 (§13.4) ───────────────────────────────────────────────────────────────────────

GROUPS = ("students", "chapters", "assignments", "questions", "reading", "question-activities", "study-sessions")
LEGACY_GROUP_NAMES = {"sessions": "question-activities", "topics": "chapters", "materials": "reading"}
V2_ONLY_PARAMS = ("v", "from", "to", "where", "work", "origin", "groupId", "questionType", "difficulty", "policyVersionId",
                  "includeStaff", "tag", "fold", "columns")
ACTIVITY_FILTERS = ("attempts", "runs", "errors", "success", "unknown", "reading", "ai")


def wants_v2(query: dict[str, str]) -> bool:
    """v0.6 explorer request: explicit ``v=2``, a v0.6-only parameter, or a v0.6-only group name."""
    if query.get("group") in ("chapters", "reading", "question-activities", "study-sessions"):
        return True
    return any(query.get(key) not in (None, "") for key in V2_ONLY_PARAMS)


@dataclass
class ExplorerQuery:
    group: str = "students"
    where: str = ""
    work: str = ""
    origin: str = ""
    unit_id: str = ""
    assignment_id: str = ""
    question_id: str = ""
    student_id: str = ""
    material_id: str = ""
    activity: str = ""
    search: str = ""
    question_type: str = ""
    difficulty: int | None = None
    policy_version_id: int | None = None
    tag: str = ""
    fold: bool = True
    sort: str = ""
    direction: str = "desc"
    page: int = 1
    page_size: int = 25
    name_mode: str = "names"


def _event_filters(q: ExplorerQuery, *, for_group: str) -> tuple[list[str], list]:
    where: list[str] = []
    params: list[object] = []
    if q.where in ("lab", "kiwi"):
        where.append("e.source = ?")
        params.append(q.where)
    work = q.work
    if work == "free":
        where.append("e.practice_mode = 'free'")
    elif work == "assigned":
        where.append(TEACHER)
    elif work and work != "all":
        where.append("(e.attribution_assignment_id = ? OR e.related_assignment_id = ?)")
        params += [work, work]
    origin = q.origin or ("teacher" if for_group == "questions" else "")
    if origin == "teacher":
        where.append(TEACHER)
    elif origin == "ai-free":
        where.append("e.practice_mode = 'free'")
    elif origin == "ai-similar":
        where.append("e.practice_mode = 'similar'")
    if q.unit_id:
        where.append(f"{UNIT_EXPR} = ?")
        params.append("" if q.unit_id == "unattributed" else q.unit_id)
    if q.assignment_id:
        where.append("(e.attribution_assignment_id = ? OR e.related_assignment_id = ?)")
        params += [q.assignment_id, q.assignment_id]
    if q.question_id:
        where.append("(e.question_id = ? OR e.item_id = ?)")
        params += [q.question_id, q.question_id]
    if q.student_id:
        where.append("e.student_id = ?")
        params.append(q.student_id)
    if q.material_id:
        where.append("CAST(json_extract(e.payload_json, '$.materialId') AS TEXT) = ?")
        params.append(q.material_id)
    if q.question_type:
        where.append("(gi.question_type = ? OR EXISTS (SELECT 1 FROM json_each(a.questions_json) jq "
                     "WHERE json_extract(jq.value, '$.id') = e.question_id AND json_extract(jq.value, '$.type') = ?))")
        params += [q.question_type, q.question_type]
    if q.difficulty is not None:
        where.append("gi.difficulty = ?")
        params.append(q.difficulty)
    if q.policy_version_id is not None:
        where.append("(e.policy_version_id = ? OR gi.policy_version_id = ?)")
        params += [q.policy_version_id, q.policy_version_id]
    if q.tag:
        where.append("EXISTS (SELECT 1 FROM json_each(a.questions_json) jq, json_each(COALESCE(json_extract(jq.value, '$.tags'), "
                     "'[]')) jt WHERE json_extract(jq.value, '$.id') = e.question_id AND jt.value = ?)")
        params.append(q.tag)
    return where, params


def _search_clause(q: ExplorerQuery, alias: str, student_col: str, class_id: str) -> tuple[str, list]:
    """Student search over roster labels (Presentation mode: pseudonym and id only)."""
    text = q.search.strip().lower()[:100]
    if not text:
        return "", []
    if q.name_mode == "pseudonyms":
        cond = ("instr(lower(rs.student_id), ?) > 0 OR instr(lower('s-' || printf('%03d', rs.pseudonym_seq)), ?) > 0")
        params = [text, text]
    else:
        cond = ("instr(lower(rs.student_id), ?) > 0 OR instr(lower(rs.display_name), ?) > 0 "
                "OR instr(lower(rs.student_name), ?) > 0 OR instr(lower(rs.kiwi_email), ?) > 0")
        params = [text] * 4
    return (f"EXISTS (SELECT 1 FROM roster rs WHERE rs.class_id = ? AND rs.student_id = {alias}.{student_col} AND ({cond}))",
            [class_id, *params])


def _aggregate(db: sqlite3.Connection, scope: Scope, q: ExplorerQuery, key_expr: str, *, extra: Iterable[str] = (),
               extra_params: Iterable[object] = (), skip_telemetry: bool = True) -> dict[str, dict]:
    population, params = pop_sql(scope)
    filters, fparams = _event_filters(q, for_group=q.group)
    search, sparams = _search_clause(q, "e", "student_id", scope.class_id)
    clauses = [population, *filters, *extra]
    if search:
        clauses.append(search)
    if skip_telemetry:
        clauses.append("e.event_type NOT IN (" + ", ".join(f"'{t}'" for t in TELEMETRY_TYPES) + ")")
    sql = f"""SELECT {key_expr} AS k, {_AGG_SELECT} FROM events e {EV_JOINS}
        WHERE {' AND '.join(clauses)} GROUP BY k"""
    rows = db.execute(sql, [*params, *fparams, *extra_params, *sparams]).fetchall()
    return {str(row["k"] if row["k"] is not None else ""): dict(row) for row in rows}


def _first_try(db: sqlite3.Connection, scope: Scope, q: ExplorerQuery, key_expr: str, unit_expr: str,
               *, extra: Iterable[str] = (), extra_params: Iterable[object] = ()) -> dict[str, dict]:
    """Per key: students (or student×item pairs) with ≥ 1 server-checked attempt and how many got the first one right."""
    population, params = pop_sql(scope)
    filters, fparams = _event_filters(q, for_group=q.group)
    clauses = [population, CHECKED, *filters, *extra]
    sql = f"""SELECT k, COUNT(*) AS takers, SUM(c) AS firstCorrect FROM (
        SELECT {key_expr} AS k, {CORRECT} AS c, ROW_NUMBER() OVER (
            PARTITION BY {key_expr}, e.student_id, COALESCE(NULLIF(e.item_id, ''), e.question_id) ORDER BY e.created_at, e.id) AS rn
        FROM events e {EV_JOINS} WHERE {' AND '.join(clauses)}) WHERE rn = 1 GROUP BY k"""
    rows = db.execute(sql, [*params, *fparams, *extra_params]).fetchall()
    return {str(row["k"] or ""): {"takers": row["takers"], "firstCorrect": row["firstCorrect"] or 0} for row in rows}


def _base_row(agg: dict | None) -> dict:
    a = agg or {}
    get = lambda key: a.get(key) or 0  # noqa: E731
    students = get("students")
    row = {name: get(name) for name in ("interactions", "actions", "attempts", "checked", "correct", "codeRuns", "codeErrors",
                                        "codeSuccesses", "aiQuestions", "views", "students", "clientChecked", "clientCorrect")}
    row.update(
        lastActive=a.get("lastActive"), startedAt=a.get("firstAt"), sessions=0,
        accuracy=_pct(get("correct"), get("checked")), serverAccuracy=_pct(get("correct"), get("checked")),
        similarAccuracy=_pct(get("simCorrect"), get("simChecked")), clientAccuracy=_pct(get("clientCorrect"), get("clientChecked")),
        legacyAccuracy=_pct(get("legacyCorrect"), get("legacyChecked")),
        averageAttempts=round(get("attempts") / students, 2) if students else 0,
        averageQuestions=round(get("aiQuestions") / students, 2) if students else 0,
        runResultNotRecorded=max(0, get("codeRuns") - get("codeErrors") - get("codeSuccesses")),
        kiwiAiQuestions=get("kiwiAiQuestions"),
    )
    return row


def _active_minutes(db: sqlite3.Connection, scope: Scope, key_expr: str = "e.student_id") -> dict[str, float]:
    """Counted heartbeats × 0.5 (§13.9), keyed by ``key_expr`` (student by default)."""
    population, params = pop_sql(scope)
    rows = db.execute(f"""SELECT {key_expr} AS k, COUNT(*) AS n FROM events e WHERE {population}
        AND e.event_type = 'study_heartbeat' AND e.heartbeat_counted = 1 GROUP BY k""", params).fetchall()
    return {str(row["k"] or ""): row["n"] * 0.5 for row in rows}


def _activity_ok(row: dict, activity: str) -> bool:
    return {
        "attempts": row.get("attempts", 0) > 0, "runs": row.get("codeRuns", 0) > 0, "errors": row.get("codeErrors", 0) > 0,
        "success": row.get("codeSuccesses", 0) > 0, "unknown": row.get("runResultNotRecorded", 0) > 0,
        "reading": row.get("views", 0) > 0, "ai": row.get("aiQuestions", 0) > 0,
    }.get(activity, True)


SORTABLE = {"label", "studentName", "lastActive", "startedAt", "attempts", "actions", "interactions", "codeRuns", "codeErrors",
            "codeSuccesses", "aiQuestions", "accuracy", "serverAccuracy", "similarAccuracy", "clientAccuracy",
            "legacyAccuracy", "students", "views", "missingWork", "homeworkAvgScorePct", "firstTryCorrectPct", "activeMinutes",
            "submitted", "runResultNotRecorded", "averageAttempts", "averageQuestions", "kiwiAiQuestions"}


def _sort_page(rows: list[dict], q: ExplorerQuery, default_sort: str) -> tuple[list[dict], int]:
    sort = q.sort or default_sort
    if sort not in SORTABLE:
        raise ValueError("Unsupported sort column")
    descending = q.direction != "asc"
    present = [r for r in rows if r.get(sort) is not None]
    missing = [r for r in rows if r.get(sort) is None]

    def key(row: dict) -> object:
        value = row.get(sort)
        return value.lower() if isinstance(value, str) else value

    present.sort(key=lambda r: str(r.get("label") or r.get("id") or ""))
    present.sort(key=key, reverse=descending)
    ordered = present + sorted(missing, key=lambda r: str(r.get("label") or r.get("id") or ""))
    start = (q.page - 1) * q.page_size
    return ordered[start:start + q.page_size], len(ordered)


def explore(db: sqlite3.Connection, scope: Scope, q: ExplorerQuery) -> dict:
    """``AnalyticsTable`` for the Activity explorer (§13.4)."""
    if q.group not in GROUPS:
        raise ValueError("Unsupported table view")
    if q.activity and q.activity not in ACTIVITY_FILTERS:
        raise ValueError("Unsupported activity filter")
    course = course_config.course_for(scope.class_id, db)
    builders = {"students": _students_rows, "chapters": _chapter_rows, "assignments": _assignment_rows,
                "questions": _question_rows, "reading": _reading_rows}
    if q.group == "question-activities":
        result = _question_activity_rows(db, scope, q)
    elif q.group == "study-sessions":
        result = _study_session_rows(db, scope, q)
    else:
        rows, default_sort = builders[q.group](db, scope, q, course)
        page_rows, total = _sort_page(rows, q, default_sort)
        if q.group == "students":
            _add_missing_work(db, scope, page_rows)
        result = {"rows": page_rows, "total": total}
    enrolled = enrolled_ids(db, unranged(scope))
    result.update(page=q.page, pageSize=q.page_size, population={"enrolled": len(enrolled), "active": active_count(db, scope)})
    return result


def active_count(db: sqlite3.Connection, scope: Scope) -> int:
    """Enrolled (population) students with ≥ 1 action-category event in the window (§13.9)."""
    population, params = pop_sql(scope)
    return int(db.execute(f"SELECT COUNT(DISTINCT e.student_id) FROM events e WHERE {population} AND e.category = 'action'",
                          params).fetchone()[0])


def _students_rows(db: sqlite3.Connection, scope: Scope, q: ExplorerQuery, course: dict) -> tuple[list[dict], str]:
    agg = _aggregate(db, scope, q, "e.student_id")
    minutes = _active_minutes(db, scope)
    base = enrolled_ids(db, unranged(scope))
    if q.student_id:
        base = [s for s in base if s == q.student_id]
    if q.search:
        clause, params = _search_clause(q, "x", "student_id", scope.class_id)
        allowed = {row[0] for row in db.execute(
            f"SELECT x.student_id FROM roster x WHERE x.class_id = ? AND {clause}", [scope.class_id, *params])}
        base = [s for s in base if s in allowed]
    # Zero-activity roster students stay listed under every filter except Activity [AU-D4-09]; the population
    # already limits ``agg`` to roster students unless "Include teaching staff" adds staff and preview-free ids.
    known = set(base)
    ids = [*base, *(k for k in agg if k and k not in known and scope.include_staff)]
    groups = _student_group_names(db, scope.class_id, ids)
    rows = []
    for sid in ids:
        if not sid:
            continue
        row = _base_row(agg.get(sid))
        row.update(id=sid, studentId=sid, studentName=sid, label=sid, activeMinutes=minutes.get(sid, 0.0),
                   groupNames=groups.get(sid, []), missingWork=None)
        row["students"] = 1
        rows.append(row)
    if q.activity:
        rows = [r for r in rows if _activity_ok(r, q.activity)]
    return rows, "lastActive"


def _student_group_names(db: sqlite3.Connection, class_id: str, ids: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for row in db.execute("""SELECT gm.student_id, g.name FROM group_members gm JOIN course_groups g ON g.id = gm.group_id
            WHERE gm.class_id = ? AND g.archived_at IS NULL ORDER BY g.kind, g.name""", (class_id,)):
        out.setdefault(row[0], []).append(row[1])
    return {sid: out.get(sid, []) for sid in ids}


def published_homework(db: sqlite3.Connection, class_id: str) -> list[AssignmentRecord]:
    rows = db.execute("""SELECT * FROM assignments WHERE class_id = ? AND kind = 'homework' AND status = 'published'
        AND archived_at IS NULL AND deleted_at IS NULL ORDER BY due_at, created_at, id""", (class_id,)).fetchall()
    return [readers.record_from_row(row) for row in rows]


def _past_due(rec: AssignmentRecord, now: datetime) -> bool:
    due = dbmod.parse_iso(rec.due_at) if rec.due_at else None
    if due is None:
        return False
    try:
        grace = timedelta(minutes=int(rec.late_policy.get("graceMinutes") or 0))
    except (TypeError, ValueError):
        grace = timedelta(0)
    return due + grace <= now


# ─── Missing work: one rule for every caller (decision D8, B-m02) ─────────────────────────────
#
# A homework and its published revisions are one piece of work. A student who submitted any version is not missing it;
# a student who submitted none is missing it once, against the newest published version in their audience (the one they
# can still submit to). Roster, student profile, Home, Needs attention, the Activity explorer, the Assignments list,
# gradebook cells and the status CSV all use ``missing_verdict`` / ``missing_work`` below.

@dataclass(frozen=True)
class MissingWork:
    """One missing homework: the version the student can still submit to, and the older versions it replaces."""

    rec: AssignmentRecord
    originals: tuple[AssignmentRecord, ...] = ()   # nearest first

    @property
    def id(self) -> str:
        return self.rec.id

    @property
    def title(self) -> str:
        return self.rec.title

    @property
    def due_at(self) -> str | None:
        return self.rec.due_at

    @property
    def original_title(self) -> str | None:
        """The first version's title (the tooltip names it), or None for a homework that was never revised."""
        return self.originals[-1].title if self.originals else None

    def as_dict(self) -> dict:
        return {"assignmentId": self.id, "title": self.title, "originalTitle": self.original_title}


@dataclass(frozen=True)
class MissingVerdict:
    """Whether a student with no submission on one homework is missing it (D8), and why not when they are not."""

    missing: bool
    submitted: AssignmentRecord | None = None       # another version the student submitted
    submitted_relation: str = ""                    # "original" (an older version) | "revision" (a newer one)
    counted_on: AssignmentRecord | None = None      # the newer published version that carries this homework
    originals: tuple[AssignmentRecord, ...] = ()    # older versions this one replaces, nearest first


def missing_text(items: list[MissingWork]) -> str:
    """Tooltip of a Missing work count: ``Files HW — revision (new version of Files HW) · Older homework``."""
    return " · ".join(f"{m.title} (new version of {m.original_title})" if m.original_title else m.title for m in items)


def homework_lineage(db: sqlite3.Connection, rec: AssignmentRecord,
                     cache: dict[str, tuple[AssignmentRecord, ...]] | None = None) -> tuple[AssignmentRecord, ...]:
    """Every non-deleted version of a homework, oldest first (the first version, then revisions by depth and creation);
    just ``(rec,)`` for a homework that was never revised."""
    if cache is not None and rec.id in cache:
        return cache[rec.id]
    if "revision_of" not in dbmod.table_columns(db, "assignments"):
        return (rec,)
    row = db.execute("""SELECT revision_of, EXISTS(SELECT 1 FROM assignments c WHERE c.class_id = a.class_id
        AND c.revision_of = a.id) FROM assignments a WHERE a.class_id = ? AND a.id = ?""", (rec.class_id, rec.id)).fetchone()
    if row is None or (not row[0] and not row[1]):
        return (rec,)
    originals = readers.original_ids(db, rec.class_id, rec.id)
    root = originals[-1] if originals else rec.id
    order: list[tuple[int, str, str]] = []
    created = db.execute("SELECT created_at FROM assignments WHERE class_id = ? AND id = ?", (rec.class_id, root)).fetchone()
    order.append((0, created[0] if created else "", root))
    seen, frontier, depth = {root}, [root], 0
    while frontier and len(seen) <= 2 * readers._LINEAGE_LIMIT:
        depth += 1
        marks = ",".join("?" for _ in frontier)
        found = [(r[0], r[1]) for r in db.execute(
            f"SELECT id, created_at FROM assignments WHERE class_id = ? AND revision_of IN ({marks})", (rec.class_id, *frontier))
            if r[0] not in seen]
        seen.update(i for i, _ in found)
        order.extend((depth, at or "", i) for i, at in found)
        frontier = [i for i, _ in found]
    members = []
    for _depth, _at, member_id in sorted(order):
        member = rec if member_id == rec.id else readers.load_assignment(db, rec.class_id, member_id)
        if member is not None:
            members.append(member)
    lineage = tuple(members) or (rec,)
    if cache is not None:
        for member in lineage:
            cache[member.id] = lineage
    return lineage


def _student_version(db: sqlite3.Connection, member: AssignmentRecord, student_id: str) -> bool:
    """A version the student can work on: published, not archived, homework, in their audience."""
    return (member.kind == "homework" and member.status == "published" and not member.archived_at
            and readers.in_audience(db, member, student_id))


def missing_verdict(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str, now: datetime, *,
                    cache: dict[str, tuple[AssignmentRecord, ...]] | None = None,
                    submitted: set[str] | None = None) -> MissingVerdict:
    """D8 for a student in the homework's audience who has no (non-preview) submission on ``rec`` itself.

    ``submitted`` (assignment ids the student submitted, non-preview) and ``cache`` (lineages) let a caller that checks
    many homework share one query.
    """
    lineage = homework_lineage(db, rec, cache)
    if len(lineage) == 1 or rec.id not in {m.id for m in lineage}:
        return MissingVerdict(missing=_past_due(rec, now))
    position = next(i for i, m in enumerate(lineage) if m.id == rec.id)
    if submitted is None:
        ids = [m.id for m in lineage]
        submitted = {r[0] for r in db.execute(
            f"""SELECT DISTINCT assignment_id FROM submissions WHERE class_id = ? AND student_id = ? AND is_preview = 0
            AND assignment_id IN ({','.join('?' for _ in ids)})""", (rec.class_id, student_id, *ids))}
    older = lineage[:position][::-1]
    for member in older:   # S-M01: the nearest original first
        if member.id in submitted:
            return MissingVerdict(missing=False, submitted=member, submitted_relation="original")
    for member in lineage[position + 1:]:
        if member.id in submitted:
            return MissingVerdict(missing=False, submitted=member, submitted_relation="revision")
    versions = [m for m in lineage if _student_version(db, m, student_id)]
    head = versions[-1] if versions else None
    if head is not None and head.id != rec.id:
        return MissingVerdict(missing=False, counted_on=head)
    return MissingVerdict(missing=_past_due(rec, now), originals=older)


def missing_work(db: sqlite3.Connection, class_id: str, student_ids: list[str], now: datetime) -> dict[str, list[MissingWork]]:
    """Missing work per student (D8): published homework in the student's audience, past due (after grace), with no
    non-preview submission on any of its versions — each homework once, against the newest version the student has."""
    out: dict[str, list[MissingWork]] = {sid: [] for sid in student_ids}
    # WHY: a verdict is "missing" only when its own homework is past due, so homework not yet due is skipped up front
    due = [rec for rec in published_homework(db, class_id) if _past_due(rec, now)]
    if not due or not student_ids:
        return out
    submitted: dict[str, set[str]] = {}
    for row in db.execute("SELECT DISTINCT student_id, assignment_id FROM submissions WHERE class_id = ? AND is_preview = 0",
                          (class_id,)):
        submitted.setdefault(row[0], set()).add(row[1])
    cache: dict[str, tuple[AssignmentRecord, ...]] = {}
    for sid in student_ids:
        mine = submitted.get(sid, set())
        for rec in due:
            if rec.id in mine or not readers.in_audience(db, rec, sid):
                continue
            verdict = missing_verdict(db, rec, sid, now, cache=cache, submitted=mine)
            if verdict.missing:
                out[sid].append(MissingWork(rec, verdict.originals))
    return out


def missing_students(db: sqlite3.Connection, rec: AssignmentRecord, student_ids: Iterable[str], now: datetime) -> set[str]:
    """The students (of ``student_ids``) whose Missing work includes this homework (D8; the Assignments list)."""
    if rec.kind != "homework" or not _past_due(rec, now):
        return set()
    ids = [sid for sid in student_ids if readers.in_audience(db, rec, sid)]
    if not ids:
        return set()
    done = {r[0] for r in db.execute("SELECT DISTINCT student_id FROM submissions WHERE class_id = ? AND assignment_id = ? "
                                     "AND is_preview = 0", (rec.class_id, rec.id))}
    cache: dict[str, tuple[AssignmentRecord, ...]] = {}
    return {sid for sid in ids if sid not in done and missing_verdict(db, rec, sid, now, cache=cache).missing}


def _add_missing_work(db: sqlite3.Connection, scope: Scope, rows: list[dict]) -> None:
    missing = missing_work(db, scope.class_id, [r["studentId"] for r in rows], dbmod.utcnow())
    for row in rows:
        row["missingWork"] = len(missing.get(row["studentId"], []))


def _chapter_rows(db: sqlite3.Connection, scope: Scope, q: ExplorerQuery, course: dict) -> tuple[list[dict], str]:
    agg = _aggregate(db, scope, q, UNIT_EXPR)
    units = [u["id"] for u in course.get("units", [])]
    keys = list(dict.fromkeys([*([] if q.unit_id else units), *agg.keys()]))
    if q.unit_id:
        wanted = "" if q.unit_id == "unattributed" else q.unit_id
        keys = [k for k in keys if k == wanted] or [wanted]
    rows = []
    for unit in keys:
        row = _base_row(agg.get(unit))
        row.update(id=unit or "unattributed", unitId=unit, label=unit_title(course, unit), title=unit_title(course, unit))
        rows.append(row)
    if q.activity:
        rows = [r for r in rows if _activity_ok(r, q.activity)]
    order = {u: i for i, u in enumerate(units)}
    rows.sort(key=lambda r: order.get(r["unitId"], len(order)))
    return rows, "label"


def submission_stats(db: sqlite3.Connection, scope: Scope, assignment_ids: list[str]) -> dict[str, dict]:
    """Per assignment: population students with a non-preview submission, and the mean latest-attempt score %."""
    if not assignment_ids:
        return {}
    population, params = pop_sql(unranged(scope), "s", time_col=None)
    marks = ",".join("?" for _ in assignment_ids)
    rows = db.execute(
        f"""SELECT s.assignment_id, COUNT(DISTINCT s.student_id) AS submitted,
        AVG(CASE WHEN s.id IN ({readers.latest_submission_ids_sql()}) AND s.grade IS NOT NULL
                 AND s.grade_status IN ('draft', 'released') THEN s.grade END) AS avgGrade
        FROM submissions s WHERE {population} AND s.assignment_id IN ({marks}) GROUP BY s.assignment_id""",
        [*params, *assignment_ids]).fetchall()
    return {row[0]: {"submitted": row["submitted"], "avgGrade": row["avgGrade"]} for row in rows}


def _assignment_rows(db: sqlite3.Connection, scope: Scope, q: ExplorerQuery, course: dict) -> tuple[list[dict], str]:
    key = "COALESCE(NULLIF(e.attribution_assignment_id, ''), e.related_assignment_id)"
    agg = _aggregate(db, scope, q, key, extra=["COALESCE(NULLIF(e.attribution_assignment_id, ''), e.related_assignment_id) != ''"])
    index = assignment_index(db, scope.class_id)
    listed = [a.id for a in index.values() if a.status == "published" and not a.deleted]
    if q.unit_id:
        listed = [aid for aid in listed if index[aid].unit_id == ("" if q.unit_id == "unattributed" else q.unit_id)]
    if q.assignment_id:
        listed = [aid for aid in listed if aid == q.assignment_id]
    if q.work == "free" or q.origin in ("ai-free",):
        listed = []
    if q.student_id or q.where == "kiwi" or q.search:
        listed = []  # narrowed views list only assignments with matching activity
    keys = list(dict.fromkeys([*listed, *[k for k in agg if k]]))
    stats = submission_stats(db, scope, keys)
    rows = []
    for aid in keys:
        info = index.get(aid)
        row = _base_row(agg.get(aid))
        maximum = sum(float(qq.get("points") or 0) for _, qq in info.questions.values()) if info else 0.0
        stat = stats.get(aid, {})
        avg = stat.get("avgGrade")
        row.update(id=aid, assignmentId=aid, label=info.title if info else aid, title=info.title if info else aid,
                   kind=info.kind if info else "", unitId=info.unit_id if info else "",
                   submitted=stat.get("submitted", 0) if info and info.kind == "homework" else None,
                   homeworkAvgScorePct=_pct(avg, maximum) if avg is not None and maximum else None)
        rows.append(row)
    if q.activity:
        rows = [r for r in rows if _activity_ok(r, q.activity)]
    return rows, "lastActive"


def _question_key(q: ExplorerQuery) -> str:
    teacher = "'t:' || e.attribution_assignment_id || ':' || COALESCE(e.question_id, '')"
    if not q.fold:
        ai = "'i:' || e.item_id"
        return f"CASE WHEN {TEACHER} THEN {teacher} WHEN e.item_id != '' THEN {ai} ELSE '' END"
    free = f"'f:' || {UNIT_EXPR} || ':' || COALESCE(gi.question_type, '')"
    similar = ("'s:' || COALESCE(NULLIF(e.related_assignment_id, ''), gi.related_assignment_id, '') || ':' || "
               "COALESCE(gi.related_question_id, '') || ':' || COALESCE(gi.question_type, '')")
    return (f"CASE WHEN {TEACHER} THEN {teacher} WHEN e.practice_mode = 'similar' AND e.item_id != '' THEN {similar} "
            f"WHEN e.practice_mode = 'free' AND e.item_id != '' THEN {free} ELSE '' END")


def _item_counts(db: sqlite3.Connection, scope: Scope, q: ExplorerQuery) -> dict[str, int]:
    """Distinct generated items per folded key (``Free practice (AI) · Ch 03 · Multiple choice (12)``)."""
    population, params = pop_sql(scope)
    filters, fparams = _event_filters(q, for_group="questions")
    key = _question_key(q)
    rows = db.execute(f"""SELECT {key} AS k, COUNT(DISTINCT e.item_id) AS n FROM events e {EV_JOINS}
        WHERE {population} AND e.item_id != '' {''.join(' AND ' + f for f in filters)} GROUP BY k""",
                      [*params, *fparams]).fetchall()
    return {str(row["k"] or ""): row["n"] for row in rows}


def _question_rows(db: sqlite3.Connection, scope: Scope, q: ExplorerQuery, course: dict) -> tuple[list[dict], str]:
    key = _question_key(q)
    extra = ["(e.question_id != '' OR e.item_id != '')", f"({key}) != ''"]
    agg = _aggregate(db, scope, q, key, extra=extra)
    first = _first_try(db, scope, q, key, UNIT_EXPR, extra=extra)
    items = _item_counts(db, scope, q)
    index = assignment_index(db, scope.class_id)
    item_rows = {}
    if not q.fold:
        ids = [k[2:] for k in agg if k.startswith("i:")]
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            for row in db.execute(f"SELECT * FROM generated_items WHERE class_id = ? AND id IN ({','.join('?' for _ in chunk)})",
                                  [scope.class_id, *chunk]):
                item_rows[row["id"]] = row
    rows = []
    for k, a in agg.items():
        row = _base_row(a)
        taken = first.get(k, {})
        row["firstTryCorrectPct"] = _pct(taken.get("firstCorrect"), taken.get("takers"))
        kind, _, rest = k.partition(":")
        if kind == "t":
            aid, _, qid = rest.partition(":")
            info = index.get(aid)
            position, question = (info.questions.get(qid) if info else None) or (None, {})
            row.update(id=k, origin="teacher", assignmentId=aid, questionId=qid, unitId=info.unit_id if info else "",
                       label=_clip(question.get("prompt") or qid, 90), title=_clip(question.get("prompt") or qid, 90),
                       questionType=question.get("type") or "", tags=list(question.get("tags") or []),
                       disambiguation=f"· {question_ref(index, aid, qid)}", aiItemGroup=None)
            row["serverAccuracy"] = row["accuracy"]
        elif kind == "f":
            unit, _, qtype = rest.rpartition(":")
            count = items.get(k, 0)
            label = f"Free practice (AI) · {chapter_short(course, unit)} · {QUESTION_TYPE_LABELS.get(qtype, qtype or 'Practice')} ({count})"
            row.update(id=k, origin="ai-free", unitId=unit, questionType=qtype, label=label, title=label,
                       aiItemGroup={"unitId": unit, "origin": "ai-free", "questionType": qtype, "items": count})
            row["serverAccuracy"] = _pct(a.get("aiCorrect"), a.get("aiChecked"))
            row["accuracy"] = row["serverAccuracy"]
        elif kind == "s":
            parts = rest.split(":")
            aid, qid, qtype = (parts + ["", "", ""])[:3]
            count = items.get(k, 0)
            ref = question_ref(index, aid, qid) or "Homework"
            label = f"Similar practice (AI) · {ref} · {QUESTION_TYPE_LABELS.get(qtype, qtype or 'Practice')} ({count})"
            row.update(id=k, origin="ai-similar", assignmentId=aid, questionId=qid,
                       unitId=index[aid].unit_id if aid in index else "", questionType=qtype, label=label, title=label,
                       aiItemGroup={"unitId": index[aid].unit_id if aid in index else "", "origin": "ai-similar",
                                    "questionType": qtype, "items": count})
            row["serverAccuracy"] = _pct(a.get("simCorrect"), a.get("simChecked"))
            row["accuracy"] = row["serverAccuracy"]
        else:  # unfolded generated item
            item_id = rest
            gi = item_rows.get(item_id)
            item = _loads(gi["item_json"], {}) if gi else {}
            origin = "ai-similar" if gi is not None and gi["origin"] == "similar" else "ai-free"
            prefix = "Similar practice (AI)" if origin == "ai-similar" else "Free practice (AI)"
            label = f"{prefix} · {_clip(item.get('prompt') or item.get('title') or item_id, 70)}"
            row.update(id=k, origin=origin, questionId=item_id, unitId=gi["unit_id"] if gi else "", label=label, title=label,
                       questionType=gi["question_type"] if gi else "", difficulty=gi["difficulty"] if gi else None,
                       policyVersionId=gi["policy_version_id"] if gi else None, aiItemGroup=None)
            row["serverAccuracy"] = _pct(a.get("aiCorrect"), a.get("aiChecked"))
            row["accuracy"] = row["serverAccuracy"]
        rows.append(row)
    # duplicate titles keep their "· HW3 Q2" suffix; unique titles drop it [FD02]
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["label"]] = counts.get(row["label"], 0) + 1
    for row in rows:
        if row.get("origin") != "teacher" or counts[row["label"]] < 2:
            row["disambiguation"] = ""
    if q.activity:
        rows = [r for r in rows if _activity_ok(r, q.activity)]
    return rows, "attempts"


def _reading_rows(db: sqlite3.Connection, scope: Scope, q: ExplorerQuery, course: dict) -> tuple[list[dict], str]:
    material = "CAST(json_extract(e.payload_json, '$.materialId') AS TEXT)"
    agg = _aggregate(db, scope, q, material, extra=["e.source = 'kiwi'", f"COALESCE({material}, '') != ''"])
    titles = {row["id"]: row for row in db.execute("SELECT id, title, unit_id FROM kiwi_materials WHERE class_id = ?",
                                                   (scope.class_id,))}
    mapped = {row[0]: row[1] for row in db.execute(
        """SELECT m.material_id, m.unit_id FROM material_unit_map m WHERE m.class_id = ? AND m.valid_from = (
           SELECT MAX(x.valid_from) FROM material_unit_map x WHERE x.class_id = m.class_id AND x.material_id = m.material_id)""",
        (scope.class_id,))}
    rows = []
    for mid, a in agg.items():
        info = titles.get(mid)
        unit = mapped.get(mid, info["unit_id"] if info else "")
        row = _base_row(a)
        row.update(id=mid, materialId=mid, label=info["title"] if info else mid, title=info["title"] if info else mid,
                   unitId=unit, chapterLabel=unit_title(course, unit))
        rows.append(row)
    if q.activity:
        rows = [r for r in rows if _activity_ok(r, q.activity)]
    return rows, "lastActive"


SESSION_RESULT_ORDER = ("Correct", "Not yet correct", "Answered", "Ran code", "Asked AI", "Viewed")


def session_result(row: dict) -> str:
    if row.get("checked"):
        return "Correct" if row.get("correct") else "Not yet correct"
    if row.get("attempts"):
        return "Answered"
    if row.get("codeRuns"):
        return "Ran code"
    if row.get("aiQuestions"):
        return "Asked AI"
    return "Viewed"


def _session_filters(scope: Scope, q: ExplorerQuery) -> tuple[str, list]:
    population, params = pop_sql(unranged(scope), "s", cols=identity.SESSION_COLS, time_col=None)
    parts = [population]
    if scope.from_:
        parts.append("s.lastActive >= ?")
        params.append(scope.from_)
    if scope.to:
        parts.append("s.startedAt < ?")
        params.append(scope.to)
    for column, value in (("s.source", q.where if q.where in ("lab", "kiwi") else ""), ("s.studentId", q.student_id),
                          ("s.materialId", q.material_id)):
        if value:
            parts.append(f"{column} = ?")
            params.append(value)
    if q.unit_id:
        parts.append("s.unitId = ?")
        params.append("" if q.unit_id == "unattributed" else q.unit_id)
    for aid in (q.assignment_id, q.work if q.work not in ("", "all", "free", "assigned") else ""):
        if aid:
            parts.append("(s.assignmentId = ? OR s.relatedAssignmentId = ?)")
            params += [aid, aid]
    if q.question_id:
        parts.append("(s.questionId = ? OR s.itemId = ?)")
        params += [q.question_id, q.question_id]
    modes = {"free": ("free",), "assigned": ("homework", "in-class")}.get(q.work) or {
        "teacher": ("homework", "in-class"), "ai-free": ("free",), "ai-similar": ("similar",)}.get(q.origin)
    if modes:
        parts.append(f"s.practiceMode IN ({','.join('?' for _ in modes)})")
        params += list(modes)
    activity = {"attempts": "s.attempts > 0", "runs": "s.codeRuns > 0", "errors": "s.codeErrors > 0",
                "success": "s.codeSuccesses > 0", "unknown": "s.codeRuns > s.codeErrors + s.codeSuccesses",
                "reading": "s.kind = 'reading'", "ai": "s.aiQuestions > 0"}.get(q.activity)
    if activity:
        parts.append(activity)
    search, sparams = _search_clause(q, "s", "studentId", scope.class_id)
    if search:
        parts.append(search)
        params += sparams
    if q.question_type:
        parts.append("s.questionType = ?")
        params.append(q.question_type)
    if q.difficulty is not None:
        parts.append("s.difficulty = ?")
        params.append(q.difficulty)
    if q.policy_version_id is not None:
        parts.append("s.policyVersionId = ?")
        params.append(q.policy_version_id)
    return " AND ".join(parts), params


SESSION_SORT = {"lastActive": "s.lastActive", "startedAt": "s.startedAt", "attempts": "s.attempts", "label": "s.title",
                "studentName": "s.studentId", "activeMinutes": "s.activeSeconds", "codeRuns": "s.codeRuns",
                "codeErrors": "s.codeErrors", "aiQuestions": "s.aiQuestions", "interactions": "s.interactions",
                "accuracy": "accuracy", "actions": "s.actions"}


def _session_row(row: sqlite3.Row) -> dict:
    data = dict(row)
    checked = data.get("checked") or 0
    data.update(label=data.get("title"), students=1, sessions=1, accuracy=_pct(data.get("correct"), checked),
                serverAccuracy=_pct(data.get("correct"), checked), averageAttempts=float(data.get("attempts") or 0),
                averageQuestions=float(data.get("aiQuestions") or 0), activeMinutes=round((data.get("activeSeconds") or 0) / 60, 1),
                runResultNotRecorded=max(0, (data.get("codeRuns") or 0) - (data.get("codeErrors") or 0) - (data.get("codeSuccesses") or 0)),
                result=session_result(data), practiceMode=data.get("practiceMode") or "", origin=data.get("origin") or "",
                clientAccuracy=_pct(data.get("clientCorrect"), data.get("clientChecked")))
    data.pop("contextKey", None)
    data.pop("browserSession", None)
    return data


def _question_activity_rows(db: sqlite3.Connection, scope: Scope, q: ExplorerQuery) -> dict:
    where, params = _session_filters(scope, q)
    sort = q.sort or "lastActive"
    if sort not in SESSION_SORT:
        raise ValueError("Unsupported sort column")
    direction = "ASC" if q.direction == "asc" else "DESC"
    total = db.execute(f"SELECT COUNT(*) FROM learning_sessions s WHERE {where}", params).fetchone()[0]
    rows = db.execute(
        f"""SELECT s.*, 100.0 * s.correct / NULLIF(s.checked, 0) AS accuracy FROM learning_sessions s WHERE {where}
        ORDER BY {SESSION_SORT[sort]} {direction} NULLS LAST, s.id LIMIT ? OFFSET ?""",
        [*params, q.page_size, (q.page - 1) * q.page_size]).fetchall()
    return {"rows": [_session_row(r) for r in rows], "total": total}


def _study_session_rows(db: sqlite3.Connection, scope: Scope, q: ExplorerQuery) -> dict:
    """Research preset: per student, a new study session after ≥ 30 min without events (window functions)."""
    population, params = pop_sql(scope)
    filters, fparams = _event_filters(q, for_group="study-sessions")
    search, sparams = _search_clause(q, "e", "student_id", scope.class_id)
    clauses = [population, *filters, "e.event_type NOT IN (" + ", ".join(f"'{t}'" for t in TELEMETRY_TYPES) + ")"]
    if search:
        clauses.append(search)
    sql = f"""WITH ev AS (
            SELECT e.*, CASE WHEN julianday(e.created_at) - julianday(LAG(e.created_at) OVER (
                PARTITION BY e.student_id ORDER BY e.created_at, e.id)) >= 30.0 / 1440 THEN 1 ELSE 0 END AS brk
            FROM events e {EV_JOINS} WHERE {' AND '.join(clauses)}),
        numbered AS (SELECT ev.*, SUM(brk) OVER (PARTITION BY student_id ORDER BY created_at, id ROWS UNBOUNDED PRECEDING) AS sess FROM ev)
        SELECT e.student_id AS studentId, e.sess AS sess, {_AGG_SELECT} FROM numbered e GROUP BY e.student_id, e.sess"""
    rows = []
    for row in db.execute(sql, [*params, *fparams, *sparams]).fetchall():
        data = _base_row(dict(row))
        data.update(id=f"{row['studentId']}:{row['sess'] + 1}", studentId=row["studentId"], studentName=row["studentId"],
                    label=f"Study session {row['sess'] + 1}", title=f"Study session {row['sess'] + 1}", students=1, sessions=1)
        rows.append(data)
    if q.activity:
        rows = [r for r in rows if _activity_ok(r, q.activity)]
    page, total = _sort_page(rows, q, "lastActive")
    return {"rows": page, "total": total}


# ─── answers by question (§6.7, TR02, AU-D4-17) ────────────────────────────────────────────────

def answers_by_question(db: sqlite3.Connection, scope: Scope, *, assignment_id: str = "", question_id: str = "",
                        unit_id: str = "", item_group: str = "", limit: int = 50) -> dict:
    """One table per question; answers are never pooled across questions."""
    index = assignment_index(db, scope.class_id)
    targets: list[tuple[str, str, str]] = []  # (kind, assignment_or_item, question)
    if assignment_id:
        info = index.get(assignment_id)
        if info is None:
            raise ValueError("Assignment not found")
        qids = [question_id] if question_id else [qid for qid, _ in sorted(info.questions.items(), key=lambda kv: kv[1][0])]
        targets = [("t", assignment_id, qid) for qid in qids]
    elif item_group:
        targets = [("i", item_id, item_id) for item_id in _items_for_group(db, scope, item_group)]
    elif question_id and question_id.startswith("gi-"):
        targets = [("i", question_id, question_id)]
    elif unit_id or question_id:
        for info in index.values():
            if info.deleted or info.status != "published" or (unit_id and info.unit_id != unit_id):
                continue
            for qid, _ in sorted(info.questions.items(), key=lambda kv: kv[1][0]):
                if not question_id or qid == question_id:
                    targets.append(("t", info.id, qid))
    else:
        raise ValueError("Choose an assignment, a chapter, a question or an AI item group")
    population, params = pop_sql(scope)
    out = []
    for kind, owner, qid in targets[:60]:
        if kind == "t":
            match = "e.attribution_assignment_id = ? AND e.question_id = ?"
            mparams = [owner, qid]
            info = index[owner]
            position, question = info.questions.get(qid, (None, {}))
            label, prompt, origin = question_ref(index, owner, qid), str(question.get("prompt") or ""), "teacher"
            choices = [str(c) for c in question.get("choices") or []] if question.get("type") == "choice" else []
        else:
            match = "e.item_id = ?"
            mparams = [owner]
            gi = db.execute("SELECT * FROM generated_items WHERE class_id = ? AND id = ?", (scope.class_id, owner)).fetchone()
            item = _loads(gi["item_json"], {}) if gi else {}
            origin = "ai-similar" if gi is not None and gi["origin"] == "similar" else "ai-free"
            label = ("Similar practice (AI)" if origin == "ai-similar" else "Free practice (AI)") + f" · {owner[-6:]}"
            prompt = str(item.get("prompt") or "")
            choices = [str(c) for c in item.get("choices") or []]
        rows = db.execute(
            f"""SELECT CAST(COALESCE(json_extract(e.payload_json, '$.answer'), '') AS TEXT) AS answer, COUNT(*) AS attempts,
            COUNT(DISTINCT e.student_id) AS students, SUM(CASE WHEN {CHECKED} AND {CORRECT} = 1 THEN 1 ELSE 0 END) AS correct,
            SUM(CASE WHEN {CHECKED} AND {CORRECT} = 0 THEN 1 ELSE 0 END) AS incorrect
            FROM events e WHERE {population} AND {ATTEMPT} AND {match}
            GROUP BY answer ORDER BY attempts DESC, answer LIMIT ?""", [*params, *mparams, limit + 1]).fetchall()
        total = db.execute(f"SELECT COUNT(*) FROM events e WHERE {population} AND {ATTEMPT} AND {match}",
                           [*params, *mparams]).fetchone()[0]
        answers = [{"answer": r["answer"], "attempts": r["attempts"], "students": r["students"], "correct": r["correct"] or 0,
                    "incorrect": r["incorrect"] or 0, "unchecked": r["attempts"] - (r["correct"] or 0) - (r["incorrect"] or 0),
                    "share": round(100 * r["attempts"] / total, 1) if total else 0} for r in rows[:limit]]
        for choice in choices:
            if not any(a["answer"] == choice for a in answers):
                answers.append({"answer": choice, "attempts": 0, "students": 0, "correct": 0, "incorrect": 0, "unchecked": 0,
                                "share": 0})
        out.append({"questionId": qid, "label": label, "origin": origin, "prompt": prompt, "totalAttempts": total,
                    "answers": answers, "hasMore": len(rows) > limit, "assignmentId": owner if kind == "t" else ""})
    return {"questions": out}


def _items_for_group(db: sqlite3.Connection, scope: Scope, item_group: str) -> list[str]:
    """``item_group`` = a folded explorer key (``f:<unit>:<type>`` or ``s:<assignment>:<question>:<type>``)."""
    kind, _, rest = item_group.partition(":")
    if kind == "f":
        unit, _, qtype = rest.rpartition(":")
        sql, params = "origin = 'free' AND unit_id = ?", [unit]
    elif kind == "s":
        aid, qid, qtype = (rest.split(":") + ["", "", ""])[:3]
        sql, params = "origin = 'similar' AND related_assignment_id = ? AND related_question_id = ?", [aid, qid]
    else:
        raise ValueError("Unknown AI item group")
    if qtype:
        sql += " AND question_type = ?"
        params.append(qtype)
    population, pparams = pop_sql(scope, "g", time_col="created_at")
    return [row[0] for row in db.execute(
        f"SELECT g.id FROM generated_items g WHERE {population} AND {sql.replace('origin', 'g.origin').replace('unit_id', 'g.unit_id').replace('related_assignment_id', 'g.related_assignment_id').replace('related_question_id', 'g.related_question_id').replace('question_type', 'g.question_type')} "
        "ORDER BY g.created_at DESC LIMIT 20", [*pparams, *params])]


# ─── question activity (aliases) ───────────────────────────────────────────────────────────────

def event_record(row: sqlite3.Row) -> dict:
    """``EventRecord`` incl. the v0.6 provenance fields."""
    keys = row.keys()
    get = lambda key, default=None: row[key] if key in keys else default  # noqa: E731
    return {"id": row["id"], "classId": row["class_id"], "studentId": row["student_id"], "studentName": row["student_name"],
            "sessionId": row["session_id"], "type": row["event_type"], "questionId": row["question_id"],
            "payload": _loads(row["payload_json"], {}), "createdAt": row["created_at"], "receivedAt": get("received_at"),
            "source": get("source", "lab"), "upstreamId": get("upstream_id"), "learningSessionId": get("learning_session_id"),
            "practiceMode": get("practice_mode", ""), "checkedBy": get("checked_by", ""), "actorRole": get("actor_role", "unknown"),
            "isPreview": bool(get("is_preview", 0)), "truncated": _loads(get("truncated_json", ""), {}) or {}}


def question_activity(db: sqlite3.Connection, class_id: str, activity_id: str, after: int = 0, limit: int = 100) -> dict:
    """``QuestionActivity``: follows ``learning_session_aliases`` (``aliasOf`` = the requested old id)."""
    session = db.execute("SELECT * FROM learning_sessions WHERE classId = ? AND id = ?", (class_id, activity_id)).fetchone()
    alias_of = None
    if session is None:
        alias = db.execute("SELECT new_id FROM learning_session_aliases WHERE class_id = ? AND old_id = ?",
                           (class_id, activity_id)).fetchone()
        if alias:
            session = db.execute("SELECT * FROM learning_sessions WHERE classId = ? AND id = ?", (class_id, alias[0])).fetchone()
            alias_of = activity_id if session else None
    if session is None:
        raise LookupError("Question activity not found")
    cursor_time, cursor_id = "", 0
    if after:
        cursor = db.execute("SELECT created_at FROM events WHERE class_id = ? AND learning_session_id = ? AND id = ?",
                            (class_id, session["id"], after)).fetchone()
        if not cursor:
            raise ValueError("Question activity cursor is invalid")
        cursor_time, cursor_id = cursor[0], after
    rows = db.execute(
        """SELECT * FROM events WHERE class_id = ? AND learning_session_id = ? AND (created_at, id) > (?, ?)
        ORDER BY created_at, id LIMIT ?""", (class_id, session["id"], cursor_time, cursor_id, limit + 1)).fetchall()
    result = {"activity": _session_row(session), "events": [event_record(r) for r in rows[:limit]], "hasMore": len(rows) > limit}
    if alias_of:
        result["aliasOf"] = alias_of
    return result


# ─── timelines (§6.7, INSIGHTS-06/19) ──────────────────────────────────────────────────────────

TIMELINE_KINDS = {
    "question_viewed": "question_viewed", "code_run": "code_run", "code_edited": "code_edited", "answer_draft": "answer_draft",
    "answer_submitted": "answer_attempt", "ai_question": "ai_turn", "hint_requested": "ai_turn", "ai_request_failed": "ai_failed",
    "ai_feedback": "ai_feedback", "attempt_started": "attempt_started", "work_submitted": "submission", "hint_shown": "hint_shown",
    "paste": "paste", "material_viewed": "material_viewed", "grade_released": "grade_released",
}
STUDY_GAP = timedelta(minutes=30)


def policy_label(db: sqlite3.Connection, class_id: str, version_id: object, course: dict) -> str:
    """``Ch 03 rules v4`` / ``Course rules v2`` (· group) for a stored policy version; ``Default rules`` otherwise."""
    if type(version_id) is not int:
        return "Default rules"
    row = db.execute("SELECT * FROM policy_versions WHERE class_id = ? AND id = ?", (class_id, version_id)).fetchone()
    if row is None:
        return "Default rules"
    label = (f"{chapter_short(course, row['unit_id'])} rules v{row['version']}" if row["scope"] == "unit"
             else f"Course rules v{row['version']}")
    if row["group_id"]:
        group = db.execute("SELECT name FROM course_groups WHERE id = ?", (row["group_id"],)).fetchone()
        label += f" · {group[0] if group else row['group_id']}"
    return label


def provenance_label(where: str, source: str | None = None) -> str:
    """Teacher-side AI names (§10 NM28): Lab replies are "Lab AI tutor", native replies "Kiwi lecture AI"."""
    if where == "kiwi":
        return "Kiwi lecture AI"
    return "Local guidance" if source == "local" else "Lab AI tutor"


def grade_status_label(status: str | None, score: float | None, maximum: float) -> str:
    """Mirror of ``labels.gradeStateLabel``: Needs grading → Draft 17/20 → Released 17/20 (NM16)."""
    fmt = lambda v: str(int(v)) if float(v).is_integer() else f"{round(float(v), 2):g}"  # noqa: E731
    if status not in ("draft", "released") or score is None:
        return "Needs grading"
    return f"{'Draft' if status == 'draft' else 'Released'} {fmt(score)}/{fmt(maximum)}"


def adjustment_title(after: dict) -> str:
    """``Late penalty −6 (auto)``, ``Bonus +1``, ``Late penalty removed`` (mirrors ``gradingKeys.adjustmentLine``)."""
    points = after.get("points") if isinstance(after, dict) else None
    reason = str(after.get("reason") or "") if isinstance(after, dict) else ""
    if not isinstance(points, (int, float)) or isinstance(points, bool) or not points:
        return reason or "Adjustment removed"
    amount = ("−" if points < 0 else "+") + (str(int(abs(points))) if float(points).is_integer() else f"{abs(points):g}")
    if reason == "Late penalty (auto)":
        return f"Late penalty {amount} (auto)"
    return f"{reason or 'Adjustment'} {amount}"


def _event_title(kind: str, payload: dict, row: sqlite3.Row) -> str:
    correct = payload.get("correct")
    if kind == "submission" and isinstance(payload.get("attempt"), int):
        late = " · Late" if payload.get("late") is True else ""   # RV6-m07: the timeline says a submission was late
        return f"Homework submission · Attempt {payload['attempt']}{late}"   # NM26
    if kind == "answer_attempt":
        return "Answer attempt · " + ("correct" if correct is True else "incorrect" if correct is False else "not auto-checked")
    if kind == "code_run":
        ok = payload.get("ok")
        return "Code run · " + ("success" if ok is True else "error" if ok is False else "result not recorded")
    if row["event_type"] == "question_generated":
        origin = payload.get("origin")
        return "Similar exercise generated" if origin == "similar" or row["practice_mode"] == "similar" else "Practice exercise generated"
    return {
        "question_viewed": "Question opened", "code_edited": "Code saved", "answer_draft": "Answer draft saved",
        "ai_turn": "AI tutor question", "ai_failed": "AI request failed", "ai_feedback": "Feedback on a Kiwi reply",
        "attempt_started": "Attempt started", "submission": "Homework submission", "hint_shown": "Hint shown",
        "paste": "Pasted text", "material_viewed": "Lecture page opened", "grade_released": "Grade released",
    }.get(kind) or {"similar_requested": "Similar exercise requested", "work_opened": "Assignment opened",
                    "answer_revealed": "Answer revealed", "question_skipped": "Exercise skipped", "code_shared": "Code shared with Kiwi",
                    "kiwi_check_answer": "Answer checked in Kiwi", "kiwi_file_action": "Kiwi file action"}.get(
        row["event_type"], row["event_type"].replace("_", " ").capitalize())


def _timeline_kind(row: sqlite3.Row) -> str:
    event_type = row["event_type"]
    if event_type == "question_generated":
        return "similar_generated" if row["practice_mode"] == "similar" else "practice_generated"
    if event_type == "answer_submitted" and row["item_id"]:
        return "item_check"
    return TIMELINE_KINDS.get(event_type, "other")


def _event_detail(db: sqlite3.Connection, row: sqlite3.Row, payload: dict) -> dict:
    detail = {k: v for k, v in payload.items() if k not in ("source",)}
    if row["event_type"] == "question_generated" and row["item_id"]:
        gi = db.execute("SELECT item_json, question_type, difficulty, origin FROM generated_items WHERE class_id = ? AND id = ?",
                        (row["class_id"], row["item_id"])).fetchone()
        if gi:
            item = _loads(gi["item_json"], {})
            detail.update(stem=item.get("prompt") or payload.get("prompt") or "", choices=item.get("choices") or [],
                          difficulty=gi["difficulty"], questionType=gi["question_type"], answer=item.get("answer"),
                          itemTitle=item.get("title") or "")
        else:
            detail.update(stem=payload.get("prompt") or "", choices=payload.get("choices") or [],
                          difficulty=payload.get("difficulty"), questionType=payload.get("type"))
    elif row["event_type"] == "question_generated":
        # Pre-v0.6 generated exercises have no generated_items row: the event payload holds the stem (TEACHER-06).
        detail.update(stem=str(payload.get("prompt") or payload.get("question") or ""), choices=payload.get("choices") or [],
                      difficulty=payload.get("difficulty"), questionType=payload.get("questionType") or payload.get("type"),
                      itemTitle=str(payload.get("title") or ""))
    return detail


def timeline(db: sqlite3.Connection, class_id: str, student_id: str, *, assignment_id: str = "", from_: str | None = None,
             to: str | None = None, unit_id: str = "", where: str = "", after: str = "", limit: int = 100) -> dict:
    """``StudentTimeline``: one assignment (with status) or the full activity timeline, in time order with study sessions."""
    course = course_config.course_for(class_id, db)
    index = assignment_index(db, class_id)
    rec = readers.load_assignment(db, class_id, assignment_id) if assignment_id else None
    if assignment_id and rec is None:
        raise LookupError("Assignment not found")
    clauses = ["e.class_id = ?", "e.student_id = ?",
               "e.event_type NOT IN (" + ", ".join(f"'{t}'" for t in (*TELEMETRY_TYPES, "grade_released")) + ")"]
    params: list[object] = [class_id, student_id]
    if assignment_id:
        clauses.append("(e.attribution_assignment_id = ? OR e.related_assignment_id = ? OR "
                       "CAST(json_extract(e.payload_json, '$.assignmentId') AS TEXT) = ?)")
        params += [assignment_id] * 3
    if from_:
        clauses.append("e.created_at >= ?")
        params.append(from_)
    if to:
        clauses.append("e.created_at < ?")
        params.append(to)
    if where in ("lab", "kiwi"):
        clauses.append("e.source = ?")
        params.append(where)
    if unit_id:
        clauses.append(f"{UNIT_EXPR} = ?")
        params.append(unit_id)
    rows = db.execute(f"""SELECT e.*, {UNIT_EXPR} AS unit FROM events e {EV_JOINS} WHERE {' AND '.join(clauses)}
        ORDER BY e.created_at, e.id""", params).fetchall()
    entries: list[tuple[str, int, int, dict]] = []
    for row in rows:
        entries.append((row["created_at"], 0, row["id"], {"row": row}))
    if where != "kiwi":
        gclauses = ["s.class_id = ?", "s.student_id = ?", "g.action != 'autocheck'"]
        gparams: list[object] = [class_id, student_id]
        if assignment_id:
            gclauses.append("s.assignment_id = ?")
            gparams.append(assignment_id)
        if from_:
            gclauses.append("g.created_at >= ?")
            gparams.append(from_)
        if to:
            gclauses.append("g.created_at < ?")
            gparams.append(to)
        for g in db.execute(f"""SELECT g.*, s.assignment_id, s.attempt FROM grade_events g JOIN submissions s ON s.id = g.submission_id
                WHERE {' AND '.join(gclauses)} ORDER BY g.created_at, g.id""", gparams).fetchall():
            if unit_id and index.get(g["assignment_id"]) and index[g["assignment_id"]].unit_id != unit_id:
                continue
            entries.append((g["created_at"], 1, g["id"], {"grade": g}))
    entries.sort(key=lambda e: (e[0], e[1], e[2]))
    # study sessions over the whole filtered stream (so pages keep consistent indexes)
    sessions: list[int] = []
    previous: datetime | None = None
    current = 0
    for at, _, _, _ in entries:
        moment = dbmod.parse_iso(at)
        if previous is not None and moment is not None and moment - previous >= STUDY_GAP:
            current += 1
        sessions.append(current)
        previous = moment or previous
    start = 0
    if after:
        parts = after.split("|")
        if len(parts) != 3 or not parts[1].isdigit() or not parts[2].isdigit():
            raise ValueError("after must be a timeline cursor")
        cursor = (parts[0], int(parts[1]), int(parts[2]))
        start = next((i for i, e in enumerate(entries) if (e[0], e[1], e[2]) > cursor), len(entries))
    page = entries[start:start + limit]
    events = [_timeline_event(db, class_id, course, index, entry, sessions[start + i]) for i, entry in enumerate(page)]
    has_more = start + limit < len(entries)
    last = page[-1] if page else None
    out: dict[str, object] = {
        "student": {"studentId": student_id, "studentName": student_id},
        "assignment": None, "status": None, "events": events,
        "nextCursor": f"{last[0]}|{last[1]}|{last[2]}" if last and has_more else None, "hasMore": has_more,
    }
    if rec is not None:
        out["assignment"] = {"id": rec.id, "title": rec.title, "kind": rec.kind, "toolPolicy": rec.tool_policy.as_dict()}
        out["status"] = assignment_status(db, rec, student_id)
    return out


def assignment_status(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str) -> dict:
    """``Draft 17/20`` after grading, ``Released 17/20`` after release (from ``grade_status``) [TR03]."""
    from server import grading_rules

    maximum = grading_rules.max_points(rec)
    latest = db.execute("""SELECT * FROM submissions WHERE class_id = ? AND assignment_id = ? AND student_id = ?
        ORDER BY attempt DESC, submitted_at DESC, id DESC LIMIT 1""", (rec.class_id, rec.id, student_id)).fetchone()
    if latest is None:
        cell = readers.gradebook_cell(db, rec, student_id)
        return {"label": cell.get("label") or "Not started", "gradeStatus": None, "score": None, "maxPoints": maximum}
    status = latest["grade_status"] if "grade_status" in latest.keys() else ("released" if latest["grade"] is not None else "ungraded")
    return {"label": grade_status_label(status, latest["grade"], maximum), "gradeStatus": status, "score": latest["grade"],
            "maxPoints": maximum}


def _timeline_event(db: sqlite3.Connection, class_id: str, course: dict, index: dict[str, AssignmentInfo],
                    entry: tuple[str, int, int, dict], session_index: int) -> dict:
    at, source_rank, ident, data = entry
    if "grade" in data:
        g = data["grade"]
        released = g["action"] in ("release", "bulk_release") or (g["action"] in ("legacy_grade", "migrated")
                                                                  and g["status_after"] == "released")
        info = index.get(g["assignment_id"])
        maximum = sum(float(q.get("points") or 0) for _, q in info.questions.values()) if info else 0.0
        status = "released" if released else (g["status_after"] or "draft")
        title = grade_status_label(status, g["total_after"], maximum) if g["total_after"] is not None else (
            "Grade released" if released else "Grade saved")
        if g["action"] == "unrelease":
            title = "Grade unreleased"
        elif g["action"] == "adjust":
            # RV6-m07: the adjustment row written with a save is its own entry ("Late penalty −6 (auto)"), not a
            # second "Draft 13/20"
            title = adjustment_title(_loads(g["items_after_json"], {}))
        return {"id": f"g:{g['id']}", "at": at, "kind": "grade_released" if released else "grade", "questionId": None,
                "questionLabel": "", "title": title,
                "context": {"practiceMode": "homework", "assignmentId": g["assignment_id"],
                            "assignmentLabel": info.title if info else g["assignment_id"], "unitId": info.unit_id if info else ""},
                "detail": {"action": g["action"], "total": g["total_after"], "maxPoints": maximum, "status": g["status_after"],
                           "actorLabel": g["actor_label"], "feedback": g["feedback_after"], "attempt": g["attempt"]},
                "provenance": {"where": "lab"}, "studySessionIndex": session_index}
    row = data["row"]
    payload = _loads(row["payload_json"], {})
    kind = _timeline_kind(row)
    aid = row["attribution_assignment_id"] or row["related_assignment_id"] or ""
    info = index.get(aid)
    qid = row["question_id"] or ""
    if row["item_id"]:
        question_label = "AI item"
    elif info and qid and qid in info.questions:
        question_label = f"Q{info.questions[qid][0]}"
    elif qid and (row["event_type"] == "question_generated" or row["practice_mode"] in ("similar", "free")):
        # a legacy AI-generated exercise id (q-<uuid>) is not a question of the assignment: show its title instead
        question_label = str(payload.get("title") or "")[:120] or "AI item"
    else:
        question_label = qid if info and qid else ""
    where = "kiwi" if row["source"] == "kiwi" else "lab"
    provenance: dict[str, object] = {"where": where}
    if kind in ("ai_turn", "ai_failed"):
        provenance["ai"] = provenance_label(where, "local" if payload.get("aiProvider") == "local" else None)
        if where == "lab":
            provenance["policyLabel"] = policy_label(db, class_id, payload.get("policyVersionId", row["policy_version_id"]), course)
            if payload.get("model"):
                provenance["model"] = payload.get("model")
            call_id = row["ai_call_id"] or payload.get("aiCallId")
            if type(call_id) is int:
                provenance["aiCallId"] = call_id
    if row["checked_by"]:
        provenance["checkedBy"] = row["checked_by"]
    return {"id": f"e:{row['id']}", "at": at, "kind": kind, "questionId": qid or (row["item_id"] or None),
            "questionLabel": question_label, "title": _event_title(kind, payload, row),
            "context": {"practiceMode": row["practice_mode"] or "", "assignmentId": aid or None,
                        "assignmentLabel": (info.title if info else None), "unitId": row["unit"] or ""},
            "detail": _event_detail(db, row, payload), "provenance": provenance, "studySessionIndex": session_index}


# ─── course metrics, trends, curves, time on task (§13.7, §13.9) ───────────────────────────────

def _scalar(db: sqlite3.Connection, scope: Scope, expr: str, *, where: str = "1 = 1", params: Iterable[object] = (),
            joins: bool = False) -> float:
    population, pparams = pop_sql(scope)
    value = db.execute(f"SELECT {expr} FROM events e {EV_JOINS if joins else ''} WHERE {population} AND {where}",
                       [*pparams, *params]).fetchone()[0]
    return value or 0


def _window_values(db: sqlite3.Connection, scope: Scope) -> dict[str, float | None]:
    population, params = pop_sql(scope)
    row = db.execute(f"""SELECT COUNT(DISTINCT CASE WHEN e.category = 'action' THEN e.student_id END) AS active,
        {_AGG_SELECT} FROM events e {EV_JOINS} WHERE {population}""", params).fetchone()
    data = dict(row)
    active = data["active"] or 0
    return {
        "active": active, "attempts": data["attempts"], "actions": data["actions"], "codeRuns": data["codeRuns"],
        "aiQuestions": data["aiQuestions"], "accuracy": _pct(data["correct"], data["checked"]),
        "similar": _pct(data["simCorrect"], data["simChecked"]),
        "attemptsPerActive": round(data["attempts"] / active, 1) if active else None,
        "actionsPerActive": round(data["actions"] / active, 1) if active else None,
    }


def course_metrics(db: sqlite3.Connection, scope: Scope, range_: dict, compare: tuple[str | None, str | None]) -> dict:
    """``CourseMetrics`` with denominators and deltas vs the comparison window."""
    course = course_config.course_for(scope.class_id, db)
    enrolled = len(enrolled_ids(db, unranged(scope)))
    current = _window_values(db, scope)
    previous = _window_values(db, ranged(scope, *compare)) if compare[0] and compare[1] else {}
    prev = lambda key: previous.get(key) if previous else None  # noqa: E731
    active = current["active"]
    published = db.execute("""SELECT kind, COUNT(*) FROM assignments WHERE class_id = ? AND status = 'published'
        AND archived_at IS NULL AND deleted_at IS NULL GROUP BY kind""", (scope.class_id,)).fetchall()
    counts = {row[0]: row[1] for row in published}
    units = course.get("units", [])
    current_unit = course.get("currentUnitId", "")
    linked = scope.linked
    sources = []
    for where in ("lab", "kiwi"):
        row = db.execute(f"""SELECT COALESCE(SUM(e.category = 'action'), 0), COALESCE(SUM(e.event_type = 'code_run'), 0),
            COALESCE(SUM({AI_QUESTION}), 0) FROM events e WHERE {pop_sql(scope)[0]} AND e.source = ?""",
                         [*pop_sql(scope)[1], where]).fetchone()
        sources.append({"where": where, "linked": linked if where == "kiwi" else True, "actions": row[0], "codeRuns": row[1],
                        "aiQuestions": row[2]})
    return {
        "range": range_, "enrolled": enrolled,
        "active": metric(active, prev("active"), {"label": "enrolled", "value": enrolled}),
        "publishedHomework": counts.get("homework", 0), "inClassExercises": counts.get("practice", 0),
        "answerAttemptsPerActive": metric(current["attemptsPerActive"], prev("attemptsPerActive"),
                                          {"label": "active students", "value": active}),
        "loggedActionsPerActive": metric(current["actionsPerActive"], prev("actionsPerActive"),
                                         {"label": "active students", "value": active}),
        "codeRuns": metric(current["codeRuns"], prev("codeRuns")),
        "aiTutorQuestions": metric(current["aiQuestions"], prev("aiQuestions")),
        "autoCheckedAccuracy": metric(current["accuracy"], prev("accuracy")),
        "similarAccuracy": metric(current["similar"], prev("similar")),
        "thisWeekChapter": {"title": unit_title(course, current_unit), "number": chapter_number(course, current_unit) or 0,
                            "completed": sum(1 for u in units if u.get("status") == "completed"), "total": len(units)},
        "sources": sources, "difficulty": difficulty_rows(db, scope),
    }


def difficulty_rows(db: sqlite3.Connection, scope: Scope) -> list[dict]:
    """AI items by requested difficulty: items, observed correct % of server-checked attempts."""
    population, params = pop_sql(scope, "g")
    epop, eparams = pop_sql(unranged(scope))
    rows = db.execute(
        f"""SELECT g.requested_difficulty AS level, COUNT(DISTINCT g.id) AS items,
        (SELECT 100.0 * SUM({CORRECT}) / NULLIF(COUNT(*), 0) FROM events e WHERE {epop} AND {CHECKED}
            AND e.item_id IN (SELECT g2.id FROM generated_items g2 WHERE g2.class_id = g.class_id
                              AND g2.requested_difficulty = g.requested_difficulty)) AS observed
        FROM generated_items g WHERE {population} AND g.origin IN ('free', 'similar') GROUP BY g.requested_difficulty
        ORDER BY level""", [*eparams, *params]).fetchall()
    return [{"level": r["level"], "nominal": r["level"], "items": r["items"],
             "observedCorrectPct": round(r["observed"], 1) if r["observed"] is not None else None} for r in rows]


def _zone(db: sqlite3.Connection, class_id: str) -> ZoneInfo:
    try:
        return ZoneInfo(readers.settings(db, class_id)["schedule"].get("timezone") or course_config.DEFAULT_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return ZoneInfo(course_config.DEFAULT_TIMEZONE)


def first_event_at(db: sqlite3.Connection, scope: Scope) -> str | None:
    population, params = pop_sql(unranged(scope))
    return db.execute(f"SELECT MIN(e.created_at) FROM events e WHERE {population}", params).fetchone()[0]


def week_buckets(db: sqlite3.Connection, scope: Scope, *, max_buckets: int = 52) -> list[tuple[datetime, datetime]]:
    """Monday-aligned week buckets (course time zone) covering ``[from, to)``."""
    tz = _zone(db, scope.class_id)
    end = dbmod.parse_iso(scope.to) if scope.to else dbmod.utcnow()
    start_raw = scope.from_ or first_event_at(db, scope)
    start = dbmod.parse_iso(start_raw) if start_raw else end - timedelta(days=7)
    if start is None or end is None or start >= end:
        return []
    local = start.astimezone(tz)
    monday = (local - timedelta(days=local.isoweekday() - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    buckets = []
    cursor = monday.astimezone(timezone.utc)
    while cursor < end and len(buckets) < 400:
        nxt = (cursor.astimezone(tz).replace(tzinfo=None) + timedelta(days=7)).replace(tzinfo=tz).astimezone(timezone.utc)
        buckets.append((max(cursor, start), min(nxt, end)))
        cursor = nxt
    return buckets[-max_buckets:]


def outages(db: sqlite3.Connection, class_id: str, from_: str | None, to: str | None) -> list[dict]:
    """§13.10 outage periods (client gaps, server errors, Kiwi unreachable) for trend shading.

    INTEGRATION (INSIGHTS handoff D7): delegates to TELEMETRY's ``telemetry.outage_periods`` so Course metrics shades
    exactly the periods Data health lists (one definition of the §13.10 merge).
    """
    from server import telemetry

    return telemetry.outage_periods(db, class_id, from_, to)


def trends(db: sqlite3.Connection, scope: Scope, *, unit_id: str = "") -> dict:
    """Weekly ``TrendBucket``s (inline SVG on Course metrics) with outage periods for shading."""
    buckets = []
    extra = [f"{UNIT_EXPR} = ?"] if unit_id else []
    extra_params = [unit_id] if unit_id else []
    for begin, end in week_buckets(db, scope):
        window = ranged(scope, dbmod.iso_seconds(begin), dbmod.iso_seconds(end))
        population, params = pop_sql(window)
        row = db.execute(f"""SELECT COUNT(DISTINCT CASE WHEN e.category = 'action' THEN e.student_id END) AS active,
            {_AGG_SELECT} FROM events e {EV_JOINS} WHERE {population} {''.join(' AND ' + c for c in extra)}""",
                         [*params, *extra_params]).fetchone()
        minutes = sum(_active_minutes(db, window).values())
        buckets.append({"start": dbmod.iso_seconds(begin), "active": row["active"] or 0, "aiQuestions": row["aiQuestions"],
                        "attempts": row["attempts"], "autoCheckedAccuracy": _pct(row["correct"], row["checked"]),
                        "activeMinutes": minutes})
    first = buckets[0]["start"] if buckets else scope.from_
    return {"buckets": buckets, "outages": outages(db, scope.class_id, first, scope.to)}


def learning_curves(db: sqlite3.Connection, scope: Scope, *, unit_id: str = "", origin: str = "", max_index: int = 10) -> dict:
    """Accuracy by attempt index (1..10) over server-checked attempts per (student, question/item)."""
    population, params = pop_sql(scope)
    clauses = [population, CHECKED]
    if unit_id:
        clauses.append(f"{UNIT_EXPR} = ?")
        params.append(unit_id)
    mode = {"teacher": TEACHER, "ai-free": "e.practice_mode = 'free'", "ai-similar": "e.practice_mode = 'similar'"}.get(origin)
    if mode:
        clauses.append(mode)
    rows = db.execute(f"""SELECT rn AS attemptIndex, COUNT(*) AS n, 100.0 * SUM(c) / COUNT(*) AS accuracy FROM (
        SELECT {CORRECT} AS c, ROW_NUMBER() OVER (PARTITION BY e.student_id, e.attribution_assignment_id,
            COALESCE(NULLIF(e.item_id, ''), e.question_id) ORDER BY e.created_at, e.id) AS rn
        FROM events e {EV_JOINS} WHERE {' AND '.join(clauses)}) WHERE rn <= ? GROUP BY rn ORDER BY rn""",
                      [*params, max_index]).fetchall()
    return {"points": [{"attemptIndex": r["attemptIndex"], "accuracy": round(r["accuracy"], 1) if r["accuracy"] is not None else None,
                        "n": r["n"]} for r in rows]}


def _quantile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * q
    low, high = math.floor(position), math.ceil(position)
    return round(ordered[low] + (ordered[high] - ordered[low]) * (position - low), 2)


def time_on_task(db: sqlite3.Connection, scope: Scope, *, assignment_id: str = "", unit_id: str = "") -> dict:
    """Median / p75 active minutes per question (counted heartbeats on that question, per student)."""
    index = assignment_index(db, scope.class_id)
    targets = [index[assignment_id]] if assignment_id in index else [
        a for a in index.values() if not a.deleted and a.status == "published" and (not unit_id or a.unit_id == unit_id)]
    if assignment_id and assignment_id not in index:
        raise ValueError("Assignment not found")
    population, params = pop_sql(scope)
    out = []
    for info in targets[:20]:
        rows = db.execute(f"""SELECT COALESCE(NULLIF(e.question_id, ''), CAST(json_extract(e.payload_json, '$.questionId') AS TEXT)) AS q,
            e.student_id AS s, COUNT(*) * 0.5 AS minutes FROM events e WHERE {population} AND e.event_type = 'study_heartbeat'
            AND e.heartbeat_counted = 1 AND CAST(json_extract(e.payload_json, '$.assignmentId') AS TEXT) = ? GROUP BY q, s""",
                          [*params, info.id]).fetchall()
        per_question: dict[str, list[float]] = {}
        for row in rows:
            if row["q"]:
                per_question.setdefault(row["q"], []).append(float(row["minutes"]))
        for qid, (position, question) in sorted(info.questions.items(), key=lambda kv: kv[1][0]):
            values = per_question.get(qid, [])
            out.append({"questionId": qid, "assignmentId": info.id, "label": f"{info.short} Q{position}",
                        "prompt": _clip(question.get("prompt"), 80), "medianMinutes": _quantile(values, 0.5),
                        "p75Minutes": _quantile(values, 0.75), "students": len(values)})
    return {"questions": out}


# ─── assignment stats & Home (§13.1) ───────────────────────────────────────────────────────────

def assignment_list_item(db: sqlite3.Connection, scope: Scope, rec: AssignmentRecord, now: datetime) -> dict:
    """``AssignmentListItem`` with ``AssignmentStats`` from ``readers.gradebook_cell`` over the population."""
    from server import grading_rules

    students = [s for s in enrolled_ids(db, unranged(scope)) if readers.in_audience(db, rec, s)]
    stats = {"enrolled": len(students), "submitted": 0, "startedNotSubmitted": 0, "toGrade": 0, "toRelease": 0, "late": 0,
             "missing": 0, "graded": 0, "released": 0, "avgScore": None, "maxPoints": grading_rules.max_points(rec),
             "attempted": 0, "firstTryCorrectPct": None}
    scores = []
    for sid in students:
        cell = readers.gradebook_cell(db, rec, sid, "latest", now)
        state = cell.get("state")
        if cell.get("attempts"):
            stats["submitted"] += 1
        elif cell.get("draftAnswered"):
            stats["startedNotSubmitted"] += 1
        stats["toGrade"] += state in ("submitted_ungraded", "newer_ungraded")
        stats["toRelease"] += state == "draft"
        stats["late"] += bool(cell.get("late"))
        stats["missing"] += state == "missing"
        stats["graded"] += state in ("draft", "released")
        stats["released"] += state == "released"
        if cell.get("score") is not None:
            scores.append(float(cell["score"]))
    if scores:
        stats["avgScore"] = round(sum(scores) / len(scores), 1)
    qids = [q["id"] for q in rec.questions if isinstance(q.get("id"), str) and q["id"]]
    if rec.kind == "practice" and qids:
        # RT-02: server-checked answers to the exercise's current questions, as on the Assignments list, Exercise results
        # and the Gradebook
        current = f"e.question_id IN ({', '.join('?' for _ in qids)})"
        first = _first_try(db, unranged(scope), ExplorerQuery(group="assignments"), "e.attribution_assignment_id", UNIT_EXPR,
                           extra=["e.attribution_assignment_id = ?", current], extra_params=[rec.id, *qids])
        taken = first.get(rec.id, {})
        stats["attempted"] = int(_scalar(db, unranged(scope), "COUNT(DISTINCT e.student_id)",
                                         where=f"{ATTEMPT} AND e.checked_by IN ('server', 'legacy_server') "
                                               f"AND e.attribution_assignment_id = ? AND {current}",
                                         params=[rec.id, *qids]))
        stats["firstTryCorrectPct"] = _pct(taken.get("firstCorrect"), taken.get("takers"))
    return {"id": rec.id, "title": rec.title, "kind": rec.kind, "unitId": rec.unit_id, "status": rec.status,
            "state": readers.assignment_state(rec, now), "questionCount": len(rec.questions), "dueAt": rec.due_at,
            "closeAt": rec.close_at, "latePolicy": rec.late_policy, "hasAttempts": bool(rec.frozen_at), "revisionOf": None,
            "stats": stats, "updatedAt": rec.updated_at}


def needs_action(db: sqlite3.Connection, scope: Scope, now: datetime) -> dict:
    """Home › Needs your action: counts shared with Grading (``readers.grading_counts``) and gradebook cell states."""
    from server import grading_rules

    counts = readers.grading_counts(db, scope.class_id, None, scope.group_id)
    to_release, missing = [], []
    enrolled = enrolled_ids(db, unranged(scope))
    # D8: the Missing work rule of the roster and Needs attention — a homework and its revisions are listed once
    missing_by_rec: dict[str, list[str]] = {}
    originals: dict[str, str | None] = {}
    for sid, items in missing_work(db, scope.class_id, enrolled, now).items():
        for item in items:
            missing_by_rec.setdefault(item.id, []).append(sid)
            originals[item.id] = item.original_title
    for rec in published_homework(db, scope.class_id):
        # WHY (review 2, CORRECTNESS-05/TEACHER-05): drafts wait for release on "Immediately" homework too (a TA without
        # releaseGrades can only save drafts), so every homework with drafts is listed, as Grading counts them.
        count = int(readers.grading_counts(db, scope.class_id, rec.id, scope.group_id).get("toRelease") or 0)
        if count:
            to_release.append({"assignmentId": rec.id, "title": rec.title, "count": count})
        gone = missing_by_rec.get(rec.id, [])
        if gone:
            missing.append({"assignmentId": rec.id, "title": rec.title, "count": len(gone),
                            "started": sum(1 for sid in gone if grading_rules.draft_progress(db, rec, sid)[0] > 0),
                            "originalTitle": originals.get(rec.id)})
    population, params = pop_sql(scope, "s", time_col="submitted_at")
    late = db.execute(f"""SELECT COUNT(*) FROM submissions s WHERE {population} AND s.is_late = 1
        AND s.id IN ({readers.latest_submission_ids_sql()})""", params).fetchone()[0]
    guard_ran = db.execute("""SELECT 1 FROM chat_turns WHERE class_id = ? AND (guard_status != 'not_applicable' OR flagged = 1)
        LIMIT 1""", (scope.class_id,)).fetchone() is not None
    flagged = None
    if guard_ran:
        tpop, tparams = pop_sql(scope, "t")
        flagged = db.execute(f"SELECT COUNT(*) FROM chat_turns t WHERE {tpop} AND t.flagged = 1", tparams).fetchone()[0]
    return {"toGrade": int(counts.get("toGrade") or 0), "toRelease": to_release, "missingPastDue": missing, "late": late,
            "flaggedReplies": flagged}


def ai_status(db: sqlite3.Connection, class_id: str) -> dict:
    """``AiStatus`` as Home shows it (configured/model from the AIRUN adapter, limits from course settings)."""
    import os

    from server import ai, ai_policy, ai_runtime

    limits = readers.settings(db, class_id).get("ai", {})
    allow = [m.strip() for m in os.environ.get("KIWI_MODEL_ALLOWLIST", "").split(",") if m.strip()]
    try:
        concurrency = int(os.environ.get("KIWI_AI_CONCURRENCY", "4"))
    except ValueError:
        concurrency = 4
    return {"configured": ai.available(), "model": ai_runtime.default_model() if ai.available() else None,
            "modelAllowlist": allow, "platformRulesVersion": ai_policy.PLATFORM_RULES_VERSION, "concurrency": concurrency,
            "perStudentPerMinute": int(limits.get("perStudentPerMinute") or 15), "classPerMinute": int(limits.get("classPerMinute") or 120)}


def free_practice_label(course: dict) -> str:
    """``Ch 01–03`` from the course free-practice scope (§12.4 effective access)."""
    units = course.get("units", [])
    open_numbers = [i + 1 for i, u in enumerate(units) if u.get("effectiveAccess", u.get("access")) in ("open", "review")]
    if not open_numbers:
        return "Off"
    if len(open_numbers) == 1:
        return f"Ch {open_numbers[0]:02d}"
    return f"Ch {open_numbers[0]:02d}–{open_numbers[-1]:02d}"


def glance(db: sqlite3.Connection, scope: Scope, compare: tuple[str | None, str | None]) -> dict:
    """This week at a glance: active of enrolled, AI questions, code runs, free-practice items, AI requests turned away."""
    enrolled = len(enrolled_ids(db, unranged(scope)))

    def window(s: Scope) -> dict:
        values = _window_values(db, s)
        gpop, gparams = pop_sql(s, "g")
        items = db.execute(f"SELECT COUNT(*) FROM generated_items g WHERE {gpop} AND g.origin = 'free'", gparams).fetchone()[0]
        cpop, cparams = pop_sql(s, "c", time_col="requested_at")
        away = db.execute(f"""SELECT COUNT(*) FROM ai_calls c WHERE {cpop}
            AND c.status IN ('rate_limited', 'busy', 'unavailable', 'daily_quota')""", cparams).fetchone()[0]
        return {**values, "items": items, "away": away}

    now_values = window(scope)
    before = window(ranged(scope, *compare)) if compare[0] and compare[1] else None
    prev = lambda key: before[key] if before else None  # noqa: E731
    return {"activeStudents": metric(now_values["active"], prev("active"), {"label": "enrolled", "value": enrolled}),
            "enrolled": enrolled, "aiQuestions": metric(now_values["aiQuestions"], prev("aiQuestions")),
            "codeRuns": metric(now_values["codeRuns"], prev("codeRuns")),
            "freePracticeItems": metric(now_values["items"], prev("items")),
            "aiTurnedAway": metric(now_values["away"], prev("away"))}


def home(db: sqlite3.Connection, scope: Scope, range_: dict, compare: tuple[str | None, str | None]) -> dict:
    """``HomeData`` (§13.1)."""
    from server import ai_policy, attention, conversations

    now = dbmod.utcnow()
    course = course_config.course_for(scope.class_id, db)
    current = course.get("currentUnitId", "")
    resolved = ai_policy.resolve(db, scope.class_id, current)
    sync = db.execute("SELECT last_synced FROM kiwi_sync WHERE class_id = ?", (scope.class_id,)).fetchone()
    soon = now + timedelta(days=7)
    listed = []
    for row in db.execute("""SELECT * FROM assignments WHERE class_id = ? AND status = 'published' AND archived_at IS NULL
            AND deleted_at IS NULL ORDER BY COALESCE(due_at, close_at, created_at), id""", (scope.class_id,)):
        rec = readers.record_from_row(row)
        due = dbmod.parse_iso(rec.due_at) if rec.due_at else None
        closed_at = dbmod.parse_iso(rec.close_at) if rec.close_at else None
        state = readers.assignment_state(rec, now)
        due_soon = due is not None and now <= due <= soon
        start = dbmod.parse_iso(scope.from_) if scope.from_ else None
        closed_in_range = state in ("closed", "past_due") and (
            (closed_at and (start is None or closed_at >= start)) or (due and (start is None or due >= start)))
        if due_soon or closed_in_range:
            listed.append(rec)
    items = [assignment_list_item(db, scope, rec, now) for rec in listed[:6]]
    attention_data = attention.evaluate(db, scope, now=now)
    reteach = attention.reteach(db, scope)
    asked = conversations.digest(db, scope, range_, limit_recent=0)
    number = chapter_number(course, current) or 0
    return {
        "range": range_,
        "header": {"courseTitle": course.get("title", ""),
                   "thisWeek": {"unitId": current, "title": unit_title(course, current), "index": number,
                                "total": len(course.get("units", []))},
                   "freePracticeLabel": free_practice_label(course),
                   "aiRules": {"unitId": current, "label": resolved.scope_label, "customized": resolved.source != "platform",
                               "updatedAt": resolved.updated_at},
                   "aiStatus": ai_status(db, scope.class_id),
                   "kiwi": {"linked": scope.linked, "lastSynced": sync[0] if sync else None}},
        "needsAction": needs_action(db, scope, now),
        "assignments": items,
        "attention": {"students": attention_data["students"][:5], "total": len(attention_data["students"]),
                      "rules": [attention.describe(r) for r in attention_data["rules"]["rules"] if r["enabled"]]},
        "reteach": {"candidates": reteach["candidates"][:5], "marked": [m for m in reteach["marked"] if not m["resolvedAt"]]},
        "askedAi": {"repeated": [{"prompt": r["prompt"], "students": r["students"], "occurrences": r["occurrences"],
                                  "threadKeys": [x["threadKey"] for x in r["examples"]]} for r in asked["repeated"][:3]],
                    "topics": [{"label": t["label"], "count": t["turns"]} for t in asked["topics"][:4]],
                    "flaggedFinalAnswer": len(asked["flagged"])},
        "glance": glance(db, scope, compare),
    }


# ─── v0.5.1 legacy queries (§6.9; unchanged except TR02: distribution grouped by question) ─────

def metrics(db, class_id, course):
    total = dict(
        db.execute(
            """SELECT COUNT(DISTINCT studentId) engagedStudents,COALESCE(SUM(interactions),0) interactions,
        COALESCE(SUM(attempts),0) attempts,COALESCE(SUM(codeRuns),0) codeRuns,COALESCE(SUM(aiQuestions),0) aiQuestions,
        COUNT(*) sessions FROM learning_sessions WHERE classId=?""",
            (class_id,),
        ).fetchone()
    )
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(
        timespec="seconds"
    )
    total["activeStudents"] = db.execute(
        "SELECT COUNT(DISTINCT studentId) FROM learning_sessions WHERE classId=? AND lastActive>=?",
        (class_id, cutoff),
    ).fetchone()[0]
    total["publishedAssignments"] = db.execute(
        "SELECT COUNT(*) FROM assignments WHERE class_id=? AND status='published' AND kind='homework'",
        (class_id,),
    ).fetchone()[0]
    n = total["engagedStudents"]
    total["averageAttempts"] = round(total["attempts"] / n, 2) if n else 0
    total["averageInteractions"] = round(total["interactions"] / n, 2) if n else 0
    total["currentUnitId"] = course["currentUnitId"]
    total["completedUnits"] = sum(u["status"] == "completed" for u in course["units"])
    total["totalUnits"] = len(course["units"])
    total["sources"] = [dict(r) for r in db.execute("""SELECT source,COUNT(*) sessions,
        SUM(interactions) interactions,SUM(codeRuns) codeRuns,SUM(aiQuestions) aiQuestions
        FROM learning_sessions WHERE classId=? GROUP BY source""", (class_id,))]
    return total


def filters(args):
    sql, params = ["s.classId=?"], [args["classId"]]
    for key in ("studentId", "unitId", "assignmentId", "questionId", "kind", "source", "materialId"):
        if args.get(key):
            sql.append(f"s.{key}=?")
            params.append(
                "" if key == "unitId" and args[key] == "unattributed" else args[key]
            )
    if args.get("search"):
        sql.append(
            "(instr(lower(s.studentName),lower(?))>0 OR instr(lower(s.studentId),lower(?))>0)"
        )
        params.extend([args["search"][:100]] * 2)
    if args.get("active") == "7d":
        sql.append("s.lastActive>=?")
        params.append(
            (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(
                timespec="seconds"
            )
        )
    activity = {
        "attempts": "s.attempts>0",
        "runs": "s.codeRuns>0",
        "questions": "s.aiQuestions>0",
        "errors": "s.codeErrors>0",
        "success": "s.codeSuccesses>0",
        "unknown": "s.codeRuns>s.codeErrors+s.codeSuccesses",
        "reading": "s.kind='reading'",
    }
    if args.get("activity") in activity:
        sql.append(activity[args["activity"]])
    if args.get("published") == "homework":
        sql.append(
            "EXISTS(SELECT 1 FROM assignments a WHERE a.class_id=s.classId AND a.id=s.assignmentId AND a.kind='homework' AND a.status='published')"
        )
    return " AND ".join(sql), params


def table(db, args):
    group = args.get("group", "students")
    if group not in ("students", "sessions", "questions", "topics", "assignments", "materials"):
        raise ValueError("Unsupported table view")
    page, size = max(int(args.get("page", "1")), 1), min(
        max(int(args.get("pageSize", "25")), 1), 100
    )
    where, params = filters(args)
    common = ",".join(f"COALESCE(SUM(s.{c}),0) {c}" for c in COUNTERS)
    keys = {
        "students": ("s.studentId", "s.studentName"),
        "sessions": ("s.id", "s.title"),
        "questions": ("s.unitId,s.assignmentId,s.questionId", "MAX(s.title)"),
        "topics": ("s.unitId", "s.unitId"),
        "assignments": ("s.assignmentId", "COALESCE(a.title,'Unassigned practice')"),
        "materials": ("s.materialId", "COALESCE(m.title,s.materialId)"),
    }
    key, label = keys[group]
    extra = ""
    if group == "questions":
        extra = " AND s.questionId!=''"
    if group == "assignments":
        extra = " AND s.assignmentId!=''"
    if group == "materials":
        extra = " AND s.materialId!=''"
    if group == "sessions":
        base = f"SELECT s.*,1 students,1 sessions,CASE WHEN s.checked>0 THEN 100.0*s.correct/s.checked ELSE NULL END accuracy,1.0*s.attempts averageAttempts,1.0*s.aiQuestions averageQuestions FROM learning_sessions s WHERE {where}{extra}"
    else:
        base = f"""SELECT {key}, {label} label,{common},COUNT(DISTINCT s.studentId) students,COUNT(*) sessions,
            MAX(s.lastActive) lastActive,100.0*SUM(s.correct)/NULLIF(SUM(s.checked),0) accuracy,
            1.0*SUM(s.attempts)/NULLIF(COUNT(DISTINCT s.studentId),0) averageAttempts,
            1.0*SUM(s.aiQuestions)/NULLIF(COUNT(DISTINCT s.studentId),0) averageQuestions
            FROM learning_sessions s LEFT JOIN assignments a ON a.id=s.assignmentId AND a.class_id=s.classId
            LEFT JOIN kiwi_materials m ON m.id=s.materialId AND m.class_id=s.classId
            WHERE {where}{extra} GROUP BY {key}"""
    # Include enrolled, inactive students, without inventing activity or correctness.
    if group == "students" and not any(
        args.get(k)
        for k in (
            "unitId",
            "assignmentId",
            "questionId",
            "kind",
            "active",
            "activity",
            "published",
            "source",
            "materialId",
        )
    ):
        roster_where = "r.class_id=?"
        roster_params = [args["classId"]]
        if args.get("studentId"):
            roster_where += " AND r.student_id=?"
            roster_params.append(args["studentId"])
        if args.get("search"):
            roster_where += "(PLACEHOLDER)"
            roster_where = roster_where.replace(
                "(PLACEHOLDER)",
                " AND (instr(lower(r.student_name),lower(?))>0 OR instr(lower(r.student_id),lower(?))>0)",
            )
            roster_params += [args["search"][:100]] * 2
        base += f""" UNION ALL SELECT r.student_id studentId,r.student_name label,{','.join('0' for _ in COUNTERS)},0 students,0 sessions,
            NULL lastActive,NULL accuracy,0 averageAttempts,0 averageQuestions FROM roster r WHERE {roster_where}
            AND NOT EXISTS(SELECT 1 FROM learning_sessions s WHERE s.classId=r.class_id AND s.studentId=r.student_id)"""
        params += roster_params
    if (
        group == "assignments"
        and args.get("published") == "homework"
        and not any(
            args.get(k)
            for k in (
                "studentId",
                "unitId",
                "questionId",
                "kind",
                "active",
                "activity",
                "search",
                "source",
                "materialId",
            )
        )
    ):
        assignment_clause = " AND a.id=?" if args.get("assignmentId") else ""
        base += f""" UNION ALL SELECT a.id assignmentId,a.title label,{','.join('0' for _ in COUNTERS)},0 students,0 sessions,
            NULL lastActive,NULL accuracy,0 averageAttempts,0 averageQuestions FROM assignments a
            WHERE a.class_id=? AND a.status='published' AND a.kind='homework'{assignment_clause}
            AND NOT EXISTS(SELECT 1 FROM learning_sessions s WHERE s.classId=a.class_id AND s.assignmentId=a.id)"""
        params += [args["classId"]] + (
            [args["assignmentId"]] if args.get("assignmentId") else []
        )
    count = db.execute(f"SELECT COUNT(*) FROM ({base})", params).fetchone()[0]
    sort = args.get("sort", "lastActive")
    allowed = {
        *COUNTERS,
        "lastActive",
        "accuracy",
        "averageAttempts",
        "averageQuestions",
        "sessions",
        "students",
        "label",
        "codeSuccesses",
    }
    if sort not in allowed:
        raise ValueError("Unsupported sort column")
    if group == "sessions" and sort == "label":
        sort = "title"
    direction = "ASC" if args.get("direction") == "asc" else "DESC"
    tie = (
        "id"
        if group == "sessions"
        else (
            "studentId"
            if group == "students"
            else (
                "unitId,assignmentId,questionId"
                if group == "questions"
                else "unitId" if group == "topics" else "materialId" if group == "materials" else "assignmentId"
            )
        )
    )
    order_column = sort
    rows = db.execute(
        f"SELECT * FROM ({base}) ORDER BY {order_column} {direction} NULLS LAST,{tie} LIMIT ? OFFSET ?",
        [*params, size, (page - 1) * size],
    ).fetchall()
    return {
        "rows": [dict(r) for r in rows],
        "total": count,
        "page": page,
        "pageSize": size,
    }


def session_events(db, class_id, sid, before=0):
    session = db.execute(
        "SELECT * FROM learning_sessions WHERE classId=? AND id=?", (class_id, sid)
    ).fetchone()
    if not session:
        raise ValueError("Session not found")
    cursor_time = ""
    if before:
        cursor = db.execute("SELECT created_at FROM events WHERE class_id=? AND learning_session_id=? AND id=?", (class_id, sid, before)).fetchone()
        if not cursor:
            raise ValueError("Session event cursor is invalid")
        cursor_time = cursor[0]
    rows = db.execute(
        "SELECT * FROM events WHERE class_id=? AND learning_session_id=? AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT 101",
        (class_id, sid, cursor_time, before),
    ).fetchall()
    events = [
        {
            "id": r["id"],
            "type": r["event_type"],
            "createdAt": r["created_at"],
            "source": r["source"],
            "upstreamId": r["upstream_id"],
            "payload": json.loads(r["payload_json"]),
        }
        for r in rows[:100]
    ]
    return {"session": dict(session), "events": events, "hasMore": len(rows) > 100}


def question_theme(prompt):
    text = str(prompt or "").casefold()
    rules = (
        ("Missing values", r"\bna\b|missing|na\.rm|is\.na"),
        ("Indexing", r"index|subscript|bracket|one.based"),
        ("Joins and keys", r"\bjoin|\bmerge|tailnum|join.*key"),
        ("Filtering and conditions", r"\bfilter|logical|condition|subset"),
        ("Means and grouped summaries", r"\bmean\b|average|aggregate|group|sum\("),
        ("Data types and import", r"\bimport|\bcsv|read\.|numeric|character|data type"),
        ("Text preprocessing", r"\btokens\b|\btokeniz|unnest_tokens|stop.?word|lowercase|corpus|lyrics"),
        ("Networks", r"\bedge|\bnode|degree|reciproc|network"),
        ("R errors and debugging", r"\berror|not found|unexpected|debug"),
    )
    return next((label for label, pattern in rules if re.search(pattern, text)), None)


def evidence(db, args):
    db.create_function("question_theme", 1, question_theme)
    db.create_function(
        "normalize_question",
        1,
        lambda text: " ".join(str(text or "").casefold().split()),
    )
    where, params = filters(args)
    # Aggregate all matching answers; only the displayed evidence is paginated.
    distribution = db.execute(
        # TR02/AU-D4-17: answers are grouped per question, never pooled across Q1 and Q2.
        f"""SELECT COALESCE(e.question_id,'') questionId,json_extract(e.payload_json,'$.answer') answer,COUNT(*) attempts,
        COUNT(DISTINCT e.student_id) students FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id
        WHERE {where} AND e.event_type='answer_submitted' GROUP BY questionId,answer ORDER BY questionId,attempts DESC,answer LIMIT 50""",
        params,
    ).fetchall()
    common = db.execute(
        f"""SELECT normalize_question(json_extract(e.payload_json,'$.prompt')) normalized,
        MIN(json_extract(e.payload_json,'$.prompt')) prompt,COUNT(*) occurrences,COUNT(DISTINCT e.student_id) students
        FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id
        WHERE {where} AND e.event_type='ai_question' AND json_extract(e.payload_json,'$.ok') IS NOT 0
        GROUP BY normalized HAVING COUNT(DISTINCT e.student_id)>1 ORDER BY students DESC,occurrences DESC LIMIT 20""",
        params,
    ).fetchall()
    themes = db.execute(
        f"""SELECT question_theme(json_extract(e.payload_json,'$.prompt')) theme,
        COUNT(*) questions,COUNT(DISTINCT e.student_id) students FROM events e
        JOIN learning_sessions s ON s.id=e.learning_session_id WHERE {where} AND e.event_type='ai_question'
        AND json_extract(e.payload_json,'$.ok') IS NOT 0 GROUP BY theme
        HAVING theme IS NOT NULL AND COUNT(DISTINCT e.student_id)>1 ORDER BY students DESC,questions DESC LIMIT 10""",
        params,
    ).fetchall()
    shared = []
    for theme in themes:
        examples = db.execute(
            f"""SELECT e.student_id studentId,e.student_name studentName,json_extract(e.payload_json,'$.prompt') prompt,s.id sessionId
            FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id WHERE {where}
            AND e.event_type='ai_question' AND question_theme(json_extract(e.payload_json,'$.prompt'))=?
            ORDER BY e.id DESC LIMIT 3""",
            [*params, theme["theme"]],
        ).fetchall()
        shared.append({**dict(theme), "examples": [dict(r) for r in examples]})
    after = max(int(args.get("beforeId", "0")), 0)
    raw = db.execute(
        f"""SELECT e.id,e.student_id studentId,e.student_name studentName,e.created_at createdAt,e.payload_json,s.id sessionId
        FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id WHERE {where} AND e.event_type='ai_question'
        AND (?=0 OR e.id<?) ORDER BY e.id DESC LIMIT 26""",
        [*params, after, after],
    ).fetchall()
    questions = [
        {
            **{k: r[k] for k in ("id", "studentId", "studentName", "createdAt", "sessionId")},
            "payload": json.loads(r["payload_json"]),
        }
        for r in raw[:25]
    ]
    distribution = [dict(r) for r in distribution]
    if args.get("questionId"):
        choices = []
        if args.get("assignmentId"):
            work = db.execute(
                "SELECT questions_json FROM assignments WHERE class_id=? AND id=?",
                (args["classId"], args["assignmentId"]),
            ).fetchone()
            if work:
                choices = next(
                    (
                        q.get("choices", [])
                        for q in json.loads(work[0])
                        if q["id"] == args["questionId"]
                    ),
                    [],
                )
        if not choices:
            generated = db.execute(
                "SELECT e.payload_json FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id WHERE s.classId=? AND s.questionId=? AND e.event_type='question_generated' ORDER BY e.id DESC LIMIT 1",
                (args["classId"], args["questionId"]),
            ).fetchone()
            if generated:
                choices = json.loads(generated[0]).get("choices", [])
        for choice in choices:
            if not any(d["answer"] == choice for d in distribution):
                distribution.append({"questionId": args["questionId"], "answer": choice, "attempts": 0, "students": 0})
    total_attempts = db.execute(
        f"SELECT COUNT(*) FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id WHERE {where} AND e.event_type='answer_submitted'",
        params,
    ).fetchone()[0]
    for d in distribution:
        d["share"] = (
            round(100 * d["attempts"] / total_attempts, 1) if total_attempts else 0
        )
    return {
        "sharedTopics": shared,
        "distribution": distribution,
        "commonQuestions": [dict(r) for r in common],
        "questions": questions,
        "hasMore": len(raw) > 25,
    }
