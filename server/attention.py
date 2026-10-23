"""Students needing attention and What to re-teach (owned by INSIGHTS; spec §13.2, §13.3).

Rules are evaluated over active, non-excluded roster students (the query-time population, P10). Thresholds are
inclusive (``≥``). "Server-checked" attempts are ``checked_by='server'`` plus re-judged legacy checks; client-reported
and not-re-judged legacy checks never trigger a rule.
"""

from __future__ import annotations

import sqlite3
from copy import deepcopy
from datetime import datetime, timedelta
from urllib.parse import quote

from server import analytics, course_config, readers
from server import db as dbmod
from server.analytics import AI_QUESTION, ATTEMPT, CHECKED, CORRECT, EV_JOINS, JOK, TEACHER, UNIT_EXPR, Scope
from server.router import valid_id

RULE_IDS = ("no_activity", "missing_work", "stuck_question", "repeated_ai_help", "low_accuracy", "late_pattern")
PARAM_LIMITS: dict[str, dict[str, tuple[int, int]]] = {
    "no_activity": {"days": (1, 90)},
    "missing_work": {"count": (1, 20)},
    "stuck_question": {"errors": (1, 100)},
    "repeated_ai_help": {"questions": (1, 100)},
    "low_accuracy": {"pct": (1, 100), "minChecked": (1, 200)},
    "late_pattern": {"count": (1, 20), "days": (1, 180)},
}
RULE_WORDS = {
    "no_activity": "No learning actions (answers, code runs, AI questions, submissions) for {days}+ days",
    "missing_work": "{count}+ past-due homework not submitted",
    "stuck_question": "{errors}+ code errors on one question with no success",
    "repeated_ai_help": "Asked the AI {questions}+ times on one question",
    "low_accuracy": "Below {pct}% auto-checked accuracy in this week's chapter ({minChecked}+ checks)",
    "late_pattern": "{count}+ late submissions in {days} days",
}
TARGET_KINDS = ("question", "item_group", "ai_prompt", "topic")


# ─── rules ─────────────────────────────────────────────────────────────────────────────────────

def rules(db: sqlite3.Connection, class_id: str) -> dict:
    """Course attention rules merged over the defaults (one entry per rule id, default order)."""
    stored = readers.settings(db, class_id).get("attentionRules") or {}
    by_id = {r.get("id"): r for r in (stored.get("rules") or []) if isinstance(r, dict)}
    out = []
    for default in course_config.ATTENTION_RULE_DEFAULTS:
        rule = deepcopy(default)
        custom = by_id.get(rule["id"])
        if custom:
            if isinstance(custom.get("enabled"), bool):
                rule["enabled"] = custom["enabled"]
            for name, value in (custom.get("params") or {}).items():
                if name in rule["params"] and type(value) is int:
                    rule["params"][name] = value
        out.append(rule)
    return {"rules": out}


def describe(rule: dict) -> str:
    """The rule in words for the ``rules (i)`` popover."""
    return RULE_WORDS[rule["id"]].format(**rule["params"])


def validate_rules(body: object) -> dict:
    if not isinstance(body, dict) or not isinstance(body.get("rules"), list):
        raise ValueError("Send {rules: [...]} with the attention rules")
    seen: dict[str, dict] = {}
    for rule in body["rules"]:
        if not isinstance(rule, dict) or rule.get("id") not in RULE_IDS:
            raise ValueError("Unknown attention rule")
        if rule["id"] in seen:
            raise ValueError(f"Rule {rule['id']} is listed twice")
        if not isinstance(rule.get("enabled"), bool):
            raise ValueError(f"Rule {rule['id']}: enabled must be true or false")
        params = rule.get("params") or {}
        if not isinstance(params, dict):
            raise ValueError(f"Rule {rule['id']}: params must be an object")
        clean = {}
        for name, (lo, hi) in PARAM_LIMITS[rule["id"]].items():
            value = params.get(name, next(d for d in course_config.ATTENTION_RULE_DEFAULTS if d["id"] == rule["id"])["params"][name])
            if type(value) is not int or not lo <= value <= hi:
                raise ValueError(f"Rule {rule['id']}: {name} must be a whole number from {lo} to {hi}")
            clean[name] = value
        extra = set(params) - set(PARAM_LIMITS[rule["id"]])
        if extra:
            raise ValueError(f"Rule {rule['id']}: unknown setting {sorted(extra)[0]}")
        seen[rule["id"]] = {"id": rule["id"], "enabled": rule["enabled"], "params": clean}
    merged = rules_from(seen)
    return {"rules": merged}


