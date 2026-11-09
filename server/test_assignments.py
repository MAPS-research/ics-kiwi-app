"""Assignment authoring, lifecycle, freeze, versions, preview, files, starter assignments and redaction — owned by ASSESS.

The first three tests were moved from server/test_app.py by FOUNDATION (unchanged in intent). The rest cover
ASSESS-03/04/05/07/08/09/13/14/15/16/17/18/19/20/23/25 (spec §9.1) and the gate leftover on preview lists.
"""

import base64
import json
import threading
import unittest
from datetime import timedelta

from server import db as dbmod
from server import testsupport
from server.testsupport import TEACHER_KEY, ApiTestCase

STAFF_ONLY_KEYS = ("answer", "referenceCode", "expectedOutput", "acceptedAnswers", "graderRubric", "grading", "tags")


def iso(delta: timedelta) -> str:
    return dbmod.iso_seconds(dbmod.utcnow() + delta)


def homework_input(**overrides):
    body = {
        "kind": "homework", "title": "Week 3 homework", "unitId": "r-basics", "instructions": "Do it.",
        "dueAt": None, "openAt": None, "closeAt": None,
        "latePolicy": {"mode": "accept_marked", "untilAt": None, "graceMinutes": 0, "penaltyPctPerDay": 0},
        "maxAttempts": None, "timeLimit": None, "gradesVisibility": "on_release", "solutionsVisibility": "never",
        "toolPolicy": {"rWorkspace": True, "allowRunPredict": False, "askKiwi": "hints_only", "similarPractice": False},
        "audience": {"type": "all"},
        "questions": [
            {"id": "q1", "type": "fill", "prompt": "mean(c(2, 4, 6))?", "points": 10, "choices": [], "starterCode": "",
             "answer": "4", "graderRubric": "Full marks for 4.", "tags": ["vectors"]},
            {"id": "q2", "type": "text", "prompt": "Explain a vector.", "points": 10, "choices": [], "starterCode": "",
             "graderRubric": "Mentions one type."},
        ],
    }
    body.update(overrides)
    return body


def inclass_input(**overrides):
    body = homework_input(kind="practice", title="In-class 1", gradesVisibility="immediately",
                          toolPolicy={"rWorkspace": True, "allowRunPredict": True, "askKiwi": "explain_concepts", "similarPractice": True},
                          questions=[
                              {"id": "p1", "type": "choice", "prompt": "Pick 4", "points": 5, "choices": ["2", "4", "6"], "starterCode": "",
                               "answer": "4", "studentExplanation": "The mean of 2, 4, 6 is 4.", "graderRubric": "n/a",
                               "hints": ["Add them up.", "Divide by 3."], "maxAttempts": 3},
                              {"id": "p2", "type": "text", "prompt": "Why?", "points": 5, "choices": [], "starterCode": ""},
                          ])
    body.update(overrides)
    return body


class AssessCase(ApiTestCase):
    cls = "assess"

    def setUp(self):
        super().setUp()
        self.create_course(self.cls)

    def t(self, path, method="GET", body=None, **kw):
        sep = "&" if "?" in path else "?"
        return self.request(f"{path}{sep}classId={self.cls}", method, body, TEACHER_KEY, **kw)

    def s(self, path, method="GET", body=None, student="demo-ada", **kw):
        sep = "&" if "?" in path else "?"
        return self.request(f"{path}{sep}classId={self.cls}", method, body, student=student, **kw)

    def p(self, path, method="GET", body=None):
        """Preview as student (instructor key + X-Kiwi-Preview)."""
        sep = "&" if "?" in path else "?"
        return self.request(f"{path}{sep}classId={self.cls}", method, body, TEACHER_KEY, preview=True)

    def create(self, body):
        status, work = self.t("/api/teacher/assignments", "POST", body)
        self.assertEqual(status, 201, work)
        return work

    def published(self, body):
        work = self.create(body)
        status, work = self.t(f"/api/teacher/assignments/{work['id']}/publish", "POST", {})
        self.assertEqual(status, 200, work)
        return work

    def update(self, work, **changes):
        body = {k: work[k] for k in homework_input()}
        body.update(changes)
        return self.t(f"/api/teacher/assignments/{work['id']}", "PUT", {**body, "baseUpdatedAt": work["updatedAt"]})

    def check(self, work_id, question_id, answer, student="demo-ada"):
        return self.s(f"/api/work/{work_id}/check", "POST", {"questionId": question_id, "answer": answer}, student=student)


