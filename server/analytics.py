"""Indexed session rollups and bounded, course-scoped evidence queries."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone

COUNTERS = (
    "interactions",
    "attempts",
    "checked",
    "correct",
    "codeRuns",
    "codeErrors",
    "codeSuccesses",
    "aiQuestions",
)


def init(db):
    db.create_function(
        "normalize_question",
        1,
        lambda text: " ".join(str(text or "").casefold().split()),
    )
    columns = {r[1] for r in db.execute("PRAGMA table_info(events)")}
    if "learning_session_id" not in columns:
        db.execute("ALTER TABLE events ADD COLUMN learning_session_id TEXT")
    if "source" not in columns:
        db.execute("ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'lab'")
        db.execute("ALTER TABLE events ADD COLUMN upstream_id TEXT")
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_native_event ON events(class_id,source,upstream_id)")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS learning_sessions (
            id TEXT PRIMARY KEY, classId TEXT NOT NULL, studentId TEXT NOT NULL,
            studentName TEXT NOT NULL, browserSession TEXT NOT NULL, contextKey TEXT NOT NULL,
            unitId TEXT NOT NULL, assignmentId TEXT NOT NULL, questionId TEXT NOT NULL,
            kind TEXT NOT NULL, title TEXT NOT NULL, startedAt TEXT NOT NULL, lastActive TEXT NOT NULL,
            interactions INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
            checked INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0,
            codeRuns INTEGER NOT NULL DEFAULT 0, codeErrors INTEGER NOT NULL DEFAULT 0,
            aiQuestions INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_session_context ON learning_sessions(classId,studentId,browserSession,contextKey,lastActive DESC);
        CREATE INDEX IF NOT EXISTS idx_session_unit ON learning_sessions(classId,unitId,assignmentId,questionId);
        CREATE INDEX IF NOT EXISTS idx_session_student ON learning_sessions(classId,studentId,lastActive DESC);
        CREATE INDEX IF NOT EXISTS idx_event_session ON events(class_id,learning_session_id,id);
    """)
    session_columns = {r[1] for r in db.execute("PRAGMA table_info(learning_sessions)")}
    for column, definition in (("source", "TEXT NOT NULL DEFAULT 'lab'"), ("materialId", "TEXT NOT NULL DEFAULT ''"),
                               ("codeSuccesses", "INTEGER NOT NULL DEFAULT 0")):
        if column not in session_columns:
            db.execute(f"ALTER TABLE learning_sessions ADD COLUMN {column} {definition}")
    db.execute("CREATE INDEX IF NOT EXISTS idx_session_source_material ON learning_sessions(classId,source,materialId,lastActive)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_session_event_time ON events(class_id,learning_session_id,created_at,id)")
    # Earlier app versions stored homework snapshots but no per-question attempts.
    # Recover those actual attempts with their original timestamp and explicit provenance.
    legacy = db.execute("""SELECT s.* FROM submissions s WHERE NOT EXISTS
        (SELECT 1 FROM events e WHERE e.class_id=s.class_id AND e.event_type='answer_submitted'
         AND json_extract(e.payload_json,'$.submissionId')=s.id)""").fetchall()
    for submission in legacy:
        opened = db.execute(
            "SELECT session_id FROM events WHERE class_id=? AND student_id=? AND event_type='work_submitted' AND json_extract(payload_json,'$.submissionId')=? ORDER BY id LIMIT 1",
            (submission["class_id"], submission["student_id"], submission["id"]),
        ).fetchone()
        browser = opened[0] if opened else "legacy-" + submission["id"]
        for question_id, answer in json.loads(submission["answers_json"]).items():
            payload = {
                "assignmentId": submission["assignment_id"],
                "submissionId": submission["id"],
                "answer": answer,
                "attempt": submission["attempt"],
                "recoveredFromSubmission": True,
            }
            db.execute(
                "INSERT INTO events (class_id,student_id,student_name,session_id,event_type,question_id,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (
                    submission["class_id"],
                    submission["student_id"],
                    submission["student_name"],
                    browser,
                    "answer_submitted",
                    question_id,
                    json.dumps(payload),
                    submission["submitted_at"],
                ),
            )
    db.execute("CREATE TABLE IF NOT EXISTS telemetry_meta (version TEXT PRIMARY KEY)")
    if not db.execute(
        "SELECT 1 FROM telemetry_meta WHERE version='sessions-v2'"
    ).fetchone():
        db.execute("DELETE FROM learning_sessions")
        db.execute("UPDATE events SET learning_session_id=NULL")
        db.execute("INSERT INTO telemetry_meta VALUES ('sessions-v2')")
    if not db.execute("SELECT 1 FROM telemetry_meta WHERE version='known-code-results-v1'").fetchone():
        db.execute("""UPDATE learning_sessions SET codeSuccesses=(SELECT COUNT(*) FROM events e
            WHERE e.learning_session_id=learning_sessions.id AND e.event_type='code_run'
            AND json_extract(e.payload_json,'$.ok')=1)""")
        db.execute("INSERT INTO telemetry_meta VALUES ('known-code-results-v1')")
    # Original payloads and timestamps remain intact. Run once for each old event.
    while True:
        rows = db.execute(
            "SELECT * FROM events WHERE learning_session_id IS NULL ORDER BY created_at,id LIMIT 1000"
        ).fetchall()
        if not rows:
            break
        for row in rows:
            index_event(db, row)


