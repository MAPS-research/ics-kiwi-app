import { countLabel, LABELS, pluralize, questionTypeLabel } from "../../lib/labels";
import { formatPercent, formatWeekdayDateTime, zoneLabel } from "../../lib/format";
import { teacherPaths } from "../../lib/routes";
import type {
  AskKiwiMode,
  AssignmentInput,
  AssignmentKind,
  AssignmentLineage,
  AssignmentListItem,
  AssignmentState,
  AssignmentStats,
  AssignmentStudentStatus,
  Course,
  GradingSettings,
  LatePolicy,
  Permission,
  SolutionsVisibility,
  TeacherAssignment,
  ToolPolicy,
  WorkQuestion,
  WorkQuestionType,
} from "../../types";

/*
 * Pure assignment rules shared by the list, the row menu and the editor (ASSESS, §9.1). No React, no I/O:
 * everything here is unit-tested in assignmentRules.test.ts.
 */

// ─── Defaults (§4.5.1) ─────────────────────────────────────────────────────────────────────────

export const HOMEWORK_TOOL_DEFAULT: ToolPolicy = { rWorkspace: true, allowRunPredict: false, askKiwi: "hints_only", similarPractice: false };
export const INCLASS_TOOL_DEFAULT: ToolPolicy = { rWorkspace: true, allowRunPredict: true, askKiwi: "explain_concepts", similarPractice: true };
export const LATE_POLICY_DEFAULT: LatePolicy = { mode: "accept_marked", untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 };
export const GRADING_DEFAULT: GradingSettings = { caseSensitive: true, whitespace: "outside_strings", numericTolerance: null, autoCheck: true };

/**
 * Decision D2 addendum (review 2, TEACHER-03): a new homework accepts late work for 7 days after its due date (marked
 * late) and then closes, so `Solutions visible: After the due date` and the end of answer protection take effect with
 * the defaults. The window follows the due date until the teacher edits the late policy; "Accepted, marked late" (no
 * end) stays available and its note says the homework then never closes.
 */
export const LATE_WINDOW_DAYS = 7;
export function autoLatePolicy(dueAt: string | null, current: LatePolicy): LatePolicy {
  const due = dueAt ? Date.parse(dueAt) : NaN;
  if (!Number.isFinite(due)) return { ...current, mode: "accept_marked", untilAt: null };
  return { ...current, mode: "accept_until", untilAt: new Date(due + LATE_WINDOW_DAYS * 86_400_000).toISOString() };
}
/** Apply a Dates-section patch; while `autoLate` is on, a due-date change moves the default late window with it. */
export function withDatesPatch(input: AssignmentInput, patch: Partial<AssignmentInput>, autoLate: boolean): AssignmentInput {
  const next = { ...input, ...patch };
  if (autoLate && "dueAt" in patch && !("latePolicy" in patch) && next.kind === "homework")
    next.latePolicy = autoLatePolicy(next.dueAt, input.latePolicy);
  return next;
}
export const NO_END_NOTE =
  "Late work has no end date, so this homework never closes: solutions stay hidden and Ask Kiwi keeps its answers protected until you set an end date, a close date or archive it.";
export const AUTO_LATE_NOTE = `Default for new homework: late work is accepted for ${LATE_WINDOW_DAYS} days after the due date (marked late), then the homework closes.`;

export function defaultToolPolicy(kind: AssignmentKind): ToolPolicy {
  return { ...(kind === "homework" ? HOMEWORK_TOOL_DEFAULT : INCLASS_TOOL_DEFAULT) };
}

/** Decision D2: homework shows solutions (and ends answer protection) once it closes; `never` is an explicit choice. */
export const SOLUTIONS_DEFAULT: Readonly<Record<AssignmentKind, SolutionsVisibility>> = { homework: "after_due", practice: "never" };

export const ASK_KIWI_OPTIONS: readonly { value: AskKiwiMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "hints_only", label: "Give hints only (never the final answer)" },
  { value: "explain_concepts", label: "Explain concepts" },
  { value: "worked_examples", label: "Show worked examples" },
];
export const QUESTION_TYPE_OPTIONS: readonly WorkQuestionType[] = ["text", "choice", "fill", "predict", "complete"];
/** Hint under `Solutions visible: After the due date` (decision D2: solutions wait for the late window too). */
export const AFTER_DUE_HINT = "Shown when the homework closes: after the due date and any late window.";
export const KIWI_PANEL_HELP =
  "This setting controls Ask Kiwi inside the Lab. The official SDK cannot disable Kiwi's own chat panel; that panel remains under Kiwi's control. The Lab never sends it assignment answer keys.";
