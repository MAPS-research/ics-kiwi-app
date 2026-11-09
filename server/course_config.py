"""Course configuration v2, chapter access and time ranges (spec §4.5.4–4.5.5, §12.4, §13.0; FOUNDATION, frozen)."""

from __future__ import annotations

import json
import math
import re
import sqlite3
from copy import deepcopy
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from server import db as dbmod
from server.contracts import TimeRange
from server.webr_packages import WEBR_PACKAGE_ALLOWLIST

_ID = re.compile(r"^[A-Za-z0-9_.:@-]{1,100}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
UNIT_ACCESS = ("default", "open", "review", "hidden")
FREE_PRACTICE_SCOPES = ("current_and_earlier", "current_only", "all")
TIME_PRESETS = ("this_class", "since_last_class", "this_week", "last_7_days", "whole_term", "custom")
DEFAULT_TIMEZONE = "Asia/Shanghai"

DEFAULT_COURSE = {
    "title": "Introduction to Computational Social Science",
    "description": "CSS methods and R practice: data collection, ethics, wrangling, visualization, text analysis, and social networks.",
    "currentUnitId": "data-wrangling",
    "units": [
        {"id": "css-intro", "title": "01 · CSS and digital data",
         "goal": "Computational social science questions, digital data sources, and research ethics", "status": "completed"},
        {"id": "r-basics", "title": "02 · R basics and data import",
         "goal": "Vectors, descriptive statistics, data types, and CSV import", "status": "completed"},
        {"id": "data-wrangling", "title": "03 · Wrangling, joins, and visualization",
         "goal": "Filtering, sorting, grouping, joins, and ggplot visualization", "status": "current"},
        {"id": "text-analysis", "title": "04 · Text analysis",
         "goal": "Corpora, tokenization, stop words, word frequencies, topic models, and embeddings", "status": "upcoming"},
        {"id": "network-analysis", "title": "05 · Social network analysis",
         "goal": "Node and edge tables, directed networks, in-degree, reciprocity, and visualization", "status": "upcoming"},
    ],
}

# v0.5.1 stored Chinese defaults on some rows; read-time translation keeps the English course.
_TRANSLATIONS = {
    "CSS 方法与 R 实践：数据收集和伦理、整理与可视化、文本分析、社会网络。": "CSS methods and R practice: data collection, ethics, wrangling, visualization, text analysis, and social networks.",
    "01 · CSS 与数字数据": "01 · CSS and digital data",
    "计算社会科学问题、数字数据来源和研究伦理": "Computational social science questions, digital data sources, and research ethics",
    "02 · R 基础与数据导入": "02 · R basics and data import",
    "向量、描述统计、数据类型、CSV 导入": "Vectors, descriptive statistics, data types, and CSV import",
    "03 · 整理、连接与可视化": "03 · Wrangling, joins, and visualization",
    "筛选、排序、分组、连接、ggplot 可视化": "Filtering, sorting, grouping, joins, and ggplot visualization",
    "04 · 文本分析": "04 · Text analysis",
    "语料、分词、停用词、词频、主题模型与词向量": "Corpora, tokenization, stop words, word frequencies, topic models, and embeddings",
    "05 · 社会网络分析": "05 · Social network analysis",
    "节点边表、有向网络、入度、互惠关系与可视化": "Node and edge tables, directed networks, in-degree, reciprocity, and visualization",
}

ATTENTION_RULE_DEFAULTS = [
    {"id": "no_activity", "enabled": True, "params": {"days": 7}},
    {"id": "missing_work", "enabled": True, "params": {"count": 1}},
    {"id": "stuck_question", "enabled": True, "params": {"errors": 5}},
    {"id": "repeated_ai_help", "enabled": True, "params": {"questions": 6}},
    {"id": "low_accuracy", "enabled": True, "params": {"pct": 50, "minChecked": 6}},
    {"id": "late_pattern", "enabled": False, "params": {"count": 2, "days": 21}},
]
# The nine v0.5.1 keyword rules (server/analytics.py question_theme) as editable keyword lists.
TOPIC_RULE_DEFAULTS = [
    {"label": "Missing values", "keywords": ["na", "missing", "na.rm", "is.na"]},
    {"label": "Indexing", "keywords": ["index", "subscript", "bracket", "one-based", "one based"]},
    {"label": "Joins and keys", "keywords": ["join", "merge", "tailnum", "join key", "primary key", "foreign key"]},
    {"label": "Filtering and conditions", "keywords": ["filter", "logical", "condition", "subset"]},
    {"label": "Means and grouped summaries", "keywords": ["mean", "average", "aggregate", "group", "sum("]},
    {"label": "Data types and import", "keywords": ["import", "csv", "read.", "numeric", "character", "data type"]},
    # RV6-m09: "tokens"/"tokeniz…" (tidytext, quanteda), not a bare "token" ("Do not start with any token" is not about text)
    {"label": "Text preprocessing", "keywords": ["tokens", "tokeniz", "unnest_tokens", "stop word", "stopword", "lowercase",
                                                 "corpus", "lyrics", "stemming", "lemmatiz"]},
    {"label": "Networks", "keywords": ["edge", "node", "degree", "reciproc", "network"]},
    {"label": "R errors and debugging", "keywords": ["error", "not found", "unexpected", "debug"]},
]


def default_settings() -> dict:
    """``course_settings.settings_json`` defaults (§4.5.4)."""
    return {
        "schedule": {"timezone": DEFAULT_TIMEZONE, "meetings": [], "termStart": None},
        "privacy": {"showEmails": True, "defaultNameMode": "names", "researchPurpose": "", "irbProtocol": "",
                    "retentionDays": None, "viewerCanExportResearch": False},
        "grading": {"defaultGradesVisibility": "on_release", "taCanRelease": False},
        "ai": {"perStudentPerMinute": 15, "classPerMinute": 120},
        "attentionRules": {"rules": deepcopy(ATTENTION_RULE_DEFAULTS)},
        "topicRules": deepcopy(TOPIC_RULE_DEFAULTS),
    }


# RV6-m09: keyword lists of the first v0.6.0 defaults. A course that still has them unchanged (saved when the course was
# created) follows the corrected defaults; rules a teacher edited are kept as they are.
_PREVIOUS_TOPIC_KEYWORDS = {
    "Joins and keys": ["join", "merge", "tailnum", "key"],
    "Text preprocessing": ["token", "stop word", "stopword", "lowercase", "corpus", "lyrics"],
}


def _upgrade_topic_rules(rules: object) -> object:
    if not isinstance(rules, list):
        return rules
    current = {r["label"]: r for r in TOPIC_RULE_DEFAULTS}
    return [deepcopy(current[r["label"]]) if isinstance(r, dict) and r.get("label") in _PREVIOUS_TOPIC_KEYWORDS
            and r.get("keywords") == _PREVIOUS_TOPIC_KEYWORDS[r["label"]] else r for r in rules]


def merge_settings(stored: object) -> dict:
    """Deep-merge stored settings over the defaults (dicts merge, everything else replaces)."""

    def merge(base: dict, extra: dict) -> dict:
        out = dict(base)
        for key, value in extra.items():
            if isinstance(value, dict) and isinstance(out.get(key), dict):
                out[key] = merge(out[key], value)
            else:
                out[key] = deepcopy(value)
        return out

    merged = merge(default_settings(), stored if isinstance(stored, dict) else {})
    merged["topicRules"] = _upgrade_topic_rules(merged.get("topicRules"))
    return merged


def _english(value: object) -> object:
    if isinstance(value, str):
        return _TRANSLATIONS.get(value, value)
    if isinstance(value, list):
        return [_english(v) for v in value]
    if isinstance(value, dict):
        return {k: _english(v) for k, v in value.items()}
    return value


def default_runtime() -> dict:
    return {"packages": [], "datasetFileIds": [], "timeoutSeconds": 12, "errorHints": []}


def effective_access(unit: dict, units: list[dict], current_unit_id: str, scope: str) -> str:
    """§12.4: hidden/open/review override; default follows the free-practice scope."""
    access = unit.get("access") or "default"
    if access == "hidden":
        return "hidden"
    if access == "open":
        return "open"
    if access == "review":
        return "review"
    ids = [u.get("id") for u in units]
    try:
        idx = ids.index(unit.get("id"))
    except ValueError:
        return "locked"
    cur = ids.index(current_unit_id) if current_unit_id in ids else 0
    if scope == "all":
        return "open"
    if scope == "current_only":
        return "open" if idx == cur else "locked"
    return "open" if idx <= cur else "locked"


def _with_defaults(config: dict) -> dict:
    """Apply v2 defaults and derived fields (status, effectiveAccess) to a stored course config."""
    course = deepcopy(config)
    course.setdefault("title", DEFAULT_COURSE["title"])
    course.setdefault("description", "")
    scope = course.get("freePracticeScope")
    course["freePracticeScope"] = scope if scope in FREE_PRACTICE_SCOPES else "current_and_earlier"
    units = [u for u in course.get("units") or [] if isinstance(u, dict)]
    ids = [u.get("id") for u in units]
    current = course.get("currentUnitId")
    if current not in ids and ids:
        current = ids[0]
    course["currentUnitId"] = current or ""
    cur_index = ids.index(current) if current in ids else 0
    clean_units = []
    for index, unit in enumerate(units):
        runtime = unit.get("runtime") if isinstance(unit.get("runtime"), dict) else {}
        merged_runtime = {**default_runtime(), **runtime}
        clean = {
            "id": unit.get("id"),
            "title": unit.get("title", ""),
            "goal": unit.get("goal", ""),
            "status": "completed" if index < cur_index else "current" if index == cur_index else "upcoming",
            "access": unit.get("access") if unit.get("access") in UNIT_ACCESS else "default",
            "week": unit.get("week") if isinstance(unit.get("week"), int) and not isinstance(unit.get("week"), bool) else None,
            "startsOn": unit.get("startsOn") if isinstance(unit.get("startsOn"), str) else None,
            "runtime": merged_runtime,
            "notes": unit.get("notes") if isinstance(unit.get("notes"), str) else "",   # S-M05: teacher-only chapter notes
            **_stored_template_fields(unit),
        }
        clean_units.append(clean)
    for unit in clean_units:
        unit["effectiveAccess"] = effective_access(unit, clean_units, course["currentUnitId"], course["freePracticeScope"])
    course["units"] = clean_units
    return course


def course_for(class_id: str, db: sqlite3.Connection | None = None) -> dict:
    """The v2 ``Course`` for a class (defaults applied, derived status/effectiveAccess, ``linked``, ``updatedAt``)."""
    if db is None:
        with dbmod.connection() as owned:
            return course_for(class_id, owned)
    row = db.execute("SELECT config_json, updated_at FROM courses WHERE class_id = ?", (class_id,)).fetchone()
    config = json.loads(row["config_json"]) if row else deepcopy(DEFAULT_COURSE)
    course = _with_defaults(_english(config))  # type: ignore[arg-type]
    from server import identity

    course["linked"] = identity.class_linked(db, class_id)
    course["updatedAt"] = row["updated_at"] if row else None
    # review 2 (TEACHER-02): every page shows dates in the course time zone, students included
    settings_row = db.execute("SELECT settings_json FROM course_settings WHERE class_id = ?", (class_id,)).fetchone() \
        if dbmod.table_exists(db, "course_settings") else None
    stored = json.loads(settings_row["settings_json"]) if settings_row else {}
    zone = ((stored.get("schedule") or {}) if isinstance(stored, dict) else {}).get("timezone")
    course["timeZone"] = zone if isinstance(zone, str) and zone else DEFAULT_TIMEZONE
    return course


def student_view(course: dict) -> dict:
    """Students never see hidden chapters (§6.1) or the staff-only chapter fields (S-M05: notes, template metadata).

    ``view`` (R-B01) tells the client which view it holds, so a teacher page never saves chapters from this one.
    """
    out = dict(course)
    out["units"] = [{k: v for k, v in u.items() if k not in STAFF_ONLY_UNIT_FIELDS}
                    for u in course["units"] if u.get("effectiveAccess") != "hidden"]
    out["view"] = "student"
    return out


def staff_view(course: dict) -> dict:
    """The full course for staff (hidden chapters, notes, template metadata), marked ``view: staff`` (R-B01)."""
    return {**course, "view": "staff"}


MAX_UNIT_NOTES = 4000
# S-M05: chapter metadata a course template brings (decision D4): its R sessions, how the week ↔ R-session pairing was
# derived, packages that only run locally and packages whose live-API steps cannot run in the browser.
TEMPLATE_UNIT_FIELDS = ("rSessions", "pairing", "runLocally", "liveApi")
# Staff-only chapter fields: student_view drops them; PUT /api/course keeps the stored value when a body omits one.
STAFF_ONLY_UNIT_FIELDS = ("notes", *TEMPLATE_UNIT_FIELDS)
PAIRINGS = ("slides", "inferred", "none")
_PACKAGE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9._]{0,59}$")
_UNIT_KEYS = ("id", "title", "goal", "access", "week", "startsOn", "runtime")


