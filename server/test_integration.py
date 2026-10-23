"""INTEGRATION (spec §18, §9.9): cross-workstream checks that no single workstream's tests can make.

- INTEGRATION-04: every ``testsupport`` builder writes the same rows as the real writer it stands for (ASSESS submit,
  in-class check and drafts; AIRUN chat, free and similar practice; TELEMETRY add_event; the GRADE writer pattern INSIGHTS
  used in fixtures), on the columns other workstreams read. Fixture drift fails here.
- Server-written events carry only registered payload keys (Data health lists no drift for them; CR-A4, CR-T2).
- Applied change requests that span workstreams (CR-T5, CR-P1, CR-AIRUN-1, CR-AIRUN-4, workstream migrations).
- INTEGRATION-05 (server-owned cut-over) and INTEGRATION-07 (legacy re-judge with the real ``judging-v2``).
- Wiring: server-built teacher links resolve to client routes; the 30-minute rule text is the same on both sides;
  INTEGRATION-03: every §19.4 row names an existing test.

All AI calls go through fakes; AI keys are empty (``testsupport``).
"""

from __future__ import annotations

import json
import re
import sqlite3
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

from server import (ai_runtime, analytics, app, attention, db as dbmod, event_schema, grading, grading_rules, judging,
                    kiwi_bridge, local_templates, migrations, roster, telemetry, testsupport, webr_packages)
from server.test_ai_runtime import C, FUTURE, AirunCase, Fake
from server.testsupport import TEACHER_KEY, ApiTestCase

ROOT = Path(__file__).resolve().parents[1]

# Columns of `events` that other workstreams read (INSIGHTS, PEOPLE exports, GRADE flags, TELEMETRY index).
EVENT_COLUMNS = ("event_type", "question_id", "surface", "schema_version", "source", "actor_role", "is_preview",
                 "identity_verified", "practice_mode", "attribution_assignment_id", "related_assignment_id", "checked_by",
                 "category", "assignment_version", "section_group_id", "condition_group_id")


def event_rows(db: sqlite3.Connection, student_id: str, types: tuple[str, ...]) -> list[dict]:
    marks = ",".join("?" for _ in types)
    rows = db.execute(f"SELECT * FROM events WHERE student_id=? AND event_type IN ({marks}) ORDER BY id", (student_id, *types))
    return [dict(r) for r in rows]


def event_view(row: dict, *, payload_skip: tuple[str, ...] = ()) -> dict:
    """Comparable view of one event: the read columns, presence of the provenance links, and the payload."""
    payload = json.loads(row["payload_json"])
    view = {c: row[c] for c in EVENT_COLUMNS}
    if row["item_id"] and view["question_id"] == row["item_id"]:
        view["question_id"] = "<item id>"  # generated item ids differ by construction
    return {**view,
            "has_item": bool(row["item_id"]), "has_chat_turn": row["chat_turn_id"] is not None,
            "has_ai_call": row["ai_call_id"] is not None, "session_is_submission": str(row["session_id"]).startswith("submission-"),
            "payload": {k: v for k, v in payload.items() if k not in payload_skip}}


