import { formatNumber, formatWeekdayDateTime, zoneLabel } from "../../lib/format";
import { activeOfEnrolledLabel, LABELS, pluralize } from "../../lib/labels";
import { teacherPaths } from "../../lib/routes";
import type { AssignmentListItem, HomeData, Metric, Permission, ReteachCandidate, TimeRange } from "../../types";

/*
 * Home model (§13.1, INSIGHTS-01/02/14/18/25): chip texts, glance texts and link rules. Pure — the views render these
 * strings and the tests assert them.
 */

export interface HomeLinks {
  /** grading queue, release page, late list (needs `grade`) */
  grading: boolean;
  /** assignment list and editor (needs `viewAssignments`) */
  assignments: boolean;
  /** AI conversations, explorer, metrics, profiles (needs `viewInsights`) */
  insights: boolean;
  /** Chapters & AI tutor rules (needs `viewAiRules`) */
  chapters: boolean;
  /** course settings (needs `manageCourse`) */
  settings: boolean;
}
export function homeLinks(permissions: readonly Permission[]): HomeLinks {
  const has = (p: Permission) => permissions.includes(p);
  return { grading: has("grade"), assignments: has("viewAssignments"), insights: has("viewInsights"), chapters: has("viewAiRules"), settings: has("manageCourse") };
}

export const toGradeChip = (count: number) => `${LABELS.toGrade} ${count}`;
export const releaseChip = (count: number) => `${LABELS.readyToRelease} ${count}`;
/** "Missing · Week 3 HW 5 (2 started)" [DA07]. */
export function missingChip(entry: HomeData["needsAction"]["missingPastDue"][number]): string {
  return `${LABELS.missing} · ${entry.title} ${entry.count}${entry.started ? ` (${entry.started} started)` : ""}`;
}
export const lateChip = (count: number) => `Late ${count}`;
export const flaggedChip = (count: number) => `Flagged replies ${count}`;

/** `+6 vs last wk` for counts, `+18%` for rates; empty when there is no comparison (Whole term). */
export function deltaText(metric: Metric, mode: "abs" | "pct", compareLabel: string | null): string {
  if (metric.previous === null || metric.value === null || !compareLabel) return "";
  const short = compareLabel === LABELS.vsLastWeek ? "vs last wk" : compareLabel;
  if (mode === "abs") {
    const diff = Math.round((metric.value - metric.previous) * 10) / 10;
    return `${diff >= 0 ? "+" : ""}${formatNumber(diff)} ${short}`;
  }
  if (metric.deltaPct === null) return "";
  return `${metric.deltaPct >= 0 ? "+" : ""}${metric.deltaPct}%`;
}

export interface GlanceItem { key: string; text: string; href: string; title?: string }
/**
 * "Active this week: 48 of 60 (learning actions; +6 vs last wk) · AI questions 132 (+18%) · Code runs 910 · Free-practice
 * items 214 · AI requests turned away 3" (K-m01: the Active label is the one Course metrics uses).
 */
export function glanceItems(glance: HomeData["glance"], range: TimeRange): GlanceItem[] {
  const withDelta = (base: string, delta: string) => (delta ? `${base} (${delta})` : base);
  const value = (m: Metric) => formatNumber(m.value ?? 0);
  return [
    { key: "active", text: activeOfEnrolledLabel(range.effectivePreset, glance.activeStudents.value ?? 0, glance.enrolled,
      deltaText(glance.activeStudents, "abs", range.compareLabel)), href: "/teacher/insights/activity?group=students", title: LABELS.activeHelp },
    { key: "ai", text: withDelta(`AI questions ${value(glance.aiQuestions)}`, deltaText(glance.aiQuestions, "pct", range.compareLabel)), href: teacherPaths.aiConversations({ unitId: "all" }) },
    { key: "runs", text: withDelta(`${LABELS.codeRuns} ${value(glance.codeRuns)}`, deltaText(glance.codeRuns, "pct", range.compareLabel)), href: "/teacher/insights/activity?group=question-activities&activity=runs" },
    { key: "items", text: `Free-practice items ${value(glance.freePracticeItems)}`, href: "/teacher/insights/activity?group=questions&origin=ai-free" },
    { key: "away", text: `AI requests turned away ${value(glance.aiTurnedAway)}`, href: "/teacher/insights/data-health" },
  ];
}

