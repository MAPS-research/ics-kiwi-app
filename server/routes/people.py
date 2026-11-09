"""People, settings and governance routes (owned by PEOPLE; spec §6.8).

Legacy (§6.9): ``POST /api/teacher/roster`` (``{students: [{studentId, studentName}]}`` → upsert display names through
``identity.ensure_roster``; never downgrades ``source``).

v0.6.0: roster list/import/edit, student search and profile, groups (incl. cohorts, randomization, history), staff &
roles (incl. Kiwi staff list and overrides), course settings, audit viewer, student data deletion and retention.
Every mutation calls ``req.audit``; names are resolved through ``identity.labels`` in ``req.name_mode``.
"""

from __future__ import annotations

from server import audit, governance, identity, roster
from server.router import ApiError, Auth, Request, route, valid_id


def _actor(req: Request) -> str:
    return audit.actor_label(req.identity)


def _student_param(req: Request) -> str:
    student_id = req.params.get("studentId", "")
    if not valid_id(student_id):
        raise ApiError(400, "invalid_request", "studentId has an invalid format")
    return student_id


# -- roster ---------------------------------------------------------------------------------------
@route("POST", "/api/teacher/roster", auth=Auth.INSTRUCTOR, permission="manageStudents")
def import_roster(req: Request) -> dict:
    data = req.body()
    result = roster.import_roster(req.db, req.class_id, data, valid_id)
    req.audit("roster_import", "roster", "", None, {"count": result["count"]})
    return result


@route("GET", "/api/teacher/roster", auth=Auth.STAFF_VIEW, permission="viewStudents", audit="analytics")
def list_roster(req: Request) -> dict:
    status = req.q_choice("status", ("active", "dropped"), "") or None
    consent = req.q_choice("consent", ("yes", "no", "not_asked"), "") or None
    excluded_raw = req.q_choice("excluded", ("0", "1"), "")
    return roster.list_roster(
        req.db, req.class_id, mode=req.name_mode, search=req.q_str("search", "", 100), group_id=req.q_id("groupId"),
        status=status, consent=consent, excluded=None if excluded_raw == "" else excluded_raw == "1",
        page=req.q_int("page", 1, 1, 100000), page_size=req.q_int("pageSize", 50, 1, 100))


@route("POST", "/api/teacher/roster/import", auth=Auth.INSTRUCTOR, permission="manageStudents")
def import_roster_v2(req: Request) -> dict:
    result = roster.import_v2(req.db, req.class_id, req.body(), _actor(req))
    if result["mode"] == "apply":
        req.audit("roster_import", "roster", "", None, {
            "applied": result["applied"],
            "rows": [{"studentId": r["studentId"], "action": r["action"], "fields": sorted(r["diff"])} for r in result["rows"]]})
    return result


@route("PATCH", "/api/teacher/roster/{studentId}", auth=Auth.INSTRUCTOR, permission="manageStudents")
def patch_roster(req: Request) -> dict:
    student_id = _student_param(req)
    before, after, consent_before, consent_after = roster.patch(req.db, req.class_id, student_id, req.body(), _actor(req))
    if before or after:
        req.audit("roster_update", "roster", student_id, before, after)
    if consent_after:
        req.audit("roster_consent_override", "roster", student_id, consent_before, consent_after)
    entry = roster.entry(req.db, req.class_id, student_id, req.name_mode)
    if entry is None:
        raise ApiError(404, "not_found", "This student is not on the roster")
    return entry


# -- search & profile -----------------------------------------------------------------------------
@route("GET", "/api/teacher/students/search", auth=Auth.STAFF_VIEW, permission="viewStudents")
def search_students(req: Request) -> list:
    q = req.q_str("q", "", 100).strip()
    if not q:
        raise ApiError(400, "invalid_request", "Type at least one character to search")
    return roster.search(req.db, req.class_id, q, req.name_mode)