class BuilderParityTests(AirunCase):
    maxDiff = None
    """INTEGRATION-04: builder (student demo-bo) vs real writer over HTTP (student demo-ada), same input."""

    def test_autochecked_submission_matches_real_submit(self):  # ASSESS submit v2 ↔ make_autochecked_submission
        with self.db() as db:
            hw = testsupport.publish_work(db, C, due_at=FUTURE)
        answers = {"q1": "4", "q2": "An ordered sequence of values."}
        status, result = self.request(f"/api/work/{hw.id}/submit?classId={C}", "POST",
                                      {"studentId": "demo-ada", "answers": answers, "requestId": "req-integration-01"},
                                      student="demo-ada")
        self.assertEqual(status, 201, result)
        with self.db() as db:
            built_id = testsupport.make_autochecked_submission(db, C, "demo-bo", hw.id, answers)
            subs = {r["student_id"]: dict(r) for r in db.execute("SELECT * FROM submissions WHERE assignment_id=?", (hw.id,))}
            real, built = subs["demo-ada"], subs["demo-bo"]
            self.assertEqual(built["id"], built_id)
            for column in ("attempt", "assignment_version", "is_late", "late_seconds", "actor_role", "is_preview",
                           "identity_verified", "grade_status", "grade", "feedback", "released_at", "time_used_seconds",
                           "over_time", "section_group_id", "condition_group_id"):
                self.assertEqual(built[column], real[column], column)
            strip = lambda blob: {q: {k: v for k, v in r.items() if k != "normalizedAnswer"} for q, r in json.loads(blob).items()}
            self.assertEqual(strip(built["autocheck_json"]), strip(real["autocheck_json"]))
            items = {sid: [dict(r) for r in db.execute(
                "SELECT question_id, auto_correct, auto_score, auto_reason, score, comment FROM submission_item_scores "
                "WHERE submission_id=? ORDER BY question_id", (subs[sid]["id"],))] for sid in subs}
            self.assertEqual(items["demo-bo"], items["demo-ada"])
            history = {sid: [dict(r) for r in db.execute(
                "SELECT actor_id, actor_role, actor_label, action, total_after, items_after_json, status_after FROM grade_events "
                "WHERE submission_id=? ORDER BY id", (subs[sid]["id"],))] for sid in subs}
            self.assertEqual(history["demo-bo"], history["demo-ada"])  # GRADE shows it as "Auto-checked at submission"
            kinds = ("answer_submitted", "work_submitted")
            self.assertEqual([event_view(r, payload_skip=("submissionId",)) for r in event_rows(db, "demo-bo", kinds)],
                             [event_view(r, payload_skip=("submissionId",)) for r in event_rows(db, "demo-ada", kinds)])

    def test_server_check_matches_real_inclass_check(self):  # ASSESS in-class check ↔ make_server_check
        with self.db() as db:
            work = testsupport.publish_work(db, C, kind="practice")
        status, result = self.request(f"/api/work/{work.id}/check?classId={C}", "POST",
                                      {"studentId": "demo-ada", "questionId": "q1", "answer": "4"}, student="demo-ada")
        self.assertEqual(status, 200, result)
        with self.db() as db:
            testsupport.make_server_check(db, C, "demo-bo", work.id, "q1", "4", True)
            real, built = event_rows(db, "demo-ada", ("answer_submitted",)), event_rows(db, "demo-bo", ("answer_submitted",))
            self.assertEqual([event_view(r) for r in built], [event_view(r) for r in real])
            self.assertIsNotNone(db.execute("SELECT frozen_at FROM assignments WHERE id=?", (work.id,)).fetchone()[0])

    def test_draft_matches_real_draft_save(self):  # ASSESS drafts ↔ make_draft
        with self.db() as db:
            hw = testsupport.publish_work(db, C, due_at=FUTURE)
        status, result = self.request(f"/api/drafts/{hw.id}?classId={C}", "PUT",
                                      {"studentId": "demo-ada", "answers": {"q1": "mean(x)"}, "clientTs": 1}, student="demo-ada")
        self.assertEqual(status, 200, result)
        with self.db() as db:
            testsupport.make_draft(db, C, "demo-bo", hw.id, {"q1": "mean(x)"}, client_ts=1)
            drafts = {r["student_id"]: dict(r) for r in db.execute("SELECT * FROM answer_drafts WHERE assignment_id=?", (hw.id,))}
            for column in ("question_id", "value", "value_length", "assignment_version", "is_preview", "client_ts_ms",
                           "section_group_id", "condition_group_id"):
                self.assertEqual(drafts["demo-bo"][column], drafts["demo-ada"][column], column)
            self.assertEqual([event_view(r) for r in event_rows(db, "demo-bo", ("answer_draft",))],
                             [event_view(r) for r in event_rows(db, "demo-ada", ("answer_draft",))])

    def test_chat_turn_matches_real_chat(self):  # AIRUN chat ↔ make_chat_turn
        with patch.object(app.ai, "invoke", Fake("Look at what mean() needs.")):
            status, reply = self.chat("How do I start?", thread="thread-ask-kiwi-r-basics")
        self.assertEqual(status, 200, reply)
        with self.db() as db:
            real_turn = dict(db.execute("SELECT * FROM chat_turns WHERE id=?", (reply["chatTurnId"],)).fetchone())
            built_id = testsupport.make_chat_turn(db, C, "demo-bo", "How do I start?", "Look at what mean() needs.",
                                                  thread_id="thread-ask-kiwi-r-basics", unit_id="r-basics", surface="ask-kiwi",
                                                  model=real_turn["model"], policy_version_id=real_turn["policy_version_id"])
            built_turn = dict(db.execute("SELECT * FROM chat_turns WHERE id=?", (built_id,)).fetchone())
            for column in ("thread_id", "question_id", "unit_id", "assignment_id", "item_id", "surface", "policy_version_id",
                           "model", "source", "guard_status", "flagged", "flag_source", "actor_role", "is_preview",
                           "identity_verified", "section_group_id", "condition_group_id"):
                self.assertEqual(built_turn[column], real_turn[column], column)
            calls = {k: dict(db.execute("SELECT * FROM ai_calls WHERE id=?", (t["ai_call_id"],)).fetchone())
                     for k, t in (("real", real_turn), ("built", built_turn))}
            for column in ("action", "surface", "unit_id", "assignment_id", "thread_id", "status", "policy_version_id",
                           "platform_rules_version", "guard_status", "actor_role", "is_preview"):
                self.assertEqual(calls["built"][column], calls["real"][column], column)
            skip = ("chatTurnId", "aiCallId", "effectiveAccess")  # ids differ; effectiveAccess is AIRUN-only context
            real = [event_view(r, payload_skip=skip) for r in event_rows(db, "demo-ada", ("ai_question",))]
            built = [event_view(r, payload_skip=skip) for r in event_rows(db, "demo-bo", ("ai_question",))]
            self.assertEqual(built, real)

    def _generated(self, db, student):
        return [dict(r) for r in db.execute("SELECT * FROM generated_items WHERE student_id=? ORDER BY created_at", (student,))]

    ITEM_COLUMNS = ("origin", "unit_id", "related_assignment_id", "related_question_id", "question_type", "difficulty",
                    "requested_type", "requested_difficulty", "source", "actor_role", "is_preview", "identity_verified",
                    "section_group_id", "condition_group_id", "status")
    # Payload keys only the real AIRUN pipeline knows (shuffle order, guard result, call id, chapter access, focus note).
    ITEM_EVENT_SKIP = ("itemId", "choiceOrder", "aiCallId", "effectiveAccess", "guardStatus", "policyVersionId", "model",
                       "focusNote", "title", "prompt", "choices", "timeOnItemMs", "homeworkMatchAssignmentId")

    def test_free_item_attempt_matches_real_generation_and_check(self):  # AIRUN free practice ↔ make_free_item_attempt
        item = json.dumps({"title": "Practice", "prompt": "What does mean(c(1, 3)) return?", "answer": "2", "acceptedAnswers": [],
                           "explanation": "Average the values."})
        with patch.object(app.ai, "invoke", Fake(item)):
            status, generated = self.request(f"/api/ai/question?classId={C}", "POST",
                                             {"studentId": "demo-ada", "unitId": "r-basics", "type": "fill", "difficulty": 2,
                                              "surface": "free-practice"}, student="demo-ada")
        self.assertEqual(status, 200, generated)
        status, checked = self.request(f"/api/practice/items/{generated['id']}/check?classId={C}", "POST", {"answer": "2"},
                                       student="demo-ada")
        self.assertEqual((status, checked["correct"]), (200, True), checked)
        with self.db() as db:
            testsupport.make_free_item_attempt(db, C, "demo-bo", "r-basics", answer="2")
            real, built = self._generated(db, "demo-ada"), self._generated(db, "demo-bo")
            self.assertEqual([{c: r[c] for c in self.ITEM_COLUMNS} for r in built], [{c: r[c] for c in self.ITEM_COLUMNS} for r in real])
            kinds = ("question_generated", "answer_submitted")
            self.assertEqual([event_view(r, payload_skip=self.ITEM_EVENT_SKIP) for r in event_rows(db, "demo-bo", kinds)],
                             [event_view(r, payload_skip=self.ITEM_EVENT_SKIP) for r in event_rows(db, "demo-ada", kinds)])

    def test_similar_attempt_matches_real_similar_and_check(self):  # AIRUN similar practice ↔ make_similar_attempt
        hw = self.homework(tool_policy={"similarPractice": True})
        item = json.dumps({"title": "Practice", "prompt": "What does mean(c(1, 3)) return?", "answer": "2", "acceptedAnswers": [],
                           "explanation": "Average the values."})
        with patch.object(app.ai, "invoke", Fake(item)):
            status, generated = self.request(f"/api/ai/similar?classId={C}", "POST",
                                             {"studentId": "demo-ada", "assignmentId": hw.id, "questionId": "q1", "difficulty": 2,
                                              "type": "fill"}, student="demo-ada")
        self.assertEqual(status, 200, generated)
        status, checked = self.request(f"/api/practice/items/{generated['id']}/check?classId={C}", "POST", {"answer": "2"},
                                       student="demo-ada")
        self.assertEqual(status, 200, checked)
        with self.db() as db:
            testsupport.make_similar_attempt(db, C, "demo-bo", hw.id, "q1", answer="2", unit_id=hw.unit_id)
            real, built = self._generated(db, "demo-ada"), self._generated(db, "demo-bo")
            self.assertEqual([{c: r[c] for c in self.ITEM_COLUMNS} for r in built], [{c: r[c] for c in self.ITEM_COLUMNS} for r in real])
            kinds = ("question_generated", "similar_requested", "answer_submitted")
            self.assertEqual([event_view(r, payload_skip=self.ITEM_EVENT_SKIP) for r in event_rows(db, "demo-bo", kinds)],
                             [event_view(r, payload_skip=self.ITEM_EVENT_SKIP) for r in event_rows(db, "demo-ada", kinds)])

    def test_client_event_route_matches_add_event(self):  # TELEMETRY POST /api/events ↔ telemetry.add_event (fixtures)
        event = {"classId": C, "sessionId": "tab-1", "type": "code_run", "schemaVersion": 2, "surface": "workspace",
                 "payload": {"code": "mean(1:3)", "ok": True, "stdout": "[1] 2", "unitId": "r-basics",
                             "attribution": {"chapter": "selected"}}}
        status, body = self.request(f"/api/events?classId={C}", "POST", {**event, "studentId": "demo-ada", "eventId": "evt-int-1"},
                                    student="demo-ada")
        self.assertEqual(status, 201, body)
        with self.db() as db:
            telemetry.add_event(db, testsupport.student_identity(db, C, "demo-bo"),
                                {**event, "studentId": "demo-bo", "eventId": "evt-int-2"})
            db.commit()
            self.assertEqual([event_view(r) for r in event_rows(db, "demo-bo", ("code_run",))],
                             [event_view(r) for r in event_rows(db, "demo-ada", ("code_run",))])

    def test_insights_grade_fixture_matches_grade_writer(self):  # GRADE save/release ↔ test_insights.grade()
        from server.test_insights import grade as insights_grade

        with self.db() as db:
            hw = testsupport.publish_work(db, C, due_at=FUTURE)
            subs = {sid: testsupport.make_autochecked_submission(db, C, sid, hw.id, {"q1": "4", "q2": "x"}) for sid in ("demo-ada", "demo-bo")}
        for action in ("save", "release"):
            status, body = self.request(f"/api/teacher/submissions/{subs['demo-ada']}/grade?classId={C}", "PUT",
                                        {"items": {"q1": {"score": 10, "comment": ""}, "q2": {"score": 7, "comment": ""}},
                                         "action": action}, key=TEACHER_KEY)
            self.assertEqual(status, 200, body)
        with self.db() as db:
            insights_grade(db, subs["demo-bo"], 17, "draft")
            insights_grade(db, subs["demo-bo"], 17, "released")
            rows = {sid: dict(db.execute("SELECT grade, grade_status, released_at IS NOT NULL released FROM submissions WHERE id=?",
                                         (sub,)).fetchone()) for sid, sub in subs.items()}
            self.assertEqual(rows["demo-bo"], rows["demo-ada"])
            steps = {sid: [tuple(r) for r in db.execute(
                "SELECT action, status_after, total_after FROM grade_events WHERE submission_id=? AND action != 'autocheck' "
                "AND action != 'adjust' ORDER BY id", (sub,))] for sid, sub in subs.items()}
            # INSIGHTS' timeline reads save_draft/release rows (handoff D12); the real writer adds nothing else it reads.
            self.assertEqual(steps["demo-bo"], steps["demo-ada"])


