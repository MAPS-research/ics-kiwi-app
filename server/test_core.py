"""FOUNDATION acceptance tests (spec §9.8: FOUNDATION-04…19) — router, auth, identity, migrations, config."""

from __future__ import annotations

import io
import json
import re
import sqlite3
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from server import (app, auth, course_config, event_schema, identity, migrations, readers, router, telemetry,
                    testsupport)
from server import db as dbmod
from server.router import ApiError, Auth, Registry, Response
from server.testsupport import TEACHER_KEY, ApiTestCase, fake_kiwi_identity

SERVER_DIR = Path(__file__).resolve().parent


def _event(class_id: str, student_id: str, **extra) -> dict:
    return {"classId": class_id, "studentId": student_id, "studentName": "Ada", "sessionId": "browser-1",
            "type": "code_run", "payload": {"code": "print(1)", "ok": True}, **extra}


def _staff(db: sqlite3.Connection, class_id: str, role: str, *, kiwi_user_id: str | None = None) -> tuple[str, str]:
    key = auth.new_staff_key()
    staff_id = "staff-" + key[-12:]
    db.execute(
        """INSERT INTO staff (id, class_id, display_name, role, kiwi_user_id, key_hash, key_prefix, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'instructor', ?)""",
        (staff_id, class_id, f"{role.title()} One", role, kiwi_user_id, None if kiwi_user_id else auth.hash_staff_key(key),
         None if kiwi_user_id else auth.key_prefix(key), dbmod.now()))
    return staff_id, key


class StudentPreviewTests(ApiTestCase):
    def test_staff_requires_preview_on_student_routes(self):  # FOUNDATION-04
        self.create_course("c1")
        status, body = self.request("/api/events", "POST", _event("c1", "instructor"), key=TEACHER_KEY)
        self.assertEqual((status, body["code"]), (403, "preview_required"))
        status, body = self.request("/api/events", "POST", _event("c1", "preview-instructor"), key=TEACHER_KEY, preview=True)
        self.assertEqual(status, 201, body)
        with self.db() as db:
            staff_id, staff_key = _staff(db, "c1", "viewer")
        status, body = self.request("/api/events", "POST", _event("c1", staff_id), key=staff_key)
        self.assertEqual((status, body["code"]), (403, "preview_required"))
        status, body = self.request("/api/events", "POST", _event("c1", f"preview-{staff_id}"), key=staff_key, preview=True)
        self.assertEqual(status, 201, body)
        status, body = self.request("/api/events", "POST", _event("c1", "someone-else"), key=TEACHER_KEY, preview=True)
        self.assertEqual((status, body["code"]), (403, "forbidden"))
        with fake_kiwi_identity("staff", can_manage=True, can_view=True, class_id="live-course", user_id="t1") as token:
            status, body = self.request("/api/events", "POST", _event("live-course", "t1"), token=token)
            self.assertEqual((status, body["code"]), (403, "preview_required"))
            status, body = self.request("/api/events", "POST", _event("live-course", "preview-t1"), token=token, preview=True)
            self.assertEqual(status, 201, body)
        status, body = self.request("/api/events", "POST", _event("c1", "demo-ada"), student="demo-ada", preview=True)
        self.assertEqual((status, body["code"]), (403, "forbidden"))
        with self.db() as db:
            rows = db.execute("SELECT student_id, is_preview, actor_role FROM events ORDER BY id").fetchall()
            self.assertEqual([tuple(r) for r in rows], [("preview-instructor", 1, "preview"), (f"preview-{staff_id}", 1, "preview"),
                                                        ("preview-t1", 1, "preview")])
            for linked in (False, True):
                pop, params = identity.population_sql("e", class_linked=linked)
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM events e WHERE {pop}", params).fetchone()[0], 0)
                pop, params = identity.population_sql("e", class_linked=linked, include_preview=True, include_staff=True)
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM events e WHERE {pop}", params).fetchone()[0], 3)
            self.assertIsNone(db.execute("SELECT 1 FROM roster WHERE student_id LIKE 'preview-%'").fetchone())

    def test_preview_header_requires_staff(self):
        self.create_course("c1")
        status, body = self.request("/api/me?classId=c1", student="demo-ada", preview=True)
        self.assertEqual((status, body["code"]), (403, "forbidden"))
        status, me = self.request("/api/me?classId=c1", key=TEACHER_KEY, preview=True)
        self.assertEqual(status, 200)
        self.assertTrue(me["preview"])
        self.assertEqual(me["role"], "instructor")


class StandaloneIdentityTests(ApiTestCase):
    def test_teacher_key_not_configured_fails_closed(self):  # FOUNDATION-05
        app.TEACHER_KEY = ""
        status, body = self.request("/api/teacher/hub?classId=c1", key="anything")
        self.assertEqual((status, body["code"]), (503, "teacher_key_not_configured"))
        self.assertIn("KIWI_TEACHER_KEY", body["error"])
        status, body = self.request("/api/teacher/verify?classId=c1", "POST", key="anything")
        self.assertEqual(status, 503)
        status, body = self.request("/api/teacher/hub?classId=local-css-demo", key="anything")
        self.assertEqual((status, body["code"]), (401, "unauthenticated"))

    def test_standalone_student_cannot_read_or_write_other_student(self):  # FOUNDATION-05, §19.4
        self.create_course("c1")
        status, _ = self.request("/api/events", "POST", _event("c1", "s1"), student="s1")
        self.assertEqual(status, 201)
        status, body = self.request("/api/events", "POST", _event("c1", "s2"), student="s1")
        self.assertEqual((status, body["code"]), (403, "forbidden"))
        self.assertEqual(self.request("/api/events?classId=c1&studentId=s2", student="s1")[0], 403)
        status, own = self.request("/api/events?classId=c1&studentId=s1", student="s1")
        self.assertEqual((status, len(own)), (200, 1))
        status, body = self.request("/api/events", "POST", _event("c1", "s1"))
        self.assertEqual((status, body["code"]), (401, "unauthenticated"))
        token = self.demo_session("c1", "s1")
        status, body = self.request("/api/events", "POST", _event("c2", "s1"), headers={"X-Demo-Session": token})
        self.assertEqual((status, body["code"]), (403, "forbidden"))
        status, body = self.request("/api/events?classId=c1", "POST", _event("c1", "s1"), headers={"X-Demo-Session": token + "x"})
        self.assertEqual((status, body["code"]), (401, "unauthenticated"))

    def test_unregistered_standalone_class_rejects_writes(self):  # FOUNDATION-05
        status, body = self.request("/api/events", "POST", _event("pop-up", "demo-ada"), student="demo-ada")
        self.assertEqual((status, body["code"]), (404, "unknown_course"))
        self.assertEqual(self.request("/api/work?classId=pop-up", student="demo-ada")[0], 200)
        self.assertEqual(self.request("/api/events", "POST", _event("local-r-class", "demo-ada"), student="demo-ada")[0], 201)
        with self.db() as db:
            testsupport.publish_work(db, "pop-up")
        self.assertEqual(self.request("/api/events", "POST", _event("pop-up", "demo-ada"), student="demo-ada")[0], 201)

    def test_demo_sessions_and_fragment_links(self):  # FOUNDATION-05, AU-T-06
        status, ada = self.request("/api/demo/session?classId=c1", "POST", {"studentId": "demo-ada"})
        self.assertEqual((status, ada["studentId"], ada["studentName"]), (200, "demo-ada", "Ada Chen"))
        self.assertTrue(ada["token"].startswith("demo."))
        self.assertEqual(self.request("/api/demo/session?classId=c1", "POST", {"studentId": "s9"})[0], 403)
        self.assertEqual(self.request("/api/teacher/demo-links?classId=c1", "POST", {"studentId": "s9"})[0], 401)
        status, link = self.request("/api/teacher/demo-links?classId=c1", "POST", {"studentId": "s9"}, key=TEACHER_KEY)
        self.assertEqual(status, 200)
        self.assertTrue(link["url"].startswith("/student/assignments#demo="))
        self.assertNotIn("?", link["url"])
        token = link["url"].split("#demo=", 1)[1]
        self.assertEqual(self.request("/api/demo/session?classId=other", "POST", {"token": token})[0], 403)
        status, session = self.request("/api/demo/session?classId=c1", "POST", {"token": token})
        self.assertEqual((status, session["studentId"]), (200, "s9"))
        with self.db() as db:
            row = db.execute("SELECT source FROM roster WHERE class_id='c1' AND student_id='s9'").fetchone()
            self.assertEqual(row["source"], "import")
        self.assertEqual(self.request("/api/demo/session?classId=local-css-demo", "POST", {"studentId": "demo-ada"})[0], 401)
        with fake_kiwi_identity("staff", can_manage=True, class_id="local-css-demo") as kiwi:
            self.assertEqual(self.request("/api/demo/session?classId=local-css-demo", "POST", {"studentId": "demo-ada"},
                                          token=kiwi)[0], 403)


class BoundaryValidationTests(ApiTestCase):
    def test_list_bodies_and_query_integers_answer_readable_400s(self):  # FOUNDATION-06
        status, body = self.request("/api/work?classId=c1", "POST", [1, 2], key=TEACHER_KEY)
        self.assertEqual((status, body["code"]), (400, "invalid_request"))
        self.assertEqual(body["error"], "Request body must be an object")
        status, body = self.request("/api/teacher/analytics/table?classId=c1&pageSize=abc", key=TEACHER_KEY)
        self.assertEqual((status, body["code"], body["error"]), (400, "invalid_request", "pageSize must be an integer from 1 to 100"))
        status, body = self.request("/api/course?classId=c1", "PUT", b"{not json", key=TEACHER_KEY)
        self.assertEqual((status, body["code"]), (400, "invalid_json"))
        status, body = self.request("/api/course?classId=bad%20id")
        self.assertEqual((status, body["code"]), (400, "invalid_request"))
        status, body = self.request("/api/nope")
        self.assertEqual((status, body["code"]), (404, "not_found"))
        status, body = self.request("/api/course", "DELETE")
        self.assertEqual((status, body["code"]), (405, "method_not_allowed"))
        self.assertNotIn("Traceback", json.dumps(body))


class AuditAndLoggingTests(ApiTestCase):
    def test_log_message_omits_query_strings(self):  # FOUNDATION-07
        captured = io.StringIO()
        with patch("sys.stderr", captured):
            self.request("/api/course?classId=c1&studentId=secret-student-77")
            self.request("/api/teacher/events?classId=c1&studentId=secret-student-77", key=TEACHER_KEY)
        log = captured.getvalue()
        self.assertIn("GET /api/course 200", log)
        self.assertNotIn("secret-student-77", log)
        self.assertNotIn("classId=", log)

    def test_mutations_and_reads_are_audited_with_actor_labels(self):  # FOUNDATION-07
        _, course = self.request("/api/course?classId=c1")
        self.assertEqual(self.request("/api/course?classId=c1", "PUT", course, key=TEACHER_KEY)[0], 200)
        self.assertEqual(self.request("/api/teacher/events?classId=c1&studentId=s1", key=TEACHER_KEY)[0], 200)
        with self.db() as db:
            action = db.execute("SELECT * FROM teacher_actions WHERE class_id='c1'").fetchone()
            self.assertEqual((action["action"], action["actor_label"], action["actor_role"]),
                             ("course_update", "Instructor (local key)", "instructor"))
            access = db.execute("SELECT * FROM data_access_log WHERE class_id='c1'").fetchone()
            self.assertEqual((access["category"], access["endpoint"], access["actor_label"]),
                             ("analytics", "/api/teacher/events", "Instructor (local key)"))
            self.assertEqual(json.loads(access["params_json"])["studentId"], "[redacted]")
            self.assertEqual(access["row_count"], 0)


