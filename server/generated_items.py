"""Generated practice items: generation, persistence, server checks, reveal, verification, review (AIRUN; spec §12.8).

Request → access/quota/policy checks → (AI configured ? provider : local templates / teacher bank) → validate →
novelty (source data, the student's last 5 items) → item guard (similar items and homework-derived free items) → one
regeneration on failure → seeded choice shuffle → ``generated_items`` row (+ rejected drafts) → server events →
``GeneratedItemPublic`` without answer keys. Students check items through the server only; the explanation is withheld
while the related homework question is protected (``readers.answer_protected``). ``verify`` stores one client webR run of
a predict item's code without ever telling the student whether it matched (no answer oracle).
"""

from __future__ import annotations

import hashlib
import json
import random
import sqlite3
import uuid
from datetime import datetime, time as dtime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from server import ai_policy, ai_runtime, course_config, identity, judging, leak_guard, local_templates, readers
from server import db as dbmod
from server.contracts import AiError
from server.router import ApiError, Request, valid_id

AI_TYPES = ("choice", "fill", "predict", "complete", "explain")
NOVELTY_RETRY = ("The previous exercise reused the source inputs or repeated a recent exercise. Generate a fresh exercise now. "
                 "Change the concrete numbers or categorical data; retain only the underlying skill. Return the required JSON.")
LEAK_RETRY = ("The previous exercise revealed the answer or solution code of a graded homework question. Write a different "
              "exercise whose answer, choices and code differ from that homework. Return the required JSON.")
INVALID_RETRY = "The previous reply was not a valid exercise. Return only the JSON object with every required field."
NOT_NOVEL_MESSAGE = "AI repeated the source example. Generate another exercise to get new data."
UNSAFE_MESSAGE = "Kiwi couldn't create a practice exercise that keeps your homework answer private. Try again or pick another chapter."
# S-m09: "Try a similar question" has no chapter choice, so its message says what the student can do there
UNSAFE_SIMILAR_MESSAGE = ("Kiwi couldn't create a similar exercise that keeps your homework answer private. Try again, or pick "
                          "another chapter in Practice with AI.")
INVALID_MESSAGE = "AI returned an invalid exercise. Please retry."
HOMEWORK_BLOCKED = "This looks like graded homework. Practice on that assignment's page instead."
WITHHELD = "The explanation is shown after the homework closes."
MISMATCH_NOTICE = "This exercise failed an automatic check; its answer key may be wrong."
REJECTED = ("rejected_invalid", "rejected_leak", "rejected_not_novel")
RECENT_ITEMS = 5


def new_item_id() -> str:
    """``gi-`` + 24 hex (tests patch this with a deterministic sequence, AIRUN-09)."""
    return "gi-" + uuid.uuid4().hex[:24]


def shuffle_seed(item_id: str) -> int:
    return int(hashlib.sha256(item_id.encode("utf-8")).hexdigest()[:8], 16)


def shuffle_choices(item: dict, item_id: str) -> tuple[dict, list[int], int | None]:
    """Fisher–Yates with ``random.Random(seed)``; returns (item with display-order choices, original indices, seed)."""
    choices = item.get("choices")
    if not isinstance(choices, list) or len(choices) < 2:
        return item, [], None
    seed = shuffle_seed(item_id)
    rng = random.Random(seed)
    order = list(range(len(choices)))
    for i in range(len(order) - 1, 0, -1):
        j = rng.randint(0, i)
        order[i], order[j] = order[j], order[i]
    return {**item, "choices": [choices[k] for k in order]}, order, seed


def _loads(value: object, default: Any) -> Any:
    try:
        data = json.loads(value) if isinstance(value, str) else default
    except json.JSONDecodeError:
        return default
    return data if isinstance(data, type(default)) else default


def _needs_verification(qtype: str, item: dict) -> bool:
    return qtype == "predict" and bool(str(item.get("code") or "").strip())


def public_item(row: sqlite3.Row | dict, policy_label: str) -> dict:
    """``GeneratedItemPublic`` (no answer, explanation, expected output or accepted answers)."""
    item = _loads(row["item_json"], {})
    out = {"id": row["id"], "origin": row["origin"], "unitId": row["unit_id"], "type": row["question_type"],
           "difficulty": row["difficulty"], "title": item.get("title", ""), "prompt": item.get("prompt", ""),
           "source": row["source"], "policyLabel": policy_label,
           "needsVerification": row["verification"] == "unverified"}
    for key in ("code", "starterCode"):
        if item.get(key):
            out[key] = item[key]
    if item.get("choices"):
        out["choices"] = list(item["choices"])
    return out


# ─── Usage counters (daily limit, unlock rule) ────────────────────────────────────────────────

def _day_start(db: sqlite3.Connection, class_id: str) -> str:
    tz_name = (readers.settings(db, class_id).get("schedule") or {}).get("timezone") or course_config.DEFAULT_TIMEZONE
    try:
        tz = ZoneInfo(tz_name)
    except (KeyError, ValueError):
        tz = ZoneInfo(course_config.DEFAULT_TIMEZONE)
    local = dbmod.utcnow().astimezone(tz)
    start = datetime.combine(local.date(), dtime(0, 0), tz).astimezone(timezone.utc)
    return dbmod.iso_seconds(start)


def used_today(db: sqlite3.Connection, class_id: str, student_id: str) -> int:
    return int(db.execute(
        f"""SELECT COUNT(*) FROM generated_items WHERE class_id=? AND student_id=? AND created_at >= ?
        AND status NOT IN ({','.join('?' for _ in REJECTED)})""",
        (class_id, student_id, _day_start(db, class_id), *REJECTED)).fetchone()[0])


def correct_items_at(db: sqlite3.Connection, class_id: str, student_id: str, unit_id: str, difficulty: int) -> int:
    """Distinct items at ``difficulty`` in the chapter with at least one server-checked correct answer."""
    return int(db.execute(
        """SELECT COUNT(DISTINCT gi.id) FROM generated_items gi JOIN events e ON e.class_id=gi.class_id AND e.item_id=gi.id
        WHERE gi.class_id=? AND gi.student_id=? AND gi.unit_id=? AND gi.difficulty=? AND e.student_id=gi.student_id
        AND e.event_type='answer_submitted' AND e.checked_by='server' AND json_extract(e.payload_json, '$.correct')=1""",
        (class_id, student_id, unit_id, difficulty)).fetchone()[0])