def _r_sessions(value: object) -> list[dict]:
    if not isinstance(value, list) or len(value) > 20:
        raise ValueError("A chapter lists at most 20 R sessions")
    out = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("Each R session needs an id and a title")
        file = item.get("file")
        out.append({"id": _text(item.get("id"), "R session id", 1, 40), "title": _text(item.get("title"), "R session title", 1, 200),
                    "file": _text(file, "R session file", 1, 200) if file not in (None, "") else ""})
    return out


def _package_names(value: object, label: str) -> list[str]:
    if not isinstance(value, list) or len(value) > 40 or any(not isinstance(p, str) or not _PACKAGE_NAME.fullmatch(p) for p in value):
        raise ValueError(f"{label} must be a list of R package names")
    return list(dict.fromkeys(value))


def template_fields(unit: dict) -> dict:
    """Validated template metadata of one chapter: only the keys the chapter has (None means absent). Raises ValueError."""
    out: dict = {}
    if unit.get("rSessions") is not None:
        out["rSessions"] = _r_sessions(unit["rSessions"])
    if unit.get("pairing") is not None:
        if unit["pairing"] not in PAIRINGS:
            raise ValueError("R-session pairing must be slides, inferred or none")
        out["pairing"] = unit["pairing"]
    if unit.get("runLocally") is not None:
        out["runLocally"] = _package_names(unit["runLocally"], "Packages to run locally")
    if unit.get("liveApi") is not None:
        out["liveApi"] = _package_names(unit["liveApi"], "Packages with live-API steps")
    return out


