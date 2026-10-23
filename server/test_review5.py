"""Regression tests for the v0.6.0 supplementary browser retest (R-B01, S-M05 re-rated blocker, R-m01, R-m02).

Each test names the finding it pins. Fixtures use ``server/testsupport.py`` builders, temporary databases and no AI
provider (AI keys stay empty).
"""

from __future__ import annotations

import io
import json
import unittest
import zipfile

from server import analytics, course_config, testsupport
from server import db as dbmod
from server.test_grading import CLS, GradingApiCase, TWO_QUESTIONS
from server.testsupport import TEACHER_KEY, ApiTestCase

TEMPLATE = "socs-sh-190-spring-2026"


def _unit_input(unit: dict, *, notes: bool = True) -> dict:
    keys = ("id", "title", "goal", "access", "week", "startsOn", "runtime") + (("notes",) if notes else ())
    return {k: unit[k] for k in keys}


def _course_input(course: dict, units: list[dict]) -> dict:
    return {"title": course["title"], "description": course["description"], "currentUnitId": course["currentUnitId"],
            "freePracticeScope": course["freePracticeScope"], "baseUpdatedAt": course["updatedAt"], "units": units}


class CourseViewTests(ApiTestCase):
    """R-B01: the course says which view it is, so a teacher page can refuse to save a student view."""

    def setUp(self) -> None:
        super().setUp()
        self.create_course("c1")
        with self.db() as db, dbmod.write_tx(db):
            course = course_config.course_for("c1", db)
            units = [{**_unit_input(u), "access": "hidden" if u["id"] == "network-analysis" else u["access"],
                      "notes": "Staff note for " + u["id"]} for u in course["units"]]
            config = course_config.validate_course({**_course_input(course, units)})
            db.execute("UPDATE courses SET config_json=? WHERE class_id='c1'", (dbmod.json_dumps(config),))

    def test_get_course_names_the_view_and_strips_staff_fields_for_students(self):  # R-B01
        status, anonymous = self.request("/api/course?classId=c1")
        self.assertEqual(status, 200, anonymous)
        self.assertEqual(anonymous["view"], "student")
        self.assertNotIn("network-analysis", [u["id"] for u in anonymous["units"]])
        self.assertFalse(any("notes" in u for u in anonymous["units"]))
        status, staff = self.request("/api/course?classId=c1", key=TEACHER_KEY)
        self.assertEqual((status, staff["view"]), (200, "staff"), staff)
        hidden = next(u for u in staff["units"] if u["id"] == "network-analysis")
        self.assertEqual((hidden["access"], hidden["notes"]), ("hidden", "Staff note for network-analysis"))
        status, preview = self.request("/api/course?classId=c1", key=TEACHER_KEY, preview=True)
        self.assertEqual((status, preview["view"]), (200, "student"), preview)
        self.assertNotIn("network-analysis", [u["id"] for u in preview["units"]])

    def test_put_and_this_week_answers_carry_the_staff_view(self):  # R-B01
        _status, staff = self.request("/api/course?classId=c1", key=TEACHER_KEY)
        status, saved = self.request("/api/course?classId=c1", "PUT", _course_input(staff, [_unit_input(u) for u in staff["units"]]),
                                     key=TEACHER_KEY)
        self.assertEqual((status, saved["view"]), (200, "staff"), saved)
        status, week = self.request("/api/teacher/chapters/this-week?classId=c1", "PUT", {"unitId": "text-analysis"}, key=TEACHER_KEY)
        self.assertEqual((status, week["view"], week["currentUnitId"]), (200, "staff", "text-analysis"), week)
        self.assertEqual(next(u for u in week["units"] if u["id"] == "network-analysis")["notes"], "Staff note for network-analysis")


