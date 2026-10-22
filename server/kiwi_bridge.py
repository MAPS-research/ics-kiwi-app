"""Verified Kiwi identity and an incremental, idempotent copy of native course activity.

No Kiwi signing secret or parent session is shared with this application.
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

try:
    from server import analytics
except ModuleNotFoundError:
    import analytics


class BridgeError(Exception):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


_identity_cache = {}
_cache_lock = threading.Lock()
_sync_locks = {}
PROJECTION_VERSION = "native-projection-v2"


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


def authenticate(header, class_id):
    if not header.startswith("Bearer ") or not 1 < len(header) < 20000:
        raise BridgeError("A Kiwi app token is required", 401)
    token = header[7:]
    key = hashlib.sha256(token.encode()).hexdigest()
    with _cache_lock:
        cached = _identity_cache.get(key)
    if cached and cached[0] > time.monotonic():
        identity = cached[1]
    else:
        identity = remote(token, "context")
        with _cache_lock:
            if len(_identity_cache) >= 128:
                _identity_cache.clear()
            _identity_cache[key] = (time.monotonic() + 5, identity)
    if identity.get("classId") != class_id or not identity.get("userId"):
        raise BridgeError("The Kiwi token belongs to another course", 403)
    return identity


def init(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS kiwi_links (class_id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS kiwi_sync (
            class_id TEXT PRIMARY KEY, cursor TEXT, snapshot TEXT, checkpoint TEXT,
            last_synced TEXT, last_error TEXT, has_more INTEGER NOT NULL DEFAULT 0,
            metadata_truncated INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS kiwi_materials (
            class_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
            document_ids TEXT NOT NULL, unit_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(class_id,id)
        );
    """)
    if "projection_version" not in {r[1] for r in db.execute("PRAGMA table_info(kiwi_sync)")}:
        db.execute("ALTER TABLE kiwi_sync ADD COLUMN projection_version TEXT NOT NULL DEFAULT ''")


def linked(db, class_id):
    configured = os.environ.get("KIWI_CLASS_IDS", "local-css-demo").split(",")
    return class_id in configured or bool(db.execute("SELECT 1 FROM kiwi_links WHERE class_id=?", (class_id,)).fetchone())


def status(db, class_id):
    row = db.execute("SELECT * FROM kiwi_sync WHERE class_id=?", (class_id,)).fetchone()
    native = db.execute("SELECT COUNT(*) FROM events WHERE class_id=? AND source='kiwi'", (class_id,)).fetchone()[0]
    return {"connected": linked(db, class_id), "lastSynced": row["last_synced"] if row else None,
            "error": row["last_error"] if row else None, "hasMore": bool(row and row["has_more"]),
            "metadataTruncated": bool(row and row["metadata_truncated"]), "nativeEvents": native,
            "materials": [dict(r) for r in db.execute("SELECT id,title,unit_id unitId FROM kiwi_materials WHERE class_id=? ORDER BY title,id", (class_id,))]}


