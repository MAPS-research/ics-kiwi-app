"""Generated practice items (AIRUN): persistence, redaction, server checks, reveal/withholding, verify without oracle,
unlock rule, deterministic shuffle, novelty extensions, local templates and the teacher bank. Fake providers only."""

from __future__ import annotations

import itertools
import json
import unittest
from collections import Counter
from unittest.mock import patch

from server import ai_runtime, app, generated_items, local_templates, testsupport
from server import db as dbmod
from server.test_ai_runtime import C, FUTURE, LIVE_FILL, LIVE_PROMPT, AirunCase, Fake
from server.testsupport import TEACHER_KEY

KEYS = ("answer", "explanation", "expectedOutput", "acceptedAnswers", "rubric")


def item_json(kind: str = "fill", **fields) -> str:
    base = {"fill": {"title": "Mean", "prompt": "Fill the gap to compute the mean of y.", "code": "y <- c(3, 5, 7)\nm <- ____",
                     "answer": "mean(y)", "acceptedAnswers": ["mean( y )"], "explanation": "mean() averages the values."},
            "choice": {"title": "Pick", "prompt": "What does sum(c(1, 2)) return?", "choices": ["3", "12", "1", "2"], "answer": "3",
                       "explanation": "1 + 2 = 3."},
            "predict": {"title": "Predict", "prompt": "What does the final print() show?", "code": "z <- c(10, 20)\nprint(sum(z))",
                        "answer": "30", "explanation": "10 + 20."},
            "explain": {"title": "Explain", "prompt": "Explain what na.rm = TRUE changes in mean().",
                        "answer": "It drops missing values before averaging.", "explanation": "Missing values make mean() NA.",
                        "rubric": "Mentions NA; mentions removal before computing."},
            "complete": {"title": "Complete", "prompt": "Complete the code to print the length.",
                         "starterCode": "v <- c(1, 2, 3)\nprint(____)", "answer": "length(v)", "expectedOutput": "3",
                         "explanation": "length() counts elements."}}[kind]
    return json.dumps({**base, **fields})


class ItemCase(AirunCase):
    def generate(self, *, unit="r-basics", kind="fill", difficulty=2, focus="", student="demo-ada", body=None):
        payload = body or {"studentId": student, "unitId": unit, "type": kind, "difficulty": difficulty, "surface": "free-practice",
                           **({"focusNote": focus} if focus else {})}
        return self.request(f"/api/ai/question?classId={C}", "POST", payload, student=student)

    def similar(self, hw, question_id="q1", difficulty=2, student="demo-ada", **extra):
        body = {"studentId": student, "assignmentId": hw.id, "questionId": question_id, "difficulty": difficulty, **extra}
        return self.request(f"/api/ai/similar?classId={C}", "POST", body, student=student)

    def check(self, item_id, answer, student="demo-ada", **extra):
        return self.request(f"/api/practice/items/{item_id}/check?classId={C}", "POST", {"answer": answer, **extra}, student=student)