/** "Week 3 HW · Due Fri 10/24 23:59 · Submitted 41/60 · To grade 12" / "Closed · 58/60 · Avg 15.2/20". */
export function assignmentLine(item: AssignmentListItem, timeZone?: string): string {
  const s = item.stats;
  if (item.state === "closed" || item.state === "past_due") {
    const avg = s.avgScore !== null ? ` · Avg ${formatNumber(s.avgScore)}/${formatNumber(s.maxPoints)}` : "";
    return `${item.title} · ${item.state === "closed" ? "Closed" : "Past due"} · ${s.submitted}/${s.enrolled}${avg}`;
  }
  const due = item.dueAt ? ` · Due ${formatWeekdayDateTime(item.dueAt, timeZone)} ${zoneLabel(timeZone, item.dueAt)}` : "";
  if (item.kind === "practice") return `${item.title}${due} · Attempted ${s.attempted}/${s.enrolled}`;
  return `${item.title}${due} · Submitted ${s.submitted}/${s.enrolled}${s.toGrade ? ` · ${LABELS.toGrade} ${s.toGrade}` : ""}`;
}

/** "1. HW3 Q2 left_join() 38% · 2.9 tries" (first-try correct, or mean score for manually graded questions). */
export function reteachLine(c: ReteachCandidate, index: number): string {
  const metric = c.firstTryCorrectPct !== null ? `${formatNumber(c.firstTryCorrectPct, 0)}% first try` : c.meanScorePct !== null ? `avg ${formatNumber(c.meanScorePct, 0)}%` : "";
  const tries = c.meanTriesToCorrect !== null ? ` · ${formatNumber(c.meanTriesToCorrect)} ${c.meanTriesToCorrect === 1 ? "try" : "tries"}` : "";   // SB-m14
  return `${index + 1}. ${c.label} ${c.prompt ? `${c.prompt} ` : ""}${metric}${tries} · ${pluralize(c.students, "student")}`.replace(/\s+/g, " ").trim();
}

/** `Asked by 7: "why does merge drop rows?"`. */
export function askedLine(entry: { prompt: string; students: number }): string {
  return `Asked by ${entry.students}: “${entry.prompt}”`;
}

/** Header strip: `This week: Ch 03 Wrangling…`, `AI tutor: Ch 03 rules v4 (customized 10/21) · Connected`. */
export function headerParts(header: HomeData["header"], fmtDate: (iso: string | null) => string): { thisWeek: string; freePractice: string; aiRules: string; aiStatus: string } {
  const unit = header.thisWeek.index ? `Ch ${String(header.thisWeek.index).padStart(2, "0")} ` : "";
  const title = header.thisWeek.title.replace(/^\d+\s*·\s*/, "");
  const customized = header.aiRules.customized && header.aiRules.updatedAt ? ` (customized ${fmtDate(header.aiRules.updatedAt)})` : "";
  return {
    thisWeek: `This week: ${unit}${title}`,
    freePractice: `Free practice: ${header.freePracticeLabel}`,
    aiRules: `AI tutor: ${header.aiRules.label}${customized}`,
    aiStatus: header.aiStatus.configured ? "Connected" : "Not configured",
  };
}

const BANNER_KEY = (classId: string) => `kiwi-home-kiwi-banner:${classId}`;
export function bannerDismissed(classId: string): boolean {
  try {
    return localStorage.getItem(BANNER_KEY(classId)) === "dismissed";
  } catch {
    return false; // WHY: without storage the banner simply shows again next time
  }
}
export function dismissBanner(classId: string): void {
  try {
    localStorage.setItem(BANNER_KEY(classId), "dismissed");
  } catch {
    // WHY: dismissal then lasts only for this page view
  }
}
