"""Core endpoints (spec §6.1; FOUNDATION, frozen): health, me, Kiwi context, course, time range, demo sessions, verify."""

from __future__ import annotations

from server import ai, auth, course_config, identity, readers
from server import db as dbmod
from server.router import ApiError, Auth, Request, Response, route, valid_id

VERSION = "0.7.0"


@route("GET", "/api/health", auth=Auth.PUBLIC)
def health(req: Request) -> dict:
    return {"ok": True, "runtime": "browser-webR", "aiAvailable": ai.available(), "version": VERSION}


@route("GET", "/api/me", auth=Auth.PUBLIC)
def me(req: Request) -> dict:
    return auth.me(req.identity, req.db)


@route("GET", "/api/kiwi/context", auth=Auth.PUBLIC)
def kiwi_context(req: Request) -> dict:
    if req.identity.kind != "kiwi":
        raise ApiError(401, "unauthenticated", "Open CSS Lab from Kiwi")
    return {**req.identity.kiwi_context, "staffRole": req.identity.staff_role}


@route("GET", "/api/course", auth=Auth.PUBLIC)
def get_course(req: Request) -> dict:
    course = course_config.course_for(req.class_id, req.db)
    if req.identity.is_staff and not req.identity.preview:
        return course_config.staff_view(course)
    return course_config.student_view(course)


@route("PUT", "/api/course", auth=Auth.INSTRUCTOR, permission="manageCourse")
def put_course(req: Request) -> dict:
    data = req.body()
    db = req.db
    with dbmod.write_tx(db):
        row = db.execute("SELECT updated_at FROM courses WHERE class_id=?", (req.class_id,)).fetchone()
        base = data.get("baseUpdatedAt")
        if base and row:
            try:
                base_at, stored_at = dbmod.parse_iso(base), dbmod.parse_iso(row["updated_at"])
            except ValueError as exc:
                raise ApiError(400, "invalid_request", "baseUpdatedAt must be an ISO date-time") from exc
            if base_at is not None and stored_at is not None and base_at < stored_at:
                raise ApiError(409, "stale_version", "The course changed since you opened it. Reload and apply your edits again.")
        stored = course_config.course_for(req.class_id, db)
        # R-B01 / S-M05: hidden chapters and staff-only chapter fields the body leaves out stay as stored
        config = course_config.validate_course(course_config.keep_unsent(data, stored))
        ids = {unit["id"] for unit in config["units"]}
        if course_config.referenced_units(db, req.class_id) - ids:
            raise ApiError(400, "invalid_request",
                           "Chapters with assignments, activity or linked materials can't be removed. Archive the chapter instead.")
        before = stored if row else None
        stamp = dbmod.now()
        db.execute(
            "INSERT INTO courses (class_id, config_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(class_id) DO UPDATE "
            "SET config_json=excluded.config_json, updated_at=excluded.updated_at",
            (req.class_id, dbmod.json_dumps(config), stamp))
        db.execute(
            "INSERT INTO course_settings (class_id, settings_json, updated_at, updated_by) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(class_id) DO NOTHING",
            (req.class_id, dbmod.json_dumps(course_config.default_settings()), stamp, req.identity.user_id or ""))
        req.audit("course_update", "course", req.class_id, before, config)
    return course_config.staff_view(course_config.course_for(req.class_id, db))


@route("GET", "/api/teacher/time-range", auth=Auth.STAFF_VIEW)
def time_range(req: Request) -> dict:
    preset = req.q_choice("preset", course_config.TIME_PRESETS, "since_last_class")
    db = req.db
    schedule = readers.settings(db, req.class_id)["schedule"]
    population, params = identity.population_sql("e", class_linked=identity.class_linked(db, req.class_id))
    first = db.execute(f"SELECT MIN(e.created_at) FROM events e WHERE e.class_id=? AND {population}",
                       (req.class_id, *params)).fetchone()[0]
    return course_config.time_range(preset, schedule, now=dbmod.utcnow(), first_event_at=first,
                                    custom_from=req.q_iso("from"), custom_to=req.q_iso("to")).as_dict()


@route("POST", "/api/demo/session", auth=Auth.PUBLIC)
def demo_session(req: Request) -> dict:
    db = req.db
    if identity.class_linked(db, req.class_id):
        raise ApiError(403, "forbidden", "Demo sessions are only available in standalone courses")
    body = req.body()
    token = body.get("token")
    if token is not None:
        data = auth.verify_demo_token(db, token) if isinstance(token, str) else None
        if data is None or data["c"] != req.class_id:
            raise ApiError(403, "forbidden", "This demo link is invalid or expired. Ask your teacher for a new link.")
        student = str(data["s"])
        if identity.tombstone(db, req.class_id, student) is not None:
            raise ApiError(403, "forbidden", auth.DEMO_REMOVED)   # SB-m09
        session, expires = auth.mint_demo_token(db, req.class_id, student, expires=int(data["e"]))
    else:
        student = body.get("studentId")
        if student not in auth.BUILTIN_DEMO_STUDENTS:
            raise ApiError(403, "forbidden", "Open the student workspace with the demo link from your teacher.")
        session, expires = auth.mint_demo_token(db, req.class_id, student, days=auth.DEMO_SESSION_DAYS)
    return {"token": session, "studentId": student, "studentName": auth.demo_name(db, req.class_id, student),
            "expiresAt": expires}


@route("POST", "/api/teacher/demo-links", auth=Auth.INSTRUCTOR, permission="manageStudents")
def demo_link(req: Request) -> dict:
    db = req.db
    if identity.class_linked(db, req.class_id):
        raise ApiError(403, "forbidden", "Demo links are only for standalone courses")
    student = req.body().get("studentId")
    if not valid_id(student) or not identity.is_roster_eligible(student):
        raise ApiError(400, "invalid_request", "studentId has an invalid format")
    if identity.tombstone(db, req.class_id, student) is not None:
        raise ApiError(409, "student_removed", "This student's data was deleted or anonymized; a demo link would write new "
                       "rows under the removed id.")   # SB-m09
    with dbmod.write_tx(db):
        identity.ensure_roster(db, req.class_id, student, source="import")
        token, expires = auth.mint_demo_token(db, req.class_id, student, days=auth.DEMO_LINK_DAYS)
        req.audit("demo_link_create", "student", student, None, {"expiresAt": expires})
    return {"url": f"/student/assignments#demo={token}", "expiresAt": expires}


@route("POST", "/api/teacher/verify", auth=Auth.PUBLIC)
def verify(req: Request) -> dict | Response:
    ident = req.identity
    if ident.staff_role:
        return {"ok": True, "role": ident.staff_role}
    message = "Teacher key is incorrect" if ident.key_failed else "Teacher access is required"
    return Response(401, {"ok": False, "role": None, "error": message, "code": "unauthenticated"})