class PersistenceTests(ItemCase):
    def test_airun_07_item_is_stored_in_full_and_served_without_keys(self):
        version = self.save_policy("r-basics", generationInstructions="GEN")
        with patch.object(app.ai, "invoke", Fake(item_json("fill"))):
            status, item = self.generate(focus="logical indexing")
        self.assertEqual(status, 200, item)
        for key in KEYS:
            self.assertNotIn(key, item)
        self.assertEqual((item["origin"], item["type"], item["source"], item["policyLabel"]), ("free", "fill", "ai", "Ch 02 rules v1"))
        self.assertTrue(item["id"].startswith("gi-"))
        row = self.rows("SELECT * FROM generated_items WHERE id=?", (item["id"],))[0]
        stored = json.loads(row["item_json"])
        self.assertEqual((stored["answer"], stored["explanation"], stored["acceptedAnswers"]),
                         ("mean(y)", "mean() averages the values.", ["mean( y )"]))
        self.assertEqual((row["requested_type"], row["requested_difficulty"], row["focus_note"], row["policy_version_id"],
                          row["model"], row["novelty_retries"], row["source"], row["status"]),
                         ("fill", 2, "logical indexing", version, "kiwi-managed", 0, "ai", "active"))
        self.assertIsNotNone(row["ai_call_id"])
        call = self.rows("SELECT status, item_id, action FROM ai_calls WHERE id=?", (row["ai_call_id"],))[0]
        self.assertEqual(tuple(call), ("ok", item["id"], "question"))
        event = json.loads(self.rows("SELECT payload_json FROM events WHERE event_type='question_generated'")[0][0])
        self.assertEqual((event["focusNote"], event["requestedType"], event["requestedDifficulty"], event["itemId"]),
                         ("logical indexing", "fill", 2, item["id"]))  # AIRUN-13
        status, listing = self.request(f"/api/teacher/ai/items?classId={C}", key=TEACHER_KEY)
        self.assertEqual(status, 200, listing)
        self.assertEqual(listing["total"], 1)
        listed = listing["items"][0]
        self.assertEqual((listed["item"]["answer"], listed["policyLabel"], listed["studentName"]), ("mean(y)", "Ch 02 rules v1", "Ada Chen"))
        self.assertEqual(self.request(f"/api/teacher/ai/items?classId={C}", student="demo-ada")[0], 403)

    def test_teacher_review_filters_flag_retire(self):
        with patch.object(app.ai, "invoke", Fake(item_json("fill"), item_json("predict"))):
            _, first = self.generate()
            _, second = self.generate(kind="predict")
        status, flagged = self.request(f"/api/teacher/ai/items/{first['id']}/flag?classId={C}", "POST", {"note": "wrong key"},
                                       key=TEACHER_KEY)
        self.assertEqual((status, flagged["status"], flagged["flagNote"]), (200, "flagged", "wrong key"))
        status, retired = self.request(f"/api/teacher/ai/items/{second['id']}/retire?classId={C}", "POST", {}, key=TEACHER_KEY)
        self.assertEqual((status, retired["status"]), (200, "retired"))
        _, only_flagged = self.request(f"/api/teacher/ai/items?classId={C}&status=flagged", key=TEACHER_KEY)
        self.assertEqual([i["id"] for i in only_flagged["items"]], [first["id"]])
        _, unverified = self.request(f"/api/teacher/ai/items?classId={C}&verification=unverified", key=TEACHER_KEY)
        self.assertEqual([i["id"] for i in unverified["items"]], [second["id"]])
        status, restored = self.request(f"/api/teacher/ai/items/{second['id']}/restore?classId={C}", "POST", {}, key=TEACHER_KEY)
        self.assertEqual(restored["status"], "active")
        actions = [r[0] for r in self.rows("SELECT action FROM teacher_actions ORDER BY id")]
        self.assertEqual(actions, ["item_flag", "item_retire", "item_restore"])