export const FROZEN_BANNER =
  "Students have started this assignment. Questions are locked to keep their attempts and grades consistent.";

export function newQuestionId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(16).slice(2);
  return `q-${random.slice(0, 12)}`;
}

export function blankQuestion(type: WorkQuestionType = "text", id = newQuestionId()): WorkQuestion {
  return {
    // RV6-m02: no pre-filled empty choice lines (they showed as a blank first line and blank Reference answer options)
    id, type, prompt: "", points: 10, choices: [], starterCode: "", answer: "", referenceCode: "",
    expectedOutput: "", acceptedAnswers: [], grading: { ...GRADING_DEFAULT, autoCheck: type !== "text" }, maxAttempts: null, hints: [],
    studentExplanation: "", graderRubric: "", tags: [],
  };
}

/** Changing the question type keeps the prompt and points and resets type-specific fields. */
export function withQuestionType(q: WorkQuestion, type: WorkQuestionType): WorkQuestion {
  if (q.type === type) return q;
  return {
    ...q, type, choices: type === "choice" ? q.choices.filter((c) => c.trim()) : [],
    answer: type === "choice" && !q.choices.includes(q.answer ?? "") ? "" : q.answer,
    referenceCode: type === "complete" || type === "predict" ? q.referenceCode : "",
    expectedOutput: type === "complete" || type === "predict" ? q.expectedOutput : "",
    grading: { ...GRADING_DEFAULT, ...(q.grading ?? {}), autoCheck: type !== "text" },
  };
}

export function blankInput(
  course: Pick<Course, "units" | "currentUnitId">,
  prefill: { kind?: string | null; unitId?: string | null; audienceGroupId?: string | null } = {},
  defaultGradesVisibility: "immediately" | "on_release" = "on_release",
): AssignmentInput {
  const kind: AssignmentKind = prefill.kind === "practice" ? "practice" : "homework";
  const unitId = prefill.unitId && course.units.some((u) => u.id === prefill.unitId) ? prefill.unitId : course.currentUnitId;
  return {
    kind, title: "", unitId, instructions: "", dueAt: null, openAt: null, closeAt: null, latePolicy: { ...LATE_POLICY_DEFAULT },
    maxAttempts: null, timeLimit: null, gradesVisibility: kind === "practice" ? "immediately" : defaultGradesVisibility,
    solutionsVisibility: SOLUTIONS_DEFAULT[kind], toolPolicy: defaultToolPolicy(kind),
    audience: prefill.audienceGroupId ? { type: "groups", groupIds: [prefill.audienceGroupId] } : { type: "all" },
    questions: [blankQuestion()], retireOriginalOnPublish: false,
  };
}

/** Switching the assignment type resets the help defaults and drops homework-only / in-class-only settings. */
export function withKind(input: AssignmentInput, kind: AssignmentKind): AssignmentInput {
  if (input.kind === kind) return input;
  // An untouched default follows the type; a value the teacher picked stays.
  const solutionsVisibility = input.solutionsVisibility === SOLUTIONS_DEFAULT[input.kind] ? SOLUTIONS_DEFAULT[kind] : input.solutionsVisibility;
  return {
    ...input, kind, solutionsVisibility, toolPolicy: defaultToolPolicy(kind), timeLimit: kind === "homework" ? input.timeLimit : null,
    maxAttempts: kind === "homework" ? input.maxAttempts : null,
    questions: input.questions.map((q) => (kind === "homework" ? { ...q, hints: [], maxAttempts: null } : q)),
  };
}

export const INPUT_KEYS = [
  "kind", "title", "unitId", "instructions", "dueAt", "openAt", "closeAt", "latePolicy", "maxAttempts", "timeLimit",
  "gradesVisibility", "solutionsVisibility", "toolPolicy", "audience", "questions", "retireOriginalOnPublish",
] as const satisfies readonly (keyof AssignmentInput)[];

