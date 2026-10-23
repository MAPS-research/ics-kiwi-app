"""Telemetry ingestion, attribution, the session index and Data health — owned by TELEMETRY.

The first three tests were moved from server/test_app.py by FOUNDATION (spec §16.1 item 6), unchanged in intent
except that an unknown event type is now a per-event rejection (422, TELEMETRY-06). The rest cover TELEMETRY-02…28.
"""

from __future__ import annotations

import inspect
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request as UrlRequest, urlopen

from server import app, event_schema, judging, migrations, router, telemetry
from server.contracts import CheckResult
from server import db as dbmod
from server.router import Auth, Registry
from server import testsupport
from server.testsupport import ApiTestCase

HW = "work-5356e581288f49e4"


def iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def ms(value: str) -> int:
    return int(iso(value).timestamp() * 1000)


class TelemetryTests(ApiTestCase):
    def test_course_and_event_history(self):
        status, course = self.request("/api/course?classId=cs101")
        self.assertEqual(status, 200)
        self.assertEqual(course["currentUnitId"], "data-wrangling")
        status, _ = self.request("/api/course?classId=cs101", "PUT", course)
        self.assertEqual(status, 401)
        course["currentUnitId"] = "text-analysis"
        status, saved = self.request(
            "/api/course?classId=cs101", "PUT", course, "test-teacher-key"
        )
        self.assertEqual(status, 200)
        self.assertEqual(saved["units"][3]["status"], "current")

        event = {
            "classId": "cs101",
            "studentId": "s1",
            "studentName": "Ada",
            "sessionId": "session-1",
            "type": "code_run",
            "payload": {"code": "print(2)", "output": "[1] 2", "ok": True},
        }
        status, created = self.request("/api/events", "POST", event, student="s1")
        self.assertEqual(status, 201)
        self.assertGreater(created["id"], 0)
        status, history = self.request(
            "/api/teacher/events?classId=cs101", key="test-teacher-key"
        )
        self.assertEqual(status, 200)
        self.assertEqual(history[0]["payload"]["code"], "print(2)")
        status, _ = self.request("/api/teacher/events?classId=cs101")
        self.assertEqual(status, 401)
        status, summary = self.request(
            "/api/teacher/summary?classId=cs101", key="test-teacher-key"
        )
        self.assertEqual(status, 200)
        self.assertEqual(summary["students"][0]["runs"], 1)

    def test_event_validation_and_pagination(self):
        self.register_class("cs101")  # standalone student writes need a registered course
        event = {
            "classId": "cs101",
            "studentId": "s1",
            "studentName": "Ada",
            "sessionId": "session-1",
            "type": "code_run",
            "payload": {"code": "print(1)"},
        }
        status, body = self.request("/api/events", "POST", {**event, "type": "unknown"}, student="s1")
        self.assertEqual((status, body["status"], body["code"]), (422, "rejected", "invalid_payload"))  # TELEMETRY-06
        for number in range(3):
            self.request(
                "/api/events", "POST", {**event, "payload": {"number": number}}, student="s1")
        status, all_events = self.request(
            "/api/teacher/events?classId=cs101", key="test-teacher-key"
        )
        self.assertEqual(status, 200)
        newest = all_events[0]["id"]
        status, older = self.request(
            f"/api/teacher/events?classId=cs101&beforeId={newest}",
            key="test-teacher-key",
        )
        self.assertEqual(status, 200)
        self.assertEqual(len(older), 2)

    def test_session_inactivity_and_legacy_migration_are_idempotent(self):
        with app.connection() as db:
            for timestamp, qid in [
                ("2026-10-14T10:00:00+00:00", "q1"),
                ("2026-10-14T10:05:00+00:00", "q1"),
                ("2026-10-14T10:06:00+00:00", "q2"),
                ("2026-10-14T11:00:00+00:00", "q1"),
            ]:
                db.execute(
                    "INSERT INTO events (class_id,student_id,student_name,session_id,event_type,question_id,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
                    (
                        "legacy",
                        "s1",
                        "Ada",
                        "browser",
                        "answer_submitted",
                        qid,
                        '{"answer":"2"}',
                        timestamp,
                    ),
                )
            app.analytics.init(db)
            app.analytics.init(db)
            self.assertEqual(
                db.execute(
                    "SELECT COUNT(*) FROM learning_sessions WHERE classId='legacy'"
                ).fetchone()[0],
                3,
            )
            self.assertEqual(
                db.execute(
                    "SELECT SUM(attempts) FROM learning_sessions WHERE classId='legacy'"
                ).fetchone()[0],
                4,
            )


