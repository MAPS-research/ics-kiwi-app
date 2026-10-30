"""Official Kiwi App API. No host patches, database access, or provider credentials.

Authentication follows Kiwi docs/jwt-configuration.md. The SDK's explicit
getToken() supplies an app token; signatures are verified against the configured
host's public JWKS. Only opaque IDs are retained. Roles are Lab-owned grants,
because the upstream app token does not assert a course role.
"""
from __future__ import annotations

import json
import os
import threading
from contextvars import ContextVar
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, HTTPRedirectHandler, build_opener

from server.contracts import AiError

APP_SLUG = "ics-r-lab"
current_identity: ContextVar = ContextVar("kiwi_request_identity", default=None)
_clients: dict = {}
_lock = threading.Lock()


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # App tokens must never follow a host redirect to another origin.


urlopen = build_opener(_NoRedirect()).open


class KiwiError(Exception):
    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.status = status


def origin() -> str:
    value = os.environ.get("KIWI_API_ORIGIN", "http://localhost:3000").rstrip("/")
    parsed = urlparse(value)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")
            or (parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"))):
        raise KiwiError("KIWI_API_ORIGIN must be an HTTPS origin or loopback HTTP origin")
    return value


def verify_token(token: str) -> dict:
    try:
        import jwt
    except ImportError:
        raise KiwiError("Install requirements.txt in the Lab Python environment to verify Kiwi app tokens") from None
    url = origin() + "/.well-known/jwks.json"
    with _lock:
        client = _clients.setdefault(url, jwt.PyJWKClient(url, cache_keys=False, lifespan=300, timeout=10))
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "RS256":
            raise jwt.InvalidTokenError("Expected RS256")
        # Kiwi's current signer omits kid. Select only a unique RSA signing key;
        # ambiguous sets fail closed. Never use a token-supplied key URL.
        if header.get("kid"):
            key = client.get_signing_key_from_jwt(token).key
        else:
            keys = [k for k in client.get_signing_keys() if k.key_type == "RSA" and k.algorithm_name == "RS256"]
            if len(keys) != 1:
                raise jwt.InvalidTokenError("Ambiguous signing key")
            key = keys[0].key
        issuer = os.environ.get("KIWI_JWT_ISSUER") or None
        claims = jwt.decode(token, key, algorithms=["RS256"], issuer=issuer,
                            options={"verify_aud": False, "require": ["sub", "exp", "iat", "type", "appSlug", "classId"]})
    except jwt.PyJWKClientConnectionError:
        raise KiwiError("Kiwi public keys are unavailable. Reopen the Lab after the host is reachable.") from None
    except (jwt.PyJWTError, ValueError):
        raise KiwiError("Invalid or expired Kiwi app token. Reopen the Lab from your Kiwi course.", 401) from None
    if (claims.get("type") != "app_token" or claims.get("appSlug") != APP_SLUG
            or not isinstance(claims.get("classId"), str) or not claims["classId"]
            or claims.get("tokenScope", "class") != "class"
            or not isinstance(claims.get("sub"), str) or not claims["sub"]
            or not isinstance(claims.get("scopes", []), list)
            or not all(isinstance(s, str) for s in claims.get("scopes", []))):
        raise KiwiError("A class-scoped CSS Lab app token is required", 403)
    return claims


def authenticate(header: str, class_id: str | None) -> dict:
    if not header.startswith("Bearer ") or not 8 < len(header) < 20000:
        raise KiwiError("A Kiwi app token is required", 401)
    claims = verify_token(header[7:])
    if class_id is not None and claims["classId"] != class_id:
        raise KiwiError("The Kiwi token belongs to another course", 403)
    class_id = claims["classId"]
    role = staff_binding(class_id, claims["sub"])
    return {"classId": class_id, "userId": claims["sub"], "username": "User " + claims["sub"][:8],
            "userRole": role or "student", "labRole": role,
            "canTeach": role is not None, "canManageCourse": role == "instructor",
            "canViewAnalytics": role is not None, "scopes": claims.get("scopes", [])}


def staff_binding(class_id: str, user_id: str) -> str | None:
    # Operator-configured course -> opaque user UUID -> Lab role. No roster or
    # user lookup, and no role/name/email taken from untrusted browser context.
    try:
        bindings = json.loads(os.environ.get("KIWI_STAFF_BINDINGS", "{}"))
        role = bindings.get(class_id, {}).get(user_id)
    except (ValueError, AttributeError):
        raise KiwiError("KIWI_STAFF_BINDINGS must map course IDs to user IDs and Lab roles") from None
    if role not in (None, "instructor", "ta", "viewer", "researcher"):
        raise KiwiError("Invalid Lab role in KIWI_STAFF_BINDINGS")
    return role


def ai_available() -> bool:
    ident = current_identity.get()
    prompt = os.environ.get("KIWI_CONTEXT_PROMPT_ID", "").strip()
    scopes = ident.kiwi_context.get("scopes", []) if ident is not None else []
    return bool(ident is not None and ident.kind == "kiwi" and ident.token and prompt
                and "context:student_learning:read" in scopes
                and (f"llm:prompt:{prompt}" in scopes or "llm:prompt:*" in scopes))


def contextual_chat(request: dict, class_id: str, student_id: str, meta: dict | None = None) -> str:
    ident = current_identity.get()
    if not ai_available():
        raise AiError(503, "ai_unavailable", "Kiwi AI requires a course app session and an approved Lab prompt. Local practice remains available.")
    callers = {ident.student_id, ident.user_id}
    if ident.is_staff and ident.user_id:
        callers.add("preview-" + ident.user_id)  # Teacher rule tests still use the teacher's own Kiwi context.
    if ident.class_id != class_id or student_id not in callers:
        raise AiError(403, "forbidden", "AI requests must use the current course and caller")
    # These are task data for the approved Kiwi prompt, not provider system
    # messages. Model, reasoning and output-token limits belong to Kiwi.
    messages = request.get("input", [])
    payload = {"instructions": [m.get("content", "") for m in messages if m.get("role") in ("system", "developer")],
               "conversation": [m for m in messages if m.get("role") in ("user", "assistant")]}
    user_message = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(user_message.encode("utf-16-le")) // 2 > 8000:
        # Never silently truncate a rule, question or R program to meet the
        # upstream DTO's hard limit. The UI can ask for a shorter context.
        raise AiError(422, "ai_context_too_large", "This request exceeds Kiwi's 8,000-character context limit. Shorten the question, code, chapter reference or conversation and retry.")
    body = {"promptId": os.environ["KIWI_CONTEXT_PROMPT_ID"].strip(), "userMessage": user_message,
            "contextRequest": {"kind": "student_learning_context", "scope": "current_user_current_class",
                               "include": ["relevant_materials"], "timeWindowDays": 14}}
    http = Request(origin() + f"/api/kiwi-apps/{APP_SLUG}/contextual-chat", data=json.dumps(body).encode(),
                   headers={"Content-Type": "application/json", "Authorization": "Bearer " + ident.token}, method="POST")
    try:
        with urlopen(http, timeout=120) as response:
            result = json.loads(response.read(2_000_001))
    except HTTPError as exc:
        code = "rate_limited" if exc.code == 429 else "ai_unavailable" if exc.code in (401, 403, 404) else "ai_provider_error"
        status = exc.code if exc.code in (401, 403, 429) else 503 if exc.code == 404 else 502
        exc.close()
        raise AiError(status, code, "Kiwi could not run the approved Lab prompt. Check the app's enabled scopes and prompt approval, then retry.") from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise AiError(502, "ai_provider_error", "Kiwi AI could not be reached or returned an unreadable response. Please retry.") from None
    if not isinstance(result, dict) or not isinstance(result.get("output"), str) or not result["output"].strip():
        raise AiError(502, "ai_invalid_output", "Kiwi returned no usable answer. Please retry.")
    if isinstance(meta, dict):
        meta.update(provider="kiwi", model="kiwi-managed", prompt_id=result.get("promptId"),
                    context_included=result.get("contextIncluded", []), context_omitted=result.get("contextOmitted", []))
    return result["output"]
