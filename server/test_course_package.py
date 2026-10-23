"""Course package export/import and course templates — owned by PEOPLE (spec §14.7, PEOPLE-11, PEOPLE-21)."""

from __future__ import annotations

import base64
import io
import json
import unittest
import zipfile

from server import course_config, testsupport
from server import db as dbmod
from server.testsupport import TEACHER_KEY, ApiTestCase
from server.webr_packages import WEBR_PACKAGE_ALLOWLIST

SRC, DST = "src-course", "dst-course"
TEMPLATE = "socs-sh-190-spring-2026"
# Decision D4 (docs/handoff/v0.6.0-decisions.md): chapter, lecture week, meeting date, R sessions, packages used there.
D4_TABLE = [
    # Decision D4 (corrected 2026-10-23): chapters, week labels and R sessions follow the slides' module schedule
    # tables; week labels skip the Spring Festival and spring-break weeks (Apr 13 = Week 11).
    ("Introduction to CSS", 1, "2026-01-19", ["1a", "1b"], {"tidyverse", "ggplot2", "palmerpenguins", "visNetwork"}),
    ("Data in the digital age", 3, "2026-02-02", ["2a"], {"tidyverse", "dplyr", "tidyr", "palmerpenguins"}),
    ("Big data problems, contd. & research ethics", 4, "2026-02-09", ["2b"], {"tidyverse"}),
    ("Online data collection", 5, "2026-02-23", ["2c"], {"tidyverse", "stringr", "tuber", "vosonSML", "httpuv", "usethis"}),
    ("Online experiments & data hunt", 6, "2026-03-02", ["2d", "2e"], {"tidyverse", "palmerpenguins", "duke"}),
    ("Text-as-data overview", 7, "2026-03-09", ["2e"], {"tidyverse", "palmerpenguins", "duke"}),
    ("Bag of words & similarity metrics", 8, "2026-03-16", ["3a", "3b"],
     {"tidyverse", "tidytext", "quanteda", "textstem", "ggwordcloud", "sotu", "quanteda.textstats", "quanteda.textplots"}),
    ("Topic modeling", 9, "2026-03-23", ["3c"],
     {"topicmodels", "stm", "tidytext", "quanteda", "reshape2", "sotu", "ldatuning", "tidyverse"}),
    ("Word embeddings", 10, "2026-03-30", ["3d"], {"word2vec"}),
    ("LLMs for text analysis", 11, "2026-04-13", [], set()),
    ("Social network analysis I", 12, "2026-04-20", ["4a"], {"tidygraph", "manynet", "tidyverse"}),
    ("Social network analysis II", 13, "2026-04-27", ["4b"], {"ggraph", "tidygraph", "visNetwork", "quanteda", "skimr", "sotu", "tidyverse"}),
]
RUN_LOCALLY = {"duke", "ldatuning"}
LIVE_API = {"tuber", "vosonSML", "httpuv", "usethis"}


def _zip_bytes(entries: dict[str, bytes], compression: int = zipfile.ZIP_DEFLATED) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