class CheckTests(ItemCase):
    def test_airun_08_server_decides_correctness(self):
        with patch.object(app.ai, "invoke", Fake(item_json("fill"))):
            _, item = self.generate()
        status, wrong = self.check(item["id"], "sum(y)", timeOnItemMs=4200)
        self.assertEqual((status, wrong["correct"], wrong["attemptIndex"]), (200, False, 1))
        self.assertNotIn("explanation", wrong)
        status, right = self.check(item["id"], "mean( y )")
        self.assertEqual((right["correct"], right["attemptIndex"], right["explanation"]), (True, 2, "mean() averages the values."))
        events = self.rows("SELECT checked_by, item_id, practice_mode, payload_json FROM events WHERE event_type='answer_submitted' "
                           "ORDER BY id")
        self.assertEqual([(e["checked_by"], e["item_id"], e["practice_mode"]) for e in events],
                         [("server", item["id"], "free")] * 2)
        payload = json.loads(events[0]["payload_json"])
        self.assertEqual((payload["attemptIndex"], payload["timeOnItemMs"]), (1, 4200))  # AIRUN-13
        session = self.rows("SELECT checked, correct FROM learning_sessions WHERE itemId=? OR questionId=?", (item["id"], item["id"]))
        self.assertEqual((sum(r["checked"] for r in session), sum(r["correct"] for r in session)), (2, 1))
        self.assertEqual(self.check(item["id"], "x", student="demo-bo")[0], 403)
        self.assertEqual(self.check("gi-000000000000000000000000", "x")[0], 404)

    def test_check_replay_with_event_id_is_not_counted_twice(self):
        with patch.object(app.ai, "invoke", Fake(item_json("fill"))):
            _, item = self.generate()
        first = self.check(item["id"], "sum(y)", eventId="evt-check-1")[1]
        again = self.check(item["id"], "sum(y)", eventId="evt-check-1")[1]
        self.assertEqual((first["attemptIndex"], again["attemptIndex"]), (1, 1))
        self.assertEqual(self.rows("SELECT COUNT(*) FROM events WHERE event_type='answer_submitted'")[0][0], 1)

    def test_airun_13_reveal_after_three_wrong_checks(self):
        self.save_policy("r-basics", feedback={"revealAfterAttempts": 3, "showExplanationOnWrong": False})
        with patch.object(app.ai, "invoke", Fake(item_json("fill"))):
            _, item = self.generate()
        reveal = f"/api/practice/items/{item['id']}/reveal?classId={C}"
        for attempt in range(3):
            self.assertEqual(self.request(reveal, "POST", {}, student="demo-ada")[0], 403)
            result = self.check(item["id"], f"wrong {attempt}")[1]
        self.assertTrue(result["canReveal"])
        status, shown = self.request(reveal, "POST", {}, student="demo-ada")
        self.assertEqual((status, shown["answer"]), (200, "mean(y)"))
        event = json.loads(self.rows("SELECT payload_json FROM events WHERE event_type='answer_revealed'")[0][0])
        self.assertEqual(event["attemptIndex"], 3)

    def test_airun_14_explain_items_get_ai_feedback(self):
        self.save_policy("r-basics", allowedTypes=["explain", "fill"])
        fake = Fake(item_json("explain"), "Good: you mention NA. Add that values are removed first.")
        with patch.object(app.ai, "invoke", fake):
            status, item = self.generate(kind="explain")
            self.assertEqual(status, 200, item)
            self.assertIn("rubric", fake.calls[0]["request"]["input"][2]["content"])
            status, result = self.check(item["id"], "It ignores NA values.")
        self.assertEqual((status, result["correct"]), (200, None))
        self.assertIn("mention NA", result["feedback"])
        payload = json.loads(self.rows("SELECT payload_json FROM events WHERE event_type='answer_submitted'")[0][0])
        self.assertIn("mention NA", payload["feedback"])
        actions = [r[0] for r in self.rows("SELECT action FROM ai_calls ORDER BY id")]
        self.assertEqual(actions, ["question", "feedback"])

    def test_complete_items_use_the_run_output(self):
        with patch.object(app.ai, "invoke", Fake(item_json("complete"))):
            _, item = self.generate(kind="complete")
        self.assertEqual(self.check(item["id"], "print(length(v))")[0], 400)  # no run output
        status, result = self.check(item["id"], "v <- c(1, 2, 3)\nprint(length(v))", runOutput="[1] 3")
        self.assertEqual((status, result["correct"]), (200, True))
        payload = json.loads(self.rows("SELECT payload_json FROM events WHERE event_type='answer_submitted'")[0][0])
        self.assertEqual(payload["basis"], "client_run_output")


class VerifyTests(ItemCase):
    def test_airun_16_verify_once_without_oracle(self):
        with patch.object(app.ai, "invoke", Fake(item_json("predict"), item_json("predict", code="w <- c(1, 2)\nprint(sum(w))"))):
            _, good = self.generate(kind="predict")
            _, bad = self.generate(kind="predict")
        self.assertTrue(good["needsVerification"])
        for item, output in ((good, "[1] 30"), (bad, "[1] 3")):
            self.check(item["id"], "30")
            status, body = self.request(f"/api/practice/items/{item['id']}/verify?classId={C}", "POST",
                                        {"runOutput": output, "ok": True}, student="demo-ada")
            self.assertEqual((status, body), (200, {"recorded": True}))
        again = self.request(f"/api/practice/items/{bad['id']}/verify?classId={C}", "POST", {"runOutput": "[1] 30", "ok": True},
                             student="demo-ada")
        self.assertEqual((again[0], again[1]["code"]), (409, "already_verified"))
        rows = dict(self.rows("SELECT id, verification FROM generated_items"))
        self.assertEqual((rows[good["id"]], rows[bad["id"]]), ("verified", "mismatch"))
        self.assertEqual(self.rows("SELECT status FROM generated_items WHERE id=?", (bad["id"],))[0][0], "active")  # not auto-flagged
        later = self.check(bad["id"], "30")[1]
        self.assertEqual((later["verification"], later["verificationNotice"]), ("mismatch", generated_items.MISMATCH_NOTICE))
        _, failed = self.request(f"/api/teacher/ai/items?classId={C}&verification=mismatch", key=TEACHER_KEY)
        self.assertEqual([i["id"] for i in failed["items"]], [bad["id"]])
        self.assertEqual(failed["items"][0]["clientRunOutput"], "[1] 3")


