"""Roster, search, profile, groups, staff, settings, audit and data deletion — owned by PEOPLE.

The first test was moved from server/test_app.py by FOUNDATION (spec §16.1 item 6); the rest cover PEOPLE-01…22
(spec §9.7) on ``testsupport`` builders only.
"""

from __future__ import annotations

import json
import unittest

from server import db as dbmod
from server import identity, telemetry, testsupport
from server.testsupport import TEACHER_KEY, ApiTestCase, fake_kiwi_identity, freeze_time

C = "c1"


def _client_event(db, class_id: str, student_id: str, event_type: str, payload: dict, *, question_id: str | None = None):
    ident = testsupport.student_identity(db, class_id, student_id)
    return telemetry.add_event(db, ident, {
        "classId": class_id, "studentId": student_id, "studentName": ident.display_name or student_id,
        "sessionId": "test-session", "type": event_type, "questionId": question_id, "payload": payload})


def _rows(db, sql: str, *params) -> list[dict]:
    return [dict(r) for r in db.execute(sql, params)]


class PeopleTests(ApiTestCase):
    def test_roster_includes_inactive_students(self):
        status, _ = self.request(
            "/api/teacher/roster?classId=css190",
            "POST",
            {"students": [{"studentId": "s2", "studentName": "Bo"}]},
        )
        self.assertEqual(status, 401)
        status, imported = self.request(
            "/api/teacher/roster?classId=css190",
            "POST",
            {"students": [{"studentId": "s2", "studentName": "Bo"}]},
            "test-teacher-key",
        )
        self.assertEqual(status, 200)
        self.assertEqual(imported["count"], 1)
        status, hub = self.request(
            "/api/teacher/hub?classId=css190", key="test-teacher-key"
        )
        self.assertEqual(hub["students"][0]["studentName"], "Bo")
        self.assertEqual(hub["students"][0]["interactions"], 0)


class RosterTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create_course(C)
        with self.db() as db:
            testsupport.add_roster(db, C, "s1", display_name="Ada Chen", kiwi_email="ada@example.edu")
            testsupport.add_roster(db, C, "s2", display_name="Bo Lin", kiwi_email="bo@example.edu")
            testsupport.add_roster(db, C, "s3", kiwi_email="cy@example.edu")

    def test_roster_entries_columns_and_pseudonym_scrub(self):  # PEOPLE-05, PEOPLE-14
        with self.db() as db:
            group = testsupport.make_group(db, C, "section", "Section A", ["s1"])
            work = testsupport.publish_work(db, C, due_at="2026-01-01T00:00:00+00:00")
            _client_event(db, C, "s1", "code_run", {"code": "1+1", "ok": True})
        status, body = self.request(f"/api/teacher/roster?classId={C}", key=TEACHER_KEY)
        self.assertEqual(status, 200)
        self.assertEqual(body["total"], 3)
        ada = next(s for s in body["students"] if s["studentId"] == "s1")
        for key in ("studentId", "studentName", "displayName", "email", "pseudonym", "source", "status", "groups", "consent",
                    "consentSource", "excluded", "exclusionReason", "lastActive", "missingWork", "activitiesRecorded"):
            self.assertIn(key, ada)
        self.assertEqual((ada["studentName"], ada["email"], ada["pseudonym"]), ("Ada Chen", "ada@example.edu", "S-001"))
        self.assertEqual(ada["groups"], [{"kind": "section", "groupId": group, "name": "Section A"}])
        self.assertEqual((ada["consent"], ada["consentSource"]), ("not_asked", "none"))
        self.assertEqual(ada["missingWork"], 1)
        self.assertIsNotNone(ada["lastActive"])
        status, body = self.request(f"/api/teacher/roster?classId={C}&groupId={group}", key=TEACHER_KEY)
        self.assertEqual([s["studentId"] for s in body["students"]], ["s1"])
        status, body = self.request(f"/api/teacher/roster?classId={C}", key=TEACHER_KEY, name_mode="pseudonyms")
        self.assertEqual(status, 200)
        for row in body["students"]:
            self.assertIsNone(row["email"])
            self.assertEqual(row["displayName"], "")
            self.assertRegex(row["studentName"], r"^S-\d{3}$")
        self.assertNotIn("Ada", json.dumps(body))
        # PEOPLE-05: the assignment status popover (ASSESS endpoint) never sends emails in Presentation mode
        status, students = self.request(f"/api/teacher/assignments/{work.id}/students?classId={C}&state=missing",
                                        key=TEACHER_KEY, name_mode="pseudonyms")
        self.assertEqual(status, 200, students)
        self.assertIsNone(students["emails"])
        self.assertNotIn("ada@example.edu", json.dumps(students))

    def test_search_by_name_id_email_pseudonym_and_presentation_mode(self):  # PEOPLE-01, PEOPLE-05
        def hits(q: str, mode: str | None = None) -> list[dict]:
            status, body = self.request(f"/api/teacher/students/search?classId={C}&q={q}", key=TEACHER_KEY, name_mode=mode)
            self.assertEqual(status, 200, body)
            return body

        self.assertEqual([(h["studentId"], h["matchedOn"]) for h in hits("ada")], [("s1", "name")])
        self.assertEqual([(h["studentId"], h["matchedOn"]) for h in hits("bo%40example")], [("s2", "email")])
        self.assertEqual([h["matchedOn"] for h in hits("s3")], ["id"])
        self.assertEqual([(h["studentId"], h["matchedOn"]) for h in hits("S-002")], [("s2", "pseudonym")])
        self.assertEqual(hits("ada", "pseudonyms"), [])
        found = hits("S-0", "pseudonyms")
        self.assertEqual(len(found), 3)
        self.assertTrue(all(h["studentName"].startswith("S-0") for h in found))
        self.assertNotIn("Ada", json.dumps(found))
        status, body = self.request(f"/api/teacher/students/search?classId={C}&q=", key=TEACHER_KEY)
        self.assertEqual((status, body["code"]), (400, "invalid_request"))
        with self.db() as db:
            for i in range(15):
                testsupport.add_roster(db, C, f"x{i:02d}", display_name=f"Xavier {i}")
        self.assertEqual(len(hits("xavier")), 10)

    def test_roster_import_preview_diff_apply_and_groups(self):  # PEOPLE-10, AU-D1-M06, PEOPLE-02
        rows = [
            {"studentId": "s1", "name": "Ada Chen", "section": "Sec A", "condition": "A"},
            {"studentId": "s2", "name": "Bo Lin-Smith"},
            {"studentId": "s9", "name": "Dee Park", "email": "dee@example.edu", "section": "Sec B"},
            {"studentId": "bad id!", "name": "Oops"},
        ]
        status, preview = self.request(f"/api/teacher/roster/import?classId={C}", "POST",
                                       {"rows": rows, "mode": "preview", "matchBy": "studentId"}, key=TEACHER_KEY)
        self.assertEqual(status, 200, preview)
        self.assertEqual([r["action"] for r in preview["rows"]], ["update", "update", "add", "error"])
        self.assertEqual(preview["applied"], 0)
        self.assertEqual(preview["rows"][1]["diff"]["displayName"], ["Bo Lin", "Bo Lin-Smith"])
        self.assertEqual(preview["rows"][0]["diff"]["section"], [None, "Sec A"])
        with self.db() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM roster WHERE class_id=? AND student_id='s9'", (C,)).fetchone())
            self.assertEqual(db.execute("SELECT COUNT(*) FROM course_groups WHERE class_id=?", (C,)).fetchone()[0], 0)
        status, applied = self.request(f"/api/teacher/roster/import?classId={C}", "POST",
                                       {"rows": rows[:3], "mode": "apply", "matchBy": "studentId"}, key=TEACHER_KEY)
        self.assertEqual((status, applied["applied"]), (200, 3))
        with self.db() as db:
            dee = db.execute("SELECT * FROM roster WHERE class_id=? AND student_id='s9'", (C,)).fetchone()
            self.assertEqual((dee["display_name"], dee["kiwi_email"], dee["source"]), ("Dee Park", "dee@example.edu", "import"))
            members = _rows(db, """SELECT m.student_id, g.name, m.kind, m.method FROM group_members m JOIN course_groups g
                ON g.id=m.group_id WHERE m.class_id=? ORDER BY m.student_id, m.kind""", C)
            self.assertEqual([(m["student_id"], m["name"], m["kind"], m["method"]) for m in members],
                             [("s1", "A", "condition", "import"), ("s1", "Sec A", "section", "import"),
                              ("s9", "Sec B", "section", "import")])
            action = db.execute("SELECT * FROM teacher_actions WHERE action='roster_import'").fetchone()
            self.assertIsNotNone(action)
        status, again = self.request(f"/api/teacher/roster/import?classId={C}", "POST",
                                     {"rows": rows[:3], "mode": "preview", "matchBy": "studentId"}, key=TEACHER_KEY)
        self.assertEqual([r["action"] for r in again["rows"]], ["unchanged", "unchanged", "unchanged"])

    def test_roster_import_matches_kiwi_accounts_by_email(self):  # PEOPLE-10, §14.1
        with self.db() as db:
            testsupport.add_roster(db, C, "3f2a91c0-0000-4000-8000-000000000001", source="kiwi", kiwi_email="eve@example.edu")
        rows = [{"email": "EVE@example.edu", "name": "Eve Wu"}, {"email": "nobody@example.edu", "name": "Nobody"}]
        status, result = self.request(f"/api/teacher/roster/import?classId={C}", "POST",
                                      {"rows": rows, "mode": "apply", "matchBy": "email"}, key=TEACHER_KEY)
        self.assertEqual(status, 200, result)
        self.assertEqual([r["action"] for r in result["rows"]], ["update", "error"])
        self.assertEqual(result["rows"][0]["studentId"], "3f2a91c0-0000-4000-8000-000000000001")
        with self.db() as db:
            row = db.execute("SELECT display_name, source FROM roster WHERE kiwi_email='eve@example.edu'").fetchone()
            self.assertEqual(tuple(row), ("Eve Wu", "kiwi"))
        status, body = self.request(f"/api/teacher/roster/import?classId={C}", "POST",
                                    {"rows": [{"studentId": f"z{i}"} for i in range(501)], "mode": "preview",
                                     "matchBy": "studentId"}, key=TEACHER_KEY)
        self.assertEqual(status, 400)

    def test_patch_status_exclusion_and_consent_override(self):  # PEOPLE-04, PEOPLE-10, AU-D1-23
        with self.db() as db:
            db.execute("UPDATE roster SET kiwi_consent=0 WHERE class_id=? AND student_id='s3'", (C,))
            self.assertEqual(identity.enrolled_count(db, C), 3)
        status, entry = self.request(f"/api/teacher/roster/s2?classId={C}", "PATCH", {"status": "dropped"}, key=TEACHER_KEY)
        self.assertEqual((status, entry["status"]), (200, "dropped"))
        status, entry = self.request(f"/api/teacher/roster/s1?classId={C}", "PATCH",
                                     {"excluded": {"value": True, "reason": "Test account"}}, key=TEACHER_KEY)
        self.assertEqual((status, entry["excluded"], entry["exclusionReason"]), (200, True, "Test account"))
        with self.db() as db:
            self.assertEqual(identity.enrolled_count(db, C), 1)
        status, body = self.request(f"/api/teacher/roster/s3?classId={C}", "PATCH",
                                    {"consentOverride": {"value": "yes", "note": ""}}, key=TEACHER_KEY)
        self.assertEqual((status, body["code"]), (400, "invalid_request"))
        _, entry = self.request(f"/api/teacher/roster?classId={C}&consent=no", key=TEACHER_KEY)
        self.assertEqual([(s["studentId"], s["consentSource"]) for s in entry["students"]], [("s3", "kiwi")])
        status, entry = self.request(f"/api/teacher/roster/s3?classId={C}", "PATCH",
                                     {"consentOverride": {"value": "yes", "note": "Paper consent form 10/20"}}, key=TEACHER_KEY)
        self.assertEqual((status, entry["consent"], entry["consentSource"]), (200, "yes", "teacher"))
        status, entry = self.request(f"/api/teacher/roster/s3?classId={C}", "PATCH", {"displayName": "Cy Ho"}, key=TEACHER_KEY)
        self.assertEqual(entry["studentName"], "Cy Ho")
        with self.db() as db:
            row = db.execute("SELECT consent_note, consent_updated_by FROM roster WHERE student_id='s3'").fetchone()
            self.assertEqual(tuple(row), ("Paper consent form 10/20", "Instructor (local key)"))
            audit = db.execute("SELECT before_json, after_json FROM teacher_actions WHERE action='roster_consent_override'").fetchone()
            self.assertIn('"no"', audit["before_json"])
            self.assertIn('"yes"', audit["after_json"])
        self.assertEqual(self.request(f"/api/teacher/roster/nobody?classId={C}", "PATCH", {"status": "dropped"},
                                      key=TEACHER_KEY)[0], 404)
        self.assertEqual(self.request(f"/api/teacher/roster/s1?classId={C}", "PATCH", {"bogus": 1}, key=TEACHER_KEY)[0], 400)

    def test_show_emails_false_hides_emails_and_labels(self):  # PEOPLE-12
        with self.db() as db:
            testsupport.update_settings(db, C, {"privacy": {"showEmails": False}})
        _, body = self.request(f"/api/teacher/roster?classId={C}", key=TEACHER_KEY)
        cy = next(s for s in body["students"] if s["studentId"] == "s3")
        self.assertIsNone(cy["email"])
        self.assertEqual(cy["studentName"], "Student s3")
        self.assertNotIn("@", json.dumps(body))


class ProfileTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create_course(C)
        with self.db() as db:
            testsupport.add_roster(db, C, "s1", display_name="Ada Chen")
            self.hw1 = testsupport.publish_work(db, C, title="Week 1 HW", due_at="2026-01-05T00:00:00+00:00")
            self.hw2 = testsupport.publish_work(db, C, title="Week 2 HW", due_at="2026-01-12T00:00:00+00:00")
            self.sub = testsupport.make_autochecked_submission(db, C, "s1", self.hw2.id, {"q1": "4", "q2": "text"},
                                                               grade_status="released", grade=16)
            db.execute("UPDATE submissions SET grade=16, is_late=1, late_seconds=3600 WHERE id=?", (self.sub,))
            _client_event(db, C, "s1", "code_run", {"code": "mean(x", "ok": False, "error": "unexpected end of input",
                                                     "assignmentId": self.hw1.id}, question_id="q1")
            testsupport.make_chat_turn(db, C, "s1", "Why does merge drop rows?", "Think about keys.", unit_id="r-basics")
            testsupport.make_free_item_attempt(db, C, "s1", "r-basics", correct=True)
            self.staff_keys = {}
        for role in ("ta", "viewer"):
            status, created = self.request(f"/api/teacher/staff?classId={C}", "POST",
                                           {"displayName": f"{role.upper()} One", "role": role}, key=TEACHER_KEY)
            self.assertEqual(status, 200, created)
            self.staff_keys[role] = created["key"]

    def test_profile_content_and_links(self):  # PEOPLE-01, PEOPLE-22, F08
        status, profile = self.request(f"/api/teacher/students/s1/profile?classId={C}", key=TEACHER_KEY)
        self.assertEqual(status, 200, profile)
        self.assertEqual(profile["student"]["studentName"], "Ada Chen")
        self.assertEqual(profile["header"]["missing"], 1)
        self.assertEqual(profile["header"]["late"], 1)
        self.assertEqual(profile["header"]["avgScorePct"], 80)
        self.assertIsNotNone(profile["header"]["lastActive"])
        self.assertEqual(profile["fullTimelineUrl"], "/teacher/students/s/s1/timeline")
        self.assertTrue(profile["canExportConversations"])
        titles = {a["title"]: a for a in profile["assignments"]}
        self.assertEqual(titles["Week 1 HW"]["cell"]["state"], "missing")
        self.assertIsNone(titles["Week 1 HW"]["gradingUrl"])
        self.assertIn(self.sub, titles["Week 2 HW"]["gradingUrl"])
        self.assertEqual(titles["Week 2 HW"]["timelineUrl"], f"/teacher/students/s/s1/assignments/{self.hw2.id}")
        self.assertEqual([e["error"] for e in profile["recentErrors"]], ["unexpected end of input"])
        self.assertEqual(profile["recentErrors"][0]["questionLabel"], "Week 1 HW · Q1")   # RV6-m04: never the raw id
        self.assertEqual(profile["recentAiQuestions"][0]["prompt"], "Why does merge drop rows?")
        self.assertEqual(profile["recentAiQuestions"][0]["where"], "lab")
        self.assertEqual(profile["recentAiQuestions"][0]["threadKey"], "lab:s1:t1")
        chapter = next(p for p in profile["practiceByChapter"] if p["unitId"] == "r-basics")
        self.assertEqual((chapter["freeItems"], chapter["serverAccuracy"]), (1, 100))
        with self.db() as db:
            access = db.execute("SELECT category, actor_label FROM data_access_log WHERE category='profile'").fetchone()
            self.assertEqual(tuple(access), ("profile", "Instructor (local key)"))
        self.assertEqual(self.request(f"/api/teacher/students/nobody/profile?classId={C}", key=TEACHER_KEY)[0], 404)

    def test_profile_links_per_role(self):  # PEOPLE-22, PEOPLE-03
        _, ta = self.request(f"/api/teacher/students/s1/profile?classId={C}", key=self.staff_keys["ta"])
        self.assertTrue(ta["canExportConversations"])
        self.assertTrue(any(a["gradingUrl"] for a in ta["assignments"]))
        _, viewer = self.request(f"/api/teacher/students/s1/profile?classId={C}", key=self.staff_keys["viewer"])
        self.assertFalse(viewer["canExportConversations"])
        self.assertTrue(all(a["gradingUrl"] is None for a in viewer["assignments"]))
        with self.db() as db:
            labels = {r[0] for r in db.execute("SELECT actor_label FROM data_access_log WHERE category='profile'")}
        self.assertEqual(labels, {"TA One", "VIEWER One"})


class GroupTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create_course(C)
        with self.db() as db:
            for i in range(1, 7):
                testsupport.add_roster(db, C, f"s{i}", display_name=f"Student {i}")

    def _post(self, path: str, body: dict, method: str = "POST", key: str = TEACHER_KEY):
        return self.request(f"{path}?classId={C}", method, body, key=key)

    def test_group_crud_members_and_cohorts(self):  # PEOPLE-02, F14
        status, sec = self._post("/api/teacher/groups", {"name": "Section 1", "kind": "section", "description": "Tue"})
        self.assertEqual((status, sec["kind"], sec["members"]), (200, "section", 0))
        status, body = self._post("/api/teacher/groups", {"name": "Section 1", "kind": "section", "description": ""})
        self.assertEqual(status, 400)
        status, sec2 = self._post("/api/teacher/groups", {"name": "Section 2", "kind": "section", "description": ""})
        status, updated = self._post(f"/api/teacher/groups/{sec['id']}/members", {"studentIds": ["s1", "s2"]}, "PUT")
        self.assertEqual((status, updated["members"]), (200, 2))
        status, moved = self._post(f"/api/teacher/groups/{sec2['id']}/members", {"studentIds": ["s2"]}, "PUT")
        self.assertEqual(moved["members"], 1)
        _, groups = self.request(f"/api/teacher/groups?classId={C}", key=TEACHER_KEY)
        self.assertEqual({g["name"]: g["members"] for g in groups}, {"Section 1": 1, "Section 2": 1})
        status, renamed = self._post(f"/api/teacher/groups/{sec['id']}", {"name": "Section 1 (Tue)"}, "PATCH")
        self.assertEqual(renamed["name"], "Section 1 (Tue)")
        status, cohort = self._post("/api/teacher/groups", {"name": "Needs attention · 10/22", "kind": "cohort",
                                                             "description": "", "studentIds": ["s1", "s2", "s3"]})
        self.assertEqual((status, cohort["members"]), (200, 3))
        status, cohort2 = self._post("/api/teacher/groups", {"name": "Extra practice", "kind": "cohort", "description": "",
                                                              "studentIds": ["s1"]})
        with self.db() as db:
            methods = {r[0] for r in db.execute("SELECT method FROM group_members WHERE group_id=?", (cohort["id"],))}
            self.assertEqual(methods, {"selection"})
            self.assertEqual(db.execute("SELECT COUNT(*) FROM group_members WHERE student_id='s1' AND kind='cohort'").fetchone()[0], 2)
        status, _ = self._post(f"/api/teacher/groups/{cohort2['id']}", {}, "DELETE")
        self.assertEqual(status, 204)
        _, groups = self.request(f"/api/teacher/groups?classId={C}", key=TEACHER_KEY)
        self.assertNotIn(cohort2["id"], [g["id"] for g in groups])
        _, all_groups = self.request(f"/api/teacher/groups?classId={C}&includeArchived=1", key=TEACHER_KEY)
        self.assertTrue(next(g for g in all_groups if g["id"] == cohort2["id"])["archived"])
        status, _ = self._post("/api/teacher/groups", {"name": "x", "kind": "cohort", "description": "", "studentIds": ["ghost"]})
        self.assertEqual(status, 400)
        with self.db() as db:
            self.assertGreaterEqual(db.execute("SELECT COUNT(*) FROM teacher_actions WHERE target_type='group'").fetchone()[0], 5)

    def test_randomize_is_reproducible_balanced_and_audited(self):  # PEOPLE-02, §14.3
        _, a = self._post("/api/teacher/groups", {"name": "A", "kind": "condition", "description": ""})
        _, b = self._post("/api/teacher/groups", {"name": "B", "kind": "condition", "description": ""})
        body = {"groupIds": [a["id"], b["id"]], "seed": "css190-f26", "overwrite": True}
        status, first = self._post("/api/teacher/groups/randomize", body)
        self.assertEqual(status, 200, first)
        self.assertEqual((first["seed"], first["algorithm"]), ("css190-f26", "sha256-sort-v1"))
        status, second = self._post("/api/teacher/groups/randomize", body)
        self.assertEqual(first["assignments"], second["assignments"])
        sizes = {}
        for item in first["assignments"]:
            sizes[item["groupId"]] = sizes.get(item["groupId"], 0) + 1
        self.assertEqual(sorted(sizes.values()), [3, 3])
        import hashlib
        order = sorted([f"s{i}" for i in range(1, 7)], key=lambda s: hashlib.sha256(f"css190-f26:{s}".encode()).hexdigest())
        self.assertEqual([x["studentId"] for x in first["assignments"]], order)
        self.assertEqual([x["groupId"] for x in first["assignments"]][:2], [a["id"], b["id"]])
        status, none_left = self._post("/api/teacher/groups/randomize", {**body, "overwrite": False})
        self.assertEqual(none_left["assignments"], [])
        with self.db() as db:
            audit = db.execute("SELECT after_json FROM teacher_actions WHERE action='groups_randomize'").fetchone()
            self.assertIn("css190-f26", audit["after_json"])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM group_members WHERE method='random' AND seed='css190-f26'").fetchone()[0], 6)
        _, cohort = self._post("/api/teacher/groups", {"name": "C", "kind": "cohort", "description": ""})
        status, _ = self._post("/api/teacher/groups/randomize", {"groupIds": [a["id"], cohort["id"]], "seed": "x", "overwrite": True})
        self.assertEqual(status, 400)
        status, _ = self._post("/api/teacher/groups/randomize", {"groupIds": [a["id"]], "seed": "x", "overwrite": True})
        self.assertEqual(status, 400)

    def test_rerandomize_keeps_history_and_condition_at_event_time(self):  # PEOPLE-16, AU-D1-10
        _, a = self._post("/api/teacher/groups", {"name": "A", "kind": "condition", "description": ""})
        _, b = self._post("/api/teacher/groups", {"name": "B", "kind": "condition", "description": ""})
        with freeze_time("2026-10-01T00:00:00+00:00"):
            _, first = self._post("/api/teacher/groups/randomize", {"groupIds": [a["id"], b["id"]], "seed": "s1", "overwrite": True})
            with self.db() as db:
                before = int(_client_event(db, C, "s1", "code_run", {"code": "1", "ok": True}).id)
        with freeze_time("2026-10-08T00:00:00+00:00"):
            _, second = self._post("/api/teacher/groups/randomize", {"groupIds": [a["id"], b["id"]], "seed": "s2", "overwrite": True})
            with self.db() as db:
                after = int(_client_event(db, C, "s1", "code_run", {"code": "2", "ok": True}).id)
        g1 = next(x["groupId"] for x in first["assignments"] if x["studentId"] == "s1")
        g2 = next(x["groupId"] for x in second["assignments"] if x["studentId"] == "s1")
        with self.db() as db:
            stamps = dict(db.execute("SELECT id, condition_group_id FROM events WHERE id IN (?, ?)", (before, after)).fetchall())
            self.assertEqual((stamps[before], stamps[after]), (g1, g2))
            history = _rows(db, "SELECT group_id, valid_from, valid_to, seed FROM group_membership_history WHERE student_id='s1' "
                                "AND kind='condition' ORDER BY id")
        if g1 != g2:
            self.assertEqual(len(history), 2)
            self.assertIsNotNone(history[0]["valid_to"])
            self.assertIsNone(history[1]["valid_to"])
        status, changes = self.request(f"/api/teacher/groups/history?classId={C}&studentId=s1&kind=condition", key=TEACHER_KEY)
        self.assertEqual(status, 200)
        self.assertEqual(changes[-1]["groupId"], g2)
        self.assertIn(changes[-1]["seed"], ("s2", "s1"))
        self.assertIn("groupName", changes[0])

    def test_ta_reads_groups_but_cannot_change_them(self):  # §6.8 permissions
        _, created = self._post("/api/teacher/staff", {"displayName": "TA", "role": "ta"})
        self.assertEqual(self.request(f"/api/teacher/groups?classId={C}", key=created["key"])[0], 200)
        status, body = self._post("/api/teacher/groups", {"name": "S", "kind": "section", "description": ""}, key=created["key"])
        self.assertEqual((status, body["code"]), (403, "role_required"))


class StaffTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create_course(C)

    def test_standalone_staff_keys_permissions_and_actor_labels(self):  # PEOPLE-03, F15
        status, created = self.request(f"/api/teacher/staff?classId={C}", "POST", {"displayName": "Wang TA", "role": "ta"},
                                       key=TEACHER_KEY)
        self.assertEqual(status, 200, created)
        key = created["key"]
        self.assertRegex(key, r"^[0-9a-f]{24}$")
        self.assertEqual(created["staff"]["keyPrefix"], key[:8])
        _, listing = self.request(f"/api/teacher/staff?classId={C}", key=TEACHER_KEY)
        self.assertNotIn(key, json.dumps(listing))
        self.assertEqual([s["displayName"] for s in listing["staff"]], ["Wang TA"])
        _, me = self.request(f"/api/me?classId={C}", key=key)
        self.assertEqual((me["role"], me["displayName"]), ("ta", "Wang TA"))
        self.assertIn("grade", me["permissions"])
        self.assertIn("viewAiRules", me["permissions"])
        for perm in ("manageAiRules", "manageCourse", "manageStaff"):
            self.assertNotIn(perm, me["permissions"])
        status, body = self.request(f"/api/teacher/settings?classId={C}", "PUT", {"privacy": {"showEmails": False}}, key=key)
        self.assertEqual((status, body["code"]), (403, "role_required"))
        self.assertEqual(self.request(f"/api/teacher/staff?classId={C}", key=key)[0], 403)
        self.assertEqual(self.request(f"/api/teacher/roster?classId={C}", key=key)[0], 200)
        with self.db() as db:
            self.assertEqual(db.execute("SELECT actor_label FROM data_access_log ORDER BY id DESC").fetchone()[0], "Wang TA")
        staff_id = created["staff"]["id"]
        status, updated = self.request(f"/api/teacher/staff/{staff_id}?classId={C}", "PATCH", {"role": "viewer"}, key=TEACHER_KEY)
        self.assertEqual((status, updated["role"]), (200, "viewer"))
        _, me = self.request(f"/api/me?classId={C}", key=key)
        self.assertEqual(me["role"], "viewer")
        self.assertEqual(self.request(f"/api/teacher/staff/{staff_id}?classId={C}", "DELETE", key=TEACHER_KEY)[0], 204)
        _, me = self.request(f"/api/me?classId={C}", key=key)
        self.assertEqual(me["kind"], "anonymous")
        _, listing = self.request(f"/api/teacher/staff?classId={C}", key=TEACHER_KEY)
        self.assertIsNotNone(listing["staff"][0]["revokedAt"])
        status, _ = self.request(f"/api/teacher/staff?classId={C}", "POST", {"displayName": "", "role": "ta"}, key=TEACHER_KEY)
        self.assertEqual(status, 400)
        status, _ = self.request(f"/api/teacher/staff?classId={C}", "POST", {"displayName": "X", "role": "owner"}, key=TEACHER_KEY)
        self.assertEqual(status, 400)
        with self.db() as db:
            actions = [r[0] for r in db.execute("SELECT action FROM teacher_actions WHERE target_type='staff' ORDER BY id")]
        self.assertEqual(actions, ["staff_create", "staff_update", "staff_revoke"])

    def test_kiwi_role_mapping_staff_list_and_overrides(self):  # PEOPLE-18, F15, AU-D1-23
        live = "live-course"

        def me_for(user_id: str, role: str = "staff", manage: bool = False, view: bool = False, user_role: str = "professor"):
            with fake_kiwi_identity(role, manage, view, user_role, class_id=live, user_id=user_id,
                                    username=f"{user_id}@example.edu") as token:
                return self.request(f"/api/me?classId={live}", token=token)[1]

        self.assertEqual(me_for("t1", manage=True, view=True)["role"], "instructor")
        assistant = me_for("t2", manage=True, view=True, user_role="ta")
        self.assertEqual(assistant["role"], "ta")
        self.assertNotIn("manageAiRules", assistant["permissions"])
        self.assertEqual(me_for("t3", view=True)["role"], "viewer")
        nobody = me_for("t4")
        self.assertEqual((nobody["role"], nobody["isStaff"]), (None, True))
        with fake_kiwi_identity("staff", False, False, "professor", class_id=live, user_id="t4") as token:
            status, body = self.request("/api/events", "POST", {"classId": live, "studentId": "t4", "studentName": "x",
                                                               "sessionId": "s", "type": "code_run", "payload": {}}, token=token)
        self.assertEqual((status, body["code"]), (403, "preview_required"))
        me_for("t5", manage=True, view=True)
        with fake_kiwi_identity("staff", True, True, "professor", class_id=live, user_id="t1",
                                username="t1@example.edu") as token:
            status, listing = self.request(f"/api/teacher/staff?classId={live}", token=token)
            self.assertEqual(status, 200, listing)
            seen = {s["kiwiUserId"]: s for s in listing["kiwiStaff"]}
            self.assertEqual({k: (v["effectiveRole"], v["roleSource"]) for k, v in seen.items()},
                             {"t1": ("instructor", "kiwi"), "t2": ("ta", "kiwi"), "t3": ("viewer", "kiwi"),
                              "t4": (None, "kiwi"), "t5": ("instructor", "kiwi")})
            self.assertEqual(seen["t2"]["kiwiRole"], "ta")
            status, created = self.request(f"/api/teacher/staff?classId={live}", "POST",
                                           {"displayName": "t5@example.edu", "role": "viewer", "kiwiUserId": "t5"}, token=token)
            self.assertEqual(status, 200, created)
            self.assertNotIn("key", created)
            status, body = self.request(f"/api/teacher/staff?classId={live}", "POST",
                                        {"displayName": "me", "role": "viewer", "kiwiUserId": "t1"}, token=token)
            self.assertEqual(status, 400)
            status, body = self.request(f"/api/teacher/staff?classId={live}", "POST",
                                        {"displayName": "student", "role": "instructor", "kiwiUserId": "s1"}, token=token)
            self.assertEqual(status, 400)
            _, listing = self.request(f"/api/teacher/staff?classId={live}", token=token)
            t5 = next(s for s in listing["kiwiStaff"] if s["kiwiUserId"] == "t5")
            self.assertEqual((t5["effectiveRole"], t5["roleSource"], t5["overrideStaffId"]), ("viewer", "override", created["staff"]["id"]))
        demoted = me_for("t5", manage=True, view=True)
        self.assertEqual((demoted["role"], demoted["roleSource"]), ("viewer", "override"))
        with self.db() as db:
            db.execute("""INSERT INTO staff (id, class_id, display_name, role, kiwi_user_id, created_by, created_at)
                       VALUES ('staff-student', ?, 'Student', 'instructor', 's1', 'test', ?)""", (live, dbmod.now()))
        student = me_for("s1", role="student", user_role="student")
        self.assertEqual(student["role"], "student")
        with fake_kiwi_identity("staff", True, True, "professor", class_id=live, user_id="t1") as token:
            status, _ = self.request(f"/api/teacher/staff/{created['staff']['id']}?classId={live}", "DELETE", token=token)
            self.assertEqual(status, 204)
        self.assertEqual(me_for("t5", manage=True, view=True)["role"], "instructor")


    def test_kiwi_assistant_is_a_ta_and_an_override_makes_a_co_teacher(self):  # decision D1
        live = "live-course"

        def me_for(user_id: str, manage: bool, view: bool, user_role: str) -> dict:
            with fake_kiwi_identity("staff", manage, view, user_role, class_id=live, user_id=user_id,
                                    username=f"{user_id}@example.edu") as token:
                return self.request(f"/api/me?classId={live}", token=token)[1]

        for manage, view in ((True, True), (True, False), (False, True)):
            assistant = me_for("a1", manage, view, "ta")
            self.assertEqual((assistant["role"], assistant["roleSource"]), ("ta", "kiwi"))
            self.assertIn("grade", assistant["permissions"])
            self.assertIn("viewInsights", assistant["permissions"])
            for perm in ("editAssignments", "manageAiRules", "manageCourse"):
                self.assertNotIn(perm, assistant["permissions"])
        with fake_kiwi_identity("staff", True, True, "professor", class_id=live, user_id="t1", username="t1@example.edu") as token:
            self.request(f"/api/me?classId={live}", token=token)
            status, created = self.request(f"/api/teacher/staff?classId={live}", "POST",
                                           {"displayName": "a1@example.edu", "role": "instructor", "kiwiUserId": "a1"}, token=token)
            self.assertEqual(status, 200, created)
        promoted = me_for("a1", True, True, "ta")
        self.assertEqual((promoted["role"], promoted["roleSource"]), ("instructor", "override"))
        self.assertIn("manageAiRules", promoted["permissions"])
        with fake_kiwi_identity("staff", True, True, "ta", class_id=live, user_id="a1", username="a1@example.edu") as token:
            status, body = self.request(f"/api/teacher/staff/{created['staff']['id']}?classId={live}", "PATCH", {"role": "ta"},
                                        token=token)
        self.assertEqual((status, body["error"]), (400, "You cannot change your own Lab role"))

    def test_researcher_role_by_staff_key_and_by_kiwi_override(self):  # decision D3
        status, created = self.request(f"/api/teacher/staff?classId={C}", "POST", {"displayName": "Shen Researcher",
                                                                                 "role": "researcher"}, key=TEACHER_KEY)
        self.assertEqual((status, created["staff"]["role"]), (200, "researcher"), created)
        key = created["key"]
        _, me = self.request(f"/api/me?classId={C}", key=key)
        self.assertEqual((me["role"], me["displayName"], me["pseudonymsForced"]), ("researcher", "Shen Researcher", True))
        for perm in ("viewStudents", "grade", "previewStudent", "manageStudents", "editAssignments", "manageAiRules"):
            self.assertNotIn(perm, me["permissions"])
        with self.db() as db:
            testsupport.add_roster(db, C, "s1", display_name="Ada Chen", kiwi_email="ada@example.edu")
            testsupport.add_roster(db, C, "s9", display_name="No Consent")
            group = testsupport.make_group(db, C, "condition", "Treatment", ["s1", "s9"])
            with dbmod.write_tx(db):  # researchers analyze consenting students only (D3, review 2 SECURITY-02)
                db.execute("UPDATE roster SET consent_override='yes' WHERE class_id=? AND student_id='s1'", (C,))
        status, groups = self.request(f"/api/teacher/groups?classId={C}", key=key)
        self.assertEqual((status, [g["name"] for g in groups]), (200, ["Treatment"]))
        status, history = self.request(f"/api/teacher/groups/history?classId={C}", key=key)
        self.assertEqual(status, 200, history)
        self.assertEqual([(h["groupId"], h["studentName"]) for h in history], [(group, "S-001")])
        self.assertNotIn("Ada", json.dumps(history))
        self.assertNotIn('"s1"', json.dumps(history))   # research ids, never student ids (SECURITY-05)
        _, named = self.request(f"/api/teacher/groups/history?classId={C}", key=TEACHER_KEY)
        self.assertEqual([h["studentName"] for h in named], ["Ada Chen", "No Consent"])
        status, body = self.request(f"/api/teacher/groups/{group}/members?classId={C}", "PUT", {"studentIds": []}, key=key)
        self.assertEqual((status, body["code"]), (403, "role_required"))
        self.assertEqual(self.request(f"/api/teacher/students/s1/profile?classId={C}", key=key)[0], 403)
        # instructors move people between viewer and researcher; the role list names all four roles
        staff_id = created["staff"]["id"]
        status, updated = self.request(f"/api/teacher/staff/{staff_id}?classId={C}", "PATCH", {"role": "viewer"}, key=TEACHER_KEY)
        self.assertEqual((status, updated["role"]), (200, "viewer"))
        self.assertIn("viewStudents", self.request(f"/api/me?classId={C}", key=key)[1]["permissions"])
        status, updated = self.request(f"/api/teacher/staff/{staff_id}?classId={C}", "PATCH", {"role": "researcher"},
                                       key=TEACHER_KEY)
        self.assertEqual((status, updated["role"]), (200, "researcher"))
        status, body = self.request(f"/api/teacher/staff?classId={C}", "POST", {"displayName": "X", "role": "owner"}, key=TEACHER_KEY)
        self.assertEqual((status, body["error"]), (400, "role must be instructor, ta, viewer or researcher"))
        live = "live-course"
        with fake_kiwi_identity("staff", True, True, "professor", class_id=live, user_id="r1", username="r1@example.edu") as token:
            self.request(f"/api/me?classId={live}", token=token)
        with fake_kiwi_identity("staff", True, True, "professor", class_id=live, user_id="t1", username="t1@example.edu") as token:
            self.request(f"/api/me?classId={live}", token=token)
            status, override = self.request(f"/api/teacher/staff?classId={live}", "POST",
                                            {"displayName": "r1@example.edu", "role": "researcher", "kiwiUserId": "r1"},
                                            token=token)
            self.assertEqual((status, override["staff"]["role"]), (200, "researcher"), override)
            _, listing = self.request(f"/api/teacher/staff?classId={live}", token=token)
        r1 = next(s for s in listing["kiwiStaff"] if s["kiwiUserId"] == "r1")
        self.assertEqual((r1["effectiveRole"], r1["roleSource"]), ("researcher", "override"))
        with fake_kiwi_identity("staff", True, True, "professor", class_id=live, user_id="r1", username="r1@example.edu") as token:
            me = self.request(f"/api/me?classId={live}", token=token)[1]
        self.assertEqual((me["role"], me["roleSource"]), ("researcher", "override"))


class SettingsTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create_course(C)

    def test_settings_get_put_validation_and_audit(self):  # §6.8, §4.5.4
        status, settings = self.request(f"/api/teacher/settings?classId={C}", key=TEACHER_KEY)
        self.assertEqual(status, 200)
        self.assertEqual(settings["privacy"]["defaultNameMode"], "names")
        body = {"privacy": {"researchPurpose": "Course reflection", "viewerCanExportResearch": True},
                "schedule": {"timezone": "Asia/Shanghai", "meetings": [{"weekday": 2, "time": "10:00", "durationMinutes": 90}]},
                "grading": {"taCanRelease": True}, "ai": {"perStudentPerMinute": 10}}
        status, saved = self.request(f"/api/teacher/settings?classId={C}", "PUT", body, key=TEACHER_KEY)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["privacy"]["researchPurpose"], "Course reflection")
        self.assertTrue(saved["privacy"]["showEmails"])
        self.assertEqual(saved["schedule"]["meetings"][0]["durationMinutes"], 90)
        self.assertEqual(saved["ai"]["classPerMinute"], 120)
        for bad in ({"schedule": {"timezone": "Mars/Base"}}, {"privacy": {"defaultNameMode": "secret"}},
                    {"privacy": {"retentionDays": 0}}, {"grading": {"defaultGradesVisibility": "never"}},
                    {"ai": {"perStudentPerMinute": "many"}}, {"bogus": {}}, {"privacy": {"unknown": True}},
                    {"attentionRules": {"rules": []}}):
            status, error = self.request(f"/api/teacher/settings?classId={C}", "PUT", bad, key=TEACHER_KEY)
            self.assertEqual((status, error["code"]), (400, "invalid_request"), bad)
        with self.db() as db:
            audit = db.execute("SELECT before_json, after_json FROM teacher_actions WHERE action='settings_update'").fetchone()
            self.assertIn("Course reflection", audit["after_json"])
        _, me = self.request(f"/api/me?classId={C}", key=TEACHER_KEY)
        self.assertEqual(me["role"], "instructor")


