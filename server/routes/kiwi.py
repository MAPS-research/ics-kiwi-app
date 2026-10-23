"""Kiwi native-activity routes (owned by TELEMETRY; spec §6.2, §15.2).

``POST /api/teacher/kiwi/sync`` (Kiwi token with analytics scope; ``imported``, ``perStudent`` backfill progress,
``excludedByDesign``/``excludedNotEnrolled``, tombstones honored), ``GET /api/teacher/kiwi/status`` and
``PUT /api/teacher/kiwi/material`` (``material_unit_map`` history; event payloads are never rewritten).
"""

from __future__ import annotations

from server import audit, course_config, identity, kiwi_bridge
from server import db as dbmod
from server.router import Auth, Request, route, valid_id


@route("POST", "/api/teacher/kiwi/sync", auth=Auth.STAFF_VIEW)
def sync(req: Request) -> dict:
    ident = req.identity
    if ident.kind != "kiwi" or not ident.kiwi_context.get("canViewAnalytics") or not ident.token:
        raise kiwi_bridge.BridgeError("Verified Kiwi course analytics access is required", 403)
    result = kiwi_bridge.sync(dbmod.connection, req.class_id, ident.token)
    identity.relabel(req.db, req.class_id, result.get("perStudent") or [], req.name_mode, key="studentId", field="label")
    return result


@route("GET", "/api/teacher/kiwi/status", auth=Auth.STAFF_VIEW)
def status(req: Request) -> dict:
    return kiwi_bridge.status(req.db, req.class_id)


@route("PUT", "/api/teacher/kiwi/material", auth=Auth.INSTRUCTOR, permission="manageCourse")
def map_material(req: Request) -> dict:
    data = req.body()
    unit_id = data.get("unitId", "")
    material_id = data.get("materialId", "")
    if not isinstance(unit_id, str) or not isinstance(material_id, str) or not valid_id(material_id):
        raise ValueError("materialId and unitId must be ids")
    if unit_id and unit_id not in [u["id"] for u in course_config.course_for(req.class_id, req.db)["units"]]:
        raise ValueError("Select an existing chapter")
    with dbmod.write_tx(req.db):
        kiwi_bridge.map_material(req.db, req.class_id, material_id, unit_id, changed_by=audit.actor_label(req.identity))
        req.audit("material_map", "material", str(material_id), None, {"unitId": unit_id})
    return kiwi_bridge.status(req.db, req.class_id)
