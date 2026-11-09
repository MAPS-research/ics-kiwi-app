"""Telemetry routes (owned by TELEMETRY; spec §6.2, §11).

``POST /api/events`` (single; 201 created, 200 duplicate ``eventId``, 422 per-event rejection, 400 only for malformed
JSON or a non-object body), ``POST /api/events/batch`` (≤ 50 events, ≤ 600 KB; per-event results; 400 only for envelope
errors), ``GET /api/events`` (latest 120 of one student), ``GET /api/teacher/events`` (legacy list with
``studentId/type/from/to/limit/beforeId``; ``paged=1&after=<cursor>`` → ``{events, nextCursor, hasMore}``),
``GET /api/teacher/summary`` and ``GET /api/teacher/data-health``.
"""

from __future__ import annotations

from server import event_schema, identity, telemetry
from server.router import ApiError, Auth, Request, Response, route

MAX_BATCH_EVENTS = 50
MAX_BATCH_BYTES = 600_000
MAX_EVENT_BYTES = 1_000_000   # one event; payloads are cut to 250,000 characters anyway (review 2, CORRECTNESS-04)


def _rejected(result) -> dict:
    return {"status": "rejected", "code": result.code, "error": result.message, "eventId": result.event_id}


@route("POST", "/api/events", auth=Auth.STUDENT, class_from_body=True, max_body=MAX_EVENT_BYTES)
def post_event(req: Request) -> Response:
    data = req.student_body()
    if data.get("classId", req.class_id) != req.class_id:
        raise ApiError(403, "forbidden", "Activity belongs to another course")
    try:
        result = telemetry.add_event(req.db, req.identity, data)
    except telemetry.EventRejected as exc:
        return Response(422, _rejected(exc.result))
    return Response(201 if result.status == "created" else 200, result.as_dict())


def _student_event(req: Request, event: object) -> object:
    """Per-event equivalent of ``Request.student_body`` (identity fills studentId/studentName)."""
    if not isinstance(event, dict):
        return event
    data = dict(event)
    ident = req.identity
    if not req.as_student():
        return data
    if data.get("studentId") not in (None, "", ident.student_id):
        raise ApiError(403, "forbidden", "Student activity belongs to another user")
    data["studentId"] = ident.student_id
    data["studentName"] = ident.display_name or ident.student_id
    return data


@route("POST", "/api/events/batch", auth=Auth.STUDENT, class_from_body=True, max_body=MAX_BATCH_BYTES)
def post_batch(req: Request) -> dict:
    body = req.body()
    events = body.get("events")
    if not isinstance(events, list):
        raise ApiError(400, "invalid_request", "events must be an array")
    if len(events) > MAX_BATCH_EVENTS:
        raise ApiError(400, "invalid_request", f"A batch holds at most {MAX_BATCH_EVENTS} events")
    for event in events:
        if isinstance(event, dict) and event.get("classId") not in (None, req.class_id):
            raise ApiError(400, "invalid_request", "All events in a batch must belong to the same course")
    prepared = [_student_event(req, event) for event in events]
    results = []
    for event in prepared:
        if isinstance(event, dict):
            event.setdefault("classId", req.class_id)
        results.append(telemetry.ingest(req.db, req.identity, event).as_dict())
    return {"results": results}


@route("GET", "/api/events", auth=(Auth.STUDENT, Auth.STAFF_VIEW))
def student_events(req: Request) -> list:
    if req.as_student():
        return telemetry.events_for(req.class_id, req.identity.student_id, 120, db=req.db)
    student_id = req.q_id("studentId")
    if not student_id:
        raise ApiError(400, "invalid_request", "studentId is required")
    rows = telemetry.events_for(req.class_id, student_id, 120, db=req.db)
    return identity.relabel(req.db, req.class_id, rows, req.name_mode)


def _event_type(req: Request) -> str | None:
    value = req.q_str("type", "", 60)
    if not value:
        return None
    if not event_schema.is_known(value):
        raise ApiError(400, "invalid_request", "type must be a registered event type")
    return value


@route("GET", "/api/teacher/events", auth=Auth.STAFF_VIEW, permission="viewInsights", audit="analytics")
def teacher_events(req: Request) -> object:
    student_id = req.q_id("studentId")
    event_type = _event_type(req)
    frm, to = req.q_iso("from"), req.q_iso("to")
    limit = req.q_int("limit", 100, 1, 500)
    if req.q_bool("paged"):
        raw = req.q_str("after", "", 20)
        if raw and not raw.isdigit():
            raise ApiError(400, "invalid_request", "after must be the nextCursor of a previous page")
        page = telemetry.events_page(req.db, req.class_id, student_id=student_id, event_type=event_type, frm=frm, to=to,
                                     after=int(raw) if raw else None, limit=limit)
        identity.relabel(req.db, req.class_id, page["events"], req.name_mode)
        return page
    before = req.q_int("beforeId", 0, 1, 2 ** 62) or None
    rows = telemetry.events_for(req.class_id, student_id, limit, before, db=req.db, event_type=event_type, frm=frm, to=to)
    return identity.relabel(req.db, req.class_id, rows, req.name_mode)


@route("GET", "/api/teacher/summary", auth=Auth.STAFF_VIEW, permission="viewInsights", audit="analytics")
def summary(req: Request) -> dict:
    data = telemetry.summary_for(req.class_id, db=req.db)
    identity.relabel(req.db, req.class_id, data["students"], req.name_mode, key="student_id", field="name")
    return data


@route("GET", "/api/teacher/data-health", auth=Auth.STAFF_VIEW, permission="viewInsights", audit="analytics")
def data_health(req: Request) -> dict:
    health = telemetry.data_health(req.db, req.class_id, req.q_iso("from"), req.q_iso("to"))
    identity.relabel(req.db, req.class_id, health["kiwi"]["perStudent"], req.name_mode, key="studentId", field="label")
    return health
