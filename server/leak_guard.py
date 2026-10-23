"""Deterministic final-answer guard (AIRUN; spec §12.5; signatures frozen in §5.6).

Which homework is protected comes from ``readers.answer_protected``. A request is matched to protected homework by
token-3-shingle **containment** (padding a pasted prompt does not lower it). Replies are checked with rules R1–R5 on
normal forms that keep an index map back to the original text, so redactions replace exactly the matched characters.
Generated items are checked with the code rules plus CW equality of their answer/choices with protected forms.
"""

from __future__ import annotations

import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Iterable

from server import db as dbmod
from server import readers
from server.contracts import AssignmentRecord, GuardResult, HomeworkMatch

MIN_CODE_LEN = 6
LINE_MIN_LEN = 8
LINE_COVERAGE = 0.60
CONTEXT_WINDOW = 40
CHOICE_WINDOW = 60
CHOICE_MIN_LEN = 4
CONTAINMENT_THRESHOLD = 0.60
MIN_SHINGLES = 4
SHORT_PROMPT_MIN = 20
REDACTION = "[hidden — graded answer]"
REDACTION_PREFIX = "Kiwi can't give the final answer for graded homework, but here is a hint:"
RETRY_INSTRUCTION = ("Your previous reply revealed the final answer to a graded question. Rewrite it as hints only; "
                     "do not state the final value or the complete solution code.")
BLOCKED_REPLY = ("This looks like graded homework where your teacher turned off Ask Kiwi. Review the chapter materials "
                 "or ask your teacher.")
CLEAN = GuardResult(False, [], [])

