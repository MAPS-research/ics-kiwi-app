"""Homework submission v2, timed attempt starts, server drafts, submission lists and per-assignment status (ASSESS).

Spec §6.3, §4.5.3, §9.1. Submit keeps the v0.5.1 KEEP guarantees (complete answers, idempotent ``requestId``,
transactional attempt numbering) and adds open/close/late/attempt/time-limit rules, autocheck rows and server
events. A replayed ``requestId`` returns the stored result and writes nothing (ASSESS-21). Preview identities
write ``is_preview=1`` rows that never count (§3.4).
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timedelta
from typing import Any

from server import auth, grading_rules, readers, telemetry
from server import db as dbmod
from server import identity as identitymod
from server.assignments import (_FOR_ASSIGNMENT, _REAL_EVENT, _dt, _loads, _state_error, _validate_text, get_work, load_row,
                                roster_ids, student_row, view_question)
from server.contracts import AssignmentRecord
from server.router import ApiError

MAX_ANSWER = 16000
TIME_GRACE_SECONDS = 120          # network grace on top of the time limit (§4.5.3)
DRAFT_EVENT_THROTTLE = timedelta(seconds=15)


def _student_fields(data: object, valid_id) -> tuple[str, str]:
    if not isinstance(data, dict) or not valid_id(data.get("studentId")):
        raise ValueError("studentId has an invalid format")
    name = data.get("studentName")
    return data["studentId"], _validate_text(name if isinstance(name, str) and name.strip() else "Student", "Student name", 100, 1)


def _identity_for(identity: Any, class_id: str, student_id: str, name: str) -> Any:
    if identity is not None and getattr(identity, "student_id", None):
        return identity
    return auth.student_identity(class_id, student_id, display_name=name)


def _replay(db: sqlite3.Connection, class_id: str, work_id: str, student_id: str, request_id: str, answers: object) -> dict | None:
    existing = db.execute(
        "SELECT s.* FROM submission_requests r JOIN submissions s ON s.id=r.submission_id WHERE r.class_id=? "
        "AND r.assignment_id=? AND r.student_id=? AND r.request_id=?",
        (class_id, work_id, student_id, request_id)).fetchone()
    if existing is None:
        return None
    if json.loads(existing["answers_json"]) != answers:
        raise ValueError("A submission request ID cannot be reused for different answers")
    return {**submit_result(existing), "replayed": True}


def submit_result(row: sqlite3.Row) -> dict:
    """``SubmitResult`` (§7.4) of a stored submission."""
    autocheck = _loads(row["autocheck_json"], {})
    return {"id": row["id"], "assignmentId": row["assignment_id"], "attempt": row["attempt"], "submittedAt": row["submitted_at"],
            "late": bool(row["is_late"]), "lateSeconds": int(row["late_seconds"] or 0), "overTime": bool(row["over_time"]),
            "timeUsedSeconds": row["time_used_seconds"],
            "autoChecked": {qid: (v.get("correct") if isinstance(v, dict) else None) for qid, v in autocheck.items()}}


def _clean_answers(rec: AssignmentRecord, answers: object, *, allow_blank: bool) -> dict[str, str]:
    if not isinstance(answers, dict):
        raise ApiError(400, "invalid_request", "answers must be an object of question ids to answers")
    if any(not isinstance(v, str) for v in answers.values()):
        raise ApiError(400, "invalid_request", "Every answer must be text")
    if any(len(v) > MAX_ANSWER for v in answers.values()):
        raise ApiError(400, "invalid_request", "Answer format is invalid or too long")
    ids = [q["id"] for q in rec.questions]
    extra = sorted(k for k in answers if k not in ids)
    missing = [qid for qid in ids if not (answers.get(qid) or "").strip()]
    if extra or (missing and not allow_blank):
        raise ApiError(400, "incomplete_submission", "Complete every question before submitting",
                       {"missing": [] if allow_blank else missing, "extra": extra})
    for question in rec.questions:
        value = answers.get(question["id"], "")
        if question.get("type") == "choice" and value.strip() and value.strip() not in question.get("choices", []):
            raise ApiError(400, "invalid_request", f"The answer to {question['id']} must be one of the choices")
    return {qid: answers.get(qid, "") for qid in ids}


def submit(db: sqlite3.Connection, class_id: str, work_id: str, data: object, valid_id, identity: Any = None, *,
           allow_draft: bool = False) -> dict:
    """Store a homework submission (§6.3 submit v2). Must run inside the caller's ``write_tx``."""
    student_id, student_name = _student_fields(data, valid_id)
    assert isinstance(data, dict)
    preview = bool(getattr(identity, "preview", False)) or allow_draft and student_id.startswith("preview-")
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    request_id = data.get("requestId")
    if request_id is not None and not valid_id(request_id):
        raise ValueError("Invalid submission request ID")
    row = student_row(db, class_id, work_id, student_id, preview=preview, allow_scheduled=True)
    rec = readers.record_from_row(row)
    if rec.kind != "homework":
        raise ValueError("Only homework is submitted; check in-class exercises question by question")
    if request_id:
        replayed = _replay(db, class_id, work_id, student_id, request_id, data.get("answers"))
        if replayed is not None:
            return replayed
    now = dbmod.utcnow()
    problem = _state_error(rec, now)
    if problem is not None:
        raise problem
    attempt = db.execute("SELECT COUNT(*) FROM submissions WHERE assignment_id=? AND student_id=?",
                         (work_id, student_id)).fetchone()[0] + 1
    if rec.max_attempts is not None and attempt > rec.max_attempts:
        raise ApiError(409, "max_attempts_reached", f"This homework allows {rec.max_attempts} attempts.")
    started_at = None
    time_used = None
    over_time = False
    if rec.time_limit:
        start = db.execute("SELECT started_at FROM attempt_starts WHERE class_id=? AND assignment_id=? AND student_id=? AND attempt=?",
                           (class_id, work_id, student_id, attempt)).fetchone()
        if start is None:
            raise ApiError(409, "attempt_not_started", "Start the attempt first: this homework has a time limit.")
        started_at = start["started_at"]
        time_used = max(0, int(round((now - _dt(started_at)).total_seconds())))  # type: ignore[operator]
        if time_used > int(rec.time_limit["minutes"]) * 60 + TIME_GRACE_SECONDS:
            if rec.time_limit.get("onExpiry") == "reject":
                raise ApiError(409, "time_limit_exceeded", "The time limit for this attempt has passed. Your saved answers stay in your draft.")
            over_time = True
    auto_submit = data.get("autoSubmit") is True and bool(rec.time_limit) and started_at is not None
    answers = _clean_answers(rec, data.get("answers"), allow_blank=auto_submit)
    from server import judging

    results = {q["id"]: judging.check(view_question(q, rec.kind), answers[q["id"]]).as_dict() for q in rec.questions}
    submission_id = f"sub-{uuid.uuid4().hex[:16]}"
    timestamp = now.isoformat(timespec="milliseconds")
    section, condition = readers.group_stamp(db, class_id, student_id)
    due = _dt(rec.due_at)
    grace = timedelta(minutes=int(rec.late_policy.get("graceMinutes") or 0))
    late_seconds = max(0, int(round((now - due).total_seconds()))) if due is not None and now > due + grace else 0
    ident = _identity_for(identity, class_id, student_id, student_name)
    linked = identitymod.class_linked(db, class_id)
    columns = {
        "id": submission_id, "assignment_id": work_id, "class_id": class_id, "student_id": student_id,
        "student_name": "" if linked else student_name, "attempt": attempt, "answers_json": json.dumps(answers, ensure_ascii=False),
        "submitted_at": timestamp, "assignment_version": rec.version, "is_late": int(late_seconds > 0),
        "late_seconds": late_seconds, "actor_role": ident.actor_role, "is_preview": int(preview),
        "identity_verified": int(bool(getattr(ident, "verified", False))), "grade_status": "ungraded",
        "autocheck_json": dbmod.json_dumps(results), "attempt_started_at": started_at, "time_used_seconds": time_used,
        "over_time": int(over_time), "section_group_id": section, "condition_group_id": condition,
    }
    db.execute(f"INSERT INTO submissions ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})", tuple(columns.values()))
    for question in rec.questions:
        outcome = results[question["id"]]
        points = float(question.get("points") or 0)
        db.execute(
            """INSERT INTO submission_item_scores (submission_id, question_id, class_id, auto_correct, auto_score, auto_reason)
            VALUES (?, ?, ?, ?, ?, ?)""",
            (submission_id, question["id"], class_id, None if outcome["correct"] is None else int(bool(outcome["correct"])),
             None if outcome["correct"] is None else points * float(bool(outcome["correct"])), outcome["reason"]))
    db.execute(
        """INSERT INTO grade_events (submission_id, class_id, actor_id, actor_role, actor_label, action, total_after,
        items_after_json, status_after, created_at) VALUES (?, ?, 'server', 'system', 'Auto-check', 'autocheck', NULL, ?, 'ungraded', ?)""",
        (submission_id, class_id, dbmod.json_dumps({k: v["correct"] for k, v in results.items()}), timestamp))
    if request_id:
        db.execute("INSERT INTO submission_requests (class_id, assignment_id, student_id, request_id, submission_id) "
                   "VALUES (?, ?, ?, ?, ?)", (class_id, work_id, student_id, request_id, submission_id))
    session = "submission-" + submission_id
    for question in rec.questions:
        outcome = results[question["id"]]
        telemetry.add_event(db, ident, {
            "classId": class_id, "studentId": student_id, "studentName": student_name, "sessionId": session,
            "type": "answer_submitted", "questionId": question["id"], "surface": "assignment", "schemaVersion": 2,
            "payload": {"assignmentId": work_id, "unitId": rec.unit_id, "answer": answers[question["id"]],
                        "correct": outcome["correct"], "checkedBy": "server" if outcome["correct"] is not None else "",
                        "basis": outcome["basis"], "submissionId": submission_id, "attempt": attempt,
                        "assignmentVersion": rec.version, "reason": outcome["reason"]},  # reason: CR-A4 (INTEGRATION)
        }, server=True)
    telemetry.add_event(db, ident, {
        "classId": class_id, "studentId": student_id, "studentName": student_name, "sessionId": session,
        "type": "work_submitted", "surface": "assignment", "schemaVersion": 2,
        "payload": {"assignmentId": work_id, "unitId": rec.unit_id, "submissionId": submission_id, "attempt": attempt,
                    "late": late_seconds > 0, "lateSeconds": late_seconds, "overTime": over_time, "timeUsedSeconds": time_used},
    }, server=True)
    if not preview and row["frozen_at"] is None:
        db.execute("UPDATE assignments SET frozen_at=? WHERE id=? AND class_id=? AND frozen_at IS NULL",
                   (timestamp, work_id, class_id))
    return submit_result(db.execute("SELECT * FROM submissions WHERE id=?", (submission_id,)).fetchone())


