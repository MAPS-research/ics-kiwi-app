"""Groups, staff & roles, course settings, audit viewer, data deletion and retention (owned by PEOPLE; spec §14).

Every function that writes runs inside one ``write_tx``; route handlers call ``req.audit(...)`` for each mutation.
Student targets of anonymize/delete are audited as ``hash:<student_hash>`` with no student content (§14.5).
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from copy import deepcopy
from datetime import timedelta
from typing import Any

from server import audit, auth, course_config, identity, readers, roster
from server import db as dbmod
from server.router import ApiError, valid_id

GROUP_KINDS = ("section", "condition", "cohort")
STAFF_ROLES = auth.STAFF_ROLES   # instructor | ta | viewer | researcher (decision D3)
RANDOM_ALGORITHM = "sha256-sort-v1"
ANON_NAME = "Anonymized student"


# -- helpers --------------------------------------------------------------------------------------
def _text(value: object, label: str, minimum: int, maximum: int) -> str:
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        if minimum:
            raise ValueError(f"{label} must contain {minimum}–{maximum} characters")
        raise ValueError(f"{label} must be at most {maximum} characters")
    return value.strip()


def _student_ids(db: sqlite3.Connection, class_id: str, value: object, *, maximum: int = 1000) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError(f"studentIds must be a list of at most {maximum} student ids")
    ids: list[str] = []
    for item in value:
        if not valid_id(item):
            raise ValueError("studentIds contains an invalid id")
        if item not in ids:
            ids.append(item)
    known = {r[0] for r in db.execute("SELECT student_id FROM roster WHERE class_id=?", (class_id,))}
    unknown = [s for s in ids if s not in known]
    if unknown:
        raise ValueError(f"Not on the roster: {unknown[0]}")
    return ids


# -- groups (§14.3) -------------------------------------------------------------------------------
def _group_row(db: sqlite3.Connection, class_id: str, group_id: str) -> sqlite3.Row:
    row = db.execute("SELECT * FROM course_groups WHERE class_id=? AND id=?", (class_id, group_id)).fetchone()
    if row is None:
        raise ApiError(404, "not_found", "Group not found")
    return row


def _group_view(db: sqlite3.Connection, row: sqlite3.Row) -> dict:
    members = db.execute("SELECT COUNT(*) FROM group_members WHERE class_id=? AND group_id=?",
                         (row["class_id"], row["id"])).fetchone()[0]
    return {"id": row["id"], "name": row["name"], "kind": row["kind"], "description": row["description"],
            "members": int(members), "archived": row["archived_at"] is not None}


def list_groups(db: sqlite3.Connection, class_id: str, *, include_archived: bool = False) -> list[dict]:
    sql = "SELECT * FROM course_groups WHERE class_id=?" + ("" if include_archived else " AND archived_at IS NULL")
    sql += " ORDER BY CASE kind WHEN 'section' THEN 0 WHEN 'condition' THEN 1 ELSE 2 END, name, id"
    return [_group_view(db, row) for row in db.execute(sql, (class_id,))]


def group_members(db: sqlite3.Connection, class_id: str, group_id: str) -> list[str]:
    return [r[0] for r in db.execute("SELECT student_id FROM group_members WHERE class_id=? AND group_id=? ORDER BY student_id",
                                     (class_id, group_id))]


def _check_unique_name(db: sqlite3.Connection, class_id: str, kind: str, name: str, exclude: str | None = None) -> None:
    row = db.execute("SELECT id FROM course_groups WHERE class_id=? AND kind=? AND name=? AND archived_at IS NULL",
                     (class_id, kind, name)).fetchone()
    if row is not None and row["id"] != exclude:
        raise ValueError(f"A {kind} named {name} already exists")


def create_group(db: sqlite3.Connection, class_id: str, body: dict, actor: str) -> dict:
    unknown = set(body) - {"name", "kind", "description", "studentIds"}
    if unknown:
        raise ValueError(f"Unknown field: {sorted(unknown)[0]}")
    name = _text(body.get("name"), "Group name", 1, 80)
    kind = body.get("kind")
    if kind not in GROUP_KINDS:
        raise ValueError("kind must be section, condition or cohort")
    description = _text(body.get("description", "") or "", "Description", 0, 500)
    ids = _student_ids(db, class_id, body["studentIds"]) if body.get("studentIds") is not None else []
    _check_unique_name(db, class_id, kind, name)
    group_id = f"grp-{uuid.uuid4().hex[:12]}"
    with dbmod.write_tx(db):
        db.execute("INSERT INTO course_groups (id, class_id, name, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                   (group_id, class_id, name, kind, description, dbmod.now()))
        for student_id in ids:
            roster.set_membership(db, class_id, group_id, student_id, kind, method="selection", assigned_by=actor)
    return _group_view(db, _group_row(db, class_id, group_id))


def update_group(db: sqlite3.Connection, class_id: str, group_id: str, body: dict) -> tuple[dict, dict]:
    row = _group_row(db, class_id, group_id)
    unknown = set(body) - {"name", "description"}
    if unknown:
        raise ValueError(f"Unknown field: {sorted(unknown)[0]}")
    if row["archived_at"]:
        raise ValueError("Archived groups cannot be edited")
    before = _group_view(db, row)
    name = _text(body["name"], "Group name", 1, 80) if "name" in body else row["name"]
    description = _text(body["description"] or "", "Description", 0, 500) if "description" in body else row["description"]
    _check_unique_name(db, class_id, row["kind"], name, exclude=group_id)
    with dbmod.write_tx(db):
        db.execute("UPDATE course_groups SET name=?, description=? WHERE id=?", (name, description, group_id))
    return before, _group_view(db, _group_row(db, class_id, group_id))


def archive_group(db: sqlite3.Connection, class_id: str, group_id: str) -> dict:
    """Delete = archive: memberships end (history keeps them through the triggers), the group stays for exports."""
    row = _group_row(db, class_id, group_id)
    before = {**_group_view(db, row), "studentIds": group_members(db, class_id, group_id)}
    if row["archived_at"]:
        return before
    with dbmod.write_tx(db):
        db.execute("DELETE FROM group_members WHERE class_id=? AND group_id=?", (class_id, group_id))
        db.execute("UPDATE course_groups SET archived_at=? WHERE id=?", (dbmod.now(), group_id))
    return before


def set_members(db: sqlite3.Connection, class_id: str, group_id: str, value: object, actor: str) -> tuple[list[str], list[str]]:
    row = _group_row(db, class_id, group_id)
    if row["archived_at"]:
        raise ValueError("Archived groups cannot be edited")
    ids = _student_ids(db, class_id, value)
    before = group_members(db, class_id, group_id)
    with dbmod.write_tx(db):
        for student_id in before:
            if student_id not in ids:
                db.execute("DELETE FROM group_members WHERE class_id=? AND group_id=? AND student_id=?",
                           (class_id, group_id, student_id))
        for student_id in ids:
            roster.set_membership(db, class_id, group_id, student_id, row["kind"], method="manual", assigned_by=actor)
    return before, group_members(db, class_id, group_id)


def randomization_order(seed: str, student_ids: list[str]) -> list[str]:
    """``sha256-sort-v1``: sort by sha256(f"{seed}:{student_id}") hex (deterministic and reproducible)."""
    return sorted(student_ids, key=lambda sid: (hashlib.sha256(f"{seed}:{sid}".encode("utf-8")).hexdigest(), sid))


def _enrolled_ids(db: sqlite3.Connection, class_id: str) -> list[str]:
    sql = "SELECT r.student_id FROM roster r WHERE r.class_id=? AND r.status='active' AND r.excluded=0"
    if identity.class_linked(db, class_id):
        sql += (" AND r.source='kiwi' AND NOT EXISTS (SELECT 1 FROM kiwi_staff_seen k WHERE k.class_id=r.class_id"
                " AND k.kiwi_user_id=r.student_id)")
    return [r[0] for r in db.execute(sql + " ORDER BY r.student_id", (class_id,))]


def randomize(db: sqlite3.Connection, class_id: str, body: dict, actor: str) -> dict:
    unknown = set(body) - {"groupIds", "seed", "studentIds", "overwrite"}
    if unknown:
        raise ValueError(f"Unknown field: {sorted(unknown)[0]}")
    group_ids = body.get("groupIds")
    if not isinstance(group_ids, list) or len(group_ids) < 2 or len(set(group_ids)) != len(group_ids):
        raise ValueError("Choose at least two different groups")
    rows = [_group_row(db, class_id, g) if isinstance(g, str) and valid_id(g) else None for g in group_ids]
    if any(r is None for r in rows):
        raise ValueError("groupIds contains an invalid id")
    kinds = {r["kind"] for r in rows}  # type: ignore[index]
    if len(kinds) != 1 or not kinds <= {"section", "condition"}:
        raise ValueError("Random assignment needs groups of one kind: sections or conditions")
    if any(r["archived_at"] for r in rows):  # type: ignore[index]
        raise ValueError("Archived groups cannot receive students")
    kind = kinds.pop()
    seed = body.get("seed")
    if not isinstance(seed, str) or not 1 <= len(seed) <= 64:
        raise ValueError("Seed must contain 1–64 characters")
    overwrite = body.get("overwrite", False)
    if not isinstance(overwrite, bool):
        raise ValueError("overwrite must be true or false")
    if body.get("studentIds") is not None:
        eligible = _student_ids(db, class_id, body["studentIds"])
    else:
        eligible = _enrolled_ids(db, class_id)
    if not overwrite:
        placed = {r[0] for r in db.execute(
            """SELECT m.student_id FROM group_members m JOIN course_groups g ON g.id=m.group_id
            WHERE m.class_id=? AND m.kind=? AND g.archived_at IS NULL""", (class_id, kind))}
        eligible = [s for s in eligible if s not in placed]
    order = randomization_order(seed, eligible)
    assignments = [{"studentId": sid, "groupId": group_ids[i % len(group_ids)]} for i, sid in enumerate(order)]
    with dbmod.write_tx(db):
        for item in assignments:
            changed = roster.set_membership(db, class_id, item["groupId"], item["studentId"], kind, method="random",
                                            assigned_by=actor, seed=seed)
            if changed:
                continue
            row = db.execute("SELECT method, seed FROM group_members WHERE class_id=? AND group_id=? AND student_id=?",
                             (class_id, item["groupId"], item["studentId"])).fetchone()
            if row is not None and (row["method"] != "random" or row["seed"] != seed):
                # WHY: same group, new assignment record — the update trigger starts a new history period with this seed.
                db.execute("UPDATE group_members SET method='random', seed=?, assigned_by=?, assigned_at=? WHERE class_id=? "
                           "AND group_id=? AND student_id=?", (seed, actor, dbmod.now(), class_id, item["groupId"], item["studentId"]))
    return {"assignments": assignments, "seed": seed, "algorithm": RANDOM_ALGORITHM}


def history(db: sqlite3.Connection, class_id: str, student_id: str | None, kind: str | None) -> list[dict]:
    names = roster.group_names(db, class_id)
    sql = "SELECT * FROM group_membership_history WHERE class_id=?"
    params: list[object] = [class_id]
    if student_id:
        sql += " AND student_id=?"
        params.append(student_id)
    if kind:
        sql += " AND kind=?"
        params.append(kind)
    return [{"studentId": r["student_id"], "kind": r["kind"], "groupId": r["group_id"], "groupName": names.get(r["group_id"], ""),
             "method": r["method"], "seed": r["seed"], "assignedBy": r["assigned_by"], "validFrom": r["valid_from"],
             "validTo": r["valid_to"]} for r in db.execute(sql + " ORDER BY valid_from, id LIMIT 5000", params)]


# -- staff & roles (§14.4) ------------------------------------------------------------------------
def _staff_view(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "displayName": row["display_name"], "role": row["role"], "kiwiUserId": row["kiwi_user_id"],
            "keyPrefix": row["key_prefix"], "createdAt": row["created_at"], "revokedAt": row["revoked_at"]}


def kiwi_effective_role(kiwi_role: str, can_manage: bool, can_view: bool) -> str | None:
    """Same order as ``auth._resolve_kiwi`` (§5.3 steps b–d) for the Staff & roles list.

    No Kiwi role maps to ``researcher`` (decision D3): that role is only given by an override on Staff & roles.
    """
    if kiwi_role == "ta" and (can_view or can_manage):
        return "ta"
    if can_manage:
        return "instructor"
    if can_view:
        return "viewer"
    return None


def staff_listing(db: sqlite3.Connection, class_id: str) -> dict:
    from server import kiwi_api
    staff = [_staff_view(r) for r in db.execute(
        "SELECT * FROM staff WHERE class_id=? ORDER BY revoked_at IS NOT NULL, created_at, id", (class_id,))]
    overrides = {r["kiwi_user_id"]: r for r in db.execute(
        "SELECT * FROM staff WHERE class_id=? AND kiwi_user_id IS NOT NULL AND revoked_at IS NULL", (class_id,))}
    seen = []
    for row in db.execute("SELECT * FROM kiwi_staff_seen WHERE class_id=? ORDER BY username, kiwi_user_id", (class_id,)):
        override = overrides.get(row["kiwi_user_id"])
        seen.append({
            "kiwiUserId": row["kiwi_user_id"], "username": "User " + row["kiwi_user_id"][:8] if identity.class_linked(db, class_id) else row["username"], "kiwiRole": row["kiwi_role"],
            "canManageCourse": bool(row["can_manage_course"]), "canViewAnalytics": bool(row["can_view_analytics"]),
            "effectiveRole": override["role"] if override else kiwi_api.staff_binding(class_id, row["kiwi_user_id"]),
            "roleSource": "override" if override else "kiwi", "overrideStaffId": override["id"] if override else None,
            "lastSeenAt": row["last_seen_at"],
        })
    return {"staff": staff, "kiwiStaff": seen}


def _staff_row(db: sqlite3.Connection, class_id: str, staff_id: str) -> sqlite3.Row:
    row = db.execute("SELECT * FROM staff WHERE class_id=? AND id=?", (class_id, staff_id)).fetchone()
    if row is None:
        raise ApiError(404, "not_found", "Staff member not found")
    return row


def _own_row(ident: Any, row: sqlite3.Row) -> bool:
    return bool((row["kiwi_user_id"] and row["kiwi_user_id"] == ident.user_id) or (ident.staff_id and ident.staff_id == row["id"]))


def create_staff(db: sqlite3.Connection, ident: Any, class_id: str, body: dict) -> dict:
    unknown = set(body) - {"displayName", "role", "kiwiUserId"}
    if unknown:
        raise ValueError(f"Unknown field: {sorted(unknown)[0]}")
    role = body.get("role")
    if role not in STAFF_ROLES:
        raise ValueError("role must be instructor, ta, viewer or researcher")
    kiwi_user_id = body.get("kiwiUserId")
    linked = identity.class_linked(db, class_id)
    stamp = dbmod.now()
    creator = audit.actor_label(ident)
    if linked:
        if not isinstance(kiwi_user_id, str) or not valid_id(kiwi_user_id):
            raise ValueError("Pick a Kiwi course staff member (staff keys are only for standalone courses)")
        if kiwi_user_id == ident.user_id:
            raise ValueError("You cannot change your own Lab role")
        seen = db.execute("SELECT * FROM kiwi_staff_seen WHERE class_id=? AND kiwi_user_id=?", (class_id, kiwi_user_id)).fetchone()
        if seen is None:
            raise ValueError("Only Kiwi course staff who have opened CSS Lab can get a Lab role here")
        name = _text(body.get("displayName") or seen["username"] or kiwi_user_id, "Display name", 1, 80)
        existing = db.execute("SELECT * FROM staff WHERE class_id=? AND kiwi_user_id=? AND revoked_at IS NULL",
                              (class_id, kiwi_user_id)).fetchone()
        with dbmod.write_tx(db):
            if existing is not None:
                db.execute("UPDATE staff SET role=?, display_name=? WHERE id=?", (role, name, existing["id"]))
                staff_id = existing["id"]
            else:
                staff_id = f"staff-{uuid.uuid4().hex[:12]}"
                db.execute("""INSERT INTO staff (id, class_id, display_name, role, kiwi_user_id, key_hash, key_prefix, created_by,
                           created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)""",
                           (staff_id, class_id, name, role, kiwi_user_id, creator[:200], stamp))
        return {"staff": _staff_view(_staff_row(db, class_id, staff_id))}
    if kiwi_user_id not in (None, ""):
        raise ValueError("This course is not linked to Kiwi; add a staff member with a key instead")
    name = _text(body.get("displayName"), "Display name", 1, 80)
    active_prefixes = {r[0] for r in db.execute(
        "SELECT key_prefix FROM staff WHERE class_id=? AND key_prefix IS NOT NULL AND revoked_at IS NULL", (class_id,))}
    for _ in range(10):
        key = auth.new_staff_key()
        if auth.key_prefix(key) not in active_prefixes and key != auth.teacher_key():
            break
    else:  # pragma: no cover - 32-bit prefix collisions ten times in a row
        raise RuntimeError("Could not generate a unique staff key")
    staff_id = f"staff-{uuid.uuid4().hex[:12]}"
    with dbmod.write_tx(db):
        db.execute("""INSERT INTO staff (id, class_id, display_name, role, kiwi_user_id, key_hash, key_prefix, created_by,
                   created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)""",
                   (staff_id, class_id, name, role, auth.hash_staff_key(key), auth.key_prefix(key), creator[:200], stamp))
    return {"staff": _staff_view(_staff_row(db, class_id, staff_id)), "key": key}


def update_staff(db: sqlite3.Connection, ident: Any, class_id: str, staff_id: str, body: dict) -> tuple[dict, dict]:
    row = _staff_row(db, class_id, staff_id)
    unknown = set(body) - {"displayName", "role"}
    if unknown:
        raise ValueError(f"Unknown field: {sorted(unknown)[0]}")
    if row["revoked_at"]:
        raise ValueError("This staff member was revoked; add them again instead")
    if _own_row(ident, row):
        raise ValueError("You cannot change your own Lab role")
    role = body.get("role", row["role"])
    if role not in STAFF_ROLES:
        raise ValueError("role must be instructor, ta, viewer or researcher")
    name = _text(body["displayName"], "Display name", 1, 80) if "displayName" in body else row["display_name"]
    with dbmod.write_tx(db):
        db.execute("UPDATE staff SET role=?, display_name=? WHERE id=?", (role, name, staff_id))
    auth.clear_key_cache(staff_id)
    return _staff_view(row), _staff_view(_staff_row(db, class_id, staff_id))


def revoke_staff(db: sqlite3.Connection, ident: Any, class_id: str, staff_id: str) -> dict:
    row = _staff_row(db, class_id, staff_id)
    if _own_row(ident, row):
        raise ValueError("You cannot revoke your own access")
    if not row["revoked_at"]:
        with dbmod.write_tx(db):
            db.execute("UPDATE staff SET revoked_at=? WHERE id=?", (dbmod.now(), staff_id))
    auth.clear_key_cache(staff_id)
    return _staff_view(row)


# -- settings (§4.5.4) ----------------------------------------------------------------------------
_PRIVACY = {"showEmails": bool, "defaultNameMode": str, "researchPurpose": str, "irbProtocol": str, "retentionDays": int,
            "viewerCanExportResearch": bool}
_GRADING = {"defaultGradesVisibility": str, "taCanRelease": bool}
_AI = {"perStudentPerMinute": (1, 120), "classPerMinute": (1, 2000)}
SETTINGS_SECTIONS = ("schedule", "privacy", "grading", "ai", "attentionRules", "topicRules")


def _section(body: dict, key: str) -> dict:
    value = body[key]
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be an object")
    return value


def _bool(value: object, label: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{label} must be true or false")
    return value


def validate_settings(current: dict, body: dict) -> dict:
    """Partial ``CourseSettings`` → merged, validated settings (400 with a readable message otherwise)."""
    unknown = set(body) - set(SETTINGS_SECTIONS)
    if unknown:
        raise ValueError(f"Unknown settings section: {sorted(unknown)[0]}")
    out = deepcopy(current)
    if "schedule" in body:
        out["schedule"] = course_config.validate_schedule({**current["schedule"], **_section(body, "schedule")})
    if "privacy" in body:
        privacy = _section(body, "privacy")
        bad = set(privacy) - set(_PRIVACY)
        if bad:
            raise ValueError(f"Unknown privacy setting: {sorted(bad)[0]}")
        for key, value in privacy.items():
            if key in ("showEmails", "viewerCanExportResearch"):
                out["privacy"][key] = _bool(value, key)
            elif key == "defaultNameMode":
                if value not in ("names", "pseudonyms"):
                    raise ValueError("defaultNameMode must be names or pseudonyms")
                out["privacy"][key] = value
            elif key == "researchPurpose":
                out["privacy"][key] = _text(value, "Research purpose", 0, 500)
            elif key == "irbProtocol":
                out["privacy"][key] = _text(value, "IRB protocol", 0, 200)
            elif key == "retentionDays":
                if value is not None and (type(value) is not int or not 1 <= value <= 3650):
                    raise ValueError("Retention must be empty (keep) or 1–3650 days")
                out["privacy"][key] = value
    if "grading" in body:
        grading = _section(body, "grading")
        bad = set(grading) - set(_GRADING)
        if bad:
            raise ValueError(f"Unknown grading setting: {sorted(bad)[0]}")
        if "defaultGradesVisibility" in grading:
            if grading["defaultGradesVisibility"] not in ("immediately", "on_release"):
                raise ValueError("defaultGradesVisibility must be immediately or on_release")
            out["grading"]["defaultGradesVisibility"] = grading["defaultGradesVisibility"]
        if "taCanRelease" in grading:
            out["grading"]["taCanRelease"] = _bool(grading["taCanRelease"], "taCanRelease")
    if "ai" in body:
        ai = _section(body, "ai")
        bad = set(ai) - set(_AI)
        if bad:
            raise ValueError(f"Unknown AI setting: {sorted(bad)[0]}")
        for key, value in ai.items():
            lo, hi = _AI[key]
            if type(value) is not int or not lo <= value <= hi:
                raise ValueError(f"{key} must be an integer from {lo} to {hi}")
            out["ai"][key] = value
    for key, where in (("attentionRules", "Students › Needs attention"), ("topicRules", "Insights › AI conversations")):
        if key in body and body[key] != current.get(key):
            raise ValueError(f"Edit {key} on {where}")
    return out


def save_settings(db: sqlite3.Connection, class_id: str, body: dict, actor: str) -> tuple[dict, dict]:
    current = readers.settings(db, class_id)
    merged = validate_settings(current, body)
    with dbmod.write_tx(db):
        db.execute(
            """INSERT INTO course_settings (class_id, settings_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
            ON CONFLICT(class_id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at,
            updated_by=excluded.updated_by""", (class_id, dbmod.json_dumps(merged), dbmod.now(), actor[:200]))
    changed = [k for k in SETTINGS_SECTIONS if current.get(k) != merged.get(k)]
    return {k: current[k] for k in changed}, {k: merged[k] for k in changed}


# -- audit viewer (§14.5) -------------------------------------------------------------------------
def _loads(text: str) -> object:
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _short(value: object) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    return text if len(text) <= 80 else text[:79] + "…"


def change_summary(before: object, after: object, *, values: bool = True) -> str:
    if isinstance(before, dict) and isinstance(after, dict):
        keys = [k for k in sorted(set(before) | set(after)) if before.get(k) != after.get(k)]
        if not values:
            return "Changed " + ", ".join(keys) if keys else "No field changes"
        return "; ".join(f"{k}: {_short(before.get(k))} → {_short(after.get(k))}" for k in keys) or "No field changes"
    if not values:
        return "Details hidden in Presentation mode"
    if after is not None:
        return _short(after) if not isinstance(after, dict) else "; ".join(f"{k}: {_short(v)}" for k, v in sorted(after.items()))
    return ""


def audit_entries(db: sqlite3.Connection, class_id: str, *, kind: str, start: str | None, end: str | None,
                  actor: str | None, action: str | None, page: int, page_size: int, mode: str) -> dict:
    table = "teacher_actions" if kind == "actions" else "data_access_log"
    where, params = ["class_id=?"], [class_id]
    if start:
        where.append("created_at >= ?")
        params.append(start)
    if end:
        where.append("created_at < ?")
        params.append(end)
    if actor:
        where.append("actor_label = ?")
        params.append(actor)
    if action:
        where.append("action = ?" if kind == "actions" else "category = ?")
        params.append(action)
    clause = " AND ".join(where)
    total = db.execute(f"SELECT COUNT(*) FROM {table} WHERE {clause}", params).fetchone()[0]
    rows = db.execute(f"SELECT * FROM {table} WHERE {clause} ORDER BY id DESC LIMIT ? OFFSET ?",
                      (*params, page_size, (page - 1) * page_size)).fetchall()
    entries = []
    pseudo = mode == "pseudonyms"
    for row in rows:
        if kind == "actions":
            before, after = _loads(row["before_json"]), _loads(row["after_json"])
            entries.append({"id": row["id"], "kind": "action", "actorLabel": row["actor_label"], "actorRole": row["actor_role"],
                            "action": row["action"], "targetType": row["target_type"], "targetId": row["target_id"],
                            "summary": change_summary(before, after, values=not pseudo), "createdAt": row["created_at"],
                            "before": None if pseudo else row["before_json"][:4000],
                            "after": None if pseudo else row["after_json"][:4000]})
        else:
            parts = [row["endpoint"]]
            if row["row_count"] is not None:
                parts.append(f"{row['row_count']} rows")
            if row["purpose"] and not pseudo:
                parts.append(f"purpose: {row['purpose']}")
            params_json = _loads(row["params_json"])
            if isinstance(params_json, dict) and params_json:
                parts.append(", ".join(f"{k}={v}" for k, v in sorted(params_json.items()) if k != "classId"))
            entries.append({"id": row["id"], "kind": "access", "actorLabel": row["actor_label"], "actorRole": row["actor_role"],
                            "action": row["category"], "targetType": "endpoint", "targetId": row["endpoint"],
                            "summary": " · ".join(p for p in parts if p), "createdAt": row["created_at"]})
    return {"entries": entries, "total": int(total), "page": page, "pageSize": page_size}


# -- deletion, anonymization, retention (§14.5) ---------------------------------------------------
# (table, class column, student column, name column, time column for retention)
STUDENT_TABLES: tuple[tuple[str, str, str, str | None], ...] = (
    ("events", "class_id", "student_id", "student_name"),
    ("learning_sessions", "classId", "studentId", "studentName"),
    ("chat_turns", "class_id", "student_id", None),
    ("ai_calls", "class_id", "student_id", None),
    ("generated_items", "class_id", "student_id", None),
    ("submissions", "class_id", "student_id", "student_name"),
    ("submission_requests", "class_id", "student_id", None),
    ("answer_drafts", "class_id", "student_id", None),
    ("attempt_starts", "class_id", "student_id", None),
    ("kiwi_user_sync", "class_id", "student_id", None),
    ("event_rejections", "class_id", "student_id", None),
)
RETENTION_TABLES: tuple[tuple[str, str, str | None], ...] = (
    ("events", "created_at", "student_name"), ("chat_turns", "created_at", None), ("ai_calls", "requested_at", None),
    ("answer_drafts", "updated_at", None), ("generated_items", "created_at", None),
)


# SB-B01: free text the student (or the AI, or a grader) wrote keeps the content but loses the student's own name, email
# and raw id. (table, key column, text columns, JSON columns) for the student's own rows; submission children and the
# student's coded threads are handled through their parents.
ANON_TEXT_COLUMNS: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("events", (), ("payload_json",)),
    ("learning_sessions", ("title",), ()),
    ("chat_turns", ("prompt", "response", "flag_reason"), ("context_json",)),
    ("ai_calls", ("developer_text", "raw_output", "error_message"), ("context_json", "guard_matches_json")),
    ("generated_items", ("focus_note", "client_run_output", "flag_note"), ("item_json",)),
    ("submissions", ("feedback", "adjustment_reason"), ("answers_json", "autocheck_json")),
    ("answer_drafts", ("value",), ()),
    ("event_rejections", ("message",), ()),
)
ANON_NAME_TEXT = "[name removed]"
_NORMALIZED_KEYS = frozenset({"normalizedAnswer", "normalized"})
ANON_EMAIL_TEXT = "[email removed]"


class _IdentityScrubber:
    """Replaces one student's roster names and emails (word-bounded, any case) and raw id inside free text (SB-B01)."""

    def __init__(self, db: sqlite3.Connection, class_id: str, student_id: str, anon: str) -> None:
        row = db.execute("SELECT display_name, kiwi_email, student_name FROM roster WHERE class_id=? AND student_id=?",
                         (class_id, student_id)).fetchone()
        terms: dict[str, str] = {}
        candidates = [(row["display_name"], ANON_NAME_TEXT), (row["student_name"], ANON_NAME_TEXT),
                      (row["kiwi_email"], ANON_EMAIL_TEXT)] if row else []
        if "@" in student_id:
            candidates.append((student_id, ANON_EMAIL_TEXT))
        for value, replacement in candidates:
            term = (value or "").strip() if isinstance(value, str) else ""
            if len(term) < 3 or term == ANON_NAME or (term == student_id and "@" not in term):
                continue
            terms.setdefault(term.casefold(), replacement if "@" not in term else ANON_EMAIL_TEXT)
        self.student_id, self.anon = student_id, anon
        self.lookup = terms
        # the raw id is replaced inside text only when it cannot be an ordinary word or number (as research_view does)
        if "@" not in student_id and len(student_id) >= 5:
            terms.setdefault(student_id.casefold(), anon)
        ordered = sorted(terms, key=len, reverse=True)
        self.pattern = re.compile(r"(?<![\w@.-])(?:" + "|".join(re.escape(t) for t in ordered) + r")(?![\w@-])",
                                  re.IGNORECASE) if ordered else None
        # judging's normalized answers drop whitespace, so word boundaries mean nothing there: match the terms
        # without their spaces anywhere (``normalizedAnswer`` values of autocheck_json and answer events)
        squeezed = {re.sub(r"\s+", "", t): r for t, r in terms.items()}
        self.squeezed_lookup = squeezed
        self.squeezed = re.compile("|".join(re.escape(t) for t in sorted(squeezed, key=len, reverse=True)),
                                   re.IGNORECASE) if squeezed else None

    def text(self, value: object) -> object:
        if not isinstance(value, str) or self.pattern is None or not value:
            return value
        return self.pattern.sub(lambda m: self.lookup.get(m.group(0).casefold(), ANON_NAME_TEXT), value)

    def squeezed_text(self, value: object) -> object:
        if not isinstance(value, str) or self.squeezed is None or not value:
            return value
        return self.squeezed.sub(lambda m: re.sub(r"\s+", "", self.squeezed_lookup.get(m.group(0).casefold(), ANON_NAME_TEXT)),
                                 value)

    def walk(self, value: object, key: str = "") -> object:
        if isinstance(value, str):
            if value == self.student_id:
                return self.anon
            return self.squeezed_text(self.text(value)) if key in _NORMALIZED_KEYS else self.text(value)
        if isinstance(value, list):
            return [self.walk(v, key) for v in value]
        if isinstance(value, dict):
            return {k: self.walk(v, k if isinstance(k, str) else "") for k, v in value.items()}
        return value

    def json_text(self, value: object) -> object:
        if not isinstance(value, str) or not value:
            return value
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return self.text(value)
        cleaned = self.walk(parsed)
        return value if cleaned == parsed else json.dumps(cleaned, ensure_ascii=False)


def _scrub_rows(db: sqlite3.Connection, scrub: _IdentityScrubber, table: str, where: str, params: tuple,
                text_cols: tuple[str, ...], json_cols: tuple[str, ...]) -> int:
    cols = [*text_cols, *json_cols]
    changed = 0
    for row in db.execute(f"SELECT rowid AS rid, {', '.join(cols)} FROM {table} WHERE {where}", params).fetchall():
        updates = {c: scrub.text(row[c]) for c in text_cols}
        updates.update({c: scrub.json_text(row[c]) for c in json_cols})
        updates = {c: v for c, v in updates.items() if v != row[c]}
        if updates:
            db.execute(f"UPDATE {table} SET {', '.join(f'{c}=?' for c in updates)} WHERE rowid=?", (*updates.values(), row["rid"]))
            changed += 1
    return changed


def scrub_student_text(db: sqlite3.Connection, class_id: str, student_id: str, anon: str) -> dict[str, int]:
    """SB-B01: remove the student's name, email and raw id from the free text of their retained rows (before re-keying)."""
    scrub = _IdentityScrubber(db, class_id, student_id, anon)
    counts: dict[str, int] = {}
    student_cols = {table: student_col for table, class_col, student_col, _ in STUDENT_TABLES}
    class_cols = {table: class_col for table, class_col, _s, _n in STUDENT_TABLES}
    for table, text_cols, json_cols in ANON_TEXT_COLUMNS:
        where = f"{class_cols[table]}=? AND {student_cols[table]}=?"
        counts[f"{table}_text"] = _scrub_rows(db, scrub, table, where, (class_id, student_id), text_cols, json_cols)
    subs = [r[0] for r in db.execute("SELECT id FROM submissions WHERE class_id=? AND student_id=?", (class_id, student_id))]
    for start in range(0, len(subs), 400):
        chunk = tuple(subs[start:start + 400])
        marks = ",".join("?" for _ in chunk)
        counts["submission_item_scores_text"] = counts.get("submission_item_scores_text", 0) + _scrub_rows(
            db, scrub, "submission_item_scores", f"submission_id IN ({marks})", chunk, ("comment", "auto_reason"), ())
        counts["grade_events_text"] = counts.get("grade_events_text", 0) + _scrub_rows(
            db, scrub, "grade_events", f"submission_id IN ({marks})", chunk, ("feedback_before", "feedback_after"),
            ("items_before_json", "items_after_json"))
    prefix = _lab_thread_prefix(student_id)
    counts["conversation_codes_text"] = _scrub_rows(db, scrub, "conversation_codes", "class_id=? AND substr(thread_key, 1, ?)=?",
                                                    (class_id, len(prefix), prefix), ("note",), ())
    return counts


def anon_id(db: sqlite3.Connection, class_id: str, student_id: str) -> str:
    return "anon-" + identity.student_hash(db, class_id, student_id)[:12]


def _has_data(db: sqlite3.Connection, class_id: str, student_id: str) -> bool:
    if db.execute("SELECT 1 FROM roster WHERE class_id=? AND student_id=?", (class_id, student_id)).fetchone():
        return True
    for table, class_col, student_col, _ in STUDENT_TABLES[:6]:
        if db.execute(f"SELECT 1 FROM {table} WHERE {class_col}=? AND {student_col}=? LIMIT 1", (class_id, student_id)).fetchone():
            return True
    return False


def _lab_thread_prefix(student_id: str) -> str:
    return f"lab:{student_id}:"


def delete_student_data(db: sqlite3.Connection, class_id: str, student_id: str, mode: str, actor: str) -> dict[str, int]:
    """Anonymize (replace ids, remove names/emails, keep content) or delete one student's rows; writes a tombstone."""
    if not identity.is_roster_eligible(student_id) or student_id.startswith("anon-"):
        raise ValueError("This id cannot be anonymized or deleted")
    if not _has_data(db, class_id, student_id):
        raise ApiError(404, "not_found", "No records for this student in this course")
    student_hash = identity.student_hash(db, class_id, student_id)
    anon = "anon-" + student_hash[:12]
    counts: dict[str, int] = {}
    prefix = _lab_thread_prefix(student_id)
    with dbmod.write_tx(db):
        if mode == "anonymize":
            counts.update(scrub_student_text(db, class_id, student_id, anon))
            for table, class_col, student_col, name_col in STUDENT_TABLES:
                sets = f"{student_col}=?" + (f", {name_col}=?" if name_col else "")
                values = [anon, ANON_NAME] if name_col else [anon]
                cur = db.execute(f"UPDATE OR REPLACE {table} SET {sets} WHERE {class_col}=? AND {student_col}=?",
                                 (*values, class_id, student_id))
                counts[table] = cur.rowcount
            counts.update(_anonymize_groups(db, class_id, student_id, anon))
            existing = db.execute("SELECT 1 FROM roster WHERE class_id=? AND student_id=?", (class_id, anon)).fetchone()
            if existing:
                counts["roster"] = db.execute("DELETE FROM roster WHERE class_id=? AND student_id=?", (class_id, student_id)).rowcount
            else:
                counts["roster"] = db.execute(
                    """UPDATE roster SET student_id=?, student_name=?, display_name=?, kiwi_email='', consent_note='',
                    excluded=1, exclusion_reason='Anonymized', updated_at=? WHERE class_id=? AND student_id=?""",
                    (anon, ANON_NAME, ANON_NAME, dbmod.now(), class_id, student_id)).rowcount
            counts["conversation_codes"] = db.execute(
                "UPDATE conversation_codes SET thread_key=? || substr(thread_key, ?) WHERE class_id=? AND substr(thread_key, 1, ?)=?",
                (_lab_thread_prefix(anon), len(prefix) + 1, class_id, len(prefix), prefix)).rowcount
        else:
            submission_ids = [r[0] for r in db.execute("SELECT id FROM submissions WHERE class_id=? AND student_id=?",
                                                       (class_id, student_id))]
            for chunk_start in range(0, len(submission_ids), 400):
                chunk = submission_ids[chunk_start:chunk_start + 400]
                marks = ",".join("?" for _ in chunk)
                counts["submission_item_scores"] = counts.get("submission_item_scores", 0) + db.execute(
                    f"DELETE FROM submission_item_scores WHERE submission_id IN ({marks})", chunk).rowcount
                counts["grade_events"] = counts.get("grade_events", 0) + db.execute(
                    f"DELETE FROM grade_events WHERE submission_id IN ({marks})", chunk).rowcount
            for table, class_col, student_col, _ in STUDENT_TABLES:
                counts[table] = db.execute(f"DELETE FROM {table} WHERE {class_col}=? AND {student_col}=?",
                                           (class_id, student_id)).rowcount
            counts["group_members"] = db.execute("DELETE FROM group_members WHERE class_id=? AND student_id=?",
                                                 (class_id, student_id)).rowcount
            counts["group_membership_history"] = db.execute(
                "DELETE FROM group_membership_history WHERE class_id=? AND student_id=?", (class_id, student_id)).rowcount
            counts["roster"] = db.execute("DELETE FROM roster WHERE class_id=? AND student_id=?", (class_id, student_id)).rowcount
            counts["conversation_codes"] = db.execute(
                "DELETE FROM conversation_codes WHERE class_id=? AND substr(thread_key, 1, ?)=?",
                (class_id, len(prefix), prefix)).rowcount
        db.execute(
            """INSERT INTO student_tombstones (class_id, student_hash, anon_id, mode, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(class_id, student_hash) DO UPDATE SET mode=excluded.mode,
            created_by=excluded.created_by, created_at=excluded.created_at""",
            (class_id, student_hash, anon, mode, actor[:200], dbmod.now()))
    return counts


def _anonymize_groups(db: sqlite3.Connection, class_id: str, student_id: str, anon: str) -> dict[str, int]:
    """Move memberships to the anonymous id without letting the history triggers invent periods."""
    original = [dict(r) for r in db.execute(
        "SELECT id, valid_to FROM group_membership_history WHERE class_id=? AND student_id=? ORDER BY id", (class_id, student_id))]
    high = db.execute("SELECT COALESCE(MAX(id), 0) FROM group_membership_history").fetchone()[0]
    moved = db.execute("UPDATE OR REPLACE group_members SET student_id=? WHERE class_id=? AND student_id=?",
                       (anon, class_id, student_id)).rowcount
    db.execute("DELETE FROM group_membership_history WHERE id > ? AND class_id=? AND student_id IN (?, ?)",
               (high, class_id, student_id, anon))
    for row in original:
        db.execute("UPDATE group_membership_history SET student_id=?, valid_to=? WHERE id=?", (anon, row["valid_to"], row["id"]))
    return {"group_members": moved, "group_membership_history": len(original)}


def retention_cutoff(db: sqlite3.Connection, class_id: str) -> tuple[int | None, str | None]:
    days = readers.settings(db, class_id)["privacy"].get("retentionDays")
    if not days:
        return None, None
    return int(days), dbmod.iso_seconds(dbmod.utcnow() - timedelta(days=int(days)))


def retention_report(db: sqlite3.Connection, class_id: str) -> dict:
    days, cutoff = retention_cutoff(db, class_id)
    due: dict[str, int] = {}
    for table, column, _ in RETENTION_TABLES:
        due[table] = 0 if cutoff is None else int(db.execute(
            f"SELECT COUNT(*) FROM {table} WHERE class_id=? AND {column} < ? AND substr(student_id, 1, 5) != 'anon-'",
            (class_id, cutoff)).fetchone()[0])
    return {"due": due, "retentionDays": days}


def run_retention(db: sqlite3.Connection, class_id: str) -> dict[str, int]:
    days, cutoff = retention_cutoff(db, class_id)
    if cutoff is None:
        raise ValueError("Set a retention period in Course settings › Privacy first")
    counts: dict[str, int] = {}
    anon_cache: dict[str, str] = {}
    students = set()
    for table, column, _ in RETENTION_TABLES:
        students |= {r[0] for r in db.execute(
            f"SELECT DISTINCT student_id FROM {table} WHERE class_id=? AND {column} < ? AND substr(student_id, 1, 5) != 'anon-'",
            (class_id, cutoff))}
    for sid in students:
        anon_cache[sid] = anon_id(db, class_id, sid)
    with dbmod.write_tx(db):
        for table, column, name_col in RETENTION_TABLES:
            counts[table] = 0
            for sid, anon in anon_cache.items():
                sets = "student_id=?" + (f", {name_col}=?" if name_col else "")
                values = [anon, ANON_NAME] if name_col else [anon]
                counts[table] += db.execute(
                    f"UPDATE OR REPLACE {table} SET {sets} WHERE class_id=? AND student_id=? AND {column} < ?",
                    (*values, class_id, sid, cutoff)).rowcount
    return counts
