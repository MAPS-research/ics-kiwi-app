"""AI conversations: digest, threads, coding, codebook and topic rules (owned by INSIGHTS; spec §13.5, §6.7).

Source of truth: ``chat_turns`` (Lab AI tutor, joined with ``ai_calls`` for provenance) plus native Kiwi ``ai_question``
events. A Lab ``ai_question`` event without a ``chat_turns`` row (same class, student and prompt within ±10 min) is a
legacy client-only record and is shown with the badge "Legacy client record".

Thread keys: ``lab:<studentId>:<threadId>`` and ``kiwi:<conversationId>``. Keys longer than the router's 120-character
path-parameter limit keep a readable prefix plus ``~<sha1[:10]>`` of the full thread id.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import sqlite3
from typing import Iterable

from server import analytics, course_config, readers
from server import db as dbmod
from server.analytics import Scope
from server.router import valid_id

CODE_COLORS = ("neutral", "info", "success", "warning", "danger")
MAX_CLUSTER_PROMPTS = 2000
JACCARD_THRESHOLD = 0.6
LEGACY_MATCH_MINUTES = 10


# ─── thread keys ───────────────────────────────────────────────────────────────────────────────

def thread_key(where: str, student_id: str, thread_id: str) -> str:
    if where == "kiwi":
        key = f"kiwi:{thread_id}"
    else:
        key = f"lab:{student_id}:{thread_id or 'legacy'}"
    if len(key) <= 120:
        return key
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
    return key[:108] + "~" + digest


def parse_key(key: str) -> tuple[str, str, str]:
    """``(where, student_id_or_empty, thread_part)`` — ``thread_part`` may carry a ``~hash`` suffix."""
    if key.startswith("kiwi:"):
        return "kiwi", "", key[5:]
    if key.startswith("lab:"):
        student, _, thread = key[4:].partition(":")
        return "lab", student, thread
    raise ValueError("Unknown conversation thread")


# ─── turn collection ───────────────────────────────────────────────────────────────────────────

def _lab_turns(db: sqlite3.Connection, scope: Scope, filters: dict) -> list[dict]:
    population, params = analytics.pop_sql(scope, "t")
    clauses = [population]
    unit = "COALESCE(NULLIF(t.unit_id, ''), a.unit_id, '')"
    if filters.get("unitId"):
        clauses.append(f"{unit} = ?")
        params.append(filters["unitId"])
    for name, column in (("studentId", "t.student_id"), ("assignmentId", "t.assignment_id"), ("threadId", "t.thread_id")):
        if filters.get(name):
            clauses.append(f"{column} = ?")
            params.append(filters[name])
    if filters.get("flagged"):
        clauses.append("t.flagged = 1")
    rows = db.execute(f"""SELECT t.*, {unit} AS unit, c.engine AS engine FROM chat_turns t
        LEFT JOIN assignments a ON a.class_id = t.class_id AND a.id = t.assignment_id
        LEFT JOIN (SELECT id, model AS engine FROM ai_calls) c ON c.id = t.ai_call_id
        WHERE {' AND '.join(clauses)} ORDER BY t.created_at, t.id""", params).fetchall()
    out = []
    for row in rows:
        keys = row.keys()
        out.append({
            "where": "lab", "threadKey": thread_key("lab", row["student_id"], row["thread_id"]), "threadId": row["thread_id"],
            "studentId": row["student_id"], "chatTurnId": row["id"], "nativeEventId": None,
            "aiCallId": row["ai_call_id"] if "ai_call_id" in keys else None, "at": row["created_at"], "prompt": row["prompt"],
            "response": row["response"], "unitId": row["unit"] or "", "assignmentId": row["assignment_id"] or "",
            "questionId": row["question_id"] or "", "itemId": row["item_id"] or "", "source": row["source"] or "lab-ai",
            "model": row["model"] or row["engine"], "policyVersionId": row["policy_version_id"],
            "guard": row["guard_status"] or "not_applicable", "flagged": bool(row["flagged"]), "flagSource": row["flag_source"] or "",
            "flagReason": row["flag_reason"] or "", "flagUpdatedBy": row["flag_updated_by"], "legacyClientRecord": False,
        })
    return out


def _event_turns(db: sqlite3.Connection, scope: Scope, filters: dict) -> list[dict]:
    """Native Kiwi turns and legacy client-only Lab ``ai_question`` events."""
    population, params = analytics.pop_sql(scope)
    clauses = [population, "e.event_type = 'ai_question'", f"COALESCE({analytics.JOK}, 1) != 0",
               f"""(e.source = 'kiwi' OR (e.chat_turn_id IS NULL AND NOT EXISTS (SELECT 1 FROM chat_turns t2
                    WHERE t2.class_id = e.class_id AND t2.student_id = e.student_id
                    AND t2.prompt = CAST(json_extract(e.payload_json, '$.prompt') AS TEXT)
                    AND ABS(julianday(t2.created_at) - julianday(e.created_at)) <= {LEGACY_MATCH_MINUTES} / 1440.0)))"""]
    if filters.get("where") == "lab" or filters.get("flagged"):
        return []
    if filters.get("unitId"):
        clauses.append(f"{analytics.UNIT_EXPR} = ?")
        params.append(filters["unitId"])
    if filters.get("studentId"):
        clauses.append("e.student_id = ?")
        params.append(filters["studentId"])
    if filters.get("assignmentId"):
        clauses.append("(e.attribution_assignment_id = ? OR e.related_assignment_id = ?)")
        params += [filters["assignmentId"]] * 2
    if filters.get("threadId"):
        clauses.append("CAST(json_extract(e.payload_json, '$.threadId') AS TEXT) = ?")
        params.append(filters["threadId"])
    if filters.get("source"):
        clauses.append("e.source = ?")
        params.append(filters["source"])
    rows = db.execute(f"""SELECT e.*, {analytics.UNIT_EXPR} AS unit FROM events e {analytics.EV_JOINS}
        WHERE {' AND '.join(clauses)} ORDER BY e.created_at, e.id""", params).fetchall()
    out = []
    for row in rows:
        payload = analytics._loads(row["payload_json"], {})
        native = row["source"] == "kiwi"
        thread = str(payload.get("threadId") or ("" if not native else row["upstream_id"] or row["id"]))
        where = "kiwi" if native else "lab"
        out.append({
            "where": where, "threadKey": thread_key(where, row["student_id"], thread), "threadId": thread,
            "studentId": row["student_id"], "chatTurnId": None, "nativeEventId": row["id"], "aiCallId": None,
            "at": row["created_at"], "prompt": str(payload.get("prompt") or ""), "response": str(payload.get("response") or ""),
            "unitId": row["unit"] or "", "assignmentId": row["attribution_assignment_id"] or row["related_assignment_id"] or "",
            "questionId": row["question_id"] or "", "itemId": row["item_id"] or "",
            "source": "kiwi" if native else str(payload.get("source") or "lab-ai"),
            "model": payload.get("engineChoice") or payload.get("model"), "policyVersionId": None, "guard": "not_applicable",
            "flagged": False, "flagSource": "", "flagReason": "", "flagUpdatedBy": None, "legacyClientRecord": not native,
        })
    return out


def collect_turns(db: sqlite3.Connection, scope: Scope, filters: dict | None = None) -> list[dict]:
    """All turns (Lab, native, legacy client-only) in time order for the scope and filters."""
    filters = filters or {}
    turns: list[dict] = []
    if filters.get("where") != "kiwi":
        turns += _lab_turns(db, scope, filters)
    turns += _event_turns(db, scope, filters)
    turns.sort(key=lambda t: (t["at"], t["chatTurnId"] or 0, t["nativeEventId"] or 0))
    return turns


# ─── digest (§13.5) ────────────────────────────────────────────────────────────────────────────

def normalize_prompt(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", str(text or "").casefold()).split())


def trigrams(text: str) -> set[str]:
    padded = f"  {text} "
    return {padded[i:i + 3] for i in range(len(padded) - 2)}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def cluster_prompts(turns: list[dict]) -> list[dict]:
    """Normalized exact match first, then greedy 3-gram Jaccard ≥ 0.6, deterministic by first occurrence."""
    recent = turns[-MAX_CLUSTER_PROMPTS:]
    exact: dict[str, list[dict]] = {}
    for turn in recent:
        norm = normalize_prompt(turn["prompt"])
        if norm:
            exact.setdefault(norm, []).append(turn)
    clusters: list[dict] = []
    for norm, members in exact.items():  # dict order = first occurrence order
        grams = trigrams(norm)
        target = next((c for c in clusters if jaccard(c["grams"], grams) >= JACCARD_THRESHOLD), None)
        if target is None:
            clusters.append({"grams": grams, "turns": list(members), "first": members[0]["at"], "prompt": members[0]["prompt"]})
        else:
            target["turns"].extend(members)
    out = []
    for cluster in clusters:
        students = {t["studentId"] for t in cluster["turns"]}
        if len(students) < 2:
            continue
        examples, seen = [], set()
        for turn in cluster["turns"]:
            if turn["studentId"] in seen:
                continue
            seen.add(turn["studentId"])
            examples.append({"threadKey": turn["threadKey"], "studentId": turn["studentId"], "studentName": turn["studentId"],
                             "at": turn["at"]})
            if len(examples) == 3:
                break
        out.append({"prompt": cluster["prompt"], "students": len(students), "occurrences": len(cluster["turns"]),
                    "examples": examples, "_first": cluster["first"]})
    out.sort(key=lambda c: c["_first"])
    out.sort(key=lambda c: (-c["students"], -c["occurrences"]))
    for cluster in out:
        cluster.pop("_first")
    return out


def topic_rules(db: sqlite3.Connection, class_id: str) -> list[dict]:
    rules = readers.settings(db, class_id).get("topicRules")
    return rules if isinstance(rules, list) else list(course_config.TOPIC_RULE_DEFAULTS)


def _keyword_pattern(keyword: str) -> re.Pattern[str]:
    word = re.escape(keyword.casefold())
    if re.fullmatch(r"[\w ]+", keyword):
        return re.compile(rf"(?<![\w]){word}")
    return re.compile(word)


def topic_of(prompt: str, rules: list[dict]) -> list[str]:
    text = str(prompt or "").casefold()
    hits = []
    for rule in rules:
        if any(_keyword_pattern(k).search(text) for k in rule.get("keywords") or [] if isinstance(k, str) and k):
            hits.append(rule.get("label", ""))
    return hits


def topics(turns: list[dict], rules: list[dict]) -> list[dict]:
    counts: dict[str, dict] = {}
    compiled = [{"label": r.get("label", ""), "patterns": [_keyword_pattern(k) for k in r.get("keywords") or []
                                                         if isinstance(k, str) and k]} for r in rules]
    for turn in turns:
        text = str(turn["prompt"] or "").casefold()
        for rule in compiled:
            if any(p.search(text) for p in rule["patterns"]):
                entry = counts.setdefault(rule["label"], {"label": rule["label"], "turns": 0, "students": set()})
                entry["turns"] += 1
                entry["students"].add(turn["studentId"])
    out = [{"label": v["label"], "turns": v["turns"], "students": len(v["students"])} for v in counts.values()]
    out.sort(key=lambda t: (-t["turns"], t["label"]))
    return out


def assignment_label(index: dict, turn: dict) -> str:
    aid = turn.get("assignmentId") or ""
    if aid and aid in index:
        qid = turn.get("questionId") or ""
        return analytics.question_ref(index, aid, qid) if qid else index[aid].title
    if turn.get("itemId"):
        return "AI practice item"
    return "Kiwi lecture" if turn["where"] == "kiwi" else ""


def assignment_title(index: dict, turn: dict) -> str:
    """The full assignment title (and ``Q2``) behind a shortened ``assignmentLabel``, for its tooltip (RT-03)."""
    info = index.get(turn.get("assignmentId") or "")
    if info is None:
        return assignment_label(index, turn)
    qid = turn.get("questionId") or ""
    position = info.questions.get(qid, (None, None))[0] if qid else None
    return f"{info.title} Q{position}" if position else info.title


def digest(db: sqlite3.Connection, scope: Scope, range_: dict, *, unit_id: str = "", assignment_id: str = "",
           limit_recent: int = 20) -> dict:
    """``ConversationDigest`` for the global top-bar range."""
    turns = collect_turns(db, scope, {"unitId": unit_id, "assignmentId": assignment_id})
    index = analytics.assignment_index(db, scope.class_id)
    flagged = [{"chatTurnId": t["chatTurnId"], "threadKey": t["threadKey"], "studentId": t["studentId"],
                "studentName": t["studentId"], "prompt": t["prompt"],
                "reason": t["flagReason"] or ("Guard: " + t["guard"].replace("_", " ") if t["flagSource"] == "guard" else "Flagged by staff"),
                "at": t["at"]} for t in turns if t["flagged"]]
    recent = [{"threadKey": t["threadKey"], "studentId": t["studentId"], "studentName": t["studentId"], "prompt": t["prompt"],
               "at": t["at"], "where": t["where"], "assignmentLabel": assignment_label(index, t),
               "assignmentTitle": assignment_title(index, t)}
              for t in reversed(turns[-limit_recent:])] if limit_recent else []
    return {"range": range_, "repeated": cluster_prompts(turns), "topics": topics(turns, topic_rules(db, scope.class_id)),
            "flagged": list(reversed(flagged)), "recent": recent}


# ─── threads & coding ──────────────────────────────────────────────────────────────────────────

def _codes_by_thread(db: sqlite3.Connection, class_id: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for row in db.execute("""SELECT c.*, b.label AS code_label FROM conversation_codes c
            LEFT JOIN codebook_codes b ON b.id = c.code_id AND b.class_id = c.class_id
            WHERE c.class_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at, c.id""", (class_id,)):
        out.setdefault(row["thread_key"], []).append(dict(row))
    return out


def code_dict(row: sqlite3.Row | dict) -> dict:
    return {"id": row["id"], "threadKey": row["thread_key"], "chatTurnId": row["chat_turn_id"],
            "nativeEventId": row["native_event_id"], "codeId": row["code_id"], "coder": row["coder_id"], "note": row["note"],
            "createdAt": row["created_at"]}


def summaries(db: sqlite3.Connection, scope: Scope, filters: dict) -> list[dict]:
    turns = collect_turns(db, scope, filters)
    index = analytics.assignment_index(db, scope.class_id)
    codes = _codes_by_thread(db, scope.class_id)
    grouped: dict[str, list[dict]] = {}
    for turn in turns:
        grouped.setdefault(turn["threadKey"], []).append(turn)
    out = []
    for key, items in grouped.items():
        thread_codes = codes.get(key, [])
        if filters.get("codeId") and not any(c["code_id"] == filters["codeId"] for c in thread_codes):
            continue
        if filters.get("uncoded") and thread_codes:
            continue
        first = items[0]
        label = next((assignment_label(index, t) for t in items if assignment_label(index, t)), "")
        out.append({"threadKey": key, "where": first["where"], "studentId": first["studentId"], "studentName": first["studentId"],
                    "unitId": next((t["unitId"] for t in items if t["unitId"]), ""), "assignmentLabel": label,
                    "turns": len(items), "firstAt": first["at"], "lastAt": items[-1]["at"],
                    "codes": sorted({c["code_label"] or c["code_id"] for c in thread_codes}),
                    "flagged": any(t["flagged"] for t in items)})
    out.sort(key=lambda s: s["threadKey"])
    out.sort(key=lambda s: s["lastAt"], reverse=True)
    return out


def next_uncoded(db: sqlite3.Connection, scope: Scope, filters: dict, current: str = "") -> str | None:
    items = summaries(db, scope, {**filters, "uncoded": True})
    keys = [s["threadKey"] for s in items]
    if current in keys:
        position = keys.index(current)
        keys = keys[position + 1:] + keys[:position]
    return next((k for k in keys if k != current), None)


def _native_feedback(db: sqlite3.Connection, class_id: str, conversation: str, turns: list[dict]) -> dict[int, list[dict]]:
    """Kiwi thumbs/flag joined to the k-th assistant reply of the conversation (k-th ``ai_responses`` row by time;
    approximate — ``targetMessageIndex`` is Kiwi's list index, §15.2)."""
    event_ids = [t["nativeEventId"] for t in turns if t["nativeEventId"]]
    if not event_ids:
        return {}
    marks = ",".join("?" for _ in event_ids)
    replies = [row[0] for row in db.execute(
        f"SELECT event_id FROM ai_responses WHERE class_id = ? AND event_id IN ({marks}) ORDER BY responded_at, upstream_action_id",
        [class_id, *event_ids])]
    if not replies:
        replies = list(event_ids)
    out: dict[int, list[dict]] = {}
    for row in db.execute("""SELECT payload_json, created_at FROM events WHERE class_id = ? AND event_type = 'ai_feedback'
            AND CAST(json_extract(payload_json, '$.conversationId') AS TEXT) = ? ORDER BY created_at, id""", (class_id, conversation)):
        payload = analytics._loads(row[0], {})
        index = payload.get("targetMessageIndex")
        if type(index) is not int or not 0 <= index < len(replies):
            continue
        value = payload.get("value")
        out.setdefault(replies[index], []).append({"value": value if isinstance(value, (int, float)) else None,
                                                   "reply": payload.get("reply") if isinstance(payload.get("reply"), str) else None,
                                                   "at": row[1]})
    return out


def thread(db: sqlite3.Connection, scope: Scope, key: str) -> dict:
    """``ConversationThread``: every turn of one thread (no time window) with provenance, guard, flags, feedback, codes."""
    where, student, part = parse_key(key)
    full = analytics.unranged(scope)
    if where == "kiwi":
        thread_id = part
        turns = [t for t in collect_turns(db, full, {"threadId": thread_id, "source": "kiwi", "where": "kiwi"})
                 if t["threadKey"] == key]
    else:
        if not valid_id(student):
            raise ValueError("Unknown conversation thread")
        turns = [t for t in collect_turns(db, full, {"studentId": student}) if t["threadKey"] == key and t["where"] == "lab"]
    if not turns:
        raise LookupError("Conversation not found")
    course = course_config.course_for(scope.class_id, db)
    index = analytics.assignment_index(db, scope.class_id)
    codes = _codes_by_thread(db, scope.class_id).get(key, [])
    feedback = _native_feedback(db, scope.class_id, turns[0]["threadId"], turns) if where == "kiwi" else {}
    out_turns = []
    for t in turns:
        provenance: dict[str, object] = {"where": t["where"], "ai": analytics.provenance_label(t["where"], t["source"])}
        if t["where"] == "lab":
            provenance["policyLabel"] = analytics.policy_label(db, scope.class_id, t["policyVersionId"], course)
        if t["model"]:
            provenance["model"] = t["model"]
        if t["aiCallId"]:
            provenance["aiCallId"] = t["aiCallId"]
        turn_codes = [code_dict(c) for c in codes if (t["chatTurnId"] and c["chat_turn_id"] == t["chatTurnId"])
                      or (t["nativeEventId"] and c["native_event_id"] == t["nativeEventId"])]
        out_turns.append({"chatTurnId": t["chatTurnId"], "nativeEventId": t["nativeEventId"], "aiCallId": t["aiCallId"],
                          "at": t["at"], "prompt": t["prompt"], "response": t["response"], "provenance": provenance,
                          "guard": t["guard"], "flagged": t["flagged"], "flagSource": t["flagSource"],
                          "flagUpdatedBy": t["flagUpdatedBy"], "legacyClientRecord": t["legacyClientRecord"],
                          "feedback": feedback.get(t["nativeEventId"], []) if t["nativeEventId"] else [], "codes": turn_codes})
    first = turns[0]
    summary = {"threadKey": key, "where": first["where"], "studentId": first["studentId"], "studentName": first["studentId"],
               "unitId": next((t["unitId"] for t in turns if t["unitId"]), ""),
               "assignmentLabel": next((assignment_label(index, t) for t in turns if assignment_label(index, t)), ""),
               "turns": len(turns), "firstAt": first["at"], "lastAt": turns[-1]["at"],
               "codes": sorted({c["code_label"] or c["code_id"] for c in codes}), "flagged": any(t["flagged"] for t in turns)}
    return {"summary": summary, "turns": out_turns, "threadCodes": [code_dict(c) for c in codes if not c["chat_turn_id"]
                                                                    and not c["native_event_id"]]}


# ─── codebook & codes ──────────────────────────────────────────────────────────────────────────

def codebook_dict(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "label": row["label"], "description": row["description"], "color": row["color"],
            "archived": row["archived_at"] is not None}


def codebook(db: sqlite3.Connection, class_id: str) -> list[dict]:
    return [codebook_dict(r) for r in db.execute("SELECT * FROM codebook_codes WHERE class_id = ? ORDER BY created_at, id",
                                                 (class_id,))]


def _code_fields(body: dict, *, partial: bool) -> dict:
    out: dict[str, object] = {}
    if "label" in body or not partial:
        label = body.get("label")
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 60:
            raise ValueError("Code label must be 1–60 characters")
        out["label"] = label.strip()
    if "description" in body or not partial:
        description = body.get("description", "")
        if not isinstance(description, str) or len(description) > 1000:
            raise ValueError("Code description must be at most 1,000 characters")
        out["description"] = description
    if "color" in body or not partial:
        color = body.get("color", "neutral")
        if color not in CODE_COLORS:
            raise ValueError("Code color must be neutral, info, success, warning or danger")
        out["color"] = color
    if partial and "archived" in body:
        if not isinstance(body["archived"], bool):
            raise ValueError("archived must be true or false")
        out["archived"] = body["archived"]
    return out


def create_code(db: sqlite3.Connection, class_id: str, body: dict, actor: str) -> dict:
    fields = _code_fields(body, partial=False)
    if db.execute("SELECT 1 FROM codebook_codes WHERE class_id = ? AND lower(label) = lower(?) AND archived_at IS NULL",
                  (class_id, fields["label"])).fetchone():
        raise ValueError("A code with this label already exists")
    code_id = "code-" + secrets.token_hex(6)
    db.execute("""INSERT INTO codebook_codes (id, class_id, label, description, color, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)""", (code_id, class_id, fields["label"], fields["description"], fields["color"], actor[:200],
                                         dbmod.now()))
    return codebook_dict(db.execute("SELECT * FROM codebook_codes WHERE id = ?", (code_id,)).fetchone())


def update_code(db: sqlite3.Connection, class_id: str, code_id: str, body: dict) -> tuple[dict, dict]:
    row = db.execute("SELECT * FROM codebook_codes WHERE class_id = ? AND id = ?", (class_id, code_id)).fetchone()
    if row is None:
        raise LookupError("Code not found")
    fields = _code_fields(body, partial=True)
    for column in ("label", "description", "color"):
        if column in fields:
            db.execute(f"UPDATE codebook_codes SET {column} = ? WHERE id = ?", (fields[column], code_id))
    if "archived" in fields:
        db.execute("UPDATE codebook_codes SET archived_at = ? WHERE id = ?", (dbmod.now() if fields["archived"] else None, code_id))
    return codebook_dict(row), codebook_dict(db.execute("SELECT * FROM codebook_codes WHERE id = ?", (code_id,)).fetchone())


def add_code(db: sqlite3.Connection, scope: Scope, body: dict, actor: str) -> dict:
    key = body.get("threadKey")
    if not isinstance(key, str) or not key or len(key) > 120:
        raise ValueError("threadKey is required")
    parse_key(key)
    code_id = body.get("codeId")
    if not isinstance(code_id, str) or db.execute(
            "SELECT 1 FROM codebook_codes WHERE class_id = ? AND id = ? AND archived_at IS NULL", (scope.class_id, code_id)).fetchone() is None:
        raise ValueError("Choose an active code from the codebook")
    chat_turn, native = body.get("chatTurnId"), body.get("nativeEventId")
    if chat_turn is not None and type(chat_turn) is not int:
        raise ValueError("chatTurnId must be a number")
    if native is not None and type(native) is not int:
        raise ValueError("nativeEventId must be a number")
    note = body.get("note") or ""
    if not isinstance(note, str) or len(note) > 2000:
        raise ValueError("Note must be at most 2,000 characters")
    turns = thread(db, scope, key)["turns"]  # the thread must exist in this course (LookupError → 404)
    if chat_turn is not None and not any(t["chatTurnId"] == chat_turn for t in turns):
        raise ValueError("That turn is not part of this thread")
    if native is not None and not any(t["nativeEventId"] == native for t in turns):
        raise ValueError("That Kiwi turn is not part of this thread")
    cur = db.execute("""INSERT INTO conversation_codes (class_id, thread_key, chat_turn_id, native_event_id, code_id, coder_id, note,
        created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""", (scope.class_id, key, chat_turn, native, code_id, actor[:200], note, dbmod.now()))
    return code_dict(db.execute("SELECT * FROM conversation_codes WHERE id = ?", (cur.lastrowid,)).fetchone())


def remove_code(db: sqlite3.Connection, class_id: str, code_row_id: int) -> dict:
    row = db.execute("SELECT * FROM conversation_codes WHERE class_id = ? AND id = ? AND deleted_at IS NULL",
                     (class_id, code_row_id)).fetchone()
    if row is None:
        raise LookupError("Code not found")
    db.execute("UPDATE conversation_codes SET deleted_at = ? WHERE id = ?", (dbmod.now(), code_row_id))
    return code_dict(row)


# ─── topic rules (§6.7, AU-D4-29) ──────────────────────────────────────────────────────────────

def validate_topic_rules(body: object) -> list[dict]:
    if not isinstance(body, list):
        raise ValueError("Send a list of topic rules")
    if len(body) > 40:
        raise ValueError("Use at most 40 topic rules")
    out, labels = [], set()
    for rule in body:
        if not isinstance(rule, dict):
            raise ValueError("Each topic rule needs a label and keywords")
        label = rule.get("label")
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 60:
            raise ValueError("Topic labels must be 1–60 characters")
        if label.strip().casefold() in labels:
            raise ValueError(f"Topic {label.strip()} is listed twice")
        labels.add(label.strip().casefold())
        keywords = rule.get("keywords")
        if not isinstance(keywords, list) or not 1 <= len(keywords) <= 30:
            raise ValueError(f"Topic {label.strip()}: give 1–30 keywords")
        clean = []
        for keyword in keywords:
            if not isinstance(keyword, str) or not 1 <= len(keyword.strip()) <= 40:
                raise ValueError(f"Topic {label.strip()}: keywords must be 1–40 characters")
            clean.append(keyword.strip().casefold())
        out.append({"label": label.strip(), "keywords": list(dict.fromkeys(clean))})
    return out


def relabel_rows(db: sqlite3.Connection, class_id: str, rows: Iterable[dict], mode: str) -> None:
    from server import identity

    identity.relabel(db, class_id, list(rows), mode)
