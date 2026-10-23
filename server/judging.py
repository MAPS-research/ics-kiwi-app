"""Answer checking — judging v2 (owned by ASSESS; signature frozen, spec §5.6, §4.5.2).

``check(question, answer, run_output=None, provenance='client')`` is pure: it never reads the database.
Rules (per question ``grading`` settings, defaults in brackets):

- ``caseSensitive`` [true]: ``MEAN(x)`` ≠ ``mean(x)``; a match that differs only in case is reported as
  ``case_mismatch`` (still incorrect) so teachers can see why.
- ``whitespace`` [``outside_strings``]: spacing outside quoted string literals is ignored, spacing inside them
  is kept (``"hel lo"`` ≠ ``"hello"``); ``collapse`` folds runs of spaces; ``exact`` only trims the ends.
- ``numericTolerance`` [1e-9, relative]: ``4.0`` = ``4``; numeric vectors compare element-wise; ``null`` turns it off.
- ``acceptedAnswers``: alternative references (reason ``accepted``).
- R output index prefixes (``[1] ``) at line starts are ignored on both sides.
- ``complete`` questions compare the last stdout line(s) of the **client** run with ``expectedOutput``
  (``basis='client_run_output'``); trailing ``Warning message`` blocks are ignored [AU-D2-M7]. Without a run the
  answer code only matches ``referenceCode``; anything else is ``not_gradable``.
- ``text`` questions and ``autoCheck: false`` are never judged (``correct=None``, ``not_gradable``).

Bumping ``JUDGING_VERSION`` re-runs TELEMETRY's ``legacy-rejudge`` rebuild (§4.4).
"""

from __future__ import annotations

import math
import re

from server.contracts import CheckResult

JUDGING_VERSION = "judging-v2"
WHITESPACE_MODES = ("outside_strings", "collapse", "exact")
DEFAULT_TOLERANCE = 1e-9

_INDEX_PREFIX = re.compile(r"^[ \t]*\[\d+\][ \t]?", re.M)
_WARNING_START = re.compile(r"^(Warning messages?:|Warning in |Warning:|In addition: Warning)")
_NUMBER = re.compile(r"^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$")


# -- normalization ---------------------------------------------------------------------------------
def _strip_outside_strings(value: str) -> str:
    """Remove whitespace outside '…' / "…" / `…` literals; keep literal contents (and escapes) verbatim."""
    out: list[str] = []
    quote = ""
    escaped = False
    for char in value:
        if quote:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            continue
        if char in ("'", '"', "`"):
            quote = char
            out.append(char)
        elif not char.isspace():
            out.append(char)
    return "".join(out)


def normalize(value: object, whitespace: str = "outside_strings", case_sensitive: bool = True) -> str:
    """Normalized form used for comparison and for grouping identical answers (``normalized_answer``)."""
    text = value if isinstance(value, str) else ""
    text = _INDEX_PREFIX.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))
    if whitespace == "exact":
        text = text.strip()
    elif whitespace == "collapse":
        text = re.sub(r"\s+", " ", text).strip()
    else:
        text = _strip_outside_strings(text)
    return text if case_sensitive else text.casefold()


def _numbers(value: str) -> list[float] | None:
    tokens = re.sub(r"\s+", " ", _INDEX_PREFIX.sub("", value.replace("\r\n", "\n"))).strip().split(" ")
    if not tokens or tokens == [""] or not all(_NUMBER.fullmatch(t) for t in tokens):
        return None
    try:
        return [float(t) for t in tokens]
    except ValueError:
        return None


def _close(a: float, b: float, tolerance: float) -> bool:
    if a == b:
        return True
    if math.isnan(a) or math.isnan(b) or math.isinf(a) or math.isinf(b):
        return False
    return abs(a - b) <= tolerance * max(abs(a), abs(b))


# -- settings & references -------------------------------------------------------------------------
def _settings(question: dict) -> tuple[bool, str, float | None, bool]:
    grading = question.get("grading") if isinstance(question.get("grading"), dict) else {}
    case_sensitive = grading.get("caseSensitive", True) is not False
    whitespace = grading.get("whitespace") if grading.get("whitespace") in WHITESPACE_MODES else "outside_strings"
    if "numericTolerance" in grading:
        raw = grading.get("numericTolerance")
        tolerance = float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw >= 0 else None
    else:
        tolerance = DEFAULT_TOLERANCE
    auto = grading.get("autoCheck", question.get("type") != "text") is not False
    return case_sensitive, whitespace, tolerance, auto


def _text(question: dict, key: str) -> str:
    value = question.get(key)
    return value if isinstance(value, str) else ""


