"""Assignment authoring, lifecycle, versions, files, student visibility and in-class checks (owned by ASSESS).

Spec §9.1, §4.5.1–4.5.3, §6.3. Every mutation runs inside the caller's ``write_tx`` and re-reads the
assignment inside that transaction, so "edit questions" and "first attempt" cannot interleave (ASSESS-17).
Preview rows (``is_preview=1`` / ``preview-*`` ids) never count as attempts: they do not freeze, block
unpublish/delete or count towards ``attemptCount`` (§3.4).

Legacy v0.5.1 helpers (``validate_work``, ``serialize_work``, ``list_work``, ``get_work``, ``save_work``,
``set_status``, ``work_options``, ``check_practice``, ``work_page``) keep their names and shapes because
``server/workflows.py`` and ``server/grading.py`` import them.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import sqlite3
import uuid
from datetime import datetime, timedelta
from typing import Any, Callable

from server import db as dbmod
from server import identity as identitymod
from server import judging, readers
from server.contracts import AssignmentRecord
from server.router import ID_PATTERN, ApiError

ValidId = Callable[[object], bool]

KINDS = ("practice", "homework")
QUESTION_TYPES = ("choice", "fill", "predict", "complete", "text")
LATE_MODES = ("not_accepted", "accept_until", "accept_marked")
GRADES_VISIBILITY = ("immediately", "on_release")
SOLUTIONS_VISIBILITY = ("never", "after_submit", "after_due", "after_release")
# Decision D2: new homework shows solutions (and ends answer protection) once it closes; "never" stays an explicit choice.
DEFAULT_SOLUTIONS_VISIBILITY = {"homework": "after_due", "practice": "never"}
EXPIRY_MODES = ("submit_marked", "reject")
TAG_PATTERN = re.compile(r"^[a-z0-9:_ -]{1,40}$")
FILE_NAME = re.compile(r"\.(csv|rds|txt|md|qmd|pdf|r|zip)$", re.I)
AI_REFERENCE_NAME = re.compile(r"\.(md|qmd|txt)$", re.I)
MAX_FILE_BYTES = 3_000_000
MAX_QUESTIONS = 30
#: keys of a stored question that students never receive (§6.3 redaction; ``explanation`` is the legacy rubric field)
STAFF_QUESTION_KEYS = frozenset({"answer", "referenceCode", "expectedOutput", "acceptedAnswers", "graderRubric", "grading",
                                 "tags", "explanation"})
#: settings whose change bumps ``version`` with a ``settings_edit`` snapshot (§6.3 PUT, ASSESS-20)
SETTINGS_FIELDS = ("due_at", "open_at", "close_at", "late_policy", "max_attempts", "time_limit", "grades_visibility",
                   "solutions_visibility", "tool_policy", "audience")
FROZEN_MESSAGE = ("Students have started this assignment. Questions are locked to keep their attempts and grades "
                  "consistent. Create a revision instead.")
_UNSET: Any = object()


# -- small validators ------------------------------------------------------------------------------
def _validate_text(value: object, label: str, maximum: int, minimum: int = 0) -> str:
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise ValueError(f"{label} must contain {minimum}–{maximum} characters")
    return value.strip()


def _optional_text(value: object, label: str, maximum: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError(f"{label} must be text of at most {maximum:,} characters")
    return value.strip()


def _iso(value: object, label: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be an ISO date-time or null")
    try:
        parsed = dbmod.parse_iso(value)
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO date-time or null") from exc
    return dbmod.iso_seconds(parsed) if parsed else None


def _int(value: object, label: str, lo: int, hi: int, *, allow_none: bool = True) -> int | None:
    if value is None and allow_none:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value or not lo <= value <= hi:
        raise ValueError(f"{label} must be a whole number from {lo} to {hi}")
    return int(value)


def _number(value: object, label: str, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi:
        raise ValueError(f"{label} must be a number from {lo:g} to {hi:g}")
    return float(value) if not float(value).is_integer() else int(value)


def _bool(value: object, label: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{label} must be true or false")
    return value


def _dt(value: str | None) -> datetime | None:
    try:
        return dbmod.parse_iso(value)
    except ValueError:
        return None


def _loads(value: object, default: Any) -> Any:
    if not isinstance(value, str) or not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


# -- questions (Question JSON v2, §4.5.2) ------------------------------------------------------------
def _string_list(value: object, label: str, max_items: int, max_len: int) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
        raise ValueError(f"{label} must be a list of text values")
    items = [v.strip() for v in value if v.strip()]
    if len(items) > max_items:
        raise ValueError(f"{label}: at most {max_items} allowed")
    if any(len(v) > max_len for v in items):
        raise ValueError(f"{label}: each entry can have at most {max_len:,} characters")
    seen: list[str] = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


def _legacy_complete(answer: str) -> tuple[str, str]:
    """(referenceCode, expectedOutput) for a legacy complete-code ``answer`` (§4.5.2)."""
    if "<-" in answer or "(" in answer or "\n" in answer:
        return answer, ""
    return "", answer


def clean_question(q: object, index: int, kind: str, valid_id: ValidId) -> dict:
    """Validate one question and return its canonical v2 dict (every key present, fixed order)."""
    where = f"Question {index}"
    if not isinstance(q, dict):
        raise ValueError(f"{where}: invalid question format")
    qid = q.get("id") or f"q-{uuid.uuid4().hex[:12]}"
    if not valid_id(qid):
        raise ValueError(f"{where}: question id is invalid")
    qtype = q.get("type")
    if qtype not in QUESTION_TYPES:
        raise ValueError(f"{where}: unsupported question type")
    points = q.get("points", 10)
    if not isinstance(points, (int, float)) or isinstance(points, bool) or not 0 < points <= 100:
        raise ValueError(f"{where}: points must be greater than 0 and no more than 100")
    prompt = _validate_text(q.get("prompt"), f"{where}: question prompt", 4000, 1)
    raw_choices = q.get("choices") or []
    choices: list[str] = []
    if qtype == "choice":
        if not isinstance(raw_choices, list) or any(not isinstance(c, str) for c in raw_choices):
            raise ValueError(f"{where}: choices must be a list of text values")
        choices = [c.strip() for c in raw_choices]
        if any(not c for c in choices):
            raise ValueError(f"{where}: choices must not be empty")
        if len(set(choices)) != len(choices):
            raise ValueError(f"{where}: choices must be unique")
        if not 2 <= len(choices) <= 8:
            raise ValueError(f"{where}: multiple choice questions need 2–8 choices")
        if any(len(c) > 300 for c in choices):
            raise ValueError(f"{where}: each choice can have at most 300 characters")
    answer = _optional_text(q.get("answer"), f"{where}: reference answer", 12000)
    if qtype == "choice" and answer and answer not in choices:
        raise ValueError(f"{where}: the reference answer must be one of the choices")
    reference_code = _optional_text(q.get("referenceCode"), f"{where}: reference solution code", 12000)
    expected_output = _optional_text(q.get("expectedOutput"), f"{where}: expected output", 12000)
    if qtype == "complete" and answer and not reference_code and not expected_output:
        reference_code, expected_output = _legacy_complete(answer)
    if qtype not in ("complete", "predict"):
        reference_code = ""
    if qtype != "complete" and qtype != "predict":
        expected_output = ""
    accepted = _string_list(q.get("acceptedAnswers"), f"{where}: accepted answers", 20, 2000)
    grading_in = q.get("grading") if isinstance(q.get("grading"), dict) else {}
    if q.get("grading") is not None and not isinstance(q.get("grading"), dict):
        raise ValueError(f"{where}: auto-check settings are invalid")
    case_sensitive = _bool(grading_in.get("caseSensitive", True), f"{where}: Match case")
    whitespace = grading_in.get("whitespace", "outside_strings")
    if whitespace not in judging.WHITESPACE_MODES:
        raise ValueError(f"{where}: whitespace must be outside_strings, collapse or exact")
    reference = answer or expected_output
    if "numericTolerance" in grading_in:
        tolerance = grading_in["numericTolerance"]
        tolerance = None if tolerance is None else _number(tolerance, f"{where}: numeric tolerance", 0, 1)
    else:
        tolerance = judging.DEFAULT_TOLERANCE if judging._numbers(reference) is not None else None
    auto_check = qtype != "text" and _bool(grading_in.get("autoCheck", True), f"{where}: auto-check")
    max_attempts = None
    hints = _string_list(q.get("hints"), f"{where}: hints for students", 3, 1000)
    if kind == "practice":
        max_attempts = _int(q.get("maxAttempts"), f"{where}: attempts allowed", 1, 20)
    else:
        hints = []
    student_explanation = _optional_text(q.get("studentExplanation"), f"{where}: explanation for students", 4000)
    grader_rubric = _optional_text(q.get("graderRubric"), f"{where}: grading rubric", 4000)
    legacy_explanation = _optional_text(q.get("explanation"), f"{where}: explanation", 4000)
    if legacy_explanation and "studentExplanation" not in q and "graderRubric" not in q:
        if kind == "homework":
            grader_rubric = legacy_explanation
        else:
            student_explanation = legacy_explanation
    raw_tags = q.get("tags")
    if raw_tags is not None and (not isinstance(raw_tags, list) or any(not isinstance(t, str) for t in raw_tags)):
        raise ValueError(f"{where}: tags must be a list of text values")
    if len([t for t in raw_tags or [] if t.strip()]) > 8:
        raise ValueError(f"{where}: at most 8 tags allowed")
    tags: list[str] = []
    for tag in raw_tags or []:
        value = tag.strip().lower()
        if not value:
            continue
        if not TAG_PATTERN.fullmatch(value):
            raise ValueError(f"{where}: tags may use only a–z, 0–9, ':', '_', '-' and spaces (1–40 characters each)")
        if value not in tags:
            tags.append(value)
    if len(tags) > 8:
        raise ValueError(f"{where}: at most 8 tags allowed")
    if kind == "practice" and auto_check:
        has_reference = bool(answer or expected_output or reference_code or accepted)
        if not has_reference:
            raise ValueError(f"{where}: in-class exercises need a reference answer for auto-checked questions")
    return {
        "id": qid, "type": qtype, "prompt": prompt, "points": points, "choices": choices,
        "starterCode": _optional_text(q.get("starterCode"), f"{where}: starter code", 12000),
        "answer": answer, "referenceCode": reference_code, "expectedOutput": expected_output, "acceptedAnswers": accepted,
        "grading": {"caseSensitive": case_sensitive, "whitespace": whitespace, "numericTolerance": tolerance,
                    "autoCheck": auto_check},
        "maxAttempts": max_attempts, "hints": hints, "studentExplanation": student_explanation,
        "graderRubric": grader_rubric, "tags": tags,
    }


def clean_questions(questions: object, kind: str, valid_id: ValidId) -> list[dict]:
    if not isinstance(questions, list) or not 1 <= len(questions) <= MAX_QUESTIONS:
        raise ValueError(f"An assignment needs 1–{MAX_QUESTIONS} questions")
    clean = [clean_question(q, i + 1, kind, valid_id) for i, q in enumerate(questions)]
    ids = [q["id"] for q in clean]
    if len(set(ids)) != len(ids):
        raise ValueError("Question ids must be unique")
    return clean


def view_question(question: dict, kind: str) -> dict:
    """Canonical v2 dict for a stored (possibly legacy) question, without validation errors."""
    q = readers.v2_question(question, kind)
    qtype = q.get("type")
    reference_code = q.get("referenceCode") or ""
    expected = q.get("expectedOutput") or ""
    grading = dict(q.get("grading") or {})
    if qtype == "text":
        grading["autoCheck"] = False
    return {
        "id": q.get("id"), "type": qtype, "prompt": q.get("prompt", ""), "points": q.get("points", 10),
        "choices": list(q.get("choices") or []) if qtype == "choice" else [], "starterCode": q.get("starterCode") or "",
        "answer": q.get("answer") or "", "referenceCode": reference_code if qtype in ("complete", "predict") else "",
        "expectedOutput": expected if qtype in ("complete", "predict") else "",
        "acceptedAnswers": list(q.get("acceptedAnswers") or []), "grading": grading,
        "maxAttempts": q.get("maxAttempts") if kind == "practice" else None,
        "hints": list(q.get("hints") or []) if kind == "practice" else [],
        "studentExplanation": q.get("studentExplanation") or "", "graderRubric": q.get("graderRubric") or "",
        "tags": list(q.get("tags") or []),
    }


def _frozen_view(questions: list[dict]) -> str:
    """What students depend on: everything except staff-only rubric and tags (editable after attempts)."""
    return dbmod.json_dumps([{k: v for k, v in q.items() if k not in ("graderRubric", "tags")} for q in questions])


# -- assignment input (AssignmentInput, §7.4) -------------------------------------------------------
def _tool_policy(value: object, kind: str, fallback: dict | None) -> dict:
    base = fallback or (readers.HOMEWORK_TOOL_DEFAULT if kind == "homework" else readers.INCLASS_TOOL_DEFAULT)
    if value is None:
        return dict(base)
    if not isinstance(value, dict):
        raise ValueError("Student help settings are invalid")
    policy = dict(base)
    for key in ("rWorkspace", "allowRunPredict", "similarPractice"):
        if key in value:
            policy[key] = _bool(value[key], f"Student help: {key}")
    if "askKiwi" in value:
        if value["askKiwi"] not in readers.ASK_KIWI_MODES:
            raise ValueError("Student help: Ask Kiwi must be off, hints_only, explain_concepts or worked_examples")
        policy["askKiwi"] = value["askKiwi"]
    return policy


def _late_policy(value: object, fallback: dict | None) -> dict:
    if value is None:
        return dict(fallback or readers.LATE_POLICY_DEFAULT)
    if not isinstance(value, dict):
        raise ValueError("Late policy is invalid")
    merged = {**readers.LATE_POLICY_DEFAULT, **value}
    if merged["mode"] not in LATE_MODES:
        raise ValueError("Late policy mode must be not_accepted, accept_until or accept_marked")
    until = _iso(merged.get("untilAt"), "Late policy: accepted until")
    if merged["mode"] == "accept_until" and until is None:
        raise ValueError("Late policy: set the date until which late submissions are accepted")
    return {"mode": merged["mode"], "untilAt": until if merged["mode"] == "accept_until" else None,
            "graceMinutes": _int(merged.get("graceMinutes", 0), "Late policy: grace minutes", 0, 120, allow_none=False),
            "penaltyPctPerDay": _number(merged.get("penaltyPctPerDay", 0), "Late policy: penalty per day", 0, 100)}


def _time_limit(value: object) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("Time limit is invalid")
    if value.get("onExpiry") not in EXPIRY_MODES:
        raise ValueError("Time limit: when time runs out must be submit_marked or reject")
    return {"minutes": _int(value.get("minutes"), "Time limit minutes", 5, 600, allow_none=False),
            "onExpiry": value["onExpiry"]}


def _audience(db: sqlite3.Connection, class_id: str, value: object, fallback: dict | None) -> dict:
    if value is None:
        return dict(fallback or {"type": "all"})
    if not isinstance(value, dict) or value.get("type") not in ("all", "groups"):
        raise ValueError("Assign to must be all students or groups")
    if value["type"] == "all":
        return {"type": "all"}
    ids = value.get("groupIds")
    if not isinstance(ids, list) or not ids or len(ids) > 50 or any(not isinstance(g, str) for g in ids):
        raise ValueError("Assign to: choose at least one group")
    known = {row[0] for row in db.execute("SELECT id FROM course_groups WHERE class_id=? AND archived_at IS NULL", (class_id,))}
    missing = [g for g in ids if g not in known]
    if missing:
        raise ValueError("Assign to: one or more groups no longer exist")
    return {"type": "groups", "groupIds": list(dict.fromkeys(ids))}


def _attachment(value: object) -> tuple[str, str, bytes] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("Invalid attachment format")
    name = _validate_text(value.get("name"), "File name", 180, 1)
    file_type = _validate_text(value.get("type", "application/octet-stream") or "application/octet-stream", "File type", 120, 1)
    if not FILE_NAME.search(name):
        raise ValueError("Supported attachments: qmd, md, txt, pdf, csv, R, rds, zip")
    try:
        data = base64.b64decode(value.get("data", ""), validate=True)
    except (ValueError, TypeError, binascii.Error) as exc:
        raise ValueError("Invalid attachment encoding") from exc
    if not data or len(data) > MAX_FILE_BYTES:
        raise ValueError("Attachment must be smaller than 3 MB")
    return name, file_type, data


def validate_input(db: sqlite3.Connection, class_id: str, data: object, valid_id: ValidId, *, unit_ids: set[str] | None,
                   base: dict | None = None, default_grades_visibility: str = "on_release") -> dict:
    """Validate an ``AssignmentInput`` (or a legacy v0.5.1 body). Keys absent from ``data`` keep ``base`` values."""
    if not isinstance(data, dict):
        raise ValueError("Invalid assignment format")
    base = base or {}

    def pick(key: str, snake: str, default: object) -> object:
        if key in data:
            return data[key]
        return base.get(snake, default)

    kind = pick("kind", "kind", None)
    if kind not in KINDS:
        raise ValueError("Assignment type must be homework or practice (in-class exercise)")
    title = _validate_text(pick("title", "title", ""), "Title", 120, 1)
    unit_id = pick("unitId", "unit_id", None)
    if not valid_id(unit_id) or (unit_ids is not None and unit_id not in unit_ids):
        raise ValueError("Select an existing chapter")
    instructions = _optional_text(pick("instructions", "instructions", ""), "Instructions", 12000)
    due_at = _iso(pick("dueAt", "due_at", None), "Due date")
    open_at = _iso(pick("openAt", "open_at", None), "Opens")
    close_at = _iso(pick("closeAt", "close_at", None), "Close date")
    if open_at and close_at and _dt(close_at) <= _dt(open_at):  # type: ignore[operator]
        raise ValueError("The close date must be after the open date")
    if open_at and due_at and _dt(due_at) <= _dt(open_at):  # type: ignore[operator]
        raise ValueError("The due date must be after the open date")
    if close_at and due_at and _dt(close_at) < _dt(due_at):  # type: ignore[operator]
        raise ValueError("The close date must be on or after the due date")
    late = _late_policy(data.get("latePolicy") if "latePolicy" in data else None, base.get("late_policy"))
    if late["mode"] == "accept_until" and due_at and _dt(late["untilAt"]) < _dt(due_at):  # type: ignore[operator]
        raise ValueError("Late policy: 'accepted until' must be after the due date")
    max_attempts = _int(pick("maxAttempts", "max_attempts", None), "Attempts allowed", 1, 100)
    time_limit = _time_limit(pick("timeLimit", "time_limit", None))
    if kind == "practice" and time_limit is not None:
        raise ValueError("Time limits are for homework only")
    if kind == "practice" and max_attempts is not None:
        raise ValueError("Attempts allowed per assignment are for homework; set attempts per question instead")
    grades = data.get("gradesVisibility") if data.get("gradesVisibility") is not None else base.get("grades_visibility",
                                                                                                    default_grades_visibility)
    if grades not in GRADES_VISIBILITY:
        raise ValueError("Grades visible to students must be immediately or on_release")
    solutions = data.get("solutionsVisibility") if data.get("solutionsVisibility") is not None else base.get(
        "solutions_visibility", DEFAULT_SOLUTIONS_VISIBILITY[kind])
    if solutions not in SOLUTIONS_VISIBILITY:
        raise ValueError("Solutions visible must be never, after_submit, after_due or after_release")
    tool = _tool_policy(data.get("toolPolicy") if "toolPolicy" in data else None, kind,
                        base.get("tool_policy") if base.get("kind") == kind else None)
    audience = _audience(db, class_id, data.get("audience") if "audience" in data else None, base.get("audience"))
    if "questions" in data or "questions" not in base:
        questions = clean_questions(data.get("questions"), kind, valid_id)
    else:
        questions = base["questions"]
    retire = data.get("retireOriginalOnPublish", base.get("retire_original_on_publish", False))
    return {"kind": kind, "title": title, "unit_id": unit_id, "instructions": instructions, "due_at": due_at, "open_at": open_at,
            "close_at": close_at, "late_policy": late, "max_attempts": max_attempts, "time_limit": time_limit,
            "grades_visibility": grades, "solutions_visibility": solutions, "tool_policy": tool, "audience": audience,
            "questions": questions, "retire_original_on_publish": bool(retire), "attachment": _attachment(data.get("attachment"))}


def stored_input(row: sqlite3.Row) -> dict:
    """The snake-case input of a stored row (base for partial updates)."""
    rec = readers.record_from_row(row)
    return {"kind": rec.kind, "title": rec.title, "unit_id": rec.unit_id, "instructions": row["instructions"],
            "due_at": rec.due_at, "open_at": rec.open_at, "close_at": rec.close_at, "late_policy": dict(rec.late_policy),
            "max_attempts": rec.max_attempts, "time_limit": rec.time_limit, "grades_visibility": rec.grades_visibility,
            "solutions_visibility": rec.solutions_visibility, "tool_policy": rec.tool_policy.as_dict(), "audience": rec.audience,
            "questions": [view_question(q, rec.kind) for q in _loads(row["questions_json"], []) if isinstance(q, dict)],
            "retire_original_on_publish": bool(row["retire_original_on_publish"])}


# -- rows -----------------------------------------------------------------------------------------
def get_work(db: sqlite3.Connection, class_id: str, work_id: str) -> sqlite3.Row:
    row = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=? AND deleted_at IS NULL", (class_id, work_id)).fetchone()
    if row is None:
        raise ValueError("Assignment not found")
    return row


def load_row(db: sqlite3.Connection, class_id: str, work_id: str) -> sqlite3.Row:
    """``get_work`` that answers 404 ``not_found``."""
    row = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=? AND deleted_at IS NULL", (class_id, work_id)).fetchone()
    if row is None:
        raise ApiError(404, "not_found", "Assignment not found")
    return row


def _now() -> datetime:
    return dbmod.utcnow()


# -- attempts (preview rows never count) -------------------------------------------------------------
_REAL_EVENT = "e.is_preview = 0 AND e.student_id NOT LIKE 'preview-%'"
_FOR_ASSIGNMENT = ("(e.attribution_assignment_id = ? OR (e.attribution_assignment_id = '' AND json_valid(e.payload_json) "
                   "AND json_extract(e.payload_json, '$.assignmentId') = ?))")


def attempt_count(db: sqlite3.Connection, class_id: str, work_id: str) -> int:
    """Non-preview submissions plus non-preview in-class checks."""
    subs = db.execute("SELECT COUNT(*) FROM submissions WHERE class_id=? AND assignment_id=? AND is_preview=0 "
                      "AND student_id NOT LIKE 'preview-%'", (class_id, work_id)).fetchone()[0]
    checks = db.execute(
        f"""SELECT COUNT(*) FROM events e WHERE e.class_id=? AND e.event_type='answer_submitted' AND {_REAL_EVENT}
        AND {_FOR_ASSIGNMENT} AND (json_valid(e.payload_json) AND json_extract(e.payload_json, '$.submissionId') IS NULL)""",
        (class_id, work_id, work_id)).fetchone()[0]
    return int(subs) + int(checks)


def has_attempts(db: sqlite3.Connection, work_id: str, class_id: str | None = None) -> bool:
    """Non-preview attempts exist (preview rows never freeze or block lifecycle changes)."""
    if class_id is None:
        row = db.execute("SELECT class_id FROM assignments WHERE id=?", (work_id,)).fetchone()
        if row is None:
            return False
        class_id = row["class_id"]
    return attempt_count(db, class_id, work_id) > 0


def is_frozen(db: sqlite3.Connection, row: sqlite3.Row) -> bool:
    return row["frozen_at"] is not None or has_attempts(db, row["id"], row["class_id"])


def _has_student_traces(db: sqlite3.Connection, class_id: str, work_id: str) -> bool:
    """Non-preview drafts or events of any kind on this assignment (blocks delete)."""
    if db.execute("SELECT 1 FROM answer_drafts WHERE class_id=? AND assignment_id=? AND is_preview=0 "
                  "AND student_id NOT LIKE 'preview-%' LIMIT 1", (class_id, work_id)).fetchone():
        return True
    return db.execute(f"SELECT 1 FROM events e WHERE e.class_id=? AND {_REAL_EVENT} AND {_FOR_ASSIGNMENT} LIMIT 1",
                      (class_id, work_id, work_id)).fetchone() is not None


# -- versions ---------------------------------------------------------------------------------------
def snapshot_version(db: sqlite3.Connection, class_id: str, work_id: str, reason: str, actor: str) -> None:
    """Store the current version's snapshot; if that version already has a different snapshot, bump first."""
    row = get_work(db, class_id, work_id)
    snapshot = readers.assignment_snapshot(row)
    stored = db.execute("SELECT snapshot_json FROM assignment_versions WHERE assignment_id=? AND version=?",
                        (work_id, snapshot["version"])).fetchone()
    if stored is not None:
        if stored["snapshot_json"] == dbmod.json_dumps(snapshot):
            return
        _bump(db, class_id, work_id)
        row = get_work(db, class_id, work_id)
        snapshot = readers.assignment_snapshot(row)
    db.execute(
        """INSERT INTO assignment_versions (assignment_id, class_id, version, snapshot_json, questions_hash, created_by,
        created_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(assignment_id, version) DO NOTHING""",
        (work_id, class_id, snapshot["version"], dbmod.json_dumps(snapshot), readers.questions_hash(snapshot["questions"]),
         actor or "system", dbmod.now(), reason))