# -- helpers ----------------------------------------------------------------------------------------------
def v2(type_: str, payload: dict, *, class_id: str = "local-r-class", student: str = "demo-ada", event_id: str | None = None,
       question_id: str | None = None, client_ts: int | None = None, surface: str | None = None, seq: int = 1) -> dict:
    event = {"eventId": event_id or f"evt-{os.urandom(6).hex()}", "classId": class_id, "studentId": student,
             "studentName": "Body name (untrusted)", "sessionId": "tab-1", "type": type_, "payload": payload,
             "clientTs": client_ts if client_ts is not None else dbmod.now_ms(), "tzOffsetMin": 480, "seq": seq,
             "schemaVersion": 2}
    if question_id:
        event["questionId"] = question_id
    if surface:
        event["surface"] = surface
    return event


class IngestionApiTests(ApiTestCase):
    """HTTP behavior of POST /api/events and /api/events/batch (§6.2, §11.2)."""

    def post(self, event: dict, student: str = "demo-ada"):
        return self.request("/api/events", "POST", event, student=student)

    def row(self, event_id: str) -> sqlite3.Row:
        with self.db() as db:
            return db.execute("SELECT * FROM events WHERE event_id=?", (event_id,)).fetchone()

    def test_code_run_300k_output_truncated_not_rejected(self):  # TELEMETRY-02, AU-D3-07
        output = "H" * 150000 + "T" * 150000
        status, body = self.post(v2("code_run", {"code": "print(x)", "ok": True, "output": output}, event_id="evt-big"))
        self.assertEqual(status, 201)
        self.assertEqual((body["status"], body["truncated"]), ("created", {"output": 300000}))
        row = self.row("evt-big")
        self.assertEqual(json.loads(row["truncated_json"]), {"output": 300000})
        payload = json.loads(row["payload_json"])
        self.assertEqual(payload["_truncated"], {"output": 300000})
        self.assertTrue(payload["output"].startswith("H" * 20000))
        self.assertTrue(payload["output"].endswith("T" * 20000))
        self.assertIn("…[truncated 260000 chars]…", payload["output"])
        self.assertLess(len(payload["output"]), 40100)
        # a payload far over 250,000 chars is cut further, never rejected
        many = {f"k{i}": "x" * 19000 for i in range(20)}
        status, body = self.post(v2("code_run", {"code": "c" * 70000, **many}, event_id="evt-many"))
        self.assertEqual(status, 201)
        stored = json.loads(self.row("evt-many")["payload_json"])
        self.assertLessEqual(len(json.dumps(stored, ensure_ascii=False)), 250000)
        self.assertEqual(stored["_truncated"]["code"], 70000)

    def test_envelope_fields_clamped_time_and_names(self):  # TELEMETRY-06, AU-D3-19, §11.2 step 1
        with testsupport.freeze_time("2026-10-22T02:00:00+00:00"):
            ok_ts = ms("2026-10-22T01:59:00+00:00")
            status, _ = self.post(v2("code_edited", {"code": "x <- 1"}, event_id="evt-ok", client_ts=ok_ts, seq=7))
            self.assertEqual(status, 201)
            status, _ = self.post(v2("code_edited", {"code": "x <- 2"}, event_id="evt-old", client_ts=ms("2026-10-18T00:00:00+00:00")))
            self.assertEqual(status, 201)
        row = self.row("evt-ok")
        self.assertEqual((row["client_ts_ms"], row["tz_offset_min"], row["client_seq"], row["schema_version"]), (ok_ts, 480, 7, 2))
        self.assertTrue(row["received_at"].startswith("2026-10-22T02:00:00"))
        self.assertTrue(row["created_at"].startswith("2026-10-22T01:59:00"))
        # standalone demo classes keep the v0.5.1 raw value (never used as a label; FOUNDATION-08); linked rows store ''
        self.assertEqual(row["student_name"], "Body name (untrusted)")
        old = self.row("evt-old")
        self.assertEqual(old["created_at"], old["received_at"])

    def test_unknown_type_and_wrong_types_are_rejected_with_rows(self):  # TELEMETRY-06, TELEMETRY-28
        status, body = self.post(v2("teleport", {}, event_id="evt-unknown"))
        self.assertEqual((status, body["status"], body["code"], body["eventId"]), (422, "rejected", "invalid_payload", "evt-unknown"))
        status, body = self.post(v2("code_run", {"ok": "yes"}, event_id="evt-bad"))
        self.assertEqual((status, body["code"]), (422, "invalid_payload"))
        self.assertIn("payload.ok", body["error"])
        status, body = self.post(v2("code_run", {"ok": True, "mystery": 1, "other": "x"}, event_id="evt-extra"))
        self.assertEqual(status, 201)
        status, body = self.post(v2("code_run", {f"k{i}": 1 for i in range(65)}, event_id="evt-keys"))
        self.assertEqual((status, body["code"]), (422, "invalid_payload"))
        status, body = self.post(v2("code_run", {"a": {"b": {"c": {"d": {"e": 1}}}}}, event_id="evt-deep"))
        self.assertEqual((status, body["code"]), (422, "invalid_payload"))
        with self.db() as db:
            rows = db.execute("SELECT client_event_id, code, event_type FROM event_rejections ORDER BY id").fetchall()
        self.assertEqual([r["client_event_id"] for r in rows], ["evt-unknown", "evt-bad", "evt-keys", "evt-deep"])
        self.assertEqual({r["code"] for r in rows}, {"invalid_payload"})
        status, health = self.request("/api/teacher/data-health?classId=local-r-class", key=self.teacher_key)
        self.assertEqual(status, 200)
        unknown = {u["type"]: u for u in health["clientReported"]["unknownPayloadKeys"]}
        self.assertEqual(sorted(unknown["code_run"]["keys"]), ["mystery", "other"])
        self.assertEqual(unknown["code_run"]["count"], 1)
        self.assertEqual(health["events"]["rejected"], [{"code": "invalid_payload", "count": 4}])

    def test_server_owned_modes(self):  # TELEMETRY-19, AU-D1-M05, TR09
        hw = None
        with self.db() as db:
            hw = testsupport.publish_work(db, "local-r-class", kind="practice")
        answer = {"assignmentId": hw.id, "answer": "4", "correct": True}
        with patch.dict(os.environ, {"KIWI_SERVER_OWNED_EVENTS": "enforce"}):
            status, body = self.post(v2("answer_submitted", answer, event_id="evt-v2", question_id="q1"))
            self.assertEqual((status, body["code"]), (422, "server_owned_event"))
            legacy = {"classId": "local-r-class", "studentId": "demo-ada", "studentName": "Ada", "sessionId": "tab",
                      "type": "answer_submitted", "questionId": "q1", "payload": answer}
            status, body = self.post(legacy)
            self.assertEqual(status, 201)
            with self.db() as db:
                stored = db.execute("SELECT * FROM events WHERE id=?", (body["id"],)).fetchone()
            self.assertEqual(stored["checked_by"], "client")
            for kind in ("ai_question", "question_generated"):
                status, body = self.post({**legacy, "type": kind, "payload": {"prompt": "x"}})
                self.assertEqual((status, body["code"]), (422, "server_owned_event"), kind)
        with patch.dict(os.environ, {"KIWI_SERVER_OWNED_EVENTS": "accept"}):
            status, body = self.post(v2("answer_submitted", answer, event_id="evt-accept", question_id="q1"))
            self.assertEqual(status, 201)
        accepted = self.row("evt-accept")
        self.assertEqual(accepted["checked_by"], "client")
        self.assertTrue(json.loads(accepted["payload_json"])["_clientReported"])
        with self.db() as db:
            session = db.execute("SELECT SUM(checked), SUM(correct), SUM(clientChecked) FROM learning_sessions "
                                 "WHERE assignmentId=?", (hw.id,)).fetchone()
            self.assertEqual(tuple(session), (0, 0, 2))
            codes = [r[0] for r in db.execute("SELECT code FROM event_rejections ORDER BY id")]
        self.assertEqual(codes, ["server_owned_event"] * 3)

    def test_batch_statuses_and_envelope_errors(self):  # §6.2, TELEMETRY-24
        events = [v2("code_edited", {"code": "a"}, event_id="b-1"), v2("code_edited", {"code": "a"}, event_id="b-1"),
                  v2("nope", {}, event_id="b-2"), v2("page_view", {"route": "/student/code"}, event_id="b-3")]
        status, body = self.request("/api/events/batch", "POST", {"classId": "local-r-class", "events": events}, student="demo-ada")
        self.assertEqual(status, 200)
        self.assertEqual([r["status"] for r in body["results"]], ["created", "duplicate", "rejected", "created"])
        self.assertEqual(body["results"][2]["code"], "invalid_payload")
        bad = [
            {"classId": "local-r-class", "events": "nope"},
            {"classId": "local-r-class", "events": [v2("page_view", {}) for _ in range(51)]},
            {"classId": "local-r-class", "events": [v2("page_view", {}), v2("page_view", {}, class_id="other")]},
        ]
        # > 600 KB is refused by the router before the body is read (max_body; FOUNDATION covers the mechanism)
        spec = next(r for r in router.REGISTRY.routes if r.method == "POST" and r.template == "/api/events/batch")
        self.assertEqual(spec.max_body, 600_000)
        for payload in bad:
            status, body = self.request("/api/events/batch", "POST", payload, student="demo-ada")
            self.assertEqual((status, body["code"]), (400, "invalid_request"))
        with self.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE event_id LIKE 'b-%'").fetchone()[0], 2)

    def test_paged_teacher_events(self):  # §6.2 GET /api/teacher/events paged=1
        for index in range(5):
            self.post(v2("code_run", {"code": f"print({index})", "ok": True}, event_id=f"evt-p{index}"))
        self.post(v2("page_view", {"route": "/student/code"}, event_id="evt-pv"))
        status, page = self.request("/api/teacher/events?classId=local-r-class&paged=1&limit=3&type=code_run", key=self.teacher_key)
        self.assertEqual(status, 200)
        self.assertEqual((len(page["events"]), page["hasMore"]), (3, True))
        first = page["events"][0]
        for key in ("source", "upstreamId", "learningSessionId", "practiceMode", "checkedBy", "actorRole", "receivedAt"):
            self.assertIn(key, first)
        self.assertEqual(first["practiceMode"], "workspace")
        status, rest = self.request(f"/api/teacher/events?classId=local-r-class&paged=1&limit=3&type=code_run&after={page['nextCursor']}",
                                    key=self.teacher_key)
        self.assertEqual((len(rest["events"]), rest["hasMore"], rest["nextCursor"]), (2, False, None))
        ids = [e["id"] for e in page["events"] + rest["events"]]
        self.assertEqual(ids, sorted(ids, reverse=True))
        status, legacy = self.request("/api/teacher/events?classId=local-r-class&type=page_view", key=self.teacher_key)
        self.assertEqual((status, [e["type"] for e in legacy]), (200, ["page_view"]))
        status, body = self.request("/api/teacher/events?classId=local-r-class&paged=1&after=zz", key=self.teacher_key)
        self.assertEqual(status, 400)

    def test_linked_class_rows_store_no_name(self):  # §11.2 step 1, AU-D4-10
        with testsupport.fake_kiwi_identity("student", class_id="local-css-demo", user_id="s1", username="ada@example.edu") as token:
            event = v2("code_run", {"ok": True}, class_id="local-css-demo", student="s1", event_id="evt-linked")
            status, _ = self.request("/api/events?classId=local-css-demo", "POST", event, token=token)
            self.assertEqual(status, 201)
        row = self.row("evt-linked")
        self.assertEqual((row["student_name"], row["identity_verified"], row["actor_role"]), ("", 1, "student"))
        with self.db() as db:
            roster = db.execute("SELECT source, kiwi_email FROM roster WHERE class_id='local-css-demo' AND student_id='s1'").fetchone()
        self.assertEqual(tuple(roster), ("activity", "ada@example.edu"))


