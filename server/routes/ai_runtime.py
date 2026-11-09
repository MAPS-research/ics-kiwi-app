"""AI runtime routes (AIRUN; spec §6.6).

Student: ``POST /api/ai/chat``, ``GET /api/chat``, ``POST /api/ai/question`` (free practice; legacy bodies with
``sourceQuestion`` accepted), ``POST /api/ai/similar``, ``POST /api/practice/items/{itemId}/check|reveal|verify`` and the
additive ``GET /api/practice/status`` (daily usage and unlocked difficulty for the Practice page).
Staff: ``GET /api/teacher/ai/items``, ``POST /api/teacher/ai/items/{itemId}/flag|unflag|retire|restore``,
``POST /api/teacher/ai/turns/{chatTurnId}/flag|unflag`` and ``GET /api/teacher/ai/calls/{aiCallId}``.
Pipelines live in ``server/ai_runtime.py`` (chat, provenance, capacity) and ``server/generated_items.py`` (items);
``ai.invoke`` is always reached through the module attribute so tests can patch ``app.ai.invoke``.
"""

from __future__ import annotations

from server import ai_policy, ai_runtime, generated_items
from server.router import ApiError, Auth, Request, route, valid_id


@route("POST", "/api/ai/chat", auth=Auth.STUDENT)
def chat(req: Request) -> dict:
    return ai_runtime.chat(req)


@route("GET", "/api/chat", auth=(Auth.STUDENT, Auth.STAFF_VIEW))
def history(req: Request) -> list:
    student_id = req.identity.student_id if req.as_student() else req.query.get("studentId", "")
    thread_id = req.query.get("threadId", "")
    if not valid_id(student_id) or not valid_id(thread_id):
        raise ApiError(400, "invalid_request", "Student and thread IDs are required")
    return ai_runtime.chat_history(req.db, req.class_id, student_id, thread_id)


@route("POST", "/api/ai/question", auth=Auth.STUDENT)
def question(req: Request) -> dict:
    return generated_items.generate_free(req)


@route("POST", "/api/ai/similar", auth=Auth.STUDENT)
def similar(req: Request) -> dict:
    return generated_items.generate_similar(req)


@route("POST", "/api/practice/items/{itemId}/check", auth=Auth.STUDENT)
def check_item(req: Request) -> dict:
    return generated_items.check(req, req.params["itemId"])


@route("POST", "/api/practice/items/{itemId}/reveal", auth=Auth.STUDENT)
def reveal_item(req: Request) -> dict:
    return generated_items.reveal(req, req.params["itemId"])


@route("POST", "/api/practice/items/{itemId}/verify", auth=Auth.STUDENT)
def verify_item(req: Request) -> dict:
    return generated_items.verify(req, req.params["itemId"])


@route("GET", "/api/practice/status", auth=Auth.STUDENT)
def practice_status(req: Request) -> dict:
    """Additive (CR in handoff): the student's ``usedToday`` and ``unlockedMaxDifficulty`` for one chapter."""
    _course, unit = ai_runtime.find_unit(req.db, req.class_id, req.query.get("unitId"))
    student_id = req.identity.student_id or ""
    resolved = ai_policy.resolve(req.db, req.class_id, unit["id"], student_id)
    status = generated_items.practice_status(req.db, req.class_id, student_id, unit["id"], ai_policy.with_defaults(resolved.config))
    return {**status, "effectiveAccess": unit.get("effectiveAccess"), "policyLabel": resolved.scope_label}


@route("GET", "/api/teacher/ai/items", auth=Auth.STAFF_VIEW, permission="viewInsights", audit="analytics")
def teacher_items(req: Request) -> dict:
    return generated_items.teacher_items(req)


@route("POST", "/api/teacher/ai/items/{itemId}/flag", auth=Auth.STAFF_GRADE, permission="flagItems")
def flag_item(req: Request) -> dict:
    return generated_items.set_status(req, req.params["itemId"], "flag")


@route("POST", "/api/teacher/ai/items/{itemId}/unflag", auth=Auth.STAFF_GRADE, permission="flagItems")
def unflag_item(req: Request) -> dict:
    return generated_items.set_status(req, req.params["itemId"], "unflag")


@route("POST", "/api/teacher/ai/items/{itemId}/retire", auth=Auth.INSTRUCTOR, permission="manageAiRules")
def retire_item(req: Request) -> dict:
    return generated_items.set_status(req, req.params["itemId"], "retire")


@route("POST", "/api/teacher/ai/items/{itemId}/restore", auth=Auth.INSTRUCTOR, permission="manageAiRules")
def restore_item(req: Request) -> dict:
    return generated_items.set_status(req, req.params["itemId"], "restore")


def _int_param(req: Request, name: str) -> int:
    raw = req.params.get(name, "")
    if not raw.isdigit() or len(raw) > 15:
        raise ApiError(404, "not_found", "Not found")
    return int(raw)


@route("POST", "/api/teacher/ai/turns/{chatTurnId}/flag", auth=Auth.STAFF_GRADE, permission="flagItems")
def flag_turn(req: Request) -> dict:
    return ai_runtime.set_turn_flag(req, _int_param(req, "chatTurnId"), True)


@route("POST", "/api/teacher/ai/turns/{chatTurnId}/unflag", auth=Auth.STAFF_GRADE, permission="flagItems")
def unflag_turn(req: Request) -> dict:
    return ai_runtime.set_turn_flag(req, _int_param(req, "chatTurnId"), False)


@route("GET", "/api/teacher/ai/calls/{aiCallId}", auth=Auth.STAFF_VIEW, permission="viewInsights", audit="conversations")
def call_detail(req: Request) -> dict:
    return ai_runtime.call_detail(req.db, req.class_id, _int_param(req, "aiCallId"))