def _bump(db: sqlite3.Connection, class_id: str, work_id: str) -> None:
    top = db.execute("SELECT COALESCE(MAX(version), 0) FROM assignment_versions WHERE assignment_id=?", (work_id,)).fetchone()[0]
    db.execute("UPDATE assignments SET version = MAX(version, ?) + 1 WHERE class_id=? AND id=?", (int(top), class_id, work_id))


def new_version(db: sqlite3.Connection, class_id: str, work_id: str, reason: str, actor: str) -> None:
    """Bump ``version`` and snapshot it (published work only; drafts snapshot on publish)."""
    _bump(db, class_id, work_id)
    snapshot_version(db, class_id, work_id, reason, actor)


# -- files ------------------------------------------------------------------------------------------
def file_meta(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "name": row["name"], "mime": row["mime"], "size": row["size"], "scope": row["scope"],
            "questionId": row["question_id"], "unitId": row["unit_id"], "mountInR": bool(row["mount_in_r"]),
            "aiReference": bool(row["ai_reference"]), "createdAt": row["created_at"]}


def legacy_file_meta(row: sqlite3.Row) -> dict:
    data = row["file_data"] or b""
    return {"id": f"legacy-{row['id']}", "name": row["file_name"], "mime": row["file_type"] or "application/octet-stream",
            "size": len(data), "scope": "assignment", "questionId": "", "unitId": "", "mountInR": True, "aiReference": False,
            "createdAt": row["updated_at"]}


