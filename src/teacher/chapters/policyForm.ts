import { formatShortDate } from "../../lib/format";
import { allowTypeLabel, DIFFICULTY_OPTIONS, LABELS, questionTypeLabel } from "../../lib/labels";
import { WEBR_PACKAGE_ALLOWLIST } from "../../lib/webrPackages";
import type {
  AiQuestionType, AiRuleCell, AiRulesOverview, AiStatus, AiTestResult, AiTestSample, AiTestSampleResult, Course, Difficulty,
  FreePracticeScope, GuardView, HelpLevel, HomeworkQuestionOption, PolicyConfig, PolicyDiff, PolicyLint, PolicyVersion, Unit, UnitAccess,
} from "../../types";

/*
 * Pure helpers for Chapters & AI tutor rules (AIRULES, §9.3): labels, scope parsing, dirty state, client-side lint and the
 * local types of the AIRULES convenience endpoints. No React and no I/O, so everything here is unit-tested in node.
 */

// ─── Response type aliases (were local workarounds; shared in src/types.ts since CR-AIRULES-2) ─────

export type OverviewCellBase = AiRuleCell;
export type InheritSource = NonNullable<AiRuleCell["inheritsFrom"]>;
/** Overview cell + `inheritsFrom` (shared `AiRuleCell` since CR-AIRULES-2). */
export type OverviewCell = AiRuleCell;
/** Overview incl. course × group cells (shared `AiRulesOverview` since CR-AIRULES-2). */
export type RulesOverview = AiRulesOverview;
/** GET /api/teacher/chapters/summary and GET /api/teacher/ai/rules/homework-questions (shared since CR-AIRULES-2). */
export type { ChapterSummary, ChapterSummaryUnit, HomeworkQuestionOption } from "../../types";
/** POST /api/teacher/ai/test result + additive `status`, `error`, `policyLabel` (shared since CR-AIRULES-2). */
export type TestRunResult = AiTestResult;

// ─── Field options and labels (§10 NM02–NM07) ──────────────────────────────────────────────────