class GuardTests(ItemCase):
    def test_airun_03_similar_choice_equal_to_homework_answer_is_rejected(self):
        hw = self.homework(questions=[{"id": "q1", "type": "complete", "prompt": "Print the mean of x ignoring NA.",
                                       "choices": [], "starterCode": "x <- c(1, NA, 3)\n____", "points": 10,
                                       "referenceCode": "print(mean(x, na.rm = TRUE))"}],
                           tool_policy={"similarPractice": True})
        leaking = item_json("choice", prompt="Which line prints the mean of y ignoring NA?",
                            choices=["print(mean(y))", "print(mean(x, na.rm = TRUE))", "print(sum(y))", "print(y)"],
                            answer="print(mean(y))")
        with patch.object(app.ai, "invoke", Fake(leaking, leaking)):
            status, error = self.similar(hw, type="choice")
        self.assertEqual((status, error["code"]), (422, "unsafe_item"))
        self.assertNotIn("pick another chapter.", error["error"])   # S-m09: the similar panel has no chapter choice
        self.assertIn("Practice with AI", error["error"])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM generated_items WHERE status='rejected_leak'")[0][0], 2)
        clean = item_json("choice", prompt="Which line sums y?", choices=["sum(y)", "mean(y)", "max(y)", "y"], answer="sum(y)")
        with patch.object(app.ai, "invoke", Fake(leaking, clean)):
            status, item = self.similar(hw, type="choice")
        self.assertEqual(status, 200, item)
        row = self.rows("SELECT guard_status, novelty_retries, related_assignment_id, origin FROM generated_items WHERE id=?",
                        (item["id"],))[0]
        self.assertEqual(tuple(row), ("retried_clean", 1, hw.id, "similar"))
        events = [r[0] for r in self.rows("SELECT event_type FROM events WHERE item_id=? ORDER BY id", (item["id"],))]
        self.assertIn("question_generated", events)
        self.assertEqual(self.rows("SELECT practice_mode, related_assignment_id FROM events WHERE event_type='similar_requested'")[0][:],
                         ("similar", hw.id))

    def test_airun_18_focus_note_matching(self):
        blocked = self.homework(tool_policy={"similarPractice": False})
        with patch.object(app.ai, "invoke", Fake()) as fake:
            status, error = self.generate(focus=LIVE_PROMPT)
        self.assertEqual((status, error["code"], fake.count), (403, "tool_disabled", 0))
        self.assertEqual(self.rows("SELECT status, homework_match_assignment_id FROM ai_calls")[0][:], ("blocked_homework_match", blocked.id))
        with self.db() as db:
            db.execute("UPDATE assignments SET tool_policy_json=? WHERE id=?",
                       (dbmod.json_dumps({"rWorkspace": True, "allowRunPredict": False, "askKiwi": "hints_only",
                                          "similarPractice": True}), blocked.id))
            db.commit()
        echo = item_json("fill", prompt="Average c(1, 3, 8)?", code="v <- c(1, 3, 8)", answer="4", acceptedAnswers=[])
        clean = item_json("fill", prompt="Average of c(2, 6, 10)?", code="v <- c(2, 6, 10)", answer="6", acceptedAnswers=[])
        with patch.object(app.ai, "invoke", Fake(echo, clean)):
            status, item = self.generate(focus=LIVE_PROMPT)
        self.assertEqual(status, 200, item)
        row = self.rows("SELECT homework_match_assignment_id, homework_match_score, guard_status FROM generated_items WHERE id=?",
                        (item["id"],))[0]
        self.assertEqual(tuple(row), (blocked.id, 1.0, "retried_clean"))
        result = self.check(item["id"], "6")[1]
        self.assertEqual((result["correct"], result["explanationWithheld"]), (True, True))
        self.assertNotIn("explanation", result)

    def test_airun_18_property_no_echoed_reference_reaches_the_student(self):
        self.homework(tool_policy={"similarPractice": True})
        returned = []
        for index in range(50):
            app.ai._rates.reset()
            echo = ["4"] if index % 2 == 0 else []  # half of the fakes echo the homework reference as a choice
            choices = echo + [str(index + k) for k in (10, 20, 30, 40)][:4 - len(echo)]
            variant = item_json("choice", prompt=f"Pick the mean of c({index}, 4, {8 - index})", choices=choices,
                                answer="4" if index % 4 == 0 else str(index + 10))
            with patch.object(app.ai, "invoke", Fake(variant, variant)):
                status, item = self.generate(kind="choice", focus=LIVE_PROMPT)
            self.assertIn(status, (200, 422), item)
            if status == 200:
                returned.append(item)
        self.assertEqual(len(returned), 25)
        for item in returned:
            stored = json.loads(self.rows("SELECT item_json FROM generated_items WHERE id=?", (item["id"],))[0][0])
            self.assertNotEqual(stored["answer"], "4")
            self.assertNotIn("4", item.get("choices", []))
        self.assertEqual(self.rows("SELECT COUNT(*) FROM generated_items WHERE status='active'")[0][0], len(returned))

    def test_airun_20_explanation_withheld_and_reveal_blocked_while_protected(self):
        self.save_policy("r-basics", feedback={"revealAfterAttempts": 1, "showExplanationOnWrong": False})
        hw = self.homework(tool_policy={"similarPractice": True})
        with patch.object(app.ai, "invoke", Fake(item_json("fill", prompt="Mean of c(1, 9)?", code="w <- c(1, 9)", answer="5",
                                                           acceptedAnswers=[]))):
            _, item = self.similar(hw)
        self.check(item["id"], "1")
        result = self.check(item["id"], "5")[1]
        self.assertEqual((result["correct"], result["explanationWithheld"], result["canReveal"]), (True, True, False))
        status, error = self.request(f"/api/practice/items/{item['id']}/reveal?classId={C}", "POST", {}, student="demo-ada")
        self.assertEqual((status, error["code"]), (403, "protected_homework"))
        with self.db() as db:
            db.execute("UPDATE assignments SET archived_at=? WHERE id=?", (dbmod.now(), hw.id))
            db.commit()
        result = self.check(item["id"], "5")[1]
        self.assertEqual((result["explanationWithheld"], result["explanation"]), (False, "mean() averages the values."))