def iso(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat(timespec="milliseconds")


def replay_cursor(checkpoint):
    # Replay the previous five minutes after each completed snapshot. This also
    # reconciles short transactions that committed after the previous read.
    at = datetime.fromisoformat(checkpoint.replace("Z", "+00:00")) - timedelta(minutes=5)
    data = json.dumps({"at": at.isoformat(), "key": ""}).encode()
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


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
    event_type = "material_viewed" if is_view else "code_run" if kind.endswith("-runcode") else "code_shared" if is_code else "ai_question"
    material = materials.get(record.get("pdfId"), {})
    mid = material.get("id") or record.get("pdfId") or ""
    page = record.get("pdfPage")
    # PDF viewer events use a zero-based currentPage; ChatCore/chatContext
    # send a one-based pageNumber to Kiwi's chat endpoint.
    display_page = page + 1 if page is not None and is_view else page if isinstance(page, int) and page > 0 else None
    thread = record.get("conversationId") or record.get("stringTag") or ("reading" if is_view else "scratchpad" if is_code else record["id"])
    actions = record.get("serverActions") or []
    action = actions[0] if actions else {}
    surface = "lecture" if mid else "scratchpad" if is_code else "chat"
    title = (record.get("conversation") or {}).get("title") or material.get("title") or ("Kiwi scratchpad" if is_code else "Kiwi conversation")
    if mid and display_page is not None:
        title += f" · page {display_page}"
    payload = {"source": "kiwi", "surface": surface, "upstreamId": record["id"], "upstreamType": kind,
        "threadId": thread, "materialId": mid, "materialTitle": material.get("title") or mid,
        "unitId": material.get("unit_id") or "", "page": display_page, "upstreamPage": page,
        "title": title, "prompt": str(content.get("prompt") or context.get("prompt") or context.get("message") or "")[:100000],
        "code": str(context.get("userCode") or context.get("code") or "")[:100000],
        "output": str(context.get("outputCode") or context.get("output") or "")[:100000],
        "response": str(action.get("botResponse") or "")[:100000],
        "upstreamActionId": action.get("id"), "responseState": "received" if action else "not-recorded"}
    if isinstance(context.get("success"), bool) and context.get("resultVersion") == "captured-result-v1":
        payload["ok"] = context["success"]
    if is_code:
        payload["language"] = context.get("language") or "not-recorded"
        payload["resultVersion"] = context.get("resultVersion")
    if context.get("error"):
        payload["error"] = str(context["error"])[:100000]
    payload["truncated"] = bool(record.get("truncated")) or any(len(str(value)) > 100000 for value in [content.get("prompt", ""), context.get("userCode", ""), context.get("outputCode", ""), action.get("botResponse", "")])
    return event_type, payload


def import_record(db, class_id, record, materials):
    event_type, payload = payload_for(record, materials)
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    old = db.execute("SELECT * FROM events WHERE class_id=? AND source='kiwi' AND upstream_id=?", (class_id, record["id"])).fetchone()
    name = record["user"]["email"]
    if old:
        if json.loads(old["payload_json"]) == payload:
            return False
        # ServerAction updates replace evidence and adjust the existing rollup;
        # they never count as an additional student question or interaction.
        before = analytics.event_counters(old["event_type"], json.loads(old["payload_json"]))
        after = analytics.event_counters(event_type, payload)
        db.execute("UPDATE events SET payload_json=?,student_name=? WHERE id=?", (serialized, name, old["id"]))
        kind = "reading" if event_type == "material_viewed" else "code" if event_type in ("code_run", "code_shared") else "thread"
        context_key = json.dumps(["kiwi", payload["materialId"], payload["page"], payload["threadId"], kind])
        db.execute("UPDATE learning_sessions SET " + ",".join(f"{c}={c}+?" for c in analytics.COUNTERS) + ",studentName=?,title=?,contextKey=? WHERE id=?",
                   [*[after[c] - before[c] for c in analytics.COUNTERS], name, payload["title"], context_key, old["learning_session_id"]])
        return False
    cur = db.execute("""INSERT INTO events (class_id,student_id,student_name,session_id,event_type,payload_json,created_at,source,upstream_id)
        VALUES (?,?,?,?,?,?,?,?,?)""", (class_id, record["userId"], name, record["sessionId"], event_type,
        serialized, iso(record["timestamp"]), "kiwi", record["id"]))
    analytics.index_event(db, db.execute("SELECT * FROM events WHERE id=?", (cur.lastrowid,)).fetchone())
    return True


def sync(connection, class_id, token):
    with _cache_lock:
        lock = _sync_locks.setdefault(class_id, threading.Lock())
    if not lock.acquire(blocking=False):
        with connection() as db:
            return {**status(db, class_id), "busy": True}
    try:
        imported = 0
        # Bound each request to five pages. The UI resumes the durable cursor
        # automatically and remains usable while a large class backfills.
        for page in range(5):
            with connection() as db:
                state = db.execute("SELECT * FROM kiwi_sync WHERE class_id=?", (class_id,)).fetchone()
                cursor = state["cursor"] if state and state["snapshot"] else replay_cursor(state["checkpoint"]) if state and state["checkpoint"] else None
                snapshot = state["snapshot"] if state else None
                if state and state["projection_version"] != PROJECTION_VERSION:
                    cursor, snapshot = None, None
            batch = remote(token, "activity", {"cursor": cursor, "snapshot": snapshot, "metadata": "true" if page == 0 else "false"})
            if batch.get("classId") != class_id:
                raise BridgeError("Kiwi returned activity for another course", 403)
            with connection() as db:
                for material in batch.get("materials") or []:
                    ids = [d["id"] for d in material.get("documents", [])]
                    title = material.get("title") or next((d["fileName"] for d in material.get("documents", [])), material["id"])
                    db.execute("INSERT INTO kiwi_materials(class_id,id,title,document_ids) VALUES (?,?,?,?) ON CONFLICT(class_id,id) DO UPDATE SET title=excluded.title,document_ids=excluded.document_ids", (class_id, material["id"], title, json.dumps(ids)))
                for student in batch.get("roster") or []:
                    db.execute("INSERT INTO roster VALUES (?,?,?) ON CONFLICT(class_id,student_id) DO NOTHING", (class_id, student["userId"], student["user"]["email"]))
                materials = {}
                for row in db.execute("SELECT * FROM kiwi_materials WHERE class_id=?", (class_id,)):
                    materials[row["id"]] = dict(row)
                    for doc_id in json.loads(row["document_ids"]):
                        materials[doc_id] = dict(row)
                for record in sorted(batch["records"], key=lambda r: (r["timestamp"], r["id"])):
                    imported += import_record(db, class_id, record, materials)
                more = bool(batch["hasMore"])
                timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
                db.execute("""INSERT INTO kiwi_sync(class_id,cursor,snapshot,checkpoint,last_synced,has_more,metadata_truncated,projection_version)
                    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(class_id) DO UPDATE SET cursor=excluded.cursor,snapshot=excluded.snapshot,
                    checkpoint=COALESCE(excluded.checkpoint,kiwi_sync.checkpoint),last_synced=excluded.last_synced,
                    has_more=excluded.has_more,last_error=NULL,metadata_truncated=MAX(kiwi_sync.metadata_truncated,excluded.metadata_truncated),projection_version=excluded.projection_version""",
                    (class_id, batch["nextCursor"], batch["snapshot"] if more else None, None if more else batch["snapshot"], timestamp, int(more), int(batch.get("metadataTruncated", False)), PROJECTION_VERSION))
            if not more:
                break
        with connection() as db:
            return {**status(db, class_id), "imported": imported}
    except BridgeError as exc:
        with connection() as db:
            db.execute("INSERT INTO kiwi_sync(class_id,last_error) VALUES (?,?) ON CONFLICT(class_id) DO UPDATE SET last_error=excluded.last_error", (class_id, str(exc)))
        raise
    finally:
        lock.release()


def map_material(db, class_id, material_id, unit_id):
    if db.execute("UPDATE kiwi_materials SET unit_id=? WHERE class_id=? AND id=?", (unit_id, class_id, material_id)).rowcount != 1:
        raise ValueError("Kiwi material not found in this course. Refresh Kiwi activity first.")
    # A mapping is metadata on existing sessions; preserve their identities and
    # event counts, so bookmarked evidence remains valid after linking a chapter.
    db.execute("UPDATE learning_sessions SET unitId=? WHERE classId=? AND source='kiwi' AND materialId=?", (unit_id, class_id, material_id))
    db.execute("""UPDATE events SET payload_json=json_set(payload_json,'$.unitId',?)
        WHERE class_id=? AND source='kiwi' AND json_extract(payload_json,'$.materialId')=?""", (unit_id, class_id, material_id))