def rules_from(by_id: dict[str, dict]) -> list[dict]:
    out = []
    for default in course_config.ATTENTION_RULE_DEFAULTS:
        out.append(deepcopy(by_id.get(default["id"], default)))
    return out


def save_settings_key(db: sqlite3.Connection, class_id: str, key: str, value: object, actor: str) -> None:
    """Write one key of ``course_settings.settings_json`` (merge over the stored row)."""
    row = db.execute("SELECT settings_json FROM course_settings WHERE class_id = ?", (class_id,)).fetchone()
    stored = analytics._loads(row[0], {}) if row else {}
    stored = stored if isinstance(stored, dict) else {}
    stored[key] = value
    merged = course_config.merge_settings(stored)
    db.execute("""INSERT INTO course_settings (class_id, settings_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(class_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at,
        updated_by = excluded.updated_by""", (class_id, dbmod.json_dumps(merged), dbmod.now(), actor[:200]))


# ─── evaluation ────────────────────────────────────────────────────────────────────────────────

def _href_profile(student_id: str) -> str:
    return f"/teacher/students/s/{quote(student_id, safe='')}"


def _href_timeline(student_id: str, assignment_id: str = "") -> str:
    if assignment_id:
        return f"{_href_profile(student_id)}/assignments/{quote(assignment_id, safe='')}"
    return f"{_href_profile(student_id)}/timeline"


def _days_text(days: int) -> str:
    if days % 7 == 0 and days >= 14:
        return f"{days // 7} weeks"
    return f"{days} days" if days != 1 else "1 day"


def evaluate(db: sqlite3.Connection, scope: Scope, *, now: datetime | None = None) -> dict:
    """``{rules, students: AttentionItem[], evaluatedAt}`` ordered by number of triggered rules, then latest trigger."""
    now = now or dbmod.utcnow()
    config = rules(db, scope.class_id)
    enabled = {r["id"]: r["params"] for r in config["rules"] if r["enabled"]}
    students = analytics.enrolled_ids(db, analytics.unranged(scope))
    reasons: dict[str, list[dict]] = {sid: [] for sid in students}
    if students and enabled:
        index = analytics.assignment_index(db, scope.class_id)
        course = course_config.course_for(scope.class_id, db)
        if "no_activity" in enabled:
            _no_activity(db, scope, students, enabled["no_activity"], now, reasons)
        if "missing_work" in enabled:
            _missing(db, scope, students, enabled["missing_work"], now, reasons)
        if "stuck_question" in enabled:
            _stuck(db, scope, enabled["stuck_question"], index, reasons)
        if "repeated_ai_help" in enabled:
            _repeated_ai(db, scope, enabled["repeated_ai_help"], index, reasons)
        if "low_accuracy" in enabled:
            _low_accuracy(db, scope, enabled["low_accuracy"], course, reasons)
        if "late_pattern" in enabled:
            _late(db, scope, enabled["late_pattern"], now, reasons)
    items = [{"studentId": sid, "studentName": sid, "reasons": found} for sid, found in reasons.items() if found]
    items.sort(key=lambda item: max((r["at"] or "") for r in item["reasons"]), reverse=True)
    items.sort(key=lambda item: len(item["reasons"]), reverse=True)
    return {"rules": config, "students": items, "evaluatedAt": dbmod.iso_seconds(now)}


def _no_activity(db: sqlite3.Connection, scope: Scope, students: list[str], params: dict, now: datetime,
                 reasons: dict[str, list[dict]]) -> None:
    """B-m01: "No learning actions for N days" (answers, code runs, AI questions, submissions), with the time the student
    was last seen (any event), from ``analytics.activity_stamps`` — the roster's *Last seen* and *Last learning action*."""
    days = params["days"]
    stamps = analytics.activity_stamps(db, scope.class_id, students)
    published = db.execute("""SELECT 1 FROM assignments WHERE class_id = ? AND status = 'published' AND deleted_at IS NULL
        LIMIT 1""", (scope.class_id,)).fetchone() is not None
    joined = {row[0]: row[1] for row in db.execute("SELECT student_id, created_at FROM roster WHERE class_id = ?", (scope.class_id,))}
    threshold = timedelta(days=days)
    for sid in students:
        stamp = stamps[sid]
        # "on the roster ≥ days days": the earlier of the roster row and the first recorded event
        candidates = [dbmod.parse_iso(v) for v in (joined.get(sid), stamp.first_seen) if v]
        joined_at = min(candidates) if candidates else None
        long_enough = published or joined_at is None or now - joined_at >= threshold
        if not long_enough:
            continue
        moment = dbmod.parse_iso(stamp.last_learning_action) if stamp.last_learning_action else None
        if moment is None:
            reasons[sid].append({"rule": "no_activity", "text": "No learning actions recorded yet", "href": _href_profile(sid),
                                 "at": None, "lastSeenAt": stamp.last_seen})
        elif now - moment >= threshold:
            # rounded like formatRelative ("11 days ago") so Home and the roster agree (TEACHER-14)
            idle = round((now - moment).total_seconds() / 86400)
            reasons[sid].append({"rule": "no_activity", "text": f"No learning actions for {idle} {'day' if idle == 1 else 'days'}",
                                 "href": _href_timeline(sid), "at": stamp.last_learning_action, "lastSeenAt": stamp.last_seen})