class ServerEventRegistryTests(AirunCase):
    """CR-A4 / CR-T2 / AIRUN handoff: server-written events carry only registered payload keys (no Data health drift)."""

    def test_real_writers_use_registered_keys_only(self):
        self.save_policy("r-basics", feedback={"revealAfterAttempts": 3, "showExplanationOnWrong": False})
        with self.db() as db:
            hw = testsupport.publish_work(db, C, due_at=FUTURE, tool_policy={"similarPractice": True})
            work = testsupport.publish_work(db, C, kind="practice")
        item = json.dumps({"title": "Practice", "prompt": "What does mean(c(1, 3)) return?", "answer": "2", "acceptedAnswers": [],
                           "explanation": "Average the values."})
        calls = [
            (f"/api/work/{work.id}/check", {"studentId": "demo-ada", "questionId": "q1", "answer": "5"}),
            (f"/api/drafts/{hw.id}", {"studentId": "demo-ada", "answers": {"q1": "4"}, "clientTs": 1}),
            (f"/api/work/{hw.id}/submit", {"studentId": "demo-ada", "answers": {"q1": "4", "q2": "x"}, "requestId": "req-reg-1"}),
        ]
        for path, body in calls:
            method = "PUT" if path.startswith("/api/drafts") else "POST"
            status, result = self.request(f"{path}?classId={C}", method, body, student="demo-ada")
            self.assertIn(status, (200, 201), result)
        other = json.dumps({"title": "Practice 2", "prompt": "What does sum(c(2, 5)) return?", "answer": "7", "acceptedAnswers": [],
                            "explanation": "Add the values."})
        with patch.object(app.ai, "invoke", Fake(item, other, "A hint.")):
            status, free = self.request(f"/api/ai/question?classId={C}", "POST", {"studentId": "demo-ada", "unitId": "r-basics",
                                        "type": "fill", "difficulty": 2, "surface": "free-practice"}, student="demo-ada")
            self.assertEqual(status, 200, free)
            status, similar = self.request(f"/api/ai/similar?classId={C}", "POST", {"studentId": "demo-ada", "assignmentId": hw.id,
                                           "questionId": "q1", "difficulty": 2, "type": "fill"}, student="demo-ada")
            self.assertEqual(status, 200, similar)
            self.assertEqual(self.chat("Where do I start?")[0], 200)
        for _ in range(3):
            self.request(f"/api/practice/items/{free['id']}/check?classId={C}", "POST", {"answer": "9"}, student="demo-ada")
        self.request(f"/api/practice/items/{free['id']}/reveal?classId={C}", "POST", {}, student="demo-ada")
        with patch.object(app.ai, "invoke", Fake(TimeoutError("slow"))):
            self.chat("Another question?")
        with self.db() as db:
            rows = db.execute("SELECT event_type, payload_json FROM events WHERE schema_version=2 AND json_valid(payload_json)").fetchall()
            seen = {r["event_type"] for r in rows}
            drift = {r["event_type"]: telemetry.unknown_keys(r["event_type"], json.loads(r["payload_json"])) for r in rows}
        self.assertTrue({"answer_submitted", "answer_draft", "work_submitted", "question_generated", "similar_requested",
                         "ai_question", "answer_revealed"} <= seen, seen)
        self.assertEqual({k: v for k, v in drift.items() if v}, {})

    def test_inclass_and_homework_events_record_the_judging_reason(self):  # CR-A4
        with self.db() as db:
            work = testsupport.publish_work(db, C, kind="practice", questions=[
                {"id": "p1", "type": "predict", "prompt": "print('hello')", "answer": '[1] "hello"', "points": 1}])
        self.request(f"/api/work/{work.id}/check?classId={C}", "POST", {"studentId": "demo-ada", "questionId": "p1",
                     "answer": '[1] "Hello"'}, student="demo-ada")
        with self.db() as db:
            payload = json.loads(event_rows(db, "demo-ada", ("answer_submitted",))[0]["payload_json"])
        self.assertEqual((payload["correct"], payload["reason"]), (False, "case_mismatch"))


