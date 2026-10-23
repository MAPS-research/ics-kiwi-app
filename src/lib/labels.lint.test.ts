import { describe, expect, it } from "vitest";
import { LABELS, STUDENT_LABELS } from "./labels";

/*
 * INTEGRATION-01 [TH14, NM28, NM32]: retired v0.5 labels never come back (§18 item 3).
 * Sources are read with Vite's `?raw` glob (no @types/node). Test files are skipped because they assert the absence of
 * these strings; comments are stripped so documentation may name a retired label.
 */
const tsx = import.meta.glob(["../**/*.tsx", "!../**/*.test.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const ts = import.meta.glob(["../**/*.ts", "!../**/*.test.ts", "!../**/*.d.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sources: Record<string, string> = { ...tsx, ...ts };
const teacher = Object.entries(sources).filter(([path]) => path.startsWith("../teacher/"));

/** Drops block comments and `//` line comments (a URL inside a string can only lose text here, never gain a match). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const RETIRED_LABELS: readonly string[] = [
  "Practice & assignments", "Generation settings", "Teacher system prompt", "Save chapter policy", "Output token limit",
  "Interaction explorer", "Explore evidence", "Grades & Data Hub", "Data Hub", "Checked accuracy", "Unknown outcomes",
  "Lock workspace", "Switch workspace", "Similar question (AI)", "AI practice ·", "Awaiting grade", "Awaiting manual grading",
  "Awaiting teacher review", "Course example drafts", "Class practice",
];
/** Bare "Kiwi AI" in teacher files; "Kiwi lecture AI" (NM28, NM32) does not match. */
const BARE_KIWI_AI = /\bKiwi AI\b/;
const LABEL_VALUES = [...Object.values(LABELS), ...Object.values(STUDENT_LABELS)] as string[];

describe("retired labels (INTEGRATION-01)", () => {
  it("scans the app sources", () => {
    expect(Object.keys(tsx).length).toBeGreaterThan(60);
    expect(teacher.length).toBeGreaterThan(40);
  });
  it("matches bare Kiwi AI but not Kiwi lecture AI, and ignores comments", () => {
    expect(BARE_KIWI_AI.test("Kiwi lecture AI")).toBe(false);
    expect(BARE_KIWI_AI.test("Asked Kiwi AI")).toBe(true);
    expect(stripComments('const a = "x"; // Data Hub\n/* Generation settings */ const url = "https://x/y";')).toBe('const a = "x"; \n const url = "https://x/y";');
  });
  it.each(Object.entries(sources))("%s uses none of the retired labels", (_path, source) => {
    const code = stripComments(source);
    for (const label of RETIRED_LABELS) expect(code, label).not.toContain(label);
  });
  it.each(teacher)("%s never says a bare Kiwi AI", (_path, source) => {
    expect(stripComments(source)).not.toMatch(BARE_KIWI_AI);
  });
  it("keeps the final §10 names that replace them in the label table", () => {
    for (const label of RETIRED_LABELS) expect(LABEL_VALUES.join("\n"), label).not.toContain(label);
    for (const label of ["Free practice (AI)", "Similar practice (AI)", "AI-generated practice", "Kiwi lecture AI", "Lab AI tutor",
      "Activity explorer", "Auto-checked accuracy (your questions)", "Gradebook", "Needs grading", "Waiting for teacher",
      "In-class exercise", "Practice with AI", "Try a similar question"])
      expect(LABEL_VALUES, label).toContain(label);
  });
  it("names the Kiwi lecture AI in the Home banner that Home renders (NM32)", () => {
    expect(LABELS.kiwiNotLinkedBanner).toContain("Kiwi lecture AI");
    expect(sources["../teacher/home/KiwiBanner.tsx"]).toContain("LABELS.kiwiNotLinkedBanner");
  });
});
