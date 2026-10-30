"""AI runtime (AIRUN): chat pipeline, provenance, guard, enforcement, failures, capacity primitives, call detail.

The first two tests were moved from server/test_app.py by FOUNDATION (KEEP: chat persistence and the novelty retry,
still 400 ``not_novel`` after two copies). Every other test uses fake providers (``app.ai.invoke`` patched) and empty
API keys — the real provider is never called.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import unittest
from contextlib import closing
from unittest.mock import patch

from server import ai_policy, ai_runtime, app, leak_guard, readers, testsupport
from server import db as dbmod
from server.contracts import AiError
from server.testsupport import TEACHER_KEY, ApiTestCase

C = "c1"
LIVE_PROMPT = "计算 c(2, 4, 6) 的平均值，填写一个数字。"
LIVE_FILL = {"id": "q1", "type": "fill", "prompt": LIVE_PROMPT, "points": 10, "choices": [], "starterCode": "", "answer": "4",
             "explanation": ""}
LEAK = "So mean(c(2, 4, 6)) returns 4"
FUTURE = "2099-01-01T00:00:00+00:00"


class Fake:
    """Fake provider for ``app.ai.invoke``: returns/raises queued replies, records calls, fills usage meta."""

    def __init__(self, *replies: object, latency: float = 0.0, check=None, default: object = "Try a smaller example first.") -> None:
        self.replies = list(replies)
        self.default = default
        self.latency = latency
        self.check = check
        self.calls: list[dict] = []
        self.lock = threading.Lock()

    def __call__(self, request, class_id, student_id, meta=None):
        with self.lock:
            self.calls.append({"request": request, "classId": class_id, "studentId": student_id})
            reply = self.replies.pop(0) if self.replies else self.default
        if self.check is not None:
            self.check(request)
        if self.latency:
            time.sleep(self.latency)
        if isinstance(meta, dict):
            meta.update(response_id=f"resp-{len(self.calls)}", input_tokens=120, output_tokens=40, reasoning_tokens=0)
        if isinstance(reply, BaseException):
            raise reply
        return reply

    @property
    def count(self) -> int:
        return len(self.calls)


class AirunCase(ApiTestCase):
    """Base: course ``c1`` (default chapters, current = ch03), AI marked available, budgets and slots reset."""

    def setUp(self) -> None:
        super().setUp()
        app.ai._rates.reset()
        app.ai._slots.configure(slots=4, wait_s=20, max_waiters=32)
        self.create_course(C)
        self._available = patch.object(app.ai, "available", return_value=True)
        self._available.start()

    def tearDown(self) -> None:
        self._available.stop()
        app.ai._rates.reset()
        app.ai._slots.configure(slots=4, wait_s=20, max_waiters=32)
        super().tearDown()

    def homework(self, questions=None, **kwargs):
        with self.db() as db:
            return testsupport.publish_work(db, C, questions=questions or [LIVE_FILL], due_at=kwargs.pop("due_at", FUTURE), **kwargs)

    def chat(self, prompt: str, *, surface: str = "ask-kiwi", unit: str = "r-basics", student: str = "demo-ada",
             thread: str | None = None, **extra) -> tuple[int, dict]:
        client_addr = extra.pop("client_addr", None)
        body = {"studentId": student, "unitId": unit, "threadId": thread or f"thread-{surface}-{unit}", "prompt": prompt,
                "surface": surface, **extra}
        return self.request(f"/api/ai/chat?classId={C}", "POST", body, student=student, client_addr=client_addr)

    def rows(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self.db() as db:
            return db.execute(sql, params).fetchall()

    def save_policy(self, unit_id: str, **config) -> int:
        with self.db() as db, dbmod.write_tx(db):
            return ai_policy.save_version(db, C, "unit", unit_id, "", ai_policy.with_defaults(config),
                                          created_by="instructor", created_by_role="instructor")["id"]


class AiRuntimeTests(ApiTestCase):
    def test_chat_is_persistent_course_scoped_and_policy_bound(self):
        self.register_class("chat")  # standalone student writes need a registered course
        body = {
            "studentId": "s1",
            "unitId": "r-basics",
            "threadId": "thread-q1",
            "questionId": "q1",
            "prompt": "Why does mean return NA?",
            "code": "print(mean(c(1,NA)))",
        }
        with patch.object(app.ai, "invoke", return_value="Check missing values with is.na()."):
            self.assertEqual(self.request("/api/ai/chat?classId=chat", "POST", body, student="s1")[0], 200)
        _, history = self.request("/api/chat?classId=chat&studentId=s1&threadId=thread-q1", student="s1")
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["prompt"], body["prompt"])
        _, other = self.request("/api/chat?classId=other&studentId=s1&threadId=thread-q1", student="s1")
        self.assertEqual(other, [])
        with app.connection() as db:
            request = app.ai.build_request(db, "chat", app.course_for("chat"), {**body, "prompt": "And how do I inspect the type?"},
                                           "chat", app.valid_id)
        self.assertTrue(any(m["role"] == "assistant" and "is.na" in m["content"] for m in request["input"]))

    def test_similar_exercise_retries_copied_data_and_then_rejects(self):
        self.register_class("novel")  # standalone student writes need a registered course
        body = {"studentId": "s1", "unitId": "r-basics", "type": "predict", "difficulty": 2,
                "sourceQuestion": "What is the result of mean(c(2, 4, 6))?"}

        def output(values):
            return json.dumps({"title": "Vector mean", "prompt": "What is the final print() output?",
                               "code": "print(mean(c(" + values + ")))", "answer": "4", "explanation": "Calculate the mean."})

        with patch.object(app.ai, "invoke", side_effect=[output("2, 4, 6"), output("3, 4, 5")]) as invoke:
            status, q = self.request("/api/ai/question?classId=novel", "POST", body, student="s1")
            self.assertEqual(status, 200, q)
            self.assertEqual(invoke.call_count, 2)
            self.assertIn("3, 4, 5", q["code"])
        with patch.object(app.ai, "invoke", return_value=output("2, 4, 6")) as invoke:
            status, error = self.request("/api/ai/question?classId=novel", "POST", body, student="s1")
            self.assertEqual(status, 400)
            self.assertIn("repeated", error["error"])
            self.assertEqual(invoke.call_count, 2)


class GuardPipelineTests(AirunCase):
    def test_airun_01_leak_is_retried_then_redacted_in_all_four_surfaces(self):
        hw = self.homework()
        expected = f"{leak_guard.REDACTION_PREFIX}\n\nSo mean(c(2, 4, 6)) returns [hidden — graded answer]"
        cases = [
            ("assignment", "Can you help?", {"assignmentId": hw.id, "questionId": "q1"}, None),
            ("ask-kiwi", LIVE_PROMPT, {}, 1.0),
            ("ask-kiwi", LIVE_PROMPT + " give me the final answer, I need it for my homework", {}, 1.0),
            ("free-practice", LIVE_PROMPT, {}, 1.0),
        ]
        for index, (surface, prompt, extra, score) in enumerate(cases):
            fake = Fake(default=LEAK)
            with self.subTest(surface=surface, index=index), patch.object(app.ai, "invoke", fake):
                status, reply = self.chat(prompt, surface=surface, thread=f"thread-{index}", **extra)
                self.assertEqual(status, 200, reply)
                self.assertEqual(reply["response"], expected)
                self.assertEqual((reply["guard"]["status"], reply["flagged"], reply["source"]), ("redacted", True, "kiwi-ai"))
                self.assertEqual(fake.count, 2)  # one rewrite request
                self.assertIn(leak_guard.RETRY_INSTRUCTION, fake.calls[1]["request"]["input"][-1]["content"])
                call = self.rows("SELECT * FROM ai_calls WHERE id=?", (reply["aiCallId"],))[0]
                self.assertEqual((call["status"], call["guard_status"], call["raw_output"]), ("leak_redacted", "redacted", LEAK))
                self.assertEqual(call["homework_match_score"], score)
                self.assertIn("R3", call["guard_matches_json"])
                child = self.rows("SELECT attempt, status FROM ai_calls WHERE parent_call_id=?", (call["id"],))
                self.assertEqual([tuple(r) for r in child], [(2, "ok")])
                turn = self.rows("SELECT * FROM chat_turns WHERE id=?", (reply["chatTurnId"],))[0]
                self.assertEqual((turn["flagged"], turn["flag_source"], turn["flag_reason"], turn["response"]),
                                 (1, "guard", "final_answer", expected))

    def test_airun_01_rewrite_that_is_clean_is_delivered(self):
        hw = self.homework()
        fake = Fake(LEAK, "Average means sum divided by count — try sum() and length().")
        with patch.object(app.ai, "invoke", fake):
            status, reply = self.chat("help", surface="assignment", assignmentId=hw.id, questionId="q1")
        self.assertEqual(status, 200, reply)
        self.assertEqual((reply["guard"]["status"], reply["flagged"]), ("retried_clean", True))
        self.assertIn("sum()", reply["response"])
        call = self.rows("SELECT status, guard_status, raw_output FROM ai_calls WHERE id=?", (reply["aiCallId"],))[0]
        self.assertEqual(tuple(call), ("leak_retried_clean", "retried_clean", LEAK))

    def test_airun_01_paraphrase_is_a_documented_miss_and_unrelated_text_is_not_matched(self):
        self.homework()
        for prompt in ("how do I average three numbers?", "what does ggplot do?"):
            with self.subTest(prompt=prompt), patch.object(app.ai, "invoke", Fake(default=LEAK)) as fake:
                status, reply = self.chat(prompt)
                self.assertEqual(status, 200, reply)
                self.assertEqual(reply["guard"]["status"], "not_applicable")
                self.assertEqual(fake.count, 1)
                call = self.rows("SELECT homework_match_score, guard_status FROM ai_calls WHERE id=?", (reply["aiCallId"],))[0]
                self.assertEqual(tuple(call), (None, "not_applicable"))

    def test_airun_02_ask_kiwi_off_is_enforced_by_the_server(self):
        hw = self.homework(tool_policy={"askKiwi": "off", "similarPractice": False})
        fake = Fake(default=LEAK)
        with patch.object(app.ai, "invoke", fake):
            status, error = self.chat("help", surface="assignment", assignmentId=hw.id, questionId="q1")
            self.assertEqual((status, error["code"]), (403, "tool_disabled"))
            status, reply = self.chat(LIVE_PROMPT)
            self.assertEqual(status, 200, reply)
            self.assertEqual(reply["response"], leak_guard.BLOCKED_REPLY)
            self.assertEqual(reply["guard"]["status"], "blocked")
            body = {"studentId": "demo-ada", "assignmentId": hw.id, "questionId": "q1", "difficulty": 2}
            status, error = self.request(f"/api/ai/similar?classId={C}", "POST", body, student="demo-ada")
            self.assertEqual((status, error["code"]), (403, "tool_disabled"))
        self.assertEqual(fake.count, 0)
        statuses = [r["status"] for r in self.rows("SELECT status FROM ai_calls ORDER BY id")]
        self.assertEqual(statuses, ["blocked_tool_policy", "blocked_tool_policy", "blocked_tool_policy"])
        match = self.rows("SELECT homework_match_score FROM ai_calls ORDER BY id")[1][0]
        self.assertEqual(match, 1.0)

    def test_airun_04_chapter_access_is_enforced_for_chat(self):
        with patch.object(app.ai, "invoke", Fake()) as fake:
            status, error = self.chat("What is a network?", unit="network-analysis")
            self.assertEqual((status, error["code"]), (403, "chapter_closed"))
            self.assertEqual(fake.count, 0)
            course = testsupport.create_course
            with self.db() as db:
                units = [dict(u) for u in readers_units(db)]
                for unit in units:
                    if unit["id"] == "network-analysis":
                        unit["access"] = "review"
                course(db, C, units=units, current_unit_id="data-wrangling")
            status, reply = self.chat("What is a network?", unit="network-analysis")
            self.assertEqual(status, 200, reply)
        status_rows = [r["status"] for r in self.rows("SELECT status FROM ai_calls ORDER BY id")]
        self.assertEqual(status_rows, ["blocked_chapter", "ok"])

    def test_airun_04_inside_an_assignment_the_tool_policy_governs(self):
        hw = self.homework(unit_id="network-analysis", questions=[dict(LIVE_FILL, prompt="Count edges")])
        with patch.object(app.ai, "invoke", Fake()):
            status, reply = self.chat("hint?", unit="network-analysis", surface="assignment", assignmentId=hw.id, questionId="q1")
        self.assertEqual(status, 200, reply)
        self.assertEqual(reply["helpLevel"], "hints_only")


def readers_units(db):
    from server import course_config

    return course_config.course_for(C, db)["units"]


class ProvenanceTests(AirunCase):
    def test_airun_05_successful_chat_writes_call_turn_and_server_event(self):
        version_id = self.save_policy("r-basics", tutoringInstructions="TUTOR-MARK")
        hw = self.homework(tool_policy={"askKiwi": "explain_concepts"})
        fake = Fake("Look at what mean() needs.")
        with patch.object(app.ai, "invoke", fake):
            status, reply = self.chat("How should I start?", surface="assignment", assignmentId=hw.id, questionId="q1",
                                      code="x <- c(2, 4, 6)")
        self.assertEqual(status, 200, reply)
        self.assertEqual((reply["policyLabel"], reply["source"]), ("Ch 02 rules v1", "kiwi-ai"))
        call = self.rows("SELECT * FROM ai_calls WHERE id=?", (reply["aiCallId"],))[0]
        self.assertEqual((call["status"], call["model"], call["policy_version_id"], call["action"], call["surface"]),
                         ("ok", "kiwi-managed", version_id, "chat", "assignment"))
        self.assertEqual(len(call["prompt_hash"]), 64)
        self.assertEqual((call["input_tokens"], call["output_tokens"], call["openai_response_id"]), (120, 40, "resp-1"))
        self.assertIsNotNone(call["latency_ms"])
        self.assertIn("TUTOR-MARK", call["developer_text"])
        self.assertEqual(call["platform_rules_version"], "platform-rules-v2")
        turn = self.rows("SELECT * FROM chat_turns WHERE id=?", (reply["chatTurnId"],))[0]
        self.assertEqual((turn["unit_id"], turn["assignment_id"], turn["surface"], turn["ai_call_id"], turn["policy_version_id"],
                          turn["model"], turn["source"]),
                         ("r-basics", hw.id, "assignment", call["id"], version_id, "kiwi-managed", "kiwi-ai"))
        context = json.loads(turn["context_json"])
        self.assertEqual((context["assignmentKind"], context["question"], context["code"]), ("homework", LIVE_PROMPT, "x <- c(2, 4, 6)"))
        event = self.rows("SELECT * FROM events WHERE event_type='ai_question'")[0]
        self.assertEqual((event["chat_turn_id"], event["ai_call_id"], event["policy_version_id"], event["checked_by"]),
                         (turn["id"], call["id"], version_id, ""))
        payload = json.loads(event["payload_json"])
        self.assertEqual((payload["surface"], payload["aiProvider"], payload["effectiveAccess"]), ("assignment", "kiwi", "open"))

    def test_airun_05_no_api_key_returns_local_guidance_with_model_null(self):
        with patch.object(app.ai, "available", return_value=False), patch.object(app.ai, "invoke", Fake()) as fake:
            status, reply = self.chat("Why NA?")
        self.assertEqual(status, 200, reply)
        self.assertEqual(reply["source"], "local")
        self.assertIn("str()", reply["response"])
        self.assertEqual(fake.count, 0)
        turn = self.rows("SELECT model, source FROM chat_turns")[0]
        self.assertEqual(tuple(turn), (None, "local"))
        self.assertEqual(self.rows("SELECT status FROM ai_calls")[0][0], "local")
        _, history = self.request(f"/api/chat?classId={C}&studentId=demo-ada&threadId=thread-ask-kiwi-r-basics", student="demo-ada")
        self.assertEqual((history[0]["source"], history[0]["policyLabel"]), ("local", "Default rules"))

    def test_airun_06_failures_are_logged_with_status_and_event(self):
        cases = [
            (AiError(502, "ai_provider_error", "The AI service took too long to answer. Please retry.", {"reason": "timeout"}),
             502, "provider_error", "timeout", "took too long"),
            (AiError(429, "rate_limited", "The AI service is receiving too many requests.", {"reason": "provider_rate_limit"}),
             429, "rate_limited", "provider_rate_limit", "too many"),
            (AiError(503, "ai_busy", "Kiwi is busy right now."), 503, "busy", "ai_busy", "busy"),
            (AiError(502, "ai_incomplete", "AI output was incomplete."), 502, "incomplete", "ai_incomplete", "incomplete"),
        ]
        for index, (error, http, status, code, message) in enumerate(cases):
            with self.subTest(status=status), patch.object(app.ai, "invoke", Fake(error)):
                got, body = self.chat(f"question {index}", thread=f"t-{index}")
                self.assertEqual(got, http)
                self.assertIn(message, body["error"].lower())
                call = self.rows("SELECT id, status, error_code FROM ai_calls ORDER BY id DESC LIMIT 1")[0]
                self.assertEqual((call["status"], call["error_code"]), (status, code))
                event = self.rows("SELECT payload_json, ai_call_id FROM events WHERE event_type='ai_request_failed' "
                                  "ORDER BY id DESC LIMIT 1")[0]
                self.assertEqual((json.loads(event["payload_json"])["status"], event["ai_call_id"]), (status, call["id"]))
        self.assertEqual(self.rows("SELECT COUNT(*) FROM chat_turns")[0][0], 0)

    def test_airun_06_generation_invalid_json_and_not_novel_are_logged(self):
        with patch.object(app.ai, "invoke", Fake("not json", "still not json")):
            status, error = self.request(f"/api/ai/question?classId={C}", "POST",
                                         {"studentId": "demo-ada", "unitId": "r-basics", "type": "fill", "difficulty": 2,
                                          "surface": "free-practice"}, student="demo-ada")
        self.assertEqual((status, error["code"]), (502, "ai_invalid_output"))
        parent = self.rows("SELECT status FROM ai_calls WHERE parent_call_id IS NULL ORDER BY id DESC LIMIT 1")[0]
        self.assertEqual(parent["status"], "invalid_output")
        failed = self.rows("SELECT payload_json FROM events WHERE event_type='ai_request_failed'")
        self.assertEqual(json.loads(failed[-1]["payload_json"])["status"], "invalid_output")
        self.assertEqual(self.rows("SELECT COUNT(*) FROM generated_items WHERE status='rejected_invalid'")[0][0], 2)

    def test_airun_12_context_fields_and_surface_threads(self):
        self.save_policy("r-basics", contextFields=["code", "error", "output", "answer"])
        fake = Fake("ok", "ok")
        with patch.object(app.ai, "invoke", fake):
            status, _ = self.chat("Why the error?", surface="workspace", thread="thread-workspace-r-basics", code="mean(x)",
                                  error="object 'x' not found", runOutput="[1] NA", answerDraft="my draft")
            self.assertEqual(status, 200)
        context = json.loads(fake.calls[0]["request"]["input"][3]["content"].split(": ", 1)[1])
        self.assertEqual((context["code"], context["error"], context["output"], context["answer"]),
                         ("mean(x)", "object 'x' not found", "[1] NA", "my draft"))
        self.save_policy("r-basics", contextFields=["code"])
        with patch.object(app.ai, "invoke", fake):
            self.chat("Again?", surface="workspace", thread="thread-workspace-r-basics", code="mean(x)", error="boom")
        context = json.loads(fake.calls[1]["request"]["input"][3]["content"].split(": ", 1)[1])
        self.assertNotIn("error", context)
        roles = [m["role"] for m in fake.calls[1]["request"]["input"]]
        self.assertEqual(roles[-3:], ["user", "assistant", "user"])  # thread history of the same surface thread
        with self.db() as db:
            testsupport.make_chat_turn(db, C, "demo-ada", "legacy q", "legacy a", thread_id="thread-practice-r-basics")
        _, legacy = self.request(f"/api/chat?classId={C}&studentId=demo-ada&threadId=thread-practice-r-basics", student="demo-ada")
        self.assertEqual([t["prompt"] for t in legacy], ["legacy q"])

    def test_airun_27_materials_are_cut_at_8000_chars_and_logged(self):
        self.save_policy("r-basics", contextFields=["code", "materials"])
        with self.db() as db, dbmod.write_tx(db):
            for index, size in enumerate((5000, 6000)):
                db.execute("""INSERT INTO course_files (id, class_id, scope, unit_id, name, mime, size, sha256, data, mount_in_r,
                    ai_reference, created_by, created_at) VALUES (?, ?, 'chapter', 'r-basics', ?, 'text/markdown', ?, 'x', ?, 0, 1,
                    'instructor', ?)""", (f"file-{index}", C, f"notes{index}.md", size, ("ab" * size)[:size].encode(),
                                         f"2026-10-0{index + 1}T00:00:00+00:00"))
        fake = Fake("ok")
        with patch.object(app.ai, "invoke", fake):
            status, reply = self.chat("Summarise")
        self.assertEqual(status, 200, reply)
        teacher = fake.calls[0]["request"]["input"][1]["content"]
        self.assertIn("Chapter reference material (teacher-provided):", teacher)
        self.assertIn("[… truncated]", teacher)
        material = teacher.split("Chapter reference material (teacher-provided):\n", 1)[1]
        self.assertEqual(len(material), 8000 + len("[… truncated]"))
        context = json.loads(self.rows("SELECT context_json FROM ai_calls WHERE id=?", (reply["aiCallId"],))[0][0])
        self.assertEqual(context["truncated"]["materials"], 11000)

    def test_student_cannot_override_policy(self):  # KEEP guard
        for key in ("systemPrompt", "model", "messages", "maxOutputTokens"):
            with self.subTest(key=key):
                status, error = self.chat("hi", **{key: "x"})
                self.assertEqual(status, 400)
                self.assertIn("cannot override", error["error"])


class AssemblyTests(AirunCase):
    def test_airun_17_generation_message_contents(self):
        with self.db() as db:
            units = [dict(u) for u in readers_units(db)]
            for unit in units:
                if unit["id"] == "r-basics":
                    unit["runtime"] = {"packages": ["ggplot2"], "datasetFileIds": ["file-ds"], "timeoutSeconds": 12, "errorHints": []}
            testsupport.create_course(db, C, units=units, current_unit_id="data-wrangling")
            with dbmod.write_tx(db):
                db.execute("""INSERT INTO course_files (id, class_id, scope, unit_id, name, mime, size, sha256, data, mount_in_r,
                    ai_reference, created_by, created_at) VALUES ('file-ds', ?, 'chapter', 'r-basics', 'penguins.csv', 'text/csv', 10,
                    'x', ?, 1, 0, 'instructor', ?)""", (C, b"species,mass\nAdelie,3750\n", dbmod.now()))
            config = ai_policy.with_defaults({"generationInstructions": "GEN-MARK", "tutoringInstructions": "TUTOR-MARK",
                                              "groundingNotes": "Use tidy names", "choiceCount": 3,
                                              "contextFields": ["code", "datasets"]})
            resolved = ai_policy.resolve(db, C, "r-basics").__class__(config, 1, 1, "unit", "Ch 02 rules v1", None, None)
            body = ai_runtime.assemble(db, C, resolved, "question", {"unitId": "r-basics", "type": "choice", "difficulty": 3,
                                                                    "answer": "SECRET-REFERENCE"})
            chat = ai_runtime.assemble(db, C, resolved, "chat", {"unitId": "r-basics", "prompt": "hi"})
        teacher, server = body["input"][1]["content"], body["input"][2]["content"]
        self.assertIn("GEN-MARK", teacher)
        self.assertNotIn("TUTOR-MARK", teacher)
        self.assertIn("TUTOR-MARK", chat["input"][1]["content"])
        self.assertIn("R packages available in this chapter: ggplot2", teacher)
        self.assertNotIn("Use only base R", json.dumps(body))
        self.assertIn("Reference notes:\nUse tidy names", teacher)
        self.assertIn("3: Combine two steps", teacher)
        self.assertIn("Datasets available: penguins.csv (species, mass)", teacher)
        self.assertIn("exactly 3 distinct choices", server)
        self.assertIn("Reply in English.", body["input"][0]["content"])
        self.assertNotIn("SECRET-REFERENCE", json.dumps(body))
        with self.db() as db:
            plain = ai_runtime.assemble(db, C, ai_policy.resolve(db, C, "css-intro"), "question", {"unitId": "css-intro", "type": "fill"})
        self.assertIn("base R only", plain["input"][1]["content"])


class ProtectionReaderTests(AirunCase):
    """AIRUN-19: readers.answer_protected over the assignment states that matter for the guard."""

    def protected(self, rec, student="demo-ada", now=None):
        with self.db() as db:
            return readers.answer_protected(db, readers.load_assignment(db, C, rec.id), student, now)

    def test_airun_19_protection_states(self):
        past = "2026-01-01T00:00:00+00:00"
        self.assertTrue(self.protected(self.homework(due_at=past, late_policy={"mode": "accept_marked"})))
        self.assertFalse(self.protected(self.homework(due_at=past, late_policy={"mode": "not_accepted"},
                                                      solutions_visibility="after_due")))
        self.assertTrue(self.protected(self.homework(due_at=past, late_policy={"mode": "not_accepted"}, solutions_visibility="never")))
        archived = self.homework()
        with self.db() as db:
            db.execute("UPDATE assignments SET archived_at=? WHERE id=?", (past, archived.id))
            db.commit()
        self.assertFalse(self.protected(archived))
        after_submit = self.homework(solutions_visibility="after_submit")
        with self.db() as db:
            testsupport.make_autochecked_submission(db, C, "demo-bo", after_submit.id, {"q1": "4"})
        self.assertFalse(self.protected(after_submit, "demo-bo"))
        self.assertTrue(self.protected(after_submit, "demo-ada"))
        with self.db() as db:
            group = testsupport.make_group(db, C, "section", "A", ["demo-bo"])
        targeted = self.homework(audience={"type": "groups", "groupIds": [group]})
        self.assertFalse(self.protected(targeted, "demo-ada"))
        self.assertTrue(self.protected(targeted, "demo-bo"))


class StaffEndpointTests(AirunCase):
    def test_airun_21_call_detail_and_unflag(self):
        hw = self.homework()
        with patch.object(app.ai, "invoke", Fake(default=LEAK)):
            _, reply = self.chat("help", surface="assignment", assignmentId=hw.id, questionId="q1")
        call_id, turn_id = reply["aiCallId"], reply["chatTurnId"]
        status, detail = self.request(f"/api/teacher/ai/calls/{call_id}?classId={C}", key=TEACHER_KEY)
        self.assertEqual(status, 200, detail)
        self.assertEqual((detail["rawOutput"], detail["guard"]["status"], detail["status"]), (LEAK, "redacted", "leak_redacted"))
        self.assertIn("platform-rules-v2", detail["developerText"])
        self.assertEqual(detail["guard"]["matches"][0]["rule"], "R3")
        self.assertIsInstance(detail["contextJson"], dict)
        self.assertEqual(len(detail["retries"]), 1)
        self.assertEqual(self.request(f"/api/teacher/ai/calls/{call_id}?classId={C}", student="demo-ada")[0], 403)
        access = self.rows("SELECT category, endpoint FROM data_access_log ORDER BY id DESC LIMIT 1")[0]
        self.assertEqual(access["category"], "conversations")
        for role in ("ta", "viewer"):
            with self.db() as db, dbmod.write_tx(db):
                from server import auth

                key = auth.new_staff_key()
                db.execute("INSERT INTO staff (id, class_id, display_name, role, key_hash, key_prefix, created_by, created_at) "
                           "VALUES (?, ?, ?, ?, ?, ?, 'instructor', ?)",
                           (f"staff-{role}00000000"[:18], C, f"Test {role}", role, auth.hash_staff_key(key), auth.key_prefix(key),
                            dbmod.now()))
            with self.subTest(role=role):
                self.assertEqual(self.request(f"/api/teacher/ai/calls/{call_id}?classId={C}", key=key)[0], 200)
                status, _ = self.request(f"/api/teacher/ai/turns/{turn_id}/unflag?classId={C}", "POST", {"reason": "fp"}, key=key)
                self.assertEqual(status, 200 if role == "ta" else 403)
        turn = self.rows("SELECT flagged, guard_status, flag_source, flag_updated_by FROM chat_turns WHERE id=?", (turn_id,))[0]
        self.assertEqual(tuple(turn), (0, "redacted", "guard", "Test ta"))
        audit = self.rows("SELECT action, target_type, target_id FROM teacher_actions WHERE action='turn_unflag'")
        self.assertEqual([tuple(a) for a in audit], [("turn_unflag", "chat_turn", str(turn_id))])
        status, flagged = self.request(f"/api/teacher/ai/turns/{turn_id}/flag?classId={C}", "POST", {"reason": "wrong"}, key=TEACHER_KEY)
        self.assertEqual((status, flagged["flagged"], flagged["flagSource"]), (200, True, "staff"))
        self.assertEqual(self.request(f"/api/teacher/ai/turns/999999/flag?classId={C}", "POST", {}, key=TEACHER_KEY)[0], 404)


class CapacityTests(AirunCase):
    def test_airun_23_per_address_limit_for_standalone_classes(self):
        with patch.dict("os.environ", {"KIWI_AI_PER_IP_PER_MINUTE": "5"}), patch.object(app.ai, "invoke", Fake()):
            codes = [self.chat(f"q{i}", thread=f"t{i}", client_addr="10.0.0.1")[0] for i in range(6)]
            self.assertEqual(codes, [200] * 5 + [429])
            self.assertEqual(self.chat("other address", client_addr="10.0.0.2")[0], 200)
        statuses = [r[0] for r in self.rows("SELECT status FROM ai_calls ORDER BY id")]
        self.assertEqual(statuses.count("rate_limited"), 1)

    def test_airun_23_linked_classes_are_not_address_limited(self):
        with self.db() as db:
            budget_keys = []
            ident = testsupport.preview_identity(C)
            with patch.object(app.ai._rates, "reserve", side_effect=lambda limits: (budget_keys.append(limits), (True, []))[1]):
                with patch("server.identity.class_linked", return_value=True):
                    ai_runtime.reserve_budget(db, ident, C, "10.0.0.1")
                ai_runtime.reserve_budget(db, ident, C, "10.0.0.1")
        self.assertEqual([len(k) for k in budget_keys], [2, 3])

    def test_airun_24_two_phase_logging_without_open_transaction(self):
        seen = {}

        def check(request):
            db = ai_runtime.current_db()
            seen["in_transaction"] = db.in_transaction
            with closing(sqlite3.connect(app.DB_PATH, timeout=0.5)) as other:
                seen["status"] = other.execute("SELECT status FROM ai_calls ORDER BY id DESC LIMIT 1").fetchone()[0]
                other.execute("BEGIN IMMEDIATE")  # would time out if the request held a write transaction
                other.execute("ROLLBACK")
            started = time.monotonic()
            status, _ = self.request(f"/api/events?classId={C}", "POST", {
                "classId": C, "studentId": "demo-bo", "sessionId": "s1", "type": "code_run", "payload": {"ok": True}},
                student="demo-bo")
            seen["events"] = (status, time.monotonic() - started)

        self.demo_session(C, "demo-bo")
        with patch.object(app.ai, "invoke", Fake(check=check)):
            status, _ = self.chat("hello")
        self.assertEqual(status, 200)
        self.assertEqual((seen["in_transaction"], seen["status"]), (False, "pending"))
        self.assertIn(seen["events"][0], (200, 201))
        self.assertLess(seen["events"][1], 1.0)

    def test_airun_24_stale_pending_rows_become_interrupted(self):
        with self.db() as db:
            ident = testsupport.preview_identity(C)
            with testsupport.freeze_time("2026-10-22T00:00:00+00:00"):
                old = ai_runtime.log_call(db, ident, C, action="chat", surface="ask-kiwi", status="pending")
            with testsupport.freeze_time("2026-10-22T00:09:00+00:00"):
                fresh = ai_runtime.log_call(db, ident, C, action="chat", surface="ask-kiwi", status="pending")
            with testsupport.freeze_time("2026-10-22T00:12:00+00:00"):
                self.assertEqual(ai_runtime.init(db), 1)
            rows = dict(db.execute("SELECT id, status FROM ai_calls").fetchall())
        self.assertEqual((rows[old], rows[fresh]), ("interrupted", "pending"))

    def test_airun_24_busy_maps_to_503_and_atomic_budget(self):
        with patch.object(app.ai, "invoke", Fake(AiError(503, "ai_busy", "Kiwi is busy right now."))):
            status, error = self.chat("busy?")
        self.assertEqual((status, error["code"]), (503, "ai_busy"))
        testsupport_settings = {"ai": {"perStudentPerMinute": 3, "classPerMinute": 120}}
        with self.db() as db:
            testsupport.update_settings(db, C, testsupport_settings)
        app.ai._rates.reset()
        fake = Fake(latency=0.2)
        results: list[int] = []
        self.demo_session(C, "demo-ada")

        def one(i):
            results.append(self.chat(f"parallel {i}", thread=f"p{i}")[0])

        with patch.object(app.ai, "invoke", fake):
            threads = [threading.Thread(target=one, args=(i,)) for i in range(10)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(fake.count, 3)
        self.assertEqual(sorted(results), [200] * 3 + [429] * 7)

    def test_airun_24_busy_requests_refund_their_budget(self):
        with self.db() as db:
            testsupport.update_settings(db, C, {"ai": {"perStudentPerMinute": 2, "classPerMinute": 120}})
        app.ai._slots.configure(slots=1, wait_s=0.05)
        self.demo_session(C, "demo-ada")
        results: list[int] = []
        fake = Fake(latency=0.6)

        def one(i):
            results.append(self.chat(f"slow {i}", thread=f"s{i}")[0])

        with patch.object(app.ai, "invoke", fake):
            first = threading.Thread(target=one, args=(0,))
            first.start()
            time.sleep(0.2)
            one(1)  # waits 50 ms for the only slot → busy, budget refunded
            first.join()
            app.ai._slots.configure(slots=1, wait_s=5)
            one(2)  # 1 used + 1 refunded: still within perStudentPerMinute=2
        self.assertEqual(results, [503, 200, 200])
        self.assertEqual([r[0] for r in self.rows("SELECT status FROM ai_calls ORDER BY id")], ["ok", "busy", "ok"])

    def test_airun_11_second_request_waits_for_the_slot(self):
        app.ai._slots.configure(slots=1, wait_s=20)
        self.demo_session(C, "demo-ada")
        results: list[tuple[int, float]] = []

        def one(i):
            started = time.monotonic()
            status, _ = self.chat(f"wait {i}", thread=f"w{i}")
            results.append((status, time.monotonic() - started))

        with patch.object(app.ai, "invoke", Fake(latency=0.5)):
            threads = [threading.Thread(target=one, args=(i,)) for i in range(2)]
            for thread in threads:
                thread.start()
                time.sleep(0.05)
            for thread in threads:
                thread.join()
        self.assertEqual([s for s, _ in results], [200, 200])
        queue = [r[0] for r in self.rows("SELECT queue_ms FROM ai_calls ORDER BY id")]
        self.assertGreaterEqual(max(queue), 300)

    def test_capacity_primitives(self):
        budget = app.ai.RateBudget()
        ok, reservation = budget.reserve([(("s", 1), 2), (("c", 1), 3)])
        self.assertTrue(ok)
        self.assertTrue(budget.reserve([(("s", 1), 2), (("c", 1), 3)])[0])
        ok, key = budget.reserve([(("s", 1), 2), (("c", 1), 3)])
        self.assertEqual((ok, key), (False, ("s", 1)))
        self.assertEqual(budget.count(("c", 1)), 2)  # rejected reservations record nothing
        budget.refund(reservation)
        self.assertEqual(budget.count(("s", 1)), 1)
        slots = app.ai.Capacity(1, 0.01, max_waiters=0)
        self.assertEqual(slots.acquire(), 0)
        self.assertIsNone(slots.acquire())
        slots.release()
        self.assertEqual(slots.acquire(), 0)


if __name__ == "__main__":
    unittest.main()
