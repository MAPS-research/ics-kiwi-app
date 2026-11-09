"""Insights queries (explorer, metrics, evidence) — owned by INSIGHTS.

The ``InsightsTests`` cases were moved from server/test_app.py by FOUNDATION (spec §16.1 item 6), unchanged in intent;
the edits are auth plumbing (demo sessions via ``student=``, registering standalone courses) and, in the first case,
answer attempts written by the server (v0.6: ``answer_submitted`` is server-owned, client copies are client-reported).
The v0.6 acceptance tests (INSIGHTS-01…25) follow in ``InsightsV06Tests``.
"""

import os
import unittest
from unittest.mock import patch

from server import app, telemetry, testsupport
from server.testsupport import ApiTestCase


# INTEGRATION-05: these moved v0.5.1 tests post v0.5.1 client copies of server-owned events (`ai_question`) to build
# legacy-shaped data; such rows were written before the `enforce` cut-over, so the fixtures opt into `accept`.
LEGACY_CLIENT_ROWS = patch.dict(os.environ, {"KIWI_SERVER_OWNED_EVENTS": "accept"})


class InsightsTests(ApiTestCase):
    @LEGACY_CLIENT_ROWS
    def test_indexed_sessions_metrics_and_evidence(self):
        self.register_class("analytics")  # standalone student writes need a registered course
        self.register_class("other")  # standalone student writes need a registered course
        with self.db() as db:  # v0.6 names come from the roster, not from event payloads [AU-D4-10]
            testsupport.add_roster(db, "analytics", "s1", display_name="Ada")
            testsupport.add_roster(db, "analytics", "s2", display_name="Bo")
        event = {
            "classId": "analytics",
            "studentId": "s1",
            "studentName": "Ada",
            "sessionId": "browser-1",
            "questionId": "q1",
        }
        for kind, payload in [
            ("question_viewed", {}),
            ("answer_submitted", {"answer": "A", "correct": False}),
            ("code_run", {"code": "print(2)", "ok": False, "error": "example"}),
            ("answer_submitted", {"answer": "B", "correct": True}),
            (
                "ai_question",
                {
                    "prompt": "Why is the mean NA?",
                    "response": "Inspect missing values.",
                    "ok": True,
                },
            ),
        ]:
            if kind == "answer_submitted":  # server-owned since v0.6 (§11.3): written the way the server writes it
                with self.db() as db:
                    ident = testsupport.student_identity(db, "analytics", "s1")
                    telemetry.add_event(db, ident, {**event, "type": kind, "payload": {"unitId": "r-basics", **payload},
                                                    "schemaVersion": 2}, server=True)
                continue
            self.request(
                "/api/events",
                "POST",
                {**event, "type": kind, "payload": {"unitId": "r-basics", **payload}}, student="s1")
        self.request(
            "/api/events",
            "POST",
            {**event, "type": "study_heartbeat", "payload": {"seconds": 30}}, student="s1")
        self.request(
            "/api/events",
            "POST",
            {
                **event,
                "studentId": "s2",
                "studentName": "Bo",
                "type": "ai_question",
                "payload": {
                    "unitId": "r-basics",
                    "prompt": "Why is the mean NA?",
                    "response": "Check is.na().",
                    "ok": True,
                },
            }, student="s2")
        self.request(
            "/api/events",
            "POST",
            {
                **event,
                "classId": "other",
                "type": "answer_submitted",
                "payload": {"correct": True},
            }, student="s1")
        self.assertEqual(
            self.request("/api/teacher/analytics/metrics?classId=analytics")[0], 401
        )
        _, metrics = self.request(
            "/api/teacher/analytics/metrics?classId=analytics", key="test-teacher-key"
        )
        self.assertEqual(metrics["interactions"], 6)
        self.assertEqual(metrics["attempts"], 2)
        self.assertEqual(metrics["averageAttempts"], 1)
        self.assertEqual(metrics["averageInteractions"], 3)
        self.assertEqual(metrics["sessions"], 2)
        for group in ("students", "questions", "topics", "sessions", "assignments"):
            status, table = self.request(
                f"/api/teacher/analytics/table?classId=analytics&group={group}",
                key="test-teacher-key",
            )
            self.assertEqual(status, 200, table)
        _, table = self.request(
            "/api/teacher/analytics/table?classId=analytics&group=sessions&studentId=s1",
            key="test-teacher-key",
        )
        self.assertEqual(table["total"], 1)
        row = table["rows"][0]
        self.assertEqual(row["attempts"], 2)
        self.assertEqual(row["accuracy"], 50)
        _, detail = self.request(
            "/api/teacher/analytics/session?classId=analytics&sessionId=" + row["id"],
            key="test-teacher-key",
        )
        self.assertEqual(len(detail["events"]), 5)
        _, evidence = self.request(
            "/api/teacher/analytics/evidence?classId=analytics&questionId=q1",
            key="test-teacher-key",
        )
        self.assertEqual(len(evidence["distribution"]), 2)
        self.assertEqual(evidence["commonQuestions"][0]["students"], 2)
        self.assertEqual(len(evidence["questions"]), 2)
        _, search = self.request(
            "/api/teacher/analytics/table?classId=analytics&search=ada",
            key="test-teacher-key",
        )
        self.assertEqual(search["total"], 1)
        _, errors = self.request(
            "/api/teacher/analytics/table?classId=analytics&group=sessions&activity=errors",
            key="test-teacher-key",
        )
        self.assertEqual(errors["total"], 1)
        self.assertEqual(
            self.request(
                "/api/teacher/analytics/table?classId=analytics&sort=payload_json",
                key="test-teacher-key",
            )[0],
            400,
        )
        self.assertEqual(
            self.request(
                "/api/teacher/analytics/session?classId=other&sessionId=" + row["id"],
                key="test-teacher-key",
            )[0],
            400,
        )

    def test_metrics_cover_more_than_recent_history_and_page_bounds(self):
        with app.connection() as db:
            # Indexed rollups: 125 independent sessions, far beyond the old 100-event window.
            rows = [
                (
                    f"learn-{i}",
                    "scale",
                    f"s{i}",
                    f"Student {i}",
                    "b",
                    "q",
                    "r-basics",
                    "",
                    "q1",
                    "question",
                    "Question",
                    "2026-10-15T00:00:00+00:00",
                    "2026-10-15T00:00:00+00:00",
                    i + 1,
                    2,
                    1,
                    1,
                    3,
                    1,
                    1,
                )
                for i in range(125)
            ]
            db.executemany(
                "INSERT INTO learning_sessions (id,classId,studentId,studentName,browserSession,contextKey,unitId,assignmentId,questionId,kind,title,startedAt,lastActive,interactions,attempts,checked,correct,codeRuns,codeErrors,aiQuestions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                rows,
            )
        _, m = self.request(
            "/api/teacher/analytics/metrics?classId=scale", key="test-teacher-key"
        )
        self.assertEqual(m["engagedStudents"], 125)
        self.assertEqual(m["attempts"], 250)
        _, p1 = self.request(
            "/api/teacher/analytics/table?classId=scale&group=students&sort=interactions&pageSize=1000",
            key="test-teacher-key",
        )
        self.assertEqual(p1["total"], 125)
        self.assertEqual(p1["pageSize"], 100)
        self.assertEqual(p1["rows"][0]["interactions"], 125)
        _, p2 = self.request(
            "/api/teacher/analytics/table?classId=scale&group=students&sort=interactions&pageSize=1000&page=2",
            key="test-teacher-key",
        )
        self.assertEqual(len(p2["rows"]), 25)
        self.assertFalse(
            {r["studentId"] for r in p1["rows"]} & {r["studentId"] for r in p2["rows"]}
        )

    def test_published_assignment_drilldown_includes_unattempted_work(self):
        data = {
            "kind": "homework",
            "title": "Review unattempted",
            "unitId": "r-basics",
            "questions": [
                {
                    "id": "q1",
                    "type": "text",
                    "prompt": "Explain a vector.",
                    "points": 10,
                }
            ],
        }
        _, w = self.request("/api/work?classId=empty", "POST", data, "test-teacher-key")
        self.request(
            "/api/work/" + w["id"] + "/status?classId=empty",
            "POST",
            {"status": "published"},
            "test-teacher-key",
        )
        _, m = self.request(
            "/api/teacher/analytics/metrics?classId=empty", key="test-teacher-key"
        )
        _, table = self.request(
            "/api/teacher/analytics/table?classId=empty&group=assignments&published=homework",
            key="test-teacher-key",
        )
        self.assertEqual(m["publishedAssignments"], 1)
        self.assertEqual(table["total"], 1)
        self.assertEqual(table["rows"][0]["attempts"], 0)

    @LEGACY_CLIENT_ROWS
    def test_choice_distribution_has_zero_options_and_common_topic_evidence(self):
        data = {
            "kind": "practice",
            "title": "Review choices",
            "unitId": "r-basics",
            "questions": [
                {
                    "id": "q1",
                    "type": "choice",
                    "prompt": "Choose the mean.",
                    "choices": ["2", "4", "6", "12"],
                    "answer": "4",
                    "points": 10,
                }
            ],
        }
        _, w = self.request(
            "/api/work?classId=choices", "POST", data, "test-teacher-key"
        )
        self.request(
            "/api/work/" + w["id"] + "/status?classId=choices",
            "POST",
            {"status": "published"},
            "test-teacher-key",
        )
        event = {
            "classId": "choices",
            "studentId": "s1",
            "studentName": "Ada",
            "sessionId": "b",
            "questionId": "q1",
        }
        self.request(
            "/api/events",
            "POST",
            {
                **event,
                "type": "answer_submitted",
                "payload": {"assignmentId": w["id"], "answer": "4", "correct": True},
            }, student="s1")
        for sid, prompt in [
            ("s1", "Why is this mean NA?"),
            ("s2", "How should missing values be handled?"),
        ]:
            self.request(
                "/api/events",
                "POST",
                {
                    **event,
                    "studentId": sid,
                    "type": "ai_question",
                    "payload": {"assignmentId": w["id"], "prompt": prompt, "ok": True},
                }, student=sid)
        _, e = self.request(
            "/api/teacher/analytics/evidence?classId=choices&assignmentId="
            + w["id"]
            + "&questionId=q1",
            key="test-teacher-key",
        )
        self.assertEqual(len(e["distribution"]), 4)
        self.assertEqual(sum(d["share"] for d in e["distribution"]), 100)
        self.assertEqual(e["sharedTopics"][0]["theme"], "Missing values")
        self.assertEqual(e["sharedTopics"][0]["students"], 2)



