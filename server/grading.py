"""Grading workbench, release, gradebook, LMS exports and exercise results (owned by GRADE; spec §6.4, §9.2).

Grade v2: per-question scores and comments in ``submission_item_scores`` (auto results pre-fill objective
questions), an optional adjustment (late penalty), overall feedback, and an append-only ``grade_events`` history
with the grader's label stored at write time. ``action: "save"`` always stores a draft; only a release (which needs
``releaseGrades``) makes a grade visible and writes a server ``grade_released`` event.

The legacy total-only grade (``POST /api/submissions/{id}/grade``) keeps v0.5.1 semantics (released immediately),
the legacy hub and grading page keep their v0.5.1 shapes.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from server import audit, auth, grading_rules, readers, telemetry
from server import db as dbmod
from server import identity as identitymod
from server.contracts import AssignmentRecord
from server.router import ApiError

QUEUE_PAGE_SIZE = 10
ORDER_LIMIT = 1000
SHOW_CHOICES = ("latest", "all", "graded", "late", "flagged", "draft")
VIEW_CHOICES = ("student", "question")
MAX_COMMENT = 4000
MAX_FEEDBACK = 4000
MAX_REASON = 200
LATE_PENALTY_REASON = "Late penalty (auto)"
LATE_PENALTY_REMOVED = "Late penalty removed"
STUCK_WRONG_ATTEMPTS = 3
STUCK_WINDOW = timedelta(minutes=15)
TOP_WRONG_ANSWERS = 5
RELEASED_LOCKED = "This grade is released. Ask an instructor to unrelease it before you change it."
# S-B01: "Apply score to group" never withdraws a released grade; the group view skips released attempts.
RELEASED_KEPT = "This grade is released, so it was not changed. Unrelease it on its card to change it."
GRADED_ACTIONS = ("save_draft", "release", "bulk_release", "legacy_grade", "migrated", "unrelease")


# -- small helpers ---------------------------------------------------------------------------------
def _num(value: float | None) -> float | int | None:
    """JSON-friendly number: whole numbers as int, others rounded to 2 decimals."""
    if value is None:
        return None
    number = round(float(value), 2) + 0.0
    return int(number) if number.is_integer() else number


def _loads(value: object, default: Any) -> Any:
    if not isinstance(value, str) or not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _text(value: object, label: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise ApiError(400, "invalid_request", f"{label} must be text")
    if len(value) > maximum:
        raise ApiError(400, "invalid_request", f"{label} must be at most {maximum:,} characters")
    return value


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _student_label(db: sqlite3.Connection, class_id: str, student_id: str, mode: str) -> str:
    if student_id.startswith("preview-"):
        return "Preview student"
    return identitymod.label(db, class_id, student_id, mode)


def _tz(db: sqlite3.Connection, class_id: str) -> ZoneInfo:
    try:
        return ZoneInfo(readers.settings(db, class_id)["schedule"].get("timezone") or "Asia/Shanghai")
    except (ZoneInfoNotFoundError, ValueError, TypeError, KeyError):
        return ZoneInfo("Asia/Shanghai")


def _load_rec(db: sqlite3.Connection, class_id: str, assignment_id: str) -> AssignmentRecord:
    rec = readers.load_assignment(db, class_id, assignment_id, include_deleted=True)
    if rec is None:
        raise ApiError(404, "not_found", "Assignment not found")
    return rec


def _submission_row(db: sqlite3.Connection, class_id: str, submission_id: str) -> sqlite3.Row:
    row = db.execute("SELECT * FROM submissions WHERE class_id=? AND id=?", (class_id, submission_id)).fetchone()
    if row is None:
        raise ApiError(404, "not_found", "Submission not found")
    return row


def _latest_grade_event(db: sqlite3.Connection, submission_id: str) -> int | None:
    value = db.execute("SELECT MAX(id) FROM grade_events WHERE submission_id=?", (submission_id,)).fetchone()[0]
    return int(value) if value is not None else None


def _item_rows(db: sqlite3.Connection, submission_id: str) -> dict[str, sqlite3.Row]:
    return {r["question_id"]: r for r in db.execute("SELECT * FROM submission_item_scores WHERE submission_id=?",
                                                     (submission_id,))}


def late_penalty(maximum: float, late_seconds: int, pct_per_day: float) -> float:
    """``-round(maxPoints · pct/100 · ceil(lateHours/24), 2)``, never below ``-maxPoints``."""
    if late_seconds <= 0 or pct_per_day <= 0 or maximum <= 0:
        return 0.0
    days = math.ceil(late_seconds / 86400)
    return max(-round(maximum * pct_per_day / 100 * days, 2), -maximum)


def _late_text(seconds: int) -> str:
    minutes = max(1, round(seconds / 60))
    if minutes < 60:
        return f"Late · {minutes} min"
    hours = round(seconds / 3600)
    if hours < 72:
        return f"Late · {hours} h"
    return f"Late · {round(seconds / 86400)} d"


def _timeline_url(student_id: str, assignment_id: str) -> str:
    return f"/teacher/students/s/{quote(student_id, safe='')}/assignments/{quote(assignment_id, safe='')}"


def _grading_url(**query: str) -> str:
    return "/teacher/grading?" + urlencode({k: v for k, v in query.items() if v})


def _student_identity(db: sqlite3.Connection, class_id: str, student_id: str) -> auth.Identity:
    """The identity a server-written event of this student is stamped with (preview rows stay preview)."""
    if student_id.startswith("preview-"):
        user = student_id[len("preview-"):] or "instructor"
        return auth.Identity("teacher_key", class_id, user, "Preview student", None, "instructor", True, False, False, True,
                             student_id, frozenset())
    linked = identitymod.class_linked(db, class_id)
    return auth.student_identity(class_id, student_id, kind="kiwi" if linked else "demo",
                                 display_name=identitymod.label(db, class_id, student_id), linked=linked)


def _write_release_event(db: sqlite3.Connection, row: sqlite3.Row, total: float | None, maximum: float, releaser: Any) -> None:
    """``grade_released`` on the student's row, stamped with the releasing staff member's role (SB-M01).

    WHY: the release is a staff action. Stored with the student's own role it moved "Last active", the explorer's
    last activity and research events.csv to the release time, so releasing grades made inactive students look active.
    """
    ident = _student_identity(db, row["class_id"], row["student_id"])
    actor = audit.actor_label(releaser)
    role = getattr(releaser, "actor_role", None) if releaser is not None else None
    telemetry.add_event(db, ident, {
        "classId": row["class_id"], "studentId": row["student_id"], "studentName": ident.display_name or row["student_id"],
        "sessionId": ("grade-" + row["id"])[:100], "type": "grade_released", "surface": "assignment", "schemaVersion": 2,
        "payload": {"submissionId": row["id"], "assignmentId": row["assignment_id"], "total": _num(total),
                    "maxPoints": _num(maximum), "releasedBy": actor},
    }, server=True, actor_role=role if role in identitymod.STAFF_ACTOR_ROLES and role != "preview" else "staff")


def _grade_event(db: sqlite3.Connection, row: sqlite3.Row, ident: Any, action: str, *, total_before: float | None,
                 total_after: float | None, items_before: dict | None = None, items_after: dict | None = None,
                 feedback_before: str | None = None, feedback_after: str | None = None, status_before: str | None,
                 status_after: str | None, stamp: str) -> int:
    cur = db.execute(
        """INSERT INTO grade_events (submission_id, class_id, actor_id, actor_role, actor_label, action, total_before,
        total_after, items_before_json, items_after_json, feedback_before, feedback_after, status_before, status_after,
        created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (row["id"], row["class_id"], (getattr(ident, "user_id", None) or "") if ident is not None else "",
         getattr(ident, "actor_role", "unknown") if ident is not None else "unknown", audit.actor_label(ident), action,
         total_before, total_after, dbmod.json_dumps(items_before or {}), dbmod.json_dumps(items_after or {}),
         feedback_before, feedback_after, status_before, status_after, stamp))
    return int(cur.lastrowid)


