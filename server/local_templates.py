"""Practice without AI: built-in chapter templates and the teacher bank (AIRUN; spec §12.8, AIRUN-10/28).

``template_item`` is the server port of the v0.5.1 client templates (``src/lib/questions.ts:16-139`` at 04a7aeb, the
same five skills), seeded per item id so a stored item can be reproduced. The teacher bank serves questions with
reference answers from the chapter's in-class exercises that are closed or archived, or published with ``frozen_at``
at least 7 days ago — an exercise still running in class is never served (its attempt limits and hints stay intact).
"""

from __future__ import annotations

import hashlib
import random
import sqlite3
from datetime import timedelta

from server import db as dbmod
from server import readers

BUILTIN_UNITS = frozenset({"css-intro", "r-basics", "data-wrangling", "dataframes", "conditions", "text-analysis",
                           "network-analysis"})
BANK_TYPES = ("fill", "choice", "predict", "complete")
BANK_MIN_AGE = timedelta(days=7)
NO_LOCAL_PRACTICE = "No practice is available for this chapter without AI."


def _rng(seed_text: str) -> random.Random:
    return random.Random(int(hashlib.sha256(seed_text.encode("utf-8")).hexdigest()[:8], 16))


def _skill(unit_id: str, difficulty: int, rng: random.Random) -> dict:
    n = rng.randint(3, 8 + difficulty * 2)
    step = rng.randint(2, 3 + difficulty)
    if unit_id == "text-analysis":
        return {"title": "Text preprocessing",
                "prompt": "Convert the text to lowercase, split it on spaces, and extract the first word.",
                "code": 'line <- "SOCIAL digital data"\ntokens <- strsplit(tolower(line), " ")[[1]]',
                "expression": "tokens[1]", "answer": "social", "choices": ["social", "SOCIAL", "digital", "data"],
                "explanation": "tolower() normalizes case. R uses one-based indexing, so tokens[1] selects the first word."}
    if unit_id == "network-analysis":
        return {"title": "Directed network in-degree", "prompt": "Count the edges that point to node B.",
                "code": 'to <- c("B", "A", "B", "C")', "expression": 'sum(to == "B")', "answer": "2",
                "choices": ["2", "1", "3", "4"],
                "explanation": 'Each TRUE value in to == "B" represents an incoming edge. sum() counts those values.'}
    if unit_id in ("data-wrangling", "dataframes"):
        return {"title": "Filter a data frame", "prompt": f"Count the rows with score greater than {n}.",
                "code": f"df <- data.frame(score = c({n}, {n + step}, {n + step * 2}))",
                "expression": f"nrow(df[df$score > {n}, , drop = FALSE])", "answer": "2", "choices": ["2", "1", "3", "0"],
                "explanation": "Only the second and third rows satisfy the strict greater-than condition. The comma separates rows from columns."}
    if unit_id == "conditions":
        return {"title": "Handle missing values", "prompt": "Count the nonmissing elements of x.", "code": "x <- c(1, NA, 3)",
                "expression": "sum(!is.na(x))", "answer": "2", "choices": ["2", "3", "NA", "0"],
                "explanation": "is.na() identifies missing values; ! reverses that condition. sum() counts TRUE values."}
    hard = difficulty >= 4
    answer = str(n + step * 2 if hard else n + step)
    return {"title": "Filter a numeric vector" if hard else "Calculate a vector mean",
            "prompt": "Add the values that are strictly greater than the mean of scores." if hard else "Calculate the mean of scores.",
            "code": f"scores <- c({n}, {n + step}, {n + step * 2})",
            "expression": "sum(scores[scores > mean(scores)])" if hard else "mean(scores)", "answer": answer,
            "choices": [answer, str(n), str(n + step * 3), "0"],
            "explanation": ("The last element is the only value strictly above the mean, so the filtered sum equals that value."
                            if hard else "The mean of three equally spaced values is the middle value.")}


