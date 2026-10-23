"""Verified Kiwi identity and an incremental, idempotent copy of native course activity (owned by TELEMETRY).

No Kiwi signing secret or parent session is shared with this application. Spec §15.2 (``native-projection-v3``):
thumbs/flag feedback → ``ai_feedback``; check-answer → ``kiwi_check_answer``; scratchpad file actions →
``kiwi_file_action``; every non-intermediate server action → ``ai_responses`` (append-only); a changed projection writes
``event_revisions`` before the event is updated (P1); the native context key has no page; imported rows store no name
(the roster gets ``kiwi_email``/``kiwi_consent`` through ``identity.ensure_roster``); tombstoned students are mapped or
skipped (§14.5); new roster members get a per-user backfill; metadata counts and the Kiwi chat mode are kept per class.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from server import db as dbmod
from server import identity, telemetry


class BridgeError(Exception):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


_identity_cache = {}
_cache_lock = threading.Lock()
_sync_locks = {}
_app_config: dict[str, dict] = {}   # class_id → {"tutoringMode", "source"} from the latest metadata pass (live value)
PROJECTION_VERSION = "native-projection-v3"
IDENTITY_CACHE_SECONDS = 120
MAX_SYNC_PAGES = 5
MAX_TEXT = 100000
FEEDBACK_REPLY = 4000
FILE_ACTIONS = {"frontend-interaction-ide-uploadfile": "upload", "frontend-interaction-ide-switchtab": "switchtab",
                "frontend-interaction-ide-savecodetofile": "save", "frontend-interaction-ide-addfile": "add"}
FEEDBACK_TYPES = {"frontend-interaction-thumbs": "thumbs", "frontend-interaction-feedback-flag": "flag"}


def _now():
    """Wall clock used for identity-cache expiry (patched by tests)."""
    return time.time()


def remote(token, path, params=None):
    origin = os.environ.get("KIWI_API_ORIGIN", "http://localhost:3000").rstrip("/")
    parsed = urlparse(origin)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
        raise BridgeError("KIWI_API_ORIGIN must use HTTPS or loopback HTTP")
    url = origin + "/api/kiwi-apps/ics-r-lab/lab/" + path
    if params:
        url += "?" + urlencode({k: v for k, v in params.items() if v is not None})
    try:
        with urlopen(Request(url, headers={"Authorization": "Bearer " + token, "Accept": "application/json"}), timeout=15) as response:
            return json.load(response)
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise BridgeError("Kiwi access expired or this course permission is unavailable. Reopen CSS Lab from Kiwi.", exc.code) from None
        raise BridgeError("Kiwi activity service is unavailable. Saved activity is still available.") from None
    except (URLError, TimeoutError, ValueError):
        raise BridgeError("Could not reach Kiwi. Saved activity is still available.") from None


def token_expiry(token):
    """JWT ``exp`` (seconds) read from the payload only to bound caching; ``None`` when absent or unreadable."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    exp = payload.get("exp") if isinstance(payload, dict) else None
    return float(exp) if isinstance(exp, (int, float)) and not isinstance(exp, bool) else None