# -- teacher assignment view -----------------------------------------------------------------------
def teacher_assignment(db: sqlite3.Connection, rec: AssignmentRecord, now: object = None) -> dict:
    """``TeacherAssignment`` (§7.4) built from the stored row (GRADE's read-only copy of the shape)."""
    row = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=?", (rec.class_id, rec.id)).fetchone()
    keys = row.keys() if row is not None else []

    def col(name: str, default: Any = None) -> Any:
        return row[name] if row is not None and name in keys else default

    if rec.kind == "homework":
        attempts = db.execute("SELECT COUNT(*) FROM submissions WHERE class_id=? AND assignment_id=? AND is_preview=0",
                              (rec.class_id, rec.id)).fetchone()[0]
    else:
        attempts = db.execute(
            """SELECT COUNT(*) FROM events WHERE class_id=? AND event_type='answer_submitted' AND attribution_assignment_id=?
            AND is_preview=0""", (rec.class_id, rec.id)).fetchone()[0]
    versions = [{"version": v["version"], "createdAt": v["created_at"], "reason": v["reason"]} for v in db.execute(
        "SELECT version, created_at, reason FROM assignment_versions WHERE class_id=? AND assignment_id=? ORDER BY version",
        (rec.class_id, rec.id))]
    files = [{"id": f["id"], "name": f["name"], "mime": f["mime"], "size": f["size"], "scope": f["scope"],
              "questionId": f["question_id"], "unitId": f["unit_id"], "mountInR": bool(f["mount_in_r"]),
              "aiReference": bool(f["ai_reference"]), "createdAt": f["created_at"]} for f in db.execute(
        """SELECT id, name, mime, size, scope, question_id, unit_id, mount_in_r, ai_reference, created_at FROM course_files
        WHERE class_id=? AND scope='assignment' AND assignment_id=? AND deleted_at IS NULL ORDER BY created_at, id""",
        (rec.class_id, rec.id))]
    return {
        "id": rec.id, "classId": rec.class_id, "kind": rec.kind, "title": rec.title, "unitId": rec.unit_id,
        "instructions": col("instructions", "") or "", "dueAt": rec.due_at, "openAt": rec.open_at, "closeAt": rec.close_at,
        "latePolicy": rec.late_policy, "maxAttempts": rec.max_attempts, "timeLimit": rec.time_limit,
        "gradesVisibility": rec.grades_visibility, "solutionsVisibility": rec.solutions_visibility,
        "toolPolicy": rec.tool_policy.as_dict(), "audience": rec.audience, "questions": rec.questions,
        "retireOriginalOnPublish": bool(col("retire_original_on_publish", 0)), "status": rec.status,
        "state": readers.assignment_state(rec, now), "version": rec.version, "frozen": rec.frozen_at is not None,
        "frozenAt": rec.frozen_at, "attemptCount": int(attempts), "revisionOf": col("revision_of"), "files": files,
        "attachmentName": col("file_name"), "versions": versions, "createdAt": col("created_at"),
        "updatedAt": rec.updated_at, "archivedAt": rec.archived_at,
    }


# -- submission detail -----------------------------------------------------------------------------
def _items(rec: AssignmentRecord, stored: dict[str, sqlite3.Row]) -> list[dict]:
    items = []
    for question in rec.questions:
        row = stored.get(question.get("id"))
        auto_correct = None if row is None or row["auto_correct"] is None else bool(row["auto_correct"])
        auto_score = row["auto_score"] if row is not None else None
        score = row["score"] if row is not None else None
        if score is None and auto_correct is not None and auto_score is not None:
            score = auto_score                      # pre-filled from the auto-check (GRADE-02)
        items.append({"questionId": question.get("id"), "points": _num(float(question.get("points") or 0)),
                      "autoCorrect": auto_correct, "autoScore": _num(auto_score), "autoReason": (row["auto_reason"] if row else ""),
                      "score": _num(score), "comment": (row["comment"] if row else "") or "",
                      "overridden": bool(row["overridden"]) if row is not None else False})
    return items


def _process(db: sqlite3.Connection, rec: AssignmentRecord, row: sqlite3.Row) -> dict:
    """Work-process summary (§7.5 ``ProcessSummary``) for the student's work on this assignment until submission."""
    args = (row["class_id"], row["student_id"], rec.id, row["submitted_at"])
    ev = db.execute(
        """SELECT
        COALESCE(SUM(CASE WHEN event_type='code_run' THEN 1 ELSE 0 END), 0) AS runs,
        COALESCE(SUM(CASE WHEN event_type='code_run' AND json_extract(payload_json,'$.ok') = 0 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(SUM(CASE WHEN event_type='paste' AND json_extract(payload_json,'$.matchesAiReply') = 1 THEN 1 ELSE 0 END), 0) AS pastes,
        COALESCE(SUM(CASE WHEN event_type='study_heartbeat' AND heartbeat_counted = 1 THEN 1 ELSE 0 END), 0) AS beats,
        COALESCE(SUM(CASE WHEN event_type='study_heartbeat' AND json_type(payload_json,'$.seconds') IN ('integer','real')
            THEN min(max(CAST(json_extract(payload_json,'$.seconds') AS INTEGER), 0), 60) ELSE 0 END), 0) AS legacy_seconds,
        COALESCE(SUM(CASE WHEN event_type='ai_question' AND chat_turn_id IS NULL THEN 1 ELSE 0 END), 0) AS client_ai
        FROM events WHERE class_id=? AND student_id=? AND attribution_assignment_id=? AND created_at <= ?""", args).fetchone()
    similar = db.execute(
        """SELECT COUNT(*) FROM events WHERE class_id=? AND student_id=? AND event_type='similar_requested'
        AND (related_assignment_id=? OR json_extract(payload_json,'$.sourceAssignmentId')=?) AND created_at <= ?""",
        (row["class_id"], row["student_id"], rec.id, rec.id, row["submitted_at"])).fetchone()[0]
    chat = db.execute(
        """SELECT COUNT(*) AS turns, COALESCE(SUM(flagged), 0) AS flagged FROM chat_turns
        WHERE class_id=? AND student_id=? AND assignment_id=? AND created_at <= ?""", args).fetchone()
    minutes = ev["beats"] * 0.5 if ev["beats"] else ev["legacy_seconds"] / 60
    return {"askKiwiMode": rec.tool_policy.ask_kiwi, "aiQuestions": int(chat["turns"] + ev["client_ai"]),
            "flaggedReplies": int(chat["flagged"]), "codeRuns": int(ev["runs"]), "codeErrors": int(ev["errors"]),
            "similarRequested": int(similar), "pastesFromAi": int(ev["pastes"]), "activeMinutes": round(minutes, 1),
            "timelineUrl": _timeline_url(row["student_id"], rec.id)}


def _has_saved_grade(row: sqlite3.Row) -> bool:
    return row["graded_by"] is not None or row["grade"] is not None


def _adjustment(row: sqlite3.Row, rec: AssignmentRecord, maximum: float) -> dict:
    pct = float(rec.late_policy.get("penaltyPctPerDay") or 0)
    if not _has_saved_grade(row) and row["is_late"] and pct > 0:
        return {"points": _num(late_penalty(maximum, int(row["late_seconds"] or 0), pct)), "reason": LATE_PENALTY_REASON,
                "auto": True}
    reason = row["adjustment_reason"] or ""
    return {"points": _num(float(row["adjustment_points"] or 0)), "reason": reason, "auto": reason == LATE_PENALTY_REASON}


def _submission_view(row: sqlite3.Row, label: str) -> dict:
    return {"id": row["id"], "assignmentId": row["assignment_id"], "studentId": row["student_id"], "studentName": label,
            "attempt": row["attempt"], "answers": _loads(row["answers_json"], {}), "submittedAt": row["submitted_at"],
            "grade": _num(row["grade"]), "feedback": row["feedback"], "gradedAt": row["graded_at"],
            "gradeStatus": row["grade_status"], "isLate": bool(row["is_late"]), "lateSeconds": int(row["late_seconds"] or 0),
            "isPreview": bool(row["is_preview"]), "overTime": bool(row["over_time"]),
            "timeUsedSeconds": row["time_used_seconds"]}


