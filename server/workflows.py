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
        CREATE TABLE IF NOT EXISTS roster (
            class_id TEXT NOT NULL, student_id TEXT NOT NULL, student_name TEXT NOT NULL,
            PRIMARY KEY(class_id, student_id)
        );
    """)


def _validate_text(value: object, label: str, maximum: int, minimum: int = 0) -> str:
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise ValueError(f"{label} 长度需为 {minimum}–{maximum} 字符")
    return value.strip()


def validate_work(data: object, valid_id) -> dict:
    if not isinstance(data, dict):
        raise ValueError("作业格式不正确")
    kind = data.get("kind")
    if kind not in ("practice", "homework"):
        raise ValueError("类型须为练习或作业")
    title = _validate_text(data.get("title"), "标题", 120, 1)
    unit_id = data.get("unitId")
    if not valid_id(unit_id):
        raise ValueError("单元 ID 不正确")
    instructions = _validate_text(data.get("instructions", ""), "说明", 12000)
    due_at = data.get("dueAt") or None
    if due_at is not None:
        if not isinstance(due_at, str):
            raise ValueError("截止时间格式不正确")
        try:
            datetime.fromisoformat(due_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("截止时间格式不正确") from exc
    questions = data.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 30:
        raise ValueError("需要 1–30 道题")
    clean = []
    seen = set()
    for q in questions:
        if not isinstance(q, dict):
            raise ValueError("题目格式不正确")
        qid = q.get("id") or f"q-{uuid.uuid4().hex[:12]}"
        if not valid_id(qid) or qid in seen:
            raise ValueError("题目 ID 不正确或重复")
        seen.add(qid)
        qtype = q.get("type")
        if qtype not in ("choice", "fill", "predict", "complete", "text"):
            raise ValueError("不支持的题型")
        points = q.get("points", 10)
        if not isinstance(points, (int, float)) or isinstance(points, bool) or not 0 < points <= 100:
            raise ValueError("分值需为 0–100")
        choices = q.get("choices", [])
        if not isinstance(choices, list) or len(choices) > 8 or any(not isinstance(c, str) or len(c) > 300 for c in choices):
            raise ValueError("选项格式不正确")
        if qtype == "choice" and len(choices) < 2:
            raise ValueError("选择题至少需要两个选项")
        clean.append({
            "id": qid, "type": qtype,
            "prompt": _validate_text(q.get("prompt"), "题干", 4000, 1),
            "points": points, "choices": choices,
            "starterCode": _validate_text(q.get("starterCode", ""), "起始代码", 12000),
            "answer": _validate_text(q.get("answer", ""), "参考答案", 12000),
            "explanation": _validate_text(q.get("explanation", ""), "解析", 4000),
        })
    if kind == "practice" and any(not q["answer"] for q in clean):
        raise ValueError("练习题需填写参考答案才能检查")
    if kind == "practice" and any(q["type"] == "choice" and q["answer"] not in q["choices"] for q in clean):
        raise ValueError("选择题参考答案必须是一个选项")
    attachment = data.get("attachment")
    file_name = file_type = file_data = None
    if attachment is not None:
        if not isinstance(attachment, dict):
            raise ValueError("附件格式不正确")
        file_name = _validate_text(attachment.get("name"), "文件名", 180, 1)
        file_type = _validate_text(attachment.get("type", "application/octet-stream"), "文件类型", 120, 1)
        if not re.search(r"\.(qmd|md|txt|pdf|csv|r|rds|zip)$", file_name, re.I):
            raise ValueError("附件仅支持 qmd、md、txt、pdf、csv、R、rds、zip")
        try:
            file_data = base64.b64decode(attachment.get("data", ""), validate=True)
        except (ValueError, TypeError, binascii.Error) as exc:
            raise ValueError("附件编码不正确") from exc
        if not file_data or len(file_data) > 3_000_000:
            raise ValueError("附件需小于 3 MB")
    return {"kind": kind, "title": title, "unit_id": unit_id,
            "instructions": instructions, "due_at": due_at, "questions": clean,
            "file_name": file_name, "file_type": file_type, "file_data": file_data}


def serialize_work(row: sqlite3.Row, teacher: bool = False) -> dict:
    questions = json.loads(row["questions_json"])
    if not teacher:
        questions = [{key: value for key, value in q.items() if key not in ("answer", "explanation")} for q in questions]
    return {"id": row["id"], "classId": row["class_id"], "kind": row["kind"],
            "title": row["title"], "unitId": row["unit_id"], "instructions": row["instructions"],
            "dueAt": row["due_at"], "status": row["status"], "questions": questions,
            "attachmentName": row["file_name"], "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def list_work(db: sqlite3.Connection, class_id: str, teacher: bool = False) -> list[dict]:
    sql = "SELECT * FROM assignments WHERE class_id=?"
    if not teacher:
        sql += " AND status='published'"
    sql += " ORDER BY created_at DESC, id DESC"
    return [serialize_work(row, teacher) for row in db.execute(sql, (class_id,)).fetchall()]


def get_work(db: sqlite3.Connection, class_id: str, work_id: str) -> sqlite3.Row:
    row = db.execute("SELECT * FROM assignments WHERE class_id=? AND id=?", (class_id, work_id)).fetchone()
    if row is None:
        raise ValueError("作业不存在")
    return row


def save_work(db: sqlite3.Connection, class_id: str, data: object, valid_id, work_id: str | None = None) -> dict:
    clean = validate_work(data, valid_id)
    if work_id:
        old = get_work(db, class_id, work_id)
        if old["status"] == "published" and db.execute("SELECT 1 FROM submissions WHERE assignment_id=? LIMIT 1", (work_id,)).fetchone():
            raise ValueError("已有学生提交，不能修改题目；请创建新作业")
        file_name = clean["file_name"] if clean["file_data"] else old["file_name"]
        file_type = clean["file_type"] if clean["file_data"] else old["file_type"]
        file_data = clean["file_data"] if clean["file_data"] else old["file_data"]
        db.execute("""UPDATE assignments SET kind=?,title=?,unit_id=?,instructions=?,due_at=?,questions_json=?,
            file_name=?,file_type=?,file_data=?,updated_at=? WHERE id=? AND class_id=?""",
            (clean["kind"], clean["title"], clean["unit_id"], clean["instructions"], clean["due_at"],
             json.dumps(clean["questions"], ensure_ascii=False), file_name, file_type, file_data, now(), work_id, class_id))
    else:
        work_id = f"work-{uuid.uuid4().hex[:16]}"
        db.execute("""INSERT INTO assignments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (work_id, class_id, clean["kind"], clean["title"], clean["unit_id"], clean["instructions"],
             clean["due_at"], "draft", json.dumps(clean["questions"], ensure_ascii=False),
             clean["file_name"], clean["file_type"], clean["file_data"], now(), now()))
    return serialize_work(get_work(db, class_id, work_id), True)