class AuditTests(ApiTestCase):
    def test_audit_lists_changes_and_data_access(self):  # PEOPLE-09
        self.create_course(C)
        with self.db() as db:
            testsupport.add_roster(db, C, "s1", display_name="Ada Chen")
        self.request(f"/api/teacher/roster/s1?classId={C}", "PATCH", {"status": "dropped"}, key=TEACHER_KEY)
        self.request(f"/api/teacher/students/s1/profile?classId={C}", key=TEACHER_KEY)
        status, changes = self.request(f"/api/teacher/audit?classId={C}&kind=actions", key=TEACHER_KEY)
        self.assertEqual(status, 200, changes)
        entry = next(e for e in changes["entries"] if e["action"] == "roster_update")
        self.assertEqual((entry["kind"], entry["actorLabel"], entry["targetType"]), ("action", "Instructor (local key)", "roster"))
        self.assertIn("status", entry["summary"])
        self.assertIn("dropped", entry["summary"])
        status, access = self.request(f"/api/teacher/audit?classId={C}&kind=access", key=TEACHER_KEY)
        self.assertTrue(any(e["action"] == "profile" for e in access["entries"]))
        _, ta = self.request(f"/api/teacher/staff?classId={C}", "POST", {"displayName": "TA", "role": "ta"}, key=TEACHER_KEY)
        self.assertEqual(self.request(f"/api/teacher/audit?classId={C}", key=ta["key"])[0], 403)
        status, error = self.request(f"/api/teacher/audit?classId={C}&kind=nope", key=TEACHER_KEY)
        self.assertEqual(status, 400)