class StudentViewSaveKeepsStaffDataTests(ApiTestCase):
    """R-B01 / S-M05: PUT /api/course keeps what the body leaves out (hidden chapters, notes, template metadata)."""

    def setUp(self) -> None:
        super().setUp()
        self.create_course("dst")
        status, applied = self.request("/api/teacher/course-package/import?classId=dst", "POST",
                                       {"templateKey": TEMPLATE, "mode": "apply", "archiveUnreferencedDefaults": True}, key=TEACHER_KEY)
        self.assertEqual(status, 200, applied)
        with self.db() as db:
            self.stored = course_config.course_for("dst", db)

    def staff(self) -> dict:
        status, course = self.request("/api/course?classId=dst", key=TEACHER_KEY)
        self.assertEqual(status, 200, course)
        return course

    def test_template_apply_stores_notes_and_template_metadata_for_staff_only(self):  # S-M05
        chapter5 = next(u for u in self.stored["units"] if u["id"] == "css190-05-experiments")
        self.assertEqual([s["id"] for s in chapter5["rSessions"]], ["2d", "2e"])
        self.assertEqual(chapter5["rSessions"][0], {"id": "2d", "title": "Data Linkage", "file": "2d. Data linkage.qmd"})
        self.assertEqual((chapter5["pairing"], chapter5["runLocally"], chapter5["liveApi"]), ("inferred", ["duke"], []))
        self.assertIn("is inferred", chapter5["notes"])
        online = next(u for u in self.stored["units"] if u["id"] == "css190-04-online-data")
        self.assertIn("tuber", online["liveApi"])
        hidden = [u["id"] for u in self.stored["units"] if u["access"] == "hidden"]
        self.assertEqual(len(hidden), 5)
        status, student = self.request("/api/course?classId=dst", student="s1")
        self.assertEqual(status, 200, student)
        self.assertEqual(len(student["units"]), 12)
        for unit in student["units"]:
            for key in course_config.STAFF_ONLY_UNIT_FIELDS:
                self.assertNotIn(key, unit, unit["id"])

    def test_saving_the_student_view_keeps_hidden_chapters_notes_and_metadata(self):  # R-B01, S-M05 (the retest steps)
        status, student = self.request("/api/course?classId=dst")   # what the teacher app held before the fix
        self.assertEqual((status, student["view"]), (200, "student"), student)
        units = [_unit_input(u, notes=False) for u in student["units"]]
        units[1] = {**units[1], "notes": "Teacher note for chapter 02"}
        status, saved = self.request("/api/course?classId=dst", "PUT", _course_input(student, units), key=TEACHER_KEY)
        self.assertEqual(status, 200, saved)
        self.assertEqual([u["id"] for u in saved["units"]], [u["id"] for u in self.stored["units"]])
        before = {u["id"]: u for u in self.stored["units"]}
        for unit in saved["units"]:
            if unit["id"] == units[1]["id"]:
                self.assertEqual(unit["notes"], "Teacher note for chapter 02")
                continue
            for key in course_config.STAFF_ONLY_UNIT_FIELDS:
                self.assertEqual(unit.get(key), before[unit["id"]].get(key), (unit["id"], key))
        self.assertEqual(sum(1 for u in saved["units"] if u["access"] == "hidden"), 5)

    def test_hidden_chapter_with_assignments_no_longer_blocks_every_save(self):  # R-B01 second symptom
        with self.db() as db:
            testsupport.publish_work(db, "dst", title="On a hidden chapter", unit_id="css-intro")
        student = self.request("/api/course?classId=dst")[1]
        units = [{**_unit_input(u, notes=False), "week": 3} if i == 3 else _unit_input(u, notes=False)
                 for i, u in enumerate(student["units"])]
        status, saved = self.request("/api/course?classId=dst", "PUT", _course_input(student, units), key=TEACHER_KEY)
        self.assertEqual(status, 200, saved)
        self.assertIn("css-intro", [u["id"] for u in saved["units"]])
        self.assertEqual(saved["units"][3]["week"], 3)

    def test_hidden_chapters_stay_in_place(self):  # R-B01
        course = self.staff()
        visible = [u for u in course["units"] if u["access"] != "hidden"]
        # the teacher moves the last visible chapter to the front; the hidden ones keep their stored positions
        reordered = [visible[-1], *visible[:-1]]
        status, saved = self.request("/api/course?classId=dst", "PUT",
                                     _course_input(course, [_unit_input(u, notes=False) for u in reordered]), key=TEACHER_KEY)
        self.assertEqual(status, 200, saved)
        ids = [u["id"] for u in saved["units"]]
        self.assertEqual(ids[0], visible[-1]["id"])
        hidden = [u["id"] for u in course["units"] if u["access"] == "hidden"]
        self.assertEqual(ids[-len(hidden):], hidden)

    def test_explicit_changes_still_apply(self):  # S-M05 "unless the client explicitly changes them"
        course = self.staff()
        target = course["units"][0]
        units = [{**_unit_input(u), "notes": ""} if u["id"] == target["id"] else _unit_input(u) for u in course["units"]]
        units[0] = {**units[0], "rSessions": [], "pairing": "none", "runLocally": [], "liveApi": []}
        status, saved = self.request("/api/course?classId=dst", "PUT", _course_input(course, units), key=TEACHER_KEY)
        self.assertEqual(status, 200, saved)
        first = saved["units"][0]
        self.assertEqual((first["notes"], first["rSessions"], first["pairing"]), ("", [], "none"))
        self.assertEqual(saved["units"][4]["notes"], course["units"][4]["notes"])

    def test_remove_unit_ids_removes_a_hidden_chapter_explicitly(self):  # R-B01
        course = self.staff()
        hidden = [u for u in course["units"] if u["access"] == "hidden"]
        kept = [_unit_input(u) for u in course["units"] if u["id"] != hidden[0]["id"]]
        status, saved = self.request("/api/course?classId=dst", "PUT",
                                     {**_course_input(course, kept), "removeUnitIds": [hidden[0]["id"]]}, key=TEACHER_KEY)
        self.assertEqual(status, 200, saved)
        self.assertNotIn(hidden[0]["id"], [u["id"] for u in saved["units"]])
        self.assertEqual(len(saved["units"]), len(course["units"]) - 1)
        with self.db() as db:
            testsupport.publish_work(db, "dst", title="Keeps its chapter", unit_id=hidden[1]["id"])
        course = self.staff()
        kept = [_unit_input(u) for u in course["units"] if u["id"] != hidden[1]["id"]]
        status, refused = self.request("/api/course?classId=dst", "PUT",
                                       {**_course_input(course, kept), "removeUnitIds": [hidden[1]["id"]]}, key=TEACHER_KEY)
        self.assertEqual(status, 400, refused)
        self.assertIn("Archive the chapter instead", refused["error"])

    def test_remove_unit_ids_and_template_metadata_are_validated(self):  # R-B01, S-M05
        course = self.staff()
        units = [_unit_input(u) for u in course["units"]]
        for bad in ({"removeUnitIds": "css-intro"}, {"removeUnitIds": [3]}):
            status, body = self.request("/api/course?classId=dst", "PUT", {**_course_input(course, units), **bad}, key=TEACHER_KEY)
            self.assertEqual(status, 400, (bad, body))
        for bad in ({"pairing": "guessed"}, {"runLocally": ["not a package!"]}, {"rSessions": [{"id": "", "title": "x"}]},
                    {"rSessions": "2d"}, {"liveApi": "tuber"}):
            broken = [{**units[0], **bad}, *units[1:]]
            status, body = self.request("/api/course?classId=dst", "PUT", _course_input(course, broken), key=TEACHER_KEY)
            self.assertEqual(status, 400, (bad, body))

    def test_this_week_and_package_import_keep_staff_fields(self):  # S-M05
        status, week = self.request("/api/teacher/chapters/this-week?classId=dst", "PUT", {"unitId": "css190-03-ethics"}, key=TEACHER_KEY)
        self.assertEqual(status, 200, week)
        chapter5 = next(u for u in week["units"] if u["id"] == "css190-05-experiments")
        self.assertEqual((chapter5["pairing"], chapter5["runLocally"]), ("inferred", ["duke"]))
        self.assertIn("is inferred", chapter5["notes"])
        status, raw = self.request("/api/teacher/course-package.zip?classId=dst", key=TEACHER_KEY)
        self.assertEqual(status, 200)
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            exported = json.loads(archive.read("course.json"))
        unit = next(u for u in exported["units"] if u["id"] == "css190-05-experiments")
        self.assertEqual((unit["pairing"], [s["id"] for s in unit["rSessions"]]), ("inferred", ["2d", "2e"]))
        # importing a second template copy skips existing chapters and keeps their staff fields
        status, again = self.request("/api/teacher/course-package/import?classId=dst", "POST",
                                     {"templateKey": TEMPLATE, "mode": "apply"}, key=TEACHER_KEY)
        self.assertEqual(status, 200, again)
        with self.db() as db:
            after = course_config.course_for("dst", db)
        chapter5 = next(u for u in after["units"] if u["id"] == "css190-05-experiments")
        self.assertEqual((chapter5["pairing"], chapter5["runLocally"]), ("inferred", ["duke"]))
        self.assertTrue(any(u["access"] == "hidden" for u in after["units"]))


