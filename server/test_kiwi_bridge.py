"""Native activity reconciliation and the live course identity boundary (owned by TELEMETRY).

FOUNDATION: ``IdentityBoundaryTests`` now uses ``testsupport.ApiTestCase``; ``SyncRouteTests`` covers the
roster-metadata path of ``kiwi_bridge.sync()`` after migration (FOUNDATION-14, §19.4).
"""
import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import app, identity, kiwi_bridge, telemetry, testsupport
from server.testsupport import ApiTestCase, fake_kiwi_context


def record(id="native-1", kind="frontend-interaction-chat", **overrides):
    return {"id": id, "userId": "s1", "user": {"email": "ada@example.edu"},
            "sessionId": "native-session", "timestamp": "2026-10-15T01:00:00.000Z", "type": kind,
            "context": {"content": {"prompt": "Why does mean return NA?"}},
            "pdfId": "doc-1", "pdfPage": 1, "conversationId": "native-thread", "serverActions": [], **overrides}


class ReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "bridge.sqlite3"
        app.init_db()
        self.materials = {"doc-1": {"id": "material-1", "title": "Lecture 2", "unit_id": "r-basics"}}

    def tearDown(self):
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def test_native_reply_replaces_evidence_without_inflating_counts(self):
        r = record()
        with app.connection() as db:
            self.assertTrue(kiwi_bridge.import_record(db, "c1", r, self.materials))
            self.assertFalse(kiwi_bridge.import_record(db, "c1", r, self.materials))
            r["serverActions"] = [{"id": "reply-1", "botResponse": "Use na.rm = TRUE."}]
            self.assertFalse(kiwi_bridge.import_record(db, "c1", r, self.materials))
            row = db.execute("SELECT * FROM learning_sessions").fetchone()
            self.assertEqual((row["interactions"], row["aiQuestions"], row["materialId"], row["source"]), (1, 1, "material-1", "kiwi"))
            # TELEMETRY: asserted on the index tables directly (INSIGHTS owns the query layer in analytics.py)
            events = db.execute("SELECT * FROM events WHERE learning_session_id=?", (row["id"],)).fetchall()
            self.assertEqual(json.loads(events[0]["payload_json"])["response"], "Use na.rm = TRUE.")
            self.assertEqual(json.loads(events[0]["payload_json"])["page"], 1)
            self.assertEqual(events[0]["upstream_id"], "native-1")

    def test_unknown_code_outcome_is_not_counted_as_success(self):
        with app.connection() as db:
            for id, result in [("legacy", {"success": True}), ("ok", {"success": True, "resultVersion": "captured-result-v1"}), ("error", {"success": False, "error": "missing object", "resultVersion": "captured-result-v1"})]:
                kiwi_bridge.import_record(db, "c1", record(id, "frontend-interaction-ide-runcode", pdfId=None, pdfPage=None,
                    conversationId=None, context={"userCode": "print(x)", "outputCode": "output", **result}), {})
            rows = db.execute("SELECT * FROM learning_sessions WHERE classId='c1' AND source='kiwi'").fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual((rows[0]["codeRuns"], rows[0]["codeSuccesses"], rows[0]["codeErrors"]), (3, 1, 1))
            self.assertEqual(rows[0]["codeRuns"] - rows[0]["codeSuccesses"] - rows[0]["codeErrors"], 1)  # run result not recorded

    def test_native_reading_and_chat_use_consistent_page_numbers(self):
        self.assertEqual(kiwi_bridge.payload_for(record(kind="frontend-interaction-pdf-change", pdfPage=0), self.materials)[1]["page"], 1)
        self.assertEqual(kiwi_bridge.payload_for(record(pdfPage=1), self.materials)[1]["page"], 1)

    def test_mapping_keeps_session_and_counts_and_filters_native_materials(self):
        with app.connection() as db:
            db.execute("INSERT INTO kiwi_materials VALUES (?,?,?,?,?)", ("c1", "material-1", "Lecture 2", '["doc-1"]', ""))
            kiwi_bridge.import_record(db, "c1", record(), {"doc-1": {**self.materials["doc-1"], "unit_id": ""}})
            original = db.execute("SELECT id FROM learning_sessions").fetchone()[0]
            kiwi_bridge.map_material(db, "c1", "material-1", "r-basics")
            kiwi_bridge.import_record(db, "c1", record("native-2"), self.materials)
            row = db.execute("SELECT * FROM learning_sessions WHERE classId='c1' AND source='kiwi' AND materialId='material-1' "
                             "AND unitId='r-basics'").fetchone()
            self.assertEqual((row["id"], row["interactions"]), (original, 2))
            self.assertEqual(db.execute("SELECT title FROM kiwi_materials WHERE class_id='c1'").fetchone()[0], "Lecture 2")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM learning_sessions WHERE classId='other'").fetchone()[0], 0)

    def test_durable_paging_and_replay_are_idempotent(self):
        base = {"classId": "c1", "snapshot": "2026-10-15T01:05:00.000Z", "hasMore": False, "nextCursor": "cursor-1", "records": [record()]}
        page1 = {**base, "hasMore": True, "materials": [{"id": "material-1", "title": "Lecture 2", "documents": [{"id": "doc-1"}]}]}
        page2 = {**base, "records": [record("native-2")], "nextCursor": "cursor-2"}
        with patch.object(kiwi_bridge, "remote", side_effect=[page1, page2]) as remote:
            s = kiwi_bridge.sync(app.connection, "c1", "never-log-this-token")
            self.assertEqual(s["nativeEvents"], 2)
            self.assertFalse(s["hasMore"])
            self.assertEqual(remote.call_args_list[1].args[2]["cursor"], "cursor-1")
        with patch.object(kiwi_bridge, "remote", return_value=base):
            self.assertEqual(kiwi_bridge.sync(app.connection, "c1", "token")["nativeEvents"], 2)