class CoursePackageTests(ApiTestCase):
    def setUp(self) -> None:
        super().setUp()
        units = [dict(u) for u in course_config.DEFAULT_COURSE["units"]]
        units.append({"id": "apis", "title": "06 · APIs and web data", "goal": "Collect data from web APIs", "status": "upcoming"})
        self.create_course(SRC, units=units)
        self.create_course(DST)
        with self.db() as db:
            testsupport.set_meetings(db, SRC, [{"weekday": 2, "time": "10:00", "durationMinutes": 90}], term_start="2026-09-01")
            self.section = testsupport.make_group(db, SRC, "section", "Sec A", [])
            testsupport.add_roster(db, SRC, "s1", display_name="Ada Chen", kiwi_email="ada@example.edu")
            self.hw = testsupport.publish_work(db, SRC, title="Week 3 HW", unit_id="apis", due_at="2026-09-22T15:59:00+00:00",
                                               audience={"type": "groups", "groupIds": [self.section]})
            self.draft = testsupport.publish_work(db, SRC, kind="practice", title="In-class 1", status="draft")
            testsupport.make_autochecked_submission(db, SRC, "s1", self.hw.id, {"q1": "4", "q2": "x"})
            db.execute("""INSERT INTO policy_versions (class_id, scope, unit_id, group_id, version, config_json, config_hash,
                       created_by, created_by_role, created_at) VALUES (?, 'unit', 'apis', ?, 1, ?, 'h', 'instructor',
                       'instructor', ?)""", (SRC, self.section, json.dumps({"tutoringInstructions": "Be brief."}), dbmod.now()))
            db.execute("""INSERT INTO course_files (id, class_id, scope, unit_id, name, mime, size, sha256, data, created_by,
                       created_at) VALUES ('file-0000000000000001', ?, 'chapter', 'apis', 'tweets.csv', 'text/csv', 4, 'x',
                       ?, 'instructor', ?)""", (SRC, b"a,b\n", dbmod.now()))
            testsupport.publish_work(db, DST, title="Existing DST work")

    def test_round_trip_with_week_shift_drafts_only_and_no_overwrite(self):  # PEOPLE-11, F13, AU-D1-20
        status, raw = self.request(f"/api/teacher/course-package.zip?classId={SRC}", key=TEACHER_KEY)
        self.assertEqual(status, 200, raw)
        archive = zipfile.ZipFile(io.BytesIO(raw))
        names = set(archive.namelist())
        for name in ("manifest.json", "course.json", "assignments.json", "ai_rules.json", "groups.json", "files.json"):
            self.assertIn(name, names)
        self.assertIn("files/file-0000000000000001-tweets.csv", names)
        manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual((manifest["format"], manifest["formatVersion"], manifest["termStart"]),
                         ("css-lab-course-package", 1, "2026-09-01"))
        everything = b"".join(archive.read(n) for n in names)
        for secret in (b"Ada Chen", b"ada@example.edu", b"s1"):
            self.assertNotIn(secret, everything)
        assignments = json.loads(archive.read("assignments.json"))
        hw = next(a for a in assignments if a["title"] == "Week 3 HW")
        self.assertEqual(hw["audience"], {"type": "groups", "groupNames": [["section", "Sec A"]]})
        # termStart 2026-09-01 00:00 Asia/Shanghai = 2026-08-31T16:00:00Z; due 21 days 23:59 later
        self.assertAlmostEqual(hw["dueOffsetDays"], 21 + 1439 / 1440, places=5)
        self.assertEqual(hw["dueAt"], "2026-09-22T15:59:00+00:00")
        payload = {"zipBase64": base64.b64encode(raw).decode(), "mode": "preview", "shiftWeeks": 16}
        status, preview = self.request(f"/api/teacher/course-package/import?classId={DST}", "POST", payload, key=TEACHER_KEY)
        self.assertEqual(status, 200, preview)
        self.assertEqual({c["id"]: c["action"] for c in preview["chapters"]}["apis"], "add")
        self.assertEqual({c["id"]: c["action"] for c in preview["chapters"]}["r-basics"], "skip")
        shifted = next(a for a in preview["assignments"] if a["title"] == "Week 3 HW")
        self.assertEqual((shifted["action"], shifted["dueAt"]), ("add", "2027-01-12T15:59:00+00:00"))
        self.assertEqual(preview["files"], 1)
        with self.db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM assignments WHERE class_id=?", (DST,)).fetchone()[0], 1)
        status, applied = self.request(f"/api/teacher/course-package/import?classId={DST}", "POST",
                                       {**payload, "mode": "apply"}, key=TEACHER_KEY)
        self.assertEqual(status, 200, applied)
        with self.db() as db:
            rows = [dict(r) for r in db.execute("SELECT * FROM assignments WHERE class_id=? ORDER BY created_at", (DST,))]
            self.assertEqual(len(rows), 3)
            existing = rows[0]
            self.assertEqual((existing["title"], existing["status"]), ("Existing DST work", "published"))
            imported = {r["title"]: r for r in rows[1:]}
            self.assertEqual({r["status"] for r in imported.values()}, {"draft"})
            self.assertEqual(imported["Week 3 HW"]["due_at"], "2027-01-12T15:59:00+00:00")
            self.assertNotIn(imported["Week 3 HW"]["id"], (self.hw.id, self.draft.id))
            group = db.execute("SELECT id FROM course_groups WHERE class_id=? AND name='Sec A'", (DST,)).fetchone()
            self.assertEqual(json.loads(imported["Week 3 HW"]["audience_json"]), {"type": "groups", "groupIds": [group["id"]]})
            policy = db.execute("SELECT * FROM policy_versions WHERE class_id=?", (DST,)).fetchone()
            self.assertEqual((policy["created_by"], policy["unit_id"], policy["group_id"]), ("import", "apis", group["id"]))
            course = course_config.course_for(DST, db)
            self.assertIn("apis", [u["id"] for u in course["units"]])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM course_files WHERE class_id=? AND unit_id='apis'", (DST,)).fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM submissions WHERE class_id=?", (DST,)).fetchone()[0], 0)
            self.assertIsNotNone(db.execute("SELECT 1 FROM teacher_actions WHERE action='course_package_import'").fetchone())
        status, again = self.request(f"/api/teacher/course-package/import?classId={DST}", "POST", payload, key=TEACHER_KEY)
        self.assertEqual({c["id"]: c["action"] for c in again["chapters"]}["apis"], "skip")

    def test_zip_safety_limits(self):  # §6.8 zip safety
        manifest = json.dumps({"format": "css-lab-course-package", "formatVersion": 1}).encode()
        cases = {
            "traversal": _zip_bytes({"manifest.json": manifest, "../evil.json": b"{}"}),
            "absolute": _zip_bytes({"manifest.json": manifest, "/etc/passwd": b"x"}),
            "too many": _zip_bytes({"manifest.json": manifest, **{f"files/f{i}.txt": b"x" for i in range(201)}}),
            "ratio": _zip_bytes({"manifest.json": manifest, "files/zeros.txt": b"0" * 2_000_000}),
            "bad manifest": _zip_bytes({"manifest.json": b'{"format": "other"}'}),
            "weird name": _zip_bytes({"manifest.json": manifest, "files/a b.txt": b"x"}),
        }
        for label, data in cases.items():
            with self.subTest(label):
                status, body = self.request(f"/api/teacher/course-package/import?classId={DST}", "POST",
                                            {"zipBase64": base64.b64encode(data).decode(), "mode": "preview"}, key=TEACHER_KEY)
                self.assertEqual((status, body["code"]), (400, "invalid_request"), body)
        for body in ({"zipBase64": "!!!", "mode": "preview"}, {"mode": "preview"},
                     {"zipBase64": "", "templateKey": TEMPLATE, "mode": "preview"},
                     {"templateKey": TEMPLATE, "mode": "maybe"}, {"templateKey": "nope", "mode": "preview"},
                     {"templateKey": TEMPLATE, "mode": "preview", "shiftWeeks": 99}):
            status, error = self.request(f"/api/teacher/course-package/import?classId={DST}", "POST", body, key=TEACHER_KEY)
            self.assertEqual(status, 400, body)

    def test_template_preview_and_apply(self):  # PEOPLE-21, F07, F11, F13, decision D4
        status, templates = self.request(f"/api/teacher/course-templates?classId={DST}", key=TEACHER_KEY)
        self.assertEqual(status, 200, templates)
        self.assertEqual([t["key"] for t in templates], [TEMPLATE])
        template = templates[0]
        self.assertEqual(template["chapters"], 12)
        self.assertIn("SOCS-SH 190", template["title"])
        self.assertIn("Spring 2026", template["title"])
        body = {"templateKey": TEMPLATE, "mode": "preview", "archiveUnreferencedDefaults": True}
        status, preview = self.request(f"/api/teacher/course-package/import?classId={DST}", "POST", body, key=TEACHER_KEY)
        self.assertEqual(status, 200, preview)
        added = [c for c in preview["chapters"] if c["action"] == "add"]
        self.assertEqual(len(added), 12)
        for chapter, (title, week, _, sessions, _) in zip(added, D4_TABLE):
            self.assertTrue(chapter["title"].endswith(title), chapter["title"])
            notes = " ".join(chapter["notes"])
            for session in sessions:
                self.assertIn(f"R session {session} ", notes)
            if not sessions:
                self.assertIn("No R session", notes)
        notes = {c["title"]: " ".join(c["notes"]) for c in added}
        self.assertIn("Run locally", notes[added[4]["title"]])
        self.assertIn("duke", notes[added[4]["title"]])
        self.assertIn("ldatuning", notes[added[7]["title"]])
        self.assertIn("use the provided data file", notes[added[3]["title"]])
        # D4 correction: only chapter 5's 2d pairing is inferred; the others quote the slides' schedule.
        self.assertIn("inferred", notes[added[4]["title"]])
        self.assertNotIn("inferred", notes[added[1]["title"]])
        self.assertIn("Slides (Week 3)", notes[added[1]["title"]])
        self.assertIn("Slides (Week 10)", notes[added[8]["title"]])
        archived = {c["id"] for c in preview["chapters"] if c["action"] == "archive"}
        self.assertNotIn("r-basics", archived)  # referenced by the existing DST assignment
        self.assertTrue(archived)
        self.assertEqual(preview["assignments"], [])
        status, applied = self.request(f"/api/teacher/course-package/import?classId={DST}", "POST", {**body, "mode": "apply"},
                                       key=TEACHER_KEY)
        self.assertEqual(status, 200, applied)
        with self.db() as db:
            course = course_config.course_for(DST, db)
            units = {u["id"]: u for u in course["units"]}
            self.assertEqual(units["r-basics"]["access"], "default")
            for unit_id in archived:
                self.assertEqual(units[unit_id]["access"], "hidden")
            new_units = [u for u in course["units"] if u["id"] in {c["id"] for c in added}]
            self.assertEqual(len(new_units), 12)
            for unit, (title, week, starts_on, _, packages) in zip(new_units, D4_TABLE):
                self.assertEqual((unit["week"], unit["startsOn"]), (week, starts_on), unit["title"])
                self.assertTrue(set(unit["runtime"]["packages"]) <= set(WEBR_PACKAGE_ALLOWLIST))
                self.assertEqual(set(unit["runtime"]["packages"]), packages - RUN_LOCALLY, unit["title"])
                self.assertTrue(1 <= len(unit["goal"]) <= 200, unit["goal"])
            hints = {u["title"]: " ".join(h["match"] + " " + h["hint"] for h in u["runtime"]["errorHints"]) for u in new_units}
            self.assertIn("duke", hints[new_units[4]["title"]])
            self.assertIn("ldatuning", hints[new_units[7]["title"]])
            self.assertIn("YT_scraped_Data.RData", hints[new_units[3]["title"]])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM assignments WHERE class_id=?", (DST,)).fetchone()[0], 1)

    def test_template_matches_the_d4_table_and_flags_non_webr_packages(self):  # decision D4
        from server import course_package

        template = course_package.load_template(TEMPLATE)
        self.assertEqual(template["manifest"]["termStart"], "2026-01-19")
        units = template["course"]["units"]
        self.assertEqual(len(units), 12)
        for unit, (title, week, starts_on, sessions, packages) in zip(units, D4_TABLE):
            with self.subTest(title):
                self.assertTrue(unit["title"].endswith(title))
                self.assertEqual((unit["week"], unit["startsOn"]), (week, starts_on))
                self.assertEqual([s["id"] for s in unit["rSessions"]], sessions)
                self.assertEqual(set(unit["runtime"]["packages"]) | set(unit.get("runLocally", [])), packages)
                self.assertEqual(set(unit.get("runLocally", [])), packages & RUN_LOCALLY)
                self.assertEqual(set(unit.get("liveApi", [])), packages & LIVE_API)
                self.assertIn(unit["pairing"], ("slides", "inferred", "none"))
        self.assertEqual(course_config.validate_course({"title": "T", "currentUnitId": units[0]["id"], "units": units})["units"][0]
                         ["runtime"]["packages"], units[0]["runtime"]["packages"])

    def test_template_dates_shift_with_weeks_and_term_start(self):  # decision D4: "shifted by the course-package date shift"
        body = {"templateKey": TEMPLATE, "mode": "apply", "shiftWeeks": 1}
        status, applied = self.request(f"/api/teacher/course-package/import?classId={DST}", "POST", body, key=TEACHER_KEY)
        self.assertEqual(status, 200, applied)
        self.create_course("next-term")
        with self.db() as db:
            testsupport.set_meetings(db, "next-term", [{"weekday": 1, "time": "10:00", "durationMinutes": 75}],
                                     term_start="2027-01-18")
        status, applied = self.request("/api/teacher/course-package/import?classId=next-term", "POST",
                                       {"templateKey": TEMPLATE, "mode": "apply"}, key=TEACHER_KEY)
        self.assertEqual(status, 200, applied)
        with self.db() as db:
            shifted = [u["startsOn"] for u in course_config.course_for(DST, db)["units"] if u["startsOn"]]
            next_term = [u["startsOn"] for u in course_config.course_for("next-term", db)["units"] if u["startsOn"]]
        self.assertEqual((shifted[0], shifted[-1]), ("2026-01-26", "2026-05-04"))
        self.assertEqual((next_term[0], next_term[1], next_term[-1]), ("2027-01-18", "2027-02-01", "2027-04-26"))

    def test_only_instructors_use_course_packages(self):  # §6.8 permissions
        _, ta = self.request(f"/api/teacher/staff?classId={SRC}", "POST", {"displayName": "TA", "role": "ta"}, key=TEACHER_KEY)
        self.assertEqual(self.request(f"/api/teacher/course-package.zip?classId={SRC}", key=ta["key"])[0], 403)
        self.assertEqual(self.request(f"/api/teacher/course-templates?classId={SRC}", key=ta["key"])[0], 403)


if __name__ == "__main__":
    unittest.main()
