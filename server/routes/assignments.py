"""Assignment, student-work, submission and draft routes (owned by ASSESS; spec §6.3, legacy §6.9).

Legacy v0.5.1 contract kept: ``GET/POST /api/work``, ``GET/PUT /api/work/{workId}``, ``POST /api/work/{workId}/status``,
``GET /api/work/{workId}/attachment``, ``GET /api/teacher/work-page``, ``POST /api/teacher/samples``.
v2: ``GET /api/work-options`` (StudentWorkOption), ``GET /api/work/{workId}`` (StudentAssignment for students),
check v2, submit v2, ``POST /api/work/{workId}/start``, ``GET /api/work/{workId}/files/{fileId}``,
``GET/PUT /api/drafts/{assignmentId}``, ``GET /api/submissions`` (StudentSubmission for students),
``/api/teacher/assignments`` (list/create/detail/update/delete + lifecycle actions, students, preview-check),
``/api/teacher/starter-assignments``.
"""

from __future__ import annotations

import base64

from server import assignments, identity, readers, submissions, telemetry
from server import db as dbmod
from server.router import ApiError, Auth, Request, Response, route, valid_id

STUDENT_OR_STAFF = (Auth.STUDENT, Auth.STAFF_VIEW)
EDIT = {"auth": Auth.INSTRUCTOR, "permission": "editAssignments"}


def _actor(req: Request) -> str:
    return req.identity.user_id or ""


def _student(req: Request) -> str:
    return req.identity.student_id or ""


def _detail(req: Request, work_id: str) -> dict:
    return assignments.teacher_view(req.db, assignments.load_row(req.db, req.class_id, work_id))


def _audit_summary(work: dict) -> dict:
    return {"title": work["title"], "kind": work["kind"], "status": work["status"], "version": work["version"]}


# -- student work (and legacy shared routes) --------------------------------------------------------
@route("GET", "/api/work-options", auth=STUDENT_OR_STAFF)
def work_options(req: Request) -> list:
    if req.as_student():
        return assignments.work_options(req.db, req.class_id, False, student_id=_student(req), preview=req.identity.preview)
    return assignments.work_options(req.db, req.class_id, True)


@route("GET", "/api/work", auth=STUDENT_OR_STAFF)
def list_work(req: Request) -> list:
    if req.as_student():
        return assignments.list_work(req.db, req.class_id, False, student_id=_student(req), preview=req.identity.preview)
    return assignments.list_work(req.db, req.class_id, True)


@route("POST", "/api/work", **EDIT)
def create_work(req: Request) -> Response:
    data = req.body()
    db = req.db
    with dbmod.write_tx(db):
        work = assignments.save_work(db, req.class_id, data, valid_id, actor=_actor(req),
                                     unit_ids=assignments.unit_ids(db, req.class_id))
        req.audit("assignment_create", "assignment", work["id"], None, {"title": work["title"], "kind": work["kind"]})
    return Response(201, work)


@route("GET", "/api/work/{workId}", auth=STUDENT_OR_STAFF)
def get_work(req: Request) -> dict:
    work_id = req.params["workId"]
    if req.as_student():
        row = assignments.student_row(req.db, req.class_id, work_id, _student(req), preview=req.identity.preview)
        return assignments.student_assignment(req.db, row, _student(req))
    return assignments.serialize_work(assignments.load_row(req.db, req.class_id, work_id), True)


@route("PUT", "/api/work/{workId}", **EDIT)
def update_work(req: Request) -> dict:
    work_id = req.params["workId"]
    data = req.body()
    db = req.db
    with dbmod.write_tx(db):
        change = assignments.update_assignment(db, req.class_id, work_id, data, valid_id, actor=_actor(req),
                                               unit_ids=assignments.unit_ids(db, req.class_id))
        work = assignments.serialize_work(assignments.get_work(db, req.class_id, work_id), True)
        req.audit("assignment_edit", "assignment", work_id, change["before"], {"title": work["title"]})
    return work


