"""Teacher-authored work, submissions, grading, and class analytics for the local pilot."""

from __future__ import annotations

import base64
import binascii
import json
import re
import sqlite3
import uuid
from datetime import datetime, timezone


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init(db: sqlite3.Connection) -> None:
    db.executescript("""
        CREATE TABLE IF NOT EXISTS assignments (
            id TEXT PRIMARY KEY, class_id TEXT NOT NULL, kind TEXT NOT NULL,
            title TEXT NOT NULL, unit_id TEXT NOT NULL, instructions TEXT NOT NULL,
            due_at TEXT, status TEXT NOT NULL, questions_json TEXT NOT NULL,
            file_name TEXT, file_type TEXT, file_data BLOB,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_work_class ON assignments(class_id, status, created_at);
        CREATE TABLE IF NOT EXISTS submissions (
            id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, class_id TEXT NOT NULL,
            student_id TEXT NOT NULL, student_name TEXT NOT NULL, attempt INTEGER NOT NULL,
            answers_json TEXT NOT NULL, submitted_at TEXT NOT NULL,
            grade REAL, feedback TEXT, graded_at TEXT,
            FOREIGN KEY(assignment_id) REFERENCES assignments(id)
        );
        CREATE INDEX IF NOT EXISTS idx_submissions_work ON submissions(class_id, assignment_id, student_id, attempt);
        CREATE TABLE IF NOT EXISTS submission_requests (
            class_id TEXT NOT NULL,assignment_id TEXT NOT NULL,student_id TEXT NOT NULL,
            request_id TEXT NOT NULL,submission_id TEXT NOT NULL,
            PRIMARY KEY(class_id,assignment_id,student_id,request_id)
        );
        CREATE TABLE IF NOT EXISTS roster (
            class_id TEXT NOT NULL, student_id TEXT NOT NULL, student_name TEXT NOT NULL,
            PRIMARY KEY(class_id, student_id)
        );
    """)


def _validate_text(value: object, label: str, maximum: int, minimum: int = 0) -> str:
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise ValueError(f"{label} must contain {minimum}–{maximum} characters")
    return value.strip()