class PolicyTests(ItemCase):
    def test_airun_04_generation_access_and_policy_bounds(self):
        with patch.object(app.ai, "invoke", Fake(item_json("fill"))) as fake:
            status, error = self.generate(unit="network-analysis")
            self.assertEqual((status, error["code"]), (403, "chapter_closed"))
            with self.db() as db:
                from server import course_config

                units = [dict(u) for u in course_config.course_for(C, db)["units"]]
                units[4]["access"] = "review"
                testsupport.create_course(db, C, units=units, current_unit_id="data-wrangling")
            status, error = self.generate(unit="network-analysis")
            self.assertEqual((status, error["code"]), (403, "generation_disabled"))
            self.save_policy("r-basics", allowedTypes=["choice"], minDifficulty=2, maxDifficulty=2, startingDifficulty=2)
            self.assertEqual(self.generate(kind="fill")[0], 400)
            self.assertEqual(self.generate(kind="choice", difficulty=4)[0], 400)
            self.assertEqual(fake.count, 0)
        statuses = [r[0] for r in self.rows("SELECT status FROM ai_calls ORDER BY id")]
        self.assertEqual(statuses, ["blocked_chapter", "blocked_generation_disabled", "validation_error", "validation_error"])
        payload = json.loads(self.rows("SELECT payload_json FROM events WHERE event_type='ai_request_failed'")[0][0])
        self.assertEqual(payload["status"], "blocked_chapter")

    def test_airun_25_unlock_rule(self):
        self.save_policy("r-basics", startingDifficulty=2, practice={"unlockAfterCorrect": 3, "allowFocusNote": True, "dailyItemLimit": 0})
        items = []
        for index in range(3):
            body = item_json("fill", prompt=f"Mean of c({index}, 10)?", code=f"v <- c({index}, 10)", answer=f"mean(v{index})",
                             acceptedAnswers=[])
            with patch.object(app.ai, "invoke", Fake(body)):
                status, item = self.generate(difficulty=2)
                self.assertEqual(status, 200, item)
                items.append(item)
        for item in items[:2]:
            self.assertTrue(self.check(item["id"], json.loads(self.rows("SELECT item_json FROM generated_items WHERE id=?",
                                                                        (item["id"],))[0][0])["answer"])[1]["correct"])
        with patch.object(app.ai, "invoke", Fake(item_json("fill"))) as fake:
            status, error = self.generate(difficulty=3)
        self.assertEqual((status, error["code"], error["details"], fake.count),
                         (403, "difficulty_locked", {"level": 3, "needed": 3, "have": 2}, 0))
        _, practice = self.request(f"/api/practice/status?classId={C}&unitId=r-basics", student="demo-ada")
        self.assertEqual(practice["unlockedMaxDifficulty"], 2)
        third = json.loads(self.rows("SELECT item_json FROM generated_items WHERE id=?", (items[2]["id"],))[0][0])["answer"]
        self.assertTrue(self.check(items[2]["id"], third)[1]["correct"])
        with patch.object(app.ai, "invoke", Fake(item_json("fill"))):
            status, item = self.generate(difficulty=3)
        self.assertEqual(status, 200, item)
        _, practice = self.request(f"/api/practice/status?classId={C}&unitId=r-basics", student="demo-ada")
        self.assertEqual((practice["unlockedMaxDifficulty"], practice["usedToday"]), (3, 4))

    def test_daily_quota(self):
        self.save_policy("r-basics", practice={"dailyItemLimit": 1, "allowFocusNote": True, "unlockAfterCorrect": 0})
        with patch.object(app.ai, "invoke", Fake(item_json("fill"), item_json("predict"))):
            self.assertEqual(self.generate()[0], 200)
            status, error = self.generate(kind="predict")
        self.assertEqual((status, error["code"]), (429, "daily_quota"))

    def test_airun_15_recent_items_are_avoided_and_near_duplicates_rejected(self):
        prompts = []
        for index in range(6):
            body = item_json("fill", prompt=f"Exercise {index}: what is the median of c({index}, 7, 9)?", code=f"v <- c({index}, 7, 9)",
                             answer=f"median(v) {index}", acceptedAnswers=[])
            fake = Fake(body)
            with patch.object(app.ai, "invoke", fake):
                status, _ = self.generate()
                self.assertEqual(status, 200)
            prompts.append(f"Exercise {index}")
        duplicate = item_json("fill", prompt="Exercise 5: what is the median of c(5, 7, 9)?", code="v <- c(5, 7, 9)",
                              answer="median(v) 5", acceptedAnswers=[])
        dup = Fake(duplicate, duplicate)
        with patch.object(app.ai, "invoke", dup):
            status, error = self.generate()
        self.assertEqual((status, error["code"]), (400, "not_novel"))
        server = dup.calls[0]["request"]["input"][2]["content"]
        self.assertIn("Avoid repeating these recent exercises:", server)
        self.assertIn("Exercise 5", server)
        self.assertIn("Exercise 1", server)
        self.assertNotIn("Exercise 0:", server)  # only the last 5

    def test_novelty_covers_character_logical_and_data_frame_literals(self):
        source = 'x <- c("a", "b", "c")\nflags <- c(TRUE, FALSE)\ndf <- data.frame(id = c(1, 2), g = c("x", "y"))'
        for code in ('y <- c("a", "b", "c")', "z <- c(TRUE, FALSE)", 'd <- data.frame(id = c(1, 2), g = c("x", "y"))'):
            self.assertFalse(ai_runtime.is_novel({"prompt": "p", "code": code}, source), code)
        self.assertTrue(ai_runtime.is_novel({"prompt": "p", "code": 'y <- c("q", "r")'}, source))


