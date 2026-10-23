"""Researcher request/response view (decision D3; review 2 SECURITY-02 and SECURITY-05).

A researcher analyzes consenting students only and never sees identities. ``server/router.py`` wraps every researcher
request with this view:

* **inbound** — research ids (``P…``, the same ids as in research exports) in path parameters, query values and JSON
  bodies are translated back to student ids, so the handlers keep working on student ids;
* **targets** — a request aimed at one student (``studentId``, a ``lab:`` thread key, a question activity, an AI call
  or a chat turn) whose student has no research consent is answered 404, as if the record did not exist;
* **outbound** — list rows of non-consenting students are dropped (a single record of one is a 404), then every raw
  student id in the response (values, ``lab:`` thread keys, link paths, dict keys and long ids inside text) is replaced
  with that student's research id.

Population queries are restricted separately through ``identity.set_consent_only`` (aggregates and counts).
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any
from urllib.parse import quote, unquote

from server import identity
from server.router import ApiError

STUDENT_KEYS = frozenset({"studentId", "student_id"})
THREAD_KEYS = frozenset({"threadKey", "thread_key", "current"})
NOT_FOUND = "Not found"
# characters that may appear inside an id (router.ID_PATTERN minus ':' and '/', which separate ids in keys and paths)
_ID_CHARS = "A-Za-z0-9_.@-"
_URL_PART = re.compile(r"[^/?&=#]+")


class ResearchView:
    """Student id ↔ research id translation and consent filtering for one researcher request."""

    def __init__(self, db: sqlite3.Connection, class_id: str) -> None:
        self.db = db
        self.class_id = class_id
        ids = [row[0] for row in db.execute("SELECT student_id FROM roster WHERE class_id=?", (class_id,))]
        self.to_rid = {sid: identity.research_id(db, class_id, sid) for sid in ids}
        self.to_sid = {rid: sid for sid, rid in self.to_rid.items()}
        self.consenting = identity.consenting_ids(db, class_id)
        # free-text replacement only for ids that cannot be ordinary words or numbers (emails, long NetIDs, Kiwi ids)
        long_ids = sorted((sid for sid in ids if "@" in sid or len(sid) >= 5), key=len, reverse=True)
        variants = {v for sid in long_ids for v in (sid, quote(sid, safe=""))}
        self._text = (re.compile(rf"(?<![{_ID_CHARS}])(?:" + "|".join(re.escape(v) for v in sorted(variants, key=len, reverse=True))
                                 + rf")(?![{_ID_CHARS}])") if variants else None)
        self._encoded = {quote(sid, safe=""): rid for sid, rid in self.to_rid.items()}

    # -- inbound --------------------------------------------------------------------------------------
    def _in(self, value: str) -> str:
        if value in self.to_sid:
            return self.to_sid[value]
        if value.startswith("lab:"):
            student, sep, rest = value[4:].partition(":")
            if sep and student in self.to_sid:
                return f"lab:{self.to_sid[student]}:{rest}"
        if "," in value:
            parts = value.split(",")
            if any(p.strip() in self.to_sid for p in parts):
                return ",".join(self.to_sid.get(p.strip(), p) for p in parts)
        return value

    def _in_json(self, value: object) -> object:
        if isinstance(value, str):
            return self._in(value)
        if isinstance(value, list):
            return [self._in_json(v) for v in value]
        if isinstance(value, dict):
            return {k: self._in_json(v) for k, v in value.items()}
        return value

    def _raw_ids(self, key: str, value: object) -> bool:
        """SB-M02: a raw roster id where a researcher addresses a student (only research ids are accepted)."""
        if not isinstance(value, str) or not value:
            return False
        if key in STUDENT_KEYS:
            return any(part.strip() in self.to_rid and part.strip() not in self.to_sid for part in value.split(","))
        if key in THREAD_KEYS and value.startswith("lab:"):
            student = value[4:].partition(":")[0]
            return student in self.to_rid and student not in self.to_sid
        return False

    def inbound(self, req: Any) -> None:
        body = req.json() if req.method in ("POST", "PUT", "PATCH") and req.has_body() else None
        pairs = [*req.params.items(), *req.query.items(), *(body.items() if isinstance(body, dict) else [])]
        if any(self._raw_ids(k, v) for k, v in pairs):
            # WHY: accepting institutional ids would let a researcher map research ids back to identities (the response
            # carries the research id of the student asked for); answer as if the record did not exist.
            raise ApiError(404, "not_found", NOT_FOUND)
        req.params = {k: self._in(v) for k, v in req.params.items()}
        req.query = {k: self._in(v) for k, v in req.query.items()}
        if req.method in ("POST", "PUT", "PATCH") and req.has_body():
            req._json = self._in_json(req.json())

    # -- targets --------------------------------------------------------------------------------------
    def _owner(self, sql: str, value: str) -> str | None:
        row = self.db.execute(sql, (self.class_id, value)).fetchone()
        return str(row[0]) if row else None

    def targets(self, req: Any) -> list[str]:
        """Student ids a request is aimed at (path parameters, query values and top-level body fields)."""
        body = req._json if isinstance(getattr(req, "_json", None), dict) else {}
        values: list[tuple[str, object]] = [*req.params.items(), *req.query.items(), *body.items()]
        found: list[str] = []
        for key, value in values:
            if isinstance(value, int) and not isinstance(value, bool):
                value = str(value)
            if not isinstance(value, str) or not value:
                continue
            if key in STUDENT_KEYS:
                found.extend(v.strip() for v in value.split(",") if v.strip())
            elif key in THREAD_KEYS and value.startswith("lab:"):
                found.append(value[4:].partition(":")[0])
            elif key in ("activityId", "sessionId"):
                owner = self._owner("SELECT studentId FROM learning_sessions WHERE classId=? AND id=?", value) or self._owner(
                    """SELECT s.studentId FROM learning_session_aliases a JOIN learning_sessions s ON s.id = a.new_id
                    WHERE a.class_id=? AND a.old_id=?""", value)
                if owner is not None:
                    found.append(owner)
            elif key == "aiCallId" and value.isdigit():
                owner = self._owner("SELECT student_id FROM ai_calls WHERE class_id=? AND id=?", value)
                if owner is not None:
                    found.append(owner)
            elif key == "chatTurnId" and value.isdigit():
                owner = self._owner("SELECT student_id FROM chat_turns WHERE class_id=? AND id=?", value)
                if owner is not None:
                    found.append(owner)
        return found

    def check_targets(self, req: Any) -> None:
        if any(sid not in self.consenting for sid in self.targets(req)):
            raise ApiError(404, "not_found", NOT_FOUND)

    # -- outbound -------------------------------------------------------------------------------------
    def _blocked(self, item: dict) -> bool:
        for key in STUDENT_KEYS:
            value = item.get(key)
            if isinstance(value, str) and value and value not in self.consenting:
                return True
        return False

    def _filter(self, value: object, *, in_list: bool = False) -> object:
        if isinstance(value, list):
            return [self._filter(v, in_list=True) for v in value if not (isinstance(v, dict) and self._blocked(v))]
        if isinstance(value, dict):
            if not in_list and self._blocked(value):
                raise ApiError(404, "not_found", NOT_FOUND)
            return {k: self._filter(v) for k, v in value.items()}
        return value

    def _out_str(self, value: str) -> str:
        if value in self.to_rid:
            return self.to_rid[value]
        if value.startswith("lab:"):
            student, sep, rest = value[4:].partition(":")
            if sep and student in self.to_rid:
                return f"lab:{self.to_rid[student]}:{rest}"
        if value.startswith("/"):
            value = _URL_PART.sub(lambda m: self.to_rid.get(unquote(m.group(0)), m.group(0)), value)
        if self._text is not None:
            value = self._text.sub(lambda m: self.to_rid.get(m.group(0)) or self._encoded.get(m.group(0), m.group(0)), value)
        return value

    def _translate(self, value: object) -> object:
        if isinstance(value, str):
            return self._out_str(value)
        if isinstance(value, list):
            return [self._translate(v) for v in value]
        if isinstance(value, dict):
            return {(self.to_rid.get(k, k) if isinstance(k, str) else k): self._translate(v) for k, v in value.items()}
        return value

    def outbound(self, body: object) -> object:
        return self._translate(self._filter(body))