def submission_detail(db: sqlite3.Connection, class_id: str, submission_id: str, name_mode: str = "names", *,
                      cache: dict | None = None, flags: dict[str, list[dict]] | None = None) -> dict:
    """``SubmissionDetail`` (§7.5): answers, auto results, rubric, item scores, history, process, flags."""
    cache = cache if cache is not None else {}
    row = _submission_row(db, class_id, submission_id)
    rec = cache.get(("rec", row["assignment_id"])) or _load_rec(db, class_id, row["assignment_id"])
    cache[("rec", rec.id)] = rec
    assignment = cache.get(("assignment", rec.id)) or teacher_assignment(db, rec)
    cache[("assignment", rec.id)] = assignment
    maximum = grading_rules.max_points(rec)
    items = _items(rec, _item_rows(db, submission_id))
    adjustment = _adjustment(row, rec, maximum)
    if row["grade_status"] in ("draft", "released") and row["grade"] is not None:
        total: float | None = float(row["grade"])
    elif items and all(i["score"] is not None for i in items):
        total = min(max(sum(float(i["score"]) for i in items) + float(adjustment["points"] or 0), 0.0), maximum)
    else:
        total = None
    label = _student_label(db, class_id, row["student_id"], name_mode)
    history = [{"id": e["id"], "action": e["action"], "actorLabel": e["actor_label"] or "", "actorRole": e["actor_role"],
                "totalBefore": _num(e["total_before"]), "totalAfter": _num(e["total_after"]),
                "statusAfter": e["status_after"] if e["status_after"] in ("ungraded", "draft", "released") else None,
                "createdAt": e["created_at"]}
               for e in db.execute("SELECT * FROM grade_events WHERE submission_id=? ORDER BY id", (submission_id,))]
    attempts = db.execute(
        """SELECT id, attempt, submitted_at, grade_status, grade FROM submissions WHERE class_id=? AND assignment_id=?
        AND student_id=? ORDER BY attempt DESC, submitted_at DESC, id DESC""",
        (class_id, row["assignment_id"], row["student_id"])).fetchall()
    earlier = [{"id": a["id"], "attempt": a["attempt"], "submittedAt": a["submitted_at"], "gradeStatus": a["grade_status"],
                "grade": _num(a["grade"])} for a in attempts if a["attempt"] < row["attempt"]]
    newer = [a for a in attempts if a["attempt"] > row["attempt"]]
    late_seconds = int(row["late_seconds"] or 0)
    pct = float(rec.late_policy.get("penaltyPctPerDay") or 0)
    card_flags: list[dict] = []
    if row["is_late"]:
        card_flags.append({"kind": "late", "text": _late_text(late_seconds)})
    if row["over_time"]:
        used = int(row["time_used_seconds"] or 0)
        limit_minutes = int((rec.time_limit or {}).get("minutes") or 0) if isinstance(rec.time_limit, dict) else 0
        # S-m07: minutes over the limit (not the total time used)
        over = max(0, used - limit_minutes * 60) if limit_minutes else used
        card_flags.append({"kind": "over_time", "text": f"Over time · {max(1, round(over / 60))} min over"})
    integrity = flags if flags is not None else grading_rules.flags_for(db, class_id, [submission_id])
    card_flags.extend(integrity.get(submission_id, []))
    if newer:
        newest = newer[0]
        text = "Newer attempt ungraded" if newest["grade_status"] == "ungraded" else f"Newer attempt (attempt {newest['attempt']})"
        card_flags.append({"kind": "newer_attempt", "text": text,
                           "href": _grading_url(assignmentId=rec.id, studentId=row["student_id"], submissionId=newest["id"],
                                                show="all")})
    time_used = None
    if row["time_used_seconds"] is not None:
        limit = int((rec.time_limit or {}).get("minutes") or 0) if isinstance(rec.time_limit, dict) else 0
        time_used = {"seconds": int(row["time_used_seconds"]), "limitMinutes": limit, "overTime": bool(row["over_time"])}
    return {
        "submission": _submission_view(row, label), "assignment": assignment, "studentLabel": label, "items": items,
        "total": _num(total), "maxPoints": _num(maximum), "adjustment": adjustment,
        "late": {"lateHours": round(late_seconds / 3600, 2), "penaltyPctPerDay": _num(pct)} if row["is_late"] else None,
        "timeUsed": time_used, "history": history, "latestGradeEventId": history[-1]["id"] if history else None,
        "earlierAttempts": earlier, "process": _process(db, rec, row), "flags": card_flags,
    }


# -- grade v2 --------------------------------------------------------------------------------------
def _parse_adjustment(value: object, maximum: float) -> tuple[float, str]:
    if not isinstance(value, dict):
        raise ApiError(400, "invalid_request", "Adjustment must be an object with points and reason")
    points = value.get("points", 0)
    if not _is_number(points) or not -maximum <= float(points) <= 0:
        raise ApiError(400, "invalid_request", f"Adjustment points must be from -{grading_rules.fmt_points(maximum)} to 0")
    reason = _text(value.get("reason", ""), "Adjustment reason", MAX_REASON)
    return round(float(points), 2) + 0.0, reason.strip()


def save_grade(db: sqlite3.Connection, class_id: str, submission_id: str, data: object, ident: Any,
               name_mode: str = "names") -> tuple[dict, dict, dict]:
    """``PUT /api/teacher/submissions/{id}/grade`` → (SubmissionDetail, audit before, audit after)."""
    if not isinstance(data, dict):
        raise ApiError(400, "invalid_request", "Request body must be an object")
    action = data.get("action")
    if action not in ("save", "release"):
        raise ApiError(400, "invalid_request", "action must be save or release")
    if action == "release" and "releaseGrades" not in getattr(ident, "permissions", frozenset()):
        raise ApiError(403, "role_required", "Your role can save grades as drafts but cannot release them.")
    items_in = data.get("items", {})
    if not isinstance(items_in, dict):
        raise ApiError(400, "invalid_request", "items must be an object keyed by question id")
    keep_released = data.get("keepReleased", False)
    if not isinstance(keep_released, bool):
        raise ApiError(400, "invalid_request", "keepReleased must be true or false")
    with dbmod.write_tx(db):
        row = _submission_row(db, class_id, submission_id)
        can_release = "releaseGrades" in getattr(ident, "permissions", frozenset())
        if row["grade_status"] == "released" and keep_released:
            # WHY (S-B01): a bulk write (By question › Apply score to group) must not silently withdraw a released grade;
            # the caller asked to leave released grades as they are.
            raise ApiError(409, "grade_released", RELEASED_KEPT)
        if row["grade_status"] == "released" and action == "save" and not can_release:
            # WHY (review 2, CORRECTNESS-01): "save" stores a draft, which would withdraw a released grade. Only roles that
            # may release grades may withdraw one (the instructor-only Unrelease route is the explicit way).
            raise ApiError(403, "role_required", RELEASED_LOCKED)
        rec = _load_rec(db, class_id, row["assignment_id"])
        latest_event = _latest_grade_event(db, submission_id)
        base = data.get("baseGradeEventId")
        if base is not None:
            if not isinstance(base, int) or isinstance(base, bool):
                raise ApiError(400, "invalid_request", "baseGradeEventId must be an integer")
            if base != latest_event:
                raise ApiError(409, "stale_version", "This grade changed since you opened it. Reload the card to see the latest version.",
                               {"latestGradeEventId": latest_event})
        questions = {q.get("id"): (n, q) for n, q in enumerate(rec.questions, start=1)}
        unknown = sorted(str(k) for k in items_in if k not in questions)
        if unknown:
            raise ApiError(400, "invalid_request", f"Unknown question id: {', '.join(unknown)[:200]}")
        stored = _item_rows(db, submission_id)
        before_items: dict[str, dict] = {}
        after_items: dict[str, dict] = {}
        overridden: dict[str, bool] = {}
        for qid, (number, question) in questions.items():
            points = float(question.get("points") or 0)
            prev = stored.get(qid)
            prev_score = prev["score"] if prev is not None else None
            prev_comment = (prev["comment"] if prev is not None else "") or ""
            auto_correct = prev["auto_correct"] if prev is not None else None
            auto_score = prev["auto_score"] if prev is not None else None
            before_items[qid] = {"score": _num(prev_score), "comment": prev_comment}
            if qid in items_in:
                entry = items_in[qid]
                if not isinstance(entry, dict):
                    raise ApiError(400, "invalid_request", f"Question {number} must be an object with score and comment")
                score = entry.get("score")
                if score is not None and (not _is_number(score) or not 0 <= float(score) <= points):
                    raise ApiError(400, "invalid_request",
                                   f"Score for question {number} must be from 0 to {grading_rules.fmt_points(points)}")
                comment = _text(entry["comment"], f"Comment on Q{number}", MAX_COMMENT) if "comment" in entry else prev_comment
            else:
                score = prev_score if prev_score is not None else (auto_score if auto_correct is not None else None)
                comment = prev_comment
            score = None if score is None else round(float(score), 2) + 0.0
            after_items[qid] = {"score": _num(score), "comment": comment}
            overridden[qid] = (auto_correct is not None and auto_score is not None and score is not None
                               and abs(score - float(auto_score)) > 1e-9)
        maximum = grading_rules.max_points(rec)
        feedback = _text(data["feedback"], "Feedback", MAX_FEEDBACK) if data.get("feedback") is not None else (row["feedback"] or "")
        prev_adjustment = (round(float(row["adjustment_points"] or 0), 2) + 0.0, row["adjustment_reason"] or "")
        if data.get("adjustment") is not None:
            adjustment = _parse_adjustment(data["adjustment"], maximum)
        else:
            auto = _adjustment(row, rec, maximum)
            adjustment = (float(auto["points"] or 0), auto["reason"]) if auto["auto"] else prev_adjustment
        missing = [qid for qid, item in after_items.items() if item["score"] is None]
        complete = bool(after_items) and not missing
        total = (min(max(sum(float(i["score"]) for i in after_items.values()) + adjustment[0], 0.0), maximum)
                 if complete else None)
        if action == "release" and total is None:
            raise ApiError(400, "invalid_request", "Score every question before releasing this grade.", {"missing": missing})
        status_after = "released" if action == "release" else ("draft" if complete else "ungraded")
        stamp = dbmod.now()
        actor_id = getattr(ident, "user_id", None) or ""
        actor_role = getattr(ident, "actor_role", "unknown")
        for qid, item in after_items.items():
            db.execute(
                """INSERT INTO submission_item_scores (submission_id, question_id, class_id, score, comment, overridden,
                graded_by, graded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(submission_id, question_id) DO UPDATE SET
                score=excluded.score, comment=excluded.comment, overridden=excluded.overridden, graded_by=excluded.graded_by,
                graded_at=excluded.graded_at""",
                (submission_id, qid, class_id, item["score"], item["comment"], int(overridden[qid]), actor_id, stamp))
        db.execute(
            """UPDATE submissions SET grade=?, feedback=?, graded_at=?, grade_status=?, released_at=?, graded_by=?,
            graded_by_role=?, adjustment_points=?, adjustment_reason=? WHERE id=?""",
            (total, feedback, stamp, status_after, stamp if status_after == "released" else None, actor_id, actor_role,
             adjustment[0], adjustment[1], submission_id))
        withdrawn = row["grade_status"] == "released" and status_after != "released"
        if withdrawn:
            # A releaser saving a draft over a released grade withdraws it: record it like an explicit Unrelease so the
            # history, the timeline and the audit log show the withdrawal (CORRECTNESS-01).
            _grade_event(db, row, ident, "unrelease", total_before=row["grade"], total_after=row["grade"],
                         status_before="released", status_after=status_after, stamp=stamp)
        if adjustment != prev_adjustment:
            _grade_event(db, row, ident, "adjust", total_before=row["grade"], total_after=total,
                         items_before={"points": prev_adjustment[0], "reason": prev_adjustment[1]},
                         items_after={"points": adjustment[0], "reason": adjustment[1]},
                         status_before=row["grade_status"], status_after=status_after, stamp=stamp)
        _grade_event(db, row, ident, "release" if action == "release" else "save_draft", total_before=row["grade"],
                     total_after=total, items_before=before_items, items_after=after_items, feedback_before=row["feedback"],
                     feedback_after=feedback, status_before=status_after if withdrawn else row["grade_status"],
                     status_after=status_after, stamp=stamp)
        if status_after == "released":
            _write_release_event(db, row, total, maximum, ident)
        before = {"status": row["grade_status"], "total": _num(row["grade"])}
        after = {"status": status_after, "total": _num(total), "adjustment": _num(adjustment[0]), "unreleased": withdrawn}
    return submission_detail(db, class_id, submission_id, name_mode), before, after


