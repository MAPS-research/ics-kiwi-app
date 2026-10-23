"""Roster, student search and student profiles (owned by PEOPLE; spec §6.8, §9.7, §14.1–14.2).

Every roster write goes through ``identity.ensure_roster`` (explicit columns, ``source`` never downgraded); names are
resolved at read time through ``identity.labels`` so Presentation mode (``pseudonyms``) never sees a name or email.
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any, Iterable
from urllib.parse import quote, urlencode

from server import db as dbmod
from server import identity, readers
from server.router import ApiError, valid_id

MAX_IMPORT_ROWS = 500
SEARCH_LIMIT = 10
NAME_MAX = 100
EMAIL_RE = re.compile(r"^[^@\s]{1,100}@[^@\s]{1,100}$")
ROSTER_PATCH_KEYS = {"displayName", "status", "excluded", "consentOverride"}


# -- legacy import (v0.5.1 contract, §6.9) --------------------------------------------------------
def import_roster(db: sqlite3.Connection, class_id: str, data: object, valid_id) -> dict:  # noqa: ANN001 - legacy signature
    """Legacy ``POST /api/teacher/roster`` ``{students: [{studentId, studentName}]}`` → upsert display names."""
    if not isinstance(data, dict) or not isinstance(data.get("students"), list) or not 1 <= len(data["students"]) <= 500:
        raise ValueError("Import 1–500 students at a time")
    rows = []
    for row in data["students"]:
        if not isinstance(row, dict) or not valid_id(row.get("studentId")):
            raise ValueError("Invalid student ID")
        name = row.get("studentName")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
            raise ValueError("Student name must contain 1–100 characters")
        rows.append((row["studentId"], name.strip()))
    with dbmod.write_tx(db):
        for student_id, name in rows:
            email = name if "@" in name else ""
            identity.ensure_roster(db, class_id, student_id, source="import", display_name="" if email else name,
                                   kiwi_email=email)
            if not email:
                db.execute("UPDATE roster SET student_name=? WHERE class_id=? AND student_id=?", (name, class_id, student_id))
    return {"count": len(rows)}


# -- shared reads ---------------------------------------------------------------------------------
def pseudonym(class_id: str, student_id: str, seq: object) -> str:
    return identity._pseudonym(class_id, student_id, seq)  # noqa: SLF001 - one formatting rule (§5.4)


def listed_rows(db: sqlite3.Connection, class_id: str) -> list[sqlite3.Row]:
    """Roster rows shown on Students pages: linked classes hide activity-only identities and Kiwi course staff."""
    if identity.class_linked(db, class_id):
        return db.execute(
            """SELECT * FROM roster r WHERE r.class_id=? AND r.source IN ('kiwi','import')
            AND NOT EXISTS (SELECT 1 FROM kiwi_staff_seen k WHERE k.class_id=r.class_id AND k.kiwi_user_id=r.student_id)
            ORDER BY r.pseudonym_seq, r.student_id""", (class_id,)).fetchall()
    return db.execute("SELECT * FROM roster WHERE class_id=? ORDER BY pseudonym_seq, student_id", (class_id,)).fetchall()


def group_names(db: sqlite3.Connection, class_id: str) -> dict[str, str]:
    """Every group id → name (archived names kept, §13.6)."""
    return {r["id"]: r["name"] for r in db.execute("SELECT id, name FROM course_groups WHERE class_id=?", (class_id,))}


def memberships(db: sqlite3.Connection, class_id: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for row in db.execute(
        """SELECT m.student_id, m.kind, m.group_id, g.name FROM group_members m JOIN course_groups g ON g.id=m.group_id
        WHERE m.class_id=? AND g.archived_at IS NULL ORDER BY CASE m.kind WHEN 'section' THEN 0 WHEN 'condition' THEN 1
        ELSE 2 END, g.name""", (class_id,)):
        out.setdefault(row["student_id"], []).append({"kind": row["kind"], "groupId": row["group_id"], "name": row["name"]})
    return out


def _homework(db: sqlite3.Connection, class_id: str) -> list:
    rows = db.execute(
        """SELECT * FROM assignments WHERE class_id=? AND kind='homework' AND status='published' AND archived_at IS NULL
        AND deleted_at IS NULL ORDER BY COALESCE(due_at, created_at), id""", (class_id,)).fetchall()
    return [readers.record_from_row(r) for r in rows]


def missing_items(db: sqlite3.Connection, class_id: str, student_ids: Iterable[str]) -> dict[str, list]:
    """Missing work per student (``analytics.missing_work``, decision D8): the rule of Home, Needs attention, the student
    profile, the Activity explorer and the status CSV — a homework and its revisions count once."""
    from server import analytics

    ids = list(student_ids)
    missing = analytics.missing_work(db, class_id, ids, dbmod.utcnow())
    return {sid: missing.get(sid, []) for sid in ids}


def _activity(db: sqlite3.Connection, class_id: str) -> dict:
    """B-m01: ``analytics.activity_stamps`` (last seen and last learning action), shared with Needs attention."""
    from server import analytics

    return analytics.activity_stamps(db, class_id)


def _activities(db: sqlite3.Connection, class_id: str) -> dict[str, int]:
    return {r[0]: int(r[1]) for r in db.execute(
        "SELECT studentId, COUNT(*) FROM learning_sessions WHERE classId=? AND isPreview=0 GROUP BY studentId", (class_id,))}


def consent_source(row: sqlite3.Row | dict) -> str:
    if row["consent_override"] in ("yes", "no"):
        return "teacher"
    if row["kiwi_consent"] is not None:
        return "kiwi"
    return "none"


def entries(db: sqlite3.Connection, class_id: str, rows: list[sqlite3.Row], mode: str) -> list[dict]:
    """``RosterEntry`` (§7.8) for the given roster rows, labels resolved in ``mode``."""
    ids = [r["student_id"] for r in rows]
    names = identity.labels(db, class_id, ids, mode)
    show_emails = bool(readers.settings(db, class_id)["privacy"].get("showEmails", True))
    groups = memberships(db, class_id)
    stamps = _activity(db, class_id)
    activities = _activities(db, class_id)
    missing = missing_items(db, class_id, ids)
    out = []
    for row in rows:
        sid = row["student_id"]
        pseudo = mode == "pseudonyms"
        out.append({
            "studentId": sid,
            "studentName": names.get(sid, sid),
            "displayName": "" if pseudo else row["display_name"],
            "email": None if pseudo or not show_emails or not row["kiwi_email"] else row["kiwi_email"],
            "pseudonym": pseudonym(class_id, sid, row["pseudonym_seq"]),
            "source": row["source"],
            "status": row["status"],
            "groups": groups.get(sid, []),
            "consent": identity.consent_state(row),
            "consentSource": consent_source(row),
            "excluded": bool(row["excluded"]),
            "exclusionReason": row["exclusion_reason"],
            # B-m01: "Last seen" (any event) and "Last learning action" (answers, code runs, AI questions, submissions)
            "lastActive": stamps[sid].last_seen if sid in stamps else None,
            "lastLearningAction": stamps[sid].last_learning_action if sid in stamps else None,
            "missingWork": len(missing.get(sid, [])),
            "missingWorkItems": [item.as_dict() for item in missing.get(sid, [])],
            "activitiesRecorded": activities.get(sid, 0),
        })
    return out


def entry(db: sqlite3.Connection, class_id: str, student_id: str, mode: str) -> dict | None:
    row = db.execute("SELECT * FROM roster WHERE class_id=? AND student_id=?", (class_id, student_id)).fetchone()
    return entries(db, class_id, [row], mode)[0] if row else None


def _matches(entry_: dict, row: sqlite3.Row, q: str, mode: str) -> str | None:
    """Which field a search term matches (names mode: label, id, email, pseudonym; pseudonyms mode: pseudonym, id)."""
    needle = q.casefold()
    pseudo = entry_["pseudonym"].casefold()
    sid = entry_["studentId"].casefold()
    if mode == "pseudonyms":
        if pseudo.startswith(needle):
            return "pseudonym"
        if sid == needle or sid.startswith(needle):
            return "id"
        return None
    label = (row["display_name"] or entry_["studentName"] or "").casefold()
    if needle in label:
        return "name"
    if needle in sid:
        return "id"
    if row["kiwi_email"] and needle in row["kiwi_email"].casefold():
        return "email"
    if needle in pseudo:
        return "pseudonym"
    return None


def list_roster(db: sqlite3.Connection, class_id: str, *, mode: str, search: str = "", group_id: str | None = None,
                status: str | None = None, consent: str | None = None, excluded: bool | None = None, page: int = 1,
                page_size: int = 50) -> dict:
    rows = listed_rows(db, class_id)
    if status:
        rows = [r for r in rows if r["status"] == status]
    if excluded is not None:
        rows = [r for r in rows if bool(r["excluded"]) == excluded]
    if consent:
        rows = [r for r in rows if identity.consent_state(r) == consent]
    if group_id:
        members = {r[0] for r in db.execute("SELECT student_id FROM group_members WHERE class_id=? AND group_id=?",
                                            (class_id, group_id))}
        rows = [r for r in rows if r["student_id"] in members]
    if search.strip():
        labelled = entries(db, class_id, rows, mode)
        keep = {e["studentId"] for e, r in zip(labelled, rows) if _matches(e, r, search.strip(), mode)}
        rows = [r for r in rows if r["student_id"] in keep]
    names = identity.labels(db, class_id, [r["student_id"] for r in rows], mode)
    if mode == "names":
        rows = sorted(rows, key=lambda r: (names.get(r["student_id"], "").casefold(), r["student_id"]))
    total = len(rows)
    start = (page - 1) * page_size
    window = rows[start:start + page_size]
    return {"students": entries(db, class_id, window, mode), "total": total, "page": page, "pageSize": page_size}


def search(db: sqlite3.Connection, class_id: str, q: str, mode: str) -> list[dict]:
    """``StudentSearchHit[]`` (≤ 10) for the top-bar `Find a student…` [F08, FD04, TH12]."""
    rows = listed_rows(db, class_id)
    labelled = entries(db, class_id, rows, mode)
    hits = []
    for entry_, row in zip(labelled, rows):
        matched = _matches(entry_, row, q, mode)
        if matched:
            prefix = entry_["studentName"].casefold().startswith(q.casefold())
            hits.append((0 if prefix else 1, entry_["studentName"].casefold(), {
                "studentId": entry_["studentId"], "studentName": entry_["studentName"],
                "pseudonym": entry_["pseudonym"], "matchedOn": matched}))
    hits.sort(key=lambda h: (h[0], h[1]))
    return [h[2] for h in hits[:SEARCH_LIMIT]]


# -- roster import v2 (§6.8, PEOPLE-10) -----------------------------------------------------------
def _clean_text(value: object, label: str, maximum: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text")
    text = value.strip()
    if len(text) > maximum:
        raise ValueError(f"{label} must be at most {maximum} characters")
    return text


def _current_group(db: sqlite3.Connection, class_id: str, student_id: str, kind: str) -> str | None:
    row = db.execute(
        """SELECT g.name FROM group_members m JOIN course_groups g ON g.id=m.group_id WHERE m.class_id=? AND m.student_id=?
        AND m.kind=? AND g.archived_at IS NULL""", (class_id, student_id, kind)).fetchone()
    return row["name"] if row else None


def _find_group(db: sqlite3.Connection, class_id: str, kind: str, name: str) -> str | None:
    row = db.execute("SELECT id FROM course_groups WHERE class_id=? AND kind=? AND name=? AND archived_at IS NULL",
                     (class_id, kind, name)).fetchone()
    return row["id"] if row else None


def ensure_group(db: sqlite3.Connection, class_id: str, kind: str, name: str) -> str:
    """Existing non-archived group of that kind and name, else a new one (caller holds the write transaction)."""
    found = _find_group(db, class_id, kind, name)
    if found:
        return found
    import uuid

    group_id = f"grp-{uuid.uuid4().hex[:12]}"
    db.execute("INSERT INTO course_groups (id, class_id, name, kind, description, created_at) VALUES (?, ?, ?, ?, '', ?)",
               (group_id, class_id, name, kind, dbmod.now()))
    return group_id


def set_membership(db: sqlite3.Connection, class_id: str, group_id: str, student_id: str, kind: str, *, method: str,
                   assigned_by: str, seed: str | None = None) -> bool:
    """Writer pattern of §4.2.2 (upsert on the partial unique index, never INSERT OR REPLACE). Returns True on change."""
    if kind in ("section", "condition"):
        current = db.execute("SELECT group_id FROM group_members WHERE class_id=? AND student_id=? AND kind=?",
                             (class_id, student_id, kind)).fetchone()
        if current and current["group_id"] == group_id:
            return False
        db.execute(
            """INSERT INTO group_members (class_id, group_id, student_id, kind, method, seed, assigned_by, assigned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(class_id, student_id, kind) WHERE kind IN ('section','condition')
            DO UPDATE SET group_id=excluded.group_id, method=excluded.method, seed=excluded.seed,
            assigned_by=excluded.assigned_by, assigned_at=excluded.assigned_at""",
            (class_id, group_id, student_id, kind, method, seed, assigned_by, dbmod.now()))
        return True
    cur = db.execute(
        """INSERT INTO group_members (class_id, group_id, student_id, kind, method, seed, assigned_by, assigned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(class_id, group_id, student_id) DO NOTHING""",
        (class_id, group_id, student_id, kind, method, seed, assigned_by, dbmod.now()))
    return cur.rowcount > 0


def _import_row(db: sqlite3.Connection, class_id: str, index: int, raw: object, match_by: str) -> dict:
    result: dict[str, Any] = {"index": index, "action": "error", "studentId": None, "message": "", "diff": {}}
    try:
        if not isinstance(raw, dict):
            raise ValueError("Each row must be an object")
        unknown = set(raw) - {"studentId", "name", "email", "section", "condition"}
        if unknown:
            raise ValueError(f"Unknown column: {sorted(unknown)[0]}")
        student_id = _clean_text(raw.get("studentId"), "Student ID", 100)
        name = _clean_text(raw.get("name"), "Name", NAME_MAX)
        email = _clean_text(raw.get("email"), "Email", 200)
        section = _clean_text(raw.get("section"), "Section", 80)
        condition = _clean_text(raw.get("condition"), "Condition", 80)
        if email and not EMAIL_RE.fullmatch(email):
            raise ValueError("Email is not a valid address")
        if student_id and not valid_id(student_id):
            raise ValueError("Student ID may use letters, numbers and . _ : @ - only")
        existing = None
        if match_by == "email":
            if not email:
                raise ValueError("Email is required when matching by email")
            existing = db.execute("SELECT * FROM roster WHERE class_id=? AND lower(kiwi_email)=lower(?)",
                                  (class_id, email)).fetchone()
            if existing is None and not student_id:
                raise ValueError("No Kiwi student with this email yet. Ask them to open CSS Lab once, or import by student ID.")
            if existing is not None and student_id and student_id != existing["student_id"]:
                raise ValueError("Student ID and email belong to different students")
        else:
            if not student_id:
                raise ValueError("Student ID is required")
        student_id = existing["student_id"] if existing is not None else student_id
        if existing is None:
            existing = db.execute("SELECT * FROM roster WHERE class_id=? AND student_id=?", (class_id, student_id)).fetchone()
        if not identity.is_roster_eligible(student_id):
            raise ValueError("Staff and preview identities cannot be imported as students")
        result["studentId"] = student_id
        diff: dict[str, list] = {}
        if existing is None:
            if name:
                diff["displayName"] = [None, name]
            if email:
                diff["email"] = [None, email]
        else:
            if name and name != existing["display_name"]:
                diff["displayName"] = [existing["display_name"] or None, name]
            if email and email.lower() != (existing["kiwi_email"] or "").lower():
                diff["email"] = [existing["kiwi_email"] or None, email]
        for kind, value in (("section", section), ("condition", condition)):
            if value:
                current = _current_group(db, class_id, student_id, kind) if existing is not None else None
                if current != value:
                    diff[kind] = [current, value]
        result["diff"] = diff
        result["action"] = "add" if existing is None else ("update" if diff else "unchanged")
        result["message"] = {"add": "New student", "update": "Changes " + ", ".join(diff), "unchanged": "No changes"}[result["action"]]
        if existing is not None and email.lower() == (existing["kiwi_email"] or "").lower():
            email = ""  # WHY: same address in another letter case is not a change; keep the stored (Kiwi) spelling
        result["_values"] = {"name": name, "email": email, "section": section, "condition": condition}
    except ValueError as exc:
        result["action"] = "error"
        result["message"] = str(exc)
        result["diff"] = {}
    return result


def import_v2(db: sqlite3.Connection, class_id: str, body: dict, actor: str) -> dict:
    """``POST /api/teacher/roster/import`` → ``RosterImportResult`` (preview never writes)."""
    rows = body.get("rows")
    mode = body.get("mode")
    match_by = body.get("matchBy", "studentId")
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_IMPORT_ROWS:
        raise ValueError(f"Import 1–{MAX_IMPORT_ROWS} rows at a time")
    if mode not in ("preview", "apply"):
        raise ValueError("mode must be preview or apply")
    if match_by not in ("studentId", "email"):
        raise ValueError("matchBy must be studentId or email")
    seen: set[str] = set()
    results = []
    for index, raw in enumerate(rows):
        res = _import_row(db, class_id, index, raw, match_by)
        if res["action"] != "error" and res["studentId"] in seen:
            res.update(action="error", message="This student appears twice in the file", diff={})
        if res["studentId"]:
            seen.add(res["studentId"])
        results.append(res)
    applied = 0
    if mode == "apply":
        with dbmod.write_tx(db):
            for res in results:
                if res["action"] not in ("add", "update"):
                    continue
                values = res["_values"]
                identity.ensure_roster(db, class_id, res["studentId"], source="import", display_name=values["name"],
                                       kiwi_email=values["email"])
                for kind in ("section", "condition"):
                    if values[kind]:
                        group_id = ensure_group(db, class_id, kind, values[kind])
                        set_membership(db, class_id, group_id, res["studentId"], kind, method="import", assigned_by=actor)
                applied += 1
    for res in results:
        res.pop("_values", None)
    return {"mode": mode, "rows": results, "applied": applied}


# -- roster edits (§6.8 PATCH) --------------------------------------------------------------------
def patch(db: sqlite3.Connection, class_id: str, student_id: str, body: dict, actor_label: str) -> tuple[dict, dict, dict, dict]:
    """Apply a roster PATCH. Returns (before, after) for the plain fields and (before, after) for consent."""
    unknown = set(body) - ROSTER_PATCH_KEYS
    if unknown:
        raise ValueError(f"Unknown field: {sorted(unknown)[0]}")
    if not body:
        raise ValueError("Nothing to change")
    row = db.execute("SELECT * FROM roster WHERE class_id=? AND student_id=?", (class_id, student_id)).fetchone()
    if row is None:
        raise ApiError(404, "not_found", "This student is not on the roster")
    updates: dict[str, object] = {}
    before: dict[str, object] = {}
    after: dict[str, object] = {}
    if "displayName" in body:
        name = body["displayName"]
        if not isinstance(name, str) or len(name.strip()) > NAME_MAX:
            raise ValueError(f"Display name must be at most {NAME_MAX} characters")
        if name.strip() != row["display_name"]:
            updates["display_name"] = name.strip()
            before["displayName"], after["displayName"] = row["display_name"], name.strip()
    if "status" in body:
        if body["status"] not in ("active", "dropped"):
            raise ValueError("status must be active or dropped")
        if body["status"] != row["status"]:
            updates["status"] = body["status"]
            before["status"], after["status"] = row["status"], body["status"]
    if "excluded" in body:
        value = body["excluded"]
        if not isinstance(value, dict) or not isinstance(value.get("value"), bool):
            raise ValueError("excluded must be {value: true|false, reason}")
        reason = value.get("reason") or ""
        if not isinstance(reason, str) or len(reason.strip()) > 200:
            raise ValueError("Exclusion reason must be at most 200 characters")
        if value["value"] and not reason.strip():
            raise ValueError("Say why this account is excluded from analytics (for example: test account)")
        new_reason = reason.strip() if value["value"] else ""
        if int(value["value"]) != row["excluded"] or new_reason != row["exclusion_reason"]:
            updates["excluded"] = int(value["value"])
            updates["exclusion_reason"] = new_reason
            before["excluded"] = {"value": bool(row["excluded"]), "reason": row["exclusion_reason"]}
            after["excluded"] = {"value": value["value"], "reason": new_reason}
    consent_before: dict = {}
    consent_after: dict = {}
    if "consentOverride" in body:
        value = body["consentOverride"]
        if not isinstance(value, dict) or value.get("value") not in ("yes", "no", None):
            raise ValueError("consentOverride must be {value: yes|no|null, note}")
        note = value.get("note") or ""
        if not isinstance(note, str) or len(note.strip()) > 500:
            raise ValueError("Consent note must be at most 500 characters")
        if value["value"] is not None and not note.strip():
            raise ValueError("Add a note that says where this consent record comes from (for example: paper form 10/20)")
        consent_before = {"value": row["consent_override"], "note": row["consent_note"], "effective": identity.consent_state(row)}
        updates.update(consent_override=value["value"], consent_note=note.strip(), consent_updated_by=actor_label,
                       consent_updated_at=dbmod.now())
        merged = {**dict(row), "consent_override": value["value"]}
        consent_after = {"value": value["value"], "note": note.strip(), "effective": identity.consent_state(merged)}
    if updates:
        updates["updated_at"] = dbmod.now()
        with dbmod.write_tx(db):
            assignments = ", ".join(f"{column} = ?" for column in updates)
            db.execute(f"UPDATE roster SET {assignments} WHERE class_id=? AND student_id=?",
                       (*updates.values(), class_id, student_id))
    return before, after, consent_before, consent_after


# -- student profile (§6.8, PEOPLE-01/22) ---------------------------------------------------------
def student_paths(student_id: str) -> dict:
    """Teacher URLs of one student (mirror of ``teacherPaths`` in ``src/lib/routes.ts``; ids URL-encoded)."""
    sid = quote(student_id, safe="")
    base = f"/teacher/students/s/{sid}"
    return {"profile": base, "timeline": f"{base}/timeline",
            "assignment": lambda assignment_id: f"{base}/assignments/{quote(assignment_id, safe='')}"}


def _time_clause(column: str, start: str | None, end: str | None) -> tuple[str, list]:
    parts, params = [], []
    if start:
        parts.append(f"{column} >= ?")
        params.append(start)
    if end:
        parts.append(f"{column} < ?")
        params.append(end)
    return (" AND " + " AND ".join(parts)) if parts else "", params


def _loads(value: object) -> dict:
    try:
        data = json.loads(value) if isinstance(value, str) else {}
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def profile(db: sqlite3.Connection, class_id: str, student_id: str, *, mode: str, permissions: frozenset[str],
            viewer: bool, start: str | None = None, end: str | None = None) -> dict:
    row = db.execute("SELECT * FROM roster WHERE class_id=? AND student_id=?", (class_id, student_id)).fetchone()
    if row is None:
        raise ApiError(404, "not_found", "This student is not on the roster")
    student = entries(db, class_id, [row], mode)[0]
    now = dbmod.utcnow()
    paths = student_paths(student_id)
    assignments = []
    released_pct: list[float] = []
    late = 0
    for rec in _homework(db, class_id):
        if not readers.in_audience(db, rec, student_id):
            continue
        cell = readers.gradebook_cell(db, rec, student_id, "latest", now)
        if cell.get("late"):
            late += 1
        if cell.get("state") == "released" and cell.get("score") is not None and cell.get("maxPoints"):
            released_pct.append(float(cell["score"]) / float(cell["maxPoints"]) * 100)
        grading_url = None
        if "grade" in permissions and cell.get("latestSubmissionId"):
            grading_url = "/teacher/grading?" + urlencode({"assignmentId": rec.id, "show": "all", "studentId": student_id,
                                                          "submissionId": cell["latestSubmissionId"]})
        assignments.append({
            "assignmentId": rec.id, "title": rec.title, "kind": rec.kind, "dueAt": rec.due_at, "cell": cell,
            "timelineUrl": paths["assignment"](rec.id), "gradingUrl": grading_url,
            "draftAnswered": cell.get("draftAnswered") if not cell.get("attempts") else None,
        })
    missing = student["missingWork"]   # D8: the shared rule; equals the rows whose cell is "missing"
    titles: dict[str, str] = {}
    positions: dict[str, dict[str, int]] = {}
    for r in db.execute("SELECT id, title, questions_json FROM assignments WHERE class_id=?", (class_id,)):
        titles[r["id"]] = r["title"]
        questions = _loads_list(r["questions_json"])
        positions[r["id"]] = {q["id"]: i + 1 for i, q in enumerate(questions) if isinstance(q, dict) and isinstance(q.get("id"), str)}
    clause, params = _time_clause("created_at", start, end)
    errors = []
    for ev in db.execute(
        f"""SELECT created_at, question_id, payload_json, source FROM events WHERE class_id=? AND student_id=? AND is_preview=0
        AND event_type='code_run'{clause} ORDER BY created_at DESC, id DESC LIMIT 200""", (class_id, student_id, *params)):
        payload = _loads(ev["payload_json"])
        if payload.get("ok") is not False or not payload.get("error"):
            continue
        aid = payload.get("assignmentId") or ""
        where = titles.get(aid) or ("Kiwi scratchpad" if ev["source"] == "kiwi" else "R workspace")
        label = _error_label(where, positions.get(aid, {}), ev["question_id"] or "", payload)
        errors.append({"at": ev["created_at"], "questionLabel": label, "error": str(payload.get("error"))[:300],
                       "href": paths["assignment"](aid) if aid in titles else paths["timeline"]})
        if len(errors) >= 5:
            break
    questions = []
    for turn in db.execute(
        f"""SELECT created_at, prompt, thread_id, flagged FROM chat_turns WHERE class_id=? AND student_id=? AND is_preview=0
        {clause} ORDER BY created_at DESC, id DESC LIMIT 5""", (class_id, student_id, *params)):
        questions.append({"at": turn["created_at"], "prompt": turn["prompt"][:300], "where": "lab",
                          "threadKey": f"lab:{student_id}:{turn['thread_id']}", "flagged": bool(turn["flagged"])})
    for ev in db.execute(
        f"""SELECT created_at, payload_json FROM events WHERE class_id=? AND student_id=? AND source='kiwi'
        AND event_type='ai_question'{clause} ORDER BY created_at DESC, id DESC LIMIT 5""", (class_id, student_id, *params)):
        payload = _loads(ev["payload_json"])
        questions.append({"at": ev["created_at"], "prompt": str(payload.get("prompt") or "")[:300], "where": "kiwi",
                          "threadKey": f"kiwi:{payload.get('threadId') or ''}", "flagged": False})
    questions.sort(key=lambda q: q["at"], reverse=True)
    from server import course_config

    course = course_config.course_for(class_id, db)
    practice = []
    item_clause, item_params = _time_clause("created_at", start, end)
    counts = {(r["unit_id"], r["origin"]): int(r["n"]) for r in db.execute(
        f"""SELECT unit_id, origin, COUNT(*) AS n FROM generated_items WHERE class_id=? AND student_id=? AND is_preview=0
        {item_clause} GROUP BY unit_id, origin""", (class_id, student_id, *item_params))}
    unit_of_item = {r["id"]: r["unit_id"] for r in db.execute(
        "SELECT id, unit_id FROM generated_items WHERE class_id=? AND student_id=?", (class_id, student_id))}
    checks: dict[str, list[int]] = {}
    for ev in db.execute(
        f"""SELECT item_id, payload_json FROM events WHERE class_id=? AND student_id=? AND is_preview=0 AND item_id != ''
        AND event_type='answer_submitted' AND checked_by='server'{clause}""", (class_id, student_id, *params)):
        correct = _loads(ev["payload_json"]).get("correct")
        unit = unit_of_item.get(ev["item_id"])
        if unit and isinstance(correct, bool):
            bucket = checks.setdefault(unit, [0, 0])
            bucket[0] += int(correct)
            bucket[1] += 1
    minutes = {r[0]: float(r[1] or 0) / 60 for r in db.execute(
        f"""SELECT unitId, SUM(activeSeconds) FROM learning_sessions WHERE classId=? AND studentId=? AND isPreview=0
        {_time_clause('lastActive', start, end)[0]} GROUP BY unitId""",
        (class_id, student_id, *_time_clause('lastActive', start, end)[1]))}
    for unit in course["units"]:
        uid = unit["id"]
        free, similar = counts.get((uid, "free"), 0), counts.get((uid, "similar"), 0)
        checked = checks.get(uid)
        if not (free or similar or checked or minutes.get(uid)):
            continue
        practice.append({"unitId": uid, "title": unit["title"], "freeItems": free, "similarItems": similar,
                         "serverAccuracy": round(checked[0] / checked[1] * 100) if checked and checked[1] else None,
                         "activeMinutes": round(minutes.get(uid, 0.0), 1)})
    return {
        "student": student,
        "header": {"lastActive": student["lastActive"], "lastLearningAction": student["lastLearningAction"], "missing": missing,
                   "late": late,
                   "avgScorePct": round(sum(released_pct) / len(released_pct)) if released_pct else None},
        "fullTimelineUrl": paths["timeline"],
        "canExportConversations": "exportActivity" in permissions and not viewer,
        "assignments": assignments,
        "recentErrors": errors,
        "recentAiQuestions": questions[:5],
        "practiceByChapter": practice,
    }


def _loads_list(text: str | None) -> list:
    try:
        value = json.loads(text or "[]")
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def _error_label(where: str, positions: dict[str, int], question_id: str, payload: dict) -> str:
    """``Week 3 HW · Q2`` or ``R workspace · Filter rows`` — never a raw question or item id (RV6-m04)."""
    if question_id in positions:
        return f"{where} · Q{positions[question_id]}"
    title = " ".join(str(payload.get("questionTitle") or "").split())
    if title:
        return f"{where} · {title[:60]}{'…' if len(title) > 60 else ''}"
    return where