@route("GET", "/api/teacher/students/{studentId}/profile", auth=Auth.STAFF_VIEW, permission="viewStudents", audit="profile")
def student_profile(req: Request) -> dict:
    ident = req.identity
    return roster.profile(req.db, req.class_id, _student_param(req), mode=req.name_mode, permissions=ident.permissions,
                          viewer=ident.staff_role == "viewer", start=req.q_iso("from"), end=req.q_iso("to"))


# -- groups ---------------------------------------------------------------------------------------
def _group_param(req: Request) -> str:
    group_id = req.params.get("groupId", "")
    if not valid_id(group_id):
        raise ApiError(400, "invalid_request", "groupId has an invalid format")
    return group_id


@route("GET", "/api/teacher/groups", auth=Auth.STAFF_VIEW, permission="viewInsights")
def list_groups(req: Request) -> list:
    return governance.list_groups(req.db, req.class_id, include_archived=req.q_bool("includeArchived"))


@route("POST", "/api/teacher/groups", auth=Auth.INSTRUCTOR, permission="manageStudents")
def create_group(req: Request) -> dict:
    body = req.body()
    group = governance.create_group(req.db, req.class_id, body, _actor(req))
    req.audit("group_create", "group", group["id"], None,
              {**group, "studentIds": governance.group_members(req.db, req.class_id, group["id"])})
    return group


@route("PATCH", "/api/teacher/groups/{groupId}", auth=Auth.INSTRUCTOR, permission="manageStudents")
def update_group(req: Request) -> dict:
    group_id = _group_param(req)
    before, after = governance.update_group(req.db, req.class_id, group_id, req.body())
    req.audit("group_update", "group", group_id, before, after)
    return after


@route("DELETE", "/api/teacher/groups/{groupId}", auth=Auth.INSTRUCTOR, permission="manageStudents")
def archive_group(req: Request) -> None:
    group_id = _group_param(req)
    before = governance.archive_group(req.db, req.class_id, group_id)
    req.audit("group_archive", "group", group_id, before, {"archived": True})


@route("PUT", "/api/teacher/groups/{groupId}/members", auth=Auth.INSTRUCTOR, permission="manageStudents")
def set_group_members(req: Request) -> dict:
    group_id = _group_param(req)
    body = req.body()
    if "studentIds" not in body:
        raise ApiError(400, "invalid_request", "studentIds is required")
    before, after = governance.set_members(req.db, req.class_id, group_id, body["studentIds"], _actor(req))
    req.audit("group_members", "group", group_id, {"studentIds": before}, {"studentIds": after})
    return next(g for g in governance.list_groups(req.db, req.class_id, include_archived=True) if g["id"] == group_id)


@route("POST", "/api/teacher/groups/randomize", auth=Auth.INSTRUCTOR, permission="manageStudents")
def randomize_groups(req: Request) -> dict:
    result = governance.randomize(req.db, req.class_id, req.body(), _actor(req))
    req.audit("groups_randomize", "group", ",".join(req.body().get("groupIds") or [])[:200], None, result)
    return result


@route("GET", "/api/teacher/groups/history", auth=Auth.STAFF_VIEW, permission="viewInsights")
def group_history(req: Request) -> list:
    kind = req.q_choice("kind", governance.GROUP_KINDS, "") or None
    rows = governance.history(req.db, req.class_id, req.q_id("studentId"), kind)
    # Decision D3: researchers read Groups without the roster, so history rows carry the (pseudonymous) label.
    return identity.relabel(req.db, req.class_id, rows, req.name_mode)


# -- staff & roles --------------------------------------------------------------------------------
def _staff_param(req: Request) -> str:
    staff_id = req.params.get("staffId", "")
    if not valid_id(staff_id):
        raise ApiError(400, "invalid_request", "staffId has an invalid format")
    return staff_id


@route("GET", "/api/teacher/staff", auth=Auth.INSTRUCTOR, permission="manageStaff")
def list_staff(req: Request) -> dict:
    return governance.staff_listing(req.db, req.class_id)