class AssignmentTests(ApiTestCase):
    def test_teacher_uploaded_assignment(self):
        data = {
            "kind": "homework",
            "title": "Uploaded QMD",
            "unitId": "r-basics",
            "instructions": "Read attachment",
            "questions": [{"id": "q1", "type": "text", "prompt": "What is a vector?", "answer": "A sequence", "points": 5}],
            "attachment": {"name": "homework.qmd", "type": "text/plain",
                           "data": base64.b64encode(b"# Homework\nQuestion one").decode()},
        }
        status, _ = self.request("/api/work?classId=css190", "POST", data)
        self.assertEqual(status, 401)
        status, work = self.request("/api/work?classId=css190", "POST", data, "test-teacher-key")
        self.assertEqual(status, 201)
        status, _ = self.request(f"/api/work/{work['id']}/attachment?classId=css190", student="s1")
        self.assertEqual(status, 404)
        self.request(f"/api/work/{work['id']}/status?classId=css190", "POST", {"status": "published"}, "test-teacher-key")
        status, attachment = self.request(f"/api/work/{work['id']}/attachment?classId=css190", student="s1")
        self.assertEqual(status, 200)
        self.assertEqual(base64.b64decode(attachment["data"]), b"# Homework\nQuestion one")

    def test_paged_authoring_and_student_detail_redaction(self):
        data = {"kind": "homework", "title": "Review paged", "unitId": "r-basics",
                "questions": [{"id": "q1", "type": "text", "prompt": "Explain.", "answer": "Teacher answer", "points": 10}]}
        for i in range(22):
            status, w = self.request("/api/work?classId=pages", "POST", {**data, "title": f"Review paged {i:02d}"}, "test-teacher-key")
            self.assertEqual(status, 201)
        self.assertEqual(self.request("/api/teacher/work-page?classId=pages")[0], 401)
        _, p1 = self.request("/api/teacher/work-page?classId=pages", key="test-teacher-key")
        _, p2 = self.request("/api/teacher/work-page?classId=pages&page=2", key="test-teacher-key")
        self.assertEqual(p1["total"], 22)
        self.assertEqual(len(p1["assignments"]), 20)
        self.assertEqual(len(p2["assignments"]), 2)
        self.assertNotIn("questions", p1["options"][0])
        self.assertEqual(self.request("/api/work/" + w["id"] + "?classId=pages", student="s1")[0], 404)
        self.request("/api/work/" + w["id"] + "/status?classId=pages", "POST", {"status": "published"}, "test-teacher-key")
        _, student = self.request("/api/work/" + w["id"] + "?classId=pages", student="s1")
        self.assertNotIn("answer", student["questions"][0])
        self.assertNotIn("explanation", student["questions"][0])
        _, options = self.request("/api/work-options?classId=pages", student="s1")
        self.assertEqual(len(options), 1)
        self.assertNotIn("questions", options[0])

    def test_revision_retains_attachment_without_mutating_original(self):
        data = {"kind": "homework", "title": "Review attachment", "unitId": "r-basics",
                "questions": [{"id": "q1", "type": "text", "prompt": "Explain.", "points": 10}],
                "attachment": {"name": "data.csv", "type": "text/csv", "data": base64.b64encode(b"x,y\n1,2").decode()}}
        _, original = self.request("/api/work?classId=revision", "POST", data, "test-teacher-key")
        copied = {k: v for k, v in data.items() if k != "attachment"}
        _, revision = self.request("/api/work?classId=revision", "POST",
                                   {**copied, "title": "Review revision", "attachmentSourceId": original["id"]}, "test-teacher-key")
        self.assertNotEqual(original["id"], revision["id"])
        _, attachment = self.request("/api/work/" + revision["id"] + "/attachment?classId=revision", key="test-teacher-key")
        self.assertEqual(attachment["data"], data["attachment"]["data"])
        _, same = self.request("/api/work/" + original["id"] + "?classId=revision", key="test-teacher-key")
        self.assertEqual(same["title"], "Review attachment")


class AuthoringTests(AssessCase):
    def test_create_round_trip_defaults_and_permissions(self):
        work = self.create(homework_input(toolPolicy=None, gradesVisibility=None))
        self.assertEqual(work["status"], "draft")
        self.assertEqual(work["state"], "draft")
        self.assertEqual(work["version"], 1)
        self.assertEqual(work["toolPolicy"], {"rWorkspace": True, "allowRunPredict": False, "askKiwi": "hints_only", "similarPractice": False})
        self.assertEqual(work["gradesVisibility"], "on_release")  # course default (§4.5.4)
        self.assertEqual(work["questions"][0]["tags"], ["vectors"])
        self.assertEqual(work["questions"][0]["graderRubric"], "Full marks for 4.")
        practice = self.create(inclass_input(toolPolicy=None))
        self.assertEqual(practice["toolPolicy"], {"rWorkspace": True, "allowRunPredict": True, "askKiwi": "explain_concepts", "similarPractice": True})
        status, detail = self.t(f"/api/teacher/assignments/{work['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(detail["questions"][0]["answer"], "4")
        self.assertFalse(detail["frozen"])
        self.assertEqual(detail["attemptCount"], 0)
        with self.db() as db:
            action = db.execute("SELECT action FROM teacher_actions WHERE target_id=? ORDER BY id", (work["id"],)).fetchone()
        self.assertEqual(action["action"], "assignment_create")
        # a TA reads but cannot write
        with self.db() as db:
            from server import auth

            key = auth.new_staff_key()
            db.execute("INSERT INTO staff (id, class_id, display_name, role, key_hash, key_prefix, created_by, created_at) "
                       "VALUES ('staff-ta0000000001', ?, 'Wang', 'ta', ?, ?, 'test', ?)",
                       (self.cls, auth.hash_staff_key(key), auth.key_prefix(key), dbmod.now()))
        self.assertEqual(self.request(f"/api/teacher/assignments?classId={self.cls}", key=key)[0], 200)
        status, body = self.request(f"/api/teacher/assignments?classId={self.cls}", "POST", homework_input(), key)
        self.assertEqual((status, body["code"]), (403, "role_required"))

    def test_validation_errors_name_the_field(self):  # ASSESS-07, ASSESS-23
        cases = [
            ({"choices": ["A", ""], "type": "choice", "answer": "A"}, "choices"),
            ({"choices": ["A", "A", "B"], "type": "choice", "answer": "A"}, "choices"),
            ({"choices": ["A", "B"], "type": "choice", "answer": "C"}, "answer"),
            ({"tags": ["a"] * 9}, "tags"),
            ({"tags": ["x" * 41]}, "tags"),
            ({"tags": ["Bad Tag!"]}, "tags"),
            ({"acceptedAnswers": ["x"] * 21}, "accepted"),
            ({"hints": ["a", "b", "c", "d"]}, "hints"),
        ]
        for patch, word in cases:
            with self.subTest(patch=patch):
                question = {**homework_input()["questions"][0], **patch}
                status, body = self.t("/api/teacher/assignments", "POST", homework_input(questions=[question]))
                self.assertEqual(status, 400, body)
                self.assertEqual(body["code"], "invalid_request")
                self.assertIn(word, body["error"].lower())
        for patch in ({"timeLimit": {"minutes": 2, "onExpiry": "reject"}},
                      {"latePolicy": {"mode": "sometimes", "untilAt": None, "graceMinutes": 0, "penaltyPctPerDay": 0}},
                      {"audience": {"type": "groups", "groupIds": ["grp-missing"]}},
                      {"toolPolicy": {"rWorkspace": True, "allowRunPredict": False, "askKiwi": "always", "similarPractice": False}},
                      {"unitId": "no-such-chapter"}):
            with self.subTest(patch=patch):
                self.assertEqual(self.t("/api/teacher/assignments", "POST", homework_input(**patch))[0], 400)
        # choices are trimmed; a time limit on an in-class exercise is refused
        question = {"id": "c1", "type": "choice", "prompt": "?", "points": 5, "choices": ["  A ", "B"], "answer": "A"}
        work = self.create(homework_input(questions=[question]))
        self.assertEqual(work["questions"][0]["choices"], ["A", "B"])
        self.assertEqual(self.t("/api/teacher/assignments", "POST",
                                inclass_input(timeLimit={"minutes": 30, "onExpiry": "reject"}))[0], 400)

    def test_tags_round_trip_and_are_never_sent_to_students(self):  # ASSESS-23
        work = self.published(homework_input())
        _, detail = self.t(f"/api/teacher/assignments/{work['id']}")
        self.assertEqual(detail["questions"][0]["tags"], ["vectors"])
        _, student = self.s(f"/api/work/{work['id']}")
        self.assertNotIn("tags", student["questions"][0])

    def test_stale_version_is_refused(self):
        work = self.create(homework_input())
        status, updated = self.update(work, title="Renamed")
        self.assertEqual(status, 200, updated)
        status, body = self.update(work, title="Stale write")
        self.assertEqual((status, body["code"]), (409, "stale_version"))

    def test_preview_check_runs_the_auto_check_without_events(self):  # AU-D1-07 "Try the auto-check"
        work = self.create(homework_input())
        status, result = self.t(f"/api/teacher/assignments/{work['id']}/preview-check", "POST",
                                {"question": {"id": "x", "type": "fill", "prompt": "?", "points": 1, "answer": "4"}, "answer": "4.0"})
        self.assertEqual(status, 200, result)
        self.assertEqual((result["correct"], result["reason"]), (True, "numeric_tolerance"))
        with self.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 0)


