import { LABELS, questionTypeLabel } from "../../lib/labels";
import { formatDateTime, formatNumber } from "../../lib/format";
import type { AiQuestionType, AnalyticsRow, Course, WorkQuestionType } from "../../types";

/*
 * Activity explorer model (§13.4) [FD02, FD06, LY02, TH10, NM21–NM40]: groups, the exact Teaching column preset per group,
 * the Research additions, filter chips and the v0.6 API query. Pure, so the presets are unit-tested (INSIGHTS-12).
 */

/**
 * How question activities are formed (TELEMETRY-09, AU-D4-M8). Same text as `telemetry.QUESTION_ACTIVITY_RULE` on the
 * server (checked by `server/test_integration.py`); shown on the question-activity page and the explorer group.
 */
export const QUESTION_ACTIVITY_RULE =
  "A question activity groups one student's work on one question, item or thread; events less than 30 minutes apart belong to the same activity, across browser tabs.";

export type ExplorerGroup = "students" | "chapters" | "assignments" | "questions" | "reading" | "question-activities" | "study-sessions";
export type ColumnPreset = "teaching" | "research";

export const EXPLORER_GROUPS: readonly { id: ExplorerGroup; label: string; research?: boolean }[] = [
  { id: "students", label: "Students" },
  { id: "chapters", label: "Chapters" },
  { id: "assignments", label: "Assignments" },
  { id: "questions", label: "Questions" },
  { id: "reading", label: LABELS.lectureReading },
  { id: "question-activities", label: LABELS.questionActivities },
  { id: "study-sessions", label: "Study sessions", research: true },
];

const LEGACY_GROUPS: Readonly<Record<string, ExplorerGroup>> = { sessions: "question-activities", topics: "chapters", materials: "reading" };

export function explorerGroup(value: string | null | undefined): ExplorerGroup {
  const v = value ? LEGACY_GROUPS[value] ?? value : "students";
  return (EXPLORER_GROUPS.some((g) => g.id === v) ? v : "students") as ExplorerGroup;
}

export interface CellContext {
  course: Course | null; assignmentTitle: (id: string) => string;
  /** a time range is applied: an empty "Last seen" / "Last learning action" means none in this period (review 2, TEACHER-09) */
  ranged?: boolean;
}
export interface ExplorerColumn {
  key: string;
  label: string;
  /** server sort key (omitted: not sortable) */
  sort?: string;
  numeric?: boolean;
  /** a date column whose cell may wrap ("Oct 22, 2026, / 1:58 PM"), so seven Students columns fit at 1280 (K-m01) */
  stamp?: boolean;
  cell: (row: AnalyticsRow, ctx: CellContext) => string;
}

