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
    from server import workflows, analytics, ai, kiwi_bridge
    from server.css_samples import SAMPLES
except ModuleNotFoundError:  # python3 server/app.py
    import workflows, analytics, ai, kiwi_bridge
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
    "question_generated",
    "question_viewed",
    "answer_submitted",
    "code_run",
    "code_edited",
    "hint_requested",
    "question_skipped",
    "difficulty_changed",
    "topic_changed",
    "profile_updated",
    "ai_question",
    "similar_requested",
    "study_heartbeat",
    "work_opened",
    "work_answer_saved",
    "work_submitted",
}

DEFAULT_COURSE = {
    "title": "Introduction to Computational Social Science",
    "description": "CSS methods and R practice: data collection, ethics, wrangling, visualization, text analysis, and social networks.",
    "currentUnitId": "data-wrangling",
    "units": [
        {
            "id": "css-intro",
            "title": "01 · CSS and digital data",
            "goal": "Computational social science questions, digital data sources, and research ethics",
            "status": "completed",
        },
        {
            "id": "r-basics",
            "title": "02 · R basics and data import",
            "goal": "Vectors, descriptive statistics, data types, and CSV import",
            "status": "completed",
        },
        {
            "id": "data-wrangling",
            "title": "03 · Wrangling, joins, and visualization",
            "goal": "Filtering, sorting, grouping, joins, and ggplot visualization",
            "status": "current",
        },
        {
            "id": "text-analysis",
            "title": "04 · Text analysis",
            "goal": "Corpora, tokenization, stop words, word frequencies, topic models, and embeddings",
            "status": "upcoming",
        },
        {
            "id": "network-analysis",
            "title": "05 · Social network analysis",
            "goal": "Node and edge tables, directed networks, in-degree, reciprocity, and visualization",
            "status": "upcoming",
        },
    ],
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class ManagedConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc, tb):
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            self.close()


def connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10, factory=ManagedConnection)
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
        ai.init(db)
        kiwi_bridge.init(db)
        analytics.init(db)


def valid_id(value: object) -> bool:
    return isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None


