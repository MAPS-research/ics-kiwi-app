import { matchRoute } from "./navigation";
import type { Permission } from "../types";

/*
 * Route table (§3.2) and legacy redirects (§3.3). Frozen after FOUNDATION.
 * Paths are built here so pages never hand-assemble teacher URLs.
 */

export type Workstream = "FOUNDATION" | "ASSESS" | "GRADE" | "AIRULES" | "AIRUN" | "TELEMETRY" | "INSIGHTS" | "PEOPLE";
export type NavSectionId = "home" | "assignments" | "grading" | "students" | "chapters" | "insights" | "settings";

export type TeacherPageId =
  | "home"
  | "assignments" | "assignmentNew" | "assignmentEdit" | "exerciseResults" | "starterAssignments"
  | "toGrade" | "gradebook" | "releaseExport"
  | "roster" | "needsAttention" | "groups" | "studentProfile" | "studentTimeline" | "studentAssignmentTimeline"
  | "chapters" | "aiRulesOverview" | "aiRulesEditor" | "generatedItems" | "lectureMaterials"
  | "aiConversations" | "activityExplorer" | "questionActivity" | "answersByQuestion" | "courseMetrics" | "exports" | "dataHealth"
  | "courseSettings";

export interface TeacherRouteDef {
  id: TeacherPageId;
  pattern: string;
  /** page module relative to src/, e.g. "teacher/home/HomePage" */
  page: string;
  owner: Workstream;
  section: NavSectionId;
  /** permission needed to open the page (the server still enforces its own, §5.3) */
  permission: Permission;
}

// WHY: literal routes are listed before parameterised ones that share a prefix, mirroring the server's literal-first rule.
export const TEACHER_ROUTES: readonly TeacherRouteDef[] = [
  { id: "home", pattern: "/teacher/home", page: "teacher/home/HomePage", owner: "INSIGHTS", section: "home", permission: "viewStudents" },
  { id: "assignments", pattern: "/teacher/assignments", page: "teacher/assignments/AssignmentListPage", owner: "ASSESS", section: "assignments", permission: "viewAssignments" },
  { id: "assignmentNew", pattern: "/teacher/assignments/new", page: "teacher/assignments/AssignmentEditorPage", owner: "ASSESS", section: "assignments", permission: "viewAssignments" },
  { id: "starterAssignments", pattern: "/teacher/assignments/starter", page: "teacher/assignments/StarterAssignmentsPage", owner: "ASSESS", section: "assignments", permission: "viewAssignments" },
  { id: "assignmentEdit", pattern: "/teacher/assignments/:assignmentId/edit", page: "teacher/assignments/AssignmentEditorPage", owner: "ASSESS", section: "assignments", permission: "viewAssignments" },
  { id: "exerciseResults", pattern: "/teacher/assignments/:assignmentId/results", page: "teacher/grading/ExerciseResultsPage", owner: "GRADE", section: "assignments", permission: "viewStudents" },
  { id: "toGrade", pattern: "/teacher/grading", page: "teacher/grading/ToGradePage", owner: "GRADE", section: "grading", permission: "grade" },
  { id: "gradebook", pattern: "/teacher/grading/gradebook", page: "teacher/grading/GradebookPage", owner: "GRADE", section: "grading", permission: "viewStudents" },
  { id: "releaseExport", pattern: "/teacher/grading/release", page: "teacher/grading/ReleaseExportPage", owner: "GRADE", section: "grading", permission: "grade" },
  { id: "roster", pattern: "/teacher/students", page: "teacher/students/RosterPage", owner: "PEOPLE", section: "students", permission: "viewStudents" },
  { id: "needsAttention", pattern: "/teacher/students/attention", page: "teacher/students/NeedsAttentionPage", owner: "INSIGHTS", section: "students", permission: "viewStudents" },
  { id: "groups", pattern: "/teacher/students/groups", page: "teacher/students/GroupsPage", owner: "PEOPLE", section: "students", permission: "viewInsights" },
  { id: "studentProfile", pattern: "/teacher/students/s/:studentId", page: "teacher/students/StudentProfilePage", owner: "PEOPLE", section: "students", permission: "viewStudents" },
  { id: "studentTimeline", pattern: "/teacher/students/s/:studentId/timeline", page: "teacher/students/StudentTimelinePage", owner: "INSIGHTS", section: "students", permission: "viewInsights" },
  { id: "studentAssignmentTimeline", pattern: "/teacher/students/s/:studentId/assignments/:assignmentId", page: "teacher/students/StudentTimelinePage", owner: "INSIGHTS", section: "students", permission: "viewInsights" },
  { id: "chapters", pattern: "/teacher/chapters", page: "teacher/chapters/ChaptersPage", owner: "AIRULES", section: "chapters", permission: "viewAiRules" },
  { id: "aiRulesOverview", pattern: "/teacher/chapters/ai", page: "teacher/chapters/AiRulesOverviewPage", owner: "AIRULES", section: "chapters", permission: "viewAiRules" },
  { id: "generatedItems", pattern: "/teacher/chapters/ai-practice", page: "teacher/chapters/GeneratedItemsPage", owner: "AIRUN", section: "chapters", permission: "viewAiRules" },
  { id: "lectureMaterials", pattern: "/teacher/chapters/materials", page: "teacher/chapters/LectureMaterialsPage", owner: "TELEMETRY", section: "chapters", permission: "viewAiRules" },
  { id: "aiRulesEditor", pattern: "/teacher/chapters/ai/:unitId", page: "teacher/chapters/AiRulesEditorPage", owner: "AIRULES", section: "chapters", permission: "viewAiRules" },
  { id: "aiConversations", pattern: "/teacher/insights/ai-conversations", page: "teacher/insights/AiConversationsPage", owner: "INSIGHTS", section: "insights", permission: "viewInsights" },
  { id: "activityExplorer", pattern: "/teacher/insights/activity", page: "teacher/insights/ActivityExplorerPage", owner: "INSIGHTS", section: "insights", permission: "viewInsights" },
  { id: "answersByQuestion", pattern: "/teacher/insights/activity/answers", page: "teacher/insights/AnswersByQuestionPage", owner: "INSIGHTS", section: "insights", permission: "viewInsights" },
  { id: "questionActivity", pattern: "/teacher/insights/activity/question-activity/:activityId", page: "teacher/insights/QuestionActivityPage", owner: "INSIGHTS", section: "insights", permission: "viewInsights" },
  { id: "courseMetrics", pattern: "/teacher/insights/metrics", page: "teacher/insights/CourseMetricsPage", owner: "INSIGHTS", section: "insights", permission: "viewInsights" },
  { id: "exports", pattern: "/teacher/insights/exports", page: "teacher/insights/ExportsPage", owner: "PEOPLE", section: "insights", permission: "exportActivity" },
  { id: "dataHealth", pattern: "/teacher/insights/data-health", page: "teacher/insights/DataHealthPage", owner: "TELEMETRY", section: "insights", permission: "viewInsights" },
  { id: "courseSettings", pattern: "/teacher/settings", page: "teacher/settings/CourseSettingsPage", owner: "PEOPLE", section: "settings", permission: "manageCourse" },
];

