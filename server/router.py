"""Route registry, request/response objects, dispatch and error mapping (spec §5.2; FOUNDATION, frozen).

Route modules register handlers with ``@route(...)``; ``server/app.py``'s ``Handler`` calls
``dispatch(handler, method)`` for every HTTP method. Handlers receive a ``Request`` and return a
``dict``/``list`` (JSON 200), a ``Response``, or ``None`` (204).
"""

from __future__ import annotations

import json
import re
import shutil
import sqlite3
import sys
import tempfile
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Iterable, Literal, Mapping
from urllib.parse import parse_qs, unquote, urlparse

from server import db as dbmod

DEFAULT_CLASS_ID = "local-r-class"
ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:@-]{1,100}$")      # v0.5.1 identifiers (classId, body ids)
PARAM_PATTERN = re.compile(r"^[A-Za-z0-9_.:@-]{1,120}$")   # path parameters (decoded)
_INT_PATTERN = re.compile(r"^-?\d{1,15}$")
SPOOL_MAX = 8 * 1024 * 1024
_SCRUB_NULL_KEYS = ("email", "kiwiEmail", "studentEmail", "emails")
_ROW_COUNT_KEYS = ("rows", "students", "items", "events", "submissions", "assignments", "threads", "entries", "cards")


class Auth(str, Enum):
    PUBLIC = "public"            # identity resolved if present, not required (linked classes still reject anonymous)
    STUDENT = "student"          # Kiwi student, demo session, or staff with X-Kiwi-Preview (acts as preview student)
    STAFF_VIEW = "staff_view"    # instructor | ta | viewer | researcher (decision D3: permission-gated, see auth.authorize)
    STAFF_GRADE = "staff_grade"  # instructor | ta
    INSTRUCTOR = "instructor"


STAFF_LEVELS: dict[Auth, tuple[str, ...]] = {
    Auth.STAFF_VIEW: ("instructor", "ta", "viewer", "researcher"),
    Auth.STAFF_GRADE: ("instructor", "ta"),
    Auth.INSTRUCTOR: ("instructor",),
}


