import { describe, expect, it } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ByQuestionView } from "../teacher/grading/ByQuestionView";
import { GradebookView } from "../teacher/grading/GradebookPage";
import { GradingCardView } from "../teacher/grading/GradingCard";
import { detailFixture, gradeEvent } from "../teacher/grading/gradingFixtures";
import { commentInputLabel, draftFromDetail, feedbackInputLabel, scoreInputLabel } from "../teacher/grading/gradingKeys";
import { QueueFiltersView } from "../teacher/grading/ToGradePage";
import { allowTypeLabel } from "./labels";
import { accessibleNames, duplicateNames } from "../test/a11yNames";
import type { Gradebook, GradingQueue, SubmissionDetail } from "../types";

/*
 * INTEGRATION-02 [LY06, LY01]: static accessible-name scan over the TSX sources (read with Vite's `?raw` glob).
 * - no control is named "on" and no aria-label is built from a submission id;
 * - every <input>/<textarea>/<select> (spec: every teacher checkbox; INTEGRATION applies it to all form controls) has an
 *   aria-label / aria-labelledby, an id referenced by a <label htmlFor> in the same file, or a wrapping <label> with text
 *   (HTML implicit labelling, which gives the same accessible name);
 * - the owners' label builders produce the names the browser review checks (GRADE-07, AIRULES-09).
 */
const sources = import.meta.glob(["../**/*.tsx", "!../**/*.test.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

interface Tag { name: string; start: number; text: string; line: number }

/** Opening JSX tags `<name …>` (attribute expressions may contain `>` inside braces). */
function openingTags(source: string, name: string): Tag[] {
  const out: Tag[] = [];
  let i = source.indexOf(`<${name}`);
  while (i >= 0) {
    const after = source[i + name.length + 1] ?? "";
    if (/[A-Za-z0-9]/.test(after)) {
      i = source.indexOf(`<${name}`, i + 1);
      continue;
    }
    let depth = 0;
    let k = i + name.length + 1;
    for (; k < source.length; k++) {
      const c = source[k];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ name, start: i, text: source.slice(i, k + 1), line: source.slice(0, i).split("\n").length });
    i = source.indexOf(`<${name}`, k);
  }
  return out;
}

/** Text of the `<label>` that is still open at `index`, or null when the control is not inside a label. */
function wrappingLabel(source: string, index: number): string | null {
  const open = source.lastIndexOf("<label", index);
  if (open < 0 || source.lastIndexOf("</label>", index) > open) return null;
  const close = source.indexOf("</label>", index);
  return close < 0 ? null : source.slice(open, close);
}

/** A wrapping label names the control when it has visible text or a JSX expression besides the control itself. */
function labelHasText(label: string, control: string): boolean {
  const rest = label.replace(control, "").replace(/^<label[^>]*>/, "").replace(/<[^>]*>/g, " ");
  return /[A-Za-z]|\{[^}]+\}/.test(rest);
}