class KeepUnsentTests(unittest.TestCase):
    """R-B01 / S-M05: ``course_config.keep_unsent`` on its own (no database)."""

    @staticmethod
    def stored(*units: tuple[str, str]) -> dict:
        return {"units": [{"id": uid, "title": uid, "goal": "g", "access": access, "week": None, "startsOn": None,
                           "runtime": course_config.default_runtime(), "notes": f"note {uid}"} for uid, access in units]}

    def test_hidden_chapters_keep_their_stored_position_and_visible_ones_can_still_be_removed(self):
        stored = self.stored(("a", "default"), ("h", "hidden"), ("b", "default"), ("c", "default"))
        body = {"units": [{"id": "b"}, {"id": "a"}]}   # reorder, drop the visible "c", say nothing about "h"
        merged = course_config.keep_unsent(body, stored)
        self.assertEqual([u["id"] for u in merged["units"]], ["b", "h", "a"])
        self.assertEqual([u["notes"] for u in merged["units"]], ["note b", "note h", "note a"])
        removed = course_config.keep_unsent({**body, "removeUnitIds": ["h"]}, stored)
        self.assertEqual([u["id"] for u in removed["units"]], ["b", "a"])

    def test_sent_fields_win_and_bodies_without_units_pass_through(self):
        stored = self.stored(("a", "default"))
        stored["units"][0]["pairing"] = "inferred"
        merged = course_config.keep_unsent({"units": [{"id": "a", "notes": "", "pairing": None}]}, stored)
        self.assertEqual((merged["units"][0]["notes"], merged["units"][0]["pairing"]), ("", None))
        self.assertEqual(course_config.keep_unsent({"title": "x"}, stored), {"title": "x"})
        self.assertEqual(course_config.keep_unsent(["not", "a", "dict"], stored), ["not", "a", "dict"])
        with self.assertRaises(ValueError):
            course_config.keep_unsent({"units": [], "removeUnitIds": [None]}, stored)


