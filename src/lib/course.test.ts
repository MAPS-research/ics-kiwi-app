import { describe, expect, it } from "vitest";
import { newUnit, normalizeCourse, removedUnitIds, STUDENT_VIEW_SAVE_ERROR, toCourseInput } from "./course";

describe("course v2 helpers", () => {
  it("fills v2 defaults for a v0.5.1 course", () => {
    const course = normalizeCourse({
      title: "CSS", description: "", currentUnitId: "u2",
      units: [{ id: "u1", title: "A", goal: "g", status: "completed" }, { id: "u2", title: "B", goal: "g", status: "current" }, { id: "u3", title: "C", goal: "g", status: "upcoming" }],
    });
    expect(course.freePracticeScope).toBe("current_and_earlier");
    expect(course.linked).toBe(false);
    expect(course.units.map((u) => u.effectiveAccess)).toEqual(["open", "open", "locked"]);
    expect(course.units[0]).toMatchObject({ access: "default", week: null, startsOn: null, runtime: { packages: [], timeoutSeconds: 12 } });
  });
  it("keeps v2 values and rejects non-objects", () => {
    const course = normalizeCourse({ title: "T", description: "d", currentUnitId: "u", freePracticeScope: "all", linked: true, updatedAt: "2026-10-22T00:00:00Z",
      units: [{ id: "u", title: "U", goal: "g", status: "current", access: "review", effectiveAccess: "review", week: 3, startsOn: "2026-10-19", runtime: { packages: ["dplyr"], datasetFileIds: [], timeoutSeconds: 30, errorHints: [] } }] });
    expect(course.units[0]).toMatchObject({ access: "review", week: 3, runtime: { packages: ["dplyr"], timeoutSeconds: 30 } });
    expect(() => normalizeCourse(null)).toThrow();
  });
  it("builds the PUT body with baseUpdatedAt and without read-only fields", () => {
    const course = normalizeCourse({ title: "T", currentUnitId: "u", updatedAt: "2026-10-22T00:00:00Z", linked: true, units: [{ id: "u", title: "U", goal: "g", status: "current" }] });
    const input = toCourseInput(course);
    expect(input.baseUpdatedAt).toBe("2026-10-22T00:00:00Z");
    expect("linked" in input).toBe(false);
    expect("effectiveAccess" in input.units[0]).toBe(false);
    expect(newUnit()).toMatchObject({ status: "upcoming", access: "default", effectiveAccess: "locked" });
  });
  it("keeps the view and the template metadata, and never sends the metadata back (R-B01, S-M05)", () => {
    const course = normalizeCourse({ title: "T", currentUnitId: "u", view: "staff", units: [{ id: "u", title: "U", goal: "g", status: "current", notes: "R session 2d",
      rSessions: [{ id: "2d", title: "Data Linkage", file: "2d. Data linkage.qmd" }, { id: 3 }], pairing: "inferred", runLocally: ["duke", 4], liveApi: [] }] });
    expect(course.view).toBe("staff");
    expect(course.units[0]).toMatchObject({ notes: "R session 2d", rSessions: [{ id: "2d", title: "Data Linkage", file: "2d. Data linkage.qmd" }], pairing: "inferred", runLocally: ["duke"], liveApi: [] });
    const unit = toCourseInput(course).units[0] as Record<string, unknown>;
    for (const key of ["rSessions", "pairing", "runLocally", "liveApi"]) expect(key in unit, key).toBe(false);
    expect(unit.notes).toBe("R session 2d");
    expect(normalizeCourse({ title: "T", currentUnitId: "u", view: "other", units: [{ id: "u", pairing: "guess" }] })).not.toHaveProperty("view");
    expect(normalizeCourse({ title: "T", currentUnitId: "u", units: [{ id: "u", pairing: "guess" }] }).units[0]).not.toHaveProperty("pairing");
  });
  it("refuses to build a save from the student view of the course (R-B01)", () => {
    const student = normalizeCourse({ title: "T", currentUnitId: "u", view: "student", units: [{ id: "u", title: "U", goal: "g", status: "current" }] });
    expect(() => toCourseInput(student)).toThrow(STUDENT_VIEW_SAVE_ERROR);
    const legacy = normalizeCourse({ title: "T", currentUnitId: "u", units: [{ id: "u", title: "U", goal: "g", status: "current" }] });
    expect(toCourseInput(legacy).units).toHaveLength(1);   // a v0.5.1 server sends no view
  });
  it("names removed chapters explicitly (R-B01)", () => {
    const saved = normalizeCourse({ title: "T", currentUnitId: "a", view: "staff", units: [{ id: "a" }, { id: "h", access: "hidden" }, { id: "b" }] });
    const draft = { ...saved, units: saved.units.filter((u) => u.id !== "h") };
    expect(removedUnitIds(saved, draft)).toEqual(["h"]);
    expect(removedUnitIds(saved, saved)).toEqual([]);
    expect(toCourseInput(draft, { removeUnitIds: ["h"] }).removeUnitIds).toEqual(["h"]);
    expect("removeUnitIds" in toCourseInput(draft)).toBe(false);
  });
});