def list_files(db: sqlite3.Connection, class_id: str, *, assignment_id: str | None = None, unit_id: str | None = None) -> list[dict]:
    files: list[dict] = []
    if assignment_id:
        work = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=?", (class_id, assignment_id)).fetchone()
        if work is not None and work["file_data"]:
            files.append(legacy_file_meta(work))
        rows = db.execute("SELECT * FROM course_files WHERE class_id=? AND scope='assignment' AND assignment_id=? "
                          "AND deleted_at IS NULL ORDER BY created_at, id", (class_id, assignment_id)).fetchall()
    elif unit_id:
        rows = db.execute("SELECT * FROM course_files WHERE class_id=? AND scope='chapter' AND unit_id=? AND deleted_at IS NULL "
                          "ORDER BY created_at, id", (class_id, unit_id)).fetchall()
    else:
        rows = db.execute("SELECT * FROM course_files WHERE class_id=? AND deleted_at IS NULL ORDER BY created_at, id",
                          (class_id,)).fetchall()
    return files + [file_meta(r) for r in rows]


_UNSAFE_NAME = re.compile(r"[/\\\x00-\x1f\x7f]")
_MIME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+-]{0,60}/[A-Za-z0-9][A-Za-z0-9.+-]{0,60}$")


def clean_file_name(value: object) -> str:
    """A course-file name: 1–180 characters, an allowed extension, no path parts or control characters."""
    name = _validate_text(value, "File name", 180, 1)
    if _UNSAFE_NAME.search(name) or name.startswith(".") or ".." in name:
        raise ValueError("File names cannot contain '/', '\\', '..' or control characters")
    if not FILE_NAME.search(name):
        raise ValueError("Supported files: csv, rds, txt, md, qmd, pdf, R, zip")
    return name


def clean_mime(value: object) -> str:
    """A bounded ``type/subtype`` media type; anything else is stored as ``application/octet-stream``."""
    return value if isinstance(value, str) and _MIME.fullmatch(value) else "application/octet-stream"


def _check_ai_reference(scope: str, name: str, value: bool) -> None:
    if value and (scope != "chapter" or not AI_REFERENCE_NAME.search(name)):
        raise ValueError("aiReference is only available for chapter files in md, qmd or txt format")