class FreezeAndVersionTests(AssessCase):
    def test_inclass_freezes_after_first_check(self):  # ASSESS-03 [TR07, AU-T-05, AU-D1-M01, AU-D3-27]
        work = self.published(inclass_input())
        status, result = self.check(work["id"], "p1", "4")
        self.assertEqual(status, 200, result)
        with self.db() as db:
            event = db.execute("SELECT * FROM events WHERE event_type='answer_submitted'").fetchone()
        self.assertEqual(event["assignment_version"], work["version"])
        self.assertEqual(event["checked_by"], "server")
        changed = [dict(q) for q in work["questions"]]
        changed[0]["prompt"] = "Pick four"
        status, body = self.update(work, questions=changed)
        self.assertEqual((status, body["code"]), (409, "frozen_has_attempts"))
        status, body = self.update(work, unitId="data-wrangling")
        self.assertEqual((status, body["code"]), (409, "frozen_has_attempts"))
        status, body = self.t(f"/api/teacher/assignments/{work['id']}/unpublish", "POST", {})
        self.assertEqual((status, body["code"]), (409, "has_submissions"))
        status, edited = self.update(work, title="In-class 1 (renamed)", instructions="New text")
        self.assertEqual(status, 200, edited)
        self.assertTrue(edited["frozen"])
        self.assertEqual(edited["attemptCount"], 1)
        with self.db() as db:
            actions = [r["action"] for r in db.execute("SELECT action FROM teacher_actions WHERE target_id=?", (work["id"],))]
        self.assertIn("assignment_edit", actions)

    def test_settings_edit_bumps_version_and_events_carry_it(self):  # ASSESS-20 [AU-D1-03, AU-D3-27]
        work = self.published(homework_input())
        status, work = self.update(work, dueAt=iso(timedelta(days=3)))
        self.assertEqual((status, work["version"]), (200, 2))
        self.assertEqual(self.s(f"/api/drafts/{work['id']}", "PUT",
                                {"answers": {"q1": "4"}, "clientTs": dbmod.now_ms(), "assignmentVersion": 2})[0], 200)
        policy = {**work["toolPolicy"], "askKiwi": "off"}
        status, work = self.update(work, toolPolicy=policy)
        self.assertEqual((status, work["version"]), (200, 3))
        with self.db() as db:
            row = db.execute("SELECT * FROM assignment_versions WHERE assignment_id=? AND version=3", (work["id"],)).fetchone()
            self.assertEqual(row["reason"], "settings_edit")
            self.assertEqual(json.loads(row["snapshot_json"])["toolPolicy"]["askKiwi"], "off")
            db.execute("UPDATE events SET created_at = '2000-01-01T00:00:00+00:00'")  # make the 15 s draft throttle pass
        self.assertEqual(self.s(f"/api/drafts/{work['id']}", "PUT",
                                {"answers": {"q1": "5"}, "clientTs": dbmod.now_ms(), "assignmentVersion": 3})[0], 200)
        with self.db() as db:
            versions = [r[0] for r in db.execute("SELECT assignment_version FROM events WHERE event_type='answer_draft' ORDER BY id")]
        self.assertEqual(versions, [2, 3])
        _, detail = self.t(f"/api/teacher/assignments/{work['id']}")
        self.assertEqual([v["version"] for v in detail["versions"]], [1, 2, 3])
        # a title-only edit does not create a version
        status, work = self.update(work, title="Renamed")
        self.assertEqual(work["version"], 3)

    def test_concurrent_edit_and_first_attempt_cannot_both_succeed(self):  # ASSESS-17 [AU-D1-25]
        for trial in range(4):
            work = self.published(homework_input(title=f"Race {trial}"))
            self.demo_session(self.cls, "demo-ada")
            renamed = [{**q, "id": q["id"] + "-v2"} for q in work["questions"]]
            barrier = threading.Barrier(2)
            results = {}

            def edit():
                barrier.wait()
                results["edit"] = self.update(work, questions=renamed)[0]

            def submit():
                barrier.wait()
                results["submit"] = self.s(f"/api/work/{work['id']}/submit", "POST",
                                           {"answers": {"q1": "4", "q2": "A list"}, "requestId": f"race-{trial}"})[0]

            threads = [threading.Thread(target=edit), threading.Thread(target=submit)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertFalse(results["edit"] == 200 and results["submit"] == 201, results)
            self.assertTrue(results["edit"] == 200 or results["submit"] == 201, results)


class LifecycleTests(AssessCase):
    def test_delete_archive_duplicate(self):  # ASSESS-05 [F13, AU-D1-09]
        draft = self.create(homework_input(title="Throwaway"))
        self.assertEqual(self.t(f"/api/teacher/assignments/{draft['id']}", "DELETE")[0], 204)
        self.assertEqual(self.t(f"/api/teacher/assignments/{draft['id']}")[0], 404)
        _, listing = self.t("/api/teacher/assignments")
        self.assertNotIn(draft["id"], [a["id"] for a in listing["assignments"]])
        work = self.published(homework_input(title="Kept"))
        self.assertEqual(self.s(f"/api/work/{work['id']}/submit", "POST", {"answers": {"q1": "4", "q2": "x"}, "requestId": "r1"})[0], 201)
        status, body = self.t(f"/api/teacher/assignments/{work['id']}", "DELETE")
        self.assertEqual(status, 409)
        status, archived = self.t(f"/api/teacher/assignments/{work['id']}/archive", "POST", {})
        self.assertEqual((status, archived["state"]), (200, "archived"))
        self.assertEqual(self.s(f"/api/work/{work['id']}")[0], 404)
        _, options = self.s("/api/work-options")
        self.assertNotIn(work["id"], [o["id"] for o in options])
        _, listing = self.t("/api/teacher/assignments")
        self.assertNotIn(work["id"], [a["id"] for a in listing["assignments"]])
        _, listing = self.t("/api/teacher/assignments?status=archived")
        self.assertEqual([a["id"] for a in listing["assignments"]], [work["id"]])
        self.assertEqual(self.t(f"/api/teacher/assignments/{work['id']}/unarchive", "POST", {})[1]["state"], "open")
        status, copy = self.t(f"/api/teacher/assignments/{work['id']}/duplicate", "POST", {"shiftDays": 7})
        self.assertEqual(status, 201, copy)
        self.assertEqual(copy["status"], "draft")
        self.assertTrue(set(q["id"] for q in copy["questions"]).isdisjoint(q["id"] for q in work["questions"]))
        self.assertIsNone(copy["revisionOf"])
        with self.db() as db:
            actions = {r["action"] for r in db.execute("SELECT action FROM teacher_actions WHERE class_id=?", (self.cls,))}
        self.assertTrue({"assignment_delete", "assignment_archive", "assignment_unarchive", "assignment_duplicate"} <= actions)

    def test_revision_retires_original_on_publish(self):  # ASSESS-04 [AU-D1-08, TH15]
        original = self.published(homework_input(title="HW 1"))
        status, sub = self.s(f"/api/work/{original['id']}/submit", "POST", {"answers": {"q1": "4", "q2": "x"}, "requestId": "r1"})
        self.assertEqual(status, 201)
        with self.db() as db:
            db.execute("UPDATE submissions SET grade=17, grade_status='released' WHERE id=?", (sub["id"],))
        status, revision = self.t(f"/api/teacher/assignments/{original['id']}/duplicate", "POST",
                                  {"asRevision": True, "retireOriginalOnPublish": True})
        self.assertEqual(status, 201, revision)
        self.assertEqual(revision["revisionOf"], original["id"])
        self.assertTrue(revision["retireOriginalOnPublish"])
        with self.db() as db:
            mapping = json.loads(db.execute("SELECT question_id_map_json FROM assignments WHERE id=?", (revision["id"],)).fetchone()[0])
        self.assertEqual(sorted(mapping.values()), ["q1", "q2"])
        status, published = self.t(f"/api/teacher/assignments/{revision['id']}/publish", "POST", {})
        self.assertEqual(status, 200)
        _, old = self.t(f"/api/teacher/assignments/{original['id']}")
        self.assertIsNotNone(old["closeAt"])
        self.assertEqual(old["state"], "closed")
        _, options = self.s("/api/work-options")
        states = {o["id"]: o["state"] for o in options}
        self.assertEqual(states[revision["id"]], "open")
        self.assertEqual(states[original["id"]], "closed")
        with self.db() as db:
            self.assertEqual(db.execute("SELECT grade FROM submissions WHERE id=?", (sub["id"],)).fetchone()[0], 17)
        status, body = self.s(f"/api/work/{original['id']}/submit", "POST", {"answers": {"q1": "4", "q2": "x"}, "requestId": "r2"})
        self.assertEqual((status, body["code"]), (409, "assignment_closed"))

    def test_close_reopen_and_unpublish_without_attempts(self):
        work = self.published(homework_input())
        status, closed = self.t(f"/api/teacher/assignments/{work['id']}/close", "POST", {})
        self.assertEqual((status, closed["state"]), (200, "closed"))
        self.assertEqual(self.t(f"/api/teacher/assignments/{work['id']}/reopen", "POST", {})[1]["state"], "open")
        status, draft = self.t(f"/api/teacher/assignments/{work['id']}/unpublish", "POST", {})
        self.assertEqual((status, draft["status"]), (200, "draft"))

    def test_scheduled_publish_hides_until_open(self):  # ASSESS-02 (open_at)
        work = self.create(homework_input())
        status, published = self.t(f"/api/teacher/assignments/{work['id']}/publish", "POST", {"openAt": iso(timedelta(days=2))})
        self.assertEqual((status, published["state"]), (200, "scheduled"))
        _, options = self.s("/api/work-options")
        self.assertEqual(options, [])
        self.assertEqual(self.s(f"/api/work/{work['id']}")[0], 404)


class InClassCheckTests(AssessCase):
    def test_explanation_hints_attempt_limit_and_reveal(self):  # ASSESS-08, F16
        work = self.published(inclass_input())
        status, wrong = self.check(work["id"], "p1", "2")
        self.assertEqual(status, 200, wrong)
        self.assertEqual((wrong["correct"], wrong["attemptIndex"], wrong["attemptsLeft"]), (False, 1, 2))
        self.assertEqual(wrong["nextHint"], "Add them up.")
        self.assertNotIn("explanation", wrong)
        _, wrong2 = self.check(work["id"], "p1", "6")
        self.assertEqual(wrong2["nextHint"], "Divide by 3.")
        _, wrong3 = self.check(work["id"], "p1", "2")
        self.assertEqual((wrong3["attemptsLeft"], wrong3["revealedAnswer"]), (0, "4"))
        status, body = self.check(work["id"], "p1", "4")
        self.assertEqual((status, body["code"]), (409, "max_attempts_reached"))
        status, right = self.check(work["id"], "p1", "4", student="demo-bo")
        self.assertEqual((right["correct"], right["explanation"]), (True, "The mean of 2, 4, 6 is 4."))
        self.assertNotIn("graderRubric", json.dumps(right))

    def test_written_response_is_recorded_not_judged(self):  # ASSESS-09 [AU-D3-M05]
        work = self.published(inclass_input())
        status, result = self.check(work["id"], "p2", "Because the mean balances values.")
        self.assertEqual(status, 200, result)
        self.assertEqual((result["correct"], result["status"]), (None, "recorded"))
        with self.db() as db:
            event = db.execute("SELECT checked_by, payload_json FROM events WHERE question_id='p2'").fetchone()
        self.assertEqual(event["checked_by"], "")
        self.assertIsNone(json.loads(event["payload_json"])["correct"])

    def test_legacy_homework_explanation_is_the_rubric(self):  # ASSESS-08
        with self.db() as db:
            rec = testsupport.publish_work(db, self.cls, questions=[
                {"id": "q1", "type": "text", "prompt": "Explain.", "points": 10, "answer": "Ref", "explanation": "Rubric text"}])
        _, detail = self.t(f"/api/teacher/assignments/{rec.id}")
        self.assertEqual(detail["questions"][0]["graderRubric"], "Rubric text")
        _, student = self.s(f"/api/work/{rec.id}")
        self.assertNotIn("Rubric text", json.dumps(student))


class RedactionSweepTests(AssessCase):
    def test_no_staff_field_reaches_any_student_endpoint(self):  # KEEP §19.2, ASSESS-08/23
        homework = self.published(homework_input(solutionsVisibility="after_submit"))
        practice = self.published(inclass_input())
        responses = []
        for path, method, body in [
            ("/api/work", "GET", None), ("/api/work-options", "GET", None),
            (f"/api/work/{homework['id']}", "GET", None), (f"/api/work/{practice['id']}", "GET", None),
            (f"/api/work/{practice['id']}/check", "POST", {"questionId": "p1", "answer": "4"}),
            (f"/api/work/{homework['id']}/submit", "POST", {"answers": {"q1": "4", "q2": "x"}, "requestId": "sweep"}),
            (f"/api/work/{homework['id']}", "GET", None), ("/api/submissions", "GET", None),
            (f"/api/drafts/{homework['id']}", "GET", None),
        ]:
            status, data = self.s(path, method, body)
            self.assertLess(status, 300, (path, data))
            responses.append(data)

        def walk(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    self.assertNotIn(key, STAFF_ONLY_KEYS, value)
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)

        for data in responses:
            walk(data)
            self.assertNotIn("Full marks for 4.", json.dumps(data))
        # after_submit: the student explanation is visible once the student has submitted
        self.assertNotIn("studentExplanation", json.dumps(responses[2]))


class PreviewTests(AssessCase):
    def test_preview_sees_and_submits_drafts_and_stays_out_of_counts(self):  # ASSESS-18 + gate leftover [F09, AU-D1-21]
        draft = self.create(homework_input(title="Preview me"))
        _, listing = self.p("/api/work-options")
        option = next(o for o in listing if o["id"] == draft["id"])
        self.assertTrue(option["isPreviewDraft"])
        _, legacy = self.p("/api/work")
        self.assertIn(draft["id"], [w["id"] for w in legacy])
        self.assertEqual(self.p(f"/api/work/{draft['id']}")[0], 200)
        status, sub = self.p(f"/api/work/{draft['id']}/submit", "POST", {"answers": {"q1": "4", "q2": "x"}, "requestId": "pv1"})
        self.assertEqual(status, 201, sub)
        _, mine = self.p(f"/api/submissions?assignmentId={draft['id']}")
        self.assertEqual([s["id"] for s in mine], [sub["id"]])
        with self.db() as db:
            row = db.execute("SELECT * FROM submissions WHERE id=?", (sub["id"],)).fetchone()
            self.assertEqual((row["is_preview"], row["actor_role"], row["student_id"]), (1, "preview", "preview-instructor"))
            from server import readers

            self.assertEqual(readers.grading_counts(db, self.cls, draft["id"])["all"], 0)
            self.assertIsNone(db.execute("SELECT frozen_at FROM assignments WHERE id=?", (draft["id"],)).fetchone()[0])
        _, listing = self.t("/api/teacher/assignments")
        row = next(a for a in listing["assignments"] if a["id"] == draft["id"])
        self.assertEqual((row["stats"]["submitted"], row["hasAttempts"]), (0, False))
        # the real student cannot see the draft
        self.assertEqual(self.s(f"/api/work/{draft['id']}")[0], 404)

    def test_editing_a_previewed_draft_discards_preview_rows(self):  # ASSESS-19
        draft = self.create(homework_input())
        self.assertEqual(self.p(f"/api/drafts/{draft['id']}", "PUT", {"answers": {"q1": "4"}, "clientTs": dbmod.now_ms(),
                                                                        "assignmentVersion": 1})[0], 200)
        self.assertEqual(self.p(f"/api/work/{draft['id']}/submit", "POST", {"answers": {"q1": "4", "q2": "x"}, "requestId": "pv"})[0], 201)
        changed = [{**q, "prompt": q["prompt"] + " (edited)"} for q in draft["questions"]]
        status, edited = self.update(draft, questions=changed)
        self.assertEqual(status, 200, edited)
        self.assertEqual(edited["attemptCount"], 0)
        with self.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM submissions WHERE assignment_id=?", (draft["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM answer_drafts WHERE assignment_id=?", (draft["id"],)).fetchone()[0], 0)

    def test_preview_checks_never_freeze_and_clear_preview_counts(self):  # ASSESS-19
        practice = self.published(inclass_input())
        self.assertEqual(self.p(f"/api/work/{practice['id']}/check", "POST", {"questionId": "p1", "answer": "4"})[0], 200)
        _, detail = self.t(f"/api/teacher/assignments/{practice['id']}")
        self.assertEqual((detail["frozen"], detail["attemptCount"]), (False, 0))
        status, result = self.t(f"/api/teacher/assignments/{practice['id']}/clear-preview", "POST", {})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["counts"]["events"], 1)
        with self.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE is_preview=1").fetchone()[0], 0)
            action = db.execute("SELECT action FROM teacher_actions WHERE action='assignment_clear_preview'").fetchone()
        self.assertIsNotNone(action)
        draft = self.create(homework_input())
        self.assertEqual(self.p(f"/api/work/{draft['id']}/submit", "POST", {"answers": {"q1": "4", "q2": "x"}, "requestId": "pv"})[0], 201)
        self.assertEqual(self.t(f"/api/teacher/assignments/{draft['id']}", "DELETE")[0], 204)