class ChangeRequestTests(ApiTestCase):
    """Applied change requests whose behavior crosses workstreams."""

    def test_workstream_migrations_are_applied_once(self):  # CR-A1, CR-AIRULES-3, CR-T1, CR-T5, AIRULES D10
        with app.connection() as db:
            applied = migrations.applied_versions(db)
            for version in ("0.6.0-assess-001-indexes", "0.6.0-airules-001-indexes", "0.6.0-telemetry-001-health"):
                self.assertIn(version, applied)
            indexes = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
            self.assertTrue({"idx_drafts_assignment", "idx_assignments_starter", "idx_assignments_revision",
                             "idx_ai_test_samples_scope"} <= indexes)
            self.assertIn("native_tutoring_mode", dbmod.table_columns(db, "kiwi_sync"))
            self.assertTrue(dbmod.table_exists(db, "event_ingest_stats"))
            self.assertEqual(migrations.run(db), [])  # nothing pending on the second run

    def test_duplicates_are_counted_as_ingest_stats_not_rejections(self):  # CR-T5
        event = {"classId": "local-r-class", "studentId": "demo-ada", "sessionId": "tab", "type": "page_view", "schemaVersion": 2,
                 "eventId": "evt-dup-1", "payload": {"route": "/student/code"}}
        statuses = [self.request("/api/events?classId=local-r-class", "POST", event, student="demo-ada")[0] for _ in range(3)]
        self.assertEqual(statuses, [201, 200, 200])
        with app.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM event_rejections").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT SUM(count) FROM event_ingest_stats WHERE kind='duplicate'").fetchone()[0], 2)
        status, health = self.request("/api/teacher/data-health?classId=local-r-class", key=TEACHER_KEY)
        self.assertEqual(status, 200, health)
        self.assertEqual((health["events"]["duplicatesIgnored"], health["events"]["rejected"]), (2, []))

    def test_kiwi_chat_mode_survives_a_restart(self):  # CR-T5
        with app.connection() as db:
            with dbmod.write_tx(db):
                kiwi_bridge._apply_metadata(db, "live-course", {"appConfig": {"tutoringMode": "guidance", "source": "class_override"},
                                                               "roster": [], "excludedByDesign": 3}, False)
        kiwi_bridge._app_config.clear()  # a new process has no live value
        with app.connection() as db:
            state = kiwi_bridge.status(db, "live-course")
        self.assertEqual((state["nativeTutoringMode"], state["nativeTutoringModeSource"], state["excludedByDesign"]),
                         ("guidance", "class_override", 3))

    def test_streamed_export_access_log_counts_rows(self):  # CR-P1
        with app.connection() as db:
            for sid in ("demo-ada", "demo-bo"):
                testsupport.add_roster(db, "local-r-class", sid, display_name=sid)
        for sid in ("demo-ada", "demo-bo"):
            self.request("/api/events?classId=local-r-class", "POST", {"classId": "local-r-class", "studentId": sid, "sessionId": "t",
                         "type": "code_run", "schemaVersion": 2, "payload": {"code": "1", "ok": True}}, student=sid)
        status, body = self.request("/api/teacher/exports/activity.csv?classId=local-r-class", key=TEACHER_KEY)
        self.assertEqual(status, 200)
        rows = int(self.last_headers["X-Export-Rows"])
        self.assertGreaterEqual(rows, 2)
        with app.connection() as db:
            logged = db.execute("SELECT row_count FROM data_access_log WHERE endpoint LIKE '%activity.csv' ORDER BY id DESC").fetchone()
        self.assertEqual(logged[0], rows)

    def test_init_db_interrupts_stale_pending_ai_calls(self):  # CR-AIRUN-1, AIRUN-24
        with app.connection() as db:
            with dbmod.write_tx(db):
                old = dbmod.iso_seconds(dbmod.utcnow() - timedelta(minutes=30))
                db.execute("""INSERT INTO ai_calls (request_id, class_id, student_id, actor_role, is_preview, identity_verified, action,
                    surface, policy_source, platform_rules_version, status, requested_at)
                    VALUES ('req-stale', 'c1', 'demo-ada', 'demo', 0, 0, 'chat', 'ask-kiwi', 'platform', 'platform-rules-v2',
                    'pending', ?)""", (old,))
        app.init_db()
        with app.connection() as db:
            self.assertEqual(db.execute("SELECT status FROM ai_calls WHERE request_id='req-stale'").fetchone()[0], "interrupted")

    def test_public_policy_practice_counts_come_from_the_enforcer(self):  # CR-AIRUN-4 (AIRULES open question 2)
        self.create_course(C)
        with app.connection() as db:
            testsupport.make_free_item_attempt(db, C, "demo-ada", "r-basics")
            testsupport.make_similar_attempt(db, C, "demo-ada", testsupport.publish_work(db, C, due_at=FUTURE).id, "q1")
        status, policy = self.request(f"/api/policy?classId={C}&unitId=r-basics", student="demo-ada")
        self.assertEqual(status, 200, policy)
        status, practice = self.request(f"/api/practice/status?classId={C}&unitId=r-basics", student="demo-ada")
        self.assertEqual(status, 200, practice)
        self.assertEqual((policy["practice"]["usedToday"], policy["practice"]["unlockedMaxDifficulty"]),
                         (practice["usedToday"], practice["unlockedMaxDifficulty"]))
        self.assertEqual(practice["usedToday"], 2)

    def test_server_owned_events_are_enforced_by_default(self):  # INTEGRATION-05
        self.assertEqual(event_schema.SERVER_OWNED_MODE, "enforce")
        base = {"classId": "local-r-class", "studentId": "demo-ada", "sessionId": "tab", "payload": {"prompt": "x"}}
        status, body = self.request("/api/events?classId=local-r-class", "POST", {**base, "type": "ai_question"}, student="demo-ada")
        self.assertEqual((status, body["code"]), (422, "server_owned_event"))
        status, body = self.request("/api/events?classId=local-r-class", "POST",
                                    {**base, "type": "answer_submitted", "schemaVersion": 2, "eventId": "evt-so-2",
                                     "payload": {"answer": "4", "correct": True}}, student="demo-ada")
        self.assertEqual((status, body["code"]), (422, "server_owned_event"))
        status, body = self.request("/api/events?classId=local-r-class", "POST",
                                    {**base, "type": "answer_submitted", "payload": {"answer": "4", "correct": True}}, student="demo-ada")
        self.assertEqual(status, 201)  # a v1 (v0.5.1 client) answer is kept as a client report
        with app.connection() as db:
            self.assertEqual(db.execute("SELECT checked_by FROM events WHERE id=?", (body["id"],)).fetchone()[0], "client")