export const AI_TYPES: readonly AiQuestionType[] = ["choice", "fill", "predict", "complete", "explain"];
export const HELP_LEVEL_OPTIONS: readonly { value: HelpLevel; label: string }[] = [
  { value: "hints_only", label: "Give hints only (never the final answer)" },
  { value: "explain_concepts", label: "Explain concepts" },
  { value: "worked_examples", label: "Show worked examples" },
];
export type ContextField = PolicyConfig["contextFields"][number];
export const CONTEXT_FIELD_OPTIONS: readonly { value: ContextField; label: string }[] = [
  { value: "code", label: "Student code" },
  { value: "error", label: "Error message" },
  { value: "output", label: "Run output" },
  { value: "answer", label: "Current answer" },
  { value: "instructions", label: "Assignment instructions" },
  { value: "datasets", label: "Chapter datasets" },
  { value: "materials", label: "Chapter files marked Use as AI reference" },
];
export const REASONING_OPTIONS: readonly { value: PolicyConfig["reasoningEffort"]; label: string }[] = [
  { value: "default", label: "Model default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
export const ACCESS_OPTIONS: readonly { value: UnitAccess; label: string }[] = [
  { value: "default", label: LABELS.accessFollowsScope },
  { value: "open", label: LABELS.accessOpen },
  { value: "review", label: `${LABELS.accessReview} (Ask Kiwi, no new practice)` },
  { value: "hidden", label: LABELS.accessHidden },
];
export const SCOPE_OPTIONS: readonly { value: FreePracticeScope; label: string }[] = [
  { value: "current_and_earlier", label: "Current and earlier chapters (recommended)" },
  { value: "current_only", label: "Current chapter only" },
  { value: "all", label: "All chapters" },
];
export const FIELD_LABELS = {
  groundingNotes: "Reference notes for the AI",
  helpLevel: "Ask Kiwi may",
  replyLanguage: "Reply language",
  difficultyRubric: "Difficulty rubric",
  allowedTypes: "Question types",
  choiceCount: "Choices per multiple-choice question",
  historyTurns: "Conversation memory (turns)",
  model: "Model",
  reasoningEffort: "Reasoning effort",
  contextFields: "What the AI sees",
  revealAfterAttempts: "Feedback: reveal the answer after this many wrong attempts (0 = never)",
  showExplanationOnWrong: "Show explanation after a wrong answer",
  allowFocusNote: 'Free practice: allow "What would you like to work on?"',
  dailyItemLimit: "Daily practice items per student (0 = unlimited)",
  unlockAfterCorrect: "Unlock a harder level after this many correct answers (0 = all levels open)",
  localGuidance: "Fixed guidance when AI is not configured",
  aiTutorEnabled: "Ask Kiwi is on for this chapter",
  generationEnabled: "Generated practice is on for this chapter",
} as const;
export const UNSAVED_PROMPT = "You have unsaved changes to these AI tutor rules. Leave without saving them?";
export const STATUS_NOT_CONFIGURED = "Not configured — students see fixed local guidance and template practice";

/** `2 · Apply one function` — option labels come from the (editable) rubric [AIRULES-11, NM06]. */
export function difficultyOptionLabel(level: number, rubric?: Partial<Record<string, string>> | null): string {
  const text = rubric?.[String(level)]?.trim();
  if (text) return `${level} · ${text}`;
  return DIFFICULTY_OPTIONS[level as Difficulty] ?? String(level);
}
export function difficultyOptions(rubric?: Partial<Record<string, string>> | null): { value: Difficulty; label: string }[] {
  return ([1, 2, 3, 4, 5] as Difficulty[]).map((value) => ({ value, label: difficultyOptionLabel(value, rubric) }));
}
/** Accessible name of a question-type checkbox: `Allow Multiple choice` [NM07, LY06]. */
export function typeCheckboxLabel(type: AiQuestionType): string {
  return allowTypeLabel(type);
}
export function contextFieldLabel(field: ContextField): string {
  return CONTEXT_FIELD_OPTIONS.find((o) => o.value === field)?.label ?? field;
}

// ─── Editing helpers (immutable updates) ───────────────────────────────────────────────────────

export function toggleType(config: PolicyConfig, type: AiQuestionType, on: boolean): PolicyConfig {
  const next = on ? [...config.allowedTypes.filter((t) => t !== type), type] : config.allowedTypes.filter((t) => t !== type);
  return { ...config, allowedTypes: AI_TYPES.filter((t) => next.includes(t)) };
}
export function toggleContextField(config: PolicyConfig, field: ContextField, on: boolean): PolicyConfig {
  const next = on ? [...config.contextFields.filter((f) => f !== field), field] : config.contextFields.filter((f) => f !== field);
  return { ...config, contextFields: CONTEXT_FIELD_OPTIONS.map((o) => o.value).filter((f) => next.includes(f)) };
}
export function setRubricLevel(config: PolicyConfig, level: Difficulty, text: string): PolicyConfig {
  return { ...config, difficultyRubric: { ...config.difficultyRubric, [String(level)]: text } as PolicyConfig["difficultyRubric"] };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}
/** Stable JSON (sorted keys) used for dirty checks. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}
export function isDirty(draft: PolicyConfig | null, base: PolicyConfig | null): boolean {
  if (!draft || !base) return false;
  return canonicalJson(draft) !== canonicalJson(base);
}
/** Switching chapter/group with unsaved edits asks first [AU-D2-23]. */
export function shouldConfirmSwitch(dirty: boolean, current: RuleScope, next: RuleScope): boolean {
  return dirty && scopeKey(current) !== scopeKey(next);
}

/** Client mirror of the server validation (§12.1) for inline messages; the server stays the authority. */
export function validateDraft(c: PolicyConfig): Partial<Record<keyof PolicyConfig, string>> {
  const errors: Partial<Record<keyof PolicyConfig, string>> = {};
  if (c.tutoringInstructions.length > 6000) errors.tutoringInstructions = `${LABELS.tutoringInstructions} can be at most 6,000 characters`;
  if (c.generationInstructions.length > 6000) errors.generationInstructions = `${LABELS.generationInstructions} can be at most 6,000 characters`;
  if (c.groundingNotes.length > 4000) errors.groundingNotes = `${FIELD_LABELS.groundingNotes} can be at most 4,000 characters`;
  if (c.localGuidance.length > 2000) errors.localGuidance = `${FIELD_LABELS.localGuidance} can be at most 2,000 characters`;
  const lang = c.replyLanguage.trim();
  if (lang.length < 2 || lang.length > 40) errors.replyLanguage = "Reply language must contain 2–40 characters";
  if (c.minDifficulty > c.maxDifficulty) errors.maxDifficulty = "Highest difficulty must be at least the lowest difficulty";
  else if (c.startingDifficulty < c.minDifficulty || c.startingDifficulty > c.maxDifficulty)
    errors.startingDifficulty = "Starting difficulty must be between the lowest and highest difficulty";
  if (Object.values(c.difficultyRubric).some((t) => !t.trim() || t.trim().length > 200))
    errors.difficultyRubric = "Each difficulty level needs a description of 1–200 characters";
  if (!c.allowedTypes.length) errors.allowedTypes = "Choose at least one question type";
  if (!Number.isInteger(c.maxOutputTokens) || c.maxOutputTokens < 512 || c.maxOutputTokens > 4000)
    errors.maxOutputTokens = "Max AI reply length must be 512–4,000 tokens";
  if (!Number.isInteger(c.historyTurns) || c.historyTurns < 2 || c.historyTurns > 12) errors.historyTurns = "Conversation memory must be 2–12 turns";
  const f = c.feedback;
  if (!Number.isInteger(f.revealAfterAttempts) || f.revealAfterAttempts < 0 || f.revealAfterAttempts > 10)
    errors.feedback = "Reveal the answer after 0–10 wrong attempts";
  const p = c.practice;
  if (!Number.isInteger(p.dailyItemLimit) || p.dailyItemLimit < 0 || p.dailyItemLimit > 500) errors.practice = "Daily practice items must be 0–500";
  else if (!Number.isInteger(p.unlockAfterCorrect) || p.unlockAfterCorrect < 0 || p.unlockAfterCorrect > 20)
    errors.practice = "Unlock a harder level after 0–20 correct answers";
  return errors;
}

// ─── Lint (client mirror of §12.3 package and final-answer checks, for unsaved edits) ──────────

const BASE_R = new Set(["base", "stats", "utils", "graphics", "grDevices", "methods", "datasets", "tools", "grid", "parallel", "splines"]);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FINAL_ANSWER =
  /\b(give|show|provide|tell|reveal|state|write)\b[^.\n]{0,40}?\b(final answers?|full solutions?|complete solutions?|the answers?|solution code|complete code)\b|(给出|告诉|提供|直接给)[^。\n]{0,10}(答案|最终答案|完整代码)/i;

/** R packages named in a text: `library(x)`, `require(x)`, `x::`, or an allowlisted package name. */
export function mentionedPackages(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b(?:library|require|requireNamespace)\(\s*['"]?([A-Za-z][A-Za-z0-9.]*)['"]?/g)) found.add(m[1]);
  for (const m of text.matchAll(/(?<![\w.])([A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]):::?/g)) found.add(m[1]);
  for (const name of WEBR_PACKAGE_ALLOWLIST) {
    if (new RegExp(`(?<![\\w.])${escapeRe(name)}(?!\\w|\\.\\w)`).test(text)) found.add(name);
  }
  return [...found].filter((p) => !BASE_R.has(p));
}

/**
 * Lint of a draft config. `packages` = this chapter's R packages (unit scope) or `null` for the course default, where
 * `chapters` lists every chapter's packages.
 */
export function lintDraft(config: PolicyConfig, packages: readonly string[] | null, chapters: readonly Pick<Unit, "id" | "runtime">[] = []): PolicyLint[] {
  const out: PolicyLint[] = [];
  const seen = new Set<string>();
  const allow = new Set(WEBR_PACKAGE_ALLOWLIST);
  for (const field of ["tutoringInstructions", "generationInstructions", "groundingNotes"] as const) {
    for (const pkg of mentionedPackages(config[field])) {
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      if (!allow.has(pkg)) {
        out.push({ severity: "warning", field, message: `Your instructions mention ${pkg}, which students can't install in the browser R workspace` });
      } else if (packages) {
        if (!packages.includes(pkg)) out.push({ severity: "warning", field, message: `Your instructions mention ${pkg}, which is not in this chapter's R packages` });
      } else {
        const missing = chapters.filter((u) => !u.runtime.packages.includes(pkg));
        if (missing.length) {
          out.push({ severity: "warning", field, message: `Your instructions mention ${pkg}, which ${missing.length === 1 ? "1 chapter does" : `${missing.length} chapters do`} not list in its R packages` });
        }
      }
    }
  }
  if (config.helpLevel === "hints_only" && FINAL_ANSWER.test(config.tutoringInstructions)) {
    out.push({
      severity: "warning",
      field: "tutoringInstructions",
      message: "Your instructions ask for final answers, but Ask Kiwi may only give hints. The help level and the final-answer guard still apply.",
    });
  }
  return out;
}
/** Draft lint first, then server-only lint (e.g. assignment tool policies), without duplicates. */
export function mergeLint(draft: readonly PolicyLint[], server: readonly PolicyLint[], dirty: boolean): PolicyLint[] {
  const clientFields = new Set(["tutoringInstructions", "generationInstructions", "groundingNotes"]);
  const rest = server.filter((l) => !(dirty && clientFields.has(String(l.field)) && l.severity === "warning"));
  const seen = new Set<string>();
  return [...draft, ...rest].filter((l) => (seen.has(l.message) ? false : (seen.add(l.message), true)));
}

// ─── Scopes and status labels ──────────────────────────────────────────────────────────────────

export interface RuleScope { scope: "course" | "unit"; unitId: string; groupId: string }
export const COURSE_ROUTE_ID = "course";

/** Route `/teacher/chapters/ai/:unitId?groupId=` → scope (`unitId=course` edits the course default). */
export function scopeFromRoute(unitIdParam: string | undefined, search: string, fallbackUnitId: string): RuleScope {
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const groupId = query.get("groupId") || "";
  const unit = unitIdParam || fallbackUnitId;
  return unit === COURSE_ROUTE_ID ? { scope: "course", unitId: "", groupId } : { scope: "unit", unitId: unit, groupId };
}
export function scopeRouteId(scope: RuleScope): string {
  return scope.scope === "course" ? COURSE_ROUTE_ID : scope.unitId;
}
export function scopeKey(scope: RuleScope): string {
  return `${scope.scope}:${scope.unitId}:${scope.groupId}`;
}
/** `03` from the chapter's position (matches the server's `Ch 03` labels). */
export function chapterNumber(course: Pick<Course, "units">, unitId: string): string {
  const index = course.units.findIndex((u) => u.id === unitId);
  return index < 0 ? unitId : String(index + 1).padStart(2, "0");
}
export function scopeTitle(scope: RuleScope, course: Pick<Course, "units">, groups: readonly { id: string; name: string }[]): string {
  const base = scope.scope === "course" ? "Course default" : course.units.find((u) => u.id === scope.unitId)?.title ?? scope.unitId;
  const group = groups.find((g) => g.id === scope.groupId);
  return group ? `${base} · ${group.name}` : base;
}
export function resetLabel(scope: RuleScope): string {
  // S-m02: a reset rule falls back to the next scope of the resolution order (unit+group → chapter → course → platform)
  if (scope.scope === "course") return scope.groupId ? "Reset to course rules" : "Reset to platform default";
  return scope.groupId ? "Reset to this chapter's rules" : "Reset to course default";
}

/** Overview/chapter-select labels: `Default`, `Customized · v4 · 10/21`, `Uses course default` [AU-D2-23]. */
export function cellLabel(cell: OverviewCell | null | undefined, timeZone?: string): string {
  if (!cell || cell.status === "default") return "Default";
  if (cell.status === "customized") return `Customized · v${cell.version ?? "?"} · ${formatShortDate(cell.updatedAt, timeZone)}`;
  if (cell.inheritsFrom === "unit" || cell.inheritsFrom === "unit-group") return "Uses chapter rules";
  return "Uses course default";
}
/** Chapter card link: `AI tutor: Customized v4` or `Uses default AI rules`. */
export function chapterRuleLink(cell: OverviewCell | null | undefined): string {
  if (!cell || cell.status === "default") return "Uses default AI rules";
  if (cell.status === "customized") return `AI tutor: Customized v${cell.version ?? "?"}`;
  return "AI tutor: Uses course default";
}
export function statusBarText(status: AiStatus | null, loading = false): string {
  if (!status) return loading ? "AI tutor: checking…" : "AI tutor: status unavailable";
  return status.configured ? `AI tutor: Connected · ${status.model ?? "server default model"}` : STATUS_NOT_CONFIGURED;
}
export function modelOptions(status: AiStatus | null): { value: string; label: string }[] {
  const def = status?.model ? `Server default (${status.model})` : "Server default";
  return [{ value: "", label: def }, ...(status?.modelAllowlist ?? []).map((m) => ({ value: m, label: m }))];
}

// ─── Versions, diffs, tests ────────────────────────────────────────────────────────────────────

export function isInheritConfig(config: PolicyVersion["config"]): config is { inherit: true } {
  return (config as { inherit?: boolean }).inherit === true;
}
export function versionLabel(v: PolicyVersion, timeZone?: string): string {
  const parts = [`v${v.version}`, formatShortDate(v.createdAt, timeZone), v.createdBy || v.createdByRole];
  return parts.filter(Boolean).join(" · ");
}
export function versionDescription(v: PolicyVersion, history: readonly PolicyVersion[]): string {
  const restored = v.restoredFrom ? history.find((h) => h.id === v.restoredFrom) : undefined;
  const parts: string[] = [];
  if (isInheritConfig(v.config)) parts.push("Uses broader rules (reset)");
  if (v.restoredFrom) parts.push(restored ? `Restored from v${restored.version}` : "Restored from an earlier version");
  if (v.note) parts.push(v.note);
  return parts.join(" · ");
}
const DIFF_LABELS: Record<string, string> = {
  tutoringInstructions: LABELS.tutoringInstructions,
  generationInstructions: LABELS.generationInstructions,
  groundingNotes: FIELD_LABELS.groundingNotes,
  helpLevel: FIELD_LABELS.helpLevel,
  replyLanguage: FIELD_LABELS.replyLanguage,
  minDifficulty: LABELS.lowestDifficulty,
  maxDifficulty: LABELS.highestDifficulty,
  startingDifficulty: LABELS.startingDifficulty,
  allowedTypes: FIELD_LABELS.allowedTypes,
  choiceCount: FIELD_LABELS.choiceCount,
  maxOutputTokens: "Max AI reply length",
  historyTurns: FIELD_LABELS.historyTurns,
  model: FIELD_LABELS.model,
  reasoningEffort: FIELD_LABELS.reasoningEffort,
  aiTutorEnabled: FIELD_LABELS.aiTutorEnabled,
  generationEnabled: FIELD_LABELS.generationEnabled,
  "feedback.revealAfterAttempts": "Reveal the answer after wrong attempts",
  "feedback.showExplanationOnWrong": FIELD_LABELS.showExplanationOnWrong,
  "practice.allowFocusNote": "Allow \"What would you like to work on?\"",
  "practice.dailyItemLimit": "Daily practice items per student",
  "practice.unlockAfterCorrect": "Unlock a harder level after correct answers",
  contextFields: FIELD_LABELS.contextFields,
  localGuidance: FIELD_LABELS.localGuidance,
  inherit: "Uses broader rules",
};
export function diffFieldLabel(field: string): string {
  const level = /^difficultyRubric\.([1-5])$/.exec(field);
  if (level) return `Difficulty level ${level[1]} description`;
  return DIFF_LABELS[field] ?? field;
}
export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map((v) => (AI_TYPES.includes(v as AiQuestionType) ? questionTypeLabel(v as AiQuestionType) : String(v))).join(", ") : "None";
  return String(value);
}
export function diffRows(diff: readonly PolicyDiff[]): { label: string; before: string; after: string }[] {
  return diff.map((d) => ({ label: diffFieldLabel(d.field), before: formatDiffValue(d.before), after: formatDiffValue(d.after) }));
}

/**
 * "Homework context" line of a test result (RV6-M10). A chosen homework question makes the reply graded homework even
 * when the typed message does not quote it; the pasted-text match is reported as a second, separate signal.
 */
export function homeworkContextLine(
  chosen: Pick<HomeworkQuestionOption, "assignmentId" | "questionId" | "assignmentTitle" | "label" | "protected"> | null,
  match: { assignmentId: string; questionId: string; containment: number | null } | null | undefined,
  questions: readonly Pick<HomeworkQuestionOption, "assignmentId" | "questionId" | "assignmentTitle" | "label">[] = [],
): string {
  const pct = match && match.containment !== null ? ` (${Math.round(match.containment * 100)}% of the question)` : "";
  if (chosen) {
    const name = `${chosen.assignmentTitle} · ${chosen.label}`;
    const head = chosen.protected
      ? `Graded homework: you chose ${name}, so the reply is checked for final answers.`
      : `You chose ${name}; its answers are no longer protected (the homework is closed or shows solutions).`;
    const quoted = match && match.assignmentId === chosen.assignmentId && match.questionId === chosen.questionId;
    return quoted ? `${head} The message also quotes it${pct}.` : head;
  }
  if (match) {
    const found = questions.find((q) => q.assignmentId === match.assignmentId && q.questionId === match.questionId);
    return `Graded homework: the message quotes ${found ? `${found.assignmentTitle} · ${found.label}` : "a homework question"}${pct}, so the reply is checked for final answers.`;
  }
  return "Not homework: no homework question chosen, and the message does not quote one of this chapter.";
}

export interface TextDiff { prefix: string; removed: string; added: string; suffix: string }
/**
 * Word-level change between two values (RV6-M06): the shared start and end are kept plain and only the changed middle
 * is marked, so a sentence appended to long tutoring instructions stands out in the comparison.
 */
export function textDiff(before: string, after: string): TextDiff {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  return {
    prefix: a.slice(0, start).join(""),
    removed: a.slice(start, a.length - end).join(""),
    added: b.slice(start, b.length - end).join(""),
    suffix: a.slice(a.length - end).join(""),
  };
}

const GUARD_LABELS: Record<GuardView["status"], string> = {
  not_applicable: "Not a graded question (guard not needed)",
  clean: "No final answer found",
  retried_clean: "Final answer caught — rewritten as hints",
  redacted: "Final answer caught — hidden in the reply",
  blocked: "Final answer caught — item blocked",
};
export function guardStatusLabel(status: GuardView["status"] | null | undefined): string {
  return status ? GUARD_LABELS[status] ?? status : "—";
}
export type ExpectationChoice = "guard_clean" | "guard_leak_handled" | "item_valid" | "homework_matched";
export const EXPECTATION_OPTIONS: readonly { value: ExpectationChoice; label: string; action?: "chat" | "question" }[] = [
  { value: "guard_clean", label: "Guard: no final answer" },
  { value: "guard_leak_handled", label: "Guard: final answer is caught" },
  { value: "item_valid", label: "Generates a valid item", action: "question" },
  { value: "homework_matched", label: "Recognized as homework" },
];
export function expectFromChoice(choice: ExpectationChoice): AiTestSample["expect"] {
  switch (choice) {
    case "guard_clean":
      return { guard: "clean" };
    case "guard_leak_handled":
      return { guard: "leak_handled" };
    case "item_valid":
      return { itemValid: true };
    default:
      return { homeworkMatched: true };
  }
}
export function expectationLabel(expect: AiTestSample["expect"]): string {
  const parts: string[] = [];
  if (expect.guard === "clean") parts.push("Guard: no final answer");
  if (expect.guard === "leak_handled") parts.push("Guard: final answer is caught");
  if (expect.itemValid !== undefined) parts.push(expect.itemValid ? "Generates a valid item" : "Item is rejected");
  if (expect.homeworkMatched !== undefined) parts.push(expect.homeworkMatched ? "Recognized as homework" : "Not recognized as homework");
  return parts.join(" · ") || "No expectation";
}
export function savedCheckOutcome(r: AiTestSampleResult): { label: string; tone: "success" | "danger" | "neutral" } {
  if (r.passed === null) return { label: "Dry run", tone: "neutral" };
  return r.passed ? { label: "Passed", tone: "success" } : { label: "Failed", tone: "danger" };
}
export function savedChecksSummary(results: readonly AiTestSampleResult[]): string {
  if (!results.length) return "No saved checks for these rules yet.";
  if (results.every((r) => r.passed === null)) return `${results.length} saved ${results.length === 1 ? "check" : "checks"} assembled (dry run, no AI call).`;
  const failed = results.filter((r) => r.passed === false).length;
  const checks = results.length === 1 ? "saved check" : "saved checks";
  if (failed) return `${failed} of ${results.length} ${checks} failed. You can still save; review the failures first.`;
  return results.length === 1 ? "The saved check passed." : `All ${results.length} saved checks passed.`;   // S-m13
}
export function testActionLabel(action: "chat" | "question"): string {
  return action === "chat" ? "Ask Kiwi reply" : "Generate practice";
}

// ─── Chapters page helpers ─────────────────────────────────────────────────────────────────────

/** "This week's chapter is now 03" (toast after the dropdown saves) [LY03]. */
export function thisWeekToast(course: Pick<Course, "units">, unitId: string): string {
  return `${LABELS.thisWeeksChapter} is now ${chapterNumber(course, unitId)}`;
}
/**
 * S-M03: what ticking "Use as AI reference" does, given whether the chapter's AI tutor rules let the AI see chapter files
 * (What the AI sees › "Chapter files marked Use as AI reference"). Without that setting the file is marked but not sent.
 */
export function aiReferenceMessage(fileName: string, value: boolean, aiSeesMaterials: boolean | undefined): string {
  if (!value) return `${fileName} is no longer used as AI reference.`;
  if (aiSeesMaterials === false)
    return `${fileName} is marked as AI reference, but the AI does not see it yet: in this chapter's AI tutor rules, tick What the AI sees › “Chapter files marked Use as AI reference”.`;
  return `${fileName} is now AI reference material for this chapter.`;
}
export const AI_REFERENCE_OFF_NOTE = "Not sent to the AI yet: this chapter's AI tutor rules do not include chapter files.";

/** Only text files can serve as AI reference material [AU-D1-17]. */
export function canUseAsAiReference(name: string): boolean {
  return /\.(md|qmd|txt)$/i.test(name.trim());
}
export function moveUnit<T>(units: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || index >= units.length || target < 0 || target >= units.length) return [...units];
  const next = [...units];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}
export function moveUnitTo<T>(units: readonly T[], from: number, to: number): T[] {
  return moveUnit(units, from, to - from);
}
export function togglePackage(packages: readonly string[], name: string, on: boolean): string[] {
  const next = on ? [...packages.filter((p) => p !== name), name] : packages.filter((p) => p !== name);
  return WEBR_PACKAGE_ALLOWLIST.filter((p) => next.includes(p));
}
export function toggleDataset(ids: readonly string[], fileId: string, on: boolean): string[] {
  return on ? [...ids.filter((id) => id !== fileId), fileId] : ids.filter((id) => id !== fileId);
}
export function effectiveAccessLabel(access: Unit["effectiveAccess"]): string {
  return { open: "Open now", review: LABELS.review, locked: LABELS.opensLater, hidden: LABELS.accessHidden }[access];
}
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 104857.6) / 10} MB`;
}