class RosterMissingLineageTests(GradingApiCase):
    """R-m02: Students › Roster "Missing work" uses the revision lineage rule of Home and the gradebook."""

    def test_roster_missing_work_matches_the_lineage_rule(self):
        rec = self.hw(title="Files HW", due_at="2026-01-01T00:00:00+00:00", questions=TWO_QUESTIONS)
        for sid in ("s1", "s2"):
            self.submit(sid, rec, {"q1": "4", "q2": "words"})
        status, copy = self.request(f"/api/teacher/assignments/{rec.id}/duplicate?classId={CLS}", "POST",
                                    {"asRevision": True, "retireOriginalOnPublish": True}, TEACHER_KEY)
        self.assertEqual(status, 201, copy)
        status, published = self.request(f"/api/teacher/assignments/{copy['id']}/publish?classId={CLS}", "POST", {}, TEACHER_KEY)
        self.assertEqual(status, 200, published)
        self.hw(title="Older homework", due_at="2026-01-02T00:00:00+00:00")   # nobody submitted it
        status, roster = self.request(f"/api/teacher/roster?classId={CLS}", key=TEACHER_KEY)
        self.assertEqual(status, 200, roster)
        counts = {r["studentId"]: r["missingWork"] for r in roster["students"]}
        with self.db() as db:
            rule = analytics.missing_work(db, CLS, ["s1", "s2", "s3"], dbmod.utcnow())
        self.assertEqual(counts, {sid: len(rule[sid]) for sid in ("s1", "s2", "s3")})
        self.assertEqual((counts["s1"], counts["s2"], counts["s3"]), (1, 1, 3))   # s3: the original, its revision, Older


class ClosedOriginalPointsToRevisionTests(GradingApiCase):
    """R-m01: the closed original names its published revision, so the student page can link to it."""

    def test_original_names_its_published_revision_for_students_who_can_open_it(self):
        rec = self.hw(title="Files HW", due_at="2026-01-01T00:00:00+00:00")
        self.submit("s1", rec, {"q1": "4", "q2": "words"})
        status, original = self.request(f"/api/work/{rec.id}?classId={CLS}", student="s1")
        self.assertEqual((status, original["revisedAs"]), (200, None), original)
        status, copy = self.request(f"/api/teacher/assignments/{rec.id}/duplicate?classId={CLS}", "POST",
                                    {"asRevision": True, "retireOriginalOnPublish": True}, TEACHER_KEY)
        self.assertEqual(status, 201, copy)
        status, original = self.request(f"/api/work/{rec.id}?classId={CLS}", student="s1")
        self.assertIsNone(original["revisedAs"], "a draft revision is not announced")
        status, published = self.request(f"/api/teacher/assignments/{copy['id']}/publish?classId={CLS}", "POST", {}, TEACHER_KEY)
        self.assertEqual(status, 200, published)
        status, original = self.request(f"/api/work/{rec.id}?classId={CLS}", student="s1")
        self.assertEqual((status, original["state"]), (200, "closed"), original)
        self.assertEqual(original["revisedAs"], {"id": copy["id"], "title": published["title"]})
        status, revision = self.request(f"/api/work/{copy['id']}?classId={CLS}", student="s1")
        self.assertEqual((status, revision["revisedAs"]), (200, None), revision)


if __name__ == "__main__":
    unittest.main()