class RelabelTests(ApiTestCase):
    def test_roster_display_name_overrides_email_in_explorer_gradebook_and_grading(self):  # FOUNDATION-08
        cls = "names"
        self.create_course(cls)
        with self.db() as db:
            work = testsupport.publish_work(db, cls, questions=[{"id": "q1", "type": "text", "prompt": "Explain.", "points": 10}])
        event = {**_event(cls, "s1"), "studentName": "ada@example.edu", "questionId": "q1",
                 "payload": {"assignmentId": work.id, "answer": "x"}, "type": "answer_submitted"}
        self.assertEqual(self.request("/api/events", "POST", event, student="s1")[0], 201)
        status, _ = self.request(f"/api/work/{work.id}/submit?classId={cls}", "POST",
                                 {"studentId": "s1", "studentName": "ada@example.edu", "answers": {"q1": "A vector"}}, student="s1")
        self.assertEqual(status, 201)
        with self.db() as db:
            raw = {r[0] for r in db.execute("SELECT student_name FROM events WHERE class_id=?", (cls,))}
            self.assertEqual(raw, {"ada@example.edu"})
        _, table = self.request(f"/api/teacher/analytics/table?classId={cls}&group=students", key=TEACHER_KEY)
        self.assertEqual(table["rows"][0]["label"], "Student s1")  # demo-link row has no name yet; the email is not a label
        self.assertEqual(self.request(f"/api/teacher/roster?classId={cls}", "POST",
                                      {"students": [{"studentId": "s1", "studentName": "Ada Chen"}]}, key=TEACHER_KEY)[0], 200)
        _, table = self.request(f"/api/teacher/analytics/table?classId={cls}&group=students", key=TEACHER_KEY)
        self.assertEqual([r["label"] for r in table["rows"]], ["Ada Chen"])
        _, sessions = self.request(f"/api/teacher/analytics/table?classId={cls}&group=sessions", key=TEACHER_KEY)
        self.assertTrue(sessions["rows"] and all(r["studentName"] == "Ada Chen" for r in sessions["rows"]))
        _, hub = self.request(f"/api/teacher/hub?classId={cls}", key=TEACHER_KEY)
        self.assertEqual(hub["students"][0]["studentName"], "Ada Chen")
        _, grading = self.request(f"/api/teacher/work-page?classId={cls}&view=grading", key=TEACHER_KEY)
        self.assertEqual(grading["submissions"][0]["studentName"], "Ada Chen")
        _, events = self.request(f"/api/teacher/events?classId={cls}", key=TEACHER_KEY)
        self.assertTrue(all(e["studentName"] == "Ada Chen" for e in events))
        _, pseudo = self.request(f"/api/teacher/analytics/table?classId={cls}&group=students", key=TEACHER_KEY,
                                 name_mode="pseudonyms")
        self.assertEqual(pseudo["rows"][0]["label"], "S-001")
        _, summary = self.request(f"/api/teacher/summary?classId={cls}", key=TEACHER_KEY, name_mode="pseudonyms")
        self.assertEqual(summary["students"][0]["name"], "S-001")


class CourseTests(ApiTestCase):
    def test_course_put_keeps_referenced_chapters(self):  # §19.4
        _, course = self.request("/api/course?classId=c1")
        self.assertEqual(course["freePracticeScope"], "current_and_earlier")
        self.assertEqual({u["effectiveAccess"] for u in course["units"]}, {"open", "locked"})
        with self.db() as db:
            testsupport.publish_work(db, "c1", unit_id="r-basics")
        trimmed = {**course, "units": [u for u in course["units"] if u["id"] != "r-basics"]}
        status, body = self.request("/api/course?classId=c1", "PUT", trimmed, key=TEACHER_KEY)
        self.assertEqual((status, body["code"]), (400, "invalid_request"))
        self.assertIn("Archive the chapter instead", body["error"])
        status, saved = self.request("/api/course?classId=c1", "PUT", course, key=TEACHER_KEY)
        self.assertEqual(status, 200)
        status, body = self.request("/api/course?classId=c1", "PUT", {**course, "baseUpdatedAt": "2020-01-01T00:00:00+00:00"},
                                    key=TEACHER_KEY)
        self.assertEqual((status, body["code"]), (409, "stale_version"))
        status, _ = self.request("/api/course?classId=c1", "PUT", {**saved, "baseUpdatedAt": saved["updatedAt"]}, key=TEACHER_KEY)
        self.assertEqual(status, 200)

    def test_hidden_chapters_are_omitted_for_students(self):
        _, course = self.request("/api/course?classId=c1")
        course["units"][4]["access"] = "hidden"
        status, saved = self.request("/api/course?classId=c1", "PUT", course, key=TEACHER_KEY)
        self.assertEqual((status, saved["units"][4]["effectiveAccess"]), (200, "hidden"))
        _, student_view = self.request("/api/course?classId=c1", student="demo-ada")
        self.assertEqual(len(student_view["units"]), 4)
        _, staff_view = self.request("/api/course?classId=c1", key=TEACHER_KEY)
        self.assertEqual(len(staff_view["units"]), 5)
        bad = {**course, "units": [{**course["units"][0], "runtime": {"packages": ["not-a-package"]}}, *course["units"][1:]]}
        self.assertEqual(self.request("/api/course?classId=c1", "PUT", bad, key=TEACHER_KEY)[0], 400)

    def test_time_range_endpoint(self):
        self.create_course("c1")
        with self.db() as db:
            testsupport.set_meetings(db, "c1", [{"weekday": 2, "time": "10:00", "durationMinutes": 90}])
        with testsupport.freeze_time("2026-10-22T01:00:00+00:00"):
            status, body = self.request("/api/teacher/time-range?classId=c1&preset=since_last_class", key=TEACHER_KEY)
        self.assertEqual((status, body["from"], body["compareLabel"]), (200, "2026-10-20T02:00:00+00:00", "vs last week"))
        self.assertEqual(self.request("/api/teacher/time-range?classId=c1&preset=custom", key=TEACHER_KEY)[0], 400)
        self.assertEqual(self.request("/api/teacher/time-range?classId=c1", student="demo-ada")[0], 403)

    def test_health_and_me(self):
        status, health = self.request("/api/health")
        self.assertEqual((status, health["version"], health["runtime"]), (200, "0.7.0", "browser-webR"))
        self.assertEqual(self.last_headers.get("Cache-Control"), "no-store")
        self.assertEqual(self.last_headers.get("X-Content-Type-Options"), "nosniff")
        self.assertTrue(re.fullmatch(r"[0-9a-f]{32}", self.last_headers.get("X-Request-Id", "")))
        _, anonymous = self.request("/api/me?classId=c1")
        self.assertEqual((anonymous["kind"], anonymous["role"], anonymous["permissions"]), ("anonymous", None, []))
        _, teacher = self.request("/api/me?classId=c1", key=TEACHER_KEY)
        self.assertEqual((teacher["kind"], teacher["role"], teacher["roleSource"], len(teacher["permissions"])),
                         ("teacher_key", "instructor", "key", len(auth.PERMISSIONS)))
        _, ada = self.request("/api/me?classId=c1", student="demo-ada")
        self.assertEqual((ada["kind"], ada["role"], ada["userId"]), ("demo", "student", "demo-ada"))
        self.assertEqual(self.request("/api/me?classId=local-css-demo")[0], 401)


class KiwiRoleOrderTests(ApiTestCase):
    CASES = [
        # (canTeach role, can_manage, can_view, userRole) → (role, roleSource, isStaff)
        (("staff", True, True, "professor"), ("instructor", "kiwi", True)),
        (("staff", False, True, "professor"), ("viewer", "kiwi", True)),
        (("staff", True, False, "ta"), ("ta", "kiwi", True)),
        (("staff", False, True, "ta"), ("ta", "kiwi", True)),
        (("staff", False, False, "ta"), (None, None, True)),
        (("student", False, False, "student"), ("student", None, False)),
    ]

    def test_kiwi_role_order_and_permissions(self):
        for (role, manage, view, user_role), (expected, source, is_staff) in self.CASES:
            with self.subTest(role=role, manage=manage, view=view, user_role=user_role):
                with fake_kiwi_identity(role, manage, view, user_role, class_id="live-course") as token:
                    status, me = self.request("/api/me?classId=live-course", token=token)
                self.assertEqual(status, 200)
                self.assertEqual((me["role"], me["roleSource"], me["isStaff"], me["verified"]), (expected, source, is_staff, True))
                if expected is None:
                    self.assertEqual(me["permissions"], ["previewStudent"])
        with self.db() as db:
            seen = db.execute("SELECT username, kiwi_role FROM kiwi_staff_seen WHERE class_id='live-course'").fetchone()
            self.assertEqual(tuple(seen), ("teacher@example.edu", "ta"))
            self.assertEqual(db.execute("SELECT name FROM kiwi_links WHERE class_id='live-course'").fetchone()[0], "live-course")

    def test_explicit_lab_grant_applies_without_a_host_role_claim(self):
        with self.db() as db:
            _staff(db, "live-course", "ta", kiwi_user_id="t1")
            _staff(db, "live-course", "instructor", kiwi_user_id="s1")
        with fake_kiwi_identity("staff", True, True, "professor", class_id="live-course", user_id="t1") as token:
            _, me = self.request("/api/me?classId=live-course", token=token)
        self.assertEqual((me["role"], me["roleSource"]), ("ta", "override"))
        self.assertNotIn("manageAiRules", me["permissions"])
        with fake_kiwi_identity("student", class_id="live-course", user_id="s1") as token:
            _, me = self.request("/api/me?classId=live-course", token=token)
        self.assertEqual((me["role"], me["roleSource"]), ("instructor", "override"))

    def test_ta_and_viewer_permissions(self):
        self.create_course("c1")
        with self.db() as db:
            _, ta_key = _staff(db, "c1", "ta")
            _, viewer_key = _staff(db, "c1", "viewer")
        self.assertEqual(self.request("/api/teacher/hub?classId=c1", key=viewer_key)[0], 200)
        status, body = self.request("/api/teacher/samples?classId=c1", "POST", key=viewer_key)
        self.assertEqual((status, body["code"]), (403, "role_required"))
        status, body = self.request("/api/teacher/work-page?classId=c1", key=viewer_key)
        self.assertEqual((status, body["code"]), (403, "role_required"))
        self.assertEqual(self.request("/api/teacher/work-page?classId=c1", key=ta_key)[0], 200)
        status, body = self.request("/api/submissions/sub-x/grade?classId=c1", "POST", {"grade": 1}, key=ta_key)
        self.assertEqual((status, body["code"]), (403, "role_required"))
        _, me = self.request("/api/me?classId=c1", key=viewer_key)
        self.assertTrue(me["exportsForcedPseudonymous"])
        self.assertNotIn("exportResearch", me["permissions"])
        with self.db() as db:
            testsupport.update_settings(db, "c1", {"grading": {"taCanRelease": True},
                                                   "privacy": {"viewerCanExportResearch": True}})
        _, ta = self.request("/api/me?classId=c1", key=ta_key)
        self.assertIn("releaseGrades", ta["permissions"])
        _, viewer = self.request("/api/me?classId=c1", key=viewer_key)
        self.assertIn("exportResearch", viewer["permissions"])


