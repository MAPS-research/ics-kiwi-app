"""Legacy native-activity projections retained for existing Lab data.

Live native imports are retired. Identity uses the official Kiwi app JWT/JWKS
contract; no private host endpoint or host database access remains.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from server import db as dbmod
from server import identity, telemetry
from server import kiwi_api


BridgeError = kiwi_api.KiwiError


PROJECTION_VERSION = "native-projection-v3"
MAX_TEXT = 100000
FEEDBACK_REPLY = 4000
FILE_ACTIONS = {"frontend-interaction-ide-uploadfile": "upload", "frontend-interaction-ide-switchtab": "switchtab",
                "frontend-interaction-ide-savecodetofile": "save", "frontend-interaction-ide-addfile": "add"}
FEEDBACK_TYPES = {"frontend-interaction-thumbs": "thumbs", "frontend-interaction-feedback-flag": "flag"}


def remote(token, path, params=None):
    """Compatibility entry point: identity uses public JWKS, native export is removed."""
    if path != "context":
        raise BridgeError("Native Kiwi activity and roster import are not part of the official App API", 410)
    return kiwi_api.authenticate("Bearer " + token, None)


def authenticate(header, class_id):
    if not header.startswith("Bearer ") or not 8 < len(header) < 20000:
        raise BridgeError("A Kiwi app token is required", 401)
    context = remote(header[7:], "context")
    if context.get("classId") != class_id or not context.get("userId"):
        raise BridgeError("The Kiwi token belongs to another course", 403)
    return context


def init(db):
    """Derived-index hook for the native projection. A projection-version change is reconciled on the next sync
    (cursor reset, ``event_revisions`` for every changed row); DDL lives in ``migrations.base_schema``."""


def linked(db, class_id):
    return identity.class_linked(db, class_id)


def status(db, class_id):
    row = db.execute("SELECT * FROM kiwi_sync WHERE class_id=?", (class_id,)).fetchone()
    native = db.execute("SELECT COUNT(*) FROM events WHERE class_id=? AND source='kiwi'", (class_id,)).fetchone()[0]
    config = {}
    if row is not None and row["native_tutoring_mode_source"] is not None:  # CR-T5: persisted by the metadata pass
        config = {"tutoringMode": row["native_tutoring_mode"], "source": row["native_tutoring_mode_source"] or None}
    return {"nativeSyncAvailable": False, "connected": linked(db, class_id), "lastSynced": row["last_synced"] if row else None,
            "error": row["last_error"] if row else None, "hasMore": bool(row and row["has_more"]),
            "metadataTruncated": bool(row and row["metadata_truncated"]), "nativeEvents": native,
            "excludedByDesign": int(row["excluded_by_design"]) if row else 0,
            "excludedNotEnrolled": int(row["excluded_not_enrolled"]) if row else 0,
            "nativeTutoringMode": config.get("tutoringMode"), "nativeTutoringModeSource": config.get("source"),
            "materials": [dict(r) for r in db.execute("SELECT id,title,unit_id unitId FROM kiwi_materials WHERE class_id=? ORDER BY title,id", (class_id,))]}


def per_student(db, class_id):
    """Per-student native import progress for Data health (labels are relabeled by the route)."""
    rows = db.execute("SELECT * FROM kiwi_user_sync WHERE class_id=? ORDER BY student_id", (class_id,)).fetchall()
    return [{"studentId": r["student_id"], "label": identity.label(db, class_id, r["student_id"]),
             "lastImportedAt": r["last_imported_at"], "backfilled": r["backfilled_at"] is not None} for r in rows]


def iso(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat(timespec="milliseconds")


def _text(value, limit=MAX_TEXT):
    return str(value or "")[:limit]


def _actions(record):
    """Non-intermediate server actions, newest last (the bridge already drops ``agent-loop-step`` and empty replies)."""
    actions = [a for a in (record.get("serverActions") or []) if isinstance(a, dict) and a.get("botResponse")
               and a.get("type") != "agent-loop-step"]
    return sorted(actions, key=lambda a: (str(a.get("timestamp") or ""), str(a.get("id") or "")))


def payload_for(record, materials):
    context = record.get("context") or {}
    if not isinstance(context, dict):
        context = {}
    content = context.get("content") or {}
    if not isinstance(content, dict):
        content = {"prompt": str(content)}
    kind = record["type"]
    is_code = "-ide-" in kind
    is_view = kind == "frontend-interaction-pdf-change"
    if kind in FEEDBACK_TYPES:
        event_type = "ai_feedback"
    elif is_view:
        event_type = "material_viewed"
    elif kind.endswith("-runcode"):
        event_type = "code_run"
    elif kind.endswith("-checkanswer"):
        event_type = "kiwi_check_answer"  # was code_shared in v2 [AU-D4-22]
    elif kind in FILE_ACTIONS:
        event_type = "kiwi_file_action"
    elif is_code:
        event_type = "code_shared"
    else:
        event_type = "ai_question"
    material = materials.get(record.get("pdfId"), {})
    mid = material.get("id") or record.get("pdfId") or ""
    page = record.get("pdfPage")
    # PDF viewer events use a zero-based currentPage; ChatCore/chatContext
    # send a one-based pageNumber to Kiwi's chat endpoint.
    display_page = page + 1 if page is not None and is_view else page if isinstance(page, int) and page > 0 else None
    thread = record.get("conversationId") or record.get("stringTag") or ("reading" if is_view else "scratchpad" if is_code else record["id"])
    actions = _actions(record)
    action = actions[-1] if actions else {}
    surface = "lecture" if mid else "scratchpad" if is_code else "chat"
    title = (record.get("conversation") or {}).get("title") or material.get("title") or ("Kiwi scratchpad" if is_code else "Kiwi conversation")
    if mid and display_page is not None:
        title += f" · page {display_page}"
    payload = {"source": "kiwi", "surface": surface, "upstreamId": record["id"], "upstreamType": kind,
        "threadId": thread, "materialId": mid, "materialTitle": material.get("title") or mid,
        "unitId": material.get("unit_id") or "", "page": display_page, "upstreamPage": page,
        "title": title, "prompt": _text(content.get("prompt") or context.get("prompt") or context.get("message")),
        "code": _text(context.get("userCode") or context.get("code")),
        "output": _text(context.get("outputCode") or context.get("output")),
        "response": _text(action.get("botResponse")),
        "upstreamActionId": action.get("id"), "responseState": "received" if action else "not-recorded",
        "responseCount": len(actions)}
    if record.get("actionsTruncated"):
        payload["actionsTruncated"] = True
    if action.get("engineChoice"):
        payload["engineChoice"] = str(action["engineChoice"])[:100]
    if isinstance(context.get("success"), bool) and context.get("resultVersion") == "captured-result-v1":
        payload["ok"] = context["success"]
    if is_code:
        payload["language"] = context.get("language") or "not-recorded"
        payload["resultVersion"] = context.get("resultVersion")
    if context.get("error"):
        payload["error"] = _text(context["error"])
    if event_type == "ai_feedback":
        payload["conversationId"] = record.get("conversationId") or ""
        index = context.get("targetMessageIndex")
        payload["targetMessageIndex"] = index if isinstance(index, int) and not isinstance(index, bool) else None
        payload["feedbackKind"] = FEEDBACK_TYPES[kind]
        value = context.get("thumbsValue")
        payload["value"] = value if isinstance(value, (int, float)) and not isinstance(value, bool) else None
        if context.get("flagReply"):
            payload["reply"] = _text(context["flagReply"], FEEDBACK_REPLY)
    if event_type == "kiwi_file_action":
        payload["action"] = FILE_ACTIONS[kind]
        payload["fileName"] = _text(context.get("fileName"), 300)
    payload["truncated"] = bool(record.get("truncated")) or any(len(str(value)) > MAX_TEXT for value in [
        content.get("prompt", ""), context.get("userCode", ""), context.get("outputCode", ""), action.get("botResponse", ""),
        context.get("error", "")])
    return event_type, payload


def _store_responses(db, class_id, record, event_id):
    stamp = dbmod.now()
    for action in _actions(record):
        if not action.get("id"):
            continue
        text = str(action.get("botResponse") or "")
        db.execute(
            """INSERT INTO ai_responses (class_id, upstream_action_id, upstream_interaction_id, event_id, action_type, engine_choice,
            bot_response, truncated, responded_at, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(class_id, upstream_action_id) DO NOTHING""",
            (class_id, str(action["id"])[:100], str(record["id"])[:100], event_id, str(action.get("type") or "")[:60],
             str(action["engineChoice"])[:100] if action.get("engineChoice") else None, text[:MAX_TEXT],
             int(len(text) > MAX_TEXT), iso(action["timestamp"]) if action.get("timestamp") else stamp, stamp))


def _owner(db, class_id, record):
    """(student_id, email) for a native record after tombstones: anonymized earlier records → anon id without email;
    deleted → ``None`` (skipped); records after the tombstone keep the real id (§14.5)."""
    student = record["userId"]
    email = str(((record.get("user") or {}).get("email")) or "")
    stone = identity.tombstone(db, class_id, student)
    if stone is None:
        return student, email
    mode, anon_id, created_at = stone
    when, cutoff = dbmod.parse_iso(record["timestamp"]), dbmod.parse_iso(created_at)
    if when is not None and cutoff is not None and when >= cutoff:
        return student, email
    if mode == "delete":
        return None, ""
    return anon_id, ""


def import_record(db, class_id, record, materials):
    """Insert or reconcile one native record; returns True when a new event was stored."""
    owner, email = _owner(db, class_id, record)
    if owner is None:
        return False
    event_type, payload = payload_for(record, materials)
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    old = db.execute("SELECT * FROM events WHERE class_id=? AND source='kiwi' AND upstream_id=?", (class_id, record["id"])).fetchone()
    if owner == record["userId"] and identity.is_roster_eligible(owner):
        roster = db.execute("SELECT source FROM roster WHERE class_id=? AND student_id=?", (class_id, owner)).fetchone()
        if email and (roster is None or roster["source"] != "kiwi"):  # the roster metadata pass stays authoritative
            identity.ensure_roster(db, class_id, owner, source="kiwi", kiwi_email=email, kiwi_role="student")
        _touch_user(db, class_id, owner)
    if old:
        _store_responses(db, class_id, record, old["id"])
        before_payload = json.loads(old["payload_json"]) if old["payload_json"] else {}
        if before_payload == payload and old["event_type"] == event_type:
            return False
        # P1: keep the previous projection, then update type and payload consistently [AU-D4-27]
        db.execute("INSERT INTO event_revisions (event_id, payload_json_before, event_type_before, reason, changed_at) "
                   "VALUES (?, ?, ?, ?, ?)", (old["id"], old["payload_json"], old["event_type"],
                                              "native-reprojection" if old["event_type"] != event_type else "native-update", dbmod.now()))
        derived = telemetry.derive(db, {"class_id": class_id, "source": "kiwi", "event_type": event_type, "payload": payload})
        before = telemetry.event_counters(old["event_type"], before_payload)
        after = telemetry.event_counters(event_type, payload)
        db.execute("UPDATE events SET payload_json=?, event_type=?, student_name='', category=?, practice_mode=? WHERE id=?",
                   (serialized, event_type, derived["category"], derived["practice_mode"], old["id"]))
        if old["learning_session_id"]:
            columns = telemetry.COUNTERS + telemetry.NEW_COUNTERS
            row = db.execute("SELECT * FROM events WHERE id=?", (old["id"],)).fetchone()
            context = telemetry._context(db, row, payload)
            db.execute("UPDATE learning_sessions SET " + ",".join(f"{c}={c}+?" for c in columns)
                       + ",title=?,contextKey=?,kind=? WHERE id=?",
                       [*[after[c] - before[c] for c in columns], payload["title"], context["key"], context["kind"],
                        old["learning_session_id"]])
        return False
    derived = telemetry.derive(db, {"class_id": class_id, "source": "kiwi", "event_type": event_type, "payload": payload})
    cur = db.execute("""INSERT INTO events (class_id,student_id,student_name,session_id,event_type,payload_json,created_at,source,upstream_id,
        received_at,actor_role,identity_verified,practice_mode,category,schema_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (class_id, owner, "", record.get("sessionId") or "native", event_type,
        serialized, iso(record["timestamp"]), "kiwi", record["id"], dbmod.now(), "student", 1, derived["practice_mode"],
        derived["category"], 2))
    _store_responses(db, class_id, record, cur.lastrowid)
    telemetry.index_event(db, db.execute("SELECT * FROM events WHERE id=?", (cur.lastrowid,)).fetchone())
    return True


def _touch_user(db, class_id, student_id):
    """Last native import per student; a student first seen through the activity stream needs no backfill."""
    stamp = dbmod.now()
    db.execute("""INSERT INTO kiwi_user_sync (class_id, student_id, first_seen_at, backfilled_at, last_imported_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(class_id, student_id) DO UPDATE SET last_imported_at=excluded.last_imported_at""",
               (class_id, student_id, stamp, stamp, stamp))


def sync(connection, class_id, token):
    """Removed in v0.7: there is no public App API for a class's native activity."""
    raise BridgeError("Native Kiwi activity import is unavailable in the official App API. Lab activity is recorded locally.", 410)


def map_material(db, class_id, material_id, unit_id, changed_by="instructor"):
    """Link a Kiwi material to a chapter: ``kiwi_materials`` + a ``material_unit_map`` history row; session metadata
    follows. Event payloads are never rewritten [AU-D1-M09]."""
    if db.execute("UPDATE kiwi_materials SET unit_id=? WHERE class_id=? AND id=?", (unit_id, class_id, material_id)).rowcount != 1:
        raise ValueError("Kiwi material not found in this course. Refresh Kiwi activity first.")
    db.execute("""INSERT INTO material_unit_map (class_id, material_id, unit_id, valid_from, changed_by) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(class_id, material_id, valid_from) DO UPDATE SET unit_id=excluded.unit_id, changed_by=excluded.changed_by""",
               (class_id, material_id, unit_id, dbmod.now(), str(changed_by or "instructor")[:200]))
    # A mapping is metadata on existing sessions; preserve their identities and
    # event counts, so bookmarked evidence remains valid after linking a chapter.
    db.execute("UPDATE learning_sessions SET unitId=? WHERE classId=? AND source='kiwi' AND materialId=?", (unit_id, class_id, material_id))
