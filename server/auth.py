"""Identity resolution, roles, permissions, preview, demo sessions and staff keys (spec §5.3; FOUNDATION, frozen)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from collections import deque
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal, Mapping

from server import db as dbmod
from server import identity as identitymod
from server.router import STAFF_LEVELS, ApiError, Auth

PERMISSIONS: tuple[str, ...] = (
    "viewInsights", "viewStudents", "previewStudent", "viewAiRules", "viewAssignments", "editAssignments", "grade",
    "releaseGrades", "exportGrades", "manageCourse", "manageAiRules", "flagItems", "manageStudents", "exportActivity",
    "exportResearch", "manageStaff", "managePrivacy", "deleteData", "viewAudit", "coursePackage",
)
TA_PERMISSIONS = frozenset({"viewInsights", "viewStudents", "previewStudent", "viewAiRules", "viewAssignments", "grade",
                            "exportGrades", "flagItems", "exportActivity"})
VIEWER_PERMISSIONS = frozenset({"viewInsights", "viewStudents", "previewStudent", "viewAiRules", "exportActivity"})
# Decision D3: research analysts read Insights, chapters/AI tutor rules and groups (read-only) and export de-identified
# data. ``viewStudents`` (named teaching views: Home action lists, roster, Needs attention, profiles, search, gradebook,
# results, re-teach marks) and ``previewStudent`` are deliberately absent.
RESEARCHER_PERMISSIONS = frozenset({"viewInsights", "viewAiRules", "exportActivity", "exportResearch"})
# STAFF_VIEW routes without a permission that a researcher may still call (deny by default: a new permission-less staff
# route stays closed to researchers until it is reviewed and listed here).
RESEARCHER_OPEN_ROUTES = frozenset({
    "/api/teacher/time-range", "/api/teacher/settings", "/api/teacher/kiwi/status", "/api/teacher/kiwi/sync",
    "/api/teacher/exports/codebook.md",
    "/api/work-options",   # assignment titles/states for the explorer filters (staff metadata, no questions or answers)
})
STAFF_ROLES: tuple[str, ...] = ("instructor", "ta", "viewer", "researcher")
PSEUDONYMOUS_EXPORT_ROLES = frozenset({"viewer", "researcher"})
KIWI_STAFF_WITHOUT_ROLE = frozenset({"previewStudent"})
BUILTIN_DEMO_STUDENTS = {"demo-ada": "Ada Chen", "demo-bo": "Bo Lin"}
DEMO_SESSION_DAYS = 7
DEMO_LINK_DAYS = 14
KEY_CACHE_SECONDS = 300
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1
LINKED_MESSAGE = "Open this course's CSS Lab from Kiwi to use your verified course identity"


@dataclass(frozen=True)
class Identity:
    kind: Literal["kiwi", "teacher_key", "staff_key", "demo", "anonymous"]
    class_id: str
    user_id: str | None
    display_name: str
    kiwi_role: str | None
    staff_role: Literal["instructor", "ta", "viewer", "researcher"] | None
    is_staff: bool
    is_student: bool
    verified: bool
    preview: bool
    student_id: str | None
    permissions: frozenset[str]
    role_source: Literal["kiwi", "override", "key"] | None = None
    staff_id: str | None = None
    class_linked: bool = False
    key_failed: bool = False
    kiwi_context: dict = field(default_factory=dict, hash=False, compare=False)
    token: str | None = field(default=None, repr=False, hash=False, compare=False)

    @property
    def actor_role(self) -> str:
        if self.preview:
            return "preview"
        if self.staff_role:
            return self.staff_role
        if self.is_staff:
            return "staff"
        if self.kind == "kiwi":
            return "student"
        if self.kind == "demo":
            return "demo"
        return "unknown"


def anonymous(class_id: str, *, linked: bool = False, key_failed: bool = False) -> Identity:
    return Identity("anonymous", class_id, None, "", None, None, False, True, False, False, None, frozenset(),
                    class_linked=linked, key_failed=key_failed)


def student_identity(class_id: str, student_id: str, *, kind: str = "demo", display_name: str = "",
                     verified: bool | None = None, linked: bool = False) -> Identity:
    """Identity of a student (used by server-side writers and test builders)."""
    return Identity(kind, class_id, student_id, display_name or student_id, "student" if kind == "kiwi" else None,  # type: ignore[arg-type]
                    None, False, True, kind == "kiwi" if verified is None else verified, False, student_id, frozenset(),
                    class_linked=linked)


# -- teacher key provider -------------------------------------------------------------------------
_teacher_key_provider: Callable[[], str] | None = None


def set_teacher_key_provider(provider: Callable[[], str] | None) -> None:
    """``server/app.py`` registers ``lambda: TEACHER_KEY`` so tests can assign ``app.TEACHER_KEY``."""
    global _teacher_key_provider
    _teacher_key_provider = provider


def teacher_key() -> str:
    if _teacher_key_provider is not None:
        return _teacher_key_provider() or ""
    return os.environ.get("KIWI_TEACHER_KEY", "")


# -- failure limits -------------------------------------------------------------------------------
class FailureLimiter:
    """Teacher-key failures: >10 per address per 60 s → 429; >100 globally → 2 s delay per failure."""

    ADDR_LIMIT = 10
    GLOBAL_LIMIT = 100
    WINDOW = 60.0
    DELAY = 2.0

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._per_addr: dict[str, deque[float]] = {}
        self._global: deque[float] = deque()

    def _prune(self, bucket: deque[float], now: float) -> None:
        while bucket and now - bucket[0] > self.WINDOW:
            bucket.popleft()

    def blocked(self, addr: str) -> bool:
        now = time.monotonic()
        with self._lock:
            bucket = self._per_addr.get(addr)
            if not bucket:
                return False
            self._prune(bucket, now)
            return len(bucket) >= self.ADDR_LIMIT

    def record(self, addr: str) -> bool:
        """Record one failure; returns True when the global limit is exceeded (answer after a delay)."""
        now = time.monotonic()
        with self._lock:
            bucket = self._per_addr.setdefault(addr, deque())
            self._prune(bucket, now)
            bucket.append(now)
            self._prune(self._global, now)
            self._global.append(now)
            if len(self._per_addr) > 5000:
                for key in [k for k, v in self._per_addr.items() if not v or now - v[-1] > self.WINDOW]:
                    del self._per_addr[key]
            return len(self._global) > self.GLOBAL_LIMIT

    def reset(self) -> None:
        with self._lock:
            self._per_addr.clear()
            self._global.clear()


LIMITER = FailureLimiter()
_sleep: Callable[[float], None] = time.sleep

# -- staff keys -----------------------------------------------------------------------------------
_key_cache: dict[str, tuple[float, str, str, str, str]] = {}   # sha256(key) → (expires, class, staff_id, role, name)
_key_lock = threading.Lock()


def clear_key_cache(staff_id: str | None = None) -> None:
    """Forget verified staff keys (all, or those of one revoked staff member)."""
    with _key_lock:
        if staff_id is None:
            _key_cache.clear()
            return
        for digest in [d for d, value in _key_cache.items() if value[2] == staff_id]:
            del _key_cache[digest]


def new_staff_key() -> str:
    return secrets.token_hex(12)


def key_prefix(key: str) -> str:
    return key[:8]


def hash_staff_key(key: str, *, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(key.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_staff_key(key: str, stored: str | None) -> bool:
    try:
        scheme, n, r, p, salt_hex, hash_hex = (stored or "").split("$")
        if scheme != "scrypt":
            return False
        digest = hashlib.scrypt(key.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p),
                                dklen=len(bytes.fromhex(hash_hex)))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), hash_hex)


# -- demo sessions --------------------------------------------------------------------------------
def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _demo_secret(db: sqlite3.Connection) -> bytes:
    row = db.execute("SELECT value FROM server_secrets WHERE name='demo-session'").fetchone()
    if row is None:
        with dbmod.write_tx(db):
            db.execute("INSERT INTO server_secrets (name, value, created_at) VALUES ('demo-session', ?, ?) "
                       "ON CONFLICT(name) DO NOTHING", (secrets.token_hex(32), dbmod.now()))
            row = db.execute("SELECT value FROM server_secrets WHERE name='demo-session'").fetchone()
    return bytes.fromhex(row["value"])


def mint_demo_token(db: sqlite3.Connection, class_id: str, student_id: str, *, days: int = DEMO_SESSION_DAYS,
                    expires: int | None = None) -> tuple[str, str]:
    """Returns ``(token, expiresAt ISO)``; token = ``demo.<b64url(json{c,s,e})>.<b64url(HMAC)>``."""
    exp = expires if expires is not None else int((dbmod.utcnow() + timedelta(days=days)).timestamp())
    payload = _b64(json.dumps({"c": class_id, "s": student_id, "e": exp}, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(_demo_secret(db), ("demo." + payload).encode("ascii"), hashlib.sha256).digest()
    expires_at = dbmod.iso_seconds(datetime.fromtimestamp(exp, timezone.utc))
    return f"demo.{payload}.{_b64(signature)}", expires_at


def verify_demo_token(db: sqlite3.Connection, token: str) -> dict | None:
    """Returns the payload ``{c, s, e}`` of a valid, unexpired token, else ``None``."""
    try:
        prefix, payload, signature = token.split(".")
        if prefix != "demo":
            return None
        expected = hmac.new(_demo_secret(db), ("demo." + payload).encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(signature)):
            return None
        data = json.loads(_unb64(payload))
    except (ValueError, TypeError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict) or not all(k in data for k in ("c", "s", "e")):
        return None
    if not isinstance(data["e"], int) or data["e"] <= int(dbmod.utcnow().timestamp()):
        return None
    return data


DEMO_REMOVED = "This demo link no longer works because the student's data was removed from the course."


def demo_name(db: sqlite3.Connection, class_id: str, student_id: str) -> str:
    return BUILTIN_DEMO_STUDENTS.get(student_id) or identitymod.label(db, class_id, student_id, "names")


# -- permissions ----------------------------------------------------------------------------------
def permissions_for(role: str | None, settings: Mapping[str, Any] | None, *, kiwi_staff: bool = False) -> frozenset[str]:
    settings = settings or {}
    if role == "instructor":
        return frozenset(PERMISSIONS)
    if role == "ta":
        perms = set(TA_PERMISSIONS)
        if (settings.get("grading") or {}).get("taCanRelease"):
            perms.add("releaseGrades")
        return frozenset(perms)
    if role == "viewer":
        perms = set(VIEWER_PERMISSIONS)
        if (settings.get("privacy") or {}).get("viewerCanExportResearch"):
            perms.add("exportResearch")
        return frozenset(perms)
    if role == "researcher":
        return RESEARCHER_PERMISSIONS
    if kiwi_staff:
        return KIWI_STAFF_WITHOUT_ROLE
    return frozenset()


def _settings(db: sqlite3.Connection, class_id: str) -> dict:
    from server import readers

    return readers.settings(db, class_id)


# -- resolution -----------------------------------------------------------------------------------
def _header(headers: Mapping[str, str], name: str) -> str:
    value = headers.get(name)
    return value.strip() if isinstance(value, str) else ""


def _resolve_kiwi(db: sqlite3.Connection, authorization: str, class_id: str) -> Identity:
    from server import kiwi_bridge

    context = kiwi_bridge.authenticate(authorization, class_id)
    user_id = str(context.get("userId"))
    username = str(context.get("username") or "")
    class_name = str(context.get("className") or class_id)
    row = db.execute("SELECT name FROM kiwi_links WHERE class_id=?", (class_id,)).fetchone()
    if row is None or row["name"] != class_name:
        with dbmod.write_tx(db):
            db.execute("INSERT INTO kiwi_links (class_id, name) VALUES (?, ?) ON CONFLICT(class_id) DO UPDATE "
                       "SET name=excluded.name", (class_id, class_name))
    kiwi_staff = bool(context.get("canTeach"))
    can_manage, can_view = bool(context.get("canManageCourse")), bool(context.get("canViewAnalytics"))
    user_role = context.get("userRole")
    role: str | None = None
    source: str | None = None
    staff_id: str | None = None
    if kiwi_staff:
        override = db.execute(
            "SELECT id, role FROM staff WHERE class_id=? AND kiwi_user_id=? AND revoked_at IS NULL",
            (class_id, user_id)).fetchone()
        if override:
            role, source, staff_id = override["role"], "override", override["id"]
    if role is None:
        if user_role == "ta" and (can_view or can_manage):
            role = "ta"
        elif can_manage:
            role = "instructor"
        elif can_view:
            role = "viewer"
        source = "kiwi" if role else None
    is_staff = role is not None or kiwi_staff
    if is_staff:
        _upsert_staff_seen(db, class_id, user_id, username, str(user_role or ""), can_manage, can_view)
    perms = permissions_for(role, _settings(db, class_id) if role in ("ta", "viewer") else None, kiwi_staff=kiwi_staff)
    return Identity("kiwi", class_id, user_id, username, str(user_role) if user_role else None, role, is_staff,  # type: ignore[arg-type]
                    not is_staff, True, False, None if is_staff else user_id, perms, source, staff_id,  # type: ignore[arg-type]
                    class_linked=True, kiwi_context=dict(context), token=authorization[7:])


def _upsert_staff_seen(db: sqlite3.Connection, class_id: str, user_id: str, username: str, kiwi_role: str,
                       can_manage: bool, can_view: bool) -> None:
    row = db.execute("SELECT * FROM kiwi_staff_seen WHERE class_id=? AND kiwi_user_id=?", (class_id, user_id)).fetchone()
    stamp = dbmod.now()
    if row is not None:
        same = (row["username"], row["kiwi_role"], row["can_manage_course"], row["can_view_analytics"]) == (
            username, kiwi_role, int(can_manage), int(can_view))
        last = dbmod.parse_iso(row["last_seen_at"])
        if same and last is not None and dbmod.utcnow() - last < timedelta(hours=1):
            return
    with dbmod.write_tx(db):
        db.execute(
            """INSERT INTO kiwi_staff_seen (class_id, kiwi_user_id, username, kiwi_role, can_manage_course,
            can_view_analytics, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(class_id, kiwi_user_id) DO UPDATE SET username=excluded.username, kiwi_role=excluded.kiwi_role,
            can_manage_course=excluded.can_manage_course, can_view_analytics=excluded.can_view_analytics,
            last_seen_at=excluded.last_seen_at""",
            (class_id, user_id, username, kiwi_role, int(can_manage), int(can_view), stamp, stamp),
        )


def _resolve_key(db: sqlite3.Connection, key: str, class_id: str, client_addr: str) -> Identity:
    if LIMITER.blocked(client_addr):
        raise ApiError(429, "rate_limited", "Too many incorrect teacher keys. Wait a minute and try again.",
                       headers={"Retry-After": "60"})
    configured = teacher_key()
    if not configured:
        raise ApiError(503, "teacher_key_not_configured",
                       "Set KIWI_TEACHER_KEY on the server to use the local teacher workspace.")
    if hmac.compare_digest(key.encode("utf-8"), configured.encode("utf-8")):
        return Identity("teacher_key", class_id, "instructor", "Instructor (local key)", None, "instructor", True, False,
                        False, False, None, permissions_for("instructor", None), "key")
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    with _key_lock:
        cached = _key_cache.get(digest)
    staff: tuple[str, str, str] | None = None
    if cached and cached[0] > time.monotonic() and cached[1] == class_id:
        staff = (cached[2], cached[3], cached[4])
    elif len(key) >= 8:
        row = db.execute(
            "SELECT id, role, display_name, key_hash FROM staff WHERE class_id=? AND key_prefix=? AND revoked_at IS NULL",
            (class_id, key_prefix(key))).fetchone()
        if row is not None and verify_staff_key(key, row["key_hash"]):
            staff = (row["id"], row["role"], row["display_name"])
            with _key_lock:
                if len(_key_cache) > 1000:
                    _key_cache.clear()
                _key_cache[digest] = (time.monotonic() + KEY_CACHE_SECONDS, class_id, *staff)
    if staff is None:
        if LIMITER.record(client_addr):
            _sleep(FailureLimiter.DELAY)
        return anonymous(class_id, key_failed=True)
    staff_id, role, name = staff
    perms = permissions_for(role, _settings(db, class_id) if role in ("ta", "viewer") else None)
    return Identity("staff_key", class_id, staff_id, name, None, role, True, False, False, False, None, perms,  # type: ignore[arg-type]
                    "key", staff_id)


def resolve(headers: Mapping[str, str], class_id: str, path: str, *, client_addr: str = "",
            db: sqlite3.Connection | None = None) -> Identity:
    """Resolve the caller (Kiwi token > teacher/staff key > demo session > anonymous), then preview."""
    if db is None:
        with dbmod.connection() as owned:
            return resolve(headers, class_id, path, client_addr=client_addr, db=owned)
    if path == "/api/health":
        return anonymous(class_id)
    linked = identitymod.class_linked(db, class_id)
    authorization = _header(headers, "Authorization")
    key = _header(headers, "X-Teacher-Key")
    demo = _header(headers, "X-Demo-Session")
    if authorization:
        ident = _resolve_kiwi(db, authorization, class_id)
    elif linked:
        raise ApiError(401, "unauthenticated", LINKED_MESSAGE)
    elif key:
        ident = _resolve_key(db, key, class_id, client_addr)
    elif demo:
        data = verify_demo_token(db, demo)
        if data is None:
            raise ApiError(401, "unauthenticated", "Your demo session is invalid or expired. Open the student workspace again.")
        if data["c"] != class_id:
            raise ApiError(403, "forbidden", "This demo session belongs to another course")
        student = str(data["s"])
        if identitymod.tombstone(db, class_id, student) is not None:
            # SB-m09: a deleted or anonymized student's session must not write new rows under the removed id
            raise ApiError(403, "forbidden", DEMO_REMOVED)
        ident = Identity("demo", class_id, student, demo_name(db, class_id, student), None, None, False, True, False,
                         False, student, frozenset())
    else:
        ident = anonymous(class_id, linked=linked)
    if _header(headers, "X-Kiwi-Preview") == "1":
        if not ident.is_staff:
            raise ApiError(403, "forbidden", "Preview as student is only available to course staff")
        if "previewStudent" not in ident.permissions:
            raise ApiError(403, "forbidden", "Preview as student is not part of your course role")
        ident = replace(ident, is_staff=True, is_student=False, preview=True, student_id=f"preview-{ident.user_id}")
    return ident


# -- route enforcement ----------------------------------------------------------------------------
def _deny_message(ident: Identity) -> str:
    if ident.kind == "kiwi":
        return "Your Kiwi account does not have permission for this course action."
    return "Your role does not include this action."


def authorize(req: Any, spec: Any) -> None:
    """Enforce a route's auth levels and permission; check student identity and course registration."""
    ident: Identity = req.identity
    levels: tuple[Auth, ...] = spec.auth
    if Auth.PUBLIC in levels:
        return
    staff_levels = [level for level in levels if level in STAFF_LEVELS]
    student_ok = Auth.STUDENT in levels
    if ident.kind == "anonymous":
        if ident.key_failed:
            raise ApiError(401, "unauthenticated", "Teacher key is incorrect")
        if student_ok and not staff_levels:
            raise ApiError(401, "unauthenticated", "Open the student workspace from your course link to continue.")
        raise ApiError(401, "unauthenticated", "Sign in to the teacher workspace to continue.")
    as_student = False
    if student_ok and ident.preview:
        as_student = True
    elif staff_levels and ident.staff_role and any(ident.staff_role in STAFF_LEVELS[level] for level in staff_levels):
        if spec.permission and spec.permission not in ident.permissions:
            raise ApiError(403, "role_required", _deny_message(ident))
        if ident.staff_role == "researcher" and not spec.permission and spec.template not in RESEARCHER_OPEN_ROUTES:
            # Decision D3: permission-less staff routes (legacy work/chat lists, assignment files…) stay closed.
            raise ApiError(403, "role_required", _deny_message(ident))
        return
    elif student_ok and ident.is_student:
        as_student = True
    elif student_ok and ident.is_staff and "previewStudent" not in ident.permissions:
        raise ApiError(403, "role_required", _deny_message(ident))
    elif student_ok and ident.is_staff and not (staff_levels and ident.staff_role):
        raise ApiError(403, "preview_required", "Staff accounts open the student view through Preview as student.")
    else:
        raise ApiError(403, "role_required", _deny_message(ident))
    if as_student:
        check_student_request(req)


def check_student_request(req: Any) -> None:
    ident: Identity = req.identity
    expected = ident.student_id
    mismatch = ("Student identity must match the Kiwi token" if ident.kind == "kiwi"
                else "Student activity belongs to another user")
    query_student = req.query.get("studentId")
    if query_student not in (None, "") and query_student != expected:
        raise ApiError(403, "forbidden", mismatch)
    writes = req.method in ("POST", "PUT", "PATCH", "DELETE")
    if writes and req.has_body():
        body = req.json()
        if isinstance(body, dict) and body.get("studentId") not in (None, "") and body.get("studentId") != expected:
            raise ApiError(403, "forbidden", mismatch)
    if writes and not ident.class_linked and not identitymod.class_linked(req.db, req.class_id):
        from server import readers

        if not readers.registered_standalone(req.db, req.class_id):
            raise ApiError(404, "unknown_course", "This course is not set up in CSS Lab yet. Ask your teacher for the course link.")


def me(ident: Identity, db: sqlite3.Connection) -> dict:
    """``Me`` (§7.1) for ``GET /api/me``."""
    role: str | None = ident.staff_role
    if role is None and ident.is_student and ident.kind != "anonymous":
        role = "student"
    return {
        "kind": ident.kind,
        "classId": ident.class_id,
        "userId": ident.user_id,
        "displayName": ident.display_name,
        "role": role,
        "permissions": [p for p in PERMISSIONS if p in ident.permissions],
        "isStaff": ident.is_staff,
        "roleSource": ident.role_source,
        "exportsForcedPseudonymous": ident.staff_role in PSEUDONYMOUS_EXPORT_ROLES,
        "pseudonymsForced": ident.staff_role == "researcher",
        "preview": ident.preview,
        "verified": ident.verified,
        "classLinked": ident.class_linked or identitymod.class_linked(db, ident.class_id),
        "staffId": ident.staff_id,
    }