def _missing(db: sqlite3.Connection, scope: Scope, students: list[str], params: dict, now: datetime,
             reasons: dict[str, list[dict]]) -> None:
    # D8: a homework and its revisions count once; the tooltip (``title``) names the original of a revision
    missing = analytics.missing_work(db, scope.class_id, students, now)
    for sid, items in missing.items():
        if len(items) < params["count"] or not items:
            continue
        text = f"Missing {items[0].title}" if len(items) == 1 else f"Missing {len(items)} assignments"
        latest = max(items, key=lambda r: r.due_at or "")
        reasons[sid].append({"rule": "missing_work", "text": text, "href": _href_timeline(sid, latest.id), "at": latest.due_at,
                             "title": analytics.missing_text(items)})


def _question_key_sql() -> tuple[str, str]:
    return ("COALESCE(NULLIF(e.attribution_assignment_id, ''), e.related_assignment_id)",
            "COALESCE(NULLIF(e.item_id, ''), e.question_id, '')")


def _target_label(index: dict, assignment_id: str, question_id: str) -> str:
    if question_id.startswith("gi-"):
        return "an AI practice item"
    return analytics.question_ref(index, assignment_id, question_id) or "one question"


def _stuck(db: sqlite3.Connection, scope: Scope, params: dict, index: dict, reasons: dict[str, list[dict]]) -> None:
    population, pparams = analytics.pop_sql(scope)
    akey, qkey = _question_key_sql()
    rows = db.execute(f"""SELECT e.student_id AS s, {akey} AS a, {qkey} AS q,
        SUM(e.event_type = 'code_run' AND {JOK} = 0) AS errors, SUM(e.event_type = 'code_run' AND {JOK} = 1) AS successes,
        SUM(CASE WHEN {CHECKED} AND {CORRECT} = 1 THEN 1 ELSE 0 END) AS solved, MAX(e.created_at) AS at
        FROM events e WHERE {population} AND {qkey} != '' GROUP BY s, a, q
        HAVING errors >= ? AND successes = 0 AND solved = 0 ORDER BY errors DESC""", [*pparams, params["errors"]]).fetchall()
    for row in rows:
        if row["s"] in reasons and not any(r["rule"] == "stuck_question" for r in reasons[row["s"]]):
            label = _target_label(index, row["a"] or "", row["q"])
            reasons[row["s"]].append({"rule": "stuck_question", "text": f"{row['errors']} errors on {label}, no success",
                                      "href": _href_timeline(row["s"], row["a"] or ""), "at": row["at"]})


def _repeated_ai(db: sqlite3.Connection, scope: Scope, params: dict, index: dict, reasons: dict[str, list[dict]]) -> None:
    population, pparams = analytics.pop_sql(scope)
    akey, qkey = _question_key_sql()
    rows = db.execute(f"""SELECT e.student_id AS s, {akey} AS a, {qkey} AS q, COUNT(*) AS n, MAX(e.created_at) AS at
        FROM events e WHERE {population} AND {AI_QUESTION} AND {qkey} != '' GROUP BY s, a, q HAVING n >= ?
        ORDER BY n DESC""", [*pparams, params["questions"]]).fetchall()
    for row in rows:
        if row["s"] in reasons and not any(r["rule"] == "repeated_ai_help" for r in reasons[row["s"]]):
            label = _target_label(index, row["a"] or "", row["q"])
            reasons[row["s"]].append({"rule": "repeated_ai_help", "text": f"Asked AI {row['n']}× on {label}",
                                      "href": _href_timeline(row["s"], row["a"] or ""), "at": row["at"]})