class IdentityBoundaryTests(ApiTestCase):
    def test_live_students_cannot_spoof_roles_students_or_courses(self):
        context = {"classId": "live-course", "userId": "s1", "username": "ada@example.edu", "userRole": "student",
                   "canTeach": False, "canManageCourse": False, "canViewAnalytics": False}
        with patch.object(kiwi_bridge, "remote", return_value=context):
            self.assertEqual(self.request("/api/kiwi/context?classId=live-course", token="student")[0], 200)
            self.assertEqual(self.request("/api/teacher/analytics/metrics?classId=live-course", token="student")[0], 403)
            self.assertEqual(self.request("/api/course?classId=other", token="student")[0], 403)
            self.assertEqual(self.request("/api/events?classId=live-course&studentId=s2", token="student")[0], 403)
            event = {"classId": "live-course", "studentId": "s2", "studentName": "spoof", "sessionId": "browser", "type": "ai_question", "payload": {}}
            self.assertEqual(self.request("/api/events?classId=live-course", "POST", event, token="student")[0], 403)
            event["studentId"] = "s1"
            # INTEGRATION-05: a client copy of the server-owned ai_question is refused in the default `enforce` mode
            status, body = self.request("/api/events?classId=live-course", "POST", event, token="student")
            self.assertEqual((status, body["code"]), (422, "server_owned_event"))
            event["type"] = "code_run"  # the anti-spoof check below uses a client-owned type
            event["source"] = "kiwi"
            event["payload"] = {"source": "kiwi", "code": "spoof source"}
            self.assertEqual(self.request("/api/events?classId=live-course", "POST", event, token="student")[0], 201)
            with app.connection() as db:
                row = db.execute("SELECT student_name,source FROM events").fetchone()
                self.assertEqual(tuple(row), ("", "lab"))  # v0.6 linked rows store no name (§11.2 step 1)
        self.assertEqual(self.request("/api/teacher/analytics/metrics?classId=live-course", key="test-teacher-key")[0], 401)
        self.assertEqual(self.request("/api/events?classId=live-course&studentId=s1")[0], 401)
        self.assertEqual(self.request("/api/events?classId=local-r-class", "POST", event)[0], 403)
        self.assertEqual(self.request("/api/events", "POST", event)[0], 401)

    def test_verified_course_analyst_needs_no_local_teacher_key(self):
        context = {"classId": "live-course", "userId": "t1", "username": "teacher@example.edu", "userRole": "professor",
                   "canTeach": True, "canManageCourse": False, "canViewAnalytics": True}
        with patch.object(kiwi_bridge, "remote", return_value=context):
            self.assertEqual(self.request("/api/teacher/verify?classId=live-course", "POST", token="teacher")[0], 200)
            self.assertEqual(self.request("/api/teacher/analytics/metrics?classId=live-course", token="teacher")[0], 200)
            self.assertEqual(self.request("/api/teacher/hub?classId=live-course", token="teacher")[0], 200)
            self.assertEqual(self.request("/api/course?classId=live-course", "PUT", app.DEFAULT_COURSE, token="teacher")[0], 403)