@route("POST", "/api/work/{workId}/status", **EDIT)
def set_status(req: Request) -> dict:
    work_id = req.params["workId"]
    status = req.body().get("status")
    db = req.db
    with dbmod.write_tx(db):
        work = assignments.set_status(db, req.class_id, work_id, status, actor=_actor(req))
        req.audit("assignment_publish" if status == "published" else "assignment_unpublish", "assignment", work_id)
    return work


@route("POST", "/api/work/{workId}/submit", auth=Auth.STUDENT)
def submit(req: Request) -> Response:
    data = req.student_body()
    db = req.db
    with dbmod.write_tx(db):
        result = submissions.submit(db, req.class_id, req.params["workId"], data, valid_id, req.identity,
                                    allow_draft=req.identity.preview)
    return Response(201, result)


@route("POST", "/api/work/{workId}/check", auth=Auth.STUDENT)
def check(req: Request) -> dict:
    work_id = req.params["workId"]
    data = req.student_body()
    db = req.db
    with dbmod.write_tx(db):
        result, payload = assignments.check_inclass(db, req.class_id, work_id, data, student_id=data["studentId"],
                                                    preview=req.identity.preview)
        result.pop("_check", None)
        if payload is None:  # retry of a recorded check (same eventId): stored result, no second attempt
            return result
        event = {"classId": req.class_id, "studentId": data["studentId"], "studentName": data["studentName"],
                 "sessionId": data["sessionId"] if valid_id(data.get("sessionId")) else "practice-" + data["studentId"],
                 "type": "answer_submitted", "questionId": data["questionId"], "surface": "assignment", "schemaVersion": 2,
                 "payload": payload}
        if valid_id(data.get("eventId")):
            event["eventId"] = data["eventId"]
        telemetry.add_event(db, req.identity, event, server=True)
    return result


@route("POST", "/api/work/{workId}/start", auth=Auth.STUDENT)
def start_attempt(req: Request) -> Response:
    req.student_body()
    db = req.db
    with dbmod.write_tx(db):
        result, created = submissions.start_attempt(db, req.class_id, req.params["workId"], req.identity)
    return Response(201 if created else 200, result)


@route("GET", "/api/work/{workId}/attachment", auth=STUDENT_OR_STAFF)
def attachment(req: Request) -> dict:
    work_id = req.params["workId"]
    if req.as_student():
        row = assignments.student_row(req.db, req.class_id, work_id, _student(req), preview=req.identity.preview)
    else:
        row = assignments.load_row(req.db, req.class_id, work_id)
    if not row["file_data"]:
        raise ApiError(404, "not_found", "Attachment not found")
    return {"name": row["file_name"], "type": row["file_type"], "data": base64.b64encode(row["file_data"]).decode()}


@route("GET", "/api/work/{workId}/files/{fileId}", auth=STUDENT_OR_STAFF)
def work_file(req: Request) -> dict:
    work_id = req.params["workId"]
    meta, data, work = assignments.file_content(req.db, req.class_id, req.params["fileId"])
    if work is None or work["id"] != work_id:
        raise ApiError(404, "not_found", "File not found")
    if req.as_student() and not assignments.visible_to(req.db, work, _student(req), preview=req.identity.preview):
        raise ApiError(404, "not_found", "File not found")
    return {"name": meta["name"], "type": meta["mime"], "data": base64.b64encode(data).decode()}


@route("GET", "/api/submissions", auth=STUDENT_OR_STAFF)
def list_submissions(req: Request) -> list:
    if req.as_student():
        return submissions.student_submissions(req.db, req.class_id, _student(req), req.q_id("assignmentId"))
    rows = submissions.list_submissions(req.db, req.class_id, True, req.q_id("studentId"), req.q_id("assignmentId"))
    return identity.relabel(req.db, req.class_id, rows, req.name_mode)


