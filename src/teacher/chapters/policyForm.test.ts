import { describe, expect, it } from "vitest";
import type { AiStatus, Course, PolicyConfig, PolicyVersion } from "../../types";
import {
  canUseAsAiReference, cellLabel, chapterNumber, chapterRuleLink, diffRows, difficultyOptionLabel, difficultyOptions,
  expectationLabel, expectFromChoice, isDirty, lintDraft, mentionedPackages, mergeLint, modelOptions, moveUnit, resetLabel,
  savedCheckOutcome, savedChecksSummary, scopeFromRoute, scopeRouteId, scopeTitle, shouldConfirmSwitch, statusBarText,
  STATUS_NOT_CONFIGURED, thisWeekToast, toggleContextField, togglePackage, toggleType, typeCheckboxLabel, validateDraft,
  versionDescription, versionLabel,
} from "./policyForm";

const DEFAULT_CONFIG: PolicyConfig = {
  tutoringInstructions: "Teach with small examples.",
  generationInstructions: "Write short exercises.",
  groundingNotes: "",
  helpLevel: "explain_concepts",
  replyLanguage: "English",
  minDifficulty: 1,
  maxDifficulty: 5,
  startingDifficulty: 2,
  difficultyRubric: { "1": "One-step recall", "2": "Apply one function", "3": "Combine two steps", "4": "Debug or adapt code", "5": "Multi-step task combining chapter skills" },
  allowedTypes: ["choice", "fill", "predict", "complete"],
  choiceCount: 4,
  maxOutputTokens: 2400,
  historyTurns: 6,
  model: null,
  reasoningEffort: "default",
  aiTutorEnabled: true,
  generationEnabled: true,
  feedback: { revealAfterAttempts: 0, showExplanationOnWrong: false },
  practice: { allowFocusNote: true, dailyItemLimit: 0, unlockAfterCorrect: 0 },
  contextFields: ["code", "error", "output", "instructions"],
  localGuidance: "Start by identifying the input.",
};

const runtime = (packages: string[] = []) => ({ packages, datasetFileIds: [], timeoutSeconds: 12, errorHints: [] });
const COURSE: Pick<Course, "units"> = {
  units: ["css-intro", "r-basics", "data-wrangling"].map((id, i) => ({
    id, title: `0${i + 1} · Chapter ${id}`, goal: "", status: "upcoming", access: "default", effectiveAccess: "open", week: null,
    startsOn: null, runtime: runtime(id === "data-wrangling" ? ["dplyr", "ggplot2"] : []),
  })),
};

describe("labels (AIRULES-09, AIRULES-11, NM06/NM07)", () => {
  it("builds difficulty option labels from the rubric", () => {
    expect(difficultyOptionLabel(2, DEFAULT_CONFIG.difficultyRubric)).toBe("2 · Apply one function");
    expect(difficultyOptionLabel(3, { ...DEFAULT_CONFIG.difficultyRubric, "3": "  Two steps  " })).toBe("3 · Two steps");
    expect(difficultyOptionLabel(5, { "5": "" })).toBe("5 · Multi-step task combining chapter skills");
    expect(difficultyOptions(DEFAULT_CONFIG.difficultyRubric).map((o) => o.label)).toEqual([
      "1 · One-step recall", "2 · Apply one function", "3 · Combine two steps", "4 · Debug or adapt code", "5 · Multi-step task combining chapter skills",
    ]);
  });
  it("names type checkboxes 'Allow <type>'", () => {
    expect(typeCheckboxLabel("choice")).toBe("Allow Multiple choice");
    expect(typeCheckboxLabel("fill")).toBe("Allow Fill in the blank");
    expect(typeCheckboxLabel("predict")).toBe("Allow Predict output");
    expect(typeCheckboxLabel("complete")).toBe("Allow Complete code");
    expect(typeCheckboxLabel("explain")).toBe("Allow Explain in words");
  });
  it("labels overview cells and chapter links (AIRULES-10)", () => {
    expect(cellLabel(null)).toBe("Default");
    expect(cellLabel({ status: "default", version: null, updatedAt: null, updatedBy: null })).toBe("Default");
    expect(cellLabel({ status: "customized", version: 4, updatedAt: "2026-10-21T04:00:00+00:00", updatedBy: "Lin" }, "UTC")).toBe("Customized · v4 · 10/21");
    expect(cellLabel({ status: "inherits", version: 1, updatedAt: null, updatedBy: null, inheritsFrom: "course" })).toBe("Uses course default");
    expect(cellLabel({ status: "inherits", version: 1, updatedAt: null, updatedBy: null, inheritsFrom: "unit" })).toBe("Uses chapter rules");
    expect(chapterRuleLink({ status: "customized", version: 4, updatedAt: null, updatedBy: null })).toBe("AI tutor: Customized v4");
    expect(chapterRuleLink(null)).toBe("Uses default AI rules");
  });
  it("shows the AI status bar text (AIRULES-08)", () => {
    const status: AiStatus = { configured: false, model: null, modelAllowlist: ["gpt-5.4-mini"], platformRulesVersion: "platform-rules-v2", concurrency: 4, perStudentPerMinute: 15, classPerMinute: 120 };
    expect(statusBarText(status)).toBe(STATUS_NOT_CONFIGURED);
    expect(STATUS_NOT_CONFIGURED).toBe("Not configured — students see fixed local guidance and template practice");
    expect(statusBarText({ ...status, configured: true, model: "gpt-5.4-mini" })).toBe("AI tutor: Connected · gpt-5.4-mini");
    expect(statusBarText(null, true)).toBe("AI tutor: checking…");
    expect(modelOptions({ ...status, configured: true, model: "gpt-5.4-mini" })[0]).toEqual({ value: "", label: "Server default (gpt-5.4-mini)" });
  });
});

