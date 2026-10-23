"""Exports, research package, student case files and codebook (owned by PEOPLE; spec §13.6, §13.8).

Files are built inside the request (so failures map to readable errors) into a spooled temporary file and returned as a
``Response.stream``; the router spools again and sends ``Content-Length``. Teaching CSVs: UTF-8 BOM, CRLF, RFC 4180
quoting, formula neutralization (KEEP). Research files: UTF-8 without BOM, no neutralization.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import sqlite3
import subprocess
import tempfile
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any, Iterable, Iterator

from server import auth, course_config, event_schema, identity, readers, roster
from server import db as dbmod
from server.router import ApiError, Request, Response

APP_VERSION = "0.6.0"
STUDY_SESSION_GAP = timedelta(minutes=30)
CHUNK = 64 * 1024
_FULL_WIDTH = {"＝": "=", "＋": "+", "－": "-", "＠": "@"}
_NUMERIC = re.compile(r"^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$", re.I)
ROOT = Path(__file__).resolve().parents[1]

ACTIVITY_COLUMNS = [
    "event_id", "student_id", "student_label", "section_group", "condition_group", "occurred_at", "received_at", "event_type",
    "schema_version", "where", "surface", "practice_mode", "unit_id", "assignment_id", "assignment_version",
    "related_assignment_id", "question_id", "item_id", "question_activity_id", "study_session_index", "actor_role",
    "checked_by", "correct", "rejudged_correct", "policy_version_id", "ai_call_id", "chat_turn_id", "truncated_fields",
    "payload_json",
]
ACTIVITY_NUMERIC = {"schema_version", "assignment_version", "study_session_index", "correct", "rejudged_correct",
                    "policy_version_id", "ai_call_id", "chat_turn_id"}
AI_COLUMNS = [
    "chat_turn_id", "native_event_id", "thread_key", "where", "student_id", "student_label", "section_group", "condition_group",
    "unit_id", "assignment_id", "question_id", "item_id", "surface", "created_at", "prompt", "response", "ai_provider", "model",
    "policy_version_id", "policy_label", "guard_status", "flagged", "flag_source", "homework_match_assignment_id",
    "homework_match_score", "input_tokens", "output_tokens", "reasoning_tokens", "latency_ms", "context_json", "native_feedback",
    "codes",
]
AI_NUMERIC = {"chat_turn_id", "native_event_id", "policy_version_id", "flagged", "homework_match_score", "input_tokens",
              "output_tokens", "reasoning_tokens", "latency_ms"}
ITEM_COLUMNS = [
    "item_id", "student_id", "student_label", "section_group", "condition_group", "origin", "unit_id", "related_assignment_id",
    "related_question_id", "question_type", "difficulty", "requested_type", "requested_difficulty", "focus_note", "source",
    "model", "ai_call_id", "policy_version_id", "novelty_retries", "guard_status", "homework_match_assignment_id",
    "homework_match_question_id", "homework_match_score", "verification", "client_run_output", "status", "created_at",
    "attempts", "correct", "item_json",
]
ITEM_NUMERIC = {"difficulty", "requested_difficulty", "ai_call_id", "policy_version_id", "novelty_retries",
                "homework_match_score", "attempts", "correct"}
CODE_COLUMNS = ["thread_key", "chat_turn_id", "native_event_id", "code_id", "code_label", "coder_role", "note", "created_at"]
AI_CALL_COLUMNS = [
    "request_id", "research_id", "section_group", "condition_group", "action", "surface", "unit_id", "assignment_id",
    "question_id", "item_id", "status", "error_code", "policy_version_id", "policy_source", "platform_rules_version", "model",
    "reasoning_effort", "max_output_tokens", "history_turns", "prompt_hash", "input_tokens", "output_tokens",
    "reasoning_tokens", "queue_ms", "latency_ms", "requested_at", "guard_status", "homework_match_score",
    "homework_match_jaccard",
]
PARTICIPANT_COLUMNS = ["research_id", "section_group", "condition_group", "consent_state", "roster_status", "identity_verified",
                       "first_activity_at", "last_activity_at"]
SUBMISSION_RESEARCH_COLUMNS = [
    "submission_id", "research_id", "section_group", "condition_group", "assignment_id", "assignment_version", "attempt",
    "submitted_at", "is_late", "late_seconds", "over_time", "time_used_seconds", "grade_status", "total", "max_points",
    "adjustment_points", "released_at",
]
ITEM_SCORE_COLUMNS = ["submission_id", "question_id", "answer_text", "auto_correct", "auto_score", "score", "points", "overridden",
                      "graded_at"]
NATIVE_RESPONSE_COLUMNS = ["upstream_action_id", "upstream_interaction_id", "native_event_id", "action_type", "engine_choice",
                           "response", "truncated", "responded_at"]
GROUP_HISTORY_COLUMNS = ["research_id", "kind", "group", "method", "seed", "valid_from", "valid_to"]


# -- CSV / JSONL writers --------------------------------------------------------------------------
def needs_neutralization(text: str) -> bool:
    """§13.6: the first non-whitespace char (full-width ＝＋－＠ normalized) is = + - @, or the lead holds a tab/CR."""
    lead = re.match(r"^[\s　]*", text).group(0)  # type: ignore[union-attr]
    if "\t" in lead or "\r" in lead:
        return True
    rest = text[len(lead):]
    if not rest:
        return False
    first = _FULL_WIDTH.get(rest[0], rest[0])
    return first in "=+-@"


def _text_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


def teaching_cell(value: object, numeric: bool = False) -> str:
    text = _text_value(value)
    is_number = isinstance(value, (int, float)) and not isinstance(value, bool) or (numeric and _NUMERIC.fullmatch(text.strip() or "x"))
    if not is_number and needs_neutralization(text):
        text = "'" + text
    return text


class TableWriter:
    """Rows → CSV (teaching or research flavour) or JSONL, written to a spooled temp file."""

    def __init__(self, columns: list[str], *, fmt: str, teaching: bool, numeric: set[str] | None = None) -> None:
        self.columns = columns
        self.fmt = fmt
        self.teaching = teaching
        self.numeric = numeric or set()
        self.rows = 0
        self.buffer = io.StringIO()
        if fmt == "csv":
            self.writer = csv.writer(self.buffer, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
            if teaching:
                self.buffer.write("﻿")
            self.writer.writerow(columns)

    def add(self, row: dict) -> None:
        self.rows += 1
        if self.fmt == "jsonl":
            self.buffer.write(json.dumps({c: row.get(c) for c in self.columns}, ensure_ascii=False, sort_keys=False) + "\n")
            return
        if self.teaching:
            self.writer.writerow([teaching_cell(row.get(c), c in self.numeric) for c in self.columns])
        else:
            self.writer.writerow([_text_value(row.get(c)) for c in self.columns])

    def data(self) -> bytes:
        return self.buffer.getvalue().encode("utf-8")


def _chunks(handle: Any) -> Iterator[bytes]:
    try:
        while True:
            chunk = handle.read(CHUNK)
            if not chunk:
                break
            yield chunk
    finally:
        handle.close()


def file_response(data: bytes | Any, filename: str, content_type: str, rows: int, headers: dict[str, str] | None = None) -> Response:
    if isinstance(data, (bytes, bytearray)):
        spool = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
        spool.write(data)
    else:
        spool = data
    spool.seek(0)
    # WHY: the router logs the access row count from X-Export-Rows for streamed responses (CR-P1).
    return Response(status=200, stream=_chunks(spool), filename=filename, content_type=content_type,
                    headers={"X-Export-Rows": str(rows), **(headers or {})})


# -- filters & population -------------------------------------------------------------------------
@dataclass
class Filters:
    start: str | None = None
    end: str | None = None
    unit_ids: list[str] = field(default_factory=list)
    group_ids: list[str] = field(default_factory=list)
    student_id: str | None = None
    assignment_id: str | None = None
    question_id: str | None = None
    where: str | None = None
    practice_mode: str | None = None
    origin: str | None = None
    include_staff: bool = False
    pseudonymize: bool = False
    consent: str = "all"
    purpose: str = ""
    thread_key: str | None = None
    code_id: str | None = None
    flagged: bool = False
    verified_only: bool = False
    forced: bool = False
    forced_role: str = ""
    include_excluded: bool = False   # case files: a dropped or excluded student's own records still belong in the file

    def public(self) -> dict:
        return {"from": self.start, "to": self.end, "unitIds": self.unit_ids, "groupIds": self.group_ids,
                "assignmentId": self.assignment_id, "questionId": self.question_id, "where": self.where,
                "practiceMode": self.practice_mode, "origin": self.origin, "includeStaff": self.include_staff,
                "pseudonymize": self.pseudonymize, "consent": self.consent, "studentFiltered": bool(self.student_id)}


def parse_filters(req: Request, *, research: bool = False) -> Filters:
    ident = req.identity
    f = Filters(
        start=req.q_iso("from"), end=req.q_iso("to"), unit_ids=req.q_list("unitIds"), group_ids=req.q_list("groupIds"),
        student_id=req.q_id("studentId"), assignment_id=req.q_id("assignmentId"), question_id=req.q_id("questionId"),
        where=req.q_choice("where", ("lab", "kiwi"), "") or None,
        practice_mode=req.q_choice("practiceMode", ("homework", "in-class", "similar", "free", "workspace", "lecture", "kiwi",
                                                    "other"), "") or None,
        origin=req.q_choice("origin", ("teacher", "ai-free", "ai-similar"), "") or None,
        include_staff=req.q_bool("includeStaff"), pseudonymize=req.q_bool("pseudonymize", research),
        consent=req.q_choice("consent", ("all", "yes"), "yes" if research else "all"),
        purpose=req.q_str("purpose", "", 500).strip(), thread_key=req.q_str("threadKey", "", 300) or None,
        code_id=req.q_id("codeId"), flagged=req.q_bool("flagged"))
    if ident.staff_role in auth.PSEUDONYMOUS_EXPORT_ROLES:
        # §5.3 footnote 1 and decision D3: viewers and researchers get de-identified exports of consenting students only.
        f.forced = not (f.pseudonymize and f.consent == "yes" and not f.include_staff)
        f.forced_role = ident.staff_role
        f.pseudonymize, f.consent, f.include_staff = True, "yes", False
    if f.student_id and not 5 <= len(f.purpose) <= 500:
        raise ApiError(400, "invalid_request", "Exports of one student need a purpose (5–500 characters).")
    return f


def student_filter(alias: str, db: sqlite3.Connection, class_id: str, f: Filters, *, student_col: str = "student_id",
                   cols: dict[str, str] | None = None) -> tuple[str, list]:
    """Population (§5.4) + consent + group + one-student filters as one SQL condition on ``alias``."""
    sql, params = identity.population_sql(alias, class_linked=identity.class_linked(db, class_id),
                                          cols=cols or identity.EVENT_COLS, include_staff=f.include_staff,
                                          include_excluded=f.include_excluded)
    parts, values = [sql], list(params)
    sid = f"{alias}.{student_col}"
    if f.consent == "yes":
        parts.append(f"EXISTS (SELECT 1 FROM roster rc WHERE rc.class_id = ? AND rc.student_id = {sid} AND "
                     "(rc.consent_override = 'yes' OR (rc.consent_override IS NULL AND rc.kiwi_consent = 1)))")
        values.append(class_id)
    if f.group_ids:
        marks = ",".join("?" for _ in f.group_ids)
        parts.append(f"EXISTS (SELECT 1 FROM group_members gm WHERE gm.class_id = ? AND gm.student_id = {sid} "
                     f"AND gm.group_id IN ({marks}))")
        values.extend([class_id, *f.group_ids])
    if f.student_id:
        parts.append(f"{sid} = ?")
        values.append(f.student_id)
    if f.verified_only:
        parts.append(f"{alias}.identity_verified = 1")
    return " AND ".join(f"({p})" for p in parts), values


def time_filter(column: str, f: Filters) -> tuple[str, list]:
    parts, values = [], []
    if f.start:
        parts.append(f"{column} >= ?")
        values.append(f.start)
    if f.end:
        parts.append(f"{column} < ?")
        values.append(f.end)
    return (" AND ".join(parts) if parts else "1 = 1"), values


class People:
    """Labels, research ids, group names and free-text scrubbing for one export."""

    def __init__(self, db: sqlite3.Connection, class_id: str, *, pseudonymize: bool, research: bool = False,
                 participants_only: bool = False) -> None:
        self.db = db
        self.class_id = class_id
        self.pseudonymize = pseudonymize
        self.research = research
        # SB-m01: consent-filtered exports name a non-consenting classmate "[classmate]", never by research id
        self.participants_only = participants_only
        self.groups = roster.group_names(db, class_id)
        self._labels: dict[str, str] = {}
        self._rids: dict[str, str] = {}
        self._scrub: dict[str, list[str]] = {}
        self._roster: tuple[list[tuple[str, str]], re.Pattern[str] | None, set[str]] | None = None
        self._consenting: set[str] | None = None

    @property
    def student_column(self) -> str:
        return "research_id" if (self.pseudonymize or self.research) else "student_id"

    def rid(self, student_id: str) -> str:
        if student_id not in self._rids:
            self._rids[student_id] = identity.research_id(self.db, self.class_id, student_id)
        return self._rids[student_id]

    def preload(self, student_ids: Iterable[str]) -> None:
        missing = [s for s in set(student_ids) if s not in self._labels]
        if missing:
            self._labels.update(identity.labels(self.db, self.class_id, missing, "names"))

    def ident(self, student_id: str) -> str:
        return self.rid(student_id) if (self.pseudonymize or self.research) else student_id

    def label(self, student_id: str) -> str:
        if self.pseudonymize or self.research:
            return self.rid(student_id)
        if student_id not in self._labels:
            self.preload([student_id])
        return self._labels.get(student_id, student_id)

    def group(self, group_id: str | None) -> str:
        return self.groups.get(group_id or "", "") if group_id else ""

    def thread_key(self, key: str) -> str:
        if not (self.pseudonymize or self.research) or not key.startswith("lab:"):
            return key
        parts = key.split(":", 2)
        return f"lab:{self.rid(parts[1])}:{parts[2]}" if len(parts) == 3 else key

    def _terms(self, student_id: str) -> list[str]:
        if student_id not in self._scrub:
            row = self.db.execute("SELECT display_name, kiwi_email, student_name FROM roster WHERE class_id=? AND student_id=?",
                                  (self.class_id, student_id)).fetchone()
            terms: list[str] = []
            if row:
                # WHY: §13.6 scrubs the student's own name and email; ids are left alone (short ids would hit ordinary words).
                terms = [t for t in (row["display_name"], row["kiwi_email"], row["student_name"])
                         if t and len(t) >= 3 and t != student_id and t != "Anonymized student"]
            self._scrub[student_id] = sorted(set(terms), key=len, reverse=True)
        return self._scrub[student_id]

    def _roster_scrub(self) -> tuple[list[tuple[str, str]], re.Pattern[str] | None, set[str]]:
        """Every roster name/email mapped to that student's research id, computed once per export (review 2)."""
        if self._roster is None:
            owners = identity.roster_term_owners(self.db, self.class_id)
            terms = [(term, self._other(sid)) for term, sid in owners]
            ids = {row[0] for row in self.db.execute("SELECT student_id FROM roster WHERE class_id=?", (self.class_id,))}
            self._roster = (terms, identity.term_pattern(terms), ids)
        return self._roster

    def _other(self, student_id: str) -> str:
        """How a roster student named in free text appears: research id, or ``[classmate]`` for a non-participant."""
        if self.participants_only:
            if self._consenting is None:
                self._consenting = identity.consenting_ids(self.db, self.class_id)
            if student_id not in self._consenting:
                return identity.NON_PARTICIPANT
        return self.rid(student_id)

    def scrub_roster(self, value: object) -> object:
        """De-identified exports: replace every roster student's name/email in free text with their research id.

        WHY (review 2, CORRECTNESS-03/SECURITY-01): one student's text may name a classmate (who may not have consented);
        scrubbing only the row owner's own terms left those names in research files. String values equal to a roster
        student id (e.g. ``payload.studentId``) are replaced too.
        """
        if not (self.pseudonymize or self.research):
            return value
        terms, pattern, ids = self._roster_scrub()
        scrubbed = identity.scrub_free_text(value, terms, skip_id_keys=False, pattern=pattern) if pattern else value

        def ids_out(item: object) -> object:
            if isinstance(item, str):
                return self._other(item) if item in ids else item
            if isinstance(item, list):
                return [ids_out(x) for x in item]
            if isinstance(item, dict):
                return {k: ids_out(v) for k, v in item.items()}
            return item

        return ids_out(scrubbed)

    def scrub(self, student_id: str, value: object) -> object:
        """Replace roster names/emails (the whole roster, then the student's own terms anywhere) with research ids."""
        if not (self.pseudonymize or self.research):
            return value
        value = self.scrub_roster(value)
        terms = self._terms(student_id)
        if not terms:
            return value
        rid = self.rid(student_id)

        def walk(item: object) -> object:
            if isinstance(item, str):
                for term in terms:
                    item = re.sub(re.escape(term), rid, item, flags=re.IGNORECASE)
                return item
            if isinstance(item, list):
                return [walk(x) for x in item]
            if isinstance(item, dict):
                return {k: walk(v) for k, v in item.items()}
            return item

        return walk(value)