# ─── v0.6 fixtures (rows written the way the owning writers write them) ─────────────────────────

from urllib.parse import quote, urlencode  # noqa: E402

from server import readers  # noqa: E402

KEY = testsupport.TEACHER_KEY
NOW = "2026-10-22T01:00:00+00:00"  # Thu 2026-10-22 09:00 Asia/Shanghai
TWO_QUESTIONS = [
    {"id": "q1", "type": "complete", "prompt": "Write code that prints the mean of x.", "points": 10, "choices": [],
     "starterCode": "", "answer": "mean(x)", "explanation": ""},
    {"id": "q2", "type": "text", "prompt": "Explain what NA means.", "points": 10, "choices": [], "starterCode": "",
     "answer": "Missing value", "explanation": ""},
]


def client_event(db, cls, sid, kind, payload, *, question_id=None, at=None, surface="", session="b1"):
    """A client event through ``telemetry.add_event`` (TELEMETRY's writer)."""
    ident = testsupport.student_identity(db, cls, sid)
    with testsupport._clock_at(at):
        return telemetry.add_event(db, ident, {"classId": cls, "studentId": sid, "studentName": sid, "sessionId": session,
                                               "type": kind, "questionId": question_id, "payload": payload,
                                               "surface": surface, "schemaVersion": 2})


