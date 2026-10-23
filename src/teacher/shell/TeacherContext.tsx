import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, hasKiwiIdentity, setNameModeHeader, setTeacherKeyHeader } from "../../lib/api";
import { normalizeCourse } from "../../lib/course";
import { setDisplayTimeZone } from "../../lib/format";
import { useTimeRange } from "../../lib/timeRange";
import type { Course, Me, NameMode, Permission, StaffRole, TeacherContextValue, VerifiedKiwiContext } from "../../types";

/*
 * Teacher session context (§7.9, FOUNDATION, frozen). TeacherApp creates the value with `useTeacherSession`; pages and
 * workstream components read it with `useTeacher()`. The server enforces every permission; the UI only hides actions.
 */

export const TeacherContext = createContext<TeacherContextValue | null>(null);

export function useTeacher(): TeacherContextValue {
  const value = useContext(TeacherContext);
  if (!value) throw new Error("useTeacher() must be used inside the teacher workspace (TeacherApp).");
  return value;
}
export function useOptionalTeacher(): TeacherContextValue | null {
  return useContext(TeacherContext);
}
export function TeacherProvider({ value, children }: { value: TeacherContextValue; children: ReactNode }) {
  return <TeacherContext.Provider value={value}>{children}</TeacherContext.Provider>;
}

export function hasPermission(me: Pick<Me, "permissions"> | null | undefined, permission: Permission): boolean {
  return Boolean(me?.permissions.includes(permission));
}

/** Props every teacher page receives from the route switch. */
export interface TeacherPageProps {
  /** URL-decoded route params (e.g. `assignmentId`). */
  params: Record<string, string>;
  /** Current pathname + search. */
  route: string;
}

// ─── Permission sets (mirror of server/auth.py, §5.3) — used only when /api/me is unavailable ──

const VIEWER: Permission[] = ["viewInsights", "viewStudents", "previewStudent", "viewAiRules", "exportActivity"];
const TA: Permission[] = [...VIEWER, "viewAssignments", "grade", "exportGrades", "flagItems"];
const INSTRUCTOR: Permission[] = [
  ...TA, "editAssignments", "releaseGrades", "manageCourse", "manageAiRules", "manageStudents", "exportResearch",
  "manageStaff", "managePrivacy", "deleteData", "viewAudit", "coursePackage",
];
// Decision D3: no named teaching views (viewStudents) and no Preview as student.
const RESEARCHER: Permission[] = ["viewInsights", "viewAiRules", "exportActivity", "exportResearch"];
export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly Permission[]>> = {
  instructor: INSTRUCTOR, ta: TA, viewer: VIEWER, researcher: RESEARCHER,
};

/** The name mode in effect: a researcher always sees pseudonyms (the server forces them too, decision D3). */
export function effectiveNameMode(me: Pick<Me, "pseudonymsForced"> | null | undefined, chosen: NameMode): NameMode {
  return me?.pseudonymsForced ? "pseudonyms" : chosen;
}

/**
 * Compatibility identity for a server without GET /api/me (v0.5.1): a verified teacher key is the instructor,
 * Kiwi `canManageCourse` is the instructor and `canViewAnalytics` alone is a viewer.
 */
export function legacyMe(classId: string, verified: VerifiedKiwiContext | null): Me | null {
  const role: StaffRole | null = verified
    ? verified.canManageCourse ? "instructor" : verified.canViewAnalytics ? "viewer" : null
    : "instructor";
  const isStaff = verified ? verified.canTeach : true;
  if (!isStaff) return null;
  return {
    kind: verified ? "kiwi" : "teacher_key",
    classId,
    userId: verified ? verified.userId : "instructor",
    displayName: verified ? verified.username || "Teacher" : "Instructor (local key)",
    role,
    permissions: role ? [...ROLE_PERMISSIONS[role]] : ["previewStudent"],
    isStaff: true,
    roleSource: verified ? "kiwi" : "key",
    exportsForcedPseudonymous: role === "viewer",
    preview: false,
    verified: Boolean(verified),
    classLinked: Boolean(verified),
    staffId: null,
  };
}