def template_item(unit_id: str, qtype: str, difficulty: int, seed: str) -> dict:
    """One local template exercise (full item incl. answer key) for a built-in chapter."""
    skill = _skill(unit_id, difficulty, _rng(seed))
    if qtype == "fill":
        return {"title": skill["title"], "prompt": f"{skill['prompt']} Fill the gap with an R expression.",
                "code": f"{skill['code']}\nresult <- ____", "answer": skill["expression"], "explanation": skill["explanation"]}
    if qtype == "choice":
        return {"title": skill["title"], "prompt": f"{skill['prompt']} What is the result?", "code": skill["code"],
                "choices": list(skill["choices"]), "answer": skill["answer"], "explanation": skill["explanation"]}
    if qtype == "predict":
        return {"title": skill["title"], "prompt": "What is the output of the final print()?",
                "code": f"{skill['code']}\nprint({skill['expression']})", "answer": skill["answer"],
                "explanation": skill["explanation"]}
    if qtype == "explain":
        return {"title": skill["title"], "prompt": f"Explain in your own words what the last line computes and why. {skill['prompt']}",
                "code": f"{skill['code']}\n{skill['expression']}", "answer": skill["explanation"],
                "explanation": skill["explanation"],
                "rubric": "Names the function used; explains the input it works on; states what the result represents."}
    return {"title": skill["title"], "prompt": f"{skill['prompt']} Replace ____ and run the code.",
            "starterCode": f"{skill['code']}\nresult <- ____ # TODO: complete the expression\nprint(result)",
            "answer": skill["expression"], "expectedOutput": skill["answer"], "explanation": skill["explanation"]}


def similar_template(source: dict, unit_id: str, qtype: str, difficulty: int, seed: str) -> tuple[dict, str] | None:
    """Local similar exercise (port of ``localSimilarQuestion``): mean → R basics skill, seq() → sequence length."""
    text = f"{source.get('prompt', '')} {source.get('starterCode', '')}".lower()
    if "mean" in text or "average" in text:
        return template_item("r-basics", qtype, difficulty, seed), qtype
    if "seq(" in text:
        rng = _rng(seed)
        start, by = rng.randint(1, 4), rng.randint(2, 5)
        end = start + by * 3
        return ({"title": "Sequence length", "prompt": "What does the final print() output?",
                 "code": f"x <- seq({start}, {end}, by = {by})\nprint(length(x))", "answer": "4",
                 "explanation": "The sequence contains the start and three further values at the specified interval."}, "predict")
    if unit_id in BUILTIN_UNITS:
        return template_item(unit_id, qtype, difficulty, seed), qtype
    return None


def _bank_eligible(rec, now) -> bool:
    if rec.kind == "homework" or rec.deleted_at:
        return False
    if rec.archived_at:
        return True
    if rec.status != "published":
        return False
    if readers.assignment_state(rec, now) == "closed":
        return True
    frozen = dbmod.parse_iso(rec.frozen_at) if rec.frozen_at else None
    current = dbmod.parse_iso(now) if isinstance(now, str) else (now or dbmod.utcnow())
    return frozen is not None and current - frozen >= BANK_MIN_AGE  # type: ignore[operator]


def bank_questions(db: sqlite3.Connection, class_id: str, unit_id: str, now: object = None) -> list[tuple[object, dict]]:
    """Teacher-bank candidates (rec, question) of a chapter: in-class exercises that are not running (AIRUN-28)."""
    out = []
    for row in db.execute("SELECT * FROM assignments WHERE class_id=? AND unit_id=? AND kind='practice' AND deleted_at IS NULL "
                          "ORDER BY created_at, id", (class_id, unit_id)):
        rec = readers.record_from_row(row)
        if not _bank_eligible(rec, now):
            continue
        for question in rec.questions:
            reference = question.get("answer") or question.get("expectedOutput")
            if question.get("type") in BANK_TYPES and isinstance(reference, str) and reference.strip():
                out.append((rec, question))
    return out


def bank_item(db: sqlite3.Connection, class_id: str, unit_id: str, qtype: str, allowed: list[str], seed: str,
              now: object = None) -> tuple[dict, str, object] | None:
    """A teacher-bank exercise of the requested type (else any allowed type): (item, type, source rec)."""
    candidates = bank_questions(db, class_id, unit_id, now)
    preferred = [c for c in candidates if c[1].get("type") == qtype] or [c for c in candidates if c[1].get("type") in allowed]
    if not preferred:
        return None
    rec, question = preferred[_rng(seed).randrange(len(preferred))]
    qt = str(question.get("type"))
    item = {"title": rec.title, "prompt": question.get("prompt", ""), "answer": question.get("answer") or question.get("expectedOutput"),
            "explanation": question.get("studentExplanation") or "Compare your answer with the worked solution from class."}
    if question.get("choices"):
        item["choices"] = list(question["choices"])
    if question.get("starterCode"):
        item["starterCode" if qt == "complete" else "code"] = question["starterCode"]
    if question.get("acceptedAnswers"):
        item["acceptedAnswers"] = list(question["acceptedAnswers"])[:20]
    if qt == "complete":
        item["expectedOutput"] = question.get("expectedOutput") or question.get("answer")
        if question.get("referenceCode"):
            item["answer"] = question["referenceCode"]
    return item, qt, rec