def _stored_template_fields(unit: dict) -> dict:
    """Read side of ``template_fields``: a stored value that no longer validates is left out instead of failing the course."""
    out: dict = {}
    for key in TEMPLATE_UNIT_FIELDS:
        try:
            out.update(template_fields({key: unit.get(key)}))
        except ValueError:
            continue
    return out


def keep_unsent(data: object, stored: dict | None) -> object:
    """R-B01 / S-M05: what a ``PUT /api/course`` body leaves out stays as stored.

    - A chapter's staff-only fields (``STAFF_ONLY_UNIT_FIELDS``) that its unit object does not send keep their stored
      value; sending a key (also ``""``, ``[]`` or ``null``) changes it.
    - A hidden (archived) chapter the body does not list is kept at its place unless ``removeUnitIds`` names it: a client
      that holds the student view never sees hidden chapters, so removing one must be explicit.
    Chapters that are not hidden and missing from the body are removed, as before (the referenced-chapter check still
    applies). Raises ValueError for a malformed ``removeUnitIds``.
    """
    if not isinstance(data, dict):
        return data
    remove = data.get("removeUnitIds", [])
    if not isinstance(remove, list) or any(not isinstance(r, str) for r in remove):
        raise ValueError("removeUnitIds must be a list of chapter ids")
    if not stored or not isinstance(data.get("units"), list):
        return data
    by_id = {u["id"]: u for u in stored["units"]}
    units: list = []
    for unit in data["units"]:
        old = by_id.get(unit.get("id")) if isinstance(unit, dict) and isinstance(unit.get("id"), str) else None
        if old is not None:
            unit = {**{k: old[k] for k in STAFF_ONLY_UNIT_FIELDS if k in old and k not in unit}, **unit}
        units.append(unit)
    sent = {u.get("id") for u in units if isinstance(u, dict)}
    for index, old in enumerate(stored["units"]):
        if old["id"] in sent or old["id"] in remove or old.get("access") != "hidden":
            continue
        # WHY: at its stored position (stored order, so consecutive archived chapters stay together and in order)
        units.insert(min(index, len(units)), {k: old[k] for k in (*_UNIT_KEYS, *STAFF_ONLY_UNIT_FIELDS) if k in old})
        sent.add(old["id"])
    return {**data, "units": units}


