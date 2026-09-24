"""Small local API for course settings and learning telemetry.

The browser runs R with webR. This server never executes student code.
Bind to loopback for the local pilot; add institutional auth before deployment.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import sqlite3
from copy import deepcopy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    from server import workflows
    from server.css_samples import SAMPLES
except ModuleNotFoundError:  # python3 server/app.py
    import workflows
    from css_samples import SAMPLES

ROOT = Path(__file__).resolve().parents[1]


def load_dotenv() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_dotenv()
DB_PATH = Path(os.environ.get("KIWI_DB_PATH", ROOT / "data" / "kiwi-lab.sqlite3"))
TEACHER_KEY = os.environ.get("KIWI_TEACHER_KEY", "kiwi-local-demo")
IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:@-]{1,100}$")
EVENT_TYPES = {
    "question_generated", "question_viewed", "answer_submitted", "code_run",
    "code_edited", "hint_requested", "question_skipped", "difficulty_changed",
    "topic_changed", "profile_updated", "ai_question", "similar_requested",
    "study_heartbeat", "work_opened", "work_answer_saved", "work_submitted",
}

DEFAULT_COURSE = {
    "title": "Introduction to Computational Social Science",
    "description": "CSS 方法与 R 实践：数据收集和伦理、整理与可视化、文本分析、社会网络。",
    "currentUnitId": "data-wrangling",
    "units": [
        {"id": "css-intro", "title": "01 · CSS 与数字数据", "goal": "计算社会科学问题、数字数据来源和研究伦理", "status": "completed"},
        {"id": "r-basics", "title": "02 · R 基础与数据导入", "goal": "向量、描述统计、数据类型、CSV 导入", "status": "completed"},
        {"id": "data-wrangling", "title": "03 · 整理、连接与可视化", "goal": "筛选、排序、分组、连接、ggplot 可视化", "status": "current"},
        {"id": "text-analysis", "title": "04 · 文本分析", "goal": "语料、分词、停用词、词频、主题模型与词向量", "status": "upcoming"},
        {"id": "network-analysis", "title": "05 · 社会网络分析", "goal": "节点边表、有向网络、入度、互惠关系与可视化", "status": "upcoming"},
    ],
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    return db


def init_db() -> None:
    with connection() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS courses (
                class_id TEXT PRIMARY KEY,
                config_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                class_id TEXT NOT NULL,
                student_id TEXT NOT NULL,
                student_name TEXT NOT NULL,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                question_id TEXT,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_class_time ON events(class_id, id DESC);
            CREATE INDEX IF NOT EXISTS idx_events_student ON events(class_id, student_id, id DESC);
        """)
        workflows.init(db)


def valid_id(value: object) -> bool:
    return isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None


def course_for(class_id: str) -> dict:
    with connection() as db:
        row = db.execute("SELECT config_json FROM courses WHERE class_id = ?", (class_id,)).fetchone()
    return json.loads(row["config_json"]) if row else deepcopy(DEFAULT_COURSE)


def validate_course(data: object) -> dict:
    if not isinstance(data, dict):
        raise ValueError("课程设置必须是对象")
    title = data.get("title")
    description = data.get("description", "")
    units = data.get("units")
    current = data.get("currentUnitId")
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 100:
        raise ValueError("课程名称长度需为 1–100 字符")
    if not isinstance(description, str) or len(description) > 1000:
        raise ValueError("课程说明过长")
    if not isinstance(units, list) or not 1 <= len(units) <= 30:
        raise ValueError("需要 1–30 个课程单元")
    clean_units = []
    ids = set()
    for unit in units:
        if not isinstance(unit, dict) or not valid_id(unit.get("id")):
            raise ValueError("单元 ID 格式不正确")
        uid = unit["id"]
        if uid in ids:
            raise ValueError("单元 ID 不能重复")
        ids.add(uid)
        name, goal = unit.get("title"), unit.get("goal")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
            raise ValueError("单元名称长度需为 1–100 字符")
        if not isinstance(goal, str) or not 1 <= len(goal.strip()) <= 500:
            raise ValueError("单元学习目标长度需为 1–500 字符")
        clean_units.append({"id": uid, "title": name.strip(), "goal": goal.strip(), "status": "upcoming"})
    if current not in ids:
        raise ValueError("当前进度必须对应一个单元")
    current_index = [u["id"] for u in clean_units].index(current)
    for index, unit in enumerate(clean_units):
        unit["status"] = "completed" if index < current_index else "current" if index == current_index else "upcoming"
    return {"title": title.strip(), "description": description.strip(), "currentUnitId": current, "units": clean_units}