/** Route-table redirects (§3.2 rows "redirect → …"). */
export const TEACHER_ROUTE_REDIRECTS: Readonly<Record<string, string>> = {
  "/teacher": "/teacher/home",
  "/teacher/insights": "/teacher/insights/ai-conversations",
};

export interface ResolvedTeacherRoute { route: TeacherRouteDef; params: Record<string, string> }
export function resolveTeacherRoute(pathname: string): ResolvedTeacherRoute | null {
  for (const route of TEACHER_ROUTES) {
    const params = matchRoute(route.pattern, pathname);
    if (params) return { route, params };
  }
  return null;
}

// ─── Navigation sections (§3.1) ────────────────────────────────────────────────────────────────

export interface NavSection {
  id: NavSectionId; label: string; root: string; permission: Permission;
  /** shown instead when the role lacks `permission` but has this one (a researcher's read-only Groups, decision D3) */
  fallback?: { label: string; root: string; permission: Permission };
}
/**
 * React key of the routed teacher page. It includes the name mode so that turning Presentation mode on or off remounts
 * the page and every list refetches with the new `X-Name-Mode` (review 2, TEACHER-01): real names must not stay on a
 * projected screen until the teacher navigates away.
 */
export function teacherPageKey(routeId: string, params: Record<string, string>, nameMode: "names" | "pseudonyms"): string {
  return `${routeId}:${JSON.stringify(params)}:${nameMode}`;
}

export const NAV_SECTIONS: readonly NavSection[] = [
  { id: "home", label: "Home", root: "/teacher/home", permission: "viewStudents" },
  { id: "assignments", label: "Assignments", root: "/teacher/assignments", permission: "viewAssignments" },
  { id: "grading", label: "Grading", root: "/teacher/grading", permission: "grade" },
  { id: "students", label: "Students", root: "/teacher/students", permission: "viewStudents",
    fallback: { label: "Groups", root: "/teacher/students/groups", permission: "viewInsights" } },
  { id: "chapters", label: "Chapters & AI tutor", root: "/teacher/chapters", permission: "viewAiRules" },
  { id: "insights", label: "Insights", root: "/teacher/insights", permission: "viewInsights" },
  { id: "settings", label: "Course settings", root: "/teacher/settings", permission: "manageCourse" },
];

