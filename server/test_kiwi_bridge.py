"""Native activity reconciliation and the live course identity boundary."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import app, analytics, kiwi_bridge
from server import test_app as api_test_support


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
            events = analytics.session_events(db, "c1", row["id"])["events"]
            self.assertEqual(events[0]["payload"]["response"], "Use na.rm = TRUE.")
            self.assertEqual(events[0]["payload"]["page"], 1)
            self.assertEqual(events[0]["upstreamId"], "native-1")

    def test_unknown_code_outcome_is_not_counted_as_success(self):
        with app.connection() as db:
            for id, result in [("legacy", {"success": True}), ("ok", {"success": True, "resultVersion": "captured-result-v1"}), ("error", {"success": False, "error": "missing object", "resultVersion": "captured-result-v1"})]:
                kiwi_bridge.import_record(db, "c1", record(id, "frontend-interaction-ide-runcode", pdfId=None, pdfPage=None,
                    conversationId=None, context={"userCode": "print(x)", "outputCode": "output", **result}), {})
            rows = analytics.table(db, {"classId": "c1", "source": "kiwi", "group": "sessions", "sort": "codeSuccesses"})["rows"]
            self.assertEqual(len(rows), 1)
            self.assertEqual((rows[0]["codeRuns"], rows[0]["codeSuccesses"], rows[0]["codeErrors"]), (3, 1, 1))
            self.assertEqual(analytics.table(db, {"classId": "c1", "activity": "unknown"})["total"], 1)

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
            row = analytics.table(db, {"classId": "c1", "source": "kiwi", "materialId": "material-1", "unitId": "r-basics", "group": "sessions"})["rows"][0]
            self.assertEqual((row["id"], row["interactions"]), (original, 2))
            self.assertEqual(analytics.table(db, {"classId": "c1", "group": "materials"})["rows"][0]["label"], "Lecture 2")
            self.assertEqual(analytics.table(db, {"classId": "other", "source": "kiwi"})["total"], 0)

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


class IdentityBoundaryTests(unittest.TestCase):
    setUp = api_test_support.ApiTests.setUp
    tearDown = api_test_support.ApiTests.tearDown
    request = api_test_support.ApiTests.request

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
            event["source"] = "kiwi"
            event["payload"] = {"source": "kiwi", "prompt": "spoof source"}
            self.assertEqual(self.request("/api/events?classId=live-course", "POST", event, token="student")[0], 201)
            with app.connection() as db:
                row = db.execute("SELECT student_name,source FROM events").fetchone()
                self.assertEqual(tuple(row), ("ada@example.edu", "lab"))
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


if __name__ == "__main__":
    unittest.main()