def _loads(value: object, default: Any = None) -> Any:
    if not isinstance(value, str) or not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _day() -> str:
    return dbmod.utcnow().strftime("%Y%m%d")


# -- activity --------------------------------------------------------------------------------------
def activity_rows(db: sqlite3.Connection, class_id: str, f: Filters, people: People) -> Iterator[dict]:
    pop, pop_values = student_filter("e", db, class_id, f)
    when, when_values = time_filter("e.created_at", f)
    where = ["e.class_id = ?", pop, when]
    values: list[object] = [class_id, *pop_values, *when_values]
    if f.where:
        where.append("e.source = ?")
        values.append(f.where)
    if f.practice_mode:
        where.append("e.practice_mode = ?")
        values.append(f.practice_mode)
    if f.origin:
        modes = {"teacher": ("homework", "in-class"), "ai-free": ("free",), "ai-similar": ("similar",)}[f.origin]
        where.append(f"e.practice_mode IN ({','.join('?' for _ in modes)})")
        values.extend(modes)
    if f.assignment_id:
        where.append("(e.attribution_assignment_id = ? OR e.related_assignment_id = ?)")
        values.extend([f.assignment_id, f.assignment_id])
    if f.question_id:
        where.append("e.question_id = ?")
        values.append(f.question_id)
    units = {r["id"]: r["unit_id"] for r in db.execute("SELECT id, unit_id FROM assignments WHERE class_id=?", (class_id,))}
    sql = f"""SELECT e.*, ls.unitId AS session_unit FROM events e LEFT JOIN learning_sessions ls ON ls.id = e.learning_session_id
        WHERE {' AND '.join(where)} ORDER BY e.created_at, e.id"""
    last_seen: dict[str, Any] = {}
    session_index: dict[str, int] = {}
    wanted_units = set(f.unit_ids)
    for row in db.execute(sql, values):
        payload = _loads(row["payload_json"], {}) or {}
        assignment_id = row["attribution_assignment_id"] or (payload.get("assignmentId") if isinstance(payload.get("assignmentId"), str) else "") or ""
        unit_id = (payload.get("unitId") if isinstance(payload.get("unitId"), str) else "") or row["session_unit"] or units.get(assignment_id, "")
        if wanted_units and unit_id not in wanted_units:
            continue
        sid = row["student_id"]
        moment = dbmod.parse_iso(row["created_at"])
        previous = last_seen.get(sid)
        if previous is None or (moment and previous and moment - previous >= STUDY_SESSION_GAP):
            session_index[sid] = session_index.get(sid, 0) + 1
        last_seen[sid] = moment
        correct = payload.get("correct")
        yield {
            "event_id": row["event_id"] or f"row-{row['id']}",
            people.student_column: people.ident(sid),
            "student_label": people.label(sid),
            "section_group": people.group(row["section_group_id"]),
            "condition_group": people.group(row["condition_group_id"]),
            "occurred_at": row["created_at"], "received_at": row["received_at"] or row["created_at"],
            "event_type": row["event_type"], "schema_version": row["schema_version"],
            "where": "kiwi" if row["source"] == "kiwi" else "lab", "surface": row["surface"],
            "practice_mode": row["practice_mode"], "unit_id": unit_id, "assignment_id": assignment_id,
            "assignment_version": row["assignment_version"], "related_assignment_id": row["related_assignment_id"],
            "question_id": row["question_id"] or "", "item_id": row["item_id"],
            "question_activity_id": row["learning_session_id"] or "", "study_session_index": session_index[sid],
            "actor_role": row["actor_role"], "checked_by": row["checked_by"],
            "correct": int(correct) if isinstance(correct, bool) else None, "rejudged_correct": row["rejudged_correct"],
            "policy_version_id": row["policy_version_id"], "ai_call_id": row["ai_call_id"], "chat_turn_id": row["chat_turn_id"],
            "truncated_fields": _loads(row["truncated_json"], {}) or {},
            "payload_json": people.scrub(sid, payload),
            "_student": sid, "_identity_verified": row["identity_verified"],
        }