def set_status(db: sqlite3.Connection, class_id: str, work_id: str, status: object) -> dict:
    if status not in ("draft", "published"):
        raise ValueError("发布状态不正确")
    row = get_work(db, class_id, work_id)
    if status == "draft" and row["status"] == "published" and db.execute("SELECT 1 FROM submissions WHERE assignment_id=? LIMIT 1", (work_id,)).fetchone():
        raise ValueError("已有提交的作业不能撤回")
    db.execute("UPDATE assignments SET status=?,updated_at=? WHERE id=?", (status, now(), work_id))
    return serialize_work(get_work(db, class_id, work_id), True)


def _student_fields(data: object, valid_id) -> tuple[str, str]:
    if not isinstance(data, dict) or not valid_id(data.get("studentId")):
        raise ValueError("studentId 格式不正确")
    return data["studentId"], _validate_text(data.get("studentName"), "学生姓名", 100, 1)


def submit(db: sqlite3.Connection, class_id: str, work_id: str, data: object, valid_id) -> dict:
    row = get_work(db, class_id, work_id)
    if row["status"] != "published" or row["kind"] != "homework":
        raise ValueError("作业未发布")
    student_id, student_name = _student_fields(data, valid_id)
    answers = data.get("answers")
    question_ids = {q["id"] for q in json.loads(row["questions_json"])}
    if not isinstance(answers, dict) or set(answers) != question_ids or any(not isinstance(value, str) or not value.strip() for value in answers.values()):
        raise ValueError("请先完成全部题目")
    if any(not isinstance(value, str) or len(value) > 16000 for value in answers.values()):
        raise ValueError("答案格式不正确或过长")
    attempt = db.execute("SELECT COUNT(*) FROM submissions WHERE assignment_id=? AND student_id=?", (work_id, student_id)).fetchone()[0] + 1
    submission_id = f"sub-{uuid.uuid4().hex[:16]}"
    timestamp = now()
    db.execute("INSERT INTO submissions (id,assignment_id,class_id,student_id,student_name,attempt,answers_json,submitted_at) VALUES (?,?,?,?,?,?,?,?)",
               (submission_id, work_id, class_id, student_id, student_name, attempt,
                json.dumps(answers, ensure_ascii=False), timestamp))
    return {"id": submission_id, "assignmentId": work_id, "attempt": attempt, "submittedAt": timestamp}