# -- timed attempts ---------------------------------------------------------------------------------
def start_attempt(db: sqlite3.Connection, class_id: str, work_id: str, identity: Any) -> tuple[dict, bool]:
    """Start (or return) the open timed attempt: ``({attempt, startedAt, endsAt}, created)`` [AU-D1-13]."""
    student_id = identity.student_id
    row = student_row(db, class_id, work_id, student_id, preview=bool(identity.preview), allow_scheduled=True)
    rec = readers.record_from_row(row)
    if rec.kind != "homework" or not rec.time_limit:
        raise ValueError("This assignment has no time limit; open it and answer directly")
    problem = _state_error(rec, dbmod.utcnow())
    if problem is not None:
        raise problem
    attempt = db.execute("SELECT COUNT(*) FROM submissions WHERE class_id=? AND assignment_id=? AND student_id=?",
                         (class_id, work_id, student_id)).fetchone()[0] + 1
    if rec.max_attempts is not None and attempt > rec.max_attempts:
        raise ApiError(409, "max_attempts_reached", f"This homework allows {rec.max_attempts} attempts.")
    minutes = int(rec.time_limit["minutes"])
    existing = db.execute("SELECT started_at FROM attempt_starts WHERE class_id=? AND assignment_id=? AND student_id=? AND attempt=?",
                          (class_id, work_id, student_id, attempt)).fetchone()
    if existing is not None:
        started = existing["started_at"]
        ends = (_dt(started) + timedelta(minutes=minutes)).isoformat(timespec="milliseconds")  # type: ignore[operator]
        return {"attempt": attempt, "startedAt": started, "endsAt": ends}, False
    started = dbmod.now()
    ends = (_dt(started) + timedelta(minutes=minutes)).isoformat(timespec="milliseconds")  # type: ignore[operator]
    db.execute("INSERT INTO attempt_starts (class_id, assignment_id, student_id, attempt, started_at, assignment_version, is_preview) "
               "VALUES (?, ?, ?, ?, ?, ?, ?)", (class_id, work_id, student_id, attempt, started, rec.version, int(bool(identity.preview))))
    telemetry.add_event(db, identity, {
        "classId": class_id, "studentId": student_id, "studentName": identity.display_name or "Student", "sessionId": "server",
        "type": "attempt_started", "surface": "assignment", "schemaVersion": 2,
        "payload": {"assignmentId": work_id, "unitId": rec.unit_id, "attempt": attempt, "startedAt": started, "endsAt": ends},
    }, server=True)
    return {"attempt": attempt, "startedAt": started, "endsAt": ends}, True