def unlocked_max(db: sqlite3.Connection, class_id: str, student_id: str, unit_id: str, config: dict) -> int:
    """Highest difficulty the student may request: levels above ``startingDifficulty`` need N correct at the level below."""
    needed = int((config.get("practice") or {}).get("unlockAfterCorrect") or 0)
    top = int(config.get("maxDifficulty") or 5)
    if needed <= 0:
        return top
    level = max(int(config.get("startingDifficulty") or 1), int(config.get("minDifficulty") or 1))
    while level < top and correct_items_at(db, class_id, student_id, unit_id, level) >= needed:
        level += 1
    return level


def practice_status(db: sqlite3.Connection, class_id: str, student_id: str, unit_id: str,
                    config: dict | None = None) -> dict:
    """Student-specific ``PublicPolicy.practice`` fields: ``usedToday`` and ``unlockedMaxDifficulty`` (AIRUN-25)."""
    if config is None:
        config = ai_policy.with_defaults(ai_policy.resolve(db, class_id, unit_id, student_id).config)
    practice = config.get("practice") or {}
    return {"unitId": unit_id, "usedToday": used_today(db, class_id, student_id),
            "dailyItemLimit": int(practice.get("dailyItemLimit") or 0),
            "unlockAfterCorrect": int(practice.get("unlockAfterCorrect") or 0),
            "startingDifficulty": int(config.get("startingDifficulty") or 1),
            "unlockedMaxDifficulty": unlocked_max(db, class_id, student_id, unit_id, config)}


def recent_prompts(db: sqlite3.Connection, class_id: str, student_id: str, unit_id: str) -> list[str]:
    rows = db.execute(
        """SELECT item_json FROM generated_items WHERE class_id=? AND student_id=? AND unit_id=? AND status IN ('active','flagged')
        ORDER BY created_at DESC, rowid DESC LIMIT ?""", (class_id, student_id, unit_id, RECENT_ITEMS)).fetchall()
    return [ai_runtime.item_signature(_loads(r["item_json"], {})) for r in rows]


# ─── Generation ───────────────────────────────────────────────────────────────────────────────

class _Spec:
    """Everything one generation request needs after the access and policy checks."""

    def __init__(self, **values: Any) -> None:
        self.__dict__.update(values)


