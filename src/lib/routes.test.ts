import { describe, expect, it } from "vitest";
import {
  activeNavSection,
  activeTabHref,
  legacyRedirect,
  navSectionsFor,
  resolveStudentRoute,
  roleRedirect,
  resolveTeacherRoute,
  sectionTabsFor,
  studentPaths,
  teacherLandingPath,
  teacherPaths,
  TEACHER_ROUTES,
  withQuery,
} from "./routes";
import { matchRoute, previewAwarePath } from "./navigation";
import type { Permission } from "../types";

const VIEWER: Permission[] = ["viewInsights", "viewStudents", "previewStudent", "viewAiRules", "exportActivity"];
// Decision D3: research analysts — Insights, read-only chapters/AI tutor rules and groups, de-identified exports.
const RESEARCHER: Permission[] = ["viewInsights", "viewAiRules", "exportActivity", "exportResearch"];
const TA: Permission[] = [...VIEWER, "viewAssignments", "grade", "exportGrades", "flagItems"];
const INSTRUCTOR: Permission[] = [
  ...TA, "editAssignments", "releaseGrades", "manageCourse", "manageAiRules", "manageStudents", "exportResearch",
  "manageStaff", "managePrivacy", "deleteData", "viewAudit", "coursePackage",
];

describe("route table (§3.2)", () => {
  const cases: [string, string, Record<string, string>][] = [
    ["/teacher/home", "teacher/home/HomePage", {}],
    ["/teacher/assignments", "teacher/assignments/AssignmentListPage", {}],
    ["/teacher/assignments/new", "teacher/assignments/AssignmentEditorPage", {}],
    ["/teacher/assignments/work-1/edit", "teacher/assignments/AssignmentEditorPage", { assignmentId: "work-1" }],
    ["/teacher/assignments/work-1/results", "teacher/grading/ExerciseResultsPage", { assignmentId: "work-1" }],
    ["/teacher/assignments/starter", "teacher/assignments/StarterAssignmentsPage", {}],
    ["/teacher/grading", "teacher/grading/ToGradePage", {}],
    ["/teacher/grading/gradebook", "teacher/grading/GradebookPage", {}],
    ["/teacher/grading/release", "teacher/grading/ReleaseExportPage", {}],
    ["/teacher/students", "teacher/students/RosterPage", {}],
    ["/teacher/students/attention", "teacher/students/NeedsAttentionPage", {}],
    ["/teacher/students/groups", "teacher/students/GroupsPage", {}],
    ["/teacher/students/s/demo-ada", "teacher/students/StudentProfilePage", { studentId: "demo-ada" }],
    ["/teacher/students/s/attention", "teacher/students/StudentProfilePage", { studentId: "attention" }],
    ["/teacher/students/s/ada%40nyu.edu/timeline", "teacher/students/StudentTimelinePage", { studentId: "ada@nyu.edu" }],
    ["/teacher/students/s/demo-ada/assignments/work-1", "teacher/students/StudentTimelinePage", { studentId: "demo-ada", assignmentId: "work-1" }],
    ["/teacher/chapters", "teacher/chapters/ChaptersPage", {}],
    ["/teacher/chapters/ai", "teacher/chapters/AiRulesOverviewPage", {}],
    ["/teacher/chapters/ai/course", "teacher/chapters/AiRulesEditorPage", { unitId: "course" }],
    ["/teacher/chapters/ai-practice", "teacher/chapters/GeneratedItemsPage", {}],
    ["/teacher/chapters/materials", "teacher/chapters/LectureMaterialsPage", {}],
    ["/teacher/insights/ai-conversations", "teacher/insights/AiConversationsPage", {}],
    ["/teacher/insights/activity", "teacher/insights/ActivityExplorerPage", {}],
    ["/teacher/insights/activity/question-activity/ls-42", "teacher/insights/QuestionActivityPage", { activityId: "ls-42" }],
    ["/teacher/insights/activity/answers", "teacher/insights/AnswersByQuestionPage", {}],
    ["/teacher/insights/metrics", "teacher/insights/CourseMetricsPage", {}],
    ["/teacher/insights/exports", "teacher/insights/ExportsPage", {}],
    ["/teacher/insights/data-health", "teacher/insights/DataHealthPage", {}],
    ["/teacher/settings", "teacher/settings/CourseSettingsPage", {}],
  ];
  it.each(cases)("%s → %s", (path, page, params) => {
    const resolved = resolveTeacherRoute(path);
    expect(resolved?.route.page).toBe(page);
    expect(resolved?.params).toEqual(params);
  });
  it("has one entry per page id and pattern", () => {
    expect(new Set(TEACHER_ROUTES.map((r) => r.id)).size).toBe(TEACHER_ROUTES.length);
    expect(new Set(TEACHER_ROUTES.map((r) => r.pattern)).size).toBe(TEACHER_ROUTES.length);
  });
  it("does not resolve unknown or partial paths", () => {
    expect(resolveTeacherRoute("/teacher/nope")).toBeNull();
    expect(resolveTeacherRoute("/teacher/students/s")).toBeNull();
    expect(resolveTeacherRoute("/teacher/students/s/%E0%A4%A")).toBeNull();
  });
  it("encodes ids in builders so they round-trip through the table", () => {
    const path = teacherPaths.studentTimeline("ada chen/1");
    expect(path).toBe("/teacher/students/s/ada%20chen%2F1/timeline");
    expect(resolveTeacherRoute(path)?.params.studentId).toBe("ada chen/1");
    expect(teacherPaths.grading({ assignmentId: "w1", show: "latest" })).toBe("/teacher/grading?assignmentId=w1&show=latest");
    expect(teacherPaths.assignmentNew({ kind: "homework", audienceGroupId: "g1" })).toBe("/teacher/assignments/new?kind=homework&audienceGroupId=g1");
    expect(teacherPaths.settings()).toBe("/teacher/settings");
    expect(withQuery("/x", { a: "", b: null, c: 0 })).toBe("/x?c=0");
  });
});

