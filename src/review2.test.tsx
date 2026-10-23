import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { popoverShift } from "./components/Popover";
import { ApiError } from "./lib/api";
import { displayTimeZone, formatDue, fromDateTimeLocal, setDisplayTimeZone, toDateTimeLocal, zoneLabel } from "./lib/format";
import { studentHref } from "./lib/navigation";
import { LAB_AI_LABEL, itemSourceLabel } from "./lib/questions";
import { teacherPageKey } from "./lib/routes";
import { checkEventId, formatStudentDate, responseMayBeLost } from "./student/assignments/AssignmentPage";
import {
  AUTO_LATE_NOTE, LATE_WINDOW_DAYS, LATE_POLICY_DEFAULT, autoLatePolicy, closingMoment, inputProblems, metaParts, protectionNote, withDatesPatch,
} from "./teacher/assignments/assignmentRules";
import { DatesSection } from "./teacher/assignments/DatesSection";
import { GradingCardView, RELEASED_DRAFT_NOTE, RELEASED_LOCKED_NOTE, submittedLine } from "./teacher/grading/GradingCard";
import { detailFixture, gradeEvent } from "./teacher/grading/gradingFixtures";
import { draftFromDetail, gradedByLine } from "./teacher/grading/gradingKeys";
import { AttentionList } from "./teacher/home/AttentionList";
import { homeLinks } from "./teacher/home/homeModel";
import { NeedsActionStrip } from "./teacher/home/NeedsActionStrip";
import { columnsFor } from "./teacher/insights/explorerColumns";
import { titleOutcome } from "./teacher/insights/timelineModel";
import { ROLE_PERMISSIONS } from "./teacher/shell/TeacherContext";
import type { AnalyticsRow, AssignmentInput, HomeData, SubmissionDetail, TimelineEvent } from "./types";

/*
 * Regression tests for the v0.6.0 second review (CHANGELOG 0.6.0 › Second review fixes). Each test names the
 * finding it pins (TEACHER-nn, CORRECTNESS-0n).
 */

afterEach(() => setDisplayTimeZone(undefined));
const noop = () => undefined;

describe("Presentation mode remounts the page (TEACHER-01)", () => {
  it("keys the routed page by name mode", () => {
    const names = teacherPageKey("gradebook", {}, "names");
    const pseudonyms = teacherPageKey("gradebook", {}, "pseudonyms");
    expect(names).not.toBe(pseudonyms);
    expect(teacherPageKey("gradebook", {}, "names")).toBe(names);
    expect(teacherPageKey("studentProfile", { studentId: "s1" }, "names")).not.toBe(teacherPageKey("studentProfile", { studentId: "s2" }, "names"));
  });
});

