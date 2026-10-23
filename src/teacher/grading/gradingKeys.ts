import type { BadgeTone } from "../../components/StatusBadge";
import { gradeStatusTone } from "../../components/StatusBadge";
import { displayTimeZone } from "../../lib/format";
import { countLabel, gradeStateLabel, LABELS, pluralize } from "../../lib/labels";
import { teacherPaths } from "../../lib/routes";
import type {
  AskKiwiMode, GradeEventView, GradeInput, GradeStatus, ItemResult, ProcessSummary, SubmissionDetail,
} from "../../types";

/*
 * Pure label builders and rules of the grading workbench (GRADE; NM12–NM16, NM25, LY06).
 * Accessible names say what a control is for ("Score for Ada Chen, attempt 1, question 2") and never contain ids.
 */

export interface CardWho { studentLabel: string; attempt: number }

/** NM15 / GRADE-07: the score input's accessible name. `questionIndex` is 1-based. */
export function scoreInputLabel({ studentLabel, attempt, questionIndex }: CardWho & { questionIndex: number }): string {
  return `Score for ${studentLabel}, attempt ${attempt}, question ${questionIndex}`;
}
/** Visible label of a per-question comment (NM14). */
export function commentFieldLabel(questionIndex: number): string {
  return `Comment on Q${questionIndex}`;
}
export function commentInputLabel({ studentLabel, attempt, questionIndex }: CardWho & { questionIndex: number }): string {
  return `Comment on Q${questionIndex} for ${studentLabel}, attempt ${attempt}`;
}
export function feedbackInputLabel({ studentLabel, attempt }: CardWho): string {
  return `Feedback to ${studentLabel}, attempt ${attempt} (visible after release)`;
}
export function cardLabel({ studentLabel, attempt }: CardWho, assignmentTitle: string): string {
  return `${studentLabel} · ${assignmentTitle} · attempt ${attempt}`;
}

/** "To grade (12)" (NM12); plain "To grade" while the count is loading. */
export function toGradeTitle(count?: number | null): string {
  return count === undefined || count === null ? LABELS.toGrade : countLabel(LABELS.toGrade, count);
}

/** Live count on the Grading section tab, `To grade (12)` (NM12; SectionTabs `counts`, CR-GRADE-1). */
export function gradingTabCounts(toGrade?: number | null): Readonly<Record<string, number>> | undefined {
  return toGrade === undefined || toGrade === null ? undefined : { [teacherPaths.grading()]: toGrade };
}

export type ShowFilter = "latest" | "all" | "graded" | "late" | "flagged" | "draft";
/** NM13: `Show: Latest attempts to grade / All attempts / Graded / Late / Flagged`. */
export const SHOW_OPTIONS: readonly { value: ShowFilter; label: string }[] = [
  { value: "latest", label: LABELS.showLatest },
  { value: "all", label: LABELS.showAll },
  { value: "graded", label: LABELS.showGraded },
  { value: "late", label: LABELS.showLate },
  { value: "flagged", label: LABELS.showFlagged },
];
export function parseShow(value: string | null): ShowFilter {
  return (["latest", "all", "graded", "late", "flagged", "draft"] as const).find((v) => v === value) ?? "latest";
}

