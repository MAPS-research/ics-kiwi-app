"""Course package export/import and course templates (owned by PEOPLE; spec §14.7).

A package carries the course design only — chapters, assignments (as drafts on import), AI tutor rules, group names
and course files — never student data. Import is preview → apply: chapters are added when their id is new, assignments
are created as drafts with new ids and shifted dates, policy versions are appended with ``created_by='import'``,
groups are created by name; nothing is overwritten or published. Zip input is size- and name-checked first.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import re
import sqlite3
import tempfile
import uuid
import zipfile
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from server import ai_policy, audit, course_config, readers
from server import assignments as assignments_mod
from server import db as dbmod
from server.router import ApiError, Request, Response

FORMAT = "css-lab-course-package"
FORMAT_VERSION = 1
APP_VERSION = "0.6.0"
TEMPLATE_DIR = Path(__file__).resolve().parent / "course_templates"
MAX_ENTRIES = 200
MAX_ENTRY_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 60 * 1024 * 1024
MAX_RATIO = 100
NAME_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def _bad(message: str) -> ApiError:
    return ApiError(400, "invalid_request", message)


def _loads(value: object, default: Any) -> Any:
    if not isinstance(value, str) or not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


# -- dates -----------------------------------------------------------------------------------------
def _term_start_utc(term_start: str | None, tz_name: str) -> datetime | None:
    if not term_start:
        return None
    try:
        day = datetime.strptime(term_start, "%Y-%m-%d").date()
        return datetime.combine(day, time(0, 0), ZoneInfo(tz_name)).astimezone(timezone.utc)
    except (ValueError, KeyError):
        return None


def _offset_days(value: str | None, base: datetime | None) -> float | None:
    moment = dbmod.parse_iso(value) if value else None
    if moment is None or base is None:
        return None
    return round((moment - base).total_seconds() / 86400, 6)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat(timespec="seconds")


def _day(value: object) -> date | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def shift_day(value: object, *, source_start: object, target_start: object, weeks: int) -> object:
    """A chapter ``startsOn`` (YYYY-MM-DD) moved to the target term (decision D4).

    With both term starts known the day keeps its offset from the term start; otherwise only ``weeks`` applies.
    Values that are not dates are returned unchanged so course validation reports them.
    """
    day = _day(value)
    if day is None:
        return value
    source, target = _day(source_start), _day(target_start)
    if source is not None and target is not None:
        day = target + (day - source)
    return (day + timedelta(weeks=weeks)).isoformat()


def _notes(unit: dict) -> list[str]:
    notes = unit.get("notes")
    return [n[:500] for n in notes if isinstance(n, str) and n.strip()][:12] if isinstance(notes, list) else []


# -- export ----------------------------------------------------------------------------------------
def build_package(db: sqlite3.Connection, class_id: str) -> dict[str, bytes]:
    course = course_config.course_for(class_id, db)
    settings = readers.settings(db, class_id)
    schedule = settings["schedule"]
    base = _term_start_utc(schedule.get("termStart"), schedule.get("timezone") or course_config.DEFAULT_TIMEZONE)
    groups = {r["id"]: (r["kind"], r["name"]) for r in db.execute("SELECT id, kind, name FROM course_groups WHERE class_id=?",
                                                                  (class_id,))}
    entries: dict[str, bytes] = {}
    manifest = {"format": FORMAT, "formatVersion": FORMAT_VERSION, "appVersion": APP_VERSION, "exportedAt": dbmod.now(),
                "termStart": schedule.get("termStart"), "timezone": schedule.get("timezone")}
    course_json = {"title": course["title"], "description": course["description"], "currentUnitId": course["currentUnitId"],
                   "freePracticeScope": course["freePracticeScope"],
                   "units": [{k: u[k] for k in ("id", "title", "goal", "access", "week", "startsOn", "runtime",
                                                *course_config.STAFF_ONLY_UNIT_FIELDS) if k in u}
                             for u in course["units"]],
                   "schedule": schedule}
    assignments = []
    for row in db.execute("SELECT * FROM assignments WHERE class_id=? AND deleted_at IS NULL ORDER BY created_at, id", (class_id,)):
        rec = readers.record_from_row(row)
        audience: dict = {"type": "all"}
        if rec.audience.get("type") == "groups":
            audience = {"type": "groups", "groupNames": [list(groups[g]) for g in rec.audience.get("groupIds") or [] if g in groups]}
        item = {"key": rec.id, "title": rec.title, "kind": rec.kind, "unitId": rec.unit_id, "instructions": row["instructions"],
                "questions": _loads(row["questions_json"], []), "toolPolicy": rec.tool_policy.as_dict(),
                "latePolicy": rec.late_policy, "timeLimit": rec.time_limit, "maxAttempts": rec.max_attempts,
                "gradesVisibility": rec.grades_visibility, "solutionsVisibility": rec.solutions_visibility, "audience": audience,
                "dueAt": rec.due_at, "openAt": rec.open_at, "closeAt": rec.close_at}
        for key, value in (("dueOffsetDays", rec.due_at), ("openOffsetDays", rec.open_at), ("closeOffsetDays", rec.close_at)):
            offset = _offset_days(value, base)
            if offset is not None:
                item[key] = offset
        assignments.append(item)
    rules = []
    for row in db.execute(
        """SELECT p.* FROM policy_versions p JOIN (SELECT scope, unit_id, group_id, MAX(version) AS v FROM policy_versions
        WHERE class_id=? GROUP BY scope, unit_id, group_id) h ON h.scope=p.scope AND h.unit_id=p.unit_id AND h.group_id=p.group_id
        AND h.v=p.version WHERE p.class_id=? ORDER BY p.scope, p.unit_id, p.group_id""", (class_id, class_id)):
        rules.append({"scope": row["scope"], "unitId": row["unit_id"],
                      "group": list(groups[row["group_id"]]) if row["group_id"] in groups else None,
                      "config": _loads(row["config_json"], {}), "note": row["note"]})
    group_list = [{"name": r["name"], "kind": r["kind"], "description": r["description"]} for r in db.execute(
        "SELECT * FROM course_groups WHERE class_id=? AND archived_at IS NULL ORDER BY kind, name", (class_id,))]
    files = []
    for row in db.execute("SELECT * FROM course_files WHERE class_id=? AND deleted_at IS NULL ORDER BY created_at, id", (class_id,)):
        path = f"files/{row['id']}-{_SAFE.sub('_', row['name'])}"[:180]
        entries[path] = bytes(row["data"])
        files.append({"id": row["id"], "path": path, "scope": row["scope"], "assignmentKey": row["assignment_id"],
                      "questionId": row["question_id"], "unitId": row["unit_id"], "name": row["name"], "mime": row["mime"],
                      "size": row["size"], "sha256": row["sha256"], "mountInR": bool(row["mount_in_r"]),
                      "aiReference": bool(row["ai_reference"])})
    entries["manifest.json"] = json.dumps(manifest, indent=2, ensure_ascii=False).encode()
    entries["course.json"] = json.dumps(course_json, indent=2, ensure_ascii=False).encode()
    entries["assignments.json"] = json.dumps(assignments, indent=2, ensure_ascii=False).encode()
    entries["ai_rules.json"] = json.dumps(rules, indent=2, ensure_ascii=False).encode()
    entries["groups.json"] = json.dumps(group_list, indent=2, ensure_ascii=False).encode()
    entries["files.json"] = json.dumps(files, indent=2, ensure_ascii=False).encode()
    return entries


def export_response(req: Request) -> Response:
    from server.exports import file_response

    entries = build_package(req.db, req.class_id)
    spool = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    with zipfile.ZipFile(spool, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in ("manifest.json", "course.json", "assignments.json", "ai_rules.json", "groups.json", "files.json"):
            archive.writestr(name, entries.pop(name))
        for name, data in entries.items():
            archive.writestr(name, data)
    return file_response(spool, f"course-package-{req.class_id}-{dbmod.utcnow():%Y%m%d}.zip", "application/zip", 0)


# -- templates -------------------------------------------------------------------------------------
def _template_files() -> dict[str, Path]:
    return {p.stem: p for p in sorted(TEMPLATE_DIR.glob("*.json"))} if TEMPLATE_DIR.exists() else {}


def load_template(key: str) -> dict:
    path = _template_files().get(key)
    if path is None or not re.fullmatch(r"[a-z0-9-]{1,60}", key):
        raise _bad("Unknown course template")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise _bad("Course template is not valid")
    return data


def list_templates() -> list[dict]:
    out = []
    for key in _template_files():
        data = load_template(key)
        out.append({"key": key, "title": data.get("title", key), "description": data.get("description", ""),
                    "chapters": len((data.get("course") or {}).get("units") or [])})
    return out


# -- zip input -------------------------------------------------------------------------------------
def read_zip(raw: bytes) -> dict:
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise _bad("The course package is not a valid zip file") from exc
    infos = archive.infolist()
    if len(infos) > MAX_ENTRIES:
        raise _bad(f"A course package may hold at most {MAX_ENTRIES} files")
    total = 0
    for info in infos:
        name = info.filename
        if not NAME_RE.fullmatch(name) or ".." in name.split("/") or ".." in name or name.startswith("/"):
            raise _bad("The course package contains a file name that is not allowed")
        if info.file_size > MAX_ENTRY_BYTES:
            raise _bad("A file in the course package is larger than 5 MB")
        total += info.file_size
        if total > MAX_TOTAL_BYTES:
            raise _bad("The course package is larger than 60 MB uncompressed")
        if info.file_size and info.file_size / max(info.compress_size, 1) > MAX_RATIO:
            raise _bad("The course package is compressed suspiciously well; refusing to unpack it")
    names = {i.filename for i in infos}

    def read_json(name: str, default: Any) -> Any:
        if name not in names:
            return default
        try:
            return json.loads(archive.read(name).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _bad(f"{name} in the course package is not valid JSON") from exc

    package = {"manifest": read_json("manifest.json", None), "course": read_json("course.json", {}),
               "assignments": read_json("assignments.json", []), "ai_rules": read_json("ai_rules.json", []),
               "groups": read_json("groups.json", []), "files": read_json("files.json", [])}
    data: dict[str, bytes] = {}
    for item in package["files"] if isinstance(package["files"], list) else []:
        path = item.get("path") if isinstance(item, dict) else None
        if isinstance(path, str) and path in names:
            data[path] = archive.read(path)
    package["file_data"] = data
    return package


def _check_manifest(package: dict) -> None:
    manifest = package.get("manifest")
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT or manifest.get("formatVersion") != FORMAT_VERSION:
        raise _bad("This file is not a CSS Lab course package (format css-lab-course-package, version 1)")
    for key, kind in (("course", dict), ("assignments", list), ("ai_rules", list), ("groups", list), ("files", list)):
        if not isinstance(package.get(key), kind):
            raise _bad(f"{key} in the course package has the wrong shape")


# -- import ----------------------------------------------------------------------------------------
def _parse_body(body: dict) -> tuple[dict, str, int, bool, str]:
    unknown = set(body) - {"zipBase64", "templateKey", "mode", "shiftWeeks", "archiveUnreferencedDefaults"}
    if unknown:
        raise _bad(f"Unknown field: {sorted(unknown)[0]}")
    mode = body.get("mode")
    if mode not in ("preview", "apply"):
        raise _bad("mode must be preview or apply")
    shift = body.get("shiftWeeks", 0)
    if type(shift) is not int or not -52 <= shift <= 52:
        raise _bad("shiftWeeks must be an integer from -52 to 52")
    archive_defaults = body.get("archiveUnreferencedDefaults", False)
    if not isinstance(archive_defaults, bool):
        raise _bad("archiveUnreferencedDefaults must be true or false")
    has_zip, has_template = "zipBase64" in body, "templateKey" in body
    if has_zip == has_template:
        raise _bad("Send exactly one of zipBase64 or templateKey")
    if has_zip:
        value = body["zipBase64"]
        if not isinstance(value, str) or not value:
            raise _bad("zipBase64 must be a base64-encoded zip file")
        try:
            raw = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise _bad("zipBase64 is not valid base64") from exc
        package, source = read_zip(raw), "package"
    else:
        key = body["templateKey"]
        if not isinstance(key, str):
            raise _bad("Unknown course template")
        template = load_template(key)
        package = {"manifest": template.get("manifest"), "course": template.get("course") or {},
                   "assignments": template.get("assignments") or [], "ai_rules": template.get("ai_rules") or [],
                   "groups": template.get("groups") or [], "files": [], "file_data": {}}
        source = f"template:{key}"
    _check_manifest(package)
    return package, mode, shift, archive_defaults, source


def _shift(value: object, offset: object, *, target_base: datetime | None, weeks: int) -> str | None:
    if isinstance(offset, (int, float)) and not isinstance(offset, bool) and target_base is not None:
        moment = target_base + timedelta(days=float(offset))
    else:
        moment = dbmod.parse_iso(value) if isinstance(value, str) and value else None
        if moment is None:
            return None
    return _iso(moment + timedelta(weeks=weeks))


def _policy_config(config: object) -> dict:
    if not isinstance(config, dict):
        raise ValueError("AI rule config must be an object")
    if config.get("inherit") is True:
        return {"inherit": True}
    known = set(ai_policy.platform_default())
    clean = {k: v for k, v in config.items() if k in known}
    if len(json.dumps(clean)) > 50000:
        raise ValueError("AI rule config is too large")
    return clean


def _file_problem(entry: dict, data: bytes) -> str | None:
    """Why an imported course file is refused, or None: the same checks as an upload (SECURITY-07)."""
    scope = entry.get("scope") if entry.get("scope") in ("assignment", "chapter") else "chapter"
    try:
        name = assignments_mod.clean_file_name(entry.get("name"))
        if not data or len(data) > assignments_mod.MAX_FILE_BYTES:
            raise ValueError("files must be smaller than 3 MB")
        ai_reference = entry.get("aiReference", False)
        if not isinstance(ai_reference, bool):
            raise ValueError("aiReference must be true or false")
        assignments_mod._check_ai_reference(scope, name, ai_reference)
    except ValueError as exc:
        return str(exc)
    return None


def _shift_late(late: object, original_due: object, shifted_due: str | None) -> object:
    """Move an ``accept_until`` end by the same amount as the due date (it is stored as an absolute time)."""
    if not isinstance(late, dict) or not isinstance(late.get("untilAt"), str):
        return late
    before = dbmod.parse_iso(original_due) if isinstance(original_due, str) and original_due else None
    after = dbmod.parse_iso(shifted_due) if shifted_due else None
    until = dbmod.parse_iso(late["untilAt"])
    if before is None or after is None or until is None:
        return late
    return {**late, "untilAt": _iso(until + (after - before))}


def _validated_assignment(db: sqlite3.Connection, class_id: str, item: dict, title: str, due: str | None, opens: str | None,
                          closes: str | None, unit_ids: set[str], settings: dict) -> dict:
    """``assignments.validate_input`` for one package assignment (dates already shifted). Raises ValueError."""
    from server.router import valid_id

    grades = item.get("gradesVisibility")
    candidate = {
        "kind": item.get("kind"), "title": title, "unitId": item.get("unitId"),
        "instructions": str(item.get("instructions") or "")[:12000], "dueAt": due, "openAt": opens, "closeAt": closes,
        "latePolicy": _shift_late(item.get("latePolicy"), item.get("dueAt"), due),
        "maxAttempts": item.get("maxAttempts"), "timeLimit": item.get("timeLimit"),
        "gradesVisibility": grades if grades is not None else settings["grading"]["defaultGradesVisibility"],
        "solutionsVisibility": item.get("solutionsVisibility"), "toolPolicy": item.get("toolPolicy"),
        "questions": item.get("questions"),
    }
    return assignments_mod.validate_input(db, class_id, candidate, valid_id, unit_ids=unit_ids)


def import_package(req: Request) -> dict:
    db, class_id = req.db, req.class_id
    package, mode, weeks, archive_defaults, source = _parse_body(req.body())
    warnings: list[str] = []
    current = course_config.course_for(class_id, db)
    current_ids = [u["id"] for u in current["units"]]
    referenced = course_config.referenced_units(db, class_id)
    settings = readers.settings(db, class_id)
    source_start = (package.get("manifest") or {}).get("termStart")
    target_start = settings["schedule"].get("termStart")
    pkg_units = [dict(u) for u in (package["course"].get("units") or []) if isinstance(u, dict)]
    for unit in pkg_units:
        if unit.get("startsOn") is not None:
            unit["startsOn"] = shift_day(unit["startsOn"], source_start=source_start, target_start=target_start, weeks=weeks)
    pkg_ids = [u.get("id") for u in pkg_units]
    chapters: list[dict] = []
    added_units: list[dict] = []
    for unit in pkg_units:
        uid = unit.get("id")
        if not isinstance(uid, str):
            raise _bad("A chapter in the package has no id")
        if uid in current_ids:
            existing = next(u for u in current["units"] if u["id"] == uid)
            if existing["title"] != unit.get("title"):
                warnings.append(f"Chapter {uid} exists here as “{existing['title']}”; kept as is.")
            chapters.append({"id": uid, "title": existing["title"], "action": "skip"})
        else:
            added_units.append(unit)
            entry = {"id": uid, "title": unit.get("title", uid), "action": "add",
                     "packages": list(((unit.get("runtime") or {}).get("packages")) or []),
                     "startsOn": unit.get("startsOn") if isinstance(unit.get("startsOn"), str) else None,
                     "week": unit.get("week") if type(unit.get("week")) is int else None}   # S-m11
            if _notes(unit):
                entry["notes"] = _notes(unit)   # template notes: R sessions, inferred pairings, run-locally packages (D4)
            chapters.append(entry)
    archived: list[str] = []
    if archive_defaults:
        for unit in current["units"]:
            if unit["id"] not in pkg_ids and unit["id"] not in referenced and unit["access"] != "hidden":
                archived.append(unit["id"])
                chapters.append({"id": unit["id"], "title": unit["title"], "action": "archive"})
    existing_units = []
    for unit in current["units"]:
        existing_units.append({**{k: unit[k] for k in ("id", "title", "goal", "access", "week", "startsOn", "runtime",
                                                       *course_config.STAFF_ONLY_UNIT_FIELDS) if k in unit},
                               "access": "hidden" if unit["id"] in archived else unit["access"]})
    # S-M05: template notes (R sessions, inferred pairings, run-locally packages, milestones) and the template metadata
    # (rSessions, pairing, runLocally, liveApi) are kept on the chapter
    new_units = [{**{k: u.get(k) for k in ("id", "title", "goal", "access", "week", "startsOn", "runtime",
                                           *course_config.TEMPLATE_UNIT_FIELDS) if k in u},
                  "notes": "\n".join(_notes(u)) if isinstance(u.get("notes"), list) else (u.get("notes") or "")}
                 for u in added_units]
    if source.startswith("template:") and new_units:
        # RV6-m10: a template is a course outline, so its chapters come first and keep their numbers (Chapter 01 is the
        # template's first week); the course's own chapters follow and nothing is deleted.
        units = new_units + existing_units
        if existing_units:
            first, last = len(new_units) + 1, len(new_units) + len(existing_units)
            hidden = sum(1 for u in existing_units if u["access"] == "hidden")
            span = f"Chapter {first:02d}" if first == last else f"Chapters {first:02d}–{last:02d}"
            note = f" ({hidden} of them archived, hidden from students)" if hidden else " (archive the ones you no longer use)"
            warnings.append(f"The template's chapters become Chapters 01–{len(new_units):02d}; your existing "
                            f"{len(existing_units)} {'chapter follows' if len(existing_units) == 1 else 'chapters follow'} "
                            f"as {span}{note}.")
    else:
        units = existing_units + new_units
    current_unit = current["currentUnitId"]
    if current_unit in archived and added_units:
        current_unit = added_units[0]["id"]
        warnings.append(f"This week's chapter moves to {added_units[0].get('title', current_unit)} because its chapter is archived.")
    course_input = {"title": current["title"], "description": current["description"], "currentUnitId": current_unit,
                    "freePracticeScope": current["freePracticeScope"], "units": units}
    try:
        new_config = course_config.validate_course(course_input)
    except ValueError as exc:
        raise _bad(f"The package chapters cannot be added: {exc}") from exc
    final_units = {u["id"] for u in new_config["units"]}
    # groups
    existing_groups = {(r["kind"], r["name"]): r["id"] for r in db.execute(
        "SELECT id, kind, name FROM course_groups WHERE class_id=? AND archived_at IS NULL", (class_id,))}
    wanted_groups: dict[tuple[str, str], str] = {}
    for group in package["groups"]:
        if isinstance(group, dict) and group.get("kind") in ("section", "condition", "cohort") and isinstance(group.get("name"), str):
            wanted_groups[(group["kind"], group["name"].strip()[:80])] = str(group.get("description") or "")[:500]
    target_base = _term_start_utc(settings["schedule"].get("termStart"), settings["schedule"].get("timezone") or "Asia/Shanghai")
    assignments: list[dict] = []
    plans: list[dict] = []
    for item in package["assignments"]:
        if not isinstance(item, dict) or not isinstance(item.get("title"), str) or item.get("kind") not in ("homework", "practice"):
            warnings.append("Skipped an assignment without a title or type.")
            continue
        title = item["title"].strip()[:120] or "Imported assignment"
        if item.get("unitId") not in final_units:
            warnings.append(f"Skipped “{title}”: its chapter {item.get('unitId')} is not in this course.")
            assignments.append({"title": title, "action": "skip", "dueAt": None})
            continue
        questions = item.get("questions")
        if not isinstance(questions, list) or not all(isinstance(q, dict) for q in questions) or len(questions) > 100:
            warnings.append(f"Skipped “{title}”: its questions are not valid.")
            assignments.append({"title": title, "action": "skip", "dueAt": None})
            continue
        due = _shift(item.get("dueAt"), item.get("dueOffsetDays"), target_base=target_base, weeks=weeks)
        opens = _shift(item.get("openAt"), item.get("openOffsetDays"), target_base=target_base, weeks=weeks)
        closes = _shift(item.get("closeAt"), item.get("closeOffsetDays"), target_base=target_base, weeks=weeks)
        try:
            # WHY (review 2, CORRECTNESS-02): an imported assignment passes the same validation as one saved in the
            # editor (questions, late policy, attempts, time limit, Student help), so a package cannot store rows that
            # later fail for students.
            clean = _validated_assignment(db, class_id, item, title, due, opens, closes, final_units, settings)
        except ValueError as exc:
            warnings.append(f"Skipped “{title}”: {exc}")
            assignments.append({"title": title, "action": "skip", "dueAt": None})
            continue
        audience = item.get("audience") if isinstance(item.get("audience"), dict) else {"type": "all"}
        names = [tuple(n) for n in audience.get("groupNames") or [] if isinstance(n, list) and len(n) == 2] \
            if audience.get("type") == "groups" else []
        for kind, name in names:
            if (kind, name) not in existing_groups:
                wanted_groups.setdefault((kind, name), "")
        plans.append({"item": item, "title": title, "due": due, "groupNames": names, "clean": clean})
        assignments.append({"title": title, "action": "add", "dueAt": due})
    policies: list[dict] = []
    policy_plans: list[dict] = []
    for rule in package["ai_rules"]:
        if not isinstance(rule, dict) or rule.get("scope") not in ("course", "unit"):
            warnings.append("Skipped an AI rule with an unknown scope.")
            continue
        unit_id = rule.get("unitId") or "" if rule["scope"] == "unit" else ""
        group = tuple(rule["group"]) if isinstance(rule.get("group"), list) and len(rule["group"]) == 2 else None
        label = ("Course default" if rule["scope"] == "course" else f"Chapter {unit_id}") + (f" · {group[1]}" if group else "")
        if rule["scope"] == "unit" and unit_id not in final_units:
            policies.append({"scope": label, "action": "skip"})
            warnings.append(f"Skipped AI rules for {unit_id}: the chapter is not in this course.")
            continue
        try:
            config = _policy_config(rule.get("config"))
        except ValueError as exc:
            policies.append({"scope": label, "action": "skip"})
            warnings.append(f"Skipped AI rules for {label}: {exc}")
            continue
        if group and group not in existing_groups:
            wanted_groups.setdefault(group, "")
        group_id = existing_groups.get(group) if group else ""
        latest = None
        if group_id is not None:
            latest = db.execute("""SELECT config_hash FROM policy_versions WHERE class_id=? AND scope=? AND unit_id=? AND group_id=?
                                ORDER BY version DESC LIMIT 1""", (class_id, rule["scope"], unit_id, group_id or "")).fetchone()
        digest = ai_policy.config_hash(config)
        if latest is not None and latest["config_hash"] == digest:
            policies.append({"scope": label, "action": "skip"})
            continue
        policies.append({"scope": label, "action": "add"})
        policy_plans.append({"scope": rule["scope"], "unit_id": unit_id, "group": group, "config": config, "hash": digest,
                             "note": str(rule.get("note") or "")[:400]})
    files: list[dict] = []
    for entry in package["files"]:
        if not isinstance(entry, dict) or entry.get("path") not in package["file_data"]:
            continue
        problem = _file_problem(entry, package["file_data"][entry["path"]])
        if problem:
            warnings.append(f"Skipped file {str(entry.get('name') or entry.get('path'))[:120]}: {problem}")
            continue
        files.append(entry)
    file_count = len(files)
    result = {"mode": mode, "chapters": chapters, "assignments": assignments, "policies": policies, "files": file_count,
              "warnings": warnings, "source": source}
    if mode == "preview":
        return result
    actor = audit.actor_label(req.identity)
    stamp = dbmod.now()
    with dbmod.write_tx(db):
        db.execute("""INSERT INTO courses (class_id, config_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(class_id)
                   DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at""",
                   (class_id, dbmod.json_dumps(new_config), stamp))
        db.execute("""INSERT INTO course_settings (class_id, settings_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
                   ON CONFLICT(class_id) DO NOTHING""",
                   (class_id, dbmod.json_dumps(course_config.default_settings()), stamp, actor[:200]))
        group_ids = dict(existing_groups)
        for (kind, name), description in wanted_groups.items():
            if (kind, name) in group_ids:
                continue
            group_id = f"grp-{uuid.uuid4().hex[:12]}"
            db.execute("INSERT INTO course_groups (id, class_id, name, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                       (group_id, class_id, name, kind, description, stamp))
            group_ids[(kind, name)] = group_id
        new_ids: dict[str, str] = {}
        for plan in plans:
            item = plan["item"]
            work_id = f"work-{uuid.uuid4().hex[:16]}"
            new_ids[str(item.get("key") or "")] = work_id
            audience = {"type": "groups", "groupIds": [group_ids[g] for g in plan["groupNames"] if g in group_ids]} \
                if plan["groupNames"] else {"type": "all"}
            clean = plan["clean"]
            db.execute(
                """INSERT INTO assignments (id, class_id, kind, title, unit_id, instructions, due_at, status, questions_json,
                created_at, updated_at, open_at, close_at, late_policy_json, max_attempts, grades_visibility, solutions_visibility,
                time_limit_json, tool_policy_json, audience_json, created_by, updated_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (work_id, class_id, clean["kind"], clean["title"], clean["unit_id"], clean["instructions"],
                 clean["due_at"], json.dumps(clean["questions"], ensure_ascii=False), stamp, stamp, clean["open_at"],
                 clean["close_at"], dbmod.json_dumps(clean["late_policy"]), clean["max_attempts"], clean["grades_visibility"],
                 clean["solutions_visibility"], dbmod.json_dumps(clean["time_limit"]) if clean["time_limit"] else None,
                 dbmod.json_dumps(clean["tool_policy"]), dbmod.json_dumps(audience), actor[:200], actor[:200]))
        for plan in policy_plans:
            group_id = group_ids.get(plan["group"], "") if plan["group"] else ""
            head = db.execute("""SELECT COALESCE(MAX(version), 0) FROM policy_versions WHERE class_id=? AND scope=? AND unit_id=?
                              AND group_id=?""", (class_id, plan["scope"], plan["unit_id"], group_id)).fetchone()[0]
            db.execute(
                """INSERT INTO policy_versions (class_id, scope, unit_id, group_id, version, config_json, config_hash, note,
                created_by, created_by_role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)""",
                (class_id, plan["scope"], plan["unit_id"], group_id, head + 1, dbmod.json_dumps(plan["config"]), plan["hash"],
                 plan["note"] or f"Imported from {source}", req.identity.actor_role, stamp))
        for item in files:
            data = package["file_data"][item["path"]]
            scope = item.get("scope") if item.get("scope") in ("assignment", "chapter") else "chapter"
            assignment_id = new_ids.get(str(item.get("assignmentKey") or ""), "") if scope == "assignment" else ""
            unit_id = item.get("unitId") if isinstance(item.get("unitId"), str) else ""
            if (scope == "assignment" and not assignment_id) or (scope == "chapter" and unit_id not in final_units):
                warnings.append(f"Skipped file {item.get('name')}: its assignment or chapter was not imported.")
                result["files"] -= 1
                continue
            db.execute(
                """INSERT INTO course_files (id, class_id, scope, assignment_id, question_id, unit_id, name, mime, size, sha256, data,
                mount_in_r, ai_reference, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (f"file-{uuid.uuid4().hex[:16]}", class_id, scope, assignment_id, str(item.get("questionId") or "")[:120],
                 unit_id if scope == "chapter" else "", assignments_mod.clean_file_name(item.get("name")),
                 assignments_mod.clean_mime(item.get("mime")), len(data), hashlib.sha256(data).hexdigest(), data,
                 int(item.get("mountInR", True) is not False), int(item.get("aiReference") is True), actor[:200], stamp))
    return result
