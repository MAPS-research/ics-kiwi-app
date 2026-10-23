"""Regression tests for the v0.6.0 second review (CHANGELOG 0.6.0 › Second review fixes).

Each test names the finding it pins (CORRECTNESS-0n, SECURITY-0n, TEACHER-nn). Fixtures use ``server/testsupport.py``
builders, temporary databases and fake AI providers only.
"""

from __future__ import annotations

import base64
import io
import json
import time
import unittest
import uuid
import zipfile
from datetime import timedelta
from unittest.mock import patch
from urllib.parse import quote

from server import app, auth, identity, leak_guard, migrations, readers, telemetry, testsupport
from server import db as dbmod
from server.test_ai_runtime import FUTURE, LEAK, LIVE_FILL, LIVE_PROMPT, AirunCase, Fake
from server.test_grading import CLS, GradingApiCase, TWO_QUESTIONS
from server.testsupport import TEACHER_KEY, ApiTestCase


def _staff_key(db, class_id: str, role: str, name: str) -> tuple[str, str]:
    key = auth.new_staff_key()
    staff_id = f"staff-{role}-{uuid.uuid4().hex[:6]}"
    with dbmod.write_tx(db):
        db.execute("""INSERT INTO staff (id, class_id, display_name, role, key_hash, key_prefix, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'instructor', ?)""",
                   (staff_id, class_id, name, role, auth.hash_staff_key(key), auth.key_prefix(key), dbmod.now()))
    return staff_id, key


def _consent(db, class_id: str, student_id: str, value: str | None) -> None:
    with dbmod.write_tx(db):
        db.execute("UPDATE roster SET consent_override=? WHERE class_id=? AND student_id=?", (value, class_id, student_id))


def _text(raw: object) -> str:
    return raw.decode("utf-8") if isinstance(raw, bytes) else json.dumps(raw, ensure_ascii=False)


# ── grading ───────────────────────────────────────────────────────────────────────────────────────