/** The editable part of a TeacherAssignment (the PUT body without baseUpdatedAt). */
export function inputOf(work: TeacherAssignment): AssignmentInput {
  const out = {} as Record<string, unknown>;
  for (const key of INPUT_KEYS) out[key] = structuredClone(work[key]);
  return out as unknown as AssignmentInput;
}

export function isDirty(a: AssignmentInput | null, b: AssignmentInput | null): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

// ─── Text fields → lists ───────────────────────────────────────────────────────────────────────

/** Choices, one per line: trimmed, empty lines dropped, duplicates reported inline [AU-D1-07]. */
export function parseChoices(text: string): { choices: string[]; error: string | null } {
  const choices = text.split("\n").map((c) => c.trim()).filter(Boolean);
  const duplicate = choices.find((c, i) => choices.indexOf(c) !== i);
  if (duplicate !== undefined) return { choices, error: `Duplicate choice: ${duplicate}` };
  if (choices.length < 2) return { choices, error: "Add at least two choices." };
  if (choices.length > 8) return { choices, error: "Use at most 8 choices." };
  return { choices, error: null };
}

/** One entry per line, trimmed, empty lines dropped. */
export function parseLines(text: string): string[] {
  return text.split("\n").map((v) => v.trim()).filter(Boolean);
}

