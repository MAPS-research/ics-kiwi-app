import type { ReactNode } from "react";
import type { AssignmentState, GradeStatus } from "../types";

/** Semantic tones only (P7): status colors stay separate from the purple interaction theme. */
export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export function StatusBadge({ tone = "neutral", children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={`status-badge tone-${tone}`} title={title}>
      {children}
    </span>
  );
}

const ASSIGNMENT_STATES: Readonly<Record<AssignmentState, { label: string; tone: BadgeTone }>> = {
  draft: { label: "Draft", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "info" },
  open: { label: "Open", tone: "success" },
  past_due: { label: "Past due", tone: "warning" },
  closed: { label: "Closed", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};
export function assignmentStateBadge(state: AssignmentState): { label: string; tone: BadgeTone } {
  return ASSIGNMENT_STATES[state] ?? { label: state, tone: "neutral" };
}

export function gradeStatusTone(status: GradeStatus | null): BadgeTone {
  return status === "released" ? "success" : status === "draft" ? "info" : status === "ungraded" ? "warning" : "neutral";
}
