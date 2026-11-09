"""Labels, pseudonyms, roster upserts, research ids, consent and query-time population (spec §5.4; FOUNDATION, frozen)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
from contextvars import ContextVar, Token
from typing import Iterable

from server import db as dbmod

SOURCE_RANK = {"activity": 0, "import": 1, "kiwi": 2}
STAFF_ACTOR_ROLES = ("instructor", "ta", "viewer", "researcher", "staff", "preview")
# SB-M01: events a staff member caused on a student's row (a grade release) are not the student's activity
STUDENT_ACTOR_SQL = "actor_role NOT IN (" + ", ".join(f"'{r}'" for r in STAFF_ACTOR_ROLES) + ")"
EVENT_COLS = {"class_id": "class_id", "student_id": "student_id", "is_preview": "is_preview", "actor_role": "actor_role"}
SESSION_COLS = {"class_id": "classId", "student_id": "studentId", "is_preview": "isPreview", "actor_role": "actorRole"}
_EMAIL_KEYS = ("email", "emails", "kiwiEmail", "studentEmail")
# Free-text scrub (decision D3): values under identifier-like keys are never rewritten (ids, thread keys, links).
_ID_KEY = re.compile(r"(^id$|Id$|_id$|Ids$|_ids$|Key$|_key$|^href$|^url$|^path$)")
_ANON_NAME = "Anonymized student"


def configured_linked_ids() -> list[str]:
    return [c.strip() for c in os.environ.get("KIWI_CLASS_IDS", "local-css-demo").split(",") if c.strip()]


def class_linked(db: sqlite3.Connection, class_id: str) -> bool:
    """A class is Kiwi-linked when listed in KIWI_CLASS_IDS or present in ``kiwi_links``."""
    if class_id in configured_linked_ids():
        return True
    if not dbmod.table_exists(db, "kiwi_links"):
        return False
    return db.execute("SELECT 1 FROM kiwi_links WHERE class_id=?", (class_id,)).fetchone() is not None


def is_roster_eligible(student_id: str) -> bool:
    return bool(student_id) and not student_id.startswith("preview-") and student_id != "instructor"


def ensure_roster(db: sqlite3.Connection, class_id: str, student_id: str, *, source: str, display_name: str = "",
                  kiwi_email: str = "", kiwi_role: str = "") -> None:
    """The only writer that inserts or upgrades roster rows. Call inside the caller's ``write_tx``.

    New rows get the next ``pseudonym_seq`` of the class. ``source`` is never downgraded
    (kiwi > import > activity); empty arguments never overwrite stored values.
    """
    if source not in SOURCE_RANK:
        raise ValueError("Unknown roster source")
    if not is_roster_eligible(student_id):
        return
    if class_linked(db, class_id):
        display_name, kiwi_email = "", ""
    display_name = (display_name or "").strip()[:100]
    kiwi_email = (kiwi_email or "").strip()[:200]
    kiwi_role = (kiwi_role or "").strip()[:40]
    stamp = dbmod.now()
    row = db.execute("SELECT * FROM roster WHERE class_id=? AND student_id=?", (class_id, student_id)).fetchone()
    if row is None:
        seq = db.execute("SELECT COALESCE(MAX(pseudonym_seq), 0) + 1 FROM roster WHERE class_id=?",
                         (class_id,)).fetchone()[0]
        legacy_name = display_name or kiwi_email or student_id
        db.execute(
            """INSERT INTO roster (class_id, student_id, student_name, display_name, kiwi_email, source, status,
            kiwi_role, pseudonym_seq, created_at, updated_at, last_import_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)""",
            (class_id, student_id, legacy_name, display_name, kiwi_email, source, kiwi_role, seq, stamp, stamp,
             stamp if source in ("import", "kiwi") else None),
        )
        return
    updates: dict[str, object] = {}
    if SOURCE_RANK[source] > SOURCE_RANK.get(row["source"], 0):
        updates["source"] = source
    for column, value in (("display_name", display_name), ("kiwi_email", kiwi_email), ("kiwi_role", kiwi_role)):
        if value and value != row[column]:
            updates[column] = value
    if row["pseudonym_seq"] is None:
        updates["pseudonym_seq"] = db.execute(
            "SELECT COALESCE(MAX(pseudonym_seq), 0) + 1 FROM roster WHERE class_id=?", (class_id,)).fetchone()[0]
    if source in ("import", "kiwi"):
        updates["last_import_at"] = stamp
    if not updates:
        return
    updates["updated_at"] = stamp
    assignments = ", ".join(f"{column} = ?" for column in updates)
    db.execute(f"UPDATE roster SET {assignments} WHERE class_id=? AND student_id=?",
               (*updates.values(), class_id, student_id))


def _settings(db: sqlite3.Connection, class_id: str) -> dict:
    from server import readers

    return readers.settings(db, class_id)


def _pseudonym(class_id: str, student_id: str, seq: object) -> str:
    if isinstance(seq, int):
        return "S-%03d" % seq
    return "S-?" + hashlib.sha256(f"{class_id}:{student_id}".encode()).hexdigest()[:4]


def _name_from_row(row: sqlite3.Row | dict | None, student_id: str, show_emails: bool) -> str:
    if row is not None:
        if row["display_name"]:
            return row["display_name"]
        if show_emails and row["kiwi_email"]:
            return row["kiwi_email"]
        legacy = row["student_name"] or ""
        if legacy and "@" not in legacy and legacy != student_id:
            return legacy
    return "Student " + student_id[:6]


def label(db: sqlite3.Connection, class_id: str, student_id: str, mode: str = "names") -> str:
    """Display label of one student (read-only; never writes)."""
    row = db.execute(
        "SELECT display_name, kiwi_email, student_name, pseudonym_seq FROM roster WHERE class_id=? AND student_id=?",
        (class_id, student_id),
    ).fetchone()
    if mode == "pseudonyms" or class_linked(db, class_id):
        return _pseudonym(class_id, student_id, row["pseudonym_seq"] if row else None)
    show_emails = bool(_settings(db, class_id)["privacy"].get("showEmails", True))
    return _name_from_row(row, student_id, show_emails)


def labels(db: sqlite3.Connection, class_id: str, student_ids: Iterable[str], mode: str = "names") -> dict[str, str]:
    ids = sorted({s for s in student_ids if isinstance(s, str) and s})
    if not ids:
        return {}
    rows: dict[str, sqlite3.Row] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for row in db.execute(
            f"""SELECT student_id, display_name, kiwi_email, student_name, pseudonym_seq FROM roster
            WHERE class_id=? AND student_id IN ({','.join('?' for _ in chunk)})""",
            (class_id, *chunk),
        ):
            rows[row["student_id"]] = row
    if mode == "pseudonyms" or class_linked(db, class_id):
        return {s: _pseudonym(class_id, s, rows[s]["pseudonym_seq"] if s in rows else None) for s in ids}
    show_emails = bool(_settings(db, class_id)["privacy"].get("showEmails", True))
    return {s: _name_from_row(rows.get(s), s, show_emails) for s in ids}


def relabel(db: sqlite3.Connection, class_id: str, rows: list, mode: str = "names", key: str = "studentId",
            field: str = "studentName") -> list:
    """Replace display names in API rows (in place, also returned) with ``label()`` via one roster read.

    In ``pseudonyms`` mode it also nulls ``email``/``emails``/``kiwiEmail`` and blanks ``displayName``.
    """
    if not isinstance(rows, list):
        return rows
    targets = [row for row in rows if isinstance(row, dict) and isinstance(row.get(key), str)]
    names = labels(db, class_id, (row[key] for row in targets), mode)
    for row in targets:
        row[field] = names.get(row[key], row.get(field))
        if mode == "pseudonyms":
            for email_key in _EMAIL_KEYS:
                if email_key in row:
                    row[email_key] = None
            if "displayName" in row:
                row["displayName"] = ""
    return rows


def _salt(db: sqlite3.Connection, class_id: str) -> bytes:
    name = f"pseudonym-salt:{class_id}"
    row = db.execute("SELECT value FROM server_secrets WHERE name=?", (name,)).fetchone()
    if row:
        return bytes.fromhex(row["value"])
    with dbmod.write_tx(db):
        db.execute("INSERT INTO server_secrets (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING",
                   (name, secrets.token_hex(32), dbmod.now()))
        row = db.execute("SELECT value FROM server_secrets WHERE name=?", (name,)).fetchone()
    return bytes.fromhex(row["value"])


def student_hash(db: sqlite3.Connection, class_id: str, student_id: str) -> str:
    return hmac.new(_salt(db, class_id), f"{class_id}:{student_id}".encode(), hashlib.sha256).hexdigest()


def research_id(db: sqlite3.Connection, class_id: str, student_id: str) -> str:
    digest = hmac.new(_salt(db, class_id), f"{class_id}:{student_id}".encode(), hashlib.sha256).digest()
    return "P" + base64.b32encode(digest).decode("ascii").rstrip("=")[:10]


def tombstone(db: sqlite3.Connection, class_id: str, student_id: str) -> tuple[str, str, str] | None:
    if not db.execute("SELECT 1 FROM student_tombstones WHERE class_id=? LIMIT 1", (class_id,)).fetchone():
        return None
    row = db.execute(
        "SELECT mode, anon_id, created_at FROM student_tombstones WHERE class_id=? AND student_hash=?",
        (class_id, student_hash(db, class_id, student_id)),
    ).fetchone()
    return (row["mode"], row["anon_id"], row["created_at"]) if row else None


def consent_state(row: sqlite3.Row | dict | None) -> str:
    if row is None:
        return "not_asked"
    override = row["consent_override"]
    if override in ("yes", "no"):
        return override
    value = row["kiwi_consent"]
    if value == 1:
        return "yes"
    if value == 0:
        return "no"
    return "not_asked"


def population_sql(alias: str, *, class_linked: bool, cols: dict[str, str] = EVENT_COLS, include_staff: bool = False,
                   include_preview: bool = False, include_excluded: bool = False) -> tuple[str, list]:
    """SQL condition selecting who counts as a student, evaluated at query time (P10)."""
    c = {name: f"{alias}.{column}" for name, column in cols.items()}
    parts: list[str] = []
    if not include_preview:
        parts.append(f"{c['is_preview']} = 0 AND {c['student_id']} NOT LIKE 'preview-%'")
    if not include_staff:
        roles = ", ".join(f"'{r}'" for r in STAFF_ACTOR_ROLES)
        parts.append(f"{c['actor_role']} NOT IN ({roles})")
        roster = [f"r.class_id = {c['class_id']}", f"r.student_id = {c['student_id']}"]
        if not include_excluded:
            roster.append("r.status = 'active' AND r.excluded = 0")
        if class_linked:
            roster.append("r.source = 'kiwi'")
        parts.append(f"EXISTS (SELECT 1 FROM roster r WHERE {' AND '.join(roster)})")
        if class_linked:
            parts.append(f"NOT EXISTS (SELECT 1 FROM kiwi_staff_seen k WHERE k.class_id = {c['class_id']} "
                         f"AND k.kiwi_user_id = {c['student_id']})")
    elif not include_excluded:
        parts.append(f"NOT EXISTS (SELECT 1 FROM roster r WHERE r.class_id = {c['class_id']} AND r.student_id = "
                     f"{c['student_id']} AND (r.status != 'active' OR r.excluded != 0))")
    if consent_only():
        parts.append(consent_clause(c["class_id"], c["student_id"]))
    return (" AND ".join(f"({p})" for p in parts) if parts else "1 = 1"), []


def enrolled_count(db: sqlite3.Connection, class_id: str) -> int:
    linked = class_linked(db, class_id)
    sql = "SELECT COUNT(*) FROM roster r WHERE r.class_id=? AND r.status='active' AND r.excluded=0"
    if linked:
        sql += (" AND r.source='kiwi' AND NOT EXISTS (SELECT 1 FROM kiwi_staff_seen k WHERE k.class_id=r.class_id"
                " AND k.kiwi_user_id=r.student_id)")
    if consent_only():
        sql += " AND " + consent_clause("r.class_id", "r.student_id")
    return int(db.execute(sql, (class_id,)).fetchone()[0])


def roster_term_owners(db: sqlite3.Connection, class_id: str) -> list[tuple[str, str]]:
    """``(term, student_id)`` for every roster name and email of the class, longest term first (decision D3).

    Single-word names shorter than four characters are left out: they collide with ordinary words and ids
    (the structured name fields are relabeled separately, so this is the safety net for free text). Student ids that
    are email addresses (standalone rosters may use them) are terms too (review 2, SECURITY-05).
    """
    found: dict[str, tuple[str, str]] = {}
    for row in db.execute("SELECT student_id, display_name, kiwi_email, student_name FROM roster WHERE class_id=?", (class_id,)):
        sid = row["student_id"]
        for value in (row["display_name"], row["kiwi_email"], row["student_name"], sid if "@" in sid else ""):
            term = (value or "").strip() if isinstance(value, str) else ""
            if not term or (term == sid and "@" not in sid) or term == _ANON_NAME or len(term) < 3:
                continue
            if "@" not in term and " " not in term and len(term) < 4:
                continue
            found.setdefault(term.casefold(), (term, sid))
    if class_linked(db, class_id):
        for row in db.execute("SELECT kiwi_user_id, username FROM kiwi_staff_seen WHERE class_id=?", (class_id,)):
            term = (row["username"] or "").strip()
            if len(term) >= 4 and term != row["kiwi_user_id"]:
                found.setdefault(term.casefold(), (term, row["kiwi_user_id"]))
    return sorted(found.values(), key=lambda pair: len(pair[0]), reverse=True)


NON_PARTICIPANT = "[classmate]"


def roster_terms(db: sqlite3.Connection, class_id: str, *, participants_only: bool = False) -> list[tuple[str, str]]:
    """``(term, pseudonym)`` for every roster name and email of the class, longest term first (decision D3).

    ``participants_only`` (researcher responses, SB-m01): a student without research consent who is named in another
    student's text becomes ``[classmate]``, so no identifier of a non-participant reaches research data.
    """
    seqs = {row["student_id"]: row["pseudonym_seq"] for row in db.execute(
        "SELECT student_id, pseudonym_seq FROM roster WHERE class_id=?", (class_id,))}
    consenting = consenting_ids(db, class_id) if participants_only else set()
    return [(term, _pseudonym(class_id, sid, seqs.get(sid)) if not participants_only or sid in consenting else NON_PARTICIPANT)
            for term, sid in roster_term_owners(db, class_id)]


def term_pattern(terms: list[tuple[str, str]]) -> re.Pattern[str] | None:
    """One word-bounded, case-insensitive pattern for ``terms`` (None when there are none)."""
    if not terms:
        return None
    return re.compile(r"(?<![\w@.])(?:" + "|".join(re.escape(term) for term, _ in terms) + r")(?![\w@])", re.IGNORECASE)


def scrub_free_text(value: object, terms: list[tuple[str, str]], *, skip_id_keys: bool = True,
                    pattern: re.Pattern[str] | None = None) -> object:
    """Replace roster names/emails inside string values with their labels (word-bounded, case-insensitive).

    With ``skip_id_keys`` (JSON responses), keys that hold identifiers (``id``, ``…Id``, ``…Key``, ``href``…) are
    skipped so links and ids keep working; exports rewrite every string.
    """
    pattern = pattern or term_pattern(terms)
    if pattern is None:
        return value
    lookup = {term.casefold(): label for term, label in terms}

    def replace(match: re.Match[str]) -> str:
        return lookup.get(match.group(0).casefold(), "S-?")

    def walk(item: object, key: str = "") -> object:
        if skip_id_keys and key and _ID_KEY.search(key):
            return item
        if isinstance(item, str):
            return pattern.sub(replace, item)
        if isinstance(item, list):
            return [walk(x, key) for x in item]
        if isinstance(item, dict):
            return {k: walk(v, k if isinstance(k, str) else "") for k, v in item.items()}
        return item

    return walk(value)


# -- researcher consent scope (decision D3, review 2 SECURITY-02) ---------------------------------------
_CONSENT_ONLY: ContextVar[bool] = ContextVar("consent_only", default=False)
CONSENT_YES_SQL = "(rc.consent_override = 'yes' OR (rc.consent_override IS NULL AND rc.kiwi_consent = 1))"


def set_consent_only(value: bool) -> Token[bool]:
    """Restrict every population query of this request to students with research consent (researcher requests)."""
    return _CONSENT_ONLY.set(value)


def reset_consent_only(token: Token[bool]) -> None:
    _CONSENT_ONLY.reset(token)


def consent_only() -> bool:
    return _CONSENT_ONLY.get()


def consent_clause(class_col: str, student_col: str) -> str:
    """SQL: the student has research consent (teacher override, else Kiwi ``User.consent``)."""
    return (f"EXISTS (SELECT 1 FROM roster rc WHERE rc.class_id = {class_col} AND rc.student_id = {student_col} "
            f"AND {CONSENT_YES_SQL})")


def consenting_ids(db: sqlite3.Connection, class_id: str) -> set[str]:
    return {row[0] for row in db.execute(f"SELECT rc.student_id FROM roster rc WHERE rc.class_id = ? AND {CONSENT_YES_SQL}",
                                         (class_id,))}