/** Points without trailing zeros: 10, 16.5. */
export function fmtPoints(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

/** `Auto-checked ✓ 10/10`, `Auto-checked ✗ 0/10`, or `Needs review` for questions the server could not check. */
export function autoCheckLine(item: Pick<ItemResult, "autoCorrect" | "autoScore" | "points">): string {
  if (item.autoCorrect === null) return "Needs review";
  const mark = item.autoCorrect ? "✓" : "✗";
  return `Auto-checked ${mark} ${fmtPoints(item.autoScore ?? 0)}/${fmtPoints(item.points)}`;
}

/**
 * Question header badge (RV6-M02): a question the server could not check reads "Needs review" only until a score is
 * saved; then "Scored 9/10", so the header never contradicts a released total (same class as TR03/NM16).
 */
export function questionBadge(item: Pick<ItemResult, "autoCorrect" | "autoScore" | "points" | "score">): { label: string; tone: BadgeTone } {
  if (item.autoCorrect === null) {
    return item.score === null
      ? { label: "Needs review", tone: "warning" }
      : { label: `Scored ${fmtPoints(item.score)}/${fmtPoints(item.points)}`, tone: "success" };
  }
  return { label: autoCheckLine(item), tone: item.autoCorrect ? "success" : "neutral" };
}

/** Card status badge (NM16): Needs grading → Draft 16/20 → Released 16/20. */
export function cardStatus(detail: Pick<SubmissionDetail, "total" | "maxPoints"> & { submission: { gradeStatus?: GradeStatus } }): {
  label: string; tone: BadgeTone;
} {
  const status = detail.submission.gradeStatus ?? "ungraded";
  return { label: gradeStateLabel(status, detail.total, detail.maxPoints), tone: gradeStatusTone(status) };
}

const ASK_KIWI_TEXT: Readonly<Record<AskKiwiMode, string>> = {
  off: "off",
  hints_only: "hints only",
  explain_concepts: "explain concepts",
  worked_examples: "worked examples",
};
/** "Ask Kiwi: hints only · 2 questions asked". */
export function askKiwiLine(process: Pick<ProcessSummary, "askKiwiMode" | "aiQuestions">): string {
  return `${LABELS.askKiwi}: ${ASK_KIWI_TEXT[process.askKiwiMode] ?? process.askKiwiMode} · ${pluralize(process.aiQuestions, "question")} asked`;
}

export const LATE_PENALTY_REASON = "Late penalty (auto)";
export const LATE_PENALTY_REMOVED = "Late penalty removed";
const MINUS = "−";
/**
 * "Late penalty −2 (auto)", "Bonus −1"; empty when there is no adjustment. With the card's `late` info the automatic
 * penalty names the counted days (S-M04): "Late penalty −4 (auto: 2 started days × 10%)".
 */
export function adjustmentLine(adjustment: { points: number; reason: string; auto?: boolean },
  late?: { lateSeconds: number; penaltyPctPerDay: number } | null): string {
  if (!adjustment.points) return "";
  const amount = `${adjustment.points < 0 ? MINUS : "+"}${fmtPoints(Math.abs(adjustment.points))}`;
  if (adjustment.auto || adjustment.reason === LATE_PENALTY_REASON) {
    if (late && late.lateSeconds > 0 && late.penaltyPctPerDay > 0) {
      const days = Math.max(1, Math.ceil(late.lateSeconds / 86400));   // grading.late_penalty
      return `Late penalty ${amount} (auto: ${days} started ${days === 1 ? "day" : "days"} × ${fmtPoints(late.penaltyPctPerDay)}%)`;
    }
    return `Late penalty ${amount} (auto)`;
  }
  return `${adjustment.reason || "Adjustment"} ${amount}`;
}
/** The adjustment stored when the grader removes the automatic late penalty (GRADE-14). */
export function removedPenalty(): { points: number; reason: string; auto: boolean } {
  return { points: 0, reason: LATE_PENALTY_REMOVED, auto: false };
}

/** Sum of the item scores plus the adjustment, clamped to 0..max; null while any question is unscored. */
export function computeTotal(scores: readonly (number | null)[], adjustment: number, maxPoints: number): number | null {
  if (!scores.length || scores.some((s) => s === null || Number.isNaN(s))) return null;
  const sum = (scores as number[]).reduce((a, b) => a + b, 0) + (adjustment || 0);
  return Math.round(Math.min(Math.max(sum, 0), maxPoints) * 100) / 100;
}

/** "" → null; anything else must be a number from 0 to `points`. */
export function parseScore(text: string, points: number): { value: number | null; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { value: null, error: "" };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > points) return { value: null, error: `Enter 0 to ${fmtPoints(points)}` };
  return { value, error: "" };
}

/** Primary action of a card: one-step `Save & release` for `immediately` homework when the grader may release. */
export function primaryAction(gradesVisibility: "immediately" | "on_release", canRelease: boolean): "save" | "release" {
  return gradesVisibility === "immediately" && canRelease ? "release" : "save";
}
export function primaryActionLabel(action: "save" | "release"): string {
  return action === "release" ? "Save & release" : "Save draft";
}

