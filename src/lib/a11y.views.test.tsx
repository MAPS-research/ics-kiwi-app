import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { AttentionRows } from "../teacher/home/AttentionList";
import { AssignmentListView } from "../teacher/assignments/AssignmentListPage";
import type { ListItem } from "../teacher/assignments/assignmentRules";
import { GradebookView } from "../teacher/grading/GradebookPage";
import { ActivityExplorerView } from "../teacher/insights/ActivityExplorerPage";
import { StudentSearch } from "../teacher/shell/StudentSearch";
import { ROLE_PERMISSIONS, TeacherProvider } from "../teacher/shell/TeacherContext";
import { GroupsView } from "../teacher/students/GroupsPage";
import { RosterView } from "../teacher/students/RosterPage";
import { StudentProfileView } from "../teacher/students/StudentProfilePage";
import { TimelineView } from "../teacher/students/StudentTimelinePage";
import { accessibleNames, duplicateNames } from "../test/a11yNames";
import type {
  AnalyticsRow, AnalyticsTable, AssignmentStats, AttentionItem, Course, Gradebook, GradebookCell, Group, Me, Permission, RosterEntry, StudentProfile,
  StudentTimeline, TeacherContextValue,
} from "../types";

/*
 * K-m04 (SB-m06 residual): no two controls of one rendered Students, Assignments or Insights view share an accessible
 * name, and a field never shares the top bar's "Find a student". Repeated row actions name their row ("Open profile for
 * Ada Chen", "Edit Week 3 HW"); the visible text stays first (label in name). Names are computed by src/test/a11yNames.ts.
 */

const noop = () => undefined;
const html = (element: ReactElement) => renderToStaticMarkup(element);
const COURSE: Course = {
  title: "CSS", description: "", currentUnitId: "u3", freePracticeScope: "current_and_earlier", linked: false, updatedAt: null,
  units: [{ id: "u3", title: "03 · Wrangling", goal: "", status: "current", access: "default", effectiveAccess: "open", week: 3, startsOn: null,
    runtime: { packages: [], datasetFileIds: [], timeoutSeconds: 12, errorHints: [] } }],
};
const me: Me = {
  kind: "teacher_key", classId: "c1", userId: "instructor", displayName: "Instructor", role: "instructor", permissions: [...ROLE_PERMISSIONS.instructor] as Permission[],
  isStaff: true, roleSource: "key", exportsForcedPseudonymous: false, preview: false, verified: false, classLinked: false, staffId: null,
};
const shell: TeacherContextValue = {
  classId: "c1", course: COURSE, setCourse: noop, me, refreshMe: async () => undefined,
  timeRange: { preset: "whole_term", effectivePreset: "whole_term", from: null, to: null, compareFrom: null, compareTo: null, label: "Whole term", compareLabel: null },
  setTimePreset: noop, nameMode: "names", setNameMode: noop, teacherKey: "k", setTeacherKey: noop, signOut: noop,
};
/** The page as the browser shows it: the top bar's student search next to the page content. */
const withTopBar = (page: ReactElement) => html(<TeacherProvider value={shell}><StudentSearch />{page}</TeacherProvider>);

const entry = (studentId: string, studentName: string): RosterEntry => ({
  studentId, studentName, displayName: studentName, email: `${studentId}@example.edu`, pseudonym: "S-001", source: "import", status: "active",
  groups: [], consent: "not_asked", consentSource: "none", excluded: false, exclusionReason: "", lastActive: "2026-10-23T12:58:00Z",
  lastLearningAction: "2026-10-12T13:00:00Z", missingWork: 2, activitiesRecorded: 7,
  missingWorkItems: [{ assignmentId: "w2", title: "Files HW — revision", originalTitle: "Files HW" }, { assignmentId: "w3", title: "Week 4 HW", originalTitle: null }],
});
const STUDENTS = [entry("s1", "Ada Chen"), entry("s2", "Bo Lin")];