describe("navigation sections (§3.1, FOUNDATION-01)", () => {
  it("shows 4 / 6 / 7 items for viewer / ta / instructor in the spec order", () => {
    expect(navSectionsFor(VIEWER).map((s) => s.label)).toEqual(["Home", "Students", "Chapters & AI tutor", "Insights"]);
    expect(navSectionsFor(TA).map((s) => s.label)).toEqual(["Home", "Assignments", "Grading", "Students", "Chapters & AI tutor", "Insights"]);
    expect(navSectionsFor(INSTRUCTOR).map((s) => s.label)).toEqual([
      "Home", "Assignments", "Grading", "Students", "Chapters & AI tutor", "Insights", "Course settings",
    ]);
  });
  it("gives a researcher Groups, Chapters & AI tutor and Insights, but no Home or roster (decision D3)", () => {
    const nav = navSectionsFor(RESEARCHER);
    expect(nav.map((s) => s.label)).toEqual(["Groups", "Chapters & AI tutor", "Insights"]);
    expect(nav[0]).toMatchObject({ id: "students", root: "/teacher/students/groups" });
    expect(sectionTabsFor("students", RESEARCHER).map((t) => t.label)).toEqual(["Groups"]);
    expect(sectionTabsFor("students", VIEWER).map((t) => t.label)).toEqual(["Roster", "Needs attention", "Groups"]);
    expect(sectionTabsFor("insights", RESEARCHER).map((t) => t.label)).toContain("Exports");
    expect(sectionTabsFor("grading", RESEARCHER)).toEqual([]);
    const permissionOf = (path: string) => resolveTeacherRoute(path)?.route.permission;
    for (const path of ["/teacher/home", "/teacher/students", "/teacher/students/attention", "/teacher/students/s/s1",
      "/teacher/grading/gradebook", "/teacher/assignments/w1/results"])
      expect(permissionOf(path), path).toBe("viewStudents");
    for (const path of ["/teacher/students/groups", "/teacher/students/s/s1/timeline", "/teacher/students/s/s1/assignments/w1",
      "/teacher/insights/activity", "/teacher/insights/ai-conversations", "/teacher/insights/metrics", "/teacher/insights/data-health"])
      expect(permissionOf(path), path).toBe("viewInsights");
  });
  it("sends a role without Home to its landing page", () => {
    expect(teacherLandingPath(RESEARCHER)).toBe("/teacher/insights/activity");
    expect(teacherLandingPath(VIEWER)).toBe("/teacher/home");
    expect(teacherLandingPath(["viewAiRules"])).toBe("/teacher/chapters");
    expect(roleRedirect("/teacher/home", RESEARCHER)).toBe("/teacher/insights/activity");
    expect(roleRedirect("/teacher", RESEARCHER)).toBe("/teacher/insights/activity");
    expect(roleRedirect("/teacher/home", INSTRUCTOR)).toBeNull();
    expect(roleRedirect("/teacher/students", RESEARCHER)).toBeNull(); // shows "Not available for your role"
    expect(roleRedirect("/teacher/insights/activity", RESEARCHER)).toBeNull();
  });
  it("marks the section of nested pages active", () => {
    expect(activeNavSection("/teacher/assignments/w1/results")).toBe("assignments");
    expect(activeNavSection("/teacher/students/s/ada/timeline")).toBe("students");
    expect(activeNavSection("/teacher/insights/activity/answers")).toBe("insights");
  });
  it("selects the most specific section tab and filters by permission", () => {
    const tabs = sectionTabsFor("chapters", INSTRUCTOR);
    expect(activeTabHref(tabs, "/teacher/chapters/ai/r-basics")).toBe("/teacher/chapters/ai");
    expect(activeTabHref(tabs, "/teacher/chapters")).toBe("/teacher/chapters");
    expect(activeTabHref(tabs, "/teacher/chapters/ai-practice")).toBe("/teacher/chapters/ai-practice");
    expect(sectionTabsFor("grading", VIEWER).map((t) => t.label)).toEqual(["Gradebook"]);
  });
});