class AudienceTests(AssessCase):
    def test_group_and_cohort_audiences(self):  # ASSESS-16 [AU-D1-10, AU-D4-09]
        with self.db() as db:
            group_a = testsupport.make_group(db, self.cls, "section", "Section A", ["demo-ada"])
            testsupport.make_group(db, self.cls, "section", "Section B", ["demo-bo"])
            cohort = testsupport.make_group(db, self.cls, "cohort", "Needs help", ["demo-bo"])
        work = self.published(homework_input(audience={"type": "groups", "groupIds": [group_a]}))
        self.assertIn(work["id"], [o["id"] for o in self.s("/api/work-options")[1]])
        self.assertNotIn(work["id"], [o["id"] for o in self.s("/api/work-options", student="demo-bo")[1]])
        self.assertEqual(self.s(f"/api/work/{work['id']}", student="demo-bo")[0], 404)
        status, _ = self.s(f"/api/work/{work['id']}/submit", "POST", {"answers": {"q1": "4", "q2": "x"}, "requestId": "a"},
                           student="demo-bo")
        self.assertEqual(status, 404)
        cohort_work = self.published(homework_input(title="For the cohort", audience={"type": "groups", "groupIds": [cohort]}))
        self.assertIn(cohort_work["id"], [o["id"] for o in self.s("/api/work-options", student="demo-bo")[1]])
        self.assertNotIn(cohort_work["id"], [o["id"] for o in self.s("/api/work-options")[1]])