@route("POST", "/api/teacher/staff", auth=Auth.INSTRUCTOR, permission="manageStaff")
def create_staff(req: Request) -> dict:
    result = governance.create_staff(req.db, req.identity, req.class_id, req.body())
    req.audit("staff_create", "staff", result["staff"]["id"], None, result["staff"])
    return result


@route("PATCH", "/api/teacher/staff/{staffId}", auth=Auth.INSTRUCTOR, permission="manageStaff")
def update_staff(req: Request) -> dict:
    staff_id = _staff_param(req)
    before, after = governance.update_staff(req.db, req.identity, req.class_id, staff_id, req.body())
    req.audit("staff_update", "staff", staff_id, before, after)
    return after


@route("DELETE", "/api/teacher/staff/{staffId}", auth=Auth.INSTRUCTOR, permission="manageStaff")
def revoke_staff(req: Request) -> None:
    staff_id = _staff_param(req)
    before = governance.revoke_staff(req.db, req.identity, req.class_id, staff_id)
    req.audit("staff_revoke", "staff", staff_id, before, {"revoked": True})


# -- settings -------------------------------------------------------------------------------------
@route("GET", "/api/teacher/settings", auth=Auth.STAFF_VIEW)
def get_settings(req: Request) -> dict:
    from server import readers

    return readers.settings(req.db, req.class_id)


@route("PUT", "/api/teacher/settings", auth=Auth.INSTRUCTOR, permission="manageCourse")
def put_settings(req: Request) -> dict:
    from server import readers

    before, after = governance.save_settings(req.db, req.class_id, req.body(), _actor(req))
    if after:
        req.audit("settings_update", "settings", req.class_id, before, after)
    return readers.settings(req.db, req.class_id)


# -- audit, deletion, retention -------------------------------------------------------------------
@route("GET", "/api/teacher/audit", auth=Auth.INSTRUCTOR, permission="viewAudit", audit="audit")
def audit_log(req: Request) -> dict:
    return governance.audit_entries(
        req.db, req.class_id, kind=req.q_choice("kind", ("actions", "access"), "actions"), start=req.q_iso("from"),
        end=req.q_iso("to"), actor=req.q_str("actor", "", 200) or None, action=req.q_str("action", "", 80) or None,
        page=req.q_int("page", 1, 1, 100000), page_size=req.q_int("pageSize", 50, 1, 100), mode=req.name_mode)


@route("POST", "/api/teacher/students/{studentId}/delete-data", auth=Auth.INSTRUCTOR, permission="deleteData")
def delete_student_data(req: Request) -> dict:
    student_id = _student_param(req)
    body = req.body()
    mode = body.get("mode")
    if mode not in ("anonymize", "delete"):
        raise ApiError(400, "invalid_request", "mode must be anonymize or delete")
    if body.get("confirm") != student_id:
        raise ApiError(400, "invalid_request", "Type the student ID exactly to confirm")
    from server import identity

    student_hash = identity.student_hash(req.db, req.class_id, student_id)
    counts = governance.delete_student_data(req.db, req.class_id, student_id, mode, _actor(req))
    req.audit("student_anonymize" if mode == "anonymize" else "student_delete", "student", f"hash:{student_hash}",
              None, {"mode": mode, "counts": counts})
    return {"counts": counts}


@route("GET", "/api/teacher/retention", auth=Auth.INSTRUCTOR, permission="deleteData")
def retention(req: Request) -> dict:
    return governance.retention_report(req.db, req.class_id)


@route("POST", "/api/teacher/retention/run", auth=Auth.INSTRUCTOR, permission="deleteData")
def run_retention(req: Request) -> dict:
    if req.body().get("confirm") != "RUN RETENTION":
        raise ApiError(400, "invalid_request", "Type RUN RETENTION to confirm")
    counts = governance.run_retention(req.db, req.class_id)
    req.audit("retention_run", "course", req.class_id, None, {"counts": counts})
    return {"counts": counts}