function expectUnique(markup: string, minimum: number) {
  const names = accessibleNames(markup);
  expect(names.length).toBeGreaterThanOrEqual(minimum);
  expect(duplicateNames(markup)).toEqual([]);
  expect(names.filter((n) => !n.name)).toEqual([]);
}

describe("unique accessible names on the Students views (K-m04)", () => {
  it("Roster: two students, with the top bar's search", () => {
    const markup = withTopBar(<RosterView students={STUDENTS} total={2} page={1} filters={{ search: "", groupId: "", consent: "", status: "" }} groups={[]}
      canManage selected={new Set()} onFilter={noop} onPage={noop} onEdit={noop} onToggle={noop} onToggleAll={noop} />);
    expectUnique(markup, 12);
    expect(markup).toContain('aria-label="Open profile for Ada Chen"');
    expect(markup).toContain('aria-label="Open profile for Bo Lin"');
    expect(markup).toContain('aria-label="Missing work for Bo Lin: 2"');
  });
  it("Needs attention: two students with the same reason", () => {
    const item = (studentId: string, studentName: string): AttentionItem => ({ studentId, studentName, reasons: [
      { rule: "no_activity", text: "No learning actions recorded yet", href: `/teacher/students/s/${studentId}`, at: null, lastSeenAt: null },
      { rule: "missing_work", text: "Missing Week 4 HW", href: `/teacher/students/s/${studentId}`, at: null }] });
    const markup = html(<AttentionRows students={[item("s1", "Ada Chen"), item("s2", "Bo Lin")]} canGrade selected={new Set()} onToggle={noop}
      studentLabel={(s) => s.studentName} />);
    expectUnique(markup, 8);
    expect(markup).toContain('aria-label="No learning actions recorded yet — Bo Lin"');
  });
  it("Student profile: two assignments, errors and AI questions", () => {
    const cell: GradebookCell = { assignmentId: "w1", state: "released", score: 16, maxPoints: 20, attempts: 1, late: false, lateSeconds: 0, overTime: false,
      latestSubmissionId: "sub-1", scoredSubmissionId: "sub-1", draftAnswered: 0, draftTotal: 2, label: "16/20 · 1 submission" };
    const row = (assignmentId: string, title: string) => ({ assignmentId, title, kind: "homework" as const, dueAt: "2026-10-24T15:59:00+00:00", cell: { ...cell, assignmentId },
      timelineUrl: `/teacher/students/s/s1/assignments/${assignmentId}`, gradingUrl: `/teacher/grading?assignmentId=${assignmentId}&studentId=s1`, draftAnswered: null });
    const profile: StudentProfile = {
      student: STUDENTS[0], header: { lastActive: null, lastLearningAction: null, missing: 1, late: 0, avgScorePct: 82 }, fullTimelineUrl: "/teacher/students/s/s1/timeline",
      canExportConversations: true, assignments: [row("w1", "Week 3 HW"), row("w2", "Week 4 HW")],
      recentErrors: [{ at: "2026-10-20T01:00:00+00:00", questionLabel: "Week 3 HW · Q1", error: "object 'x' not found", href: "/teacher/students/s/s1/timeline" },
        { at: "2026-10-20T02:00:00+00:00", questionLabel: "Week 4 HW · Q1", error: "object 'y' not found", href: "/teacher/students/s/s1/timeline" }],
      recentAiQuestions: [{ at: "2026-10-20T01:00:00+00:00", prompt: "why NA?", where: "lab", threadKey: "lab:s1:t1", flagged: false },
        { at: "2026-10-20T03:00:00+00:00", prompt: "how to join?", where: "kiwi", threadKey: "kiwi:c1", flagged: false }],
      practiceByChapter: [],
    };
    const markup = withTopBar(<StudentProfileView profile={profile} permissions={ROLE_PERMISSIONS.instructor} onExportConversations={noop} onCaseFile={noop} />);
    expectUnique(markup, 10);
    expect(markup).toContain('aria-label="Timeline for Week 4 HW"');
    expect(markup).toContain('aria-label="Grade Week 4 HW"');
  });
  it("Groups: two groups of one kind", () => {
    const groups: Group[] = [{ id: "a", name: "A", kind: "condition", description: "", members: 3, archived: false },
      { id: "b", name: "B", kind: "condition", description: "", members: 3, archived: false }];
    const markup = html(<GroupsView groups={groups} canManage onMembers={noop} onRename={noop} onArchive={noop} />);
    expectUnique(markup, 6);
    expect(markup).toContain('aria-label="Members of B"');
    expect(markup).toContain('aria-label="Rename B"');
    expect(markup).toContain('aria-label="Archive B"');
  });
  it("Timeline: two generated exercises and two grade events", () => {
    const base = { questionId: null, questionLabel: "", studySessionIndex: 0, provenance: { where: "lab" as const },
      context: { practiceMode: "homework", assignmentId: "hw3", assignmentLabel: "Week 3 Homework", unitId: "u3" } };
    const timeline: StudentTimeline = {
      student: { studentId: "s1", studentName: "Ada Chen" }, assignment: null, status: null, nextCursor: null, hasMore: false,
      events: [
        { ...base, id: "e:1", at: "2026-10-21T01:03:00Z", kind: "similar_generated", title: "Similar exercise generated", detail: { stem: "mean(c(1, 3))?", questionType: "choice" } },
        { ...base, id: "e:2", at: "2026-10-21T01:09:00Z", kind: "similar_generated", title: "Similar exercise generated", detail: { stem: "sum(c(1, 3))?", questionType: "choice" } },
        { ...base, id: "g:1", at: "2026-10-21T03:00:00Z", kind: "grade_released", title: "Released 17/20", detail: { actorLabel: "Instructor", attempt: 1 } },
        { ...base, id: "g:2", at: "2026-10-22T03:00:00Z", kind: "grade_released", title: "Released 18/20", detail: { actorLabel: "Instructor", attempt: 2 } },
      ],
    } as unknown as StudentTimeline;
    const markup = html(<TimelineView timeline={timeline} canGrade loading={false} onLoadMore={noop} />);
    expectUnique(markup, 4);
  });
});

