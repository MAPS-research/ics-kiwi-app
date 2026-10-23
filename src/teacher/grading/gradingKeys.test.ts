import { describe, expect, it } from "vitest";
import {
  adjustmentLine, askKiwiLine, autoCheckLine, cardContext, cardControlLabel, cardLabel, cardStatus, commentFieldLabel, commentInputLabel, computeTotal, draftErrors,
  draftFromDetail, draftToInput, draftTotal, feedbackInputLabel, gradingTabCounts, firstOpenQuestion, gradedByLine, historyLine,
  isSaveAndNextShortcut, isTotalOnly, keepUnsavedDrafts, nextUngradedId, pageOf, parseScore, parseShow, primaryAction, primaryActionLabel,
  readyToReleaseLabel, releaseButtonLabel, removedPenalty, scoreInputLabel, SHOW_OPTIONS, toGradeTitle, type CardDraft,
} from "./gradingKeys";
import { detailFixture, gradeEvent as event } from "./gradingFixtures";

describe("accessible names (GRADE-07, NM15, NM14, SB-m06)", () => {
  const who = { studentLabel: "Ada Chen", assignmentTitle: "Week 3 HW", attempt: 1 };
  it("names the score input after the student, homework, attempt and question", () => {
    expect(scoreInputLabel({ ...who, questionIndex: 2 })).toBe("Score for Ada Chen, Week 3 HW, attempt 1, question 2");
    expect(scoreInputLabel({ ...who, assignmentTitle: "Files HW", questionIndex: 2 })).not.toBe(scoreInputLabel({ ...who, questionIndex: 2 }));
  });
  it("names comments, feedback and card buttons without ids", () => {
    expect(commentFieldLabel(1)).toBe("Comment on Q1");
    expect(commentInputLabel({ ...who, attempt: 2, questionIndex: 1 })).toBe("Comment on Q1 for Ada Chen, Week 3 HW, attempt 2");
    expect(feedbackInputLabel(who)).toBe("Feedback to Ada Chen, Week 3 HW, attempt 1 (visible after release)");
    expect(cardContext(who)).toBe("Ada Chen, Week 3 HW, attempt 1");
    expect(cardControlLabel("Save draft", who)).toBe("Save draft — Ada Chen, Week 3 HW, attempt 1");
    expect(cardLabel(who)).toBe("Ada Chen · Week 3 HW · attempt 1");
  });
});

describe("queue labels", () => {
  it("shows the live count in the title and the five Show options (NM12, NM13)", () => {
    expect(toGradeTitle(12)).toBe("To grade (12)");
    expect(toGradeTitle(undefined)).toBe("To grade");
    expect(SHOW_OPTIONS.map((o) => o.label)).toEqual(["Latest attempts to grade", "All attempts", "Graded", "Late", "Flagged"]);
    expect(parseShow("flagged")).toBe("flagged");
    expect(parseShow("nonsense")).toBe("latest");
  });
  it("describes auto-check results", () => {
    expect(autoCheckLine({ autoCorrect: true, autoScore: 10, points: 10 })).toBe("Auto-checked ✓ 10/10");
    expect(autoCheckLine({ autoCorrect: false, autoScore: 0, points: 10 })).toBe("Auto-checked ✗ 0/10");
    expect(autoCheckLine({ autoCorrect: null, autoScore: null, points: 10 })).toBe("Needs review");
  });
  it("labels card states Needs grading → Draft → Released (NM16)", () => {
    expect(cardStatus({ total: null, maxPoints: 20, submission: { gradeStatus: "ungraded" } })).toEqual({ label: "Needs grading", tone: "warning" });
    expect(cardStatus({ total: 16, maxPoints: 20, submission: { gradeStatus: "draft" } })).toEqual({ label: "Draft 16/20", tone: "info" });
    expect(cardStatus({ total: 16.5, maxPoints: 20, submission: { gradeStatus: "released" } }).label).toBe("Released 16.5/20");
  });
  it("summarizes help and process", () => {
    expect(askKiwiLine({ askKiwiMode: "hints_only", aiQuestions: 2 })).toBe("Ask Kiwi: hints only · 2 questions asked");
    expect(askKiwiLine({ askKiwiMode: "off", aiQuestions: 1 })).toBe("Ask Kiwi: off · 1 question asked");
  });
});