describe("legacy redirects (§3.3)", () => {
  const rows: [string, string, string][] = [
    ["/teacher/work", "", "/teacher/assignments"],
    ["/teacher/work/assignments", "?status=draft&search=week", "/teacher/assignments?status=draft&search=week"],
    ["/teacher/work/new", "", "/teacher/assignments/new"],
    ["/teacher/work/edit/work-abc", "", "/teacher/assignments/work-abc/edit"],
    ["/teacher/work/grading", "?assignmentId=X", "/teacher/grading?assignmentId=X&show=latest"],
    ["/teacher/work/grading", "?assignmentId=X&status=ungraded", "/teacher/grading?assignmentId=X&show=latest"],
    ["/teacher/work/grading", "?status=all&assignmentId=X", "/teacher/grading?assignmentId=X&show=all"],
    ["/teacher/work/grading", "", "/teacher/grading?show=latest"],
    ["/teacher/work/policies", "", "/teacher/chapters/ai"],
    ["/teacher/course", "", "/teacher/chapters"],
    ["/teacher/course/plan", "", "/teacher/chapters"],
    ["/teacher/course/roster", "", "/teacher/students"],
    ["/teacher/course/materials", "", "/teacher/chapters/materials"],
    ["/teacher/analytics", "", "/teacher/insights/metrics"],
    ["/teacher/analytics/overview", "", "/teacher/insights/metrics"],
    ["/teacher/analytics/table", "?group=sessions&studentId=s1", "/teacher/insights/activity?group=question-activities&studentId=s1"],
    ["/teacher/analytics/table", "?group=topics&source=kiwi", "/teacher/insights/activity?group=chapters&where=kiwi"],
    ["/teacher/analytics/table", "?group=materials&materialId=m1", "/teacher/insights/activity?group=reading&materialId=m1"],
    ["/teacher/analytics/table", "?group=students&activity=unknown", "/teacher/insights/activity?group=students&activity=unknown"],
    ["/teacher/analytics/table", "?group=questions&activity=questions", "/teacher/insights/activity?group=questions&activity=ai"],
    ["/teacher/analytics/session/ls-17", "", "/teacher/insights/activity/question-activity/ls-17"],
    ["/teacher/analytics/evidence", "?unitId=u1&questionId=q1", "/teacher/insights/activity/answers?unitId=u1&questionId=q1"],
    ["/teacher/analytics/hub", "", "/teacher/grading/gradebook"],
    ["/teacher", "", "/teacher/home"],
    ["/teacher/", "", "/teacher/home"],
    ["/teacher/insights", "", "/teacher/insights/ai-conversations"],
  ];
  it.each(rows)("%s%s → %s", (path, search, to) => {
    expect(legacyRedirect(path, search)).toEqual({ to });
  });
  it("sends unknown teacher URLs home with a moved notice", () => {
    expect(legacyRedirect("/teacher/unknown/page", "?x=1")).toEqual({ to: "/teacher/home", notice: "moved" });
    expect(legacyRedirect("/teacher/work/edit", "")).toEqual({ to: "/teacher/home", notice: "moved" });
  });
  it("leaves every current route alone", () => {
    for (const route of TEACHER_ROUTES) {
      const sample = route.pattern.replace(/:[A-Za-z]+/g, "id-1");
      expect(legacyRedirect(sample, "?a=b")).toBeNull();
    }
    expect(legacyRedirect("/student/assignments", "")).toBeNull();
    expect(legacyRedirect("/entry", "")).toBeNull();
  });
  it("keeps the v0.5.1 student root redirects", () => {
    expect(legacyRedirect("/", "")).toEqual({ to: "/student/assignments" });
    expect(legacyRedirect("/student", "")).toEqual({ to: "/student/assignments" });
    expect(legacyRedirect("/student/practice", "")).toEqual({ to: "/student/practice/settings" });
    expect(legacyRedirect("/preview/student", "")).toEqual({ to: "/preview/student/assignments" });
  });
});

