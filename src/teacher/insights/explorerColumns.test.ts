import { describe, expect, it } from "vitest";
import {
  activityExportQuery, answersQuery, columnLabels, columnPreset, drillDown, explorerApiQuery, explorerChips, explorerGroup, removedValue,
  storeColumnPreset, TEACHING_COLUMNS,
} from "./explorerColumns";
import type { AnalyticsRow } from "../../types";

/* INSIGHTS-11/12/23 [FD02, FD06, LY02, TH10]: exact Teaching presets per group, Research additions, chips and queries. */

const row = (extra: Partial<AnalyticsRow>): AnalyticsRow => ({
  lastActive: null, interactions: 0, attempts: 0, checked: 0, correct: 0, codeRuns: 0, codeErrors: 0, codeSuccesses: 0, aiQuestions: 0,
  students: 0, sessions: 0, accuracy: null, averageAttempts: 0, averageQuestions: 0, ...extra,
});

describe("Teaching column preset (§13.4 table)", () => {
  it.each([
    ["students", ["Student", "Last learning action", "Last seen", "Attempts", "Auto-checked accuracy (your questions)", "AI tutor questions (incl. hints)", "Missing work"]],
    ["chapters", ["Chapter", "Students", "Attempts", "Auto-checked accuracy (your questions)", "Similar practice accuracy (AI)", "AI tutor questions (incl. hints)"]],
    ["assignments", ["Assignment", "Submitted (whole term)", "Homework avg score", "Auto-checked accuracy (your questions)", "Similar practice accuracy (AI)", "Last seen"]],
    ["questions", ["Question", "Origin", "Students", "First try correct %", "Attempts", "AI tutor questions (incl. hints)"]],
    ["reading", ["Material", "Chapter", "Students", "Views", "Kiwi lecture AI questions", "Last seen"]],
    ["question-activities", ["Student", "Question", "Started", "Active minutes", "Attempts", "Result"]],
  ] as const)("%s has exactly its teaching columns", (group, labels) => {
    expect(columnLabels(group, "teaching")).toEqual(labels);
    // K-m01: Students shows both named stamps (Last learning action and Last seen); every other group keeps six
    expect(TEACHING_COLUMNS[group]).toHaveLength(group === "students" ? 7 : 6);
  });
  it("K-m01: no column is called 'Last activity'; each names its definition and sorts by it", () => {
    for (const group of ["students", "chapters", "assignments", "questions", "reading", "question-activities", "study-sessions"] as const) {
      expect(columnLabels(group, "teaching")).not.toContain("Last activity");
      expect(columnLabels(group, "research")).not.toContain("Last activity");
    }
    const [learned, seen] = ["lastLearningAction", "lastActive"].map((key) => TEACHING_COLUMNS.students.find((c) => c.key === key)!);
    expect([learned.label, learned.sort, seen.label, seen.sort]).toEqual(["Last learning action", "lastLearningAction", "Last seen", "lastActive"]);
    expect([learned.stamp, seen.stamp]).toEqual([true, true]);   // date cells wrap so seven columns fit at 1280
    const ctx = { course: null, assignmentTitle: (id: string) => id };
    expect(learned.cell(row({ lastActive: "2026-10-23T12:58:00Z", lastLearningAction: null }), ctx)).toBe("None yet");
    expect(learned.cell(row({ lastLearningAction: null }), { ...ctx, ranged: true })).toBe("None in this period");
    expect(seen.cell(row({ lastActive: null }), ctx)).toBe("Not seen yet");
    expect(seen.cell(row({ lastActive: null }), { ...ctx, ranged: true })).toBe("Not seen in this period");
    expect(learned.cell(row({ lastLearningAction: "2026-10-12T13:00:00Z" }), ctx)).not.toMatch(/None/);
  });
  it("hides Run result not recorded in Teaching and shows it in Research", () => {
    expect(columnLabels("students", "teaching")).not.toContain("Run result not recorded");
    const research = columnLabels("students", "research");
    expect(research).toContain("Run result not recorded");
    for (const label of ["Logged actions", "Code runs", "Successes", "Errors", "Similar practice accuracy (AI)", "Client-reported accuracy", "Legacy auto-check (v0.5 rules)", "Active minutes", "Group"])
      expect(research).toContain(label);
    expect(new Set(research).size).toBe(research.length);
  });
  it("adds question type, difficulty, policy version and tags for questions in Research", () => {
    const research = columnLabels("questions", "research");
    for (const label of ["Question type", "Difficulty", "Policy version", "Tags"]) expect(research).toContain(label);
    expect(columnLabels("assignments", "research").filter((l) => l === "Homework avg score")).toHaveLength(1);
  });
});