class LegacyRejudgeTests(ApiTestCase):
    """INTEGRATION-07 [AU-D1-06, TH04]: a v0.5.1 check stored correct is re-judged with the real judging-v2."""

    def test_case_mismatch_is_rejudged_incorrect_and_leaves_auto_checked_accuracy(self):
        self.assertEqual(judging.JUDGING_VERSION, "judging-v2")
        with app.connection() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Ada")
            self.create_course("c1")
            practice = testsupport.publish_work(db, "c1", kind="practice", questions=[
                {"id": "p1", "type": "predict", "prompt": "print('hello')", "answer": '[1] "hello"', "points": 1}])
            db.execute("UPDATE assignments SET updated_at='2026-10-01T00:00:00+00:00'")
            cur = db.execute(
                "INSERT INTO events (class_id, student_id, student_name, session_id, event_type, question_id, payload_json, created_at, "
                "schema_version) VALUES ('c1','s1','Ada','browser','answer_submitted','p1',?,?,1)",
                (json.dumps({"assignmentId": practice.id, "answer": '[1] "Hello"', "correct": True}), "2026-10-14T10:05:00+00:00"))
            legacy_id = cur.lastrowid
            db.execute("DELETE FROM telemetry_meta WHERE version LIKE 'sessions-v3%' OR version LIKE 'legacy-rejudge:%'")
            db.commit()
            telemetry.init(db)
            row = db.execute("SELECT checked_by, rejudged_correct FROM events WHERE id=?", (legacy_id,)).fetchone()
            self.assertEqual(tuple(row), ("legacy_server", 0))
            self.assertTrue(telemetry.rebuild_done(db, "legacy-rejudge:judging-v2"))
        status, metrics = self.request("/api/teacher/metrics?classId=c1", key=TEACHER_KEY)
        self.assertEqual(status, 200, metrics)
        self.assertIn(metrics["autoCheckedAccuracy"]["value"], (0, 0.0))