class ListAndStatusTests(AssessCase):
    def _three_students(self, due_at):
        work = self.published(homework_input(dueAt=due_at, questions=[
            {"id": "a", "type": "fill", "prompt": "1?", "points": 5, "answer": "1"},
            {"id": "b", "type": "fill", "prompt": "2?", "points": 5, "answer": "2"},
            {"id": "c", "type": "fill", "prompt": "3?", "points": 5, "answer": "3"}]))
        for student in ("s-a", "s-b", "s-c"):
            self.demo_session(self.cls, student)
        with self.db() as db:
            for student, name in (("s-a", "Ann"), ("s-b", "Ben"), ("s-c", "Cy")):
                testsupport.add_roster(db, self.cls, student, display_name=name)
        self.assertEqual(self.s(f"/api/work/{work['id']}/submit", "POST", {"answers": {"a": "1", "b": "2", "c": "3"}, "requestId": "r"},
                                student="s-a")[0], 201)
        with self.db() as db:
            testsupport.make_draft(db, self.cls, "s-b", work["id"], {"a": "1", "b": "2"})
        return work

    def test_missing_and_started_lists(self):  # ASSESS-13 [DA01, DA07]
        work = self._three_students(None)
        with self.db() as db:
            db.execute("UPDATE assignments SET due_at=? WHERE id=?", (iso(timedelta(days=-1)), work["id"]))
        status, missing = self.t(f"/api/teacher/assignments/{work['id']}/students?state=missing")
        self.assertEqual(status, 200, missing)
        rows = {r["studentId"]: r for r in missing["students"]}
        self.assertEqual(set(rows), {"s-b", "s-c"})
        self.assertEqual((rows["s-b"]["draftAnswered"], rows["s-b"]["draftTotal"]), (2, 3))
        self.assertEqual(rows["s-b"]["studentName"], "Ben")
        _, started = self.t(f"/api/teacher/assignments/{work['id']}/students?state=started")
        self.assertEqual([r["studentId"] for r in started["students"]], ["s-b"])
        _, submitted = self.t(f"/api/teacher/assignments/{work['id']}/students?state=submitted")
        self.assertEqual([r["studentId"] for r in submitted["students"]], ["s-a"])
        with self.db() as db:
            db.execute("UPDATE assignments SET due_at=? WHERE id=?", (iso(timedelta(days=1)), work["id"]))
        _, missing = self.t(f"/api/teacher/assignments/{work['id']}/students?state=missing")
        self.assertEqual(missing["students"], [])
        _, started = self.t(f"/api/teacher/assignments/{work['id']}/students?state=started")
        self.assertEqual([r["studentId"] for r in started["students"]], ["s-b"])
        _, pseudo = self.request(f"/api/teacher/assignments/{work['id']}/students?state=started&classId={self.cls}", key=TEACHER_KEY,
                                 name_mode="pseudonyms")
        self.assertTrue(pseudo["students"][0]["studentName"].startswith("S-"))
        self.assertIsNone(pseudo["emails"])

    def test_list_rows_carry_stats(self):  # ASSESS-13, DA01
        work = self._three_students(None)
        with self.db() as db:
            db.execute("UPDATE assignments SET due_at=? WHERE id=?", (iso(timedelta(days=-1)), work["id"]))
        practice = self.published(inclass_input())
        self.check(practice["id"], "p1", "4", student="s-a")
        self.check(practice["id"], "p1", "2", student="s-b")
        _, listing = self.t("/api/teacher/assignments")
        rows = {a["id"]: a for a in listing["assignments"]}
        stats = rows[work["id"]]["stats"]
        self.assertEqual((stats["enrolled"], stats["submitted"], stats["startedNotSubmitted"], stats["toGrade"], stats["missing"]),
                         (3, 1, 1, 1, 2))
        self.assertEqual(stats["late"], 0)
        self.assertEqual(rows[work["id"]]["questionCount"], 3)
        pstats = rows[practice["id"]]["stats"]
        self.assertEqual((pstats["attempted"], pstats["firstTryCorrectPct"]), (2, 50))
        _, drafts = self.t("/api/teacher/assignments?status=draft")
        self.assertEqual(drafts["assignments"], [])
        _, search = self.t("/api/teacher/assignments?search=in-class")
        self.assertEqual([a["id"] for a in search["assignments"]], [practice["id"]])