def upload_file(db: sqlite3.Connection, class_id: str, body: dict, actor: str, valid_id: ValidId, unit_ids: set[str]) -> dict:
    scope = body.get("scope")
    if scope not in ("assignment", "chapter"):
        raise ValueError("scope must be assignment or chapter")
    assignment_id = question_id = unit_id = ""
    if scope == "assignment":
        assignment_id = body.get("assignmentId") or ""
        if not valid_id(assignment_id):
            raise ValueError("assignmentId is required for assignment files")
        work = get_work(db, class_id, assignment_id)
        question_id = body.get("questionId") or ""
        if question_id and question_id not in {q.get("id") for q in _loads(work["questions_json"], []) if isinstance(q, dict)}:
            raise ValueError("questionId does not belong to this assignment")
    else:
        unit_id = body.get("unitId") or ""
        if unit_id not in unit_ids:
            raise ValueError("unitId must be an existing chapter")
    name = clean_file_name(body.get("name"))
    mime = clean_mime(body.get("type"))
    try:
        data = base64.b64decode(body.get("data", ""), validate=True)
    except (ValueError, TypeError, binascii.Error) as exc:
        raise ValueError("File data must be base64-encoded") from exc
    if not data or len(data) > MAX_FILE_BYTES:
        raise ValueError("Files must be smaller than 3 MB")
    mount = _bool(body.get("mountInR", True), "mountInR")
    ai_reference = _bool(body.get("aiReference", False), "aiReference")
    _check_ai_reference(scope, name, ai_reference)
    file_id = f"file-{uuid.uuid4().hex[:16]}"
    db.execute(
        """INSERT INTO course_files (id, class_id, scope, assignment_id, question_id, unit_id, name, mime, size, sha256, data,
        mount_in_r, ai_reference, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (file_id, class_id, scope, assignment_id, question_id, unit_id, name, mime, len(data), hashlib.sha256(data).hexdigest(),
         data, int(mount), int(ai_reference), actor or "instructor", dbmod.now()))
    return file_meta(db.execute("SELECT * FROM course_files WHERE id=?", (file_id,)).fetchone())


def _file_row(db: sqlite3.Connection, class_id: str, file_id: str) -> sqlite3.Row:
    row = db.execute("SELECT * FROM course_files WHERE class_id=? AND id=? AND deleted_at IS NULL", (class_id, file_id)).fetchone()
    if row is None:
        raise ApiError(404, "not_found", "File not found")
    return row


def update_file(db: sqlite3.Connection, class_id: str, file_id: str, body: dict) -> tuple[dict, dict]:
    if file_id.startswith("legacy-"):
        raise ValueError("The original attachment always loads into R; upload it again to change its settings")
    row = _file_row(db, class_id, file_id)
    before = file_meta(row)
    mount = _bool(body["mountInR"], "mountInR") if "mountInR" in body else bool(row["mount_in_r"])
    ai_reference = _bool(body["aiReference"], "aiReference") if "aiReference" in body else bool(row["ai_reference"])
    _check_ai_reference(row["scope"], row["name"], ai_reference)
    db.execute("UPDATE course_files SET mount_in_r=?, ai_reference=? WHERE id=?", (int(mount), int(ai_reference), file_id))
    return before, file_meta(_file_row(db, class_id, file_id))


def delete_file(db: sqlite3.Connection, class_id: str, file_id: str, actor: str) -> dict:
    """Soft delete. The legacy single attachment is preserved as a deleted ``course_files`` row before it is cleared."""
    stamp = dbmod.now()
    if file_id.startswith("legacy-"):
        work = load_row(db, class_id, file_id[len("legacy-"):])
        if not work["file_data"]:
            raise ApiError(404, "not_found", "File not found")
        before = legacy_file_meta(work)
        data = bytes(work["file_data"])
        db.execute(
            """INSERT INTO course_files (id, class_id, scope, assignment_id, question_id, unit_id, name, mime, size, sha256, data,
            mount_in_r, ai_reference, created_by, created_at, deleted_at) VALUES (?, ?, 'assignment', ?, '', '', ?, ?, ?, ?, ?, 1, 0,
            ?, ?, ?)""",
            (f"file-{uuid.uuid4().hex[:16]}", class_id, work["id"], work["file_name"], work["file_type"] or "application/octet-stream",
             len(data), hashlib.sha256(data).hexdigest(), data, actor or "instructor", work["updated_at"], stamp))
        db.execute("UPDATE assignments SET file_name=NULL, file_type=NULL, file_data=NULL WHERE id=?", (work["id"],))
        return before
    row = _file_row(db, class_id, file_id)
    db.execute("UPDATE course_files SET deleted_at=? WHERE id=?", (stamp, file_id))
    return file_meta(row)


def file_content(db: sqlite3.Connection, class_id: str, file_id: str) -> tuple[dict, bytes, sqlite3.Row | None]:
    """(meta, bytes, assignment row or None) for a course file or a legacy attachment."""
    if file_id.startswith("legacy-"):
        work = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=? AND deleted_at IS NULL",
                          (class_id, file_id[len("legacy-"):])).fetchone()
        if work is None or not work["file_data"]:
            raise ApiError(404, "not_found", "File not found")
        return legacy_file_meta(work), bytes(work["file_data"]), work
    row = _file_row(db, class_id, file_id)
    work = None
    if row["scope"] == "assignment":
        work = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=? AND deleted_at IS NULL",
                          (class_id, row["assignment_id"])).fetchone()
    return file_meta(row), bytes(row["data"]), work


def _copy_files(db: sqlite3.Connection, class_id: str, source_id: str, target_id: str, qmap: dict[str, str], actor: str) -> None:
    reverse = {old: new for new, old in qmap.items()}
    for row in db.execute("SELECT * FROM course_files WHERE class_id=? AND scope='assignment' AND assignment_id=? AND deleted_at IS NULL",
                          (class_id, source_id)).fetchall():
        db.execute(
            """INSERT INTO course_files (id, class_id, scope, assignment_id, question_id, unit_id, name, mime, size, sha256, data,
            mount_in_r, ai_reference, created_by, created_at) VALUES (?, ?, 'assignment', ?, ?, '', ?, ?, ?, ?, ?, ?, 0, ?, ?)""",
            (f"file-{uuid.uuid4().hex[:16]}", class_id, target_id, reverse.get(row["question_id"], "") if row["question_id"] else "",
             row["name"], row["mime"], row["size"], row["sha256"], row["data"], row["mount_in_r"], actor or "instructor", dbmod.now()))


# -- serialization ----------------------------------------------------------------------------------
def input_view(rec: AssignmentRecord, row: sqlite3.Row) -> dict:
    return {"kind": rec.kind, "title": rec.title, "unitId": rec.unit_id, "instructions": row["instructions"],
            "dueAt": rec.due_at, "openAt": rec.open_at, "closeAt": rec.close_at, "latePolicy": dict(rec.late_policy),
            "maxAttempts": rec.max_attempts, "timeLimit": rec.time_limit, "gradesVisibility": rec.grades_visibility,
            "solutionsVisibility": rec.solutions_visibility, "toolPolicy": rec.tool_policy.as_dict(), "audience": rec.audience,
            "questions": [view_question(q, rec.kind) for q in _loads(row["questions_json"], []) if isinstance(q, dict)],
            "retireOriginalOnPublish": bool(row["retire_original_on_publish"])}


def lineage_view(db: sqlite3.Connection, class_id: str, work_id: str, revision_of: str | None) -> dict:
    """S-M01: what links an original and its revisions (the editor and the list name both directions)."""
    original = None
    if revision_of:
        row = db.execute("SELECT id, title FROM assignments WHERE class_id=? AND id=?", (class_id, revision_of)).fetchone()
        original = row["title"] if row is not None else None
    now = _now()
    revisions = []
    for row in db.execute("""SELECT * FROM assignments WHERE class_id=? AND revision_of=? AND deleted_at IS NULL
            ORDER BY created_at, id""", (class_id, work_id)):
        rec = readers.record_from_row(row)
        revisions.append({"id": rec.id, "title": rec.title, "status": rec.status, "state": readers.assignment_state(rec, now)})
    return {"revisionOf": revision_of, "revisionOfTitle": original, "revisions": revisions}


def teacher_view(db: sqlite3.Connection, row: sqlite3.Row) -> dict:
    """``TeacherAssignment`` (§7.4)."""
    rec = readers.record_from_row(row)
    versions = [{"version": v["version"], "createdAt": v["created_at"], "reason": v["reason"]}
                for v in db.execute("SELECT version, created_at, reason FROM assignment_versions WHERE assignment_id=? "
                                    "ORDER BY version", (rec.id,))]
    return {**input_view(rec, row), "id": rec.id, "classId": rec.class_id, "status": rec.status,
            "state": readers.assignment_state(rec, _now()), "version": rec.version, "frozen": is_frozen(db, row),
            "frozenAt": rec.frozen_at, "attemptCount": attempt_count(db, rec.class_id, rec.id),
            **lineage_view(db, rec.class_id, rec.id, row["revision_of"]),
            "files": list_files(db, rec.class_id, assignment_id=rec.id), "attachmentName": row["file_name"], "versions": versions,
            "createdAt": row["created_at"], "updatedAt": row["updated_at"], "archivedAt": rec.archived_at}


def redact_question(question: dict, *, show_explanation: bool = False, revealed_hints: int = 0) -> dict:
    """Student-safe question: staff-only keys removed; explanation and hints only when earned (§6.3)."""
    out = {k: v for k, v in question.items() if k not in STAFF_QUESTION_KEYS and k not in ("studentExplanation", "hints")}
    if show_explanation and question.get("studentExplanation"):
        out["studentExplanation"] = question["studentExplanation"]
    hints = question.get("hints") or []
    if revealed_hints and hints:
        out["hints"] = list(hints[:revealed_hints])
    return out


def serialize_work(row: sqlite3.Row, teacher: bool = False) -> dict:
    """v0.5.1 ``Assignment`` shape; students never receive answers, rubrics or explanations (KEEP)."""
    questions = json.loads(row["questions_json"])
    if not teacher:
        questions = [redact_question(q) for q in questions]
    return {"id": row["id"], "classId": row["class_id"], "kind": row["kind"], "title": row["title"], "unitId": row["unit_id"],
            "instructions": row["instructions"], "dueAt": row["due_at"], "status": row["status"], "questions": questions,
            "attachmentName": row["file_name"], "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


# -- student visibility -----------------------------------------------------------------------------
def visible_to(db: sqlite3.Connection, row: sqlite3.Row, student_id: str, *, preview: bool, now: object = None,
               allow_scheduled: bool = False) -> bool:
    """Published, not archived/deleted, in the audience and not scheduled — preview also opens drafts (§3.4)."""
    if row["deleted_at"] or row["archived_at"]:
        return False
    if preview:
        return True
    if row["status"] != "published":
        return False
    rec = readers.record_from_row(row)
    if not readers.in_audience(db, rec, student_id):
        return False
    return allow_scheduled or readers.assignment_state(rec, now or _now()) != "scheduled"


def student_row(db: sqlite3.Connection, class_id: str, work_id: str, student_id: str, *, preview: bool,
                allow_scheduled: bool = False) -> sqlite3.Row:
    row = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=?", (class_id, work_id)).fetchone()
    if row is None or not visible_to(db, row, student_id, preview=preview, allow_scheduled=allow_scheduled):
        raise ApiError(404, "not_found", "Assignment not found")
    return row


def _my_attempts(db: sqlite3.Connection, class_id: str, work_id: str, student_id: str, kind: str) -> tuple[int, str]:
    if kind == "homework":
        rows = db.execute("SELECT grade_status FROM submissions WHERE class_id=? AND assignment_id=? AND student_id=? "
                          "ORDER BY attempt DESC", (class_id, work_id, student_id)).fetchall()
        if not rows:
            return 0, "none"
        return len(rows), "graded" if rows[0]["grade_status"] == "released" else "submitted"
    count = db.execute(
        f"""SELECT COUNT(*) FROM events e WHERE e.class_id=? AND e.student_id=? AND e.event_type='answer_submitted'
        AND {_FOR_ASSIGNMENT}""", (class_id, student_id, work_id, work_id)).fetchone()[0]
    return int(count), "submitted" if count else "none"


def student_options(db: sqlite3.Connection, class_id: str, student_id: str, *, preview: bool) -> list[dict]:
    """``StudentWorkOption[]`` — published, in audience, not scheduled; closed shown read-only; preview adds drafts."""
    now = _now()
    rows = db.execute("SELECT * FROM assignments WHERE class_id=? AND deleted_at IS NULL AND archived_at IS NULL "
                      "ORDER BY created_at DESC, id DESC", (class_id,)).fetchall()
    from server import course_config

    # S-m08: the chapter title for a student card, also for a chapter hidden from students (never the raw id)
    titles = {u["id"]: u["title"] for u in course_config.course_for(class_id, db)["units"]}
    options = []
    for row in rows:
        if not visible_to(db, row, student_id, preview=preview, now=now):
            continue
        rec = readers.record_from_row(row)
        attempts, latest = _my_attempts(db, class_id, rec.id, student_id, rec.kind)
        original = readers.submitted_original(db, rec, student_id) if rec.kind == "homework" and not attempts else None
        options.append({
            "id": rec.id, "title": rec.title, "kind": rec.kind, "unitId": rec.unit_id, "status": rec.status,
            "questionCount": len(rec.questions), "hasSubmissions": attempts > 0, "dueAt": rec.due_at,
            "state": readers.assignment_state(rec, now), "closeAt": rec.close_at, "latePolicy": dict(rec.late_policy),
            "maxAttempts": rec.max_attempts, "myAttempts": attempts, "myLatestStatus": latest,
            "submittedOriginal": {"id": original.id, "title": original.title} if original is not None else None,   # S-M01
            "unitTitle": titles.get(rec.unit_id, ""),                                                            # S-m08
            **({"isPreviewDraft": True} if preview and rec.status == "draft" else {}),
        })
    return options


def work_options(db: sqlite3.Connection, class_id: str, teacher: bool = False, *, student_id: str | None = None,
                 preview: bool = False) -> list[dict]:
    """Staff: v0.5.1 ``WorkOption[]`` (+ ``state``); students: ``StudentWorkOption[]``."""
    if not teacher and student_id:
        return student_options(db, class_id, student_id, preview=preview)
    condition = "" if teacher else " AND a.status='published' AND a.archived_at IS NULL"
    rows = db.execute(
        f"""SELECT a.* FROM assignments a WHERE a.class_id=? AND a.deleted_at IS NULL{condition}
        ORDER BY a.created_at DESC, a.id DESC""", (class_id,)).fetchall()
    now = _now()
    out = []
    for row in rows:
        rec = readers.record_from_row(row)
        out.append({"id": rec.id, "title": rec.title, "kind": rec.kind, "unitId": rec.unit_id, "status": rec.status,
                    "dueAt": rec.due_at, "questionCount": len(rec.questions),
                    "hasSubmissions": attempt_count(db, class_id, rec.id) > 0, "state": readers.assignment_state(rec, now)})
    return out


def list_work(db: sqlite3.Connection, class_id: str, teacher: bool = False, *, student_id: str | None = None,
              preview: bool = False) -> list[dict]:
    """Legacy ``GET /api/work``: staff get every assignment; students get what they may open (preview: drafts too)."""
    rows = db.execute("SELECT * FROM assignments WHERE class_id=? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC",
                      (class_id,)).fetchall()
    if teacher:
        return [serialize_work(row, True) for row in rows]
    now = _now()
    return [serialize_work(row, False) for row in rows
            if (visible_to(db, row, student_id, preview=preview, now=now) if student_id
                else row["status"] == "published" and not row["archived_at"])]


def _revealed_hint_counts(db: sqlite3.Connection, class_id: str, work_id: str, student_id: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for event in db.execute(
            f"""SELECT e.question_id, e.payload_json FROM events e WHERE e.class_id=? AND e.student_id=?
            AND e.event_type='answer_submitted' AND {_FOR_ASSIGNMENT} ORDER BY e.id""",
            (class_id, student_id, work_id, work_id)):
        payload = _loads(event["payload_json"], {})
        if payload.get("correct") is False:
            counts[event["question_id"]] = counts.get(event["question_id"], 0) + 1
    return counts


def current_attempt(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str) -> dict | None:
    """The open timed attempt ``{attempt, startedAt, endsAt}`` (started, not yet submitted)."""
    if rec.kind != "homework" or not rec.time_limit:
        return None
    attempt = db.execute("SELECT COUNT(*) FROM submissions WHERE class_id=? AND assignment_id=? AND student_id=?",
                         (rec.class_id, rec.id, student_id)).fetchone()[0] + 1
    row = db.execute("SELECT started_at FROM attempt_starts WHERE class_id=? AND assignment_id=? AND student_id=? AND attempt=?",
                     (rec.class_id, rec.id, student_id, attempt)).fetchone()
    if row is None:
        return None
    started = _dt(row["started_at"])
    ends = started + timedelta(minutes=int(rec.time_limit.get("minutes") or 0)) if started else None
    return {"attempt": attempt, "startedAt": row["started_at"], "endsAt": ends.isoformat(timespec="milliseconds") if ends else None}


def student_assignment(db: sqlite3.Connection, row: sqlite3.Row, student_id: str) -> dict:
    """``StudentAssignment`` (§7.4), redacted; legacy ``Assignment`` keys kept for cached bundles."""
    rec = readers.record_from_row(row)
    now = _now()
    show = readers.solutions_visible(db, rec, student_id, now)
    hints = _revealed_hint_counts(db, rec.class_id, rec.id, student_id) if rec.kind == "practice" else {}
    questions = [redact_question(view_question(q, rec.kind), show_explanation=show, revealed_hints=hints.get(q.get("id"), 0))
                 for q in _loads(row["questions_json"], []) if isinstance(q, dict)]
    return {
        "id": rec.id, "classId": rec.class_id, "kind": rec.kind, "title": rec.title, "unitId": rec.unit_id,
        "instructions": row["instructions"], "status": rec.status, "state": readers.assignment_state(rec, now),
        "dueAt": rec.due_at, "openAt": rec.open_at, "closeAt": rec.close_at, "latePolicy": dict(rec.late_policy),
        "maxAttempts": rec.max_attempts, "timeLimit": rec.time_limit, "currentAttempt": current_attempt(db, rec, student_id),
        "toolPolicy": rec.tool_policy.as_dict(), "gradesVisibility": rec.grades_visibility, "version": rec.version,
        "questions": questions, "files": list_files(db, rec.class_id, assignment_id=rec.id), "attachmentName": row["file_name"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
        "submittedOriginal": _original_ref(db, rec, student_id),   # S-M01
        "revisedAs": _revision_ref(db, rec, student_id, now),       # R-m01
    }


def _revision_ref(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str, now: object) -> dict | None:
    """R-m01: the published revision that replaces this assignment for the student (nearest first, one that still
    accepts work preferred), or None. Drafts and revisions outside the student's audience are never named."""
    _originals, revisions = readers.lineage_ids(db, rec.class_id, rec.id)
    visible = []
    for revision_id in revisions:
        row = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=?", (rec.class_id, revision_id)).fetchone()
        if row is not None and visible_to(db, row, student_id, preview=False, now=now):
            visible.append(readers.record_from_row(row))
    if not visible:
        return None
    accepting = [r for r in visible if readers.assignment_state(r, now) in ("open", "past_due")]
    chosen = (accepting or visible)[0]
    return {"id": chosen.id, "title": chosen.title}


def _original_ref(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str) -> dict | None:
    if rec.kind != "homework" or db.execute("SELECT 1 FROM submissions WHERE class_id=? AND assignment_id=? AND student_id=? LIMIT 1",
                                            (rec.class_id, rec.id, student_id)).fetchone():
        return None
    original = readers.submitted_original(db, rec, student_id)
    return {"id": original.id, "title": original.title} if original is not None else None


def file_visible_to_student(db: sqlite3.Connection, class_id: str, meta: dict, work: sqlite3.Row | None, student_id: str, *,
                            preview: bool) -> bool:
    if meta["scope"] == "assignment":
        return work is not None and visible_to(db, work, student_id, preview=preview)
    from server import course_config

    unit = next((u for u in course_config.course_for(class_id, db)["units"] if u["id"] == meta["unitId"]), None)
    return unit is not None and (preview or unit.get("effectiveAccess") in ("open", "review"))


# -- lifecycle --------------------------------------------------------------------------------------
def _course_settings_default(db: sqlite3.Connection, class_id: str) -> str:
    value = readers.settings(db, class_id).get("grading", {}).get("defaultGradesVisibility", "on_release")
    return value if value in GRADES_VISIBILITY else "on_release"


def _write_columns(clean: dict) -> dict:
    return {"kind": clean["kind"], "title": clean["title"], "unit_id": clean["unit_id"], "instructions": clean["instructions"],
            "due_at": clean["due_at"], "open_at": clean["open_at"], "close_at": clean["close_at"],
            "late_policy_json": dbmod.json_dumps(clean["late_policy"]), "max_attempts": clean["max_attempts"],
            "time_limit_json": dbmod.json_dumps(clean["time_limit"]) if clean["time_limit"] else None,
            "grades_visibility": clean["grades_visibility"], "solutions_visibility": clean["solutions_visibility"],
            "tool_policy_json": dbmod.json_dumps(clean["tool_policy"]), "audience_json": dbmod.json_dumps(clean["audience"]),
            "questions_json": json.dumps(clean["questions"], ensure_ascii=False),
            "retire_original_on_publish": int(clean["retire_original_on_publish"])}


def create_assignment(db: sqlite3.Connection, class_id: str, data: object, valid_id: ValidId, *, actor: str,
                      unit_ids: set[str] | None, legacy: bool = False, starter_key: str | None = None) -> str:
    """Insert a draft; returns its id. Legacy bodies default to ``gradesVisibility='immediately'`` (v0.5.1)."""
    default_visibility = "immediately" if legacy else _course_settings_default(db, class_id)
    clean = validate_input(db, class_id, data, valid_id, unit_ids=unit_ids, default_grades_visibility=default_visibility)
    file_name = file_type = file_data = None
    if clean["attachment"]:
        file_name, file_type, file_data = clean["attachment"]
    elif isinstance(data, dict) and data.get("attachmentSourceId"):
        if not valid_id(data["attachmentSourceId"]):
            raise ValueError("Invalid revision source ID")
        source = get_work(db, class_id, data["attachmentSourceId"])
        file_name, file_type, file_data = source["file_name"], source["file_type"], source["file_data"]
    work_id = f"work-{uuid.uuid4().hex[:16]}"
    stamp = dbmod.now()
    columns = {**_write_columns(clean), "id": work_id, "class_id": class_id, "status": "draft", "file_name": file_name,
               "file_type": file_type, "file_data": file_data, "created_at": stamp, "updated_at": stamp, "created_by": actor,
               "updated_by": actor, "version": 1, "starter_key": starter_key}
    db.execute(f"INSERT INTO assignments ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})", tuple(columns.values()))
    return work_id


def save_work(db: sqlite3.Connection, class_id: str, data: object, valid_id: ValidId, work_id: str | None = None, *,
              actor: str = "", unit_ids: set[str] | None = None) -> dict:
    """Legacy create/update (v0.5.1 body and ``Assignment`` response)."""
    if work_id:
        update_assignment(db, class_id, work_id, data, valid_id, actor=actor, unit_ids=unit_ids)
    else:
        work_id = create_assignment(db, class_id, data, valid_id, actor=actor, unit_ids=unit_ids, legacy=True)
    return serialize_work(get_work(db, class_id, work_id), True)


def validate_work(data: object, valid_id: ValidId) -> dict:
    """Legacy validator name (re-exported by ``workflows``): v2 question validation of a v0.5.1 body."""
    if not isinstance(data, dict):
        raise ValueError("Invalid assignment format")
    kind = data.get("kind")
    if kind not in KINDS:
        raise ValueError("Kind must be practice or homework")
    attachment = _attachment(data.get("attachment"))
    return {"kind": kind, "title": _validate_text(data.get("title"), "Title", 120, 1), "unit_id": data.get("unitId"),
            "instructions": _optional_text(data.get("instructions"), "Instructions", 12000),
            "due_at": _iso(data.get("dueAt"), "Due date"), "questions": clean_questions(data.get("questions"), kind, valid_id),
            "file_name": attachment[0] if attachment else None, "file_type": attachment[1] if attachment else None,
            "file_data": attachment[2] if attachment else None}


def update_assignment(db: sqlite3.Connection, class_id: str, work_id: str, data: object, valid_id: ValidId, *, actor: str,
                      unit_ids: set[str] | None, base_updated_at: object = _UNSET) -> dict:
    """Edit an assignment (§6.3 PUT). Returns ``{before, after, questionsChanged, settingsChanged, clearedPreview}``."""
    row = load_row(db, class_id, work_id)
    if base_updated_at is not _UNSET:
        if not isinstance(base_updated_at, str) or _dt(base_updated_at) is None:
            raise ValueError("baseUpdatedAt is required")
        if _dt(base_updated_at) < _dt(row["updated_at"]):  # type: ignore[operator]
            raise ApiError(409, "stale_version", "This assignment was changed in another window. Reload it to see the latest version.")
    if row["archived_at"]:
        raise ValueError("Unarchive this assignment before editing it")
    base = stored_input(row)
    clean = validate_input(db, class_id, data, valid_id, unit_ids=unit_ids, base=base)
    questions_changed = _frozen_view(clean["questions"]) != _frozen_view(base["questions"])
    structure_changed = questions_changed or clean["kind"] != base["kind"] or clean["unit_id"] != base["unit_id"]
    if structure_changed and is_frozen(db, row):
        raise ApiError(409, "frozen_has_attempts", FROZEN_MESSAGE)
    settings_changed = any(clean[key] != base[key] for key in SETTINGS_FIELDS)
    columns = {**_write_columns(clean), "updated_at": dbmod.now(), "updated_by": actor}
    if clean["attachment"]:
        columns.update(file_name=clean["attachment"][0], file_type=clean["attachment"][1], file_data=clean["attachment"][2])
    sets = ", ".join(f"{key}=?" for key in columns)
    db.execute(f"UPDATE assignments SET {sets} WHERE class_id=? AND id=?", (*columns.values(), class_id, work_id))
    cleared: dict[str, int] = {}
    if structure_changed:
        cleared = clear_preview(db, class_id, work_id)
    if row["status"] == "published" and (structure_changed or settings_changed):
        new_version(db, class_id, work_id, "edit" if structure_changed else "settings_edit", actor)
    return {"before": {"title": base["title"], "version": row["version"]}, "questionsChanged": structure_changed,
            "settingsChanged": settings_changed, "clearedPreview": cleared}


def check_publishable(questions: object) -> None:
    """Structural check before students see an assignment (defense in depth for rows not written by the editor).

    Stricter content rules (reference answers, tags…) are enforced when the editor saves; this only refuses question
    sets that would break student pages and submissions: no questions, missing or duplicate ids, unknown types.
    """
    if not isinstance(questions, list) or not questions:
        raise ValueError("Add at least one question before publishing")
    seen: set[str] = set()
    for index, question in enumerate(questions, start=1):
        qid = question.get("id") if isinstance(question, dict) else None
        if not isinstance(qid, str) or ID_PATTERN.fullmatch(qid) is None:
            raise ValueError(f"Question {index} has no valid id; open the assignment in the editor and save it again")
        if qid in seen:
            raise ValueError(f"Question {index} repeats the id {qid}; open the assignment in the editor and save it again")
        seen.add(qid)
        if question.get("type") not in QUESTION_TYPES:
            raise ValueError(f"Question {index} has an unsupported type")


def publish(db: sqlite3.Connection, class_id: str, work_id: str, *, actor: str, open_at: object = _UNSET) -> dict:
    """Publish (optionally scheduled). A revision with ``retire_original_on_publish`` closes its original [AU-D1-08]."""
    row = load_row(db, class_id, work_id)
    if row["archived_at"]:
        raise ValueError("Unarchive this assignment before publishing it")
    check_publishable(_loads(row["questions_json"], None))
    stamp = dbmod.now()
    if open_at is not _UNSET:
        opens = _iso(open_at, "openAt")
        due, close = _dt(row["due_at"]), _dt(row["close_at"])
        if opens and ((due and due <= _dt(opens)) or (close and close <= _dt(opens))):  # type: ignore[operator]
            raise ValueError("The open date must be before the due and close dates")
        db.execute("UPDATE assignments SET open_at=? WHERE id=?", (opens, work_id))
    db.execute("UPDATE assignments SET status='published', updated_at=?, updated_by=? WHERE class_id=? AND id=?",
               (stamp, actor, class_id, work_id))
    snapshot_version(db, class_id, work_id, "publish", actor)
    retired = None
    if row["revision_of"] and row["retire_original_on_publish"]:
        original = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=? AND deleted_at IS NULL",
                              (class_id, row["revision_of"])).fetchone()
        if original is not None and (original["close_at"] is None or _dt(original["close_at"]) > _dt(stamp)):  # type: ignore[operator]
            db.execute("UPDATE assignments SET close_at=?, updated_at=?, updated_by=? WHERE id=?",
                       (dbmod.iso_seconds(_dt(stamp)), stamp, actor, original["id"]))  # type: ignore[arg-type]
            if original["status"] == "published":
                new_version(db, class_id, original["id"], "settings_edit", actor)
            retired = original["id"]
    return {"retiredOriginal": retired}


