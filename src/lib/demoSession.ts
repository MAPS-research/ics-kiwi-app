import { api } from "./api";

/*
 * Standalone demo identities (§5.3 "Standalone student identity"). Built-in demo students get a session from
 * POST /api/demo/session; other students come from an instructor's demo link whose token travels in the URL fragment
 * (`#demo=<token>`), is exchanged once and removed with history.replaceState. Nothing runs at import time.
 */

export interface DemoIdentity { studentId: string; studentName: string }
export interface DemoSession extends DemoIdentity { token: string; expiresAt: string }

export const BUILT_IN_DEMO_STUDENTS: readonly DemoIdentity[] = [
  { studentId: "demo-ada", studentName: "Ada Chen" },
  { studentId: "demo-bo", studentName: "Bo Lin" },
];
const SELECTED_KEY = "kiwi-lab-student";
const sessionKey = (classId: string, studentId: string) => `kiwi-demo-session:${classId}:${studentId}`;
const linkedKey = (classId: string) => `kiwi-demo-linked:${classId}`;

/** The demo-link token in a URL fragment, or null. */
export function parseDemoFragment(hash: string): string | null {
  const match = /(?:^#|&)demo=([^&]+)/.exec(hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
/** The fragment without the demo token ("" when nothing else remains). */
export function stripDemoFragment(hash: string): string {
  const rest = hash.replace(/^#/, "").split("&").filter((part) => part && !part.startsWith("demo="));
  return rest.length ? `#${rest.join("&")}` : "";
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // WHY: the session still works for this page; the student picks the identity again after a reload.
  }
}

/** v0.5.1 stored "ada"/"bo"; v0.6 stores the full student id. */
export function selectedDemoStudent(): string {
  let value: string | null = null;
  try {
    value = localStorage.getItem(SELECTED_KEY);
  } catch {
    value = null;
  }
  if (!value) return "demo-ada";
  return value === "ada" || value === "bo" ? `demo-${value}` : value;
}
export function selectDemoStudent(studentId: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, studentId);
  } catch {
    // selection is per page load when storage is unavailable
  }
}

export function readDemoSession(classId: string, studentId: string, now = Date.now()): DemoSession | null {
  const stored = readJson<DemoSession>(sessionKey(classId, studentId));
  if (!stored || stored.studentId !== studentId || typeof stored.token !== "string") return null;
  const expires = Date.parse(stored.expiresAt);
  return Number.isNaN(expires) || expires - now < 60_000 ? null : stored;
}
export function storeDemoSession(classId: string, session: DemoSession): void {
  writeJson(sessionKey(classId, session.studentId), session);
}

/** Students added through demo links on this browser (shown in the demo picker). */
export function linkedDemoStudents(classId: string): DemoIdentity[] {
  const list = readJson<DemoIdentity[]>(linkedKey(classId));
  return Array.isArray(list) ? list.filter((s) => s && typeof s.studentId === "string" && typeof s.studentName === "string") : [];
}
function rememberLinkedStudent(classId: string, identity: DemoIdentity): void {
  if (BUILT_IN_DEMO_STUDENTS.some((s) => s.studentId === identity.studentId)) return;
  const others = linkedDemoStudents(classId).filter((s) => s.studentId !== identity.studentId);
  writeJson(linkedKey(classId), [...others, identity]);
}

export function demoChoices(classId: string): DemoIdentity[] {
  return [...BUILT_IN_DEMO_STUDENTS, ...linkedDemoStudents(classId)];
}

/** A valid session for the student: the stored one, or a new one for a built-in demo student. */
export async function ensureDemoSession(classId: string, studentId: string): Promise<DemoSession> {
  const stored = readDemoSession(classId, studentId);
  if (stored) return stored;
  if (!BUILT_IN_DEMO_STUDENTS.some((s) => s.studentId === studentId))
    throw new Error("This demo link has expired. Ask your teacher for a new link, or choose Ada Chen or Bo Lin.");
  const session = await api.demoSession(classId, { studentId });
  storeDemoSession(classId, session);
  return session;
}

/** Exchanges a `#demo=` token for a session and remembers the student for the picker. */
export async function exchangeDemoToken(classId: string, token: string): Promise<DemoSession> {
  const session = await api.demoSession(classId, { token });
  storeDemoSession(classId, session);
  rememberLinkedStudent(classId, { studentId: session.studentId, studentName: session.studentName });
  selectDemoStudent(session.studentId);
  return session;
}
