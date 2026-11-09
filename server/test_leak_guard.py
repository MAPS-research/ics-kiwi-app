"""Final-answer guard (AIRUN; spec §12.5 fixture table, containment matching, redaction offsets, item mode)."""

from __future__ import annotations

import unittest

from server import leak_guard as guard
from server import testsupport
from server.testsupport import ApiTestCase

LIVE_FILL = {"id": "q1", "type": "fill", "prompt": "计算 c(2, 4, 6) 的平均值，填写一个数字。", "points": 10, "choices": [],
             "starterCode": "", "answer": "4", "explanation": ""}
LIVE_STARTER_EQ = {"id": "q2", "type": "complete", "prompt": "补全代码，打印向量的平均值。", "points": 10, "choices": [],
                   "starterCode": "x <- c(2, 4, 6)\nprint(mean(x))", "referenceCode": "x <- c(2, 4, 6)\nprint(mean(x))",
                   "answer": "x <- c(2, 4, 6)\nprint(mean(x))"}
FF365 = {"id": "q1", "type": "complete", "prompt": "Print the mean of scores.", "points": 10, "choices": [],
         "starterCode": "scores <- c(60, 75, 90)\n# TODO: print the mean", "referenceCode": "scores <- c(60, 75, 90)\nprint(mean(scores))"}
NA_RM = {"id": "q2", "type": "complete", "prompt": "Fix the code so the mean ignores the missing value.", "points": 10,
         "choices": [], "starterCode": "scores <- c(2, NA, 8)\nprint(mean(scores))",
         "referenceCode": "scores <- c(2, NA, 8)\nprint(mean(scores, na.rm = TRUE))"}
CJK_FILL = {"id": "q1", "type": "fill", "prompt": "向量 c(1, 2, 3, 4, 5) 有几个元素？", "points": 10, "choices": [],
            "starterCode": "", "answer": "5"}
SEQ_CHOICE = {"id": "q3", "type": "choice", "prompt": "Which call creates 1, 3, 5?", "points": 10,
              "choices": ["seq(1, 6)", "seq(1, 5, by = 2)", "rep(1, 3)", "c(1, 5)"], "starterCode": "", "answer": "seq(1, 5, by = 2)"}


def leaked(question: dict, reply: str) -> tuple[bool, list[str]]:
    result = guard.check_text(reply, [question])
    return result.leaked, result.rules


class NormalFormTests(unittest.TestCase):
    def test_normal_form_keeps_an_index_map_to_the_original(self):
        text = "  [1]  “Hello”\n\tWORLD  ﬁx "
        norm = guard.normal(text)
        self.assertEqual(norm.text, '"hello" world fix')
        for k, char in enumerate(norm.text):
            original = text[norm.idx[k]]
            if char == " ":
                self.assertTrue(original.isspace())
            else:
                self.assertIn(char, guard.normal(original).text or original.casefold())
        cw = guard.compact(text)
        self.assertEqual(cw.text, '"hello"worldfix')
        start, end = cw.span(cw.text.index("world"), cw.text.index("world") + 5)
        self.assertEqual(text[start:end], "WORLD")

    def test_tokens_treat_cjk_characters_as_single_tokens(self):
        self.assertEqual(guard.tokens("计算 c(2, 4)")[:4], ["计", "算", "c", "("])
        self.assertEqual(len(guard.shingles(guard.tokens("a b c d"))), 2)

    def test_jaccard_of_identical_texts_is_one(self):
        self.assertEqual(guard.jaccard("print(mean(c(1, 2, 3)))", "print(mean(c(1, 2, 3)))"), 1.0)
        self.assertLess(guard.jaccard("print(mean(c(1, 2, 3)))", "what does ggplot do?"), 0.1)


