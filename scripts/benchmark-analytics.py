"""Measure synthetic session-rollup queries without touching the application DB."""

import argparse
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import app

parser = argparse.ArgumentParser()
parser.add_argument("--sessions", type=int, default=100000)
args = parser.parse_args()
if not 1 <= args.sessions <= 1000000:
    parser.error("Use 1–1,000,000 synthetic sessions")
with tempfile.TemporaryDirectory(prefix="kiwi-analytics-benchmark-") as directory:
    app.DB_PATH = Path(directory) / "synthetic.sqlite3"
    app.init_db()
    with app.connection() as db:
        rows = (
            (
                f"learn-{i}",
                "benchmark",
                f"s{i%5000}",
                f"Student {i%5000:05d}",
                f"browser-{i%5000}",
                f"q{i%200}",
                ["r-basics", "data-wrangling", "text-analysis", "network-analysis"][
                    i % 4
                ],
                "",
                f"q{i%200}",
                "question",
                f"Synthetic question {i%200}",
                "2026-10-15T00:00:00+00:00",
                "2026-10-15T00:00:00+00:00",
                10 + i % 50,
                2,
                2,
                1,
                3,
                1,
                2,
            )
            for i in range(args.sessions)
        )
        db.executemany(
            "INSERT INTO learning_sessions (id,classId,studentId,studentName,browserSession,contextKey,unitId,assignmentId,questionId,kind,title,startedAt,lastActive,interactions,attempts,checked,correct,codeRuns,codeErrors,aiQuestions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
    results = {
        "fixture": "synthetic session rollups only; not an HTTP, AI, or multi-user capacity test",
        "sessions": args.sessions,
        "students": min(args.sessions, 5000),
        "queries": {},
    }
    with app.connection() as db:
        tasks = {
            "metrics": lambda: app.analytics.metrics(
                db, "benchmark", app.DEFAULT_COURSE
            )
        }
        for group in ("students", "sessions", "questions", "topics", "assignments"):
            tasks[group] = lambda group=group: app.analytics.table(
                db,
                {
                    "classId": "benchmark",
                    "group": group,
                    "sort": "interactions",
                    "pageSize": "25",
                },
            )
        for name, task in tasks.items():
            times = []
            for _ in range(3):
                started = time.perf_counter()
                value = task()
                times.append((time.perf_counter() - started) * 1000)
            results["queries"][name] = {
                "medianMs": round(statistics.median(times), 2),
                "rows": len(value.get("rows", [])),
                "responseBytes": len(json.dumps(value).encode()),
            }
    print(json.dumps(results, indent=2))