def release_assignment(db: sqlite3.Connection, class_id: str, assignment_id: str, submission_ids: object,
                       ident: Any) -> list[str]:
    """Release drafts of one assignment (default: every non-preview draft). Returns the released ids."""
    rec = _load_rec(db, class_id, assignment_id)
    if submission_ids is not None:
        if (not isinstance(submission_ids, list) or len(submission_ids) > ORDER_LIMIT
                or any(not isinstance(s, str) or not readers_valid_id(s) for s in submission_ids)):
            raise ApiError(400, "invalid_request", f"submissionIds must be a list of at most {ORDER_LIMIT} submission ids")
    maximum = grading_rules.max_points(rec)
    released: list[str] = []
    with dbmod.write_tx(db):
        if submission_ids is None:
            rows = db.execute("""SELECT * FROM submissions WHERE class_id=? AND assignment_id=? AND grade_status='draft'
                AND is_preview=0 ORDER BY submitted_at, id""", (class_id, assignment_id)).fetchall()
        else:
            ids = list(dict.fromkeys(submission_ids))
            rows = db.execute(
                f"""SELECT * FROM submissions WHERE class_id=? AND assignment_id=? AND grade_status='draft'
                AND id IN ({','.join('?' for _ in ids)}) ORDER BY submitted_at, id""",
                (class_id, assignment_id, *ids)).fetchall() if ids else []
        stamp = dbmod.now()
        for row in rows:
            if row["grade"] is None:
                continue
            db.execute("UPDATE submissions SET grade_status='released', released_at=? WHERE id=?", (stamp, row["id"]))
            _grade_event(db, row, ident, "bulk_release", total_before=row["grade"], total_after=row["grade"],
                         status_before="draft", status_after="released", stamp=stamp)
            _write_release_event(db, row, row["grade"], maximum, ident)
            released.append(row["id"])
    return released


def readers_valid_id(value: str) -> bool:
    from server.router import PARAM_PATTERN

    return PARAM_PATTERN.fullmatch(value) is not None


def unrelease(db: sqlite3.Connection, class_id: str, submission_id: str, ident: Any, name_mode: str = "names") -> dict:
    with dbmod.write_tx(db):
        row = _submission_row(db, class_id, submission_id)
        if row["grade_status"] != "released":
            raise ApiError(400, "invalid_request", "This grade is not released.")
        status = "draft" if row["grade"] is not None else "ungraded"
        stamp = dbmod.now()
        db.execute("UPDATE submissions SET grade_status=?, released_at=NULL WHERE id=?", (status, submission_id))
        _grade_event(db, row, ident, "unrelease", total_before=row["grade"], total_after=row["grade"],
                     status_before="released", status_after=status, stamp=stamp)
    return submission_detail(db, class_id, submission_id, name_mode)


# -- queue -----------------------------------------------------------------------------------------
def _search_matches(text: str, label: str, student_id: str, email: str, mode: str) -> bool:
    needle = text.casefold().strip()
    if not needle:
        return True
    fields = [student_id] if mode == "pseudonyms" else [label, student_id, email]
    if mode == "pseudonyms":
        fields.append(label)
    return any(needle in (f or "").casefold() for f in fields)


def _emails(db: sqlite3.Connection, class_id: str, student_ids: Iterable[str]) -> dict[str, str]:
    ids = sorted(set(student_ids))
    out: dict[str, str] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for r in db.execute(f"SELECT student_id, kiwi_email FROM roster WHERE class_id=? AND student_id IN "
                            f"({','.join('?' for _ in chunk)})", (class_id, *chunk)):
            out[r["student_id"]] = r["kiwi_email"] or ""
    return out


