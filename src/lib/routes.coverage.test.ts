import { describe, expect, it } from "vitest";
import {
  NAV_SECTIONS, SECTION_TABS, activeNavSection, activeTabHref, isPreviewPath, legacyRedirect, previewPaths, resolveStudentRoute,
  resolveTeacherRoute, sectionTabsFor, studentPaths, teacherPaths, type TeacherPageId,
} from "./routes";

/*
 * Coverage for the §3.2 path builders: every teacher builder resolves through the route table to its page (so pages
 * never build a URL the shell cannot open), student/preview builders resolve to the student routes, and the §3.3
 * legacy rows that routes.test.ts does not list.
 */

const ID = "ada chen/1";
const pathOf = (url: string) => url.split("?")[0];

describe("teacher path builders round-trip through the route table", () => {
  const cases: [string, string, TeacherPageId, Record<string, string>?][] = [
    ["home", teacherPaths.home(), "home"],
    ["assignments", teacherPaths.assignments({ status: "published", page: 2 }), "assignments"],
    ["assignmentNew", teacherPaths.assignmentNew(), "assignmentNew"],
    ["assignmentEdit", teacherPaths.assignmentEdit(ID), "assignmentEdit", { assignmentId: ID }],
    ["exerciseResults", teacherPaths.exerciseResults(ID), "exerciseResults", { assignmentId: ID }],
    ["starterAssignments", teacherPaths.starterAssignments(), "starterAssignments"],
    ["grading", teacherPaths.grading(), "toGrade"],
    ["gradebook", teacherPaths.gradebook({ policy: "best" }), "gradebook"],
    ["release", teacherPaths.release({ assignmentId: "w1" }), "releaseExport"],
    ["roster", teacherPaths.roster({ consent: "no" }), "roster"],
    ["attention", teacherPaths.attention(), "needsAttention"],
    ["groups", teacherPaths.groups(), "groups"],
    ["studentProfile", teacherPaths.studentProfile(ID), "studentProfile", { studentId: ID }],
    ["studentTimeline", teacherPaths.studentTimeline(ID, { where: "kiwi" }), "studentTimeline", { studentId: ID }],
    ["studentAssignmentTimeline", teacherPaths.studentAssignmentTimeline(ID, "w 2"), "studentAssignmentTimeline", { studentId: ID, assignmentId: "w 2" }],
    ["chapters", teacherPaths.chapters(), "chapters"],
    ["aiRules", teacherPaths.aiRules(), "aiRulesOverview"],
    ["aiRulesEditor", teacherPaths.aiRulesEditor("u/1", { groupId: "g1" }), "aiRulesEditor", { unitId: "u/1" }],
    ["generatedItems", teacherPaths.generatedItems(), "generatedItems"],
    ["lectureMaterials", teacherPaths.lectureMaterials(), "lectureMaterials"],
    ["aiConversations", teacherPaths.aiConversations({ unitId: "u1" }), "aiConversations"],
    ["activity", teacherPaths.activity({ group: "students" }), "activityExplorer"],
    ["questionActivity", teacherPaths.questionActivity("ls:42"), "questionActivity", { activityId: "ls:42" }],
    ["answers", teacherPaths.answers({ assignmentId: "w1" }), "answersByQuestion"],
    ["metrics", teacherPaths.metrics(), "courseMetrics"],
    ["exports", teacherPaths.exports(), "exports"],
    ["dataHealth", teacherPaths.dataHealth(), "dataHealth"],
    ["settings", teacherPaths.settings("privacy"), "courseSettings"],
  ];
  it.each(cases)("%s", (_name, url, id, params = {}) => {
    const resolved = resolveTeacherRoute(pathOf(url));
    expect(resolved?.route.id).toBe(id);
    expect(resolved?.params).toEqual(params);
    expect(legacyRedirect(pathOf(url), "")).toBeNull(); // current URLs are never redirected
  });
  it("adds only non-empty query values", () => {
    expect(teacherPaths.assignments({ status: "", search: "hw", unitId: undefined })).toBe("/teacher/assignments?search=hw");
    expect(teacherPaths.settings("package")).toBe("/teacher/settings?tab=package");
    expect(teacherPaths.studentTimeline("s1")).toBe("/teacher/students/s/s1/timeline");
  });
});

describe("student and preview builders", () => {
  it.each([
    [studentPaths.assignments(), "assignmentList", {}],
    [studentPaths.assignment("w 1"), "assignment", { assignmentId: "w 1", tool: "answer" }],
    [studentPaths.assignment("w1", "similar", "q2"), "assignment", { assignmentId: "w1", tool: "similar" }],
    [studentPaths.practice(), "practice", { tool: "settings" }],
    [studentPaths.practice("kiwi"), "practice", { tool: "kiwi" }],
    [studentPaths.workspace(), "workspace", {}],
    [studentPaths.askKiwi(), "askKiwi", {}],
    [studentPaths.course(), "courseOutline", {}],
  ])("%s", (url, id, params) => {
    expect(resolveStudentRoute(pathOf(url))).toEqual({ id, params, preview: false });
  });
  it("keeps the question id in the query string", () => {
    expect(studentPaths.assignment("w1", "code", "q2")).toBe("/student/assignments/w1/code?q=q2");
    expect(studentPaths.entry()).toBe("/entry");
  });
  it("resolves preview paths as preview student routes", () => {
    expect(resolveStudentRoute(previewPaths.assignments())).toEqual({ id: "assignmentList", params: {}, preview: true });
    expect(resolveStudentRoute(previewPaths.assignment("w1"))).toEqual({
      id: "assignment", params: { assignmentId: "w1", tool: "answer" }, preview: true,
    });
    expect(isPreviewPath("/preview/student")).toBe(true);
    expect(isPreviewPath("/preview/students")).toBe(false);
    expect(resolveStudentRoute("/student/unknown/page/deep")).toBeNull();
  });
});