class LocalPracticeTests(ApiTestCase):
    """§18 step 7 coverage gap (local_templates.py was 74%): practice without AI, AIRUN-10/28, read-only use."""

    def test_templates_are_deterministic_and_well_formed_for_every_chapter_and_type(self):
        for unit in sorted(local_templates.BUILTIN_UNITS):
            for qtype in ("fill", "choice", "predict", "explain", "complete"):
                with self.subTest(unit=unit, qtype=qtype):
                    item = local_templates.template_item(unit, qtype, 3, f"seed-{unit}")
                    self.assertEqual(item, local_templates.template_item(unit, qtype, 3, f"seed-{unit}"))  # reproducible
                    self.assertTrue(item["title"] and item["prompt"] and item["answer"] and item["explanation"])
                    if qtype == "choice":
                        self.assertIn(item["answer"], item["choices"])
                    if qtype == "complete":
                        self.assertIn("____", item["starterCode"])
                        self.assertTrue(item["expectedOutput"])
                    if qtype == "explain":
                        self.assertIn("rubric", item)
        easy = local_templates.template_item("r-basics", "predict", 1, "s")
        hard = local_templates.template_item("r-basics", "predict", 5, "s")
        self.assertIn("mean(scores)", easy["code"])
        self.assertIn("scores > mean(scores)", hard["code"])

    def test_similar_templates_follow_the_source_question(self):
        item, qtype = local_templates.similar_template({"prompt": "Compute the average of x"}, "custom", "choice", 2, "s1")
        self.assertEqual((qtype, item["title"]), ("choice", "Calculate a vector mean"))
        item, qtype = local_templates.similar_template({"prompt": "", "starterCode": "x <- seq(1, 10, by = 3)"}, "custom", "fill", 2, "s2")
        self.assertEqual((qtype, item["answer"]), ("predict", "4"))
        item, qtype = local_templates.similar_template({"prompt": "Count edges"}, "network-analysis", "fill", 2, "s3")
        self.assertEqual(item["answer"], 'sum(to == "B")')
        self.assertIsNone(local_templates.similar_template({"prompt": "Count edges"}, "custom-chapter", "fill", 2, "s4"))

    def test_teacher_bank_serves_only_exercises_that_are_not_running(self):
        questions = [
            {"id": "q1", "type": "complete", "prompt": "Print the mean.", "points": 1, "choices": [], "starterCode": "x <- 1:3",
             "answer": "2", "referenceCode": "x <- 1:3\nprint(mean(x))", "expectedOutput": "[1] 2", "explanation": ""},
            {"id": "q2", "type": "choice", "prompt": "Pick 4.", "points": 1, "choices": ["3", "4"], "starterCode": "",
             "answer": "4", "acceptedAnswers": [str(i) for i in range(30)], "explanation": "", "studentExplanation": "Four."},
            {"id": "q3", "type": "text", "prompt": "Explain.", "points": 1, "choices": [], "starterCode": "", "answer": "x",
             "explanation": ""},
        ]
        now = dbmod.utcnow()
        old = (now - timedelta(days=8)).isoformat()
        with self.db() as db:
            running = testsupport.publish_work(db, "local-r-class", kind="practice", title="Running", questions=questions)
            db.execute("UPDATE assignments SET frozen_at=? WHERE id=?", ((now - timedelta(days=1)).isoformat(), running.id))
            frozen = testsupport.publish_work(db, "local-r-class", kind="practice", title="Frozen long ago", questions=questions)
            db.execute("UPDATE assignments SET frozen_at=? WHERE id=?", (old, frozen.id))
            closed = testsupport.publish_work(db, "local-r-class", kind="practice", title="Closed", questions=questions,
                                              close_at=(now - timedelta(hours=1)).isoformat())
            archived = testsupport.publish_work(db, "local-r-class", kind="practice", title="Archived", questions=questions, status="draft")
            db.execute("UPDATE assignments SET archived_at=? WHERE id=?", (old, archived.id))
            draft = testsupport.publish_work(db, "local-r-class", kind="practice", title="Draft", questions=questions, status="draft")
            testsupport.publish_work(db, "local-r-class", kind="homework", title="Homework", questions=questions)
            db.commit()
            served = {rec.title for rec, _ in local_templates.bank_questions(db, "local-r-class", "r-basics")}
            self.assertEqual(served, {"Frozen long ago", "Closed", "Archived"})  # never Running, Draft or homework
            self.assertNotIn(draft.title, served)
            self.assertTrue(all(q["type"] != "text" for _, q in local_templates.bank_questions(db, "local-r-class", "r-basics")))
            item, qtype, rec = local_templates.bank_item(db, "local-r-class", "r-basics", "complete", ["choice"], "seed")
            self.assertEqual(qtype, "complete")
            self.assertEqual(item["answer"], "x <- 1:3\nprint(mean(x))")  # reference code, not the expected value
            self.assertEqual((item["expectedOutput"], item["starterCode"]), ("[1] 2", "x <- 1:3"))
            item, qtype, _ = local_templates.bank_item(db, "local-r-class", "r-basics", "predict", ["choice"], "seed")
            self.assertEqual((qtype, item["choices"], len(item["acceptedAnswers"]), item["explanation"]), ("choice", ["3", "4"], 20, "Four."))
            self.assertIsNone(local_templates.bank_item(db, "local-r-class", "r-basics", "predict", ["explain"], "seed"))
            self.assertIsNone(local_templates.bank_item(db, "local-r-class", "data-wrangling", "choice", ["choice"], "seed"))

    def test_webr_package_allowlist(self):
        self.assertTrue(webr_packages.is_allowed("dplyr"))
        self.assertFalse(webr_packages.is_allowed("not-a-course-package"))
        self.assertFalse(webr_packages.is_allowed(None))