/** Sidebar items for a permission list: viewer 4, ta 6, instructor 7, researcher 3 (§3.1, decision D3). */
export function navSectionsFor(permissions: readonly Permission[]): NavSection[] {
  const out: NavSection[] = [];
  for (const section of NAV_SECTIONS) {
    if (permissions.includes(section.permission)) out.push(section);
    else if (section.fallback && permissions.includes(section.fallback.permission))
      out.push({ id: section.id, label: section.fallback.label, root: section.fallback.root, permission: section.fallback.permission });
  }
  return out;
}

/** Where a role starts: Home when it may open Home, else the Activity explorer, else its first section (decision D3). */
export function teacherLandingPath(permissions: readonly Permission[]): string {
  if (permissions.includes("viewStudents")) return "/teacher/home";
  if (permissions.includes("viewInsights")) return "/teacher/insights/activity";
  return navSectionsFor(permissions)[0]?.root ?? "/teacher/home";
}

/** Home (or `/teacher`) for a role without Home → its landing page; other pages keep the "Not available" notice. */
export function roleRedirect(pathname: string, permissions: readonly Permission[]): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path !== "/teacher" && path !== "/teacher/home") return null;
  if (permissions.includes("viewStudents")) return null;
  const landing = teacherLandingPath(permissions);
  return landing === "/teacher/home" ? null : landing;
}

export function activeNavSection(pathname: string): NavSectionId | null {
  const resolved = resolveTeacherRoute(pathname);
  if (resolved) return resolved.route.section;
  const hit = NAV_SECTIONS.find((s) => pathname === s.root || pathname.startsWith(`${s.root}/`));
  return hit?.id ?? null;
}

// ─── Section tabs (sit directly under the PageHeader, §3.1) ────────────────────────────────────

export interface SectionTab { label: string; href: string; permission?: Permission }
export const SECTION_TABS: Readonly<Partial<Record<NavSectionId, readonly SectionTab[]>>> = {
  assignments: [
    { label: "All assignments", href: "/teacher/assignments" },
    { label: "Starter assignments", href: "/teacher/assignments/starter" },
  ],
  grading: [
    { label: "To grade", href: "/teacher/grading", permission: "grade" },
    { label: "Gradebook", href: "/teacher/grading/gradebook", permission: "viewStudents" },
    { label: "Release & export", href: "/teacher/grading/release", permission: "grade" },
  ],
  students: [
    { label: "Roster", href: "/teacher/students", permission: "viewStudents" },
    { label: "Needs attention", href: "/teacher/students/attention", permission: "viewStudents" },
    { label: "Groups", href: "/teacher/students/groups" },
  ],
  chapters: [
    { label: "Chapters", href: "/teacher/chapters" },
    { label: "AI tutor rules", href: "/teacher/chapters/ai" },
    { label: "AI-generated practice", href: "/teacher/chapters/ai-practice" },
    { label: "Linked lecture materials", href: "/teacher/chapters/materials" },
  ],
  insights: [
    { label: "AI conversations", href: "/teacher/insights/ai-conversations" },
    { label: "Activity explorer", href: "/teacher/insights/activity" },
    { label: "Course metrics", href: "/teacher/insights/metrics" },
    { label: "Exports", href: "/teacher/insights/exports", permission: "exportActivity" },
    { label: "Data health", href: "/teacher/insights/data-health" },
  ],
};

export function sectionTabsFor(section: NavSectionId, permissions: readonly Permission[]): SectionTab[] {
  return (SECTION_TABS[section] ?? []).filter((tab) => !tab.permission || permissions.includes(tab.permission));
}

/** The most specific tab whose href is the pathname or a parent of it. */
export function activeTabHref(tabs: readonly SectionTab[], pathname: string): string | null {
  let best: SectionTab | null = null;
  for (const tab of tabs) {
    const matches = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    if (matches && (!best || tab.href.length > best.href.length)) best = tab;
  }
  return best?.href ?? null;
}

// ─── Path builders ─────────────────────────────────────────────────────────────────────────────

type QueryValue = string | number | boolean | null | undefined;
/** Appends the non-empty query values in insertion order. */
export function withQuery(path: string, query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}
const enc = encodeURIComponent;

