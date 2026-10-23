import { describe, expect, it } from "vitest";
import { cellAriaLabel, cellHref, cellMuted, cellText, cellTone, inClassText, parsePolicy, POLICY_OPTIONS } from "./gradebookCells";
import type { GradebookCell } from "../../types";

const cell = (over: Partial<GradebookCell>): GradebookCell => ({
  assignmentId: "work-1", state: "not_submitted", score: null, maxPoints: 20, attempts: 0, late: false, lateSeconds: 0, overTime: false,
  latestSubmissionId: null, scoredSubmissionId: null, draftAnswered: 0, draftTotal: 3, label: "Not started", ...over,
});

describe("gradebook cells (GRADE-06, GRADE-11, NM18)", () => {
  it("maps every state to a semantic tone", () => {
    expect(cellTone("released")).toBe("success");
    expect(cellTone("draft")).toBe("info");
    expect(cellTone("submitted_ungraded")).toBe("warning");
    expect(cellTone("newer_ungraded")).toBe("warning");
    expect(cellTone("missing")).toBe("danger");
    expect(cellTone("not_due")).toBe("neutral");
    expect(cellTone("not_submitted")).toBe("neutral");
  });
  it("prefixes released cells so cards, gradebook and timeline all read Released 17/20", () => {
    expect(cellText(cell({ state: "released", label: "17/20 · 1 submission" }))).toBe("Released 17/20 · 1 submission");
    expect(cellText(cell({ state: "draft", label: "Draft 17/20" }))).toBe("Draft 17/20");
    expect(cellText(cell({ state: "missing", label: "Missing · started (2/3 answered)" }))).toBe("Missing · started (2/3 answered)");
  });
  it("mutes not-due and not-started cells without a draft", () => {
    expect(cellMuted(cell({ state: "not_due", label: "Not due yet" }))).toBe(true);
    expect(cellMuted(cell({ state: "not_due", label: "Not due yet · started", draftAnswered: 1 }))).toBe(false);
    expect(cellMuted(cell({ state: "missing", label: "Missing" }))).toBe(false);
  });
  it("links graders to the grading card and everyone else to the timeline", () => {
    const graded = cell({ state: "released", latestSubmissionId: "sub-2", scoredSubmissionId: "sub-1" });
    expect(cellHref(graded, "s 1", true)).toBe("/teacher/grading?assignmentId=work-1&studentId=s+1&submissionId=sub-1&show=all");
    expect(cellHref(graded, "s1", false)).toBe("/teacher/students/s/s1/assignments/work-1");
    expect(cellHref(cell({ state: "missing" }), "s1", true)).toBe("/teacher/students/s/s1/assignments/work-1");
  });
  it("gives cell links a readable name", () => {
    expect(cellAriaLabel("Ada Chen", "Week 3 HW (20 pts) · Due 10/24", cell({ state: "missing", label: "Missing", late: false })))
      .toBe("Ada Chen · Week 3 HW (20 pts) · Due 10/24: Missing");
    expect(cellAriaLabel("Ada", "HW", cell({ state: "released", label: "18/20 · 1 submission", late: true }))).toBe("Ada · HW: Released 18/20 · 1 submission · Late");
  });
  it("words in-class columns and the score policy", () => {
    expect(inClassText({ completionPct: 100, accuracyPct: 50 })).toBe("100% done · Correct eventually 50%");
    // RV6-M03 / RT-02: question-level wording and labels shared with Exercise results and the Assignments row
    expect(inClassText({ completionPct: 100, accuracyPct: 100, correctFirstTryPct: 0 })).toBe("100% done · Correct eventually 100% · First try correct 0%");
    expect(inClassText({ completionPct: 0, accuracyPct: null })).toBe("Not started");
    expect(inClassText({ completionPct: 50, accuracyPct: null })).toBe("50% done");
    expect(POLICY_OPTIONS.map((p) => p.label)).toEqual(["Latest", "Highest"]);
    expect(parsePolicy("highest")).toBe("highest");
    expect(parsePolicy(null)).toBe("latest");
  });
});