def authenticate(header, class_id):
    """Verified Kiwi context for a bearer token; cached for min(token exp, 120 s) [AU-D3-M02]."""
    if not header.startswith("Bearer ") or not 1 < len(header) < 20000:
        raise BridgeError("A Kiwi app token is required", 401)
    token = header[7:]
    key = hashlib.sha256(token.encode()).hexdigest()
    now = _now()
    with _cache_lock:
        cached = _identity_cache.get(key)
    if cached and cached[0] > now:
        context = cached[1]
    else:
        context = remote(token, "context")
        exp = token_expiry(token)
        until = now + IDENTITY_CACHE_SECONDS if exp is None else min(exp, now + IDENTITY_CACHE_SECONDS)
        with _cache_lock:
            if len(_identity_cache) >= 128:
                _identity_cache.clear()
            if until > now:
                _identity_cache[key] = (until, context)
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
    config = _app_config.get(class_id) or {}
    if row is not None and row["native_tutoring_mode_source"] is not None:  # CR-T5: persisted by the metadata pass
        config = {"tutoringMode": row["native_tutoring_mode"], "source": row["native_tutoring_mode_source"] or None}
    return {"connected": linked(db, class_id), "lastSynced": row["last_synced"] if row else None,
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


def replay_cursor(checkpoint):
    # Replay the previous five minutes after each completed snapshot. This also
    # reconciles short transactions that committed after the previous read.
    at = datetime.fromisoformat(checkpoint.replace("Z", "+00:00")) - timedelta(minutes=5)
    data = json.dumps({"at": at.isoformat(), "key": ""}).encode()
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


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


def _materials(db, class_id):
    materials = {}
    for row in db.execute("SELECT * FROM kiwi_materials WHERE class_id=?", (class_id,)):
        materials[row["id"]] = dict(row)
        for doc_id in json.loads(row["document_ids"]):
            materials[doc_id] = dict(row)
    return materials


def _apply_metadata(db, class_id, batch, first_sync):
    for material in batch.get("materials") or []:
        ids = [d["id"] for d in material.get("documents", [])]
        title = material.get("title") or next((d["fileName"] for d in material.get("documents", [])), material["id"])
        db.execute("INSERT INTO kiwi_materials(class_id,id,title,document_ids) VALUES (?,?,?,?) ON CONFLICT(class_id,id) DO UPDATE SET title=excluded.title,document_ids=excluded.document_ids", (class_id, material["id"], title, json.dumps(ids)))
    stamp = dbmod.now()
    for student in batch.get("roster") or []:
        student_id = student.get("userId")
        if not isinstance(student_id, str) or not student_id:
            continue
        user = student.get("user") or {}
        identity.ensure_roster(db, class_id, student_id, source="kiwi", kiwi_email=str(user.get("email") or ""), kiwi_role="student")
        consent = user.get("consent")
        if isinstance(consent, bool):
            db.execute("UPDATE roster SET kiwi_consent=? WHERE class_id=? AND student_id=? AND kiwi_consent IS NOT ?",
                       (int(consent), class_id, student_id, int(consent)))
        # A student first seen after the first sync gets a per-user backfill of earlier native activity [AU-D3-18].
        db.execute("""INSERT INTO kiwi_user_sync (class_id, student_id, first_seen_at, backfilled_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(class_id, student_id) DO NOTHING""", (class_id, student_id, stamp, stamp if first_sync else None))
    if "excludedByDesign" in batch or "excludedNotEnrolled" in batch:
        db.execute("""INSERT INTO kiwi_sync (class_id, excluded_by_design, excluded_not_enrolled) VALUES (?, ?, ?)
            ON CONFLICT(class_id) DO UPDATE SET excluded_by_design=excluded.excluded_by_design,
            excluded_not_enrolled=excluded.excluded_not_enrolled""",
                   (class_id, int(batch.get("excludedByDesign") or 0), int(batch.get("excludedNotEnrolled") or 0)))
    config = batch.get("appConfig")
    if isinstance(config, dict):
        mode = config.get("tutoringMode")
        source = config.get("source")
        _app_config[class_id] = {"tutoringMode": str(mode)[:40] if mode else None,
                                 "source": source if source in ("app", "class_override") else None}
        # CR-T5: persist the live value so Course settings › Kiwi connection shows it after a restart.
        db.execute("""INSERT INTO kiwi_sync (class_id, native_tutoring_mode, native_tutoring_mode_source) VALUES (?, ?, ?)
            ON CONFLICT(class_id) DO UPDATE SET native_tutoring_mode=excluded.native_tutoring_mode,
            native_tutoring_mode_source=excluded.native_tutoring_mode_source""",
                   (class_id, _app_config[class_id]["tutoringMode"], _app_config[class_id]["source"] or ""))


def _import_batch(db, class_id, batch):
    materials = _materials(db, class_id)
    imported = 0
    for record in sorted(batch.get("records") or [], key=lambda r: (r["timestamp"], r["id"])):
        imported += import_record(db, class_id, record, materials)
    return imported


def _backfill(connection, class_id, token, budget):
    """Per-user passes (``userId`` filter, from the beginning) for roster members first seen after the first sync."""
    imported, pages = 0, 0
    while pages < budget:
        with connection() as db:
            pending = db.execute("SELECT * FROM kiwi_user_sync WHERE class_id=? AND backfilled_at IS NULL ORDER BY first_seen_at, "
                                 "student_id LIMIT 1", (class_id,)).fetchone()
        if pending is None:
            break
        batch = remote(token, "activity", {"cursor": pending["backfill_cursor"], "userId": pending["student_id"],
                                           "metadata": "false"})
        pages += 1
        if batch.get("classId") != class_id:
            raise BridgeError("Kiwi returned activity for another course", 403)
        with connection() as db, dbmod.write_tx(db):
            imported += _import_batch(db, class_id, batch)
            done = not batch.get("hasMore")
            db.execute("UPDATE kiwi_user_sync SET backfill_cursor=?, backfilled_at=? WHERE class_id=? AND student_id=?",
                       (None if done else batch.get("nextCursor"), dbmod.now() if done else None, class_id, pending["student_id"]))
    return imported, pages


def sync(connection, class_id, token):
    with _cache_lock:
        lock = _sync_locks.setdefault(class_id, threading.Lock())
    if not lock.acquire(blocking=False):
        with connection() as db:
            return {**status(db, class_id), "busy": True}
    try:
        imported = 0
        with connection() as db:
            state = db.execute("SELECT * FROM kiwi_sync WHERE class_id=?", (class_id,)).fetchone()
            first_sync = state is None or not (state["checkpoint"] or state["snapshot"] or state["last_synced"])
            if state and state["projection_version"] != PROJECTION_VERSION and db.execute(
                    "SELECT 1 FROM events WHERE class_id=? AND source='kiwi' LIMIT 1", (class_id,)).fetchone():
                from server import migrations

                migrations.backup_once(db, PROJECTION_VERSION)  # destructive re-projection: backup first (§4.4)
        # Bound each request to five pages. The UI resumes the durable cursor
        # automatically and remains usable while a large class backfills.
        pages = 0
        more = False
        for page in range(MAX_SYNC_PAGES):
            with connection() as db:
                state = db.execute("SELECT * FROM kiwi_sync WHERE class_id=?", (class_id,)).fetchone()
                cursor = state["cursor"] if state and state["snapshot"] else replay_cursor(state["checkpoint"]) if state and state["checkpoint"] else None
                snapshot = state["snapshot"] if state else None
                if state and state["projection_version"] != PROJECTION_VERSION:
                    cursor, snapshot = None, None
            # P9: no write transaction is open while the bridge is called.
            batch = remote(token, "activity", {"cursor": cursor, "snapshot": snapshot, "metadata": "true" if page == 0 else "false"})
            pages += 1
            if batch.get("classId") != class_id:
                raise BridgeError("Kiwi returned activity for another course", 403)
            with connection() as db, dbmod.write_tx(db):
                if page == 0:
                    _apply_metadata(db, class_id, batch, first_sync)
                imported += _import_batch(db, class_id, batch)
                more = bool(batch["hasMore"])
                timestamp = dbmod.now()
                db.execute("""INSERT INTO kiwi_sync(class_id,cursor,snapshot,checkpoint,last_synced,has_more,metadata_truncated,projection_version)
                    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(class_id) DO UPDATE SET cursor=excluded.cursor,snapshot=excluded.snapshot,
                    checkpoint=COALESCE(excluded.checkpoint,kiwi_sync.checkpoint),last_synced=excluded.last_synced,
                    has_more=excluded.has_more,last_error=NULL,metadata_truncated=MAX(kiwi_sync.metadata_truncated,excluded.metadata_truncated),projection_version=excluded.projection_version""",
                    (class_id, batch["nextCursor"], batch["snapshot"] if more else None, None if more else batch["snapshot"], timestamp, int(more), int(batch.get("metadataTruncated", False)), PROJECTION_VERSION))
            if not more:
                break
        if not more and pages < MAX_SYNC_PAGES:
            extra, _used = _backfill(connection, class_id, token, MAX_SYNC_PAGES - pages)
            imported += extra
        with connection() as db:
            return {**status(db, class_id), "imported": imported, "perStudent": per_student(db, class_id)}
    except BridgeError as exc:
        with connection() as db:
            db.execute("INSERT INTO kiwi_sync(class_id,last_error) VALUES (?,?) ON CONFLICT(class_id) DO UPDATE SET last_error=excluded.last_error", (class_id, str(exc)))
        raise
    finally:
        lock.release()


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