def add_event(data: object) -> dict:
    if not isinstance(data, dict):
        raise ValueError("事件格式不正确")
    for key in ("classId", "studentId", "sessionId"):
        if not valid_id(data.get(key)):
            raise ValueError(f"{key} 格式不正确")
    name = data.get("studentName", "Student")
    kind = data.get("type")
    payload = data.get("payload", {})
    question_id = data.get("questionId")
    if not isinstance(name, str) or not 1 <= len(name) <= 100:
        raise ValueError("studentName 格式不正确")
    if kind not in EVENT_TYPES:
        raise ValueError("不支持的事件类型")
    if question_id is not None and not valid_id(question_id):
        raise ValueError("questionId 格式不正确")
    if not isinstance(payload, dict) or len(json.dumps(payload, ensure_ascii=False)) > 60000:
        raise ValueError("事件内容过大")
    timestamp = now()
    with connection() as db:
        cur = db.execute(
            """INSERT INTO events
            (class_id, student_id, student_name, session_id, event_type, question_id, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (data["classId"], data["studentId"], name, data["sessionId"], kind,
             question_id, json.dumps(payload, ensure_ascii=False), timestamp),
        )
        return {"id": cur.lastrowid, "createdAt": timestamp}


def events_for(class_id: str, student_id: str | None = None, limit: int = 100, before_id: int | None = None) -> list[dict]:
    query = "SELECT * FROM events WHERE class_id = ?"
    params: list[object] = [class_id]
    if student_id:
        query += " AND student_id = ?"
        params.append(student_id)
    if before_id is not None:
        query += " AND id < ?"
        params.append(before_id)
    query += " ORDER BY id DESC LIMIT ?"
    params.append(min(max(limit, 1), 500))
    with connection() as db:
        rows = db.execute(query, params).fetchall()
    return [{
        "id": row["id"], "classId": row["class_id"], "studentId": row["student_id"],
        "studentName": row["student_name"], "sessionId": row["session_id"],
        "type": row["event_type"], "questionId": row["question_id"],
        "payload": json.loads(row["payload_json"]), "createdAt": row["created_at"],
    } for row in rows]


def summary_for(class_id: str) -> dict:
    with connection() as db:
        rows = db.execute("""SELECT student_id, MAX(student_name) name,
            COUNT(*) events,
            SUM(CASE WHEN event_type='code_run' THEN 1 ELSE 0 END) runs,
            SUM(CASE WHEN event_type='answer_submitted' THEN 1 ELSE 0 END) answers,
            MAX(created_at) last_active
            FROM events WHERE class_id=? GROUP BY student_id ORDER BY last_active DESC""", (class_id,)).fetchall()
    return {"students": [dict(row) for row in rows], "totalEvents": sum(row["events"] for row in rows)}


class Handler(BaseHTTPRequestHandler):
    def respond(self, status: int, data: object) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def body_json(self) -> object:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 4_200_000:
            raise ValueError("请求内容为空或过大")
        return json.loads(self.rfile.read(length))

    def teacher(self) -> bool:
        provided = self.headers.get("X-Teacher-Key", "")
        return bool(provided) and hmac.compare_digest(provided, TEACHER_KEY)

    def route(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        args = parse_qs(parsed.query)
        class_id = args.get("classId", ["local-r-class"])[0]
        if not valid_id(class_id):
            raise ValueError("classId 格式不正确")
        if path == "/api/health" and method == "GET":
            self.respond(200, {"ok": True, "runtime": "browser-webR", "database": str(DB_PATH)})
        elif path == "/api/course" and method == "GET":
            self.respond(200, course_for(class_id))
        elif path == "/api/course" and method == "PUT":
            if not self.teacher():
                self.respond(401, {"error": "教师密钥不正确"})
                return
            config = validate_course(self.body_json())
            with connection() as db:
                db.execute("INSERT INTO courses VALUES (?, ?, ?) ON CONFLICT(class_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at",
                           (class_id, json.dumps(config, ensure_ascii=False), now()))
            self.respond(200, config)
        elif path == "/api/events" and method == "POST":
            self.respond(201, add_event(self.body_json()))
        elif path == "/api/events" and method == "GET":
            student_id = args.get("studentId", [None])[0]
            if not student_id or not valid_id(student_id):
                raise ValueError("studentId 必填")
            self.respond(200, events_for(class_id, student_id, 120))
        elif path == "/api/work" and method == "GET":
            with connection() as db:
                self.respond(200, workflows.list_work(db, class_id, self.teacher()))
        elif path == "/api/work" and method == "POST":
            if not self.teacher():
                self.respond(401, {"error": "教师密钥不正确"})
                return
            with connection() as db:
                self.respond(201, workflows.save_work(db, class_id, self.body_json(), valid_id))
        elif path.startswith("/api/work/"):
            parts = path.split("/")
            work_id = parts[3] if len(parts) > 3 else ""
            action = parts[4] if len(parts) > 4 else ""
            if not valid_id(work_id):
                raise ValueError("作业 ID 不正确")
            with connection() as db:
                if method == "PUT" and not action:
                    if not self.teacher():
                        self.respond(401, {"error": "教师密钥不正确"})
                    else:
                        self.respond(200, workflows.save_work(db, class_id, self.body_json(), valid_id, work_id))
                elif method == "POST" and action == "status":
                    if not self.teacher():
                        self.respond(401, {"error": "教师密钥不正确"})
                    else:
                        self.respond(200, workflows.set_status(db, class_id, work_id, self.body_json().get("status")))
                elif method == "POST" and action == "submit":
                    self.respond(201, workflows.submit(db, class_id, work_id, self.body_json(), valid_id))
                elif method == "POST" and action == "check":
                    self.respond(200, workflows.check_practice(db, class_id, work_id, self.body_json(), valid_id))
                elif method == "GET" and action == "attachment":
                    row = workflows.get_work(db, class_id, work_id)
                    if row["status"] != "published" and not self.teacher():
                        self.respond(404, {"error": "附件不存在"})
                    elif not row["file_data"]:
                        self.respond(404, {"error": "附件不存在"})
                    else:
                        import base64
                        self.respond(200, {"name": row["file_name"], "type": row["file_type"], "data": base64.b64encode(row["file_data"]).decode()})
                else:
                    self.respond(404, {"error": "接口不存在"})
        elif path == "/api/submissions" and method == "GET":
            student_id = args.get("studentId", [None])[0]
            if not self.teacher() and (not student_id or not valid_id(student_id)):
                raise ValueError("studentId 必填")
            with connection() as db:
                self.respond(200, workflows.list_submissions(db, class_id, self.teacher(), student_id))
        elif path.startswith("/api/submissions/") and path.endswith("/grade") and method == "POST":
            if not self.teacher():
                self.respond(401, {"error": "教师密钥不正确"})
                return
            submission_id = path.split("/")[3]
            if not valid_id(submission_id):
                raise ValueError("提交 ID 不正确")
            with connection() as db:
                self.respond(200, workflows.grade(db, class_id, submission_id, self.body_json()))
        elif path == "/api/teacher/hub" and method == "GET":
            if not self.teacher():
                self.respond(401, {"error": "教师密钥不正确"})
                return
            with connection() as db:
                self.respond(200, workflows.hub(db, class_id))
        elif path == "/api/teacher/samples" and method == "POST":
            if not self.teacher():
                self.respond(401, {"error": "教师密钥不正确"})
                return
            with connection() as db:
                existing = {row[0] for row in db.execute("SELECT title FROM assignments WHERE class_id=?", (class_id,))}
                created = [workflows.save_work(db, class_id, sample, valid_id) for sample in SAMPLES if sample["title"] not in existing]
                self.respond(201, {"created": len(created)})
        elif path == "/api/teacher/roster" and method == "POST":
            if not self.teacher():
                self.respond(401, {"error": "教师密钥不正确"})
                return
            with connection() as db:
                self.respond(200, workflows.import_roster(db, class_id, self.body_json(), valid_id))
        elif path == "/api/teacher/verify" and method == "POST":
            self.respond(200 if self.teacher() else 401, {"ok": self.teacher()})
        elif path == "/api/teacher/summary" and method == "GET":
            if not self.teacher():
                self.respond(401, {"error": "教师密钥不正确"})
                return
            self.respond(200, summary_for(class_id))
        elif path == "/api/teacher/events" and method == "GET":
            if not self.teacher():
                self.respond(401, {"error": "教师密钥不正确"})
                return
            student_id = args.get("studentId", [None])[0]
            if student_id and not valid_id(student_id):
                raise ValueError("studentId 格式不正确")
            before = args.get("beforeId", [None])[0]
            if before is not None and (not before.isdecimal() or int(before) < 1):
                raise ValueError("beforeId 格式不正确")
            self.respond(200, events_for(class_id, student_id, 100, int(before) if before else None))
        else:
            self.respond(404, {"error": "接口不存在"})

    def do_GET(self) -> None:
        self.handle_request("GET")

    def do_POST(self) -> None:
        self.handle_request("POST")

    def do_PUT(self) -> None:
        self.handle_request("PUT")

    def handle_request(self, method: str) -> None:
        try:
            self.route(method)
        except (ValueError, json.JSONDecodeError) as exc:
            self.respond(400, {"error": str(exc)})
        except Exception as exc:
            self.log_error("Unexpected server error: %s", exc)
            self.respond(500, {"error": "服务器内部错误"})


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("KIWI_API_PORT", "8101"))
    print(f"Kiwi Lab API: http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