class DeletionTests(ApiTestCase):
    def _seed(self, db, class_id: str, sid: str) -> dict:
        work = testsupport.publish_work(db, class_id, due_at="2026-01-01T00:00:00+00:00")
        group = testsupport.make_group(db, class_id, "condition", f"A-{sid}", [sid])
        sub = testsupport.make_autochecked_submission(db, class_id, sid, work.id, {"q1": "4", "q2": "words"})
        testsupport.make_draft(db, class_id, sid, work.id, {"q1": "3"})
        turn = testsupport.make_chat_turn(db, class_id, sid, "help me", "hint")
        item = testsupport.make_free_item_attempt(db, class_id, sid, "r-basics")
        db.execute("""INSERT INTO conversation_codes (class_id, thread_key, chat_turn_id, code_id, coder_id, created_at)
                   VALUES (?, ?, ?, 'code-1', 'instructor', ?)""", (class_id, f"lab:{sid}:t1", turn, dbmod.now()))
        return {"work": work.id, "group": group, "sub": sub, "turn": turn, "item": item}

    STUDENT_TABLES = (("events", "student_id"), ("learning_sessions", "studentId"), ("chat_turns", "student_id"),
                      ("ai_calls", "student_id"), ("generated_items", "student_id"), ("submissions", "student_id"),
                      ("answer_drafts", "student_id"), ("group_members", "student_id"),
                      ("group_membership_history", "student_id"), ("roster", "student_id"))

    def _count(self, db, sid: str) -> dict:
        return {t: db.execute(f"SELECT COUNT(*) FROM {t} WHERE {c}=?", (sid,)).fetchone()[0] for t, c in self.STUDENT_TABLES}

    def test_anonymize_standalone_student(self):  # PEOPLE-08
        self.create_course(C)
        with self.db() as db:
            testsupport.add_roster(db, C, "s1", display_name="Ada Chen", kiwi_email="ada@example.edu")
            self._seed(db, C, "s1")
            before = self._count(db, "s1")
            anon = "anon-" + identity.student_hash(db, C, "s1")[:12]
        status, body = self.request(f"/api/teacher/students/s1/delete-data?classId={C}", "POST",
                                    {"mode": "anonymize", "confirm": "wrong"}, key=TEACHER_KEY)
        self.assertEqual(status, 400)
        status, result = self.request(f"/api/teacher/students/s1/delete-data?classId={C}", "POST",
                                      {"mode": "anonymize", "confirm": "s1"}, key=TEACHER_KEY)
        self.assertEqual(status, 200, result)
        with self.db() as db:
            self.assertTrue(all(v == 0 for v in self._count(db, "s1").values()))
            after = self._count(db, anon)
            for table, count in before.items():
                self.assertEqual(after[table], count, table)
                self.assertEqual(result["counts"].get(table), count, table)
            roster = db.execute("SELECT * FROM roster WHERE student_id=?", (anon,)).fetchone()
            self.assertEqual((roster["display_name"], roster["kiwi_email"], roster["excluded"]), ("Anonymized student", "", 1))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE student_name LIKE '%Ada%'").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT thread_key FROM conversation_codes").fetchone()[0], f"lab:{anon}:t1")
            self.assertEqual(db.execute("SELECT prompt FROM chat_turns").fetchone()[0], "help me")
            tomb = db.execute("SELECT mode, anon_id FROM student_tombstones").fetchone()
            self.assertEqual(tuple(tomb), ("anonymize", anon))
            action = db.execute("SELECT * FROM teacher_actions WHERE action='student_anonymize'").fetchone()
            self.assertTrue(action["target_id"].startswith("hash:"))
            self.assertNotIn("s1", action["after_json"] + action["before_json"])
            self.assertNotIn("Ada", action["after_json"] + action["before_json"])
            self.assertEqual(identity.tombstone(db, C, "s1")[0], "anonymize")
        self.assertEqual(self.request(f"/api/teacher/students/s1/delete-data?classId={C}", "POST",
                                      {"mode": "anonymize", "confirm": "s1"}, key=TEACHER_KEY)[0], 404)

    def test_anonymize_linked_rewrites_history_and_delete_mode(self):  # PEOPLE-20, AU-D4-13
        live = "live-course"
        with self.db() as db:
            db.execute("INSERT INTO kiwi_links (class_id, name) VALUES (?, ?)", (live, live))
            for sid in ("k1", "k2"):
                testsupport.add_roster(db, live, sid, source="kiwi", kiwi_email=f"{sid}@example.edu")
                self._seed(db, live, sid)
            anon = "anon-" + identity.student_hash(db, live, "k1")[:12]
        with fake_kiwi_identity("staff", True, True, class_id=live, user_id="t1") as token:
            status, result = self.request(f"/api/teacher/students/k1/delete-data?classId={live}", "POST",
                                          {"mode": "anonymize", "confirm": "k1"}, token=token)
            self.assertEqual(status, 200, result)
            status, deleted = self.request(f"/api/teacher/students/k2/delete-data?classId={live}", "POST",
                                           {"mode": "delete", "confirm": "k2"}, token=token)
            self.assertEqual(status, 200, deleted)
        with self.db() as db:
            self.assertGreater(db.execute("SELECT COUNT(*) FROM group_membership_history WHERE student_id=?", (anon,)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM conversation_codes WHERE thread_key LIKE 'lab:k1:%'").fetchone()[0], 0)
            self.assertTrue(all(v == 0 for v in self._count(db, "k2").values()))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM submission_item_scores s WHERE NOT EXISTS (SELECT 1 FROM submissions u "
                                        "WHERE u.id=s.submission_id)").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM conversation_codes WHERE thread_key LIKE 'lab:k2:%'").fetchone()[0], 0)
            self.assertEqual(identity.tombstone(db, live, "k2")[0], "delete")
            targets = [r[0] for r in db.execute("SELECT target_id FROM teacher_actions WHERE action IN "
                                                "('student_anonymize','student_delete')")]
            self.assertTrue(all(t.startswith("hash:") for t in targets))
        self.assertGreater(deleted["counts"]["submissions"], 0)

    def test_retention_report_and_confirmed_run(self):  # PEOPLE-08, §14.5
        self.create_course(C)
        with self.db() as db:
            testsupport.add_roster(db, C, "s1", display_name="Ada Chen")
        with freeze_time("2026-06-01T00:00:00+00:00"):
            with self.db() as db:
                testsupport.make_chat_turn(db, C, "s1", "old question", "old answer")
        with self.db() as db:
            testsupport.make_chat_turn(db, C, "s1", "new question", "new answer")
        _, report = self.request(f"/api/teacher/retention?classId={C}", key=TEACHER_KEY)
        self.assertIsNone(report["retentionDays"])
        self.assertEqual(self.request(f"/api/teacher/retention/run?classId={C}", "POST", {"confirm": "RUN RETENTION"},
                                      key=TEACHER_KEY)[0], 400)
        with self.db() as db:
            testsupport.update_settings(db, C, {"privacy": {"retentionDays": 30}})
        _, report = self.request(f"/api/teacher/retention?classId={C}", key=TEACHER_KEY)
        self.assertEqual((report["retentionDays"], report["due"]["chat_turns"], report["due"]["events"]), (30, 1, 1))
        self.assertEqual(self.request(f"/api/teacher/retention/run?classId={C}", "POST", {"confirm": "yes"}, key=TEACHER_KEY)[0], 400)
        status, ran = self.request(f"/api/teacher/retention/run?classId={C}", "POST", {"confirm": "RUN RETENTION"}, key=TEACHER_KEY)
        self.assertEqual((status, ran["counts"]["chat_turns"]), (200, 1))
        with self.db() as db:
            rows = dict(db.execute("SELECT prompt, student_id FROM chat_turns").fetchall())
            self.assertTrue(rows["old question"].startswith("anon-"))
            self.assertEqual(rows["new question"], "s1")
        _, report = self.request(f"/api/teacher/retention?classId={C}", key=TEACHER_KEY)
        self.assertEqual(report["due"]["chat_turns"], 0)


if __name__ == "__main__":
    unittest.main()