def unit_notes(value: object) -> str:
    """S-M05: chapter notes as stored text; a template's list of notes becomes one line per note."""
    if value is None:
        return ""
    if isinstance(value, list):
        if not all(isinstance(v, str) for v in value):
            raise ValueError("Chapter notes must be text")
        value = "\n".join(v.strip() for v in value if v.strip())
    if not isinstance(value, str):
        raise ValueError("Chapter notes must be text")
    if len(value) > MAX_UNIT_NOTES:
        raise ValueError(f"Chapter notes can be at most {MAX_UNIT_NOTES:,} characters")
    return value.strip()


def _text(value: object, label: str, minimum: int, maximum: int) -> str:
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise ValueError(f"{label} must contain {minimum}–{maximum} characters")
    return value.strip()


def _runtime(value: object) -> dict:
    if value is None:
        return default_runtime()
    if not isinstance(value, dict):
        raise ValueError("Chapter runtime settings must be an object")
    packages = value.get("packages", [])
    if not isinstance(packages, list) or len(packages) > 40 or any(p not in WEBR_PACKAGE_ALLOWLIST for p in packages):
        raise ValueError("Chapter packages must come from the webR package allowlist")
    files = value.get("datasetFileIds", [])
    if not isinstance(files, list) or len(files) > 20 or any(not isinstance(f, str) or not _ID.fullmatch(f) for f in files):
        raise ValueError("Chapter datasets must be a list of file ids")
    timeout = value.get("timeoutSeconds", 12)
    if type(timeout) is not int or not 1 <= timeout <= 120:
        raise ValueError("R timeout must be an integer from 1 to 120 seconds")
    hints = value.get("errorHints", [])
    if not isinstance(hints, list) or len(hints) > 20:
        raise ValueError("Use at most 20 error hints per chapter")
    clean_hints = []
    for hint in hints:
        if not isinstance(hint, dict):
            raise ValueError("Each error hint needs match and hint text")
        clean_hints.append({"match": _text(hint.get("match"), "Error hint match", 1, 200),
                            "hint": _text(hint.get("hint"), "Error hint text", 1, 1000)})
    return {"packages": list(dict.fromkeys(packages)), "datasetFileIds": list(dict.fromkeys(files)),
            "timeoutSeconds": timeout, "errorHints": clean_hints}