class ApiError(Exception):
    """An error answered as ``{"error", "code", "details"?}`` with the given HTTP status."""

    def __init__(self, status: int, code: str, message: str, details: dict | None = None,
                 headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.headers = dict(headers or {})


def valid_id(value: object) -> bool:
    return isinstance(value, str) and ID_PATTERN.fullmatch(value) is not None


@dataclass
class Response:
    status: int = 200
    body: object = None
    headers: dict[str, str] = field(default_factory=dict)
    content_type: str = "application/json; charset=utf-8"
    stream: Iterable[bytes] | None = None     # file download (CSV/JSONL/ZIP): spooled, then sent with Content-Length
    filename: str | None = None               # sets Content-Disposition: attachment


_UNSET = object()


class Request:
    """One API request. ``req.db`` is a per-request connection committed after a successful handler."""

    def __init__(self, handler: Any, method: str, path: str, query: dict[str, str], request_id: str,
                 client_addr: str):
        self.handler = handler
        self.method = method
        self.path = path
        self.params: dict[str, str] = {}
        self.query = query
        self.headers: Mapping[str, str] = handler.headers if handler is not None else {}
        self.class_id = ""
        self.identity: Any = None
        mode = (self.headers.get("X-Name-Mode") or "").strip().lower()
        self.name_mode: Literal["names", "pseudonyms"] = "pseudonyms" if mode == "pseudonyms" else "names"
        self.request_id = request_id
        self.client_addr = client_addr
        self.max_body = 4_200_000
        self._json: object = _UNSET
        self._db: sqlite3.Connection | None = None

    # -- body -------------------------------------------------------------------------------------
    def json(self) -> object:
        if self._json is not _UNSET:
            return self._json
        raw_length = self.headers.get("Content-Length") or "0"
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise ApiError(400, "invalid_request", "Content-Length is invalid") from exc
        if length < 1:
            raise ApiError(400, "invalid_json", "A JSON request body is required")
        if length > self.max_body:
            raise ApiError(400, "invalid_request", "Request body is too large")
        data = self.handler.rfile.read(length)
        try:
            self._json = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ApiError(400, "invalid_json", "Request body is not valid JSON") from exc
        return self._json

    def has_body(self) -> bool:
        try:
            return int(self.headers.get("Content-Length") or "0") > 0
        except ValueError:
            return False

    def body(self) -> dict:
        data = self.json()
        if not isinstance(data, dict):
            raise ApiError(400, "invalid_request", "Request body must be an object")
        return data

    def body_or_empty(self) -> dict:
        return self.body() if self.has_body() else {}

    def as_student(self) -> bool:
        """True when the caller acts as a student (Kiwi/demo student, or staff in Preview as student)."""
        ident = self.identity
        return bool(ident is not None and ident.student_id and (ident.preview or ident.is_student))

    def student_body(self) -> dict:
        """Body of a student write with ``studentId``/``studentName`` taken from the verified identity.

        The router already rejected a body ``studentId`` that differs from the caller (403).
        """
        data = dict(self.body())
        ident = self.identity
        if "classId" in data and data["classId"] != self.class_id:
            raise ApiError(403, "forbidden", "Activity belongs to another course")
        if not self.as_student():
            return data
        data["studentId"] = ident.student_id
        name = data.get("studentName")
        if ident.kind == "kiwi" and not ident.preview:
            data["studentName"] = ident.display_name or ident.student_id
        elif not isinstance(name, str) or not name.strip():
            data["studentName"] = "Preview student" if ident.preview else (ident.display_name or "Student")
        return data

    # -- query helpers ----------------------------------------------------------------------------
    def q_str(self, name: str, default: str = "", max_len: int = 200) -> str:
        value = self.query.get(name)
        if value is None:
            return default
        if len(value) > max_len:
            raise ApiError(400, "invalid_request", f"{name} is too long")
        return value

    def q_int(self, name: str, default: int, lo: int, hi: int, *, clamp: bool = False) -> int:
        raw = self.query.get(name)
        if raw is None or raw == "":
            return default
        if not _INT_PATTERN.fullmatch(raw.strip()):
            raise ApiError(400, "invalid_request", f"{name} must be an integer from {lo} to {hi}")
        value = int(raw.strip())
        if value < lo or value > hi:
            if clamp:
                return min(max(value, lo), hi)
            raise ApiError(400, "invalid_request", f"{name} must be an integer from {lo} to {hi}")
        return value

    def q_bool(self, name: str, default: bool = False) -> bool:
        raw = (self.query.get(name) or "").strip().lower()
        if raw == "":
            return default
        if raw in ("1", "true"):
            return True
        if raw in ("0", "false"):
            return False
        raise ApiError(400, "invalid_request", f"{name} must be 1 or 0")

    def q_choice(self, name: str, choices: Iterable[str], default: str) -> str:
        options = tuple(choices)
        raw = self.query.get(name)
        if raw is None or raw == "":
            return default
        if raw not in options:
            raise ApiError(400, "invalid_request", f"{name} must be one of: {', '.join(options)}")
        return raw

    def q_list(self, name: str, max_items: int = 100) -> list[str]:
        raw = self.query.get(name) or ""
        items = [part.strip() for part in raw.split(",") if part.strip()]
        if len(items) > max_items:
            raise ApiError(400, "invalid_request", f"{name} accepts at most {max_items} values")
        for item in items:
            if not PARAM_PATTERN.fullmatch(item):
                raise ApiError(400, "invalid_request", f"{name} contains an invalid id")
        return items

    def q_id(self, name: str, *, required: bool = False) -> str | None:
        raw = self.query.get(name)
        if raw is None or raw == "":
            if required:
                raise ApiError(400, "invalid_request", f"{name} is required")
            return None
        if not valid_id(raw):
            raise ApiError(400, "invalid_request", f"{name} has an invalid format")
        return raw

    def q_iso(self, name: str) -> str | None:
        raw = self.query.get(name)
        if raw is None or raw == "":
            return None
        try:
            parsed = dbmod.parse_iso(raw)
        except ValueError as exc:
            raise ApiError(400, "invalid_request", f"{name} must be an ISO date-time") from exc
        return dbmod.iso_seconds(parsed) if parsed else None

    # -- shared state -----------------------------------------------------------------------------
    @property
    def db(self) -> sqlite3.Connection:
        if self._db is None:
            self._db = dbmod.connection()
        return self._db

    def audit(self, action: str, target_type: str, target_id: str = "", before: object = None,
              after: object = None) -> None:
        from server import audit

        audit.record_action(self.db, self, action, target_type, target_id, before, after)

    def close(self, commit: bool) -> None:
        if self._db is None:
            return
        try:
            if self._db.in_transaction:
                if commit:
                    self._db.commit()
                else:
                    self._db.rollback()
        finally:
            self._db.close()
            self._db = None


# -- registry -------------------------------------------------------------------------------------
@dataclass
class _Segment:
    literal: str | None = None
    param: str | None = None
    suffix: str = ""

    def rank(self) -> int:
        return 0 if self.literal is not None else (1 if self.suffix else 2)

    def shape(self) -> str:
        return f"L:{self.literal}" if self.literal is not None else f"P:{self.suffix}"


@dataclass
class RouteSpec:
    method: str
    template: str
    segments: list[_Segment]
    handler: Callable[[Request], object]
    auth: tuple[Auth, ...]
    permission: str | None
    audit: str | None
    class_from_body: bool
    max_body: int

    def match(self, parts: list[str]) -> dict[str, str] | None:
        if len(parts) != len(self.segments):
            return None
        params: dict[str, str] = {}
        for part, segment in zip(parts, self.segments):
            if segment.literal is not None:
                if part != segment.literal:
                    return None
                continue
            value = part
            if segment.suffix:
                if not value.endswith(segment.suffix):
                    return None
                value = value[: -len(segment.suffix)]
            if not PARAM_PATTERN.fullmatch(value):
                return None
            params[segment.param or ""] = value
        return params

    def rank(self) -> tuple[int, ...]:
        return tuple(segment.rank() for segment in self.segments)


def _parse_template(template: str) -> list[_Segment]:
    if not template.startswith("/"):
        raise ValueError(f"Route template must start with '/': {template}")
    segments = []
    for part in template.split("/"):
        if "{" in part or "}" in part:
            match = re.fullmatch(r"\{([A-Za-z_][A-Za-z0-9_]*)\}([A-Za-z0-9_.-]*)", part)
            if not match:
                raise ValueError(f"Unsupported route segment {part!r} in {template}")
            segments.append(_Segment(param=match.group(1), suffix=match.group(2)))
        else:
            segments.append(_Segment(literal=part))
    return segments


class Registry:
    def __init__(self) -> None:
        self.routes: list[RouteSpec] = []
        self._templates: set[tuple[str, str]] = set()
        self._shapes: set[tuple[str, tuple[str, ...]]] = set()

    def route(self, method: str, template: str, *, auth: Auth | tuple[Auth, ...], permission: str | None = None,
              audit: str | None = None, class_from_body: bool = False, max_body: int = 4_200_000):
        def decorator(fn: Callable[[Request], object]) -> Callable[[Request], object]:
            self.add(method, template, fn, auth=auth, permission=permission, audit=audit,
                     class_from_body=class_from_body, max_body=max_body)
            return fn

        return decorator

    def add(self, method: str, template: str, handler: Callable[[Request], object], *, auth: Auth | tuple[Auth, ...],
            permission: str | None = None, audit: str | None = None, class_from_body: bool = False,
            max_body: int = 4_200_000) -> RouteSpec:
        method = method.upper()
        if method not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
            raise ValueError(f"Unsupported method {method}")
        segments = _parse_template(template)
        key = (method, template)
        if key in self._templates:
            raise ValueError(f"Duplicate route {method} {template}")
        shape = (method, tuple(segment.shape() for segment in segments))
        if shape in self._shapes:
            raise ValueError(f"Route {method} {template} has the same shape as an existing route")
        levels = auth if isinstance(auth, tuple) else (auth,)
        if not levels or any(not isinstance(level, Auth) for level in levels):
            raise ValueError(f"Route {method} {template} needs Auth levels")
        spec = RouteSpec(method, template, segments, handler, levels, permission, audit, class_from_body, max_body)
        self._templates.add(key)
        self._shapes.add(shape)
        self.routes.append(spec)
        return spec

    def match(self, method: str, parts: list[str]) -> tuple[RouteSpec | None, dict[str, str], list[str]]:
        best: tuple[tuple[int, ...], RouteSpec, dict[str, str]] | None = None
        other_methods: set[str] = set()
        for spec in self.routes:
            params = spec.match(parts)
            if params is None:
                continue
            if spec.method != method:
                other_methods.add(spec.method)
                continue
            rank = spec.rank()
            if best is None or rank < best[0]:
                best = (rank, spec, params)
        if best is None:
            return None, {}, sorted(other_methods)
        return best[1], best[2], []


REGISTRY = Registry()


def route(method: str, template: str, *, auth: Auth | tuple[Auth, ...], permission: str | None = None,
          audit: str | None = None, class_from_body: bool = False, max_body: int = 4_200_000):
    return REGISTRY.route(method, template, auth=auth, permission=permission, audit=audit,
                          class_from_body=class_from_body, max_body=max_body)


# -- dispatch -------------------------------------------------------------------------------------
def _client_addr(handler: Any) -> str:
    peer = ""
    try:
        peer = str(handler.client_address[0])
    except (AttributeError, IndexError, TypeError):
        peer = ""
    if peer in ("127.0.0.1", "::1", "localhost") or peer.startswith("127."):
        # WHY (review 2, SECURITY-06): the right-most entry is the hop the loopback proxy (Vite, Kiwi) appended; entries
        # to its left are whatever the client sent, so using them would let a client pick its own rate-limit bucket.
        forwarded = (handler.headers.get("X-Forwarded-For") or "").split(",")[-1].strip()
        if forwarded:
            return forwarded[:100]
    return peer


def scrub_pseudonyms(value: object) -> object:
    """Null every email field/list and blank roster display names (Presentation mode safety net)."""
    if isinstance(value, list):
        return [scrub_pseudonyms(item) for item in value]
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key in _SCRUB_NULL_KEYS:
                out[key] = None
            elif key == "displayName" and "studentId" in value:
                out[key] = ""
            else:
                out[key] = scrub_pseudonyms(item)
        return out
    return value


def _row_count(body: object) -> int | None:
    if isinstance(body, list):
        return len(body)
    if isinstance(body, dict):
        for key in _ROW_COUNT_KEYS:
            if isinstance(body.get(key), list):
                return len(body[key])
    return None


def _log(handler: Any, message: str) -> None:
    try:
        handler.log_message("%s", message)
    except (AttributeError, TypeError, ValueError):
        sys.stderr.write(message + "\n")


def _record_incident(class_id: str, kind: str) -> None:
    if not class_id:
        return
    minute = dbmod.utcnow().strftime("%Y-%m-%dT%H:%M")
    try:
        with dbmod.connection() as conn:
            conn.execute(
                """INSERT INTO service_incidents (class_id, minute, kind, count) VALUES (?, ?, ?, 1)
                ON CONFLICT(class_id, minute, kind) DO UPDATE SET count = count + 1""",
                (class_id, minute, kind),
            )
    except sqlite3.Error as exc:
        sys.stderr.write(f"Could not record service incident ({kind}): {type(exc).__name__}\n")


def _enforce(req: Request, spec: RouteSpec) -> None:
    from server import auth

    auth.authorize(req, spec)


def _send(handler: Any, req: Request, response: Response) -> None:
    headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": req.request_id,
        **response.headers,
    }
    if response.stream is not None:
        with tempfile.SpooledTemporaryFile(max_size=SPOOL_MAX) as spool:
            for chunk in response.stream:
                if chunk:
                    spool.write(chunk if isinstance(chunk, bytes) else str(chunk).encode("utf-8"))
            size = spool.tell()
            spool.seek(0)
            handler.send_response(response.status)
            handler.send_header("Content-Type", response.content_type)
            handler.send_header("Content-Length", str(size))
            if response.filename:
                safe = re.sub(r"[^A-Za-z0-9._-]", "_", response.filename)[:180]
                handler.send_header("Content-Disposition", f'attachment; filename="{safe}"')
            for key, value in headers.items():
                handler.send_header(key, value)
            handler.end_headers()
            shutil.copyfileobj(spool, handler.wfile)
        return
    if response.status == 204:
        handler.send_response(204)
        for key, value in headers.items():
            handler.send_header(key, value)
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return
    if isinstance(response.body, (bytes, bytearray)):
        payload = bytes(response.body)
    elif isinstance(response.body, str) and not response.content_type.startswith("application/json"):
        payload = response.body.encode("utf-8")
    else:
        payload = json.dumps(response.body, ensure_ascii=False).encode("utf-8")
    handler.send_response(response.status)
    handler.send_header("Content-Type", response.content_type)
    handler.send_header("Content-Length", str(len(payload)))
    if response.filename:
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", response.filename)[:180]
        handler.send_header("Content-Disposition", f'attachment; filename="{safe}"')
    for key, value in headers.items():
        handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(payload)