class SyncRouteTests(ApiTestCase):
    DEMO = "00000000-0000-4000-8000-000000000192"
    NEW = "00000000-0000-4000-8000-000000000193"

    def _remote(self, batch):
        context = fake_kiwi_context("staff", can_manage=True, can_view=True, class_id="local-css-demo", user_id="t1")

        def remote(token, path, params=None):
            return dict(context) if path == "context" else batch

        return remote

    def test_sync_route_with_roster_metadata_after_migration(self):
        with app.connection() as db:  # the seeded v0.5.1 roster row (scripts/local-kiwi/seed-app.mjs)
            db.execute("INSERT INTO roster (class_id, student_id, student_name) VALUES ('local-css-demo', ?, 'Demo Student')",
                       (self.DEMO,))
        batch = {"classId": "local-css-demo", "snapshot": "2026-10-15T01:05:00.000Z", "hasMore": False, "nextCursor": "c1",
                 "records": [record("native-9", userId=self.DEMO)], "materials": [],
                 "roster": [{"userId": self.DEMO, "user": {"email": "demo.student@css-kiwi.local"}},
                            {"userId": self.NEW, "user": {"email": "new.student@css-kiwi.local"}}]}
        with patch.object(kiwi_bridge, "remote", side_effect=self._remote(batch)):
            status, result = self.request("/api/teacher/kiwi/sync?classId=local-css-demo", "POST", token="teacher")
            self.assertEqual((status, result["imported"], result["nativeEvents"]), (200, 1, 1))
            self.assertEqual(self.request("/api/teacher/kiwi/sync?classId=local-css-demo", "POST", token="teacher")[1]["imported"], 0)
        with app.connection() as db:
            rows = {r["student_id"]: dict(r) for r in db.execute("SELECT * FROM roster WHERE class_id='local-css-demo'")}
        self.assertEqual(set(rows), {self.DEMO, self.NEW})
        self.assertEqual((rows[self.DEMO]["display_name"], rows[self.DEMO]["source"], rows[self.DEMO]["kiwi_email"]),
                         ("", "kiwi", "demo.student@css-kiwi.local"))
        self.assertEqual(rows[self.DEMO]["student_name"], "Demo Student")
        self.assertEqual((rows[self.NEW]["source"], rows[self.NEW]["pseudonym_seq"]), ("kiwi", 2))
        self.assertEqual(rows[self.DEMO]["pseudonym_seq"], 1)
        with app.connection() as db:
            native = db.execute("SELECT actor_role, identity_verified, category, practice_mode FROM events WHERE source='kiwi'").fetchone()
        self.assertEqual(tuple(native), ("student", 1, "action", "lecture"))

    def test_sync_requires_kiwi_analytics_scope(self):
        status, body = self.request("/api/teacher/kiwi/sync?classId=c1", "POST", key="test-teacher-key")
        self.assertEqual((status, body["code"]), (403, "forbidden"))