def _activity_columns(people: People) -> list[str]:
    return [people.student_column if c == "student_id" else c for c in ACTIVITY_COLUMNS]


# -- AI conversations ------------------------------------------------------------------------------
def _policy_labels(db: sqlite3.Connection, class_id: str) -> dict[int, str]:
    titles = {u["id"]: u["title"] for u in course_config.course_for(class_id, db)["units"]}
    groups = roster.group_names(db, class_id)
    out = {}
    for row in db.execute("SELECT id, scope, unit_id, group_id, version FROM policy_versions WHERE class_id=?", (class_id,)):
        if row["scope"] == "course":
            base = "Course rules"
        else:
            title = titles.get(row["unit_id"], row["unit_id"])
            base = f"Ch {title.split(' · ')[0]} rules" if " · " in title else f"{title} rules"
        label = f"{base} v{row['version']}"
        if row["group_id"]:
            label += f" · {groups.get(row['group_id'], row['group_id'])}"
        out[int(row["id"])] = label
    return out


def _codes(db: sqlite3.Connection, class_id: str) -> tuple[dict[str, list[tuple]], dict[str, str]]:
    labels = {r["id"]: r["label"] for r in db.execute("SELECT id, label FROM codebook_codes WHERE class_id=?", (class_id,))}
    by_thread: dict[str, list[tuple]] = {}
    for row in db.execute("SELECT * FROM conversation_codes WHERE class_id=? AND deleted_at IS NULL ORDER BY id", (class_id,)):
        by_thread.setdefault(row["thread_key"], []).append((row["chat_turn_id"], row["native_event_id"], row["code_id"]))
    return by_thread, labels


def ai_rows(db: sqlite3.Connection, class_id: str, f: Filters, people: People) -> list[dict]:
    rows: list[dict] = []
    policy_labels = _policy_labels(db, class_id)
    codes, code_labels = _codes(db, class_id)

    def code_text(thread_key: str, turn_id: int | None, native_id: int | None) -> str:
        found = []
        for chat_turn_id, native_event_id, code_id in codes.get(thread_key, []):
            if (chat_turn_id is None and native_event_id is None) or (turn_id and chat_turn_id == turn_id) or (
                    native_id and native_event_id == native_id):
                found.append(code_labels.get(code_id, code_id))
        return "; ".join(dict.fromkeys(found))

    def has_code(thread_key: str) -> bool:
        return any(code_id == f.code_id for _, _, code_id in codes.get(thread_key, []))

    if f.where in (None, "lab"):
        pop, pop_values = student_filter("c", db, class_id, f)
        when, when_values = time_filter("c.created_at", f)
        where = ["c.class_id = ?", pop, when]
        values: list[object] = [class_id, *pop_values, *when_values]
        if f.unit_ids:
            where.append(f"c.unit_id IN ({','.join('?' for _ in f.unit_ids)})")
            values.extend(f.unit_ids)
        if f.assignment_id:
            where.append("c.assignment_id = ?")
            values.append(f.assignment_id)
        if f.question_id:
            where.append("c.question_id = ?")
            values.append(f.question_id)
        if f.flagged:
            where.append("c.flagged = 1")
        for row in db.execute(
            f"""SELECT c.*, a.input_tokens, a.output_tokens, a.reasoning_tokens, a.latency_ms, a.homework_match_assignment_id,
            a.homework_match_score FROM chat_turns c LEFT JOIN ai_calls a ON a.id = c.ai_call_id
            WHERE {' AND '.join(where)} ORDER BY c.created_at, c.id""", values):
            key = f"lab:{row['student_id']}:{row['thread_id']}"
            if f.thread_key and key != f.thread_key:
                continue
            if f.code_id and not has_code(key):
                continue
            sid = row["student_id"]
            provider = "local" if row["source"] == "local" else "openai"
            rows.append({
                "chat_turn_id": row["id"], "native_event_id": None, "thread_key": people.thread_key(key), "where": "lab",
                people.student_column: people.ident(sid), "student_label": people.label(sid),
                "section_group": people.group(row["section_group_id"]), "condition_group": people.group(row["condition_group_id"]),
                "unit_id": row["unit_id"], "assignment_id": row["assignment_id"], "question_id": row["question_id"] or "",
                "item_id": row["item_id"], "surface": row["surface"], "created_at": row["created_at"],
                "prompt": people.scrub(sid, row["prompt"]), "response": people.scrub(sid, row["response"]),
                "ai_provider": provider, "model": row["model"], "policy_version_id": row["policy_version_id"],
                "policy_label": policy_labels.get(row["policy_version_id"], "Default rules") if row["policy_version_id"] else "Default rules",
                "guard_status": row["guard_status"], "flagged": int(row["flagged"]), "flag_source": row["flag_source"],
                "homework_match_assignment_id": row["homework_match_assignment_id"] or "",
                "homework_match_score": row["homework_match_score"], "input_tokens": row["input_tokens"],
                "output_tokens": row["output_tokens"], "reasoning_tokens": row["reasoning_tokens"], "latency_ms": row["latency_ms"],
                "context_json": people.scrub(sid, _loads(row["context_json"], {})), "native_feedback": [],
                "codes": code_text(key, row["id"], None), "_student": sid, "_identity_verified": row["identity_verified"],
            })
    if f.where in (None, "kiwi") and not f.flagged and not f.assignment_id and not f.question_id:
        pop, pop_values = student_filter("e", db, class_id, f)
        when, when_values = time_filter("e.created_at", f)
        feedback: dict[str, list[dict]] = {}
        for row in db.execute("SELECT created_at, payload_json FROM events WHERE class_id=? AND source='kiwi' AND event_type='ai_feedback'",
                              (class_id,)):
            payload = _loads(row["payload_json"], {}) or {}
            conversation = str(payload.get("conversationId") or payload.get("threadId") or "")
            feedback.setdefault(conversation, []).append({"value": payload.get("value"), "reply": payload.get("reply"),
                                                          "at": row["created_at"], "messageIndex": payload.get("targetMessageIndex")})
        responses = {r["event_id"]: r["bot_response"] for r in db.execute(
            "SELECT event_id, bot_response FROM ai_responses WHERE class_id=? AND event_id IS NOT NULL", (class_id,))}
        for row in db.execute(
            f"""SELECT e.* FROM events e WHERE e.class_id = ? AND e.source = 'kiwi' AND e.event_type = 'ai_question'
            AND {pop} AND {when} ORDER BY e.created_at, e.id""", (class_id, *pop_values, *when_values)):
            payload = _loads(row["payload_json"], {}) or {}
            unit_id = str(payload.get("unitId") or "")
            if f.unit_ids and unit_id not in f.unit_ids:
                continue
            thread = str(payload.get("threadId") or "")
            key = f"kiwi:{thread}"
            if f.thread_key and key != f.thread_key:
                continue
            if f.code_id and not has_code(key):
                continue
            sid = row["student_id"]
            rows.append({
                "chat_turn_id": None, "native_event_id": row["id"], "thread_key": key, "where": "kiwi",
                people.student_column: people.ident(sid), "student_label": people.label(sid),
                "section_group": people.group(row["section_group_id"]), "condition_group": people.group(row["condition_group_id"]),
                "unit_id": unit_id, "assignment_id": "", "question_id": "", "item_id": "", "surface": str(payload.get("surface") or ""),
                "created_at": row["created_at"], "prompt": people.scrub(sid, str(payload.get("prompt") or "")),
                "response": people.scrub(sid, str(payload.get("response") or responses.get(row["id"]) or "")),
                "ai_provider": "kiwi-native", "model": payload.get("engineChoice") or None, "policy_version_id": None,
                "policy_label": "Kiwi lecture AI", "guard_status": "not_applicable", "flagged": 0, "flag_source": "",
                "homework_match_assignment_id": "", "homework_match_score": None, "input_tokens": None, "output_tokens": None,
                "reasoning_tokens": None, "latency_ms": None,
                "context_json": {k: payload.get(k) for k in ("materialId", "materialTitle", "page", "title") if payload.get(k)},
                "native_feedback": [{k: v for k, v in fb.items() if k != "messageIndex"} for fb in feedback.get(thread, [])],
                "codes": code_text(key, None, row["id"]), "_student": sid, "_identity_verified": row["identity_verified"],
            })
    rows.sort(key=lambda r: (r["created_at"], r["chat_turn_id"] or 0, r["native_event_id"] or 0))
    return rows


