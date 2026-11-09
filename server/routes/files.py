"""Course file routes (owned by ASSESS; spec §6.3) [AU-D1-24, AU-D1-17].

``POST /api/teacher/files`` (≤ 3 MB; csv, rds, txt, md, qmd, pdf, R, zip), ``PATCH /api/teacher/files/{fileId}``
(``mountInR``, ``aiReference``), ``DELETE /api/teacher/files/{fileId}`` (soft delete), ``GET /api/teacher/files``
(``?assignmentId|unitId``) and ``GET /api/files/{fileId}`` (students: files of a visible assignment or an
accessible chapter). The legacy single attachment (``assignments.file_*``) is the virtual file ``legacy-<assignmentId>``.
"""

from __future__ import annotations

import base64

from server import assignments
from server import db as dbmod
from server.router import ApiError, Auth, Request, Response, route, valid_id


@route("POST", "/api/teacher/files", auth=Auth.INSTRUCTOR, permission="editAssignments")
def upload(req: Request) -> Response:
    body = req.body()
    db = req.db
    with dbmod.write_tx(db):
        meta = assignments.upload_file(db, req.class_id, body, req.identity.user_id or "", valid_id,
                                       assignments.unit_ids(db, req.class_id))
        req.audit("file_upload", "file", meta["id"], None,
                  {k: meta[k] for k in ("name", "size", "scope", "unitId", "questionId", "mountInR", "aiReference")}
                  | {"assignmentId": body.get("assignmentId") or ""})
    return Response(201, meta)


@route("PATCH", "/api/teacher/files/{fileId}", auth=Auth.INSTRUCTOR, permission="editAssignments")
def update(req: Request) -> dict:
    body = req.body()
    db = req.db
    with dbmod.write_tx(db):
        before, after = assignments.update_file(db, req.class_id, req.params["fileId"], body)
        req.audit("file_update", "file", after["id"], {k: before[k] for k in ("mountInR", "aiReference")},
                  {k: after[k] for k in ("mountInR", "aiReference")})
    return after


@route("DELETE", "/api/teacher/files/{fileId}", auth=Auth.INSTRUCTOR, permission="editAssignments")
def delete(req: Request) -> None:
    db = req.db
    with dbmod.write_tx(db):
        before = assignments.delete_file(db, req.class_id, req.params["fileId"], req.identity.user_id or "")
        req.audit("file_delete", "file", req.params["fileId"], {k: before[k] for k in ("name", "size", "scope")}, None)
    return None


@route("GET", "/api/teacher/files", auth=Auth.STAFF_VIEW)
def list_files(req: Request) -> list:
    assignment_id = req.q_id("assignmentId")
    unit_id = req.q_id("unitId")
    if assignment_id:
        assignments.load_row(req.db, req.class_id, assignment_id)
    return assignments.list_files(req.db, req.class_id, assignment_id=assignment_id, unit_id=unit_id)


@route("GET", "/api/files/{fileId}", auth=(Auth.STUDENT, Auth.STAFF_VIEW))
def download(req: Request) -> dict:
    meta, data, work = assignments.file_content(req.db, req.class_id, req.params["fileId"])
    if req.as_student() and not assignments.file_visible_to_student(req.db, req.class_id, meta, work, req.identity.student_id,
                                                                  preview=req.identity.preview):
        raise ApiError(404, "not_found", "File not found")
    return {"name": meta["name"], "type": meta["mime"], "data": base64.b64encode(data).decode()}