def unpublish(db: sqlite3.Connection, class_id: str, work_id: str, *, actor: str) -> None:
    row = load_row(db, class_id, work_id)
    if row["status"] == "published" and is_frozen(db, row):
        raise ApiError(409, "has_submissions", "Students have started this assignment. Close submissions or archive it instead.")
    db.execute("UPDATE assignments SET status='draft', updated_at=?, updated_by=? WHERE class_id=? AND id=?",
               (dbmod.now(), actor, class_id, work_id))


def set_status(db: sqlite3.Connection, class_id: str, work_id: str, status: object, *, actor: str = "") -> dict:
    """Legacy ``POST /api/work/{id}/status``."""
    if status not in ("draft", "published"):
        raise ValueError("Invalid publication status")
    if status == "published":
        publish(db, class_id, work_id, actor=actor)
    else:
        unpublish(db, class_id, work_id, actor=actor)
    return serialize_work(get_work(db, class_id, work_id), True)


def set_close(db: sqlite3.Connection, class_id: str, work_id: str, close_at: str | None, *, actor: str) -> None:
    row = load_row(db, class_id, work_id)
    db.execute("UPDATE assignments SET close_at=?, updated_at=?, updated_by=? WHERE class_id=? AND id=?",
               (close_at, dbmod.now(), actor, class_id, work_id))
    if row["status"] == "published" and row["close_at"] != close_at:
        new_version(db, class_id, work_id, "settings_edit", actor)


