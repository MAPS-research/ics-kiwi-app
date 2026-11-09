"""Grading routes (owned by GRADE; spec §6.4).

Legacy (v0.5.1 contract, §6.9): ``POST /api/submissions/{submissionId}/grade`` (total-only, released immediately,
requires ``releaseGrades``) and ``GET /api/teacher/hub``.

v0.6: grading queue, submission detail, grade v2 (save always drafts, release needs ``releaseGrades``),
bulk release, unrelease, gradebook, Grades for LMS CSV, Student × assignment status CSV and in-class exercise
results. Every staff mutation is audited; names go through ``identity.relabel``/``identity.label``.
"""

from __future__ import annotations

from server import db as dbmod
from server import grading, identity
from server.router import ApiError, Auth, Request, Response, route


def _filename(prefix: str, class_id: str) -> str:
    return f"{prefix}-{class_id}-{dbmod.utcnow().strftime('%Y%m%d')}.csv"


def _csv(data: bytes, filename: str) -> Response:
    return Response(status=200, stream=[data], content_type="text/csv; charset=utf-8", filename=filename)


@route("POST", "/api/submissions/{submissionId}/grade", auth=Auth.STAFF_GRADE, permission="releaseGrades")
def legacy_grade(req: Request) -> dict:
    submission_id = req.params["submissionId"]
    result = grading.grade(req.db, req.class_id, submission_id, req.body(), req.identity)
    req.audit("grade_legacy", "submission", submission_id, None, {"grade": result["grade"]})
    return result


@route("GET", "/api/teacher/hub", auth=Auth.STAFF_VIEW, permission="viewStudents", audit="gradebook")
def hub(req: Request) -> dict:
    data = grading.hub(req.db, req.class_id)
    identity.relabel(req.db, req.class_id, data["students"], req.name_mode)
    return data


@route("GET", "/api/teacher/grading/queue", auth=Auth.STAFF_GRADE, permission="grade", audit="gradebook")
def grading_queue(req: Request) -> dict:
    return grading.queue(
        req.db, req.class_id,
        show=req.q_choice("show", grading.SHOW_CHOICES, "latest"),
        view=req.q_choice("view", grading.VIEW_CHOICES, "student"),
        assignment_id=req.q_id("assignmentId"), question_id=req.q_id("questionId"), student_id=req.q_id("studentId"),
        group_id=req.q_id("groupId"), search=req.q_str("search", "", 120),
        include_preview=req.q_bool("includePreview"), page=req.q_int("page", 1, 1, 100_000),
        name_mode=req.name_mode)


@route("GET", "/api/teacher/submissions/{submissionId}", auth=Auth.STAFF_GRADE, permission="grade", audit="gradebook")
def submission_detail(req: Request) -> dict:
    return grading.submission_detail(req.db, req.class_id, req.params["submissionId"], req.name_mode)


@route("PUT", "/api/teacher/submissions/{submissionId}/grade", auth=Auth.STAFF_GRADE, permission="grade")
def save_grade(req: Request) -> dict:
    submission_id = req.params["submissionId"]
    detail, before, after = grading.save_grade(req.db, req.class_id, submission_id, req.body(), req.identity, req.name_mode)
    if after.pop("unreleased", False):
        req.audit("grade_unrelease", "submission", submission_id, {"status": "released"}, {"status": after["status"]})
    req.audit("grade_release" if after["status"] == "released" else "grade_save", "submission", submission_id, before, after)
    return detail


@route("POST", "/api/teacher/assignments/{assignmentId}/release", auth=Auth.STAFF_GRADE, permission="releaseGrades")
def release(req: Request) -> dict:
    assignment_id = req.params["assignmentId"]
    body = req.body_or_empty()
    released = grading.release_assignment(req.db, req.class_id, assignment_id, body.get("submissionIds"), req.identity)
    req.audit("grades_release", "assignment", assignment_id, None, {"released": len(released), "submissionIds": released})
    return {"released": len(released)}


@route("POST", "/api/teacher/submissions/{submissionId}/unrelease", auth=Auth.INSTRUCTOR)
def unrelease(req: Request) -> dict:
    submission_id = req.params["submissionId"]
    detail = grading.unrelease(req.db, req.class_id, submission_id, req.identity, req.name_mode)
    req.audit("grade_unrelease", "submission", submission_id, {"status": "released"},
              {"status": detail["submission"]["gradeStatus"]})
    return detail


@route("GET", "/api/teacher/gradebook", auth=Auth.STAFF_VIEW, permission="viewStudents", audit="gradebook")
def gradebook(req: Request) -> dict:
    return grading.gradebook(
        req.db, req.class_id, policy=req.q_choice("policy", ("latest", "highest"), "latest"),
        search=req.q_str("search", "", 120), group_id=req.q_id("groupId"), page=req.q_int("page", 1, 1, 100_000),
        page_size=req.q_int("pageSize", 50, 1, 100), name_mode=req.name_mode)


@route("GET", "/api/teacher/exports/grades.csv", auth=Auth.STAFF_GRADE, permission="exportGrades", audit="export")
def grades_csv(req: Request) -> Response:
    data = grading.grades_csv(
        req.db, req.class_id, policy=req.q_choice("policy", ("latest", "highest"), "latest"),
        released_only=req.q_bool("releasedOnly", True), layout=req.q_choice("layout", ("wide", "long"), "wide"),
        assignment_ids=req.q_list("assignmentIds"), group_ids=req.q_list("groupIds"))
    return _csv(data, _filename("grades", req.class_id))


@route("GET", "/api/teacher/exports/assignment-status.csv", auth=Auth.STAFF_GRADE, permission="exportGrades", audit="export")
def assignment_status_csv(req: Request) -> Response:
    data = grading.status_csv(req.db, req.class_id, assignment_ids=req.q_list("assignmentIds"),
                              group_ids=req.q_list("groupIds"), pseudonymize=req.q_bool("pseudonymize"))
    return _csv(data, _filename("assignment-status", req.class_id))


@route("GET", "/api/teacher/assignments/{assignmentId}/results", auth=Auth.STAFF_VIEW, permission="viewStudents", audit="analytics")
def exercise_results(req: Request) -> dict:
    start, end = req.q_iso("from"), req.q_iso("to")
    if start and end and start >= end:
        raise ApiError(400, "invalid_request", "from must be before to")
    data = grading.exercise_results(req.db, req.class_id, req.params["assignmentId"], start=start, end=end,
                                    group_id=req.q_id("groupId"), name_mode=req.name_mode)
    for question in data["questions"]:
        identity.relabel(req.db, req.class_id, question["stuck"], req.name_mode)
    identity.relabel(req.db, req.class_id, data["students"], req.name_mode)
    return data