class ReleasedGradeTests(GradingApiCase):
    def _released(self):
        rec = self.hw(grades_visibility="on_release")
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"})
        items = {"q1": {"score": 10, "comment": ""}, "q2": {"score": 6, "comment": ""}}
        status, body = self.put_grade(sub, {"items": items, "action": "release"})
        self.assertEqual((status, body["submission"]["gradeStatus"]), (200, "released"), body)
        return rec, sub

    def test_ta_cannot_withdraw_a_released_grade_by_saving(self):  # CORRECTNESS-01
        _rec, sub = self._released()
        ta = self.staff_key("ta", "Wang (TA)")
        status, body = self.put_grade(sub, {"items": {"q2": {"score": 6, "comment": "typo fix"}}, "action": "save"}, key=ta)
        self.assertEqual((status, body["code"]), (403, "role_required"), body)
        self.assertIn("unrelease", body["error"])
        with self.db() as db:
            row = db.execute("SELECT grade_status, released_at, grade FROM submissions WHERE id=?", (sub,)).fetchone()
            comment = db.execute("SELECT comment FROM submission_item_scores WHERE submission_id=? AND question_id='q2'",
                                 (sub,)).fetchone()[0]
        self.assertEqual(row["grade_status"], "released")
        self.assertIsNotNone(row["released_at"])
        self.assertEqual((row["grade"], comment), (16.0, ""))

    def test_instructor_draft_over_released_grade_records_the_withdrawal(self):  # CORRECTNESS-01
        _rec, sub = self._released()
        status, body = self.put_grade(sub, {"items": {"q2": {"score": 7, "comment": ""}}, "action": "save"})
        self.assertEqual((status, body["submission"]["gradeStatus"]), (200, "draft"), body)
        with self.db() as db:
            actions = [(r["action"], r["status_before"], r["status_after"]) for r in db.execute(
                "SELECT action, status_before, status_after FROM grade_events WHERE submission_id=? ORDER BY id", (sub,))]
            audit_rows = [r[0] for r in db.execute("SELECT action FROM teacher_actions WHERE target_id=? ORDER BY id", (sub,))]
        self.assertEqual(actions[-2:], [("unrelease", "released", "draft"), ("save_draft", "draft", "draft")])
        self.assertIn("grade_unrelease", audit_rows)
        self.assertEqual(audit_rows[-1], "grade_save")

    def test_home_lists_drafts_of_immediately_homework_to_release(self):  # CORRECTNESS-05, TEACHER-05
        rec = self.hw(grades_visibility="immediately")
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"})
        ta = self.staff_key("ta", "Wang (TA)")
        items = {"q1": {"score": 10, "comment": ""}, "q2": {"score": 6, "comment": ""}}
        self.assertEqual(self.put_grade(sub, {"items": items, "action": "save"}, key=ta)[0], 200)
        status, home = self.request(f"/api/teacher/home?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, home)
        self.assertEqual(home["needsAction"]["toRelease"], [{"assignmentId": rec.id, "title": rec.title, "count": 1}])


class DraftAnsweredTests(GradingApiCase):
    def test_whitespace_only_draft_is_not_started_anywhere(self):  # CORRECTNESS-09
        rec = self.hw(due_at="2020-01-01T00:00:00+00:00")
        status, body = self.request(f"/api/drafts/{rec.id}?classId={CLS}", "PUT",
                                    {"answers": {"q1": " \n\t ", "q2": ""}, "clientTs": 1}, student="s1")
        self.assertIn(status, (200, 204), body)
        with self.db() as db:
            self.assertEqual(db.execute("SELECT MAX(value_length) FROM answer_drafts").fetchone()[0], 0)
            cell = readers.gradebook_cell(db, readers.load_assignment(db, CLS, rec.id), "s1")
        self.assertEqual((cell["state"], cell["draftAnswered"]), ("missing", 0))
        self.assertNotIn("started", cell["label"])
        _, home = self.request(f"/api/teacher/home?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual([m["started"] for m in home["needsAction"]["missingPastDue"]], [0])
        _, listing = self.request(f"/api/teacher/assignments?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual([a["stats"]["startedNotSubmitted"] for a in listing["assignments"]], [0])


# ── course packages ───────────────────────────────────────────────────────────────────────────────

def _package(assignments: list[dict], files: list[dict] | None = None, data: dict[str, bytes] | None = None) -> str:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("manifest.json", json.dumps({"format": "css-lab-course-package", "formatVersion": 1}))
        z.writestr("course.json", json.dumps({"units": []}))
        z.writestr("assignments.json", json.dumps(assignments))
        z.writestr("ai_rules.json", "[]")
        z.writestr("groups.json", "[]")
        z.writestr("files.json", json.dumps(files or []))
        for path, raw in (data or {}).items():
            z.writestr(path, raw)
    return base64.b64encode(buf.getvalue()).decode()


GOOD_Q = {"id": "q1", "type": "fill", "prompt": "mean(c(2,4,6))?", "points": 10, "answer": "4"}


class PackageValidationTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Ada Chen")

    def _import(self, package: str, mode: str = "apply"):
        return self.request("/api/teacher/course-package/import?classId=c1", "POST", {"zipBase64": package, "mode": mode},
                            TEACHER_KEY)

    def test_invalid_assignments_are_skipped_and_valid_ones_cleaned(self):  # CORRECTNESS-02
        base = {"kind": "homework", "unitId": "r-basics"}
        bad_questions = [{"type": "bogus", "prompt": "no id"}, dict(GOOD_Q), dict(GOOD_Q, prompt="dup id")]
        package = _package([
            {**base, "key": "a1", "title": "Broken questions", "questions": bad_questions},
            {**base, "key": "a2", "title": "Too many attempts", "questions": [GOOD_Q], "maxAttempts": 100000},
            {**base, "key": "a3", "title": "Odd late policy", "questions": [GOOD_Q], "latePolicy": {"mode": "weird"}},
            {**base, "key": "a4", "title": "Good homework", "questions": [GOOD_Q], "maxAttempts": 2},
        ])
        status, preview = self._import(package, "preview")
        self.assertEqual(status, 200, preview)
        self.assertEqual([a["action"] for a in preview["assignments"]], ["skip", "skip", "skip", "add"])
        self.assertEqual(len([w for w in preview["warnings"] if w.startswith("Skipped “")]), 3)
        status, result = self._import(package)
        self.assertEqual(status, 200, result)
        with self.db() as db:
            rows = db.execute("SELECT title, questions_json, max_attempts, late_policy_json FROM assignments").fetchall()
        self.assertEqual([r["title"] for r in rows], ["Good homework"])
        question = json.loads(rows[0]["questions_json"])[0]
        self.assertEqual((question["id"], question["graderRubric"], rows[0]["max_attempts"]), ("q1", "", 2))
        self.assertEqual(json.loads(rows[0]["late_policy_json"])["mode"], readers.LATE_POLICY_DEFAULT["mode"])

    def test_publish_refuses_a_broken_question_set(self):  # CORRECTNESS-02 (defense in depth)
        with self.db() as db:
            rec = testsupport.publish_work(db, "c1", status="draft",
                                           questions=[{"type": "fill", "prompt": "no id"}, dict(GOOD_Q), dict(GOOD_Q)])
        status, body = self.request(f"/api/teacher/assignments/{rec.id}/publish?classId=c1", "POST", {}, TEACHER_KEY)
        self.assertEqual(status, 400, body)
        self.assertIn("valid id", body["error"])

    def test_imported_files_pass_the_upload_checks(self):  # SECURITY-07
        files = [
            {"path": "files/1", "name": "../../evil.html", "mime": "text/html", "scope": "chapter", "unitId": "r-basics",
             "aiReference": True},
            {"path": "files/2", "name": "data.csv", "mime": "text/csv", "scope": "chapter", "unitId": "r-basics",
             "aiReference": True},
            {"path": "files/3", "name": "big.csv", "mime": "text/csv", "scope": "chapter", "unitId": "r-basics"},
            {"path": "files/4", "name": "notes.md", "mime": "not a mime", "scope": "chapter", "unitId": "r-basics",
             "aiReference": True},
        ]
        data = {"files/1": b"<script>", "files/2": b"a,b\n1,2\n", "files/3": b"x" * 3_100_000, "files/4": b"# Notes"}
        status, result = self._import(_package([], files, data))
        self.assertEqual(status, 200, result)
        self.assertEqual(result["files"], 1)
        self.assertEqual(len([w for w in result["warnings"] if w.startswith("Skipped file")]), 3)
        with self.db() as db:
            stored = [tuple(r) for r in db.execute("SELECT name, mime, ai_reference FROM course_files")]
        self.assertEqual(stored, [("notes.md", "application/octet-stream", 1)])

    def test_upload_rejects_path_names(self):  # SECURITY-07 (same rule for uploads)
        body = {"scope": "chapter", "unitId": "r-basics", "name": "../x.csv", "data": base64.b64encode(b"a").decode()}
        status, error = self.request("/api/teacher/files?classId=c1", "POST", body, TEACHER_KEY)
        self.assertEqual(status, 400, error)


# ── de-identified exports and researcher views ────────────────────────────────────────────────────

class DeidentifiedExportTests(ApiTestCase):
    """Zelda (consent yes) names her classmate Bobby (no consent) and his email in her own text."""

    def setUp(self) -> None:
        super().setUp()
        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Zelda Realname", kiwi_email="zelda@realmail.edu")
            testsupport.add_roster(db, "c1", "s2", display_name="Bobby Tables", kiwi_email="bobby@realmail.edu")
            _consent(db, "c1", "s1", "yes")
            _consent(db, "c1", "s2", "no")
            self.turn = testsupport.make_chat_turn(db, "c1", "s1", "My friend Bobby Tables (bobby@realmail.edu) says hi",
                                                   "Hi Zelda Realname, ask Bobby Tables directly.")
            testsupport.make_chat_turn(db, "c1", "s2", "NOCONSENTCHAT", "ok", thread_id="t2")
            self.rid, self.rkey = _staff_key(db, "c1", "researcher", "Shen (research)")
        status, code = self.request("/api/teacher/codebook?classId=c1", "POST", {"label": "Peer help"}, key=TEACHER_KEY)
        self.assertEqual(status, 201, code)
        status, added = self.request("/api/teacher/ai-conversations/codes?classId=c1", "POST",
                                     {"threadKey": "lab:s1:t1", "codeId": code["id"], "chatTurnId": self.turn,
                                      "note": "Zelda Realname copied from Bobby Tables"}, key=TEACHER_KEY)
        self.assertEqual(status, 201, added)

    def _assert_clean(self, text: str) -> None:
        for term in ("Bobby Tables", "bobby@realmail.edu", "Zelda Realname", "zelda@realmail.edu"):
            self.assertNotIn(term, text)

    def test_researcher_exports_scrub_every_roster_name(self):  # CORRECTNESS-03, SECURITY-01
        # standalone courses: researchers cannot opt into unverified data (RV6-M07 refuses their exports); the
        # instructor's research package is checked
        status, raw = self.request("/api/teacher/exports/research-package.zip?classId=c1&allowUnverified=1&purpose="
                                   + quote("Help seeking study"), key=TEACHER_KEY)
        self.assertEqual(status, 200, raw)
        archive = zipfile.ZipFile(io.BytesIO(raw))
        for name in archive.namelist():
            with self.subTest(file=name):
                self._assert_clean(archive.read(name).decode("utf-8", "replace"))
        status, body = self.request("/api/teacher/exports/activity.jsonl?classId=c1", key=self.rkey)
        self.assertEqual((status, body["code"]), (409, "unverified_identity"))
        # the same course linked to Kiwi (verified identities, a Kiwi staff member overridden to researcher)
        with self.db() as db, dbmod.write_tx(db):
            db.execute("INSERT INTO kiwi_links (class_id, name) VALUES ('c1', 'c1')")
            db.execute("UPDATE roster SET source='kiwi' WHERE class_id='c1'")
            for table in ("events", "chat_turns", "ai_calls"):
                db.execute(f"UPDATE {table} SET identity_verified=1 WHERE class_id='c1'")
            db.execute("""INSERT INTO staff (id, class_id, display_name, role, kiwi_user_id, created_by, created_at)
                       VALUES ('staff-r-kiwi', 'c1', 'Shen (Kiwi)', 'researcher', 'r1', 'test', ?)""", (dbmod.now(),))
        with testsupport.fake_kiwi_identity("staff", False, True, "professor", class_id="c1", user_id="r1") as token:
            for path in ("activity.jsonl", "ai-conversations.csv", "conversation-codes.csv"):
                with self.subTest(path=path):
                    status, raw = self.request(f"/api/teacher/exports/{path}?classId=c1", token=token)
                    self.assertEqual(status, 200, raw)
                    self._assert_clean(_text(raw))
                    self.assertNotIn("NOCONSENTCHAT", _text(raw))
            status, raw = self.request("/api/teacher/exports/ai-conversations.csv?classId=c1", token=token)
            # the consenting student's turn, classmate name scrubbed; SB-m01: a non-consenting classmate is "[classmate]",
            # never their research id
            self.assertIn("My friend [classmate] ([classmate])", _text(raw))
            status, raw = self.request("/api/teacher/exports/conversation-codes.csv?classId=c1", token=token)
            self.assertIn("copied from [classmate]", _text(raw))
            self.assertRegex(_text(raw), r"P[A-Z0-9]+ copied from")

    def test_instructor_pseudonymized_export_scrubs_classmates(self):  # CORRECTNESS-03
        status, raw = self.request("/api/teacher/exports/ai-conversations.csv?classId=c1&pseudonymize=1&consent=all",
                                   key=TEACHER_KEY)
        self.assertEqual(status, 200, raw)
        self._assert_clean(_text(raw))
        status, raw = self.request("/api/teacher/exports/ai-conversations.csv?classId=c1", key=TEACHER_KEY)
        self.assertIn("Bobby Tables", _text(raw))  # a named teaching export keeps the text

    def test_researcher_sees_consenting_students_only(self):  # SECURITY-02
        status, threads = self.request("/api/teacher/ai-conversations/threads?classId=c1", key=self.rkey)
        self.assertEqual(status, 200, threads)
        self.assertEqual(len(threads["threads"]), 1)
        self.assertNotIn("NOCONSENTCHAT", _text(threads))
        rid1 = threads["threads"][0]["studentId"]
        with self.db() as db:
            self.assertEqual(rid1, identity.research_id(db, "c1", "s1"))
            rid2 = identity.research_id(db, "c1", "s2")
        for path in ("/api/teacher/events", "/api/teacher/summary", "/api/teacher/analytics/table?group=students&v=2",
                     "/api/teacher/ai-conversations/digest", "/api/teacher/analytics/evidence"):
            with self.subTest(path=path):
                status, body = self.request(f"{path}{'&' if '?' in path else '?'}classId=c1", key=self.rkey)
                self.assertEqual(status, 200, body)
                self.assertNotIn("NOCONSENTCHAT", _text(body))
                self.assertNotIn('"s2"', _text(body))
                self.assertNotIn(rid2, _text(body))
        for target in (f"/api/teacher/events?studentId={rid2}", "/api/teacher/events?studentId=s2",
                       f"/api/teacher/timeline?studentId={rid2}", f"/api/teacher/ai-conversations/threads/lab:{rid2}:t2",
                       "/api/teacher/ai-conversations/threads/lab:s2:t2"):
            with self.subTest(target=target):
                status, body = self.request(f"{target}&classId=c1" if "?" in target else f"{target}?classId=c1", key=self.rkey)
                self.assertEqual((status, body["code"]), (404, "not_found"), body)
        with self.db() as db:
            activity = db.execute("SELECT id FROM learning_sessions WHERE studentId='s2' LIMIT 1").fetchone()
        if activity is not None:
            status, body = self.request(f"/api/teacher/analytics/question-activity/{activity[0]}?classId=c1", key=self.rkey)
            self.assertEqual(status, 404, body)
        # the instructor still sees both students
        status, threads = self.request("/api/teacher/ai-conversations/threads?classId=c1", key=TEACHER_KEY)
        self.assertEqual(len(threads["threads"]), 2)

    def test_researcher_gets_research_ids_and_can_use_them(self):  # SECURITY-05
        with self.db() as db:
            rid1 = identity.research_id(db, "c1", "s1")
        status, threads = self.request("/api/teacher/ai-conversations/threads?classId=c1", key=self.rkey)
        key = threads["threads"][0]["threadKey"]
        self.assertEqual(key, f"lab:{rid1}:t1")
        self.assertNotIn('"s1"', _text(threads))
        status, thread = self.request(f"/api/teacher/ai-conversations/threads/{key}?classId=c1", key=self.rkey)
        self.assertEqual(status, 200, thread)
        status, timeline = self.request(f"/api/teacher/timeline?classId=c1&studentId={rid1}", key=self.rkey)
        self.assertEqual(status, 200, timeline)
        self.assertNotIn('"s1"', _text(timeline))
        self.assertNotIn("/s/s1/", _text(timeline))


class LinkedResearchPackageTests(ApiTestCase):
    def test_kiwi_linked_researcher_package_scrubs_classmates(self):  # CORRECTNESS-03, SECURITY-01
        cls = "live-course"
        with self.db() as db, dbmod.write_tx(db):
            db.execute("INSERT INTO kiwi_links (class_id, name) VALUES (?, ?)", (cls, cls))
        self.create_course(cls)
        with self.db() as db:
            testsupport.add_roster(db, cls, "kiwi-s1", source="kiwi", display_name="Zelda Realname")
            testsupport.add_roster(db, cls, "kiwi-s2", source="kiwi", display_name="Bobby Tables", kiwi_email="bobby@realmail.edu")
            _consent(db, cls, "kiwi-s1", "yes")
            testsupport.make_chat_turn(db, cls, "kiwi-s1", "Bobby Tables (bobby@realmail.edu) told me the answer",
                                       "Ask Bobby Tables how.")
            with dbmod.write_tx(db):
                db.execute("""INSERT INTO staff (id, class_id, display_name, role, kiwi_user_id, created_by, created_at)
                    VALUES ('staff-r1', ?, 'Shen (research)', 'researcher', 'kiwi-r9', 'instructor', ?)""", (cls, dbmod.now()))
        with testsupport.fake_kiwi_identity("ta", can_view=True, user_role="ta", class_id=cls, user_id="kiwi-r9",
                                            username="shen@css-kiwi.local") as token:
            status, raw = self.request(f"/api/teacher/exports/research-package.zip?classId={cls}&purpose=" + quote("Study"),
                                       token=token)
        self.assertEqual(status, 200, raw)
        archive = zipfile.ZipFile(io.BytesIO(raw))
        texts = {name: archive.read(name).decode("utf-8", "replace") for name in archive.namelist()}
        self.assertTrue(any("told me the answer" in t for t in texts.values()))
        for name, text in texts.items():
            with self.subTest(file=name):
                self.assertNotIn("Bobby Tables", text)
                self.assertNotIn("bobby@realmail.edu", text)


class EmailIdTests(ApiTestCase):
    def test_email_student_ids_never_reach_a_researcher(self):  # SECURITY-05
        self.create_course("c1")
        sid = "carol.k@realmail.edu"
        with self.db() as db:
            testsupport.add_roster(db, "c1", sid, display_name="Carol King")
            _consent(db, "c1", sid, "yes")
            testsupport.make_chat_turn(db, "c1", sid, f"I am {sid}", "Hello", thread_id="t3")
            _rid, key = _staff_key(db, "c1", "researcher", "Shen (research)")
            rid = identity.research_id(db, "c1", sid)
        for path in ("/api/teacher/ai-conversations/threads", "/api/teacher/events", "/api/teacher/summary",
                     "/api/teacher/analytics/table?group=students&v=2"):
            with self.subTest(path=path):
                status, body = self.request(f"{path}{'&' if '?' in path else '?'}classId=c1", key=key)
                self.assertEqual(status, 200, body)
                self.assertNotIn("realmail", _text(body))
        status, timeline = self.request(f"/api/teacher/timeline?classId=c1&studentId={rid}", key=key)
        self.assertEqual(status, 200, timeline)
        self.assertNotIn("realmail", _text(timeline))


class PresentationModeTests(ApiTestCase):
    def test_free_text_is_scrubbed_for_every_staff_role(self):  # SECURITY-04
        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Zelda Realname")
            testsupport.add_roster(db, "c1", "s2", display_name="Bobby Tables", kiwi_email="bobby@realmail.edu")
            testsupport.make_chat_turn(db, "c1", "s1", "I am Zelda Realname and my friend is Bobby Tables bobby@realmail.edu",
                                       "Hi")
            _vid, viewer = _staff_key(db, "c1", "viewer", "Vera Viewer")
        for key in (TEACHER_KEY, viewer):
            for path in ("/api/teacher/ai-conversations/threads/lab:s1:t1", "/api/teacher/events",
                         "/api/teacher/timeline?studentId=s1", "/api/teacher/ai-conversations/digest"):
                with self.subTest(key=key[:6], path=path):
                    status, body = self.request(f"{path}{'&' if '?' in path else '?'}classId=c1", key=key,
                                                name_mode="pseudonyms")
                    self.assertEqual(status, 200, body)
                    for term in ("Zelda Realname", "Bobby Tables", "bobby@realmail.edu"):
                        self.assertNotIn(term, _text(body))
        status, named = self.request("/api/teacher/ai-conversations/threads/lab:s1:t1?classId=c1", key=TEACHER_KEY)
        self.assertIn("Bobby Tables", _text(named))


# ── telemetry ─────────────────────────────────────────────────────────────────────────────────────

class TelemetryLimitTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Ada Chen")

    def test_wide_payloads_are_cut_to_the_limit(self):  # CORRECTNESS-04
        for width in (100, 300):
            payload = {f"k{i}": ["y" * width for _ in range(200)] for i in range(60)}
            out, cut = telemetry.truncate_payload("code_run", payload)
            self.assertLessEqual(len(json.dumps(out, ensure_ascii=False)), telemetry.MAX_PAYLOAD_CHARS)
            self.assertTrue(cut)
            self.assertLessEqual(len(out["_truncated"]), telemetry.MAX_TRUNCATED_PATHS + 1)
        long_keys = {("k" * 150) + str(i): "v" for i in range(2000)}
        out, _ = telemetry.truncate_payload("code_run", long_keys)
        self.assertLessEqual(len(json.dumps(out, ensure_ascii=False)), telemetry.MAX_PAYLOAD_CHARS)
        small = {"code": "x <- 1", "unitId": "r-basics"}
        self.assertEqual(telemetry.truncate_payload("code_run", dict(small)), (small, {}))

    def test_stored_payload_never_exceeds_the_limit(self):  # CORRECTNESS-04
        payload = {f"k{i}": ["y" * 60 for _ in range(200)] for i in range(60)}
        event = {"eventId": uuid.uuid4().hex, "classId": "c1", "type": "code_run", "sessionId": "tab-1", "schemaVersion": 2,
                 "payload": payload}
        status, body = self.request("/api/events", "POST", event, student="s1")
        self.assertEqual(status, 201, body)
        with self.db() as db:
            stored = db.execute("SELECT MAX(length(payload_json)) FROM events WHERE event_type='code_run'").fetchone()[0]
        self.assertLessEqual(stored, telemetry.MAX_PAYLOAD_CHARS)

    def test_late_event_bridging_two_activities_merges_them(self):  # CORRECTNESS-06
        start = int(time.time() * 1000) - 3 * 3600 * 1000

        def event(offset_min: int) -> dict:
            return {"eventId": uuid.uuid4().hex, "classId": "c1", "type": "question_viewed", "questionId": "q-x1",
                    "sessionId": "tab-1", "schemaVersion": 2, "clientTs": start + offset_min * 60000, "surface": "free-practice",
                    "payload": {"unitId": "r-basics"}}

        for offset in (0, 50, 25):
            self.assertEqual(self.request("/api/events", "POST", event(offset), student="s1")[0], 201)
        with self.db() as db:
            live = db.execute("SELECT id, interactions, startedAt, lastActive FROM learning_sessions WHERE studentId='s1'").fetchall()
            linked = {r[0] for r in db.execute("SELECT learning_session_id FROM events WHERE student_id='s1'")}
            aliases = db.execute("SELECT COUNT(*) FROM learning_session_aliases").fetchone()[0]
            self.assertEqual(len(live), 1)
            self.assertEqual(live[0]["interactions"], 3)
            self.assertEqual(linked, {live[0]["id"]})
            self.assertEqual(aliases, 1)
            telemetry.rebuild_sessions_v3(db)
            rebuilt = db.execute("SELECT interactions, startedAt, lastActive FROM learning_sessions WHERE studentId='s1'").fetchall()
        self.assertEqual([(r["interactions"], r["startedAt"], r["lastActive"]) for r in rebuilt],
                         [(live[0]["interactions"], live[0]["startedAt"], live[0]["lastActive"])])


# ── in-class checks ───────────────────────────────────────────────────────────────────────────────

class CheckRetryTests(ApiTestCase):
    Q = [{"id": "p1", "type": "fill", "prompt": "mean(c(2,4,6))?", "points": 10, "choices": [], "starterCode": "",
          "answer": "4", "explanation": "", "maxAttempts": 1, "hints": ["Add them up first."]}]

    def test_retry_with_the_same_event_id_returns_the_stored_result(self):  # CORRECTNESS-07
        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Ada Chen")
            rec = testsupport.publish_work(db, "c1", kind="practice", questions=self.Q)
        body = {"questionId": "p1", "answer": "5", "eventId": "evt-check-1", "sessionId": "tab-1"}
        first = self.request(f"/api/work/{rec.id}/check?classId=c1", "POST", body, student="s1")
        retry = self.request(f"/api/work/{rec.id}/check?classId=c1", "POST", body, student="s1")
        self.assertEqual(first[0], 200, first)
        self.assertEqual(retry[0], 200, retry)
        for key in ("correct", "attemptIndex", "attemptsLeft", "revealedAnswer", "nextHint"):
            self.assertEqual(retry[1].get(key), first[1].get(key), key)
        self.assertEqual((first[1]["attemptsLeft"], first[1]["revealedAnswer"]), (0, "4"))
        other = self.request(f"/api/work/{rec.id}/check?classId=c1", "POST", {**body, "eventId": "evt-check-2"}, student="s1")
        self.assertEqual((other[0], other[1]["code"]), (409, "max_attempts_reached"))
        with self.db() as db:
            n = db.execute("SELECT COUNT(*) FROM events WHERE event_type='answer_submitted' AND student_id='s1'").fetchone()[0]
        self.assertEqual(n, 1)


# ── solutions visibility (D2) ─────────────────────────────────────────────────────────────────────

class AfterDueWithoutDueDateTests(ApiTestCase):
    def test_closed_homework_without_due_date_shows_solutions(self):  # CORRECTNESS-08
        self.create_course("c1")
        past = (dbmod.utcnow() - timedelta(days=1)).isoformat()
        with self.db() as db:
            rec = testsupport.publish_work(db, "c1", due_at=None, close_at=past, solutions_visibility="after_due")
            now = dbmod.utcnow()
            self.assertEqual(readers.assignment_state(rec, now), "closed")
            self.assertTrue(readers.solutions_visible(db, rec, "s1", now))
            self.assertFalse(readers.answer_protected(db, rec, "s1", now))
            open_rec = testsupport.publish_work(db, "c1", due_at=None, close_at=FUTURE, solutions_visibility="after_due")
            self.assertFalse(readers.solutions_visible(db, open_rec, "s1", now))

    def test_close_date_before_due_date_is_rejected(self):  # CORRECTNESS-08
        self.create_course("c1")
        body = {"kind": "homework", "title": "Dates", "unitId": "r-basics", "dueAt": "2030-01-10T00:00:00+00:00",
                "closeAt": "2030-01-05T00:00:00+00:00", "questions": [GOOD_Q]}
        status, error = self.request("/api/teacher/assignments?classId=c1", "POST", body, TEACHER_KEY)
        self.assertEqual(status, 400, error)
        self.assertIn("close date", error["error"])


# ── AI guard ──────────────────────────────────────────────────────────────────────────────────────

class GuardFieldsTests(AirunCase):
    def test_homework_text_in_any_student_field_is_matched(self):  # SECURITY-03
        hw = self.homework(tool_policy={"askKiwi": "off", "similarPractice": False})
        self.assertTrue(hw.id)
        fake = Fake(default=LEAK)
        with patch.object(app.ai, "invoke", fake):
            for field in ("error", "runOutput", "answerDraft"):
                with self.subTest(field=field):
                    status, reply = self.chat("Please solve the exercise text shown in my box", **{field: LIVE_PROMPT})
                    self.assertEqual(status, 200, reply)
                    self.assertEqual(reply["response"], leak_guard.BLOCKED_REPLY)
                    self.assertEqual(reply["guard"]["status"], "blocked")
        self.assertEqual(fake.count, 0)

    def test_hints_homework_text_in_output_is_guarded(self):  # SECURITY-03
        self.homework()
        with patch.object(app.ai, "invoke", Fake(LEAK, "Think about what mean() adds up.")):
            status, reply = self.chat("What does this print mean?", runOutput=LIVE_PROMPT)
        self.assertEqual(status, 200, reply)
        self.assertIn(reply["guard"]["status"], ("clean", "retried_clean", "redacted"))
        self.assertNotIn("returns 4", reply["response"])


# ── client address ────────────────────────────────────────────────────────────────────────────────

class ForwardedForTests(ApiTestCase):
    def test_the_proxy_hop_is_limited_not_the_client_supplied_one(self):  # SECURITY-06
        for n in range(10):
            status, _ = self.request("/api/teacher/hub?classId=c1", key="wrong", client_addr=f"10.0.0.{n}, 127.0.0.9")
            self.assertEqual(status, 401)
        status, body = self.request("/api/teacher/hub?classId=c1", key="wrong", client_addr="10.0.0.99, 127.0.0.9")
        self.assertEqual((status, body["code"]), (429, "rate_limited"))
        self.assertEqual(self.request("/api/teacher/hub?classId=c1", key="wrong", client_addr="10.0.0.1, 127.0.0.10")[0], 401)


# ── timelines, migration, data health ─────────────────────────────────────────────────────────────

class LegacyContextTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Ada Chen")
            self.rec = testsupport.publish_work(db, "c1", questions=TWO_QUESTIONS, due_at=FUTURE)

    def test_legacy_similar_exercise_shows_its_stem_and_title(self):  # TEACHER-06
        with self.db() as db, dbmod.write_tx(db):
            db.execute("""INSERT INTO events (class_id, student_id, student_name, session_id, event_type, question_id, payload_json,
                created_at, source, practice_mode, related_assignment_id, attribution_assignment_id, actor_role)
                VALUES ('c1', 's1', 'Ada Chen', 'tab', 'question_generated', 'q-fa62eef0', ?, ?, 'lab', 'similar', ?, '', 'student')""",
                       (json.dumps({"title": "Mean of a column", "prompt": "What does mean(df$x) print?", "questionType": "choice",
                                    "choices": ["1", "2"], "relatedAssignmentId": self.rec.id, "unitId": "r-basics"}),
                        dbmod.now(), self.rec.id))
        status, timeline = self.request(f"/api/teacher/timeline?classId=c1&studentId=s1&assignmentId={self.rec.id}", key=TEACHER_KEY)
        self.assertEqual(status, 200, timeline)
        entry = next(e for e in timeline["events"] if e["kind"] == "similar_generated")
        self.assertEqual(entry["questionLabel"], "Mean of a column")
        self.assertEqual((entry["detail"]["stem"], entry["detail"]["questionType"]), ("What does mean(df$x) print?", "choice"))

    def test_migration_backfills_legacy_chat_context(self):  # TEACHER-07
        with self.db() as db, dbmod.write_tx(db):
            db.execute("""INSERT INTO chat_turns (class_id, student_id, thread_id, question_id, prompt, response, created_at)
                VALUES ('c1', 's1', ?, '', 'Why NA?', 'Use na.rm', ?)""", (f"thread-{self.rec.id}-q2", dbmod.now()))
            db.execute("""INSERT INTO chat_turns (class_id, student_id, thread_id, question_id, prompt, response, created_at)
                VALUES ('c1', 's1', 'thread-practice-data-wrangling', '', 'What is a tibble?', 'A data frame', ?)""", (dbmod.now(),))
            db.execute("""INSERT INTO grade_events (submission_id, class_id, actor_id, actor_role, actor_label, action, created_at)
                VALUES ('sub-1', 'c1', 'pre-0.6', 'system', 'Before v0.6', 'migrated', ?)""", (dbmod.now(),))
            migrations.b8_chat_context(db)
            rows = [tuple(r) for r in db.execute(
                "SELECT assignment_id, question_id, unit_id FROM chat_turns WHERE prompt IN ('Why NA?', 'What is a tibble?') ORDER BY id")]
            label = db.execute("SELECT actor_label FROM grade_events WHERE submission_id='sub-1'").fetchone()[0]
        self.assertEqual(rows, [(self.rec.id, "q2", "r-basics"), ("", "", "data-wrangling")])
        self.assertEqual(label, "Imported from v0.5")
        self.assertIn(("0.6.0-010-chat-context", migrations.b8_chat_context), migrations.MIGRATIONS)


class DataHealthBlockedTests(AirunCase):
    def test_scope_refusals_are_counted(self):  # TEACHER-13
        with patch.object(app.ai, "invoke", Fake()):
            self.assertEqual(self.chat("What is a network?", unit="network-analysis")[0], 403)
            self.assertEqual(self.chat("What is a vector?")[0], 200)
        status, health = self.request(f"/api/teacher/data-health?classId=c1", key=TEACHER_KEY)
        self.assertEqual(status, 200, health)
        calls = health["aiCalls"]
        self.assertEqual((calls["total"], calls["ok"], calls["blocked"], calls["turnedAway"], calls["failed"]), (2, 1, 1, 0, 0))
        self.assertEqual(calls["other"], 0)


class IdleDaysTests(ApiTestCase):
    def test_idle_days_round_like_the_roster(self):  # TEACHER-14
        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Ada Chen")
        moment = (dbmod.utcnow() - timedelta(days=10, hours=20)).isoformat(timespec="milliseconds")
        with self.db() as db, dbmod.write_tx(db):
            db.execute("""INSERT INTO events (class_id, student_id, student_name, session_id, event_type, payload_json, created_at,
                source, actor_role, category) VALUES ('c1', 's1', 'Ada Chen', 'tab', 'code_run', '{}', ?, 'lab', 'student', 'action')""",
                       (moment,))
        status, home = self.request("/api/teacher/home?classId=c1", key=TEACHER_KEY)
        self.assertEqual(status, 200, home)
        self.assertIn("No learning actions for 11 days", _text(home))   # B-m01 wording


if __name__ == "__main__":
    unittest.main()
