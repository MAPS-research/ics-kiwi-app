"""Regression tests for the supplementary v0.6.0 browser findings (passes A and B: S-Bnn/S-Mnn/S-mnn, SB-Bnn/SB-Mnn/SB-mnn).

Each test names the finding it pins. Fixtures use ``server/testsupport.py`` builders, temporary databases and no AI
provider (AI keys stay empty).
"""

from __future__ import annotations

import io
import json
import unittest
import zipfile
from urllib.parse import quote

from server import ai_policy, course_config, identity, readers, testsupport
from server import db as dbmod
from server.test_grading import CLS, GradingApiCase, LONG, TWO_QUESTIONS
from server.test_review2 import _consent, _staff_key, _text
from server.testsupport import TEACHER_KEY, ApiTestCase


class GroupApplyKeepsReleasedGradesTests(GradingApiCase):
    """S-B01: By question › Apply score to group must never rewrite or withdraw a released grade."""

    def _two_students_same_answer(self):
        rec = self.hw(grades_visibility="on_release",
                      questions=[TWO_QUESTIONS[0], dict(TWO_QUESTIONS[1], id="q2")])
        ada = self.submit("s1", rec, {"q1": "4", "q2": LONG})
        items = {"q1": {"score": 10, "comment": ""}, "q2": {"score": 6, "comment": ""}}
        status, released = self.put_grade(ada, {"items": items, "action": "release"})
        self.assertEqual((status, released["submission"]["gradeStatus"], released["total"]), (200, "released", 16), released)
        bo = self.submit("s2", rec, {"q1": "4", "q2": LONG})
        return rec, ada, bo

    def test_group_lists_members_with_names_and_grade_status(self):
        rec, ada, bo = self._two_students_same_answer()
        body = self.queue(f"&view=question&assignmentId={rec.id}&questionId=q2&show=all")
        group = next(g for g in body["groups"] if len(g["submissionIds"]) == 2)
        members = {m["submissionId"]: m for m in group["members"]}
        self.assertEqual(set(members), {ada, bo})
        self.assertEqual((members[ada]["studentLabel"], members[ada]["gradeStatus"], members[ada]["grade"]), ("Ada Chen", "released", 16))
        self.assertEqual((members[bo]["studentLabel"], members[bo]["gradeStatus"]), ("Bo Lin", "ungraded"))
        self.assertTrue(members[bo]["latest"])
        self.assertEqual(members[ada]["maxPoints"], 20)
        pseudo = self.queue(f"&view=question&assignmentId={rec.id}&questionId=q2&show=all", name_mode="pseudonyms")
        labels = {m["studentLabel"] for g in pseudo["groups"] for m in g["members"]}
        self.assertNotIn("Ada Chen", labels)

    def test_keep_released_refuses_to_touch_a_released_grade(self):
        _rec, ada, bo = self._two_students_same_answer()
        body = {"items": {"q2": {"score": 7, "comment": ""}}, "action": "save", "keepReleased": True}
        status, refused = self.put_grade(ada, body)
        self.assertEqual((status, refused["code"]), (409, "grade_released"), refused)
        detail = self.detail(ada)
        self.assertEqual((detail["submission"]["gradeStatus"], detail["total"]), ("released", 16))
        self.assertEqual([h["action"] for h in detail["history"]], ["autocheck", "release"])
        status, saved = self.put_grade(bo, body)
        self.assertEqual((status, saved["submission"]["gradeStatus"]), (200, "draft"), saved)
        self.assertEqual(next(i for i in saved["items"] if i["questionId"] == "q2")["score"], 7)

    def test_keep_released_must_be_boolean(self):
        _rec, _ada, bo = self._two_students_same_answer()
        status, body = self.put_grade(bo, {"items": {}, "action": "save", "keepReleased": "yes"})
        self.assertEqual(status, 400, body)

    def test_group_carries_the_auto_score_for_prefill(self):  # S-m05
        rec = self.hw()
        self.submit("s1", rec, {"q1": "4", "q2": "words"})
        self.submit("s2", rec, {"q1": "4", "q2": "other words"})
        body = self.queue(f"&view=question&assignmentId={rec.id}&questionId=q1&show=all")
        group = body["groups"][0]
        self.assertEqual((len(group["submissionIds"]), group["autoCorrect"], group["autoScore"]), (2, True, 10))