describe("scores, totals and the late penalty (GRADE-14)", () => {
  it("parses scores within the question's points", () => {
    expect(parseScore("", 10)).toEqual({ value: null, error: "" });
    expect(parseScore("7.5", 10)).toEqual({ value: 7.5, error: "" });
    expect(parseScore("11", 10).error).toBe("Enter 0 to 10");
    expect(parseScore("abc", 10).error).toBe("Enter 0 to 10");
  });
  it("totals scores plus adjustment, clamped, and null while incomplete", () => {
    expect(computeTotal([10, 10], -4, 20)).toBe(16);
    expect(computeTotal([10, null], 0, 20)).toBeNull();
    expect(computeTotal([1, 1], -5, 20)).toBe(0);
    expect(computeTotal([], 0, 20)).toBeNull();
  });
  it("words the adjustment line and the removal", () => {
    expect(adjustmentLine({ points: -2, reason: "Late penalty (auto)", auto: true })).toBe("Late penalty −2 (auto)");
    expect(adjustmentLine({ points: -1.5, reason: "Format", auto: false })).toBe("Format −1.5");
    expect(adjustmentLine({ points: 0, reason: "Late penalty removed" })).toBe("");
    // S-M04: the card names the counted (started) days
    expect(adjustmentLine({ points: -4, reason: "Late penalty (auto)", auto: true }, { lateSeconds: 24 * 3600 + 57 * 60, penaltyPctPerDay: 10 }))
      .toBe("Late penalty −4 (auto: 2 started days × 10%)");
    expect(adjustmentLine({ points: -2, reason: "Late penalty (auto)", auto: true }, { lateSeconds: 3600, penaltyPctPerDay: 10 }))
      .toBe("Late penalty −2 (auto: 1 started day × 10%)");
    expect(removedPenalty()).toEqual({ points: 0, reason: "Late penalty removed", auto: false });
  });
});