describe("navigation chrome", () => {
  it("finds the active section for routed and unrouted paths", () => {
    expect(activeNavSection("/teacher/students/s/s1/timeline")).toBe("students");
    expect(activeNavSection("/teacher/insights")).toBe("insights");
    expect(activeNavSection("/teacher/grading/unknown/deeper")).toBe("grading");
    expect(activeNavSection("/student/code")).toBeNull();
  });
  it("hides exactly the tabs whose permission is missing", () => {
    // Derived from the table itself, so the check holds when tabs or their permissions change.
    for (const section of NAV_SECTIONS.map((s) => s.id)) {
      const tabs = SECTION_TABS[section] ?? [];
      const needed = [...new Set(tabs.flatMap((t) => (t.permission ? [t.permission] : [])))];
      expect(sectionTabsFor(section, []), section).toEqual(tabs.filter((t) => !t.permission));
      expect(sectionTabsFor(section, needed), section).toEqual([...tabs]);
    }
  });
  it("picks the most specific tab that is the path or one of its parents", () => {
    const tabs = [{ label: "A", href: "/a" }, { label: "AB", href: "/a/b" }, { label: "ABC", href: "/a/bc" }];
    expect(activeTabHref(tabs, "/a/b/c")).toBe("/a/b");
    expect(activeTabHref(tabs, "/a/bc")).toBe("/a/bc");
    expect(activeTabHref(tabs, "/a/x")).toBe("/a");
    expect(activeTabHref(tabs, "/ab")).toBeNull();
    expect(activeTabHref([], "/a")).toBeNull();
  });
});

describe("legacy redirects (§3.3) not listed in routes.test.ts", () => {
  it.each([
    ["/student/", "?x=1", "/student/assignments?x=1"],
    ["/student/practice", "", "/student/practice/settings"],
    ["/preview", "", "/preview/student/assignments"],
    ["/preview/student/practice", "?a=b", "/preview/student/practice/settings?a=b"],
    ["/teacher/", "?range=this_week", "/teacher/home?range=this_week"],
    ["/teacher/work/assignments", "?page=2", "/teacher/assignments?page=2"],
    ["/teacher/work/new", "", "/teacher/assignments/new"],
    ["/teacher/work/policies", "?x=1", "/teacher/chapters/ai"],
    ["/teacher/course/plan", "", "/teacher/chapters"],
    ["/teacher/course/roster", "", "/teacher/students"],
    ["/teacher/course/materials", "", "/teacher/chapters/materials"],
    ["/teacher/analytics/overview", "", "/teacher/insights/metrics"],
    ["/teacher/analytics/evidence", "?questionId=q1", "/teacher/insights/activity/answers?questionId=q1"],
    ["/teacher/analytics/hub", "", "/teacher/grading/gradebook"],
    ["/teacher/work/edit/w%201", "", "/teacher/assignments/w%201/edit"],
    ["/teacher/analytics/session/s-9", "", "/teacher/insights/activity/question-activity/s-9"],
  ])("%s%s → %s", (path, search, to) => {
    expect(legacyRedirect(path, search)).toEqual({ to });
  });
  it("maps the grading view parameters", () => {
    expect(legacyRedirect("/teacher/work/grading", "?status=all&studentId=s1&assignmentId=w1")).toEqual({
      to: "/teacher/grading?assignmentId=w1&studentId=s1&show=all",
    });
    expect(legacyRedirect("/teacher/work/grading", "")).toEqual({ to: "/teacher/grading?show=latest" });
  });
  it("maps the old explorer parameters", () => {
    expect(legacyRedirect("/teacher/analytics/table", "?group=materials&source=kiwi&activity=questions&page=3")).toEqual({
      to: "/teacher/insights/activity?group=reading&where=kiwi&activity=ai&page=3",
    });
    expect(legacyRedirect("/teacher/analytics/table", "?group=students&activity=runs")).toEqual({
      to: "/teacher/insights/activity?group=students&activity=runs",
    });
  });
  it("sends unknown teacher URLs home with a notice and leaves other URLs alone", () => {
    expect(legacyRedirect("/teacher/unknown/page", "")).toEqual({ to: "/teacher/home", notice: "moved" });
    expect(legacyRedirect("/entry", "")).toBeNull();
    expect(legacyRedirect("/teachers", "")).toBeNull();
  });
});