function controlProblems(source: string): string[] {
  const problems: string[] = [];
  const htmlFor = new Set([...source.matchAll(/htmlFor=\{?["'`]?([^"'`}\s>]+)/g)].map((m) => m[1]));
  for (const tag of ["input", "textarea", "select"].flatMap((name) => openingTags(source, name))) {
    if (/type=["']hidden["']/.test(tag.text)) continue;
    if (/\baria-label(ledby)?=/.test(tag.text)) continue;
    const id = /\bid=\{?["'`]?([^"'`}\s>]+)/.exec(tag.text)?.[1];
    if (id && htmlFor.has(id)) continue;
    const label = wrappingLabel(source, tag.start);
    if (label !== null && labelHasText(label, tag.text)) continue;
    problems.push(`line ${tag.line}: <${tag.name}> has no accessible name`);
  }
  return problems;
}

describe("accessible names (INTEGRATION-02)", () => {
  it("scans the TSX sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(60);
  });
  it("detects unnamed controls and accepts the three naming patterns", () => {
    expect(controlProblems('<input type="checkbox" checked={x} />')).toHaveLength(1);
    expect(controlProblems('<label><input type="checkbox" /></label>')).toHaveLength(1);
    expect(controlProblems('<label><input type="checkbox" /> Allow Multiple choice</label>')).toEqual([]);
    expect(controlProblems('<label><input type="radio" /> {LABELS.accessOpen}</label>')).toEqual([]);
    expect(controlProblems('<label htmlFor="due">Due</label><input id="due" type="date" />')).toEqual([]);
    expect(controlProblems('<input aria-label={scoreInputLabel(who)} onChange={(e) => set(e.target.value > 1)} />')).toEqual([]);
  });
  it.each(Object.entries(sources))("%s names every control and never by id", (_path, source) => {
    expect(source).not.toMatch(/aria-label=["']on["']/);
    for (const m of source.matchAll(/aria-label=\{([^}]*)\}/g)) expect(m[1], m[0]).not.toMatch(/submission\w*(\.id|Id)\b/i);
    expect(controlProblems(source)).toEqual([]);
  });
  it("label builders give the names the browser review checks (GRADE-07, AIRULES-09, SB-m06)", () => {
    const who = { studentLabel: "Ada Chen", assignmentTitle: "Files HW", attempt: 1 };
    expect(scoreInputLabel({ ...who, questionIndex: 2 })).toBe("Score for Ada Chen, Files HW, attempt 1, question 2");
    expect(commentInputLabel({ ...who, questionIndex: 1 })).toBe("Comment on Q1 for Ada Chen, Files HW, attempt 1");
    expect(feedbackInputLabel(who)).toBe("Feedback to Ada Chen, Files HW, attempt 1 (visible after release)");
    expect(allowTypeLabel("choice")).toBe("Allow Multiple choice");
    expect(allowTypeLabel("explain")).toBe("Allow Explain in words");
  });
});


/*
 * SB-m06: no two controls of one rendered grading view share an accessible name (two cards of one student on different
 * homework used to have two "Score for Ada Chen, attempt 1, question 1" inputs and repeated "Save draft" buttons).
 * Names are computed by `src/test/a11yNames.ts`; `src/lib/a11y.views.test.tsx` runs the same check on the Students,
 * Assignments and Insights views (K-m04).
 */
const noop = () => undefined;
function twoCardsOfOneStudent(): SubmissionDetail[] {
  const base = detailFixture();
  const busy = (assignmentId: string, title: string, submissionId: string): SubmissionDetail => ({
    ...base,
    submission: { ...base.submission, id: submissionId, assignmentId, attempt: 2, isLate: true, lateSeconds: 82_800, gradeStatus: "released", grade: 18 },
    assignment: { ...base.assignment, id: assignmentId, title },
    total: 18, adjustment: { points: -2, reason: "Late penalty (auto)", auto: true }, late: { lateHours: 23, penaltyPctPerDay: 10 },
    flags: [{ kind: "late", text: "Late · 23 h", href: `/teacher/grading?show=late&assignmentId=${assignmentId}` },
      { kind: "ai_final_answer", text: "AI reply may contain the final answer", href: "/teacher/insights/ai-conversations?flagged=1" }],
    earlierAttempts: [{ id: `${submissionId}-1`, attempt: 1, submittedAt: "2026-10-20T14:58:00.000+00:00", gradeStatus: "released", grade: 12 }],
    history: [gradeEvent({ id: 9, action: "release", actorLabel: "Instructor", actorRole: "instructor", totalAfter: 18, statusAfter: "released" })],
    process: { ...base.process, timelineUrl: `/teacher/students/s/s1/assignments/${assignmentId}` },
  });
  return [busy("work-1", "Week 3 Homework", "sub-a"), busy("work-2", "Files HW", "sub-b"), detailFixture({ submission: { ...base.submission, id: "sub-c", assignmentId: "work-3" },
    assignment: { ...base.assignment, id: "work-3", title: "Week 4 Homework" } })];
}
function cards(details: SubmissionDetail[]): string {
  return renderToStaticMarkup(createElement(Fragment, null,
    createElement(QueueFiltersView, { show: "all", view: "student", assignmentId: "", assignments: [{ id: "work-1", title: "Week 3 Homework" }], questions: [],
      questionId: "", search: "", chips: [], onChange: noop, onSearch: noop }),
    ...details.map((detail) => createElement(GradingCardView, { key: detail.submission.id, detail, draft: draftFromDetail(detail), canRelease: true,
      canUnrelease: true, busy: false, timeZone: "UTC", onChange: noop, onSave: noop, onUnrelease: noop }))));
}

describe("unique accessible names in one rendered grading view (SB-m06)", () => {
  it("computes names the way a browser does for the patterns the views use", () => {
    const names = accessibleNames('<label>Points <input type="number"/></label><button aria-label="Save draft — Ada">Save draft</button>'
      + '<a href="/x"><span aria-hidden="true">›</span> Open</a><label for="due">Due</label><input id="due"/><summary>Q1 <span>Needs review</span></summary>'
      + '<button><svg aria-hidden="true"></svg> Refresh</button><input type="hidden" value="x"/>');
    expect(names.map((n) => n.name)).toEqual(["Points", "Save draft — Ada", "Open", "Due", "Q1 Needs review", "Refresh"]);
    expect(duplicateNames('<button>Save draft</button><button>Save draft</button><input aria-label="x"/>')).toEqual(["save draft"]);
    expect(duplicateNames('<label>Show <select><option>All</option></select></label><button>Show all</button>')).toEqual([]);
  });
  it("names every control of two cards of the same student on different homework apart", () => {
    const html = cards(twoCardsOfOneStudent());
    expect(accessibleNames(html).length).toBeGreaterThan(30);
    expect(duplicateNames(html)).toEqual([]);
    expect(accessibleNames(html).every((n) => n.name)).toBe(true);
    expect(html).toContain('aria-label="Score for Ada Chen, Files HW, attempt 2, question 1"');
    expect(html).toContain('aria-label="Score for Ada Chen, Week 3 Homework, attempt 2, question 1"');
  });
  it("names the By question groups and the Gradebook cells apart", () => {
    const question = detailFixture().assignment.questions[0];
    const group = (key: string, n: number): NonNullable<GradingQueue["groups"]>[number] => ({ normalizedAnswer: key, sampleAnswer: key, submissionIds: Array.from({ length: n }, (_, i) => `${key}-${i}`),
      autoCorrect: null, autoScore: null, members: [] });
    const byQuestion = renderToStaticMarkup(createElement(ByQuestionView, { question, questionIndex: 1, groups: [group("4", 2), group("5", 2), group("x", 1)],
      values: {}, busy: false, onChange: noop, onApply: noop }));
    expect(duplicateNames(byQuestion)).toEqual([]);
    const cell = { state: "missing" as const, score: null, maxPoints: 20, attempts: 0, late: false, lateSeconds: 0, overTime: false, latestSubmissionId: null,
      scoredSubmissionId: null, draftAnswered: 0, draftTotal: 2, label: "Missing" };
    const row = (studentId: string, studentName: string) => ({ studentId, studentName, pseudonym: studentId, section: null, condition: null, groups: [],
      cells: [{ ...cell, assignmentId: "w1" }, { ...cell, assignmentId: "w2" }], inClass: [], activeMinutes: 0, aiQuestions: 0, codeRuns: 0, lastActive: null });
    const book: Gradebook = { policy: "latest", columns: [{ assignmentId: "w1", title: "Files HW", maxPoints: 20, dueAt: null, header: "Files HW (20 pts)" },
      { assignmentId: "w2", title: "Files HW — revision", maxPoints: 20, dueAt: null, header: "Files HW — revision (20 pts)" }], inClassColumns: [],
      rows: [row("s1", "Ada Chen"), row("s2", "Bo Lin")], total: 2, page: 1, pageSize: 50 };
    const gradebook = renderToStaticMarkup(createElement(GradebookView, { book, canGrade: true, canExport: true, groups: [], policy: "latest", search: "",
      groupId: "", page: 1, loading: false, onPolicy: noop, onSearch: noop, onGroup: noop, onPage: noop }));
    expect(duplicateNames(gradebook)).toEqual([]);
  });
});