def _complete_references(question: dict) -> tuple[str, str]:
    """(expectedOutput, referenceCode) with the §4.5.2 legacy mapping of ``answer``."""
    expected, code = _text(question, "expectedOutput"), _text(question, "referenceCode")
    answer = _text(question, "answer")
    if not expected.strip() and not code.strip() and answer.strip():
        if "<-" in answer or "(" in answer or "\n" in answer:
            code = answer
        else:
            expected = answer
    return expected, code


def _accepted(question: dict) -> list[str]:
    values = question.get("acceptedAnswers")
    return [v for v in values if isinstance(v, str) and v.strip()] if isinstance(values, list) else []


def _stdout_tail(run_output: str, lines: int) -> str:
    rows = run_output.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for index, row in enumerate(rows):
        if _WARNING_START.match(row.strip()):
            rows = rows[:index]
            break
    kept = [row for row in rows if row.strip()]
    return "\n".join(kept[-max(1, lines):])


# -- comparison ------------------------------------------------------------------------------------
def _compare(given: str, expected: str, case_sensitive: bool, whitespace: str, tolerance: float | None) -> str | None:
    """'exact' | 'numeric_tolerance' | 'case_mismatch' (incorrect) | None (mismatch)."""
    g = normalize(given, whitespace, True)
    e = normalize(expected, whitespace, True)
    if case_sensitive and g == e:
        return "exact"
    if not case_sensitive and g.casefold() == e.casefold():
        return "exact"
    if tolerance is not None:
        a, b = _numbers(given), _numbers(expected)
        if a is not None and b is not None and len(a) == len(b) and all(_close(x, y, tolerance) for x, y in zip(a, b)):
            return "numeric_tolerance"
    if case_sensitive and g.casefold() == e.casefold():
        return "case_mismatch"
    return None


def _against(given: str, primary: str, accepted: list[str], settings: tuple[bool, str, float | None, bool]) -> tuple[bool, str]:
    case_sensitive, whitespace, tolerance, _ = settings
    case_mismatch = False
    for index, reference in enumerate([primary, *accepted] if primary.strip() else accepted):
        outcome = _compare(given, reference, case_sensitive, whitespace, tolerance)
        if outcome in ("exact", "numeric_tolerance"):
            is_primary = index == 0 and bool(primary.strip())
            return True, (outcome if is_primary or outcome == "numeric_tolerance" else "accepted")
        if outcome == "case_mismatch":
            case_mismatch = True
    return False, "case_mismatch" if case_mismatch else "mismatch"


def _result(correct: bool | None, reason: str, basis: str, normalized: str) -> CheckResult:
    fraction = None if correct is None else (1.0 if correct else 0.0)
    return CheckResult(correct, fraction, reason, basis, normalized)


def check(question: dict, answer: str, run_output: str | None = None, provenance: str = "client") -> CheckResult:
    """Check one answer against a (v2 or legacy) question dict. ``provenance`` records who supplied ``run_output``."""
    del provenance  # the basis already says where the evidence came from; kept for the frozen signature
    question = question if isinstance(question, dict) else {}
    qtype = question.get("type")
    given = answer if isinstance(answer, str) else ""
    settings = _settings(question)
    case_sensitive, whitespace, _, auto = settings
    normalized = normalize(given, whitespace, case_sensitive)
    if qtype == "text" or not auto:
        return _result(None, "not_gradable", "answer_text", normalized)
    accepted = _accepted(question)
    if qtype == "choice":
        reference = _text(question, "answer").strip()
        chosen = given.strip()
        if not reference and not accepted:
            return _result(None, "no_reference", "answer_text", chosen)
        if reference and chosen == reference:
            return _result(True, "choice", "answer_text", chosen)
        if chosen in [a.strip() for a in accepted]:
            return _result(True, "accepted", "answer_text", chosen)
        return _result(False, "mismatch", "answer_text", chosen)
    if qtype == "complete":
        expected, code = _complete_references(question)
        if isinstance(run_output, str) and (expected.strip() or accepted):
            lines = len([row for row in expected.split("\n") if row.strip()]) or 1
            observed = _stdout_tail(run_output, lines)
            correct, reason = _against(observed, expected, accepted, settings)
            if correct and reason == "exact":
                reason = "output_match"
            return _result(correct, reason, "client_run_output", normalize(observed, whitespace, case_sensitive))
        if code.strip():
            outcome = _compare(given, code, case_sensitive, whitespace, None)
            if outcome == "exact":
                return _result(True, "exact", "answer_text", normalized)
        if expected.strip() or code.strip() or accepted:
            return _result(None, "not_gradable", "answer_text", normalized)
        return _result(None, "no_reference", "answer_text", normalized)
    reference = _text(question, "answer") or _text(question, "expectedOutput")
    if not reference.strip() and not accepted:
        return _result(None, "no_reference", "answer_text", normalized)
    correct, reason = _against(given, reference, accepted, settings)
    return _result(correct, reason, "answer_text", normalized)