# -- v0.6 projection (§15.2) ------------------------------------------------------------------------------
def action(id, text, at="2026-10-15T01:00:05.000Z", kind="chat", engine="gpt"):
    return {"id": id, "type": kind, "botResponse": text, "timestamp": at, "engineChoice": engine}


class ProjectionV3Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "bridge.sqlite3"
        app.init_db()
        self.materials = {"doc-1": {"id": "material-1", "title": "Lecture 2", "unit_id": "r-basics"}}

    def tearDown(self):
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def imported(self, db, upstream):
        return db.execute("SELECT * FROM events WHERE source='kiwi' AND upstream_id=?", (upstream,)).fetchone()

    def test_new_types_ai_responses_and_revisions(self):  # TELEMETRY-10, TELEMETRY-25, DA11, AU-D3-17, AU-D4-22
        with app.connection() as db:
            kiwi_bridge.import_record(db, "c1", record("thumb", "frontend-interaction-thumbs", pdfId=None, pdfPage=None,
                                                       context={"thumbsValue": 1, "targetMessageIndex": 3}), {})
            kiwi_bridge.import_record(db, "c1", record("flag", "frontend-interaction-feedback-flag", pdfId=None, pdfPage=None,
                                                       context={"targetMessageIndex": 2, "flagReply": "Too direct" * 600}), {})
            kiwi_bridge.import_record(db, "c1", record("check", "frontend-interaction-ide-checkanswer", pdfId=None, pdfPage=None,
                                                       conversationId=None, context={"userCode": "x", "outputCode": "1"}), {})
            kiwi_bridge.import_record(db, "c1", record("up", "frontend-interaction-ide-uploadfile", pdfId=None, pdfPage=None,
                                                       conversationId=None, context={"fileName": "data.csv"}), {})
            thumb, flag, check, up = (self.imported(db, k) for k in ("thumb", "flag", "check", "up"))
            self.assertEqual(thumb["event_type"], "ai_feedback")
            self.assertEqual({k: json.loads(thumb["payload_json"])[k] for k in ("conversationId", "targetMessageIndex", "value")},
                             {"conversationId": "native-thread", "targetMessageIndex": 3, "value": 1})
            self.assertEqual(len(json.loads(flag["payload_json"])["reply"]), 4000)
            self.assertEqual(check["event_type"], "kiwi_check_answer")
            self.assertEqual((up["event_type"], json.loads(up["payload_json"])["action"], json.loads(up["payload_json"])["fileName"]),
                             ("kiwi_file_action", "upload", "data.csv"))
            chat = record("chat-1", serverActions=[action("a1", "First"), action("a2", "Second", "2026-10-15T01:00:09.000Z")])
            self.assertTrue(kiwi_bridge.import_record(db, "c1", chat, self.materials))
            row = self.imported(db, "chat-1")
            payload = json.loads(row["payload_json"])
            self.assertEqual((payload["response"], payload["responseCount"]), ("Second", 2))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM ai_responses WHERE class_id='c1'").fetchone()[0], 2)
            chat["serverActions"].append(action("a3", "Third", "2026-10-15T01:00:20.000Z"))
            self.assertFalse(kiwi_bridge.import_record(db, "c1", chat, self.materials))
            revisions = db.execute("SELECT * FROM event_revisions WHERE event_id=?", (row["id"],)).fetchall()
            self.assertEqual(len(revisions), 1)
            self.assertEqual(json.loads(revisions[0]["payload_json_before"])["response"], "Second")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM ai_responses WHERE class_id='c1'").fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT interactions FROM learning_sessions WHERE id=?",
                                        (row["learning_session_id"],)).fetchone()[0], 1)
            # page is not part of the native context key: the same thread on another page joins the activity
            kiwi_bridge.import_record(db, "c1", record("chat-2", pdfPage=7, timestamp="2026-10-15T01:05:00.000Z"), self.materials)
            self.assertEqual(self.imported(db, "chat-2")["learning_session_id"], row["learning_session_id"])
            self.assertEqual(json.loads(self.imported(db, "chat-2")["payload_json"])["page"], 7)
            # re-projection of a v2 row (check-answer was code_shared) updates the type and keeps the old payload
            db.execute("UPDATE events SET event_type='code_shared', payload_json='{\"old\": true}' WHERE id=?", (check["id"],))
            kiwi_bridge.import_record(db, "c1", record("check", "frontend-interaction-ide-checkanswer", pdfId=None, pdfPage=None,
                                                       conversationId=None, context={"userCode": "x", "outputCode": "1"}), {})
            revision = db.execute("SELECT * FROM event_revisions WHERE event_id=?", (check["id"],)).fetchone()
            self.assertEqual((revision["event_type_before"], revision["payload_json_before"]), ("code_shared", '{"old": true}'))
            self.assertEqual(self.imported(db, "check")["event_type"], "kiwi_check_answer")
            self.assertEqual(self.imported(db, "chat-1")["student_name"], "")

    def test_tombstones_map_or_skip_earlier_records(self):  # TELEMETRY-23, AU-D4-13
        with app.connection() as db:
            for student, mode in (("s-anon", "anonymize"), ("s-del", "delete")):
                db.execute("INSERT INTO student_tombstones (class_id, student_hash, anon_id, mode, created_by, created_at) "
                           "VALUES ('c1', ?, ?, ?, 'instructor', '2026-10-16T00:00:00.000+00:00')",
                           (identity.student_hash(db, "c1", student), "anon-" + student, mode))
            for student in ("s-anon", "s-del"):
                for suffix, at in (("early", "2026-10-15T01:00:00.000Z"), ("late", "2026-10-17T01:00:00.000Z")):
                    kiwi_bridge.import_record(db, "c1", record(f"{student}-{suffix}", userId=student, timestamp=at,
                                                               user={"email": f"{student}@example.edu"}), self.materials)
            owners = {r["upstream_id"]: r["student_id"] for r in db.execute("SELECT upstream_id, student_id FROM events WHERE source='kiwi'")}
            self.assertEqual(owners, {"s-anon-early": "anon-s-anon", "s-anon-late": "s-anon", "s-del-late": "s-del"})
            emails = [r[0] for r in db.execute("SELECT kiwi_email FROM roster WHERE student_id LIKE 'anon-%'")]
            self.assertEqual(emails, [])
            self.assertNotIn("s-anon@example.edu", json.dumps([dict(r) for r in db.execute(
                "SELECT * FROM events WHERE student_id='anon-s-anon'")]))
            # the roster sync re-adds a still-enrolled student as a new roster row
            db.execute("DELETE FROM roster WHERE student_id='s-del'")
            kiwi_bridge._apply_metadata(db, "c1", {"roster": [{"userId": "s-del", "user": {"email": "s-del@example.edu"}}]}, False)
            row = db.execute("SELECT source, kiwi_email FROM roster WHERE class_id='c1' AND student_id='s-del'").fetchone()
            self.assertEqual(tuple(row), ("kiwi", "s-del@example.edu"))