class ResearcherRoleTests(ApiTestCase):
    """Decision D3 (docs/handoff/v0.6.0-decisions.md): the ``researcher`` staff role, end to end on the auth matrix."""

    RESEARCHER_PERMISSIONS = ["viewInsights", "viewAiRules", "exportActivity", "exportResearch"]

    def setUp(self) -> None:
        super().setUp()
        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Ada Chen", kiwi_email="ada@example.edu")
            testsupport.make_chat_turn(db, "c1", "s1", "I am Ada Chen (ada@example.edu). Why is mean NA?", "Use na.rm = TRUE.")
            # researchers analyze consenting students only (decision D3, review 2 SECURITY-02)
            db.execute("UPDATE roster SET consent_override='yes' WHERE class_id='c1' AND student_id='s1'")
            db.commit()
            self.researcher_id, self.key = _staff(db, "c1", "researcher")
            # SB-M02: researchers address students by research id only (a raw student id answers 404)
            self.rid = identity.research_id(db, "c1", "s1")

    def test_permission_matrix(self):
        self.assertEqual(router.STAFF_LEVELS[Auth.STAFF_VIEW], ("instructor", "ta", "viewer", "researcher"))
        self.assertNotIn("researcher", router.STAFF_LEVELS[Auth.STAFF_GRADE])
        self.assertNotIn("researcher", router.STAFF_LEVELS[Auth.INSTRUCTOR])
        status, me = self.request("/api/me?classId=c1", key=self.key)
        self.assertEqual((status, me["role"], me["kind"], me["isStaff"]), (200, "researcher", "staff_key", True))
        self.assertEqual(me["permissions"], self.RESEARCHER_PERMISSIONS)
        self.assertTrue(me["exportsForcedPseudonymous"])
        self.assertTrue(me["pseudonymsForced"])
        with self.db() as db:
            testsupport.update_settings(db, "c1", {"grading": {"taCanRelease": True}})
        self.assertEqual(self.request("/api/me?classId=c1", key=self.key)[1]["permissions"], self.RESEARCHER_PERMISSIONS)
        for path in ("/api/teacher/analytics/table", "/api/teacher/ai-conversations/threads", "/api/teacher/metrics",
                     "/api/teacher/data-health", "/api/teacher/ai/rules", "/api/teacher/chapters/summary",
                     "/api/teacher/groups", "/api/teacher/groups/history", "/api/teacher/codebook",
                     f"/api/teacher/timeline?studentId={self.rid}", "/api/teacher/time-range", "/api/teacher/settings",
                     "/api/teacher/kiwi/status", "/api/teacher/exports/codebook.md", "/api/work-options"):
            with self.subTest(allowed=path):
                status, body = self.request(f"{path}{'&' if '?' in path else '?'}classId=c1", key=self.key)
                self.assertEqual(status, 200, body)
        # named teaching views, grading, assignments, editing and every permission-less staff route are refused
        for method, path in (("GET", "/api/teacher/home"), ("GET", "/api/teacher/attention"), ("GET", "/api/teacher/roster"),
                             ("GET", "/api/teacher/students/search?q=ada"), ("GET", "/api/teacher/students/s1/profile"),
                             ("GET", "/api/teacher/hub"), ("GET", "/api/teacher/gradebook"),
                             ("GET", "/api/teacher/grading/queue"), ("GET", "/api/teacher/assignments"),
                             ("GET", "/api/work"), ("GET", "/api/chat"), ("GET", "/api/teacher/assignments/w1/students"),
                             ("GET", "/api/teacher/starter-assignments"), ("GET", "/api/teacher/files"),
                             ("GET", "/api/teacher/staff"), ("GET", "/api/teacher/audit"),
                             ("POST", "/api/teacher/reteach"), ("POST", "/api/teacher/groups"), ("PUT", "/api/teacher/settings"),
                             ("POST", "/api/teacher/ai/rules"), ("PUT", "/api/teacher/chapters/this-week"),
                             ("PUT", "/api/teacher/submissions/sub-x/grade"), ("POST", "/api/teacher/assignments")):
            with self.subTest(denied=f"{method} {path}"):
                status, body = self.request(f"{path}{'&' if '?' in path else '?'}classId=c1", method,
                                            {} if method != "GET" else None, key=self.key)
                self.assertEqual((status, body["code"]), (403, "role_required"), body)
        # coding mode is research work: the researcher can add codes to the codebook
        status, code = self.request("/api/teacher/codebook?classId=c1", "POST", {"label": "Asks for answer"}, key=self.key)
        self.assertEqual(status, 201, code)

    def test_no_preview_as_student(self):
        status, body = self.request("/api/events", "POST", _event("c1", f"preview-{self.researcher_id}"), key=self.key,
                                    preview=True)
        self.assertEqual((status, body["code"]), (403, "forbidden"))
        status, body = self.request("/api/events", "POST", _event("c1", self.researcher_id), key=self.key)
        self.assertEqual((status, body["code"]), (403, "role_required"))

    def test_responses_are_forced_pseudonymous_and_free_text_is_scrubbed(self):
        status, threads = self.request("/api/teacher/ai-conversations/threads?classId=c1", key=self.key, name_mode="names")
        self.assertEqual(status, 200, threads)
        self.assertEqual(threads["threads"][0]["studentName"], "S-001")
        key = threads["threads"][0]["threadKey"]
        status, thread = self.request(f"/api/teacher/ai-conversations/threads/{key}?classId=c1", key=self.key)
        self.assertEqual(status, 200, thread)
        _, timeline = self.request("/api/teacher/timeline?classId=c1&studentId=s1", key=self.key)
        for body in (threads, thread, timeline):
            text = json.dumps(body)
            self.assertNotIn("Ada Chen", text)
            self.assertNotIn("ada@example.edu", text)
        self.assertIn("I am S-001 (S-001). Why is mean NA?", json.dumps(thread))
        # researchers get research ids in thread keys (review 2, SECURITY-05); the instructor uses the student id key
        self.assertNotIn(":s1:", key)
        # the same request from an instructor in names mode still shows the name
        _, named = self.request("/api/teacher/ai-conversations/threads/lab:s1:t1?classId=c1", key=TEACHER_KEY)
        self.assertIn("Ada Chen", json.dumps(named))

    def test_every_researcher_read_is_logged_with_the_role(self):
        for path in ("/api/teacher/ai/rules", "/api/teacher/groups", "/api/teacher/analytics/table"):
            self.assertEqual(self.request(f"{path}?classId=c1", key=self.key)[0], 200)
        with self.db() as db:
            rows = [tuple(r) for r in db.execute(
                "SELECT actor_role, category, endpoint FROM data_access_log WHERE actor_id=? ORDER BY id", (self.researcher_id,))]
        self.assertEqual(rows, [("researcher", "read", "/api/teacher/ai/rules"), ("researcher", "read", "/api/teacher/groups"),
                                ("researcher", "analytics", "/api/teacher/analytics/table")])

    def test_kiwi_override_to_researcher_and_no_automatic_mapping(self):
        with self.db() as db:
            _staff(db, "live-course", "researcher", kiwi_user_id="t9")
        with fake_kiwi_identity("staff", True, True, "professor", class_id="live-course", user_id="t9") as token:
            status, me = self.request("/api/me?classId=live-course", token=token)
        self.assertEqual((status, me["role"], me["roleSource"], me["isStaff"]), (200, "researcher", "override", True))
        self.assertEqual(me["permissions"], self.RESEARCHER_PERMISSIONS)
        for manage, view, user_role in ((True, True, "professor"), (False, True, "professor"), (True, False, "ta"),
                                        (False, True, "researcher")):
            with fake_kiwi_identity("staff", manage, view, user_role, class_id="live-course", user_id="t8") as token:
                self.assertNotEqual(self.request("/api/me?classId=live-course", token=token)[1]["role"], "researcher")


class TeacherKeyLimitTests(ApiTestCase):
    def test_failures_per_address_then_429_even_across_classes(self):  # FOUNDATION-19
        for n in range(10):
            status, body = self.request(f"/api/teacher/hub?classId=c{n}", key="wrong", client_addr="10.1.1.1")
            self.assertEqual((status, body["error"]), (401, "Teacher key is incorrect"))
        status, body = self.request("/api/teacher/hub?classId=c99", key=TEACHER_KEY, client_addr="10.1.1.1")
        self.assertEqual((status, body["code"]), (429, "rate_limited"))
        self.assertEqual(self.last_headers.get("Retry-After"), "60")
        self.assertEqual(self.request("/api/teacher/verify?classId=c1", "POST", key="wrong", client_addr="10.1.1.1")[0], 429)
        self.assertEqual(self.request("/api/teacher/hub?classId=c1", key="wrong", client_addr="10.2.2.2")[0], 401)
        self.assertEqual(self.request("/api/teacher/hub?classId=c1", key=TEACHER_KEY, client_addr="10.2.2.2")[0], 200)

    def test_global_failures_delay_wrong_keys_but_never_a_correct_key(self):  # FOUNDATION-19
        for n in range(101):
            auth.LIMITER.record(f"10.9.{n // 10}.{n % 10}")
        sleeps: list[float] = []
        with patch.object(auth, "_sleep", side_effect=sleeps.append):
            started = time.monotonic()
            self.assertEqual(self.request("/api/teacher/hub?classId=c1", key=TEACHER_KEY, client_addr="10.3.3.3")[0], 200)
            self.assertLess(time.monotonic() - started, 1.5)
            self.assertEqual(sleeps, [])
            self.assertEqual(self.request("/api/teacher/hub?classId=c1", key="wrong", client_addr="10.4.4.4")[0], 401)
        self.assertEqual(sleeps, [auth.FailureLimiter.DELAY])

    def test_staff_key_verified_once_cached_and_cleared_on_revoke(self):  # FOUNDATION-19, F15
        with self.db() as db:
            staff_id, key = _staff(db, "c1", "ta")
        real = __import__("hashlib").scrypt
        with patch.object(auth.hashlib, "scrypt", side_effect=real) as scrypt:
            for _ in range(3):
                status, me = self.request("/api/me?classId=c1", key=key)
                self.assertEqual((status, me["role"], me["kind"], me["staffId"]), (200, "ta", "staff_key", staff_id))
            self.assertEqual(scrypt.call_count, 1)
            with self.db() as db:
                db.execute("UPDATE staff SET revoked_at=? WHERE id=?", (dbmod.now(), staff_id))
            auth.clear_key_cache(staff_id)
            status, me = self.request("/api/me?classId=c1", key=key)
            self.assertEqual((status, me["kind"]), (200, "anonymous"))
            self.assertEqual(scrypt.call_count, 1)  # revoked prefix is not looked up, so no scrypt call
            self.assertEqual(self.request("/api/teacher/hub?classId=c1", key=key)[0], 401)
        self.assertFalse(auth.verify_staff_key(key, "scrypt$bad"))