@route("GET", "/api/drafts/{assignmentId}", auth=Auth.STUDENT)
def get_draft(req: Request) -> dict:
    work_id = req.params["assignmentId"]
    assignments.student_row(req.db, req.class_id, work_id, _student(req), preview=req.identity.preview)
    return submissions.get_draft(req.db, req.class_id, work_id, _student(req))


@route("PUT", "/api/drafts/{assignmentId}", auth=Auth.STUDENT)
def save_draft(req: Request) -> dict:
    data = req.student_body()
    db = req.db
    with dbmod.write_tx(db):
        return submissions.save_draft(db, req.class_id, req.params["assignmentId"], data, req.identity)


# -- staff: assignments -----------------------------------------------------------------------------
@route("GET", "/api/teacher/assignments", auth=Auth.STAFF_VIEW, permission="viewAssignments")
def teacher_assignments(req: Request) -> dict:
    status = req.q_choice("status", ("all", "draft", "published", "closed", "archived"), "all")
    kind = req.q_choice("kind", ("", "homework", "practice"), "")
    unit_id = req.q_id("unitId")
    group_id = req.q_id("groupId")
    page = req.q_int("page", 1, 1, 100_000)
    page_size = req.q_int("pageSize", 20, 1, 100)
    rows, total = assignments.teacher_list(req.db, req.class_id, status=status, kind=kind or None, unit_id=unit_id,
                                           search=req.q_str("search", "", 120).strip(), page=page, page_size=page_size)
    now = dbmod.utcnow()
    items = []
    for row in rows:
        rec = readers.record_from_row(row)
        stats = submissions.assignment_stats(req.db, rec, group_id)
        items.append({"id": rec.id, "title": rec.title, "kind": rec.kind, "unitId": rec.unit_id, "status": rec.status,
                      "state": readers.assignment_state(rec, now), "questionCount": len(rec.questions), "dueAt": rec.due_at,
                      "closeAt": rec.close_at, "openAt": rec.open_at, "latePolicy": dict(rec.late_policy),
                      "solutionsVisibility": rec.solutions_visibility, "hasAttempts": assignments.is_frozen(req.db, row),
                      **assignments.lineage_view(req.db, req.class_id, rec.id, row["revision_of"]),   # S-M01
                      "hasPreviewRows": _has_preview_rows(req, rec.id), "stats": stats, "updatedAt": row["updated_at"]})
    return {"assignments": items, "total": total, "page": page, "pageSize": page_size}


def _has_preview_rows(req: Request, work_id: str) -> bool:
    db = req.db
    preview = "(is_preview = 1 OR student_id LIKE 'preview-%')"
    for table in ("submissions", "answer_drafts", "attempt_starts"):
        if db.execute(f"SELECT 1 FROM {table} WHERE class_id=? AND assignment_id=? AND {preview} LIMIT 1",
                      (req.class_id, work_id)).fetchone():
            return True
    return db.execute(f"SELECT 1 FROM events WHERE class_id=? AND {preview} AND attribution_assignment_id=? LIMIT 1",
                      (req.class_id, work_id)).fetchone() is not None


@route("POST", "/api/teacher/assignments", **EDIT)
def create_assignment(req: Request) -> Response:
    data = req.body()
    db = req.db
    with dbmod.write_tx(db):
        work_id = assignments.create_assignment(db, req.class_id, data, valid_id, actor=_actor(req),
                                                unit_ids=assignments.unit_ids(db, req.class_id))
        work = _detail(req, work_id)
        req.audit("assignment_create", "assignment", work_id, None, _audit_summary(work))
    return Response(201, work)


@route("GET", "/api/teacher/assignments/{assignmentId}", auth=Auth.STAFF_VIEW, permission="viewAssignments")
def teacher_assignment(req: Request) -> dict:
    return _detail(req, req.params["assignmentId"])