export const teacherPaths = {
  home: () => "/teacher/home",
  /** `open` + `list` open one row's student list on a tab (Home › Missing › List, review 2 TEACHER-12). */
  assignments: (q: { status?: string; search?: string; page?: number; unitId?: string; open?: string; list?: "missing" | "late" } = {}) =>
    withQuery("/teacher/assignments", q),
  assignmentNew: (q: { kind?: "homework" | "practice"; unitId?: string; audienceGroupId?: string } = {}) => withQuery("/teacher/assignments/new", q),
  assignmentEdit: (assignmentId: string) => `/teacher/assignments/${enc(assignmentId)}/edit`,
  exerciseResults: (assignmentId: string) => `/teacher/assignments/${enc(assignmentId)}/results`,
  starterAssignments: () => "/teacher/assignments/starter",
  grading: (q: { assignmentId?: string; show?: string; view?: string; questionId?: string; studentId?: string; submissionId?: string; groupId?: string } = {}) =>
    withQuery("/teacher/grading", q),
  gradebook: (q: { policy?: string; search?: string; groupId?: string } = {}) => withQuery("/teacher/grading/gradebook", q),
  release: (q: { assignmentId?: string } = {}) => withQuery("/teacher/grading/release", q),
  roster: (q: { search?: string; groupId?: string; consent?: string; status?: string } = {}) => withQuery("/teacher/students", q),
  attention: () => "/teacher/students/attention",
  groups: () => "/teacher/students/groups",
  studentProfile: (studentId: string) => `/teacher/students/s/${enc(studentId)}`,
  studentTimeline: (studentId: string, q: { from?: string; to?: string; unitId?: string; where?: string } = {}) =>
    withQuery(`/teacher/students/s/${enc(studentId)}/timeline`, q),
  studentAssignmentTimeline: (studentId: string, assignmentId: string) =>
    `/teacher/students/s/${enc(studentId)}/assignments/${enc(assignmentId)}`,
  chapters: () => "/teacher/chapters",
  aiRules: () => "/teacher/chapters/ai",
  aiRulesEditor: (unitId: string, q: { groupId?: string } = {}) => withQuery(`/teacher/chapters/ai/${enc(unitId)}`, q),
  generatedItems: () => "/teacher/chapters/ai-practice",
  lectureMaterials: () => "/teacher/chapters/materials",
  aiConversations: (q: Record<string, QueryValue> = {}) => withQuery("/teacher/insights/ai-conversations", q),
  activity: (q: Record<string, QueryValue> = {}) => withQuery("/teacher/insights/activity", q),
  questionActivity: (activityId: string) => `/teacher/insights/activity/question-activity/${enc(activityId)}`,
  answers: (q: Record<string, QueryValue> = {}) => withQuery("/teacher/insights/activity/answers", q),
  metrics: () => "/teacher/insights/metrics",
  exports: () => "/teacher/insights/exports",
  dataHealth: () => "/teacher/insights/data-health",
  settings: (tab?: "course" | "schedule" | "kiwi" | "staff" | "privacy" | "package") => withQuery("/teacher/settings", { tab }),
} as const;

export type StudentTool = "answer" | "code" | "kiwi" | "similar";
export type PracticeTool = "settings" | "question" | "code" | "kiwi";
export const studentPaths = {
  assignments: () => "/student/assignments",
  assignment: (assignmentId: string, tool: StudentTool = "answer", questionId?: string) =>
    withQuery(`/student/assignments/${enc(assignmentId)}/${tool}`, { q: questionId }),
  practice: (tool: PracticeTool = "settings") => `/student/practice/${tool}`,
  workspace: () => "/student/code",
  askKiwi: () => "/student/kiwi",
  course: () => "/student/course",
  entry: () => "/entry",
} as const;
export const previewPaths = {
  assignments: () => "/preview/student/assignments",
  assignment: (assignmentId: string) => `/preview/student/assignments/${enc(assignmentId)}/answer`,
} as const;

// ─── Student routes (paths unchanged from v0.5.1; also served under /preview/student) ──────────

