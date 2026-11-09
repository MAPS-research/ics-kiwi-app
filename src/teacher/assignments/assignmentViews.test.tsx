import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LABELS } from "../../lib/labels";
import { AssignmentEditorView, AttachmentsList, type EditorViewProps } from "./AssignmentEditorPage";
import { AssignmentListView } from "./AssignmentListPage";
import { initialChoices, StarterAssignmentsView, starterRequest } from "./StarterAssignmentsPage";
import { checkResultText } from "./QuestionEditor";
import { blankInput, blankQuestion, fieldLabel, FROZEN_BANNER, KIWI_PANEL_HELP, type ListItem } from "./assignmentRules";
import type { AssignmentStats, CheckResult, Course, Permission, StarterAssignment, TeacherAssignment } from "../../types";

/* Editor sections, list rows and starter mapping rendered with renderToStaticMarkup (§19.1). */

const course = { title: "CSS", currentUnitId: "r-basics", linked: false,
  units: [{ id: "r-basics", title: "R basics" }, { id: "data-wrangling", title: "Data wrangling" }] } as unknown as Course;
const INSTRUCTOR: Permission[] = ["viewAssignments", "editAssignments", "previewStudent", "grade", "releaseGrades"];
const TA: Permission[] = ["viewAssignments", "previewStudent", "grade"];
const noop = () => undefined;
const esc = (text: string) => text.replace(/'/g, "&#x27;");

function editor(over: Partial<EditorViewProps> = {}): string {
  const input = over.input ?? blankInput(course, { kind: "homework" }, "on_release");
  return renderToStaticMarkup(createElement(AssignmentEditorView, {
    course, input, setInput: noop, work: null, linked: false, timeZone: "Asia/Shanghai", defaultGradesVisibility: "on_release", groups: [],
    readOnly: false, busy: false, dirty: true, onSaveDraft: noop, onPublish: noop, onPreview: noop, onRevision: noop, onUpload: noop,
    onRemoveFile: noop, onToggleMount: noop, onTryCheck: async (): Promise<CheckResult> => ({ correct: true, scoreFraction: 1, reason: "exact", basis: "answer_text", normalizedAnswer: "" }),
    ...over,
  }));
}

const published = (over: Partial<TeacherAssignment> = {}): TeacherAssignment => ({
  ...blankInput(course, { kind: "homework" }), title: "HW 1", questions: [{ ...blankQuestion("fill"), prompt: "mean?", answer: "4", graderRubric: "Rubric" }],
  id: "w1", classId: "c", status: "published", state: "open", version: 2, frozen: true, frozenAt: "x", attemptCount: 3, revisionOf: null,
  files: [{ id: "file-1", name: "data.csv", mime: "text/csv", size: 2048, scope: "assignment", questionId: "", unitId: "", mountInR: true, aiReference: false, createdAt: "x" }],
  attachmentName: null, versions: [], createdAt: "x", updatedAt: "x", archivedAt: null, ...over,
});

describe("Try the auto-check wording (RV6-m03)", () => {
  it("speaks about the output for Complete code and about the answer otherwise", () => {
    expect(checkResultText({ correct: true, scoreFraction: 1, reason: "output_match", basis: "client_run_output", normalizedAnswer: "80" }))
      .toBe("Correct — the output matches the expected output.");
    expect(checkResultText({ correct: false, scoreFraction: 0, reason: "mismatch", basis: "client_run_output", normalizedAnswer: "81" }))
      .toBe("Not correct — the output does not match.");
    expect(checkResultText({ correct: true, scoreFraction: 1, reason: "exact", basis: "answer_text", normalizedAnswer: "4" }))
      .toBe("Correct — the answer matches the reference.");
  });
  it("labels the Complete code try box as output", () => {
    const input = blankInput(course, { kind: "homework" }, "on_release");
    const html = editor({ input: { ...input, questions: [{ ...blankQuestion("complete"), prompt: "Print 80", expectedOutput: "[1] 80" }] } });
    expect(html).toContain("Try the auto-check (output a student&#x27;s code prints)");
    expect(html).toContain('placeholder="[1] 80"');
  });
});

describe("in-class exercise editor (RV6-M08)", () => {
  it("shows no late policy, grade release, solutions or rubric for an exercise that is not graded", () => {
    const input = blankInput(course, { kind: "practice" }, "on_release");
    const html = editor({ input: { ...input, questions: [{ ...blankQuestion("fill"), prompt: "mean?", answer: "4" }] } });
    for (const hidden of ["Late submissions", "Late penalty", "Grace minutes", "Grades visible to students", "Solutions visible", LABELS.graderRubric, "Dates &amp; late policy"])
      expect(html).not.toContain(hidden);
    expect(html).toContain(">Dates<");
    expect(html).toContain("In-class exercises are auto-checked and not graded");
    expect(html).toContain(LABELS.studentExplanation);
    const homework = editor();
    for (const shown of ["Late submissions", "Grace minutes", "Grades visible to students", "Solutions visible", LABELS.graderRubric]) expect(homework).toContain(shown);
  });
  it("shows no Points on an in-class question, which is not graded (RT-06)", () => {
    const input = blankInput(course, { kind: "practice" }, "on_release");
    const html = editor({ input: { ...input, questions: [{ ...blankQuestion("fill"), prompt: "mean?", answer: "4" }] } });
    expect(html).toContain(">Question 1 · Fill in the blank<");
    expect(html).not.toContain("10 points");
    expect(html).not.toContain(fieldLabel.points(0));
    expect(html).toContain(LABELS.notGraded);
    const homework = editor();
    expect(homework).toContain("Question 1 · ");
    expect(homework).toMatch(/Question 1 · [^<]+ · \d+ points?</);
    expect(homework).toContain(`aria-label="${fieldLabel.points(0)}"`);
  });
});

describe("assignment editor (ASSESS §9.1, NM08, NM09, F09, LY04)", () => {
  it("renders four sections and the draft footer", () => {
    const html = editor();
    for (const heading of [">Details<", ">Questions<", "Student help &amp; AI", "Dates &amp; late policy"]) expect(html).toContain(heading);
    expect(html).toContain(LABELS.assignmentType);
    expect(html).toContain(LABELS.homeworkType);
    expect(html).toContain(LABELS.inClassType);
    expect(html).toContain(LABELS.studentExplanation);
    expect(html).toContain(LABELS.graderRubric);
    for (const button of ["Save draft", LABELS.previewAsStudent, "Publish now"]) expect(html).toContain(button);
    expect(html).toContain("Save the draft to add attachments.");
    expect(html).toContain("Course default: When I release");
    expect(html).toContain("No due date");
    expect(editor({ input: { ...blankInput(course), dueAt: "2026-10-24T15:59:00Z" } })).toContain("Due Sat 10/24 23:59 Asia/Shanghai");
    // decision D2: the Student help note states the actual protection state of this homework
    expect(html).toContain(esc("Ask Kiwi won't give final answers for this homework: there is no closing date"));
    expect(editor({ now: Date.parse("2026-10-20T00:00:00Z"),
      input: { ...blankInput(course), dueAt: "2026-10-24T15:59:00Z", latePolicy: { mode: "not_accepted", untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 } } }))
      .toContain(esc("Ask Kiwi won't give final answers until this homework closes (Sat 10/24 23:59)."));
    expect(editor({ input: { ...blankInput(course), solutionsVisibility: "never" } }))
      .toContain(esc("until you archive it or make solutions visible (Solutions visible: Never)."));
    expect(html).toContain("Solutions visible");
    expect(html).toContain('<option value="after_due" selected="">After the due date</option>');
    expect(html).toContain("Shown when the homework closes");
    expect(html).toContain("Give hints only (never the final answer)");
    expect(html).toContain("Tags (comma-separated, e.g. joins, skill:left_join)");
    expect(html).not.toContain("Hints for students"); // in-class only
    expect(html).not.toContain(esc(KIWI_PANEL_HELP));
  });
  it("shows in-class fields, the Kiwi panel help for linked courses and time limits only for homework", () => {
    const practice = blankInput(course, { kind: "practice" });
    practice.questions = [blankQuestion("fill")];
    const html = editor({ input: practice, linked: true });
    expect(html).toContain("Hints for students");
    expect(html).toContain("Attempts allowed");
    expect(html).toContain(esc(KIWI_PANEL_HELP));
    expect(html).not.toContain("Time limit");
    expect(editor()).toContain("Time limit");
    expect(html).toContain("Try the auto-check");
    expect(html).toContain("Match case");
    expect(html).toContain("Ignore spacing outside quotes");
  });
  it("locks questions after attempts but keeps rubric and tags editable", () => {
    const work = published();
    const html = editor({ work, input: { ...work } });
    expect(html).toContain(FROZEN_BANNER);
    expect(html).toContain("Create revision");
    expect(html).toContain("Save changes");
    expect(html).not.toContain("Publish now");
    expect(html).not.toContain("Add question");
    const fieldsets = html.match(/<fieldset class="assess-fieldset"( disabled="")?>/g) ?? [];
    expect(fieldsets.some((f) => f.includes("disabled"))).toBe(true);
    expect(fieldsets.some((f) => !f.includes("disabled"))).toBe(true);
    expect(html).toContain("data.csv");
    expect(html).toContain("Load data.csv into R automatically");
  });
  it("is read-only for a TA: no footer, every field disabled", () => {
    const work = published({ frozen: false });
    const html = editor({ work, input: { ...work }, readOnly: true, onTryCheck: undefined });
    expect(html).not.toContain("Save changes");
    expect(html).not.toContain("Try the auto-check");
    expect(html).not.toMatch(/<fieldset class="assess-fieldset">/);
  });
  it("lists attachments with their target question", () => {
    const html = renderToStaticMarkup(createElement(AttachmentsList, {
      files: [{ id: "legacy-w1", name: "hw.qmd", mime: "text/plain", size: 10, scope: "assignment", questionId: "", unitId: "", mountInR: true, aiReference: false, createdAt: "x" },
        { id: "file-2", name: "q.csv", mime: "text/csv", size: 1_500_000, scope: "assignment", questionId: "q1", unitId: "", mountInR: false, aiReference: false, createdAt: "x" }],
      questions: [{ ...blankQuestion("fill", "q1") }], readOnly: false, onRemove: noop, onToggleMount: noop,
    }));
    expect(html).toContain("Whole assignment");
    expect(html).toContain("Question 1");
    expect(html).toContain("1.5 MB");
    expect(html).toContain('aria-label="Remove attachment q.csv"');
  });
});

const stats = (over: Partial<AssignmentStats> = {}): AssignmentStats => ({
  enrolled: 60, submitted: 41, startedNotSubmitted: 3, toGrade: 12, toRelease: 0, late: 3, missing: 0, graded: 0, released: 0, avgScore: null,
  maxPoints: 20, attempted: 35, firstTryCorrectPct: 62, ...over,
});
const item = (over: Partial<ListItem> = {}): ListItem => ({
  id: "w1", title: "Week 3 HW", kind: "homework", unitId: "r-basics", status: "published", state: "open", questionCount: 3,
  dueAt: "2026-10-24T15:59:00Z", closeAt: null, latePolicy: { mode: "accept_marked", untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 },
  hasAttempts: true, revisionOf: null, stats: stats(), updatedAt: "x", ...over,
});

describe("assignment list (ASSESS-13, NM10, NM11, NM44)", () => {
  const list = (items: ListItem[], permissions = INSTRUCTOR) => renderToStaticMarkup(createElement(AssignmentListView, {
    course, items, total: items.length, page: 1, pageSize: 20, loaded: true, busy: false, status: "all", search: "", permissions,
    timeZone: "Asia/Shanghai", load: async () => ({ students: [], emails: null }), onSearch: noop, onStatus: noop, onPage: noop, onAction: noop,
  }));
  it("renders homework and in-class rows with counts, buttons and the starter link", () => {
    const html = list([item(), item({ id: "w2", title: "Exercise", kind: "practice", questionCount: 1 })]);
    expect(html).toContain("Homework");
    expect(html).toContain("Due Sat 10/24 23:59");
    expect(html).toContain('aria-label="Submitted 41/60 — student list for Week 3 HW"');
    expect(html).toContain('aria-label="To grade 12 — student list for Week 3 HW"');
    expect(html).toContain("Grade (12)");
    expect(html).toContain("In-class exercise");
    expect(html).toContain("1 question");
    expect(html).toContain(`<span title="${LABELS.firstTryCorrectHelp}">First try correct 62%</span>`);   // RT-02
    expect(html).toContain(">Results<");
    expect(html).toContain('aria-label="More actions for Week 3 HW"');
    expect(html).toContain(LABELS.starterAssignments);
    for (const label of ["All", "Drafts", "Published", "Closed", "Archived"]) expect(html).toContain(`>${label}</button>`);
  });
  it("shows the answer protection state on published homework rows (decision D2)", () => {
    const html = list([
      item({ solutionsVisibility: "after_due" }),
      item({ id: "w3", title: "Quiz", solutionsVisibility: "never" }),
      item({ id: "w4", title: "Closed HW", state: "closed", solutionsVisibility: "after_due" }),
      item({ id: "w5", title: "Draft HW", status: "draft", state: "draft", solutionsVisibility: "after_due" }),
      item({ id: "w2", title: "Exercise", kind: "practice", questionCount: 1, solutionsVisibility: "never" }),
    ]);
    expect(html).toContain(esc("Ask Kiwi won't give final answers for this homework: there is no closing date"));
    expect(html).toContain(esc("(Solutions visible: Never)."));
    expect(html).toContain("Answers are no longer protected: this homework is closed.");
    expect(html.match(/class="muted assess-protection"/g)).toHaveLength(3);
    expect(list([item()])).not.toContain("assess-protection"); // older servers do not send solutionsVisibility
  });
  it("walks the homework button and hides edit actions from a TA", () => {
    expect(list([item({ stats: stats({ toGrade: 0, toRelease: 12 }) })])).toContain("Release (12)");
    expect(list([item({ stats: stats({ toGrade: 0, toRelease: 0 }) })])).toContain(LABELS.gradedButton);
    const ta = list([item()], TA);
    expect(ta).toContain(">View<");
    expect(ta).not.toContain(LABELS.starterAssignments);
  });
  it("does not make Grade (0) the filled primary button when nothing waits (RV6-m20)", () => {
    const html = list([item({ stats: stats({ toGrade: 0, toRelease: 0, submitted: 0 }) })]);
    expect(html).toMatch(/class="outline-button"[^>]*>Grade \(0\)</);
    expect(list([item()])).toMatch(/class="primary-button"[^>]*>Grade \(12\)</);
  });
  it("shows an empty state", () => {
    expect(list([])).toContain("No assignments yet.");
  });
  it("shows the chapter filter from a Chapters card link as a removable chip (CR-AIRULES-4; INTEGRATION)", () => {
    const html = renderToStaticMarkup(createElement(AssignmentListView, {
      course, items: [], total: 0, page: 1, pageSize: 20, loaded: true, busy: false, status: "all", search: "", permissions: INSTRUCTOR,
      onSearch: noop, onStatus: noop, onPage: noop, onAction: noop, unitId: "data-wrangling", onClearUnit: noop,
    }));
    expect(html).toContain('aria-label="Remove filter Chapter: Data wrangling"');
    expect(html).toContain("No assignments match these filters.");
  });
});

describe("starter assignments (ASSESS-14, NM44)", () => {
  const starters: StarterAssignment[] = [
    { key: "a", title: "HW 1", kind: "homework", sampleUnitId: "r-basics", mappedUnitId: "r-basics", alreadyAdded: false },
    { key: "b", title: "HW 3", kind: "homework", sampleUnitId: "text-analysis", mappedUnitId: null, alreadyAdded: false },
    { key: "c", title: "Old", kind: "practice", sampleUnitId: "r-basics", mappedUnitId: "r-basics", alreadyAdded: true },
  ];
  it("preselects mappable samples and maps or skips missing chapters", () => {
    const choices = initialChoices(starters);
    expect(starterRequest(starters, choices)).toEqual({ keys: ["a"], unitMap: {} });
    expect(starterRequest(starters, { ...choices, b: { selected: true, unitId: "data-wrangling" } })).toEqual({
      keys: ["a", "b"], unitMap: { "text-analysis": "data-wrangling" } });
    const html = renderToStaticMarkup(createElement(StarterAssignmentsView, { course, starters, choices, loaded: true, busy: false, onChoice: noop, onAdd: noop }));
    expect(html).toContain("Skip (chapter not in this course)");
    expect(html).toContain("Already added");
    expect(html).toContain(`${LABELS.addStarterAssignments} (1)`);
  });
});

describe("S-M06: publish errors and limits are visible where the teacher acts", () => {
  it("renders a failed publish inside the sticky footer and the time-limit range at the field", () => {
    const input = { ...blankInput(course, { kind: "homework" }, "on_release"), title: "Timed", timeLimit: { minutes: 1, onExpiry: "submit_marked" as const } };
    const html = editor({ input, error: "Time limit minutes must be an integer from 5 to 600" });
    const footer = html.slice(html.indexOf('<footer class="assess-footer"'));
    expect(footer).toContain('role="alert">Time limit minutes must be an integer from 5 to 600</p>');
    expect(html).toContain('min="5" max="600"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Time limit: use 5 to 600 minutes per attempt.");
    expect(editor({ input: { ...input, timeLimit: { minutes: 30, onExpiry: "submit_marked" as const } } })).toContain("5–600 minutes");
  });
});