export interface CardAction { id: "draft" | "next" | "release"; label: string; action: "save" | "release"; next: boolean; primary: boolean }
/**
 * Card buttons in a fixed order on every card (RV6-M11): Save draft · Save & next · Release. Only the filled style
 * follows the assignment's grade visibility, so a fast grader never finds Release where Save draft was.
 */
export function cardActions(primary: "save" | "release", canRelease: boolean): CardAction[] {
  const actions: CardAction[] = [
    { id: "draft", label: "Save draft", action: "save", next: false, primary: primary === "save" },
    { id: "next", label: primary === "release" ? "Save, release & next" : "Save & next ungraded", action: primary, next: true, primary: false },
  ];
  if (canRelease)
    actions.push({ id: "release", label: primary === "release" ? "Save & release" : "Release", action: "release", next: false, primary: primary === "release" });
  return actions;
}
/** One line under the buttons that says what releasing means for this homework (RV6-M11). */
export function releaseHint(primary: "save" | "release", canRelease: boolean): string {
  if (!canRelease) return "Your role saves drafts; an instructor releases grades.";
  return primary === "release"
    ? "Grades for this homework are visible immediately: Save & release shows this grade to the student."
    : "Students see this grade only after you release it.";
}

const GRADED_ACTIONS = new Set(["save_draft", "release", "bulk_release", "legacy_grade", "migrated"]);
function shortDateTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "";
  const parts: Record<string, string> = {};
  // RV6-m05: the course time zone by default, the zone of "Submitted …" on the same card (never the browser's)
  const zone = timeZone ?? displayTimeZone();
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date))
    parts[part.type] = part.value;
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}
/** "Graded by Wang (TA) · 10/22 09:10" from the stored actor label (never an id), or null when never graded. */
export function gradedByLine(history: readonly GradeEventView[], timeZone?: string, status?: GradeStatus): string | null {
  const last = [...history].reverse().find((h) => GRADED_ACTIONS.has(h.action));
  if (!last) return null;
  const name = last.actorLabel || "Unknown grader";
  if (last.action === "migrated") return `${name} · ${shortDateTime(last.createdAt, timeZone)}`;   // "Imported from v0.5 · 10/21 09:10"
  const role = last.actorRole === "ta" && !/\(TA\)/.test(name) ? " (TA)" : "";
  // S-m06: a card that still needs grading was saved, not graded
  const verb = status === "ungraded" ? "Last saved by" : "Graded by";
  return `${verb} ${name}${role} · ${shortDateTime(last.createdAt, timeZone)}`;
}
const HISTORY_TEXT: Readonly<Record<string, string>> = {
  autocheck: "Auto-checked at submission",
  save_draft: "Saved draft",
  release: "Released",
  bulk_release: "Released with the assignment",
  unrelease: "Moved back to draft",
  legacy_grade: "Graded and released (total only)",
  migrated: "Grade from before v0.6",
  adjust: "Changed the adjustment",
};
export function historyLine(entry: GradeEventView, timeZone?: string): string {
  const what = HISTORY_TEXT[entry.action] ?? entry.action;
  const total = entry.totalAfter === null ? "" : ` · ${fmtPoints(entry.totalAfter)}`;
  return `${shortDateTime(entry.createdAt, timeZone)} · ${entry.actorLabel || "System"} · ${what}${total}`;
}

/** Legacy grades saved before v0.6 have a total but no per-question scores. */
export const TOTAL_ONLY_LABEL = "Total-only grade (before v0.6)";
export function isTotalOnly(detail: Pick<SubmissionDetail, "items" | "total"> & { submission: { gradeStatus?: GradeStatus } }): boolean {
  return (detail.submission.gradeStatus ?? "ungraded") !== "ungraded" && detail.total !== null && detail.items.every((i) => i.score === null);
}

/** The question block that starts open: the first one without a score (all collapsed once everything is scored). */
export function firstOpenQuestion(items: readonly Pick<ItemResult, "questionId" | "score">[]): string | null {
  return items.find((i) => i.score === null)?.questionId ?? null;
}