/** "joins, skill:left_join" → tags; ≤ 8, each 1–40 of [a-z0-9:_ -] (AU-D1-20). */
export function parseTags(text: string): { tags: string[]; error: string | null } {
  const tags = [...new Set(text.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const bad = tags.find((t) => !/^[a-z0-9:_ -]{1,40}$/.test(t));
  if (bad !== undefined) return { tags, error: `Tag "${bad}" may use only a–z, 0–9, ":", "_", "-" and spaces (≤ 40 characters).` };
  if (tags.length > 8) return { tags, error: "Use at most 8 tags." };
  return { tags, error: null };
}

/** Client-side checks shown next to the footer before saving (the server repeats them). */
export function inputProblems(input: AssignmentInput): string[] {
  const problems: string[] = [];
  if (!input.title.trim()) problems.push("Add a title.");
  if (!input.questions.length) problems.push("Add at least one question.");
  input.questions.forEach((q, i) => {
    const n = `Question ${i + 1}`;
    if (!q.prompt.trim()) problems.push(`${n}: add a prompt.`);
    if (q.type === "choice") {
      const { error } = parseChoices(q.choices.join("\n"));
      if (error) problems.push(`${n}: ${error}`);
      else if (q.answer && !q.choices.includes(q.answer)) problems.push(`${n}: pick the reference answer from the choices.`);
    }
    const auto = q.type !== "text" && q.grading?.autoCheck !== false;
    if (input.kind === "practice" && auto && !(q.answer || q.expectedOutput || q.referenceCode || q.acceptedAnswers?.length))
      problems.push(`${n}: in-class questions need a reference answer to be auto-checked.`);
  });
  if (input.openAt && input.dueAt && Date.parse(input.dueAt) <= Date.parse(input.openAt)) problems.push("The due date must be after the open date.");
  if (input.closeAt && input.dueAt && Date.parse(input.closeAt) < Date.parse(input.dueAt)) problems.push("The close date must be on or after the due date.");
  if (input.latePolicy.mode === "accept_until" && !input.latePolicy.untilAt) problems.push("Set the date until which late work is accepted.");
  // S-M06: the server's limits, stated before Publish instead of a failed request
  const limit = timeLimitProblem(input);
  if (limit) problems.push(limit);
  if (input.kind === "homework" && input.maxAttempts !== null && !(Number.isInteger(input.maxAttempts) && input.maxAttempts >= 1 && input.maxAttempts <= 100))
    problems.push("Attempts allowed: use a whole number from 1 to 100, or leave it empty for unlimited.");
  const grace = input.latePolicy.graceMinutes;
  if (!(Number.isInteger(grace) && grace >= 0 && grace <= 120)) problems.push("Grace minutes: use a whole number from 0 to 120.");
  const pct = input.latePolicy.penaltyPctPerDay;
  if (!(Number.isFinite(pct) && pct >= 0 && pct <= 100)) problems.push("Late penalty: use 0 to 100 % per day.");
  return problems;
}

export const TIME_LIMIT_RANGE = { min: 5, max: 600 } as const;
/** S-M06: "Time limit: use 5 to 600 minutes per attempt." (null when fine or no limit). */
export function timeLimitProblem(input: Pick<AssignmentInput, "kind" | "timeLimit">): string | null {
  if (input.kind !== "homework" || !input.timeLimit) return null;
  const minutes = input.timeLimit.minutes;
  if (Number.isInteger(minutes) && minutes >= TIME_LIMIT_RANGE.min && minutes <= TIME_LIMIT_RANGE.max) return null;
  return `Time limit: use ${TIME_LIMIT_RANGE.min} to ${TIME_LIMIT_RANGE.max} minutes per attempt.`;
}

// ─── List rows (§9.1 List) ─────────────────────────────────────────────────────────────────────

export type ListItem = AssignmentListItem & { hasPreviewRows?: boolean };

/**
 * `Homework · Due Fri 10/24 23:59 · Submitted 41/60 · To grade 12 · Late 3` / `In-class exercise · 3 questions · Attempted 35/60 ·
 * First try correct 62%` [NM10, DA01]; RT-02 uses the Exercise results label for the same number.
 */
export function metaParts(item: Pick<ListItem, "kind" | "questionCount" | "dueAt" | "stats" | "status"> & { state?: AssignmentState }, timeZone?: string): string[] {
  const s = item.stats;
  if (item.kind === "practice") {
    const parts = [LABELS.inClassExercise, pluralize(item.questionCount, "question")];
    if (item.status === "published") parts.push(`Attempted ${s.attempted}/${s.enrolled}`);
    if (s.firstTryCorrectPct !== null) parts.push(`${LABELS.firstTryCorrect} ${formatPercent(s.firstTryCorrectPct)}`);   // RT-02
    return parts;
  }
  const parts = [LABELS.homework, item.dueAt ? `Due ${formatWeekdayDateTime(item.dueAt, timeZone)} ${zoneLabel(timeZone, item.dueAt)}` : "No due date"];
  if (item.status === "published") {
    parts.push(`Submitted ${s.submitted}/${s.enrolled}`);
    if (s.toGrade) parts.push(`To grade ${s.toGrade}`);
    if (s.late) parts.push(`Late ${s.late}`);
    if ((item.state === "past_due" || item.state === "closed") && s.missing) parts.push(`Missing ${s.missing}`);   // TEACHER-12
    if (s.submittedOriginal) parts.push(`Submitted the original ${s.submittedOriginal}`);   // S-M01
  }
  return parts;
}
export function metaLine(item: Pick<ListItem, "kind" | "questionCount" | "dueAt" | "stats" | "status">, timeZone?: string): string {
  return metaParts(item, timeZone).join(" · ");
}

/** The homework row button: Grade (n) while anything is ungraded → Release (n) while drafts wait → Graded ✓ [NM11, F04]. */
export function homeworkButton(stats: Pick<AssignmentStats, "toGrade"> & Partial<Pick<AssignmentStats, "toRelease" | "submitted">>, assignmentId = ""):
  { label: string; href: string | null; kind: "grade" | "release" | "done" } {
  if (stats.toGrade > 0 || stats.submitted === 0)
    return { label: countLabel("Grade", stats.toGrade), href: teacherPaths.grading({ assignmentId, show: "latest" }), kind: "grade" };
  if ((stats.toRelease ?? 0) > 0) return { label: countLabel("Release", stats.toRelease ?? 0), href: teacherPaths.release({ assignmentId }), kind: "release" };
  return { label: LABELS.gradedButton, href: assignmentId ? teacherPaths.grading({ assignmentId, show: "all" }) : null, kind: "done" };
}

export const STATUS_FILTERS: readonly { value: "all" | "draft" | "published" | "closed" | "archived"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "published", label: "Published" },
  { value: "closed", label: "Closed" },
  { value: "archived", label: "Archived" },
];

export type RowAction = "duplicate" | "revision" | "preview" | "clearPreview" | "close" | "reopen" | "archive" | "unarchive" | "delete";
/** ⋯ menu entries for a row, in display order [F13, AU-D1-09]. */
export function rowMenuActions(item: Pick<ListItem, "status" | "state" | "hasAttempts" | "hasPreviewRows">, permissions: readonly Permission[]):
  { action: RowAction; label: string }[] {
  const out: { action: RowAction; label: string }[] = [];
  const edit = permissions.includes("editAssignments");
  if (edit) out.push({ action: "duplicate", label: "Duplicate" });
  if (edit && item.hasAttempts) out.push({ action: "revision", label: "Create revision" });
  if (permissions.includes("previewStudent") && item.state !== "archived") out.push({ action: "preview", label: LABELS.previewAsStudent });
  if (!edit) return out;
  if (item.hasPreviewRows) out.push({ action: "clearPreview", label: LABELS.clearTestSubmissions });
  if (item.status === "published" && item.state !== "archived")
    out.push(item.state === "closed" ? { action: "reopen", label: "Reopen" } : { action: "close", label: "Close submissions" });
  out.push(item.state === "archived" ? { action: "unarchive", label: "Unarchive" } : { action: "archive", label: "Archive" });
  if (item.status === "draft" && !item.hasAttempts) out.push({ action: "delete", label: "Delete draft" });
  return out;
}

// ─── Student status popovers (DA01, DA07) ──────────────────────────────────────────────────────

export type StudentListState = "submitted" | "not_submitted" | "started" | "missing" | "late" | "to_grade";
export const STUDENT_LIST_TITLES: Readonly<Record<StudentListState, string>> = {
  submitted: "Submitted", not_submitted: "Not submitted", started: "Started only", missing: "Missing", late: "Late", to_grade: "To grade",
};

/** "Started · 2/3 answered" | "Submitted · late" | "Not started" for a popover row. */
export function studentStatusLabel(row: Pick<AssignmentStudentStatus, "submittedAt" | "late" | "draftAnswered" | "draftTotal" | "attempts" | "submittedOriginal">): string {
  if (!row.submittedAt && row.submittedOriginal) return "Submitted the original";   // S-M01
  if (row.submittedAt) {
    const base = row.attempts > 1 ? `Submitted · ${pluralize(row.attempts, "attempt")}` : "Submitted";
    return row.late ? `${base} · late` : base;
  }
  if (row.draftAnswered > 0) return `Started · ${row.draftAnswered}/${row.draftTotal} answered`;
  return LABELS.notStarted;
}

// ─── Editor labels ─────────────────────────────────────────────────────────────────────────────

/** `Question 1 · Fill in the blank · 10 points`; in-class questions are not graded, so they show no points (RT-06). */
export function questionHeading(index: number, q: Pick<WorkQuestion, "type" | "points">, kind: AssignmentKind = "homework"): string {
  const base = `Question ${index + 1} · ${questionTypeLabel(q.type)}`;
  return kind === "practice" ? base : `${base} · ${pluralize(q.points, "point")}`;
}

/** "Due Fri 10/24 23:59 Asia/Shanghai" — the course timezone is shown next to the due date. */
export function dueWithZone(dueAt: string | null, timeZone: string): string {
  return dueAt ? `Due ${formatWeekdayDateTime(dueAt, timeZone)} ${timeZone}` : "No due date";
}

export function gradesDefaultLabel(value: "immediately" | "on_release"): string {
  return `Course default: ${value === "on_release" ? "When I release" : "Immediately"}`;
}

// ─── Answer protection (decision D2; mirrors server/readers.answer_protected) ─────────────────

export type ProtectionInput = Pick<AssignmentInput, "kind" | "dueAt" | "closeAt" | "latePolicy" | "solutionsVisibility"> & {
  state?: AssignmentState;
  /** S-M02: revisions of this homework; an open one keeps the shared answers protected */
  revisions?: AssignmentLineage["revisions"];
};

/** S-M02: the first published revision that still accepts submissions. */
export function openRevision(revisions: AssignmentLineage["revisions"]): { id: string; title: string } | null {
  return (revisions ?? []).find((r) => r.status === "published" && (r.state === "open" || r.state === "past_due")) ?? null;
}

/** When the homework stops accepting submissions: the earliest of the close date, the late-window end and (no late work) due + grace. */
export function closingMoment(p: Pick<ProtectionInput, "dueAt" | "closeAt" | "latePolicy">): number | null {
  const times: number[] = [];
  const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
  const close = at(p.closeAt);
  if (Number.isFinite(close)) times.push(close);
  const due = at(p.dueAt);
  const grace = (p.latePolicy.graceMinutes || 0) * 60_000;
  if (p.latePolicy.mode === "not_accepted" && Number.isFinite(due)) times.push(due + grace);
  const until = at(p.latePolicy.untilAt);
  if (p.latePolicy.mode === "accept_until" && Number.isFinite(until)) times.push(until);
  return times.length ? Math.min(...times) : null;
}

function closingText(p: ProtectionInput, closing: number, timeZone?: string): string {
  const due = p.dueAt ? Date.parse(p.dueAt) : NaN;
  const fmt = (ms: number) => formatWeekdayDateTime(new Date(ms).toISOString(), timeZone);
  if (!Number.isFinite(due) || closing < due) return fmt(closing);
  const grace = p.latePolicy.graceMinutes || 0;
  if (closing > due + grace * 60_000) return `${fmt(due)} + late window to ${fmt(closing)}`;
  return grace > 0 ? `${fmt(due)} + ${grace} min grace` : fmt(due);
}

/**
 * The Student help note and the list line: the actual answer-protection state of a homework, or null for an in-class
 * exercise. `now` (ms) also treats a passed closing moment as closed — the editor passes it for unsaved dates; list rows
 * trust the server's `state`.
 */
export function protectionNote(p: ProtectionInput, timeZone?: string, now?: number): string | null {
  if (p.kind !== "homework") return null;
  if (p.state === "archived") return "Answers are no longer protected: this homework is archived.";
  if (p.solutionsVisibility === "never")
    return "Ask Kiwi won't give final answers until you archive it or make solutions visible (Solutions visible: Never).";
  const closing = closingMoment(p);
  const closed = p.state === "closed" || (now !== undefined && closing !== null && closing <= now);
  const revision = openRevision(p.revisions);
  if (closed && revision)
    return `Closed, but Ask Kiwi still won't give final answers: its revision “${revision.title}” asks the same questions and accepts submissions.`;
  if (closed) return "Answers are no longer protected: this homework is closed.";
  const who = p.solutionsVisibility === "after_submit" ? "a student final answers until they submit or"
    : p.solutionsVisibility === "after_release" ? "a student final answers until their grade is released or" : "final answers until";
  if (closing === null) {
    if (p.solutionsVisibility === "after_submit")
      return "Ask Kiwi won't give a student final answers until they submit: there is no closing date, so for everyone else answers stay protected until you set one or archive the homework.";
    if (p.solutionsVisibility === "after_release")
      return "Ask Kiwi won't give a student final answers until their grade is released: there is no closing date, so for everyone else answers stay protected until you set one or archive the homework.";
    return "Ask Kiwi won't give final answers for this homework: there is no closing date, so answers stay protected until you set one or archive the homework.";
  }
  return `Ask Kiwi won't give ${who} this homework closes (${closingText(p, closing, timeZone)}).`;
}

/** S-M01: "Revision of “Files HW”" / "Revised as “Files HW — revision”" (the editor and the list link both ways). */
export function lineageLinks(item: { revisionOf?: string | null } & AssignmentLineage): { label: string; id: string }[] {
  const out: { label: string; id: string }[] = [];
  if (item.revisionOf) out.push({ label: `Revision of “${item.revisionOfTitle || "the original"}”`, id: item.revisionOf });
  for (const r of item.revisions ?? []) out.push({ label: `Revised as “${r.title}”${r.status === "draft" ? " (draft)" : ""}`, id: r.id });
  return out;
}

export function stateNote(state: AssignmentState): string | null {
  if (state === "scheduled") return "Scheduled — students see it when it opens.";
  if (state === "closed") return "Closed — submissions are no longer accepted.";
  if (state === "archived") return "Archived — hidden from students.";
  return null;
}

/** Accessible names for repeated controls (LY06). */
export const fieldLabel = {
  questionType: (i: number) => `Question type for question ${i + 1}`,
  points: (i: number) => `Points for question ${i + 1}`,
  prompt: (i: number) => `Question prompt for question ${i + 1}`,
  remove: (i: number) => `Remove question ${i + 1}`,
  attachmentMount: (name: string) => `Load ${name} into R automatically`,
  removeFile: (name: string) => `Remove attachment ${name}`,
  rowMenu: (title: string) => `More actions for ${title}`,
  countButton: (label: string, title: string) => `${label} — student list for ${title}`,
};