def course_for(class_id: str) -> dict:
    with connection() as db:
        row = db.execute(
            "SELECT config_json FROM courses WHERE class_id = ?", (class_id,)
        ).fetchone()
    config = json.loads(row["config_json"]) if row else deepcopy(DEFAULT_COURSE)
    translations = {
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

    def english(value):
        if isinstance(value, str):
            return translations.get(value, value)
        if isinstance(value, list):
            return [english(v) for v in value]
        if isinstance(value, dict):
            return {k: english(v) for k, v in value.items()}
        return value

    return english(config)


def validate_course(data: object) -> dict:
    if not isinstance(data, dict):
        raise ValueError("Course settings must be an object")
    title = data.get("title")
    description = data.get("description", "")
    units = data.get("units")
    current = data.get("currentUnitId")
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 100:
        raise ValueError("Course title must contain 1–100 characters")
    if not isinstance(description, str) or len(description) > 1000:
        raise ValueError("Course description is too long")
    if not isinstance(units, list) or not 1 <= len(units) <= 30:
        raise ValueError("A course needs 1–30 chapters")
    clean_units = []
    ids = set()
    for unit in units:
        if not isinstance(unit, dict) or not valid_id(unit.get("id")):
            raise ValueError("Invalid chapter ID")
        uid = unit["id"]
        if uid in ids:
            raise ValueError("Chapter IDs must be unique")
        ids.add(uid)
        name, goal = unit.get("title"), unit.get("goal")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
            raise ValueError("Chapter title must contain 1–100 characters")
        if not isinstance(goal, str) or not 1 <= len(goal.strip()) <= 500:
            raise ValueError("Learning goal must contain 1–500 characters")
        clean_units.append(
            {
                "id": uid,
                "title": name.strip(),
                "goal": goal.strip(),
                "status": "upcoming",
            }
        )
    if current not in ids:
        raise ValueError("Select an existing chapter as the current chapter")
    current_index = [u["id"] for u in clean_units].index(current)
    for index, unit in enumerate(clean_units):
        unit["status"] = (
            "completed"
            if index < current_index
            else "current" if index == current_index else "upcoming"
        )
    return {
        "title": title.strip(),
        "description": description.strip(),
        "currentUnitId": current,
        "units": clean_units,
    }


def add_event(data: object, db=None) -> dict:
    if not isinstance(data, dict):
        raise ValueError("Invalid event format")
    for key in ("classId", "studentId", "sessionId"):
        if not valid_id(data.get(key)):
            raise ValueError(f"{key} has an invalid format")
    name = data.get("studentName", "Student")
    kind = data.get("type")
    payload = data.get("payload", {})
    if isinstance(payload, dict) and payload.get("source") == "kiwi":
        payload = {k: v for k, v in payload.items() if not k.startswith("upstream")}
        payload["source"] = "lab"
    question_id = data.get("questionId")
    if not isinstance(name, str) or not 1 <= len(name) <= 100:
        raise ValueError("studentName has an invalid format")
    if kind not in EVENT_TYPES:
        raise ValueError("Unsupported event type")
    if question_id is not None and not valid_id(question_id):
        raise ValueError("questionId has an invalid format")
    if (
        not isinstance(payload, dict)
        or len(json.dumps(payload, ensure_ascii=False)) > 60000
    ):
        raise ValueError("Event payload is too large")
    if db is None:
        with connection() as owned:
            return add_event(data, owned)
    timestamp = now()
    cur = db.execute(
        """INSERT INTO events
        (class_id, student_id, student_name, session_id, event_type, question_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            data["classId"],
            data["studentId"],
            name,
            data["sessionId"],
            kind,
            question_id,
            json.dumps(payload, ensure_ascii=False),
            timestamp,
        ),
    )
    row = db.execute("SELECT * FROM events WHERE id=?", (cur.lastrowid,)).fetchone()
    analytics.index_event(db, row)
    return {"id": cur.lastrowid, "createdAt": timestamp}


def events_for(
    class_id: str,
    student_id: str | None = None,
    limit: int = 100,
    before_id: int | None = None,
) -> list[dict]:
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
    return [
        {
            "id": row["id"],
            "classId": row["class_id"],
            "studentId": row["student_id"],
            "studentName": row["student_name"],
            "sessionId": row["session_id"],
            "type": row["event_type"],
            "questionId": row["question_id"],
            "payload": json.loads(row["payload_json"]),
            "createdAt": row["created_at"],
        }
        for row in rows
    ]


def summary_for(class_id: str) -> dict:
    with connection() as db:
        rows = db.execute(
            """SELECT student_id, MAX(student_name) name,
            COUNT(*) events,
            SUM(CASE WHEN event_type='code_run' THEN 1 ELSE 0 END) runs,
            SUM(CASE WHEN event_type='answer_submitted' THEN 1 ELSE 0 END) answers,
            MAX(created_at) last_active
            FROM events WHERE class_id=? GROUP BY student_id ORDER BY last_active DESC""",
            (class_id,),
        ).fetchall()
    return {
        "students": [dict(row) for row in rows],
        "totalEvents": sum(row["events"] for row in rows),
    }


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
        if hasattr(self, "_body_cache"):
            return self._body_cache
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 4_200_000:
            raise ValueError("Request body is empty or too large")
        self._body_cache = json.loads(self.rfile.read(length))
        return self._body_cache

    def teacher(self) -> bool:
        identity = getattr(self, "kiwi_identity", None)
        if identity:
            return bool(identity.get("canManageCourse"))
        provided = self.headers.get("X-Teacher-Key", "")
        return bool(provided) and hmac.compare_digest(provided, TEACHER_KEY)

    def analyst(self) -> bool:
        identity = getattr(self, "kiwi_identity", None)
        return bool(identity.get("canViewAnalytics")) if identity else self.teacher()

    def teacher_denied(self) -> None:
        if getattr(self, "kiwi_identity", None):
            self.respond(403, {"error": "Your Kiwi account does not have permission for this course action."})
        else:
            self.respond(401, {"error": "Teacher key is incorrect"})

    def own_student(self, student_id) -> None:
        identity = getattr(self, "kiwi_identity", None)
        if identity and student_id != identity["userId"] and not self.analyst():
            raise kiwi_bridge.BridgeError("Student activity belongs to another user", 403)

    def student_body(self, data):
        if not isinstance(data, dict):
            raise ValueError("Invalid request body")
        identity = getattr(self, "kiwi_identity", None)
        if identity:
            if data.get("studentId") != identity["userId"]:
                raise kiwi_bridge.BridgeError("Student identity must match the Kiwi token", 403)
            data["studentName"] = identity["username"]
            if "classId" in data and data["classId"] != identity["classId"]:
                raise kiwi_bridge.BridgeError("Activity belongs to another course", 403)
        return data

    def route(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        args = parse_qs(parsed.query)
        if hasattr(self, "_body_cache"):
            del self._body_cache
        if path == "/api/events" and method == "POST" and "classId" not in args:
            event = self.body_json()
            if not isinstance(event, dict):
                raise ValueError("Invalid event format")
            args["classId"] = [event.get("classId", "")]
        class_id = args.get("classId", ["local-r-class"])[0]
        if not valid_id(class_id):
            raise ValueError("classId has an invalid format")
        self.kiwi_identity = None
        authorization = self.headers.get("Authorization", "")
        if path != "/api/health":
            if authorization:
                self.kiwi_identity = kiwi_bridge.authenticate(authorization, class_id)
                with connection() as db:
                    db.execute("INSERT INTO kiwi_links VALUES (?,?) ON CONFLICT(class_id) DO UPDATE SET name=excluded.name", (class_id, self.kiwi_identity.get("className", class_id)))
            else:
                with connection() as db:
                    requires_kiwi = kiwi_bridge.linked(db, class_id)
                if requires_kiwi:
                    raise kiwi_bridge.BridgeError("Open this course's CSS Lab from Kiwi to use your verified course identity", 401)
        if path == "/api/health" and method == "GET":
            self.respond(
                200,
                {"ok": True, "runtime": "browser-webR", "aiAvailable": ai.available()},
            )
        elif path == "/api/kiwi/context" and method == "GET":
            if not self.kiwi_identity:
                raise kiwi_bridge.BridgeError("Open CSS Lab from Kiwi", 401)
            self.respond(200, self.kiwi_identity)
        elif path == "/api/teacher/kiwi/sync" and method == "POST":
            if not self.kiwi_identity or not self.analyst():
                raise kiwi_bridge.BridgeError("Verified Kiwi course analytics access is required", 403)
            self.respond(200, kiwi_bridge.sync(connection, class_id, authorization[7:]))
        elif path == "/api/teacher/kiwi/status" and method == "GET":
            if not self.analyst():
                raise kiwi_bridge.BridgeError("Teacher analytics access is required", 403)
            with connection() as db:
                self.respond(200, kiwi_bridge.status(db, class_id))
        elif path == "/api/teacher/kiwi/material" and method == "PUT":
            if not self.teacher():
                raise kiwi_bridge.BridgeError("Course management permission is required", 403)
            data = self.body_json()
            unit_id = data.get("unitId", "")
            if unit_id and unit_id not in [u["id"] for u in course_for(class_id)["units"]]:
                raise ValueError("Select an existing chapter")
            with connection() as db:
                kiwi_bridge.map_material(db, class_id, data.get("materialId", ""), unit_id)
                self.respond(200, kiwi_bridge.status(db, class_id))
        elif path == "/api/policy" and method == "GET":
            unit_id = args.get("unitId", [course_for(class_id)["currentUnitId"]])[0]
            with connection() as db:
                self.respond(200, ai.public_policy(db, class_id, unit_id))
        elif path == "/api/teacher/policies":
            if not self.teacher():
                self.teacher_denied()
                return
            course = course_for(class_id)
            with connection() as db:
                if method == "GET":
                    self.respond(
                        200,
                        [
                            {"unitId": u["id"], **ai.policy(db, class_id, u["id"])}
                            for u in course["units"]
                        ],
                    )
                elif method == "PUT":
                    self.respond(
                        200,
                        ai.save_policy(
                            db,
                            class_id,
                            self.body_json(),
                            [u["id"] for u in course["units"]],
                            now(),
                        ),
                    )
                else:
                    self.respond(405, {"error": "Method not allowed"})
        elif path in ("/api/ai/question", "/api/ai/chat") and method == "POST":
            data = self.student_body(self.body_json())
            action = path.rsplit("/", 1)[1]
            with connection() as db:
                request = ai.build_request(
                    db, class_id, course_for(class_id), data, action, valid_id
                )
            text = ai.invoke(request, class_id, data["studentId"])
            if action == "question":
                question = ai.validate_question(text, data)
                if not ai.is_novel(question, data.get("sourceQuestion", "")):
                    request["input"].append({"role": "assistant", "content": text})
                    request["input"].append(
                        {
                            "role": "developer",
                            "content": "The previous exercise reused the source inputs. Generate a fresh exercise now. Change the concrete numbers or categorical data; retain only the underlying skill. Return the required JSON.",
                        }
                    )
                    question = ai.validate_question(
                        ai.invoke(request, class_id, data["studentId"]), data
                    )
                    if not ai.is_novel(question, data.get("sourceQuestion", "")):
                        raise ValueError(
                            "AI repeated the source example. Generate another exercise to get new data."
                        )
                import uuid

                self.respond(
                    200,
                    {
                        **question,
                        "id": f"q-{uuid.uuid4()}",
                        "type": data["type"],
                        "difficulty": data["difficulty"],
                        "unitId": data["unitId"],
                        "source": "kiwi-ai",
                    },
                )
            else:
                with connection() as db:
                    db.execute(
                        "INSERT INTO chat_turns (class_id,student_id,thread_id,question_id,prompt,response,created_at) VALUES (?,?,?,?,?,?,?)",
                        (
                            class_id,
                            data["studentId"],
                            data["threadId"],
                            data.get("questionId", ""),
                            data["prompt"],
                            text,
                            now(),
                        ),
                    )
                self.respond(200, {"response": text, "source": "kiwi-ai"})
        elif path == "/api/chat" and method == "GET":
            student_id = args.get("studentId", [""])[0]
            thread_id = args.get("threadId", [""])[0]
            if not valid_id(student_id) or not valid_id(thread_id):
                raise ValueError("Student and thread IDs are required")
            self.own_student(student_id)
            with connection() as db:
                rows = db.execute(
                    "SELECT prompt,response,created_at createdAt FROM chat_turns WHERE class_id=? AND student_id=? AND thread_id=? ORDER BY id DESC LIMIT 30",
                    (class_id, student_id, thread_id),
                ).fetchall()
                self.respond(200, [dict(r) for r in reversed(rows)])
        elif path.startswith("/api/teacher/analytics") and method == "GET":
            if not self.analyst():
                self.teacher_denied()
                return
            values = {k: v[0] for k, v in args.items()}
            values["classId"] = class_id
            with connection() as db:
                action = path.rsplit("/", 1)[-1]
                if action == "metrics":
                    result = analytics.metrics(db, class_id, course_for(class_id))
                elif action == "table":
                    result = analytics.table(db, values)
                elif action == "evidence":
                    result = analytics.evidence(db, values)
                elif action == "session":
                    result = analytics.session_events(
                        db,
                        class_id,
                        values.get("sessionId", ""),
                        int(values.get("afterId", "0")),
                    )
                else:
                    self.respond(404, {"error": "Analytics view not found"})
                    return
                self.respond(200, result)
        elif path == "/api/course" and method == "GET":
            self.respond(200, course_for(class_id))
        elif path == "/api/course" and method == "PUT":
            if not self.teacher():
                self.teacher_denied()
                return
            config = validate_course(self.body_json())
            with connection() as db:
                ids = [u["id"] for u in config["units"]]
                referenced = {
                    r[0]
                    for r in db.execute(
                        "SELECT DISTINCT unit_id FROM assignments WHERE class_id=?",
                        (class_id,),
                    )
                }
                referenced |= {
                    r[0]
                    for r in db.execute(
                        "SELECT DISTINCT unitId FROM learning_sessions WHERE classId=? AND unitId!=''",
                        (class_id,),
                    )
                }
                referenced |= {r[0] for r in db.execute("SELECT unit_id FROM kiwi_materials WHERE class_id=? AND unit_id!=''", (class_id,))}
                if referenced - set(ids):
                    raise ValueError(
                        "Chapters with assignments or learning history must be retained. Rename them or add a new chapter instead."
                    )
                db.execute(
                    "INSERT INTO courses VALUES (?, ?, ?) ON CONFLICT(class_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at",
                    (class_id, json.dumps(config, ensure_ascii=False), now()),
                )
            self.respond(200, config)
        elif path == "/api/events" and method == "POST":
            data = self.student_body(self.body_json())
            if data.get("classId") != class_id:
                raise kiwi_bridge.BridgeError("Activity belongs to another course", 403)
            self.respond(201, add_event(data))
        elif path == "/api/events" and method == "GET":
            student_id = args.get("studentId", [None])[0]
            if not student_id or not valid_id(student_id):
                raise ValueError("studentId is required")
            self.own_student(student_id)
            self.respond(200, events_for(class_id, student_id, 120))
        elif path == "/api/work-options" and method == "GET":
            with connection() as db:
                self.respond(200, workflows.work_options(db, class_id, self.teacher()))
        elif path == "/api/teacher/work-page" and method == "GET":
            if not self.teacher():
                self.teacher_denied()
                return
            with connection() as db:
                self.respond(
                    200,
                    workflows.work_page(
                        db, class_id, {k: v[0] for k, v in args.items()}
                    ),
                )
        elif path == "/api/work" and method == "GET":
            with connection() as db:
                self.respond(200, workflows.list_work(db, class_id, self.teacher()))
        elif path == "/api/work" and method == "POST":
            if not self.teacher():
                self.teacher_denied()
                return
            data = self.body_json()
            if not isinstance(data, dict) or data.get("unitId") not in [
                u["id"] for u in course_for(class_id)["units"]
            ]:
                raise ValueError("Select an existing chapter")
            with connection() as db:
                self.respond(201, workflows.save_work(db, class_id, data, valid_id))
        elif path.startswith("/api/work/"):
            parts = path.split("/")
            work_id = parts[3] if len(parts) > 3 else ""
            action = parts[4] if len(parts) > 4 else ""
            if not valid_id(work_id):
                raise ValueError("Invalid assignment ID")
            with connection() as db:
                if method == "GET" and not action:
                    row = workflows.get_work(db, class_id, work_id)
                    if row["status"] != "published" and not self.teacher():
                        self.respond(404, {"error": "Assignment not found"})
                    else:
                        self.respond(200, workflows.serialize_work(row, self.teacher()))
                elif method == "PUT" and not action:
                    if not self.teacher():
                        self.teacher_denied()
                    else:
                        data = self.body_json()
                        if not isinstance(data, dict) or data.get("unitId") not in [
                            u["id"] for u in course_for(class_id)["units"]
                        ]:
                            raise ValueError("Select an existing chapter")
                        self.respond(
                            200,
                            workflows.save_work(db, class_id, data, valid_id, work_id),
                        )
                elif method == "POST" and action == "status":
                    if not self.teacher():
                        self.teacher_denied()
                    else:
                        self.respond(
                            200,
                            workflows.set_status(
                                db, class_id, work_id, self.body_json().get("status")
                            ),
                        )
                elif method == "POST" and action == "submit":
                    data = self.student_body(self.body_json())
                    result = workflows.submit(db, class_id, work_id, data, valid_id)
                    for question_id, answer in (
                        [] if result.get("replayed") else data["answers"].items()
                    ):
                        add_event(
                            {
                                "classId": class_id,
                                "studentId": data["studentId"],
                                "studentName": data["studentName"],
                                "sessionId": data.get("sessionId")
                                or "submission-" + result["id"],
                                "type": "answer_submitted",
                                "questionId": question_id,
                                "payload": {
                                    "assignmentId": work_id,
                                    "answer": answer,
                                    "submissionId": result["id"],
                                    "attempt": result["attempt"],
                                },
                            },
                            db,
                        )
                    db.commit()
                    self.respond(201, result)
                elif method == "POST" and action == "check":
                    data = self.student_body(self.body_json())
                    result = workflows.check_practice(
                        db, class_id, work_id, data, valid_id
                    )
                    add_event(
                        {
                            "classId": class_id,
                            "studentId": data["studentId"],
                            "studentName": data["studentName"],
                            "sessionId": data.get("sessionId")
                            or "practice-" + data["studentId"],
                            "type": "answer_submitted",
                            "questionId": data["questionId"],
                            "payload": {
                                "assignmentId": work_id,
                                "answer": data["answer"],
                                "correct": result["correct"],
                            },
                        },
                        db,
                    )
                    db.commit()
                    self.respond(200, result)
                elif method == "GET" and action == "attachment":
                    row = workflows.get_work(db, class_id, work_id)
                    if row["status"] != "published" and not self.teacher():
                        self.respond(404, {"error": "Attachment not found"})
                    elif not row["file_data"]:
                        self.respond(404, {"error": "Attachment not found"})
                    else:
                        import base64

                        self.respond(
                            200,
                            {
                                "name": row["file_name"],
                                "type": row["file_type"],
                                "data": base64.b64encode(row["file_data"]).decode(),
                            },
                        )
                else:
                    self.respond(404, {"error": "Endpoint not found"})
        elif path == "/api/submissions" and method == "GET":
            student_id = args.get("studentId", [None])[0]
            if not self.teacher() and (not student_id or not valid_id(student_id)):
                raise ValueError("studentId is required")
            if student_id:
                self.own_student(student_id)
            with connection() as db:
                self.respond(
                    200,
                    workflows.list_submissions(
                        db,
                        class_id,
                        self.teacher(),
                        student_id,
                        args.get("assignmentId", [None])[0],
                    ),
                )
        elif (
            path.startswith("/api/submissions/")
            and path.endswith("/grade")
            and method == "POST"
        ):
            if not self.teacher():
                self.teacher_denied()
                return
            submission_id = path.split("/")[3]
            if not valid_id(submission_id):
                raise ValueError("Invalid submission ID")
            with connection() as db:
                self.respond(
                    200, workflows.grade(db, class_id, submission_id, self.body_json())
                )
        elif path == "/api/teacher/hub" and method == "GET":
            if not self.analyst():
                self.teacher_denied()
                return
            with connection() as db:
                self.respond(200, workflows.hub(db, class_id))
        elif path == "/api/teacher/samples" and method == "POST":
            if not self.teacher():
                self.teacher_denied()
                return
            with connection() as db:
                existing = {
                    row[0]
                    for row in db.execute(
                        "SELECT title FROM assignments WHERE class_id=?", (class_id,)
                    )
                }
                created = [
                    workflows.save_work(db, class_id, sample, valid_id)
                    for sample in SAMPLES
                    if sample["title"] not in existing
                ]
                self.respond(201, {"created": len(created)})
        elif path == "/api/teacher/roster" and method == "POST":
            if not self.teacher():
                self.teacher_denied()
                return
            with connection() as db:
                self.respond(
                    200,
                    workflows.import_roster(db, class_id, self.body_json(), valid_id),
                )
        elif path == "/api/teacher/verify" and method == "POST":
            allowed = self.teacher() or self.analyst()
            self.respond(200 if allowed else 401, {"ok": allowed})
        elif path == "/api/teacher/summary" and method == "GET":
            if not self.analyst():
                self.teacher_denied()
                return
            self.respond(200, summary_for(class_id))
        elif path == "/api/teacher/events" and method == "GET":
            if not self.analyst():
                self.teacher_denied()
                return
            student_id = args.get("studentId", [None])[0]
            if student_id and not valid_id(student_id):
                raise ValueError("studentId has an invalid format")
            before = args.get("beforeId", [None])[0]
            if before is not None and (not before.isdecimal() or int(before) < 1):
                raise ValueError("beforeId has an invalid format")
            self.respond(
                200,
                events_for(class_id, student_id, 100, int(before) if before else None),
            )
        else:
            self.respond(404, {"error": "Endpoint not found"})

    def do_GET(self) -> None:
        self.handle_request("GET")

    def do_POST(self) -> None:
        self.handle_request("POST")

    def do_PUT(self) -> None:
        self.handle_request("PUT")

    def handle_request(self, method: str) -> None:
        try:
            self.route(method)
        except kiwi_bridge.BridgeError as exc:
            self.respond(exc.status, {"error": str(exc)})
        except (ValueError, json.JSONDecodeError) as exc:
            self.respond(400, {"error": str(exc)})
        except Exception as exc:
            self.log_error("Unexpected server error: %s", exc)
            self.respond(500, {"error": "Internal server error"})


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("KIWI_API_PORT", "8101"))
    print(f"Kiwi Lab API: http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