def event_counters(event_type, p):
    attempt = event_type == "answer_submitted"
    checked = attempt and isinstance(p.get("correct"), bool)
    return {"interactions": 1, "attempts": int(attempt), "checked": int(checked),
            "correct": int(checked and p["correct"]), "codeRuns": int(event_type == "code_run"),
            "codeErrors": int(event_type == "code_run" and p.get("ok") is False),
            "codeSuccesses": int(event_type == "code_run" and p.get("ok") is True),
            "aiQuestions": int(event_type in ("ai_question", "hint_requested") and p.get("ok") is not False)}


def index_event(db, row):
    p = json.loads(row["payload_json"])
    if row["event_type"] == "study_heartbeat":
        db.execute("UPDATE events SET learning_session_id='' WHERE id=?", (row["id"],))
        return
    aid = str(p.get("assignmentId") or p.get("relatedAssignmentId") or "")[:100]
    qid = row["question_id"] or ""
    unit = str(p.get("unitId") or "")[:100]
    title = str(p.get("questionTitle") or p.get("title") or "")[:500]
    source = row["source"]
    material = str(p.get("materialId") or "")[:100] if source == "kiwi" else ""
    if aid:
        work = db.execute(
            "SELECT unit_id,questions_json FROM assignments WHERE class_id=? AND id=?",
            (row["class_id"], aid),
        ).fetchone()
        if work:
            unit = work["unit_id"]
            q = next(
                (q for q in json.loads(work["questions_json"]) if q["id"] == qid), None
            )
            if q:
                title = q["prompt"]
    if qid and not unit:
        previous = db.execute(
            "SELECT unitId,title FROM learning_sessions WHERE classId=? AND studentId=? AND questionId=? AND assignmentId=? AND unitId!='' ORDER BY lastActive DESC LIMIT 1",
            (row["class_id"], row["student_id"], qid, aid),
        ).fetchone()
        if previous:
            unit = previous["unitId"]
            title = title or previous["title"]
    kind = (
        "question"
        if qid
        else (
            "reading" if row["event_type"] == "material_viewed" else
            "thread"
            if p.get("threadId") and row["event_type"] not in ("code_run", "code_shared")
            else (
                "code"
                if row["event_type"] in ("code_run", "code_edited", "code_shared")
                else "activity"
            )
        )
    )
    context = json.dumps(
        [unit, aid, qid, str(p.get("threadId") or "") if not qid else "", kind]
        if source == "lab" else ["kiwi", material, p.get("page"), str(p.get("threadId") or ""), kind]
    )
    cutoff = (
        datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
        - timedelta(minutes=30)
    ).isoformat(timespec="seconds")
    old = db.execute(
        """SELECT id FROM learning_sessions WHERE classId=? AND studentId=? AND browserSession=?
        AND contextKey=? AND lastActive>=? ORDER BY lastActive DESC,id DESC LIMIT 1""",
        (row["class_id"], row["student_id"], row["session_id"], context, cutoff),
    ).fetchone()
    sid = old["id"] if old else f"learn-{uuid.uuid4().hex}"
    if not old:
        db.execute(
            """INSERT INTO learning_sessions
            (id,classId,studentId,studentName,browserSession,contextKey,unitId,assignmentId,questionId,kind,title,startedAt,lastActive,source,materialId)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                sid,
                row["class_id"],
                row["student_id"],
                row["student_name"],
                row["session_id"],
                context,
                unit,
                aid,
                qid,
                kind,
                title or ("R workspace" if kind == "code" else "Learning activity"),
                row["created_at"],
                row["created_at"],
                source,
                material,
            ),
        )
    counters = event_counters(row["event_type"], p)
    db.execute(
        """UPDATE learning_sessions SET studentName=?,lastActive=?,interactions=interactions+1,
        attempts=attempts+?,checked=checked+?,correct=correct+?,codeRuns=codeRuns+?,codeErrors=codeErrors+?,codeSuccesses=codeSuccesses+?,aiQuestions=aiQuestions+?,
        title=CASE WHEN ?!='' THEN ? ELSE title END WHERE id=?""",
        (
            row["student_name"],
            row["created_at"],
            *[counters[c] for c in COUNTERS if c != "interactions"],
            title,
            title,
            sid,
        ),
    )
    db.execute("UPDATE events SET learning_session_id=? WHERE id=?", (sid, row["id"]))


def metrics(db, class_id, course):
    total = dict(
        db.execute(
            """SELECT COUNT(DISTINCT studentId) engagedStudents,COALESCE(SUM(interactions),0) interactions,
        COALESCE(SUM(attempts),0) attempts,COALESCE(SUM(codeRuns),0) codeRuns,COALESCE(SUM(aiQuestions),0) aiQuestions,
        COUNT(*) sessions FROM learning_sessions WHERE classId=?""",
            (class_id,),
        ).fetchone()
    )
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(
        timespec="seconds"
    )
    total["activeStudents"] = db.execute(
        "SELECT COUNT(DISTINCT studentId) FROM learning_sessions WHERE classId=? AND lastActive>=?",
        (class_id, cutoff),
    ).fetchone()[0]
    total["publishedAssignments"] = db.execute(
        "SELECT COUNT(*) FROM assignments WHERE class_id=? AND status='published' AND kind='homework'",
        (class_id,),
    ).fetchone()[0]
    n = total["engagedStudents"]
    total["averageAttempts"] = round(total["attempts"] / n, 2) if n else 0
    total["averageInteractions"] = round(total["interactions"] / n, 2) if n else 0
    total["currentUnitId"] = course["currentUnitId"]
    total["completedUnits"] = sum(u["status"] == "completed" for u in course["units"])
    total["totalUnits"] = len(course["units"])
    total["sources"] = [dict(r) for r in db.execute("""SELECT source,COUNT(*) sessions,
        SUM(interactions) interactions,SUM(codeRuns) codeRuns,SUM(aiQuestions) aiQuestions
        FROM learning_sessions WHERE classId=? GROUP BY source""", (class_id,))]
    return total


def filters(args):
    sql, params = ["s.classId=?"], [args["classId"]]
    for key in ("studentId", "unitId", "assignmentId", "questionId", "kind", "source", "materialId"):
        if args.get(key):
            sql.append(f"s.{key}=?")
            params.append(
                "" if key == "unitId" and args[key] == "unattributed" else args[key]
            )
    if args.get("search"):
        sql.append(
            "(instr(lower(s.studentName),lower(?))>0 OR instr(lower(s.studentId),lower(?))>0)"
        )
        params.extend([args["search"][:100]] * 2)
    if args.get("active") == "7d":
        sql.append("s.lastActive>=?")
        params.append(
            (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(
                timespec="seconds"
            )
        )
    activity = {
        "attempts": "s.attempts>0",
        "runs": "s.codeRuns>0",
        "questions": "s.aiQuestions>0",
        "errors": "s.codeErrors>0",
        "success": "s.codeSuccesses>0",
        "unknown": "s.codeRuns>s.codeErrors+s.codeSuccesses",
        "reading": "s.kind='reading'",
    }
    if args.get("activity") in activity:
        sql.append(activity[args["activity"]])
    if args.get("published") == "homework":
        sql.append(
            "EXISTS(SELECT 1 FROM assignments a WHERE a.class_id=s.classId AND a.id=s.assignmentId AND a.kind='homework' AND a.status='published')"
        )
    return " AND ".join(sql), params


def table(db, args):
    group = args.get("group", "students")
    if group not in ("students", "sessions", "questions", "topics", "assignments", "materials"):
        raise ValueError("Unsupported table view")
    page, size = max(int(args.get("page", "1")), 1), min(
        max(int(args.get("pageSize", "25")), 1), 100
    )
    where, params = filters(args)
    common = ",".join(f"COALESCE(SUM(s.{c}),0) {c}" for c in COUNTERS)
    keys = {
        "students": ("s.studentId", "s.studentName"),
        "sessions": ("s.id", "s.title"),
        "questions": ("s.unitId,s.assignmentId,s.questionId", "MAX(s.title)"),
        "topics": ("s.unitId", "s.unitId"),
        "assignments": ("s.assignmentId", "COALESCE(a.title,'Unassigned practice')"),
        "materials": ("s.materialId", "COALESCE(m.title,s.materialId)"),
    }
    key, label = keys[group]
    extra = ""
    if group == "questions":
        extra = " AND s.questionId!=''"
    if group == "assignments":
        extra = " AND s.assignmentId!=''"
    if group == "materials":
        extra = " AND s.materialId!=''"
    if group == "sessions":
        base = f"SELECT s.*,1 students,1 sessions,CASE WHEN s.checked>0 THEN 100.0*s.correct/s.checked ELSE NULL END accuracy,1.0*s.attempts averageAttempts,1.0*s.aiQuestions averageQuestions FROM learning_sessions s WHERE {where}{extra}"
    else:
        base = f"""SELECT {key}, {label} label,{common},COUNT(DISTINCT s.studentId) students,COUNT(*) sessions,
            MAX(s.lastActive) lastActive,100.0*SUM(s.correct)/NULLIF(SUM(s.checked),0) accuracy,
            1.0*SUM(s.attempts)/NULLIF(COUNT(DISTINCT s.studentId),0) averageAttempts,
            1.0*SUM(s.aiQuestions)/NULLIF(COUNT(DISTINCT s.studentId),0) averageQuestions
            FROM learning_sessions s LEFT JOIN assignments a ON a.id=s.assignmentId AND a.class_id=s.classId
            LEFT JOIN kiwi_materials m ON m.id=s.materialId AND m.class_id=s.classId
            WHERE {where}{extra} GROUP BY {key}"""
    # Include enrolled, inactive students, without inventing activity or correctness.
    if group == "students" and not any(
        args.get(k)
        for k in (
            "unitId",
            "assignmentId",
            "questionId",
            "kind",
            "active",
            "activity",
            "published",
            "source",
            "materialId",
        )
    ):
        roster_where = "r.class_id=?"
        roster_params = [args["classId"]]
        if args.get("studentId"):
            roster_where += " AND r.student_id=?"
            roster_params.append(args["studentId"])
        if args.get("search"):
            roster_where += "(PLACEHOLDER)"
            roster_where = roster_where.replace(
                "(PLACEHOLDER)",
                " AND (instr(lower(r.student_name),lower(?))>0 OR instr(lower(r.student_id),lower(?))>0)",
            )
            roster_params += [args["search"][:100]] * 2
        base += f""" UNION ALL SELECT r.student_id studentId,r.student_name label,{','.join('0' for _ in COUNTERS)},0 students,0 sessions,
            NULL lastActive,NULL accuracy,0 averageAttempts,0 averageQuestions FROM roster r WHERE {roster_where}
            AND NOT EXISTS(SELECT 1 FROM learning_sessions s WHERE s.classId=r.class_id AND s.studentId=r.student_id)"""
        params += roster_params
    if (
        group == "assignments"
        and args.get("published") == "homework"
        and not any(
            args.get(k)
            for k in (
                "studentId",
                "unitId",
                "questionId",
                "kind",
                "active",
                "activity",
                "search",
                "source",
                "materialId",
            )
        )
    ):
        assignment_clause = " AND a.id=?" if args.get("assignmentId") else ""
        base += f""" UNION ALL SELECT a.id assignmentId,a.title label,{','.join('0' for _ in COUNTERS)},0 students,0 sessions,
            NULL lastActive,NULL accuracy,0 averageAttempts,0 averageQuestions FROM assignments a
            WHERE a.class_id=? AND a.status='published' AND a.kind='homework'{assignment_clause}
            AND NOT EXISTS(SELECT 1 FROM learning_sessions s WHERE s.classId=a.class_id AND s.assignmentId=a.id)"""
        params += [args["classId"]] + (
            [args["assignmentId"]] if args.get("assignmentId") else []
        )
    count = db.execute(f"SELECT COUNT(*) FROM ({base})", params).fetchone()[0]
    sort = args.get("sort", "lastActive")
    allowed = {
        *COUNTERS,
        "lastActive",
        "accuracy",
        "averageAttempts",
        "averageQuestions",
        "sessions",
        "students",
        "label",
        "codeSuccesses",
    }
    if sort not in allowed:
        raise ValueError("Unsupported sort column")
    if group == "sessions" and sort == "label":
        sort = "title"
    direction = "ASC" if args.get("direction") == "asc" else "DESC"
    tie = (
        "id"
        if group == "sessions"
        else (
            "studentId"
            if group == "students"
            else (
                "unitId,assignmentId,questionId"
                if group == "questions"
                else "unitId" if group == "topics" else "materialId" if group == "materials" else "assignmentId"
            )
        )
    )
    order_column = sort
    rows = db.execute(
        f"SELECT * FROM ({base}) ORDER BY {order_column} {direction} NULLS LAST,{tie} LIMIT ? OFFSET ?",
        [*params, size, (page - 1) * size],
    ).fetchall()
    return {
        "rows": [dict(r) for r in rows],
        "total": count,
        "page": page,
        "pageSize": size,
    }


def session_events(db, class_id, sid, before=0):
    session = db.execute(
        "SELECT * FROM learning_sessions WHERE classId=? AND id=?", (class_id, sid)
    ).fetchone()
    if not session:
        raise ValueError("Session not found")
    cursor_time = ""
    if before:
        cursor = db.execute("SELECT created_at FROM events WHERE class_id=? AND learning_session_id=? AND id=?", (class_id, sid, before)).fetchone()
        if not cursor:
            raise ValueError("Session event cursor is invalid")
        cursor_time = cursor[0]
    rows = db.execute(
        "SELECT * FROM events WHERE class_id=? AND learning_session_id=? AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT 101",
        (class_id, sid, cursor_time, before),
    ).fetchall()
    events = [
        {
            "id": r["id"],
            "type": r["event_type"],
            "createdAt": r["created_at"],
            "source": r["source"],
            "upstreamId": r["upstream_id"],
            "payload": json.loads(r["payload_json"]),
        }
        for r in rows[:100]
    ]
    return {"session": dict(session), "events": events, "hasMore": len(rows) > 100}


def question_theme(prompt):
    text = str(prompt or "").casefold()
    rules = (
        ("Missing values", r"\bna\b|missing|na\.rm|is\.na"),
        ("Indexing", r"index|subscript|bracket|one.based"),
        ("Joins and keys", r"\bjoin|\bmerge|tailnum|join.*key"),
        ("Filtering and conditions", r"\bfilter|logical|condition|subset"),
        ("Means and grouped summaries", r"\bmean\b|average|aggregate|group|sum\("),
        ("Data types and import", r"\bimport|\bcsv|read\.|numeric|character|data type"),
        ("Text preprocessing", r"\btoken|stop.?word|lowercase|corpus|lyrics"),
        ("Networks", r"\bedge|\bnode|degree|reciproc|network"),
        ("R errors and debugging", r"\berror|not found|unexpected|debug"),
    )
    return next((label for label, pattern in rules if re.search(pattern, text)), None)


def evidence(db, args):
    db.create_function("question_theme", 1, question_theme)
    db.create_function(
        "normalize_question",
        1,
        lambda text: " ".join(str(text or "").casefold().split()),
    )
    where, params = filters(args)
    # Aggregate all matching answers; only the displayed evidence is paginated.
    distribution = db.execute(
        f"""SELECT json_extract(e.payload_json,'$.answer') answer,COUNT(*) attempts,
        COUNT(DISTINCT e.student_id) students FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id
        WHERE {where} AND e.event_type='answer_submitted' GROUP BY answer ORDER BY attempts DESC,answer LIMIT 50""",
        params,
    ).fetchall()
    common = db.execute(
        f"""SELECT normalize_question(json_extract(e.payload_json,'$.prompt')) normalized,
        MIN(json_extract(e.payload_json,'$.prompt')) prompt,COUNT(*) occurrences,COUNT(DISTINCT e.student_id) students
        FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id
        WHERE {where} AND e.event_type='ai_question' AND json_extract(e.payload_json,'$.ok') IS NOT 0
        GROUP BY normalized HAVING COUNT(DISTINCT e.student_id)>1 ORDER BY students DESC,occurrences DESC LIMIT 20""",
        params,
    ).fetchall()
    themes = db.execute(
        f"""SELECT question_theme(json_extract(e.payload_json,'$.prompt')) theme,
        COUNT(*) questions,COUNT(DISTINCT e.student_id) students FROM events e
        JOIN learning_sessions s ON s.id=e.learning_session_id WHERE {where} AND e.event_type='ai_question'
        AND json_extract(e.payload_json,'$.ok') IS NOT 0 GROUP BY theme
        HAVING theme IS NOT NULL AND COUNT(DISTINCT e.student_id)>1 ORDER BY students DESC,questions DESC LIMIT 10""",
        params,
    ).fetchall()
    shared = []
    for theme in themes:
        examples = db.execute(
            f"""SELECT e.student_name studentName,json_extract(e.payload_json,'$.prompt') prompt,s.id sessionId
            FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id WHERE {where}
            AND e.event_type='ai_question' AND question_theme(json_extract(e.payload_json,'$.prompt'))=?
            ORDER BY e.id DESC LIMIT 3""",
            [*params, theme["theme"]],
        ).fetchall()
        shared.append({**dict(theme), "examples": [dict(r) for r in examples]})
    after = max(int(args.get("beforeId", "0")), 0)
    raw = db.execute(
        f"""SELECT e.id,e.student_name studentName,e.created_at createdAt,e.payload_json,s.id sessionId
        FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id WHERE {where} AND e.event_type='ai_question'
        AND (?=0 OR e.id<?) ORDER BY e.id DESC LIMIT 26""",
        [*params, after, after],
    ).fetchall()
    questions = [
        {
            **{k: r[k] for k in ("id", "studentName", "createdAt", "sessionId")},
            "payload": json.loads(r["payload_json"]),
        }
        for r in raw[:25]
    ]
    distribution = [dict(r) for r in distribution]
    if args.get("questionId"):
        choices = []
        if args.get("assignmentId"):
            work = db.execute(
                "SELECT questions_json FROM assignments WHERE class_id=? AND id=?",
                (args["classId"], args["assignmentId"]),
            ).fetchone()
            if work:
                choices = next(
                    (
                        q.get("choices", [])
                        for q in json.loads(work[0])
                        if q["id"] == args["questionId"]
                    ),
                    [],
                )
        if not choices:
            generated = db.execute(
                "SELECT e.payload_json FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id WHERE s.classId=? AND s.questionId=? AND e.event_type='question_generated' ORDER BY e.id DESC LIMIT 1",
                (args["classId"], args["questionId"]),
            ).fetchone()
            if generated:
                choices = json.loads(generated[0]).get("choices", [])
        for choice in choices:
            if not any(d["answer"] == choice for d in distribution):
                distribution.append({"answer": choice, "attempts": 0, "students": 0})
    total_attempts = db.execute(
        f"SELECT COUNT(*) FROM events e JOIN learning_sessions s ON s.id=e.learning_session_id WHERE {where} AND e.event_type='answer_submitted'",
        params,
    ).fetchone()[0]
    for d in distribution:
        d["share"] = (
            round(100 * d["attempts"] / total_attempts, 1) if total_attempts else 0
        )
    return {
        "sharedTopics": shared,
        "distribution": distribution,
        "commonQuestions": [dict(r) for r in common],
        "questions": questions,
        "hasMore": len(raw) > 25,
    }
