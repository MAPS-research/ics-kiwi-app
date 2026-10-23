"""Schema base, versioned migrations, backfills and backups (spec §4; FOUNDATION, frozen).

``init_db`` calls ``base_schema(db)`` (the exact v0.5.1 end state, then the legacy submission
recovery), then ``run(db)`` (core migrations, then workstream migrations). Every migration runs in
``BEGIN IMMEDIATE … COMMIT`` with its ``schema_migrations`` row, one statement per ``execute()``.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Callable

from server import db as dbmod
from server import event_schema

WORKSTREAM_MODULES = ("assess", "grade", "airules", "airun", "telemetry", "insights", "people")
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_ALLOWED_WS = re.compile(
    r"^\s*(CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s|CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s|ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s)",
    re.I)
_ALTER = re.compile(r"^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\s+(.+?)\s*;?\s*$", re.I | re.S)


class MigrationError(RuntimeError):
    """Startup must stop: a migration or backup could not complete."""


# -- v0.5.1 end state ------------------------------------------------------------------------------
BASE_TABLES = [
    "CREATE TABLE IF NOT EXISTS courses (class_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
    """CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, class_id TEXT NOT NULL, student_id TEXT NOT NULL,
        student_name TEXT NOT NULL, session_id TEXT NOT NULL, event_type TEXT NOT NULL, question_id TEXT,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_events_class_time ON events(class_id, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_events_student ON events(class_id, student_id, id DESC)",
    """CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY, class_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, unit_id TEXT NOT NULL,
        instructions TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL, questions_json TEXT NOT NULL,
        file_name TEXT, file_type TEXT, file_data BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_work_class ON assignments(class_id, status, created_at)",
    """CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, class_id TEXT NOT NULL, student_id TEXT NOT NULL,
        student_name TEXT NOT NULL, attempt INTEGER NOT NULL, answers_json TEXT NOT NULL, submitted_at TEXT NOT NULL,
        grade REAL, feedback TEXT, graded_at TEXT, FOREIGN KEY(assignment_id) REFERENCES assignments(id))""",
    "CREATE INDEX IF NOT EXISTS idx_submissions_work ON submissions(class_id, assignment_id, student_id, attempt)",
    """CREATE TABLE IF NOT EXISTS submission_requests (
        class_id TEXT NOT NULL, assignment_id TEXT NOT NULL, student_id TEXT NOT NULL, request_id TEXT NOT NULL,
        submission_id TEXT NOT NULL, PRIMARY KEY(class_id, assignment_id, student_id, request_id))""",
    """CREATE TABLE IF NOT EXISTS roster (
        class_id TEXT NOT NULL, student_id TEXT NOT NULL, student_name TEXT NOT NULL, PRIMARY KEY(class_id, student_id))""",
    """CREATE TABLE IF NOT EXISTS generation_policies (
        class_id TEXT NOT NULL, unit_id TEXT NOT NULL, config_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(class_id, unit_id))""",
    """CREATE TABLE IF NOT EXISTS chat_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, class_id TEXT NOT NULL, student_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        question_id TEXT NOT NULL, prompt TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_turns(class_id, student_id, thread_id, id DESC)",
    "CREATE TABLE IF NOT EXISTS kiwi_links (class_id TEXT PRIMARY KEY, name TEXT NOT NULL)",
    """CREATE TABLE IF NOT EXISTS kiwi_sync (
        class_id TEXT PRIMARY KEY, cursor TEXT, snapshot TEXT, checkpoint TEXT, last_synced TEXT, last_error TEXT,
        has_more INTEGER NOT NULL DEFAULT 0, metadata_truncated INTEGER NOT NULL DEFAULT 0)""",
    """CREATE TABLE IF NOT EXISTS kiwi_materials (
        class_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, document_ids TEXT NOT NULL,
        unit_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(class_id, id))""",
]
BASE_COLUMNS = [
    ("kiwi_sync", "projection_version", "TEXT NOT NULL DEFAULT ''"),
    ("events", "learning_session_id", "TEXT"),
    ("events", "source", "TEXT NOT NULL DEFAULT 'lab'"),
    ("events", "upstream_id", "TEXT"),
]
BASE_SESSIONS = [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_native_event ON events(class_id, source, upstream_id)",
    """CREATE TABLE IF NOT EXISTS learning_sessions (
        id TEXT PRIMARY KEY, classId TEXT NOT NULL, studentId TEXT NOT NULL, studentName TEXT NOT NULL,
        browserSession TEXT NOT NULL, contextKey TEXT NOT NULL, unitId TEXT NOT NULL, assignmentId TEXT NOT NULL,
        questionId TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, startedAt TEXT NOT NULL, lastActive TEXT NOT NULL,
        interactions INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, checked INTEGER NOT NULL DEFAULT 0,
        correct INTEGER NOT NULL DEFAULT 0, codeRuns INTEGER NOT NULL DEFAULT 0, codeErrors INTEGER NOT NULL DEFAULT 0,
        aiQuestions INTEGER NOT NULL DEFAULT 0)""",
    "CREATE INDEX IF NOT EXISTS idx_session_context ON learning_sessions(classId, studentId, browserSession, contextKey, lastActive DESC)",
    "CREATE INDEX IF NOT EXISTS idx_session_unit ON learning_sessions(classId, unitId, assignmentId, questionId)",
    "CREATE INDEX IF NOT EXISTS idx_session_student ON learning_sessions(classId, studentId, lastActive DESC)",
    "CREATE INDEX IF NOT EXISTS idx_event_session ON events(class_id, learning_session_id, id)",
]
BASE_SESSION_COLUMNS = [
    ("learning_sessions", "source", "TEXT NOT NULL DEFAULT 'lab'"),
    ("learning_sessions", "materialId", "TEXT NOT NULL DEFAULT ''"),
    ("learning_sessions", "codeSuccesses", "INTEGER NOT NULL DEFAULT 0"),
]
BASE_TAIL = [
    "CREATE INDEX IF NOT EXISTS idx_session_source_material ON learning_sessions(classId, source, materialId, lastActive)",
    "CREATE INDEX IF NOT EXISTS idx_session_event_time ON events(class_id, learning_session_id, created_at, id)",
    "CREATE TABLE IF NOT EXISTS telemetry_meta (version TEXT PRIMARY KEY)",
]


def add_column(db: sqlite3.Connection, table: str, column: str, declaration: str) -> bool:
    """Guarded ``ALTER TABLE … ADD COLUMN`` (skipped when the column exists). Returns True when added."""
    if column in dbmod.table_columns(db, table):
        return False
    db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
    return True