def _error_response(status: int, code: str, message: str, details: dict | None = None,
                    headers: dict[str, str] | None = None) -> Response:
    body: dict[str, object] = {"error": message, "code": code}
    if details:
        body["details"] = details
    return Response(status=status, body=body, headers=dict(headers or {}))


def dispatch(handler: Any, method: str, registry: Registry | None = None) -> None:
    """Handle one HTTP request end to end (parse → class → identity → match → enforce → handle → send)."""
    reg = registry or REGISTRY
    parsed = urlparse(handler.path)
    path = parsed.path
    query = {key: values[0] for key, values in parse_qs(parsed.query, keep_blank_values=True).items()}
    req = Request(handler, method, path, query, uuid.uuid4().hex, _client_addr(handler))
    response: Response
    committed = False
    try:
        parts = [unquote(part) for part in path.split("/")]
        spec, params, allowed = reg.match(method, parts)
        if spec is not None:
            req.max_body = spec.max_body
        class_id = query.get("classId") or ""
        if spec is not None and spec.class_from_body:
            body = req.json()
            body_class = body.get("classId") if isinstance(body, dict) else None
            if class_id and isinstance(body_class, str) and body_class and body_class != class_id:
                raise ApiError(403, "forbidden", "Activity belongs to another course")
            if not class_id and isinstance(body_class, str):
                class_id = body_class
        class_id = class_id or DEFAULT_CLASS_ID
        if not valid_id(class_id):
            raise ApiError(400, "invalid_request", "classId has an invalid format")
        req.class_id = class_id
        from server import auth

        req.identity = auth.resolve(req.headers, class_id, path, client_addr=req.client_addr, db=req.db)
        researcher = getattr(req.identity, "staff_role", None) == "researcher"
        if researcher:
            # WHY (decision D3): researchers never see identities, whatever name mode the client asks for.
            req.name_mode = "pseudonyms"
        if spec is None:
            if allowed:
                raise ApiError(405, "method_not_allowed", "Method not allowed", headers={"Allow": ", ".join(allowed)})
            raise ApiError(404, "not_found", "Endpoint not found")
        req.params = params
        _enforce(req, spec)
        view = None
        consent_token = None
        if researcher:
            # Decision D3 / review 2 (SECURITY-02, SECURITY-05): consenting students only, research ids instead of ids.
            from server import identity, research_view

            view = research_view.ResearchView(req.db, class_id)
            view.inbound(req)
            view.check_targets(req)
            consent_token = identity.set_consent_only(True)
        try:
            result = spec.handler(req)
        finally:
            if consent_token is not None:
                from server import identity

                identity.reset_consent_only(consent_token)
        if isinstance(result, Response):
            response = result
        elif result is None:
            response = Response(status=204)
        else:
            response = Response(status=200, body=result)
        if (view is not None and response.stream is None and response.content_type.startswith("application/json")
                and 200 <= response.status < 300):
            response.body = view.outbound(response.body)   # may raise 404 → nothing is committed
        req.close(commit=True)
        committed = True
        # Decision D3: every successful researcher read is logged too (category "read" when the route has none).
        category = spec.audit or ("read" if researcher and method == "GET" and Auth.PUBLIC not in spec.auth else None)
        if category and 200 <= response.status < 300 and getattr(req.identity, "is_staff", False):
            from server import audit

            with dbmod.connection() as log_db:
                # CR-P1 (INTEGRATION): a streamed export reports its row count in X-Export-Rows.
                rows = response.headers.get("X-Export-Rows", "")
                count = int(rows) if response.stream is not None and rows.isdigit() else _row_count(response.body)
                audit.record_access(log_db, req, category, spec.template, req.query, count,
                                    purpose=req.query.get("purpose", ""))
        json_body = response.stream is None and response.content_type.startswith("application/json")
        if req.name_mode == "pseudonyms" and getattr(req.identity, "is_staff", False) and json_body:
            from server import identity

            response.body = scrub_pseudonyms(response.body)
            # Presentation mode and researchers (review 2, SECURITY-04): roster names/emails inside free text too.
            with dbmod.connection() as scrub_db:
                researcher = getattr(req.identity, "staff_role", None) == "researcher"
                response.body = identity.scrub_free_text(response.body, identity.roster_terms(
                    scrub_db, class_id, participants_only=researcher))
    except ApiError as exc:
        response = _error_response(exc.status, exc.code, exc.message, exc.details, exc.headers)
    except Exception as exc:  # noqa: BLE001 - single mapping point (spec §5.2)
        response = _map_exception(handler, req, exc)
    finally:
        if not committed:
            try:
                req.close(commit=False)
            except sqlite3.Error as exc:
                _log(handler, f"request {req.request_id}: rollback failed ({type(exc).__name__})")
    try:
        _send(handler, req, response)
    except (BrokenPipeError, ConnectionResetError):
        _log(handler, f"request {req.request_id}: client disconnected")


def _map_exception(handler: Any, req: Request, exc: Exception) -> Response:
    from server import kiwi_bridge

    if isinstance(exc, kiwi_bridge.BridgeError):
        status = int(getattr(exc, "status", 503) or 503)
        code = {401: "unauthenticated", 403: "forbidden"}.get(status, "kiwi_unavailable")
        if code == "kiwi_unavailable":
            _record_incident(req.class_id, "kiwi_unreachable")
        return _error_response(status, code, str(exc))
    if isinstance(exc, json.JSONDecodeError):
        return _error_response(400, "invalid_json", "Request body is not valid JSON")
    if isinstance(exc, ValueError):
        return _error_response(400, "invalid_request", str(exc) or "Invalid request")
    _log(handler, f"internal error request={req.request_id} {req.method} {req.path} ({type(exc).__name__})")
    _record_incident(req.class_id, "server_error")
    return _error_response(500, "internal_error", "Internal server error")
