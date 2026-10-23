"""Test infrastructure (spec §16.1 item 6; FOUNDATION, frozen).

``ApiTestCase`` runs a real ``ThreadingHTTPServer`` on a temporary database. Fixture builders write rows
exactly as the owning writers do (columns per §4.2, derived fields through ``telemetry.derive`` via
``telemetry.add_event``), so a workstream's acceptance tests pass with only FOUNDATION baselines present.
INTEGRATION-04 compares builders with the real writers.
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import threading
import unittest
import uuid
from contextlib import contextmanager
from datetime import datetime
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

from server import app, auth, course_config, grading_rules, identity, kiwi_bridge, readers, telemetry
from server import db as dbmod

# INTEGRATION (PEOPLE open question 5): `app.load_dotenv()` only fills unset variables, so a developer `.env` used to put a
# real provider key into the test process. Tests never call a real AI provider: AI keys are always empty here, and tests
# that need "configured" patch the environment or `ai.invoke` themselves.
for _ai_key in ("OPENAI_API_KEY", "OPEN_AI_TEST_KEY"):
    os.environ[_ai_key] = ""

TEACHER_KEY = "test-teacher-key"
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_QUESTIONS = [
    {"id": "q1", "type": "fill", "prompt": "What does mean(c(2, 4, 6)) return?", "points": 10, "choices": [],
     "starterCode": "", "answer": "4", "explanation": "The sum is 12; divide by 3."},
    {"id": "q2", "type": "text", "prompt": "Explain what a vector is.", "points": 10, "choices": [], "starterCode": "",
     "answer": "An ordered sequence of values of one type.", "explanation": ""},
]


# -- time ------------------------------------------------------------------------------------------
@contextmanager
def _clock_at(at: str | datetime | None) -> Iterator[None]:
    if at is None:
        yield
        return
    moment = dbmod.parse_iso(at)
    previous = dbmod._clock
    dbmod.set_clock(lambda: moment)  # type: ignore[arg-type,return-value]
    try:
        yield
    finally:
        dbmod.set_clock(previous)


class freeze_time:
    """``freeze_time("2026-10-22T01:00:00+00:00")`` sets ``db.now()``; use as a context manager to restore."""

    def __init__(self, at: str | datetime) -> None:
        self.moment = dbmod.parse_iso(at)
        self.previous = dbmod._clock
        dbmod.set_clock(lambda: self.moment)  # type: ignore[arg-type,return-value]

    def __enter__(self) -> "freeze_time":
        return self

    def __exit__(self, *exc: object) -> None:
        dbmod.set_clock(self.previous)

    def advance(self, **delta: float) -> None:
        from datetime import timedelta

        self.moment = self.moment + timedelta(**delta)  # type: ignore[operator]


# -- identities ------------------------------------------------------------------------------------
def student_identity(db: sqlite3.Connection, class_id: str, student_id: str) -> auth.Identity:
    linked = identity.class_linked(db, class_id)
    return auth.student_identity(class_id, student_id, kind="kiwi" if linked else "demo",
                                 display_name=identity.label(db, class_id, student_id), linked=linked)


def preview_identity(class_id: str, staff_user: str = "instructor") -> auth.Identity:
    return auth.Identity("teacher_key", class_id, staff_user, "Instructor (local key)", None, "instructor", True, False,
                         False, True, f"preview-{staff_user}", auth.permissions_for("instructor", None), "key")


def fake_kiwi_context(role: str = "student", can_manage: bool = False, can_view: bool = False,
                      user_role: str | None = None, *, class_id: str = "live-course", user_id: str | None = None,
                      username: str | None = None, class_name: str | None = None) -> dict:
    staff = role != "student"
    return {"classId": class_id, "className": class_name or class_id, "userId": user_id or ("t1" if staff else "s1"),
            "username": username or ("teacher@example.edu" if staff else "ada@example.edu"),
            "userRole": user_role or ("professor" if staff else "student"), "canTeach": staff,
            "canManageCourse": can_manage, "canViewAnalytics": can_view}


@contextmanager
def fake_kiwi_identity(role: str = "student", can_manage: bool = False, can_view: bool = False,
                       user_role: str | None = None, **context: Any) -> Iterator[str]:
    """Patch the bridge so any bearer token resolves to this Kiwi context; yields a token to send."""
    ctx = fake_kiwi_context(role, can_manage, can_view, user_role, **context)
    original = kiwi_bridge.remote

    def remote(token: str, path: str, params: dict | None = None) -> dict:
        if path == "context":
            return dict(ctx)
        return original(token, path, params)

    kiwi_bridge._identity_cache.clear()
    with patch.object(kiwi_bridge, "remote", side_effect=remote):
        yield f"token-{ctx['userId']}"
    kiwi_bridge._identity_cache.clear()


# -- course & schedule -----------------------------------------------------------------------------
def create_course(db: sqlite3.Connection, class_id: str, *, title: str = "Test course", units: list | None = None,
                  current_unit_id: str | None = None, free_practice_scope: str = "current_and_earlier") -> dict:
    base = course_config.DEFAULT_COURSE
    data = {"title": title, "description": "", "units": units or [dict(u) for u in base["units"]],
            "currentUnitId": current_unit_id or base["currentUnitId"], "freePracticeScope": free_practice_scope}
    config = course_config.validate_course(data)
    stamp = dbmod.now()
    with dbmod.write_tx(db):
        db.execute("INSERT INTO courses (class_id, config_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(class_id) DO UPDATE "
                   "SET config_json=excluded.config_json, updated_at=excluded.updated_at", (class_id, dbmod.json_dumps(config), stamp))
        db.execute("INSERT INTO course_settings (class_id, settings_json, updated_at, updated_by) VALUES (?, ?, ?, 'test') "
                   "ON CONFLICT(class_id) DO NOTHING", (class_id, dbmod.json_dumps(course_config.default_settings()), stamp))
    return course_config.course_for(class_id, db)


def update_settings(db: sqlite3.Connection, class_id: str, patch_: dict) -> dict:
    merged = course_config.merge_settings({**readers.settings(db, class_id), **patch_})
    with dbmod.write_tx(db):
        db.execute("INSERT INTO course_settings (class_id, settings_json, updated_at, updated_by) VALUES (?, ?, ?, 'test') "
                   "ON CONFLICT(class_id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at",
                   (class_id, dbmod.json_dumps(merged), dbmod.now()))
    return merged


def set_meetings(db: sqlite3.Connection, class_id: str, meetings: list[dict], *, timezone: str = "Asia/Shanghai",
                 term_start: str | None = None) -> dict:
    schedule = course_config.validate_schedule({"timezone": timezone, "meetings": meetings, "termStart": term_start})
    return update_settings(db, class_id, {"schedule": schedule})


def add_roster(db: sqlite3.Connection, class_id: str, student_id: str, *, source: str = "import", display_name: str = "",
               kiwi_email: str = "") -> None:
    with dbmod.write_tx(db):
        identity.ensure_roster(db, class_id, student_id, source=source, display_name=display_name, kiwi_email=kiwi_email)


# -- assignments -----------------------------------------------------------------------------------
def publish_work(db: sqlite3.Connection, class_id: str, *, kind: str = "homework", title: str | None = None,
                 unit_id: str = "r-basics", questions: list | None = None, due_at: str | None = None,
                 status: str = "published", tool_policy: dict | None = None, audience: dict | None = None,
                 late_policy: dict | None = None, open_at: str | None = None, close_at: str | None = None,
                 solutions_visibility: str = "never", grades_visibility: str = "immediately",
                 max_attempts: int | None = None, time_limit: dict | None = None, work_id: str | None = None):
    """An assignment row as ASSESS writes it (+ its ``assignment_versions`` v1 snapshot when published)."""
    work_id = work_id or f"work-{uuid.uuid4().hex[:16]}"
    qs = [dict(q) for q in (questions or DEFAULT_QUESTIONS)]
    defaults = readers.HOMEWORK_TOOL_DEFAULT if kind == "homework" else readers.INCLASS_TOOL_DEFAULT
    stamp = dbmod.now()
    with dbmod.write_tx(db):
        db.execute(
            """INSERT INTO assignments (id, class_id, kind, title, unit_id, instructions, due_at, status, questions_json,
            created_at, updated_at, open_at, close_at, late_policy_json, max_attempts, grades_visibility, solutions_visibility,
            time_limit_json, tool_policy_json, audience_json, created_by, updated_by)
            VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'instructor', 'instructor')""",
            (work_id, class_id, kind, title or f"Test {kind} {work_id[-4:]}", unit_id, due_at, status,
             json.dumps(qs, ensure_ascii=False), stamp, stamp, open_at, close_at,
             dbmod.json_dumps({**readers.LATE_POLICY_DEFAULT, **(late_policy or {})}), max_attempts, grades_visibility,
             solutions_visibility, dbmod.json_dumps(time_limit) if time_limit else None,
             dbmod.json_dumps({**defaults, **(tool_policy or {})}), dbmod.json_dumps(audience or {"type": "all"})))
        if status == "published":
            row = db.execute("SELECT * FROM assignments WHERE id=?", (work_id,)).fetchone()
            snapshot = readers.assignment_snapshot(row)
            db.execute(
                """INSERT INTO assignment_versions (assignment_id, class_id, version, snapshot_json, questions_hash, created_by,
                created_at, reason) VALUES (?, ?, 1, ?, ?, 'instructor', ?, 'publish')""",
                (work_id, class_id, dbmod.json_dumps(snapshot), readers.questions_hash(snapshot["questions"]), stamp))
    return readers.load_assignment(db, class_id, work_id)


def make_group(db: sqlite3.Connection, class_id: str, kind: str, name: str, members: list[str] = (), *,  # type: ignore[assignment]
               method: str = "manual", assigned_by: str = "instructor", at: str | None = None) -> str:
    group_id = f"grp-{uuid.uuid4().hex[:12]}"
    with _clock_at(at), dbmod.write_tx(db):
        stamp = dbmod.now()
        db.execute("INSERT INTO course_groups (id, class_id, name, kind, description, created_at) VALUES (?, ?, ?, ?, '', ?)",
                   (group_id, class_id, name, kind, stamp))
        for student_id in members:
            set_membership(db, class_id, group_id, student_id, kind, method=method, assigned_by=assigned_by)
    return group_id


def set_membership(db: sqlite3.Connection, class_id: str, group_id: str, student_id: str, kind: str, *,
                   method: str = "manual", assigned_by: str = "instructor", seed: str | None = None) -> None:
    """Writer pattern of §4.2.2: section/condition moves upsert on the partial unique index (history via triggers)."""
    stamp = dbmod.now()
    with dbmod.write_tx(db):
        if kind in ("section", "condition"):
            db.execute(
                """INSERT INTO group_members (class_id, group_id, student_id, kind, method, seed, assigned_by, assigned_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(class_id, student_id, kind) WHERE kind IN ('section','condition')
                DO UPDATE SET group_id=excluded.group_id, method=excluded.method, seed=excluded.seed,
                assigned_by=excluded.assigned_by, assigned_at=excluded.assigned_at""",
                (class_id, group_id, student_id, kind, method, seed, assigned_by, stamp))
        else:
            db.execute(
                """INSERT INTO group_members (class_id, group_id, student_id, kind, method, seed, assigned_by, assigned_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(class_id, group_id, student_id) DO NOTHING""",
                (class_id, group_id, student_id, kind, method, seed, assigned_by, stamp))


def _server_event(db: sqlite3.Connection, ident: auth.Identity, event_type: str, payload: dict, *,
                  question_id: str | None = None, surface: str = "", session_id: str = "server") -> int:
    result = telemetry.add_event(db, ident, {"classId": ident.class_id, "studentId": ident.student_id,
                                             "studentName": ident.display_name or ident.student_id, "sessionId": session_id,
                                             "type": event_type, "questionId": question_id, "payload": payload,
                                             "surface": surface, "schemaVersion": 2}, server=True)
    return int(result.id or 0)


def _ident(db: sqlite3.Connection, class_id: str, student_id: str, preview: bool) -> auth.Identity:
    if preview:
        return preview_identity(class_id, student_id[len("preview-"):] if student_id.startswith("preview-") else "instructor")
    return student_identity(db, class_id, student_id)


def make_server_check(db: sqlite3.Connection, class_id: str, student_id: str, assignment_id: str, question_id: str,
                      answer: str, correct: bool | None, *, at: str | None = None, attempt_index: int = 1,
                      basis: str = "answer_text", preview: bool = False) -> int:
    """An in-class check as ASSESS writes it: server ``answer_submitted`` (``checked_by='server'``)."""
    ident = _ident(db, class_id, student_id, preview)
    version = readers.current_version(db, class_id, assignment_id)
    rec = readers.load_assignment(db, class_id, assignment_id)
    # INTEGRATION-04: same payload as ASSESS's real check (unitId, judging reason, checkedBy '' when not gradable).
    with _clock_at(at):
        event_id = _server_event(db, ident, "answer_submitted", {
            "assignmentId": assignment_id, "answer": answer, "correct": correct,
            "checkedBy": "server" if correct is not None else "", "basis": basis,
            "attemptIndex": attempt_index, "assignmentVersion": version, "unitId": rec.unit_id if rec else "",
            "reason": _reason(correct)}, question_id=question_id, surface="assignment")
        if not preview:
            db.execute("UPDATE assignments SET frozen_at=COALESCE(frozen_at, ?) WHERE class_id=? AND id=?",
                       (dbmod.now(), class_id, assignment_id))
    return event_id


def _reason(correct: bool | None) -> str:
    """The judging reason a real check records for an explicit outcome (``judging.check`` values)."""
    return "not_gradable" if correct is None else ("exact" if correct else "mismatch")


def _make_item(db: sqlite3.Connection, ident: auth.Identity, origin: str, unit_id: str, *, related_assignment_id: str = "",
               related_question_id: str = "", question_type: str = "fill", difficulty: int = 2, answer: str = "4",
               prompt: str = "What does mean(c(1, 3)) return?", choices: list | None = None) -> str:
    item_id = "gi-" + uuid.uuid4().hex[:24]
    section, condition = readers.group_stamp(db, ident.class_id, ident.student_id or "")
    item = {"title": "Practice", "prompt": prompt, "answer": answer, "acceptedAnswers": [], "explanation": "Average the values.",
            **({"choices": choices} if choices else {})}
    surface = "similar" if origin == "similar" else "free-practice"
    with dbmod.write_tx(db):
        # INTEGRATION-04: like AIRUN's pipeline, an AI-sourced item has its ai_calls row (provenance "Show AI call").
        call = db.execute(
            """INSERT INTO ai_calls (request_id, class_id, student_id, actor_role, is_preview, identity_verified, action, surface,
            unit_id, assignment_id, question_id, item_id, section_group_id, condition_group_id, policy_source, platform_rules_version,
            model, status, requested_at, responded_at, raw_output, guard_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'platform', 'platform-rules-v2', 'gpt-5.4-mini', 'ok', ?, ?, ?, ?)""",
            (uuid.uuid4().hex, ident.class_id, ident.student_id, ident.actor_role, int(ident.preview), int(ident.verified),
             "similar" if origin == "similar" else "question", surface, unit_id, related_assignment_id, related_question_id,
             item_id, section, condition, dbmod.now(), dbmod.now(), dbmod.json_dumps(item),
             "clean" if origin == "similar" else "not_applicable"))
        db.execute(
            """INSERT INTO generated_items (id, class_id, student_id, actor_role, is_preview, identity_verified, origin, unit_id,
            related_assignment_id, related_question_id, question_type, difficulty, requested_type, requested_difficulty,
            item_json, source, model, section_group_id, condition_group_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', 'gpt-5.4-mini', ?, ?, ?)""",
            (item_id, ident.class_id, ident.student_id, ident.actor_role, int(ident.preview), int(ident.verified), origin,
             unit_id, related_assignment_id, related_question_id, question_type, difficulty, question_type, difficulty,
             dbmod.json_dumps(item), section, condition, dbmod.now()))
        _server_event(db, ident, "question_generated", {
            "itemId": item_id, "origin": origin, "unitId": unit_id, "type": question_type, "difficulty": difficulty,
            "requestedType": question_type, "requestedDifficulty": difficulty, "title": item["title"], "prompt": prompt,
            "source": "ai", "relatedAssignmentId": related_assignment_id or None, "relatedQuestionId": related_question_id or None,
            "aiCallId": call.lastrowid}, question_id=item_id, surface=surface)
        if origin == "similar":
            _server_event(db, ident, "similar_requested", {"sourceAssignmentId": related_assignment_id,
                                                          "sourceQuestionId": related_question_id, "itemId": item_id,
                                                          "unitId": unit_id, "relatedAssignmentId": related_assignment_id},
                          question_id=related_question_id or None, surface="similar")
    return item_id


def make_similar_attempt(db: sqlite3.Connection, class_id: str, student_id: str, assignment_id: str, question_id: str, *,
                         correct: bool = True, answer: str = "4", unit_id: str | None = None, at: str | None = None,
                         attempt_index: int = 1) -> str:
    """A similar-practice item (AIRUN) and one server-checked attempt on it; returns the item id."""
    ident = student_identity(db, class_id, student_id)
    rec = readers.load_assignment(db, class_id, assignment_id)
    with _clock_at(at):
        item_id = _make_item(db, ident, "similar", unit_id or (rec.unit_id if rec else ""), related_assignment_id=assignment_id,
                             related_question_id=question_id, answer=answer)
        _server_event(db, ident, "answer_submitted", {"itemId": item_id, "answer": answer, "correct": correct,
                                                     "checkedBy": "server", "basis": "answer_text", "reason": _reason(correct),
                                                     "attemptIndex": attempt_index, "unitId": unit_id or (rec.unit_id if rec else ""),
                                                     "origin": "similar", "relatedAssignmentId": assignment_id},
                      question_id=item_id, surface="similar")
    return item_id


def make_free_item_attempt(db: sqlite3.Connection, class_id: str, student_id: str, unit_id: str, *, correct: bool = True,
                           answer: str = "4", question_type: str = "fill", difficulty: int = 2, at: str | None = None,
                           attempt_index: int = 1) -> str:
    """A free-practice item (AIRUN) and one server-checked attempt on it; returns the item id."""
    ident = student_identity(db, class_id, student_id)
    with _clock_at(at):
        item_id = _make_item(db, ident, "free", unit_id, question_type=question_type, difficulty=difficulty, answer=answer)
        _server_event(db, ident, "answer_submitted", {"itemId": item_id, "answer": answer, "correct": correct,
                                                     "checkedBy": "server", "basis": "answer_text", "reason": _reason(correct),
                                                     "attemptIndex": attempt_index, "unitId": unit_id, "origin": "free",
                                                     "relatedAssignmentId": None},
                      question_id=item_id, surface="free-practice")
    return item_id


def make_autochecked_submission(db: sqlite3.Connection, class_id: str, student_id: str, assignment_id: str,
                                answers: dict[str, str], *, auto: dict[str, bool | None] | None = None,
                                grade_status: str = "ungraded", grade: float | None = None, feedback: str | None = None,
                                at: str | None = None, preview: bool = False, time_used_seconds: int | None = None,
                                over_time: bool = False) -> str:
    """A homework submission as ASSESS submit v2 writes it (item auto scores, autocheck_json, server events)."""
    from server import judging

    ident = _ident(db, class_id, student_id, preview)
    rec = readers.load_assignment(db, class_id, assignment_id)
    if rec is None:
        raise ValueError("Assignment not found")
    with _clock_at(at), dbmod.write_tx(db):
        stamp = dbmod.now()
        attempt = db.execute("SELECT COUNT(*) FROM submissions WHERE assignment_id=? AND student_id=?",
                             (assignment_id, ident.student_id)).fetchone()[0] + 1
        submission_id = f"sub-{uuid.uuid4().hex[:16]}"
        due = dbmod.parse_iso(rec.due_at) if rec.due_at else None
        now_dt = dbmod.parse_iso(stamp)
        late_seconds = max(0, int((now_dt - due).total_seconds())) if due is not None and now_dt > due else 0  # type: ignore[operator]
        section, condition = readers.group_stamp(db, class_id, ident.student_id or "")
        results: dict[str, dict] = {}
        for question in rec.questions:
            qid = question["id"]
            if auto is not None and qid in auto:
                correct = auto[qid]
                outcome = {"correct": correct, "scoreFraction": None if correct is None else float(bool(correct)),
                           "reason": "not_gradable" if correct is None else ("exact" if correct else "mismatch"),
                           "basis": "answer_text", "normalizedAnswer": judging.normalize(answers.get(qid, ""))}
            else:
                outcome = judging.check(question, answers.get(qid, "")).as_dict()
            results[qid] = outcome
        db.execute(
            """INSERT INTO submissions (id, assignment_id, class_id, student_id, student_name, attempt, answers_json,
            submitted_at, grade, feedback, graded_at, assignment_version, is_late, late_seconds, actor_role, is_preview,
            identity_verified, grade_status, released_at, autocheck_json, time_used_seconds, over_time, section_group_id,
            condition_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (submission_id, assignment_id, class_id, ident.student_id, "" if ident.class_linked else ident.display_name,
             attempt, json.dumps(answers, ensure_ascii=False), stamp, grade, feedback,
             stamp if grade is not None else None, rec.version, int(late_seconds > 0), late_seconds, ident.actor_role,
             int(ident.preview), int(ident.verified), grade_status, stamp if grade_status == "released" else None,
             dbmod.json_dumps(results), time_used_seconds, int(over_time), section, condition))
        for question in rec.questions:
            outcome = results[question["id"]]
            points = float(question.get("points") or 0)
            db.execute(
                """INSERT INTO submission_item_scores (submission_id, question_id, class_id, auto_correct, auto_score, auto_reason)
                VALUES (?, ?, ?, ?, ?, ?)""",
                (submission_id, question["id"], class_id, None if outcome["correct"] is None else int(bool(outcome["correct"])),
                 None if outcome["correct"] is None else points * float(bool(outcome["correct"])), outcome["reason"]))
            # INTEGRATION-04: same payload as ASSESS's real submit (unitId, judging reason, checkedBy '' when not gradable)
            _server_event(db, ident, "answer_submitted", {
                "assignmentId": assignment_id, "unitId": rec.unit_id, "answer": answers.get(question["id"], ""),
                "correct": outcome["correct"], "checkedBy": "server" if outcome["correct"] is not None else "",
                "basis": outcome["basis"], "submissionId": submission_id, "attempt": attempt,
                "assignmentVersion": rec.version, "reason": outcome["reason"]}, question_id=question["id"], surface="assignment",
                session_id="submission-" + submission_id)
        _server_event(db, ident, "work_submitted", {
            "assignmentId": assignment_id, "unitId": rec.unit_id, "submissionId": submission_id, "attempt": attempt,
            "late": late_seconds > 0,
            "lateSeconds": late_seconds, "overTime": over_time, "timeUsedSeconds": time_used_seconds},
            surface="assignment", session_id="submission-" + submission_id)
        db.execute(
            """INSERT INTO grade_events (submission_id, class_id, actor_id, actor_role, actor_label, action, total_after,
            items_after_json, status_after, created_at) VALUES (?, ?, 'server', 'system', 'Auto-check', 'autocheck', NULL, ?, ?, ?)""",
            (submission_id, class_id, dbmod.json_dumps({k: v["correct"] for k, v in results.items()}), grade_status, stamp))
        if not preview:
            db.execute("UPDATE assignments SET frozen_at=COALESCE(frozen_at, ?) WHERE class_id=? AND id=?",
                       (stamp, class_id, assignment_id))
    return submission_id


def make_draft(db: sqlite3.Connection, class_id: str, student_id: str, assignment_id: str, answers: dict[str, str], *,
               preview: bool = False, client_ts: int | None = None, at: str | None = None) -> None:
    """Server-saved answer drafts as ASSESS writes them (+ one ``answer_draft`` server event per question)."""
    import hashlib

    ident = _ident(db, class_id, student_id, preview)
    with _clock_at(at), dbmod.write_tx(db):
        section, condition = readers.group_stamp(db, class_id, ident.student_id or "")
        version = readers.current_version(db, class_id, assignment_id)
        rec = readers.load_assignment(db, class_id, assignment_id)
        for question_id, value in answers.items():
            db.execute(
                """INSERT INTO answer_drafts (class_id, student_id, assignment_id, question_id, value, value_length,
                assignment_version, is_preview, client_ts_ms, updated_at, section_group_id, condition_group_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(class_id, student_id, assignment_id, question_id)
                DO UPDATE SET value=excluded.value, value_length=excluded.value_length, client_ts_ms=excluded.client_ts_ms,
                updated_at=excluded.updated_at""",
                (class_id, ident.student_id, assignment_id, question_id, value, grading_rules.answered_length(value), version,
                 int(ident.preview),
                 client_ts if client_ts is not None else dbmod.now_ms(), dbmod.now(), section, condition))
            payload = {"assignmentId": assignment_id, "unitId": rec.unit_id if rec else "", "questionId": question_id,
                       "length": len(value), "valueHash": hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]}
            if rec and any(q.get("id") == question_id and q.get("type") == "choice" for q in rec.questions):
                payload["choice"] = value
            # INTEGRATION-04: same payload as ASSESS's draft writer
            _server_event(db, ident, "answer_draft", payload, question_id=question_id, surface="assignment")


def make_chat_turn(db: sqlite3.Connection, class_id: str, student_id: str, prompt: str, response: str, *,
                   thread_id: str = "t1", unit_id: str = "", assignment_id: str = "", question_id: str = "",
                   item_id: str = "", surface: str = "ask-kiwi", guard_status: str = "not_applicable", flagged: bool = False,
                   flag_reason: str = "", status: str = "ok", source: str = "lab-ai", model: str | None = "gpt-5.4-mini",
                   policy_version_id: int | None = None, at: str | None = None, preview: bool = False) -> int:
    """A Lab AI tutor turn as AIRUN writes it: ``ai_calls`` row, ``chat_turns`` row and a server ``ai_question`` event."""
    ident = _ident(db, class_id, student_id, preview)
    with _clock_at(at), dbmod.write_tx(db):
        stamp = dbmod.now()
        section, condition = readers.group_stamp(db, class_id, ident.student_id or "")
        call = db.execute(
            """INSERT INTO ai_calls (request_id, class_id, student_id, actor_role, is_preview, identity_verified, action, surface,
            unit_id, assignment_id, question_id, item_id, thread_id, section_group_id, condition_group_id, policy_version_id,
            policy_source, platform_rules_version, model, status, requested_at, responded_at, raw_output, guard_status)
            VALUES (?, ?, ?, ?, ?, ?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'platform-rules-v2', ?, ?, ?, ?, ?, ?)""",
            (uuid.uuid4().hex, class_id, ident.student_id, ident.actor_role, int(ident.preview), int(ident.verified), surface,
             unit_id, assignment_id, question_id, item_id, thread_id, section, condition, policy_version_id,
             "unit" if policy_version_id else "platform", model, status, stamp, stamp, response, guard_status))
        turn = db.execute(
            """INSERT INTO chat_turns (class_id, student_id, thread_id, question_id, prompt, response, created_at, unit_id,
            assignment_id, item_id, surface, ai_call_id, policy_version_id, model, source, guard_status, flagged, flag_reason,
            flag_source, actor_role, is_preview, identity_verified, section_group_id, condition_group_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (class_id, ident.student_id, thread_id, question_id, prompt, response, stamp, unit_id, assignment_id, item_id,
             surface, call.lastrowid, policy_version_id, model, source, guard_status, int(flagged), flag_reason,
             "guard" if flagged else "", ident.actor_role, int(ident.preview), int(ident.verified), section, condition))
        _server_event(db, ident, "ai_question", {
            "chatTurnId": turn.lastrowid, "aiCallId": call.lastrowid, "unitId": unit_id, "assignmentId": assignment_id or None,
            "itemId": item_id or None, "threadId": thread_id, "surface": surface, "prompt": prompt, "response": response,
            "aiProvider": "openai" if source == "lab-ai" else "local", "model": model, "policyVersionId": policy_version_id,
            "guardStatus": guard_status}, question_id=question_id or None, surface=surface)
    return int(turn.lastrowid)


def make_native_event(db: sqlite3.Connection, class_id: str, student_id: str, *, kind: str = "frontend-interaction-chat",
                      prompt: str = "Why does mean return NA?", response: str = "", at: str = "2026-10-15T01:00:00.000Z",
                      record_id: str | None = None, material: dict | None = None, email: str = "student@example.edu",
                      context: dict | None = None) -> bool:
    """A native Kiwi record imported exactly as the bridge importer writes it (``kiwi_bridge.import_record``)."""
    record = {"id": record_id or f"native-{uuid.uuid4().hex[:12]}", "userId": student_id, "user": {"email": email},
              "sessionId": "native-session", "timestamp": at, "type": kind,
              "context": context if context is not None else {"content": {"prompt": prompt}},
              "pdfId": (material or {}).get("documentId"), "pdfPage": 1 if material else None,
              "conversationId": "native-thread", "serverActions": [{"id": "reply-" + uuid.uuid4().hex[:8], "botResponse": response}] if response else []}
    materials = {material["documentId"]: {"id": material["id"], "title": material.get("title", material["id"]),
                                          "unit_id": material.get("unitId", "")}} if material else {}
    with dbmod.write_tx(db):
        return kiwi_bridge.import_record(db, class_id, record, materials)


# -- snapshots -------------------------------------------------------------------------------------
def snapshot_paths() -> list[Path]:
    """Migration snapshots: ``.local/*.sqlite3`` plus comma-separated ``KIWI_SNAPSHOT_DBS``."""
    paths = sorted((ROOT / ".local").glob("*.sqlite3")) if (ROOT / ".local").exists() else []
    extra = [Path(p.strip()) for p in os.environ.get("KIWI_SNAPSHOT_DBS", "").split(",") if p.strip()]
    seen: set[str] = set()
    result = []
    for path in paths + extra:
        key = str(path.resolve())
        if key not in seen and path.exists():
            seen.add(key)
            result.append(path)
    return result


def copy_snapshot(source: Path, target: Path) -> Path:
    """Copy a snapshot with the online backup API, never writing to the source."""
    wal = Path(str(source) + "-wal")
    uri = f"file:{source}?mode=ro" if wal.exists() and wal.stat().st_size > 0 else f"file:{source}?immutable=1"
    src = sqlite3.connect(uri, uri=True)
    try:
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return target


# -- HTTP test case --------------------------------------------------------------------------------
class ApiTestCase(unittest.TestCase):
    """Temporary database + live server. ``request(..., student=...)`` mints a demo session through the API."""

    teacher_key = TEACHER_KEY

    def setUp(self) -> None:
        kiwi_bridge._identity_cache.clear()
        auth.LIMITER.reset()
        auth.clear_key_cache()
        dbmod.set_clock(None)
        self.temp = tempfile.TemporaryDirectory()
        self._previous = (app.DB_PATH, app.TEACHER_KEY)
        app.DB_PATH = Path(self.temp.name) / "test.sqlite3"
        app.TEACHER_KEY = self.teacher_key
        app.init_db()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self._demo_tokens: dict[tuple[str, str], str] = {}
        self.last_headers: dict[str, str] = {}

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        dbmod.set_clock(None)
        auth.LIMITER.reset()
        auth.clear_key_cache()
        app.DB_PATH, app.TEACHER_KEY = self._previous
        self.temp.cleanup()

    # helpers
    def db(self) -> sqlite3.Connection:
        return app.connection()

    def create_course(self, class_id: str, **kwargs: Any) -> dict:
        with self.db() as db:
            return create_course(db, class_id, **kwargs)

    register_class = create_course

    @staticmethod
    def _class_of(path: str, body: object) -> str:
        query = parse_qs(urlparse(path).query)
        if "classId" in query:
            return query["classId"][0]
        if isinstance(body, dict) and isinstance(body.get("classId"), str):
            return body["classId"]
        return "local-r-class"

    def demo_session(self, class_id: str, student_id: str) -> str:
        key = (class_id, student_id)
        if key in self._demo_tokens:
            return self._demo_tokens[key]
        if student_id in auth.BUILTIN_DEMO_STUDENTS:
            status, data = self.request(f"/api/demo/session?classId={class_id}", "POST", {"studentId": student_id})
        else:
            status, link = self.request(f"/api/teacher/demo-links?classId={class_id}", "POST", {"studentId": student_id},
                                        key=TEACHER_KEY if self.teacher_key else None)
            if status != 200:
                raise AssertionError(f"demo link failed: {status} {link}")
            token = link["url"].split("#demo=", 1)[1]
            status, data = self.request(f"/api/demo/session?classId={class_id}", "POST", {"token": token})
        if status != 200:
            raise AssertionError(f"demo session failed: {status} {data}")
        self._demo_tokens[key] = data["token"]
        return data["token"]

    def request(self, path: str, method: str = "GET", body: object = None, key: str | None = None, *,
                token: str | None = None, student: str | None = None, preview: bool = False,
                name_mode: str | None = None, client_addr: str | None = None, headers: dict | None = None) -> tuple[int, Any]:
        sent = {"Content-Type": "application/json"}
        if key:
            sent["X-Teacher-Key"] = key
        if token:
            sent["Authorization"] = "Bearer " + token
        if student:
            sent["X-Demo-Session"] = self.demo_session(self._class_of(path, body), student)
        if preview:
            sent["X-Kiwi-Preview"] = "1"
        if name_mode:
            sent["X-Name-Mode"] = name_mode
        if client_addr:
            sent["X-Forwarded-For"] = client_addr
        sent.update(headers or {})
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        request = Request(self.url + path, data=data, headers=sent, method=method)
        try:
            with urlopen(request) as response:
                return response.status, self._decode(response)
        except HTTPError as error:
            with error:
                return error.code, self._decode(error)

    def _decode(self, response: Any) -> Any:
        self.last_headers = {k: v for k, v in response.headers.items()}
        raw = response.read()
        if not raw:
            return None
        if (response.headers.get("Content-Type") or "").startswith("application/json"):
            return json.loads(raw)
        return raw