const stats = (over: Partial<AssignmentStats> = {}): AssignmentStats => ({
  enrolled: 60, submitted: 41, startedNotSubmitted: 3, toGrade: 12, toRelease: 0, late: 3, missing: 2, graded: 0, released: 0, avgScore: null,
  maxPoints: 20, attempted: 35, firstTryCorrectPct: 62, ...over,
});
const item = (over: Partial<ListItem> = {}): ListItem => ({
  id: "w1", title: "Week 3 HW", kind: "homework", unitId: "u3", status: "published", state: "past_due", questionCount: 3,
  dueAt: "2026-10-20T15:59:00Z", closeAt: null, latePolicy: { mode: "accept_marked", untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 },
  hasAttempts: true, revisionOf: null, stats: stats(), updatedAt: "x", ...over,
});

describe("unique accessible names on the Assignments list (K-m04)", () => {
  it.each([["instructor", ROLE_PERMISSIONS.instructor], ["ta", ROLE_PERMISSIONS.ta]] as const)("%s: two homework rows with the same counts and two exercises", (_role, permissions) => {
    const markup = withTopBar(<AssignmentListView course={COURSE} items={[item(), item({ id: "w2", title: "Week 4 HW" }),
      item({ id: "x1", title: "Exercise 1", kind: "practice", state: "open" }), item({ id: "x2", title: "Exercise 2", kind: "practice", state: "open" })]}
      total={4} page={1} pageSize={20} loaded busy={false} status="all" search="" permissions={permissions} timeZone="UTC"
      load={async () => ({ students: [], emails: null })} onSearch={noop} onStatus={noop} onPage={noop} onAction={noop} />);
    expectUnique(markup, 16);
    expect(markup).toMatch(/aria-label="(Edit|View) Week 4 HW"/);
    expect(markup).toContain('aria-label="Grade (12) — Week 4 HW"');
    expect(markup).toContain('aria-label="Results for Exercise 2"');
  });
});