class AnswerProtectionDefaultTests(AssessCase):
    """Decision D2: new homework shows solutions after the due date, and protection lasts while students can submit."""

    def test_new_homework_defaults_to_after_due_and_never_stays_explicit(self):
        work = self.create(homework_input(solutionsVisibility=None))
        self.assertEqual(work["solutionsVisibility"], "after_due")
        legacy = self.t("/api/work", "POST", {"kind": "homework", "title": "Legacy", "unitId": "r-basics",
                                               "questions": [{"id": "q1", "type": "text", "prompt": "?", "points": 5}]})[1]
        _, detail = self.t(f"/api/teacher/assignments/{legacy['id']}")
        self.assertEqual(detail["solutionsVisibility"], "after_due")
        explicit = self.create(homework_input(solutionsVisibility="never"))
        self.assertEqual(explicit["solutionsVisibility"], "never")
        status, updated = self.update(explicit, title="Reused quiz", solutionsVisibility=None)
        self.assertEqual((status, updated["solutionsVisibility"]), (200, "never"), updated)
        practice = self.create(inclass_input(solutionsVisibility=None))
        self.assertEqual(practice["solutionsVisibility"], "never")
        with self.db() as db:
            db.execute("UPDATE assignments SET solutions_visibility='never' WHERE id=?", (work["id"],))
        _, listing = self.t("/api/teacher/assignments")
        rows = {a["id"]: a for a in listing["assignments"]}
        self.assertEqual(rows[work["id"]]["solutionsVisibility"], "never")
        self.assertEqual(rows[explicit["id"]]["solutionsVisibility"], "never")
        self.assertIn("openAt", rows[work["id"]])

    def test_after_due_protects_through_the_late_window_and_ends_at_close(self):
        from server import readers

        due, late_end = "2026-10-24T15:59:00+00:00", "2026-10-26T15:59:00+00:00"
        before, in_late, after = "2026-10-24T00:00:00+00:00", "2026-10-25T00:00:00+00:00", "2026-10-27T00:00:00+00:00"
        with self.db() as db:
            def state(**kw):
                rec = testsupport.publish_work(db, self.cls, due_at=due, **kw)
                return [(readers.answer_protected(db, rec, "s1", now), readers.solutions_visible(db, rec, "s1", now))
                        for now in (before, in_late, after)]

            # (protected, solutions visible) before the due date, inside the late window, after it
            self.assertEqual(state(solutions_visibility="after_due", late_policy={"mode": "accept_until", "untilAt": late_end}),
                             [(True, False), (True, False), (False, True)])
            self.assertEqual(state(solutions_visibility="after_due", late_policy={"mode": "not_accepted"}),
                             [(True, False), (False, True), (False, True)])
            # accepted late with no end date: there is no closing date, so answers stay protected
            self.assertEqual(state(solutions_visibility="after_due", late_policy={"mode": "accept_marked"}),
                             [(True, False), (True, False), (True, False)])
            self.assertEqual(state(solutions_visibility="after_due", late_policy={"mode": "accept_marked"}, close_at=late_end),
                             [(True, False), (True, False), (False, True)])
            # Never: protected until archived, even when closed
            self.assertEqual(state(solutions_visibility="never", late_policy={"mode": "not_accepted"}),
                             [(True, False), (True, False), (True, False)])


