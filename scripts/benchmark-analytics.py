"""Measure synthetic analytics queries without touching the application DB (owned by INSIGHTS).

Two fixtures in one temporary database:
- legacy session rollups (``--sessions``) for the v0.5.1 ``analytics.table``/``metrics`` endpoints (§6.9);
- v0.6 event rows (``--events``) with derived columns for the range-aware Activity explorer, Course metrics,
  trends and Home queries (§13.4, §13.7), which aggregate ``events`` inside a ``[from, to)`` window.
It is not an HTTP, AI, or multi-user capacity test.
"""

import argparse
import json
import statistics
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import analytics, app  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--sessions", type=int, default=100000)
parser.add_argument("--events", type=int, default=200000)
parser.add_argument("--students", type=int, default=500)
args = parser.parse_args()
if not 1 <= args.sessions <= 1000000:
    parser.error("Use 1–1,000,000 synthetic sessions")
if not 0 <= args.events <= 2000000:
    parser.error("Use 0–2,000,000 synthetic events")
if not 1 <= args.students <= 20000:
    parser.error("Use 1–20,000 synthetic students")

UNITS = ["r-basics", "data-wrangling", "text-analysis", "network-analysis"]
START = datetime(2026, 9, 1, tzinfo=timezone.utc)


def timed(task):
    times, value = [], None
    for _ in range(3):
        started = time.perf_counter()
        value = task()
        times.append((time.perf_counter() - started) * 1000)
    return value, round(statistics.median(times), 2)


with tempfile.TemporaryDirectory(prefix="kiwi-analytics-benchmark-") as directory:
    app.DB_PATH = Path(directory) / "synthetic.sqlite3"
    app.init_db()
    with app.connection() as db:
        db.executemany(
            "INSERT INTO learning_sessions (id,classId,studentId,studentName,browserSession,contextKey,unitId,assignmentId,questionId,kind,title,"
            "startedAt,lastActive,interactions,attempts,checked,correct,codeRuns,codeErrors,aiQuestions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ((f"learn-{i}", "benchmark", f"s{i % 5000}", f"Student {i % 5000:05d}", f"browser-{i % 5000}", f"q{i % 200}", UNITS[i % 4], "",
              f"q{i % 200}", "question", f"Synthetic question {i % 200}", "2026-10-15T00:00:00+00:00", "2026-10-15T00:00:00+00:00",
              10 + i % 50, 2, 2, 1, 3, 1, 2) for i in range(args.sessions)),
        )
        # v0.6 fixture: a roster, published work and events with the derived columns written by telemetry.add_event.
        db.executemany("INSERT INTO roster (class_id, student_id, student_name, display_name, source, status, pseudonym_seq) "
                       "VALUES ('bench6', ?, ?, ?, 'import', 'active', ?)",
                       ((f"s{i}", f"Student {i}", f"Student {i}", i + 1) for i in range(args.students)))
        for n, unit in enumerate(UNITS):
            db.execute("""INSERT INTO assignments (id, class_id, kind, title, unit_id, instructions, due_at, status, questions_json,
                created_at, updated_at) VALUES (?, 'bench6', ?, ?, ?, '', NULL, 'published', ?, '2026-09-01', '2026-09-01')""",
                       (f"hw{n}", "homework" if n % 2 == 0 else "practice", f"Week {n + 1} HW", unit,
                        json.dumps([{"id": f"q{k}", "type": "fill", "prompt": f"Question {k}", "answer": "4", "points": 10} for k in range(5)])))
        kinds = ("answer_submitted", "code_run", "code_run", "ai_question", "question_viewed")
        rows = []
        for i in range(args.events):
            kind = kinds[i % len(kinds)]
            at = (START + timedelta(minutes=i * 7 % (60 * 24 * 60))).isoformat(timespec="milliseconds")
            payload = {"assignmentId": f"hw{i % 4}", "answer": str(i % 6), "correct": i % 3 == 0} if kind == "answer_submitted" else (
                {"assignmentId": f"hw{i % 4}", "ok": i % 4 != 0, "code": "x"} if kind == "code_run" else {"assignmentId": f"hw{i % 4}", "prompt": f"p{i % 40}"})
            rows.append(("bench6", f"s{i % args.students}", "Student", "b", kind, f"q{i % 5}", json.dumps(payload), at, "lab", 2, at,
                         "student", "homework" if (i % 4) % 2 == 0 else "in-class", f"hw{i % 4}",
                         "server" if kind == "answer_submitted" else "", "action" if kind != "question_viewed" else "telemetry"))
        db.executemany("""INSERT INTO events (class_id, student_id, student_name, session_id, event_type, question_id, payload_json,
            created_at, source, schema_version, received_at, actor_role, practice_mode, attribution_assignment_id, checked_by, category)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", rows)
        db.execute("UPDATE events SET learning_session_id = '' WHERE class_id = 'bench6'")
        db.commit()
    results = {
        "fixture": "synthetic session rollups and v0.6 events; not an HTTP, AI, or multi-user capacity test",
        "sessions": args.sessions, "events": args.events, "students": args.students, "queries": {},
    }
    with app.connection() as db:
        tasks = {"legacy:metrics": lambda: analytics.metrics(db, "benchmark", app.DEFAULT_COURSE)}
        for group in ("students", "sessions", "questions", "topics", "assignments"):
            tasks[f"legacy:{group}"] = lambda group=group: analytics.table(
                db, {"classId": "benchmark", "group": group, "sort": "interactions", "pageSize": "25"})
        week = analytics.make_scope(db, "bench6", from_="2026-10-01T00:00:00+00:00", to="2026-10-08T00:00:00+00:00")
        term = analytics.make_scope(db, "bench6")
        for label, scope in (("week", week), ("term", term)):
            for group in ("students", "chapters", "assignments", "questions"):
                tasks[f"v2:{group}:{label}"] = lambda scope=scope, group=group: analytics.explore(
                    db, scope, analytics.ExplorerQuery(group=group, page_size=25))
            tasks[f"v2:metrics:{label}"] = lambda scope=scope: analytics.course_metrics(
                db, scope, {}, ("2026-09-24T00:00:00+00:00", "2026-10-01T00:00:00+00:00"))
        tasks["v2:trends:term"] = lambda: analytics.trends(db, term)
        tasks["v2:answers:term"] = lambda: analytics.answers_by_question(db, term, assignment_id="hw0")
        for name, task in tasks.items():
            value, median = timed(task)
            rows = value.get("rows") or value.get("buckets") or value.get("questions") or []
            results["queries"][name] = {"medianMs": median, "rows": len(rows), "responseBytes": len(json.dumps(value).encode())}
    print(json.dumps(results, indent=2))
