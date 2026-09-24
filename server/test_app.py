import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import app


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        app.DB_PATH = Path(self.temp.name) / "test.sqlite3"
        app.TEACHER_KEY = "test-teacher-key"
        app.init_db()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, method="GET", body=None, key=None):
        headers = {"Content-Type": "application/json"}
        if key:
            headers["X-Teacher-Key"] = key
        request = Request(self.url + path, data=json.dumps(body).encode() if body is not None else None,
                          headers=headers, method=method)
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.load(error)

    def test_course_and_event_history(self):
        status, course = self.request("/api/course?classId=cs101")
        self.assertEqual(status, 200)
        self.assertEqual(course["currentUnitId"], "data-wrangling")
        status, _ = self.request("/api/course?classId=cs101", "PUT", course)
        self.assertEqual(status, 401)
        course["currentUnitId"] = "text-analysis"
        status, saved = self.request("/api/course?classId=cs101", "PUT", course, "test-teacher-key")
        self.assertEqual(status, 200)
        self.assertEqual(saved["units"][3]["status"], "current")

        event = {"classId": "cs101", "studentId": "s1", "studentName": "Ada", "sessionId": "session-1",
                 "type": "code_run", "payload": {"code": "print(2)", "output": "[1] 2", "ok": True}}
        status, created = self.request("/api/events", "POST", event)
        self.assertEqual(status, 201)
        self.assertGreater(created["id"], 0)
        status, history = self.request("/api/teacher/events?classId=cs101", key="test-teacher-key")
        self.assertEqual(status, 200)
        self.assertEqual(history[0]["payload"]["code"], "print(2)")
        status, _ = self.request("/api/teacher/events?classId=cs101")
        self.assertEqual(status, 401)
        status, summary = self.request("/api/teacher/summary?classId=cs101", key="test-teacher-key")
        self.assertEqual(status, 200)
        self.assertEqual(summary["students"][0]["runs"], 1)

    def test_event_validation_and_pagination(self):
        event = {"classId": "cs101", "studentId": "s1", "studentName": "Ada", "sessionId": "session-1",
                 "type": "code_run", "payload": {"code": "print(1)"}}
        status, _ = self.request("/api/events", "POST", {**event, "type": "unknown"})
        self.assertEqual(status, 400)
        for number in range(3):
            self.request("/api/events", "POST", {**event, "payload": {"number": number}})
        status, all_events = self.request("/api/teacher/events?classId=cs101", key="test-teacher-key")
        self.assertEqual(status, 200)
        newest = all_events[0]["id"]
        status, older = self.request(f"/api/teacher/events?classId=cs101&beforeId={newest}", key="test-teacher-key")
        self.assertEqual(status, 200)
        self.assertEqual(len(older), 2)

    def test_teacher_workflow_answer_redaction_grading_and_hub(self):
        cls = "css190"
        status, result = self.request(f"/api/teacher/samples?classId={cls}", "POST", key="test-teacher-key")
        self.assertEqual(status, 201)
        self.assertEqual(result["created"], 5)
        status, student_list = self.request(f"/api/work?classId={cls}")
        self.assertEqual(status, 200)
        self.assertEqual(student_list, [])
        status, teacher_list = self.request(f"/api/work?classId={cls}", key="test-teacher-key")
        self.assertEqual(status, 200)
        self.assertTrue(all(work["status"] == "draft" for work in teacher_list))
        practice = next(work for work in teacher_list if work["kind"] == "practice")
        homework = next(work for work in teacher_list if work["title"].startswith("作业 4"))
        self.assertIn("answer", practice["questions"][0])
        for work in (practice, homework):
            status, _ = self.request(f"/api/work/{work['id']}/status?classId={cls}", "POST",
                                     {"status": "published"}, "test-teacher-key")
            self.assertEqual(status, 200)
        status, student_list = self.request(f"/api/work?classId={cls}")
        self.assertEqual(status, 200)
        self.assertEqual(len(student_list), 2)
        self.assertNotIn("answer", student_list[0]["questions"][0])
        self.assertNotIn("explanation", student_list[0]["questions"][0])
        status, checked = self.request(f"/api/work/{practice['id']}/check?classId={cls}", "POST",
            {"studentId": "s1", "studentName": "Ada", "questionId": "p1", "answer": "seq(1, 5, by = 2)"})
        self.assertEqual(status, 200)
        self.assertTrue(checked["correct"])
        status, submitted = self.request(f"/api/work/{homework['id']}/submit?classId={cls}", "POST",
            {"studentId": "s1", "studentName": "Ada", "answers": {"h4a": "sum(edges$to == 'B')", "h4b": "Reciprocity"}})
        self.assertEqual(status, 201)
        self.assertEqual(submitted["attempt"], 1)
        status, second = self.request(f"/api/work/{homework['id']}/submit?classId={cls}", "POST",
            {"studentId": "s1", "studentName": "Ada", "answers": {"h4a": "2", "h4b": "reciprocal"}})
        self.assertEqual(second["attempt"], 2)
        status, _ = self.request(f"/api/submissions/{second['id']}/grade?classId={cls}", "POST",
            {"grade": 18, "feedback": "解释清楚"})
        self.assertEqual(status, 401)
        status, _ = self.request(f"/api/submissions/{second['id']}/grade?classId={cls}", "POST",
            {"grade": 18, "feedback": "解释清楚"}, "test-teacher-key")
        self.assertEqual(status, 200)
        status, own = self.request(f"/api/submissions?classId={cls}&studentId=s1")
        self.assertEqual(len(own), 2)
        self.assertEqual(own[0]["grade"], 18)
        status, _ = self.request(f"/api/teacher/hub?classId={cls}")
        self.assertEqual(status, 401)
        status, hub = self.request(f"/api/teacher/hub?classId={cls}", key="test-teacher-key")
        self.assertEqual(status, 200)
        self.assertEqual(hub["students"][0]["attemptsByAssignment"][homework["id"]], 2)
        self.assertEqual(hub["students"][0]["scoreByAssignment"][homework["id"]], 18)

    def test_teacher_uploaded_assignment(self):
        import base64
        data = {"kind": "homework", "title": "Uploaded QMD", "unitId": "r-basics", "instructions": "Read attachment",
                "questions": [{"id": "q1", "type": "text", "prompt": "What is a vector?", "answer": "A sequence",
                               "points": 5}],
                "attachment": {"name": "homework.qmd", "type": "text/plain",
                               "data": base64.b64encode(b"# Homework\nQuestion one").decode()}}
        status, _ = self.request("/api/work?classId=css190", "POST", data)
        self.assertEqual(status, 401)
        status, work = self.request("/api/work?classId=css190", "POST", data, "test-teacher-key")
        self.assertEqual(status, 201)
        status, _ = self.request(f"/api/work/{work['id']}/attachment?classId=css190")
        self.assertEqual(status, 404)
        self.request(f"/api/work/{work['id']}/status?classId=css190", "POST", {"status": "published"}, "test-teacher-key")
        status, attachment = self.request(f"/api/work/{work['id']}/attachment?classId=css190")
        self.assertEqual(status, 200)
        self.assertEqual(base64.b64decode(attachment["data"]), b"# Homework\nQuestion one")

    def test_roster_includes_inactive_students(self):
        status, _ = self.request("/api/teacher/roster?classId=css190", "POST",
                                 {"students": [{"studentId": "s2", "studentName": "Bo"}]})
        self.assertEqual(status, 401)
        status, imported = self.request("/api/teacher/roster?classId=css190", "POST",
                                        {"students": [{"studentId": "s2", "studentName": "Bo"}]}, "test-teacher-key")
        self.assertEqual(status, 200)
        self.assertEqual(imported["count"], 1)
        status, hub = self.request("/api/teacher/hub?classId=css190", key="test-teacher-key")
        self.assertEqual(hub["students"][0]["studentName"], "Bo")
        self.assertEqual(hub["students"][0]["interactions"], 0)


if __name__ == "__main__":
    unittest.main()