class StarterTests(AssessCase):
    cls = "starter"

    def test_starter_mapping_skip_and_dedupe(self):  # ASSESS-14 [AU-D1-15, NM44]
        units = [u for u in testsupport.course_config.DEFAULT_COURSE["units"] if u["id"] != "text-analysis"]
        self.create_course(self.cls, units=[dict(u) for u in units], current_unit_id="r-basics")
        status, starters = self.t("/api/teacher/starter-assignments")
        self.assertEqual(status, 200)
        text = next(s for s in starters if s["sampleUnitId"] == "text-analysis")
        self.assertIsNone(text["mappedUnitId"])
        status, result = self.t("/api/teacher/starter-assignments", "POST", {})
        self.assertEqual(status, 201, result)
        self.assertEqual(result["created"], len(starters) - 1)
        self.assertEqual([s["key"] for s in result["skipped"]], [text["key"]])
        with self.db() as db:
            units_used = {r[0] for r in db.execute("SELECT unit_id FROM assignments WHERE class_id=?", (self.cls,))}
        self.assertNotIn("text-analysis", units_used)
        status, again = self.t("/api/teacher/starter-assignments", "POST", {"unitMap": {"text-analysis": "r-basics"}})
        self.assertEqual((status, again["created"]), (201, 1))
        _, third = self.t("/api/teacher/starter-assignments", "POST", {})
        self.assertEqual(third["created"], 0)
        self.assertTrue(all(s["alreadyAdded"] for s in self.t("/api/teacher/starter-assignments")[1]))