describe("actions and history", () => {
  it("uses Save & release only for immediately-visible grades with release permission (GRADE-05)", () => {
    expect(primaryAction("immediately", true)).toBe("release");
    expect(primaryAction("immediately", false)).toBe("save");
    expect(primaryAction("on_release", true)).toBe("save");
    expect(primaryActionLabel("release")).toBe("Save & release");
    expect(primaryActionLabel("save")).toBe("Save draft");
  });
  it("shows the stored grader label, never an id (GRADE-04)", () => {
    const history = [event({ action: "autocheck", actorLabel: "Auto-check", actorRole: "system" }), event({ actorLabel: "Wang", actorRole: "ta" })];
    expect(gradedByLine(history, "Asia/Shanghai")).toBe("Graded by Wang (TA) · 10/22 09:10");
    expect(gradedByLine([event({ actorLabel: "Wang (TA)" })], "Asia/Shanghai")).toBe("Graded by Wang (TA) · 10/22 09:10");
    expect(gradedByLine([event({ action: "autocheck" })])).toBeNull();
    // S-m06: a card that still needs grading was only saved
    expect(gradedByLine([event({ actorLabel: "Wang (TA)" })], "Asia/Shanghai", "ungraded")).toBe("Last saved by Wang (TA) · 10/22 09:10");
    expect(historyLine(event({ action: "release", actorLabel: "Instructor (local key)", actorRole: "instructor", totalAfter: 17 }), "UTC"))
      .toBe("10/22 01:10 · Instructor (local key) · Released · 17");
  });
  it("finds the next ungraded card and its page (Save & next)", () => {
    const order = ["a", "b", "c", "d"];
    expect(nextUngradedId(order, "b", new Set(["b"]))).toBe("c");
    expect(nextUngradedId(order, "d", new Set(["d", "a"]))).toBe("b");
    expect(nextUngradedId(order, "a", new Set(order))).toBeNull();
    expect(nextUngradedId(order, "zzz", new Set())).toBe("a");
    expect(pageOf(Array.from({ length: 25 }, (_, i) => `s${i}`), "s12")).toBe(2);
    expect(pageOf(order, "x")).toBeNull();
  });
  it("binds Ctrl/⌘+Enter to Save & next", () => {
    expect(isSaveAndNextShortcut({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(isSaveAndNextShortcut({ key: "Enter", metaKey: true })).toBe(true);
    expect(isSaveAndNextShortcut({ key: "Enter" })).toBe(false);
    expect(isSaveAndNextShortcut({ key: "s", ctrlKey: true })).toBe(false);
  });
  it("labels release controls (GRADE-12)", () => {
    expect(releaseButtonLabel(58, 60)).toBe("Release grades (58/60 graded)");
    expect(readyToReleaseLabel(12)).toBe("Ready to release 12");
  });
});

describe("card draft state", () => {
  it("round-trips a detail into a GradeInput with the base grade event", () => {
    const detail = detailFixture();
    const draft = draftFromDetail(detail);
    expect(draft.items.q1).toEqual({ score: "10", comment: "" });
    expect(draftTotal(draft, detail)).toBeNull();
    draft.items.q2 = { score: "7", comment: "Mention the type." };
    draft.feedback = "Good work.";
    expect(draftTotal(draft, detail)).toBe(17);
    expect(draftToInput(draft, detail, "save")).toEqual({
      items: { q1: { score: 10, comment: "" }, q2: { score: 7, comment: "Mention the type." } },
      feedback: "Good work.", adjustment: { points: 0, reason: "", auto: false }, action: "save", baseGradeEventId: 7,
    });
    draft.items.q2.score = "12";
    expect(draftErrors(draft, detail)).toEqual({ q2: "Enter 0 to 10" });
    expect(draftTotal(draft, detail)).toBeNull();
  });
  it("opens the first unscored question and recognizes total-only legacy grades", () => {
    const detail = detailFixture();
    expect(firstOpenQuestion(detail.items)).toBe("q2");
    expect(firstOpenQuestion(detail.items.map((i) => ({ ...i, score: 1 })))).toBeNull();
    const legacy = detailFixture({ total: 18, items: detail.items.map((i) => ({ ...i, score: null, autoCorrect: null })),
      submission: { ...detail.submission, gradeStatus: "released", grade: 18 } });
    expect(isTotalOnly(legacy)).toBe(true);
    expect(isTotalOnly(detail)).toBe(false);
  });
});

describe("gradingTabCounts (NM12, CR-GRADE-1; INTEGRATION)", () => {
  it("puts the live count on the To grade tab only once it is known", () => {
    expect(gradingTabCounts(12)).toEqual({ "/teacher/grading": 12 });
    expect(gradingTabCounts(0)).toEqual({ "/teacher/grading": 0 });
    expect(gradingTabCounts(undefined)).toBeUndefined();
    expect(gradingTabCounts(null)).toBeUndefined();
  });
});


describe("SB-M05: unsaved scores survive a queue reload", () => {
  const draft = (score: string): CardDraft => ({ items: { q1: { score, comment: "" } }, feedback: "", adjustment: { points: 0, reason: "", auto: false } });
  it("keeps typed scores on other cards and takes the server version for the saved card", () => {
    const base = { del: draft(""), ada: draft("") };
    const prev = { del: draft("8"), ada: draft("6") };
    const fresh = { del: draft("8"), ada: draft("") };
    const merged = keepUnsavedDrafts(prev, base, fresh, new Set(["del"]));
    expect(merged.ada.items.q1.score).toBe("6");
    expect(merged.del.items.q1.score).toBe("8");
  });
  it("takes the server version for untouched cards and keeps typed cards that left the page", () => {
    const base = { a: draft("3"), b: draft("") };
    const merged = keepUnsavedDrafts({ a: draft("3"), b: draft("5") }, base, { a: draft("4") }, new Set());
    expect(merged).toEqual({ a: draft("4"), b: draft("5") });
    expect(keepUnsavedDrafts({ a: draft("9") }, base, { a: draft("4") }, new Set(["a"]))).toEqual({ a: draft("4") });
  });
});