describe("scopes and dirty state (AIRULES-10)", () => {
  it("parses the editor route", () => {
    expect(scopeFromRoute("course", "", "r-basics")).toEqual({ scope: "course", unitId: "", groupId: "" });
    expect(scopeFromRoute("r-basics", "?groupId=grp-1", "x")).toEqual({ scope: "unit", unitId: "r-basics", groupId: "grp-1" });
    expect(scopeFromRoute(undefined, "", "data-wrangling")).toEqual({ scope: "unit", unitId: "data-wrangling", groupId: "" });
    expect(scopeRouteId({ scope: "course", unitId: "", groupId: "" })).toBe("course");
    expect(scopeTitle({ scope: "unit", unitId: "r-basics", groupId: "g" }, COURSE, [{ id: "g", name: "Group B" }])).toBe("02 · Chapter r-basics · Group B");
    expect(resetLabel({ scope: "unit", unitId: "r-basics", groupId: "" })).toBe("Reset to course default");
    expect(resetLabel({ scope: "course", unitId: "", groupId: "" })).toBe("Reset to platform default");
    // S-m02: a group rule falls back to the chapter's (or the course's) rules, not to the course default
    expect(resetLabel({ scope: "unit", unitId: "r-basics", groupId: "grp-a" })).toBe("Reset to this chapter's rules");
    expect(resetLabel({ scope: "course", unitId: "", groupId: "grp-a" })).toBe("Reset to course rules");
  });
  it("detects unsaved edits independent of key order and prompts only on a real switch", () => {
    const reordered = JSON.parse(JSON.stringify({ ...DEFAULT_CONFIG })) as PolicyConfig;
    expect(isDirty(reordered, DEFAULT_CONFIG)).toBe(false);
    expect(isDirty({ ...DEFAULT_CONFIG, choiceCount: 3 }, DEFAULT_CONFIG)).toBe(true);
    const a = { scope: "unit" as const, unitId: "r-basics", groupId: "" };
    expect(shouldConfirmSwitch(true, a, { ...a, unitId: "css-intro" })).toBe(true);
    expect(shouldConfirmSwitch(true, a, a)).toBe(false);
    expect(shouldConfirmSwitch(false, a, { ...a, groupId: "g" })).toBe(false);
  });
  it("updates types and context fields immutably in canonical order", () => {
    const next = toggleType(DEFAULT_CONFIG, "explain", true);
    expect(next.allowedTypes).toEqual(["choice", "fill", "predict", "complete", "explain"]);
    expect(DEFAULT_CONFIG.allowedTypes).toHaveLength(4);
    expect(toggleType(next, "choice", false).allowedTypes).toEqual(["fill", "predict", "complete", "explain"]);
    expect(toggleContextField(DEFAULT_CONFIG, "materials", true).contextFields).toEqual(["code", "error", "output", "instructions", "materials"]);
  });
  it("validates drafts like the server", () => {
    expect(validateDraft(DEFAULT_CONFIG)).toEqual({});
    const errors = validateDraft({ ...DEFAULT_CONFIG, minDifficulty: 3, startingDifficulty: 2, allowedTypes: [], replyLanguage: "E",
      practice: { ...DEFAULT_CONFIG.practice, unlockAfterCorrect: 21 } });
    expect(Object.keys(errors).sort()).toEqual(["allowedTypes", "practice", "replyLanguage", "startingDifficulty"]);
  });
});

