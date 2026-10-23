"""Read-only cross-module helpers (spec §5.6; FOUNDATION, frozen signatures).

Workstreams read assignments, audiences, groups, settings and grading state only through these
functions so that every module agrees on the same rules.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timedelta
from typing import Literal

from server import db as dbmod
from server.contracts import AssignmentRecord, ToolPolicy

HOMEWORK_TOOL_DEFAULT = {"rWorkspace": True, "allowRunPredict": False, "askKiwi": "hints_only", "similarPractice": False}
INCLASS_TOOL_DEFAULT = {"rWorkspace": True, "allowRunPredict": True, "askKiwi": "explain_concepts", "similarPractice": True}
LATE_POLICY_DEFAULT = {"mode": "accept_marked", "untilAt": None, "graceMinutes": 0, "penaltyPctPerDay": 0}
ASK_KIWI_MODES = ("off", "hints_only", "explain_concepts", "worked_examples")
_NUMBER = re.compile(r"^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$", re.I)


def _loads(value: object, default: object) -> object:
    if not isinstance(value, str) or not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _time(value: object) -> datetime | None:
    try:
        return dbmod.parse_iso(value)
    except ValueError:
        return None


def _now(now: object) -> datetime:
    parsed = _time(now) if now is not None else None
    return parsed or dbmod.utcnow()


def tool_policy_for(kind: str, stored: object) -> ToolPolicy:
    """§4.5.1: ``{}`` (or missing keys) reads as the homework / in-class default."""
    base = HOMEWORK_TOOL_DEFAULT if kind == "homework" else INCLASS_TOOL_DEFAULT
    data = stored if isinstance(stored, dict) else {}
    merged = {**base, **{k: v for k, v in data.items() if k in base}}
    ask = merged["askKiwi"] if merged["askKiwi"] in ASK_KIWI_MODES else base["askKiwi"]
    return ToolPolicy(bool(merged["rWorkspace"]), bool(merged["allowRunPredict"]), ask, bool(merged["similarPractice"]))


def v2_question(question: dict, kind: str) -> dict:
    """Legacy read mapping of a stored question to Question JSON v2 (§4.5.2; no rewrite)."""
    q = dict(question)
    q.setdefault("choices", [])
    q.setdefault("starterCode", "")
    q.setdefault("points", 10)
    answer = q.get("answer") or ""
    if "studentExplanation" not in q and "graderRubric" not in q:
        explanation = q.get("explanation") or ""
        if kind == "homework":
            q["graderRubric"] = explanation
        else:
            q["studentExplanation"] = explanation
    if q.get("type") == "complete" and "referenceCode" not in q and "expectedOutput" not in q and answer:
        if "<-" in answer or "(" in answer or "\n" in answer:
            q["referenceCode"] = answer
        else:
            q["expectedOutput"] = answer
    grading = dict(q.get("grading") or {})
    grading.setdefault("caseSensitive", True)
    grading.setdefault("whitespace", "outside_strings")
    if "numericTolerance" not in grading:
        grading["numericTolerance"] = 1e-9 if _NUMBER.fullmatch(answer.strip() or "x") else None
    grading.setdefault("autoCheck", q.get("type") != "text")
    q["grading"] = grading
    q.setdefault("acceptedAnswers", [])
    q.setdefault("hints", [])
    q.setdefault("tags", [])
    q.setdefault("maxAttempts", None)
    return q


def record_from_row(row: sqlite3.Row) -> AssignmentRecord:
    keys = row.keys()

    def col(name: str, default: object = None) -> object:
        return row[name] if name in keys else default

    kind = row["kind"]
    questions = [v2_question(q, kind) for q in _loads(row["questions_json"], []) if isinstance(q, dict)]
    late = {**LATE_POLICY_DEFAULT, **(_loads(col("late_policy_json"), {}) or {})}
    audience = _loads(col("audience_json"), {"type": "all"}) or {"type": "all"}
    return AssignmentRecord(
        id=row["id"], class_id=row["class_id"], kind=kind, title=row["title"], unit_id=row["unit_id"],
        status=row["status"], due_at=row["due_at"], open_at=col("open_at"), close_at=col("close_at"),
        late_policy=late, max_attempts=col("max_attempts"),
        grades_visibility=col("grades_visibility", "immediately") or "immediately",
        solutions_visibility=col("solutions_visibility", "never") or "never",
        tool_policy=tool_policy_for(kind, _loads(col("tool_policy_json"), {})),
        audience=audience if isinstance(audience, dict) else {"type": "all"},
        archived_at=col("archived_at"), deleted_at=col("deleted_at"), version=int(col("version", 1) or 1),
        frozen_at=col("frozen_at"), questions=questions, time_limit=_loads(col("time_limit_json"), None),
        updated_at=row["updated_at"],
    )


def load_assignment(db: sqlite3.Connection, class_id: str, assignment_id: str,
                    include_deleted: bool = False) -> AssignmentRecord | None:
    row = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=?", (class_id, assignment_id)).fetchone()
    if row is None:
        return None
    rec = record_from_row(row)
    if rec.deleted_at and not include_deleted:
        return None
    return rec


def assignment_question(rec: AssignmentRecord, question_id: str) -> dict | None:
    return next((q for q in rec.questions if q.get("id") == question_id), None)


def assignment_snapshot(row: sqlite3.Row) -> dict:
    """Snapshot stored in ``assignment_versions.snapshot_json`` (full questions as stored)."""
    keys = row.keys()
    rec = record_from_row(row)
    return {
        "title": row["title"], "kind": row["kind"], "unitId": row["unit_id"], "instructions": row["instructions"],
        "dueAt": row["due_at"], "openAt": rec.open_at, "closeAt": rec.close_at, "latePolicy": rec.late_policy,
        "maxAttempts": rec.max_attempts, "timeLimit": rec.time_limit, "gradesVisibility": rec.grades_visibility,
        "solutionsVisibility": rec.solutions_visibility, "toolPolicy": rec.tool_policy.as_dict(),
        "audience": rec.audience, "questions": _loads(row["questions_json"], []),
        "version": int(row["version"]) if "version" in keys and row["version"] else 1,
    }


def questions_hash(questions: object) -> str:
    return hashlib.sha256(dbmod.json_dumps(questions).encode("utf-8")).hexdigest()


def question_ids_any_version(db: sqlite3.Connection, class_id: str, assignment_id: str) -> set[str]:
    ids: set[str] = set()
    row = db.execute("SELECT questions_json FROM assignments WHERE class_id=? AND id=?",
                     (class_id, assignment_id)).fetchone()
    if row:
        ids |= {q.get("id") for q in _loads(row["questions_json"], []) if isinstance(q, dict)}
    for version in db.execute("SELECT snapshot_json FROM assignment_versions WHERE class_id=? AND assignment_id=?",
                              (class_id, assignment_id)):
        snapshot = _loads(version["snapshot_json"], {})
        if isinstance(snapshot, dict):
            ids |= {q.get("id") for q in snapshot.get("questions", []) if isinstance(q, dict)}
    return {i for i in ids if isinstance(i, str)}


def current_version(db: sqlite3.Connection, class_id: str, assignment_id: str) -> int | None:
    row = db.execute("SELECT version FROM assignments WHERE class_id=? AND id=?", (class_id, assignment_id)).fetchone()
    return int(row["version"]) if row and row["version"] is not None else None


def _grace(rec: AssignmentRecord) -> timedelta:
    try:
        return timedelta(minutes=int(rec.late_policy.get("graceMinutes") or 0))
    except (TypeError, ValueError):
        return timedelta(0)


def assignment_state(rec: AssignmentRecord, now: object) -> Literal["draft", "scheduled", "open", "past_due", "closed", "archived"]:
    current = _now(now)
    # S-M07: an archived draft is "archived" (the list then offers Unarchive), not "draft"
    if rec.archived_at:
        return "archived"
    if rec.status == "draft":
        return "draft"
    open_at = _time(rec.open_at)
    if open_at is not None and open_at > current:
        return "scheduled"
    close_at = _time(rec.close_at)
    if close_at is not None and close_at <= current:
        return "closed"
    due = _time(rec.due_at)
    mode = rec.late_policy.get("mode", "accept_marked")
    if mode == "accept_until":
        until = _time(rec.late_policy.get("untilAt"))
        if until is not None and current >= until:
            return "closed"
    if due is not None and due + _grace(rec) <= current:
        if mode == "not_accepted":
            return "closed"
        return "past_due"
    return "open"


def student_groups(db: sqlite3.Connection, class_id: str, student_id: str) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {"section": [], "condition": [], "cohort": []}
    for row in db.execute(
        """SELECT m.group_id, m.kind FROM group_members m JOIN course_groups g ON g.id = m.group_id
        WHERE m.class_id=? AND m.student_id=? AND g.archived_at IS NULL ORDER BY m.assigned_at, m.group_id""",
        (class_id, student_id),
    ):
        groups.setdefault(row["kind"], []).append(row["group_id"])
    return groups


def group_stamp(db: sqlite3.Connection, class_id: str, student_id: str) -> tuple[str, str]:
    """(section_group_id, condition_group_id) at write time, or ('', '')."""
    groups = student_groups(db, class_id, student_id)
    return (groups["section"][0] if groups["section"] else "", groups["condition"][0] if groups["condition"] else "")


def in_audience(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str) -> bool:
    audience = rec.audience or {"type": "all"}
    if audience.get("type") != "groups":
        return True
    wanted = {g for g in audience.get("groupIds") or [] if isinstance(g, str)}
    if not wanted:
        return False
    groups = student_groups(db, rec.class_id, student_id)
    return bool(wanted & {g for ids in groups.values() for g in ids})


def settings(db: sqlite3.Connection, class_id: str) -> dict:
    """``course_settings`` for the class with defaults applied (§4.5.4)."""
    from server import course_config

    row = None
    if dbmod.table_exists(db, "course_settings"):
        row = db.execute("SELECT settings_json FROM course_settings WHERE class_id=?", (class_id,)).fetchone()
    return course_config.merge_settings(_loads(row["settings_json"], {}) if row else {})


def roster_entry(db: sqlite3.Connection, class_id: str, student_id: str) -> dict | None:
    row = db.execute("SELECT * FROM roster WHERE class_id=? AND student_id=?", (class_id, student_id)).fetchone()
    return dict(row) if row else None


def _latest_submission(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str) -> sqlite3.Row | None:
    return db.execute(
        """SELECT * FROM submissions WHERE class_id=? AND assignment_id=? AND student_id=? AND is_preview=0
        ORDER BY attempt DESC, submitted_at DESC, id DESC LIMIT 1""",
        (rec.class_id, rec.id, student_id),
    ).fetchone()


# ─── revision lineage (S-M01, S-M02) ───────────────────────────────────────────────────────────
_LINEAGE_LIMIT = 20


def lineage_ids(db: sqlite3.Connection, class_id: str, assignment_id: str) -> tuple[list[str], list[str]]:
    """``(originals, revisions)`` of an assignment: its ``revision_of`` chain (nearest first) and every revision made
    from it, directly or from one of its revisions (deleted rows excluded, at most 20 each)."""
    if "revision_of" not in dbmod.table_columns(db, "assignments"):
        return [], []
    originals = original_ids(db, class_id, assignment_id)
    seen = {assignment_id, *originals}
    revisions: list[str] = []
    frontier = [assignment_id]
    while frontier and len(revisions) < _LINEAGE_LIMIT:
        marks = ",".join("?" for _ in frontier)
        found = [r[0] for r in db.execute(
            f"""SELECT id FROM assignments WHERE class_id=? AND revision_of IN ({marks}) AND deleted_at IS NULL
            ORDER BY created_at, id""", (class_id, *frontier)) if r[0] not in seen]
        seen.update(found)
        revisions.extend(found)
        frontier = found
    return originals, revisions[:_LINEAGE_LIMIT]


def _lineage_records(db: sqlite3.Connection, rec: AssignmentRecord) -> list[AssignmentRecord]:
    originals, revisions = lineage_ids(db, rec.class_id, rec.id)
    out = []
    for other_id in [*revisions, *originals]:
        other = load_assignment(db, rec.class_id, other_id)
        if other is not None:
            out.append(other)
    return out


def original_ids(db: sqlite3.Connection, class_id: str, assignment_id: str) -> list[str]:
    """The ``revision_of`` chain of an assignment, nearest original first (empty for an assignment that is no revision)."""
    if "revision_of" not in dbmod.table_columns(db, "assignments"):
        return []
    seen = {assignment_id}
    out: list[str] = []
    current = assignment_id
    for _ in range(_LINEAGE_LIMIT):
        row = db.execute("SELECT revision_of FROM assignments WHERE class_id=? AND id=?", (class_id, current)).fetchone()
        parent = row["revision_of"] if row is not None else None
        if not parent or parent in seen:
            break
        out.append(parent)
        seen.add(parent)
        current = parent
    return out


def submitted_original(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str) -> AssignmentRecord | None:
    """S-M01: the nearest original of this revision that the student submitted (non-preview), or None."""
    for original_id in original_ids(db, rec.class_id, rec.id):
        if db.execute("""SELECT 1 FROM submissions WHERE class_id=? AND assignment_id=? AND student_id=? AND is_preview=0
                LIMIT 1""", (rec.class_id, original_id, student_id)).fetchone():
            return load_assignment(db, rec.class_id, original_id, include_deleted=True)
    return None


def originals_submitted_by(db: sqlite3.Connection, rec: AssignmentRecord) -> set[str]:
    """S-M01: students with a (non-preview) submission on any original of this revision."""
    originals = original_ids(db, rec.class_id, rec.id)
    if not originals:
        return set()
    marks = ",".join("?" for _ in originals)
    return {r[0] for r in db.execute(
        f"SELECT DISTINCT student_id FROM submissions WHERE class_id=? AND is_preview=0 AND assignment_id IN ({marks})",
        (rec.class_id, *originals))}


def protecting_relative(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str, now: object) -> AssignmentRecord | None:
    """S-M02: another assignment of the same revision lineage that protects its (shared) answers for this student now.

    WHY: publishing a revision closes the original, and a closed original would show its solutions and let Ask Kiwi
    discuss answers that the open revision still asks for.
    """
    if rec.kind != "homework":
        return None
    for other in _lineage_records(db, rec):
        if other.kind == "homework" and _own_protected(db, other, student_id, now):
            return other
    return None


def solutions_visible(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str, now: object) -> bool:
    """Whether the student may see this homework's solutions: its own rule, unless a revision (or the original) of it
    still protects the same answers (S-M02)."""
    return _own_solutions_visible(db, rec, student_id, now) and protecting_relative(db, rec, student_id, now) is None


def _own_solutions_visible(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str, now: object) -> bool:
    mode = rec.solutions_visibility
    if mode == "after_submit":
        return _latest_submission(db, rec, student_id) is not None
    if mode == "after_due":
        # Decision D2: "After the due date" waits for the late window too — solutions appear once the homework no
        # longer accepts submissions, so a late submitter never sees them first.
        # Review 2 (CORRECTNESS-08): homework with a close date but no due date shows solutions once it closes.
        if assignment_state(rec, now) != "closed":
            return False
        due = _time(rec.due_at)
        return due is None or _now(now) >= due + _grace(rec)
    if mode == "after_release":
        latest = _latest_submission(db, rec, student_id)
        return latest is not None and latest["grade_status"] == "released"
    return False


def answer_protected(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str, now: object) -> bool:
    """§5.6: homework answers stay protected while submissions are accepted or solutions are never shown.

    Decision D2: with the default ``after_due`` this means protected until the homework closes (due date plus any late
    window); homework accepting late work with no end date stays protected until a close date is set or it is archived.
    S-M02: a published homework also stays protected while another assignment of its revision lineage (its revision or
    its original) protects the same answers for the student.
    """
    if _own_protected(db, rec, student_id, now):
        return True
    if rec.kind != "homework" or rec.status != "published" or rec.archived_at or rec.deleted_at:
        return False
    return protecting_relative(db, rec, student_id, now) is not None


def _own_protected(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str, now: object) -> bool:
    if rec.kind != "homework" or rec.status != "published" or rec.archived_at or rec.deleted_at:
        return False
    open_at = _time(rec.open_at)
    if open_at is not None and open_at > _now(now):
        return False
    if not in_audience(db, rec, student_id):
        return False
    if _own_solutions_visible(db, rec, student_id, now):
        return False
    state = assignment_state(rec, now)
    return state in ("open", "past_due") or rec.solutions_visibility == "never"


def open_homework_questions(db: sqlite3.Connection, class_id: str, student_id: str,
                            now: object) -> list[tuple[AssignmentRecord, dict]]:
    result: list[tuple[AssignmentRecord, dict]] = []
    for row in db.execute(
        """SELECT * FROM assignments WHERE class_id=? AND kind='homework' AND status='published'
        AND archived_at IS NULL AND deleted_at IS NULL ORDER BY created_at, id""",
        (class_id,),
    ):
        rec = record_from_row(row)
        if answer_protected(db, rec, student_id, now):
            result.extend((rec, q) for q in rec.questions)
    return result


def latest_submission_ids_sql() -> str:
    """SQL selecting the newest non-preview attempt id per (class, student, assignment)."""
    return ("SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY class_id, assignment_id, student_id "
            "ORDER BY attempt DESC, submitted_at DESC, id DESC) AS rn FROM submissions WHERE is_preview = 0) "
            "WHERE rn = 1")


def grading_counts(db: sqlite3.Connection, class_id: str, assignment_id: str | None = None,
                   group_id: str | None = None) -> dict:
    """``{toGrade, late, draft, toRelease, flagged, graded, all}`` — delegates to ``grading_rules`` (GRADE)."""
    from server import grading_rules

    return grading_rules.grading_counts(db, class_id, assignment_id, group_id)


def gradebook_cell(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str, policy: str = "latest",
                   now: object = None) -> dict:
    """``GradebookCell`` (§7.5) — delegates to ``grading_rules`` (GRADE)."""
    from server import grading_rules

    return grading_rules.gradebook_cell(db, rec, student_id, policy, now)


def registered_standalone(db: sqlite3.Connection, class_id: str) -> bool:
    """Standalone student writes need a ``courses`` row, any assignment, or KIWI_STANDALONE_CLASS_IDS."""
    import os

    configured = [c.strip() for c in os.environ.get("KIWI_STANDALONE_CLASS_IDS", "local-r-class").split(",") if c.strip()]
    if class_id in configured:
        return True
    if db.execute("SELECT 1 FROM courses WHERE class_id=?", (class_id,)).fetchone():
        return True
    return db.execute("SELECT 1 FROM assignments WHERE class_id=? LIMIT 1", (class_id,)).fetchone() is not None