class _RaisingHandler(app.Handler):
    registry: Registry | None = None

    def do_GET(self) -> None:
        router.dispatch(self, "GET", self.registry)


class DataHealthTests(ApiTestCase):
    def test_outages_merge_client_gaps_and_minutes(self):  # TELEMETRY-20, §13.10
        with self.db() as db, testsupport.freeze_time("2026-10-21T11:00:00+00:00"):
            ident = testsupport.student_identity(db, "local-r-class", "demo-ada")
            for start, end, dropped in (("10:00", "10:05", 30), ("10:04", "10:12", 11)):
                telemetry.add_event(db, ident, v2("telemetry_gap", {
                    "droppedCount": dropped, "droppedTypes": {"code_edited": dropped}, "reason": "overflow",
                    "fromTs": ms(f"2026-10-21T{start}:00+00:00"), "toTs": ms(f"2026-10-21T{end}:00+00:00")}))
            telemetry.add_event(db, testsupport.student_identity(db, "local-r-class", "demo-bo"), v2("telemetry_gap", {
                "droppedCount": 2, "droppedTypes": {"page_view": 2}, "reason": "overflow",
                "fromTs": ms("2026-10-21T10:40:00+00:00"), "toTs": ms("2026-10-21T10:41:00+00:00")}, student="demo-bo"))
            for minute in ("10:20", "10:21", "10:22", "10:40"):
                db.execute("INSERT INTO service_incidents (class_id, minute, kind, count) VALUES ('local-r-class', ?, 'server_error', 2)",
                           (f"2026-10-21T{minute}",))
            db.execute("INSERT INTO service_incidents (class_id, minute, kind, count) VALUES ('local-r-class', '2026-10-21T10:30', "
                       "'kiwi_unreachable', 1)")
            db.commit()
            outages = telemetry.data_health(db, "local-r-class", "2026-10-21T00:00:00+00:00", "2026-10-22T00:00:00+00:00")["outages"]
        gaps = [o for o in outages if o["kind"] == "client_gap"]
        errors = [o for o in outages if o["kind"] == "server_error"]
        self.assertEqual([(g["from"][11:16], g["to"][11:16], g["count"]) for g in gaps], [("10:00", "10:12", 41), ("10:40", "10:41", 2)])
        self.assertEqual([(e["from"][11:16], e["to"][11:16], e["count"]) for e in errors], [("10:20", "10:23", 6), ("10:40", "10:41", 2)])
        self.assertEqual([o["kind"] for o in outages if o["kind"] == "kiwi_unreachable"], ["kiwi_unreachable"])

    def test_router_500_counts_incident(self):  # TELEMETRY-20 (test route raising)
        reg = Registry()

        @reg.route("GET", "/api/boom", auth=Auth.PUBLIC)
        def boom(req):
            raise RuntimeError("boom")

        handler = type("H", (_RaisingHandler,), {"registry": reg})
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(handler, "log_message", lambda *a, **k: None):
                with self.assertRaises(HTTPError) as caught:
                    urlopen(UrlRequest(f"http://127.0.0.1:{server.server_port}/api/boom?classId=local-r-class"))
                self.assertEqual(caught.exception.code, 500)
                caught.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        with self.db() as db:
            health = telemetry.data_health(db, "local-r-class", None, None)
        self.assertEqual([o["kind"] for o in health["outages"]], ["server_error"])

    def test_counts_reported(self):  # TELEMETRY-16
        with self.db() as db, testsupport.freeze_time("2026-10-22T02:00:05+00:00"):
            hw = testsupport.publish_work(db, "local-r-class")
            testsupport.make_chat_turn(db, "local-r-class", "demo-ada", "Why NA?", "Use na.rm.")
            db.execute("INSERT INTO events (class_id, student_id, student_name, session_id, event_type, payload_json, created_at) "
                       "VALUES ('local-r-class','demo-ada','Ada','b','ai_question','{\"prompt\":\"old\"}', ?)", (dbmod.now(),))
            db.commit()
            ident = testsupport.student_identity(db, "local-r-class", "demo-ada")
            event = v2("code_run", {"ok": True, "output": "x" * 50000}, event_id="dup-1")
            telemetry.add_event(db, ident, event)
            telemetry.add_event(db, ident, event)
            telemetry.add_event(db, ident, v2("ai_request_unreached", {"action": "chat", "reason": "network"}))
            for _ in range(3):
                telemetry.add_event(db, ident, v2("study_heartbeat", {"seconds": 30}, client_ts=dbmod.now_ms()))
            testsupport.make_server_check(db, "local-r-class", "demo-ada", hw.id, "q1", "4", True, preview=True)
            health = telemetry.data_health(db, "local-r-class", None, None)
        self.assertEqual(health["aiTurns"]["serverTurns"], 1)
        self.assertEqual(health["aiTurns"]["withServerEvent"], 1)
        self.assertEqual(health["aiTurns"]["legacyClientOnly"], 1)
        self.assertEqual(health["events"]["duplicatesIgnored"], 1)
        self.assertEqual(health["events"]["truncated"], 1)
        self.assertEqual(health["heartbeats"], {"received": 3, "counted": 1, "duplicates": 2})
        self.assertEqual(health["clientReported"]["aiRequestsUnreached"], 1)
        self.assertEqual(health["identity"]["previewEvents"], 1)
        self.assertEqual(health["aiCalls"]["total"], 1)
        self.assertIn("perStudent", health["kiwi"])
        self.assertIn("range", health)


class DeriveAndIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "telemetry.sqlite3"
        app.init_db()
        dbmod.set_clock(None)

    def tearDown(self) -> None:
        dbmod.set_clock(None)
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def ident(self, db, student="s1", class_id="c1"):
        return testsupport.student_identity(db, class_id, student)

    def test_dedup_sql_on_sqlite_345(self):  # TELEMETRY-24
        self.assertGreaterEqual(tuple(int(p) for p in sqlite3.sqlite_version.split(".")), (3, 45, 0))
        source = inspect.getsource(telemetry)
        self.assertIn("ON CONFLICT(class_id, event_id) WHERE event_id IS NOT NULL DO NOTHING", source)
        self.assertNotIn("INSERT OR IGNORE INTO events", source)
        with app.connection() as db:
            ident = self.ident(db)
            first = telemetry.add_event(db, ident, v2("code_edited", {"code": "a"}, class_id="c1", student="s1", event_id="e-1"))
            again = telemetry.add_event(db, ident, v2("code_edited", {"code": "b"}, class_id="c1", student="s1", event_id="e-1"))
            self.assertEqual((first.status, again.status, again.id), ("created", "duplicate", first.id))
            with self.assertRaises(sqlite3.IntegrityError):  # NOT NULL still raises (no INSERT OR IGNORE)
                db.execute(f"INSERT INTO events ({', '.join(telemetry.EVENT_COLUMNS)}) VALUES "
                           f"({', '.join('?' for _ in telemetry.EVENT_COLUMNS)}) "
                           "ON CONFLICT(class_id, event_id) WHERE event_id IS NOT NULL DO NOTHING",
                           ["c1", "s1", None, "tab", "code_edited", None, "{}", dbmod.now(), "lab", "e-2", 2, dbmod.now(),
                            *[None] * 3, "", "demo", 0, 0, "", "", "", "", "", "", "", None, None, None, None, None, 0, "", ""])

    def test_heartbeat_bucket_counts_once_two_threads(self):  # TELEMETRY-04, TELEMETRY-24, AU-T-09
        moment = "2026-10-22T02:00:10+00:00"
        with testsupport.freeze_time("2026-10-22T02:01:00+00:00"):
            with app.connection() as db:
                ident = self.ident(db)
                for index in range(41):
                    telemetry.add_event(db, ident, v2("study_heartbeat", {"seconds": 999}, class_id="c1", student="s1",
                                                      client_ts=ms(moment) + index * 100))
                counted = db.execute("SELECT SUM(heartbeat_counted), COUNT(DISTINCT heartbeat_bucket) FROM events "
                                     "WHERE event_type='study_heartbeat'").fetchone()
                self.assertEqual(tuple(counted), (1, 1))
            errors: list[BaseException] = []
            barrier = threading.Barrier(2)

            def write(student_id: str) -> None:
                try:
                    with app.connection() as conn:
                        barrier.wait()
                        telemetry.add_event(conn, testsupport.student_identity(conn, "c1", "s2"),
                                            v2("study_heartbeat", {}, class_id="c1", student="s2", client_ts=ms(moment)))
                except BaseException as exc:  # noqa: BLE001 - surfaced below
                    errors.append(exc)

            threads = [threading.Thread(target=write, args=("s2",)) for _ in range(2)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertEqual(errors, [])
            with app.connection() as db:
                rows = db.execute("SELECT heartbeat_counted FROM events WHERE student_id='s2'").fetchall()
            self.assertEqual(sorted(r[0] for r in rows), [0, 1])

    def test_heartbeat_adds_active_seconds_to_matching_activity(self):  # TELEMETRY-04, DA09
        with testsupport.freeze_time("2026-10-22T02:00:00+00:00") as clock, app.connection() as db:
            hw = testsupport.publish_work(db, "c1")
            ident = self.ident(db)
            ctx = {"assignmentId": hw.id, "unitId": "r-basics", "questionId": "q1"}
            telemetry.add_event(db, ident, v2("question_viewed", {"assignmentId": hw.id, "unitId": "r-basics"}, class_id="c1",
                                              student="s1", question_id="q1"))
            for seconds in (30, 60, 61):
                clock.advance(seconds=30)
                telemetry.add_event(db, ident, v2("study_heartbeat", {"seconds": 1, **ctx}, class_id="c1", student="s1"))
            telemetry.add_event(db, ident, v2("study_heartbeat", {"seconds": 1, **ctx, "questionId": "q2"}, class_id="c1", student="s1"))
            row = db.execute("SELECT activeSeconds, interactions FROM learning_sessions WHERE questionId='q1'").fetchone()
        self.assertEqual(tuple(row), (90, 1))

    def test_session_bounds_min_max_and_no_browser_session(self):  # TELEMETRY-08, TELEMETRY-09
        with testsupport.freeze_time("2026-10-22T10:30:00+00:00"), app.connection() as db:
            ident = self.ident(db)
            for at, tab in (("10:20", "tab-a"), ("10:05", "tab-b")):
                event = v2("code_edited", {"code": "x"}, class_id="c1", student="s1", question_id="q-free-1",
                           client_ts=ms(f"2026-10-22T{at}:00+00:00"), surface="free-practice")
                event["sessionId"] = tab
                telemetry.add_event(db, ident, event)
            rows = db.execute("SELECT startedAt, lastActive, contextKey FROM learning_sessions").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["startedAt"].startswith("2026-10-22T10:05"))
        self.assertTrue(rows[0]["lastActive"].startswith("2026-10-22T10:20"))
        self.assertNotIn("tab-", rows[0]["contextKey"])
        self.assertIn("30 minutes", telemetry.QUESTION_ACTIVITY_RULE)

    def test_submission_title_and_workspace_attribution(self):  # TELEMETRY-15, NM26, AU-D4-M6
        with app.connection() as db:
            hw = testsupport.publish_work(db, "c1")
            testsupport.make_autochecked_submission(db, "c1", "s1", hw.id, {"q1": "4", "q2": "A vector"})
            title = db.execute("SELECT title FROM learning_sessions WHERE kind='submission'").fetchone()[0]
            self.assertEqual(title, "Homework submission · Attempt 1")
            ident = self.ident(db)
            telemetry.add_event(db, ident, v2("code_run", {"ok": True, "unitId": "r-basics",
                                                           "attribution": {"chapter": "unattributed"}}, class_id="c1", student="s1",
                                              surface="workspace"))
            telemetry.add_event(db, ident, v2("code_run", {"ok": True, "unitId": "text-analysis",
                                                           "attribution": {"chapter": "selected"}}, class_id="c1", student="s1",
                                              surface="workspace"))
            units = sorted(r[0] for r in db.execute("SELECT unitId FROM learning_sessions WHERE practiceMode='workspace'"))
        self.assertEqual(units, ["", "text-analysis"])

    def _legacy(self, db, event_type, question_id, payload, at, *, session="legacy-session-1", schema=1):
        cur = db.execute(
            "INSERT INTO events (class_id, student_id, student_name, session_id, event_type, question_id, payload_json, created_at, "
            "learning_session_id, schema_version) VALUES ('c1','s1','Ada','browser',?,?,?,?,?,?)",
            (event_type, question_id, json.dumps(payload), at, session, schema))
        return cur.lastrowid

    def _seed_legacy(self, db):
        """Pre-v0.6 rows: a homework with its own question, legacy similar attempts carrying the parent id, an in-class check."""
        testsupport.publish_work(db, "c1", work_id=HW, questions=[
            {"id": "q-own", "type": "fill", "prompt": "Mean ignoring NA of c(2, NA, 8)?", "answer": "5", "points": 10}])
        practice = testsupport.publish_work(db, "c1", kind="practice", questions=[
            {"id": "p1", "type": "predict", "prompt": "print('hello')", "answer": '[1] "hello"', "points": 1}])
        db.execute("UPDATE assignments SET updated_at='2026-10-01T00:00:00+00:00'")
        db.execute("INSERT INTO learning_sessions (id, classId, studentId, studentName, browserSession, contextKey, unitId, "
                   "assignmentId, questionId, kind, title, startedAt, lastActive) VALUES "
                   "('legacy-session-1','c1','s1','Ada','browser','[]','r-basics',?,'q-own','question','Old','t','t'),"
                   "('legacy-session-2','c1','s1','Ada','browser','[]','r-basics',?,'p1','question','Old','t','t')", (HW, practice.id))
        ids = {
            "own": self._legacy(db, "answer_submitted", "q-own", {"assignmentId": HW, "answer": "5", "correct": True},
                                "2026-10-14T10:00:00+00:00"),
            "sim1": self._legacy(db, "answer_submitted", "q-4176b069-890c-4be5-8a48-e5bf63a87f5d",
                                 {"assignmentId": HW, "answer": "B", "correct": True}, "2026-10-14T10:02:00+00:00"),
            "sim2": self._legacy(db, "answer_submitted", "q-4176b069-890c-4be5-8a48-e5bf63a87f5d",
                                 {"assignmentId": HW, "answer": "C", "correct": False}, "2026-10-14T10:03:00+00:00"),
            "inclass": self._legacy(db, "answer_submitted", "p1", {"assignmentId": practice.id, "answer": '[1] "Hello"', "correct": True},
                                    "2026-10-14T10:05:00+00:00", session="legacy-session-2"),
        }
        db.commit()
        return practice, ids

    def _rebuild(self, db):
        db.execute("DELETE FROM telemetry_meta WHERE version LIKE 'sessions-v3%' OR version LIKE 'legacy-rejudge:%'")
        db.commit()
        telemetry.init(db)

    def test_sessions_v3_attribution_of_legacy_rows(self):  # TELEMETRY-03, TR01, AU-D1-M02, AU-D2-M1, AU-D3-12
        with app.connection() as db:
            practice, ids = self._seed_legacy(db)
            self._rebuild(db)
            rows = {r["id"]: r for r in db.execute("SELECT * FROM events")}
            for key in ("sim1", "sim2"):
                row = rows[ids[key]]
                self.assertEqual((row["practice_mode"], row["attribution_assignment_id"], row["related_assignment_id"]),
                                 ("similar", "", HW))
            self.assertEqual(rows[ids["own"]]["attribution_assignment_id"], HW)
            self.assertEqual(rows[ids["inclass"]]["checked_by"], "legacy_server")
            self.assertEqual(json.loads(rows[ids["sim1"]]["payload_json"]), {"assignmentId": HW, "answer": "B", "correct": True})
            homework = db.execute("SELECT SUM(attempts) FROM learning_sessions WHERE assignmentId=?", (HW,)).fetchone()[0]
            related = db.execute("SELECT SUM(attempts), MIN(practiceMode) FROM learning_sessions WHERE relatedAssignmentId=?",
                                 (HW,)).fetchone()
        self.assertEqual(homework, 1)  # the homework's own question only
        self.assertEqual(tuple(related), (2, "similar"))

    def test_sessions_v3_interrupted_rebuild_restarts_with_aliases(self):  # TELEMETRY-26, AU-D3-20, AU-D4-M8
        with app.connection() as db:
            self._seed_legacy(db)
            self.assertEqual(migrations.list_backups(db, "sessions-v3"), [])
            db.execute("DELETE FROM telemetry_meta WHERE version LIKE 'sessions-v3%'")
            db.commit()
            original = telemetry.index_event
            calls = {"n": 0}

            def flaky(conn, row):
                calls["n"] += 1
                if calls["n"] == 2:
                    raise RuntimeError("injected interruption")
                return original(conn, row)

            with patch.object(telemetry, "index_event", flaky):
                with self.assertRaises(RuntimeError):
                    telemetry.init(db)
            if db.in_transaction:
                db.rollback()
            self.assertFalse(db.execute("SELECT 1 FROM telemetry_meta WHERE version='sessions-v3'").fetchone())
            self.assertGreater(db.execute("SELECT COUNT(*) FROM learning_session_v2_map").fetchone()[0], 0)
            telemetry.init(db)
            telemetry.init(db)
            aliases = {r["old_id"]: r["new_id"] for r in db.execute("SELECT * FROM learning_session_aliases")}
            self.assertEqual(set(aliases), {"legacy-session-1", "legacy-session-2"})
            for new_id in aliases.values():
                self.assertTrue(db.execute("SELECT 1 FROM learning_sessions WHERE id=?", (new_id,)).fetchone())
            self.assertEqual(db.execute("SELECT COUNT(*) FROM learning_session_v2_map").fetchone()[0], 0)
            self.assertTrue(db.execute("SELECT 1 FROM telemetry_meta WHERE version='sessions-v3'").fetchone())
            self.assertEqual(len(migrations.list_backups(db, "sessions-v3")), 1)

    def test_legacy_rejudge(self):  # TELEMETRY-27, AU-D1-06
        def stub(question, answer, run_output=None, provenance="client"):
            expected = question.get("answer")
            correct = None if expected is None else answer == expected
            return CheckResult(correct, None if correct is None else float(correct), "exact", "answer_text", answer)

        with app.connection() as db:
            practice, ids = self._seed_legacy(db)
            edited = self._legacy(db, "answer_submitted", "p1", {"assignmentId": practice.id, "answer": '[1] "hello"', "correct": True},
                                  "2026-10-14T10:06:00+00:00", session="legacy-session-2")
            other = testsupport.publish_work(db, "c1", kind="practice", questions=[
                {"id": "x1", "type": "fill", "prompt": "P", "answer": "1", "points": 1}])
            late = self._legacy(db, "answer_submitted", "x1", {"assignmentId": other.id, "answer": "1", "correct": True},
                                "2026-10-01T00:00:00+00:00")
            db.commit()
            with patch.object(judging, "check", stub), patch.object(judging, "JUDGING_VERSION", "test-v1"):
                self._rebuild(db)
            values = {r["id"]: r["rejudged_correct"] for r in db.execute("SELECT id, rejudged_correct FROM events")}
            self.assertEqual(values[ids["inclass"]], 0)
            self.assertEqual(values[edited], 1)
            self.assertIsNone(values[late])  # assignment edited after the attempt
            self.assertTrue(db.execute("SELECT 1 FROM telemetry_meta WHERE version='legacy-rejudge:test-v1'").fetchone())
            with patch.object(judging, "check", lambda *a, **k: CheckResult(True, 1.0, "exact", "answer_text", "")), \
                    patch.object(judging, "JUDGING_VERSION", "test-v2"):
                telemetry.init(db)
            self.assertEqual(db.execute("SELECT rejudged_correct FROM events WHERE id=?", (ids["inclass"],)).fetchone()[0], 1)
            self.assertTrue(db.execute("SELECT 1 FROM telemetry_meta WHERE version='legacy-rejudge:test-v2'").fetchone())

    def test_fresh_database_takes_no_rebuild_backup(self):  # FOUNDATION-10 (a) compatibility
        with app.connection() as db:
            self.assertEqual(migrations.list_backups(db), [])
            self.assertTrue(telemetry.rebuild_done(db, "sessions-v3"))
            self.assertFalse(telemetry._meta(db, "sessions-v3"))  # the plain tag stays free for registered rebuilds

    def test_registry_mode_default_is_respected(self):  # §11.2 step 3 (code default until INTEGRATION)
        with patch.dict(os.environ, {"KIWI_SERVER_OWNED_EVENTS": ""}):
            self.assertEqual(event_schema.server_owned_mode(), event_schema.SERVER_OWNED_MODE)


if __name__ == "__main__":
    unittest.main()