const pct = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${formatNumber(value)}%`);
const num = (value: number | null | undefined) => (value === null || value === undefined ? "—" : formatNumber(value));
const when = (value: string | null | undefined, ranged = false) =>
  value ? formatDateTime(value) : ranged ? "No activity in this period" : "No activity yet";
/** K-m01 (B-m01): the two named stamps, with empty texts that say which one is missing. */
const seenAt = (value: string | null | undefined, ranged = false) =>
  value ? formatDateTime(value) : ranged ? "Not seen in this period" : "Not seen yet";
const learnedAt = (value: string | null | undefined, ranged = false) =>
  value ? formatDateTime(value) : ranged ? "None in this period" : "None yet";
const chapterOf = (row: AnalyticsRow, ctx: CellContext) =>
  ctx.course?.units.find((u) => u.id === row.unitId)?.title || (row.unitId ? row.unitId : "Not linked to a chapter");

export const ORIGIN_LABELS: Readonly<Record<string, string>> = {
  teacher: "Your questions",
  "ai-free": LABELS.freePracticeAi,
  "ai-similar": LABELS.similarPracticeAi,
};

/** Row title shown in the first column (with the duplicate-title suffix "· HW3 Q2" [FD02]). */
export function rowTitle(group: ExplorerGroup, row: AnalyticsRow, ctx: CellContext): string {
  if (group === "students" || group === "study-sessions") return row.studentName || row.label || row.studentId || "Student";
  if (group === "chapters") return chapterOf(row, ctx);
  if (group === "question-activities") return row.title || row.label || "Question activity";
  const base = row.label || row.title || row.id || "Untitled";
  return row.disambiguation ? `${base} ${row.disambiguation}` : base;
}

const C = {
  student: (label = "Student"): ExplorerColumn => ({ key: "student", label, sort: "label", cell: (r) => r.studentName || r.label || r.studentId || "" }),
  /** K-m01: *Last seen* — the newest event of any kind (the roster's column); the server's `lastActive` */
  lastSeen: (): ExplorerColumn => ({ key: "lastActive", label: LABELS.lastSeen, sort: "lastActive", stamp: true, cell: (r, ctx) => seenAt(r.lastActive, ctx.ranged) }),
  /** K-m01: *Last learning action* — answers, code runs, AI questions, submissions (the No learning actions rule) */
  lastLearningAction: (): ExplorerColumn => ({ key: "lastLearningAction", label: LABELS.lastLearningAction, sort: "lastLearningAction", stamp: true,
    cell: (r, ctx) => learnedAt(r.lastLearningAction, ctx.ranged) }),
  attempts: (): ExplorerColumn => ({ key: "attempts", label: "Attempts", sort: "attempts", numeric: true, cell: (r) => num(r.attempts) }),
  accuracy: (): ExplorerColumn => ({ key: "serverAccuracy", label: LABELS.autoCheckedAccuracy, sort: "serverAccuracy", numeric: true, cell: (r) => pct(r.serverAccuracy ?? r.accuracy) }),
  similar: (): ExplorerColumn => ({ key: "similarAccuracy", label: LABELS.similarPracticeAccuracy, sort: "similarAccuracy", numeric: true, cell: (r) => pct(r.similarAccuracy) }),
  ai: (): ExplorerColumn => ({ key: "aiQuestions", label: LABELS.aiTutorQuestions, sort: "aiQuestions", numeric: true, cell: (r) => num(r.aiQuestions) }),
  students: (): ExplorerColumn => ({ key: "students", label: "Students", sort: "students", numeric: true, cell: (r) => num(r.students) }),
};

/**
 * Teaching preset: the §13.4 table (six columns per group; Students has seven since K-m01 split "Last activity" into
 * Last learning action and Last seen); `See details` is pinned separately. Every other "Last activity" is *Last seen*.
 */
export const TEACHING_COLUMNS: Readonly<Record<ExplorerGroup, readonly ExplorerColumn[]>> = {
  students: [
    C.student(), C.lastLearningAction(), C.lastSeen(), C.attempts(), C.accuracy(), C.ai(),
    { key: "missingWork", label: "Missing work", sort: "missingWork", numeric: true, cell: (r) => num(r.missingWork) },
  ],
  chapters: [
    { key: "chapter", label: "Chapter", sort: "label", cell: (r, ctx) => chapterOf(r, ctx) },
    C.students(), C.attempts(), C.accuracy(), C.similar(), C.ai(),
  ],
  assignments: [
    { key: "assignment", label: "Assignment", sort: "label", cell: (r) => r.label || r.title || "" },
    { key: "submitted", label: "Submitted (whole term)", sort: "submitted", numeric: true, cell: (r) => (r.kind === "practice" ? "In-class" : num((r as AnalyticsRow & { submitted?: number | null }).submitted)) },
    { key: "homeworkAvgScorePct", label: "Homework avg score", sort: "homeworkAvgScorePct", numeric: true, cell: (r) => pct(r.homeworkAvgScorePct) },
    C.accuracy(), C.similar(), C.lastSeen(),
  ],
  questions: [
    { key: "question", label: "Question", sort: "label", cell: (r, ctx) => rowTitle("questions", r, ctx) },
    { key: "origin", label: "Origin", cell: (r) => ORIGIN_LABELS[r.origin || ""] || "—" },
    C.students(),
    { key: "firstTryCorrectPct", label: "First try correct %", sort: "firstTryCorrectPct", numeric: true, cell: (r) => pct(r.firstTryCorrectPct) },
    C.attempts(), C.ai(),
  ],
  reading: [
    { key: "material", label: "Material", sort: "label", cell: (r) => r.label || r.title || r.materialId || "" },
    { key: "chapter", label: "Chapter", cell: (r, ctx) => chapterOf(r, ctx) },
    C.students(),
    { key: "views", label: "Views", sort: "views", numeric: true, cell: (r) => num(r.views) },
    { key: "kiwiAiQuestions", label: `${LABELS.kiwiLectureAi} questions`, sort: "kiwiAiQuestions", numeric: true, cell: (r) => num((r as AnalyticsRow & { kiwiAiQuestions?: number }).kiwiAiQuestions ?? r.aiQuestions) },
    C.lastSeen(),
  ],
  "question-activities": [
    C.student(),
    { key: "question", label: "Question", sort: "label", cell: (r) => r.title || r.label || "" },
    { key: "startedAt", label: "Started", sort: "startedAt", cell: (r) => when(r.startedAt) },
    { key: "activeMinutes", label: "Active minutes", sort: "activeMinutes", numeric: true, cell: (r) => num(r.activeMinutes) },
    C.attempts(),
    { key: "result", label: "Result", cell: (r) => r.result || "—" },
  ],
  "study-sessions": [
    C.student(),
    { key: "session", label: "Study session", cell: (r) => r.label || "" },
    { key: "startedAt", label: "Started", sort: "startedAt", cell: (r) => when(r.startedAt) },
    C.lastSeen(),
    { key: "actions", label: "Logged actions", sort: "actions", numeric: true, cell: (r) => num(r.actions) },
    C.ai(),
  ],
};

type ResearchColumn = ExplorerColumn & { groups?: readonly ExplorerGroup[] };
const ALL: readonly ExplorerGroup[] = ["students", "chapters", "assignments", "questions", "reading", "question-activities", "study-sessions"];
/** Research preset additions (§13.4), in the spec's order; columns already in the Teaching preset are not repeated. */
export const RESEARCH_COLUMNS: readonly ResearchColumn[] = [
  { key: "actions", label: "Logged actions", sort: "actions", numeric: true, cell: (r) => num(r.actions), groups: ALL },
  { key: "codeRuns", label: LABELS.codeRuns, sort: "codeRuns", numeric: true, cell: (r) => num(r.codeRuns), groups: ALL },
  { key: "codeSuccesses", label: "Successes", sort: "codeSuccesses", numeric: true, cell: (r) => num(r.codeSuccesses), groups: ALL },
  { key: "codeErrors", label: "Errors", sort: "codeErrors", numeric: true, cell: (r) => num(r.codeErrors), groups: ALL },
  { key: "runResultNotRecorded", label: LABELS.runResultNotRecorded, sort: "runResultNotRecorded", numeric: true, groups: ALL,
    cell: (r) => num((r as AnalyticsRow & { runResultNotRecorded?: number }).runResultNotRecorded ?? Math.max(0, r.codeRuns - r.codeSuccesses - r.codeErrors)) },
  { ...C.similar(), groups: ALL },
  { key: "clientAccuracy", label: "Client-reported accuracy", sort: "clientAccuracy", numeric: true, cell: (r) => pct(r.clientAccuracy), groups: ALL },
  { key: "legacyAccuracy", label: LABELS.legacyAutoCheck, sort: "legacyAccuracy", numeric: true, cell: (r) => pct(r.legacyAccuracy), groups: ALL },
  { key: "activeMinutes", label: "Active minutes", sort: "activeMinutes", numeric: true, cell: (r) => num(r.activeMinutes), groups: ["students", "question-activities", "study-sessions"] },
  { key: "homeworkAvgScorePct", label: "Homework avg score", sort: "homeworkAvgScorePct", numeric: true, cell: (r) => pct(r.homeworkAvgScorePct), groups: ["assignments"] },
  { key: "questionType", label: "Question type", cell: (r) => (r.questionType ? questionTypeLabel(r.questionType as WorkQuestionType | AiQuestionType) : "—"), groups: ["questions", "question-activities"] },
  { key: "difficulty", label: "Difficulty", cell: (r) => num(r.difficulty), groups: ["questions", "question-activities"] },
  { key: "policyVersionId", label: "Policy version", cell: (r) => (r.policyVersionId ? `v${r.policyVersionId}` : "—"), groups: ["questions", "question-activities"] },
  { key: "tags", label: "Tags", cell: (r) => (r.tags?.length ? r.tags.join(", ") : "—"), groups: ["questions"] },
  { key: "groupNames", label: "Group", cell: (r) => (r.groupNames?.length ? r.groupNames.join(", ") : "—"), groups: ["students", "study-sessions"] },
];

export function columnsFor(group: ExplorerGroup, preset: ColumnPreset): ExplorerColumn[] {
  const teaching = [...TEACHING_COLUMNS[group]];
  if (preset === "teaching") return teaching;
  const keys = new Set(teaching.map((c) => c.key));
  return [...teaching, ...RESEARCH_COLUMNS.filter((c) => (c.groups ?? ALL).includes(group) && !keys.has(c.key))];
}
export function columnLabels(group: ExplorerGroup, preset: ColumnPreset): string[] {
  return columnsFor(group, preset).map((c) => c.label);
}
/** The pinned last column label. */
export const PINNED_ACTION = LABELS.seeDetails;

// ─── column preset persistence (URL `columns=`, then localStorage) ─────────────────────────────

const PRESET_KEY = "kiwi-explorer-columns";
export function columnPreset(search: string): ColumnPreset {
  const fromUrl = new URLSearchParams(search).get("columns");
  if (fromUrl === "teaching" || fromUrl === "research") return fromUrl;
  try {
    return localStorage.getItem(PRESET_KEY) === "research" ? "research" : "teaching";
  } catch {
    return "teaching"; // WHY: storage blocked; the URL still carries an explicit choice
  }
}
export function storeColumnPreset(preset: ColumnPreset): void {
  try {
    localStorage.setItem(PRESET_KEY, preset);
  } catch {
    // WHY: the choice stays in the URL for this view
  }
}

// ─── filters (one chip row, §3.6 [LY02, FD06]) ─────────────────────────────────────────────────

export interface FilterOption { value: string; label: string }
export interface FilterDef { key: string; label: string; research?: boolean }
export const FILTER_DEFS: readonly FilterDef[] = [
  { key: "where", label: LABELS.whereLabel },
  { key: "unitId", label: "Chapter" },
  { key: "work", label: LABELS.workLabel },
  { key: "origin", label: "Origin" },
  { key: "groupId", label: "Group" },
  { key: "studentId", label: "Student" },
  { key: "activity", label: "Activity" },
  { key: "questionType", label: "Question type", research: true },
  { key: "difficulty", label: "Difficulty", research: true },
  { key: "policyVersionId", label: "Policy version", research: true },
  { key: "tag", label: "Tag", research: true },
  { key: "includeStaff", label: LABELS.includeTeachingStaff, research: true },
];
/** Drill-down filters that can arrive in the URL; shown as chips too. */
const DRILL_LABELS: Readonly<Record<string, string>> = { assignmentId: "Assignment", questionId: "Question", materialId: "Lecture", search: "Search" };

export const WHERE_OPTIONS: readonly FilterOption[] = [
  { value: "lab", label: LABELS.whereLab },
  { value: "kiwi", label: LABELS.whereKiwi },
];
export const ORIGIN_OPTIONS: readonly FilterOption[] = [
  { value: "teacher", label: ORIGIN_LABELS.teacher },
  { value: "ai-free", label: LABELS.freePracticeAi },
  { value: "ai-similar", label: LABELS.similarPracticeAi },
];
export const ACTIVITY_OPTIONS: readonly FilterOption[] = [
  { value: "attempts", label: "Answer attempts" },
  { value: "runs", label: LABELS.codeRuns },
  { value: "errors", label: "Code errors" },
  { value: "success", label: "Successful runs" },
  { value: "ai", label: LABELS.aiTutorQuestions },
  { value: "reading", label: LABELS.lectureReading },
  { value: "unknown", label: LABELS.runResultNotRecorded },
];
export function workOptions(assignments: readonly { id: string; title: string }[]): FilterOption[] {
  return [
    { value: "free", label: LABELS.workFree },
    { value: "assigned", label: LABELS.workAssigned },
    ...assignments.map((a) => ({ value: a.id, label: a.title })),
  ];
}
export const QUESTION_TYPE_OPTIONS: readonly FilterOption[] = (["choice", "fill", "predict", "complete", "explain", "text"] as const).map((t) => ({
  value: t,
  label: questionTypeLabel(t),
}));

export interface ChipNames {
  course: Course | null;
  assignments: readonly { id: string; title: string }[];
  groups: readonly { id: string; name: string }[];
  studentName?: (id: string) => string;
}
export interface ChipData { key: string; label: string; value: string }

/** Display value of one filter. */
export function filterValueLabel(key: string, value: string, names: ChipNames): string {
  if (key === "where") return WHERE_OPTIONS.find((o) => o.value === value)?.label ?? value;
  if (key === "unitId") return value === "unattributed" ? "Not linked to a chapter" : names.course?.units.find((u) => u.id === value)?.title ?? value;
  if (key === "work") return workOptions(names.assignments).find((o) => o.value === value)?.label ?? value;
  if (key === "origin") return value === "all" ? "All origins" : ORIGIN_OPTIONS.find((o) => o.value === value)?.label ?? value;
  if (key === "groupId") return names.groups.find((g) => g.id === value)?.name ?? value;
  if (key === "activity") return ACTIVITY_OPTIONS.find((o) => o.value === value)?.label ?? value;
  if (key === "questionType") return QUESTION_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
  if (key === "includeStaff") return value === "1" ? "Yes" : "No";
  if (key === "assignmentId") return names.assignments.find((a) => a.id === value)?.title ?? value;
  if (key === "studentId") return names.studentName?.(value) ?? value;
  return value;
}

/**
 * Chips for the active filters. In the Questions group the default Origin is "Your questions" and is shown as a chip
 * (removing it sets `origin=all`).
 */
export function explorerChips(values: Readonly<Record<string, string>>, group: ExplorerGroup, names: ChipNames): ChipData[] {
  const chips: ChipData[] = [];
  const effective = { ...values };
  if (group === "questions" && !effective.origin) effective.origin = "teacher";
  for (const def of FILTER_DEFS) {
    const value = effective[def.key];
    if (!value || (def.key === "origin" && value === "all")) continue;
    chips.push({ key: def.key, label: def.label, value: filterValueLabel(def.key, value, names) });
  }
  for (const [key, label] of Object.entries(DRILL_LABELS)) {
    const value = values[key];
    if (value) chips.push({ key, label, value: filterValueLabel(key, value, names) });
  }
  return chips;
}

/** Value written when a chip is removed (`origin` in Questions falls back to "all", everything else is cleared). */
export function removedValue(key: string, group: ExplorerGroup): string {
  return key === "origin" && group === "questions" ? "all" : "";
}

const PASS_THROUGH = ["where", "unitId", "work", "origin", "groupId", "studentId", "activity", "questionType", "difficulty", "policyVersionId",
  "tag", "includeStaff", "assignmentId", "questionId", "materialId", "search", "sort", "direction", "page", "pageSize", "fold"] as const;

/** v0.6 `/api/teacher/analytics/table` query (always `v=2`) from the page URL and the global time range. */
export function explorerApiQuery(values: Readonly<Record<string, string>>, group: ExplorerGroup, range: { from?: string; to?: string }): Record<string, string> {
  const q: Record<string, string> = { v: "2", group };
  for (const key of PASS_THROUGH) if (values[key]) q[key] = values[key];
  if (range.from) q.from = range.from;
  if (range.to) q.to = range.to;
  return q;
}

/** Filters the "Export ▾ › Activity log (this view)" link carries (§13.4, INSIGHTS-23). */
export function activityExportQuery(values: Readonly<Record<string, string>>, range: { from?: string; to?: string }): Record<string, string> {
  const out: Record<string, string> = {};
  if (values.unitId && values.unitId !== "unattributed") out.unitIds = values.unitId;
  if (values.groupId) out.groupIds = values.groupId;
  for (const key of ["studentId", "assignmentId", "questionId", "where"] as const) if (values[key]) out[key] = values[key];
  const work = values.work;
  // WHY: the export accepts one practiceMode; "Assigned work only" is the teacher origin (homework + in-class).
  if (work === "free") out.practiceMode = "free";
  else if (work === "assigned") out.origin = "teacher";
  else if (work && work !== "all" && !out.assignmentId) out.assignmentId = work;
  if (values.origin && values.origin !== "all") out.origin = values.origin;
  if (values.includeStaff === "1") out.includeStaff = "1";
  if (range.from) out.from = range.from;
  if (range.to) out.to = range.to;
  return out;
}

/** Where "See details" goes for a row (drill-down chain, KEEP). */
export function drillDown(group: ExplorerGroup, row: AnalyticsRow, values: Readonly<Record<string, string>>): { kind: "activity" | "timeline" | "questionActivity" | "answers"; query: Record<string, string> } {
  const keep: Record<string, string> = {};
  for (const key of ["where", "work", "groupId", "includeStaff"] as const) if (values[key]) keep[key] = values[key];
  if (group === "students") return { kind: "timeline", query: { studentId: row.studentId || "" } };
  if (group === "study-sessions") return { kind: "timeline", query: { studentId: row.studentId || "", from: row.startedAt || "", to: row.lastActive || "" } };
  if (group === "question-activities") return { kind: "questionActivity", query: { activityId: row.id || "" } };
  if (group === "chapters") return { kind: "activity", query: { ...keep, group: "question-activities", unitId: row.unitId || "unattributed" } };
  if (group === "assignments") return { kind: "activity", query: { ...keep, group: "question-activities", assignmentId: row.assignmentId || "" } };
  if (group === "reading") return { kind: "activity", query: { ...keep, group: "question-activities", materialId: row.materialId || "", where: "kiwi" } };
  if (row.aiItemGroup) {
    return {
      kind: "activity",
      query: { ...keep, group: "questions", origin: row.origin || "all", fold: "0", unitId: row.aiItemGroup.unitId, questionType: row.aiItemGroup.questionType,
        ...(row.origin === "ai-similar" && row.assignmentId ? { assignmentId: row.assignmentId } : {}) },
    };
  }
  return { kind: "activity", query: { ...keep, group: "question-activities", questionId: row.questionId || "", assignmentId: row.assignmentId || "" } };
}

/** Answers-by-question drill (questions and assignments rows). */
export function answersQuery(group: ExplorerGroup, row: AnalyticsRow): Record<string, string> | null {
  if (group === "assignments" && row.assignmentId) return { assignmentId: row.assignmentId };
  if (group !== "questions") return null;
  if (row.aiItemGroup && row.id) return { itemGroup: row.id };
  if (row.assignmentId && row.questionId) return { assignmentId: row.assignmentId, questionId: row.questionId };
  if (row.questionId) return { questionId: row.questionId };
  return null;
}