describe("lint (AIRULES-03, §12.3)", () => {
  it("finds package mentions", () => {
    expect(mentionedPackages("Use dplyr::filter() and library(ggplot2); quanteda.textplots too").sort()).toEqual(["dplyr", "ggplot2", "quanteda.textplots"]);
    expect(mentionedPackages("stats::sd and base::mean are fine")).toEqual([]);
  });
  it("warns about packages missing from the chapter and final-answer requests", () => {
    const config = { ...DEFAULT_CONFIG, generationInstructions: "Use dplyr::filter() then igraph::degree()", helpLevel: "hints_only" as const,
      tutoringInstructions: "Always give the final answer." };
    const lint = lintDraft(config, ["ggplot2"]);
    expect(lint.map((l) => l.message)).toEqual([
      "Your instructions mention dplyr, which is not in this chapter's R packages",
      "Your instructions mention igraph, which students can't install in the browser R workspace",
      "Your instructions ask for final answers, but Ask Kiwi may only give hints. The help level and the final-answer guard still apply.",
    ]);
    expect(lintDraft({ ...DEFAULT_CONFIG, generationInstructions: "plot with ggplot2" }, ["ggplot2"])).toEqual([]);
    const course = lintDraft({ ...DEFAULT_CONFIG, generationInstructions: "Use dplyr" }, null, COURSE.units);
    expect(course[0].message).toBe("Your instructions mention dplyr, which 2 chapters do not list in its R packages");
  });
  it("merges client and server lint without duplicates", () => {
    const server = [{ severity: "info" as const, field: "allowedTypes" as const, message: "Complete code needs the R workspace" },
      { severity: "warning" as const, field: "generationInstructions" as const, message: "old package warning" }];
    const draft = [{ severity: "warning" as const, field: "generationInstructions" as const, message: "new package warning" }];
    expect(mergeLint(draft, server, true).map((l) => l.message)).toEqual(["new package warning", "Complete code needs the R workspace"]);
    expect(mergeLint([], server, false)).toHaveLength(2);
  });
});

describe("versions, saved checks and chapters", () => {
  const v = (over: Partial<PolicyVersion>): PolicyVersion => ({ id: 1, scope: "unit", unitId: "r-basics", groupId: "", version: 1, config: DEFAULT_CONFIG,
    configHash: "h", note: "", restoredFrom: null, createdBy: "Lin", createdByRole: "instructor", createdAt: "2026-10-21T04:00:00+00:00", ...over });
  it("describes versions and diffs", () => {
    expect(versionLabel(v({ version: 3 }), "UTC")).toBe("v3 · 10/21 · Lin");
    const history = [v({ id: 7, version: 3, restoredFrom: 1, note: "back" }), v({})];
    expect(versionDescription(history[0], history)).toBe("Restored from v1 · back");
    expect(versionDescription(v({ config: { inherit: true } }), history)).toBe("Uses broader rules (reset)");
    expect(diffRows([{ field: "choiceCount", before: 4, after: 3 }, { field: "difficultyRubric.2", before: "a", after: "b" },
      { field: "allowedTypes", before: ["fill"], after: ["fill", "explain"] }])).toEqual([
      { label: "Choices per multiple-choice question", before: "4", after: "3" },
      { label: "Difficulty level 2 description", before: "a", after: "b" },
      { label: "Question types", before: "Fill in the blank", after: "Fill in the blank, Explain in words" },
    ]);
  });
  it("maps saved-check expectations and outcomes (AIRULES-14)", () => {
    expect(expectFromChoice("guard_leak_handled")).toEqual({ guard: "leak_handled" });
    expect(expectFromChoice("item_valid")).toEqual({ itemValid: true });
    expect(expectationLabel({ guard: "clean" })).toBe("Guard: no final answer");
    expect(expectationLabel({ homeworkMatched: true })).toBe("Recognized as homework");
    const base = { sampleId: "ats-1", label: "x", detail: "", guard: null, promptHash: "h" };
    expect(savedCheckOutcome({ ...base, passed: null }).label).toBe("Dry run");
    expect(savedCheckOutcome({ ...base, passed: false })).toEqual({ label: "Failed", tone: "danger" });
    expect(savedChecksSummary([{ ...base, passed: true }, { ...base, passed: false }])).toBe("1 of 2 saved checks failed. You can still save; review the failures first.");
    expect(savedChecksSummary([{ ...base, passed: null }])).toBe("1 saved check assembled (dry run, no AI call).");
    // S-m13: no "All 1 saved checks"
    expect(savedChecksSummary([{ ...base, passed: true }])).toBe("The saved check passed.");
    expect(savedChecksSummary([{ ...base, passed: true }, { ...base, passed: true }])).toBe("All 2 saved checks passed.");
    expect(savedChecksSummary([{ ...base, passed: false }])).toBe("1 of 1 saved check failed. You can still save; review the failures first.");
  });
  it("supports the chapters page (AIRULES-04, AIRULES-12)", () => {
    expect(thisWeekToast(COURSE, "data-wrangling")).toBe("This week's chapter is now 03");
    expect(chapterNumber(COURSE, "r-basics")).toBe("02");
    expect(["notes.md", "slides.QMD", "readme.txt", "data.csv", "notes.md.pdf"].map(canUseAsAiReference)).toEqual([true, true, true, false, false]);
    expect(moveUnit(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveUnit(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(togglePackage(["ggplot2"], "dplyr", true)).toEqual(["dplyr", "ggplot2"]);
    expect(togglePackage(["ggplot2", "dplyr"], "ggplot2", false)).toEqual(["dplyr"]);
  });
});