const row = (over: Partial<AnalyticsRow>): AnalyticsRow => ({
  lastActive: "2026-10-23T12:58:00Z", lastLearningAction: "2026-10-12T13:00:00Z", interactions: 3, attempts: 2, checked: 2, correct: 1, codeRuns: 4,
  codeErrors: 1, codeSuccesses: 2, aiQuestions: 1, students: 1, sessions: 0, accuracy: 50, averageAttempts: 2, averageQuestions: 1, serverAccuracy: 50, ...over,
});

describe("unique accessible names on the Insights views (K-m04)", () => {
  const explorer = (group: "students" | "assignments" | "questions", rows: AnalyticsRow[]) => {
    const data: AnalyticsTable = { rows, total: rows.length, page: 1, pageSize: 25, population: { enrolled: 5, active: 2 } };
    return withTopBar(<ActivityExplorerView course={COURSE} group={group} values={{}} preset="teaching" data={data} loading={false}
      names={{ course: COURSE, assignments: [{ id: "w1", title: "Week 3 HW" }, { id: "w2", title: "Week 4 HW" }], groups: [] }}
      permissions={ROLE_PERMISSIONS.instructor} selected={new Set()} onSelect={noop} patch={noop} onDetails={noop} onAnswers={noop} onAddFilter={noop} />);
  };
  it("Activity explorer › Students: two rows", () => {
    const markup = explorer("students", [row({ id: "s1", studentId: "s1", studentName: "Ada Chen", label: "Ada Chen", missingWork: 1 }),
      row({ id: "s2", studentId: "s2", studentName: "Bo Lin", label: "Bo Lin", missingWork: 0 })]);
    expectUnique(markup, 14);
    expect(markup).toContain('aria-label="See details for Bo Lin"');
  });
  it("Activity explorer › Assignments: two rows with Answers", () => {
    const markup = explorer("assignments", [row({ id: "w1", assignmentId: "w1", label: "Week 3 HW", kind: "homework" }),
      row({ id: "w2", assignmentId: "w2", label: "Week 4 HW", kind: "homework" })]);
    expectUnique(markup, 12);
    expect(markup).toContain('aria-label="Answers for Week 4 HW"');
  });
});

describe("unique accessible names next to the top bar (K-m04)", () => {
  it("the Gradebook filter is not a second 'Find a student'", () => {
    const cell: GradebookCell = { assignmentId: "w1", state: "missing", score: null, maxPoints: 20, attempts: 0, late: false, lateSeconds: 0, overTime: false,
      latestSubmissionId: null, scoredSubmissionId: null, draftAnswered: 0, draftTotal: 2, label: "Missing" };
    const student = (studentId: string, studentName: string) => ({ studentId, studentName, pseudonym: studentId, section: null, condition: null, groups: [],
      cells: [cell], inClass: [], activeMinutes: 0, aiQuestions: 0, codeRuns: 0, lastActive: null });
    const book: Gradebook = { policy: "latest", columns: [{ assignmentId: "w1", title: "Files HW", maxPoints: 20, dueAt: null, header: "Files HW (20 pts)" }],
      inClassColumns: [], rows: [student("s1", "Ada Chen"), student("s2", "Bo Lin")], total: 2, page: 1, pageSize: 50 };
    const markup = withTopBar(<GradebookView book={book} canGrade canExport groups={[]} policy="latest" search="" groupId="" page={1} loading={false}
      onPolicy={noop} onSearch={noop} onGroup={noop} onPage={noop} />);
    expectUnique(markup, 6);
    const names = accessibleNames(markup).map((n) => n.name);
    expect(names.filter((n) => n === "Find a student")).toHaveLength(1);
    expect(names).toContain("Filter students");
  });
});