class AnonymizeScrubsOwnIdentityTests(GradingApiCase):
    """SB-B01: Anonymize removes the student's own name and email from the content it keeps."""

    NAME, EMAIL, SID = "Review S-Anon Student", "review-s-anon@example.edu", "review-s-anon"

    def test_anonymize_scrubs_name_email_and_raw_id_from_retained_text(self):
        with self.db() as db:
            testsupport.add_roster(db, CLS, self.SID, display_name=self.NAME, kiwi_email=self.EMAIL)
        rec = self.hw(due_at="2026-01-01T00:00:00+00:00")
        intro = f"Hi, I am {self.NAME} ({self.EMAIL}), id {self.SID}. Ada Chen helped me."
        with self.db() as db:
            sub = testsupport.make_autochecked_submission(db, CLS, self.SID, rec.id, {"q1": "4", "q2": intro})
            testsupport.make_draft(db, CLS, self.SID, rec.id, {"q2": f"draft by {self.EMAIL.upper()}"})
            testsupport.make_chat_turn(db, CLS, self.SID, intro, f"Hello {self.NAME}! Let's look at your code.")
        status, _ = self.put_grade(sub, {"items": {"q1": {"score": 10, "comment": f"Nice, {self.NAME}"},
                                                   "q2": {"score": 5, "comment": ""}},
                                         "feedback": f"Well done {self.NAME}", "action": "release"})
        self.assertEqual(status, 200)
        status, result = self.request(f"/api/teacher/students/{self.SID}/delete-data?classId={CLS}", "POST",
                                      {"mode": "anonymize", "confirm": self.SID}, key=TEACHER_KEY)
        self.assertEqual(status, 200, result)
        with self.db() as db:
            found = []
            for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
                if table in ("teacher_actions", "data_access_log", "student_tombstones"):
                    continue   # audit rows: the student is audited as hash:<student_hash> (§14.5)
                cols = [r[1] for r in db.execute(f"PRAGMA table_info({table})") if (r[2] or "").upper() in ("TEXT", "")]
                for col in cols:
                    for needle in (self.NAME, self.NAME.replace(" ", ""), self.EMAIL, self.SID):
                        hits = db.execute(f"SELECT COUNT(*) FROM {table} WHERE instr(lower(CAST({col} AS TEXT)), lower(?)) > 0",
                                          (needle,)).fetchone()[0]
                        if hits:
                            found.append((table, col, needle))
            self.assertEqual(found, [])
            anon = db.execute("SELECT student_id FROM roster WHERE display_name='Anonymized student'").fetchone()[0]
            prompt = db.execute("SELECT prompt FROM chat_turns WHERE student_id=?", (anon,)).fetchone()[0]
            self.assertEqual(prompt, f"Hi, I am [name removed] ([email removed]), id {anon}. Ada Chen helped me.")
            answers = json.loads(db.execute("SELECT answers_json FROM submissions WHERE student_id=?", (anon,)).fetchone()[0])
            self.assertEqual(answers["q1"], "4")
            self.assertTrue(answers["q2"].startswith("Hi, I am [name removed]"))
        self.assertGreater(result["counts"]["chat_turns_text"], 0)



class ArchivedDraftTests(GradingApiCase):
    def test_archived_draft_reads_archived_and_can_be_unarchived(self):  # S-M07
        rec = self.hw(status="draft")
        status, _ = self.request(f"/api/teacher/assignments/{rec.id}/archive?classId={CLS}", "POST", {}, TEACHER_KEY)
        self.assertEqual(status, 200)
        status, listed = self.request(f"/api/teacher/assignments?classId={CLS}&status=archived", key=TEACHER_KEY)
        item = next(a for a in listed["assignments"] if a["id"] == rec.id)
        self.assertEqual((item["status"], item["state"]), ("draft", "archived"))
        status, _ = self.request(f"/api/teacher/assignments/{rec.id}/unarchive?classId={CLS}", "POST", {}, TEACHER_KEY)
        self.assertEqual(status, 200)
        status, listed = self.request(f"/api/teacher/assignments?classId={CLS}&status=draft", key=TEACHER_KEY)
        self.assertEqual(next(a for a in listed["assignments"] if a["id"] == rec.id)["state"], "draft")



