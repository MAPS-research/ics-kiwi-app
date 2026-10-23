"""Answer checking (judging v2) — owned by ASSESS. ASSESS-06/07/09 tables incl. the LIVE cases of AU-D1-06.

Pure unit tests: ``judging.check`` never reads the database.
"""

import unittest

from server import judging


def q(qtype="fill", answer="", **extra):
    return {"id": "q1", "type": qtype, "prompt": "?", "points": 10, "choices": extra.pop("choices", []),
            "starterCode": "", "answer": answer, **extra}


class JudgingTableTests(unittest.TestCase):
    """ASSESS-06 [F16, AU-D1-06, AU-D2-M7]: answer pairs → (correct, reason)."""

    CASES = [
        # (question, answer, run_output, expected correct, expected reason)
        # LIVE: tolower reference '[1] "hello"', student output '[1] "Hello"' was judged correct in v0.5.1
        (q("predict", '[1] "hello"'), '[1] "Hello"', None, False, "case_mismatch"),
        # LIVE: whitespace inside a string literal matters
        (q("predict", '"hello"'), '"hel lo"', None, False, "mismatch"),
        # LIVE: MEAN( X ) vs mean(x) — case-sensitive default
        (q("fill", "mean(x)"), "MEAN( X )", None, False, "case_mismatch"),
        # spacing outside strings is ignored by default
        (q("fill", "mean(x)"), "mean( x )", None, True, "exact"),
        # LIVE: 4.0 vs 4 was judged incorrect in v0.5.1
        (q("fill", "4"), "4.0", None, True, "numeric_tolerance"),
        (q("predict", "[1] 4"), "4", None, True, "exact"),
        (q("predict", "[1] 2 4 6"), "[1] 2.0 4 6.00", None, True, "numeric_tolerance"),
        (q("fill", "4"), "5", None, False, "mismatch"),
        (q("fill", "0.3"), "0.30000000000000004", None, True, "numeric_tolerance"),
        # accepted answers
        (q("fill", "left_join", acceptedAnswers=["left_join(a, b)", "dplyr::left_join"]), "dplyr::left_join", None, True, "accepted"),
        (q("fill", "left_join", acceptedAnswers=["dplyr::left_join"]), "inner_join", None, False, "mismatch"),
        # case-insensitive and whitespace modes
        (q("fill", "mean(x)", grading={"caseSensitive": False}), "MEAN( X )", None, True, "exact"),
        (q("fill", "left join", grading={"whitespace": "collapse"}), "left   join", None, True, "exact"),
        (q("fill", "left join", grading={"whitespace": "collapse"}), "leftjoin", None, False, "mismatch"),
        (q("fill", "a  b", grading={"whitespace": "exact"}), "a b", None, False, "mismatch"),
        (q("fill", "a  b", grading={"whitespace": "exact"}), "a  b ", None, True, "exact"),
        (q("fill", "4", grading={"numericTolerance": None}), "4.0", None, False, "mismatch"),
        (q("fill", "100", grading={"numericTolerance": 0.05}), "104", None, True, "numeric_tolerance"),
        # choice: exact option text (trimmed)
        (q("choice", "seq(1, 5, by = 2)", choices=["seq(1, 5, by = 2)", "c(1, 5)"]), "seq(1, 5, by = 2)", None, True, "choice"),
        (q("choice", "seq(1, 5, by = 2)", choices=["seq(1, 5, by = 2)", "c(1, 5)"]), "c(1, 5)", None, False, "mismatch"),
        # complete: last stdout line of the client run, trailing warnings ignored
        (q("complete", "", expectedOutput="[1] 80"), "avg_a <- mean(score[group == 'A'])", "[1] 80", True, "output_match"),
        (q("complete", "", expectedOutput="[1] 80"), "x", "[1] 70\n[1] 80\nWarning message:\nIn mean(x) : argument is not numeric", True,
         "output_match"),
        (q("complete", "", expectedOutput="[1] 80"), "x", "[1] 81", False, "mismatch"),
        (q("complete", "", expectedOutput='[1] "hello"'), "x", '[1] "Hello"', False, "case_mismatch"),
        # legacy complete (answer is an expected value) keeps working
        (q("complete", "80"), "code", "[1] 80", True, "output_match"),
        # complete without a run: the reference code itself still matches, anything else needs a run
        (q("complete", "", referenceCode="x <- seq(-3, 25, by = 2)\nprint(mean(x))"), "x <- seq(-3,25,by=2)\nprint(mean(x))", None,
         True, "exact"),
        (q("complete", "", expectedOutput="[1] 80"), "anything", None, None, "not_gradable"),
        # text and auto-check off are never judged
        (q("text", "An ordered sequence"), "An ordered sequence", None, None, "not_gradable"),
        (q("fill", "4", grading={"autoCheck": False}), "4", None, None, "not_gradable"),
        # no reference answer
        (q("fill", ""), "4", None, None, "no_reference"),
    ]

    def test_answer_pairs(self):
        for question, answer, run_output, correct, reason in self.CASES:
            with self.subTest(question=question, answer=answer, run_output=run_output):
                result = judging.check(question, answer, run_output)
                self.assertEqual((result.correct, result.reason), (correct, reason))
                self.assertEqual(result.score_fraction, None if correct is None else float(correct))

    def test_basis_names_the_evidence(self):
        question = q("complete", "", expectedOutput="[1] 80")
        self.assertEqual(judging.check(question, "x", "[1] 80").basis, "client_run_output")
        self.assertEqual(judging.check(q("fill", "4"), "4").basis, "answer_text")

    def test_normalized_answer_groups_equivalent_answers(self):
        question = q("fill", "left_join(a, b)")
        self.assertEqual(judging.check(question, "left_join( a, b )").normalized_answer,
                         judging.check(question, "left_join(a,b)").normalized_answer)
        self.assertNotEqual(judging.check(question, '"a b"').normalized_answer, judging.check(question, '"ab"').normalized_answer)

    def test_version_and_legacy_normalize_signature(self):
        self.assertEqual(judging.JUDGING_VERSION, "judging-v2")
        self.assertEqual(judging.normalize("  [1] 4 "), "4")   # testsupport calls normalize(value) with one argument

    def test_v2_question_from_readers_is_accepted(self):
        from server import readers

        legacy = {"id": "p1", "type": "choice", "prompt": "?", "choices": ["A", "B"], "answer": "A", "explanation": "x"}
        mapped = readers.v2_question(legacy, "practice")
        self.assertTrue(judging.check(mapped, "A").correct)
        self.assertFalse(judging.check(mapped, "a").correct)


if __name__ == "__main__":
    unittest.main()