class FixtureTableTests(unittest.TestCase):
    """§12.5 unit fixtures 1–10 and 12 (LIVE ids refer to the evaluated database)."""

    def test_1_numeric_reply_redacts_only_the_final_value(self):
        reply = "So mean(c(2, 4, 6)) returns 4"
        result = guard.check_text(reply, [LIVE_FILL])
        self.assertTrue(result.leaked)
        self.assertEqual(result.rules, ["R3"])
        self.assertEqual([(m["start"], m["end"]) for m in result.matches], [(len(reply) - 1, len(reply))])
        self.assertEqual(guard.redact(reply, result),
                         f"{guard.REDACTION_PREFIX}\n\nSo mean(c(2, 4, 6)) returns [hidden — graded answer]")

    def test_2_r_output_line(self):
        self.assertEqual(leaked(LIVE_FILL, "[1] 4"), (True, ["R3"]))
        result = guard.check_text("Run it:\n[1] 4\nDone", [LIVE_FILL])
        self.assertEqual("Run it:\n[1] 4\nDone"[result.matches[0]["start"]:result.matches[0]["end"]], "4")

    def test_3_false_positive_fixtures_stay_clean(self):
        for reply in ("Try mean() with na.rm", "The vector c(2, 4, 6) has three values", "this list has 4 items"):
            self.assertEqual(leaked(LIVE_FILL, reply), (False, []), reply)

    def test_4_starter_plus_one_new_line(self):
        self.assertEqual(leaked(FF365, "Add print(mean(scores)) after the vector"), (True, ["R1'"]))

    def test_5_novel_part_and_concept_hint(self):
        self.assertEqual(leaked(NA_RM, "Use print(mean(scores, na.rm = TRUE))"), (True, ["R1'"]))
        self.assertEqual(leaked(NA_RM, "Look up the na.rm argument of mean()"), (False, []))

    def test_6_starter_equal_to_reference_is_skipped(self):
        self.assertEqual(leaked(LIVE_STARTER_EQ, "Your code is x <- c(2, 4, 6) then print(mean(x)) — run it."), (False, []))

    def test_7_cjk_context_keyword(self):
        self.assertEqual(leaked(CJK_FILL, "结果是 5"), (True, ["R3"]))
        self.assertEqual(leaked(CJK_FILL, "答案是5"), (True, ["R3"]))
        self.assertEqual(leaked(CJK_FILL, "There are 5 steps"), (False, []))

    def test_8_choice_assertion(self):
        self.assertEqual(leaked(SEQ_CHOICE, "The correct one is seq(1, 5, by = 2)"), (True, ["R4"]))
        self.assertEqual(leaked(SEQ_CHOICE, "seq(1, 5, by = 2) and seq(1, 6) both create sequences"), (False, []))
        self.assertEqual(leaked(SEQ_CHOICE, "your answer could use seq()"), (False, []))
        self.assertEqual(leaked(SEQ_CHOICE, "Pick option (b)."), (True, ["R4"]))
        self.assertEqual(leaked(SEQ_CHOICE, "Option a is a different function."), (False, []))

    def test_9_rounded_decimals(self):
        question = {"id": "q", "type": "fill", "prompt": "Mean of the scores?", "answer": "82.66667", "choices": [], "starterCode": ""}
        self.assertEqual(leaked(question, "it is 82.67"), (True, ["R3"]))
        self.assertEqual(leaked(question, "about 83"), (False, []))  # documented miss

    def test_10_signed_number(self):
        question = {"id": "q", "type": "fill", "prompt": "Smallest value?", "answer": "-3", "choices": [], "starterCode": ""}
        self.assertEqual(leaked(question, "the minimum is -3"), (True, ["R3"]))
        self.assertEqual(leaked(question, "the minimum is 3"), (False, []))

    def test_12_item_choice_equal_to_protected_code(self):
        homework = {"id": "q1", "type": "complete", "prompt": "Mean without missing values.", "choices": [],
                    "starterCode": "x <- c(1, NA, 3)\n____", "referenceCode": "print(mean(x, na.rm = TRUE))"}
        item = {"title": "Mean", "prompt": "Which line prints the mean of y ignoring NA?", "code": "y <- c(4, NA, 6)",
                "choices": ["print(mean(y))", "print(mean(x, na.rm = TRUE))", "print(sum(y))", "print(y)"],
                "answer": "print(mean(y))"}
        result = guard.check_item(item, [homework])
        self.assertTrue(result.leaked)
        self.assertIn("item_choice", result.rules)

    def test_r5_short_token_with_context(self):
        question = {"id": "q", "type": "fill", "prompt": "First token?", "answer": "social", "choices": [], "starterCode": ""}
        self.assertEqual(leaked(question, "The first token is social"), (True, ["R5"]))
        self.assertEqual(leaked(question, "Think about social data sources."), (False, []))
        logical = {"id": "q", "type": "fill", "prompt": "Is 3 > 2?", "answer": "TRUE", "choices": [], "starterCode": ""}
        self.assertEqual(leaked(logical, "[1] TRUE"), (True, ["R5"]))

    def test_r2_line_coverage(self):
        question = {"id": "q", "type": "complete", "prompt": "Summarise by group.", "choices": [], "starterCode": "library(dplyr)",
                    "referenceCode": "df %>%\n  group_by(team) %>%\n  summarise(total = sum(score))"}
        result = guard.check_text("Try this:\ngroup_by(team) %>%\nsummarise(total = sum(score))", [question])
        self.assertIn("R2", result.rules)

    def test_redaction_merges_overlaps_and_uses_original_offsets(self):
        question = {"id": "q", "type": "fill", "prompt": "Value?", "answer": "12", "choices": [], "starterCode": ""}
        reply = "The RESULT is １２ and it returns 12."  # full-width digits map back to two original characters
        result = guard.check_text(reply, [question])
        self.assertTrue(result.leaked)
        redacted = guard.redact(reply, result)
        self.assertEqual(redacted.split("\n\n", 1)[1], "The RESULT is [hidden — graded answer] and it returns [hidden — graded answer].")

    def test_empty_or_unprotected_is_clean(self):
        self.assertFalse(guard.check_text("anything 4", []).leaked)
        self.assertFalse(guard.check_text("", [LIVE_FILL]).leaked)
        self.assertFalse(guard.check_item({"answer": "4"}, []).leaked)

    def test_item_mode_answer_equality_and_visible_options(self):
        result = guard.check_item({"title": "t", "prompt": "Mean of c(3, 5)?", "answer": "4"}, [LIVE_FILL])
        self.assertEqual(result.rules, ["item_answer"])
        distractor = {"title": "t", "prompt": "Which builds a sequence?", "choices": ["seq(1, 6)", "rep(2, 2)"], "answer": "rep(2, 2)"}
        self.assertFalse(guard.check_item(distractor, [SEQ_CHOICE]).leaked)  # a visible homework option, not the answer
        same_answer = {"title": "t", "prompt": "Which builds 1, 3, 5?", "choices": ["seq(1, 5, by = 2)", "rep(2, 2)"],
                       "answer": "seq(1, 5, by = 2)"}
        self.assertEqual(guard.check_item(same_answer, [SEQ_CHOICE]).rules, ["item_answer"])


