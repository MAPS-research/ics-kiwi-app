import { api, ApiError } from "./api";
import { DIFFICULTY_OPTIONS } from "./labels";
import { threadFor } from "./navigation";
import type {
  AiQuestionType,
  AskKiwiMode,
  Course,
  Difficulty,
  EffectiveUnitAccess,
  GeneratedItemPublic,
  GuardView,
  ItemCheckResult,
  PolicyConfig,
  PracticeStatus,
  Surface,
  Tracker,
} from "../types";

/*
 * Practice and Ask Kiwi helpers (AIRUN, §12.8). The client no longer generates or checks questions: items come from
 * POST /api/ai/question|similar without answer keys and are checked by the server. This module keeps typed API
 * wrappers, `normalizeAnswer` for display, and pure label/notice builders that the student pages and tests share.
 */

// ─── Display helpers ───────────────────────────────────────────────────────────────────────────

/** Display normalization only (the server decides correctness). */
export function normalizeAnswer(answer: string): string {
  return answer
    .trim()
    .toLowerCase()
    .replace(/^\[1\]\s*/, "")
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+/g, "");
}

export const LOCAL_GUIDANCE_LABEL = "Local guidance";
export const LAB_AI_LABEL = "Ask Kiwi";   // student side says "Ask Kiwi" (TH14 / review 2 TEACHER-14)

// ─── Threads (surface-prefixed, AIRUN-12 / AU-D3-M07) ─────────────────────────────────────────

export interface ThreadScope { unitId: string; assignmentId?: string; questionId?: string; itemId?: string }

/** `thread-standalone-<unit>`, `thread-assignment-<aid>-<qid>`, `thread-similar-<item>`, `thread-practice-<item|unit>`, … */
export function chatThreadId(surface: Surface, scope: ThreadScope): string {
  switch (surface) {
    case "ask-kiwi":
      return threadFor(`standalone-${scope.unitId}`);
    case "assignment":
      return threadFor(`assignment-${scope.assignmentId || "none"}-${scope.questionId || scope.unitId}`);
    case "similar":
      return threadFor(`similar-${scope.itemId || scope.questionId || scope.unitId}`);
    case "free-practice":
      return threadFor(`practice-${scope.itemId || scope.questionId || scope.unitId}`);
    case "workspace":
      return threadFor(`workspace-${scope.unitId}`);
    default:
      return threadFor(`${surface}-${scope.unitId}`);
  }
}

/** The v0.5.1 thread id of the same chat (its history still loads, shown before the new turns). */
export function legacyThreadId(scope: ThreadScope): string {
  return threadFor(`${scope.assignmentId || "practice"}-${scope.questionId || scope.itemId || scope.unitId}`);
}

// ─── Chapter and difficulty options (AIRUN-04, AIRUN-25, NM42) ────────────────────────────────

export interface SelectOption<T extends string | number> { value: T; label: string; disabled: boolean }

/** Chapter select: hidden chapters omitted, locked ones `… (Opens later)` (disabled); Review chapters allow Ask Kiwi only. */
export function chapterOptions(course: Pick<Course, "units">, purpose: "practice" | "chat"): SelectOption<string>[] {
  return course.units
    .filter((u) => u.effectiveAccess !== "hidden")
    .map((u) => {
      const access: EffectiveUnitAccess = u.effectiveAccess ?? "open";
      if (access === "locked") return { value: u.id, label: `${u.title} (Opens later)`, disabled: true };
      if (access === "review")
        return purpose === "practice"
          ? { value: u.id, label: `${u.title} (Review — Ask Kiwi only)`, disabled: true }
          : { value: u.id, label: `${u.title} (Review)`, disabled: false };
      return { value: u.id, label: u.title, disabled: false };
    });
}

/** First chapter the purpose can use, preferring `preferred`. */
export function firstUsableChapter(course: Pick<Course, "units">, purpose: "practice" | "chat", preferred: string): string {
  const options = chapterOptions(course, purpose);
  const wanted = options.find((o) => o.value === preferred && !o.disabled);
  return (wanted ?? options.find((o) => !o.disabled) ?? options[0])?.value ?? preferred;
}

