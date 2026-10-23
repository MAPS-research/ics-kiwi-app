"""Exports, research package, case files and codebook — owned by PEOPLE (spec §13.6, §13.8, PEOPLE-06/07/13/16/17/19)."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import unittest
import zipfile

from server import db as dbmod
from server import event_schema, identity, telemetry, testsupport
from server.testsupport import TEACHER_KEY, ApiTestCase, fake_kiwi_identity, freeze_time

C = "c1"
LIVE = "live-course"
BOM = b"\xef\xbb\xbf"
ACTIVITY_COLUMNS = [
    "event_id", "student_id", "student_label", "section_group", "condition_group", "occurred_at", "received_at", "event_type",
    "schema_version", "where", "surface", "practice_mode", "unit_id", "assignment_id", "assignment_version",
    "related_assignment_id", "question_id", "item_id", "question_activity_id", "study_session_index", "actor_role",
    "checked_by", "correct", "rejudged_correct", "policy_version_id", "ai_call_id", "chat_turn_id", "truncated_fields",
    "payload_json",
]


def _client_event(db, class_id: str, student_id: str, event_type: str, payload: dict):
    ident = testsupport.student_identity(db, class_id, student_id)
    return telemetry.add_event(db, ident, {"classId": class_id, "studentId": student_id, "studentName": ident.display_name,
                                           "sessionId": "test-session", "type": event_type, "payload": payload})


def _csv(raw: bytes, *, bom: bool = True) -> list[list[str]]:
    if bom:
        assert raw.startswith(BOM), raw[:10]
        raw = raw[len(BOM):]
    else:
        assert not raw.startswith(BOM)
    return list(csv.reader(io.StringIO(raw.decode("utf-8"), newline="")))


def _dicts(raw: bytes, *, bom: bool = True) -> list[dict]:
    rows = _csv(raw, bom=bom)
    return [dict(zip(rows[0], row)) for row in rows[1:]]


def _zip(raw: bytes) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(raw))


class ActivityExportTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create_course(C)
        with self.db() as db:
            testsupport.add_roster(db, C, "s1", display_name="Ada Chen", kiwi_email="ada@example.edu")
            testsupport.add_roster(db, C, "s2", display_name="=HYPERLINK(1)")
            testsupport.add_roster(db, C, "s3", display_name="＋SUM")
            self.section = testsupport.make_group(db, C, "section", "Section A", ["s1"])
            with freeze_time("2026-10-01T01:00:00+00:00"):
                _client_event(db, C, "s1", "code_run", {"code": "mean(x)", "ok": True, "unitId": "r-basics"})
            with freeze_time("2026-10-10T01:00:00+00:00"):
                testsupport.make_chat_turn(db, C, "s1", "I am Ada Chen, why NA?", "Use na.rm.", unit_id="data-wrangling")
                _client_event(db, C, "s2", "code_run", {"code": "1", "ok": True, "unitId": "data-wrangling"})
                _client_event(db, C, "s3", "code_run", {"code": "2", "ok": False, "error": "boom"})
            work = testsupport.publish_work(db, C, kind="practice")
            testsupport.make_server_check(db, C, "preview-instructor", work.id, "q1", "4", True, preview=True)

    def _get(self, path: str, key: str = TEACHER_KEY):
        status, body = self.request(f"/api/teacher/exports/{path}{'&' if '?' in path else '?'}classId={C}", key=key)
        return status, body, dict(self.last_headers)

    def test_activity_csv_columns_bom_neutralization_streamed_and_logged(self):  # PEOPLE-06, §13.6 KEEP
        status, raw, headers = self._get("activity.csv")
        self.assertEqual(status, 200, raw)
        self.assertTrue(headers["Content-Type"].startswith("text/csv"))
        self.assertEqual(int(headers["Content-Length"]), len(raw))
        self.assertIn("attachment", headers.get("Content-Disposition", ""))
        self.assertIn(b"\r\n", raw)
        rows = _csv(raw)
        self.assertEqual(rows[0], ACTIVITY_COLUMNS)
        data = [dict(zip(rows[0], r)) for r in rows[1:]]
        self.assertTrue(data)
        self.assertFalse(any(r["student_id"].startswith("preview-") for r in data))
        labels = {r["student_id"]: r["student_label"] for r in data}
        self.assertEqual(labels["s1"], "Ada Chen")
        self.assertEqual(labels["s2"], "'=HYPERLINK(1)")
        self.assertEqual(labels["s3"], "'＋SUM")
        self.assertEqual({r["section_group"] for r in data if r["student_id"] == "s1"}, {"Section A"})
        self.assertEqual({r["where"] for r in data}, {"lab"})
        ai = next(r for r in data if r["event_type"] == "ai_question")
        self.assertTrue(ai["chat_turn_id"])
        with self.db() as db:
            log = db.execute("SELECT category, endpoint, row_count FROM data_access_log ORDER BY id DESC").fetchone()
        self.assertEqual(tuple(log), ("export", "/api/teacher/exports/activity.csv", len(data)))

    def test_activity_jsonl_filters_purpose_and_pseudonyms(self):  # PEOPLE-06, AU-D4-07
        status, raw, headers = self._get("activity.jsonl")
        self.assertEqual(status, 200)
        self.assertFalse(raw.startswith(BOM))
        lines = [json.loads(line) for line in raw.decode().splitlines()]
        self.assertEqual(set(lines[0]), set(ACTIVITY_COLUMNS))
        self.assertIsInstance(lines[0]["payload_json"], dict)
        _, raw, _ = self._get("activity.jsonl?from=2026-10-05T00:00:00Z&to=2026-10-11T00:00:00Z")
        self.assertEqual({json.loads(l)["student_id"] for l in raw.decode().splitlines()}, {"s1", "s2", "s3"})
        _, raw, _ = self._get("activity.jsonl?from=2026-09-30T00:00:00Z&to=2026-10-05T00:00:00Z")
        self.assertEqual([json.loads(l)["event_type"] for l in raw.decode().splitlines()], ["code_run"])
        _, raw, _ = self._get(f"activity.jsonl?groupIds={self.section}")
        self.assertEqual({json.loads(l)["student_id"] for l in raw.decode().splitlines()}, {"s1"})
        _, raw, _ = self._get("activity.jsonl?unitIds=data-wrangling")
        self.assertEqual({json.loads(l)["unit_id"] for l in raw.decode().splitlines()}, {"data-wrangling"})
        status, error, _ = self._get("activity.csv?studentId=s1")
        self.assertEqual((status, error["code"]), (400, "invalid_request"))
        status, raw, _ = self._get("activity.csv?studentId=s1&purpose=Integrity%20review")
        self.assertEqual(status, 200)
        self.assertEqual({r["student_id"] for r in _dicts(raw)}, {"s1"})
        with self.db() as db:
            self.assertEqual(db.execute("SELECT purpose FROM data_access_log ORDER BY id DESC").fetchone()[0], "Integrity review")
            rid = identity.research_id(db, C, "s1")
        status, raw, headers = self._get("activity.csv?pseudonymize=1")
        rows = _dicts(raw)
        self.assertIn("research_id", rows[0])
        self.assertNotIn("student_id", rows[0])
        self.assertIn(rid, {r["research_id"] for r in rows})
        self.assertNotIn(b"Ada", raw)
        self.assertNotIn(b"ada@example.edu", raw)
        self.assertEqual(headers.get("X-Export-Pseudonymized"), "1")

    def test_viewer_exports_are_forced_pseudonymous_with_consent(self):  # PEOPLE-19, AU-D4-14
        with self.db() as db:
            db.execute("UPDATE roster SET consent_override='yes' WHERE class_id=? AND student_id='s1'", (C,))
            rid = identity.research_id(db, C, "s1")
        _, created = self.request(f"/api/teacher/staff?classId={C}", "POST", {"displayName": "Shen Viewer", "role": "viewer"},
                                  key=TEACHER_KEY)
        viewer = created["key"]
        _, me = self.request(f"/api/me?classId={C}", key=viewer)
        self.assertTrue(me["exportsForcedPseudonymous"])
        # RV6-M07: allowUnverified=0 is forced on every viewer export; a standalone course has no verified identities
        # (the linked-course case is in server/test_review3.py)
        status, body, _ = self._get("activity.csv?pseudonymize=0&consent=all", key=viewer)
        self.assertEqual((status, body["code"]), (409, "unverified_identity"))
        self.assertTrue(rid)
        status, body, _ = self._get("research-package.zip?purpose=Course%20study", key=viewer)
        self.assertEqual(status, 403)
        with self.db() as db:
            testsupport.update_settings(db, C, {"privacy": {"viewerCanExportResearch": True}})
        status, body, _ = self._get("research-package.zip?purpose=Course%20study&allowUnverified=1", key=viewer)
        self.assertEqual((status, body["code"]), (409, "unverified_identity"))
        status, body, _ = self._get("student/s1.zip?purpose=Integrity%20case", key=viewer)
        self.assertEqual(status, 403)

    def test_researcher_exports_are_forced_and_case_files_refused(self):  # decision D3
        with self.db() as db:
            db.execute("UPDATE roster SET consent_override='yes' WHERE class_id=? AND student_id='s1'", (C,))
            rid = identity.research_id(db, C, "s1")
        _, created = self.request(f"/api/teacher/staff?classId={C}", "POST", {"displayName": "Shen", "role": "researcher"},
                                  key=TEACHER_KEY)
        researcher = created["key"]
        # RV6-M07 (decision D3): allowUnverified=0 on every researcher export, so a standalone course (unverified demo
        # identities only) exports nothing; pseudonyms, consent and the verified-only rows of a linked course are pinned
        # in server/test_review3.py.
        for name in ("activity.csv", "ai-conversations.csv", "generated-items.jsonl", "conversation-codes.csv"):
            with self.subTest(name):
                status, body, _ = self._get(f"{name}?pseudonymize=0&consent=all&includeStaff=1", key=researcher)
                self.assertEqual((status, body["code"]), (409, "unverified_identity"))
                self.assertNotIn("Ada", json.dumps(body))
        self.assertTrue(rid)
        # research package: no viewerCanExportResearch needed, but allowUnverified is never honoured for a researcher
        status, body, _ = self._get("research-package.zip?purpose=Course%20study&allowUnverified=1", key=researcher)
        self.assertEqual((status, body["code"]), (409, "unverified_identity"))
        status, body, _ = self._get("student/s1.zip?purpose=Integrity%20case", key=researcher)
        self.assertEqual((status, body["code"]), (403, "role_required"))
        with self.db() as db:
            rows = [tuple(r) for r in db.execute("SELECT actor_role, category FROM data_access_log WHERE actor_label='Shen'")]
        # refused exports read no student data; the access log of a successful researcher export (with the role) is
        # pinned by server/test_review3.py
        self.assertEqual({r[0] for r in rows}, {"researcher"} if rows else set())

    def test_codebook_documents_registry_and_metrics(self):  # PEOPLE-13, AU-D4-25
        status, raw, headers = self._get("codebook.md")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/markdown"))
        text = raw.decode("utf-8")
        for event_type, spec in event_schema.REGISTRY.items():
            self.assertIn(f"### `{event_type}`", text)
            for field_name in spec["fields"]:
                self.assertIn(f"`{field_name}`", text)
        for phrase in ("Auto-checked accuracy (your questions)", "Similar practice accuracy (AI)", "research_id", "ai_provider",
                       "`source`", "lab:<student>:<thread>", "Known limitations", "deprecated", "Schema changelog",
                       "checked_by", "rejudged_correct"):
            self.assertIn(phrase, text)


class ConversationExportTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        with self.db() as db:
            db.execute("INSERT INTO kiwi_links (class_id, name) VALUES (?, ?)", (LIVE, LIVE))
            testsupport.add_roster(db, LIVE, "k1", source="kiwi", kiwi_email="k1@example.edu")
            self.cond = testsupport.make_group(db, LIVE, "condition", "A", ["k1"])
            self.turn = testsupport.make_chat_turn(db, LIVE, "k1", "why does merge drop rows?", "Check the keys.",
                                                   unit_id="data-wrangling")
            testsupport.make_native_event(db, LIVE, "k1", prompt="Why NA?", response="Because missing.", email="k1@example.edu")
            testsupport.make_free_item_attempt(db, LIVE, "k1", "data-wrangling")
            db.execute("""INSERT INTO codebook_codes (id, class_id, label, created_by, created_at)
                       VALUES ('code-1', ?, 'Confusion', 'instructor', ?)""", (LIVE, dbmod.now()))
            db.execute("""INSERT INTO conversation_codes (class_id, thread_key, chat_turn_id, code_id, coder_id, created_at)
                       VALUES (?, 'lab:k1:t1', ?, 'code-1', 't1', ?)""", (LIVE, self.turn, dbmod.now()))

    def _get(self, path: str, token: str):
        status, body = self.request(f"/api/teacher/exports/{path}{'&' if '?' in path else '?'}classId={LIVE}", token=token)
        return status, body

    def test_ai_conversations_generated_items_and_codes(self):  # PEOPLE-06, AU-D2-M4, AU-D3-25
        with fake_kiwi_identity("staff", True, True, class_id=LIVE, user_id="t1") as token:
            status, raw = self._get("ai-conversations.csv", token)
            self.assertEqual(status, 200, raw)
            rows = _dicts(raw)
            self.assertEqual({r["where"] for r in rows}, {"lab", "kiwi"})
            lab = next(r for r in rows if r["where"] == "lab")
            self.assertEqual((lab["thread_key"], lab["condition_group"], lab["codes"]), ("lab:k1:t1", "A", "Confusion"))
            self.assertEqual((lab["ai_provider"], lab["model"]), ("openai", "gpt-5.4-mini"))
            kiwi = next(r for r in rows if r["where"] == "kiwi")
            self.assertEqual((kiwi["ai_provider"], kiwi["prompt"], kiwi["response"]), ("kiwi-native", "Why NA?", "Because missing."))
            self.assertTrue(kiwi["native_event_id"])
            self.assertIn("native_feedback", rows[0])
            status, raw = self._get("ai-conversations.jsonl?pseudonymize=1", token)
            lines = [json.loads(l) for l in raw.decode().splitlines()]
            self.assertTrue(all(l["thread_key"].startswith(("lab:P", "kiwi:")) for l in lines))
            self.assertNotIn(b"k1@example.edu", raw)
            status, raw = self._get("generated-items.jsonl", token)
            items = [json.loads(l) for l in raw.decode().splitlines()]
            self.assertEqual(len(items), 1)
            self.assertEqual((items[0]["origin"], items[0]["attempts"], items[0]["correct"]), ("free", 1, 1))
            self.assertIn("answer", items[0]["item"])
            self.assertEqual(items[0]["condition_group"], "A")
            status, raw = self._get("generated-items.csv", token)
            self.assertEqual(status, 200)
            self.assertIn("item_json", _csv(raw)[0])
            status, raw = self._get("conversation-codes.csv", token)
            codes = _dicts(raw)
            self.assertEqual((codes[0]["code_label"], codes[0]["thread_key"]), ("Confusion", "lab:k1:t1"))


class CaseFileTests(ApiTestCase):
    def test_ta_case_file_and_student_conversation_export(self):  # PEOPLE-17, TH07
        self.create_course(C)
        with self.db() as db:
            testsupport.add_roster(db, C, "s1", display_name="Ada Chen")
            work = testsupport.publish_work(db, C, title="Week 3 HW")
            sub = testsupport.make_autochecked_submission(db, C, "s1", work.id, {"q1": "4", "q2": "A vector"})
            testsupport.make_chat_turn(db, C, "s1", "is it 4?", "Check the mean.", assignment_id=work.id, question_id="q1")
            events = db.execute("SELECT COUNT(*) FROM events WHERE class_id=? AND student_id='s1'", (C,)).fetchone()[0]
        _, ta = self.request(f"/api/teacher/staff?classId={C}", "POST", {"displayName": "TA One", "role": "ta"}, key=TEACHER_KEY)
        _, viewer = self.request(f"/api/teacher/staff?classId={C}", "POST", {"displayName": "V", "role": "viewer"}, key=TEACHER_KEY)
        status, body = self.request(f"/api/teacher/exports/student/s1.zip?classId={C}", key=ta["key"])
        self.assertEqual((status, body["code"]), (400, "invalid_request"))
        status, raw = self.request(f"/api/teacher/exports/student/s1.zip?classId={C}&purpose=Integrity%20case%2012", key=ta["key"])
        self.assertEqual(status, 200, raw)
        archive = _zip(raw)
        self.assertEqual(sorted(archive.namelist()),
                         ["README.md", "ai_conversations.csv", "item_scores.csv", "submissions.csv", "timeline.jsonl"])
        readme = archive.read("README.md").decode()
        self.assertIn("Integrity case 12", readme)
        self.assertIn("TA One", readme)
        self.assertIn("is it 4?", archive.read("ai_conversations.csv").decode("utf-8-sig"))
        self.assertIn(sub, archive.read("submissions.csv").decode("utf-8-sig"))
        self.assertIn("Ada Chen", archive.read("submissions.csv").decode("utf-8-sig"))
        self.assertEqual(len(_dicts(archive.read("item_scores.csv"))), 2)
        self.assertEqual(len(archive.read("timeline.jsonl").decode().splitlines()), events)
        status, _ = self.request(f"/api/teacher/exports/student/s1.zip?classId={C}&purpose=Integrity%20case", key=viewer["key"])
        self.assertEqual(status, 403)
        status, body = self.request(f"/api/teacher/exports/ai-conversations.csv?classId={C}&studentId=s1", key=ta["key"])
        self.assertEqual(status, 400)
        status, raw = self.request(f"/api/teacher/exports/ai-conversations.csv?classId={C}&studentId=s1&purpose=Integrity%20case%2012",
                                   key=ta["key"])
        self.assertEqual(status, 200)
        self.assertEqual(len(_dicts(raw)), 1)
        with self.db() as db:
            purposes = [r[0] for r in db.execute("SELECT purpose FROM data_access_log WHERE category='export'")]
        self.assertEqual(purposes, ["Integrity case 12", "Integrity case 12"])
        self.assertEqual(self.request(f"/api/teacher/exports/student/ghost.zip?classId={C}&purpose=Integrity%20case",
                                      key=ta["key"])[0], 404)
        with self.db() as db:
            db.execute("UPDATE roster SET status='dropped', excluded=1 WHERE class_id=? AND student_id='s1'", (C,))
        status, raw = self.request(f"/api/teacher/exports/student/s1.zip?classId={C}&purpose=Integrity%20case%2012", key=ta["key"])
        archive = _zip(raw)
        self.assertEqual(len(archive.read("timeline.jsonl").decode().splitlines()), events)
        self.assertIn("is it 4?", archive.read("ai_conversations.csv").decode("utf-8-sig"))


class ResearchPackageTests(ApiTestCase):
    def test_standalone_requires_allow_unverified_and_purpose(self):  # PEOPLE-07, AU-T-06
        self.create_course(C)
        with self.db() as db:
            testsupport.add_roster(db, C, "s1", display_name="Ada Chen")
            testsupport.make_chat_turn(db, C, "s1", "q", "a")
        base = f"/api/teacher/exports/research-package.zip?classId={C}"
        for query in ("", "&consent=all&pseudonymize=1", "&purpose=abc"):
            status, body = self.request(base + query, key=TEACHER_KEY)
            self.assertEqual((status, body["code"]), (400, "invalid_request"), query)
        status, body = self.request(base + "&purpose=Course%20reflection", key=TEACHER_KEY)
        self.assertEqual((status, body["code"]), (409, "unverified_identity"))
        status, body = self.request(base + "&purpose=Course%20reflection&consent=all&pseudonymize=0&allowUnverified=1", key=TEACHER_KEY)
        self.assertEqual((status, body["code"]), (409, "consent_required"))
        status, raw = self.request(base + "&purpose=Course%20reflection&consent=all&allowUnverified=1", key=TEACHER_KEY)
        self.assertEqual(status, 200, raw)
        archive = _zip(raw)
        readme = archive.read("README.md").decode()
        self.assertIn("DEMO DATA — identities not verified", readme)
        self.assertIn("IRB protocol: (not provided)", readme)
        self.assertIn("Course reflection", readme)
        participants = _dicts(archive.read("participants.csv"), bom=False)
        self.assertEqual({p["identity_verified"] for p in participants}, {"0"})
        self.assertNotIn("student_id", participants[0])

    def test_linked_package_consent_manifest_condition_at_event_time(self):  # PEOPLE-04, PEOPLE-06, PEOPLE-16
        with self.db() as db:
            db.execute("INSERT INTO kiwi_links (class_id, name) VALUES (?, ?)", (LIVE, LIVE))
            for sid, consent in (("k1", 1), ("k2", 0), ("k3", None)):
                testsupport.add_roster(db, LIVE, sid, source="kiwi", kiwi_email=f"{sid}@example.edu")
                db.execute("UPDATE roster SET kiwi_consent=? WHERE class_id=? AND student_id=?", (consent, LIVE, sid))
            testsupport.update_settings(db, LIVE, {"privacy": {"irbProtocol": "IRB-2026-01"}})
            a = testsupport.make_group(db, LIVE, "condition", "A", [], at="2026-10-01T00:00:00+00:00")
            b = testsupport.make_group(db, LIVE, "condition", "B", [], at="2026-10-01T00:00:00+00:00")
            with freeze_time("2026-10-02T00:00:00+00:00"):
                testsupport.set_membership(db, LIVE, a, "k1", "condition", method="random", seed="s1")
            for sid in ("k1", "k2", "k3"):
                testsupport.make_chat_turn(db, LIVE, sid, f"first {sid}", "r", at="2026-10-03T00:00:00+00:00")
            with freeze_time("2026-10-05T00:00:00+00:00"):
                testsupport.set_membership(db, LIVE, b, "k1", "condition", method="random", seed="s2")
            testsupport.make_chat_turn(db, LIVE, "k1", "second k1", "r", at="2026-10-06T00:00:00+00:00")
            rid = identity.research_id(db, LIVE, "k1")
        with fake_kiwi_identity("staff", True, True, class_id=LIVE, user_id="t1") as token:
            status, raw = self.request(f"/api/teacher/exports/research-package.zip?classId={LIVE}&purpose=Condition%20study",
                                       token=token)
            self.assertEqual(status, 200, raw)
            archive = _zip(raw)
            names = set(archive.namelist())
            for name in ("README.md", "codebook.md", "manifest.json", "participants.csv", "events.csv", "ai_turns.csv",
                         "ai_calls.csv", "group_history.csv", "submissions.csv", "item_scores.csv", "generated_items.jsonl",
                         "policy_versions.jsonl", "assignments.jsonl", "native_ai_responses.csv", "conversation_codes.csv"):
                self.assertIn(name, names)
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual((manifest["format"], manifest["formatVersion"], manifest["pseudonymized"]),
                             ("css-lab-research-package", 1, True))
            for entry in manifest["files"]:
                self.assertEqual(hashlib.sha256(archive.read(entry["name"])).hexdigest(), entry["sha256"], entry["name"])
            self.assertIn("IRB protocol: IRB-2026-01", archive.read("README.md").decode())
            participants = _dicts(archive.read("participants.csv"), bom=False)
            self.assertEqual([p["research_id"] for p in participants], [rid])
            self.assertEqual(participants[0]["consent_state"], "yes")
            events = _dicts(archive.read("events.csv"), bom=False)
            self.assertEqual({e["research_id"] for e in events}, {rid})
            by_prompt = {json.loads(e["payload_json"]).get("prompt"): e["condition_group"] for e in events if e["event_type"] == "ai_question"}
            self.assertEqual(by_prompt, {"first k1": "A", "second k1": "B"})
            history = _dicts(archive.read("group_history.csv"), bom=False)
            self.assertEqual([(h["group"], bool(h["valid_to"])) for h in history], [("A", True), ("B", False)])
            calls = _csv(archive.read("ai_calls.csv"), bom=False)[0]
            self.assertNotIn("developer_text", calls)
            self.assertNotIn(b"k1@example.edu", raw)
            status, raw = self.request(f"/api/teacher/exports/research-package.zip?classId={LIVE}&purpose=Condition%20study"
                                       "&includeRaw=1", token=token)
            calls = _csv(_zip(raw).read("ai_calls.csv"), bom=False)[0]
            self.assertIn("developer_text", calls)
            self.assertIn("raw_output", calls)
            status, raw = self.request(f"/api/teacher/exports/research-package.zip?classId={LIVE}&purpose=Condition%20study"
                                       "&consent=all&pseudonymize=1", token=token)
            self.assertEqual(len(_dicts(_zip(raw).read("participants.csv"), bom=False)), 3)
        # decision D3: a researcher (Kiwi staff override) gets the package without the viewer setting, consenting
        # students only, never the raw provider fields
        with self.db() as db:
            db.execute("""INSERT INTO staff (id, class_id, display_name, role, kiwi_user_id, created_by, created_at)
                       VALUES ('staff-research1', ?, 'Shen', 'researcher', 'r1', 'test', ?)""", (LIVE, dbmod.now()))
        with fake_kiwi_identity("staff", False, True, "professor", class_id=LIVE, user_id="r1") as token:
            status, raw = self.request(f"/api/teacher/exports/research-package.zip?classId={LIVE}&purpose=Condition%20study"
                                       "&consent=all&pseudonymize=0&includeRaw=1", token=token)
            self.assertEqual(status, 200, raw)
            archive = _zip(raw)
            self.assertEqual([p["research_id"] for p in _dicts(archive.read("participants.csv"), bom=False)], [rid])
            self.assertNotIn("developer_text", _csv(archive.read("ai_calls.csv"), bom=False)[0])
            self.assertTrue(json.loads(archive.read("manifest.json"))["pseudonymized"])
            self.assertNotIn(b"k1@example.edu", raw)


if __name__ == "__main__":
    unittest.main()