describe("student routes and preview", () => {
  it("resolves student pages with and without the preview prefix", () => {
    expect(resolveStudentRoute("/student/assignments/w1/code")).toEqual({ id: "assignment", params: { assignmentId: "w1", tool: "code" }, preview: false });
    expect(resolveStudentRoute("/preview/student/practice/question")).toEqual({ id: "practice", params: { tool: "question" }, preview: true });
    expect(resolveStudentRoute("/student/kiwi")?.id).toBe("askKiwi");
    expect(resolveStudentRoute("/student/nope")).toBeNull();
    expect(studentPaths.assignment("w 1", "kiwi", "q1")).toBe("/student/assignments/w%201/kiwi?q=q1");
  });
  it("keeps navigation inside the preview", () => {
    expect(previewAwarePath("/student/assignments/w1/answer", "/preview/student/assignments")).toBe("/preview/student/assignments/w1/answer");
    expect(previewAwarePath("/student/assignments", "/student/code")).toBe("/student/assignments");
    expect(previewAwarePath("/teacher/home", "/preview/student/code")).toBe("/teacher/home");
  });
  it("matches wildcard patterns", () => {
    expect(matchRoute("/preview/student/*", "/preview/student/practice/code")).toEqual({ "*": "practice/code" });
    expect(matchRoute("/a/:b", "/a")).toBeNull();
    expect(matchRoute("/a/:b", "/a/x/y")).toBeNull();
  });
});