const keyStorageName = (classId: string) => `kiwi-teacher-session-${classId}`;
const NAME_MODE_KEY = "kiwi-name-mode";

export function readStoredTeacherKey(classId: string): string | null {
  try {
    return sessionStorage.getItem(keyStorageName(classId));
  } catch {
    return null;
  }
}
function storeTeacherKey(classId: string, key: string | null): void {
  try {
    if (key) sessionStorage.setItem(keyStorageName(classId), key);
    else sessionStorage.removeItem(keyStorageName(classId));
  } catch {
    // WHY: without storage the key lives only in memory for this tab; signing in again is the fallback.
  }
}
function readNameMode(): NameMode {
  try {
    return sessionStorage.getItem(NAME_MODE_KEY) === "pseudonyms" ? "pseudonyms" : "names";
  } catch {
    return "names";
  }
}

export const STALE_KEY_MESSAGE = "Teacher key is incorrect or was revoked. Sign in again.";

/**
 * What an /api/me answer means for the teacher session. GET /api/me is PUBLIC, so a stored teacher/staff key that no
 * longer verifies (wrong, rotated or revoked) comes back as an anonymous identity instead of a 401.
 */
export function classifyMe(next: Me | null, usedTeacherKey: boolean): "ready" | "stale_key" | "no_access" | "signed_out" {
  if (next?.isStaff) return "ready";
  if (usedTeacherKey && (!next || next.kind === "anonymous")) return "stale_key";
  return next ? "no_access" : "signed_out";
}

export const STAFF_COURSE_ERROR =
  "The course was sent without your staff access (the student view, without hidden chapters and chapter notes). Sign in again or reload the page.";

/**
 * R-B01: GET /api/course as staff. Runs only once the staff identity is known (its key header or Kiwi token is set), and
 * refuses a student view, which lacks hidden chapters and chapter notes and must never reach a teacher page.
 */
export async function loadStaffCourse(classId: string): Promise<Course> {
  const course = normalizeCourse(await api.course(classId));
  if (course.view === "student") throw new Error(STAFF_COURSE_ERROR);
  setDisplayTimeZone(course.timeZone);   // every page shows dates in the course zone (TEACHER-02)
  return course;
}

/** R-B01: the staff identity the course was loaded for (null without a Lab role); a new key, staff member or role reloads it. */
export function staffIdentityKey(me: Me | null, teacherKey: string | null): string | null {
  if (!me?.isStaff || me.role === null || me.role === "student") return null;
  return JSON.stringify([me.kind, me.userId, me.staffId, me.role, teacherKey]);
}

export type TeacherSessionStatus = "loading" | "signed_out" | "ready" | "error";
export interface TeacherSession {
  status: TeacherSessionStatus;
  error: string;
  /** null until /api/me answered for a staff identity and its staff course is loaded */
  value: TeacherContextValue | null;
  me: Me | null;
  /** R-B01: why the staff course could not be loaded ("" while loading or loaded) */
  courseError: string;
  teacherKey: string | null;
  setTeacherKey: (key: string | null) => void;
  retry: () => void;
}