/** `3 · Combine two steps (locked)` above the unlocked maximum (unlock rule, AIRUN-25). */
export function difficultyOptions(
  policy: { minDifficulty: number; maxDifficulty: number; difficultyRubric?: Partial<PolicyConfig["difficultyRubric"]> },
  unlockedMax: number | null,
): SelectOption<Difficulty>[] {
  const out: SelectOption<Difficulty>[] = [];
  for (let n = policy.minDifficulty; n <= policy.maxDifficulty; n += 1) {
    const level = n as Difficulty;
    const rubric = policy.difficultyRubric?.[String(n) as "1"];
    const base = rubric ? `${n} · ${rubric}` : DIFFICULTY_OPTIONS[level];
    const locked = unlockedMax !== null && n > unlockedMax;
    out.push({ value: level, label: locked ? `${base} (locked)` : base, disabled: locked });
  }
  return out;
}

// ─── Notices ───────────────────────────────────────────────────────────────────────────────────

/** Assignment help-level notice shown above Ask Kiwi (TH02). */
export function helpLevelNotice(askKiwi: AskKiwiMode | null | undefined): string | null {
  switch (askKiwi) {
    case "hints_only":
      return "Ask Kiwi gives hints only for this assignment";
    case "off":
      return "Ask Kiwi is turned off for this assignment";
    case "explain_concepts":
      return "Ask Kiwi explains concepts for this assignment but won't solve it";
    case "worked_examples":
      return "Ask Kiwi can show worked examples of similar problems for this assignment";
    default:
      return null;
  }
}

/** Guard notice when the server rewrote or shortened a reply (§12.5). */
export function guardNotice(status: GuardView["status"] | undefined | null): string | null {
  if (status === "redacted") return "Kiwi hid part of this reply because it would have given away a graded answer.";
  if (status === "retried_clean") return "Kiwi rewrote this reply as hints so your graded answer stays yours.";
  return null;
}

export function sourceLabel(source: "lab-ai" | "local" | string): string {
  return source === "local" ? LOCAL_GUIDANCE_LABEL : source === "kiwi-ai" ? "Kiwi AI" : source === "lab-ai" ? "Lab AI (historical)" : LAB_AI_LABEL;
}

export function itemSourceLabel(source: GeneratedItemPublic["source"]): string {
  return source === "ai" ? "Made by Ask Kiwi" : source === "teacher_bank" ? "From your teacher's exercises" : "Local template";
}

export const VERIFICATION_MISMATCH = "This exercise failed an automatic check; its answer key may be wrong.";
export const EXPLANATION_WITHHELD = "The explanation is shown after the homework closes.";

export interface CheckFeedbackView {
  tone: "correct" | "incorrect" | "neutral";
  /** the verdict line ("Correct.", "Answer recorded.", "Try again. …") */
  text: string;
  /** the item's explanation as written (AI explanations carry Markdown and fenced R code; render with ResponseText) */
  explanation: string | null;
  /** "The explanation is shown after the homework closes." while the homework is protected */
  note: string | null;
}

/**
 * Feedback for a server check result (correct / incorrect / recorded for written explanations). RT-01: the explanation
 * is kept apart from the verdict so the view renders its Markdown and code like the prompt, not as plain text.
 */
export function checkFeedback(result: ItemCheckResult): CheckFeedbackView {
  const explanation = result.explanation?.trim() ? result.explanation : null;
  const note = result.explanationWithheld ? EXPLANATION_WITHHELD : null;
  if (result.correct === true) return { tone: "correct", text: "Correct.", explanation, note };
  if (result.correct === null) return { tone: "neutral", text: "Answer recorded.", explanation, note };
  return { tone: "incorrect", text: "Try again. Inspect the code or ask Kiwi for a hint.", explanation, note: null };
}