def _ai_columns(people: People) -> list[str]:
    return [people.student_column if c == "student_id" else c for c in AI_COLUMNS]


# -- generated items, codes -----------------------------------------------------------------------
def item_rows(db: sqlite3.Connection, class_id: str, f: Filters, people: People) -> list[dict]:
    pop, pop_values = student_filter("g", db, class_id, f)
    when, when_values = time_filter("g.created_at", f)
    where = ["g.class_id = ?", pop, when]
    values: list[object] = [class_id, *pop_values, *when_values]
    if f.unit_ids:
        where.append(f"g.unit_id IN ({','.join('?' for _ in f.unit_ids)})")
        values.extend(f.unit_ids)
    if f.assignment_id:
        where.append("g.related_assignment_id = ?")
        values.append(f.assignment_id)
    if f.origin:
        origin = {"ai-free": "free", "ai-similar": "similar", "teacher": "teacher_test"}[f.origin]
        where.append("g.origin = ?")
        values.append(origin)
    attempts: dict[str, list[int]] = {}
    for row in db.execute("""SELECT item_id, payload_json FROM events WHERE class_id=? AND item_id != ''
                          AND event_type='answer_submitted' AND checked_by='server'""", (class_id,)):
        correct = (_loads(row["payload_json"], {}) or {}).get("correct")
        bucket = attempts.setdefault(row["item_id"], [0, 0])
        bucket[0] += 1
        bucket[1] += int(correct is True)
    out = []
    for row in db.execute(f"SELECT g.* FROM generated_items g WHERE {' AND '.join(where)} ORDER BY g.created_at, g.id", values):
        sid = row["student_id"]
        item = people.scrub(sid, _loads(row["item_json"], {}) or {})
        counts = attempts.get(row["id"], [0, 0])
        out.append({
            "item_id": row["id"], people.student_column: people.ident(sid), "student_label": people.label(sid),
            "section_group": people.group(row["section_group_id"]), "condition_group": people.group(row["condition_group_id"]),
            "origin": row["origin"], "unit_id": row["unit_id"], "related_assignment_id": row["related_assignment_id"],
            "related_question_id": row["related_question_id"], "question_type": row["question_type"], "difficulty": row["difficulty"],
            "requested_type": row["requested_type"], "requested_difficulty": row["requested_difficulty"],
            "focus_note": people.scrub(sid, row["focus_note"]), "source": row["source"], "model": row["model"],
            "ai_call_id": row["ai_call_id"], "policy_version_id": row["policy_version_id"], "novelty_retries": row["novelty_retries"],
            "guard_status": row["guard_status"], "homework_match_assignment_id": row["homework_match_assignment_id"],
            "homework_match_question_id": row["homework_match_question_id"], "homework_match_score": row["homework_match_score"],
            "verification": row["verification"], "client_run_output": row["client_run_output"], "status": row["status"],
            "created_at": row["created_at"], "attempts": counts[0], "correct": counts[1], "item_json": item, "item": item,
            "_student": sid,
        })
    return out


def _item_columns(people: People, fmt: str) -> list[str]:
    cols = [people.student_column if c == "student_id" else c for c in ITEM_COLUMNS]
    return [("item" if c == "item_json" else c) for c in cols] if fmt == "jsonl" else cols


def _coder_roles(db: sqlite3.Connection, class_id: str) -> dict[str, str]:
    """Coder → staff role (SB-M03). Codes store the coder's label (``audit.actor_label``: the staff key's display name, the
    Kiwi username, or ``Instructor (local key)``), so labels resolve as well as staff and Kiwi ids. Revoked staff keep the
    role they had for the codes they wrote."""
    roles = {"instructor": "instructor", "Instructor (local key)": "instructor"}
    for row in db.execute("SELECT id, role, kiwi_user_id, display_name FROM staff WHERE class_id=? "
                          "ORDER BY revoked_at IS NULL, created_at", (class_id,)):
        if row["display_name"]:
            roles[row["display_name"]] = row["role"]
        roles[row["id"]] = row["role"]
        if row["kiwi_user_id"]:
            roles[row["kiwi_user_id"]] = row["role"]
    from server import governance

    for row in db.execute("SELECT * FROM kiwi_staff_seen WHERE class_id=?", (class_id,)):
        role = governance.kiwi_effective_role(row["kiwi_role"], bool(row["can_manage_course"]),
                                              bool(row["can_view_analytics"])) or "staff"
        roles.setdefault(row["kiwi_user_id"], role)
        if row["username"]:
            roles.setdefault(row["username"], roles.get(row["kiwi_user_id"], role))
    return roles


def code_rows(db: sqlite3.Connection, class_id: str, f: Filters, people: People) -> list[dict]:
    pop, pop_values = student_filter("c", db, class_id, f)
    allowed_turns = {r[0]: r[1] for r in db.execute(f"SELECT c.id, c.student_id FROM chat_turns c WHERE c.class_id=? AND {pop}",
                                                    (class_id, *pop_values))}
    pop_e, pop_e_values = student_filter("e", db, class_id, f)
    allowed_native = {r[0]: r[1] for r in db.execute(
        f"SELECT e.id, e.student_id FROM events e WHERE e.class_id=? AND e.source='kiwi' AND {pop_e}", (class_id, *pop_e_values))}
    allowed_students = set(allowed_turns.values()) | set(allowed_native.values())
    labels = {r["id"]: r["label"] for r in db.execute("SELECT id, label FROM codebook_codes WHERE class_id=?", (class_id,))}
    roles = _coder_roles(db, class_id)
    when, when_values = time_filter("created_at", f)
    out = []
    for row in db.execute(f"SELECT * FROM conversation_codes WHERE class_id=? AND deleted_at IS NULL AND {when} ORDER BY id",
                          (class_id, *when_values)):
        key = row["thread_key"]
        if row["chat_turn_id"] is not None:
            if row["chat_turn_id"] not in allowed_turns:
                continue
        elif row["native_event_id"] is not None:
            if row["native_event_id"] not in allowed_native:
                continue
        elif key.startswith("lab:"):
            parts = key.split(":", 2)
            if len(parts) < 3 or parts[1] not in allowed_students:
                continue
        if f.code_id and row["code_id"] != f.code_id:
            continue
        if f.thread_key and key != f.thread_key:
            continue
        out.append({"thread_key": people.thread_key(key), "chat_turn_id": row["chat_turn_id"],
                    "native_event_id": row["native_event_id"], "code_id": row["code_id"],
                    "code_label": labels.get(row["code_id"], row["code_id"]), "coder_role": roles.get(row["coder_id"], ""),
                    "note": people.scrub_roster(row["note"]), "created_at": row["created_at"]})
    return out


# -- teaching exports (§6.8) ----------------------------------------------------------------------
def _export_headers(f: Filters) -> dict[str, str]:
    headers = {"X-Export-Pseudonymized": "1" if f.pseudonymize else "0", "X-Export-Consent": f.consent}
    if f.forced:
        headers["X-Export-Forced"] = f"pseudonymize=1; consent=yes ({f.forced_role or 'viewer'} exports are de-identified)"
    if f.verified_only:
        headers["X-Export-Verified-Only"] = "1"
    return headers


def _strip(row: dict) -> dict:
    return {k: v for k, v in row.items() if not k.startswith("_")}


UNVERIFIED_FOR_ROLE = ("This course is not linked to Kiwi, so student identities are not verified. Exports for your role "
                      "include Kiwi-verified students only; an instructor can export the demo data.")


