import { displayTimeZone } from "../../lib/format";
import type { AnswerDraft, AssignmentState } from "../../types";

/*
 * Server answer drafts for the student assignment page [DA07, AU-D3-08, AU-D1-14] (ASSESS).
 * - `createDraftSync` debounces edits (2 s) into one `PUT /api/drafts/{id}`; one request in flight at a time; failed
 *   saves stay pending and are retried with the next edit or `flush()`.
 * - The local copy (localStorage) is an offline fallback only; `mergeDrafts` keeps whichever value is newer per question.
 * - `pruneStale` drops answers for questions that no longer exist, so submit sends only current ids.
 */

export const DRAFT_DEBOUNCE_MS = 2000;

export interface LocalEntry { value: string; ts: number }
export type LocalDraft = Record<string, LocalEntry>;

export interface DraftSyncOptions {
  save: (answers: Record<string, string>, clientTs: number) => Promise<AnswerDraft>;
  delayMs?: number;
  now?: () => number;
  onSaved?: (draft: AnswerDraft, savedAt: number) => void;
  onError?: (error: unknown) => void;
  onPending?: (pending: number) => void;
}

export interface DraftSync {
  update: (questionId: string, value: string) => void;
  flush: () => Promise<void>;
  pending: () => Record<string, string>;
  dispose: () => void;
}

export function createDraftSync(opts: DraftSyncOptions): DraftSync {
  const delay = opts.delayMs ?? DRAFT_DEBOUNCE_MS;
  const now = opts.now ?? Date.now;
  let pending: Record<string, string> = {};
  let changedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
  };
  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight) {
      await inFlight;
      if (Object.keys(pending).length) return flush();
      return;
    }
    const snapshot = { ...pending };
    if (!Object.keys(snapshot).length || disposed) return;
    const clientTs = changedAt || now();
    inFlight = (async () => {
      try {
        const draft = await opts.save(snapshot, clientTs);
        for (const [qid, value] of Object.entries(snapshot)) if (pending[qid] === value) delete pending[qid];
        opts.onPending?.(Object.keys(pending).length);
        if (!disposed) opts.onSaved?.(draft, now());
      } catch (error) {
        if (!disposed) opts.onError?.(error);
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  };
  return {
    update(questionId, value) {
      if (disposed) return;
      pending = { ...pending, [questionId]: value };
      changedAt = now();
      opts.onPending?.(Object.keys(pending).length);
      schedule();
    },
    flush,
    pending: () => ({ ...pending }),
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Keep only answers for current question ids; returns the removed ids for the "assignment was updated" notice. */
export function pruneStale<T>(answers: Record<string, T>, questionIds: readonly string[]): { answers: Record<string, T>; removed: string[] } {
  const keep: Record<string, T> = {};
  const removed: string[] = [];
  for (const [qid, value] of Object.entries(answers)) {
    if (questionIds.includes(qid)) keep[qid] = value;
    else removed.push(qid);
  }
  return { answers: keep, removed };
}

/** Per question, the newer of the server draft and the local fallback copy; `unsynced` lists local values to re-send. */
export function mergeDrafts(server: AnswerDraft | null, local: LocalDraft): { answers: Record<string, string>; unsynced: string[] } {
  const answers: Record<string, string> = {};
  const unsynced: string[] = [];
  for (const [qid, entry] of Object.entries(server?.answers ?? {})) answers[qid] = entry.value;
  for (const [qid, entry] of Object.entries(local)) {
    const remote = server?.answers[qid];
    const remoteTs = remote ? Date.parse(remote.updatedAt) : Number.NEGATIVE_INFINITY;
    if (!remote || (entry.ts > remoteTs && entry.value !== remote.value)) {
      answers[qid] = entry.value;
      if (entry.value !== (remote?.value ?? "")) unsynced.push(qid);
    }
  }
  return { answers, unsynced };
}

/** Reads the local fallback copy; understands the v0.5.1 format (a plain `{qid: answer}` object). */
export function readLocalDraft(key: string): LocalDraft {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return {}; // WHY: storage can be blocked (private mode); the server draft still restores answers
  }
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (data && typeof data === "object" && (data as { v?: number }).v === 2) return ((data as { answers?: LocalDraft }).answers ?? {}) as LocalDraft;
    if (data && typeof data === "object")
      return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, { value: v as string, ts: 0 }]));
  } catch {
    return {};
  }
  return {};
}

/** Writes the local fallback copy; returns false when the browser refuses storage. */
export function writeLocalDraft(key: string, draft: LocalDraft): boolean {
  try {
    localStorage.setItem(key, JSON.stringify({ v: 2, answers: draft }));
    return true;
  } catch {
    return false;
  }
}

export const UPDATED_NOTICE = "This assignment was updated; review your answers.";
/**
 * R-m01: the notice says nothing once the assignment no longer accepts answers (closed or archived, e.g. closed by
 * publishing its revision): there is nothing left to review, and the header already says it is closed.
 */
export function draftNotice(storedVersion: number | null, currentVersion: number, removed: readonly string[], state?: AssignmentState): string {
  if (state === "closed" || state === "archived") return "";
  return removed.length || (storedVersion !== null && storedVersion !== currentVersion) ? UPDATED_NOTICE : "";
}

/** "Saved to your account · 10:42" | "Saving…" | "Saved on this device only — will retry". */
export function savedLabel(state: { savedAt: number | null; pending: number; failing: boolean }, timeZone?: string): string {
  if (state.failing) return "Saved on this device only — will retry";
  if (state.pending > 0) return "Saving…";
  if (state.savedAt === null) return "";
  // RV6-m05: the course time zone (as the due date and the submissions list), not the browser's
  const time = new Date(state.savedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timeZone ?? displayTimeZone() });
  return `Saved to your account · ${time}`;
}