def list_submissions(db: sqlite3.Connection, class_id: str, teacher: bool, student_id: str | None = None) -> list[dict]:
    sql = "SELECT s.* FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.class_id=?"
    params = [class_id]
    if not teacher:
        sql += " AND s.student_id=? AND a.status='published'"
        params.append(student_id)
    sql += " ORDER BY s.submitted_at DESC, s.id DESC"
    rows = db.execute(sql, params).fetchall()
    return [{"id": r["id"], "assignmentId": r["assignment_id"], "studentId": r["student_id"],
             "studentName": r["student_name"], "attempt": r["attempt"], "answers": json.loads(r["answers_json"]),
             "submittedAt": r["submitted_at"], "grade": r["grade"], "feedback": r["feedback"],
             "gradedAt": r["graded_at"]} for r in rows]


def grade(db: sqlite3.Connection, class_id: str, submission_id: str, data: object) -> dict:
    if not isinstance(data, dict):
        raise ValueError("评分格式不正确")
    row = db.execute("""SELECT s.*,a.questions_json FROM submissions s JOIN assignments a ON a.id=s.assignment_id
        WHERE s.id=? AND s.class_id=?""", (submission_id, class_id)).fetchone()
    if not row:
        raise ValueError("提交不存在")
    maximum = sum(q["points"] for q in json.loads(row["questions_json"]))
    score = data.get("grade")
    if not isinstance(score, (int, float)) or isinstance(score, bool) or not 0 <= score <= maximum:
        raise ValueError(f"得分需为 0–{maximum}")
    feedback = _validate_text(data.get("feedback", ""), "评语", 4000)
    db.execute("UPDATE submissions SET grade=?,feedback=?,graded_at=? WHERE id=?", (score, feedback, now(), submission_id))
    return {"id": submission_id, "grade": score, "feedback": feedback, "maxPoints": maximum, "gradedAt": now()}


