"""Export routes (owned by PEOPLE; GRADE owns grades.csv and assignment-status.csv in ``routes/grading.py``).

§6.8 / §13.6: activity, AI conversations, generated items, coded conversations, one student's case file, the research
package and the codebook; §14.7: course package export/import and templates. Downloads return
``Response(stream=…, filename=…)``; the router spools them and sends Content-Length. Routes declared with
``audit="export"`` are logged in ``data_access_log`` (row count and purpose).
"""

from __future__ import annotations

from server import audit, course_package, exports, identity
from server.router import ApiError, Auth, Request, Response, route, valid_id


def _audit_export(req: Request, name: str, response: Response) -> Response:
    """§5.5: exports are recorded as staff actions too (PII-stripped parameters, row count; no student content)."""
    target = "hash:" + identity.student_hash(req.db, req.class_id, req.query["studentId"]) if req.query.get("studentId") else ""
    req.audit("export", "export", target or name, None,
              {"file": name, "params": audit.strip_params(req.query), "rows": response.headers.get("X-Export-Rows")})
    return response


def _teaching(kind: str, fmt: str):
    def handler(req: Request) -> Response:
        return _audit_export(req, f"{kind}.{fmt}", exports.teaching_export(req, kind, fmt))

    handler.__name__ = f"export_{kind.replace('-', '_')}_{fmt}"
    return handler


for _kind, _formats in (("activity", ("csv", "jsonl")), ("ai-conversations", ("csv", "jsonl")),
                        ("generated-items", ("csv", "jsonl")), ("conversation-codes", ("csv",))):
    for _fmt in _formats:
        route("GET", f"/api/teacher/exports/{_kind}.{_fmt}", auth=Auth.STAFF_VIEW, permission="exportActivity",
              audit="export")(_teaching(_kind, _fmt))


@route("GET", "/api/teacher/exports/student/{studentId}.zip", auth=Auth.STAFF_GRADE, permission="exportActivity",
       audit="export")
def student_case_file(req: Request) -> Response:
    student_id = req.params.get("studentId", "")
    if not valid_id(student_id):
        raise ApiError(400, "invalid_request", "studentId has an invalid format")
    response = exports.case_file(req, student_id)
    req.audit("export", "export", "hash:" + identity.student_hash(req.db, req.class_id, student_id),
              None, {"file": "student case file", "params": audit.strip_params(req.query), "rows": response.headers.get("X-Export-Rows")})
    return response


@route("GET", "/api/teacher/exports/research-package.zip", auth=Auth.STAFF_VIEW, permission="exportResearch", audit="export")
def research_package(req: Request) -> Response:
    return _audit_export(req, "research-package.zip", exports.research_package(req))


@route("GET", "/api/teacher/exports/codebook.md", auth=Auth.STAFF_VIEW)
def codebook(req: Request) -> Response:
    text = exports.codebook_md()
    return Response(status=200, body=text, content_type="text/markdown; charset=utf-8", filename="codebook.md")


@route("GET", "/api/teacher/course-package.zip", auth=Auth.INSTRUCTOR, permission="coursePackage")
def export_course_package(req: Request) -> Response:
    response = course_package.export_response(req)
    req.audit("course_package_export", "course", req.class_id, None, {"file": "course-package.zip"})
    return response


@route("GET", "/api/teacher/course-templates", auth=Auth.INSTRUCTOR, permission="coursePackage")
def course_templates(req: Request) -> list:
    return course_package.list_templates()


@route("POST", "/api/teacher/course-package/import", auth=Auth.INSTRUCTOR, permission="coursePackage", max_body=20_000_000)
def import_course_package(req: Request) -> dict:
    result = course_package.import_package(req)
    if result["mode"] == "apply":
        req.audit("course_package_import", "course", req.class_id, None, {
            "chapters": [c for c in result["chapters"] if c["action"] != "skip"],
            "assignments": len([a for a in result["assignments"] if a["action"] == "add"]),
            "policies": len([p for p in result["policies"] if p["action"] == "add"]), "files": result["files"]})
    return result