class _RegistryHandler(app.Handler):
    registry: Registry | None = None

    def do_GET(self) -> None:
        router.dispatch(self, "GET", self.registry)

    def do_POST(self) -> None:
        router.dispatch(self, "POST", self.registry)

    def do_PUT(self) -> None:
        router.dispatch(self, "PUT", self.registry)

    def do_PATCH(self) -> None:
        router.dispatch(self, "PATCH", self.registry)

    def do_DELETE(self) -> None:
        router.dispatch(self, "DELETE", self.registry)


class RouterTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        reg = Registry()

        @reg.route("GET", "/api/teacher/exports/grades.csv", auth=Auth.STAFF_VIEW)
        def grades_csv(req):
            return Response(stream=iter([b"a,b\r\n", b"1,2\r\n"]), content_type="text/csv; charset=utf-8", filename="grades.csv")

        @reg.route("GET", "/api/teacher/exports/{name}", auth=Auth.STAFF_VIEW)
        def generic_export(req):
            return {"name": req.params["name"]}

        @reg.route("GET", "/api/teacher/exports/student/{studentId}.zip", auth=Auth.STAFF_VIEW)
        def student_zip(req):
            return {"studentId": req.params["studentId"]}

        @reg.route("GET", "/api/teacher/ai-conversations/threads/{threadKey}", auth=Auth.STAFF_VIEW)
        def thread(req):
            return {"threadKey": req.params["threadKey"]}

        @reg.route("GET", "/api/both", auth=(Auth.STUDENT, Auth.STAFF_VIEW))
        def both(req):
            return {"asStudent": req.as_student()}

        @reg.route("POST", "/api/body-class", auth=Auth.PUBLIC, class_from_body=True)
        def body_class(req):
            return {"classId": req.class_id}

        @reg.route("GET", "/api/people", auth=Auth.STAFF_VIEW)
        def people(req):
            return {"rows": [{"studentId": "s1", "studentName": "Ada", "email": "ada@example.edu", "displayName": "Ada"}],
                    "emails": ["ada@example.edu"], "kiwiEmail": "x@example.edu"}

        @reg.route("PATCH", "/api/thing/{id}", auth=Auth.INSTRUCTOR)
        def patch_thing(req):
            return {"patched": req.params["id"]}

        @reg.route("DELETE", "/api/thing/{id}", auth=Auth.INSTRUCTOR)
        def delete_thing(req):
            return None

        @reg.route("GET", "/api/boom", auth=Auth.PUBLIC)
        def boom(req):
            raise RuntimeError("secret detail")

        handler = type("H", (_RegistryHandler,), {"registry": reg})
        self.alt = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.alt_thread = threading.Thread(target=self.alt.serve_forever, daemon=True)
        self.alt_thread.start()
        self.main_url, self.url = self.url, f"http://127.0.0.1:{self.alt.server_port}"

    def tearDown(self) -> None:
        self.alt.shutdown()
        self.alt.server_close()
        self.alt_thread.join()
        self.url = self.main_url
        super().tearDown()

    def demo_session(self, class_id: str, student_id: str) -> str:
        with self.db() as db:
            return auth.mint_demo_token(db, class_id, student_id)[0]

    def test_literal_segments_win_and_suffix_params(self):  # FOUNDATION-11
        status, body = self.request("/api/teacher/exports/grades.csv?classId=c1", key=TEACHER_KEY)
        self.assertEqual((status, body), (200, b"a,b\r\n1,2\r\n"))
        self.assertEqual(self.last_headers["Content-Length"], "10")
        self.assertIn('filename="grades.csv"', self.last_headers["Content-Disposition"])
        self.assertEqual(self.request("/api/teacher/exports/activity.jsonl?classId=c1", key=TEACHER_KEY)[1], {"name": "activity.jsonl"})
        self.assertEqual(self.request("/api/teacher/exports/student/s-1.zip?classId=c1", key=TEACHER_KEY)[1], {"studentId": "s-1"})

    def test_percent_decoded_params(self):  # FOUNDATION-11
        status, body = self.request("/api/teacher/ai-conversations/threads/lab%3Aada%3At1?classId=c1", key=TEACHER_KEY)
        self.assertEqual((status, body), (200, {"threadKey": "lab:ada:t1"}))
        self.assertEqual(self.request("/api/teacher/ai-conversations/threads/a%20b?classId=c1", key=TEACHER_KEY)[0], 404)

    def test_auth_tuple_admits_students_and_staff(self):  # FOUNDATION-11
        self.assertEqual(self.request("/api/both?classId=c1", student="demo-ada")[1], {"asStudent": True})
        self.assertEqual(self.request("/api/both?classId=c1", key=TEACHER_KEY)[1], {"asStudent": False})
        self.assertEqual(self.request("/api/both?classId=c1", key=TEACHER_KEY, preview=True)[1], {"asStudent": True})
        self.assertEqual(self.request("/api/both?classId=c1")[0], 401)

    def test_query_class_must_match_body_class(self):  # FOUNDATION-11
        self.assertEqual(self.request("/api/body-class", "POST", {"classId": "c7"})[1], {"classId": "c7"})
        status, body = self.request("/api/body-class?classId=c1", "POST", {"classId": "c7"})
        self.assertEqual((status, body["code"]), (403, "forbidden"))

    def test_pseudonym_mode_scrubs_emails_for_staff(self):  # FOUNDATION-11, TH12
        _, names = self.request("/api/people?classId=c1", key=TEACHER_KEY)
        self.assertEqual(names["rows"][0]["email"], "ada@example.edu")
        _, pseudo = self.request("/api/people?classId=c1", key=TEACHER_KEY, name_mode="pseudonyms")
        self.assertEqual((pseudo["rows"][0]["email"], pseudo["rows"][0]["displayName"], pseudo["emails"], pseudo["kiwiEmail"]),
                         (None, "", None, None))

    def test_patch_delete_405_and_500_mapping(self):  # FOUNDATION-11, AU-D1-09
        self.assertEqual(self.request("/api/thing/x1?classId=c1", "PATCH", {}, key=TEACHER_KEY), (200, {"patched": "x1"}))
        self.assertEqual(self.request("/api/thing/x1?classId=c1", "DELETE", key=TEACHER_KEY), (204, None))
        self.assertEqual(self.request("/api/thing/x1?classId=c1", "GET", key=TEACHER_KEY)[0], 405)
        captured = io.StringIO()
        with patch("sys.stderr", captured):
            status, body = self.request("/api/boom?classId=c1&studentId=hidden-id")
        self.assertEqual((status, body), (500, {"error": "Internal server error", "code": "internal_error"}))
        self.assertIn("/api/boom", captured.getvalue())
        self.assertNotIn("hidden-id", captured.getvalue())
        self.assertNotIn("secret detail", captured.getvalue())
        with self.db() as db:
            self.assertEqual(db.execute("SELECT SUM(count) FROM service_incidents WHERE class_id='c1' AND kind='server_error'")
                             .fetchone()[0], 1)

    def test_registration_rejects_duplicates_and_same_shape(self):  # FOUNDATION-11
        reg = Registry()
        reg.add("GET", "/api/a/{x}", lambda req: None, auth=Auth.PUBLIC)
        with self.assertRaises(ValueError):
            reg.add("GET", "/api/a/{x}", lambda req: None, auth=Auth.PUBLIC)
        with self.assertRaises(ValueError):
            reg.add("GET", "/api/a/{y}", lambda req: None, auth=Auth.PUBLIC)
        reg.add("POST", "/api/a/{y}", lambda req: None, auth=Auth.PUBLIC)
        reg.add("GET", "/api/a/{y}.zip", lambda req: None, auth=Auth.PUBLIC)
        with self.assertRaises(ValueError):
            reg.add("GET", "/api/b/{x}{y}", lambda req: None, auth=Auth.PUBLIC)

    def test_request_helpers(self):
        req = router.Request(None, "GET", "/x", {"a": "5", "b": "x", "c": "1", "d": "s1,s2", "t": "2026-10-22T09:00:00.500+08:00",
                                                 "z": "nope"}, "rid", "127.0.0.1")
        self.assertEqual(req.q_int("a", 1, 1, 10), 5)
        self.assertEqual(req.q_int("a", 1, 1, 3, clamp=True), 3)
        with self.assertRaises(ApiError):
            req.q_int("b", 1, 1, 10)
        self.assertTrue(req.q_bool("c"))
        self.assertEqual(req.q_list("d"), ["s1", "s2"])
        self.assertEqual(req.q_iso("t"), "2026-10-22T01:00:00+00:00")
        with self.assertRaises(ApiError):
            req.q_iso("z")
        with self.assertRaises(ApiError):
            req.q_choice("z", ("a", "b"), "a")


class IdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "identity.sqlite3"
        app.init_db()

    def tearDown(self) -> None:
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def test_ensure_roster_consecutive_pseudonyms_under_two_threads(self):  # FOUNDATION-13
        errors: list[BaseException] = []
        barrier = threading.Barrier(2)

        def add(student: str) -> None:
            try:
                with app.connection() as db:
                    barrier.wait()
                    with dbmod.write_tx(db):
                        identity.ensure_roster(db, "c1", student, source="activity")
            except BaseException as exc:  # noqa: BLE001 - surfaced by the assertion below
                errors.append(exc)

        threads = [threading.Thread(target=add, args=(s,)) for s in ("s1", "s2")]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        with app.connection() as db:
            self.assertEqual(sorted(r[0] for r in db.execute("SELECT pseudonym_seq FROM roster WHERE class_id='c1'")), [1, 2])

    def test_ensure_roster_never_downgrades_and_ignores_staff_ids(self):  # FOUNDATION-13
        with app.connection() as db, dbmod.write_tx(db):
            identity.ensure_roster(db, "c1", "s1", source="kiwi", kiwi_email="ada@example.edu")
            identity.ensure_roster(db, "c1", "s1", source="activity", display_name="Ada")
            identity.ensure_roster(db, "c1", "s1", source="import", kiwi_email="")
            identity.ensure_roster(db, "c1", "preview-instructor", source="activity")
            identity.ensure_roster(db, "c1", "instructor", source="import")
        with app.connection() as db:
            row = db.execute("SELECT * FROM roster WHERE class_id='c1'").fetchall()
            self.assertEqual(len(row), 1)
            self.assertEqual((row[0]["source"], row[0]["display_name"], row[0]["kiwi_email"], row[0]["pseudonym_seq"]),
                             ("kiwi", "Ada", "ada@example.edu", 1))
            with self.assertRaises(ValueError):
                identity.ensure_roster(db, "c1", "s2", source="teacher")

    def test_label_is_read_only(self):  # FOUNDATION-13
        with app.connection() as db, dbmod.write_tx(db):
            identity.ensure_roster(db, "c1", "s1", source="import", display_name="Ada Chen")
            identity.ensure_roster(db, "c1", "s2", source="kiwi", kiwi_email="bo@example.edu")
            identity.ensure_roster(db, "c1", "s3", source="activity")
        ro = sqlite3.connect(f"file:{app.DB_PATH}?mode=ro", uri=True)
        ro.row_factory = sqlite3.Row
        try:
            self.assertEqual(identity.label(ro, "c1", "s1"), "Ada Chen")
            self.assertEqual(identity.label(ro, "c1", "s2"), "bo@example.edu")
            self.assertEqual(identity.label(ro, "c1", "s3"), "Student s3")
            self.assertEqual(identity.label(ro, "c1", "s2", "pseudonyms"), "S-002")
            self.assertTrue(identity.label(ro, "c1", "nobody", "pseudonyms").startswith("S-?"))
            self.assertEqual(identity.labels(ro, "c1", ["s1", "s3"]), {"s1": "Ada Chen", "s3": "Student s3"})
        finally:
            ro.close()
        with app.connection() as db:
            testsupport.update_settings(db, "c1", {"privacy": {"showEmails": False}})
            self.assertEqual(identity.label(db, "c1", "s2"), "Student s2")
            rows = identity.relabel(db, "c1", [{"studentId": "s1", "studentName": "x", "email": "a@b", "displayName": "Ada"}],
                                    "pseudonyms")
            self.assertEqual(rows[0], {"studentId": "s1", "studentName": "S-001", "email": None, "displayName": ""})

    def test_population_sql_is_evaluated_at_query_time(self):  # P10, FOUNDATION-04
        with app.connection() as db, dbmod.write_tx(db):
            for student, source in (("k1", "kiwi"), ("i1", "import"), ("a1", "activity"), ("staffer", "kiwi"), ("gone", "kiwi")):
                identity.ensure_roster(db, "lc", student, source=source)
            db.execute("UPDATE roster SET status='dropped' WHERE student_id='gone'")
            db.execute("INSERT INTO kiwi_staff_seen (class_id, kiwi_user_id, username, kiwi_role, can_manage_course, "
                       "can_view_analytics, first_seen_at, last_seen_at) VALUES ('lc','staffer','t','ta',0,1,?,?)",
                       (dbmod.now(), dbmod.now()))
            for student, role in (("k1", "student"), ("i1", "unknown"), ("a1", "unknown"), ("staffer", "student"),
                                  ("gone", "student"), ("nobody", "unknown"), ("k1", "ta")):
                db.execute("INSERT INTO events (class_id, student_id, student_name, session_id, event_type, payload_json, "
                           "created_at, actor_role) VALUES ('lc', ?, '', 's', 'code_run', '{}', ?, ?)", (student, dbmod.now(), role))

        def count(**flags) -> set[str]:
            sql, params = identity.population_sql("e", **flags)
            with app.connection() as db:
                return {r[0] for r in db.execute(f"SELECT DISTINCT student_id FROM events e WHERE {sql}", params)}

        self.assertEqual(count(class_linked=True), {"k1"})
        self.assertEqual(count(class_linked=False), {"k1", "i1", "a1", "staffer"})
        self.assertEqual(count(class_linked=True, include_staff=True), {"k1", "i1", "a1", "staffer", "nobody"})
        self.assertEqual(count(class_linked=True, include_excluded=True), {"k1", "gone"})
        with app.connection() as db:
            self.assertEqual(identity.enrolled_count(db, "lc"), 4)
            with patch.dict("os.environ", {"KIWI_CLASS_IDS": "lc"}):
                self.assertTrue(identity.class_linked(db, "lc"))
                self.assertEqual(identity.enrolled_count(db, "lc"), 1)

    def test_research_ids_hashes_tombstones_and_consent(self):
        with app.connection() as db:
            rid = identity.research_id(db, "c1", "s1")
            self.assertRegex(rid, r"^P[A-Z2-7]{10}$")
            self.assertEqual(rid, identity.research_id(db, "c1", "s1"))
            self.assertNotEqual(rid, identity.research_id(db, "c2", "s1"))
            digest = identity.student_hash(db, "c1", "s1")
            self.assertIsNone(identity.tombstone(db, "c1", "s1"))
            db.execute("INSERT INTO student_tombstones (class_id, student_hash, anon_id, mode, created_by, created_at) "
                       "VALUES ('c1', ?, 'anon-1', 'anonymize', 'instructor', ?)", (digest, dbmod.now()))
            self.assertEqual(identity.tombstone(db, "c1", "s1")[:2], ("anonymize", "anon-1"))
        self.assertEqual(identity.consent_state({"consent_override": None, "kiwi_consent": 1}), "yes")
        self.assertEqual(identity.consent_state({"consent_override": "no", "kiwi_consent": 1}), "no")
        self.assertEqual(identity.consent_state({"consent_override": None, "kiwi_consent": None}), "not_asked")


class GroupHistoryTests(unittest.TestCase):  # FOUNDATION-18
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "groups.sqlite3"
        app.init_db()

    def tearDown(self) -> None:
        app.DB_PATH = self.previous
        dbmod.set_clock(None)
        self.temp.cleanup()

    def test_insert_move_delete_and_cohorts(self):
        with app.connection() as db:
            with testsupport.freeze_time("2026-10-01T00:00:00+00:00"):
                a = testsupport.make_group(db, "c1", "section", "A", ["s1"])
                b = testsupport.make_group(db, "c1", "section", "B")
                cond = testsupport.make_group(db, "c1", "condition", "Treatment", ["s1"])
            self.assertEqual(readers.group_stamp(db, "c1", "s1"), (a, cond))
            with testsupport.freeze_time("2026-10-05T00:00:00+00:00"):
                testsupport.set_membership(db, "c1", b, "s1", "section")
            self.assertEqual(readers.group_stamp(db, "c1", "s1"), (b, cond))
            history = db.execute("SELECT group_id, valid_from, valid_to FROM group_membership_history WHERE kind='section' "
                                 "ORDER BY id").fetchall()
            self.assertEqual([tuple(r) for r in history], [(a, "2026-10-01T00:00:00.000+00:00", "2026-10-05T00:00:00.000+00:00"),
                                                           (b, "2026-10-05T00:00:00.000+00:00", None)])
            db.execute("DELETE FROM group_members WHERE class_id='c1' AND group_id=? AND student_id='s1'", (b,))
            closed = db.execute("SELECT valid_to FROM group_membership_history WHERE group_id=? ", (b,)).fetchone()[0]
            self.assertIsNotNone(closed)
            self.assertEqual(readers.group_stamp(db, "c1", "s1"), ("", cond))
            c1 = testsupport.make_group(db, "c1", "cohort", "Needs attention", ["s1"])
            c2 = testsupport.make_group(db, "c1", "cohort", "Extra practice", ["s1"])
            self.assertEqual(sorted(readers.student_groups(db, "c1", "s1")["cohort"]), sorted([c1, c2]))
            open_cohorts = db.execute("SELECT COUNT(*) FROM group_membership_history WHERE kind='cohort' AND valid_to IS NULL").fetchone()[0]
            self.assertEqual(open_cohorts, 2)
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO group_members (class_id, group_id, student_id, kind, method, seed, assigned_by, assigned_at) "
                           "VALUES ('c1', ?, 's1', 'condition', 'manual', NULL, 'x', 'now')",
                           (testsupport.make_group(db, "c1", "condition", "Control"),))


class CourseConfigTests(unittest.TestCase):
    SCHEDULE = {"timezone": "Asia/Shanghai", "meetings": [{"weekday": 2, "time": "10:00", "durationMinutes": 90}], "termStart": None}

    def tr(self, preset: str, now: str, schedule: dict | None = None, **kw):
        return course_config.time_range(preset, schedule or self.SCHEDULE, now=now, **kw)

    def test_time_range_table(self):  # FOUNDATION-12
        since = self.tr("since_last_class", "2026-10-22T01:00:00+00:00")  # Thu 10/22 09:00 Shanghai
        self.assertEqual((since.from_, since.to, since.compare_from, since.compare_to, since.compare_label),
                         ("2026-10-20T02:00:00+00:00", "2026-10-22T01:00:00+00:00", "2026-10-13T02:00:00+00:00",
                          "2026-10-15T01:00:00+00:00", "vs last week"))
        self.assertEqual(since.label, "Since last class (Tue 10/20)")
        during = "2026-10-20T02:30:00+00:00"  # Tue 10/20 10:30 Shanghai
        this_class = self.tr("this_class", during)
        self.assertEqual((this_class.from_, this_class.to), ("2026-10-20T02:00:00+00:00", during))
        self.assertEqual(this_class.label, "This class (Tue 10/20 10:00)")
        self.assertEqual(self.tr("since_last_class", during).from_, "2026-10-13T02:00:00+00:00")
        week = self.tr("this_week", during)
        self.assertEqual((week.from_, week.label), ("2026-10-18T16:00:00+00:00", "This week (since Mon 10/19)"))
        self.assertEqual(self.tr("last_7_days", "2026-10-22T01:00:00.900+00:00").from_, "2026-10-15T01:00:00+00:00")
        term = self.tr("whole_term", during, first_event_at="2026-09-01T03:04:05.678+00:00")
        self.assertEqual((term.from_, term.compare_from, term.compare_label, term.label),
                         ("2026-09-01T03:04:05+00:00", None, None, "Whole term"))
        self.assertIsNone(self.tr("whole_term", during).from_)
        termed = self.tr("whole_term", during, {**self.SCHEDULE, "termStart": "2026-09-07"})
        self.assertEqual(termed.from_, "2026-09-06T16:00:00+00:00")
        custom = self.tr("custom", during, custom_from="2026-10-01T00:00:00+00:00", custom_to="2026-10-11T00:00:00+00:00")
        self.assertEqual((custom.compare_from, custom.compare_to, custom.compare_label),
                         ("2026-09-17T00:00:00+00:00", "2026-09-27T00:00:00+00:00", "vs previous period"))
        for bad in ({}, {"custom_from": "2026-10-02T00:00:00Z", "custom_to": "2026-10-01T00:00:00Z"},
                    {"custom_from": "2025-01-01T00:00:00Z", "custom_to": "2026-10-01T00:00:00Z"}):
            with self.assertRaises(ValueError):
                self.tr("custom", during, **bad)
        fallback = self.tr("since_last_class", during, {"timezone": "Asia/Shanghai", "meetings": [], "termStart": None})
        self.assertEqual((fallback.effective_preset, fallback.from_, fallback.compare_label),
                         ("last_7_days", "2026-10-13T02:30:00+00:00", "vs last week"))
        self.assertEqual(fallback.note, "Set class meetings in Course settings to use Since last class")
        ny = {"timezone": "America/New_York", "meetings": [{"weekday": 1, "time": "10:00", "durationMinutes": 60}], "termStart": None}
        after_dst = self.tr("this_class", "2026-11-02T15:30:00+00:00", ny)  # Mon 11/2 10:30 EST
        self.assertEqual(after_dst.from_, "2026-11-02T15:00:00+00:00")
        self.assertEqual(after_dst.compare_from, "2026-10-26T14:00:00+00:00")  # Mon 10/26 10:00 EDT
        before_dst = self.tr("since_last_class", "2026-11-02T15:30:00+00:00", ny)
        self.assertEqual(before_dst.from_, "2026-10-26T14:00:00+00:00")
        self.assertEqual(set(since.as_dict()), {"preset", "effectivePreset", "from", "to", "compareFrom", "compareTo", "label",
                                                "compareLabel"})

    def test_effective_access(self):  # §12.4
        units = [{"id": u, "access": "default"} for u in ("a", "b", "c")]
        cases = {"current_and_earlier": ["open", "open", "locked"], "current_only": ["locked", "open", "locked"],
                 "all": ["open", "open", "open"]}
        for scope, expected in cases.items():
            self.assertEqual([course_config.effective_access(u, units, "b", scope) for u in units], expected)
        for access in ("hidden", "open", "review"):
            self.assertEqual(course_config.effective_access({"id": "c", "access": access}, units, "a", "current_only"), access)

    def test_validate_course_v2(self):
        base = {"title": "T", "currentUnitId": "a", "units": [{"id": "a", "title": "A", "goal": "G"}]}
        clean = course_config.validate_course(base)
        self.assertEqual(clean["units"][0]["runtime"], course_config.default_runtime())
        self.assertEqual(clean["freePracticeScope"], "current_and_earlier")
        for broken in ({**base, "freePracticeScope": "x"}, {**base, "units": [{"id": "a", "title": "A", "goal": "G", "week": 0}]},
                       {**base, "units": [{"id": "a", "title": "A", "goal": "G", "startsOn": "10/01"}]},
                       {**base, "units": [{"id": "a", "title": "A", "goal": "G", "access": "secret"}]},
                       {**base, "currentUnitId": "z"}, [], {**base, "units": [{"id": "a", "title": "A", "goal": "G",
                                                                               "runtime": {"timeoutSeconds": 999}}]}):
            with self.assertRaises(ValueError):
                course_config.validate_course(broken)
        with self.assertRaises(ValueError):
            course_config.validate_schedule({"timezone": "Mars/Base", "meetings": []})
        self.assertEqual(course_config.validate_schedule({"meetings": [{"weekday": 7, "time": "08:30"}]})["meetings"][0]["durationMinutes"], 90)


class ReadersTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "readers.sqlite3"
        app.init_db()

    def tearDown(self) -> None:
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def test_assignment_state_protection_and_mapping(self):
        with app.connection() as db:
            rec = testsupport.publish_work(db, "c1", due_at="2026-10-20T00:00:00+00:00")
            self.assertEqual(readers.assignment_state(rec, "2026-10-19T00:00:00+00:00"), "open")
            self.assertEqual(readers.assignment_state(rec, "2026-10-21T00:00:00+00:00"), "past_due")
            self.assertTrue(readers.answer_protected(db, rec, "s1", "2026-10-21T00:00:00+00:00"))
            closed = testsupport.publish_work(db, "c1", due_at="2026-10-20T00:00:00+00:00", late_policy={"mode": "not_accepted"},
                                              solutions_visibility="after_due")
            self.assertEqual(readers.assignment_state(closed, "2026-10-21T00:00:00+00:00"), "closed")
            self.assertFalse(readers.answer_protected(db, closed, "s1", "2026-10-21T00:00:00+00:00"))
            later = testsupport.publish_work(db, "c1", open_at="2030-01-01T00:00:00+00:00")
            self.assertEqual(readers.assignment_state(later, "2026-10-21T00:00:00+00:00"), "scheduled")
            draft = testsupport.publish_work(db, "c1", status="draft")
            self.assertEqual(readers.assignment_state(draft, None), "draft")
            group = testsupport.make_group(db, "c1", "cohort", "Targets", ["s2"])
            targeted = testsupport.publish_work(db, "c1", audience={"type": "groups", "groupIds": [group]})
            self.assertEqual((readers.in_audience(db, targeted, "s1"), readers.in_audience(db, targeted, "s2")), (False, True))
            self.assertEqual([r.id for r, _ in readers.open_homework_questions(db, "c1", "s1", "2026-10-21T00:00:00+00:00")],
                             [rec.id, rec.id])
            self.assertEqual(rec.tool_policy.as_dict(), readers.HOMEWORK_TOOL_DEFAULT)
            self.assertEqual(rec.questions[0]["graderRubric"], "The sum is 12; divide by 3.")
            self.assertEqual(rec.questions[0]["grading"]["numericTolerance"], 1e-9)
            practice = readers.v2_question({"id": "p", "type": "complete", "answer": "x <- 1\nprint(x)", "explanation": "e"}, "practice")
            self.assertEqual((practice["referenceCode"], practice["studentExplanation"]), ("x <- 1\nprint(x)", "e"))
            self.assertEqual(readers.tool_policy_for("practice", {}).as_dict(), readers.INCLASS_TOOL_DEFAULT)
            self.assertTrue(readers.settings(db, "c1")["privacy"]["showEmails"])
            self.assertIsNone(readers.load_assignment(db, "c1", "missing"))

    def test_grading_baseline_counts_and_cells(self):
        with app.connection() as db:
            rec = testsupport.publish_work(db, "c1", due_at="2026-10-20T00:00:00+00:00")
            for student in ("s1", "s2", "s3"):
                testsupport.add_roster(db, "c1", student)
            testsupport.make_autochecked_submission(db, "c1", "s1", rec.id, {"q1": "4", "q2": "words"},
                                                    at="2026-10-19T00:00:00+00:00")
            testsupport.make_autochecked_submission(db, "c1", "s2", rec.id, {"q1": "5", "q2": "words"}, grade_status="released",
                                                    grade=12, at="2026-10-21T00:00:00+00:00")
            testsupport.make_autochecked_submission(db, "c1", "preview-instructor", rec.id, {"q1": "4", "q2": "x"}, preview=True)
            counts = readers.grading_counts(db, "c1")
            self.assertEqual((counts["toGrade"], counts["graded"], counts["late"], counts["all"]), (1, 1, 1, 2))
            cells = {s: readers.gradebook_cell(db, rec, s, now="2026-10-22T00:00:00+00:00") for s in ("s1", "s2", "s3")}
            self.assertEqual({s: c["state"] for s, c in cells.items()},
                             {"s1": "submitted_ungraded", "s2": "released", "s3": "missing"})
            self.assertEqual((cells["s2"]["label"], cells["s3"]["label"]), ("12/20 · 1 submission", "Missing"))
            items = db.execute("SELECT question_id, auto_correct, auto_score FROM submission_item_scores s JOIN submissions u "
                               "ON u.id=s.submission_id WHERE u.student_id='s1' ORDER BY question_id").fetchall()
            self.assertEqual([tuple(r) for r in items], [("q1", 1, 10.0), ("q2", None, None)])
            checked = db.execute("SELECT checked_by, practice_mode FROM events WHERE student_id='s1' AND question_id='q1'").fetchone()
            self.assertEqual(tuple(checked), ("server", "homework"))


class TelemetryBaselineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "telemetry.sqlite3"
        app.init_db()

    def tearDown(self) -> None:
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def test_derive_attribution_table(self):  # §11.5 baseline (complete derive)
        with app.connection() as db:
            hw = testsupport.publish_work(db, "c1", questions=[{"id": "q1", "type": "fill", "prompt": "P", "answer": "4", "points": 5}])
            practice = testsupport.publish_work(db, "c1", kind="practice",
                                                questions=[{"id": "p1", "type": "fill", "prompt": "P", "answer": "4", "points": 5}])
            item = testsupport.make_free_item_attempt(db, "c1", "s1", "r-basics")
            sim = testsupport.make_similar_attempt(db, "c1", "s1", hw.id, "q1")
            db.execute("INSERT INTO kiwi_materials VALUES ('c1','m1','Lecture','[]','r-basics')")

            def mode(**row):
                d = telemetry.derive(db, {"class_id": "c1", "source": "lab", **row})
                return d["practice_mode"], d["attribution_assignment_id"], d["related_assignment_id"], d["checked_by"]

            self.assertEqual(mode(event_type="answer_submitted", question_id="q1", payload={"assignmentId": hw.id, "correct": True},
                                  server=True), ("homework", hw.id, "", "server"))
            self.assertEqual(mode(event_type="answer_submitted", question_id="p1", payload={"assignmentId": practice.id, "correct": True}),
                             ("in-class", practice.id, "", "legacy_server"))
            self.assertEqual(mode(event_type="answer_submitted", question_id="q-legacy-sim", payload={"assignmentId": hw.id, "correct": False}),
                             ("similar", "", hw.id, "client"))
            self.assertEqual(mode(event_type="work_submitted", question_id="zzz", payload={"assignmentId": hw.id}), ("homework", hw.id, "", ""))
            self.assertEqual(mode(event_type="answer_submitted", question_id=item, payload={"correct": True}, client=True),
                             ("free", "", "", "client"))
            self.assertEqual(mode(event_type="answer_submitted", question_id=sim, payload={}), ("similar", "", hw.id, ""))
            self.assertEqual(mode(event_type="question_viewed", question_id="q-1234", payload={}), ("free", "", "", ""))
            self.assertEqual(mode(event_type="code_run", payload={}), ("workspace", "", "", ""))
            self.assertEqual(mode(event_type="ai_question", payload={"surface": "ask-kiwi"}, question_id="x"), ("workspace", "", "", ""))
            self.assertEqual(mode(event_type="code_run", question_id="unknown", payload={"assignmentId": "missing"}), ("other", "", "", ""))
            native = telemetry.derive(db, {"class_id": "c1", "source": "kiwi", "event_type": "material_viewed", "payload": {"materialId": "m1"}})
            self.assertEqual((native["practice_mode"], native["unit_id"], native["category"]), ("lecture", "r-basics", "action"))
            self.assertEqual(telemetry.derive(db, {"class_id": "c1", "source": "kiwi", "event_type": "ai_question", "payload": {}})["practice_mode"], "kiwi")

    def test_add_event_dedup_and_stamps(self):
        with app.connection() as db:
            testsupport.make_group(db, "c1", "section", "A", ["s1"])
            ident = testsupport.student_identity(db, "c1", "s1")
            event = {"classId": "c1", "studentId": "s1", "studentName": "Ada", "sessionId": "b", "type": "code_run",
                     "payload": {"ok": True}, "eventId": "evt-1", "schemaVersion": 2, "clientTs": dbmod.now_ms() - 1000, "seq": 3}
            first = telemetry.add_event(db, ident, event)
            again = telemetry.add_event(db, ident, event)
            self.assertEqual((first.status, again.status, again.id), ("created", "duplicate", first.id))
            row = db.execute("SELECT * FROM events WHERE id=?", (first.id,)).fetchone()
            self.assertEqual((row["schema_version"], row["client_seq"], row["actor_role"], row["category"], row["practice_mode"]),
                             (2, 3, "demo", "action", "workspace"))
            self.assertTrue(row["section_group_id"].startswith("grp-"))
            self.assertLessEqual(row["created_at"], row["received_at"])
            self.assertEqual(db.execute("SELECT source FROM roster WHERE student_id='s1'").fetchone()[0], "activity")
            with self.assertRaises(ValueError):
                telemetry.add_event(db, ident, {**event, "eventId": "evt-2", "type": "nope"})
            with self.assertRaises(ApiError):
                telemetry.add_event(db, ident, {**event, "eventId": "evt-3", "studentId": "s2"})
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO events (class_id, student_id, student_name, session_id, event_type, payload_json, created_at, "
                           "event_id) VALUES ('c1','s1',NULL,'b','x','{}','t','evt-9') ON CONFLICT(class_id, event_id) "
                           "WHERE event_id IS NOT NULL DO NOTHING")

    def test_event_schema_registry(self):
        self.assertEqual(event_schema.SERVER_OWNED_MODE, "enforce")  # INTEGRATION-05 cut-over (was "accept" until INTEGRATION)
        with patch.dict("os.environ", {"KIWI_SERVER_OWNED_EVENTS": "accept"}):
            self.assertEqual(event_schema.server_owned_mode(), "accept")
        self.assertEqual(event_schema.category("study_heartbeat"), "telemetry")
        self.assertEqual(event_schema.category("telemetry_gap"), "system")
        self.assertTrue(event_schema.is_server_owned("answer_submitted"))
        self.assertFalse(event_schema.is_server_owned("code_run"))
        self.assertTrue(event_schema.LEGACY_V1_TYPES <= set(event_schema.REGISTRY))
        self.assertEqual(event_schema.REGISTRY["hint_requested"]["deprecated_since"], "0.6.0")
        with patch.dict("os.environ", {"KIWI_SERVER_OWNED_EVENTS": "enforce"}):
            self.assertEqual(event_schema.server_owned_mode(), "enforce")
        for name, spec in event_schema.REGISTRY.items():
            self.assertIn(spec["category"], ("action", "telemetry", "system"), name)
            self.assertTrue(spec["description"], name)