class GradeReleaseIsNotStudentActivityTests(GradingApiCase):
    """SB-M01: a staff grade release is not the student's activity."""

    def test_release_keeps_last_active_and_leaves_the_student_population(self):
        rec = self.hw(grades_visibility="on_release")
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"}, at="2026-10-20T09:00:00+00:00")
        with testsupport.freeze_time("2026-10-22T09:46:00+00:00"):
            status, _ = self.put_grade(sub, {"items": {"q1": {"score": 10, "comment": ""}, "q2": {"score": 7, "comment": ""}},
                                             "action": "release"})
        self.assertEqual(status, 200)
        event = self.events("grade_released")[0]
        self.assertEqual((event["student_id"], event["actor_role"], event["learning_session_id"]), ("s1", "instructor", ""))
        with self.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM learning_sessions WHERE title LIKE '%rade%'").fetchone()[0], 0)
            last = db.execute("SELECT MAX(lastActive) FROM learning_sessions WHERE studentId='s1'").fetchone()[0]
            self.assertTrue(last.startswith("2026-10-20"), last)
        status, roster = self.request(f"/api/teacher/roster?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, roster)
        ada = next(r for r in roster["students"] if r["studentId"] == "s1")
        self.assertTrue(ada["lastActive"].startswith("2026-10-20"), ada["lastActive"])
        status, listed = self.request(f"/api/teacher/assignments/{rec.id}/students?classId={CLS}&state=submitted", key=TEACHER_KEY)
        self.assertEqual(status, 200, listed)
        self.assertTrue(listed["students"][0]["lastActive"].startswith("2026-10-20"), listed)
        status, raw = self.request(f"/api/teacher/exports/assignment-status.csv?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200)
        self.assertNotIn("2026-10-22T09:46", raw.decode() if isinstance(raw, bytes) else str(raw))



class ResearcherRawIdTests(ApiTestCase):
    """SB-M02: researcher requests accept research ids only, never raw student ids."""

    def test_raw_student_ids_answer_404_for_a_researcher(self):
        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "demo-ada", display_name="Ada Chen")
            testsupport.add_roster(db, "c1", "demo-bo", display_name="Bo Lin")
            _consent(db, "c1", "demo-ada", "yes")
            _consent(db, "c1", "demo-bo", "no")
            testsupport.make_chat_turn(db, "c1", "demo-ada", "How do I join?", "Use left_join().")
            _rid, key = _staff_key(db, "c1", "researcher", "Shen (research)")
            rid = identity.research_id(db, "c1", "demo-ada")
        status, ok = self.request(f"/api/teacher/timeline?classId=c1&studentId={rid}", key=key)
        self.assertEqual(status, 200, ok)
        for target in ("/api/teacher/timeline?studentId=demo-ada", "/api/teacher/events?studentId=demo-ada",
                       f"/api/teacher/events?studentId={rid},demo-ada", "/api/teacher/ai-conversations/threads/lab:demo-ada:t1",
                       "/api/teacher/timeline?studentId=demo-bo"):
            with self.subTest(target=target):
                status, body = self.request(f"{target}&classId=c1" if "?" in target else f"{target}?classId=c1", key=key)
                self.assertEqual((status, body["code"]), (404, "not_found"), body)
                self.assertNotIn(rid, _text(body))
        status, body = self.request("/api/teacher/timeline?classId=c1&studentId=demo-ada", key=TEACHER_KEY)
        self.assertEqual(status, 200, body)   # teaching staff keep using student ids



class CoderRoleTests(ApiTestCase):
    def test_coded_conversation_export_names_the_coder_role(self):  # SB-M03
        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Ada Chen")
            _consent(db, "c1", "s1", "yes")
            turn = testsupport.make_chat_turn(db, "c1", "s1", "How do I join?", "Use left_join().")
            _rid, rkey = _staff_key(db, "c1", "researcher", "Shen (research)")
            _tid, tkey = _staff_key(db, "c1", "ta", "Tao (TA)")
            with dbmod.write_tx(db):   # a researcher's code; codes store the coder's label (audit.actor_label)
                db.execute("""INSERT INTO conversation_codes (class_id, thread_key, chat_turn_id, code_id, coder_id, created_at)
                           VALUES ('c1', 'lab:s1:t1', ?, 'legacy', 'Shen (research)', ?)""", (turn, dbmod.now()))
        status, code = self.request("/api/teacher/codebook?classId=c1", "POST", {"label": "Peer help"}, key=TEACHER_KEY)
        self.assertEqual(status, 201, code)
        for key in (TEACHER_KEY, tkey):
            status, added = self.request("/api/teacher/ai-conversations/codes?classId=c1", "POST",
                                         {"threadKey": "lab:s1:t1", "codeId": code["id"], "chatTurnId": turn}, key=key)
            self.assertEqual(status, 201, added)
        with self.db() as db, dbmod.write_tx(db):
            db.execute("UPDATE conversation_codes SET code_id=? WHERE code_id='legacy'", (code["id"],))
        status, raw = self.request("/api/teacher/exports/conversation-codes.csv?classId=c1", key=TEACHER_KEY)
        self.assertEqual(status, 200, raw)
        lines = _text(raw).splitlines()
        header = lines[0].lstrip("\ufeff").split(",")
        roles = sorted(line.split(",")[header.index("coder_role")] for line in lines[1:] if line)
        self.assertEqual(roles, ["instructor", "researcher", "ta"])



class RevisionLineageTests(GradingApiCase):
    """S-M01 (submitters of the original are not missing the revision) and S-M02 (the closed original stays protected)."""

    QUESTIONS = [dict(TWO_QUESTIONS[0], studentExplanation="mean(df$score) is 80"), TWO_QUESTIONS[1]]

    def _revised(self):
        rec = self.hw(title="Files HW", due_at="2026-01-01T00:00:00+00:00", solutions_visibility="after_due",
                      grades_visibility="on_release", questions=self.QUESTIONS)
        for sid in ("s1", "s2"):
            sub = self.submit(sid, rec, {"q1": "4", "q2": "words"})
            self.put_grade(sub, {"items": {"q1": {"score": 10, "comment": ""}, "q2": {"score": 8, "comment": ""}}, "action": "release"})
        status, copy = self.request(f"/api/teacher/assignments/{rec.id}/duplicate?classId={CLS}", "POST",
                                    {"asRevision": True, "retireOriginalOnPublish": True}, TEACHER_KEY)
        self.assertEqual(status, 201, copy)
        status, published = self.request(f"/api/teacher/assignments/{copy['id']}/publish?classId={CLS}", "POST", {}, TEACHER_KEY)
        self.assertEqual(status, 200, published)
        return rec, copy["id"]

    def test_submitters_of_the_original_are_not_missing_the_revision(self):  # S-M01
        rec, revision = self._revised()
        status, listed = self.request(f"/api/teacher/assignments?classId={CLS}", key=TEACHER_KEY)
        rows = {a["id"]: a for a in listed["assignments"]}
        self.assertEqual((rows[revision]["stats"]["missing"], rows[revision]["stats"]["submittedOriginal"]), (1, 2))  # s3 never submitted
        self.assertEqual((rows[revision]["revisionOf"], rows[revision]["revisionOfTitle"]), (rec.id, "Files HW"))
        self.assertEqual([r["id"] for r in rows[rec.id]["revisions"]], [revision])
        status, missing = self.request(f"/api/teacher/assignments/{revision}/students?classId={CLS}&state=missing", key=TEACHER_KEY)
        self.assertEqual([r["studentId"] for r in missing["students"]], ["s3"])
        status, home = self.request(f"/api/teacher/home?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, home)
        gone = [m for m in home["needsAction"]["missingPastDue"] if m["assignmentId"] == revision]
        self.assertEqual([m["count"] for m in gone], [1])
        status, book = self.request(f"/api/teacher/gradebook?classId={CLS}", key=TEACHER_KEY)
        cell = next(c for r in book["rows"] if r["studentId"] == "s1" for c in r["cells"] if c["assignmentId"] == revision)
        self.assertEqual((cell["state"], cell["label"], cell["onOriginal"]), ("not_submitted", "Submitted the original", True))
        status, options = self.request(f"/api/work-options?classId={CLS}", student="s1")
        mine = next(o for o in options if o["id"] == revision)
        self.assertEqual(mine["submittedOriginal"], {"id": rec.id, "title": "Files HW"})
        status, other = self.request(f"/api/work-options?classId={CLS}", student="s3")
        self.assertIsNone(next(o for o in other if o["id"] == revision)["submittedOriginal"])

    def test_closed_original_stays_protected_while_its_revision_is_open(self):  # S-M02
        rec, revision = self._revised()
        status, original = self.request(f"/api/work/{rec.id}?classId={CLS}", student="s1")
        self.assertEqual((status, original["state"]), (200, "closed"), original)
        self.assertNotIn("studentExplanation", original["questions"][0])
        with self.db() as db:
            now = dbmod.utcnow()
            closed = readers.load_assignment(db, CLS, rec.id)
            self.assertTrue(readers.answer_protected(db, closed, "s1", now))
            self.assertEqual(readers.protecting_relative(db, closed, "s1", now).id, revision)
            with dbmod.write_tx(db):   # once the revision closes too, the original shows its solutions again
                db.execute("UPDATE assignments SET close_at=? WHERE id=?", ("2026-01-02T00:00:00+00:00", revision))
            self.assertFalse(readers.answer_protected(db, closed, "s1", now))
        status, original = self.request(f"/api/work/{rec.id}?classId={CLS}", student="s1")
        self.assertEqual(original["questions"][0]["studentExplanation"], "mean(df$score) is 80")



class AiReferenceRuleTests(ApiTestCase):
    def test_chapter_summary_says_whether_the_rules_send_ai_reference_files(self):  # S-M03
        self.create_course("c1")
        status, summary = self.request("/api/teacher/chapters/summary?classId=c1", key=TEACHER_KEY)
        self.assertEqual(status, 200, summary)
        unit = summary["units"][0]
        self.assertIs(unit["aiSeesMaterials"], False)
        config = ai_policy.platform_default()
        config["contextFields"] = [*config["contextFields"], "materials"]
        status, saved = self.request("/api/teacher/ai/rules?classId=c1", "POST",
                                     {"scope": "unit", "unitId": unit["unitId"], "groupId": "", "config": config, "note": "",
                                      "baseVersion": None}, key=TEACHER_KEY)
        self.assertEqual(status, 201, saved)
        status, summary = self.request("/api/teacher/chapters/summary?classId=c1", key=TEACHER_KEY)
        self.assertIs(next(u for u in summary["units"] if u["unitId"] == unit["unitId"])["aiSeesMaterials"], True)



class TemplateNotesTests(ApiTestCase):
    def test_applied_template_keeps_its_chapter_notes_for_staff_only(self):  # S-M05
        self.create_course("dst")
        body = {"templateKey": "socs-sh-190-spring-2026", "mode": "apply"}
        status, applied = self.request("/api/teacher/course-package/import?classId=dst", "POST", body, key=TEACHER_KEY)
        self.assertEqual(status, 200, applied)
        with self.db() as db:
            course = course_config.course_for("dst", db)
        chapter5 = next(u for u in course["units"] if u["title"] == "Online experiments & data hunt")
        self.assertIn("R session 2d · Data Linkage (2d. Data linkage.qmd).", chapter5["notes"])
        self.assertIn("is inferred", chapter5["notes"])
        self.assertIn("Run locally: duke", chapter5["notes"])
        self.assertIn("R Ex. 2 assigned", chapter5["notes"])
        self.assertEqual(len(chapter5["notes"].splitlines()), 5)
        self.assertEqual(course_config.student_view(course)["units"][0].get("notes"), None)
        status, student = self.request("/api/course?classId=dst", student="s1")
        self.assertEqual(status, 200, student)
        self.assertFalse(any("notes" in u for u in student["units"]))
        # notes are editable with the chapters and validated
        status, saved = self.request("/api/course?classId=dst", "PUT", {**_course_input(course), "units": [
            {**_unit_input(u), "notes": "x" * 4001 if u["id"] == chapter5["id"] else u["notes"]} for u in course["units"]]},
            key=TEACHER_KEY)
        self.assertEqual(status, 400, saved)



class StarterDedupeTests(ApiTestCase):
    def test_chinese_titled_v05_starters_are_already_added(self):  # S-m01
        self.create_course("c1")
        with self.db() as db:
            for title in ("课堂练习 · R 基础与数据整理", "作业 1 · R 基础、导入与整理", "作业 2 · 航班数据连接与可视化",
                          "作业 3 · 歌词文本预处理", "作业 4 · 社会网络与入度"):
                testsupport.publish_work(db, "c1", title=title)
        status, starters = self.request("/api/teacher/starter-assignments?classId=c1", key=TEACHER_KEY)
        self.assertEqual(status, 200, starters)
        self.assertEqual([s["alreadyAdded"] for s in starters], [True] * 5)



class OverTimeFlagTests(GradingApiCase):
    def test_over_time_flag_counts_minutes_over_the_limit(self):  # S-m07
        rec = self.hw(time_limit={"minutes": 5, "onExpiry": "submit_marked"})
        sub = self.submit("s1", rec, {"q1": "4", "q2": "words"}, time_used_seconds=7 * 60, over_time=True)
        flags = {f["kind"]: f["text"] for f in self.detail(sub)["flags"]}
        self.assertEqual(flags["over_time"], "Over time · 2 min over")



class ResearchScrubTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Anon Student")
            testsupport.add_roster(db, "c1", "s2", display_name="Ada Chen")
            testsupport.add_roster(db, "c1", "s3", display_name="Bo Lin")
            _consent(db, "c1", "s1", "yes")
            _consent(db, "c1", "s2", "yes")
            _consent(db, "c1", "s3", "no")
            testsupport.make_chat_turn(db, "c1", "s1", "Ada Chen and Bo Lin helped me with joins", "Good teamwork.")
            _rid, self.rkey = _staff_key(db, "c1", "researcher", "Shen (research)")
            self.ada, self.bo = identity.research_id(db, "c1", "s2"), identity.research_id(db, "c1", "s3")

    def test_non_consenting_classmate_is_not_named_by_research_id(self):  # SB-m01
        status, raw = self.request("/api/teacher/exports/research-package.zip?classId=c1&allowUnverified=1&purpose="
                                   + quote("Help seeking study"), key=TEACHER_KEY)
        self.assertEqual(status, 200, raw)
        texts = "\n".join(zipfile.ZipFile(io.BytesIO(raw)).read(n).decode("utf-8", "replace")
                          for n in zipfile.ZipFile(io.BytesIO(raw)).namelist())
        self.assertIn(f"{self.ada} and [classmate] helped me", texts)
        self.assertNotIn(self.bo, texts)
        self.assertNotIn("Bo Lin", texts)
        status, threads = self.request("/api/teacher/ai-conversations/threads?classId=c1", key=self.rkey)
        self.assertEqual(status, 200, threads)
        key = threads["threads"][0]["threadKey"]
        status, thread = self.request(f"/api/teacher/ai-conversations/threads/{key}?classId=c1", key=self.rkey)
        self.assertEqual(status, 200, thread)
        text = _text(thread)
        self.assertIn("[classmate]", text)
        self.assertNotIn("Bo Lin", text)

    def test_researcher_unverified_message_gives_advice_they_can_follow(self):  # SB-m02
        status, body = self.request("/api/teacher/exports/research-package.zip?classId=c1&allowUnverified=1&purpose="
                                    + quote("Help seeking study"), key=self.rkey)
        self.assertEqual((status, body["code"]), (409, "unverified_identity"), body)
        self.assertNotIn("allowUnverified", body["error"])



class ReteachWriteTests(ApiTestCase):
    def test_viewers_read_but_cannot_write_reteach_marks(self):  # SB-m11
        self.create_course("c1")
        with self.db() as db:
            _vid, viewer = _staff_key(db, "c1", "viewer", "Co-instructor (viewer)")
            _tid, ta = _staff_key(db, "c1", "ta", "Tao (TA)")
        body = {"targetKind": "topic", "assignmentId": "", "questionId": "", "unitId": "", "chatTurnId": None,
                "label": "Joins", "note": ""}
        self.assertEqual(self.request("/api/teacher/reteach?classId=c1", key=viewer)[0], 200)
        status, refused = self.request("/api/teacher/reteach?classId=c1", "POST", body, viewer)
        self.assertEqual(status, 403, refused)
        status, mark = self.request("/api/teacher/reteach?classId=c1", "POST", body, ta)
        self.assertEqual(status, 201, mark)
        status, _ = self.request(f"/api/teacher/reteach/{mark['id']}?classId=c1", "PATCH", {"resolved": True}, viewer)
        self.assertEqual(status, 403)



class DeletedStudentDemoLinkTests(ApiTestCase):
    def test_a_deleted_students_demo_link_no_longer_signs_in(self):  # SB-m09
        self.create_course("c1")
        status, link = self.request("/api/teacher/demo-links?classId=c1", "POST", {"studentId": "review-s-del"}, TEACHER_KEY)
        self.assertEqual(status, 200, link)
        token = link["url"].split("#demo=", 1)[1]
        status, session = self.request("/api/demo/session?classId=c1", "POST", {"token": token})
        self.assertEqual(status, 200, session)
        status, result = self.request("/api/teacher/students/review-s-del/delete-data?classId=c1", "POST",
                                      {"mode": "delete", "confirm": "review-s-del"}, key=TEACHER_KEY)
        self.assertEqual(status, 200, result)
        status, refused = self.request("/api/demo/session?classId=c1", "POST", {"token": token})
        self.assertEqual(status, 403, refused)
        status, refused = self.request("/api/work-options?classId=c1", headers={"X-Demo-Session": session["token"]})
        self.assertEqual(status, 403, refused)
        status, refused = self.request("/api/teacher/demo-links?classId=c1", "POST", {"studentId": "review-s-del"}, TEACHER_KEY)
        self.assertEqual((status, refused["code"]), (409, "student_removed"))



class LocalFallbackHealthTests(ApiTestCase):
    def test_data_health_counts_local_fallbacks_apart(self):  # SB-m13
        from server import telemetry

        self.create_course("c1")
        with self.db() as db:
            testsupport.add_roster(db, "c1", "s1", display_name="Ada Chen")
            testsupport.make_chat_turn(db, "c1", "s1", "Why NA?", "Use na.rm.")
            testsupport.make_chat_turn(db, "c1", "s1", "And now?", "Check is.na().", status="local", source="local", model=None,
                                       thread_id="t2")
            testsupport.make_free_item_attempt(db, "c1", "s1", "r-basics")
            health = telemetry.data_health(db, "c1", None, None)
        self.assertEqual(health["aiCalls"]["local"], 1)
        self.assertGreater(health["aiCalls"]["ok"], health["aiCalls"]["local"])
        self.assertIn("local", health["generatedItems"])


def _unit_input(unit: dict) -> dict:
    return {k: unit[k] for k in ("id", "title", "goal", "access", "week", "startsOn", "runtime", "notes")}


def _course_input(course: dict) -> dict:
    return {"title": course["title"], "description": course["description"], "currentUnitId": course["currentUnitId"],
            "freePracticeScope": course["freePracticeScope"], "units": [_unit_input(u) for u in course["units"]]}


if __name__ == "__main__":
    unittest.main()