_QUOTES = {"‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
           "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"'}
_PREFIX = re.compile(r"^\s*\[\d+\]\s*")
_TOKEN = re.compile(r"[a-z_.][a-z0-9_.]*|\d+(?:\.\d+)?|[^\sa-z0-9]")
# WHY re.ASCII: CJK characters are word characters in Unicode mode, so "结果是5" would hide the 5 from \w-bounded rules.
# Deviation (documented): a sentence-final period ("It returns 4.") does not hide the number; ".5" after it still does.
_NUMBER = re.compile(r"(?<![\w.])[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?(?!\w|\.\w)", re.ASCII)
_NUMBER_FULL = re.compile(r"[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?", re.ASCII)
_KEYWORD = re.compile(r"\b(returns?|is|equals?|gives|outputs?|result|answer|prints?)\b", re.ASCII)
_ARROWS = ("→", "->", "=>")
_CJK_KEYWORDS = ("是", "等于", "结果", "答案", "输出", "返回", "为")
_CHOICE_KEYWORD = re.compile(r"\b(correct|answer|choose|pick|option|should be|is right)\b", re.ASCII)
_CHOICE_LETTER = re.compile(r"\b(option|choice|answer)\s*\(?([a-h])\)?(?![a-z])", re.ASCII)
_OUTPUT_LINE = re.compile(r"^\s*\[\d+\]\s+(.*)$")
FORM_KEYS = ("answer", "referenceCode", "expectedOutput")


# ─── Normal forms with index maps ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Norm:
    """A normalized string; ``idx[k]`` is the index in the original string of ``text[k]``."""

    text: str
    idx: tuple[int, ...]

    def span(self, start: int, end: int) -> tuple[int, int]:
        """Original [start, end) of the normalized slice [start, end)."""
        return self.idx[start], self.idx[end - 1] + 1


@dataclass(frozen=True)
class Compact:
    """``CW(s)``: N(s) without whitespace; ``n_idx[k]`` indexes ``norm.text``."""

    text: str
    n_idx: tuple[int, ...]
    norm: Norm

    def n_span(self, start: int, end: int) -> tuple[int, int]:
        return self.n_idx[start], self.n_idx[end - 1] + 1

    def span(self, start: int, end: int) -> tuple[int, int]:
        n_start, n_end = self.n_span(start, end)
        return self.norm.span(n_start, n_end)


def _fold(value: str) -> list[tuple[str, int]]:
    """NFKC → casefold → straight quotes, per original character (so every output char maps back)."""
    out: list[tuple[str, int]] = []
    for index, char in enumerate(value):
        for folded in unicodedata.normalize("NFKC", char).casefold():
            out.append((_QUOTES.get(folded, folded), index))
    return out


def normal(value: str | None) -> Norm:
    """``N(s)``: NFKC, casefold, straight quotes, strip a leading R index prefix per line, collapse whitespace, trim."""
    chars = _fold(value or "")
    kept: list[tuple[str, int]] = []
    line: list[tuple[str, int]] = []

    def flush(current: list[tuple[str, int]]) -> None:
        match = _PREFIX.match("".join(c for c, _ in current))
        kept.extend(current[match.end() if match else 0:])

    for char, index in chars:
        if char == "\n":
            flush(line)
            line = []
            kept.append((char, index))
        else:
            line.append((char, index))
    flush(line)
    text: list[str] = []
    idx: list[int] = []
    for char, index in kept:
        if char.isspace():
            if text and text[-1] == " ":
                continue
            text.append(" ")
            idx.append(index)
        else:
            text.append(char)
            idx.append(index)
    start, end = 0, len(text)
    while start < end and text[start] == " ":
        start += 1
    while end > start and text[end - 1] == " ":
        end -= 1
    return Norm("".join(text[start:end]), tuple(idx[start:end]))


def compact(value: str | Norm | None) -> Compact:
    """``CW(s)``: ``N(s)`` with all whitespace removed (index map composed through N)."""
    norm = value if isinstance(value, Norm) else normal(value)
    chars = [(c, k) for k, c in enumerate(norm.text) if not c.isspace()]
    return Compact("".join(c for c, _ in chars), tuple(k for _, k in chars), norm)


def lines_l(value: str | None) -> list[Norm]:
    """``L(s)``: NFKC + casefold, split into lines, no prefix strip (output-line rule only)."""
    out: list[Norm] = []
    text: list[str] = []
    idx: list[int] = []
    for char, index in _fold(value or ""):
        if char == "\n":
            out.append(Norm("".join(text), tuple(idx)))
            text, idx = [], []
        else:
            text.append(char)
            idx.append(index)
    out.append(Norm("".join(text), tuple(idx)))
    return out


def tokens(value: str | Norm) -> list[str]:
    text = value.text if isinstance(value, Norm) else normal(value).text
    return _TOKEN.findall(text)


def shingles(toks: list[str]) -> set[tuple[str, ...]]:
    return {tuple(toks[i:i + 3]) for i in range(len(toks) - 2)}


def jaccard(a: str, b: str) -> float:
    """Symmetric 3-gram Jaccard of two texts (novelty, AIRUN-15)."""
    sa, sb = shingles(tokens(a)), shingles(tokens(b))
    union = sa | sb
    return len(sa & sb) / len(union) if union else 0.0


def _find_all(haystack: str, needle: str) -> list[int]:
    if not needle:
        return []
    found, start = [], haystack.find(needle)
    while start != -1:
        found.append(start)
        start = haystack.find(needle, start + 1)
    return found


# ─── Protected questions ──────────────────────────────────────────────────────────────────────

@dataclass
class Protection:
    """Protected questions of one request, plus the homework match (logged in ai_calls / generated_items)."""

    items: list[tuple[AssignmentRecord, dict, str]] = field(default_factory=list)
    match: HomeworkMatch | None = None

    @property
    def protected(self) -> bool:
        return bool(self.items)


def _due(rec: AssignmentRecord) -> datetime:
    try:
        return dbmod.parse_iso(rec.due_at) or datetime.min.replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def match_homework(db: sqlite3.Connection, class_id: str, student_id: str, text: str, now: object, *,
                   unit_id: str = "") -> HomeworkMatch | None:
    """Best protected homework question whose prompt (+ starter code) is contained in ``text`` (§12.5 (b))."""
    if not isinstance(text, str) or not text.strip():
        return None
    candidates = readers.open_homework_questions(db, class_id, student_id, now)
    if not candidates:
        return None
    request = normal(text)
    request_shingles = shingles(tokens(request))
    request_cw = compact(request).text
    best: tuple[tuple, HomeworkMatch] | None = None
    for rec, question in candidates:
        prompt = str(question.get("prompt") or "")
        home = normal(prompt + "\n" + str(question.get("starterCode") or ""))
        home_shingles = shingles(tokens(home))
        shared = len(home_shingles & request_shingles)
        union = home_shingles | request_shingles
        jac = shared / len(union) if union else 0.0
        if len(home_shingles) >= MIN_SHINGLES:
            containment = shared / len(home_shingles)
            if containment < CONTAINMENT_THRESHOLD:
                continue
        else:
            prompt_cw = compact(prompt).text
            if len(prompt_cw) < SHORT_PROMPT_MIN or prompt_cw not in request_cw:
                continue
            containment = 1.0
        key = (round(containment, 9), rec.unit_id == unit_id and bool(unit_id), _due(rec))
        found = HomeworkMatch(rec.id, str(question.get("id") or ""), containment, jac, rec, question)
        if best is None or key > best[0]:
            best = (key, found)
    return best[1] if best else None


def protection(db: sqlite3.Connection, class_id: str, student_id: str, request: dict, now: object) -> Protection:
    """(a) explicit assignment question when protected, (b) homework match on ``request['text']``, (c) similar source."""
    result = Protection()
    seen: set[tuple[str, str]] = set()

    def add(rec: AssignmentRecord, question: dict, source: str) -> None:
        key = (rec.id, str(question.get("id") or ""))
        if key not in seen:
            seen.add(key)
            result.items.append((rec, question, source))

    assignment_id, question_id = request.get("assignmentId"), request.get("questionId")
    if isinstance(assignment_id, str) and assignment_id and isinstance(question_id, str) and question_id:
        rec = readers.load_assignment(db, class_id, assignment_id)
        question = readers.assignment_question(rec, question_id) if rec else None
        if rec is not None and question is not None and readers.answer_protected(db, rec, student_id, now):
            add(rec, question, "explicit")
    similar = request.get("similar")
    if isinstance(similar, tuple) and len(similar) == 2:
        add(similar[0], similar[1], "similar")
    text = request.get("text")
    if isinstance(text, str) and text.strip():
        found = match_homework(db, class_id, student_id, text, now, unit_id=str(request.get("unitId") or ""))
        if found is not None:
            result.match = found
            add(found.rec, found.question, "homework_match")
    return result


def protected_for(db: sqlite3.Connection, class_id: str, student_id: str, request: dict,
                  now: object) -> list[tuple[AssignmentRecord, dict, str]]:
    """Protected (rec, question, source) for a request (explicit, homework match, similar source)."""
    return protection(db, class_id, student_id, request, now).items


def _questions(protected: Iterable[object]) -> list[tuple[dict, str, str]]:
    """Accept (rec, question, source) tuples, (rec, question) pairs or bare question dicts → (question, aid, qid)."""
    out: list[tuple[dict, str, str]] = []
    for entry in protected or []:
        if isinstance(entry, dict):
            out.append((entry, "", str(entry.get("id") or "")))
        elif isinstance(entry, (tuple, list)) and len(entry) >= 2 and isinstance(entry[1], dict):
            rec = entry[0]
            out.append((entry[1], getattr(rec, "id", "") or "", str(entry[1].get("id") or "")))
    return out


def forms(question: dict) -> list[tuple[str, str]]:
    """Protected forms: answer, referenceCode, expectedOutput and each accepted answer (empty ones ignored)."""
    found: list[tuple[str, str]] = []
    seen: set[str] = set()
    values = [(key, question.get(key)) for key in FORM_KEYS]
    values += [("acceptedAnswer", value) for value in (question.get("acceptedAnswers") or [])]
    for kind, value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        key = compact(value).text
        if key and key not in seen:
            seen.add(key)
            found.append((kind, value))
    return found


def _visible(question: dict) -> str:
    choices = [str(c) for c in question.get("choices") or [] if isinstance(c, str)]
    return "\n".join([str(question.get("prompt") or ""), str(question.get("starterCode") or ""), *choices])


def _novel_lines(form: str, question: dict) -> list[str]:
    """CW of the form's lines that appear in neither the starter code nor the prompt."""
    starter = compact(str(question.get("starterCode") or "")).text
    prompt = compact(str(question.get("prompt") or "")).text
    lines = []
    for raw in form.splitlines():
        line = compact(raw).text
        if line and line not in starter and line not in prompt:
            lines.append(line)
    return lines


# ─── Rules ────────────────────────────────────────────────────────────────────────────────────

class _Reply:
    """The guarded reply in all normal forms (built once per check)."""

    def __init__(self, text: str) -> None:
        self.original = text or ""
        self.n = normal(self.original)
        self.cw = compact(self.n)
        self.lines = lines_l(self.original)

    def excerpt(self, start: int, end: int) -> str:
        return self.original[max(0, start - 20):min(len(self.original), end + 20)]

    def context_ok(self, n_start: int) -> bool:
        window = self.n.text[max(0, n_start - CONTEXT_WINDOW):n_start]
        return bool(_KEYWORD.search(window)) or any(a in window for a in _ARROWS) or any(k in window for k in _CJK_KEYWORDS)


def _numeric_equal(token: str, value: Decimal) -> bool:
    try:
        number = Decimal(token)
    except InvalidOperation:
        return False
    if abs(number - value) <= Decimal("1e-9") * max(Decimal(1), abs(value)):
        return True
    mantissa = token.lower().split("e", 1)[0]
    if "." in mantissa and "e" not in token.lower():
        decimals = len(mantissa.split(".", 1)[1])
        if decimals >= 1:
            quantum = Decimal(1).scaleb(-decimals)
            try:
                return value.quantize(quantum, rounding=ROUND_HALF_UP) == number
            except InvalidOperation:
                return False
    return False


class _Matches:
    def __init__(self, reply: _Reply, question: dict, assignment_id: str, question_id: str) -> None:
        self.reply = reply
        self.items: list[dict] = []
        self.meta = {"assignmentId": assignment_id, "questionId": question_id}

    def add(self, rule: str, kind: str, start: int, end: int) -> None:
        if end <= start:
            return
        if any(m["rule"] == rule and m["start"] == start and m["end"] == end for m in self.items):
            return
        self.items.append({"rule": rule, "answerKind": kind, "excerpt": self.reply.excerpt(start, end),
                           "start": start, "end": end, **self.meta})


def token_like(form: str) -> bool:
    """A single word/number or fewer than 6 characters: handled by R3/R5 (whole token + context), not substring rules.

    Deviation (documented): §12.5 lists ``social`` (6 characters) as an R5 short token; one-token forms therefore use
    R5 so that "Think about social data" is not flagged by R1 substring matching.
    """
    return len(compact(form).text) < MIN_CODE_LEN or len(tokens(form)) <= 1


def _code_rules(found: _Matches, kind: str, form: str, question: dict, visible_cw: str) -> None:
    reply = found.reply
    form_cw = compact(form).text
    if not form_cw or form_cw in visible_cw or token_like(form):
        return  # visible to the student already (starter == reference, a choice option) or a short token (R3/R5)
    r1 = False
    if len(form_cw) >= MIN_CODE_LEN:
        for pos in _find_all(reply.cw.text, form_cw):
            r1 = True
            found.add("R1", kind, *reply.cw.span(pos, pos + len(form_cw)))
    novel = _novel_lines(form, question)
    novel_cw = "".join(novel)
    if not r1 and novel_cw and len(novel_cw) >= MIN_CODE_LEN:
        for pos in _find_all(reply.cw.text, novel_cw):
            found.add("R1'", kind, *reply.cw.span(pos, pos + len(novel_cw)))
    long_lines = [line for line in novel if len(line) >= LINE_MIN_LEN]
    if len(long_lines) >= 2:
        hits = [line for line in long_lines if line in reply.cw.text]
        if len(hits) / len(long_lines) >= LINE_COVERAGE:
            for line in hits:
                for pos in _find_all(reply.cw.text, line):
                    found.add("R2", kind, *reply.cw.span(pos, pos + len(line)))


def _output_line_hits(reply: _Reply, predicate) -> list[tuple[int, int]]:
    """Original spans inside R output lines (``[1] value``) whose captured part satisfies ``predicate``."""
    spans: list[tuple[int, int]] = []
    for line in reply.lines:
        match = _OUTPUT_LINE.match(line.text)
        if not match:
            continue
        offset = match.start(1)
        for start, end in predicate(match.group(1)):
            spans.append(line.span(offset + start, offset + end))
    return spans


def _r3(found: _Matches, kind: str, form: str) -> None:
    reply = found.reply
    try:
        value = Decimal(normal(form).text)
    except InvalidOperation:
        return
    for match in _NUMBER.finditer(reply.n.text):
        if _numeric_equal(match.group(0), value) and reply.context_ok(match.start()):
            found.add("R3", kind, *reply.n.span(match.start(), match.end()))

    def numbers(part: str) -> list[tuple[int, int]]:
        return [(m.start(), m.end()) for m in _NUMBER.finditer(part) if _numeric_equal(m.group(0), value)]

    for start, end in _output_line_hits(reply, numbers):
        found.add("R3", kind, start, end)


def _r4(found: _Matches, kind: str, choice: str, letter: str | None) -> None:
    reply = found.reply
    choice_cw = compact(choice).text
    if len(choice_cw) < CHOICE_MIN_LEN:
        return
    for pos in _find_all(reply.cw.text, choice_cw):
        n_start, n_end = reply.cw.n_span(pos, pos + len(choice_cw))
        before = reply.n.text[max(0, n_start - CHOICE_WINDOW):n_start]
        after = reply.n.text[n_end:n_end + CHOICE_WINDOW]
        if _CHOICE_KEYWORD.search(before) or _CHOICE_KEYWORD.search(after):
            found.add("R4", kind, *reply.cw.span(pos, pos + len(choice_cw)))
    if letter:
        for match in _CHOICE_LETTER.finditer(reply.n.text):
            if match.group(2) == letter:
                found.add("R4", kind, *reply.n.span(match.start(2), match.end(2)))


def _r5(found: _Matches, kind: str, form: str) -> None:
    reply = found.reply
    token = normal(form).text
    if not token:
        return
    pattern = re.compile(r"(?<![\w.])" + re.escape(token) + r"(?!\w|\.\w)", re.ASCII)
    for match in pattern.finditer(reply.n.text):
        if reply.context_ok(match.start()):
            found.add("R5", kind, *reply.n.span(match.start(), match.end()))

    def whole(part: str) -> list[tuple[int, int]]:
        return [(m.start(), m.end()) for m in pattern.finditer(part)]

    for start, end in _output_line_hits(reply, whole):
        found.add("R5", kind, start, end)


def _display_letter(question: dict, answer: str) -> str | None:
    target = compact(answer).text
    for index, choice in enumerate(question.get("choices") or []):
        if isinstance(choice, str) and compact(choice).text == target and index < 8:
            return "abcdefgh"[index]
    return None


def _result(matches: list[dict]) -> GuardResult:
    if not matches:
        return CLEAN
    rules = sorted({m["rule"] for m in matches})
    return GuardResult(True, rules, sorted(matches, key=lambda m: (m["start"], m["end"], m["rule"])))


def check_text(text: str, protected: list) -> GuardResult:
    """Guard an AI reply against the protected questions (rules R1, R1′, R2, R3, R4, R5)."""
    questions = _questions(protected)
    if not questions or not isinstance(text, str) or not text.strip():
        return CLEAN
    reply = _Reply(text)
    matches: list[dict] = []
    for question, assignment_id, question_id in questions:
        found = _Matches(reply, question, assignment_id, question_id)
        visible_cw = compact(_visible(question)).text
        is_choice = question.get("type") == "choice"
        for kind, form in forms(question):
            _code_rules(found, kind, form, question, visible_cw)
            form_n = normal(form).text
            numeric = bool(_NUMBER_FULL.fullmatch(form_n))
            if numeric:
                _r3(found, kind, form)
            if is_choice and kind == "answer":
                _r4(found, kind, form, _display_letter(question, form))
            if not numeric and token_like(form):
                _r5(found, kind, form)
        matches.extend(found.items)
    return _result(matches)


def item_text(item: dict) -> str:
    """What a student sees of a generated item before answering (title, prompt, code, starter code, choices)."""
    parts = [str(item.get(key) or "") for key in ("title", "prompt", "code", "starterCode")]
    parts += [str(c) for c in item.get("choices") or [] if isinstance(c, str)]
    return "\n".join(p for p in parts if p)


def check_item(item: dict, protected: list) -> GuardResult:
    """Guard a generated item: R1/R1′/R2 on its visible text, plus CW equality of its answer, expected output and
    choices with protected forms (choices equal to a visible homework option are allowed unless they are the answer)."""
    questions = _questions(protected)
    if not questions or not isinstance(item, dict):
        return CLEAN
    reply = _Reply(item_text(item))
    matches: list[dict] = []
    answer_cw = {compact(str(item.get(key) or "")).text for key in ("answer", "expectedOutput")} - {""}
    answer_cw |= {compact(str(a)).text for a in item.get("acceptedAnswers") or [] if isinstance(a, str)} - {""}
    choice_cws = [compact(str(c)).text for c in item.get("choices") or [] if isinstance(c, str)]
    for question, assignment_id, question_id in questions:
        found = _Matches(reply, question, assignment_id, question_id)
        visible_cw = compact(_visible(question)).text
        options = {compact(str(c)).text for c in question.get("choices") or [] if isinstance(c, str)}
        for kind, form in forms(question):
            _code_rules(found, kind, form, question, visible_cw)
            form_cw = compact(form).text
            if form_cw in answer_cw:
                found.items.append({"rule": "item_answer", "answerKind": kind, "excerpt": form[:200], "start": 0, "end": 0,
                                    "assignmentId": assignment_id, "questionId": question_id})
            if form_cw not in options and form_cw in choice_cws:
                found.items.append({"rule": "item_choice", "answerKind": kind, "excerpt": form[:200], "start": 0, "end": 0,
                                    "assignmentId": assignment_id, "questionId": question_id})
        matches.extend(found.items)
    return _result(matches)


def redact(text: str, result: GuardResult) -> str:
    """Replace every matched span of the original reply with ``[hidden — graded answer]`` (overlaps merged) and
    prepend the guard notice."""
    spans = sorted((m["start"], m["end"]) for m in result.matches if m.get("end", 0) > m.get("start", 0))
    merged: list[list[int]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    out, last = [], 0
    for start, end in merged:
        out.append(text[last:start])
        out.append(REDACTION)
        last = end
    out.append(text[last:])
    return f"{REDACTION_PREFIX}\n\n{''.join(out)}"


def matches_json(result: GuardResult) -> list[dict]:
    """Matches as stored in ``guard_matches_json`` (staff/research only)."""
    return [dict(m) for m in result.matches]