/** Student-readable message for an AI request error (specific per server code, AIRUN-06). */
export function aiErrorMessage(error: unknown): string {
  if (error instanceof RequestTimeout) return "Kiwi took too long to answer. Check your connection and try again.";
  if (error instanceof ApiError) {
    if (error.status === 0) return "Could not reach CSS Lab. Check your connection and try again.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

// ─── Unreached requests (AIRUN-26 / AU-D3-10) ─────────────────────────────────────────────────

export class RequestTimeout extends Error {
  constructor(ms: number) {
    super(`No answer within ${Math.round(ms / 1000)} s`);
    this.name = "RequestTimeout";
  }
}

/** Reject with `RequestTimeout` when `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestTimeout(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export type UnreachedReason = "network" | "timeout" | "http_error";

/**
 * Why a request never got a CSS Lab answer: `network` (no HTTP response), `timeout` (client gave up), `http_error`
 * (a proxy/server error page without the Lab's JSON error body). Returns null when the Lab answered (the server has
 * then already logged the request in `ai_calls`).
 */
export function unreachedReason(error: unknown): { reason: UnreachedReason; httpStatus: number | null } | null {
  if (error instanceof RequestTimeout) return { reason: "timeout", httpStatus: null };
  if (error instanceof ApiError) {
    if (error.status === 0) return { reason: "network", httpStatus: null };
    if (error.status >= 500 && /^Request failed \(\d+\)$/.test(error.message)) return { reason: "http_error", httpStatus: error.status };
    return null;
  }
  if (error instanceof TypeError) return { reason: "network", httpStatus: null };
  return null;
}

export interface UnreachedContext { action: "chat" | "question" | "similar"; surface: Surface; unitId: string; assignmentId?: string; questionId?: string; itemId?: string }

/** Enqueue `ai_request_unreached` through the telemetry outbox when the request never reached the server. */
export async function reportUnreached(track: Tracker, error: unknown, ctx: UnreachedContext): Promise<boolean> {
  const why = unreachedReason(error);
  if (!why) return false;
  await track(
    "ai_request_unreached",
    { action: ctx.action, surface: ctx.surface, reason: why.reason, httpStatus: why.httpStatus, unitId: ctx.unitId,
      assignmentId: ctx.assignmentId, questionId: ctx.questionId, itemId: ctx.itemId },
    ctx.questionId ?? ctx.itemId,
  );
  return true;
}

// ─── Practice settings events (AIRUN-13) ──────────────────────────────────────────────────────

export interface PracticeSettings { unitId: string; type: AiQuestionType; difficulty: Difficulty; focusNote: string }

/** One `practice_settings_changed` payload per changed field. */
export function settingsChanges(prev: PracticeSettings, next: PracticeSettings): { field: "unit" | "type" | "difficulty" | "focusNote"; from: unknown; to: unknown }[] {
  const out: { field: "unit" | "type" | "difficulty" | "focusNote"; from: unknown; to: unknown }[] = [];
  if (prev.unitId !== next.unitId) out.push({ field: "unit", from: prev.unitId, to: next.unitId });
  if (prev.type !== next.type) out.push({ field: "type", from: prev.type, to: next.type });
  if (prev.difficulty !== next.difficulty) out.push({ field: "difficulty", from: prev.difficulty, to: next.difficulty });
  if (prev.focusNote.trim() !== next.focusNote.trim()) out.push({ field: "focusNote", from: prev.focusNote.length, to: next.focusNote.length });
  return out;
}

/** `question_skipped` payload when the student moves on before a correct answer (null otherwise). */
export function skippedPayload(item: Pick<GeneratedItemPublic, "id" | "unitId"> | null, correct: boolean | null | undefined, attempts: number):
  { itemId: string; attempted: boolean; unitId: string } | null {
  if (!item || correct === true) return null;
  return { itemId: item.id, attempted: attempts > 0, unitId: item.unitId };
}

// ─── API wrappers (§6.6) ──────────────────────────────────────────────────────────────────────

/** Shared §7.6 types since CR-AIRUN-2 (kept as aliases for existing imports). */
export type { PracticeStatus } from "../types";
export type CheckResultView = ItemCheckResult;

export const AI_TIMEOUT_MS = 75_000;

export function generateItem(classId: string, b: { studentId: string; unitId: string; type: AiQuestionType; difficulty: Difficulty; focusNote?: string }): Promise<GeneratedItemPublic> {
  return withTimeout(api.generateItem(classId, { ...b, surface: "free-practice" }), AI_TIMEOUT_MS);
}
export function generateSimilar(classId: string, b: { studentId: string; assignmentId: string; questionId: string; difficulty: Difficulty; type?: AiQuestionType }): Promise<GeneratedItemPublic> {
  return withTimeout(api.generateSimilar(classId, b), AI_TIMEOUT_MS);
}
export function checkItem(classId: string, itemId: string, b: { answer: string; runOutput?: string; eventId?: string; timeOnItemMs?: number }): Promise<CheckResultView> {
  return api.checkItem(classId, itemId, b);   // CR-AIRUN-3: timeOnItemMs is typed now
}
export function revealItem(classId: string, itemId: string): Promise<{ answer: string; explanation: string }> {
  return api.revealItem(classId, itemId);
}
export function verifyItem(classId: string, itemId: string, b: { runOutput: string; ok: boolean }): Promise<{ recorded: true }> {
  return api.verifyItem(classId, itemId, b);
}
/** Additive endpoint (AIRUN; typed by CR-AIRUN-3): usage today and the unlocked maximum difficulty for one chapter. */
export function practiceStatus(classId: string, unitId: string): Promise<PracticeStatus> {
  return api.practiceStatus(classId, unitId);
}

/** Unlocked maximum after a `difficulty_locked` error (details `{level, needed, have}`). */
export function lockedFrom(error: unknown): number | null {
  if (error instanceof ApiError && error.code === "difficulty_locked") {
    const level = Number((error.details as { level?: unknown } | undefined)?.level);
    return Number.isFinite(level) ? level - 1 : null;
  }
  return null;
}

// ─── Verification run (one webR run of a predict item's code, sent once) ──────────────────────

export type CodeRunner = (code: string) => Promise<{ ok: boolean; output: string; stdout?: string; error?: string }>;
const verified = new Set<string>();

/**
 * After the first check of a predict item, run its code in webR and post the result once (no answer oracle: the
 * response never says whether it matched). Returns false when skipped (already sent or nothing to run).
 */
export async function verifyAfterFirstCheck(classId: string, item: Pick<GeneratedItemPublic, "id" | "code" | "needsVerification">, runner: CodeRunner): Promise<boolean> {
  if (!item.needsVerification || !item.code || verified.has(item.id)) return false;
  verified.add(item.id);
  let result: { ok: boolean; output: string; stdout?: string; error?: string };
  try {
    result = await runner(item.code);
  } catch {
    // WHY: webR could not start on this device — that says nothing about the answer key, so nothing is sent.
    verified.delete(item.id);
    return false;
  }
  try {
    await verifyItem(classId, item.id, { runOutput: (result.stdout || result.output || result.error || "").slice(0, 40000), ok: result.ok });
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "already_verified")) {
      verified.delete(item.id); // WHY: allow one retry on the next check when the request itself failed
      throw error;
    }
  }
  return true;
}

/** Default runner: the shared webR engine in its own environment (loaded on demand so tests never start webR). */
export const webRRunner: CodeRunner = async (code) => {
  const { runR } = await import("./rEngine");
  const result = await runR(code, { envKey: `verify:${Date.now()}`, graphics: false });
  const stdout = result.entries?.filter((e) => e.type === "stdout").map((e) => e.text).join("\n");
  return { ok: Boolean(result.ok), output: String(result.output ?? ""), stdout: stdout || undefined, error: result.error };
};

/** Test hook. */
export function resetVerificationMemory(): void {
  verified.clear();
}