def teaching_export(req: Request, kind: str, fmt: str) -> Response:
    db, class_id = req.db, req.class_id
    f = parse_filters(req)
    if f.forced_role:
        # RV6-M07, decision D3 and §5.3 footnote 1: viewer and researcher exports are forced to allowUnverified=0 — every
        # export, not only the research package. A standalone (demo) course has no verified identities at all.
        if not identity.class_linked(db, class_id):
            raise ApiError(409, "unverified_identity", UNVERIFIED_FOR_ROLE)
        f.verified_only = True
    people = People(db, class_id, pseudonymize=f.pseudonymize, participants_only=f.consent == "yes")
    if kind == "activity":
        writer = TableWriter(_activity_columns(people), fmt=fmt, teaching=True, numeric=ACTIVITY_NUMERIC)
        for row in activity_rows(db, class_id, f, people):
            writer.add(row)
        name = "activity"
    elif kind == "ai-conversations":
        writer = TableWriter(_ai_columns(people), fmt=fmt, teaching=True, numeric=AI_NUMERIC)
        for row in ai_rows(db, class_id, f, people):
            writer.add(row)
        name = "ai-conversations"
    elif kind == "generated-items":
        writer = TableWriter(_item_columns(people, fmt), fmt=fmt, teaching=True, numeric=ITEM_NUMERIC)
        for row in item_rows(db, class_id, f, people):
            writer.add(row)
        name = "generated-items"
    elif kind == "conversation-codes":
        writer = TableWriter(CODE_COLUMNS, fmt="csv", teaching=True, numeric={"chat_turn_id", "native_event_id"})
        for row in code_rows(db, class_id, f, people):
            writer.add(row)
        name = "conversation-codes"
    else:  # pragma: no cover - routes register known kinds only
        raise ApiError(404, "not_found", "Unknown export")
    content_type = "text/csv; charset=utf-8" if fmt == "csv" else "application/x-ndjson; charset=utf-8"
    return file_response(writer.data(), f"{name}-{class_id}-{_day()}.{fmt}", content_type, writer.rows, _export_headers(f))


# -- student case file (§6.8, PEOPLE-17) ----------------------------------------------------------
SUBMISSION_CASE_COLUMNS = ["submission_id", "student_id", "student", "assignment_id", "assignment", "attempt", "submitted_at",
                           "is_late", "late_seconds", "over_time", "grade_status", "total", "max_points", "feedback",
                           "released_at", "answers_json"]
ITEM_SCORE_CASE_COLUMNS = ["submission_id", "question_id", "answer_text", "auto_correct", "auto_score", "score", "points",
                           "comment", "overridden", "graded_by", "graded_at"]


def _max_points(db: sqlite3.Connection, class_id: str) -> dict[str, tuple[float, dict]]:
    out = {}
    for row in db.execute("SELECT * FROM assignments WHERE class_id=?", (class_id,)):
        rec = readers.record_from_row(row)
        out[rec.id] = (float(sum(float(q.get("points") or 0) for q in rec.questions)),
                       {q.get("id"): float(q.get("points") or 0) for q in rec.questions})
    return out


def case_file(req: Request, student_id: str) -> Response:
    db, class_id = req.db, req.class_id
    purpose = req.q_str("purpose", "", 500).strip()
    if not 5 <= len(purpose) <= 500:
        raise ApiError(400, "invalid_request", "A case file needs a purpose (5–500 characters).")
    assignment_id = req.q_id("assignmentId")
    from server import governance

    if not governance._has_data(db, class_id, student_id):  # noqa: SLF001 - shared existence rule
        raise ApiError(404, "not_found", "No records for this student in this course")
    people = People(db, class_id, pseudonymize=False)
    f = Filters(student_id=student_id, assignment_id=assignment_id, include_staff=True, include_excluded=True, purpose=purpose)
    conversations = TableWriter(AI_COLUMNS, fmt="csv", teaching=True, numeric=AI_NUMERIC)
    for row in ai_rows(db, class_id, f, people):
        conversations.add(row)
    points = _max_points(db, class_id)
    titles = {r["id"]: r["title"] for r in db.execute("SELECT id, title FROM assignments WHERE class_id=?", (class_id,))}
    submissions = TableWriter(SUBMISSION_CASE_COLUMNS, fmt="csv", teaching=True,
                              numeric={"attempt", "is_late", "late_seconds", "over_time", "total", "max_points"})
    scores = TableWriter(ITEM_SCORE_CASE_COLUMNS, fmt="csv", teaching=True,
                         numeric={"auto_correct", "auto_score", "score", "points", "overridden"})
    sql = "SELECT * FROM submissions WHERE class_id=? AND student_id=? AND is_preview=0"
    params: list[object] = [class_id, student_id]
    if assignment_id:
        sql += " AND assignment_id=?"
        params.append(assignment_id)
    label = people.label(student_id)
    for sub in db.execute(sql + " ORDER BY submitted_at, id", params):
        maximum, per_question = points.get(sub["assignment_id"], (0.0, {}))
        answers = _loads(sub["answers_json"], {}) or {}
        submissions.add({"submission_id": sub["id"], "student_id": student_id, "student": label,
                         "assignment_id": sub["assignment_id"], "assignment": titles.get(sub["assignment_id"], ""),
                         "attempt": sub["attempt"], "submitted_at": sub["submitted_at"], "is_late": sub["is_late"],
                         "late_seconds": sub["late_seconds"], "over_time": sub["over_time"], "grade_status": sub["grade_status"],
                         "total": sub["grade"], "max_points": maximum, "feedback": sub["feedback"] or "",
                         "released_at": sub["released_at"], "answers_json": answers})
        for item in db.execute("SELECT * FROM submission_item_scores WHERE submission_id=? ORDER BY question_id", (sub["id"],)):
            scores.add({"submission_id": sub["id"], "question_id": item["question_id"],
                        "answer_text": answers.get(item["question_id"], ""), "auto_correct": item["auto_correct"],
                        "auto_score": item["auto_score"], "score": item["score"], "points": per_question.get(item["question_id"]),
                        "comment": item["comment"], "overridden": item["overridden"], "graded_by": item["graded_by"],
                        "graded_at": item["graded_at"]})
    timeline = TableWriter(ACTIVITY_COLUMNS, fmt="jsonl", teaching=True)
    for row in activity_rows(db, class_id, f, people):
        timeline.add(row)
    from server import audit

    readme = "\n".join([
        f"# Case file — {label}", "",
        f"- Course: {class_id}", f"- Student ID: {student_id}", f"- Purpose: {purpose}",
        f"- Exported by: {audit.actor_label(req.identity)} ({req.identity.actor_role})", f"- Exported at: {dbmod.now()}",
        f"- Assignment filter: {assignment_id or 'all assignments'}", f"- App version: {APP_VERSION}", "",
        "This file contains names and is for course staff only. Files:",
        "- `ai_conversations.csv` — every Lab AI tutor and Kiwi lecture AI turn of this student",
        "- `submissions.csv` and `item_scores.csv` — answers, scores, comments and feedback",
        "- `timeline.jsonl` — every recorded event of this student, in time order",
        "Teaching CSVs start with a UTF-8 byte order mark and neutralize cells a spreadsheet could read as formulas.", ""])
    spool = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    with zipfile.ZipFile(spool, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("README.md", readme)
        archive.writestr("ai_conversations.csv", conversations.data())
        archive.writestr("submissions.csv", submissions.data())
        archive.writestr("item_scores.csv", scores.data())
        archive.writestr("timeline.jsonl", timeline.data())
    rows = conversations.rows + submissions.rows + scores.rows + timeline.rows
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", student_id)
    return file_response(spool, f"case-file-{safe}-{_day()}.zip", "application/zip", rows)


# -- research package (§13.6) ---------------------------------------------------------------------
def git_sha() -> str:
    env = os.environ.get("KIWI_GIT_SHA", "").strip()
    if env:
        return env[:64]
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=3, check=False)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    sha = out.stdout.strip()
    return sha if out.returncode == 0 and re.fullmatch(r"[0-9a-f]{7,64}", sha) else "unknown"


def outage_periods(db: sqlite3.Connection, class_id: str, f: Filters) -> list[str]:
    """Service incidents (server errors, Kiwi unreachable) merged into periods of consecutive minutes."""
    clauses, values = ["class_id = ?"], [class_id]
    if f.start:
        clauses.append("minute >= ?")
        values.append(f.start[:16])
    if f.end:
        clauses.append("minute < ?")
        values.append(f.end[:16])
    periods: list[list] = []
    for row in db.execute(f"SELECT minute, kind, count FROM service_incidents WHERE {' AND '.join(clauses)} ORDER BY kind, minute",
                          values):
        moment = dbmod.parse_iso(row["minute"] + ":00+00:00")
        if periods and periods[-1][2] == row["kind"] and moment - periods[-1][1] <= timedelta(minutes=1):  # type: ignore[operator]
            periods[-1][1] = moment
            periods[-1][3] += int(row["count"])
        else:
            periods.append([moment, moment, row["kind"], int(row["count"])])
    gaps = 0
    when, when_values = time_filter("created_at", f)
    for row in db.execute(f"SELECT payload_json FROM events WHERE class_id=? AND event_type='telemetry_gap' AND {when}",
                          (class_id, *when_values)):
        gaps += int((_loads(row["payload_json"], {}) or {}).get("droppedCount") or 0)
    lines = [f"{p[0].isoformat()} – {(p[1] + timedelta(minutes=1)).isoformat()} · {p[2]} ({p[3]})" for p in periods]
    if gaps:
        lines.append(f"Client outboxes reported {gaps} dropped events (telemetry_gap) in this range")
    return lines


def participant_rows(db: sqlite3.Connection, class_id: str, f: Filters) -> list[sqlite3.Row]:
    """Enrolled roster students (§5.4 population: active, not excluded; linked: Kiwi students who are not staff)."""
    sql = "SELECT r.* FROM roster r WHERE r.class_id = ? AND r.status = 'active' AND r.excluded = 0"
    values: list[object] = [class_id]
    if identity.class_linked(db, class_id):
        sql += (" AND r.source = 'kiwi' AND NOT EXISTS (SELECT 1 FROM kiwi_staff_seen k WHERE k.class_id = r.class_id"
                " AND k.kiwi_user_id = r.student_id)")
    if f.consent == "yes":
        sql += " AND (r.consent_override = 'yes' OR (r.consent_override IS NULL AND r.kiwi_consent = 1))"
    if f.group_ids:
        sql += (f" AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.class_id = r.class_id AND gm.student_id = r.student_id"
                f" AND gm.group_id IN ({','.join('?' for _ in f.group_ids)}))")
        values.extend(f.group_ids)
    return db.execute(sql + " ORDER BY r.pseudonym_seq, r.student_id", values).fetchall()