export type StudentPageId = "assignmentList" | "assignment" | "practice" | "workspace" | "askKiwi" | "courseOutline";
export interface ResolvedStudentRoute { id: StudentPageId; params: Record<string, string>; preview: boolean }
const STUDENT_ROUTES: readonly { id: StudentPageId; pattern: string }[] = [
  { id: "assignmentList", pattern: "/student/assignments" },
  { id: "assignment", pattern: "/student/assignments/:assignmentId" },
  { id: "assignment", pattern: "/student/assignments/:assignmentId/:tool" },
  { id: "practice", pattern: "/student/practice/:tool" },
  { id: "workspace", pattern: "/student/code" },
  { id: "askKiwi", pattern: "/student/kiwi" },
  { id: "courseOutline", pattern: "/student/course" },
];
export function isPreviewPath(pathname: string): boolean {
  return pathname === "/preview/student" || pathname.startsWith("/preview/student/");
}
export function resolveStudentRoute(pathname: string): ResolvedStudentRoute | null {
  const preview = isPreviewPath(pathname);
  const path = preview ? pathname.slice("/preview".length) : pathname;
  for (const route of STUDENT_ROUTES) {
    const params = matchRoute(route.pattern, path);
    if (params) return { id: route.id, params, preview };
  }
  return null;
}

// ─── Legacy redirects (§3.3) ───────────────────────────────────────────────────────────────────

export interface LegacyRedirect {
  to: string;
  /** "moved": an unknown /teacher/* URL; the shell shows a dismissible "That page moved" notice. */
  notice?: "moved";
}

const ANALYTICS_GROUPS: Readonly<Record<string, string>> = {
  sessions: "question-activities",
  topics: "chapters",
  materials: "reading",
};

function searchSuffix(params: URLSearchParams): string {
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * Maps a v0.5.1 URL (or a route-table redirect) to its v0.6.0 URL. Returns null when the URL is already current
 * or outside the app's redirect rules. The caller applies it with `history.replaceState`.
 */
export function legacyRedirect(pathname: string, search: string): LegacyRedirect | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const params = new URLSearchParams(search);
  const keep = searchSuffix(params);

  // Canonical roots (v0.5.1 App.tsx replacements, kept).
  if (path === "/" || path === "/student") return { to: `/student/assignments${keep}` };
  if (path === "/student/practice") return { to: `/student/practice/settings${keep}` };
  if (path === "/preview" || path === "/preview/student") return { to: `/preview/student/assignments${keep}` };
  if (path === "/preview/student/practice") return { to: `/preview/student/practice/settings${keep}` };
  if (path !== "/teacher" && !path.startsWith("/teacher/")) return null;

  const redirect = TEACHER_ROUTE_REDIRECTS[path];
  if (redirect) return { to: `${redirect}${keep}` };

  switch (path) {
    case "/teacher/work":
    case "/teacher/work/assignments":
      return { to: `/teacher/assignments${keep}` };
    case "/teacher/work/new":
      return { to: `/teacher/assignments/new${keep}` };
    case "/teacher/work/grading": {
      const out = new URLSearchParams();
      const assignmentId = params.get("assignmentId");
      if (assignmentId) out.set("assignmentId", assignmentId);
      for (const [key, value] of params)
        if (key !== "assignmentId" && key !== "status") out.append(key, value);
      out.set("show", params.get("status") === "all" ? "all" : "latest");
      return { to: `/teacher/grading${searchSuffix(out)}` };
    }
    case "/teacher/work/policies":
      return { to: "/teacher/chapters/ai" };
    case "/teacher/course":
    case "/teacher/course/plan":
      return { to: "/teacher/chapters" };
    case "/teacher/course/roster":
      return { to: "/teacher/students" };
    case "/teacher/course/materials":
      return { to: "/teacher/chapters/materials" };
    case "/teacher/analytics":
    case "/teacher/analytics/overview":
      return { to: "/teacher/insights/metrics" };
    case "/teacher/analytics/table": {
      const out = new URLSearchParams();
      for (const [key, value] of params) {
        if (key === "group") out.append("group", ANALYTICS_GROUPS[value] ?? value);
        else if (key === "source") out.append("where", value);
        else if (key === "activity" && value === "questions") out.append("activity", "ai");
        else out.append(key, value);
      }
      return { to: `/teacher/insights/activity${searchSuffix(out)}` };
    }
    case "/teacher/analytics/evidence":
      return { to: `/teacher/insights/activity/answers${keep}` };
    case "/teacher/analytics/hub":
      return { to: "/teacher/grading/gradebook" };
    default:
      break;
  }
  const edit = /^\/teacher\/work\/edit\/([^/]+)$/.exec(path);
  if (edit) return { to: `/teacher/assignments/${edit[1]}/edit` };
  const session = /^\/teacher\/analytics\/session\/([^/]+)$/.exec(path);
  if (session) return { to: `/teacher/insights/activity/question-activity/${session[1]}` };
  if (resolveTeacherRoute(path)) return null;
  return { to: "/teacher/home", notice: "moved" };
}
