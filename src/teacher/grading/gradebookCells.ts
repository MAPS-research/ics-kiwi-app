import type { BadgeTone } from "../../components/StatusBadge";
import { teacherPaths } from "../../lib/routes";
import { LABELS, revisionOfNote } from "../../lib/labels";
import type { GradebookCell, GradebookCellState } from "../../types";

/*
 * Gradebook cell presentation (GRADE; NM16, NM18, TR04). The server's `cell.label` is the single source of the
 * wording (grading_rules.cell_label); this module adds tone, the "Released" prefix and the link target.
 */

const TONES: Readonly<Record<GradebookCellState, BadgeTone>> = {
  released: "success",
  draft: "info",
  submitted_ungraded: "warning",
  newer_ungraded: "warning",
  missing: "danger",
  not_due: "neutral",
  not_submitted: "neutral",
};
/** Semantic tone of a cell state (P7: status colors stay separate from the purple theme). */
export function cellTone(state: GradebookCellState): BadgeTone {
  return TONES[state] ?? "neutral";
}

/** Cell text: released cells read "Released 18/20 · 1 submission" so cards, gradebook and timeline agree (GRADE-11). */
export function cellText(cell: Pick<GradebookCell, "state" | "label">): string {
  return cell.state === "released" ? `Released ${cell.label}` : cell.label;
}

/** Muted states render without emphasis ("Not due yet", "Not started", "Not assigned"). */
export function cellMuted(cell: Pick<GradebookCell, "state" | "draftAnswered">): boolean {
  return (cell.state === "not_due" || cell.state === "not_submitted") && cell.draftAnswered === 0;
}

/**
 * Every cell links somewhere: graders open the grading card of the scored (or latest) submission; viewers and
 * students without a submission open the student × assignment timeline.
 */
export function cellHref(cell: Pick<GradebookCell, "assignmentId" | "latestSubmissionId" | "scoredSubmissionId">, studentId: string,
  canGrade: boolean): string {
  const submissionId = cell.scoredSubmissionId ?? cell.latestSubmissionId;
  if (canGrade && submissionId)
    return teacherPaths.grading({ assignmentId: cell.assignmentId, studentId, submissionId, show: "all" });
  return teacherPaths.studentAssignmentTimeline(studentId, cell.assignmentId);
}

/**
 * D8 tooltip of a cell whose homework has revisions (a homework and its revisions count once): the missing revision names
 * its original, a replaced original names the version that carries it, a submission to another version names it.
 */
export function cellLineageNote(cell: Pick<GradebookCell, "revisionOfTitle" | "countedOnTitle" | "revisionTitle" | "originalTitle" | "onOriginal" | "onRevision">): string {
  if (cell.revisionOfTitle) return revisionOfNote(cell.revisionOfTitle);
  if (cell.countedOnTitle) return `Counted on ${cell.countedOnTitle}: the homework and its revisions count once.`;
  if (cell.onRevision && cell.revisionTitle) return `Submitted ${cell.revisionTitle}.`;
  if (cell.onOriginal && cell.originalTitle) return `Submitted ${cell.originalTitle}.`;
  return "";
}

/** Accessible name of a cell link: "Ada Chen · Week 3 HW (20 pts) · Due 10/24: Missing". */
export function cellAriaLabel(studentName: string, header: string, cell: Pick<GradebookCell, "state" | "label" | "late">): string {
  return `${studentName} · ${header}: ${cellText(cell)}${cell.late ? " · Late" : ""}`;
}

/**
 * In-class column (RV6-M03, RT-02): "100% done · Correct eventually 100% · First try correct 0%", the labels of Exercise
 * results and the Assignments row; "Not started". Correctness counts questions, not checks.
 */
export function inClassText(entry: { completionPct: number | null; accuracyPct: number | null; correctFirstTryPct?: number | null }): string {
  if (!entry.completionPct) return "Not started";
  if (entry.accuracyPct === null) return `${entry.completionPct}% done`;
  const first = entry.correctFirstTryPct === undefined || entry.correctFirstTryPct === null ? "" : ` · ${LABELS.firstTryCorrect} ${entry.correctFirstTryPct}%`;
  return `${entry.completionPct}% done · ${LABELS.correctEventually} ${entry.accuracyPct}%${first}`;
}

export type ScorePolicy = "latest" | "highest";
export const POLICY_OPTIONS: readonly { value: ScorePolicy; label: string }[] = [
  { value: "latest", label: "Latest" },
  { value: "highest", label: "Highest" },
];
export function parsePolicy(value: string | null): ScorePolicy {
  return value === "highest" ? "highest" : "latest";
}