def recover_legacy_submissions(db: sqlite3.Connection) -> int:
    """v0.5.1 legacy recovery: per-question ``answer_submitted`` events for submissions without them (idempotent)."""
    legacy = db.execute("""SELECT s.* FROM submissions s WHERE NOT EXISTS
        (SELECT 1 FROM events e WHERE e.class_id=s.class_id AND e.event_type='answer_submitted'
         AND json_valid(e.payload_json) AND json_extract(e.payload_json,'$.submissionId')=s.id)""").fetchall()
    created = 0
    for submission in legacy:
        opened = db.execute(
            "SELECT session_id FROM events WHERE class_id=? AND student_id=? AND event_type='work_submitted' "
            "AND json_valid(payload_json) AND json_extract(payload_json,'$.submissionId')=? ORDER BY id LIMIT 1",
            (submission["class_id"], submission["student_id"], submission["id"]),
        ).fetchone()
        browser = opened[0] if opened else "legacy-" + submission["id"]
        try:
            answers = json.loads(submission["answers_json"])
        except json.JSONDecodeError:
            continue
        if not isinstance(answers, dict):
            continue
        for question_id, answer in answers.items():
            payload = {"assignmentId": submission["assignment_id"], "submissionId": submission["id"], "answer": answer,
                       "attempt": submission["attempt"], "recoveredFromSubmission": True}
            db.execute(
                "INSERT INTO events (class_id,student_id,student_name,session_id,event_type,question_id,payload_json,created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (submission["class_id"], submission["student_id"], submission["student_name"], browser,
                 "answer_submitted", question_id, json.dumps(payload), submission["submitted_at"]),
            )
            created += 1
    return created


def base_schema(db: sqlite3.Connection) -> None:
    """Reproduce the exact v0.5.1 end state on any database, then run the v0.5.1 legacy submission recovery."""
    with dbmod.write_tx(db):
        for statement in BASE_TABLES:
            db.execute(statement)
        for table, column, declaration in BASE_COLUMNS:
            add_column(db, table, column, declaration)
        for statement in BASE_SESSIONS:
            db.execute(statement)
        for table, column, declaration in BASE_SESSION_COLUMNS:
            add_column(db, table, column, declaration)
        for statement in BASE_TAIL:
            db.execute(statement)
        recover_legacy_submissions(db)


# -- 0.6.0-001-columns -----------------------------------------------------------------------------
NEW_COLUMNS: list[tuple[str, str, str]] = [
    ("events", "event_id", "TEXT"), ("events", "schema_version", "INTEGER NOT NULL DEFAULT 1"),
    ("events", "received_at", "TEXT"), ("events", "client_ts_ms", "INTEGER"), ("events", "client_seq", "INTEGER"),
    ("events", "tz_offset_min", "INTEGER"), ("events", "surface", "TEXT NOT NULL DEFAULT ''"),
    ("events", "actor_role", "TEXT NOT NULL DEFAULT 'unknown'"), ("events", "is_preview", "INTEGER NOT NULL DEFAULT 0"),
    ("events", "identity_verified", "INTEGER NOT NULL DEFAULT 0"), ("events", "practice_mode", "TEXT NOT NULL DEFAULT ''"),
    ("events", "attribution_assignment_id", "TEXT NOT NULL DEFAULT ''"),
    ("events", "related_assignment_id", "TEXT NOT NULL DEFAULT ''"), ("events", "item_id", "TEXT NOT NULL DEFAULT ''"),
    ("events", "checked_by", "TEXT NOT NULL DEFAULT ''"), ("events", "rejudged_correct", "INTEGER"),
    ("events", "section_group_id", "TEXT NOT NULL DEFAULT ''"), ("events", "condition_group_id", "TEXT NOT NULL DEFAULT ''"),
    ("events", "assignment_version", "INTEGER"), ("events", "policy_version_id", "INTEGER"),
    ("events", "ai_call_id", "INTEGER"), ("events", "chat_turn_id", "INTEGER"), ("events", "heartbeat_bucket", "INTEGER"),
    ("events", "heartbeat_counted", "INTEGER NOT NULL DEFAULT 0"), ("events", "truncated_json", "TEXT NOT NULL DEFAULT ''"),
    ("events", "category", "TEXT NOT NULL DEFAULT ''"),
    ("learning_sessions", "practiceMode", "TEXT NOT NULL DEFAULT ''"), ("learning_sessions", "origin", "TEXT NOT NULL DEFAULT ''"),
    ("learning_sessions", "relatedAssignmentId", "TEXT NOT NULL DEFAULT ''"),
    ("learning_sessions", "itemId", "TEXT NOT NULL DEFAULT ''"), ("learning_sessions", "threadId", "TEXT NOT NULL DEFAULT ''"),
    ("learning_sessions", "actorRole", "TEXT NOT NULL DEFAULT 'unknown'"),
    ("learning_sessions", "isPreview", "INTEGER NOT NULL DEFAULT 0"), ("learning_sessions", "actions", "INTEGER NOT NULL DEFAULT 0"),
    ("learning_sessions", "telemetryEvents", "INTEGER NOT NULL DEFAULT 0"),
    ("learning_sessions", "clientChecked", "INTEGER NOT NULL DEFAULT 0"),
    ("learning_sessions", "clientCorrect", "INTEGER NOT NULL DEFAULT 0"),
    ("learning_sessions", "activeSeconds", "INTEGER NOT NULL DEFAULT 0"),
    ("learning_sessions", "questionType", "TEXT NOT NULL DEFAULT ''"), ("learning_sessions", "difficulty", "INTEGER"),
    ("learning_sessions", "policyVersionId", "INTEGER"),
    ("assignments", "open_at", "TEXT"), ("assignments", "close_at", "TEXT"),
    ("assignments", "late_policy_json", "TEXT NOT NULL DEFAULT '{\"mode\":\"accept_marked\",\"graceMinutes\":0,\"penaltyPctPerDay\":0}'"),
    ("assignments", "max_attempts", "INTEGER"), ("assignments", "grades_visibility", "TEXT NOT NULL DEFAULT 'immediately'"),
    ("assignments", "solutions_visibility", "TEXT NOT NULL DEFAULT 'never'"), ("assignments", "time_limit_json", "TEXT"),
    ("assignments", "tool_policy_json", "TEXT NOT NULL DEFAULT '{}'"),
    ("assignments", "audience_json", "TEXT NOT NULL DEFAULT '{\"type\":\"all\"}'"), ("assignments", "archived_at", "TEXT"),
    ("assignments", "deleted_at", "TEXT"), ("assignments", "revision_of", "TEXT"), ("assignments", "question_id_map_json", "TEXT"),
    ("assignments", "retire_original_on_publish", "INTEGER NOT NULL DEFAULT 0"),
    ("assignments", "version", "INTEGER NOT NULL DEFAULT 1"), ("assignments", "frozen_at", "TEXT"),
    ("assignments", "created_by", "TEXT NOT NULL DEFAULT ''"), ("assignments", "updated_by", "TEXT NOT NULL DEFAULT ''"),
    ("assignments", "starter_key", "TEXT"),
    ("submissions", "assignment_version", "INTEGER"), ("submissions", "is_late", "INTEGER NOT NULL DEFAULT 0"),
    ("submissions", "late_seconds", "INTEGER NOT NULL DEFAULT 0"), ("submissions", "actor_role", "TEXT NOT NULL DEFAULT 'unknown'"),
    ("submissions", "is_preview", "INTEGER NOT NULL DEFAULT 0"), ("submissions", "identity_verified", "INTEGER NOT NULL DEFAULT 0"),
    ("submissions", "grade_status", "TEXT NOT NULL DEFAULT 'ungraded'"), ("submissions", "released_at", "TEXT"),
    ("submissions", "graded_by", "TEXT"), ("submissions", "graded_by_role", "TEXT"),
    ("submissions", "adjustment_points", "REAL NOT NULL DEFAULT 0"), ("submissions", "adjustment_reason", "TEXT NOT NULL DEFAULT ''"),
    ("submissions", "autocheck_json", "TEXT NOT NULL DEFAULT '{}'"), ("submissions", "attempt_started_at", "TEXT"),
    ("submissions", "time_used_seconds", "INTEGER"), ("submissions", "over_time", "INTEGER NOT NULL DEFAULT 0"),
    ("submissions", "section_group_id", "TEXT NOT NULL DEFAULT ''"), ("submissions", "condition_group_id", "TEXT NOT NULL DEFAULT ''"),
    ("roster", "display_name", "TEXT NOT NULL DEFAULT ''"), ("roster", "kiwi_email", "TEXT NOT NULL DEFAULT ''"),
    ("roster", "source", "TEXT NOT NULL DEFAULT 'import'"), ("roster", "status", "TEXT NOT NULL DEFAULT 'active'"),
    ("roster", "kiwi_role", "TEXT NOT NULL DEFAULT ''"), ("roster", "kiwi_consent", "INTEGER"),
    ("roster", "consent_override", "TEXT"), ("roster", "consent_note", "TEXT NOT NULL DEFAULT ''"),
    ("roster", "consent_updated_by", "TEXT"), ("roster", "consent_updated_at", "TEXT"),
    ("roster", "excluded", "INTEGER NOT NULL DEFAULT 0"), ("roster", "exclusion_reason", "TEXT NOT NULL DEFAULT ''"),
    ("roster", "pseudonym_seq", "INTEGER"), ("roster", "created_at", "TEXT"), ("roster", "updated_at", "TEXT"),
    ("roster", "last_import_at", "TEXT"),
    ("chat_turns", "unit_id", "TEXT NOT NULL DEFAULT ''"), ("chat_turns", "assignment_id", "TEXT NOT NULL DEFAULT ''"),
    ("chat_turns", "item_id", "TEXT NOT NULL DEFAULT ''"), ("chat_turns", "surface", "TEXT NOT NULL DEFAULT 'legacy'"),
    ("chat_turns", "context_json", "TEXT NOT NULL DEFAULT '{}'"), ("chat_turns", "ai_call_id", "INTEGER"),
    ("chat_turns", "policy_version_id", "INTEGER"), ("chat_turns", "model", "TEXT"),
    ("chat_turns", "source", "TEXT NOT NULL DEFAULT 'lab-ai'"), ("chat_turns", "guard_status", "TEXT NOT NULL DEFAULT 'not_applicable'"),
    ("chat_turns", "flagged", "INTEGER NOT NULL DEFAULT 0"), ("chat_turns", "flag_reason", "TEXT NOT NULL DEFAULT ''"),
    ("chat_turns", "flag_source", "TEXT NOT NULL DEFAULT ''"), ("chat_turns", "flag_updated_by", "TEXT"),
    ("chat_turns", "flag_updated_at", "TEXT"), ("chat_turns", "actor_role", "TEXT NOT NULL DEFAULT 'unknown'"),
    ("chat_turns", "is_preview", "INTEGER NOT NULL DEFAULT 0"), ("chat_turns", "identity_verified", "INTEGER NOT NULL DEFAULT 0"),
    ("chat_turns", "section_group_id", "TEXT NOT NULL DEFAULT ''"), ("chat_turns", "condition_group_id", "TEXT NOT NULL DEFAULT ''"),
    ("kiwi_sync", "excluded_by_design", "INTEGER NOT NULL DEFAULT 0"),
    ("kiwi_sync", "excluded_not_enrolled", "INTEGER NOT NULL DEFAULT 0"),
]