def check_practice(db: sqlite3.Connection, class_id: str, work_id: str, data: object, valid_id) -> dict:
    row = get_work(db, class_id, work_id)
    if row["status"] != "published" or row["kind"] != "practice":
        raise ValueError("练习未发布")
    _student_fields(data, valid_id)
    q = next((q for q in json.loads(row["questions_json"]) if q["id"] == data.get("questionId")), None)
    if not q:
        raise ValueError("题目不存在")
    answer = data.get("answer")
    if not isinstance(answer, str) or len(answer) > 16000:
        raise ValueError("答案格式不正确")
    def normalize(value: str) -> str:
        return re.sub(r"\s+", "", re.sub(r"^\[1\]\s*", "", value.strip().casefold()).strip("\"'"))
    expected = normalize(q["answer"])
    actual = normalize(answer)
    correct = bool(expected) and actual == expected
    if q["type"] == "complete" and isinstance(data.get("runOutput"), str):
        correct = bool(expected) and normalize(data["runOutput"].splitlines()[-1] if data["runOutput"].splitlines() else "") == expected
    return {"correct": correct, "explanation": q["explanation"] if correct else "先检查代码输出与题目要求，再尝试一次。"}


def hub(db: sqlite3.Connection, class_id: str) -> dict:
    assignments = db.execute("SELECT id,title FROM assignments WHERE class_id=? AND kind='homework' AND status='published' ORDER BY created_at,id", (class_id,)).fetchall()
    student_map: dict[str, dict] = {}
    def student(sid: str, name: str) -> dict:
        return student_map.setdefault(sid, {"studentId": sid, "studentName": name, "scoreByAssignment": {},
            "attemptsByAssignment": {}, "interactions": 0, "learningSeconds": 0,
            "freePracticeCount": 0, "codeRuns": 0, "aiQuestions": 0, "lastActive": None})
    for row in db.execute("SELECT student_id,student_name FROM roster WHERE class_id=?", (class_id,)):
        student(row["student_id"], row["student_name"])
    for row in db.execute("SELECT student_id,student_name,event_type,payload_json,created_at FROM events WHERE class_id=?", (class_id,)):
        item = student(row["student_id"], row["student_name"])
        item["studentName"] = row["student_name"]
        item["interactions"] += 1
        item["lastActive"] = max(item["lastActive"] or "", row["created_at"])
        payload = json.loads(row["payload_json"])
        if row["event_type"] == "study_heartbeat":
            seconds = payload.get("seconds", 0)
            if isinstance(seconds, (int, float)) and not isinstance(seconds, bool):
                item["learningSeconds"] += min(max(int(seconds), 0), 60)
        elif row["event_type"] == "question_generated":
            item["freePracticeCount"] += 1
        elif row["event_type"] == "code_run":
            item["codeRuns"] += 1
        elif row["event_type"] == "ai_question":
            item["aiQuestions"] += 1
    for row in db.execute("SELECT student_id,student_name,assignment_id,grade,submitted_at FROM submissions WHERE class_id=? ORDER BY attempt", (class_id,)):
        item = student(row["student_id"], row["student_name"])
        aid = row["assignment_id"]
        item["attemptsByAssignment"][aid] = item["attemptsByAssignment"].get(aid, 0) + 1
        if row["grade"] is not None:
            item["scoreByAssignment"][aid] = row["grade"]
        item["lastActive"] = max(item["lastActive"] or "", row["submitted_at"])
    return {"assignments": [dict(a) for a in assignments], "students": sorted(student_map.values(), key=lambda x: x["studentName"].lower())}


def import_roster(db: sqlite3.Connection, class_id: str, data: object, valid_id) -> dict:
    if not isinstance(data, dict) or not isinstance(data.get("students"), list) or not 1 <= len(data["students"]) <= 500:
        raise ValueError("名单需包含 1–500 名学生")
    for row in data["students"]:
        if not isinstance(row, dict) or not valid_id(row.get("studentId")):
            raise ValueError("学生 ID 格式不正确")
        name = _validate_text(row.get("studentName"), "学生姓名", 100, 1)
        db.execute("INSERT INTO roster VALUES (?,?,?) ON CONFLICT(class_id,student_id) DO UPDATE SET student_name=excluded.student_name",
                   (class_id, row["studentId"], name))
    return {"count": len(data["students"])}