def _write(archive: zipfile.ZipFile, manifest: list[dict], name: str, data: bytes, rows: int) -> None:
    archive.writestr(name, data)
    manifest.append({"name": name, "rows": rows, "sha256": hashlib.sha256(data).hexdigest()})


def research_package(req: Request) -> Response:
    db, class_id, ident = req.db, req.class_id, req.identity
    f = parse_filters(req, research=True)
    f.include_staff = False
    allow_unverified = req.q_bool("allowUnverified") and ident.staff_role not in auth.PSEUDONYMOUS_EXPORT_ROLES
    include_raw = req.q_bool("includeRaw") and ident.staff_role == "instructor"
    if not 5 <= len(f.purpose) <= 500:
        raise ApiError(400, "invalid_request", "Every research package needs a purpose (5–500 characters).")
    if f.consent == "all" and not f.pseudonymize:
        raise ApiError(409, "consent_required", "Exporting students without research consent requires pseudonymize=1.")
    linked = identity.class_linked(db, class_id)
    if not linked and not allow_unverified:
        # SB-m02: roles that cannot use allowUnverified get advice they can follow
        if ident.staff_role in auth.PSEUDONYMOUS_EXPORT_ROLES:
            raise ApiError(409, "unverified_identity", UNVERIFIED_FOR_ROLE)
        raise ApiError(409, "unverified_identity",
                       "This course is not linked to Kiwi, so student identities are not verified. Add allowUnverified=1 "
                       "to export demo data.")
    f.verified_only = linked and not allow_unverified
    settings = readers.settings(db, class_id)
    people = People(db, class_id, pseudonymize=f.pseudonymize, research=True, participants_only=f.consent == "yes")
    manifest_files: list[dict] = []
    counts: dict[str, int] = {}
    export_id = uuid.uuid4().hex
    generated_at = dbmod.now()

    # participants: enrolled students (population rules) after the consent and group filters
    roster_rows = participant_rows(db, class_id, f)
    participants = {r["student_id"]: r for r in roster_rows}
    activity = list(activity_rows(db, class_id, f, people))
    activity = [r for r in activity if r["_student"] in participants]
    spans: dict[str, list[str]] = {}
    for row in activity:
        span = spans.setdefault(row["_student"], [row["occurred_at"], row["occurred_at"]])
        span[1] = row["occurred_at"]
    current = roster.memberships(db, class_id)
    cols = list(PARTICIPANT_COLUMNS) + ([] if f.pseudonymize else ["student_id", "label"])
    part_writer = TableWriter(cols, fmt="csv", teaching=False)
    for sid, row in participants.items():
        groups = {g["kind"]: g["name"] for g in current.get(sid, []) if g["kind"] in ("section", "condition")}
        part_writer.add({"research_id": people.rid(sid), "section_group": groups.get("section", ""),
                         "condition_group": groups.get("condition", ""), "consent_state": identity.consent_state(row),
                         "roster_status": row["status"], "identity_verified": int(linked and row["source"] == "kiwi"),
                         "first_activity_at": spans.get(sid, [None, None])[0], "last_activity_at": spans.get(sid, [None, None])[1],
                         "student_id": sid, "label": identity.label(db, class_id, sid, "names")})
    events_writer = TableWriter(_activity_columns(people), fmt="csv", teaching=False)
    for row in activity:
        events_writer.add({**row, "payload_json": json.dumps(row["payload_json"], ensure_ascii=False, sort_keys=True),
                           "truncated_fields": json.dumps(row["truncated_fields"], sort_keys=True)})
    turns = [r for r in ai_rows(db, class_id, f, people) if r["_student"] in participants]
    turns_writer = TableWriter(_ai_columns(people), fmt="csv", teaching=False)
    for row in turns:
        turns_writer.add(row)
    # ai_calls incl. failures
    call_cols = AI_CALL_COLUMNS + (["developer_text", "raw_output"] if include_raw else [])
    calls_writer = TableWriter(call_cols, fmt="csv", teaching=False)
    pop_a, pop_a_values = student_filter("a", db, class_id, f)
    when_a, when_a_values = time_filter("a.requested_at", f)
    referenced_policies: set[int] = set()
    for call in db.execute(f"SELECT a.* FROM ai_calls a WHERE a.class_id=? AND {pop_a} AND {when_a} ORDER BY a.requested_at, a.id",
                           (class_id, *pop_a_values, *when_a_values)):
        if call["student_id"] not in participants or (f.unit_ids and call["unit_id"] not in f.unit_ids):
            continue
        if call["policy_version_id"]:
            referenced_policies.add(int(call["policy_version_id"]))
        calls_writer.add({**{c: call[c] for c in AI_CALL_COLUMNS if c in call.keys()}, "research_id": people.rid(call["student_id"]),
                          "section_group": people.group(call["section_group_id"]),
                          "condition_group": people.group(call["condition_group_id"]),
                          "developer_text": people.scrub(call["student_id"], call["developer_text"]),
                          "raw_output": people.scrub(call["student_id"], call["raw_output"])})
    history_writer = TableWriter(GROUP_HISTORY_COLUMNS, fmt="csv", teaching=False)
    for row in db.execute("SELECT * FROM group_membership_history WHERE class_id=? ORDER BY valid_from, id", (class_id,)):
        if row["student_id"] in participants:
            history_writer.add({"research_id": people.rid(row["student_id"]), "kind": row["kind"], "group": people.group(row["group_id"]),
                                "method": row["method"], "seed": row["seed"], "valid_from": row["valid_from"], "valid_to": row["valid_to"]})
    points = _max_points(db, class_id)
    sub_writer = TableWriter(SUBMISSION_RESEARCH_COLUMNS, fmt="csv", teaching=False)
    score_writer = TableWriter(ITEM_SCORE_COLUMNS, fmt="csv", teaching=False)
    pop_s, pop_s_values = student_filter("s", db, class_id, f)
    when_s, when_s_values = time_filter("s.submitted_at", f)
    referenced_versions: set[tuple[str, int]] = {(r["assignment_id"], int(r["assignment_version"])) for r in activity
                                                 if r["assignment_id"] and r["assignment_version"]}
    # WHY: rows written before 0.6.0 carry no assignment_version; export the latest snapshot of those assignments.
    unversioned: set[str] = {r["assignment_id"] for r in activity if r["assignment_id"] and not r["assignment_version"]}
    for sub in db.execute(f"SELECT s.* FROM submissions s WHERE s.class_id=? AND {pop_s} AND {when_s} ORDER BY s.submitted_at, s.id",
                          (class_id, *pop_s_values, *when_s_values)):
        if sub["student_id"] not in participants:
            continue
        maximum, per_question = points.get(sub["assignment_id"], (0.0, {}))
        if sub["assignment_version"]:
            referenced_versions.add((sub["assignment_id"], int(sub["assignment_version"])))
        else:
            unversioned.add(sub["assignment_id"])
        sub_writer.add({"submission_id": sub["id"], "research_id": people.rid(sub["student_id"]),
                        "section_group": people.group(sub["section_group_id"]), "condition_group": people.group(sub["condition_group_id"]),
                        "assignment_id": sub["assignment_id"], "assignment_version": sub["assignment_version"], "attempt": sub["attempt"],
                        "submitted_at": sub["submitted_at"], "is_late": sub["is_late"], "late_seconds": sub["late_seconds"],
                        "over_time": sub["over_time"], "time_used_seconds": sub["time_used_seconds"],
                        "grade_status": sub["grade_status"], "total": sub["grade"], "max_points": maximum,
                        "adjustment_points": sub["adjustment_points"], "released_at": sub["released_at"]})
        answers = _loads(sub["answers_json"], {}) or {}
        for item in db.execute("SELECT * FROM submission_item_scores WHERE submission_id=? ORDER BY question_id", (sub["id"],)):
            score_writer.add({"submission_id": sub["id"], "question_id": item["question_id"],
                              "answer_text": people.scrub(sub["student_id"], answers.get(item["question_id"], "")),
                              "auto_correct": item["auto_correct"], "auto_score": item["auto_score"], "score": item["score"],
                              "points": per_question.get(item["question_id"]), "overridden": item["overridden"],
                              "graded_at": item["graded_at"]})
    items_writer = TableWriter(_item_columns(people, "jsonl"), fmt="jsonl", teaching=False)
    for row in item_rows(db, class_id, f, people):
        if row["_student"] in participants:
            if row["policy_version_id"]:
                referenced_policies.add(int(row["policy_version_id"]))
            items_writer.add(row)
    for row in turns:
        if row["policy_version_id"]:
            referenced_policies.add(int(row["policy_version_id"]))
    policy_writer = TableWriter(["id", "scope", "unit_id", "group", "version", "config", "config_hash", "note", "restored_from",
                                 "created_by_role", "created_at"], fmt="jsonl", teaching=False)
    when_p, when_p_values = time_filter("created_at", f)
    for row in db.execute(f"SELECT * FROM policy_versions WHERE class_id=? ORDER BY id", (class_id,)):
        in_range = db.execute(f"SELECT 1 FROM policy_versions WHERE id=? AND {when_p}", (row["id"], *when_p_values)).fetchone()
        if row["id"] in referenced_policies or in_range:
            policy_writer.add({"id": row["id"], "scope": row["scope"], "unit_id": row["unit_id"], "group": people.group(row["group_id"]),
                               "version": row["version"], "config": _loads(row["config_json"], {}), "config_hash": row["config_hash"],
                               "note": row["note"], "restored_from": row["restored_from"], "created_by_role": row["created_by_role"],
                               "created_at": row["created_at"]})
    assignment_writer = TableWriter(["assignment_id", "version", "reason", "created_at", "snapshot"], fmt="jsonl", teaching=False)
    latest_versions = {r[0]: int(r[1]) for r in db.execute(
        "SELECT assignment_id, MAX(version) FROM assignment_versions WHERE class_id=? GROUP BY assignment_id", (class_id,))}
    referenced_versions |= {(aid, latest_versions[aid]) for aid in unversioned if aid in latest_versions}
    for row in db.execute("SELECT * FROM assignment_versions WHERE class_id=? ORDER BY assignment_id, version", (class_id,)):
        if (row["assignment_id"], int(row["version"])) in referenced_versions:
            assignment_writer.add({"assignment_id": row["assignment_id"], "version": row["version"], "reason": row["reason"],
                                   "created_at": row["created_at"], "snapshot": _loads(row["snapshot_json"], {})})
    native_writer = TableWriter(NATIVE_RESPONSE_COLUMNS, fmt="csv", teaching=False)
    native_ids = {r["native_event_id"]: r["_student"] for r in turns if r["native_event_id"]}
    for row in db.execute("SELECT * FROM ai_responses WHERE class_id=? ORDER BY responded_at", (class_id,)):
        if row["event_id"] in native_ids:
            native_writer.add({"upstream_action_id": row["upstream_action_id"], "upstream_interaction_id": row["upstream_interaction_id"],
                               "native_event_id": row["event_id"], "action_type": row["action_type"],
                               "engine_choice": row["engine_choice"],
                               "response": people.scrub(native_ids[row["event_id"]], row["bot_response"]),
                               "truncated": row["truncated"], "responded_at": row["responded_at"]})
    code_writer = TableWriter(["thread_key", "chat_turn_id", "native_event_id", "code_label", "coder_role", "note", "created_at"],
                              fmt="csv", teaching=False)
    for row in code_rows(db, class_id, Filters(start=f.start, end=f.end, consent=f.consent, group_ids=f.group_ids,
                                               verified_only=f.verified_only), people):
        code_writer.add(row)
    files = [("participants.csv", part_writer), ("events.csv", events_writer), ("ai_turns.csv", turns_writer),
             ("ai_calls.csv", calls_writer), ("group_history.csv", history_writer), ("submissions.csv", sub_writer),
             ("item_scores.csv", score_writer), ("generated_items.jsonl", items_writer),
             ("policy_versions.jsonl", policy_writer), ("assignments.jsonl", assignment_writer),
             ("native_ai_responses.csv", native_writer), ("conversation_codes.csv", code_writer)]
    for name, writer in files:
        counts[name] = writer.rows
    from server import ai_policy, audit

    privacy = settings["privacy"]
    excluded_not_enrolled = 0
    try:
        row = db.execute("SELECT excluded_not_enrolled FROM kiwi_sync WHERE class_id=?", (class_id,)).fetchone()
        excluded_not_enrolled = int(row[0]) if row and row[0] is not None else 0
    except sqlite3.Error:
        excluded_not_enrolled = 0
    legacy = db.execute("SELECT COUNT(*), SUM(rejudged_correct IS NOT NULL) FROM events WHERE class_id=? AND checked_by='legacy_server'",
                        (class_id,)).fetchone()
    outages = outage_periods(db, class_id, f)
    sha = git_sha()
    readme_lines = [
        f"# CSS Lab research package — {class_id}", "",
        "DEMO DATA — identities not verified" if not linked or allow_unverified else "Identities verified by Kiwi (linked course).",
        "",
        f"- App version: {APP_VERSION}", f"- Git commit: {sha}", f"- Export id: {export_id}", f"- Generated at: {generated_at}",
        f"- Exported by: {audit.actor_label(ident)} ({ident.actor_role})",
        f"- Purpose: {f.purpose}", f"- Research purpose (privacy settings): {privacy.get('researchPurpose') or '(not provided)'}",
        f"- IRB protocol: {privacy.get('irbProtocol') or '(not provided)'}",
        f"- Consent filter: {'only students with research consent (yes)' if f.consent == 'yes' else 'all students (pseudonymized)'}",
        f"- Pseudonymization: {'research ids only' if f.pseudonymize else 'research ids; participants.csv also lists student ids and names'}",
        f"- Identity verification: {'unverified rows included (allowUnverified=1)' if allow_unverified else 'verified rows only'}",
        f"- Platform rules version: {ai_policy.PLATFORM_RULES_VERSION}",
        f"- Event schema version: {event_schema.SCHEMA_VERSION}; package format version 1",
        f"- Raw AI text (developer_text, raw_output): {'included' if include_raw else 'not included'}",
        f"- Filters: {json.dumps(f.public(), sort_keys=True)}", "",
        "## Row counts", *[f"- `{name}`: {n}" for name, n in counts.items()], "",
        "## Files", "Research files are UTF-8 without a byte order mark and without formula neutralization — open them with a CSV "
        "parser, not a spreadsheet. `codebook.md` documents every column, event type and metric.", "",
        "## Limitations",
        "- R output is produced in the student's browser (webR); correctness based on it has `basis=client_run_output`.",
        "- Standalone (demo) courses have unverified identities (`identity_verified=0`).",
        f"- Rows from before 0.6.0: {legacy[0] or 0} legacy auto-checks (`checked_by=legacy_server`), "
        f"{int(legacy[1] or 0)} re-judged with the current rules (`rejudged_correct`).",
        "- Deprecated event types (v1 clients) are documented in the codebook.",
        f"- Kiwi activity of students no longer enrolled is not exported ({excluded_not_enrolled} records excluded by the bridge).",
        "- The final-answer guard can miss paraphrased answers.", "",
        "## Outage periods in range", *([f"- {line}" for line in outages] or ["- none recorded"]), ""]
    readme = "\n".join(readme_lines).encode("utf-8")
    codebook = codebook_md().encode("utf-8")
    spool = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    with zipfile.ZipFile(spool, "w", zipfile.ZIP_DEFLATED) as archive:
        _write(archive, manifest_files, "README.md", readme, 0)
        _write(archive, manifest_files, "codebook.md", codebook, 0)
        for name, writer in files:
            _write(archive, manifest_files, name, writer.data(), writer.rows)
        manifest = {"format": "css-lab-research-package", "formatVersion": 1, "appVersion": APP_VERSION, "gitSha": sha,
                    "exportId": export_id, "generatedAt": generated_at, "filters": f.public(), "pseudonymized": f.pseudonymize,
                    "consentFilter": f.consent, "identityVerified": not (not linked or allow_unverified), "files": manifest_files}
        archive.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
    total = sum(counts.values())
    return file_response(spool, f"research-package-{class_id}-{_day()}.zip", "application/zip", total, _export_headers(f))