def heartbeat(db, cls, sid, at, *, assignment_id="", question_id=""):
    """A counted study heartbeat (TELEMETRY's accounting sets ``heartbeat_counted`` = 1 for the first per bucket)."""
    result = client_event(db, cls, sid, "study_heartbeat", {"seconds": 30, "assignmentId": assignment_id,
                                                           "questionId": question_id}, at=at, surface="assignment")
    with dbmod.write_tx(db):
        db.execute("UPDATE events SET heartbeat_counted = 1 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM events x WHERE "
                   "x.class_id = events.class_id AND x.student_id = events.student_id AND x.heartbeat_bucket = events.heartbeat_bucket "
                   "AND x.heartbeat_counted = 1 AND x.id != events.id)", (result.id,))
    return result


def grade(db, submission_id, total, status, *, actor="Instructor (local key)"):
    """A grade save/release as GRADE writes it (``submissions.grade_status`` + an append-only ``grade_events`` row)."""
    with dbmod.write_tx(db):
        row = db.execute("SELECT * FROM submissions WHERE id = ?", (submission_id,)).fetchone()
        db.execute("UPDATE submissions SET grade = ?, grade_status = ?, graded_at = ?, released_at = ? WHERE id = ?",
                   (total, status, dbmod.now(), dbmod.now() if status == "released" else None, submission_id))
        db.execute("""INSERT INTO grade_events (submission_id, class_id, actor_id, actor_role, actor_label, action, total_before,
            total_after, status_before, status_after, created_at) VALUES (?, ?, 'instructor', 'instructor', ?, ?, ?, ?, ?, ?, ?)""",
                   (submission_id, row["class_id"], actor, "release" if status == "released" else "save_draft", row["grade"], total,
                    row["grade_status"], status, dbmod.now()))


def q(**params):
    return urlencode({k: v for k, v in params.items() if v is not None}, quote_via=quote)


from server import db as dbmod  # noqa: E402