def set_archived(db: sqlite3.Connection, class_id: str, work_id: str, archived: bool, *, actor: str) -> None:
    load_row(db, class_id, work_id)
    stamp = dbmod.now()
    db.execute("UPDATE assignments SET archived_at=?, updated_at=?, updated_by=? WHERE class_id=? AND id=?",
               (stamp if archived else None, stamp, actor, class_id, work_id))


def delete_assignment(db: sqlite3.Connection, class_id: str, work_id: str, *, actor: str) -> dict:
    """Soft delete of a draft without student work (preview rows are cleared) [AU-D1-09]."""
    row = load_row(db, class_id, work_id)
    if is_frozen(db, row) or _has_student_traces(db, class_id, work_id) or db.execute(
            "SELECT 1 FROM submissions WHERE class_id=? AND assignment_id=? AND is_preview=0 LIMIT 1", (class_id, work_id)).fetchone():
        raise ApiError(409, "has_submissions", "Students have work on this assignment. Archive it instead.")
    if row["status"] != "draft":
        raise ValueError("Unpublish this assignment before deleting it, or archive it")
    cleared = clear_preview(db, class_id, work_id)
    db.execute("UPDATE assignments SET deleted_at=?, updated_by=? WHERE class_id=? AND id=?", (dbmod.now(), actor, class_id, work_id))
    return cleared