class WiringTests(unittest.TestCase):
    """Cross-workstream links and copy that must agree between server and client."""

    @classmethod
    def setUpClass(cls) -> None:
        source = (ROOT / "src/lib/routes.ts").read_text()
        cls.patterns = re.findall(r'pattern: "(/teacher/[^"]*)"', source)
        cls.grading_query = set(re.search(r"grading: \(q: \{([^}]*)\}", source).group(1).replace("?", "").replace(" ", "")
                                .split(";")) - {""}
        cls.grading_keys = {part.split(":")[0] for part in cls.grading_query}

    def matches(self, url: str) -> bool:
        path = urlsplit(url).path
        for pattern in self.patterns:
            regex = "^" + re.sub(r":[A-Za-z]+", "[^/]+", pattern) + "$"
            if re.match(regex, path):
                return True
        return False

    def test_server_built_teacher_links_resolve_to_client_routes(self):
        paths = roster.student_paths("demo ada/1")
        urls = [paths["profile"], paths["timeline"], paths["assignment"]("work-1"), attention._href_profile("s1"),
                attention._href_timeline("s1"), attention._href_timeline("s1", "work-1"), grading._timeline_url("s1", "work-1"),
                grading_rules._timeline_href("s1", "work-1"), grading._grading_url(assignmentId="w1", show="all", studentId="s1"),
                "/teacher/grading?studentId=s1&show=late"]
        self.assertGreater(len(self.patterns), 25)
        for url in urls:
            self.assertTrue(self.matches(url), url)
        for url in ("/teacher/grading?studentId=s1&show=late",
                    "/teacher/grading?assignmentId=w1&show=all&studentId=s1&submissionId=sub-1"):
            keys = set(dict(p.split("=") for p in urlsplit(url).query.split("&")))
            self.assertLessEqual(keys, self.grading_keys, url)  # ToGradePage reads these query keys

    def test_question_activity_rule_is_the_same_text_on_both_sides(self):  # TELEMETRY-09, AU-D4-M8
        client = (ROOT / "src/teacher/insights/explorerColumns.ts").read_text()
        self.assertIn(json.dumps(telemetry.QUESTION_ACTIVITY_RULE, ensure_ascii=False), client.replace("\n", ""))
        for page in ("src/teacher/insights/QuestionActivityPage.tsx", "src/teacher/insights/ActivityExplorerPage.tsx"):
            self.assertIn("QUESTION_ACTIVITY_RULE", (ROOT / page).read_text(), page)

    def test_section_19_4_rows_name_existing_tests(self):  # INTEGRATION-03, AU-T-17
        rows = [
            ("server/test_core.py", "test_course_put_keeps_referenced_chapters"),
            ("server/test_telemetry.py", "test_code_run_300k_output_truncated_not_rejected"),
            ("server/test_telemetry.py", "test_heartbeat_bucket_counts_once_two_threads"),
            ("server/test_kiwi_bridge.py", "test_sync_route_with_roster_metadata_after_migration"),
            ("server/test_kiwi_bridge.py", "test_material_route_writes_map_not_payload"),
            ("server/test_core.py", "test_standalone_student_cannot_read_or_write_other_student"),
            ("server/test_core.py", "test_staff_requires_preview_on_student_routes"),
            ("scripts/local-kiwi/bridge/lab-bridge.controller.spec.ts", "projects new types"),
            ("scripts/local-kiwi/bridge/lab-bridge.controller.spec.ts", "filters by userId"),
            ("scripts/local-kiwi/bridge/lab-bridge.controller.spec.ts", "returns consent"),
            ("scripts/local-kiwi/bridge/lab-bridge.controller.spec.ts", "counts excluded records"),
            ("scripts/local-kiwi/verify-integration.mjs", "INTEGRATION-06"),
            ("scripts/local-kiwi/bridge/CssLabHostPatches.test.tsx", "hides chat while unavailable"),
            ("scripts/local-kiwi/bridge/CssLabHostPatches.test.tsx", "returns to the requested path after login"),
            ("scripts/local-kiwi/run-bridge-tests.mjs", "Skipped bridge tests: .local/kiwi and .local/kiwi-ui are not set up"),
            ("server/test_core.py", "test_init_db_twice_on_snapshots"),
        ]
        for path, name in rows:
            text = (ROOT / path).read_text()
            if path.endswith(".py"):
                self.assertRegex(text, rf"def {re.escape(name)}\(", f"{path} › {name}")
            else:
                self.assertIn(name, text, f"{path} › {name}")
        package = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(package["scripts"]["test:bridge"], "node scripts/local-kiwi/run-bridge-tests.mjs")


if __name__ == "__main__":
    unittest.main()