def queue(db: sqlite3.Connection, class_id: str, *, show: str = "latest", view: str = "student",
          assignment_id: str | None = None, question_id: str | None = None, student_id: str | None = None,
          group_id: str | None = None, search: str = "", include_preview: bool = False, page: int = 1,
          name_mode: str = "names") -> dict:
    """``GradingQueue`` (§7.5) for the To grade page."""
    if show not in SHOW_CHOICES or view not in VIEW_CHOICES:
        raise ApiError(400, "invalid_request", "Unsupported grading filter")
    if view == "question" and not (assignment_id and question_id):
        raise ApiError(400, "invalid_request", "Choose an assignment and a question for the By question view.")
    population, params = identitymod.population_sql("s", class_linked=identitymod.class_linked(db, class_id))
    if include_preview:     # "Show preview submissions": the student population plus staff test submissions
        population = f"(({population}) OR s.is_preview = 1)"
    where = ["s.class_id = ?", "a.kind = 'homework'", "a.deleted_at IS NULL", population]
    values: list[object] = [class_id, *params]
    if show != "all":
        where.append(f"s.id IN ({grading_rules.latest_ids_sql()})")
    if show == "latest":
        where.append("s.grade_status = 'ungraded'")
    elif show == "graded":
        where.append("s.grade_status IN ('draft', 'released')")
    elif show == "draft":
        where.append("s.grade_status = 'draft'")
    elif show == "late":
        where.append("s.is_late = 1")
    for column, value in (("s.assignment_id", assignment_id), ("s.student_id", student_id)):
        if value:
            where.append(f"{column} = ?")
            values.append(value)
    if group_id:
        where.append("EXISTS (SELECT 1 FROM group_members m WHERE m.class_id = s.class_id AND m.group_id = ? "
                     "AND m.student_id = s.student_id)")
        values.append(group_id)
    rows = db.execute(
        f"""SELECT s.* FROM submissions s JOIN assignments a ON a.id = s.assignment_id AND a.class_id = s.class_id
        WHERE {' AND '.join(where)} ORDER BY s.submitted_at, s.id""", values).fetchall()
    if search.strip():
        ids = [r["student_id"] for r in rows]
        names = identitymod.labels(db, class_id, ids, name_mode)
        emails = _emails(db, class_id, ids) if name_mode == "names" else {}
        rows = [r for r in rows if _search_matches(search, names.get(r["student_id"], ""), r["student_id"],
                                                   emails.get(r["student_id"], ""), name_mode)]
    flags: dict[str, list[dict]] = {}
    if rows:
        index = grading_rules.identical_index(db, class_id, {r["assignment_id"] for r in rows})
        flags = grading_rules.flags_for(db, class_id, [r["id"] for r in rows], index)
    if show == "flagged":
        rows = [r for r in rows if any(f["kind"] in grading_rules.INTEGRITY_FLAGS for f in flags.get(r["id"], []))]
    counts = grading_rules.grading_counts(db, class_id, assignment_id, group_id)
    order = [r["id"] for r in rows][:ORDER_LIMIT]
    result: dict[str, Any] = {"counts": counts, "view": view, "show": show, "order": order, "cards": [],
                              "total": len(rows), "page": page, "pageSize": QUEUE_PAGE_SIZE}
    if view == "question":
        groups: dict[str, dict] = {}
        items: dict[str, sqlite3.Row] = {}
        latest_ids: set[str] = set()
        if rows:
            ids = [r["id"] for r in rows]
            for start in range(0, len(ids), 400):
                chunk = ids[start:start + 400]
                marks = ",".join("?" for _ in chunk)
                for item in db.execute(
                        f"SELECT submission_id, auto_correct, auto_score, score FROM submission_item_scores WHERE question_id=? "
                        f"AND submission_id IN ({marks})", (question_id, *chunk)):
                    items[item["submission_id"]] = item
                latest_ids |= {r[0] for r in db.execute(
                    f"SELECT id FROM submissions WHERE id IN ({marks}) AND id IN ({grading_rules.latest_ids_sql()})", chunk)}
        labels = identitymod.labels(db, class_id, [r["student_id"] for r in rows], name_mode)
        maximum = _num(grading_rules.max_points(_load_rec(db, class_id, assignment_id))) if assignment_id else None
        for r in rows:
            answer = str(_loads(r["answers_json"], {}).get(question_id, "") or "")
            key = grading_rules.normalize_answer(answer)
            item = items.get(r["id"])
            auto_correct = None if item is None or item["auto_correct"] is None else bool(item["auto_correct"])
            group = groups.setdefault(key, {"normalizedAnswer": key, "sampleAnswer": answer[:2000], "submissionIds": [],
                                            "autoCorrect": auto_correct,
                                            "autoScore": _num(item["auto_score"]) if auto_correct is not None else None,
                                            "members": []})
            group["submissionIds"].append(r["id"])
            # S-B01: who is in the group and the grade state of each attempt (released ones are never overwritten)
            group["members"].append({"submissionId": r["id"], "studentId": r["student_id"],
                                     "studentLabel": labels.get(r["student_id"], r["student_id"]), "attempt": r["attempt"],
                                     "latest": r["id"] in latest_ids, "gradeStatus": r["grade_status"], "grade": _num(r["grade"]),
                                     "score": _num(item["score"]) if item is not None else None, "maxPoints": maximum})
        result["groups"] = sorted(groups.values(), key=lambda g: (-len(g["submissionIds"]), g["normalizedAnswer"]))
        result["page"], result["pageSize"] = 1, max(1, len(result["groups"]))
        return result
    start = (page - 1) * QUEUE_PAGE_SIZE
    cache: dict = {}
    result["cards"] = [submission_detail(db, class_id, r["id"], name_mode, cache=cache, flags=flags)
                       for r in rows[start:start + QUEUE_PAGE_SIZE]]
    return result


# -- roster population -----------------------------------------------------------------------------
def roster_students(db: sqlite3.Connection, class_id: str, group_ids: Iterable[str] | None = None) -> list[sqlite3.Row]:
    """Enrolled students (active, not excluded; linked classes: Kiwi students who are not course staff)."""
    sql = ["SELECT r.* FROM roster r WHERE r.class_id=? AND r.status='active' AND r.excluded=0",
           "AND r.student_id NOT LIKE 'preview-%' AND r.student_id != 'instructor'"]
    values: list[object] = [class_id]
    if identitymod.class_linked(db, class_id):
        sql.append("AND r.source='kiwi' AND NOT EXISTS (SELECT 1 FROM kiwi_staff_seen k WHERE k.class_id=r.class_id "
                   "AND k.kiwi_user_id=r.student_id)")
    groups = [g for g in (group_ids or []) if g]
    if groups:
        sql.append(f"AND EXISTS (SELECT 1 FROM group_members m WHERE m.class_id=r.class_id AND m.student_id=r.student_id "
                   f"AND m.group_id IN ({','.join('?' for _ in groups)}))")
        values.extend(groups)
    return db.execute(" ".join(sql) + " ORDER BY r.rowid", values).fetchall()


def _group_info(db: sqlite3.Connection, class_id: str) -> dict[str, dict]:
    info: dict[str, dict] = {}
    for r in db.execute(
            """SELECT m.student_id, m.kind, g.name FROM group_members m JOIN course_groups g ON g.id = m.group_id
            WHERE m.class_id=? AND g.archived_at IS NULL ORDER BY m.assigned_at, g.name""", (class_id,)):
        entry = info.setdefault(r["student_id"], {"section": None, "condition": None, "groups": []})
        if r["kind"] in ("section", "condition") and entry[r["kind"]] is None:
            entry[r["kind"]] = r["name"]
        entry["groups"].append(r["name"])
    return info


def _published(db: sqlite3.Connection, class_id: str, kind: str) -> list[AssignmentRecord]:
    return [readers.record_from_row(r) for r in db.execute(
        """SELECT * FROM assignments WHERE class_id=? AND kind=? AND status='published' AND deleted_at IS NULL
        ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, created_at, id""", (class_id, kind))]


def column_header(rec: AssignmentRecord, tz: ZoneInfo) -> str:
    """``Week 3 HW (20 pts) · Due 10/24`` (NM18), the due date shown in the course time zone."""
    header = f"{rec.title} ({grading_rules.fmt_points(grading_rules.max_points(rec))} pts)"
    due = dbmod.parse_iso(rec.due_at) if rec.due_at else None
    return f"{header} · Due {due.astimezone(tz).strftime('%m/%d')}" if due else header


def _sorted_students(db: sqlite3.Connection, class_id: str, students: list[sqlite3.Row], mode: str,
                     search: str = "") -> list[tuple[sqlite3.Row, str]]:
    names = identitymod.labels(db, class_id, [s["student_id"] for s in students], mode)
    pairs = [(s, names.get(s["student_id"], s["student_id"])) for s in students]
    if search.strip():
        pairs = [(s, n) for s, n in pairs if _search_matches(search, n, s["student_id"], s["kiwi_email"] or "", mode)]
    return sorted(pairs, key=lambda p: (p[1].casefold(), p[0]["student_id"]))


def _in_class_stats(db: sqlite3.Connection, class_id: str, practice: list[AssignmentRecord],
                    student_ids: list[str]) -> dict[tuple[str, str], dict]:
    """(student, exercise) → questions attempted and, per auto-checked question, first-try and eventual correctness.

    RV6-M03: the Gradebook reports questions (like Exercise results), not the share of checks: one wrong then one
    right answer is "correct eventually 100% · first try 0%", not "50% correct".
    """
    stats: dict[tuple[str, str], dict] = {}
    if not practice or not student_ids:
        return stats
    aids = [p.id for p in practice]
    for r in db.execute(
            f"""SELECT student_id, attribution_assignment_id AS aid, question_id,
            CASE WHEN checked_by = 'legacy_server' THEN rejudged_correct ELSE json_extract(payload_json, '$.correct') END AS ok
            FROM events WHERE class_id=? AND event_type='answer_submitted' AND checked_by IN ('server', 'legacy_server')
            AND is_preview=0 AND attribution_assignment_id IN ({','.join('?' for _ in aids)}) ORDER BY created_at, id""",
            (class_id, *aids)):
        entry = stats.setdefault((r["student_id"], r["aid"]), {"questions": set(), "first": {}, "eventually": {}})
        entry["questions"].add(r["question_id"])
        if r["ok"] is not None:
            qid = r["question_id"]
            entry["first"].setdefault(qid, bool(r["ok"]))
            entry["eventually"][qid] = entry["eventually"].get(qid, False) or bool(r["ok"])
    return stats


def in_class_entry(rec: AssignmentRecord, stat: dict | None) -> dict:
    """Gradebook in-class cell: completion over the exercise's questions; correctness over the auto-checked ones."""
    qids = {q.get("id") for q in rec.questions}
    done = len(stat["questions"] & qids) if stat else 0
    checked = [q for q in (stat or {}).get("first", {}) if q in qids]
    eventually = round(100 * sum(1 for q in checked if stat["eventually"][q]) / len(checked)) if checked else None
    first = round(100 * sum(1 for q in checked if stat["first"][q]) / len(checked)) if checked else None
    # accuracyPct (spec §7.5) keeps its key and now means "correct eventually", the same as Exercise results.
    return {"assignmentId": rec.id, "completionPct": round(100 * done / len(qids)) if qids else None,
            "accuracyPct": eventually, "correctFirstTryPct": first}