class InsightsV06Tests(ApiTestCase):
    def get(self, path, **params):
        status, body = self.request(f"{path}?{q(**params)}", key=KEY)
        self.assertEqual(status, 200, body)
        return body

    # INSIGHTS-01 / FOUNDATION-12 ------------------------------------------------------------------------------
    def test_home_range_since_last_class_and_fallback_note(self):
        cls = "home-range"
        self.create_course(cls)
        with testsupport.freeze_time(NOW):
            home = self.get("/api/teacher/home", classId=cls, preset="since_last_class")
            self.assertEqual(home["range"]["effectivePreset"], "last_7_days")
            self.assertEqual(home["range"]["note"], "Set class meetings in Course settings to use Since last class")
            with self.db() as db:
                testsupport.set_meetings(db, cls, [{"weekday": 2, "time": "10:00", "durationMinutes": 90}])
            tr = self.get("/api/teacher/time-range", classId=cls, preset="since_last_class")
            self.assertEqual((tr["from"], tr["label"], tr["compareLabel"]),
                             ("2026-10-20T02:00:00+00:00", "Since last class (Tue 10/20)", "vs last week"))
            home = self.get("/api/teacher/home", classId=cls, **{"from": tr["from"], "to": tr["to"],
                                                                 "compareFrom": tr["compareFrom"], "compareTo": tr["compareTo"]})
            self.assertEqual((home["range"]["from"], home["range"]["to"]), (tr["from"], tr["to"]))
            self.assertEqual(self.get("/api/teacher/home", classId=cls, preset="since_last_class")["range"]["label"],
                             "Since last class (Tue 10/20)")
            for block in ("needsAction", "assignments", "attention", "reteach", "askedAi", "glance", "header"):
                self.assertIn(block, home)

    # INSIGHTS-02 ------------------------------------------------------------------------------------------------
    def test_home_needs_action_matches_grading_and_gradebook(self):
        cls = "home-counts"
        self.create_course(cls)
        with testsupport.freeze_time(NOW), self.db() as db:
            for i in range(1, 6):
                testsupport.add_roster(db, cls, f"s{i}", display_name=f"Student {i}")
            hw = testsupport.publish_work(db, cls, title="Week 3 HW", due_at="2026-10-20T00:00:00+00:00",
                                          grades_visibility="on_release", questions=TWO_QUESTIONS)
            testsupport.publish_work(db, cls, title="Week 4 HW", due_at="2026-10-26T00:00:00+00:00", questions=TWO_QUESTIONS)
            testsupport.make_autochecked_submission(db, cls, "s1", hw.id, {"q1": "mean(x)", "q2": "Missing"})
            sub2 = testsupport.make_autochecked_submission(db, cls, "s2", hw.id, {"q1": "x", "q2": "y"})
            grade(db, sub2, 8, "draft")
            testsupport.make_draft(db, cls, "s3", hw.id, {"q1": "mean("})
            expected = readers.grading_counts(db, cls)
            per_assignment = readers.grading_counts(db, cls, hw.id)
            cells = [readers.gradebook_cell(db, hw, f"s{i}", "latest", NOW) for i in range(1, 6)]
            missing = [c for c in cells if c["state"] == "missing"]
        with testsupport.freeze_time(NOW):
            home = self.get("/api/teacher/home", classId=cls)
        action = home["needsAction"]
        self.assertEqual(action["toGrade"], expected["toGrade"])
        if per_assignment["toRelease"]:
            self.assertEqual(action["toRelease"], [{"assignmentId": hw.id, "title": "Week 3 HW", "count": per_assignment["toRelease"]}])
        else:
            self.assertEqual(action["toRelease"], [])
        self.assertEqual(action["missingPastDue"], [{"assignmentId": hw.id, "title": "Week 3 HW", "count": len(missing),
                                                     "started": sum(1 for c in missing if c["draftAnswered"]),
                                                     "originalTitle": None}])   # D8: a revision names its original
        self.assertEqual((len(missing), sum(1 for c in missing if c["draftAnswered"])), (3, 1))
        self.assertEqual(action["late"], 2)
        self.assertIsNone(action["flaggedReplies"])  # no guard has run yet: the chip stays hidden
        listed = {a["id"]: a for a in home["assignments"]}
        self.assertIn(hw.id, listed)
        self.assertEqual(listed[hw.id]["stats"]["submitted"], 2)
        self.assertEqual(listed[hw.id]["stats"]["missing"], 3)

    # INSIGHTS-04 ------------------------------------------------------------------------------------------------
    def test_answers_by_question_never_pools_questions(self):
        cls = "answers"
        self.create_course(cls)
        with self.db() as db:
            hw = testsupport.publish_work(db, cls, title="Week 2 HW", questions=TWO_QUESTIONS)
            for sid, code, text, ok in (("s1", "mean(x)", "A missing value", True), ("s2", "print(x)", "Not available", False),
                                        ("s3", "mean(x)", "A missing value", True)):
                testsupport.add_roster(db, cls, sid)
                testsupport.make_autochecked_submission(db, cls, sid, hw.id, {"q1": code, "q2": text}, auto={"q1": ok, "q2": None})
        data = self.get("/api/teacher/analytics/answers", classId=cls, assignmentId=hw.id)
        tables = {t["questionId"]: t for t in data["questions"]}
        self.assertEqual(set(tables), {"q1", "q2"})
        self.assertEqual({a["answer"] for a in tables["q1"]["answers"]}, {"mean(x)", "print(x)"})
        self.assertEqual({a["answer"] for a in tables["q2"]["answers"]}, {"A missing value", "Not available"})
        q1 = {a["answer"]: a for a in tables["q1"]["answers"]}
        self.assertEqual((q1["mean(x)"]["correct"], q1["mean(x)"]["incorrect"], q1["print(x)"]["incorrect"]), (2, 0, 1))
        self.assertTrue(all(a["unchecked"] == a["attempts"] for a in tables["q2"]["answers"]))
        self.assertEqual(tables["q1"]["label"], "HW2 Q1")
        # legacy evidence endpoint groups the distribution by question as well [TR02]
        status, legacy = self.request(f"/api/teacher/analytics/evidence?classId={cls}&assignmentId={hw.id}", key=KEY)
        self.assertEqual(status, 200)
        by_question = {(d["questionId"], d["answer"]) for d in legacy["distribution"]}
        self.assertIn(("q1", "mean(x)"), by_question)
        self.assertIn(("q2", "A missing value"), by_question)

    # INSIGHTS-06 / INSIGHTS-16 ---------------------------------------------------------------------------------
    def test_assignment_timeline_merges_process_and_grade_status(self):
        cls = "timeline-a"
        self.create_course(cls)
        with self.db() as db:
            testsupport.add_roster(db, cls, "s1", display_name="Ada Chen")
            hw = testsupport.publish_work(db, cls, title="Week 3 Homework", questions=TWO_QUESTIONS)
            client_event(db, cls, "s1", "question_viewed", {"assignmentId": hw.id}, question_id="q1",
                         at="2026-10-21T01:00:00+00:00", surface="assignment")
            client_event(db, cls, "s1", "code_run", {"assignmentId": hw.id, "code": "mean(", "ok": False, "error": "unexpected end"},
                         question_id="q1", at="2026-10-21T01:01:00+00:00", surface="assignment")
            testsupport.make_chat_turn(db, cls, "s1", "Why does mean( fail?", "Check the parentheses.", assignment_id=hw.id,
                                       question_id="q1", unit_id=hw.unit_id, surface="assignment", at="2026-10-21T01:02:00+00:00")
            ident = testsupport.student_identity(db, cls, "s1")
            with testsupport._clock_at("2026-10-21T01:03:00+00:00"):
                item = testsupport._make_item(db, ident, "similar", hw.unit_id, related_assignment_id=hw.id, related_question_id="q1",
                                              question_type="choice", answer="2", prompt="What does mean(c(1, 3)) return?",
                                              choices=["1", "2", "3", "4"])
            testsupport.make_draft(db, cls, "s1", hw.id, {"q1": "mean(x)"}, at="2026-10-21T01:04:00+00:00")
            sub = testsupport.make_autochecked_submission(db, cls, "s1", hw.id, {"q1": "mean(x)", "q2": "Missing"},
                                                          at="2026-10-21T01:05:00+00:00")
        status = self.get("/api/teacher/timeline", classId=cls, studentId="s1", assignmentId=hw.id)["status"]
        self.assertEqual(status["label"], "Needs grading")
        with testsupport.freeze_time("2026-10-21T02:00:00+00:00"), self.db() as db:
            grade(db, sub, 17, "draft")
        data = self.get("/api/teacher/timeline", classId=cls, studentId="s1", assignmentId=hw.id)
        self.assertEqual(data["status"]["label"], "Draft 17/20")
        with testsupport.freeze_time("2026-10-21T03:00:00+00:00"), self.db() as db:
            grade(db, sub, 17, "released")
        data = self.get("/api/teacher/timeline", classId=cls, studentId="s1", assignmentId=hw.id)
        self.assertEqual((data["status"]["label"], data["status"]["gradeStatus"]), ("Released 17/20", "released"))
        self.assertEqual(data["student"]["studentName"], "Ada Chen")
        self.assertEqual(data["assignment"]["title"], "Week 3 Homework")
        kinds = [e["kind"] for e in data["events"]]
        for kind in ("question_viewed", "code_run", "ai_turn", "similar_generated", "answer_draft", "answer_attempt", "submission",
                     "grade", "grade_released"):
            self.assertIn(kind, kinds)
        times = [e["at"] for e in data["events"]]
        self.assertEqual(times, sorted(times))
        generated = next(e for e in data["events"] if e["kind"] == "similar_generated")
        self.assertEqual(generated["title"], "Similar exercise generated")
        self.assertEqual(generated["detail"]["stem"], "What does mean(c(1, 3)) return?")
        self.assertEqual(generated["detail"]["choices"], ["1", "2", "3", "4"])
        self.assertEqual(generated["questionId"], item)
        ai = next(e for e in data["events"] if e["kind"] == "ai_turn")
        self.assertEqual(ai["provenance"]["ai"], "Lab AI tutor")  # INSIGHTS-08: never a bare "Kiwi AI"
        self.assertEqual(ai["provenance"]["policyLabel"], "Default rules")
        graded = [e for e in data["events"] if e["kind"] in ("grade", "grade_released")]
        self.assertEqual([e["title"] for e in graded], ["Draft 17/20", "Released 17/20"])

    # INSIGHTS-19 ------------------------------------------------------------------------------------------------
    def test_full_activity_timeline_across_surfaces_with_study_sessions(self):
        cls = "timeline-full"
        self.create_course(cls)
        with self.db() as db:
            testsupport.add_roster(db, cls, "s1", display_name="Ada Chen")
            hw = testsupport.publish_work(db, cls, title="Week 3 Homework", questions=TWO_QUESTIONS)
            testsupport.make_free_item_attempt(db, cls, "s1", "data-wrangling", at="2026-10-21T01:00:00+00:00")
            client_event(db, cls, "s1", "code_run", {"code": "mean(scores)", "ok": True, "output": "[1] 3"},
                         at="2026-10-21T01:05:00+00:00", surface="workspace")
            testsupport.make_native_event(db, cls, "s1", kind="frontend-interaction-pdf-change", at="2026-10-21T01:36:00.000Z",
                                          material={"documentId": "doc-1", "id": "mat-1", "title": "Lecture 3", "unitId": "data-wrangling"})
            testsupport.make_native_event(db, cls, "s1", prompt="What is a join?", response="It combines tables.",
                                          at="2026-10-21T01:40:00.000Z")
            testsupport.make_autochecked_submission(db, cls, "s1", hw.id, {"q1": "mean(x)", "q2": "Missing"},
                                                    at="2026-10-21T01:45:00+00:00")
        data = self.get("/api/teacher/timeline", classId=cls, studentId="s1")
        self.assertIsNone(data["assignment"])
        events = data["events"]
        modes = {(e["kind"], e["context"]["practiceMode"]) for e in events}
        self.assertIn(("item_check", "free"), modes)
        self.assertIn(("code_run", "workspace"), modes)
        self.assertIn(("material_viewed", "lecture"), modes)
        self.assertIn(("ai_turn", "kiwi"), modes)
        self.assertIn(("submission", "homework"), modes)
        native = next(e for e in events if e["kind"] == "ai_turn")
        self.assertEqual((native["provenance"]["where"], native["provenance"]["ai"]), ("kiwi", "Kiwi lecture AI"))
        times = [e["at"] for e in events]
        self.assertEqual(times, sorted(times))
        before = [e["studySessionIndex"] for e in events if e["at"] < "2026-10-21T01:36"]
        after = [e["studySessionIndex"] for e in events if e["at"] >= "2026-10-21T01:36"]
        self.assertEqual(set(before), {0})
        self.assertEqual(set(after), {1})  # 31-minute gap starts study session 2
        page = self.get("/api/teacher/timeline", classId=cls, studentId="s1", limit=2)
        self.assertTrue(page["hasMore"])
        rest = self.get("/api/teacher/timeline", classId=cls, studentId="s1", limit=200, after=page["nextCursor"])
        self.assertEqual([e["id"] for e in page["events"] + rest["events"]], [e["id"] for e in events])

    # INSIGHTS-07 / INSIGHTS-09 / INSIGHTS-10 -------------------------------------------------------------------
    def test_course_metrics_denominators_published_counts_and_deltas(self):
        cls = "metrics"
        self.create_course(cls)
        with self.db() as db:
            for i in range(1, 6):
                testsupport.add_roster(db, cls, f"s{i}")
            works = [testsupport.publish_work(db, cls, title=f"Week {i} HW", questions=TWO_QUESTIONS) for i in range(1, 5)]
            for i in range(3):
                testsupport.publish_work(db, cls, kind="practice", title=f"In-class {i}", questions=TWO_QUESTIONS)
            testsupport.publish_work(db, cls, title="Draft HW", status="draft")
            for sid in ("s1", "s2"):
                testsupport.make_server_check(db, cls, sid, works[0].id, "q1", "mean(x)", True, at="2026-10-21T01:00:00+00:00")
            testsupport.make_server_check(db, cls, "s1", works[0].id, "q1", "x", False, at="2026-10-21T01:10:00+00:00")
            testsupport.make_server_check(db, cls, "s3", works[0].id, "q1", "mean(x)", True, at="2026-10-14T01:00:00+00:00")
        window = {"from": "2026-10-20T00:00:00+00:00", "to": "2026-10-22T00:00:00+00:00",
                  "compareFrom": "2026-10-13T00:00:00+00:00", "compareTo": "2026-10-15T00:00:00+00:00"}
        m = self.get("/api/teacher/metrics", classId=cls, **window)
        self.assertEqual(m["enrolled"], 5)  # never-active students count in enrolled
        self.assertEqual(m["active"]["value"], 2)
        self.assertEqual(m["active"]["denominator"], {"label": "enrolled", "value": 5})
        self.assertEqual(m["active"]["previous"], 1)
        self.assertEqual(m["active"]["deltaPct"], 100)
        self.assertEqual(m["answerAttemptsPerActive"]["value"], 1.5)
        self.assertEqual(m["answerAttemptsPerActive"]["denominator"], {"label": "active students", "value": 2})
        self.assertEqual((m["publishedHomework"], m["inClassExercises"]), (4, 3))
        self.assertAlmostEqual(m["autoCheckedAccuracy"]["value"], 66.7)
        self.assertEqual(m["thisWeekChapter"]["total"], 5)
        whole = self.get("/api/teacher/metrics", classId=cls)
        self.assertEqual(whole["range"]["preset"], "whole_term")
        self.assertIsNone(whole["active"]["deltaPct"])
        self.assertEqual(whole["active"]["value"], 3)

    # INSIGHTS-11 / INSIGHTS-12 (server) ---------------------------------------------------------------------------
    def test_explorer_questions_origin_folding_disambiguation_and_research_filters(self):
        cls = "explorer"
        self.create_course(cls)
        prompt = [{"id": "q1", "type": "fill", "prompt": "What does mean(c(2, 4, 6)) return?", "points": 10, "answer": "4"}]
        tagged = [{**prompt[0], "tags": ["means"]}]
        with self.db() as db:
            for sid in ("s1", "s2", "s3"):
                testsupport.add_roster(db, cls, sid)
            hw3 = testsupport.publish_work(db, cls, title="Week 3 Homework", kind="practice", questions=tagged, unit_id="data-wrangling")
            hw4 = testsupport.publish_work(db, cls, title="Week 4 Homework", kind="practice", questions=prompt, unit_id="data-wrangling")
            testsupport.make_server_check(db, cls, "s1", hw3.id, "q1", "4", True)
            testsupport.make_server_check(db, cls, "s2", hw4.id, "q1", "3", False)
            testsupport.make_free_item_attempt(db, cls, "s1", "data-wrangling", question_type="choice", difficulty=3)
            testsupport.make_free_item_attempt(db, cls, "s2", "data-wrangling", question_type="choice", difficulty=3, correct=False)
            testsupport.make_similar_attempt(db, cls, "s3", hw3.id, "q1")
        teacher = self.get("/api/teacher/analytics/table", classId=cls, group="questions", v="2")
        self.assertEqual({r["origin"] for r in teacher["rows"]}, {"teacher"})  # default Origin: Your questions
        self.assertEqual(sorted(r["disambiguation"] for r in teacher["rows"]), ["· IC3 Q1", "· IC4 Q1"])
        everything = self.get("/api/teacher/analytics/table", classId=cls, group="questions", origin="all")
        labels = {r["label"] for r in everything["rows"]}
        self.assertIn("Free practice · Ch 03 · Multiple choice (2)", labels)
        self.assertIn("Similar practice · IC3 Q1 · Fill in the blank (1)", labels)
        folded = next(r for r in everything["rows"] if r["origin"] == "ai-free")
        self.assertEqual(folded["aiItemGroup"], {"unitId": "data-wrangling", "origin": "ai-free", "questionType": "choice", "items": 2})
        self.assertEqual(folded["firstTryCorrectPct"], 50.0)
        free_only = self.get("/api/teacher/analytics/table", classId=cls, group="questions", origin="all", work="free")
        self.assertEqual({r["origin"] for r in free_only["rows"]}, {"ai-free"})
        unfolded = self.get("/api/teacher/analytics/table", classId=cls, group="questions", origin="ai-free", fold="0")
        self.assertEqual(len(unfolded["rows"]), 2)
        typed = self.get("/api/teacher/analytics/table", classId=cls, group="questions", origin="all", questionType="choice")
        self.assertEqual({r["origin"] for r in typed["rows"]}, {"ai-free"})
        level = self.get("/api/teacher/analytics/table", classId=cls, group="questions", origin="all", difficulty="2")
        self.assertEqual({r["origin"] for r in level["rows"]}, {"ai-similar"})
        tag = self.get("/api/teacher/analytics/table", classId=cls, group="questions", tag="means")
        self.assertEqual([(r["assignmentId"], r["tags"]) for r in tag["rows"]], [(hw3.id, ["means"])])
        chapters = self.get("/api/teacher/analytics/table", classId=cls, group="chapters", v="2")
        wrangling = next(r for r in chapters["rows"] if r["unitId"] == "data-wrangling")
        self.assertEqual((wrangling["serverAccuracy"], wrangling["similarAccuracy"]), (50.0, 100.0))
        assignments = self.get("/api/teacher/analytics/table", classId=cls, group="assignments", v="2")
        row3 = next(r for r in assignments["rows"] if r["assignmentId"] == hw3.id)
        self.assertEqual((row3["serverAccuracy"], row3["similarAccuracy"]), (100.0, 100.0))

    def test_explorer_students_keep_zero_activity_roster_and_pseudonyms(self):
        cls = "explorer-students"
        self.create_course(cls)
        with self.db() as db:
            for sid, name in (("s1", "Ada Chen"), ("s2", "Bo Li"), ("s3", "Cy Wu")):
                testsupport.add_roster(db, cls, sid, display_name=name)
            hw = testsupport.publish_work(db, cls, kind="practice", questions=TWO_QUESTIONS)
            testsupport.make_server_check(db, cls, "s1", hw.id, "q1", "mean(x)", True)
            testsupport.make_free_item_attempt(db, cls, "s2", "r-basics")
        for params in ({}, {"where": "lab"}, {"work": "free"}, {"unitId": "text-analysis"},
                       {"from": "2026-01-01T00:00:00+00:00", "to": "2026-01-02T00:00:00+00:00"}):
            table = self.get("/api/teacher/analytics/table", classId=cls, group="students", v="2", **params)
            self.assertEqual({r["studentId"] for r in table["rows"]}, {"s1", "s2", "s3"}, params)
        table = self.get("/api/teacher/analytics/table", classId=cls, group="students", v="2", sort="label", direction="asc")
        self.assertEqual([r["label"] for r in table["rows"]], ["Ada Chen", "Bo Li", "Cy Wu"])
        self.assertEqual(table["population"]["enrolled"], 3)
        status, masked = self.request(f"/api/teacher/analytics/table?classId={cls}&group=students&v=2", key=KEY, name_mode="pseudonyms")
        self.assertEqual(status, 200)
        self.assertTrue(all(r["label"].startswith("S-") for r in masked["rows"]))
        errors = self.get("/api/teacher/analytics/table", classId=cls, group="students", v="2", activity="attempts")
        self.assertEqual({r["studentId"] for r in errors["rows"]}, {"s1", "s2"})
        self.assertEqual(self.request(f"/api/teacher/analytics/table?classId={cls}&v=2&sort=payload_json", key=KEY)[0], 400)

    # INSIGHTS-15 ------------------------------------------------------------------------------------------------
    def test_trends_learning_curves_and_time_on_task(self):
        cls = "trends"
        self.create_course(cls)
        with self.db() as db:
            for sid in ("s1", "s2"):
                testsupport.add_roster(db, cls, sid)
            hw = testsupport.publish_work(db, cls, kind="practice", title="Week 3 practice", questions=TWO_QUESTIONS)
            testsupport.make_server_check(db, cls, "s1", hw.id, "q1", "x", False, at="2026-10-13T02:00:00+00:00")
            testsupport.make_server_check(db, cls, "s1", hw.id, "q1", "mean(x)", True, at="2026-10-13T02:05:00+00:00")
            testsupport.make_server_check(db, cls, "s2", hw.id, "q1", "mean(x)", True, at="2026-10-20T02:00:00+00:00")
            for minute in range(4):
                heartbeat(db, cls, "s1", f"2026-10-20T03:0{minute}:10+00:00", assignment_id=hw.id, question_id="q1")
            for minute in range(2):
                heartbeat(db, cls, "s2", f"2026-10-20T04:0{minute}:10+00:00", assignment_id=hw.id, question_id="q1")
        # two Monday-aligned weeks in the course time zone (Asia/Shanghai): Mon 10/12 00:00 – Mon 10/26 00:00 local
        data = self.get("/api/teacher/trends", classId=cls, bucket="week", **{"from": "2026-10-11T16:00:00+00:00",
                                                                             "to": "2026-10-25T16:00:00+00:00"})
        self.assertEqual(len(data["buckets"]), 2)
        self.assertEqual([b["attempts"] for b in data["buckets"]], [2, 1])
        self.assertEqual([b["active"] for b in data["buckets"]], [1, 1])
        self.assertEqual(data["buckets"][0]["autoCheckedAccuracy"], 50.0)
        self.assertIn("outages", data)
        curve = self.get("/api/teacher/learning-curves", classId=cls)["points"]
        self.assertEqual([(p["attemptIndex"], p["accuracy"], p["n"]) for p in curve], [(1, 50.0, 2), (2, 100.0, 1)])
        tot = self.get("/api/teacher/time-on-task", classId=cls, assignmentId=hw.id)["questions"]
        q1 = next(x for x in tot if x["questionId"] == "q1")
        self.assertEqual((q1["students"], q1["medianMinutes"], q1["p75Minutes"]), (2, 1.5, 1.75))

    # INSIGHTS-20 ------------------------------------------------------------------------------------------------
    def test_group_filter_restricts_every_insights_endpoint(self):
        cls = "groups"
        self.create_course(cls)
        with self.db() as db:
            ids = [f"s{i}" for i in range(1, 6)]
            for sid in ids:
                testsupport.add_roster(db, cls, sid)
            a = testsupport.make_group(db, cls, "section", "Section A", ids[:3])
            testsupport.make_group(db, cls, "section", "Section B", ids[3:])
            hw = testsupport.publish_work(db, cls, kind="practice", title="Week 3 practice", questions=TWO_QUESTIONS)
            for sid in ids:
                testsupport.make_server_check(db, cls, sid, hw.id, "q1", "mean(x)", sid in ("s1", "s4"), at="2026-10-20T02:00:00+00:00")
                heartbeat(db, cls, sid, "2026-10-20T03:00:10+00:00", assignment_id=hw.id, question_id="q1")
        m = self.get("/api/teacher/metrics", classId=cls, groupId=a)
        self.assertEqual((m["enrolled"], m["active"]["value"]), (3, 3))
        self.assertEqual(self.get("/api/teacher/home", classId=cls, groupId=a)["glance"]["enrolled"], 3)
        attention = self.get("/api/teacher/attention", classId=cls, groupId=a)
        self.assertTrue({s["studentId"] for s in attention["students"]} <= set(ids[:3]))
        reteach = self.get("/api/teacher/reteach", classId=cls, groupId=a)["candidates"]
        self.assertEqual([(c["questionId"], c["students"]) for c in reteach], [("q1", 3)])
        answers = self.get("/api/teacher/analytics/answers", classId=cls, assignmentId=hw.id, groupId=a)["questions"][0]
        self.assertEqual(answers["totalAttempts"], 3)
        table = self.get("/api/teacher/analytics/table", classId=cls, group="students", groupId=a)
        self.assertEqual({r["studentId"] for r in table["rows"]}, set(ids[:3]))
        tot = self.get("/api/teacher/time-on-task", classId=cls, assignmentId=hw.id, groupId=a)["questions"][0]
        self.assertEqual(tot["students"], 3)
        trends = self.get("/api/teacher/trends", classId=cls, groupId=a, **{"from": "2026-10-19T00:00:00+00:00",
                                                                           "to": "2026-10-26T00:00:00+00:00"})
        self.assertEqual(sum(b["active"] for b in trends["buckets"]), 3)

    # INSIGHTS-24 ------------------------------------------------------------------------------------------------
    def test_auto_checked_accuracy_counts_rejudged_legacy_only(self):
        cls = "legacy"
        self.create_course(cls)
        with self.db() as db:
            for sid in ("s1", "s2", "s3", "s4"):
                testsupport.add_roster(db, cls, sid)
            hw = testsupport.publish_work(db, cls, kind="practice", title="Week 1 practice", questions=TWO_QUESTIONS)
            testsupport.make_server_check(db, cls, "s1", hw.id, "q1", "mean(x)", True)
            testsupport.make_server_check(db, cls, "s2", hw.id, "q1", "x", False)
            legacy_a = testsupport.make_server_check(db, cls, "s3", hw.id, "q1", '[1] "Hello"', True)
            legacy_b = testsupport.make_server_check(db, cls, "s4", hw.id, "q1", "mean(x)", True)
            with dbmod.write_tx(db):  # v0.5.1 in-class checks: legacy_server, re-judged (0) or not re-judged (NULL)
                db.execute("UPDATE events SET checked_by = 'legacy_server', schema_version = 1, rejudged_correct = 0 WHERE id = ?", (legacy_a,))
                db.execute("UPDATE events SET checked_by = 'legacy_server', schema_version = 1, rejudged_correct = NULL WHERE id = ?", (legacy_b,))
        rows = self.get("/api/teacher/analytics/table", classId=cls, group="assignments", v="2")["rows"]
        row = next(r for r in rows if r["assignmentId"] == hw.id)
        self.assertEqual(row["serverAccuracy"], 33.3)  # 1 correct of server(2) + re-judged legacy(1)
        self.assertEqual(row["legacyAccuracy"], 100.0)  # Research preset: original v0.5 judgements
        self.assertEqual(self.get("/api/teacher/metrics", classId=cls)["autoCheckedAccuracy"]["value"], 33.3)

    def test_question_activity_follows_aliases(self):
        cls = "alias"
        self.create_course(cls)
        with self.db() as db:
            testsupport.add_roster(db, cls, "s1", display_name="Ada Chen")
            hw = testsupport.publish_work(db, cls, kind="practice", questions=TWO_QUESTIONS)
            event_id = testsupport.make_server_check(db, cls, "s1", hw.id, "q1", "mean(x)", True)
            session = db.execute("SELECT learning_session_id FROM events WHERE id = ?", (event_id,)).fetchone()[0]
            with dbmod.write_tx(db):
                db.execute("INSERT INTO learning_session_aliases (old_id, new_id, class_id, created_at) VALUES (?, ?, ?, ?)",
                           ("learn-old", session, cls, dbmod.now()))
        data = self.get(f"/api/teacher/analytics/question-activity/{session}", classId=cls)
        self.assertNotIn("aliasOf", data)
        self.assertEqual(data["activity"]["studentName"], "Ada Chen")
        moved = self.get("/api/teacher/analytics/question-activity/learn-old", classId=cls)
        self.assertEqual((moved["aliasOf"], moved["activity"]["id"]), ("learn-old", session))
        self.assertEqual(moved["events"][0]["checkedBy"], "server")
        self.assertEqual(self.request(f"/api/teacher/analytics/question-activity/learn-missing?classId={cls}", key=KEY)[0], 404)

    def test_insights_endpoints_require_staff_and_validate_input(self):
        cls = "guard"
        self.create_course(cls)
        for path in ("/api/teacher/home", "/api/teacher/metrics", "/api/teacher/attention", "/api/teacher/reteach",
                     "/api/teacher/ai-conversations/digest", "/api/teacher/trends"):
            self.assertEqual(self.request(f"{path}?classId={cls}")[0], 401, path)
            self.assertEqual(self.request(f"{path}?classId={cls}&from=yesterday", key=KEY)[0], 400, path)
        self.assertEqual(self.request(f"/api/teacher/home?classId={cls}&preset=someday", key=KEY)[0], 400)
        status, body = self.request(f"/api/teacher/timeline?classId={cls}", key=KEY)
        self.assertEqual((status, body["code"]), (400, "invalid_request"))
        self.assertEqual(self.request(f"/api/teacher/timeline?classId={cls}&studentId=s1&assignmentId=nope", key=KEY)[0], 404)


if __name__ == "__main__":
    unittest.main()
