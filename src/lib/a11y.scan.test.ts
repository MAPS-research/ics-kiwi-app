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
 * The names follow the accessible-name rules for the markup React renders: aria-labelledby, aria-label, <label for>, a
 * wrapping <label> (without the control's own content), the element's text (aria-hidden parts left out), then title.
 */
interface El { tag: string; attrs: Record<string, string>; children: (El | string)[]; parent: El | null }
const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
const decode = (text: string) => text.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_m, code: string) => {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  if (named[code.toLowerCase()]) return named[code.toLowerCase()];
  return String.fromCodePoint(code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10));
});

export function parseMarkup(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [], parent: null };
  let current = root;
  const tokens = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html))) {
    const [, closing, rawTag, rawAttrs, selfClosing, text] = match;
    if (text !== undefined) {
      current.children.push(decode(text));
      continue;
    }
    if (!rawTag) continue;   // a comment
    const tag = rawTag.toLowerCase();
    if (closing) {
      for (let node: El | null = current; node; node = node.parent) if (node.tag === tag) { current = node.parent ?? root; break; }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? "").matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? "");
    const el: El = { tag, attrs, children: [], parent: current };
    current.children.push(el);
    if (!selfClosing && !VOID.has(tag)) current = el;
  }
  return root;
}

const walk = (el: El, visit: (e: El) => void) => {
  visit(el);
  for (const child of el.children) if (typeof child !== "string") walk(child, visit);
};
const FORM = new Set(["input", "textarea", "select"]);
function textOf(el: El, skip?: El): string {
  if (el === skip || el.attrs["aria-hidden"] === "true") return "";
  if (el !== skip && el.parent && el.attrs["aria-label"] && el.tag !== "#root") return el.attrs["aria-label"];
  return el.children.map((c) => (typeof c === "string" ? c : FORM.has(c.tag) ? "" : textOf(c, skip))).join("");
}
function ownText(el: El): string {
  return el.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}
const clean = (text: string) => text.replace(/\s+/g, " ").trim();

export function accessibleNames(html: string): { tag: string; name: string }[] {
  const root = parseMarkup(html);
  const byId = new Map<string, El>();
  walk(root, (e) => { if (e.attrs.id) byId.set(e.attrs.id, e); });
  const out: { tag: string; name: string }[] = [];
  walk(root, (el) => {
    const control = FORM.has(el.tag) || el.tag === "button" || el.tag === "summary" || (el.tag === "a" && "href" in el.attrs);
    if (!control || (el.tag === "input" && el.attrs.type === "hidden")) return;
    let name = "";
    if (el.attrs["aria-labelledby"]) name = el.attrs["aria-labelledby"].split(/\s+/).map((id) => (byId.get(id) ? ownText(byId.get(id)!) : "")).join(" ");
    if (!clean(name) && el.attrs["aria-label"]) name = el.attrs["aria-label"];
    if (!clean(name) && FORM.has(el.tag)) {
      let label: El | undefined;
      walk(root, (e) => { if (e.tag === "label" && el.attrs.id && e.attrs.for === el.attrs.id) label = e; });
      for (let up = el.parent; !label && up; up = up.parent) if (up.tag === "label") label = up;
      if (label) name = textOf(label, el);
    }
    if (!clean(name) && !FORM.has(el.tag)) name = ownText(el);
    if (!clean(name) && el.attrs.title) name = el.attrs.title;
    out.push({ tag: el.tag, name: clean(name) });
  });
  return out;
}

/** Accessible names used by more than one control ("" counts: an unnamed control is a problem of its own). */
export function duplicateNames(html: string): string[] {
  const seen = new Map<string, number>();
  for (const { name } of accessibleNames(html)) seen.set(name.toLowerCase(), (seen.get(name.toLowerCase()) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([name]) => name);
}

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