def validate_course(data: object) -> dict:
    """Validate ``CourseInput`` v2 → stored config (status/effectiveAccess derived and stored for rollback safety)."""
    if not isinstance(data, dict):
        raise ValueError("Course settings must be an object")
    title = _text(data.get("title"), "Course title", 1, 100)
    description = data.get("description", "")
    if not isinstance(description, str) or len(description) > 1000:
        raise ValueError("Course description is too long")
    scope = data.get("freePracticeScope", "current_and_earlier")
    if scope not in FREE_PRACTICE_SCOPES:
        raise ValueError("Free practice scope must be current_and_earlier, current_only or all")
    units = data.get("units")
    if not isinstance(units, list) or not 1 <= len(units) <= 30:
        raise ValueError("A course needs 1–30 chapters")
    clean_units = []
    ids: set[str] = set()
    for unit in units:
        if not isinstance(unit, dict) or not isinstance(unit.get("id"), str) or not _ID.fullmatch(unit["id"]):
            raise ValueError("Invalid chapter ID")
        uid = unit["id"]
        if uid in ids:
            raise ValueError("Chapter IDs must be unique")
        ids.add(uid)
        access = unit.get("access", "default")
        if access not in UNIT_ACCESS:
            raise ValueError("Chapter access must be default, open, review or hidden")
        week = unit.get("week")
        if week is not None and (type(week) is not int or not 1 <= week <= 60):
            raise ValueError("Chapter week must be an integer from 1 to 60")
        starts_on = unit.get("startsOn")
        if starts_on is not None:
            if not isinstance(starts_on, str) or not _DATE.fullmatch(starts_on):
                raise ValueError("Chapter start date must be YYYY-MM-DD")
            try:
                date.fromisoformat(starts_on)
            except ValueError as exc:
                raise ValueError("Chapter start date must be YYYY-MM-DD") from exc
        clean_units.append({
            "id": uid,
            "title": _text(unit.get("title"), "Chapter title", 1, 100),
            "goal": _text(unit.get("goal"), "Learning goal", 1, 500),
            "access": access,
            "week": week,
            "startsOn": starts_on,
            "runtime": _runtime(unit.get("runtime")),
            "notes": unit_notes(unit.get("notes")),
            **template_fields(unit),   # S-M05: course-template metadata (staff only)
        })
    current = data.get("currentUnitId")
    if current not in ids:
        raise ValueError("Select an existing chapter as the current chapter")
    current_index = [u["id"] for u in clean_units].index(current)
    for index, unit in enumerate(clean_units):
        unit["status"] = "completed" if index < current_index else "current" if index == current_index else "upcoming"
    return {"title": title, "description": description.strip(), "currentUnitId": current,
            "freePracticeScope": scope, "units": clean_units}


