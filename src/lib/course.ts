import type {
  Course, CourseInput, CourseView, EffectiveUnitAccess, FreePracticeScope, TemplatePairing, TemplateRSession, Unit, UnitAccess, UnitRuntime,
} from "../types";

/*
 * Course v2 helpers (§7.2). The server validates courses; these helpers only normalize what the client reads
 * (a v0.5.1 server answers without the v2 unit fields) and build the PUT /api/course body.
 */

export const DEFAULT_UNIT_RUNTIME: UnitRuntime = { packages: [], datasetFileIds: [], timeoutSeconds: 12, errorHints: [] };

const UNIT_ACCESS: readonly UnitAccess[] = ["default", "open", "review", "hidden"];
const EFFECTIVE_ACCESS: readonly EffectiveUnitAccess[] = ["open", "review", "locked", "hidden"];
const SCOPES: readonly FreePracticeScope[] = ["current_and_earlier", "current_only", "all"];
const STATUSES: readonly Unit["status"][] = ["completed", "current", "upcoming"];
const VIEWS: readonly CourseView[] = ["staff", "student"];
const PAIRINGS: readonly TemplatePairing[] = ["slides", "inferred", "none"];

/** R-B01: why a teacher page cannot save a course it received as the student view. */
export const STUDENT_VIEW_SAVE_ERROR =
  "This page has the student view of the course (without hidden chapters and chapter notes), so saving it could remove them. Reload the page and try again.";

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function normalizeRuntime(value: unknown): UnitRuntime {
  if (!value || typeof value !== "object") return { ...DEFAULT_UNIT_RUNTIME };
  const r = value as Partial<UnitRuntime>;
  return {
    packages: Array.isArray(r.packages) ? r.packages.filter((p): p is string => typeof p === "string") : [],
    datasetFileIds: Array.isArray(r.datasetFileIds) ? r.datasetFileIds.filter((p): p is string => typeof p === "string") : [],
    timeoutSeconds: typeof r.timeoutSeconds === "number" && r.timeoutSeconds > 0 ? r.timeoutSeconds : DEFAULT_UNIT_RUNTIME.timeoutSeconds,
    errorHints: Array.isArray(r.errorHints)
      ? r.errorHints.filter((h): h is { match: string; hint: string } => Boolean(h) && typeof h.match === "string" && typeof h.hint === "string")
      : [],
  };
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;

/** S-M05: the course-template metadata of a chapter (only the keys the server sent in a known shape). */
function templateFields(u: Partial<Unit>): Pick<Unit, "rSessions" | "pairing" | "runLocally" | "liveApi"> {
  const sessions = Array.isArray(u.rSessions)
    ? (u.rSessions as Partial<TemplateRSession>[]).filter((r) => r && typeof r.id === "string" && typeof r.title === "string")
      .map((r) => ({ id: r.id as string, title: r.title as string, file: typeof r.file === "string" ? r.file : "" }))
    : undefined;
  const runLocally = strings(u.runLocally);
  const liveApi = strings(u.liveApi);
  return {
    ...(sessions ? { rSessions: sessions } : {}),
    ...(typeof u.pairing === "string" && (PAIRINGS as readonly string[]).includes(u.pairing) ? { pairing: u.pairing } : {}),
    ...(runLocally ? { runLocally } : {}),
    ...(liveApi ? { liveApi } : {}),
  };
}

/** Fills v2 defaults for fields a v0.5.1 server does not send; never invents chapters. */
export function normalizeCourse(raw: unknown): Course {
  if (!raw || typeof raw !== "object") throw new Error("The course could not be read from the server.");
  const c = raw as Partial<Course> & { units?: unknown };
  const unitsRaw = Array.isArray(c.units) ? (c.units as Partial<Unit>[]) : [];
  const units: Unit[] = unitsRaw
    .filter((u) => u && typeof u.id === "string")
    .map((u) => {
      const status = pick(u.status, STATUSES, "upcoming");
      return {
        id: String(u.id),
        title: typeof u.title === "string" ? u.title : String(u.id),
        goal: typeof u.goal === "string" ? u.goal : "",
        status,
        access: pick(u.access, UNIT_ACCESS, "default"),
        effectiveAccess: pick(u.effectiveAccess, EFFECTIVE_ACCESS, status === "upcoming" ? "locked" : "open"),
        week: typeof u.week === "number" ? u.week : null,
        startsOn: typeof u.startsOn === "string" ? u.startsOn : null,
        runtime: normalizeRuntime(u.runtime),
        ...(typeof u.notes === "string" ? { notes: u.notes } : {}),
        ...templateFields(u),
      };
    });
  return {
    title: typeof c.title === "string" ? c.title : "CSS Lab course",
    description: typeof c.description === "string" ? c.description : "",
    currentUnitId: typeof c.currentUnitId === "string" ? c.currentUnitId : units[0]?.id ?? "",
    freePracticeScope: pick(c.freePracticeScope, SCOPES, "current_and_earlier"),
    units,
    linked: Boolean(c.linked),
    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : null,
    ...(typeof c.timeZone === "string" && c.timeZone ? { timeZone: c.timeZone } : {}),
    ...(typeof c.view === "string" && (VIEWS as readonly string[]).includes(c.view) ? { view: c.view } : {}),
  };
}

/**
 * PUT /api/course body; `baseUpdatedAt` lets the server answer 409 stale_version for concurrent edits.
 * R-B01: throws for a course received as the student view (its hidden chapters and notes are missing). Template metadata
 * is never sent (the server keeps it); `notes` only when the course has them.
 */
export function toCourseInput(course: Course, opts: { removeUnitIds?: readonly string[] } = {}): CourseInput {
  if (course.view === "student") throw new Error(STUDENT_VIEW_SAVE_ERROR);
  return {
    title: course.title,
    description: course.description,
    currentUnitId: course.currentUnitId,
    freePracticeScope: course.freePracticeScope,
    baseUpdatedAt: course.updatedAt,
    units: course.units.map((u) => ({
      id: u.id, title: u.title, goal: u.goal, access: u.access, week: u.week, startsOn: u.startsOn, runtime: u.runtime, status: u.status,
      ...(u.notes !== undefined ? { notes: u.notes } : {}),
    })),
    ...(opts.removeUnitIds ? { removeUnitIds: [...opts.removeUnitIds] } : {}),
  };
}

/** R-B01: chapters of the saved course that the draft no longer has (sent as `removeUnitIds`). */
export function removedUnitIds(saved: Course, draft: Course): string[] {
  const kept = new Set(draft.units.map((u) => u.id));
  return saved.units.filter((u) => !kept.has(u.id)).map((u) => u.id);
}

export function newUnit(): Unit {
  return {
    id: `unit-${crypto.randomUUID()}`,
    title: "New chapter",
    goal: "Describe the learning goal",
    status: "upcoming",
    access: "default",
    effectiveAccess: "locked",
    week: null,
    startsOn: null,
    runtime: { ...DEFAULT_UNIT_RUNTIME },
  };
}