@route("PUT", "/api/teacher/assignments/{assignmentId}", **EDIT)
def update_assignment(req: Request) -> dict:
    work_id = req.params["assignmentId"]
    data = req.body()
    db = req.db
    with dbmod.write_tx(db):
        change = assignments.update_assignment(db, req.class_id, work_id, data, valid_id, actor=_actor(req),
                                               unit_ids=assignments.unit_ids(db, req.class_id),
                                               base_updated_at=data.get("baseUpdatedAt"))
        work = _detail(req, work_id)
        req.audit("assignment_edit", "assignment", work_id, change["before"],
                  {**_audit_summary(work), "questionsChanged": change["questionsChanged"],
                   "settingsChanged": change["settingsChanged"], "clearedPreview": change["clearedPreview"]})
    return work


@route("DELETE", "/api/teacher/assignments/{assignmentId}", **EDIT)
def delete_assignment(req: Request) -> None:
    work_id = req.params["assignmentId"]
    db = req.db
    with dbmod.write_tx(db):
        before = _detail(req, work_id)
        cleared = assignments.delete_assignment(db, req.class_id, work_id, actor=_actor(req))
        req.audit("assignment_delete", "assignment", work_id, _audit_summary(before), {"clearedPreview": cleared})
    return None


def _lifecycle(req: Request, action: str, run) -> dict:
    work_id = req.params["assignmentId"]
    db = req.db
    with dbmod.write_tx(db):
        before = _detail(req, work_id)
        extra = run(db, work_id) or {}
        work = _detail(req, work_id)
        req.audit(f"assignment_{action}", "assignment", work_id, _audit_summary(before), {**_audit_summary(work), **extra})
    return work


@route("POST", "/api/teacher/assignments/{assignmentId}/publish", **EDIT)
def publish(req: Request) -> dict:
    body = req.body_or_empty()
    open_at = body["openAt"] if "openAt" in body else assignments._UNSET
    return _lifecycle(req, "publish", lambda db, wid: assignments.publish(db, req.class_id, wid, actor=_actor(req), open_at=open_at))


@route("POST", "/api/teacher/assignments/{assignmentId}/unpublish", **EDIT)
def unpublish(req: Request) -> dict:
    return _lifecycle(req, "unpublish", lambda db, wid: assignments.unpublish(db, req.class_id, wid, actor=_actor(req)))


@route("POST", "/api/teacher/assignments/{assignmentId}/close", **EDIT)
def close(req: Request) -> dict:
    body = req.body_or_empty()
    close_at = assignments._iso(body.get("closeAt"), "closeAt") or dbmod.iso_seconds(dbmod.utcnow())
    return _lifecycle(req, "close", lambda db, wid: assignments.set_close(db, req.class_id, wid, close_at, actor=_actor(req)))


@route("POST", "/api/teacher/assignments/{assignmentId}/reopen", **EDIT)
def reopen(req: Request) -> dict:
    return _lifecycle(req, "reopen", lambda db, wid: assignments.set_close(db, req.class_id, wid, None, actor=_actor(req)))


@route("POST", "/api/teacher/assignments/{assignmentId}/archive", **EDIT)
def archive(req: Request) -> dict:
    return _lifecycle(req, "archive", lambda db, wid: assignments.set_archived(db, req.class_id, wid, True, actor=_actor(req)))


@route("POST", "/api/teacher/assignments/{assignmentId}/unarchive", **EDIT)
def unarchive(req: Request) -> dict:
    return _lifecycle(req, "unarchive", lambda db, wid: assignments.set_archived(db, req.class_id, wid, False, actor=_actor(req)))


@route("POST", "/api/teacher/assignments/{assignmentId}/duplicate", **EDIT)
def duplicate(req: Request) -> Response:
    work_id = req.params["assignmentId"]
    body = req.body_or_empty()
    db = req.db
    with dbmod.write_tx(db):
        new_id = assignments.duplicate(db, req.class_id, work_id, body, actor=_actor(req))
        work = _detail(req, new_id)
        req.audit("assignment_duplicate", "assignment", new_id, {"source": work_id},
                  {**_audit_summary(work), "revisionOf": work["revisionOf"]})
    return Response(201, work)


