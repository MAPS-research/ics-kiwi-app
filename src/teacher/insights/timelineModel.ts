import { LABELS } from "../../lib/labels";
import type { PracticeMode, StudentTimeline, TimelineEvent } from "../../types";

/*
 * Timeline model (INSIGHTS-06/08/16/19): labels, provenance, study-session grouping and paging merges for the
 * full activity timeline and the student × assignment timeline. Pure; used by StudentTimelinePage and AI conversations.
 */

type Provenance = TimelineEvent["provenance"];

/** Teacher-side AI provenance (§10 NM28): `Lab AI tutor · Ch 03 rules v4`, `Kiwi lecture AI`; never a bare "Kiwi AI". */
export function provenanceLabel(p: Provenance | null | undefined): string {
  if (!p) return "";
  if (p.where === "kiwi") return p.ai ? LABELS.kiwiLectureAi : "Kiwi";
  if (!p.ai) return "";
  if (p.ai === LABELS.localGuidance) return LABELS.localGuidance;
  return p.policyLabel ? `${LABELS.labAiTutor} · ${p.policyLabel}` : LABELS.labAiTutor;
}

/** Full provenance line (§12.9): `Lab AI tutor · Ch 03 rules v4 · gpt-5.4-mini`. */
export function provenanceDetail(p: Provenance | null | undefined): string {
  const base = provenanceLabel(p);
  if (!base || !p?.model) return base;
  return `${base} · ${p.model}`;
}

export const KIND_LABELS: Readonly<Record<TimelineEvent["kind"], string>> = {
  question_viewed: "Question opened",
  code_run: "Code run",
  code_edited: "Code saved",
  answer_draft: "Answer draft saved",
  answer_attempt: "Answer attempt",
  ai_turn: "AI tutor question",
  ai_failed: "AI request failed",
  ai_feedback: "Feedback on a Kiwi reply",
  similar_generated: LABELS.similarExerciseGenerated,
  practice_generated: "Practice exercise generated",
  item_check: "AI practice answer",
  attempt_started: "Attempt started",
  submission: "Homework submission",
  grade: "Grade saved",
  grade_released: "Grade released",
  hint_shown: "Hint shown",
  paste: "Pasted text",
  material_viewed: "Lecture page opened",
  other: "Activity",
};
export function kindLabel(kind: TimelineEvent["kind"]): string {
  return KIND_LABELS[kind] ?? KIND_LABELS.other;
}

const MODE_LABELS: Readonly<Record<string, string>> = {
  homework: LABELS.homework,
  "in-class": LABELS.inClassExercise,
  similar: LABELS.similarPracticeAi,
  free: LABELS.freePracticeAi,
  workspace: "R workspace",
  lecture: LABELS.lectureReading,
  kiwi: "Kiwi",
  other: "Other activity",
};
/** Where the step happened: the assignment title, or the practice mode (`Free practice (AI)`, `R workspace`, …). */
export function contextLabel(ctx: TimelineEvent["context"]): string {
  if (ctx.assignmentLabel && (ctx.practiceMode === "homework" || ctx.practiceMode === "in-class")) return ctx.assignmentLabel;
  if (ctx.practiceMode === "similar" && ctx.assignmentLabel) return `${LABELS.similarPracticeAi} · ${ctx.assignmentLabel}`;
  return MODE_LABELS[(ctx.practiceMode || "other") as PracticeMode] ?? MODE_LABELS.other;
}

/** "Ada Chen — full activity timeline" / "Ada Chen · Week 3 Homework — full timeline" (§3.2). */
export function timelineTitle(studentName: string, assignmentTitle?: string | null): string {
  return assignmentTitle ? `${studentName} · ${assignmentTitle} — full timeline` : `${studentName} — full activity timeline`;
}

export interface StudySession { index: number; start: string; end: string; events: TimelineEvent[] }
/** Groups events (already in time order) by their server-computed study-session index (new index after ≥ 30 min). */
export function groupStudySessions(events: readonly TimelineEvent[]): StudySession[] {
  const out: StudySession[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (last && last.index === event.studySessionIndex) {
      last.events.push(event);
      last.end = event.at;
    } else out.push({ index: event.studySessionIndex, start: event.at, end: event.at, events: [event] });
  }
  return out;
}

/** Appends a "Load more" page without duplicates (Kiwi sync never clears loaded pages [AU-D4-18]). */
export function appendTimeline(current: StudentTimeline | null, page: StudentTimeline): StudentTimeline {
  if (!current) return page;
  const seen = new Set(current.events.map((e) => e.id));
  return { ...page, events: [...current.events, ...page.events.filter((e) => !seen.has(e.id))] };
}

/** Short outcome text shown next to the step title (answers, runs, checks). */
export function outcomeText(event: TimelineEvent): string {
  const d = event.detail as Record<string, unknown>;
  if (event.kind === "answer_attempt" || event.kind === "item_check") {
    if (d.correct === true) return "Correct";
    if (d.correct === false) return "Incorrect";
    return "Not auto-checked";
  }
  if (event.kind === "code_run") return d.ok === true ? "Success" : d.ok === false ? "Error" : LABELS.runResultNotRecorded;
  return "";
}

/** The outcome suffix of a timeline row, or "" when the server title already says it ("Answer attempt · not auto-checked"). */
export function titleOutcome(event: TimelineEvent): string {
  const outcome = outcomeText(event);
  return outcome && (event.title || "").toLowerCase().includes(outcome.toLowerCase()) ? "" : outcome;
}

/** Grade status badge tone for the student × assignment header. */
export function statusTone(status: StudentTimeline["status"]): "neutral" | "info" | "success" | "warning" {
  if (!status) return "neutral";
  if (status.gradeStatus === "released") return "success";
  if (status.gradeStatus === "draft") return "info";
  if (status.gradeStatus === "ungraded") return "warning";
  return "neutral";
}

/** Query for the timeline's "Export ▾ › Activity log (this view)" (INSIGHTS-23). */
export function timelineExportQuery(studentId: string, opts: { assignmentId?: string; unitId?: string; where?: string; from?: string; to?: string }): Record<string, string> {
  const q: Record<string, string> = { studentId };
  if (opts.assignmentId) q.assignmentId = opts.assignmentId;
  if (opts.unitId) q.unitIds = opts.unitId;
  if (opts.where) q.where = opts.where;
  if (opts.from) q.from = opts.from;
  if (opts.to) q.to = opts.to;
  return q;
}