class BuilderTests(unittest.TestCase):
    """Every testsupport builder writes rows other workstreams can read (columns per §4.2, derive applied)."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH
        app.DB_PATH = Path(self.temp.name) / "builders.sqlite3"
        app.init_db()

    def tearDown(self) -> None:
        app.DB_PATH = self.previous
        dbmod.set_clock(None)
        self.temp.cleanup()

    def test_builders(self):
        with app.connection() as db:
            course = testsupport.create_course(db, "c1", title="CSS")
            self.assertEqual(course["title"], "CSS")
            testsupport.set_meetings(db, "c1", [{"weekday": 2, "time": "10:00"}], term_start="2026-09-07")
            self.assertEqual(readers.settings(db, "c1")["schedule"]["termStart"], "2026-09-07")
            hw = testsupport.publish_work(db, "c1", due_at="2026-10-30T00:00:00+00:00")
            practice = testsupport.publish_work(db, "c1", kind="practice")
            self.assertEqual(db.execute("SELECT reason FROM assignment_versions WHERE assignment_id=?", (hw.id,)).fetchone()[0], "publish")
            testsupport.make_server_check(db, "c1", "s1", practice.id, "q1", "4", True, at="2026-10-20T02:10:00+00:00")
            check = db.execute("SELECT * FROM events WHERE event_type='answer_submitted' AND student_id='s1'").fetchone()
            self.assertEqual((check["checked_by"], check["practice_mode"], check["attribution_assignment_id"], check["created_at"]),
                             ("server", "in-class", practice.id, "2026-10-20T02:10:00.000+00:00"))
            self.assertIsNotNone(readers.load_assignment(db, "c1", practice.id).frozen_at)
            similar = testsupport.make_similar_attempt(db, "c1", "s1", hw.id, "q1", correct=False)
            free = testsupport.make_free_item_attempt(db, "c1", "s1", "r-basics")
            modes = {r["item_id"]: (r["practice_mode"], r["related_assignment_id"]) for r in db.execute(
                "SELECT item_id, practice_mode, related_assignment_id FROM events WHERE event_type='answer_submitted' AND item_id!=''")}
            self.assertEqual(modes, {similar: ("similar", hw.id), free: ("free", "")})
            sub = testsupport.make_autochecked_submission(db, "c1", "s2", hw.id, {"q1": "4", "q2": "text"})
            self.assertEqual(json.loads(db.execute("SELECT autocheck_json FROM submissions WHERE id=?", (sub,)).fetchone()[0])["q1"]["correct"], True)
            testsupport.make_draft(db, "c1", "s3", hw.id, {"q1": "4"})
            self.assertEqual(readers.gradebook_cell(db, hw, "s3")["draftAnswered"], 1)
            turn = testsupport.make_chat_turn(db, "c1", "s1", "Why NA?", "Use na.rm.", flagged=True, guard_status="redacted")
            row = db.execute("SELECT t.flagged, t.flag_source, c.status, c.raw_output FROM chat_turns t JOIN ai_calls c ON c.id=t.ai_call_id "
                             "WHERE t.id=?", (turn,)).fetchone()
            self.assertEqual(tuple(row), (1, "guard", "ok", "Use na.rm."))
            self.assertEqual(db.execute("SELECT chat_turn_id FROM events WHERE event_type='ai_question'").fetchone()[0], turn)
            self.assertTrue(testsupport.make_native_event(db, "c1", "s4", response="Try is.na()"))
            native = db.execute("SELECT source, practice_mode, actor_role FROM events WHERE source='kiwi'").fetchone()
            self.assertEqual(tuple(native), ("kiwi", "kiwi", "student"))
            group = testsupport.make_group(db, "c1", "condition", "Treatment", ["s1", "s2"])
            self.assertEqual(readers.group_stamp(db, "c1", "s1")[1], group)
            preview = testsupport.make_autochecked_submission(db, "c1", "preview-instructor", hw.id, {"q1": "1", "q2": "x"}, preview=True)
            self.assertEqual(db.execute("SELECT is_preview, actor_role FROM submissions WHERE id=?", (preview,)).fetchone()[:], (1, "preview"))
        with testsupport.freeze_time("2026-10-22T01:00:00+00:00") as clock:
            self.assertEqual(dbmod.now(), "2026-10-22T01:00:00.000+00:00")
            clock.advance(minutes=1)
            self.assertEqual(dbmod.now(), "2026-10-22T01:01:00.000+00:00")
        ctx = testsupport.fake_kiwi_context("staff", True, False, "ta", class_id="k1")
        self.assertEqual((ctx["canTeach"], ctx["userRole"], ctx["classId"]), (True, "ta", "k1"))


class AiBaselineTests(ApiTestCase):
    def test_assemble_message_order_and_reasoning(self):  # §12.2 baseline
        from server import ai_policy, ai_runtime

        with self.db() as db:
            resolved = ai_policy.resolve(db, "c1", "r-basics")
            self.assertEqual((resolved.source, resolved.scope_label), ("platform", "Default rules"))
            request = ai_runtime.assemble(db, "c1", resolved, "chat", {"prompt": "Why NA?", "code": "mean(x)", "answer": "secret"},
                                          history=[{"prompt": "hi", "response": "hello"}])
            roles = [m["role"] for m in request["input"]]
            self.assertEqual(roles, ["system", "developer", "developer", "user", "user", "assistant", "user"])
            self.assertIn("platform-rules-v2", request["input"][0]["content"])
            self.assertIn("Reply in English.", request["input"][0]["content"])
            self.assertIn("base R only", request["input"][1]["content"])
            self.assertNotIn("secret", request["input"][3]["content"])  # answer is not in the default contextFields
            self.assertNotIn("reasoning", request)
            self.assertEqual(request["store"], False)
            config = {**resolved.config, "reasoningEffort": "low", "contextFields": ["answer"]}
            tuned = ai_runtime.assemble(db, "c1", resolved.__class__(config, 1, 1, "unit", "Ch 02 rules v1", None, None),
                                        "question", {"type": "choice", "difficulty": 3})
            self.assertEqual(tuned["reasoning"], {"effort": "low"})
            self.assertIn("exactly 4 distinct choices", tuned["input"][2]["content"])
            self.assertEqual(len(ai_runtime.prompt_hash(tuned)), 64)

    def test_legacy_policy_put_creates_versions_and_resolves(self):
        policy = {**app.ai.DEFAULT_POLICY, "unitId": "r-basics", "allowedTypes": ["fill"], "systemPrompt": "Hint first."}
        self.assertEqual(self.request("/api/teacher/policies?classId=c1", "PUT", policy, key=TEACHER_KEY)[0], 200)
        self.assertEqual(self.request("/api/teacher/policies?classId=c1", "PUT", {**policy, "systemPrompt": "Hint twice."},
                                      key=TEACHER_KEY)[0], 200)
        _, rows = self.request("/api/teacher/policies?classId=c1", key=TEACHER_KEY)
        unit = next(r for r in rows if r["unitId"] == "r-basics")
        self.assertEqual((unit["systemPrompt"], unit["isCustomized"], unit["allowedTypes"]), ("Hint twice.", True, ["fill"]))
        self.assertFalse(next(r for r in rows if r["unitId"] == "css-intro")["isCustomized"])
        with self.db() as db:
            versions = [r[0] for r in db.execute("SELECT version FROM policy_versions WHERE unit_id='r-basics' ORDER BY id")]
            self.assertEqual(versions, [1, 2])
            from server import ai_policy

            self.assertEqual(ai_policy.resolve(db, "c1", "r-basics").scope_label, "Ch 02 rules v2")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM generation_policies").fetchone()[0], 0)

    def test_ai_errors_map_to_status_codes(self):
        self.create_course("c1")
        body = {"studentId": "s1", "unitId": "r-basics", "threadId": "t1", "prompt": "Help?"}
        with patch.dict("os.environ", {"OPENAI_API_KEY": "", "OPEN_AI_TEST_KEY": ""}):
            status, error = self.request("/api/ai/chat?classId=c1", "POST", body, student="s1")
        self.assertEqual((status, error["code"]), (503, "ai_unavailable"))
        from server.contracts import AiError

        with patch.object(app.ai, "invoke", side_effect=AiError(429, "rate_limited", "Too many AI requests.")):
            status, error = self.request("/api/ai/chat?classId=c1", "POST", body, student="s1")
        self.assertEqual((status, error["code"]), (429, "rate_limited"))
        with patch.object(app.ai, "invoke", return_value="Look at na.rm."):
            self.assertEqual(self.request("/api/ai/chat?classId=c1", "POST", body, student="s1")[0], 200)
        with self.db() as db:
            row = db.execute("SELECT actor_role, identity_verified, surface, source FROM chat_turns").fetchone()
        self.assertEqual(tuple(row), ("demo", 0, "legacy", "kiwi-ai"))


class MigrationTests(unittest.TestCase):
    TOTAL_TABLES =("assignments", "submissions", "events", "chat_turns", "generation_policies")

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.previous = app.DB_PATH

    def tearDown(self) -> None:
        app.DB_PATH = self.previous
        self.temp.cleanup()

    def test_base_schema_on_fresh_db_is_v051_end_state(self):  # FOUNDATION-15
        with dbmod.connection(Path(self.temp.name) / "base.sqlite3") as db:
            migrations.base_schema(db)
            self.assertTrue({"source", "learning_session_id", "upstream_id"} <= dbmod.table_columns(db, "events"))
            self.assertTrue({"materialId", "codeSuccesses", "source"} <= dbmod.table_columns(db, "learning_sessions"))
            self.assertIn("projection_version", dbmod.table_columns(db, "kiwi_sync"))
            self.assertNotIn("event_id", dbmod.table_columns(db, "events"))
            self.assertFalse(dbmod.table_exists(db, "schema_migrations"))
            self.assertTrue(dbmod.table_exists(db, "telemetry_meta"))

    def test_migrations_module_never_uses_executescript(self):  # FOUNDATION-15
        self.assertNotIn("executescript(", (SERVER_DIR / "migrations.py").read_text())

    def test_legacy_recovery_runs_before_b5_and_is_stamped(self):  # FOUNDATION-15
        path = Path(self.temp.name) / "legacy.sqlite3"
        with dbmod.connection(path) as db:
            migrations.base_schema(db)
            db.execute("INSERT INTO assignments (id, class_id, kind, title, unit_id, instructions, status, questions_json, "
                       "created_at, updated_at) VALUES ('w1','c1','homework','HW','r-basics','','published','[]','t','t')")
            db.execute("INSERT INTO submissions (id, assignment_id, class_id, student_id, student_name, attempt, answers_json, "
                       "submitted_at, grade) VALUES ('sub-1','w1','c1','demo-ada','Ada',1,'{\"q1\":\"4\"}','2026-10-01T12:00:00+00:00', 8)")
        app.DB_PATH = path
        app.init_db()
        with app.connection() as db:
            event = db.execute("SELECT * FROM events WHERE class_id='c1'").fetchone()
            self.assertTrue(json.loads(event["payload_json"])["recoveredFromSubmission"])
            self.assertEqual((event["received_at"], event["category"], event["actor_role"]),
                             ("2026-10-01T12:00:00+00:00", "action", "demo"))
            sub = db.execute("SELECT grade_status, released_at, graded_by, actor_role FROM submissions").fetchone()
            self.assertEqual(tuple(sub), ("released", None, "pre-0.6", "demo"))
            self.assertEqual(db.execute("SELECT action, actor_label, total_after FROM grade_events").fetchone()[:], ("migrated", "Imported from v0.5", 8.0))
            self.assertEqual(db.execute("SELECT source, display_name FROM roster WHERE student_id='demo-ada'").fetchone()[:], ("activity", "Ada"))
            self.assertEqual(db.execute("SELECT reason FROM assignment_versions WHERE assignment_id='w1'").fetchone()[0], "migration")
            self.assertEqual(db.execute("SELECT frozen_at FROM assignments WHERE id='w1'").fetchone()[0], "2026-10-01T12:00:00+00:00")
            self.assertEqual(len(migrations.list_backups(db, "0.6.0-001-columns")), 1)

    def test_backup_once_runs_before_registered_rebuild(self):  # FOUNDATION-15
        path = Path(self.temp.name) / "rebuild.sqlite3"
        app.DB_PATH = path
        app.init_db()
        seen: list[int] = []

        def stub(db: sqlite3.Connection) -> None:
            seen.append(len(migrations.list_backups(db, "sessions-v3")))
            db.execute("INSERT INTO telemetry_meta (version) VALUES ('sessions-v3')")
            db.commit()

        with patch.object(telemetry, "DERIVED_REBUILDS", [("sessions-v3", stub)]):
            with app.connection() as db:
                telemetry.init(db)
                telemetry.init(db)
                self.assertEqual(seen, [1])
                self.assertEqual(len(migrations.list_backups(db, "sessions-v3")), 1)
                self.assertEqual(migrations.backup_once(db, "sessions-v3"), migrations.list_backups(db, "sessions-v3")[0])
                db.execute("BEGIN")
                with self.assertRaises(migrations.MigrationError):
                    migrations.backup_once(db, "other-tag")
                db.execute("ROLLBACK")
        backups = path.parent / "backups"
        self.assertEqual(backups.stat().st_mode & 0o777, 0o700)

    def test_init_db_twice_on_fresh_db(self):  # FOUNDATION-10 (a)
        app.DB_PATH = Path(self.temp.name) / "fresh.sqlite3"
        app.init_db()
        app.init_db()
        with app.connection() as db:
            # CR-A1 / CR-AIRULES-3 / CR-T1 (INTEGRATION): additive workstream migrations count as applied too.
            self.assertEqual(migrations.applied_versions(db),
                             {v for v, _ in migrations.MIGRATIONS + migrations.workstream_steps()})
            self.assertEqual(migrations.list_backups(db), [])

    def _counts(self, db: sqlite3.Connection) -> dict:
        counts = {t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] if dbmod.table_exists(db, t) else 0
                  for t in self.TOTAL_TABLES}
        counts["recovered"] = db.execute(
            "SELECT COUNT(*) FROM events WHERE json_valid(payload_json) AND json_extract(payload_json,'$.recoveredFromSubmission')=1"
        ).fetchone()[0] if dbmod.table_exists(db, "events") else 0
        counts["grades"] = sorted(tuple(r) for r in db.execute("SELECT id, grade, feedback FROM submissions")) \
            if dbmod.table_exists(db, "submissions") else []
        return counts

    def test_init_db_twice_on_snapshots(self):  # FOUNDATION-10 (b)–(e), §19.4
        paths = testsupport.snapshot_paths()
        if not paths:
            self.skipTest("No migration snapshots found (.local/*.sqlite3 or KIWI_SNAPSHOT_DBS)")
        for index, source in enumerate(paths):
            with self.subTest(snapshot=source.name):
                target = testsupport.copy_snapshot(source, Path(self.temp.name) / f"snap-{index}-{source.stem}.sqlite3")
                with dbmod.connection(target) as db:
                    before = self._counts(db)
                app.DB_PATH = target
                app.init_db()
                with app.connection() as db:
                    after = self._counts(db)
                app.init_db()
                with app.connection() as db:
                    again = self._counts(db)
                    backups = migrations.list_backups(db)
                    self.assertEqual([p.name.split(".pre-")[1].rsplit("-", 1)[0] for p in backups], ["0.6.0-001-columns"])
                    self.assertEqual(migrations.applied_versions(db),
                                     {v for v, _ in migrations.MIGRATIONS + migrations.workstream_steps()})
                    for table in ("assignments", "submissions", "chat_turns", "generation_policies"):
                        self.assertEqual(after[table], before[table], table)
                    self.assertEqual(after["events"], before["events"] + after["recovered"] - before["recovered"])
                    self.assertEqual(after["grades"], before["grades"])
                    self.assertEqual(again, after)

    def test_evaluated_snapshot_population(self):  # FOUNDATION-10 (e), §4.3
        evaluated = []
        for source in testsupport.snapshot_paths():
            with dbmod.connection(testsupport.copy_snapshot(source, Path(self.temp.name) / f"probe-{len(evaluated)}.sqlite3")) as db:
                if dbmod.table_exists(db, "generation_policies") and tuple(self._counts(db)[t] for t in self.TOTAL_TABLES) == (12, 6, 358, 7, 2):
                    evaluated.append(source)
        if not evaluated:
            self.skipTest("Evaluated snapshot kiwi-lab.before-v0.6 (358 events) not found; set KIWI_SNAPSHOT_DBS")
        for index, source in enumerate(evaluated):
            with self.subTest(snapshot=source.name):
                app.DB_PATH = testsupport.copy_snapshot(source, Path(self.temp.name) / f"evaluated-{index}.sqlite3")
                app.init_db()
                app.init_db()
                with app.connection() as db:
                    self.assertEqual(tuple(self._counts(db)[t] for t in self.TOTAL_TABLES), (12, 6, 358, 7, 2))
                    self._assert_evaluated_population(db)

    def _assert_evaluated_population(self, db: sqlite3.Connection) -> None:
        for class_id, enrolled, events in (("local-css-demo", 1, 120), ("local-r-class", 2, 232)):
            linked = identity.class_linked(db, class_id)
            pop, params = identity.population_sql("e", class_linked=linked)
            counted = db.execute(f"SELECT COUNT(*) FROM events e WHERE e.class_id=? AND {pop}", (class_id, *params)).fetchone()[0]
            self.assertEqual((identity.enrolled_count(db, class_id), counted), (enrolled, events), class_id)
        demo = "00000000-0000-4000-8000-000000000192"
        self.assertEqual(identity.label(db, "local-css-demo", demo), "Demo Student")
        teacher = db.execute("SELECT source FROM roster WHERE student_id='00000000-0000-4000-8000-000000000191'").fetchone()
        self.assertEqual(teacher["source"], "activity")
        pop, params = identity.population_sql("e", class_linked=True, include_staff=True)
        staff_included = db.execute(f"SELECT COUNT(*) FROM events e WHERE e.class_id='local-css-demo' AND {pop}", params).fetchone()[0]
        self.assertEqual(staff_included, 126)

    def test_ws_migrations_additive(self):  # FOUNDATION-17
        allowed = re.compile(r"^\s*(CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS|CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS|"
                             r"ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN)\s", re.I)
        for ws in migrations.WORKSTREAM_MODULES:
            module = __import__(f"server.migrations_{ws}", fromlist=["OPS"])
            self.assertIsInstance(module.OPS, list)
            for version, statements in module.OPS:
                self.assertTrue(version.startswith(f"0.6.0-{ws}-"), version)
                for statement in statements:
                    self.assertRegex(statement, allowed)
                    self.assertNotRegex(statement, re.compile(r"\b(DROP|TRIGGER|UPDATE|DELETE|INSERT)\b", re.I))
        for bad in ("DROP TABLE events", "UPDATE events SET x=1", "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END"):
            with self.assertRaises(migrations.MigrationError):
                migrations.validate_ws_statement(bad)

    def test_ws_runner_applies_additive_ops_once(self):
        fake = type("M", (), {"OPS": [("0.6.0-grade-001-test", ["ALTER TABLE submissions ADD COLUMN grade_status TEXT",
                                                                "ALTER TABLE submissions ADD COLUMN ws_note TEXT NOT NULL DEFAULT ''",
                                                                "CREATE TABLE IF NOT EXISTS ws_thing (id TEXT PRIMARY KEY)"])]})
        app.DB_PATH = Path(self.temp.name) / "ws.sqlite3"
        app.init_db()
        real_import = migrations.importlib.import_module
        with patch.object(migrations.importlib, "import_module",
                          side_effect=lambda name: fake if name == "server.migrations_grade" else real_import(name)):
            app.init_db()
            app.init_db()
            self.assertIn("ws_thing", migrations.altered_or_created_tables())
        with app.connection() as db:
            self.assertIn("ws_note", dbmod.table_columns(db, "submissions"))
            self.assertIn("0.6.0-grade-001-test", migrations.applied_versions(db))
        bad = type("M", (), {"OPS": [("0.6.0-people-001-x", ["CREATE TABLE IF NOT EXISTS ok (id TEXT)"])]})
        with patch.object(migrations.importlib, "import_module",
                          side_effect=lambda name: bad if name == "server.migrations_grade" else real_import(name)):
            with self.assertRaises(migrations.MigrationError):
                migrations.workstream_steps()

    def test_no_positional_inserts(self):  # FOUNDATION-14
        tables = migrations.altered_or_created_tables()
        self.assertTrue({"events", "assignments", "roster", "submissions", "chat_turns", "learning_sessions", "kiwi_sync",
                         "staff", "ai_calls"} <= tables)
        pattern = re.compile(r"INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s+VALUES", re.I)
        offenders = []
        for path in sorted(SERVER_DIR.rglob("*.py")):
            for match in pattern.finditer(path.read_text()):
                if match.group(1) in tables:
                    offenders.append(f"{path.name}: INSERT INTO {match.group(1)} VALUES")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