def referenced_units(db: sqlite3.Connection, class_id: str) -> set[str]:
    """Chapters that assignments, learning history or Kiwi materials refer to (cannot be removed)."""
    refs = {r[0] for r in db.execute("SELECT DISTINCT unit_id FROM assignments WHERE class_id=?", (class_id,))}
    refs |= {r[0] for r in db.execute(
        "SELECT DISTINCT unitId FROM learning_sessions WHERE classId=? AND unitId!=''", (class_id,))}
    refs |= {r[0] for r in db.execute(
        "SELECT unit_id FROM kiwi_materials WHERE class_id=? AND unit_id!=''", (class_id,))}
    return {r for r in refs if r}


def validate_schedule(schedule: object) -> dict:
    """Schedule validation shared with settings (§4.5.4): timezone must be a valid zoneinfo name."""
    if not isinstance(schedule, dict):
        raise ValueError("Schedule must be an object")
    tz_name = schedule.get("timezone", DEFAULT_TIMEZONE)
    try:
        ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError, TypeError) as exc:
        raise ValueError("Choose a valid time zone (for example Asia/Shanghai)") from exc
    meetings = schedule.get("meetings", [])
    if not isinstance(meetings, list) or len(meetings) > 14:
        raise ValueError("Use at most 14 class meetings per week")
    clean = []
    for meeting in meetings:
        if not isinstance(meeting, dict):
            raise ValueError("Each class meeting needs weekday, time and duration")
        weekday, at, duration = meeting.get("weekday"), meeting.get("time"), meeting.get("durationMinutes", 90)
        if type(weekday) is not int or not 1 <= weekday <= 7:
            raise ValueError("Meeting weekday must be 1 (Monday) to 7 (Sunday)")
        if not isinstance(at, str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", at):
            raise ValueError("Meeting time must be HH:MM")
        if type(duration) is not int or not 15 <= duration <= 300:
            raise ValueError("Meeting duration must be 15–300 minutes")
        clean.append({"weekday": weekday, "time": at, "durationMinutes": duration})
    term_start = schedule.get("termStart")
    if term_start is not None:
        if not isinstance(term_start, str) or not _DATE.fullmatch(term_start):
            raise ValueError("Term start must be YYYY-MM-DD")
        try:
            date.fromisoformat(term_start)
        except ValueError as exc:
            raise ValueError("Term start must be YYYY-MM-DD") from exc
    return {"timezone": tz_name, "meetings": clean, "termStart": term_start}


# -- time ranges (§13.0) --------------------------------------------------------------------------
def _floor(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(microsecond=0)


def _fmt(value: datetime | None) -> str | None:
    return dbmod.iso_seconds(value) if value is not None else None


def _occurrences(schedule: dict, tz: ZoneInfo, now: datetime) -> list[tuple[datetime, datetime]]:
    local_today = now.astimezone(tz).date()
    term_start = schedule.get("termStart")
    term = date.fromisoformat(term_start) if isinstance(term_start, str) and _DATE.fullmatch(term_start) else None
    result = []
    for offset in range(0, 36):
        day = local_today - timedelta(days=offset)
        if term is not None and day < term:
            continue
        for meeting in schedule.get("meetings") or []:
            try:
                weekday = int(meeting.get("weekday"))
                hour, minute = (int(x) for x in str(meeting.get("time")).split(":"))
                duration = int(meeting.get("durationMinutes") or 90)
            except (TypeError, ValueError):
                continue
            if day.isoweekday() != weekday:
                continue
            # fold=0: a nonexistent local time moves forward with the DST gap when converted to UTC.
            start = datetime.combine(day, time(hour, minute), tzinfo=tz).astimezone(timezone.utc)
            result.append((start, start + timedelta(minutes=duration)))
    result.sort()
    return result


def _shift_local(value: datetime, tz: ZoneInfo, days: int) -> datetime:
    """Shift by whole days in local wall-clock time (keeps 10:00 local across DST changes)."""
    local = value.astimezone(tz)
    shifted = (local.replace(tzinfo=None) - timedelta(days=days)).replace(tzinfo=tz)
    return shifted.astimezone(timezone.utc)


def time_range(preset: str, schedule: dict, *, now: datetime | str, first_event_at: str | None = None,
               custom_from: str | None = None, custom_to: str | None = None) -> TimeRange:
    """Resolve a time-range preset in the course time zone (frozen algorithm, §13.0)."""
    if preset not in TIME_PRESETS:
        raise ValueError("preset must be one of: " + ", ".join(TIME_PRESETS))
    schedule = schedule if isinstance(schedule, dict) else {}
    try:
        tz = ZoneInfo(schedule.get("timezone") or DEFAULT_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        tz = ZoneInfo(DEFAULT_TIMEZONE)
    current = _floor(dbmod.parse_iso(now) if isinstance(now, str) else now)  # type: ignore[arg-type]
    local = lambda v: v.astimezone(tz)  # noqa: E731
    effective = preset
    note = None
    start: datetime | None = None
    label = ""
    if preset in ("this_class", "since_last_class"):
        occurrences = [o for o in _occurrences(schedule, tz, current) if o[0] <= current]
        chosen = None
        if preset == "this_class":
            running = [o for o in occurrences if o[0] <= current < o[1]]
            chosen = running[-1] if running else (occurrences[-1] if occurrences else None)
            if chosen:
                label = f"This class ({local(chosen[0]).strftime('%a %m/%d %H:%M')})"
        else:
            ended = [o for o in occurrences if o[1] <= current]
            chosen = ended[-1] if ended else None
            if chosen:
                label = f"Since last class ({local(chosen[0]).strftime('%a %m/%d')})"
        if chosen:
            start = chosen[0]
        else:
            effective = "last_7_days"
            note = "Set class meetings in Course settings to use " + ("This class" if preset == "this_class" else "Since last class")
    if preset == "this_week":
        local_now = local(current)
        monday = local_now.date() - timedelta(days=local_now.isoweekday() - 1)
        start = datetime.combine(monday, time(0, 0), tzinfo=tz).astimezone(timezone.utc)
        label = f"This week (since Mon {monday.strftime('%m/%d')})"
    if effective == "last_7_days":
        start = current - timedelta(days=7)
        label = "Last 7 days"
    if preset == "whole_term":
        term_start = schedule.get("termStart")
        if isinstance(term_start, str) and _DATE.fullmatch(term_start):
            start = datetime.combine(date.fromisoformat(term_start), time(0, 0), tzinfo=tz).astimezone(timezone.utc)
        elif first_event_at:
            start = _floor(dbmod.parse_iso(first_event_at))  # type: ignore[arg-type]
        else:
            start = None
        return TimeRange(preset, preset, _fmt(start), _fmt(current), None, None, "Whole term", None, None)
    if preset == "custom":
        begin = dbmod.parse_iso(custom_from) if custom_from else None
        end = dbmod.parse_iso(custom_to) if custom_to else None
        if begin is None or end is None:
            raise ValueError("A custom range needs from and to")
        begin, end = _floor(begin), _floor(end)
        if begin >= end:
            raise ValueError("The range start must be before its end")
        if end - begin > timedelta(days=400):
            raise ValueError("A custom range can span at most 400 days")
        weeks = math.ceil((end - begin) / timedelta(days=7))
        last = end - timedelta(seconds=1)
        return TimeRange("custom", "custom", _fmt(begin), _fmt(end), _fmt(_shift_local(begin, tz, 7 * weeks)),
                         _fmt(_shift_local(end, tz, 7 * weeks)),
                         f"{local(begin).strftime('%m/%d')} – {local(last).strftime('%m/%d')}", "vs previous period", None)
    assert start is not None
    return TimeRange(preset, effective, _fmt(start), _fmt(current), _fmt(_shift_local(start, tz, 7)),
                     _fmt(_shift_local(current, tz, 7)), label, "vs last week", note)