def validate_work(data: object, valid_id) -> dict:
    if not isinstance(data, dict):
        raise ValueError("Invalid assignment format")
    kind = data.get("kind")
    if kind not in ("practice", "homework"):
        raise ValueError("Kind must be practice or homework")
    title = _validate_text(data.get("title"), "Title", 120, 1)
    unit_id = data.get("unitId")
    if not valid_id(unit_id):
        raise ValueError("Invalid chapter ID")
    instructions = _validate_text(data.get("instructions", ""), "Instructions", 12000)
    due_at = data.get("dueAt") or None
    if due_at is not None:
        if not isinstance(due_at, str):
            raise ValueError("Invalid due date")
        try:
            datetime.fromisoformat(due_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Invalid due date") from exc
    questions = data.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 30:
        raise ValueError("An assignment needs 1–30 questions")
    clean = []
    seen = set()
    for q in questions:
        if not isinstance(q, dict):
            raise ValueError("Invalid question format")
        qid = q.get("id") or f"q-{uuid.uuid4().hex[:12]}"
        if not valid_id(qid) or qid in seen:
            raise ValueError("Question ID is invalid or duplicated")
        seen.add(qid)
        qtype = q.get("type")
        if qtype not in ("choice", "fill", "predict", "complete", "text"):
            raise ValueError("Unsupported question type")
        points = q.get("points", 10)
        if (
            not isinstance(points, (int, float))
            or isinstance(points, bool)
            or not 0 < points <= 100
        ):
            raise ValueError("Points must be greater than 0 and no more than 100")
        choices = q.get("choices", [])
        if (
            not isinstance(choices, list)
            or len(choices) > 8
            or any(not isinstance(c, str) or len(c) > 300 for c in choices)
        ):
            raise ValueError("Invalid choices")
        if qtype == "choice" and len(choices) < 2:
            raise ValueError("Multiple choice questions need at least two options")
        clean.append(
            {
                "id": qid,
                "type": qtype,
                "prompt": _validate_text(q.get("prompt"), "Question prompt", 4000, 1),
                "points": points,
                "choices": choices,
                "starterCode": _validate_text(
                    q.get("starterCode", ""), "Starter code", 12000
                ),
                "answer": _validate_text(
                    q.get("answer", ""), "Reference answer", 12000
                ),
                "explanation": _validate_text(
                    q.get("explanation", ""), "Explanation", 4000
                ),
            }
        )
    if kind == "practice" and any(not q["answer"] for q in clean):
        raise ValueError("Practice questions require a reference answer")
    if kind == "practice" and any(
        q["type"] == "choice" and q["answer"] not in q["choices"] for q in clean
    ):
        raise ValueError("Reference answer must match a choice")
    attachment = data.get("attachment")
    file_name = file_type = file_data = None
    if attachment is not None:
        if not isinstance(attachment, dict):
            raise ValueError("Invalid attachment format")
        file_name = _validate_text(attachment.get("name"), "File name", 180, 1)
        file_type = _validate_text(
            attachment.get("type", "application/octet-stream"), "File type", 120, 1
        )
        if not re.search(r"\.(qmd|md|txt|pdf|csv|r|rds|zip)$", file_name, re.I):
            raise ValueError(
                "Supported attachments: qmd, md, txt, pdf, csv, R, rds, zip"
            )
        try:
            file_data = base64.b64decode(attachment.get("data", ""), validate=True)
        except (ValueError, TypeError, binascii.Error) as exc:
            raise ValueError("Invalid attachment encoding") from exc
        if not file_data or len(file_data) > 3_000_000:
            raise ValueError("Attachment must be smaller than 3 MB")
    return {
        "kind": kind,
        "title": title,
        "unit_id": unit_id,
        "instructions": instructions,
        "due_at": due_at,
        "questions": clean,
        "file_name": file_name,
        "file_type": file_type,
        "file_data": file_data,
    }


def serialize_work(row: sqlite3.Row, teacher: bool = False) -> dict:
    questions = json.loads(row["questions_json"])
    if not teacher:
        questions = [
            {
                key: value
                for key, value in q.items()
                if key not in ("answer", "explanation")
            }
            for q in questions
        ]
    return {
        "id": row["id"],
        "classId": row["class_id"],
        "kind": row["kind"],
        "title": row["title"],
        "unitId": row["unit_id"],
        "instructions": row["instructions"],
        "dueAt": row["due_at"],
        "status": row["status"],
        "questions": questions,
        "attachmentName": row["file_name"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def list_work(
    db: sqlite3.Connection, class_id: str, teacher: bool = False
) -> list[dict]:
    sql = "SELECT * FROM assignments WHERE class_id=?"
    if not teacher:
        sql += " AND status='published'"
    sql += " ORDER BY created_at DESC, id DESC"
    return [
        serialize_work(row, teacher) for row in db.execute(sql, (class_id,)).fetchall()
    ]


def get_work(db: sqlite3.Connection, class_id: str, work_id: str) -> sqlite3.Row:
    row = db.execute(
        "SELECT * FROM assignments WHERE class_id=? AND id=?", (class_id, work_id)
    ).fetchone()
    if row is None:
        raise ValueError("Assignment not found")
    return row


def save_work(
    db: sqlite3.Connection,
    class_id: str,
    data: object,
    valid_id,
    work_id: str | None = None,
) -> dict:
    clean = validate_work(data, valid_id)
    if (
        not work_id
        and isinstance(data, dict)
        and data.get("attachmentSourceId")
        and not clean["file_data"]
    ):
        if not valid_id(data["attachmentSourceId"]):
            raise ValueError("Invalid revision source ID")
        source = get_work(db, class_id, data["attachmentSourceId"])
        for field in ("file_name", "file_type", "file_data"):
            clean[field] = source[field]
    if work_id:
        old = get_work(db, class_id, work_id)
        if (
            old["status"] == "published"
            and db.execute(
                "SELECT 1 FROM submissions WHERE assignment_id=? LIMIT 1", (work_id,)
            ).fetchone()
        ):
            raise ValueError(
                "This assignment has submissions. Create a revision to preserve questions and grades."
            )
        file_name = clean["file_name"] if clean["file_data"] else old["file_name"]
        file_type = clean["file_type"] if clean["file_data"] else old["file_type"]
        file_data = clean["file_data"] if clean["file_data"] else old["file_data"]
        db.execute(
            """UPDATE assignments SET kind=?,title=?,unit_id=?,instructions=?,due_at=?,questions_json=?,
            file_name=?,file_type=?,file_data=?,updated_at=? WHERE id=? AND class_id=?""",
            (
                clean["kind"],
                clean["title"],
                clean["unit_id"],
                clean["instructions"],
                clean["due_at"],
                json.dumps(clean["questions"], ensure_ascii=False),
                file_name,
                file_type,
                file_data,
                now(),
                work_id,
                class_id,
            ),
        )
    else:
        work_id = f"work-{uuid.uuid4().hex[:16]}"
        db.execute(
            """INSERT INTO assignments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                work_id,
                class_id,
                clean["kind"],
                clean["title"],
                clean["unit_id"],
                clean["instructions"],
                clean["due_at"],
                "draft",
                json.dumps(clean["questions"], ensure_ascii=False),
                clean["file_name"],
                clean["file_type"],
                clean["file_data"],
                now(),
                now(),
            ),
        )
    return serialize_work(get_work(db, class_id, work_id), True)


def set_status(
    db: sqlite3.Connection, class_id: str, work_id: str, status: object
) -> dict:
    if status not in ("draft", "published"):
        raise ValueError("Invalid publication status")
    row = get_work(db, class_id, work_id)
    if (
        status == "draft"
        and row["status"] == "published"
        and db.execute(
            "SELECT 1 FROM submissions WHERE assignment_id=? LIMIT 1", (work_id,)
        ).fetchone()
    ):
        raise ValueError("Assignments with submissions cannot be unpublished")
    db.execute(
        "UPDATE assignments SET status=?,updated_at=? WHERE id=?",
        (status, now(), work_id),
    )
    return serialize_work(get_work(db, class_id, work_id), True)


def _student_fields(data: object, valid_id) -> tuple[str, str]:
    if not isinstance(data, dict) or not valid_id(data.get("studentId")):
        raise ValueError("studentId has an invalid format")
    return data["studentId"], _validate_text(
        data.get("studentName"), "Student name", 100, 1
    )


def submit(
    db: sqlite3.Connection, class_id: str, work_id: str, data: object, valid_id
) -> dict:
    row = get_work(db, class_id, work_id)
    if row["status"] != "published" or row["kind"] != "homework":
        raise ValueError("Homework is not published")
    student_id, student_name = _student_fields(data, valid_id)
    answers = data.get("answers")
    question_ids = {q["id"] for q in json.loads(row["questions_json"])}
    if (
        not isinstance(answers, dict)
        or set(answers) != question_ids
        or any(
            not isinstance(value, str) or not value.strip()
            for value in answers.values()
        )
    ):
        raise ValueError("Complete every question before submitting")
    if any(
        not isinstance(value, str) or len(value) > 16000 for value in answers.values()
    ):
        raise ValueError("Answer format is invalid or too long")
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    request_id = data.get("requestId")
    if request_id is not None:
        if not valid_id(request_id):
            raise ValueError("Invalid submission request ID")
        existing = db.execute(
            "SELECT s.* FROM submission_requests r JOIN submissions s ON s.id=r.submission_id WHERE r.class_id=? AND r.assignment_id=? AND r.student_id=? AND r.request_id=?",
            (class_id, work_id, student_id, request_id),
        ).fetchone()
        if existing:
            if json.loads(existing["answers_json"]) != answers:
                raise ValueError(
                    "A submission request ID cannot be reused for different answers"
                )
            return {
                "id": existing["id"],
                "assignmentId": work_id,
                "attempt": existing["attempt"],
                "submittedAt": existing["submitted_at"],
                "replayed": True,
            }
    attempt = (
        db.execute(
            "SELECT COUNT(*) FROM submissions WHERE assignment_id=? AND student_id=?",
            (work_id, student_id),
        ).fetchone()[0]
        + 1
    )
    submission_id = f"sub-{uuid.uuid4().hex[:16]}"
    timestamp = now()
    db.execute(
        "INSERT INTO submissions (id,assignment_id,class_id,student_id,student_name,attempt,answers_json,submitted_at) VALUES (?,?,?,?,?,?,?,?)",
        (
            submission_id,
            work_id,
            class_id,
            student_id,
            student_name,
            attempt,
            json.dumps(answers, ensure_ascii=False),
            timestamp,
        ),
    )
    if request_id:
        db.execute(
            "INSERT INTO submission_requests VALUES (?,?,?,?,?)",
            (class_id, work_id, student_id, request_id, submission_id),
        )
    return {
        "id": submission_id,
        "assignmentId": work_id,
        "attempt": attempt,
        "submittedAt": timestamp,
    }


def list_submissions(
    db: sqlite3.Connection,
    class_id: str,
    teacher: bool,
    student_id: str | None = None,
    assignment_id: str | None = None,
) -> list[dict]:
    sql = "SELECT s.* FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.class_id=?"
    params = [class_id]
    if not teacher:
        sql += " AND s.student_id=? AND a.status='published'"
        params.append(student_id)
    if assignment_id:
        sql += " AND s.assignment_id=?"
        params.append(assignment_id)
    sql += " ORDER BY s.submitted_at DESC, s.attempt DESC, s.id DESC"
    if assignment_id:
        sql += " LIMIT 100"
    rows = db.execute(sql, params).fetchall()
    return [
        {
            "id": r["id"],
            "assignmentId": r["assignment_id"],
            "studentId": r["student_id"],
            "studentName": r["student_name"],
            "attempt": r["attempt"],
            "answers": json.loads(r["answers_json"]),
            "submittedAt": r["submitted_at"],
            "grade": r["grade"],
            "feedback": r["feedback"],
            "gradedAt": r["graded_at"],
        }
        for r in rows
    ]


def grade(
    db: sqlite3.Connection, class_id: str, submission_id: str, data: object
) -> dict:
    if not isinstance(data, dict):
        raise ValueError("Invalid grade format")
    row = db.execute(
        """SELECT s.*,a.questions_json FROM submissions s JOIN assignments a ON a.id=s.assignment_id
        WHERE s.id=? AND s.class_id=?""",
        (submission_id, class_id),
    ).fetchone()
    if not row:
        raise ValueError("Submission not found")
    maximum = sum(q["points"] for q in json.loads(row["questions_json"]))
    score = data.get("grade")
    if (
        not isinstance(score, (int, float))
        or isinstance(score, bool)
        or not 0 <= score <= maximum
    ):
        raise ValueError(f"Score must be between 0 and {maximum}")
    feedback = _validate_text(data.get("feedback", ""), "Feedback", 4000)
    db.execute(
        "UPDATE submissions SET grade=?,feedback=?,graded_at=? WHERE id=?",
        (score, feedback, now(), submission_id),
    )
    return {
        "id": submission_id,
        "grade": score,
        "feedback": feedback,
        "maxPoints": maximum,
        "gradedAt": now(),
    }


def check_practice(
    db: sqlite3.Connection, class_id: str, work_id: str, data: object, valid_id
) -> dict:
    row = get_work(db, class_id, work_id)
    if row["status"] != "published" or row["kind"] != "practice":
        raise ValueError("Practice is not published")
    _student_fields(data, valid_id)
    q = next(
        (
            q
            for q in json.loads(row["questions_json"])
            if q["id"] == data.get("questionId")
        ),
        None,
    )
    if not q:
        raise ValueError("Question not found")
    answer = data.get("answer")
    if not isinstance(answer, str) or len(answer) > 16000:
        raise ValueError("Invalid answer format")

    def normalize(value: str) -> str:
        return re.sub(
            r"\s+", "", re.sub(r"^\[1\]\s*", "", value.strip().casefold()).strip("\"'")
        )

    expected = normalize(q["answer"])
    actual = normalize(answer)
    correct = bool(expected) and actual == expected
    if q["type"] == "complete" and isinstance(data.get("runOutput"), str):
        correct = (
            bool(expected)
            and normalize(
                data["runOutput"].splitlines()[-1]
                if data["runOutput"].splitlines()
                else ""
            )
            == expected
        )
    return {
        "correct": correct,
        "explanation": (
            q["explanation"]
            if correct
            else "Check the output against the question and try again."
        ),
    }


def hub(db: sqlite3.Connection, class_id: str) -> dict:
    assignments = db.execute(
        "SELECT id,title FROM assignments WHERE class_id=? AND kind='homework' AND status='published' ORDER BY created_at,id",
        (class_id,),
    ).fetchall()
    student_map: dict[str, dict] = {}

    def student(sid: str, name: str) -> dict:
        return student_map.setdefault(
            sid,
            {
                "studentId": sid,
                "studentName": name,
                "scoreByAssignment": {},
                "attemptsByAssignment": {},
                "interactions": 0,
                "learningSeconds": 0,
                "freePracticeCount": 0,
                "codeRuns": 0,
                "aiQuestions": 0,
                "lastActive": None,
            },
        )

    for row in db.execute(
        "SELECT student_id,student_name FROM roster WHERE class_id=?", (class_id,)
    ):
        student(row["student_id"], row["student_name"])
    # Aggregate in SQL instead of loading every code snapshot and AI response.
    for row in db.execute(
        """SELECT studentId,MAX(studentName) studentName,SUM(interactions) interactions,
        SUM(codeRuns) codeRuns,SUM(aiQuestions) aiQuestions,MAX(lastActive) lastActive
        FROM learning_sessions WHERE classId=? GROUP BY studentId""",
        (class_id,),
    ):
        item = student(row["studentId"], row["studentName"])
        for field in ("interactions", "codeRuns", "aiQuestions", "lastActive"):
            item[field] = row[field]
    for row in db.execute(
        """SELECT student_id,MAX(student_name) student_name,
        SUM(CASE WHEN event_type='study_heartbeat' AND json_type(payload_json,'$.seconds') IN ('integer','real')
            THEN min(max(CAST(json_extract(payload_json,'$.seconds') AS INTEGER),0),60) ELSE 0 END) seconds,
        SUM(CASE WHEN event_type='question_generated' THEN 1 ELSE 0 END) generated
        FROM events WHERE class_id=? AND event_type IN ('study_heartbeat','question_generated') GROUP BY student_id""",
        (class_id,),
    ):
        item = student(row["student_id"], row["student_name"])
        item["learningSeconds"] = row["seconds"]
        item["freePracticeCount"] = row["generated"]
    for row in db.execute(
        """SELECT student_id,MAX(student_name) student_name,assignment_id,COUNT(*) attempts,
        MAX(submitted_at) last_active FROM submissions WHERE class_id=? GROUP BY student_id,assignment_id""",
        (class_id,),
    ):
        item = student(row["student_id"], row["student_name"])
        item["attemptsByAssignment"][row["assignment_id"]] = row["attempts"]
        item["lastActive"] = max(item["lastActive"] or "", row["last_active"])
    for row in db.execute(
        """SELECT student_id,student_name,assignment_id,grade FROM
        (SELECT student_id,student_name,assignment_id,grade,ROW_NUMBER() OVER
          (PARTITION BY student_id,assignment_id ORDER BY attempt DESC,submitted_at DESC,id DESC) rn
          FROM submissions WHERE class_id=? AND grade IS NOT NULL) WHERE rn=1""",
        (class_id,),
    ):
        student(row["student_id"], row["student_name"])["scoreByAssignment"][
            row["assignment_id"]
        ] = row["grade"]
    return {
        "assignments": [dict(a) for a in assignments],
        "students": sorted(
            student_map.values(), key=lambda x: x["studentName"].lower()
        ),
    }


def import_roster(
    db: sqlite3.Connection, class_id: str, data: object, valid_id
) -> dict:
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("students"), list)
        or not 1 <= len(data["students"]) <= 500
    ):
        raise ValueError("Import 1–500 students at a time")
    for row in data["students"]:
        if not isinstance(row, dict) or not valid_id(row.get("studentId")):
            raise ValueError("Invalid student ID")
        name = _validate_text(row.get("studentName"), "Student name", 100, 1)
        db.execute(
            "INSERT INTO roster VALUES (?,?,?) ON CONFLICT(class_id,student_id) DO UPDATE SET student_name=excluded.student_name",
            (class_id, row["studentId"], name),
        )
    return {"count": len(data["students"])}


def work_options(db, class_id, teacher=False):
    condition = "" if teacher else " AND a.status='published'"
    rows = db.execute(
        f"""SELECT a.id,a.title,a.kind,a.unit_id unitId,a.status,a.due_at dueAt,
        json_array_length(a.questions_json) questionCount,
        EXISTS(SELECT 1 FROM submissions s WHERE s.assignment_id=a.id) hasSubmissions
        FROM assignments a WHERE a.class_id=?{condition} ORDER BY a.created_at DESC,a.id DESC""",
        (class_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def work_page(db, class_id, args):
    """Read only the question and answer bodies needed for this authoring/grading page."""
    page = max(int(args.get("page", "1")), 1)
    search = args.get("search", "")[:120]
    view = args.get("view", "assignments")
    if view == "grading":
        size = 10
        where = "s.class_id=?"
        params = [class_id]
        if search:
            where += " AND (instr(lower(s.student_name),lower(?))>0 OR instr(lower(s.student_id),lower(?))>0)"
            params += [search, search]
        if args.get("assignmentId"):
            where += " AND s.assignment_id=?"
            params.append(args["assignmentId"])
        if args.get("status") == "ungraded":
            where += " AND s.grade IS NULL"
        total = db.execute(
            f"SELECT COUNT(*) FROM submissions s WHERE {where}", params
        ).fetchone()[0]
        rows = db.execute(
            f"SELECT s.* FROM submissions s WHERE {where} ORDER BY submitted_at DESC,attempt DESC,id DESC LIMIT ? OFFSET ?",
            [*params, size, (page - 1) * size],
        ).fetchall()
        subs = [
            {
                "id": r["id"],
                "assignmentId": r["assignment_id"],
                "studentId": r["student_id"],
                "studentName": r["student_name"],
                "attempt": r["attempt"],
                "answers": json.loads(r["answers_json"]),
                "submittedAt": r["submitted_at"],
                "grade": r["grade"],
                "feedback": r["feedback"],
                "gradedAt": r["graded_at"],
            }
            for r in rows
        ]
        work_ids = list({r["assignment_id"] for r in rows})
        works = (
            [
                serialize_work(r, True)
                for r in db.execute(
                    f"SELECT * FROM assignments WHERE class_id=? AND id IN ({','.join('?' for _ in work_ids)})",
                    [class_id, *work_ids],
                ).fetchall()
            ]
            if work_ids
            else []
        )
    elif view == "assignments":
        size = 20
        where = "a.class_id=?"
        params = [class_id]
        if search:
            where += " AND instr(lower(a.title),lower(?))>0"
            params.append(search)
        if args.get("status") in ("draft", "published"):
            where += " AND a.status=?"
            params.append(args["status"])
        total = db.execute(
            f"SELECT COUNT(*) FROM assignments a WHERE {where}", params
        ).fetchone()[0]
        rows = db.execute(
            f"SELECT a.* FROM assignments a WHERE {where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
            [*params, size, (page - 1) * size],
        ).fetchall()
        works = [serialize_work(r, True) for r in rows]
        subs = []
    else:
        raise ValueError("Unsupported work page")
    return {
        "assignments": works,
        "submissions": subs,
        "options": work_options(db, class_id, True),
        "page": page,
        "pageSize": size,
        "total": total,
    }