# -- codebook (§13.8) -----------------------------------------------------------------------------
TABLE_DICTIONARY: dict[str, dict[str, str]] = {
    "activity / events.csv": {
        "event_id": "Client UUID (or server uuid) of the event; `row-<n>` for legacy rows without one",
        "student_id | research_id": "Course student id (teaching exports) or HMAC research id `P…` (pseudonymized and research files)",
        "student_label": "Display label at export time (research files: the research id)",
        "section_group, condition_group": "Group names at event time (stamped when the row was written)",
        "occurred_at": "When it happened (client time clamped to ±5 min of receipt for v2 events; ms precision UTC)",
        "received_at": "When the server stored it", "event_type": "Event type (section 4)",
        "schema_version": "1 = v0.5 client body, 2 = v0.6 envelope", "where": "`lab` (CSS Lab) or `kiwi` (imported from Kiwi)",
        "surface": "UI surface", "practice_mode": "homework | in-class | similar | free | workspace | lecture | kiwi | other",
        "unit_id": "Chapter id", "assignment_id": "Teacher assignment the activity is attributed to",
        "assignment_version": "Assignment version at the time (settings and questions)",
        "related_assignment_id": "Parent homework of a similar-practice item", "question_id": "Question or item id",
        "item_id": "Generated item id (`gi-…`)", "question_activity_id": "Derived question-activity (session) id",
        "study_session_index": "Per student: a new study session starts after ≥ 30 min without exported events",
        "actor_role": "student | demo | preview | instructor | ta | viewer | researcher | staff | unknown (informational; population is decided at query time)",
        "checked_by": "`server` (checked by the Lab server), `legacy_server` (v0.5 server rules), `client` (browser-reported, excluded from default metrics)",
        "correct": "1/0 for checked attempts, empty when not checkable",
        "rejudged_correct": "Legacy v0.5 checks re-judged with the current rules (empty = not re-judged)",
        "policy_version_id": "AI tutor rule version that applied", "ai_call_id": "Row in ai_calls", "chat_turn_id": "Row in chat_turns",
        "truncated_fields": "{field: original length} for fields cut to their limits", "payload_json": "Event payload (section 4)",
    },
    "ai-conversations / ai_turns.csv": {
        "chat_turn_id, native_event_id": "Lab AI tutor turn id, or the Kiwi lecture AI event id",
        "thread_key": "`lab:<student>:<thread>` (Lab, student part replaced by the research id in research files) or `kiwi:<conversationId>`",
        "where": "`lab` or `kiwi`", "prompt, response": "Student prompt and the reply shown (after the final-answer guard)",
        "ai_provider": "openai | local (fixed local guidance) | kiwi-native — kept separate from `where`/`source`",
        "model": "Model name used for the reply", "policy_label": "Human-readable rule version, e.g. `Ch 03 rules v4`",
        "guard_status": "Final-answer guard result (section 8)", "flagged, flag_source": "Flag state and who set it (`guard` or `staff`)",
        "homework_match_assignment_id, homework_match_score": "Protected homework matched by containment",
        "input_tokens, output_tokens, reasoning_tokens, latency_ms": "Provider usage and latency",
        "context_json": "Learning context sent with the request (field-truncated)",
        "native_feedback": "Kiwi thumbs/flag feedback on the conversation: JSON array of {value, reply, at}",
        "codes": "Qualitative codes applied (labels; see conversation_codes.csv)",
    },
    "ai_calls.csv": {
        "request_id": "Unique request id", "action": "chat | question | similar | feedback | test_*", "status": "Call status (section 8)",
        "error_code": "Error code of failed calls", "policy_source": "unit-group | unit | course-group | course | platform",
        "platform_rules_version": "Version of the always-applied platform rules", "prompt_hash": "SHA-256 of the assembled request",
        "queue_ms, latency_ms": "Queue wait and provider latency", "homework_match_jaccard": "Symmetric Jaccard (research only)",
        "developer_text, raw_output": "Instructions sent and the original reply (only with includeRaw=1)",
    },
    "participants.csv": {
        "research_id": "HMAC-SHA256(course salt, class:student) base32, 10 chars, prefixed `P`; stable per course, never shown on screen",
        "consent_state": "yes | no | not_asked (teacher override, else Kiwi `User.consent`)", "roster_status": "active | dropped",
        "identity_verified": "1 when the identity came from Kiwi (linked course)",
        "first_activity_at, last_activity_at": "First/last exported event in range",
    },
    "group_history.csv": {"kind": "section | condition | cohort", "method": "manual | import | random | selection",
                          "seed": "Seed of random assignment (sha256-sort-v1)", "valid_from, valid_to": "Membership period (empty = current)"},
    "submissions.csv / item_scores.csv": {
        "attempt": "Attempt number per student and assignment", "is_late, late_seconds": "Late relative to the due date + grace",
        "over_time, time_used_seconds": "Timed homework", "grade_status": "ungraded | draft | released",
        "total, max_points, adjustment_points": "Total score (items + adjustment, clamped)", "auto_correct, auto_score": "Server auto-check",
        "score, overridden": "Score given by staff; overridden = differs from the auto score",
    },
    "generated_items.jsonl": {
        "origin": "free | similar | teacher_test", "source": "ai | local_template | teacher_bank",
        "verification": "unverified | verified | mismatch | not_applicable (client webR check)",
        "status": "active | flagged | retired | rejected_*", "attempts, correct": "Server-checked attempts on the item",
        "item": "Full item incl. answer and explanation",
    },
}