describe("Course time zone everywhere (TEACHER-02)", () => {
  const due = "2026-10-21T06:59:00.000Z"; // 14:59 in Asia/Shanghai, 23:59 the day before in Los Angeles
  it("uses the course zone when a call site passes none", () => {
    setDisplayTimeZone("Asia/Shanghai");
    expect(displayTimeZone()).toBe("Asia/Shanghai");
    expect(formatDue(due, Date.parse("2026-10-01T00:00:00Z"))).toBe("Due Wed 10/21 14:59");
    expect(formatDue(due, Date.parse("2026-10-01T00:00:00Z"), undefined, { zone: true })).toBe("Due Wed 10/21 14:59 GMT+8");
    expect(formatStudentDate(due)).toBe("Wed 10/21, 2:59 PM GMT+8");
    expect(submittedLine("2026-10-21T14:58:00.000Z")).toBe("10/21 22:58 GMT+8");
    setDisplayTimeZone("Not/AZone");
    expect(displayTimeZone()).toBeUndefined();
  });
  it("reads and writes datetime-local inputs in the course zone", () => {
    expect(toDateTimeLocal(due, "Asia/Shanghai")).toBe("2026-10-21T14:59");
    expect(fromDateTimeLocal("2026-10-24T23:59", "Asia/Shanghai")).toBe("2026-10-24T15:59:00.000Z");
    expect(toDateTimeLocal(fromDateTimeLocal("2026-10-24T23:59", "America/Los_Angeles"), "America/Los_Angeles")).toBe("2026-10-24T23:59");
    // across a DST change (Los Angeles falls back on 2026-11-01)
    expect(fromDateTimeLocal("2026-11-02T09:00", "America/Los_Angeles")).toBe("2026-11-02T17:00:00.000Z");
    expect(fromDateTimeLocal("2026-10-30T09:00", "America/Los_Angeles")).toBe("2026-10-30T16:00:00.000Z");
    expect(fromDateTimeLocal("")).toBeNull();
    expect(zoneLabel("UTC")).toBe("UTC");
    expect(zoneLabel("Asia/Shanghai", due)).toBe("GMT+8");
  });
  it("the editor inputs show course-zone wall time", () => {
    const input = { kind: "homework", dueAt: due, openAt: null, closeAt: null, latePolicy: { ...LATE_POLICY_DEFAULT }, maxAttempts: null, timeLimit: null,
      gradesVisibility: "on_release", solutionsVisibility: "after_due", audience: { type: "all" } } as unknown as AssignmentInput;
    const html = renderToStaticMarkup(<DatesSection input={input} timeZone="Asia/Shanghai" defaultGradesVisibility="on_release" groups={[]} readOnly={false} onChange={noop} />);
    expect(html).toContain('value="2026-10-21T14:59"');
  });
});

describe("Default late window ends answer protection (TEACHER-03)", () => {
  const base = { kind: "homework", dueAt: null, openAt: null, closeAt: null, latePolicy: { ...LATE_POLICY_DEFAULT }, solutionsVisibility: "after_due",
    maxAttempts: null, timeLimit: null, gradesVisibility: "on_release", audience: { type: "all" } } as unknown as AssignmentInput;
  it("a due date on new homework sets a 7-day late window that follows the due date", () => {
    const first = withDatesPatch(base, { dueAt: "2026-10-24T15:59:00.000Z" }, true);
    expect(first.latePolicy).toMatchObject({ mode: "accept_until", untilAt: "2026-10-31T15:59:00.000Z" });
    const moved = withDatesPatch(first, { dueAt: "2026-10-25T15:59:00.000Z" }, true);
    expect(moved.latePolicy.untilAt).toBe("2026-11-01T15:59:00.000Z");
    expect(LATE_WINDOW_DAYS).toBe(7);
    expect(closingMoment(moved)).toBe(Date.parse("2026-11-01T15:59:00.000Z"));
    expect(protectionNote(moved, "UTC", Date.parse("2026-10-20T00:00:00Z"))).toContain("until this homework closes");
    expect(protectionNote(moved, "UTC", Date.parse("2026-11-02T00:00:00Z"))).toBe("Answers are no longer protected: this homework is closed.");
    // a teacher's own late policy is never overwritten, and existing homework keeps its policy
    expect(withDatesPatch(first, { dueAt: "2026-10-26T15:59:00.000Z" }, false).latePolicy.untilAt).toBe("2026-10-31T15:59:00.000Z");
    expect(withDatesPatch({ ...base, kind: "practice" } as AssignmentInput, { dueAt: "2026-10-24T15:59:00.000Z" }, true).latePolicy.mode).toBe("accept_marked");
    expect(autoLatePolicy(null, first.latePolicy)).toMatchObject({ mode: "accept_marked", untilAt: null });
  });
  it("the editor says what the default does and warns when late work never ends", () => {
    const auto = withDatesPatch(base, { dueAt: "2026-10-24T15:59:00.000Z" }, true);
    const props = { timeZone: "UTC", defaultGradesVisibility: "on_release" as const, groups: [], readOnly: false, onChange: noop };
    expect(renderToStaticMarkup(<DatesSection input={auto} autoLate {...props} />)).toContain(AUTO_LATE_NOTE);
    expect(renderToStaticMarkup(<DatesSection input={{ ...auto, latePolicy: { ...LATE_POLICY_DEFAULT } }} {...props} />)).toContain("never closes");
  });
  it("refuses a close date before the due date (CORRECTNESS-08)", () => {
    const problems = inputProblems({ ...base, title: "x", unitId: "u", questions: [], dueAt: "2026-10-24T00:00:00Z", closeAt: "2026-10-20T00:00:00Z" } as unknown as AssignmentInput);
    expect(problems).toContain("The close date must be on or after the due date.");
  });
});

