/*
 * Where "Exit preview" goes (RV6-m01): the teacher page that opened Preview as student (the assignment editor, the
 * assignments list), so the Save draft · Preview · Publish now loop continues. Stored per tab in sessionStorage;
 * only teacher paths are accepted, and any storage failure falls back to the teacher Home.
 */

const KEY = "kiwi-preview-return";

/** A same-origin teacher path such as `/teacher/assignments/w1/edit`; anything else is rejected. */
export function isTeacherReturnPath(path: unknown): path is string {
  return typeof path === "string" && /^\/teacher(\/|$|\?)/.test(path) && !path.startsWith("//") && !/[\s\\]/.test(path);
}

export function rememberPreviewReturn(path: string, storage: Pick<Storage, "setItem"> | null = safeSession()): void {
  if (!storage || !isTeacherReturnPath(path)) return;
  try {
    storage.setItem(KEY, path);
  } catch {
    // WHY: without storage Exit preview falls back to Home, which is the previous behaviour
  }
}

/** The remembered path (consumed), or `fallback`. */
export function takePreviewReturn(fallback: string, storage: Pick<Storage, "getItem" | "removeItem"> | null = safeSession()): string {
  if (!storage) return fallback;
  try {
    const value = storage.getItem(KEY);
    storage.removeItem(KEY);
    return isTeacherReturnPath(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}
