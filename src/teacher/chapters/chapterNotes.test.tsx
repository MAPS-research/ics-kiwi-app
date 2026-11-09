import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { STUDENT_VIEW_SAVE_ERROR } from "../../lib/course";
import { ChapterCardView, chaptersDirty, chaptersSaveInput, templateSummary } from "./ChaptersPage";
import type { Course, Unit } from "../../types";

/*
 * S-M05 / R-B01 on the Chapters page: template notes and metadata are shown read-only (editing the notes is an explicit
 * step), removed chapters are named in the save, and a student view of the course is never saved.
 */

const decode = (html: string) => html.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const render = (el: ReactElement) => decode(renderToStaticMarkup(el));
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
const noop = () => undefined;

const unit = (id: string, over: Partial<Unit> = {}): Unit => ({
  id, title: id, goal: `Goal ${id}`, status: "current", access: "default", effectiveAccess: "open", week: 6, startsOn: null,
  runtime: { packages: [], datasetFileIds: [], timeoutSeconds: 12, errorHints: [] }, notes: "", ...over,
});
const TEMPLATE_UNIT = unit("css190-05-experiments", {
  notes: "R session 2d · Data Linkage (2d. Data linkage.qmd).\nPairing 2d with “a revisit” is inferred.\nR Ex. 2 assigned (Mar 5).",
  rSessions: [{ id: "2d", title: "Data Linkage", file: "2d. Data linkage.qmd" }, { id: "2e", title: "Visualization", file: "2e. Visualization.qmd" }],
  pairing: "inferred", runLocally: ["duke"], liveApi: [],
});
const course = (units: Unit[], view: Course["view"] = "staff"): Course => ({
  title: "CSS", description: "", currentUnitId: units[0].id, freePracticeScope: "current_and_earlier", linked: false,
  updatedAt: "2026-10-23T00:00:00+00:00", units, view,
});
const card = (u: Unit, readOnly = false) =>
  render(
    <ChapterCardView unit={u} index={0} total={2} course={course([u])} summary={null} readOnly={readOnly} busy={false} onUnit={noop} onMove={noop}
      onRemove={noop} onToggleAiReference={noop} onUpload={noop} />,
  );

describe("chapter notes are shown read-only (S-M05)", () => {
  it("lists every template note line and the template metadata without an edit box", () => {
    const html = card(TEMPLATE_UNIT);
    expect(html).toContain("Chapter notes");
    expect(html).toContain("<li>R session 2d · Data Linkage (2d. Data linkage.qmd).</li>");
    expect(html).toContain("<li>R Ex. 2 assigned (Mar 5).</li>");
    expect(html).toContain("R sessions: 2d · Data Linkage, 2e · Visualization");
    expect(html).toContain("R-session pairing inferred");
    expect(html).toContain("Run locally: duke");
    expect(html).not.toContain("<textarea");
    expect(buttons(html)).toContain("Edit notes");
  });
  it("offers no edit button without manageCourse, and says when a chapter has no notes", () => {
    expect(buttons(card(TEMPLATE_UNIT, true))).not.toContain("Edit notes");
    const empty = card(unit("u1"));
    expect(empty).toContain("No chapter notes yet.");
    expect(buttons(empty)).toContain("Add notes");
    expect(empty).not.toContain("From the course template");
  });
  it("summarizes the template metadata", () => {
    expect(templateSummary(TEMPLATE_UNIT)).toEqual(["R sessions: 2d · Data Linkage, 2e · Visualization", "Run locally: duke"]);
    expect(templateSummary(unit("x", { pairing: "none", rSessions: [], liveApi: ["tuber", "httpuv"] }))).toEqual(["Live API steps (use the provided data): tuber, httpuv"]);
    expect(templateSummary(unit("y"))).toEqual([]);
  });
});

describe("Save chapters (R-B01)", () => {
  const hidden = unit("archived", { access: "hidden", effectiveAccess: "hidden", notes: "kept" });
  const saved = course([TEMPLATE_UNIT, unit("u2", { status: "upcoming" }), hidden]);
  it("names removed chapters and never sends template metadata", () => {
    const draft = { ...saved, units: saved.units.filter((u) => u.id !== "archived") };
    const body = chaptersSaveInput(draft, saved);
    expect(body.removeUnitIds).toEqual(["archived"]);
    expect(body.units.map((u) => u.id)).toEqual(["css190-05-experiments", "u2"]);
    expect(body.units[0].notes).toBe(TEMPLATE_UNIT.notes);
    expect("pairing" in body.units[0]).toBe(false);
    expect(chaptersSaveInput(saved, saved).removeUnitIds).toEqual([]);
  });
  it("refuses a student view and still compares drafts of one", () => {
    const student = course([TEMPLATE_UNIT], "student");
    expect(() => chaptersSaveInput(student, student)).toThrow(STUDENT_VIEW_SAVE_ERROR);
    expect(chaptersDirty(student, student)).toBe(false);
  });
});