describe("explorer chips and queries", () => {
  const names = { course: null, assignments: [{ id: "hw3", title: "Week 3 HW" }], groups: [{ id: "g1", name: "Section A" }] };
  it("shows the default Origin chip in Questions and removing it means all origins", () => {
    const chips = explorerChips({ work: "free" }, "questions", names);
    expect(chips.map((c) => `${c.label}: ${c.value}`)).toEqual(["Work: Free practice only", "Origin: Your questions"]);
    expect(removedValue("origin", "questions")).toBe("all");
    expect(explorerChips({ origin: "all" }, "questions", names).find((c) => c.key === "origin")).toBeUndefined();
    expect(explorerChips({ groupId: "g1", where: "kiwi" }, "students", names).map((c) => c.value)).toEqual(["Kiwi lectures & scratchpad", "Section A"]);
  });
  it("builds the v0.6 table query with the global range", () => {
    expect(explorerApiQuery({ group: "topics", unitId: "u3", work: "free", page: "2" }, explorerGroup("topics"), { from: "A", to: "B" })).toEqual({
      v: "2", group: "chapters", unitId: "u3", work: "free", page: "2", from: "A", to: "B",
    });
    expect(explorerGroup("sessions")).toBe("question-activities");
    expect(explorerGroup("bogus")).toBe("students");
  });
  it("carries the page filters on Export ▾ › Activity log (this view)", () => {
    expect(activityExportQuery({ unitId: "u3", groupId: "g1", work: "free", where: "lab", studentId: "s1", origin: "ai-free" }, { from: "A", to: "B" })).toEqual({
      unitIds: "u3", groupIds: "g1", studentId: "s1", where: "lab", practiceMode: "free", origin: "ai-free", from: "A", to: "B",
    });
    expect(activityExportQuery({ work: "hw3" }, {})).toEqual({ assignmentId: "hw3" });
    expect(activityExportQuery({ work: "assigned" }, {})).toEqual({ origin: "teacher" });
  });
  it("drills folded AI rows into their items and teacher questions into question activities", () => {
    const folded = row({ id: "f:u3:choice", origin: "ai-free", aiItemGroup: { unitId: "u3", origin: "ai-free", questionType: "choice", items: 12 } });
    expect(drillDown("questions", folded, {}).query).toMatchObject({ group: "questions", fold: "0", origin: "ai-free", unitId: "u3", questionType: "choice" });
    expect(answersQuery("questions", folded)).toEqual({ itemGroup: "f:u3:choice" });
    const teacher = row({ id: "t:hw3:q2", origin: "teacher", assignmentId: "hw3", questionId: "q2" });
    expect(drillDown("questions", teacher, { where: "lab" }).query).toEqual({ where: "lab", group: "question-activities", questionId: "q2", assignmentId: "hw3" });
    expect(drillDown("students", row({ studentId: "s1" }), {})).toEqual({ kind: "timeline", query: { studentId: "s1" } });
    expect(answersQuery("students", row({}))).toBeNull();
  });
  it("persists the column preset in the URL and localStorage", () => {
    localStorage.clear();
    expect(columnPreset("")).toBe("teaching");
    storeColumnPreset("research");
    expect(columnPreset("")).toBe("research");
    expect(columnPreset("?columns=teaching")).toBe("teaching");
  });
});