class FileTests(AssessCase):
    def upload(self, **body):
        data = {"scope": "assignment", "name": "data.csv", "type": "text/csv", "data": base64.b64encode(b"x\n1").decode(), **body}
        return self.t("/api/teacher/files", "POST", data)

    def test_attachments_upload_remove_and_student_download(self):  # ASSESS-15 [AU-D1-24]
        work = self.published(homework_input())
        status, first = self.upload(assignmentId=work["id"])
        self.assertEqual(status, 201, first)
        self.assertTrue(first["mountInR"])
        status, second = self.upload(assignmentId=work["id"], questionId="q1", name="notes.md", type="text/markdown", mountInR=False)
        self.assertEqual(status, 201, second)
        self.assertEqual(second["questionId"], "q1")
        _, files = self.t(f"/api/teacher/files?assignmentId={work['id']}")
        self.assertEqual({f["id"] for f in files}, {first["id"], second["id"]})
        _, student = self.s(f"/api/work/{work['id']}")
        self.assertEqual({f["name"] for f in student["files"]}, {"data.csv", "notes.md"})
        status, download = self.s(f"/api/work/{work['id']}/files/{first['id']}")
        self.assertEqual((status, base64.b64decode(download["data"])), (200, b"x\n1"))
        self.assertEqual(self.s(f"/api/files/{first['id']}")[0], 200)
        self.assertEqual(self.t(f"/api/teacher/files/{second['id']}", "DELETE")[0], 204)
        _, files = self.t(f"/api/teacher/files?assignmentId={work['id']}")
        self.assertEqual([f["id"] for f in files], [first["id"]])
        self.assertEqual(self.s(f"/api/files/{second['id']}")[0], 404)
        self.assertEqual(self.upload(assignmentId=work["id"], name="evil.exe")[0], 400)
        self.assertEqual(self.upload(assignmentId=work["id"], questionId="nope")[0], 400)
        draft = self.create(homework_input(title="Hidden"))
        _, hidden = self.upload(assignmentId=draft["id"])
        self.assertEqual(self.s(f"/api/files/{hidden['id']}")[0], 404)

    def test_ai_reference_only_for_chapter_text_files(self):  # ASSESS-25 [AU-D1-17]
        status, md = self.upload(scope="chapter", unitId="r-basics", name="notes.md", type="text/markdown", aiReference=True)
        self.assertEqual(status, 201, md)
        self.assertTrue(md["aiReference"])
        with self.db() as db:
            self.assertEqual(db.execute("SELECT ai_reference FROM course_files WHERE id=?", (md["id"],)).fetchone()[0], 1)
        status, body = self.upload(scope="chapter", unitId="r-basics", name="slides.pdf", type="application/pdf", aiReference=True)
        self.assertEqual(status, 400)
        self.assertIn("aiReference", body["error"])
        work = self.create(homework_input())
        status, body = self.upload(assignmentId=work["id"], name="notes.md", aiReference=True)
        self.assertEqual(status, 400)
        self.assertIn("aiReference", body["error"])
        status, toggled = self.t(f"/api/teacher/files/{md['id']}", "PATCH", {"aiReference": False})
        self.assertEqual((status, toggled["aiReference"]), (200, False))
        _, chapter = self.t("/api/teacher/files?unitId=r-basics")
        self.assertEqual([f["id"] for f in chapter], [md["id"]])
        self.assertEqual(self.s(f"/api/files/{md['id']}")[0], 200)

    def test_legacy_attachment_is_a_virtual_file(self):
        legacy = {"kind": "homework", "title": "Legacy", "unitId": "r-basics",
                  "questions": [{"id": "q1", "type": "text", "prompt": "?", "points": 5}],
                  "attachment": {"name": "hw.qmd", "type": "text/plain", "data": base64.b64encode(b"# hi").decode()}}
        _, work = self.t("/api/work", "POST", legacy)
        _, detail = self.t(f"/api/teacher/assignments/{work['id']}")
        self.assertEqual(detail["files"][0]["id"], f"legacy-{work['id']}")
        self.assertEqual(detail["attachmentName"], "hw.qmd")
        self.t(f"/api/teacher/assignments/{work['id']}/publish", "POST", {})
        status, download = self.s(f"/api/work/{work['id']}/files/legacy-{work['id']}")
        self.assertEqual((status, base64.b64decode(download["data"])), (200, b"# hi"))


if __name__ == "__main__":
    unittest.main()