def _activity(db: sqlite3.Connection, class_id: str, student_ids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {s: {"activeMinutes": 0.0, "aiQuestions": 0, "codeRuns": 0, "lastActive": None} for s in student_ids}
    for start in range(0, len(student_ids), 400):
        chunk = student_ids[start:start + 400]
        marks = ",".join("?" for _ in chunk)
        for r in db.execute(
                f"""SELECT student_id,
                COALESCE(SUM(CASE WHEN event_type='study_heartbeat' AND heartbeat_counted=1 THEN 1 ELSE 0 END), 0) AS beats,
                COALESCE(SUM(CASE WHEN event_type='study_heartbeat' AND json_type(payload_json,'$.seconds') IN ('integer','real')
                    THEN min(max(CAST(json_extract(payload_json,'$.seconds') AS INTEGER), 0), 60) ELSE 0 END), 0) AS seconds,
                COALESCE(SUM(CASE WHEN event_type='code_run' THEN 1 ELSE 0 END), 0) AS runs,
                MAX(CASE WHEN {identitymod.STUDENT_ACTOR_SQL} THEN created_at END) AS last_active
                FROM events WHERE class_id=? AND is_preview=0 AND student_id IN ({marks}) GROUP BY student_id""",
                (class_id, *chunk)):
            minutes = r["beats"] * 0.5 if r["beats"] else r["seconds"] / 60
            out[r["student_id"]].update(activeMinutes=round(minutes, 1), codeRuns=int(r["runs"]), lastActive=r["last_active"])
        for r in db.execute(f"SELECT student_id, COUNT(*) AS n FROM chat_turns WHERE class_id=? AND is_preview=0 "
                            f"AND student_id IN ({marks}) GROUP BY student_id", (class_id, *chunk)):
            out[r["student_id"]]["aiQuestions"] = int(r["n"])
    return out


def gradebook(db: sqlite3.Connection, class_id: str, *, policy: str = "latest", search: str = "",
              group_id: str | None = None, page: int = 1, page_size: int = 50, name_mode: str = "names",
              now: object = None) -> dict:
    """``Gradebook`` (§7.5): one row per enrolled student, homework cells, in-class completion/accuracy."""
    homework = _published(db, class_id, "homework")
    practice = _published(db, class_id, "practice")
    tz = _tz(db, class_id)
    columns = [{"assignmentId": r.id, "title": r.title, "maxPoints": _num(grading_rules.max_points(r)), "dueAt": r.due_at,
                "header": column_header(r, tz)} for r in homework]
    pairs = _sorted_students(db, class_id, roster_students(db, class_id, [group_id] if group_id else None), name_mode, search)
    total = len(pairs)
    window = pairs[(page - 1) * page_size: page * page_size]
    ids = [s["student_id"] for s, _ in window]
    pseudonyms = identitymod.labels(db, class_id, ids, "pseudonyms")
    groups = _group_info(db, class_id)
    in_class = _in_class_stats(db, class_id, practice, ids)
    activity = _activity(db, class_id, ids)
    rows = []
    for student, _label in window:
        sid = student["student_id"]
        group = groups.get(sid, {"section": None, "condition": None, "groups": []})
        cells = []
        for rec in homework:
            cell = grading_rules.gradebook_cell(db, rec, sid, policy, now)
            cell["score"], cell["maxPoints"] = _num(cell["score"]), _num(cell["maxPoints"])
            cells.append(cell)
        exercises = [in_class_entry(rec, in_class.get((sid, rec.id))) for rec in practice]
        rows.append({"studentId": sid, "studentName": "", "pseudonym": pseudonyms.get(sid, ""), "section": group["section"],
                     "condition": group["condition"], "groups": group["groups"], "cells": cells, "inClass": exercises,
                     **activity[sid]})
    identitymod.relabel(db, class_id, rows, name_mode)
    return {"policy": policy, "columns": columns,
            "inClassColumns": [{"assignmentId": r.id, "title": r.title} for r in practice],
            "rows": rows, "total": total, "page": page, "pageSize": page_size}


# -- CSV -------------------------------------------------------------------------------------------
_FULL_WIDTH_SIGNS = {"＝": "=", "＋": "+", "－": "-", "＠": "@"}
_NUMERIC = re.compile(r"^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$", re.I)
_LEAD = re.compile(r"^[\s　]*")


def needs_neutralization(text: str) -> bool:
    """Same rule as ``src/lib/csv.ts`` (§13.6): a formula sign after leading spaces, or a tab/CR in them."""
    lead = _LEAD.match(text).group(0)  # type: ignore[union-attr]
    if "\t" in lead or "\r" in lead:
        return True
    first = text[len(lead):len(lead) + 1]
    return bool(first) and _FULL_WIDTH_SIGNS.get(first, first) in "=+-@"


def csv_cell(value: object, numeric: bool = False) -> str:
    if value is None:
        text, is_number = "", False
    elif isinstance(value, bool):
        text, is_number = ("yes" if value else "no"), False
    elif isinstance(value, (int, float)):
        number = _num(value)
        text, is_number = ("" if number is None else str(number)), True
    else:
        text = str(value)
        is_number = numeric and bool(_NUMERIC.match(text.strip()))
    if not is_number and needs_neutralization(text):
        text = "'" + text
    return '"' + text.replace('"', '""') + '"'


def to_csv(rows: Iterable[Iterable[object]], numeric_columns: Iterable[int] = ()) -> bytes:
    """Teaching CSV: UTF-8 BOM, CRLF, every cell quoted (RFC 4180), formula neutralization (KEEP)."""
    numeric = set(numeric_columns)
    lines = [",".join(csv_cell(cell, i in numeric) for i, cell in enumerate(row)) for row in rows]
    return ("﻿" + "\r\n".join(lines) + "\r\n").encode("utf-8")


def _latest_actor_label(db: sqlite3.Connection, submission_id: str | None) -> str:
    if not submission_id:
        return ""
    row = db.execute(
        f"""SELECT actor_label FROM grade_events WHERE submission_id=? AND action IN ({','.join('?' for _ in GRADED_ACTIONS)})
        ORDER BY id DESC LIMIT 1""", (submission_id, *GRADED_ACTIONS)).fetchone()
    return (row["actor_label"] or "") if row else ""


def _export_assignments(db: sqlite3.Connection, class_id: str, assignment_ids: list[str]) -> list[AssignmentRecord]:
    homework = _published(db, class_id, "homework")
    if assignment_ids:
        wanted = set(assignment_ids)
        homework = [r for r in homework if r.id in wanted]
    return homework


def grades_csv(db: sqlite3.Connection, class_id: str, *, policy: str = "latest", released_only: bool = True,
               layout: str = "wide", assignment_ids: list[str] | None = None, group_ids: list[str] | None = None,
               now: object = None) -> bytes:
    """``Grades for LMS (CSV)`` (§13.6): wide or long; released scores only unless ``releasedOnly=0``."""
    homework = _export_assignments(db, class_id, assignment_ids or [])
    pairs = _sorted_students(db, class_id, roster_students(db, class_id, group_ids), "names")
    show_emails = bool(readers.settings(db, class_id)["privacy"].get("showEmails", True)) and not identitymod.class_linked(db, class_id)
    groups = _group_info(db, class_id)
    submissions: dict[str, sqlite3.Row] = {}

    def submission(sid: str | None) -> sqlite3.Row | None:
        if not sid:
            return None
        if sid not in submissions:
            submissions[sid] = db.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
        return submissions[sid]

    def scored(cell: dict) -> tuple[float | None, sqlite3.Row | None]:
        states = ("released", "newer_ungraded") if released_only else ("released", "newer_ungraded", "draft")
        if cell["state"] not in states:
            return None, None
        return cell["score"], submission(cell["scoredSubmissionId"])

    if layout == "long":
        table: list[list[object]] = [["student_id", "name", "email", "section", "condition", "assignment_id", "assignment_title",
                                      "max_points", "score", "status", "late", "late_hours", "over_time", "attempt_used",
                                      "score_policy", "graded_by", "released_at", "feedback"]]
        for student, name in pairs:
            sid = student["student_id"]
            group = groups.get(sid, {"section": None, "condition": None})
            for rec in homework:
                cell = grading_rules.gradebook_cell(db, rec, sid, policy, now)
                score, used = scored(cell)
                basis = used or submission(cell["latestSubmissionId"])
                late_seconds = int(basis["late_seconds"] or 0) if basis else 0
                table.append([sid, name, (student["kiwi_email"] or "") if show_emails else "", group["section"] or "",
                              group["condition"] or "", rec.id, rec.title, grading_rules.max_points(rec), score, cell["state"],
                              bool(basis["is_late"]) if basis else False, round(late_seconds / 3600, 2) if basis else None,
                              bool(basis["over_time"]) if basis else False, used["attempt"] if used else None, policy,
                              _latest_actor_label(db, used["id"] if used else None),
                              csv_time(used["released_at"]) if used else "", (used["feedback"] or "") if used else ""])
        return _teaching_csv(db, class_id, table, (7, 8, 11, 13))
    head: list[object] = ["Student ID", "Name", "Email", "Section", "Condition"]
    for rec in homework:
        head += [f"{rec.title} [{grading_rules.fmt_points(grading_rules.max_points(rec))}]", f"{rec.title} Late",
                 f"{rec.title} Feedback"]
    table = [head]
    for student, name in pairs:
        sid = student["student_id"]
        group = groups.get(sid, {"section": None, "condition": None})
        line: list[object] = [sid, name, (student["kiwi_email"] or "") if show_emails else "", group["section"] or "",
                              group["condition"] or ""]
        for rec in homework:
            cell = grading_rules.gradebook_cell(db, rec, sid, policy, now)
            score, used = scored(cell)
            basis = used or submission(cell["latestSubmissionId"])
            line += [score, bool(basis["is_late"]) if basis else "", (used["feedback"] or "") if used else ""]
        table.append(line)
    return _teaching_csv(db, class_id, table, [5 + 3 * i for i in range(len(homework))])


def _teaching_csv(db, class_id, table, numeric_columns):
    if identitymod.class_linked(db, class_id):
        table = identitymod.scrub_free_text(table, identitymod.roster_terms(db, class_id), skip_id_keys=False)
    return to_csv(table, numeric_columns=numeric_columns)


STATUS_STATES = {"not_due": "Not due yet", "submitted_ungraded": "Submitted · ungraded",
                 "newer_ungraded": "Newer attempt ungraded", "draft": "Draft", "released": "Released"}


def status_label(cell: dict) -> str:
    """``state`` column of ``assignment-status.csv`` (§13.6)."""
    started = cell["draftAnswered"] > 0
    # D8: another version of the homework carries this row (submitted there, or missing there instead of here)
    if cell.get("onOriginal"):
        return "Submitted the original"
    if cell.get("onRevision"):
        return "Submitted the new version"
    if cell.get("countedOnId"):
        return "Replaced by the new version"
    if cell["state"] == "missing":
        return "Missing · started" if started else "Missing"
    if cell["state"] == "not_submitted":
        return "Started · not submitted" if started else "Not started"
    return STATUS_STATES.get(cell["state"], cell["state"])


def csv_time(value: object) -> str:
    """One ISO-8601 format for every timestamp column (RV6-m08): ``2026-10-20T15:59:00+00:00`` (UTC, seconds)."""
    try:
        parsed = dbmod.parse_iso(value)
    except ValueError:
        return str(value or "")
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds") if parsed else ""


def status_csv(db: sqlite3.Connection, class_id: str, *, assignment_ids: list[str] | None = None,
               group_ids: list[str] | None = None, pseudonymize: bool = False, now: object = None) -> bytes:
    """``Student × assignment status (CSV)`` (§13.6, GRADE-13)."""
    pseudonymize = pseudonymize or identitymod.class_linked(db, class_id)
    homework = _export_assignments(db, class_id, assignment_ids or [])
    pairs = _sorted_students(db, class_id, roster_students(db, class_id, group_ids), "pseudonyms" if pseudonymize else "names")
    show_emails = bool(readers.settings(db, class_id)["privacy"].get("showEmails", True)) and not pseudonymize
    groups = _group_info(db, class_id)
    table: list[list[object]] = [["student_id", "student", "email", "section", "condition", "assignment_id", "assignment",
                                  "due_at", "state", "late", "attempts", "last_active", "draft_answered", "draft_updated_at"]]
    for student, name in pairs:
        sid = student["student_id"]
        shown_id = identitymod.research_id(db, class_id, sid) if pseudonymize else sid
        group = groups.get(sid, {"section": None, "condition": None})
        for rec in homework:
            cell = grading_rules.gradebook_cell(db, rec, sid, "latest", now)
            if cell["label"] == grading_rules.NOT_ASSIGNED:
                continue
            _answered, draft_updated = grading_rules.draft_progress(db, rec, sid)
            last = db.execute(
                f"""SELECT MAX(t) FROM (SELECT MAX(created_at) AS t FROM events WHERE class_id=? AND student_id=? AND is_preview=0
                AND {identitymod.STUDENT_ACTOR_SQL} AND attribution_assignment_id=? UNION ALL SELECT MAX(submitted_at) FROM submissions WHERE class_id=?
                AND student_id=? AND assignment_id=? AND is_preview=0)""",
                (class_id, sid, rec.id, class_id, sid, rec.id)).fetchone()[0]
            table.append([shown_id, shown_id if pseudonymize else name, (student["kiwi_email"] or "") if show_emails else "",
                          group["section"] or "", group["condition"] or "", rec.id, rec.title, csv_time(rec.due_at),
                          status_label(cell), cell["late"], cell["attempts"], csv_time(last), cell["draftAnswered"],
                          csv_time(draft_updated)])
    return _teaching_csv(db, class_id, table, (10, 12))


# -- exercise results ------------------------------------------------------------------------------
def exercise_results(db: sqlite3.Connection, class_id: str, assignment_id: str, *, start: str | None = None,
                     end: str | None = None, group_id: str | None = None, name_mode: str = "names",
                     now: datetime | None = None) -> dict:
    """``ExerciseResults`` (§7.5, GRADE-09) from server-checked attempts in ``[from, to)``."""
    rec = _load_rec(db, class_id, assignment_id)
    current = now or dbmod.utcnow()
    population, params = identitymod.population_sql("e", class_linked=identitymod.class_linked(db, class_id))
    where = ["e.class_id = ?", "e.event_type = 'answer_submitted'", "e.attribution_assignment_id = ?",
             "e.checked_by IN ('server', 'legacy_server')", population]
    values: list[object] = [class_id, assignment_id, *params]
    if start:
        where.append("e.created_at >= ?")
        values.append(start)
    if end:
        where.append("e.created_at < ?")
        values.append(end)
    if group_id:
        where.append("EXISTS (SELECT 1 FROM group_members m WHERE m.class_id = e.class_id AND m.group_id = ? "
                     "AND m.student_id = e.student_id)")
        values.append(group_id)
    attempts: dict[str, dict[str, list[dict]]] = {}
    last_active: dict[str, str] = {}
    for r in db.execute(
            f"""SELECT e.student_id, e.question_id, e.created_at,
            json_extract(e.payload_json, '$.answer') AS answer,
            CASE WHEN e.checked_by = 'legacy_server' THEN e.rejudged_correct ELSE json_extract(e.payload_json, '$.correct') END AS ok
            FROM events e WHERE {' AND '.join(where)} ORDER BY e.created_at, e.id""", values):
        attempts.setdefault(r["question_id"] or "", {}).setdefault(r["student_id"], []).append(
            {"ok": None if r["ok"] is None else bool(r["ok"]), "answer": str(r["answer"] or ""), "at": r["created_at"]})
        last_active[r["student_id"]] = max(last_active.get(r["student_id"], ""), r["created_at"])
    student_ids = sorted(last_active)
    names = identitymod.labels(db, class_id, student_ids, name_mode)
    questions = []
    per_student = {s: {"correct": 0, "attempted": 0} for s in student_ids}
    for number, question in enumerate(rec.questions, start=1):
        qid = question.get("id")
        by_student = attempts.get(qid, {})
        gradable = {s: [a for a in rows if a["ok"] is not None] for s, rows in by_student.items()}
        graded = {s: rows for s, rows in gradable.items() if rows}
        first = sum(1 for rows in graded.values() if rows[0]["ok"])
        eventually = sum(1 for rows in graded.values() if any(a["ok"] for a in rows))
        wrong: dict[str, dict] = {}
        stuck = []
        for sid, rows in by_student.items():
            per_student[sid]["attempted"] += 1
            if any(a["ok"] for a in rows):
                per_student[sid]["correct"] += 1
            for a in rows:
                if a["ok"] is False:
                    key = grading_rules.normalize_answer(a["answer"])
                    entry = wrong.setdefault(key, {"answer": a["answer"].strip()[:200], "students": set()})
                    entry["students"].add(sid)
            wrong_count = sum(1 for a in rows if a["ok"] is False)
            last_at = dbmod.parse_iso(rows[-1]["at"])
            if (wrong_count >= STUCK_WRONG_ATTEMPTS and not any(a["ok"] for a in rows) and last_at is not None
                    and current - last_at <= STUCK_WINDOW):
                stuck.append({"studentId": sid, "studentName": names.get(sid, sid), "wrongAttempts": wrong_count,
                              "lastAttemptAt": rows[-1]["at"]})
        top = sorted(wrong.values(), key=lambda w: (-len(w["students"]), w["answer"]))[:TOP_WRONG_ANSWERS]
        prompt = " ".join(str(question.get("prompt") or "").split())
        questions.append({
            "questionId": qid, "label": f"Q{number} · {prompt[:60]}{'…' if len(prompt) > 60 else ''}",
            "attempted": len(by_student),
            "correctFirstTryPct": round(100 * first / len(graded)) if graded else None,
            "correctEventuallyPct": round(100 * eventually / len(graded)) if graded else None,
            "topWrongAnswers": [{"answer": w["answer"], "students": len(w["students"])} for w in top],
            "stuck": sorted(stuck, key=lambda s: (-s["wrongAttempts"], s["studentName"]))})
    students = [{"studentId": s, "studentName": names.get(s, s), "correct": per_student[s]["correct"],
                 "attempted": per_student[s]["attempted"], "lastActive": last_active.get(s)} for s in student_ids]
    students.sort(key=lambda s: s["studentName"].casefold())
    return {"assignment": teacher_assignment(db, rec, current), "enrolled": len(roster_students(db, class_id,
                                                                                                [group_id] if group_id else None)),
            "refreshedAt": dbmod.now(), "questions": questions, "students": students}


# -- legacy (v0.5.1 shapes) ------------------------------------------------------------------------
def grade(db: sqlite3.Connection, class_id: str, submission_id: str, data: object, identity: Any = None) -> dict:
    """Legacy total-only grade: released immediately (v0.5.1); omitted feedback keeps the previous value."""
    if not isinstance(data, dict):
        raise ValueError("Invalid grade format")
    row = db.execute(
        """SELECT s.*,a.questions_json FROM submissions s JOIN assignments a ON a.id=s.assignment_id
        WHERE s.id=? AND s.class_id=?""", (submission_id, class_id)).fetchone()
    if not row:
        raise ValueError("Submission not found")
    maximum = sum(q["points"] for q in json.loads(row["questions_json"]))
    score = data.get("grade")
    if not isinstance(score, (int, float)) or isinstance(score, bool) or not 0 <= score <= maximum:
        raise ValueError(f"Score must be between 0 and {maximum}")
    if "feedback" in data:
        value = data["feedback"]
        if not isinstance(value, str) or len(value.strip()) > MAX_FEEDBACK:
            raise ValueError(f"Feedback must contain 0–{MAX_FEEDBACK} characters")   # v0.5.1 message
        feedback = value.strip()
    else:
        feedback = row["feedback"] or ""
    stamp = dbmod.now()
    actor_id = (getattr(identity, "user_id", None) or "") if identity is not None else ""
    actor_role = getattr(identity, "actor_role", "unknown") if identity is not None else "unknown"
    with dbmod.write_tx(db):
        db.execute(
            """UPDATE submissions SET grade=?, feedback=?, graded_at=?, grade_status='released', released_at=?, graded_by=?,
            graded_by_role=? WHERE id=?""", (score, feedback, stamp, stamp, actor_id, actor_role, submission_id))
        _grade_event(db, row, identity, "legacy_grade", total_before=row["grade"], total_after=score,
                     feedback_before=row["feedback"], feedback_after=feedback, status_before=row["grade_status"],
                     status_after="released", stamp=stamp)
        _write_release_event(db, row, float(score), float(maximum), identity)
    return {"id": submission_id, "grade": score, "feedback": feedback, "maxPoints": maximum, "gradedAt": stamp}


def hub(db: sqlite3.Connection, class_id: str) -> dict:
    """v0.5.1 ``HubData`` (legacy Grades & Data Hub); scores are saved grades (draft or released), preview rows excluded."""
    assignments = db.execute(
        "SELECT id,title FROM assignments WHERE class_id=? AND kind='homework' AND status='published' AND deleted_at IS NULL "
        "ORDER BY created_at,id", (class_id,)).fetchall()
    student_map: dict[str, dict] = {}

    def student(sid: str, name: str) -> dict:
        return student_map.setdefault(sid, {
            "studentId": sid, "studentName": name, "scoreByAssignment": {}, "attemptsByAssignment": {}, "interactions": 0,
            "learningSeconds": 0, "freePracticeCount": 0, "codeRuns": 0, "aiQuestions": 0, "lastActive": None})

    for row in db.execute("SELECT student_id,student_name FROM roster WHERE class_id=?", (class_id,)):
        student(row["student_id"], row["student_name"])
    # Aggregate in SQL instead of loading every code snapshot and AI response.
    for row in db.execute(
        """SELECT studentId,MAX(studentName) studentName,SUM(interactions) interactions,
        SUM(codeRuns) codeRuns,SUM(aiQuestions) aiQuestions,MAX(lastActive) lastActive
        FROM learning_sessions WHERE classId=? AND isPreview=0 AND studentId NOT LIKE 'preview-%' GROUP BY studentId""",
        (class_id,)):
        item = student(row["studentId"], row["studentName"])
        for field in ("interactions", "codeRuns", "aiQuestions", "lastActive"):
            item[field] = row[field]
    for row in db.execute(
        """SELECT student_id,MAX(student_name) student_name,
        SUM(CASE WHEN event_type='study_heartbeat' AND json_type(payload_json,'$.seconds') IN ('integer','real')
            THEN min(max(CAST(json_extract(payload_json,'$.seconds') AS INTEGER),0),60) ELSE 0 END) seconds,
        SUM(CASE WHEN event_type='question_generated' THEN 1 ELSE 0 END) generated
        FROM events WHERE class_id=? AND event_type IN ('study_heartbeat','question_generated') AND is_preview=0
        AND student_id NOT LIKE 'preview-%' GROUP BY student_id""",
        (class_id,)):
        item = student(row["student_id"], row["student_name"])
        item["learningSeconds"] = row["seconds"]
        item["freePracticeCount"] = row["generated"]
    for row in db.execute(
        """SELECT student_id,MAX(student_name) student_name,assignment_id,COUNT(*) attempts,
        MAX(submitted_at) last_active FROM submissions WHERE class_id=? AND is_preview=0 GROUP BY student_id,assignment_id""",
            (class_id,)):
        item = student(row["student_id"], row["student_name"])
        item["attemptsByAssignment"][row["assignment_id"]] = row["attempts"]
        item["lastActive"] = max(item["lastActive"] or "", row["last_active"])
    for row in db.execute(
        """SELECT student_id,student_name,assignment_id,grade FROM
        (SELECT student_id,student_name,assignment_id,grade,ROW_NUMBER() OVER
          (PARTITION BY student_id,assignment_id ORDER BY attempt DESC,submitted_at DESC,id DESC) rn
          FROM submissions WHERE class_id=? AND grade IS NOT NULL AND is_preview=0) WHERE rn=1""", (class_id,)):
        student(row["student_id"], row["student_name"])["scoreByAssignment"][row["assignment_id"]] = row["grade"]
    return {"assignments": [dict(a) for a in assignments],
            "students": sorted(student_map.values(), key=lambda x: x["studentName"].lower())}


def work_page(db: sqlite3.Connection, class_id: str, args: dict) -> dict:
    """Grading page (v0.5.1 ``WorkPage`` with ``view=grading``)."""
    from server.assignments import serialize_work, work_options

    page = max(int(args.get("page", "1")), 1)
    search = args.get("search", "")[:120]
    size = 10
    where = "s.class_id=?"
    params: list[object] = [class_id]
    if search:
        where += " AND (instr(lower(s.student_name),lower(?))>0 OR instr(lower(s.student_id),lower(?))>0)"
        params += [search, search]
    if args.get("assignmentId"):
        where += " AND s.assignment_id=?"
        params.append(args["assignmentId"])
    if args.get("status") == "ungraded":
        where += " AND s.grade IS NULL"
    total = db.execute(f"SELECT COUNT(*) FROM submissions s WHERE {where}", params).fetchone()[0]
    rows = db.execute(f"SELECT s.* FROM submissions s WHERE {where} ORDER BY submitted_at DESC,attempt DESC,id DESC LIMIT ? OFFSET ?",
                      [*params, size, (page - 1) * size]).fetchall()
    subs = [{"id": r["id"], "assignmentId": r["assignment_id"], "studentId": r["student_id"], "studentName": r["student_name"],
             "attempt": r["attempt"], "answers": json.loads(r["answers_json"]), "submittedAt": r["submitted_at"],
             "grade": r["grade"], "feedback": r["feedback"], "gradedAt": r["graded_at"]} for r in rows]
    work_ids = list({r["assignment_id"] for r in rows})
    works = [serialize_work(r, True) for r in db.execute(
        f"SELECT * FROM assignments WHERE class_id=? AND id IN ({','.join('?' for _ in work_ids)})",
        [class_id, *work_ids]).fetchall()] if work_ids else []
    return {"assignments": works, "submissions": subs, "options": work_options(db, class_id, True), "page": page,
            "pageSize": size, "total": total}