def _shift(value: str | None, days: int) -> str | None:
    parsed = _dt(value)
    return dbmod.iso_seconds(parsed + timedelta(days=days)) if parsed and days else value


def duplicate(db: sqlite3.Connection, class_id: str, work_id: str, body: dict, *, actor: str) -> str:
    """Copy as a new draft with new question ids (+ files); ``asRevision`` keeps lineage [F13, AU-D1-08]."""
    row = load_row(db, class_id, work_id)
    as_revision = bool(body.get("asRevision", False))
    retire = bool(body.get("retireOriginalOnPublish", False)) and as_revision
    days = _int(body.get("shiftDays", 0), "shiftDays", -365, 365, allow_none=False) or 0
    title = body.get("title")
    if title is None:
        title = f"{row['title']} — revision" if as_revision else f"{row['title']} (copy)"
    title = _validate_text(title[:120] if isinstance(title, str) else title, "Title", 120, 1)
    base = stored_input(row)
    qmap: dict[str, str] = {}
    questions = []
    for q in base["questions"]:
        new_id = f"q-{uuid.uuid4().hex[:12]}"
        qmap[new_id] = q["id"]
        questions.append({**q, "id": new_id})
    late = dict(base["late_policy"])
    late["untilAt"] = _shift(late.get("untilAt"), days)
    clean = {**base, "title": title, "questions": questions, "late_policy": late, "due_at": _shift(base["due_at"], days),
             "open_at": _shift(base["open_at"], days), "close_at": None if as_revision else _shift(base["close_at"], days),
             "retire_original_on_publish": retire}
    new_id = f"work-{uuid.uuid4().hex[:16]}"
    stamp = dbmod.now()
    columns = {**_write_columns(clean), "id": new_id, "class_id": class_id, "status": "draft", "file_name": row["file_name"],
               "file_type": row["file_type"], "file_data": row["file_data"], "created_at": stamp, "updated_at": stamp,
               "created_by": actor, "updated_by": actor, "version": 1,
               "revision_of": work_id if as_revision else None,
               "question_id_map_json": dbmod.json_dumps(qmap) if as_revision else None}
    db.execute(f"INSERT INTO assignments ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})", tuple(columns.values()))
    _copy_files(db, class_id, work_id, new_id, qmap, actor)
    return new_id


def clear_preview(db: sqlite3.Connection, class_id: str, work_id: str) -> dict[str, int]:
    """Delete this assignment's preview rows; returns per-table counts [AU-D1-09]."""
    preview = "(is_preview = 1 OR student_id LIKE 'preview-%')"
    subs = [r[0] for r in db.execute(f"SELECT id FROM submissions WHERE class_id=? AND assignment_id=? AND {preview}",
                                     (class_id, work_id))]
    counts: dict[str, int] = {}

    def run(table: str, sql: str, params: tuple) -> None:
        counts[table] = counts.get(table, 0) + db.execute(sql, params).rowcount

    for sub_id in subs:
        run("submission_item_scores", "DELETE FROM submission_item_scores WHERE submission_id=?", (sub_id,))
        run("grade_events", "DELETE FROM grade_events WHERE submission_id=?", (sub_id,))
        run("submission_requests", "DELETE FROM submission_requests WHERE submission_id=?", (sub_id,))
    run("submissions", f"DELETE FROM submissions WHERE class_id=? AND assignment_id=? AND {preview}", (class_id, work_id))
    run("answer_drafts", f"DELETE FROM answer_drafts WHERE class_id=? AND assignment_id=? AND {preview}", (class_id, work_id))
    run("attempt_starts", f"DELETE FROM attempt_starts WHERE class_id=? AND assignment_id=? AND {preview}", (class_id, work_id))
    run("events", f"""DELETE FROM events WHERE class_id=? AND {preview} AND (attribution_assignment_id=? OR related_assignment_id=?
        OR (json_valid(payload_json) AND json_extract(payload_json, '$.assignmentId')=?))""", (class_id, work_id, work_id, work_id))
    run("chat_turns", f"DELETE FROM chat_turns WHERE class_id=? AND assignment_id=? AND {preview}", (class_id, work_id))
    run("learning_sessions", "DELETE FROM learning_sessions WHERE classId=? AND assignmentId=? AND (isPreview=1 OR studentId LIKE "
        "'preview-%')", (class_id, work_id))
    for table in ("submission_item_scores", "grade_events", "submission_requests"):
        counts.setdefault(table, 0)
    return counts


# -- in-class checks --------------------------------------------------------------------------------
def _state_error(rec: AssignmentRecord, now: datetime) -> ApiError | None:
    """409 for submissions that the dates/late policy no longer (or not yet) accept."""
    open_at = _dt(rec.open_at)
    if open_at is not None and open_at > now:
        return ApiError(409, "not_open_yet", "This assignment is not open yet.")
    close_at = _dt(rec.close_at)
    if close_at is not None and close_at <= now:
        return ApiError(409, "assignment_closed", "Closed — submissions are no longer accepted.")
    due = _dt(rec.due_at)
    mode = rec.late_policy.get("mode", "accept_marked")
    if mode == "accept_until":
        until = _dt(rec.late_policy.get("untilAt"))
        if until is not None and now >= until:
            return ApiError(409, "late_not_accepted", "Late submissions were accepted until the late deadline, which has passed.")
    if due is not None and mode == "not_accepted":
        grace = timedelta(minutes=int(rec.late_policy.get("graceMinutes") or 0))
        if now >= due + grace:
            return ApiError(409, "late_not_accepted", "The due date has passed and late submissions are not accepted.")
    return None


def _check_result(question: dict, correct: bool | None, reason: str, attempt_index: int, limit: int | None,
                  wrong_so_far: int) -> dict[str, Any]:
    """``InClassCheckResult`` for one judged attempt (``wrong_so_far`` counts wrong attempts including this one)."""
    left = None if limit is None else max(0, int(limit) - attempt_index)
    result: dict[str, Any] = {"correct": correct, "attemptIndex": attempt_index, "attemptsLeft": left}
    if correct is None:
        result["status"] = "recorded"
        if question["type"] == "complete" and reason == "not_gradable":
            result["explanation"] = "Run your code in the R workspace and use it as your answer; the check compares its printed output."
    elif correct:
        if question.get("studentExplanation"):
            result["explanation"] = question["studentExplanation"]
    else:
        hints = question.get("hints") or []
        if wrong_so_far <= len(hints):
            result["nextHint"] = hints[wrong_so_far - 1]
        if left == 0:
            result["revealedAnswer"] = question.get("answer") or question.get("expectedOutput") or ""
    return result


def _check_replay(db: sqlite3.Connection, class_id: str, work_id: str, student_id: str, question: dict, event_id: str,
                  limit: int | None) -> dict | None:
    """The stored result of a check already recorded with ``event_id`` (a retry after a lost response), or None.

    WHY (review 2, CORRECTNESS-07): the attempt limit must not count the retry of the same click as a new attempt.
    """
    rows = db.execute(
        f"""SELECT e.event_id, e.payload_json FROM events e WHERE e.class_id=? AND e.student_id=? AND e.event_type='answer_submitted'
        AND e.question_id=? AND {_FOR_ASSIGNMENT} ORDER BY e.id""", (class_id, student_id, question["id"], work_id, work_id)).fetchall()
    wrong = 0
    for index, row in enumerate(rows, start=1):
        payload = _loads(row["payload_json"], {}) or {}
        if payload.get("correct") is False:
            wrong += 1
        if row["event_id"] == event_id:
            correct = payload.get("correct") if isinstance(payload.get("correct"), bool) else None
            attempt = payload.get("attemptIndex") if isinstance(payload.get("attemptIndex"), int) else index
            result = _check_result(question, correct, str(payload.get("reason") or ""), attempt, limit, wrong)
            result["replayed"] = True
            return result
    return None