/** Next submission to grade after `currentId` in the queue order, skipping ids already handled in this session. */
export function nextUngradedId(order: readonly string[], currentId: string, handled: ReadonlySet<string>): string | null {
  const start = order.indexOf(currentId);
  for (let step = 1; step <= order.length; step += 1) {
    const id = order[(Math.max(start, -1) + step + order.length) % order.length];
    if (id !== currentId && !handled.has(id)) return id;
  }
  return null;
}
/** 1-based queue page that holds `id` (page size 10), or null. */
export function pageOf(order: readonly string[], id: string, pageSize = 10): number | null {
  const index = order.indexOf(id);
  return index < 0 ? null : Math.floor(index / pageSize) + 1;
}

/** Ctrl+Enter / ⌘+Enter = Save & next. */
export function isSaveAndNextShortcut(event: { key: string; ctrlKey?: boolean; metaKey?: boolean }): boolean {
  return event.key === "Enter" && Boolean(event.ctrlKey || event.metaKey);
}

/** Release & export: "Release grades (58/60 graded)" and "Ready to release 12" (F04, NM11). */
export function releaseButtonLabel(graded: number, all: number): string {
  return `Release grades (${graded}/${all} graded)`;
}
export function readyToReleaseLabel(count: number): string {
  return `${LABELS.readyToRelease} ${count}`;
}

// ─── card draft state ──────────────────────────────────────────────────────────────────────────

export interface CardDraft {
  items: Record<string, { score: string; comment: string }>;
  feedback: string;
  adjustment: { points: number; reason: string; auto: boolean };
}
export function draftFromDetail(detail: SubmissionDetail): CardDraft {
  const items: CardDraft["items"] = {};
  for (const item of detail.items) items[item.questionId] = { score: item.score === null ? "" : String(item.score), comment: item.comment };
  return { items, feedback: detail.submission.feedback ?? "", adjustment: { ...detail.adjustment } };
}
/**
 * SB-M05: after a reload of the queue, keep what the grader typed into other cards. A card's draft is "unsaved" when it
 * differs from the server version it was built from (`base`); those drafts survive, every other card takes the server's
 * version, and the cards in `reset` (the one just saved, or one that turned out stale) always take the server's version.
 */
export function keepUnsavedDrafts(prev: Readonly<Record<string, CardDraft>>, base: Readonly<Record<string, CardDraft>>,
  fresh: Readonly<Record<string, CardDraft>>, reset: ReadonlySet<string>): Record<string, CardDraft> {
  const same = (a: CardDraft, b: CardDraft) => JSON.stringify(a) === JSON.stringify(b);
  const unsaved = (id: string) => !reset.has(id) && prev[id] !== undefined && base[id] !== undefined && !same(prev[id], base[id]);
  const out: Record<string, CardDraft> = {};
  for (const id of Object.keys(prev)) if (unsaved(id)) out[id] = prev[id];
  for (const [id, draft] of Object.entries(fresh)) out[id] = unsaved(id) ? prev[id] : draft;
  return out;
}

/** Totals the draft the way the server will (null while a score is missing or invalid). */
export function draftTotal(draft: CardDraft, detail: Pick<SubmissionDetail, "items" | "maxPoints">): number | null {
  const scores = detail.items.map((item) => {
    const parsed = parseScore(draft.items[item.questionId]?.score ?? "", item.points);
    return parsed.error ? Number.NaN : parsed.value;
  });
  return computeTotal(scores, draft.adjustment.points, detail.maxPoints);
}
export function draftErrors(draft: CardDraft, detail: Pick<SubmissionDetail, "items">): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const item of detail.items) {
    const { error } = parseScore(draft.items[item.questionId]?.score ?? "", item.points);
    if (error) errors[item.questionId] = error;
  }
  return errors;
}
export function draftToInput(draft: CardDraft, detail: SubmissionDetail, action: "save" | "release"): GradeInput {
  const items: GradeInput["items"] = {};
  for (const item of detail.items) {
    const entry = draft.items[item.questionId] ?? { score: "", comment: "" };
    items[item.questionId] = { score: parseScore(entry.score, item.points).value, comment: entry.comment };
  }
  return { items, feedback: draft.feedback, adjustment: { ...draft.adjustment }, action, baseGradeEventId: detail.latestGradeEventId };
}