class SyncV3Tests(ApiTestCase):
    DEMO = "00000000-0000-4000-8000-000000000192"
    NEW = "00000000-0000-4000-8000-000000000193"

    def setUp(self):
        super().setUp()
        self.calls = []

    def remote_for(self, pages):
        context = fake_kiwi_context("staff", can_manage=True, can_view=True, class_id="local-css-demo", user_id="t1")

        def remote(token, path, params=None):
            if path == "context":
                return dict(context)
            self.calls.append(dict(params or {}))
            key = "user" if (params or {}).get("userId") else "main"
            return pages[key].pop(0) if len(pages[key]) > 1 else pages[key][0]

        return remote

    def batch(self, records, roster, **extra):
        return {"classId": "local-css-demo", "snapshot": "2026-10-20T01:05:00.000Z", "hasMore": False, "nextCursor": "c1",
                "records": records, "materials": [], "roster": roster, **extra}

    def test_metadata_counts_consent_tutoring_mode_and_backfill(self):  # TELEMETRY-11, TELEMETRY-25, TELEMETRY-13, AU-D3-18
        with self.db() as db:
            db.execute("INSERT INTO roster (class_id, student_id, student_name) VALUES ('local-css-demo', ?, 'Demo Student')", (self.DEMO,))
        meta = {"excludedByDesign": 13, "excludedNotEnrolled": 4,
                "appConfig": {"tutoringMode": "guidance", "source": "class_override"}}
        first = self.batch([record("n1", userId=self.DEMO)], [{"userId": self.DEMO, "user": {"email": "demo@x.edu", "consent": True}}], **meta)
        with patch.object(kiwi_bridge, "remote", side_effect=self.remote_for({"main": [first], "user": [self.batch([], [])]})):
            status, result = self.request("/api/teacher/kiwi/sync?classId=local-css-demo", "POST", token="teacher")
        self.assertEqual(status, 200)
        self.assertEqual((result["excludedByDesign"], result["excludedNotEnrolled"]), (13, 4))
        self.assertEqual((result["nativeTutoringMode"], result["nativeTutoringModeSource"]), ("guidance", "class_override"))
        self.assertFalse(any(c.get("userId") for c in self.calls))  # the first sync covers everyone
        with self.db() as db:
            sync = db.execute("SELECT excluded_by_design, excluded_not_enrolled FROM kiwi_sync WHERE class_id='local-css-demo'").fetchone()
            self.assertEqual(tuple(sync), (13, 4))
            demo = db.execute("SELECT * FROM roster WHERE student_id=?", (self.DEMO,)).fetchone()
            self.assertEqual((demo["source"], demo["kiwi_consent"], demo["display_name"], demo["student_name"]),
                             ("kiwi", 1, "", "Demo Student"))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM roster WHERE student_id=?", (self.DEMO,)).fetchone()[0], 1)
        # a student first seen in a later roster sync gets a per-user backfill of earlier native activity
        self.calls.clear()
        second = self.batch([], [{"userId": self.DEMO, "user": {"email": "demo@x.edu", "consent": True}},
                                 {"userId": self.NEW, "user": {"email": "new@x.edu", "consent": False}}], **meta)
        earlier = self.batch([record("n-old", userId=self.NEW, timestamp="2026-10-01T01:00:00.000Z", user={"email": "new@x.edu"})], [])
        with patch.object(kiwi_bridge, "remote", side_effect=self.remote_for({"main": [second], "user": [earlier]})):
            status, result = self.request("/api/teacher/kiwi/sync?classId=local-css-demo", "POST", token="teacher")
        self.assertEqual((status, result["imported"]), (200, 1))
        self.assertEqual([c.get("userId") for c in self.calls if c.get("userId")], [self.NEW])
        with self.db() as db:
            rows = {r["student_id"]: dict(r) for r in db.execute("SELECT * FROM kiwi_user_sync WHERE class_id='local-css-demo'")}
            self.assertTrue(rows[self.NEW]["backfilled_at"])
            self.assertTrue(rows[self.NEW]["last_imported_at"])
            self.assertEqual(db.execute("SELECT kiwi_consent FROM roster WHERE student_id=?", (self.NEW,)).fetchone()[0], 0)
            health = telemetry.data_health(db, "local-css-demo", None, None)
        per = {p["studentId"]: p for p in health["kiwi"]["perStudent"]}
        self.assertTrue(per[self.NEW]["backfilled"])
        self.assertEqual(health["kiwi"]["excludedNotEnrolled"], 4)

    def test_material_route_writes_map_not_payload(self):  # TELEMETRY-14, AU-D1-M09, AU-T-18
        with self.db() as db:
            db.execute("INSERT INTO kiwi_materials VALUES ('local-css-demo','material-1','Lecture 2','[\"doc-1\"]','')")
            kiwi_bridge.import_record(db, "local-css-demo", record("n1", userId=self.DEMO),
                                      {"doc-1": {"id": "material-1", "title": "Lecture 2", "unit_id": ""}})
            before = db.execute("SELECT payload_json FROM events WHERE source='kiwi'").fetchone()[0]
        with testsupport.fake_kiwi_identity("staff", can_manage=True, can_view=True, class_id="local-css-demo") as token:
            for unit in ("r-basics", "data-wrangling"):
                status, body = self.request("/api/teacher/kiwi/material?classId=local-css-demo", "PUT",
                                            {"materialId": "material-1", "unitId": unit}, token=token)
                self.assertEqual(status, 200)
        with self.db() as db:
            self.assertEqual(db.execute("SELECT payload_json FROM events WHERE source='kiwi'").fetchone()[0], before)
            history = [r["unit_id"] for r in db.execute("SELECT unit_id FROM material_unit_map WHERE material_id='material-1' "
                                                         "ORDER BY valid_from")]
            self.assertEqual(history, ["r-basics", "data-wrangling"])
            self.assertEqual(db.execute("SELECT unitId FROM learning_sessions WHERE source='kiwi'").fetchone()[0], "data-wrangling")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM teacher_actions WHERE action='material_map'").fetchone()[0], 2)

    def test_identity_cache_is_bounded_and_outage_is_counted(self):  # TELEMETRY-12, AU-D3-M02
        calls = {"n": 0}
        context = fake_kiwi_context("student", class_id="local-css-demo", user_id="s1")

        def remote(token, path, params=None):
            calls["n"] += 1
            return dict(context)

        clock = {"t": 1_000_000.0}
        with patch.object(kiwi_bridge, "remote", side_effect=remote), patch.object(kiwi_bridge, "_now", lambda: clock["t"]):
            kiwi_bridge._identity_cache.clear()
            for _ in range(3):
                kiwi_bridge.authenticate("Bearer plain-token", "local-css-demo")
            self.assertEqual(calls["n"], 1)
            clock["t"] += 119
            kiwi_bridge.authenticate("Bearer plain-token", "local-css-demo")
            self.assertEqual(calls["n"], 1)
            clock["t"] += 2
            kiwi_bridge.authenticate("Bearer plain-token", "local-css-demo")
            self.assertEqual(calls["n"], 2)
            payload = base64.urlsafe_b64encode(json.dumps({"exp": int(clock["t"]) + 10}).encode()).decode().rstrip("=")
            jwt = f"eyJhbGciOiJub25lIn0.{payload}.sig"
            kiwi_bridge.authenticate("Bearer " + jwt, "local-css-demo")
            clock["t"] += 11
            kiwi_bridge.authenticate("Bearer " + jwt, "local-css-demo")
            self.assertEqual(calls["n"], 4)
        kiwi_bridge._identity_cache.clear()

        def down(token, path, params=None):
            raise kiwi_bridge.BridgeError("Could not reach Kiwi. Saved activity is still available.")

        with patch.object(kiwi_bridge, "remote", side_effect=down):
            event = {"eventId": "evt-out", "classId": "local-css-demo", "studentId": "s1", "studentName": "", "sessionId": "tab",
                     "type": "page_view", "payload": {"route": "/student/code"}, "clientTs": 1, "tzOffsetMin": 0, "seq": 1,
                     "schemaVersion": 2}
            status, body = self.request("/api/events?classId=local-css-demo", "POST", event, token="down")
        self.assertEqual((status, body["code"]), (503, "kiwi_unavailable"))
        with self.db() as db:
            self.assertEqual(db.execute("SELECT SUM(count) FROM service_incidents WHERE kind='kiwi_unreachable'").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE event_id='evt-out'").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