def _low_accuracy(db: sqlite3.Connection, scope: Scope, params: dict, course: dict, reasons: dict[str, list[dict]]) -> None:
    unit = course.get("currentUnitId", "")
    population, pparams = analytics.pop_sql(scope)
    rows = db.execute(f"""SELECT e.student_id AS s, COUNT(*) AS n, SUM({CORRECT}) AS c, MAX(e.created_at) AS at
        FROM events e {EV_JOINS} WHERE {population} AND {CHECKED} AND {UNIT_EXPR} = ? GROUP BY s HAVING n >= ?""",
                      [*pparams, unit, params["minChecked"]]).fetchall()
    for row in rows:
        pct = 100.0 * (row["c"] or 0) / row["n"]
        if row["s"] in reasons and pct < params["pct"]:
            reasons[row["s"]].append({
                "rule": "low_accuracy",
                "text": f"{round(pct)}% correct on {analytics.chapter_short(course, unit)} practice ({row['n']} checks)",
                "href": _href_timeline(row["s"]), "at": row["at"]})


def _late(db: sqlite3.Connection, scope: Scope, params: dict, now: datetime, reasons: dict[str, list[dict]]) -> None:
    since = dbmod.iso_seconds(now - timedelta(days=params["days"]))
    population, pparams = analytics.pop_sql(analytics.unranged(scope), "s", time_col=None)
    rows = db.execute(f"""SELECT s.student_id, COUNT(*) AS n, MAX(s.submitted_at) AS at FROM submissions s
        WHERE {population} AND s.is_late = 1 AND s.submitted_at >= ? GROUP BY s.student_id HAVING n >= ?""",
                      [*pparams, since, params["count"]]).fetchall()
    for row in rows:
        if row[0] in reasons:
            reasons[row[0]].append({"rule": "late_pattern",
                                    "text": f"{row['n']} late submissions in {_days_text(params['days'])}",
                                    "href": f"/teacher/grading?studentId={quote(row[0], safe='')}&show=late", "at": row["at"]})


# ─── What to re-teach (§13.3) ──────────────────────────────────────────────────────────────────

def mark_dict(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "targetKind": row["target_kind"], "assignmentId": row["assignment_id"],
            "questionId": row["question_id"], "unitId": row["unit_id"], "chatTurnId": row["chat_turn_id"], "label": row["label"],
            "note": row["note"], "createdBy": row["created_by"], "createdAt": row["created_at"], "resolvedAt": row["resolved_at"]}


def marks(db: sqlite3.Connection, class_id: str, *, include_resolved: bool = False) -> list[dict]:
    sql = "SELECT * FROM reteach_marks WHERE class_id = ?" + ("" if include_resolved else " AND resolved_at IS NULL")
    return [mark_dict(r) for r in db.execute(sql + " ORDER BY created_at DESC, id DESC", (class_id,))]


def reteach(db: sqlite3.Connection, scope: Scope, *, include_resolved: bool = False, limit: int = 5) -> dict:
    """Teacher-authored questions with ≥ 3 population students attempting in the range, weakest first."""
    population, pparams = analytics.pop_sql(scope)
    attempts = db.execute(f"""SELECT e.attribution_assignment_id AS a, e.question_id AS q, COUNT(DISTINCT e.student_id) AS students
        FROM events e WHERE {population} AND {ATTEMPT} AND {TEACHER} AND COALESCE(e.question_id, '') != ''
        GROUP BY a, q HAVING students >= 3""", pparams).fetchall()
    if not attempts:
        return {"candidates": [], "marked": marks(db, scope.class_id, include_resolved=include_resolved)}
    # per (question, student): was the first server-checked attempt correct, and at which attempt index the first correct
    per_student = f"""SELECT a, q, s, MAX(CASE WHEN attempt_no = 1 THEN ok END) AS first_ok,
            MIN(CASE WHEN ok = 1 THEN attempt_no END) AS first_correct_no FROM (
            SELECT e.attribution_assignment_id AS a, e.question_id AS q, e.student_id AS s, {CORRECT} AS ok,
              ROW_NUMBER() OVER (PARTITION BY e.attribution_assignment_id, e.question_id, e.student_id
                                 ORDER BY e.created_at, e.id) AS attempt_no
            FROM events e WHERE {population} AND {CHECKED} AND {TEACHER}) GROUP BY a, q, s"""
    checks = {(r["a"], r["q"]): dict(r) for r in db.execute(
        f"""SELECT a, q, COUNT(*) AS takers, SUM(first_ok) AS firstCorrect, AVG(first_correct_no) AS meanTries
        FROM ({per_student}) GROUP BY a, q""", pparams)}
    spop, sparams = analytics.pop_sql(scope, "s", time_col="submitted_at")
    scores = {(r[0], r[1]): r[2] for r in db.execute(f"""SELECT s.assignment_id, i.question_id,
            AVG(i.score * 100.0 / NULLIF(CAST(json_extract(jq.value, '$.points') AS REAL), 0))
        FROM submission_item_scores i JOIN submissions s ON s.id = i.submission_id
        JOIN assignments a ON a.id = s.assignment_id AND a.class_id = s.class_id
        JOIN json_each(a.questions_json) jq ON json_extract(jq.value, '$.id') = i.question_id
        WHERE {spop} AND i.score IS NOT NULL AND s.grade_status IN ('draft', 'released') GROUP BY s.assignment_id, i.question_id""",
                                                   sparams)}
    index = analytics.assignment_index(db, scope.class_id)
    open_marks = {(m["assignmentId"], m["questionId"]) for m in marks(db, scope.class_id) if m["targetKind"] == "question"}
    candidates = []
    for row in attempts:
        key = (row["a"], row["q"])
        info = index.get(row["a"])
        if info is None or info.deleted:
            continue
        check = checks.get(key)
        first = analytics._pct(check["firstCorrect"], check["takers"]) if check and check["takers"] else None
        mean_tries = round(check["meanTries"], 1) if check and check["meanTries"] is not None else None
        score = round(scores[key], 1) if scores.get(key) is not None else None
        if first is None and score is None:
            continue
        question = info.questions.get(row["q"], (None, {}))[1]
        candidates.append({"assignmentId": row["a"], "questionId": row["q"], "label": analytics.question_ref(index, row["a"], row["q"]),
                           "prompt": analytics._clip(question.get("prompt"), 140), "students": row["students"],
                           "firstTryCorrectPct": first, "meanTriesToCorrect": mean_tries,
                           "meanScorePct": score if first is None else None, "marked": key in open_marks})
    candidates.sort(key=lambda c: -c["students"])
    candidates.sort(key=lambda c: c["firstTryCorrectPct"] if c["firstTryCorrectPct"] is not None else c["meanScorePct"])
    return {"candidates": candidates[:limit], "marked": marks(db, scope.class_id, include_resolved=include_resolved)}