class LocalPracticeTests(ItemCase):
    def setUp(self) -> None:
        super().setUp()
        self._local = patch.object(app.ai, "available", return_value=False)
        self._local.start()

    def tearDown(self) -> None:
        self._local.stop()
        super().tearDown()

    def test_airun_10_templates_bank_and_no_local_practice(self):
        with patch.object(app.ai, "invoke", Fake()) as fake:
            status, item = self.generate(unit="r-basics", kind="choice")
            self.assertEqual((status, item["source"], len(item["choices"])), (200, "local_template", 4))
            units = [{"id": "r-basics", "title": "R", "goal": "Basics"}, {"id": "my-unit", "title": "Mine", "goal": "Own chapter"},
                     {"id": "empty-unit", "title": "Empty", "goal": "Nothing"}]
            with self.db() as db:
                testsupport.create_course(db, C, units=units, current_unit_id="empty-unit")
                exercise = testsupport.publish_work(db, C, kind="practice", unit_id="my-unit",
                                                    questions=[{"id": "b1", "type": "fill", "prompt": "Length of c(1, 2)?",
                                                                "answer": "2", "choices": [], "starterCode": ""}],
                                                    close_at="2026-01-01T00:00:00+00:00")
            status, bank = self.generate(unit="my-unit", kind="fill")
            self.assertEqual((status, bank["source"], bank["prompt"]), (200, "teacher_bank", "Length of c(1, 2)?"))
            self.assertTrue(self.check(bank["id"], "2")[1]["correct"])
            status, error = self.generate(unit="empty-unit", kind="fill")
            self.assertEqual((status, error["code"], error["error"]), (409, "no_local_practice", local_templates.NO_LOCAL_PRACTICE))
            self.assertEqual(fake.count, 0)
        self.assertIsNotNone(exercise)
        self.assertEqual(self.rows("SELECT model FROM generated_items WHERE source='teacher_bank'")[0][0], None)

    def test_airun_28_running_exercises_are_never_served(self):
        with self.db() as db:
            fresh = testsupport.publish_work(db, C, kind="practice", unit_id="text-analysis", work_id="work-fresh",
                                             questions=[{"id": "f1", "type": "fill", "prompt": "Fresh?", "answer": "1", "choices": [],
                                                         "starterCode": ""}])
            db.execute("UPDATE assignments SET frozen_at=? WHERE id=?", (dbmod.now(), fresh.id))
            old = testsupport.publish_work(db, C, kind="practice", unit_id="text-analysis", work_id="work-old",
                                           questions=[{"id": "o1", "type": "fill", "prompt": "Old?", "answer": "2", "choices": [],
                                                       "starterCode": ""}])
            db.execute("UPDATE assignments SET frozen_at='2026-01-01T00:00:00+00:00' WHERE id=?", (old.id,))
            never = testsupport.publish_work(db, C, kind="practice", unit_id="text-analysis", work_id="work-unstarted",
                                             questions=[{"id": "u1", "type": "fill", "prompt": "Unstarted?", "answer": "3",
                                                         "choices": [], "starterCode": ""}])
            db.commit()
            served = {q["id"] for _, q in local_templates.bank_questions(db, C, "text-analysis", dbmod.utcnow())}
        self.assertEqual(served, {"o1"})
        self.assertIsNotNone(never)

    def test_airun_09_seeded_shuffle_is_balanced(self):
        counter = itertools.count()
        with patch.object(generated_items, "new_item_id", side_effect=lambda: f"gi-test-{next(counter):016d}"):
            positions = Counter()
            for index in range(200):
                status, item = self.generate(unit="r-basics", kind="choice",
                                             student="demo-ada" if index % 2 else "demo-bo")
                self.assertEqual(status, 200, item)
                row = self.rows("SELECT item_json, choice_order_json, shuffle_seed FROM generated_items WHERE id=?", (item["id"],))[0]
                stored = json.loads(row["item_json"])
                positions[stored["choices"].index(stored["answer"])] += 1
                self.assertEqual(item["choices"], stored["choices"])
                self.assertEqual(row["shuffle_seed"], generated_items.shuffle_seed(item["id"]))
        for index in range(4):
            self.assertTrue(30 <= positions[index] <= 70, positions)
        app.ai._rates.reset()

    def test_local_similar_practice(self):
        hw = self.homework(tool_policy={"similarPractice": True})
        status, item = self.similar(hw)
        self.assertEqual((status, item["origin"], item["source"]), (200, "similar", "local_template"))
        self.assertNotIn("answer", item)


if __name__ == "__main__":
    unittest.main()
