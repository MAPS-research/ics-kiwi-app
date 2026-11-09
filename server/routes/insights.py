"""Insights routes (owned by INSIGHTS; spec §6.7).

All endpoints are STAFF_VIEW / ``viewInsights`` with ``audit="analytics"`` unless noted (timeline → ``timeline``, AI
conversations → ``conversations``). Every endpoint accepts ``groupId`` (population restricted to that group's current
members) and the time window ``from``/``to`` (ISO, ``to`` exclusive; missing → whole term) [TH16, F14]. Student names
always pass through ``identity.relabel`` (Presentation mode) [TH12].

Legacy v0.5.1 endpoints stay registered (§6.9): ``GET /api/teacher/analytics/metrics``, ``…/evidence``, ``…/session``,
and ``…/table`` without v0.6 parameters.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Callable

from server import analytics, attention, audit, conversations, course_config, identity, readers
from server import db as dbmod
from server.router import ApiError, Auth, Request, Response, route, valid_id

_TABLE_KEYS = ("group", "studentId", "unitId", "assignmentId", "questionId", "kind", "source", "materialId", "search",
               "active", "activity", "published", "sort", "direction")
VIEW = {"auth": Auth.STAFF_VIEW, "permission": "viewInsights"}
# Named teaching views (Home action lists, Needs attention, re-teach marks): not for researchers (decision D3).
TEACHING = {"auth": Auth.STAFF_VIEW, "permission": "viewStudents"}
# SB-m11: writing re-teach marks is teaching work (instructors and TAs); a read-only viewer only reads them
TEACHING_WRITE = {"auth": Auth.STAFF_GRADE, "permission": "viewStudents"}


# ─── helpers ───────────────────────────────────────────────────────────────────────────────────

def _not_found(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except LookupError as exc:
        raise ApiError(404, "not_found", str(exc.args[0] if exc.args else "Not found")) from exc


def _label_range(db: Any, class_id: str, from_: str | None, to: str | None) -> str:
    if not from_ and not to:
        return "Whole term"
    tz = analytics._zone(db, class_id)
    fmt = lambda v: dbmod.parse_iso(v).astimezone(tz).strftime("%m/%d")  # noqa: E731
    if from_ and to:
        last = dbmod.parse_iso(to) - timedelta(seconds=1)
        return f"{fmt(from_)} – {last.astimezone(tz).strftime('%m/%d')}"
    return f"Since {fmt(from_)}" if from_ else f"Until {fmt(to)}"


def window(req: Request, *, include_staff: bool = False) -> tuple[analytics.Scope, dict, tuple[str | None, str | None]]:
    """Scope + echoed ``TimeRange`` + comparison window from ``preset`` or ``from/to/compareFrom/compareTo``."""
    db = req.db
    from_, to = req.q_iso("from"), req.q_iso("to")
    compare = (req.q_iso("compareFrom"), req.q_iso("compareTo"))
    preset = req.query.get("preset")
    if preset:
        if preset not in course_config.TIME_PRESETS:
            raise ApiError(400, "invalid_request", "preset must be one of: " + ", ".join(course_config.TIME_PRESETS))
        base = analytics.make_scope(db, req.class_id)
        schedule = readers.settings(db, req.class_id)["schedule"]
        try:
            range_ = course_config.time_range(preset, schedule, now=dbmod.utcnow(), first_event_at=analytics.first_event_at(db, base),
                                              custom_from=from_, custom_to=to).as_dict()
        except ValueError as exc:
            raise ApiError(400, "invalid_request", str(exc)) from exc
        from_, to = range_["from"], range_["to"]
        compare = (range_["compareFrom"], range_["compareTo"])
    elif from_ or to:
        range_ = {"preset": "custom", "effectivePreset": "custom", "from": from_, "to": to, "compareFrom": compare[0],
                  "compareTo": compare[1], "label": _label_range(db, req.class_id, from_, to),
                  "compareLabel": "vs previous period" if compare[0] and compare[1] else None}
    else:
        range_ = {"preset": "whole_term", "effectivePreset": "whole_term", "from": None, "to": None, "compareFrom": None,
                  "compareTo": None, "label": "Whole term", "compareLabel": None}
        compare = (None, None)
    if from_ and to and from_ >= to:
        raise ApiError(400, "invalid_request", "from must be before to")
    scope = analytics.make_scope(db, req.class_id, from_=from_, to=to, group_id=req.q_id("groupId"),
                                 include_staff=include_staff)
    return scope, range_, compare


def _relabel(req: Request, rows: list, key: str = "studentId", field: str = "studentName") -> list:
    return identity.relabel(req.db, req.class_id, rows, req.name_mode, key=key, field=field)


def _actor(req: Request) -> str:
    return audit.actor_label(req.identity) or (req.identity.user_id or "staff")


# ─── legacy (§6.9) ─────────────────────────────────────────────────────────────────────────────

@route("GET", "/api/teacher/analytics/metrics", **VIEW, audit="analytics")
def metrics_legacy(req: Request) -> dict:
    return analytics.metrics(req.db, req.class_id, course_config.course_for(req.class_id, req.db))


def _explorer_query(req: Request) -> analytics.ExplorerQuery:
    group = req.query.get("group") or "students"
    group = analytics.LEGACY_GROUP_NAMES.get(group, group)
    if group not in analytics.GROUPS:
        raise ApiError(400, "invalid_request", "Unsupported table view")
    work = req.q_str("work", "", 120)
    if work and work not in ("all", "free", "assigned") and not valid_id(work):
        raise ApiError(400, "invalid_request", "work has an invalid format")
    return analytics.ExplorerQuery(
        group=group, where=req.q_choice("where", ("lab", "kiwi", "all"), ""),
        work=work, origin=req.q_choice("origin", ("teacher", "ai-free", "ai-similar", "all"), ""),
        unit_id=req.q_str("unitId", "", 120), assignment_id=req.q_id("assignmentId") or "", question_id=req.q_id("questionId") or "",
        student_id=req.q_id("studentId") or "", material_id=req.q_str("materialId", "", 120),
        activity=req.q_choice("activity", (*analytics.ACTIVITY_FILTERS, "questions"), "").replace("questions", "ai"),
        search=req.q_str("search", "", 100), question_type=req.q_str("questionType", "", 20),
        difficulty=req.q_int("difficulty", 0, 0, 5) or None,
        policy_version_id=req.q_int("policyVersionId", 0, 0, 2 ** 62) or None, tag=req.q_str("tag", "", 60),
        fold=req.query.get("fold") != "0", sort=req.q_str("sort", "", 40),
        direction="asc" if req.query.get("direction") == "asc" else "desc",
        page=req.q_int("page", 1, 1, 1_000_000, clamp=True), page_size=req.q_int("pageSize", 25, 1, 100, clamp=True),
        name_mode=req.name_mode)


@route("GET", "/api/teacher/analytics/table", **VIEW, audit="analytics")
def table(req: Request) -> dict:
    if analytics.wants_v2(req.query):
        query = _explorer_query(req)
        if query.where == "all":
            query.where = ""
        scope, _, _ = window(req, include_staff=req.q_bool("includeStaff"))
        try:
            result = analytics.explore(req.db, scope, query)
        except ValueError as exc:
            raise ApiError(400, "invalid_request", str(exc)) from exc
        _relabel(req, result["rows"])
        if query.group == "students":
            for row in result["rows"]:
                row["label"] = row.get("studentName")
        return result
    values = {key: req.query[key] for key in _TABLE_KEYS if key in req.query}
    values["classId"] = req.class_id
    values["page"] = str(req.q_int("page", 1, 1, 1_000_000, clamp=True))
    values["pageSize"] = str(req.q_int("pageSize", 25, 1, 100, clamp=True))
    result = analytics.table(req.db, values)
    field = "label" if values.get("group", "students") == "students" else "studentName"
    _relabel(req, result["rows"], field=field)
    return result


@route("GET", "/api/teacher/analytics/evidence", **VIEW, audit="analytics")
def evidence(req: Request) -> dict:
    values = {key: req.query[key] for key in _TABLE_KEYS if key in req.query}
    values["classId"] = req.class_id
    values["beforeId"] = str(req.q_int("beforeId", 0, 0, 2 ** 62))
    result = analytics.evidence(req.db, values)
    _relabel(req, result["questions"])
    for topic in result["sharedTopics"]:
        _relabel(req, topic["examples"])
    return result


@route("GET", "/api/teacher/analytics/session", **VIEW, audit="analytics")
def session(req: Request) -> dict:
    result = analytics.session_events(req.db, req.class_id, req.query.get("sessionId", ""), req.q_int("afterId", 0, 0, 2 ** 62))
    _relabel(req, [result["session"]])
    return result


# ─── explorer drill-downs ──────────────────────────────────────────────────────────────────────

@route("GET", "/api/teacher/analytics/answers", **VIEW, audit="analytics")
def answers(req: Request) -> dict:
    scope, _, _ = window(req)
    try:
        return analytics.answers_by_question(req.db, scope, assignment_id=req.q_id("assignmentId") or "",
                                             question_id=req.q_id("questionId") or "", unit_id=req.q_str("unitId", "", 120),
                                             item_group=req.q_str("itemGroup", "", 200))
    except ValueError as exc:
        raise ApiError(400, "invalid_request", str(exc)) from exc


@route("GET", "/api/teacher/analytics/question-activity/{activityId}", **VIEW, audit="analytics")
def question_activity(req: Request) -> dict:
    after = req.q_int("after", 0, 0, 2 ** 62)
    result = _not_found(lambda: analytics.question_activity(req.db, req.class_id, req.params["activityId"], after))
    _relabel(req, [result["activity"]])
    _relabel(req, result["events"])
    return result


@route("GET", "/api/teacher/timeline", **VIEW, audit="timeline")
def student_timeline(req: Request) -> dict:
    student = req.q_id("studentId", required=True) or ""
    limit = req.q_int("limit", 100, 1, 200)
    where = req.q_choice("where", ("lab", "kiwi"), "")
    result = _not_found(lambda: analytics.timeline(
        req.db, req.class_id, student, assignment_id=req.q_id("assignmentId") or "", from_=req.q_iso("from"),
        to=req.q_iso("to"), unit_id=req.q_str("unitId", "", 120), where=where, after=req.q_str("after", "", 120), limit=limit))
    _relabel(req, [result["student"]])
    return result


# ─── metrics ───────────────────────────────────────────────────────────────────────────────────

@route("GET", "/api/teacher/metrics", **VIEW, audit="analytics")
def course_metrics(req: Request) -> dict:
    scope, range_, compare = window(req)
    return analytics.course_metrics(req.db, scope, range_, compare)


@route("GET", "/api/teacher/trends", **VIEW, audit="analytics")
def trends(req: Request) -> dict:
    req.q_choice("bucket", ("week",), "week")
    scope, _, _ = window(req)
    return analytics.trends(req.db, scope, unit_id=req.q_str("unitId", "", 120))


@route("GET", "/api/teacher/learning-curves", **VIEW, audit="analytics")
def learning_curves(req: Request) -> dict:
    scope, _, _ = window(req)
    return analytics.learning_curves(req.db, scope, unit_id=req.q_str("unitId", "", 120),
                                     origin=req.q_choice("origin", ("teacher", "ai-free", "ai-similar"), ""))


@route("GET", "/api/teacher/time-on-task", **VIEW, audit="analytics")
def time_on_task(req: Request) -> dict:
    scope, _, _ = window(req)
    try:
        return analytics.time_on_task(req.db, scope, assignment_id=req.q_id("assignmentId") or "",
                                      unit_id=req.q_str("unitId", "", 120))
    except ValueError as exc:
        raise ApiError(400, "invalid_request", str(exc)) from exc


# ─── Home, attention, re-teach ─────────────────────────────────────────────────────────────────

@route("GET", "/api/teacher/home", **TEACHING, audit="analytics")
def home(req: Request) -> dict:
    scope, range_, compare = window(req)
    data = analytics.home(req.db, scope, range_, compare)
    _relabel(req, data["attention"]["students"])
    return data


@route("GET", "/api/teacher/attention", **TEACHING, audit="analytics")
def attention_list(req: Request) -> dict:
    scope, _, _ = window(req)
    data = attention.evaluate(req.db, scope)
    _relabel(req, data["students"])
    data["descriptions"] = {rule["id"]: attention.describe(rule) for rule in data["rules"]["rules"]}
    return data


@route("GET", "/api/teacher/attention/rules", **VIEW)
def attention_rules(req: Request) -> dict:
    return attention.rules(req.db, req.class_id)


@route("PUT", "/api/teacher/attention/rules", auth=Auth.INSTRUCTOR, permission="manageCourse")
def save_attention_rules(req: Request) -> dict:
    try:
        clean = attention.validate_rules(req.body())
    except ValueError as exc:
        raise ApiError(400, "invalid_request", str(exc)) from exc
    with dbmod.write_tx(req.db):
        before = attention.rules(req.db, req.class_id)
        attention.save_settings_key(req.db, req.class_id, "attentionRules", clean, _actor(req))
        req.audit("attention_rules_update", "settings", "attentionRules", before, clean)
    return attention.rules(req.db, req.class_id)


@route("GET", "/api/teacher/reteach", **VIEW, audit="analytics")
def reteach(req: Request) -> dict:
    scope, _, _ = window(req)
    return attention.reteach(req.db, scope, include_resolved=req.q_bool("includeResolved"))


@route("POST", "/api/teacher/reteach", **TEACHING_WRITE)
def mark_reteach(req: Request) -> Response:
    body = req.body()
    try:
        with dbmod.write_tx(req.db):
            mark = attention.create_mark(req.db, req.class_id, body, _actor(req))
            req.audit("reteach_mark", "reteach_mark", str(mark["id"]), None, mark)
    except ValueError as exc:
        raise ApiError(400, "invalid_request", str(exc)) from exc
    return Response(201, mark)


@route("PATCH", "/api/teacher/reteach/{markId}", **TEACHING_WRITE)
def update_reteach(req: Request) -> dict:
    raw = req.params["markId"]
    if not raw.isdigit():
        raise ApiError(400, "invalid_request", "markId must be a number")
    body = req.body()
    try:
        with dbmod.write_tx(req.db):
            before, after = _not_found(lambda: attention.update_mark(req.db, req.class_id, int(raw), body))
            req.audit("reteach_update", "reteach_mark", raw, before, after)
    except ValueError as exc:
        raise ApiError(400, "invalid_request", str(exc)) from exc
    return after


# ─── AI conversations (§13.5) ──────────────────────────────────────────────────────────────────

def _conversation_filters(req: Request) -> dict:
    return {"unitId": req.q_str("unitId", "", 120), "studentId": req.q_id("studentId") or "",
            "assignmentId": req.q_id("assignmentId") or "", "codeId": req.q_id("codeId") or "",
            "uncoded": req.q_bool("uncoded"), "flagged": req.q_bool("flagged"),
            "where": req.q_choice("where", ("lab", "kiwi"), "")}


@route("GET", "/api/teacher/ai-conversations/digest", **VIEW, audit="conversations")
def conversation_digest(req: Request) -> dict:
    scope, range_, _ = window(req)
    data = conversations.digest(req.db, scope, range_, unit_id=req.q_str("unitId", "", 120),
                                assignment_id=req.q_id("assignmentId") or "")
    for cluster in data["repeated"]:
        _relabel(req, cluster["examples"])
    _relabel(req, data["flagged"])
    _relabel(req, data["recent"])
    return data


@route("GET", "/api/teacher/ai-conversations/threads", **VIEW, audit="conversations")
def conversation_threads(req: Request) -> dict:
    scope, _, _ = window(req)
    page = req.q_int("page", 1, 1, 100_000, clamp=True)
    size = req.q_int("pageSize", 25, 1, 100, clamp=True)
    items = conversations.summaries(req.db, scope, _conversation_filters(req))
    rows = items[(page - 1) * size:page * size]
    _relabel(req, rows)
    return {"threads": rows, "total": len(items), "page": page, "pageSize": size}


@route("GET", "/api/teacher/ai-conversations/threads/{threadKey}", **VIEW, audit="conversations")
def conversation_thread(req: Request) -> dict:
    scope = analytics.make_scope(req.db, req.class_id, include_staff=True)
    try:
        data = _not_found(lambda: conversations.thread(req.db, scope, req.params["threadKey"]))
    except ValueError as exc:
        raise ApiError(400, "invalid_request", str(exc)) from exc
    _relabel(req, [data["summary"]])
    return data


@route("GET", "/api/teacher/ai-conversations/next-uncoded", **VIEW, audit="conversations")
def next_uncoded(req: Request) -> dict:
    scope, _, _ = window(req)
    current = req.q_str("current", "", 120)
    return {"threadKey": conversations.next_uncoded(req.db, scope, _conversation_filters(req), current)}


@route("GET", "/api/teacher/codebook", **VIEW)
def codebook(req: Request) -> list:
    return conversations.codebook(req.db, req.class_id)


@route("POST", "/api/teacher/codebook", **VIEW)
def create_code(req: Request) -> Response:
    body = req.body()
    try:
        with dbmod.write_tx(req.db):
            code = conversations.create_code(req.db, req.class_id, body, _actor(req))
            req.audit("codebook_create", "codebook_code", code["id"], None, code)
    except ValueError as exc:
        raise ApiError(400, "invalid_request", str(exc)) from exc
    return Response(201, code)


@route("PATCH", "/api/teacher/codebook/{codeId}", **VIEW)
def update_code(req: Request) -> dict:
    body = req.body()
    try:
        with dbmod.write_tx(req.db):
            before, after = _not_found(lambda: conversations.update_code(req.db, req.class_id, req.params["codeId"], body))
            req.audit("codebook_update", "codebook_code", req.params["codeId"], before, after)
    except ValueError as exc:
        raise ApiError(400, "invalid_request", str(exc)) from exc
    return after


@route("POST", "/api/teacher/ai-conversations/codes", **VIEW)
def add_conversation_code(req: Request) -> Response:
    body = req.body()
    scope = analytics.make_scope(req.db, req.class_id, include_staff=True)
    try:
        with dbmod.write_tx(req.db):
            code = _not_found(lambda: conversations.add_code(req.db, scope, body, _actor(req)))
            req.audit("conversation_code_add", "conversation", code["threadKey"], None,
                      {"codeId": code["codeId"], "chatTurnId": code["chatTurnId"], "nativeEventId": code["nativeEventId"]})
    except ValueError as exc:
        raise ApiError(400, "invalid_request", str(exc)) from exc
    return Response(201, code)


@route("DELETE", "/api/teacher/ai-conversations/codes/{codeId}", **VIEW)
def remove_conversation_code(req: Request) -> None:
    raw = req.params["codeId"]
    if not raw.isdigit():
        raise ApiError(400, "invalid_request", "codeId must be a number")
    with dbmod.write_tx(req.db):
        removed = _not_found(lambda: conversations.remove_code(req.db, req.class_id, int(raw)))
        req.audit("conversation_code_remove", "conversation", removed["threadKey"], {"codeId": removed["codeId"]}, None)
    return None


@route("GET", "/api/teacher/topic-rules", **VIEW)
def topic_rules(req: Request) -> list:
    return conversations.topic_rules(req.db, req.class_id)


@route("PUT", "/api/teacher/topic-rules", auth=Auth.INSTRUCTOR, permission="manageCourse")
def save_topic_rules(req: Request) -> list:
    try:
        clean = conversations.validate_topic_rules(req.json())
    except ValueError as exc:
        raise ApiError(400, "invalid_request", str(exc)) from exc
    with dbmod.write_tx(req.db):
        before = conversations.topic_rules(req.db, req.class_id)
        attention.save_settings_key(req.db, req.class_id, "topicRules", clean, _actor(req))
        req.audit("topic_rules_update", "settings", "topicRules", before, clean)
    return conversations.topic_rules(req.db, req.class_id)