def create_mark(db: sqlite3.Connection, class_id: str, body: dict, actor: str) -> dict:
    kind = body.get("targetKind")
    if kind not in TARGET_KINDS:
        raise ValueError("targetKind must be question, item_group, ai_prompt or topic")
    label = body.get("label")
    if not isinstance(label, str) or not 1 <= len(label.strip()) <= 300:
        raise ValueError("Give the re-teach item a label (1–300 characters)")
    note = body.get("note") or ""
    if not isinstance(note, str) or len(note) > 2000:
        raise ValueError("Note must be text of at most 2,000 characters")
    ids = {}
    for name in ("assignmentId", "questionId", "unitId"):
        value = body.get(name) or ""
        if not isinstance(value, str) or (value and not valid_id(value)):
            raise ValueError(f"{name} has an invalid format")
        ids[name] = value
    chat = body.get("chatTurnId")
    if chat is not None and type(chat) is not int:
        raise ValueError("chatTurnId must be a number")
    if kind == "question" and not (ids["assignmentId"] and ids["questionId"]):
        raise ValueError("A question mark needs assignmentId and questionId")
    cur = db.execute("""INSERT INTO reteach_marks (class_id, target_kind, assignment_id, question_id, unit_id, chat_turn_id, label,
        note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                     (class_id, kind, ids["assignmentId"], ids["questionId"], ids["unitId"], chat, label.strip(), note,
                      actor[:200], dbmod.now()))
    return mark_dict(db.execute("SELECT * FROM reteach_marks WHERE id = ?", (cur.lastrowid,)).fetchone())


def update_mark(db: sqlite3.Connection, class_id: str, mark_id: int, body: dict) -> tuple[dict, dict]:
    row = db.execute("SELECT * FROM reteach_marks WHERE class_id = ? AND id = ?", (class_id, mark_id)).fetchone()
    if row is None:
        raise LookupError("Re-teach item not found")
    before = mark_dict(row)
    resolved = body.get("resolved")
    note = body.get("note")
    if resolved is not None and not isinstance(resolved, bool):
        raise ValueError("resolved must be true or false")
    if note is not None and (not isinstance(note, str) or len(note) > 2000):
        raise ValueError("Note must be text of at most 2,000 characters")
    if resolved is not None:
        db.execute("UPDATE reteach_marks SET resolved_at = ? WHERE id = ?", (dbmod.now() if resolved else None, mark_id))
    if note is not None:
        db.execute("UPDATE reteach_marks SET note = ? WHERE id = ?", (note, mark_id))
    return before, mark_dict(db.execute("SELECT * FROM reteach_marks WHERE id = ?", (mark_id,)).fetchone())