def m001_columns(db: sqlite3.Connection) -> None:
    for table, column, declaration in NEW_COLUMNS:
        add_column(db, table, column, declaration)


# -- 0.6.0-002-tables ------------------------------------------------------------------------------
NEW_TABLES: list[str] = [
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS server_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL)",
    """CREATE TABLE IF NOT EXISTS course_settings (
        class_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT '')""",
    """CREATE TABLE IF NOT EXISTS staff (
        id TEXT PRIMARY KEY, class_id TEXT NOT NULL, display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('instructor','ta','viewer','researcher')), kiwi_user_id TEXT, key_hash TEXT, key_prefix TEXT,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)""",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_kiwi ON staff(class_id, kiwi_user_id) WHERE kiwi_user_id IS NOT NULL AND revoked_at IS NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_prefix ON staff(class_id, key_prefix) WHERE key_prefix IS NOT NULL AND revoked_at IS NULL",
    """CREATE TABLE IF NOT EXISTS kiwi_staff_seen (
        class_id TEXT NOT NULL, kiwi_user_id TEXT NOT NULL, username TEXT NOT NULL, kiwi_role TEXT NOT NULL,
        can_manage_course INTEGER NOT NULL, can_view_analytics INTEGER NOT NULL, first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, PRIMARY KEY (class_id, kiwi_user_id))""",
    """CREATE TABLE IF NOT EXISTS course_groups (
        id TEXT PRIMARY KEY, class_id TEXT NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('section','condition','cohort')), description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, archived_at TEXT)""",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name ON course_groups(class_id, kind, name) WHERE archived_at IS NULL",
    """CREATE TABLE IF NOT EXISTS group_members (
        class_id TEXT NOT NULL, group_id TEXT NOT NULL, student_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('section','condition','cohort')),
        method TEXT NOT NULL CHECK (method IN ('manual','import','random','selection')),
        seed TEXT, assigned_by TEXT NOT NULL, assigned_at TEXT NOT NULL, PRIMARY KEY (class_id, group_id, student_id))""",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_one ON group_members(class_id, student_id, kind) WHERE kind IN ('section','condition')",
    "CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(class_id, group_id)",
    """CREATE TABLE IF NOT EXISTS group_membership_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, class_id TEXT NOT NULL, student_id TEXT NOT NULL, kind TEXT NOT NULL,
        group_id TEXT NOT NULL, method TEXT NOT NULL, seed TEXT, assigned_by TEXT NOT NULL, valid_from TEXT NOT NULL,
        valid_to TEXT)""",
    "CREATE INDEX IF NOT EXISTS idx_gmh ON group_membership_history(class_id, student_id, kind, valid_from)",
    """CREATE TRIGGER IF NOT EXISTS trg_gm_insert AFTER INSERT ON group_members BEGIN
        UPDATE group_membership_history SET valid_to = NEW.assigned_at
          WHERE class_id = NEW.class_id AND student_id = NEW.student_id AND valid_to IS NULL
            AND ((NEW.kind != 'cohort' AND kind = NEW.kind) OR (NEW.kind = 'cohort' AND group_id = NEW.group_id));
        INSERT INTO group_membership_history (class_id, student_id, kind, group_id, method, seed, assigned_by, valid_from)
          VALUES (NEW.class_id, NEW.student_id, NEW.kind, NEW.group_id, NEW.method, NEW.seed, NEW.assigned_by, NEW.assigned_at);
    END""",
    """CREATE TRIGGER IF NOT EXISTS trg_gm_update AFTER UPDATE ON group_members BEGIN
        UPDATE group_membership_history SET valid_to = NEW.assigned_at
          WHERE class_id = OLD.class_id AND student_id = OLD.student_id AND group_id = OLD.group_id AND valid_to IS NULL;
        INSERT INTO group_membership_history (class_id, student_id, kind, group_id, method, seed, assigned_by, valid_from)
          VALUES (NEW.class_id, NEW.student_id, NEW.kind, NEW.group_id, NEW.method, NEW.seed, NEW.assigned_by, NEW.assigned_at);
    END""",
    """CREATE TRIGGER IF NOT EXISTS trg_gm_delete AFTER DELETE ON group_members BEGIN
        UPDATE group_membership_history SET valid_to = strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')
          WHERE class_id = OLD.class_id AND student_id = OLD.student_id AND group_id = OLD.group_id AND valid_to IS NULL;
    END""",
    """CREATE TABLE IF NOT EXISTS policy_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, class_id TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('course','unit')),
        unit_id TEXT NOT NULL DEFAULT '', group_id TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL,
        config_json TEXT NOT NULL, config_hash TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', restored_from INTEGER,
        created_by TEXT NOT NULL, created_by_role TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (class_id, scope, unit_id, group_id, version))""",
    "CREATE INDEX IF NOT EXISTS idx_policy_head ON policy_versions(class_id, scope, unit_id, group_id, version DESC)",
    """CREATE TABLE IF NOT EXISTS ai_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, class_id TEXT NOT NULL, student_id TEXT NOT NULL,
        actor_role TEXT NOT NULL, is_preview INTEGER NOT NULL DEFAULT 0, identity_verified INTEGER NOT NULL DEFAULT 0,
        action TEXT NOT NULL CHECK (action IN ('chat','question','similar','feedback','test_chat','test_question','test_feedback')),
        surface TEXT NOT NULL DEFAULT '', unit_id TEXT NOT NULL DEFAULT '', assignment_id TEXT NOT NULL DEFAULT '',
        question_id TEXT NOT NULL DEFAULT '', item_id TEXT NOT NULL DEFAULT '', thread_id TEXT NOT NULL DEFAULT '',
        group_id TEXT NOT NULL DEFAULT '', section_group_id TEXT NOT NULL DEFAULT '', condition_group_id TEXT NOT NULL DEFAULT '',
        policy_version_id INTEGER, policy_source TEXT NOT NULL DEFAULT 'platform', platform_rules_version TEXT NOT NULL,
        model TEXT, reasoning_effort TEXT, max_output_tokens INTEGER, history_turns INTEGER,
        prompt_hash TEXT NOT NULL DEFAULT '', developer_text TEXT NOT NULL DEFAULT '', context_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL, error_code TEXT NOT NULL DEFAULT '', error_message TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 1, parent_call_id INTEGER, openai_response_id TEXT, input_tokens INTEGER,
        output_tokens INTEGER, reasoning_tokens INTEGER, queue_ms INTEGER, latency_ms INTEGER, requested_at TEXT NOT NULL,
        responded_at TEXT, raw_output TEXT NOT NULL DEFAULT '', output_truncated INTEGER NOT NULL DEFAULT 0,
        guard_status TEXT NOT NULL DEFAULT 'not_applicable', guard_matches_json TEXT NOT NULL DEFAULT '[]',
        homework_match_assignment_id TEXT NOT NULL DEFAULT '', homework_match_question_id TEXT NOT NULL DEFAULT '',
        homework_match_score REAL, homework_match_jaccard REAL)""",
    "CREATE INDEX IF NOT EXISTS idx_ai_calls_class_time ON ai_calls(class_id, requested_at)",
    "CREATE INDEX IF NOT EXISTS idx_ai_calls_status ON ai_calls(class_id, status, requested_at)",
    """CREATE TABLE IF NOT EXISTS generated_items (
        id TEXT PRIMARY KEY, class_id TEXT NOT NULL, student_id TEXT NOT NULL, actor_role TEXT NOT NULL,
        is_preview INTEGER NOT NULL DEFAULT 0, identity_verified INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL CHECK (origin IN ('free','similar','teacher_test')), unit_id TEXT NOT NULL,
        related_assignment_id TEXT NOT NULL DEFAULT '', related_question_id TEXT NOT NULL DEFAULT '',
        question_type TEXT NOT NULL, difficulty INTEGER NOT NULL, requested_type TEXT NOT NULL,
        requested_difficulty INTEGER NOT NULL, focus_note TEXT NOT NULL DEFAULT '', item_json TEXT NOT NULL,
        choice_order_json TEXT NOT NULL DEFAULT '[]', shuffle_seed INTEGER,
        source TEXT NOT NULL CHECK (source IN ('ai','local_template','teacher_bank')), ai_call_id INTEGER,
        policy_version_id INTEGER, model TEXT, novelty_retries INTEGER NOT NULL DEFAULT 0,
        guard_status TEXT NOT NULL DEFAULT 'not_applicable', homework_match_assignment_id TEXT NOT NULL DEFAULT '',
        homework_match_question_id TEXT NOT NULL DEFAULT '', homework_match_score REAL,
        verification TEXT NOT NULL DEFAULT 'unverified', client_run_output TEXT NOT NULL DEFAULT '', verified_at TEXT,
        section_group_id TEXT NOT NULL DEFAULT '', condition_group_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','flagged','retired','rejected_invalid','rejected_leak','rejected_not_novel')),
        flag_note TEXT NOT NULL DEFAULT '', flagged_by TEXT, flagged_at TEXT, retired_by TEXT, retired_at TEXT,
        created_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_items_student ON generated_items(class_id, student_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_items_review ON generated_items(class_id, origin, unit_id, status, created_at)",
    """CREATE TABLE IF NOT EXISTS assignment_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id TEXT NOT NULL, class_id TEXT NOT NULL, version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL, questions_hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        reason TEXT NOT NULL, UNIQUE (assignment_id, version))""",
    """CREATE TABLE IF NOT EXISTS course_files (
        id TEXT PRIMARY KEY, class_id TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('assignment','chapter')),
        assignment_id TEXT NOT NULL DEFAULT '', question_id TEXT NOT NULL DEFAULT '', unit_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL,
        mount_in_r INTEGER NOT NULL DEFAULT 1, ai_reference INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, deleted_at TEXT)""",
    "CREATE INDEX IF NOT EXISTS idx_files_owner ON course_files(class_id, scope, assignment_id, unit_id) WHERE deleted_at IS NULL",
    """CREATE TABLE IF NOT EXISTS submission_item_scores (
        submission_id TEXT NOT NULL, question_id TEXT NOT NULL, class_id TEXT NOT NULL, auto_correct INTEGER,
        auto_score REAL, auto_reason TEXT NOT NULL DEFAULT '', score REAL, comment TEXT NOT NULL DEFAULT '',
        overridden INTEGER NOT NULL DEFAULT 0, graded_by TEXT, graded_at TEXT, PRIMARY KEY (submission_id, question_id))""",
    """CREATE TABLE IF NOT EXISTS grade_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL, class_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        actor_role TEXT NOT NULL, actor_label TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL CHECK (action IN ('autocheck','save_draft','release','unrelease','bulk_release','legacy_grade','migrated','adjust')),
        total_before REAL, total_after REAL, items_before_json TEXT NOT NULL DEFAULT '{}', items_after_json TEXT NOT NULL DEFAULT '{}',
        feedback_before TEXT, feedback_after TEXT, status_before TEXT, status_after TEXT, created_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_grade_events_sub ON grade_events(submission_id, id)",
    """CREATE TABLE IF NOT EXISTS answer_drafts (
        class_id TEXT NOT NULL, student_id TEXT NOT NULL, assignment_id TEXT NOT NULL, question_id TEXT NOT NULL,
        value TEXT NOT NULL, value_length INTEGER NOT NULL, assignment_version INTEGER, is_preview INTEGER NOT NULL DEFAULT 0,
        client_ts_ms INTEGER, updated_at TEXT NOT NULL, section_group_id TEXT NOT NULL DEFAULT '',
        condition_group_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (class_id, student_id, assignment_id, question_id))""",
    """CREATE TABLE IF NOT EXISTS attempt_starts (
        class_id TEXT NOT NULL, assignment_id TEXT NOT NULL, student_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        started_at TEXT NOT NULL, assignment_version INTEGER, is_preview INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (class_id, assignment_id, student_id, attempt))""",
    """CREATE TABLE IF NOT EXISTS learning_session_aliases (
        old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, class_id TEXT NOT NULL, created_at TEXT NOT NULL)""",
    "CREATE TABLE IF NOT EXISTS learning_session_v2_map (event_id INTEGER PRIMARY KEY, old_session_id TEXT NOT NULL)",
    """CREATE TABLE IF NOT EXISTS student_tombstones (
        class_id TEXT NOT NULL, student_hash TEXT NOT NULL, anon_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('anonymize','delete')), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (class_id, student_hash))""",
    """CREATE TABLE IF NOT EXISTS service_incidents (
        class_id TEXT NOT NULL, minute TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('server_error','kiwi_unreachable')),
        count INTEGER NOT NULL, PRIMARY KEY (class_id, minute, kind))""",
    """CREATE TABLE IF NOT EXISTS ai_test_samples (
        id TEXT PRIMARY KEY, class_id TEXT NOT NULL, unit_id TEXT NOT NULL DEFAULT '', group_id TEXT NOT NULL DEFAULT '',
        label TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('chat','question')), sample_json TEXT NOT NULL,
        expect_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT)""",
    """CREATE TABLE IF NOT EXISTS event_rejections (
        id INTEGER PRIMARY KEY AUTOINCREMENT, class_id TEXT NOT NULL, student_id TEXT NOT NULL DEFAULT '',
        client_event_id TEXT NOT NULL DEFAULT '', event_type TEXT NOT NULL DEFAULT '', code TEXT NOT NULL,
        message TEXT NOT NULL, received_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_event_rejections ON event_rejections(class_id, received_at)",
    """CREATE TABLE IF NOT EXISTS event_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, payload_json_before TEXT NOT NULL,
        event_type_before TEXT NOT NULL, reason TEXT NOT NULL, changed_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS material_unit_map (
        class_id TEXT NOT NULL, material_id TEXT NOT NULL, unit_id TEXT NOT NULL, valid_from TEXT NOT NULL,
        changed_by TEXT NOT NULL, PRIMARY KEY (class_id, material_id, valid_from))""",
    """CREATE TABLE IF NOT EXISTS ai_responses (
        class_id TEXT NOT NULL, upstream_action_id TEXT NOT NULL, upstream_interaction_id TEXT NOT NULL, event_id INTEGER,
        action_type TEXT NOT NULL, engine_choice TEXT, bot_response TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
        responded_at TEXT NOT NULL, imported_at TEXT NOT NULL, PRIMARY KEY (class_id, upstream_action_id))""",
    """CREATE TABLE IF NOT EXISTS kiwi_user_sync (
        class_id TEXT NOT NULL, student_id TEXT NOT NULL, first_seen_at TEXT NOT NULL, backfill_cursor TEXT,
        backfilled_at TEXT, last_imported_at TEXT, PRIMARY KEY (class_id, student_id))""",
    """CREATE TABLE IF NOT EXISTS reteach_marks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, class_id TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('question','item_group','ai_prompt','topic')),
        assignment_id TEXT NOT NULL DEFAULT '', question_id TEXT NOT NULL DEFAULT '', unit_id TEXT NOT NULL DEFAULT '',
        chat_turn_id INTEGER, label TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, resolved_at TEXT)""",
    """CREATE TABLE IF NOT EXISTS codebook_codes (
        id TEXT PRIMARY KEY, class_id TEXT NOT NULL, label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT 'neutral', created_by TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT)""",
    """CREATE TABLE IF NOT EXISTS conversation_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, class_id TEXT NOT NULL, thread_key TEXT NOT NULL, chat_turn_id INTEGER,
        native_event_id INTEGER, code_id TEXT NOT NULL, coder_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, deleted_at TEXT)""",
    "CREATE INDEX IF NOT EXISTS idx_conversation_codes ON conversation_codes(class_id, thread_key)",
    """CREATE TABLE IF NOT EXISTS teacher_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, class_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL,
        actor_role TEXT NOT NULL, actor_label TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, target_type TEXT NOT NULL,
        target_id TEXT NOT NULL DEFAULT '', before_json TEXT NOT NULL DEFAULT '', after_json TEXT NOT NULL DEFAULT '',
        request_id TEXT NOT NULL, created_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_teacher_actions ON teacher_actions(class_id, created_at)",
    """CREATE TABLE IF NOT EXISTS data_access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, class_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL,
        actor_role TEXT NOT NULL, actor_label TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, endpoint TEXT NOT NULL,
        params_json TEXT NOT NULL, row_count INTEGER, purpose TEXT NOT NULL DEFAULT '', request_id TEXT NOT NULL,
        created_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_data_access ON data_access_log(class_id, created_at)",
]
NEW_INDEXES: list[str] = [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_id ON events(class_id, event_id) WHERE event_id IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_events_class_created ON events(class_id, created_at, id)",
    "CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(class_id, event_type, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_events_attribution ON events(class_id, attribution_assignment_id, question_id)",
    "CREATE INDEX IF NOT EXISTS idx_events_related ON events(class_id, related_assignment_id) WHERE related_assignment_id != ''",
    "CREATE INDEX IF NOT EXISTS idx_events_item ON events(class_id, item_id) WHERE item_id != ''",
    "CREATE INDEX IF NOT EXISTS idx_events_heartbeat ON events(class_id, student_id, heartbeat_bucket) WHERE event_type = 'study_heartbeat'",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_heartbeat_counted ON events(class_id, student_id, heartbeat_bucket) WHERE heartbeat_counted = 1",
    "CREATE INDEX IF NOT EXISTS idx_events_student_time ON events(class_id, student_id, created_at, id)",
    "CREATE INDEX IF NOT EXISTS idx_events_condition ON events(class_id, condition_group_id) WHERE condition_group_id != ''",
    "CREATE INDEX IF NOT EXISTS idx_session_mode ON learning_sessions(classId, practiceMode, assignmentId, questionId)",
    "CREATE INDEX IF NOT EXISTS idx_session_related ON learning_sessions(classId, relatedAssignmentId) WHERE relatedAssignmentId != ''",
    "CREATE INDEX IF NOT EXISTS idx_session_context_v3 ON learning_sessions(classId, studentId, contextKey, lastActive DESC)",
    "CREATE INDEX IF NOT EXISTS idx_item_scores_question ON submission_item_scores(class_id, question_id)",
    "CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(class_id, assignment_id, grade_status)",
    "CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(class_id, student_id, assignment_id, attempt DESC)",
    "CREATE INDEX IF NOT EXISTS idx_chat_class_time ON chat_turns(class_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_chat_assignment ON chat_turns(class_id, assignment_id, question_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_pseudonym ON roster(class_id, pseudonym_seq) WHERE pseudonym_seq IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_assignments_live ON assignments(class_id, status, archived_at, deleted_at)",
]


def m002_tables(db: sqlite3.Connection) -> None:
    for statement in NEW_TABLES + NEW_INDEXES:
        db.execute(statement)


# -- backfills (§4.3) --------------------------------------------------------------------------------
def linked_class_ids(db: sqlite3.Connection) -> list[str]:
    from server import identity

    ids = set(identity.configured_linked_ids())
    ids |= {row[0] for row in db.execute("SELECT class_id FROM kiwi_links")}
    return sorted(ids)


def _in_clause(values: list[str]) -> tuple[str, list[str]]:
    return ("(" + ",".join("?" for _ in values) + ")", list(values)) if values else ("(NULL)", [])


def b1_policies(db: sqlite3.Connection) -> None:
    from server import ai_policy

    for row in db.execute("SELECT * FROM generation_policies ORDER BY class_id, unit_id").fetchall():
        try:
            stored = json.loads(row["config_json"])
        except json.JSONDecodeError:
            stored = {}
        config = ai_policy.config_from_legacy(stored if isinstance(stored, dict) else {})
        db.execute(
            """INSERT INTO policy_versions (class_id, scope, unit_id, group_id, version, config_json, config_hash, note,
            restored_from, created_by, created_by_role, created_at) VALUES (?, 'unit', ?, '', 1, ?, ?, ?, NULL, 'migration',
            'system', ?) ON CONFLICT(class_id, scope, unit_id, group_id, version) DO NOTHING""",
            (row["class_id"], row["unit_id"], dbmod.json_dumps(config), ai_policy.config_hash(config),
             "Migrated from v0.5 chapter policy", row["updated_at"]),
        )


def stamp_provenance(db: sqlite3.Connection, table: str) -> None:
    """B5 rule for ``identity_verified`` and informational ``actor_role`` on legacy rows."""
    linked_sql, params = _in_clause(linked_class_ids(db))
    verified = (f"CASE WHEN source = 'kiwi' OR class_id IN {linked_sql} THEN 1 ELSE 0 END" if table == "events"
                else f"CASE WHEN class_id IN {linked_sql} THEN 1 ELSE 0 END")
    role = (f"""CASE WHEN class_id IN {linked_sql} THEN
            CASE WHEN EXISTS (SELECT 1 FROM roster r WHERE r.class_id = {table}.class_id AND r.student_id = {table}.student_id
                              AND r.source IN ('kiwi','import'))
                   OR EXISTS (SELECT 1 FROM events n WHERE n.class_id = {table}.class_id AND n.student_id = {table}.student_id
                              AND n.source = 'kiwi')
                 THEN 'student' ELSE 'unknown' END
          WHEN student_id LIKE 'demo-%' THEN 'demo' ELSE 'unknown' END""")
    db.execute(f"UPDATE {table} SET identity_verified = {verified}, actor_role = {role}", params + params)


def b2_submissions(db: sqlite3.Connection) -> None:
    late = ("SELECT CASE WHEN a.due_at IS NOT NULL AND a.due_at != '' AND julianday(submissions.submitted_at) > "
            "julianday(a.due_at) THEN {value} ELSE 0 END FROM assignments a WHERE a.id = submissions.assignment_id")
    db.execute(f"""UPDATE submissions SET
        grade_status = CASE WHEN grade IS NOT NULL THEN 'released' ELSE 'ungraded' END,
        released_at = graded_at,
        graded_by = CASE WHEN grade IS NOT NULL THEN 'pre-0.6' ELSE graded_by END,
        is_late = COALESCE(({late.format(value='1')}), 0),
        late_seconds = COALESCE(({late.format(value="CAST(ROUND((julianday(submissions.submitted_at) - julianday(a.due_at)) * 86400) AS INTEGER)")}), 0)""")
    stamp_provenance(db, "submissions")
    db.execute(
        """INSERT INTO grade_events (submission_id, class_id, actor_id, actor_role, actor_label, action, total_before,
        total_after, items_before_json, items_after_json, feedback_before, feedback_after, status_before, status_after,
        created_at)
        SELECT id, class_id, 'pre-0.6', 'system', 'Imported from v0.5', 'migrated', NULL, grade, '{}', '{}', NULL, feedback,
        NULL, 'released', COALESCE(graded_at, submitted_at) FROM submissions s WHERE grade IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM grade_events g WHERE g.submission_id = s.id AND g.action = 'migrated')""")


LEGACY_HOMEWORK_TOOLS = {"rWorkspace": True, "allowRunPredict": True, "askKiwi": "hints_only", "similarPractice": True}
LEGACY_PRACTICE_TOOLS = {"rWorkspace": True, "allowRunPredict": True, "askKiwi": "explain_concepts", "similarPractice": True}
DEFAULT_LATE_POLICY = '{"mode":"accept_marked","graceMinutes":0,"penaltyPctPerDay":0}'


def b3_assignments(db: sqlite3.Connection) -> None:
    from server import readers

    db.execute("UPDATE assignments SET tool_policy_json = CASE WHEN kind = 'homework' THEN ? ELSE ? END, "
               "grades_visibility = 'immediately', late_policy_json = ?",
               (dbmod.json_dumps(LEGACY_HOMEWORK_TOOLS), dbmod.json_dumps(LEGACY_PRACTICE_TOOLS), DEFAULT_LATE_POLICY))
    db.execute("""UPDATE assignments SET frozen_at = (SELECT MIN(t) FROM (
            SELECT MIN(s.submitted_at) AS t FROM submissions s
              WHERE s.class_id = assignments.class_id AND s.assignment_id = assignments.id
            UNION ALL
            SELECT MIN(e.created_at) AS t FROM events e
              WHERE e.class_id = assignments.class_id AND e.event_type = 'answer_submitted' AND assignments.kind = 'practice'
              AND json_valid(e.payload_json) AND json_extract(e.payload_json, '$.assignmentId') = assignments.id))
        WHERE frozen_at IS NULL""")
    for row in db.execute("SELECT * FROM assignments WHERE status = 'published' ORDER BY created_at, id").fetchall():
        snapshot = readers.assignment_snapshot(row)
        db.execute(
            """INSERT INTO assignment_versions (assignment_id, class_id, version, snapshot_json, questions_hash, created_by,
            created_at, reason) VALUES (?, ?, 1, ?, ?, 'migration', ?, 'migration')
            ON CONFLICT(assignment_id, version) DO NOTHING""",
            (row["id"], row["class_id"], dbmod.json_dumps(snapshot), readers.questions_hash(snapshot["questions"]),
             row["updated_at"]),
        )


def _latest_name(db: sqlite3.Connection, class_id: str, student_id: str, *, email: bool) -> str:
    condition = "instr(student_name, '@') > 0" if email else "instr(student_name, '@') = 0 AND student_name != ''"
    row = db.execute(
        f"SELECT student_name FROM events WHERE class_id=? AND student_id=? AND {condition} ORDER BY created_at DESC, id DESC LIMIT 1",
        (class_id, student_id)).fetchone()
    if row is None:
        row = db.execute(
            f"SELECT student_name FROM submissions WHERE class_id=? AND student_id=? AND {condition} ORDER BY submitted_at DESC LIMIT 1",
            (class_id, student_id)).fetchone()
    value = row[0] if row else ""
    return "" if not email and value == student_id else value


def b4_roster(db: sqlite3.Connection) -> None:
    from server import identity

    linked = set(linked_class_ids(db))
    stamp = dbmod.now()
    native = {(r[0], r[1]) for r in db.execute("SELECT DISTINCT class_id, student_id FROM events WHERE source = 'kiwi'")}
    for row in db.execute("SELECT rowid, * FROM roster ORDER BY class_id, rowid").fetchall():
        class_id, student_id, name = row["class_id"], row["student_id"], row["student_name"] or ""
        if class_id in linked and ((class_id, student_id) in native or UUID_PATTERN.fullmatch(student_id) or "@" in name):
            source = "kiwi"
        else:
            source = "import"
        kiwi_email = name if "@" in name else _latest_name(db, class_id, student_id, email=True)
        display = name if "@" not in name else ""
        db.execute("UPDATE roster SET source=?, kiwi_email=?, display_name=?, created_at=?, updated_at=? WHERE rowid=?",
                   (source, kiwi_email, display, stamp, stamp, row["rowid"]))
    for class_id in [r[0] for r in db.execute("SELECT DISTINCT class_id FROM roster").fetchall()]:
        seq = db.execute("SELECT COALESCE(MAX(pseudonym_seq), 0) FROM roster WHERE class_id=?", (class_id,)).fetchone()[0]
        for row in db.execute("SELECT rowid FROM roster WHERE class_id=? AND pseudonym_seq IS NULL ORDER BY rowid",
                              (class_id,)).fetchall():
            seq += 1
            db.execute("UPDATE roster SET pseudonym_seq=? WHERE rowid=?", (seq, row["rowid"]))
    missing = db.execute("""SELECT class_id, student_id, MIN(t) AS first_at FROM (
            SELECT class_id, student_id, created_at AS t FROM events
            UNION ALL SELECT class_id, student_id, submitted_at FROM submissions
            UNION ALL SELECT class_id, student_id, created_at FROM chat_turns) a
        WHERE student_id NOT LIKE 'preview-%' AND student_id != 'instructor'
          AND NOT EXISTS (SELECT 1 FROM roster r WHERE r.class_id = a.class_id AND r.student_id = a.student_id)
        GROUP BY class_id, student_id ORDER BY class_id, first_at, student_id""").fetchall()
    for row in missing:
        identity.ensure_roster(db, row["class_id"], row["student_id"], source="activity",
                               display_name=_latest_name(db, row["class_id"], row["student_id"], email=False),
                               kiwi_email=_latest_name(db, row["class_id"], row["student_id"], email=True))


def b5_provenance(db: sqlite3.Connection) -> None:
    db.execute("UPDATE events SET received_at = created_at WHERE received_at IS NULL")
    db.execute(f"UPDATE events SET category = {event_schema.category_case_sql('event_type')}")
    for table in ("events", "chat_turns", "submissions"):
        stamp_provenance(db, table)


def b6_materials(db: sqlite3.Connection) -> None:
    db.execute(
        """INSERT INTO material_unit_map (class_id, material_id, unit_id, valid_from, changed_by)
        SELECT class_id, id, unit_id, ?, 'migration' FROM kiwi_materials WHERE unit_id != ''
        ON CONFLICT(class_id, material_id, valid_from) DO NOTHING""", (dbmod.now(),))


def b7_settings(db: sqlite3.Connection) -> None:
    from server import course_config

    defaults = dbmod.json_dumps(course_config.default_settings())
    db.execute(
        """INSERT INTO course_settings (class_id, settings_json, updated_at, updated_by)
        SELECT class_id, ?, ?, 'migration' FROM courses WHERE true ON CONFLICT(class_id) DO NOTHING""",
        (defaults, dbmod.now()))


def b8_chat_context(db: sqlite3.Connection) -> None:
    """Pre-v0.6 Lab AI tutor turns: assignment, question and chapter from the v0.5.1 thread id (review 2, TEACHER-07).

    v0.5.1 named threads ``thread-<assignmentId>-<questionId>`` (homework/in-class questions) or
    ``thread-practice-<unitId>`` (free practice); the 0.6.0 columns were added empty, so the AI conversations
    chapter filter showed none of these turns.
    """
    works: dict[str, list[tuple[str, str, set[str]]]] = {}
    for row in db.execute("SELECT id, class_id, unit_id, questions_json FROM assignments"):
        try:
            questions = json.loads(row["questions_json"] or "[]")
        except json.JSONDecodeError:
            questions = []
        qids = {q.get("id") for q in questions if isinstance(q, dict) and isinstance(q.get("id"), str)}
        works.setdefault(row["class_id"], []).append((row["id"], row["unit_id"] or "", qids))
    for entries in works.values():
        entries.sort(key=lambda e: len(e[0]), reverse=True)
    updates: list[tuple[str, str, str, int]] = []
    for turn in db.execute("""SELECT id, class_id, thread_id, question_id, unit_id FROM chat_turns
            WHERE assignment_id = '' AND thread_id LIKE 'thread-%'"""):
        rest = turn["thread_id"][len("thread-"):]
        for work_id, unit_id, qids in works.get(turn["class_id"], []):
            if rest.startswith(work_id + "-"):
                qid = turn["question_id"] or ""
                tail = rest[len(work_id) + 1:]
                if not qid and tail in qids:
                    qid = tail
                updates.append((work_id, qid, turn["unit_id"] or unit_id, turn["id"]))
                break
        else:
            if rest.startswith("practice-") and not turn["unit_id"]:
                updates.append(("", turn["question_id"] or "", rest[len("practice-"):][:100], turn["id"]))
    for work_id, qid, unit_id, turn_id in updates:
        db.execute("UPDATE chat_turns SET assignment_id=?, question_id=?, unit_id=? WHERE id=?", (work_id, qid, unit_id, turn_id))
    # TEACHER-14: the grader of migrated grades reads "Imported from v0.5" (was "Before v0.6").
    db.execute("UPDATE grade_events SET actor_label='Imported from v0.5' WHERE actor_label='Before v0.6' AND actor_role='system'")


MIGRATIONS: list[tuple[str, Callable[[sqlite3.Connection], None]]] = [
    ("0.6.0-001-columns", m001_columns),
    ("0.6.0-002-tables", m002_tables),
    ("0.6.0-003-policies", b1_policies),
    ("0.6.0-004-submissions", b2_submissions),
    ("0.6.0-005-assignments", b3_assignments),
    ("0.6.0-006-roster", b4_roster),
    ("0.6.0-007-provenance", b5_provenance),
    ("0.6.0-008-materials", b6_materials),
    ("0.6.0-009-settings", b7_settings),
    ("0.6.0-010-chat-context", b8_chat_context),
]


# -- workstream migrations (additive DDL only) -----------------------------------------------------
def validate_ws_statement(statement: str) -> None:
    if not isinstance(statement, str) or not _ALLOWED_WS.match(statement):
        raise MigrationError(f"Workstream migrations allow only additive DDL: {str(statement)[:80]!r}")
    if ";" in statement.strip().rstrip(";"):
        raise MigrationError("Workstream migration statements must be single statements")


def workstream_steps() -> list[tuple[str, Callable[[sqlite3.Connection], None]]]:
    steps: list[tuple[str, Callable[[sqlite3.Connection], None]]] = []
    for ws in WORKSTREAM_MODULES:
        module = importlib.import_module(f"server.migrations_{ws}")
        for version, statements in getattr(module, "OPS", []):
            if not isinstance(version, str) or not version.startswith(f"0.6.0-{ws}-"):
                raise MigrationError(f"Workstream migration version must start with 0.6.0-{ws}-: {version!r}")
            for statement in statements:
                validate_ws_statement(statement)
            steps.append((version, lambda db, s=tuple(statements): _apply_ws(db, s)))
    return steps


def _apply_ws(db: sqlite3.Connection, statements: tuple[str, ...]) -> None:
    for statement in statements:
        match = _ALTER.match(statement)
        if match:
            add_column(db, match.group(1), match.group(2), match.group(3))
        else:
            db.execute(statement.strip().rstrip(";"))


def altered_or_created_tables() -> set[str]:
    """Tables altered or created by a 0.6 migration (positional inserts into them are forbidden)."""
    tables = {table for table, _, _ in NEW_COLUMNS}
    for statement in NEW_TABLES:
        match = re.match(r"\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)", statement, re.I)
        if match:
            tables.add(match.group(1))
    for _, fn in workstream_steps():
        statements = getattr(fn, "__defaults__", None) or ((),)
        for statement in statements[0]:
            match = re.match(r"\s*(?:CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS|ALTER\s+TABLE)\s+(\w+)", statement, re.I)
            if match:
                tables.add(match.group(1))
    return tables


# -- backups -----------------------------------------------------------------------------------------
def _database_file(db: sqlite3.Connection) -> Path | None:
    for row in db.execute("PRAGMA database_list"):
        if row[1] == "main":
            return Path(row[2]) if row[2] else None
    return None


def backup_dir(db_file: Path) -> Path:
    return db_file.parent / "backups"


def _safe_tag(tag: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", tag)


def backup_once(db: sqlite3.Connection, tag: str) -> Path | None:
    """Online backup to ``<db dir>/backups/<stem>.pre-<tag>-<UTC yyyymmddTHHMMSS>.sqlite3`` unless one exists.

    Must run outside a transaction. Raises ``MigrationError`` when the backup cannot be written.
    """
    db_file = _database_file(db)
    if db_file is None:
        return None
    if db.in_transaction:
        raise MigrationError("backup_once must run outside a transaction")
    directory = backup_dir(db_file)
    prefix = f"{db_file.stem}.pre-{_safe_tag(tag)}-"
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        existing = sorted(p for p in directory.glob(prefix + "*.sqlite3") if re.fullmatch(r"\d{8}T\d{6}", p.name[len(prefix):-8]))
        if existing:
            return existing[0]
        target = directory / f"{prefix}{dbmod.utcnow().strftime('%Y%m%dT%H%M%S')}.sqlite3"
        partial = target.with_suffix(".partial")
        destination = sqlite3.connect(partial)
        try:
            db.backup(destination)
        finally:
            destination.close()
        os.chmod(partial, 0o600)
        partial.replace(target)
        return target
    except (OSError, sqlite3.Error) as exc:
        raise MigrationError(f"Could not back up the database before {tag}: {exc}. Startup stopped; no data was changed.") from exc


def list_backups(db: sqlite3.Connection, tag: str | None = None) -> list[Path]:
    db_file = _database_file(db)
    if db_file is None or not backup_dir(db_file).exists():
        return []
    pattern = f"{db_file.stem}.pre-{_safe_tag(tag)}-*.sqlite3" if tag else f"{db_file.stem}.pre-*.sqlite3"
    return sorted(backup_dir(db_file).glob(pattern))


def _has_data(db: sqlite3.Connection) -> bool:
    for table in ("events", "assignments", "submissions", "chat_turns", "roster", "courses", "generation_policies",
                  "learning_sessions", "kiwi_links"):
        if dbmod.table_exists(db, table) and db.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone():
            return True
    return False


def applied_versions(db: sqlite3.Connection) -> set[str]:
    if not dbmod.table_exists(db, "schema_migrations"):
        return set()
    return {row[0] for row in db.execute("SELECT version FROM schema_migrations")}


def run(db: sqlite3.Connection) -> list[str]:
    """Apply every missing core and workstream migration; returns the versions applied now."""
    if db.in_transaction:
        db.commit()
    db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
    applied = applied_versions(db)
    pending = [(version, fn) for version, fn in MIGRATIONS + workstream_steps() if version not in applied]
    if not pending:
        return []
    if _has_data(db):
        backup_once(db, pending[0][0])
    done: list[str] = []
    for version, fn in pending:
        db.execute("BEGIN IMMEDIATE")
        try:
            fn(db)
            db.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", (version, dbmod.now()))
            db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        done.append(version)
    return done


def checksum(db: sqlite3.Connection, table: str, columns: str) -> str:
    """Stable digest of selected columns (used by preservation checks)."""
    digest = hashlib.sha256()
    for row in db.execute(f"SELECT {columns} FROM {table} ORDER BY rowid"):
        digest.update(json.dumps(list(row), default=str).encode("utf-8"))
    return digest.hexdigest()