/** State behind TeacherContext: teacher/staff key, identity (/api/me), the staff course, name mode and time range. */
export function useTeacherSession(opts: { classId: string; verified: VerifiedKiwiContext | null }): TeacherSession {
  const { classId, verified } = opts;
  const [teacherKey, setKeyState] = useState<string | null>(() => (verified ? null : readStoredTeacherKey(classId)));
  const [nameMode, setNameModeState] = useState<NameMode>(readNameMode);
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<TeacherSessionStatus>("loading");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [course, setCourseState] = useState<Course | null>(null);
  const [courseError, setCourseError] = useState("");
  const [courseAttempt, setCourseAttempt] = useState(0);
  const request = useRef(0);

  // WHY in render: child pages fire requests in their effects, which run before this component's effects.
  setTeacherKeyHeader(verified ? null : teacherKey);
  const activeNameMode = effectiveNameMode(me, nameMode);
  setNameModeHeader(activeNameMode);

  const setTeacherKey = useCallback(
    (key: string | null) => {
      storeTeacherKey(classId, key);
      setTeacherKeyHeader(key);
      setKeyState(key);
    },
    [classId],
  );

  const loadMe = useCallback(async () => {
    const id = ++request.current;
    if (!hasKiwiIdentity() && !teacherKey) {
      setMe(null);
      setStatus("signed_out");
      return;
    }
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      let next: Me | null;
      try {
        next = await api.me(classId);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
        // Server without /api/me (v0.5.1): verify the key the old way and derive the role.
        if (!verified && teacherKey) await api.verifyTeacher(classId, teacherKey);
        next = legacyMe(classId, verified);
      }
      if (id !== request.current) return;
      const outcome = classifyMe(next, !verified && Boolean(teacherKey));
      if (outcome === "stale_key") {
        // WHY: keeping a key that no longer verifies would count a failure on every request and keep routing the
        // student workspace into preview (App.tsx treats a stored key as a staff visitor).
        storeTeacherKey(classId, null);
        setTeacherKeyHeader(null);
        setKeyState(null);
        setMe(null);
        setStatus("signed_out");
        setError(STALE_KEY_MESSAGE);
        return;
      }
      if (outcome !== "ready" || !next) {
        setMe(null);
        setStatus("signed_out");
        setError(outcome === "no_access" ? "This account does not have teacher access to this course." : "");
        return;
      }
      setMe(next);
      setError("");
      setStatus("ready");
    } catch (e) {
      if (id !== request.current) return;
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof ApiError && (e.status === 401 || e.status === 403) && teacherKey) {
        // An expired or revoked key: back to the gate with the reason.
        storeTeacherKey(classId, null);
        setTeacherKeyHeader(null);
        setKeyState(null);
        setMe(null);
        setStatus("signed_out");
        setError(message);
        return;
      }
      setError(message);
      setStatus("error");
    }
  }, [classId, teacherKey, verified]);

  useEffect(() => {
    void loadMe();
  }, [loadMe, attempt]);

  const time = useTimeRange(classId, status === "ready");

  // R-B01: the staff course loads after /api/me confirmed a staff identity (its credentials are on every request by then),
  // and again after a sign-in, a key change or a role change; App's boot course is never used here.
  const identity = status === "ready" ? staffIdentityKey(me, verified ? null : teacherKey) : null;
  useEffect(() => {
    setCourseState(null);
    setCourseError("");
    if (!identity) return;
    let active = true;
    loadStaffCourse(classId)
      .then((next) => {
        if (active) setCourseState(next);
      })
      .catch((e: unknown) => {
        if (active) setCourseError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [classId, identity, courseAttempt]);

  const setCourse = useCallback((next: Course) => {
    // WHY: a student view must never replace the staff course; load the staff course again instead.
    if (next.view === "student") setCourseAttempt((n) => n + 1);
    else setCourseState(next);
  }, []);

  const setNameMode = useCallback((mode: NameMode) => {
    try {
      sessionStorage.setItem(NAME_MODE_KEY, mode);
    } catch {
      // WHY: presentation mode still applies for this page lifetime.
    }
    setNameModeHeader(mode);
    setNameModeState(mode);
  }, []);

  const signOut = useCallback(() => {
    setTeacherKey(null);
    setMe(null);
    setStatus("signed_out");
  }, [setTeacherKey]);

  const refreshMe = useCallback(() => loadMe(), [loadMe]);

  const value = useMemo<TeacherContextValue | null>(
    () =>
      me && course
        ? {
            classId, course, setCourse, me, refreshMe,
            timeRange: time.timeRange, setTimePreset: time.setTimePreset,
            nameMode: activeNameMode, setNameMode, teacherKey, setTeacherKey, signOut,
          }
        : null,
    [classId, course, setCourse, me, refreshMe, time.timeRange, time.setTimePreset, activeNameMode, setNameMode, teacherKey, setTeacherKey, signOut],
  );

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
    setCourseAttempt((n) => n + 1);
  }, []);
  return { status, error, value, me, courseError, teacherKey, setTeacherKey, retry };
}