def _store_item(db: sqlite3.Connection, ident: Any, spec: _Spec, item_id: str, item: dict, qtype: str, *, status: str,
                source: str, call_id: int | None, model: object, retries: int, guard_status: str,
                order: list[int] | None = None, seed: int | None = None) -> None:
    section, condition = readers.group_stamp(db, ident.class_id, ident.student_id or "")
    match = spec.match
    related_aid, related_qid = spec.related
    verification = "unverified" if status == "active" and _needs_verification(qtype, item) else "not_applicable"
    db.execute(
        """INSERT INTO generated_items (id, class_id, student_id, actor_role, is_preview, identity_verified, origin, unit_id,
        related_assignment_id, related_question_id, question_type, difficulty, requested_type, requested_difficulty, focus_note,
        item_json, choice_order_json, shuffle_seed, source, ai_call_id, policy_version_id, model, novelty_retries, guard_status,
        homework_match_assignment_id, homework_match_question_id, homework_match_score, verification, section_group_id,
        condition_group_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (item_id, ident.class_id, ident.student_id, ident.actor_role, int(bool(ident.preview)), int(bool(ident.verified)),
         spec.origin, spec.unit["id"], related_aid, related_qid, qtype, spec.difficulty, spec.requested_type,
         spec.requested_difficulty, spec.focus_note, dbmod.json_dumps(item), dbmod.json_dumps(order or []), seed, source,
         call_id, spec.resolved.version_id, model, retries, guard_status,
         match.assignment_id if match else "", match.question_id if match else "", match.containment if match else None,
         verification, section, condition, status, dbmod.now()))


def _rejected(db: sqlite3.Connection, ident: Any, spec: _Spec, item: dict | None, raw: str, failure: str, qtype: str,
              source: str, call_id: int | None, model: object, retries: int) -> None:
    status = {"not_novel": "rejected_not_novel", "leak": "rejected_leak"}.get(failure, "rejected_invalid")
    stored = item if isinstance(item, dict) else {"raw": raw[:4000]}
    _store_item(db, ident, spec, new_item_id(), stored, qtype, status=status, source=source, call_id=call_id, model=model,
                retries=retries, guard_status="blocked" if failure == "leak" else spec.guard_default)


def _attempt(spec: _Spec, text: str, recent: list[str]) -> tuple[dict | None, str | None]:
    """Validate → novelty → item guard; returns (item, failure) with failure in invalid_output|validation_error|not_novel|leak."""
    try:
        item = ai_runtime.validate_question(text, {"type": spec.qtype, "choiceCount": spec.config.get("choiceCount", 4),
                                                   "replyLanguage": spec.config.get("replyLanguage", "English")})
    except ai_runtime.InvalidOutput as exc:
        return None, exc.kind
    except ValueError:
        return None, "validation_error"
    if not ai_runtime.is_novel(item, spec.source_text, recent):
        return item, "not_novel"
    if spec.protection.protected and leak_guard.check_item(item, spec.protection.items).leaked:
        return item, "leak"
    return item, None


def _finish(db: sqlite3.Connection, ident: Any, spec: _Spec, item: dict, qtype: str, *, source: str, call_id: int | None,
            model: object, retries: int, guard_status: str, usage: dict | None) -> dict:
    item_id = new_item_id()
    shown, order, seed = shuffle_choices(item, item_id)
    with dbmod.write_tx(db):
        _store_item(db, ident, spec, item_id, shown, qtype, status="active", source=source, call_id=call_id, model=model,
                    retries=retries, guard_status=guard_status, order=order, seed=seed)
        if call_id is not None:
            ai_runtime.finish_call(db, call_id, status="ok" if source == "ai" else "local", meta=usage, item_id=item_id,
                                   guard_status=guard_status)
        surface = "similar" if spec.origin == "similar" else "free-practice"
        related_aid, related_qid = spec.related
        payload = {"itemId": item_id, "origin": spec.origin, "unitId": spec.unit["id"], "type": qtype,
                   "difficulty": spec.difficulty, "requestedType": spec.requested_type,
                   "requestedDifficulty": spec.requested_difficulty, "focusNote": spec.focus_note,
                   "title": shown.get("title", ""), "prompt": shown.get("prompt", ""), "choices": shown.get("choices") or [],
                   "choiceOrder": order, "source": source, "policyVersionId": spec.resolved.version_id, "model": model,
                   "relatedAssignmentId": related_aid or None, "relatedQuestionId": related_qid or None,
                   "aiCallId": call_id, "effectiveAccess": spec.access, "guardStatus": guard_status,
                   **({"homeworkMatchAssignmentId": spec.match.assignment_id} if spec.match else {})}
        ai_runtime.server_event(db, ident, "question_generated", payload, question_id=item_id, surface=surface)
        if spec.origin == "similar":
            ai_runtime.server_event(db, ident, "similar_requested", {
                "sourceAssignmentId": related_aid, "sourceQuestionId": related_qid, "itemId": item_id, "unitId": spec.unit["id"],
                "relatedAssignmentId": related_aid}, question_id=related_qid or None, surface="similar")
        row = db.execute("SELECT * FROM generated_items WHERE id=?", (item_id,)).fetchone()
    return public_item(row, spec.resolved.scope_label)


def _fail_generation(db: sqlite3.Connection, ident: Any, spec: _Spec, call_id: int, failure: str) -> ApiError:
    status = {"not_novel": "not_novel", "invalid_output": "invalid_output", "leak": "validation_error"}.get(failure, "validation_error")
    error: ApiError
    if failure == "not_novel":
        error = ApiError(400, "not_novel", NOT_NOVEL_MESSAGE)
    elif failure == "leak":
        error = ApiError(422, "unsafe_item", UNSAFE_SIMILAR_MESSAGE if spec.origin == "similar" else UNSAFE_MESSAGE,
                         {"reason": "unsafe_item"})
    else:
        error = AiError(502, "ai_invalid_output", INVALID_MESSAGE, {"reason": failure})
    ai_runtime.failed(db, ident, call_id, status=status, action=spec.action, surface=spec.surface, unit_id=spec.unit["id"],
                      assignment_id=spec.related[0], question_id=spec.related[1], error=error)
    if failure == "leak":
        with dbmod.write_tx(db):
            db.execute("UPDATE ai_calls SET guard_status='blocked' WHERE id=?", (call_id,))
    return error


def _generate_ai(req: Request, spec: _Spec) -> dict:
    db, ident, cls = req.db, req.identity, req.class_id
    student_id = ident.student_id or ""
    recent = recent_prompts(db, cls, student_id, spec.unit["id"])
    context = {"unitId": spec.unit["id"], "chapter": spec.unit.get("title"), "goal": spec.unit.get("goal"), "type": spec.qtype,
               "difficulty": spec.difficulty, "focusNote": spec.focus_note, "sourceQuestion": spec.source_text,
               "recentExercises": recent}
    context.update(ai_runtime.chapter_resources(db, cls, spec.unit, spec.config))
    body, meta = ai_runtime.assemble_with_meta(db, cls, spec.resolved, "question", context)
    try:
        reservation = ai_runtime.reserve_budget(db, ident, cls, req.client_addr)
    except AiError as exc:
        raise ai_runtime.reject(db, ident, cls, exc, status="rate_limited", match=spec.match, **spec.log) from None
    call_id = ai_runtime.log_call(db, ident, cls, status="pending", request=body, meta=meta, match=spec.match, **spec.log)
    model = body.get("model")
    failures: list[str] = []
    item: dict | None = None
    usage: dict = {}
    text = ""
    try:
        with ai_runtime.provider_slot() as queue_ms:
            request = body
            for attempt in (1, 2):
                target = call_id
                if attempt == 2:  # one regeneration (novelty, leak or schema failure), logged as a child call
                    retry = {"not_novel": NOVELTY_RETRY, "leak": LEAK_RETRY}.get(failures[-1], INVALID_RETRY)
                    request = {**request, "input": [*request["input"], {"role": "assistant", "content": text},
                                                     {"role": "developer", "content": retry}]}
                    target = ai_runtime.log_call(db, ident, cls, status="pending", request=request, attempt=2,
                                                 parent_call_id=call_id, match=spec.match, **spec.log)
                try:
                    text, usage = ai_runtime.invoke(db, request, cls, student_id, queue_ms if attempt == 1 else 0)
                except AiError as exc:
                    if attempt == 2:
                        with dbmod.write_tx(db):
                            ai_runtime.finish_call(db, target, status=ai_runtime.STATUS_FOR_CODE.get(exc.code, "provider_error"),
                                                   error_code=exc.code, error_message=exc.message)
                    raise
                item, failure = _attempt(spec, text, recent)
                with dbmod.write_tx(db):
                    if attempt == 2:
                        ai_runtime.finish_call(db, target, status=_STATUS_FOR_FAILURE.get(failure or "", "ok"), meta=usage,
                                               raw_output=text)
                    else:  # the parent keeps the original reply; its final status is written below
                        ai_runtime.finish_call(db, target, status="pending", meta=usage, raw_output=text)
                    if failure is not None:
                        _rejected(db, ident, spec, item, text, failure, spec.qtype, "ai", call_id, model, attempt - 1)
                if failure is None:
                    break
                failures.append(failure)
    except AiError as exc:
        status = ai_runtime.STATUS_FOR_CODE.get(exc.code, "provider_error")
        if status in ai_runtime.REFUNDED:
            ai_runtime.refund_budget(reservation)
        ai_runtime.failed(db, ident, call_id, status=status, action=spec.action, surface=spec.surface,
                          unit_id=spec.unit["id"], assignment_id=spec.related[0], question_id=spec.related[1], error=exc)
        raise
    if item is None or len(failures) >= 2:
        raise _fail_generation(db, ident, spec, call_id, failures[-1] if failures else "validation_error")
    guard = "not_applicable" if not spec.protection.protected else ("retried_clean" if "leak" in failures else "clean")
    return _finish(db, ident, spec, item, spec.qtype, source="ai", call_id=call_id, model=model, retries=len(failures),
                   guard_status=guard, usage=usage)


_STATUS_FOR_FAILURE = {"not_novel": "not_novel", "invalid_output": "invalid_output", "validation_error": "validation_error",
                       "leak": "validation_error"}


def _generate_local(req: Request, spec: _Spec) -> dict:
    db, ident, cls = req.db, req.identity, req.class_id
    unit_id = spec.unit["id"]
    failures: list[str] = []
    for attempt in (1, 2):
        seed = f"{ident.student_id}:{unit_id}:{spec.qtype}:{spec.difficulty}:{dbmod.now_ms()}:{attempt}:{uuid.uuid4().hex[:6]}"
        made = None
        if spec.origin == "similar" and spec.source_question is not None:
            similar = local_templates.similar_template(spec.source_question, unit_id, spec.qtype, spec.difficulty, seed)
            if similar is not None:
                made = (similar[0], similar[1], "local_template")
        elif unit_id in local_templates.BUILTIN_UNITS:
            made = (local_templates.template_item(unit_id, spec.qtype, spec.difficulty, seed), spec.qtype, "local_template")
        if made is None:
            bank = local_templates.bank_item(db, cls, unit_id, spec.qtype, list(spec.config.get("allowedTypes") or []), seed,
                                             dbmod.utcnow())
            if bank is not None:
                made = (bank[0], bank[1], "teacher_bank")
        if made is None:
            raise ai_runtime.reject(db, ident, cls, ApiError(409, "no_local_practice", local_templates.NO_LOCAL_PRACTICE),
                                    status="unavailable", match=spec.match, **spec.log)
        item, qtype, source = made
        if spec.protection.protected and leak_guard.check_item(item, spec.protection.items).leaked:
            failures.append("leak")
            continue
        call_id = ai_runtime.log_call(db, ident, cls, status="local", match=spec.match, **spec.log)
        guard = "not_applicable" if not spec.protection.protected else ("retried_clean" if failures else "clean")
        return _finish(db, ident, spec, item, qtype, source=source, call_id=call_id, model=None, retries=len(failures),
                       guard_status=guard, usage=None)
    call_id = ai_runtime.log_call(db, ident, cls, status="pending", match=spec.match, **spec.log)
    with dbmod.write_tx(db):
        _rejected(db, ident, spec, made[0] if made else None, "", "leak", spec.qtype, made[2] if made else "local_template",
                  call_id, None, 1)
    raise _fail_generation(db, ident, spec, call_id, "leak")


def _common(req: Request) -> tuple[dict, Any]:
    db = req.db
    ai_runtime.ensure_init(db)
    ai_runtime.commit_open(db)
    data = req.student_body()
    ai_runtime.reject_overrides(data)
    if not valid_id(data.get("studentId")):
        raise ApiError(400, "invalid_request", "A valid student identity is required")
    return data, req.identity


def _difficulty(data: dict) -> int:
    value = data.get("difficulty")
    if type(value) is not int or not 1 <= value <= 5:
        raise ApiError(400, "invalid_request", "Difficulty must be an integer from 1 to 5")
    return value


def generate_free(req: Request) -> dict:
    """``POST /api/ai/question`` — free practice (legacy bodies with ``sourceQuestion`` accepted, deprecated)."""
    data, ident = _common(req)
    db, cls = req.db, req.class_id
    legacy = "surface" not in data
    if not legacy and data.get("surface") != "free-practice":
        raise ApiError(400, "invalid_request", "surface must be free-practice")
    qtype = data.get("type")
    if qtype not in AI_TYPES:
        raise ApiError(400, "invalid_request", "Choose a supported question type")
    difficulty = _difficulty(data)
    focus = ai_runtime.text_field(data, "focusNote", 400, label="Focus note").strip()
    source_question = ai_runtime.text_field(data, "sourceQuestion", 4000).strip()
    _course, unit = ai_runtime.find_unit(db, cls, data.get("unitId"))
    student_id = data["studentId"]
    resolved = ai_policy.resolve(db, cls, unit["id"], student_id)
    config = ai_policy.with_defaults(resolved.config)
    access = ai_runtime.access_payload(unit)
    log = dict(action="question", surface="free-practice" if not legacy else "legacy", resolved=resolved, unit_id=unit["id"])
    if access in ("locked", "hidden"):
        raise ai_runtime.reject(db, ident, cls, ApiError(403, "chapter_closed", ai_runtime.CHAPTER_CLOSED),
                                status="blocked_chapter", **log)
    if access == "review" or not config.get("generationEnabled", True):
        message = ("This chapter is open for review: Ask Kiwi works, new practice exercises do not."
                   if access == "review" else "Your teacher turned off generated practice for this chapter.")
        raise ai_runtime.reject(db, ident, cls, ApiError(403, "generation_disabled", message),
                                status="blocked_generation_disabled", **log)
    if qtype not in config["allowedTypes"] or not config["minDifficulty"] <= difficulty <= config["maxDifficulty"]:
        raise ai_runtime.reject(db, ident, cls, ApiError(
            400, "invalid_request", "Requested question type or difficulty is outside the teacher policy. Refresh the settings."),
            status="validation_error", **log)
    if focus and not (config.get("practice") or {}).get("allowFocusNote", True):
        raise ai_runtime.reject(db, ident, cls, ApiError(400, "invalid_request", "Your teacher turned off focus notes for this chapter."),
                                status="validation_error", **log)
    _limits(db, ident, cls, unit, config, difficulty, log, check_unlock=True)
    now = dbmod.utcnow()
    match_text = "\n".join(t for t in (focus, source_question) if t)
    protection = leak_guard.protection(db, cls, student_id, {"text": match_text, "unitId": unit["id"]}, now) \
        if match_text else leak_guard.Protection()
    match = protection.match
    if match is not None and (not match.rec.tool_policy.similar_practice or match.rec.tool_policy.ask_kiwi == "off"):
        raise ai_runtime.reject(db, ident, cls, ApiError(403, "tool_disabled", HOMEWORK_BLOCKED),
                                status="blocked_homework_match", match=match, **log)
    spec = _Spec(origin="free", unit=unit, resolved=resolved, config=config, qtype=qtype, difficulty=difficulty,
                 requested_type=qtype, requested_difficulty=difficulty, focus_note=focus, source_text=source_question,
                 source_question=None, related=("", ""), protection=protection, match=match, access=access, log=log,
                 action="question", surface=log["surface"],
                 guard_default="clean" if protection.protected else "not_applicable")
    if not legacy and not ai_runtime._ai().available():
        return _generate_local(req, spec)
    return _generate_ai(req, spec)


def _limits(db: sqlite3.Connection, ident: Any, cls: str, unit: dict, config: dict, difficulty: int, log: dict, *,
            check_unlock: bool) -> None:
    practice = config.get("practice") or {}
    needed = int(practice.get("unlockAfterCorrect") or 0)
    start = int(config.get("startingDifficulty") or 1)
    if check_unlock and needed > 0 and difficulty > start:
        have = correct_items_at(db, cls, ident.student_id or "", unit["id"], difficulty - 1)
        if have < needed or unlocked_max(db, cls, ident.student_id or "", unit["id"], config) < difficulty:
            raise ai_runtime.reject(db, ident, cls, ApiError(
                403, "difficulty_locked",
                f"Level {difficulty} unlocks after {needed} correct exercises at level {difficulty - 1} (you have {have}).",
                {"level": difficulty, "needed": needed, "have": have}), status="difficulty_locked", **log)
    limit = int(practice.get("dailyItemLimit") or 0)
    if limit > 0 and used_today(db, cls, ident.student_id or "") >= limit:
        raise ai_runtime.reject(db, ident, cls, ApiError(
            429, "daily_quota", f"You reached today's limit of {limit} practice exercises. Come back tomorrow.",
            {"limit": limit}), status="daily_quota", **log)


def generate_similar(req: Request) -> dict:
    """``POST /api/ai/similar`` — the server loads the source question itself (AU-D2-10)."""
    data, ident = _common(req)
    db, cls = req.db, req.class_id
    assignment_id = ai_runtime.optional_id(data, "assignmentId")
    question_id = ai_runtime.optional_id(data, "questionId")
    if not assignment_id or not question_id:
        raise ApiError(400, "invalid_request", "assignmentId and questionId are required")
    difficulty = _difficulty(data)
    rec = ai_runtime.visible_assignment(db, ident, cls, assignment_id)
    source = readers.assignment_question(rec, question_id)
    if source is None:
        raise ApiError(404, "not_found", "Question not found in assignment")
    course = course_config.course_for(cls, db)
    unit = next((u for u in course["units"] if u["id"] == rec.unit_id),
                {"id": rec.unit_id, "title": rec.unit_id, "goal": "", "effectiveAccess": "open", "runtime": {}})
    student_id = data["studentId"]
    resolved = ai_policy.resolve(db, cls, unit["id"], student_id)
    config = ai_policy.with_defaults(resolved.config)
    log = dict(action="similar", surface="similar", resolved=resolved, unit_id=unit["id"], assignment_id=assignment_id,
               question_id=question_id)
    if not rec.tool_policy.similar_practice:
        raise ai_runtime.reject(db, ident, cls, ApiError(403, "tool_disabled", "Similar practice is not available for this assignment."),
                                status="blocked_tool_policy", **log)
    allowed = list(config.get("allowedTypes") or ["predict"])
    requested = data.get("type")
    if requested is not None and requested not in AI_TYPES:
        raise ApiError(400, "invalid_request", "Choose a supported question type")
    preferred = requested or ("predict" if source.get("type") in ("text", "complete") else source.get("type"))
    qtype = preferred if preferred in allowed else allowed[0]
    if not config["minDifficulty"] <= difficulty <= config["maxDifficulty"]:
        raise ai_runtime.reject(db, ident, cls, ApiError(
            400, "invalid_request", "Requested question type or difficulty is outside the teacher policy. Refresh the settings."),
            status="validation_error", **log)
    _limits(db, ident, cls, unit, config, difficulty, log, check_unlock=False)
    protection = leak_guard.Protection(items=[(rec, source, "similar")])
    spec = _Spec(origin="similar", unit=unit, resolved=resolved, config=config, qtype=qtype, difficulty=difficulty,
                 requested_type=requested or qtype, requested_difficulty=difficulty, focus_note="",
                 source_text=f"{source.get('prompt', '')}\n{source.get('starterCode', '')}", source_question=source,
                 related=(assignment_id, question_id), protection=protection, match=None,
                 access=ai_runtime.access_payload(unit), log=log, action="similar", surface="similar", guard_default="clean")
    if not ai_runtime._ai().available():
        return _generate_local(req, spec)
    return _generate_ai(req, spec)


# ─── Student item endpoints ───────────────────────────────────────────────────────────────────

def owned_item(req: Request, item_id: str) -> sqlite3.Row:
    if not req.as_student():
        raise ApiError(403, "preview_required", "Staff accounts open the student view through Preview as student.")
    row = req.db.execute("SELECT * FROM generated_items WHERE class_id=? AND id=?", (req.class_id, item_id)).fetchone()
    if row is None or row["status"] in REJECTED:
        raise ApiError(404, "not_found", "Practice item not found")
    if row["student_id"] != req.identity.student_id:
        raise ApiError(403, "forbidden", "This practice item belongs to another student")
    return row


def _related(row: sqlite3.Row) -> tuple[str, str]:
    if row["origin"] == "similar" and row["related_assignment_id"]:
        return row["related_assignment_id"], row["related_question_id"]
    if row["homework_match_assignment_id"]:
        return row["homework_match_assignment_id"], row["homework_match_question_id"]
    return "", ""


def explanation_withheld(db: sqlite3.Connection, row: sqlite3.Row, student_id: str, now: object = None) -> bool:
    """Homework-derived and similar items keep their explanation while the related homework question is protected."""
    aid, _qid = _related(row)
    if not aid:
        return False
    rec = readers.load_assignment(db, row["class_id"], aid)
    return rec is not None and readers.answer_protected(db, rec, student_id, now)


def _checks(db: sqlite3.Connection, row: sqlite3.Row) -> list[dict]:
    rows = db.execute(
        """SELECT event_id, payload_json, created_at FROM events WHERE class_id=? AND item_id=? AND student_id=?
        AND event_type='answer_submitted' AND checked_by IN ('server', '') ORDER BY created_at, id""",
        (row["class_id"], row["id"], row["student_id"])).fetchall()
    out = []
    for r in rows:
        payload = _loads(r["payload_json"], {})
        if payload.get("checkedBy") == "server":
            out.append({**payload, "_eventId": r["event_id"], "_at": r["created_at"]})
    return out


def _judge_question(row: sqlite3.Row, item: dict) -> dict:
    qtype = row["question_type"]
    question = {"id": row["id"], "type": "text" if qtype == "explain" else qtype, "prompt": item.get("prompt", ""),
                "answer": item.get("answer", ""), "acceptedAnswers": item.get("acceptedAnswers") or [],
                "choices": item.get("choices") or [], "starterCode": item.get("starterCode") or ""}
    if qtype == "complete":
        question["expectedOutput"] = item.get("expectedOutput") or ""
        question["answer"] = item.get("expectedOutput") or item.get("answer", "")
    return question


def _feedback(req: Request, row: sqlite3.Row, item: dict, answer: str, config: dict, resolved) -> tuple[str | None, int | None]:
    """AI feedback on an ``explain`` answer (``ai_calls.action='feedback'``); ``(None, None)`` without AI."""
    db, ident, cls = req.db, req.identity, req.class_id
    if not ai_runtime._ai().available() or not answer.strip():
        return None, None
    context = {"unitId": row["unit_id"], "question": item.get("prompt"), "studentAnswer": answer,
               "rubric": item.get("rubric") or item.get("explanation"), "modelAnswer": item.get("answer"),
               "packages": [], "prompt": "Please give feedback on my explanation."}
    body, meta = ai_runtime.assemble_with_meta(db, cls, resolved, "feedback", context)
    log = dict(action="feedback", surface="similar" if row["origin"] == "similar" else "free-practice", resolved=resolved,
               unit_id=row["unit_id"], item_id=row["id"])
    try:
        reservation = ai_runtime.reserve_budget(db, ident, cls, req.client_addr)
    except AiError as exc:
        ai_runtime.reject(db, ident, cls, exc, status="rate_limited", **log)
        return None, None
    call_id = ai_runtime.log_call(db, ident, cls, status="pending", request=body, meta=meta, **log)
    try:
        with ai_runtime.provider_slot() as queue_ms:
            text, usage = ai_runtime.invoke(db, body, cls, ident.student_id or "", queue_ms)
    except AiError as exc:
        status = ai_runtime.STATUS_FOR_CODE.get(exc.code, "provider_error")
        if status in ai_runtime.REFUNDED:
            ai_runtime.refund_budget(reservation)
        ai_runtime.failed(db, ident, call_id, status=status, action="feedback", surface=log["surface"], unit_id=row["unit_id"],
                          item_id=row["id"], error=exc)
        return None, call_id
    guard_status = "not_applicable"
    aid, qid = _related(row)
    final = text
    if aid and explanation_withheld(db, row, ident.student_id or ""):
        rec = readers.load_assignment(db, cls, aid)
        question = readers.assignment_question(rec, qid) if rec else None
        result = leak_guard.check_text(text, [(rec, question, "similar")]) if question else leak_guard.CLEAN
        guard_status = "redacted" if result.leaked else "clean"
        final = leak_guard.redact(text, result) if result.leaked else text
    with dbmod.write_tx(db):
        ai_runtime.finish_call(db, call_id, status="ok", meta=usage, raw_output=text, guard_status=guard_status)
    return final, call_id


def check(req: Request, item_id: str) -> dict:
    """``POST /api/practice/items/{itemId}/check`` — server-side correctness (``checked_by='server'``)."""
    db, ident = req.db, req.identity
    ai_runtime.commit_open(db)
    row = owned_item(req, item_id)
    data = req.body()
    answer = data.get("answer", "")
    if not isinstance(answer, str) or len(answer) > 12000:
        raise ApiError(400, "invalid_request", "answer must be text of at most 12,000 characters")
    run_output = ai_runtime.text_field(data, "runOutput", 40000, label="runOutput")
    event_id = ai_runtime.optional_id(data, "eventId")
    time_on = data.get("timeOnItemMs")
    if time_on is not None and (type(time_on) is not int or not 0 <= time_on <= 86_400_000):
        raise ApiError(400, "invalid_request", "timeOnItemMs must be an integer number of milliseconds")
    item = _loads(row["item_json"], {})
    qtype = row["question_type"]
    if qtype == "complete" and not run_output:
        raise ApiError(400, "invalid_request", "Run your code successfully before checking.")
    previous = _checks(db, row)
    if event_id:
        replay = next((p for p in previous if p.get("_eventId") == event_id), None)
        if replay is not None:
            return _check_response(req, row, item, replay.get("correct"), int(replay.get("attemptIndex") or len(previous)),
                                   previous, replay.get("feedback"))
    question = _judge_question(row, item)
    if qtype == "complete":  # complete-code items are judged on the student's webR run output
        result = judging.check(question, answer, run_output, "client_run_output")
    else:
        result = judging.check(question, answer, None, "client")
    attempt_index = len(previous) + 1
    resolved = ai_policy.resolve(db, req.class_id, row["unit_id"], ident.student_id)
    config = ai_policy.with_defaults(resolved.config)
    feedback, feedback_call = (None, None)
    if qtype == "explain":
        feedback, feedback_call = _feedback(req, row, item, answer, config, resolved)
    payload = {"itemId": row["id"], "unitId": row["unit_id"], "answer": answer, "correct": result.correct,
               "checkedBy": "server", "basis": result.basis, "reason": result.reason, "attemptIndex": attempt_index,
               "timeOnItemMs": time_on, "origin": row["origin"],
               "relatedAssignmentId": row["related_assignment_id"] or None,
               **({"runOutput": run_output[:4000]} if run_output else {}),
               **({"feedback": feedback, "feedbackCallId": feedback_call} if qtype == "explain" else {})}
    surface = "similar" if row["origin"] == "similar" else "free-practice"
    with dbmod.write_tx(db):
        ai_runtime.server_event(db, ident, "answer_submitted", payload, question_id=row["id"], surface=surface,
                                event_id=event_id or None)
    return _check_response(req, row, item, result.correct, attempt_index, [*previous, payload], feedback)


def _check_response(req: Request, row: sqlite3.Row, item: dict, correct: object, attempt_index: int, checks: list[dict],
                    feedback: object) -> dict:
    db, ident = req.db, req.identity
    config = ai_policy.with_defaults(ai_policy.resolve(db, req.class_id, row["unit_id"], ident.student_id).config)
    fb = config.get("feedback") or {}
    withheld = explanation_withheld(db, row, ident.student_id or "")
    wrong = sum(1 for c in checks if c.get("correct") is False)
    reveal_after = int(fb.get("revealAfterAttempts") or 0)
    out: dict[str, object] = {"correct": correct, "attemptIndex": attempt_index, "explanationWithheld": False,
                              "canReveal": bool(reveal_after > 0 and wrong >= reveal_after and not withheld)}
    show = correct is True or correct is None or (correct is False and bool(fb.get("showExplanationOnWrong")))
    if show:
        if withheld:
            out["explanationWithheld"] = True
            out["withheldMessage"] = WITHHELD
        elif item.get("explanation"):
            out["explanation"] = item["explanation"]
    if row["verification"] in ("verified", "mismatch") and attempt_index >= 2:
        out["verification"] = row["verification"]
        if row["verification"] == "mismatch":
            out["verificationNotice"] = MISMATCH_NOTICE
    if row["question_type"] == "explain":
        out["feedback"] = feedback
    return out


def reveal(req: Request, item_id: str) -> dict:
    """``POST /api/practice/items/{itemId}/reveal`` after ``revealAfterAttempts`` wrong checks."""
    db, ident = req.db, req.identity
    ai_runtime.commit_open(db)
    row = owned_item(req, item_id)
    item = _loads(row["item_json"], {})
    if explanation_withheld(db, row, ident.student_id or ""):
        raise ApiError(403, "protected_homework", "The answer is shown after the homework closes.")
    config = ai_policy.with_defaults(ai_policy.resolve(db, req.class_id, row["unit_id"], ident.student_id).config)
    needed = int((config.get("feedback") or {}).get("revealAfterAttempts") or 0)
    checks = _checks(db, row)
    wrong = sum(1 for c in checks if c.get("correct") is False)
    if needed <= 0 or wrong < needed:
        message = ("Your teacher has not enabled Reveal for this chapter." if needed <= 0
                   else f"Reveal is available after {needed} incorrect attempts.")
        raise ApiError(403, "forbidden", message)
    answer = item.get("expectedOutput") if row["question_type"] == "complete" and item.get("expectedOutput") else item.get("answer", "")
    with dbmod.write_tx(db):
        ai_runtime.server_event(db, ident, "answer_revealed", {"itemId": row["id"], "attemptIndex": len(checks),
                                                               "unitId": row["unit_id"]},
                                question_id=row["id"], surface="similar" if row["origin"] == "similar" else "free-practice")
    return {"answer": answer, "explanation": item.get("explanation", "")}


def verify(req: Request, item_id: str) -> dict:
    """``POST /api/practice/items/{itemId}/verify`` — one client webR run of the item code; never answers whether it matched."""
    db = req.db
    ai_runtime.commit_open(db)
    row = owned_item(req, item_id)
    data = req.body()
    run_output = data.get("runOutput")
    ok = data.get("ok")
    if not isinstance(run_output, str) or len(run_output) > 40000 or not isinstance(ok, bool):
        raise ApiError(400, "invalid_request", "runOutput (text) and ok (true/false) are required")
    if row["verification"] == "not_applicable":
        raise ApiError(400, "invalid_request", "This exercise has no code to verify")
    item = _loads(row["item_json"], {})
    matched = False
    if ok:
        result = judging.check({"type": "complete", "answer": str(item.get("answer") or ""),
                                "expectedOutput": str(item.get("answer") or "")}, "", run_output, "client_run_output")
        matched = result.correct is True
    with dbmod.write_tx(db):
        cur = db.execute("UPDATE generated_items SET verification=?, client_run_output=?, verified_at=? "
                         "WHERE class_id=? AND id=? AND verified_at IS NULL",
                         ("verified" if matched else "mismatch", run_output[:4000], dbmod.now(), req.class_id, item_id))
        if cur.rowcount == 0:
            raise ApiError(409, "already_verified", "This exercise was already checked.")
    return {"recorded": True}


# ─── Staff review (AI-generated practice) ─────────────────────────────────────────────────────

def teacher_item(db: sqlite3.Connection, class_id: str, row: sqlite3.Row) -> dict:
    item = _loads(row["item_json"], {})
    match = None
    if row["homework_match_assignment_id"]:
        match = {"assignmentId": row["homework_match_assignment_id"], "questionId": row["homework_match_question_id"],
                 "containment": row["homework_match_score"]}
    return {
        "id": row["id"], "origin": row["origin"], "studentId": row["student_id"], "studentName": row["student_id"],
        "unitId": row["unit_id"], "relatedAssignmentId": row["related_assignment_id"],
        "relatedQuestionId": row["related_question_id"], "questionType": row["question_type"], "difficulty": row["difficulty"],
        "requestedType": row["requested_type"], "requestedDifficulty": row["requested_difficulty"],
        "focusNote": row["focus_note"],
        "item": {k: item[k] for k in ("title", "prompt", "code", "starterCode", "choices", "answer", "acceptedAnswers",
                                      "expectedOutput", "explanation", "rubric") if k in item},
        "source": row["source"], "model": row["model"], "policyVersionId": row["policy_version_id"],
        "policyLabel": ai_runtime.policy_label(db, class_id, row["policy_version_id"]),
        "noveltyRetries": row["novelty_retries"], "guardStatus": row["guard_status"], "verification": row["verification"],
        "clientRunOutput": row["client_run_output"], "status": row["status"], "flagNote": row["flag_note"],
        "flaggedBy": row["flagged_by"], "flaggedAt": row["flagged_at"], "retiredBy": row["retired_by"],
        "retiredAt": row["retired_at"], "homeworkMatch": match, "aiCallId": row["ai_call_id"],
        "attempts": int(row["attempts"] or 0) if "attempts" in row.keys() else 0,
        "correctAttempts": int(row["correct_attempts"] or 0) if "correct_attempts" in row.keys() else 0,
        "isPreview": bool(row["is_preview"]), "createdAt": row["created_at"],
    }


def teacher_items(req: Request) -> dict:
    """``GET /api/teacher/ai/items`` (filters: origin, unitId, status, verification, assignmentId, studentId, groupId, from, to)."""
    db, cls = req.db, req.class_id
    where = ["gi.class_id=?"]
    params: list[object] = [cls]
    origin = req.q_choice("origin", ("free", "similar", "teacher_test"), "")
    status = req.q_choice("status", ("active", "flagged", "retired", *REJECTED, "rejected"), "")
    verification = req.q_choice("verification", ("unverified", "verified", "mismatch", "not_applicable"), "")
    for column, value in (("gi.origin", origin), ("gi.verification", verification)):
        if value:
            where.append(f"{column}=?")
            params.append(value)
    if status == "rejected":
        where.append(f"gi.status IN ({','.join('?' for _ in REJECTED)})")
        params.extend(REJECTED)
    elif status:
        where.append("gi.status=?")
        params.append(status)
    elif not req.q_bool("includeRejected"):
        where.append(f"gi.status NOT IN ({','.join('?' for _ in REJECTED)})")
        params.extend(REJECTED)
    unit_id = req.q_id("unitId")
    if unit_id:
        where.append("gi.unit_id=?")
        params.append(unit_id)
    assignment_id = req.q_id("assignmentId")
    if assignment_id:
        where.append("(gi.related_assignment_id=? OR gi.homework_match_assignment_id=?)")
        params += [assignment_id, assignment_id]
    student_id = req.q_id("studentId")
    if student_id:
        where.append("gi.student_id=?")
        params.append(student_id)
    group_id = req.q_id("groupId")
    if group_id:
        where.append("gi.student_id IN (SELECT student_id FROM group_members WHERE class_id=? AND group_id=?)")
        params += [cls, group_id]
    start, end = req.q_iso("from"), req.q_iso("to")
    if start:
        where.append("gi.created_at >= ?")
        params.append(start)
    if end:
        where.append("gi.created_at < ?")
        params.append(end)
    population, pop_params = identity.population_sql(
        "gi", class_linked=identity.class_linked(db, cls), include_staff=req.q_bool("includeStaff"),
        include_preview=req.q_bool("includePreview") or origin == "teacher_test")
    where.append(population)
    params.extend(pop_params)
    page = req.q_int("page", 1, 1, 100000, clamp=True)
    size = req.q_int("pageSize", 50, 1, 100, clamp=True)
    clause = " AND ".join(where)
    total = db.execute(f"SELECT COUNT(*) FROM generated_items gi WHERE {clause}", params).fetchone()[0]
    rows = db.execute(
        f"""SELECT gi.*, (SELECT COUNT(*) FROM events e WHERE e.class_id=gi.class_id AND e.item_id=gi.id
            AND e.event_type='answer_submitted' AND e.checked_by='server') AS attempts,
            (SELECT COUNT(*) FROM events e WHERE e.class_id=gi.class_id AND e.item_id=gi.id AND e.event_type='answer_submitted'
            AND e.checked_by='server' AND json_extract(e.payload_json, '$.correct')=1) AS correct_attempts
        FROM generated_items gi WHERE {clause} ORDER BY gi.created_at DESC, gi.id LIMIT ? OFFSET ?""",
        (*params, size, (page - 1) * size)).fetchall()
    items = [teacher_item(db, cls, row) for row in rows]
    identity.relabel(db, cls, items, req.name_mode)
    return {"items": items, "total": total, "page": page, "pageSize": size}


def set_status(req: Request, item_id: str, action: str) -> dict:
    """Flag/unflag (``flagItems``) or retire/restore (``manageAiRules``) an item; audited."""
    from server import audit

    db = req.db
    data = req.body_or_empty()
    note = data.get("note", "")
    if not isinstance(note, str) or len(note) > 1000:
        raise ApiError(400, "invalid_request", "note must be text of at most 1,000 characters")
    with dbmod.write_tx(db):
        row = db.execute("SELECT * FROM generated_items WHERE class_id=? AND id=?", (req.class_id, item_id)).fetchone()
        if row is None:
            raise ApiError(404, "not_found", "Practice item not found")
        if row["status"] in REJECTED:
            raise ApiError(409, "invalid_request", "Rejected drafts were never shown to students and cannot change status.")
        before = {"status": row["status"], "flagNote": row["flag_note"]}
        actor = audit.actor_label(req.identity)
        stamp = dbmod.now()
        if action == "flag":
            db.execute("UPDATE generated_items SET status=CASE WHEN status='retired' THEN status ELSE 'flagged' END, flag_note=?, "
                       "flagged_by=?, flagged_at=? WHERE id=?", (note.strip(), actor, stamp, item_id))
        elif action == "unflag":
            db.execute("UPDATE generated_items SET status=CASE WHEN status='flagged' THEN 'active' ELSE status END, flag_note='', "
                       "flagged_by=?, flagged_at=? WHERE id=?", (actor, stamp, item_id))
        elif action == "retire":
            db.execute("UPDATE generated_items SET status='retired', retired_by=?, retired_at=? WHERE id=?", (actor, stamp, item_id))
        elif action == "restore":
            db.execute("UPDATE generated_items SET status=CASE WHEN flag_note!='' THEN 'flagged' ELSE 'active' END, retired_by=?, "
                       "retired_at=? WHERE id=?", (actor, stamp, item_id))
        else:
            raise ApiError(400, "invalid_request", "Unknown item action")
        updated = db.execute("SELECT * FROM generated_items WHERE id=?", (item_id,)).fetchone()
        req.audit(f"item_{action}", "generated_item", item_id, before,
                  {"status": updated["status"], "flagNote": updated["flag_note"], "note": note.strip()[:200]})
    out = teacher_item(db, req.class_id, updated)
    identity.relabel(db, req.class_id, [out], req.name_mode)
    return out
