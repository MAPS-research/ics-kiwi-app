"""AI conversations: digest, threads, coding, codebook, topic rules (INSIGHTS-05, -17, -22 server side, §13.5).

``chat_turns`` rows come from ``testsupport.make_chat_turn`` (AIRUN's writer), native turns from
``testsupport.make_native_event`` (TELEMETRY's importer); a v0.5.1 client ``ai_question`` without a turn is a legacy
client-only record.
"""

import json
import os
import unittest
from unittest.mock import patch

from server import db as dbmod
from server import testsupport
from server.test_insights import KEY, client_event, q
from server.testsupport import ApiTestCase


class ConversationTests(ApiTestCase):
    cls = "convo"

    def setUp(self) -> None:
        super().setUp()
        self.create_course(self.cls)
        with self.db() as db:
            for sid, name in (("s1", "Ada Chen"), ("s2", "Bo Li"), ("s3", "Cy Wu")):
                testsupport.add_roster(db, self.cls, sid, display_name=name)
            self.hw = testsupport.publish_work(db, self.cls, title="Week 3 Homework")
            self.t1 = testsupport.make_chat_turn(db, self.cls, "s1", "Why does merge drop rows?", "Check the keys.", thread_id="t1",
                                                 assignment_id=self.hw.id, question_id="q1", surface="assignment",
                                                 at="2026-10-21T01:00:00+00:00")
            testsupport.make_chat_turn(db, self.cls, "s2", "why does merge drop rows", "Look at unmatched keys.", thread_id="t9",
                                       at="2026-10-21T01:10:00+00:00")
            testsupport.make_chat_turn(db, self.cls, "s3", "Why does merge() drop some rows?", "Compare key columns.", thread_id="t3",
                                       at="2026-10-21T01:20:00+00:00", flagged=True, guard_status="redacted", flag_reason="R1 final answer")
            testsupport.make_chat_turn(db, self.cls, "s1", "How do I plot a histogram?", "Use hist().", thread_id="t1",
                                       at="2026-10-21T01:30:00+00:00")
            # v0.5.1 client copy of the first turn (matched → hidden) and a client-only record (legacy badge); such rows
            # predate the INTEGRATION-05 `enforce` cut-over, so they are written in `accept` mode.
            with patch.dict(os.environ, {"KIWI_SERVER_OWNED_EVENTS": "accept"}):
                client_event(db, self.cls, "s1", "ai_question", {"prompt": "Why does merge drop rows?", "response": "Check the keys.",
                                                                 "threadId": "t1", "ok": True}, at="2026-10-21T01:00:30+00:00")
                client_event(db, self.cls, "s2", "ai_question", {"prompt": "What is a tibble?", "response": "A data frame.",
                                                                 "threadId": "old", "ok": True}, at="2026-10-21T01:40:00+00:00")
            testsupport.make_native_event(db, self.cls, "s2", prompt="What is a left join?", response="It keeps all left rows.",
                                          at="2026-10-21T01:50:00.000Z")

    def get(self, path: str, **params):
        status, body = self.request(f"{path}?{q(classId=self.cls, **params)}", key=KEY)
        self.assertEqual(status, 200, body)
        return body

    def test_digest_clusters_topics_flags_and_recent(self):
        first = self.get("/api/teacher/ai-conversations/digest")
        second = self.get("/api/teacher/ai-conversations/digest")
        self.assertEqual(first, second)  # deterministic clustering
        top = first["repeated"][0]
        self.assertEqual((top["prompt"], top["students"], top["occurrences"]), ("Why does merge drop rows?", 3, 3))
        self.assertEqual([e["studentName"] for e in top["examples"]], ["Ada Chen", "Bo Li", "Cy Wu"])
        self.assertEqual(len(first["repeated"]), 1)  # single-student prompts are not "repeated"
        topics = {t["label"]: t for t in first["topics"]}
        self.assertEqual((topics["Joins and keys"]["turns"], topics["Joins and keys"]["students"]), (4, 3))
        self.assertEqual([f["studentName"] for f in first["flagged"]], ["Cy Wu"])
        self.assertEqual(first["flagged"][0]["reason"], "R1 final answer")
        wheres = {r["where"] for r in first["recent"]}
        self.assertEqual(wheres, {"lab", "kiwi"})
        self.assertEqual(first["recent"][0]["prompt"], "What is a left join?")
        # RT-03: a shortened label carries the full assignment title for its tooltip
        merge = next(r for r in first["recent"] if r["prompt"] == "Why does merge drop rows?")
        self.assertEqual((merge["assignmentLabel"], merge["assignmentTitle"]), ("HW3 Q1", "Week 3 Homework Q1"))
        self.assertEqual(first["recent"][0]["assignmentTitle"], first["recent"][0]["assignmentLabel"])  # no assignment
        ranged = self.get("/api/teacher/ai-conversations/digest", **{"from": "2026-10-21T01:15:00+00:00", "to": "2026-10-21T02:00:00+00:00"})
        self.assertEqual(ranged["repeated"], [])  # the global range applies (no page-specific default)
        status, masked = self.request(f"/api/teacher/ai-conversations/digest?classId={self.cls}", key=KEY, name_mode="pseudonyms")
        self.assertEqual(status, 200)
        self.assertTrue(all(e["studentName"].startswith("S-") for e in masked["repeated"][0]["examples"]))

    def test_topic_rules_are_editable_and_drive_digest_topics(self):
        rules = [{"label": "Plotting", "keywords": ["plot", "Histogram"]}]
        status, saved = self.request(f"/api/teacher/topic-rules?classId={self.cls}", "PUT", rules, key=KEY)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved, [{"label": "Plotting", "keywords": ["plot", "histogram"]}])
        self.assertEqual(self.get("/api/teacher/topic-rules"), saved)
        self.assertEqual(self.get("/api/teacher/ai-conversations/digest")["topics"], [{"label": "Plotting", "turns": 1, "students": 1}])
        for bad in ([{"label": "", "keywords": ["x"]}], [{"label": "A", "keywords": []}], {"label": "A"}):
            self.assertEqual(self.request(f"/api/teacher/topic-rules?classId={self.cls}", "PUT", bad, key=KEY)[0], 400)

    def test_threads_list_filters_and_legacy_client_records(self):
        data = self.get("/api/teacher/ai-conversations/threads")
        keys = {t["threadKey"]: t for t in data["threads"]}
        self.assertEqual(data["total"], 5)
        self.assertIn("lab:s1:t1", keys)
        self.assertEqual(keys["lab:s1:t1"]["turns"], 2)  # the matched v0.5.1 client copy is not a second turn
        self.assertEqual(keys["lab:s1:t1"]["assignmentLabel"], "HW3 Q1")
        self.assertEqual(keys["lab:s1:t1"]["studentName"], "Ada Chen")
        self.assertIn("lab:s2:old", keys)
        self.assertIn("kiwi:native-thread", keys)
        self.assertEqual(keys["kiwi:native-thread"]["where"], "kiwi")
        legacy = self.get("/api/teacher/ai-conversations/threads/lab:s2:old")
        self.assertTrue(legacy["turns"][0]["legacyClientRecord"])
        flagged = self.get("/api/teacher/ai-conversations/threads", flagged="1")
        self.assertEqual([t["threadKey"] for t in flagged["threads"]], ["lab:s3:t3"])
        mine = self.get("/api/teacher/ai-conversations/threads", studentId="s1")
        self.assertEqual([t["threadKey"] for t in mine["threads"]], ["lab:s1:t1"])
        self.assertEqual(self.request(f"/api/teacher/ai-conversations/threads/lab:s9:none?classId={self.cls}", key=KEY)[0], 404)

    def test_thread_detail_provenance_guard_and_native_feedback(self):
        with self.db() as db:
            native = db.execute("SELECT id FROM events WHERE class_id = ? AND source = 'kiwi' AND event_type = 'ai_question'",
                                (self.cls,)).fetchone()[0]
            with dbmod.write_tx(db):
                db.execute("""INSERT INTO ai_responses (class_id, upstream_action_id, upstream_interaction_id, event_id, action_type,
                    engine_choice, bot_response, responded_at, imported_at) VALUES (?, 'act-1', 'int-1', ?, 'chat', 'gpt-4o', 'It keeps…',
                    '2026-10-21T01:50:05.000+00:00', '2026-10-21T01:51:00.000+00:00')""", (self.cls, native))
                db.execute("""INSERT INTO events (class_id, student_id, student_name, session_id, event_type, payload_json, created_at,
                    source, upstream_id, received_at, actor_role, identity_verified, practice_mode, category)
                    VALUES (?, 's2', '', 'native-session', 'ai_feedback', ?, '2026-10-21T01:52:00.000+00:00', 'kiwi', 'fb-1',
                    '2026-10-21T01:52:00.000+00:00', 'student', 1, 'kiwi', 'action')""",
                           (self.cls, json.dumps({"conversationId": "native-thread", "targetMessageIndex": 0, "value": 1,
                                                  "reply": None})))
        lab = self.get("/api/teacher/ai-conversations/threads/lab:s3:t3")
        turn = lab["turns"][0]
        self.assertEqual(turn["provenance"]["ai"], "Lab AI tutor")
        self.assertEqual((turn["provenance"]["policyLabel"], turn["provenance"]["model"]), ("Default rules", "gpt-5.4-mini"))
        self.assertIsInstance(turn["aiCallId"], int)
        self.assertEqual((turn["guard"], turn["flagged"], turn["flagSource"]), ("redacted", True, "guard"))
        kiwi = self.get("/api/teacher/ai-conversations/threads/kiwi:native-thread")
        native_turn = kiwi["turns"][0]
        self.assertEqual(native_turn["provenance"], {"where": "kiwi", "ai": "Kiwi lecture AI"})
        self.assertEqual(native_turn["feedback"], [{"value": 1, "reply": None, "at": "2026-10-21T01:52:00.000+00:00"}])
        self.assertEqual(kiwi["summary"]["studentName"], "Bo Li")

    def test_codebook_and_coding_round_trip(self):
        status, code = self.request(f"/api/teacher/codebook?classId={self.cls}", "POST",
                                    {"label": "Asks for answer", "description": "Wants the final answer", "color": "warning"}, key=KEY)
        self.assertEqual(status, 201, code)
        self.assertEqual(self.request(f"/api/teacher/codebook?classId={self.cls}", "POST", {"label": "asks for answer"}, key=KEY)[0], 400)
        status, applied = self.request(f"/api/teacher/ai-conversations/codes?classId={self.cls}", "POST",
                                       {"threadKey": "lab:s1:t1", "chatTurnId": self.t1, "codeId": code["id"], "note": "clear case"},
                                       key=KEY)
        self.assertEqual(status, 201, applied)
        self.assertEqual(applied["coder"], "Instructor (local key)")
        coded = self.get("/api/teacher/ai-conversations/threads", codeId=code["id"])
        self.assertEqual([t["threadKey"] for t in coded["threads"]], ["lab:s1:t1"])
        self.assertEqual(coded["threads"][0]["codes"], ["Asks for answer"])
        uncoded = self.get("/api/teacher/ai-conversations/threads", uncoded="1")
        self.assertNotIn("lab:s1:t1", [t["threadKey"] for t in uncoded["threads"]])
        nxt = self.get("/api/teacher/ai-conversations/next-uncoded", current="lab:s1:t1")["threadKey"]
        self.assertIn(nxt, [t["threadKey"] for t in uncoded["threads"]])
        detail = self.get("/api/teacher/ai-conversations/threads/lab:s1:t1")
        self.assertEqual(detail["turns"][0]["codes"][0]["codeId"], code["id"])
        status, _ = self.request(f"/api/teacher/ai-conversations/codes?classId={self.cls}", "POST",
                                 {"threadKey": "lab:s2:t9", "chatTurnId": self.t1, "codeId": code["id"]}, key=KEY)
        self.assertEqual(status, 400)  # that turn belongs to another thread
        status, _ = self.request(f"/api/teacher/ai-conversations/codes/{applied['id']}?classId={self.cls}", "DELETE", key=KEY)
        self.assertEqual(status, 204)
        self.assertEqual(self.get("/api/teacher/ai-conversations/threads/lab:s1:t1")["turns"][0]["codes"], [])
        status, archived = self.request(f"/api/teacher/codebook/{code['id']}?classId={self.cls}", "PATCH", {"archived": True}, key=KEY)
        self.assertEqual((status, archived["archived"]), (200, True))
        with self.db() as db:
            actions = [r[0] for r in db.execute("SELECT action FROM teacher_actions WHERE class_id = ? ORDER BY id", (self.cls,))]
        self.assertEqual(actions, ["codebook_create", "conversation_code_add", "conversation_code_remove", "codebook_update"])

    def test_home_shows_flagged_replies_once_the_guard_ran(self):
        home = self.get("/api/teacher/home")
        self.assertEqual(home["needsAction"]["flaggedReplies"], 1)
        self.assertEqual(home["askedAi"]["flaggedFinalAnswer"], 1)
        self.assertEqual(home["askedAi"]["repeated"][0]["students"], 3)


if __name__ == "__main__":
    unittest.main()