# -- drafts -----------------------------------------------------------------------------------------
def get_draft(db: sqlite3.Connection, class_id: str, work_id: str, student_id: str) -> dict:
    """``AnswerDraft`` (§7.4): the stored server draft of one student."""
    rows = db.execute("SELECT question_id, value, updated_at, assignment_version FROM answer_drafts WHERE class_id=? "
                      "AND student_id=? AND assignment_id=? ORDER BY question_id", (class_id, student_id, work_id)).fetchall()
    answers = {r["question_id"]: {"value": r["value"], "updatedAt": r["updated_at"]} for r in rows}
    versions = [r["assignment_version"] for r in rows if r["assignment_version"] is not None]
    return {"assignmentId": work_id, "answers": answers, "updatedAt": max((r["updated_at"] for r in rows), default=None),
            "assignmentVersion": max(versions) if versions else None}


def has_draft(db: sqlite3.Connection, class_id: str, work_id: str, student_id: str) -> bool:
    """Whether the student has any server draft row (an emptied answer included) on this assignment."""
    return db.execute("SELECT 1 FROM answer_drafts WHERE class_id=? AND student_id=? AND assignment_id=? LIMIT 1",
                      (class_id, student_id, work_id)).fetchone() is not None


def carry_revision_draft(db: sqlite3.Connection, class_id: str, row: sqlite3.Row, student_id: str, *,
                         preview: bool) -> dict | None:
    """K-m03: copy the student's draft from the closed original to this revision the first time they open it.

    Runs inside a write transaction. Walks the ``revision_of`` chain (nearest original first), mapping question ids
    through each revision's ``question_id_map_json`` (revision id → original id). It copies the non-empty answers of the
    nearest version that has any, only when that version is closed (or archived) and the student never submitted an
    earlier version (their work then stays with that submission). A revision that already has a draft row is never
    touched, and the copy writes no ``answer_draft`` event (copying is not a learning action). Returns
    ``{"assignmentId", "title"}`` of the version copied from, or None.
    """
    if "revision_of" not in row.keys() or not row["revision_of"] or has_draft(db, class_id, row["id"], student_id):
        return None
    rec = readers.record_from_row(row)
    mapping = {q["id"]: q["id"] for q in rec.questions if isinstance(q.get("id"), str) and q["id"]}
    child, now = row, dbmod.utcnow()
    for original_id in readers.original_ids(db, class_id, row["id"]):
        hop = _loads(child["question_id_map_json"], {})
        hop = hop if isinstance(hop, dict) else {}
        mapping = {qid: hop[via] for qid, via in mapping.items() if isinstance(hop.get(via), str)}
        parent = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=?", (class_id, original_id)).fetchone()
        if parent is None or not mapping:
            return None
        if db.execute("SELECT 1 FROM submissions WHERE class_id=? AND assignment_id=? AND student_id=? LIMIT 1",
                      (class_id, original_id, student_id)).fetchone():
            return None   # the student submitted an earlier version: that submission holds their work
        wanted = {old: new for new, old in mapping.items()}
        marks = ",".join("?" for _ in wanted)
        found = db.execute(
            f"""SELECT question_id, value, client_ts_ms, updated_at FROM answer_drafts WHERE class_id=? AND student_id=?
            AND assignment_id=? AND value_length > 0 AND question_id IN ({marks})""",
            (class_id, student_id, original_id, *wanted)).fetchall()
        if not found:
            child = parent
            continue
        if readers.assignment_state(readers.record_from_row(parent), now) not in ("closed", "archived"):
            return None   # the student can still work on that version
        section, condition = readers.group_stamp(db, class_id, student_id)
        for draft in found:
            # WHY: keep the student's own time stamps — the copy is not a new edit (Missing · started, draft times)
            db.execute(
                """INSERT OR IGNORE INTO answer_drafts (class_id, student_id, assignment_id, question_id, value, value_length,
                assignment_version, is_preview, client_ts_ms, updated_at, section_group_id, condition_group_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (class_id, student_id, rec.id, wanted[draft["question_id"]], draft["value"],
                 grading_rules.answered_length(draft["value"]), rec.version, int(bool(preview)), draft["client_ts_ms"],
                 draft["updated_at"], section, condition))
        return {"assignmentId": parent["id"], "title": parent["title"]}
    return None


def save_draft(db: sqlite3.Connection, class_id: str, work_id: str, data: dict, identity: Any) -> dict:
    """Upsert answers per question; a write older than the stored ``clientTs`` is ignored [DA07, AU-D3-08]."""
    student_id = identity.student_id
    row = student_row(db, class_id, work_id, student_id, preview=bool(identity.preview))
    rec = readers.record_from_row(row)
    answers = data.get("answers")
    if not isinstance(answers, dict) or any(not isinstance(v, str) for v in answers.values()):
        raise ValueError("answers must be an object of question ids to text")
    if any(len(v) > MAX_ANSWER for v in answers.values()):
        raise ValueError(f"Each answer can have at most {MAX_ANSWER:,} characters")
    client_ts = data.get("clientTs")
    if isinstance(client_ts, bool) or not isinstance(client_ts, int):
        client_ts = dbmod.now_ms()
    version = data.get("assignmentVersion")
    version = version if isinstance(version, int) and not isinstance(version, bool) else rec.version
    questions = {q["id"]: q for q in rec.questions}
    section, condition = readers.group_stamp(db, class_id, student_id)
    now = dbmod.utcnow()
    for question_id, value in answers.items():
        question = questions.get(question_id)
        if question is None:
            continue  # stale key of a removed question; the client prunes these (AU-D1-14)
        stored = db.execute("SELECT value, client_ts_ms FROM answer_drafts WHERE class_id=? AND student_id=? AND assignment_id=? "
                            "AND question_id=?", (class_id, student_id, work_id, question_id)).fetchone()
        if stored is not None and stored["client_ts_ms"] is not None and client_ts < stored["client_ts_ms"]:
            continue  # an older tab cannot roll the draft back
        if stored is not None and stored["value"] == value:
            continue
        db.execute(
            """INSERT INTO answer_drafts (class_id, student_id, assignment_id, question_id, value, value_length,
            assignment_version, is_preview, client_ts_ms, updated_at, section_group_id, condition_group_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(class_id, student_id, assignment_id, question_id)
            DO UPDATE SET value=excluded.value, value_length=excluded.value_length, assignment_version=excluded.assignment_version,
            client_ts_ms=excluded.client_ts_ms, updated_at=excluded.updated_at, section_group_id=excluded.section_group_id,
            condition_group_id=excluded.condition_group_id""",
            (class_id, student_id, work_id, question_id, value, grading_rules.answered_length(value), version,
             int(bool(identity.preview)), client_ts,
             now.isoformat(timespec="milliseconds"), section, condition))
        last = db.execute("SELECT created_at FROM events WHERE class_id=? AND student_id=? AND event_type='answer_draft' "
                          "AND attribution_assignment_id=? AND question_id=? ORDER BY id DESC LIMIT 1",
                          (class_id, student_id, work_id, question_id)).fetchone()
        if last is not None and _dt(last["created_at"]) is not None and now - _dt(last["created_at"]) < DRAFT_EVENT_THROTTLE:  # type: ignore[operator]
            continue
        payload: dict[str, Any] = {"assignmentId": work_id, "unitId": rec.unit_id, "questionId": question_id, "length": len(value),
                                   "valueHash": hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]}
        if question.get("type") == "choice":
            payload["choice"] = value
        telemetry.add_event(db, identity, {
            "classId": class_id, "studentId": student_id, "studentName": identity.display_name or "Student", "sessionId": "server",
            "type": "answer_draft", "questionId": question_id, "surface": "assignment", "schemaVersion": 2, "payload": payload,
        }, server=True)
    return get_draft(db, class_id, work_id, student_id)


# -- submission lists -------------------------------------------------------------------------------
def list_submissions(db: sqlite3.Connection, class_id: str, teacher: bool, student_id: str | None = None,
                     assignment_id: str | None = None) -> list[dict]:
    """Staff: v0.5.1 ``Submission[]`` (all, no silent cap). Students: their own ``StudentSubmission[]``."""
    if not teacher:
        return student_submissions(db, class_id, student_id or "", assignment_id)
    sql = "SELECT s.* FROM submissions s WHERE s.class_id=?"
    params: list[object] = [class_id]
    if student_id:
        sql += " AND s.student_id=?"
        params.append(student_id)
    if assignment_id:
        sql += " AND s.assignment_id=?"
        params.append(assignment_id)
    sql += " ORDER BY s.submitted_at DESC, s.attempt DESC, s.id DESC"
    return [
        {"id": r["id"], "assignmentId": r["assignment_id"], "studentId": r["student_id"], "studentName": r["student_name"],
         "attempt": r["attempt"], "answers": json.loads(r["answers_json"]), "submittedAt": r["submitted_at"],
         "grade": r["grade"], "feedback": r["feedback"], "gradedAt": r["graded_at"], "gradeStatus": r["grade_status"],
         "isLate": bool(r["is_late"]), "lateSeconds": int(r["late_seconds"] or 0), "isPreview": bool(r["is_preview"]),
         "overTime": bool(r["over_time"]), "timeUsedSeconds": r["time_used_seconds"]}
        for r in db.execute(sql, params).fetchall()
    ]


def student_submissions(db: sqlite3.Connection, class_id: str, student_id: str, assignment_id: str | None = None) -> list[dict]:
    """``StudentSubmission[]`` newest first (+ v0.5.1 keys); grade, feedback and comments only once released."""
    sql = ("SELECT s.*, a.questions_json AS questions_json FROM submissions s LEFT JOIN assignments a ON a.id=s.assignment_id "
           "WHERE s.class_id=? AND s.student_id=?")
    params: list[object] = [class_id, student_id]
    if assignment_id:
        sql += " AND s.assignment_id=?"
        params.append(assignment_id)
    sql += " ORDER BY s.submitted_at DESC, s.attempt DESC, s.id DESC"
    out = []
    for r in db.execute(sql, params).fetchall():
        released = r["grade_status"] == "released"
        questions = [q for q in _loads(r["questions_json"], []) if isinstance(q, dict)]
        items = None
        if released:
            scores = {s["question_id"]: s for s in db.execute(
                "SELECT question_id, score, comment FROM submission_item_scores WHERE submission_id=?", (r["id"],))}
            items = {q["id"]: {"score": scores[q["id"]]["score"] if q["id"] in scores else None,
                               "comment": scores[q["id"]]["comment"] if q["id"] in scores else ""} for q in questions}
        # RV6-M01: a released total can include an adjustment (the automatic late penalty); the student sees the line
        # so the per-question scores add up to the total.
        points = round(float(r["adjustment_points"] or 0), 2) + 0.0 if released else 0.0
        out.append({
            "id": r["id"], "assignmentId": r["assignment_id"], "studentId": r["student_id"], "studentName": r["student_name"],
            "attempt": r["attempt"], "answers": json.loads(r["answers_json"]), "submittedAt": r["submitted_at"],
            "isLate": bool(r["is_late"]), "lateSeconds": int(r["late_seconds"] or 0),
            "status": "released" if released else "waiting_for_teacher",
            "grade": r["grade"] if released else None, "maxPoints": sum(float(q.get("points") or 0) for q in questions),
            "feedback": r["feedback"] if released else None, "gradedAt": r["released_at"] or r["graded_at"] if released else None,
            "items": items,
            "adjustment": {"points": int(points) if points.is_integer() else points, "reason": r["adjustment_reason"] or ""}
            if released and points else None,
        })
    return out


# -- per-assignment status (popovers) and list stats -----------------------------------------------
def _audience_students(db: sqlite3.Connection, rec: AssignmentRecord, group_id: str | None) -> list[str]:
    students = [s for s in roster_ids(db, rec.class_id) if readers.in_audience(db, rec, s)]
    if group_id:
        members = {r[0] for r in db.execute("SELECT student_id FROM group_members WHERE class_id=? AND group_id=?",
                                            (rec.class_id, group_id))}
        students = [s for s in students if s in members]
    return students


def _latest_submissions(db: sqlite3.Connection, rec: AssignmentRecord) -> tuple[dict[str, sqlite3.Row], dict[str, int]]:
    latest: dict[str, sqlite3.Row] = {}
    counts: dict[str, int] = {}
    for row in db.execute("SELECT * FROM submissions WHERE class_id=? AND assignment_id=? AND is_preview=0 "
                          "ORDER BY student_id, attempt DESC, submitted_at DESC, id DESC", (rec.class_id, rec.id)):
        counts[row["student_id"]] = counts.get(row["student_id"], 0) + 1
        latest.setdefault(row["student_id"], row)
    return latest, counts


def _drafts(db: sqlite3.Connection, rec: AssignmentRecord) -> dict[str, tuple[int, str]]:
    ids = [q["id"] for q in rec.questions]
    if not ids:
        return {}
    marks = ", ".join("?" for _ in ids)
    return {r["student_id"]: (int(r["answered"]), r["updated"]) for r in db.execute(
        f"""SELECT student_id, COUNT(*) AS answered, MAX(updated_at) AS updated FROM answer_drafts WHERE class_id=? AND assignment_id=?
        AND is_preview=0 AND value_length > 0 AND question_id IN ({marks}) GROUP BY student_id""",
        (rec.class_id, rec.id, *ids))}


def _first_tries(db: sqlite3.Connection, rec: AssignmentRecord, students: set[str]) -> tuple[int, int | None]:
    """(students who checked a current question, first-try-correct % over (student, current question) pairs).

    RT-02: the definition of Exercise results and the Gradebook in-class cell (§13.3, ``grading.exercise_results`` /
    ``grading.in_class_entry``), so the Assignments row agrees with both: only questions still in the exercise (answers to
    a question removed by an edit no longer count), only server-checked answers (re-judged legacy checks included;
    client-reported and not-re-judged legacy checks excluded), and each pair's first checked answer in time order.
    """
    qids = [q["id"] for q in rec.questions if isinstance(q.get("id"), str) and q["id"]]
    if not qids or not students:
        return 0, None
    marks = ", ".join("?" for _ in qids)
    first: dict[tuple[str, str], bool] = {}
    attempted: set[str] = set()
    for event in db.execute(
            f"""SELECT e.student_id, e.question_id,
            CASE WHEN e.checked_by = 'legacy_server' THEN e.rejudged_correct
                 WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json, '$.correct') END AS ok
            FROM events e WHERE e.class_id=? AND e.event_type='answer_submitted' AND e.checked_by IN ('server', 'legacy_server')
            AND {_REAL_EVENT} AND {_FOR_ASSIGNMENT} AND e.question_id IN ({marks}) ORDER BY e.created_at, e.id""",
            (rec.class_id, rec.id, rec.id, *qids)):
        if event["student_id"] not in students:
            continue
        attempted.add(event["student_id"])
        if event["ok"] in (0, 1):
            first.setdefault((event["student_id"], event["question_id"]), bool(event["ok"]))
    return len(attempted), (round(100 * sum(first.values()) / len(first)) if first else None)


def assignment_stats(db: sqlite3.Connection, rec: AssignmentRecord, group_id: str | None = None) -> dict:
    """``AssignmentStats`` (§7.4) over the enrolled audience (preview and staff excluded) [DA01, TH01]."""
    from server import analytics

    now = dbmod.utcnow()
    students = _audience_students(db, rec, group_id)
    population = set(students)
    latest, _ = _latest_submissions(db, rec)
    latest = {sid: row for sid, row in latest.items() if sid in population}
    drafts = {sid: d for sid, d in _drafts(db, rec).items() if sid in population}
    counts = readers.grading_counts(db, rec.class_id, rec.id, group_id)
    scored = [float(r["grade"]) for r in latest.values() if r["grade"] is not None and r["grade_status"] in ("draft", "released")]
    attempted, first_try = _first_tries(db, rec, population) if rec.kind == "practice" else (0, None)
    # S-M01: students who submitted the original of this revision are not missing it
    on_original = {sid for sid in readers.originals_submitted_by(db, rec) if sid in population and sid not in latest} \
        if rec.kind == "homework" else set()
    # D8: the Missing work rule of every view — a homework and its revisions count once
    missing = analytics.missing_students(db, rec, [sid for sid in students if sid not in latest], now)
    return {
        "enrolled": len(students), "submitted": len(latest),
        "startedNotSubmitted": sum(1 for sid, (answered, _) in drafts.items() if answered > 0 and sid not in latest),
        "toGrade": int(counts.get("toGrade", 0)), "toRelease": int(counts.get("toRelease", 0)),
        "late": sum(1 for r in latest.values() if r["is_late"]),
        "missing": len(missing),
        "submittedOriginal": len(on_original),
        "graded": sum(1 for r in latest.values() if r["grade_status"] in ("draft", "released")),
        "released": sum(1 for r in latest.values() if r["grade_status"] == "released"),
        "avgScore": round(sum(scored) / len(scored), 2) if scored else None,
        "maxPoints": sum(float(q.get("points") or 0) for q in rec.questions),
        "attempted": attempted, "firstTryCorrectPct": first_try,
    }


STUDENT_STATES = ("submitted", "not_submitted", "started", "missing", "late", "to_grade")


def students_status(db: sqlite3.Connection, rec: AssignmentRecord, state: str, group_id: str | None,
                    name_mode: str) -> dict:
    """``{students: AssignmentStudentStatus[], emails}`` for the row popovers [DA01, DA07]."""
    from server import analytics

    now = dbmod.utcnow()
    students = _audience_students(db, rec, group_id)
    latest, attempts = _latest_submissions(db, rec)
    drafts = _drafts(db, rec)
    on_original = readers.originals_submitted_by(db, rec) if rec.kind == "homework" else set()
    # D8: the Missing work rule of every view — a homework and its revisions count once
    missing = analytics.missing_students(db, rec, [sid for sid in students if sid not in latest], now) \
        if state == "missing" else set()
    selected = []
    for sid in students:
        sub = latest.get(sid)
        answered = drafts.get(sid, (0, None))[0]
        keep = {
            "submitted": sub is not None, "not_submitted": sub is None, "started": sub is None and answered > 0,
            "missing": sid in missing, "late": sub is not None and bool(sub["is_late"]),
            "to_grade": sub is not None and sub["grade_status"] == "ungraded",
        }[state]
        if keep:
            selected.append(sid)
    if not selected:
        return {"students": [], "emails": None}
    marks = ", ".join("?" for _ in selected)
    last_active = {r[0]: r[1] for r in db.execute(
        f"SELECT student_id, MAX(created_at) FROM events WHERE class_id=? AND is_preview=0 AND {identitymod.STUDENT_ACTOR_SQL} "
        f"AND student_id IN ({marks}) GROUP BY student_id",
        (rec.class_id, *selected))}
    groups: dict[str, dict[str, str]] = {}
    for r in db.execute(
            f"""SELECT m.student_id, m.kind, g.name FROM group_members m JOIN course_groups g ON g.id=m.group_id
            WHERE m.class_id=? AND m.kind IN ('section','condition') AND g.archived_at IS NULL AND m.student_id IN ({marks})""",
            (rec.class_id, *selected)):
        groups.setdefault(r["student_id"], {})[r["kind"]] = r["name"]
    rows = []
    for sid in selected:
        sub = latest.get(sid)
        answered, updated = drafts.get(sid, (0, None))
        rows.append({"studentId": sid, "studentName": sid, "section": groups.get(sid, {}).get("section"),
                     "condition": groups.get(sid, {}).get("condition"), "lastActive": last_active.get(sid),
                     "submittedAt": sub["submitted_at"] if sub else None, "late": bool(sub["is_late"]) if sub else False,
                     "attempts": attempts.get(sid, 0), "gradeStatus": sub["grade_status"] if sub else None,
                     "draftAnswered": answered, "draftTotal": len(rec.questions), "draftUpdatedAt": updated,
                     "submittedOriginal": sub is None and sid in on_original})
    identitymod.relabel(db, rec.class_id, rows, name_mode)
    rows.sort(key=lambda r: (r["studentName"] or "").casefold())
    emails = None
    if name_mode == "names" and readers.settings(db, rec.class_id).get("privacy", {}).get("showEmails", True):
        found = [r[0] for r in db.execute(f"SELECT kiwi_email FROM roster WHERE class_id=? AND student_id IN ({marks}) "
                                          "AND kiwi_email != ''", (rec.class_id, *selected))]
        emails = sorted(found) or None
    return {"students": rows, "emails": emails}


__all__ = ["submit", "list_submissions", "student_submissions", "start_attempt", "get_draft", "save_draft", "has_draft",
           "carry_revision_draft", "assignment_stats",
           "students_status", "submit_result", "get_work", "load_row"]