@route("POST", "/api/teacher/assignments/{assignmentId}/clear-preview", **EDIT)
def clear_preview(req: Request) -> dict:
    work_id = req.params["assignmentId"]
    db = req.db
    with dbmod.write_tx(db):
        assignments.load_row(db, req.class_id, work_id)
        counts = assignments.clear_preview(db, req.class_id, work_id)
        req.audit("assignment_clear_preview", "assignment", work_id, None, {"counts": counts})
    return {"counts": counts}


@route("POST", "/api/teacher/assignments/{assignmentId}/preview-check", **EDIT)
def preview_check(req: Request) -> dict:
    """"Try the auto-check" in the editor: judges a question draft; writes nothing [AU-D1-07]."""
    from server import judging

    body = req.body()
    kind = body.get("kind") if body.get("kind") in assignments.KINDS else "homework"
    question = assignments.clean_question(body.get("question"), 1, kind, valid_id)
    answer = body.get("answer")
    if not isinstance(answer, str) or len(answer) > submissions.MAX_ANSWER:
        raise ValueError("answer must be text")
    run_output = body.get("runOutput") if isinstance(body.get("runOutput"), str) else None
    return judging.check(question, answer, run_output if question["type"] == "complete" else None, provenance="client").as_dict()


@route("GET", "/api/teacher/assignments/{assignmentId}/students", auth=Auth.STAFF_VIEW, permission="viewStudents", audit="analytics")
def assignment_students(req: Request) -> dict:
    row = assignments.load_row(req.db, req.class_id, req.params["assignmentId"])
    state = req.q_choice("state", submissions.STUDENT_STATES, "submitted")
    return submissions.students_status(req.db, readers.record_from_row(row), state, req.q_id("groupId"), req.name_mode)


# -- staff: starter assignments and legacy authoring ------------------------------------------------
@route("GET", "/api/teacher/starter-assignments", auth=Auth.STAFF_VIEW)
def starter_assignments(req: Request) -> list:
    return assignments.starter_list(req.db, req.class_id, assignments.unit_ids(req.db, req.class_id))


@route("POST", "/api/teacher/starter-assignments", **EDIT)
def add_starter_assignments(req: Request) -> Response:
    body = req.body_or_empty()
    db = req.db
    with dbmod.write_tx(db):
        result = assignments.add_starters(db, req.class_id, body.get("keys"), body.get("unitMap"), valid_id, actor=_actor(req),
                                          unit_ids=assignments.unit_ids(db, req.class_id))
        req.audit("starter_add", "assignment", "", None, {"created": result["createdIds"], "skipped": result["skipped"]})
    return Response(201, {"created": result["created"], "skipped": result["skipped"]})


@route("GET", "/api/teacher/work-page", auth=Auth.STAFF_VIEW, permission="viewAssignments")
def work_page(req: Request) -> dict:
    args = {
        "view": req.q_choice("view", ("assignments", "grading"), "assignments"),
        "page": str(req.q_int("page", 1, 1, 1_000_000, clamp=True)),
        "search": req.q_str("search", "", 120),
    }
    for key in ("status", "assignmentId"):
        if req.query.get(key):
            args[key] = req.query[key]
    if args["view"] == "grading":
        from server import grading

        page = grading.work_page(req.db, req.class_id, args)
        identity.relabel(req.db, req.class_id, page["submissions"], req.name_mode)
        return page
    return assignments.work_page(req.db, req.class_id, args)


@route("POST", "/api/teacher/samples", **EDIT)
def add_samples(req: Request) -> Response:
    """Legacy "Load CSS example drafts": every starter not added yet (``{created}``)."""
    db = req.db
    with dbmod.write_tx(db):
        result = assignments.add_starters(db, req.class_id, None, None, valid_id, actor=_actor(req),
                                          unit_ids=assignments.unit_ids(db, req.class_id))
        req.audit("starter_add", "assignment", "", None, {"created": result["createdIds"]})
    return Response(201, {"created": result["created"]})