describe("Released grades (CORRECTNESS-01)", () => {
  const released = (): SubmissionDetail => {
    const d = detailFixture();
    return { ...d, submission: { ...d.submission, gradeStatus: "released", grade: 16 } };
  };
  const card = (detail: SubmissionDetail, canRelease: boolean) =>
    renderToStaticMarkup(<GradingCardView detail={detail} draft={draftFromDetail(detail)} canRelease={canRelease} canUnrelease={canRelease} busy={false}
      timeZone="UTC" onChange={noop} onSave={noop} />);
  it("a TA cannot save over a released grade", () => {
    const html = card(released(), false);
    expect(html).toContain(RELEASED_LOCKED_NOTE);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save draft<\/button>/);
    // SB-m03: the inputs are read-only too, so nothing typed is lost to a disabled Save
    expect(html).toMatch(/<input[^>]*aria-label="Score for Ada Chen, Week 3 Homework, attempt 1, question 1"[^>]*readOnly=""/);
    expect(html).toMatch(/<textarea[^>]*aria-label="Feedback to Ada Chen, Week 3 Homework, attempt 1 \(visible after release\)"[^>]*readOnly=""/);
    expect(card(released(), true)).not.toContain('readOnly=""');
  });
  it("an instructor is told that a draft withdraws the grade", () => {
    const html = card(released(), true);
    expect(html).toContain(RELEASED_DRAFT_NOTE);
    expect(html).not.toContain(RELEASED_LOCKED_NOTE);
    expect(card(detailFixture(), false)).not.toContain(RELEASED_LOCKED_NOTE);
  });
});