def check_inclass(db: sqlite3.Connection, class_id: str, work_id: str, data: dict, *, student_id: str,
                  preview: bool) -> tuple[dict, dict | None]:
    """Judge one in-class answer (§6.3 check v2). Returns ``(InClassCheckResult, event payload)``; caller writes the event.

    A retry with the ``eventId`` of a recorded check returns the stored result and ``None`` (nothing new to write).
    """
    row = student_row(db, class_id, work_id, student_id, preview=preview, allow_scheduled=True)
    rec = readers.record_from_row(row)
    if rec.kind != "practice":
        raise ValueError("Only in-class exercises can be checked; submit homework instead")
    question_id = data.get("questionId")
    question = readers.assignment_question(rec, question_id) if isinstance(question_id, str) else None
    if question is None:
        raise ValueError("Question not found")
    question = view_question(question, rec.kind)
    answer = data.get("answer")
    if not isinstance(answer, str) or len(answer) > 16000:
        raise ValueError("Invalid answer format")
    run_output = data.get("runOutput") if isinstance(data.get("runOutput"), str) else None
    if run_output is not None and len(run_output) > 20000:
        run_output = run_output[-20000:]
    limit = question.get("maxAttempts")
    event_id = data.get("eventId") if isinstance(data.get("eventId"), str) and ID_PATTERN.fullmatch(data["eventId"]) else None
    if event_id:
        replay = _check_replay(db, class_id, work_id, student_id, question, event_id, limit)
        if replay is not None:
            return replay, None
    problem = _state_error(rec, _now())
    if problem is not None and problem.code != "late_not_accepted":
        raise problem
    previous = db.execute(
        f"""SELECT COUNT(*) FROM events e WHERE e.class_id=? AND e.student_id=? AND e.event_type='answer_submitted'
        AND e.question_id=? AND {_FOR_ASSIGNMENT}""", (class_id, student_id, question["id"], work_id, work_id)).fetchone()[0]
    if limit is not None and previous >= limit:
        raise ApiError(409, "max_attempts_reached", "You have used every attempt for this question.")
    outcome = judging.check(question, answer, run_output if question["type"] == "complete" else None, provenance="client")
    attempt_index = int(previous) + 1
    wrong_so_far = _revealed_hint_counts(db, class_id, work_id, student_id).get(question["id"], 0) + 1
    result = _check_result(question, outcome.correct, outcome.reason, attempt_index, limit, wrong_so_far)
    payload: dict[str, Any] = {"assignmentId": work_id, "answer": answer, "correct": outcome.correct,
                               "checkedBy": "server" if outcome.correct is not None else "", "basis": outcome.basis,
                               "attemptIndex": attempt_index, "assignmentVersion": rec.version,
                               "unitId": rec.unit_id, "reason": outcome.reason}  # reason: CR-A4 (INTEGRATION)
    if outcome.basis == "client_run_output" and run_output is not None:
        payload["runOutput"] = run_output[-4000:]
    if not preview and row["frozen_at"] is None:
        db.execute("UPDATE assignments SET frozen_at=? WHERE class_id=? AND id=? AND frozen_at IS NULL",
                   (dbmod.now(), class_id, work_id))
    result["_check"] = outcome
    return result, payload


def check_practice(db: sqlite3.Connection, class_id: str, work_id: str, data: object, valid_id: ValidId, *,
                   allow_draft: bool = False) -> dict:
    """Legacy name (re-exported by ``workflows``): ``{correct, explanation, _check}`` without writing events."""
    if not isinstance(data, dict) or not valid_id(data.get("studentId")):
        raise ValueError("studentId has an invalid format")
    result, _ = check_inclass(db, class_id, work_id, {k: v for k, v in data.items() if k != "eventId"},
                              student_id=data["studentId"], preview=allow_draft)
    return {"correct": result["correct"], "explanation": result.get("explanation", ""), "_check": result["_check"]}


# -- starter assignments (css_samples) --------------------------------------------------------------
def starter_list(db: sqlite3.Connection, class_id: str, unit_ids: set[str]) -> list[dict]:
    from server.css_samples import SAMPLES

    added_keys = {r[0] for r in db.execute("SELECT starter_key FROM assignments WHERE class_id=? AND deleted_at IS NULL "
                                           "AND starter_key IS NOT NULL", (class_id,))}
    titles = {r[0] for r in db.execute("SELECT title FROM assignments WHERE class_id=? AND deleted_at IS NULL", (class_id,))}
    return [{"key": s["key"], "title": s["title"], "kind": s["kind"], "sampleUnitId": s["unitId"],
             "mappedUnitId": s["unitId"] if s["unitId"] in unit_ids else None,
             "alreadyAdded": s["key"] in added_keys or bool(titles & {s["title"], *s.get("legacyTitles", [])})}
            for s in SAMPLES]


def add_starters(db: sqlite3.Connection, class_id: str, keys: object, unit_map: object, valid_id: ValidId, *, actor: str,
                 unit_ids: set[str]) -> dict:
    """Add starter drafts; unknown chapters are mapped (``unitMap``) or skipped, never stored [AU-D1-15]."""
    from server.css_samples import SAMPLES

    if keys is not None and (not isinstance(keys, list) or any(not isinstance(k, str) for k in keys)):
        raise ValueError("keys must be a list of starter keys")
    if unit_map is not None and (not isinstance(unit_map, dict) or any(not isinstance(v, str) for v in unit_map.values())):
        raise ValueError("unitMap must map sample chapters to chapters")
    unit_map = unit_map or {}
    known = {s["key"] for s in SAMPLES}
    unknown = [k for k in keys or [] if k not in known]
    if unknown:
        raise ValueError(f"Unknown starter assignment: {unknown[0]}")
    status = {s["key"]: s for s in starter_list(db, class_id, unit_ids)}
    created: list[str] = []
    skipped: list[dict] = []
    for sample in SAMPLES:
        if keys is not None and sample["key"] not in keys:
            continue
        if status[sample["key"]]["alreadyAdded"]:
            skipped.append({"key": sample["key"], "reason": "Already added"})
            continue
        unit = unit_map.get(sample["unitId"]) or (sample["unitId"] if sample["unitId"] in unit_ids else None)
        if unit not in unit_ids:
            skipped.append({"key": sample["key"], "reason": f"Chapter {sample['unitId']} is not in this course"})
            continue
        body = {k: v for k, v in sample.items() if k not in ("key", "legacyTitles")}
        created.append(create_assignment(db, class_id, {**body, "unitId": unit}, valid_id, actor=actor, unit_ids=unit_ids,
                                         starter_key=sample["key"]))
    return {"created": len(created), "createdIds": created, "skipped": skipped}


# -- authoring list (legacy work-page) -------------------------------------------------------------
def work_page(db: sqlite3.Connection, class_id: str, args: dict) -> dict:
    """Authoring list page (v0.5.1 ``WorkPage`` with ``view=assignments``)."""
    page = max(int(args.get("page", "1")), 1)
    search = args.get("search", "")[:120]
    size = 20
    where = "a.class_id=? AND a.deleted_at IS NULL"
    params: list[object] = [class_id]
    if search:
        where += " AND instr(lower(a.title),lower(?))>0"
        params.append(search)
    if args.get("status") in ("draft", "published"):
        where += " AND a.status=?"
        params.append(args["status"])
    total = db.execute(f"SELECT COUNT(*) FROM assignments a WHERE {where}", params).fetchone()[0]
    rows = db.execute(f"SELECT a.* FROM assignments a WHERE {where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
                      [*params, size, (page - 1) * size]).fetchall()
    return {"assignments": [serialize_work(r, True) for r in rows], "submissions": [],
            "options": work_options(db, class_id, True), "page": page, "pageSize": size, "total": total}


def teacher_list(db: sqlite3.Connection, class_id: str, *, status: str, kind: str | None, unit_id: str | None,
                 search: str, page: int, page_size: int = 20) -> tuple[list[sqlite3.Row], int]:
    """Rows for ``GET /api/teacher/assignments`` (stats are added by the route)."""
    where = ["class_id=?", "deleted_at IS NULL"]
    params: list[object] = [class_id]
    if status == "archived":
        where.append("archived_at IS NOT NULL")
    else:
        where.append("archived_at IS NULL")
        if status == "draft":
            where.append("status='draft'")
        elif status in ("published", "closed"):
            where.append("status='published'")
    if kind in KINDS:
        where.append("kind=?")
        params.append(kind)
    if unit_id:
        where.append("unit_id=?")
        params.append(unit_id)
    if search:
        where.append("instr(lower(title), lower(?)) > 0")
        params.append(search)
    rows = db.execute(f"SELECT * FROM assignments WHERE {' AND '.join(where)} ORDER BY created_at DESC, id DESC", params).fetchall()
    if status in ("published", "closed"):
        now = _now()
        rows = [r for r in rows if (readers.assignment_state(readers.record_from_row(r), now) == "closed") == (status == "closed")]
    return rows[(page - 1) * page_size: page * page_size], len(rows)


def unit_ids(db: sqlite3.Connection, class_id: str) -> set[str]:
    from server import course_config

    return {u["id"] for u in course_config.course_for(class_id, db)["units"]}


def roster_ids(db: sqlite3.Connection, class_id: str) -> list[str]:
    """Enrolled students at query time (P10): active, not excluded; linked classes: Kiwi students not seen as staff."""
    linked = identitymod.class_linked(db, class_id)
    sql = ("SELECT r.student_id FROM roster r WHERE r.class_id=? AND r.status='active' AND r.excluded=0 "
           "AND r.student_id NOT LIKE 'preview-%' AND r.student_id != 'instructor'")
    if linked:
        sql += (" AND r.source='kiwi' AND NOT EXISTS (SELECT 1 FROM kiwi_staff_seen k WHERE k.class_id=r.class_id "
                "AND k.kiwi_user_id=r.student_id)")
    return [row[0] for row in db.execute(sql + " ORDER BY r.rowid", (class_id,))]