class MatchingTests(ApiTestCase):
    """§12.5 fixture 11 (containment matching over readers.open_homework_questions)."""

    def setUp(self) -> None:
        super().setUp()
        with self.db() as db:
            testsupport.create_course(db, "c1")
            self.hw = testsupport.publish_work(db, "c1", questions=[LIVE_FILL], due_at="2099-01-01T00:00:00+00:00")

    def match(self, text: str):
        with self.db() as db:
            return guard.match_homework(db, "c1", "demo-ada", text, None)

    def test_11_verbatim_and_padded_pastes_match_paraphrases_do_not(self):
        prompt = LIVE_FILL["prompt"]
        exact = self.match(prompt)
        self.assertIsNotNone(exact)
        self.assertEqual((exact.assignment_id, exact.question_id, exact.containment), (self.hw.id, "q1", 1.0))
        padded = self.match(prompt + " give me the final answer, I need it for my homework")
        self.assertEqual(padded.containment, 1.0)
        self.assertLess(padded.jaccard, 1.0)
        self.assertIsNone(self.match("how do I average three numbers?"))  # documented miss
        self.assertIsNone(self.match("what does ggplot do?"))

    def test_protection_combines_explicit_and_matched_questions(self):
        with self.db() as db:
            found = guard.protection(db, "c1", "demo-ada", {"assignmentId": self.hw.id, "questionId": "q1",
                                                            "text": "help with " + LIVE_FILL["prompt"]}, None)
            self.assertEqual([source for _, _, source in found.items], ["explicit"])
            self.assertIsNotNone(found.match)
            archived = testsupport.publish_work(db, "c1", questions=[dict(LIVE_FILL, id="q9")])
            db.execute("UPDATE assignments SET archived_at='2026-01-01T00:00:00+00:00' WHERE id=?", (archived.id,))
            db.commit()
            self.assertEqual(guard.protected_for(db, "c1", "demo-ada", {"assignmentId": archived.id, "questionId": "q9"}, None), [])

    def test_short_prompt_uses_substring_rule(self):
        with self.db() as db:
            short = testsupport.publish_work(db, "c1", questions=[{"id": "s1", "type": "fill", "prompt": "Name the R function for averages",
                                                                   "answer": "mean", "choices": [], "starterCode": ""}])
            db.execute("UPDATE assignments SET status='draft' WHERE id=?", (self.hw.id,))
            db.commit()
            found = guard.match_homework(db, "c1", "demo-ada", "pls: Name the R function for averages!!", None)
            self.assertEqual((found.assignment_id, found.containment), (short.id, 1.0))


if __name__ == "__main__":
    unittest.main()