describe("In-class check retries (CORRECTNESS-07)", () => {
  it("reuses the eventId only for the same question and answer after a lost response", () => {
    let n = 0;
    const make = () => `check-${++n}`;
    const first = checkEventId(null, "q1", "5", make);
    expect(first).toBe("check-1");
    expect(checkEventId({ questionId: "q1", answer: "5", eventId: first }, "q1", "5", make)).toBe(first);
    expect(checkEventId({ questionId: "q1", answer: "5", eventId: first }, "q1", "6", make)).toBe("check-2");
    expect(checkEventId({ questionId: "q1", answer: "5", eventId: first }, "q2", "5", make)).toBe("check-3");
    expect(responseMayBeLost(new ApiError(0, "network_error", "offline"))).toBe(true);
    expect(responseMayBeLost(new ApiError(502, "request_failed", "bad gateway"))).toBe(true);
    expect(responseMayBeLost(new ApiError(409, "max_attempts_reached", "used"))).toBe(false);
    expect(responseMayBeLost(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("Preview links stay in the preview (TEACHER-15)", () => {
  it("builds preview hrefs while previewing", () => {
    expect(studentHref("/student/assignments/w1/kiwi?q=q1", "/preview/student/assignments/w1/answer")).toBe("/preview/student/assignments/w1/kiwi?q=q1");
    expect(studentHref("/student/practice/code", "/student/practice/settings")).toBe("/student/practice/code");
  });
});

describe("Popovers stay inside the viewport (TEACHER-11)", () => {
  it("shifts a panel that would run past either edge", () => {
    expect(popoverShift({ left: 498, right: 1056 }, 1024)).toBe(-48);
    expect(popoverShift({ left: 35, right: 378 }, 375)).toBe(16 - 35);
    expect(popoverShift({ left: 4, right: 200 }, 1024)).toBe(12);
    expect(popoverShift({ left: 100, right: 400 }, 1024)).toBe(0);
  });
});

describe("Home cross-links (TEACHER-12)", () => {
  const action: HomeData["needsAction"] = { toGrade: 0, toRelease: [], missingPastDue: [{ assignmentId: "w1", title: "Week 3 HW", count: 2, started: 1 }],
    late: 1, flaggedReplies: null };
  it("Missing opens the row's Missing list; Late offers a list too", () => {
    const html = renderToStaticMarkup(<NeedsActionStrip action={action} links={homeLinks(ROLE_PERMISSIONS.instructor)} />);
    expect(html).toContain('href="/teacher/assignments?search=Week+3+HW&amp;open=w1&amp;list=missing"');
    expect((html.match(/› List/g) ?? []).length).toBe(2);
  });
  it("past-due rows show a Missing count and the attention link says where it goes", () => {
    const stats = { enrolled: 60, submitted: 41, startedNotSubmitted: 3, toGrade: 12, toRelease: 0, late: 3, missing: 16, avgScore: null, maxPoints: 20, graded: 0, released: 0,
      attempted: 0, firstTryCorrectPct: null };
    const row = { kind: "homework" as const, questionCount: 2, dueAt: "2026-10-01T00:00:00Z", status: "published" as const, stats };
    expect(metaParts({ ...row, state: "past_due" }, "UTC")).toContain("Missing 16");
    expect(metaParts({ ...row, state: "open" }, "UTC")).not.toContain("Missing 16");
    const html = renderToStaticMarkup(<AttentionList students={[]} total={0} rulesText={[]} canGrade studentLabel={() => ""} />);
    expect(html).toContain("Open Needs attention");
    expect(html).not.toContain("Open roster");
  });
});

describe("Copy (TEACHER-14, TEACHER-09)", () => {
  const event = (title: string, correct: boolean | null): TimelineEvent =>
    ({ id: "e", at: "2026-10-21T00:00:00Z", kind: "answer_attempt", questionId: "q1", questionLabel: "Q1", title, context: {}, detail: { correct },
      provenance: { where: "lab" }, studySessionIndex: 0 }) as unknown as TimelineEvent;
  it("does not repeat the outcome the title already names", () => {
    expect(titleOutcome(event("Answer attempt · not auto-checked", null))).toBe("");
    expect(titleOutcome(event("Answer attempt · correct", true))).toBe("");
    expect(titleOutcome(event("Question opened", true))).toBe("Correct");
  });
  it("names migrated grades without 'Graded by' and says Ask Kiwi on the student side", () => {
    const history = [gradeEvent({ id: 1, action: "migrated", actorLabel: "Imported from v0.5", actorRole: "system", createdAt: "2026-10-21T01:10:00Z" })];
    expect(gradedByLine(history, "UTC")).toBe("Imported from v0.5 · 10/21 01:10");
    expect(LAB_AI_LABEL).toBe("Ask Kiwi");
    expect(itemSourceLabel("ai")).not.toMatch(/\bKiwi AI\b/);
  });
  it("an empty last seen under a time range reads 'Not seen in this period' (K-m01 renamed Last activity)", () => {
    const column = columnsFor("students", "teaching").find((c) => c.key === "lastActive")!;
    const row = { lastActive: null } as unknown as AnalyticsRow;
    expect(column.cell(row, { course: null, assignmentTitle: (id) => id, ranged: true })).toBe("Not seen in this period");
    expect(column.cell(row, { course: null, assignmentTitle: (id) => id })).toBe("Not seen yet");
  });
});