METRIC_FORMULAS = [
    ("Enrolled", "active, non-excluded roster students (linked courses: Kiwi students who are not course staff)"),
    ("Active (range)", "enrolled students with ≥ 1 action-category event in the range"),
    ("Active minutes", "counted heartbeats × 0.5 (one per 30 s bucket per student)"),
    ("Auto-checked accuracy (your questions)", "server-checked correct ÷ server-checked attempts on teacher-authored questions; "
     "legacy v0.5 checks count only with `rejudged_correct`"),
    ("Similar practice accuracy (AI)", "server-checked correct ÷ checked attempts on similar items"),
    ("Client-reported accuracy (legacy)", "clientCorrect ÷ clientChecked (research preset only)"),
    ("First try correct %", "students whose first server-checked attempt is correct ÷ students with ≥ 1 checked attempt"),
    ("Mean tries to correct", "mean attempt index of the first correct attempt among students who got it right"),
    ("AI tutor questions (incl. hints)", "Lab chat_turns + Kiwi native ai_question + legacy hint_requested"),
    ("Logged actions", "action-category events (attempts, runs, AI questions, submissions, generations, installs, file loads)"),
    ("AI requests turned away / failed", "ai_calls by status (section 8)"),
    ("Per active student", "every per-active-student metric divides by Active (range) and states Active and Enrolled"),
]


def codebook_md() -> str:
    lines = [
        "# CSS Lab research codebook", "",
        f"App version {APP_VERSION} · event schema version {event_schema.SCHEMA_VERSION} · generated from `server/event_schema.py`.", "",
        "## 1 Overview & data provenance", "",
        "- **Server-written** rows (AI turns, generated items, server checks, grades) are the source of truth; client-written "
        "rows are kept but flagged.",
        "- `checked_by`: `server` (Lab server judged the answer), `legacy_server` (v0.5 server rules; see `rejudged_correct`), "
        "`client` (browser-reported, excluded from default metrics). `_clientReported` in payloads marks client copies of "
        "server-owned events.",
        "- `identity_verified`: 1 for identities verified through Kiwi; standalone (demo) rows are 0.",
        "- `actor_role` marks staff and preview rows; Preview as student traffic (`is_preview=1`, ids `preview-…`) is never exported.",
        "- `source` / `where`: **where** the activity happened (`lab` = CSS Lab, `kiwi` = imported from Kiwi). It is "
        "separate from the AI provider (`ai_provider`: openai | local | kiwi-native) and the `model`.", "",
        "## 2 Identifiers", "",
        "- `research_id`: `P` + base32(HMAC-SHA256(course salt, `<class>:<student>`))[:10]; the salt never leaves the server.",
        "- Thread keys: `lab:<student>:<thread>` (Lab AI tutor) and `kiwi:<conversationId>` (Kiwi lecture AI).",
        "- Question ids belong to their assignment; generated items use `gi-…`; Kiwi native feedback joins by "
        "(conversationId, message index).", "",
        "## 3 Time", "",
        "- `occurred_at` (client time, clamped to the receipt time ± 5 min for v2 events) and `received_at` (server time), "
        "ISO-8601 UTC with milliseconds.",
        "- Range filters use second-precision bounds, `to` exclusive; course display time zone comes from Course settings.",
        "- Time-range presets: This class, Since last class, This week, Last 7 days, Whole term, Custom (§13.0).", "",
        "## 4 Event types", "",
    ]
    for name, spec in sorted(event_schema.REGISTRY.items()):
        lines += [f"### `{name}`", "", spec.get("description", ""), "",
                  f"- Version {spec.get('version')} · category `{spec.get('category')}` · emitter `{spec.get('emitter')}`"
                  + (" · server-owned" if spec.get("server_owned") else "")
                  + (f" · deprecated since {spec['deprecated_since']}" if spec.get("deprecated_since") else ""), ""]
        if spec.get("fields"):
            lines += ["| Field | Type | Description | Free text |", "|---|---|---|---|"]
            limits = spec.get("limits") or {}
            for field_name, (kind, description, free_text) in spec["fields"].items():
                limit = f" (≤ {limits[field_name]:,} chars, truncated beyond)" if field_name in limits else ""
                lines.append(f"| `{field_name}` | {kind} | {description}{limit} | {'yes' if free_text else 'no'} |")
            lines.append("")
        else:
            lines += ["No documented fields (legacy rows keep their v0.5 payload).", ""]
    lines += ["## 5 Tables & columns", ""]
    for table, columns in TABLE_DICTIONARY.items():
        lines += [f"### {table}", "", "| Column | Meaning |", "|---|---|"]
        lines += [f"| `{column}` | {meaning} |" for column, meaning in columns.items()]
        lines.append("")
    lines += [
        "## 6 Practice modes, surfaces, origins", "",
        "- `practice_mode`: homework, in-class (teacher-authored), similar (AI item derived from a homework question), free "
        "(free practice with AI), workspace (R workspace), lecture / kiwi (Kiwi), other.",
        "- Origins: teacher (your questions), ai-free, ai-similar. Homework-derived items withhold explanations while the "
        "homework is protected.", "",
        "## 7 Groups & conditions", "",
        "- Section and condition ids are stamped on every row at write time; `group_history.csv` reconstructs membership "
        "over time. Cohorts are ad-hoc targeting groups, not experimental conditions.", "",
        "## 8 AI provenance", "",
        "- Every Lab AI call records the policy version, platform rules version, model, tokens, latency and guard status.",
        "- Guard statuses: not_applicable, clean, retried_clean, redacted, blocked; the deterministic rules R1–R5 compare "
        "replies with protected homework answers.",
        "- ai_calls status values cover ok, failures and turned-away requests; `ai_request_unreached` events record "
        "requests that never reached the server.", "",
        "## 9 Metric formulas", "",
        *[f"- **{name}**: {formula}" for name, formula in METRIC_FORMULAS], "",
        "## 10 Known limitations", "",
        "- R output provenance: correctness based on browser output is `client_run_output`.",
        "- Standalone identities are not verified.",
        "- Legacy rows before 0.6.0 (incl. `legacy_server` checks; only re-judged ones count) and deprecated event types.",
        "- Kiwi enrollment-time filtering: activity of students no longer enrolled is not imported (`excludedNotEnrolled`).",
        "- The guard can miss paraphrases; outage periods are listed in the README of each package.", "",
        "## 11 Schema changelog", "",
        "- 0.6.0: event envelope v2 (event_id, received_at, surface, actor_role, practice_mode, attribution, group stamps, "
        "truncation flags), server-owned events, research package format 1.",
        "- 0.5.x: schema version 1 client events.", "",
    ]
    return "\n".join(lines)
