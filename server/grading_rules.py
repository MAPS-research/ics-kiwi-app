"""Grading states shared by Home, Grading, Gradebook and profiles (owned by GRADE; spec §5.6, §7.5, §9.2).

The single implementation of "to grade / late / missing / started / not due yet / newer attempt ungraded /
ready to release / flagged". ``readers.grading_counts`` and ``readers.gradebook_cell`` delegate here; their
signatures and output shapes are frozen.

Grade states (``submissions.grade_status``): ``ungraded`` (needs grading, possibly with partly saved item scores),
``draft`` (every question scored, total saved, not visible to the student) and ``released``.
``submissions.grade`` holds the total of a draft or released grade.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from typing import Iterable
from urllib.parse import quote, urlencode

from server import db as dbmod
from server import identity
from server.contracts import AssignmentRecord

INTEGRITY_FLAGS = ("ai_final_answer", "paste_from_ai", "identical_answer")
IDENTICAL_MIN_CHARS = 40          # normalized answer length for "Same answer as <n> other students"
PASTE_MIN_CHARS = 200             # "Large paste from an AI reply"
FLAG_TEXT = {
    "ai_final_answer": "AI reply may contain the final answer",
    "paste_from_ai": "Large paste from an AI reply",
}
NOT_ASSIGNED = "Not assigned"


# -- formatting ------------------------------------------------------------------------------------
def fmt_points(value: float | None) -> str:
    """``20`` for whole numbers, ``16.25`` otherwise, ``–`` when missing."""
    if value is None:
        return "–"
    number = round(float(value), 2)
    return str(int(number)) if number.is_integer() else f"{number:g}"


def plural(count: int, noun: str) -> str:
    return f"{count} {noun if count == 1 else noun + 's'}"


def normalize_answer(value: object) -> str:
    """Grouping key for identical answers: trimmed, whitespace runs collapsed, case-folded."""
    return " ".join(str(value or "").split()).casefold()


def max_points(rec: AssignmentRecord) -> float:
    return float(sum(float(q.get("points") or 0) for q in rec.questions))


def cell_label(state: str, score: float | None, maximum: float, attempts: int, *, draft_answered: int = 0,
               draft_total: int = 0) -> str:
    """Gradebook cell label (§7.5, NM18): ``18/20 · 1 submission``, ``Draft 16/20``, ``Missing · started (2/3 answered)``…"""
    points = f"{fmt_points(score)}/{fmt_points(maximum)}"
    started = draft_answered > 0
    if state == "released":
        return f"{points} · {plural(attempts, 'submission')}"
    if state == "draft":
        return f"Draft {points}"
    if state == "newer_ungraded":
        return f"{points} · newer attempt ungraded"
    if state == "submitted_ungraded":
        return "Submitted · ungraded"
    if state == "missing":
        return f"Missing · started ({draft_answered}/{draft_total} answered)" if started else "Missing"
    if state == "not_due":
        return "Not due yet · started" if started else "Not due yet"
    if state == "not_submitted":
        return f"Started · {draft_answered}/{draft_total} answered" if started else "Not started"
    if state == "on_original":
        return "Submitted the original"
    if state == "on_revision":
        return "Submitted the new version"
    if state == "counted_on":
        return "Replaced by the new version"
    return state


# -- time ------------------------------------------------------------------------------------------
def _moment(value: object) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        parsed = dbmod.parse_iso(value)
        if parsed is not None:
            return parsed
    return dbmod.utcnow()


def grace(rec: AssignmentRecord) -> timedelta:
    try:
        return timedelta(minutes=int(rec.late_policy.get("graceMinutes") or 0))
    except (TypeError, ValueError):
        return timedelta(0)


def past_due(rec: AssignmentRecord, now: object = None) -> bool:
    due = dbmod.parse_iso(rec.due_at) if rec.due_at else None
    return due is not None and _moment(now) >= due + grace(rec)


# -- drafts ----------------------------------------------------------------------------------------
def answered_length(value: str) -> int:
    """``answer_drafts.value_length``: characters after trimming whitespace, so 0 means "not answered" (review 2,
    CORRECTNESS-09: one definition of a started draft for the Gradebook, Home, the Assignments list and the status CSV)."""
    return len(value.strip())


def draft_progress(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str) -> tuple[int, str | None]:
    """(non-empty draft answers for current questions, last draft update) — preview drafts never count."""
    qids = [q.get("id") for q in rec.questions if isinstance(q.get("id"), str)]
    if not qids:
        return 0, None
    row = db.execute(
        f"""SELECT COUNT(*) AS answered, MAX(updated_at) AS updated FROM answer_drafts
        WHERE class_id=? AND assignment_id=? AND student_id=? AND is_preview=0 AND value_length > 0
        AND question_id IN ({','.join('?' for _ in qids)})""", (rec.class_id, rec.id, student_id, *qids)).fetchone()
    return int(row["answered"] or 0), row["updated"]


# -- gradebook cell --------------------------------------------------------------------------------
def gradebook_cell(db: sqlite3.Connection, rec: AssignmentRecord, student_id: str, policy: str = "latest",
                   now: object = None) -> dict:
    """``GradebookCell`` (§7.5) for one student and one homework under the ``latest`` or ``highest`` policy."""
    from server import readers

    rows = db.execute(
        """SELECT * FROM submissions WHERE class_id=? AND assignment_id=? AND student_id=? AND is_preview=0
        ORDER BY attempt DESC, submitted_at DESC, id DESC""", (rec.class_id, rec.id, student_id)).fetchall()
    maximum = max_points(rec)
    answered, _updated = draft_progress(db, rec, student_id)
    cell = {"assignmentId": rec.id, "state": "not_submitted", "score": None, "maxPoints": maximum, "attempts": len(rows),
            "late": False, "lateSeconds": 0, "overTime": False, "latestSubmissionId": None, "scoredSubmissionId": None,
            "draftAnswered": answered, "draftTotal": len(rec.questions), "label": ""}
    if not rows:
        if not readers.in_audience(db, rec, student_id):
            cell["label"] = NOT_ASSIGNED
            return cell
        from server import analytics

        # D8: the Missing work rule of every view (``analytics.missing_verdict``) — a homework and its revisions count once
        verdict = analytics.missing_verdict(db, rec, student_id, _moment(now)) if rec.kind == "homework" else None
        if verdict is not None and verdict.submitted is not None:
            other = verdict.submitted
            if verdict.submitted_relation == "original":
                # S-M01: a student who submitted the original of this revision is not missing it (grades stay per version)
                cell.update(state="not_submitted", onOriginal=True, originalId=other.id, originalTitle=other.title,
                            label=cell_label("on_original", None, maximum, 0))
            else:
                cell.update(state="not_submitted", onRevision=True, revisionId=other.id, revisionTitle=other.title,
                            label=cell_label("on_revision", None, maximum, 0))
            return cell
        if verdict is not None and verdict.counted_on is not None:
            # D8: the newer version carries this homework for the student (missing there, if anywhere)
            cell.update(state="not_submitted", countedOnId=verdict.counted_on.id, countedOnTitle=verdict.counted_on.title,
                        label=cell_label("counted_on", None, maximum, 0))
            return cell
        if verdict.missing if verdict is not None else past_due(rec, now):
            cell["state"] = "missing"
            if verdict is not None and verdict.originals:
                cell["revisionOfTitle"] = verdict.originals[-1].title
        elif rec.due_at:
            cell["state"] = "not_due"
        else:
            cell["state"] = "not_submitted"
    else:
        latest = rows[0]
        cell.update(latestSubmissionId=latest["id"], late=bool(latest["is_late"]),
                    lateSeconds=int(latest["late_seconds"] or 0), overTime=bool(latest["over_time"]))
        released = [r for r in rows if r["grade_status"] == "released" and r["grade"] is not None]
        best = max(released, key=lambda r: (float(r["grade"]), r["attempt"])) if released else None
        if latest["grade_status"] == "released" and latest["grade"] is not None:
            scored = best if policy == "highest" else latest
            cell.update(state="released", score=scored["grade"], scoredSubmissionId=scored["id"])
        elif latest["grade_status"] == "draft" and latest["grade"] is not None:
            cell.update(state="draft", score=latest["grade"], scoredSubmissionId=latest["id"])
        elif released:
            scored = best if policy == "highest" else released[0]
            cell.update(state="newer_ungraded", score=scored["grade"], scoredSubmissionId=scored["id"])
        else:
            cell["state"] = "submitted_ungraded"
    cell["label"] = cell_label(cell["state"], cell["score"], maximum, len(rows), draft_answered=answered,
                               draft_total=len(rec.questions))
    return cell


# -- latest attempts -------------------------------------------------------------------------------
def latest_ids_sql() -> str:
    """Newest attempt per (class, assignment, student). Preview students have their own ``preview-*`` ids, so the
    partition covers preview rows too; population filters decide whether they count."""
    return ("SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY class_id, assignment_id, student_id "
            "ORDER BY attempt DESC, submitted_at DESC, id DESC) AS rn FROM submissions) WHERE rn = 1")


def latest_population_rows(db: sqlite3.Connection, class_id: str, assignment_ids: Iterable[str] | None = None,
                           group_id: str | None = None, *, include_preview: bool = False) -> list[sqlite3.Row]:
    population, params = identity.population_sql("s", class_linked=identity.class_linked(db, class_id))
    if include_preview:     # preview rows carry actor_role='preview', so add them explicitly
        population = f"(({population}) OR s.is_preview = 1)"
    where =[f"s.id IN ({latest_ids_sql()})", "s.class_id = ?", "a.deleted_at IS NULL", population]
    values: list[object] = [class_id, *params]
    ids = list(assignment_ids) if assignment_ids is not None else None
    if ids is not None:
        if not ids:
            return []
        where.append(f"s.assignment_id IN ({','.join('?' for _ in ids)})")
        values.extend(ids)
    if group_id:
        where.append("EXISTS (SELECT 1 FROM group_members m WHERE m.class_id = s.class_id AND m.group_id = ? "
                     "AND m.student_id = s.student_id)")
        values.append(group_id)
    return db.execute(
        f"""SELECT s.* FROM submissions s JOIN assignments a ON a.id = s.assignment_id AND a.class_id = s.class_id
        WHERE {' AND '.join(where)} ORDER BY s.submitted_at, s.id""", values).fetchall()


# -- integrity flags -------------------------------------------------------------------------------
def _timeline_href(student_id: str, assignment_id: str) -> str:
    return f"/teacher/students/s/{quote(student_id, safe='')}/assignments/{quote(assignment_id, safe='')}"


def _answers(row: sqlite3.Row) -> dict:
    try:
        data = json.loads(row["answers_json"] or "{}")
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def identical_index(db: sqlite3.Connection, class_id: str, assignment_ids: Iterable[str]) -> dict[tuple, set[str]]:
    """(assignment, question, normalized answer ≥ 40 chars) → students whose latest submission has that answer."""
    index: dict[tuple, set[str]] = {}
    for row in latest_population_rows(db, class_id, sorted(set(assignment_ids))):
        for qid, answer in _answers(row).items():
            key = normalize_answer(answer)
            if len(key) >= IDENTICAL_MIN_CHARS:
                index.setdefault((row["assignment_id"], qid, key), set()).add(row["student_id"])
    return index


def flags_for(db: sqlite3.Connection, class_id: str, submission_ids: Iterable[str],
              index: dict[tuple, set[str]] | None = None) -> dict[str, list[dict]]:
    """Integrity flags (§9.2) per submission: ``ai_final_answer``, ``paste_from_ai``, ``identical_answer``.

    Flags are prompts for review, never penalties. AI and paste evidence counts only up to the submission time.
    """
    ids = [s for s in dict.fromkeys(submission_ids) if s]
    result: dict[str, list[dict]] = {s: [] for s in ids}
    if not ids:
        return result
    rows: list[sqlite3.Row] = []
    for start in range(0, len(ids), 400):
        chunk = ids[start:start + 400]
        rows.extend(db.execute(
            f"""SELECT s.*,
            EXISTS (SELECT 1 FROM chat_turns ct WHERE ct.class_id = s.class_id AND ct.student_id = s.student_id
                    AND ct.flagged = 1 AND ct.created_at <= s.submitted_at
                    AND (ct.assignment_id = s.assignment_id OR EXISTS (SELECT 1 FROM ai_calls c WHERE c.id = ct.ai_call_id
                         AND c.homework_match_assignment_id = s.assignment_id))) AS ai_flag,
            EXISTS (SELECT 1 FROM events e WHERE e.class_id = s.class_id AND e.student_id = s.student_id
                    AND e.event_type = 'paste' AND e.created_at <= s.submitted_at
                    AND json_extract(e.payload_json, '$.matchesAiReply') = 1
                    AND CAST(COALESCE(json_extract(e.payload_json, '$.length'), 0) AS INTEGER) >= {PASTE_MIN_CHARS}
                    AND (e.attribution_assignment_id = s.assignment_id
                         OR json_extract(e.payload_json, '$.assignmentId') = s.assignment_id)) AS paste_flag
            FROM submissions s WHERE s.class_id = ? AND s.id IN ({','.join('?' for _ in chunk)})""",
            (class_id, *chunk)).fetchall())
    if index is None:
        index = identical_index(db, class_id, {r["assignment_id"] for r in rows})
    from server import readers

    positions: dict[str, dict[str, int]] = {}
    for row in rows:
        flags = result[row["id"]]
        href = _timeline_href(row["student_id"], row["assignment_id"])
        if row["ai_flag"]:
            flags.append({"kind": "ai_final_answer", "text": FLAG_TEXT["ai_final_answer"], "href": href})
        if row["paste_flag"]:
            flags.append({"kind": "paste_from_ai", "text": FLAG_TEXT["paste_from_ai"], "href": href})
        best: tuple[int, str] | None = None
        for qid, answer in _answers(row).items():
            key = normalize_answer(answer)
            if len(key) < IDENTICAL_MIN_CHARS:
                continue
            others = index.get((row["assignment_id"], qid, key), set()) - {row["student_id"]}
            if others and (best is None or len(others) > best[0]):
                best = (len(others), qid)
        if best is not None:
            query = urlencode({"assignmentId": row["assignment_id"], "view": "question", "questionId": best[1], "show": "all"})
            if row["assignment_id"] not in positions:
                rec = readers.load_assignment(db, class_id, row["assignment_id"], include_deleted=True)
                positions[row["assignment_id"]] = {q.get("id"): n for n, q in enumerate(rec.questions, 1)} if rec else {}
            number = positions[row["assignment_id"]].get(best[1])
            # S-m06: name the question the answer matches on
            where = f" on Q{number}" if number else ""
            flags.append({"kind": "identical_answer", "text": f"Same answer as {plural(best[0], 'other student')}{where}",
                          "href": f"/teacher/grading?{query}"})
    return result


def flagged_ids(db: sqlite3.Connection, class_id: str, rows: list[sqlite3.Row]) -> set[str]:
    flags = flags_for(db, class_id, [r["id"] for r in rows])
    return {sid for sid, items in flags.items() if any(f["kind"] in INTEGRITY_FLAGS for f in items)}


# -- counts ----------------------------------------------------------------------------------------
def grading_counts(db: sqlite3.Connection, class_id: str, assignment_id: str | None = None,
                   group_id: str | None = None) -> dict:
    """Counts over the latest non-preview attempt per (student, assignment) within the population.

    ``toGrade`` ungraded · ``late`` late · ``draft``/``toRelease`` drafts ready to release · ``graded`` draft or
    released · ``flagged`` at least one integrity flag · ``all`` latest attempts.
    """
    rows = latest_population_rows(db, class_id, [assignment_id] if assignment_id else None, group_id)
    statuses = [r["grade_status"] for r in rows]
    drafts = sum(1 for r in rows if r["grade_status"] == "draft" and r["grade"] is not None)
    return {"toGrade": statuses.count("ungraded"), "late": sum(1 for r in rows if r["is_late"]), "draft": drafts,
            "toRelease": drafts, "flagged": len(flagged_ids(db, class_id, rows)),
            "graded": sum(1 for s in statuses if s in ("draft", "released")), "all": len(rows)}
