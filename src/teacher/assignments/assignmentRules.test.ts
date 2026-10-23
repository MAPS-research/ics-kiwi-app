import { describe, expect, it } from "vitest";
import {
  blankInput,
  defaultToolPolicy,
  homeworkButton,
  inputOf,
  inputProblems,
  isDirty,
  lineageLinks,
  metaLine,
  parseChoices,
  parseTags,
  protectionNote,
  rowMenuActions,
  studentStatusLabel,
  withKind,
  withQuestionType,
  blankQuestion,
  type ListItem,
} from "./assignmentRules";
import type { AssignmentStats, Course, Permission, TeacherAssignment } from "../../types";

const course = { currentUnitId: "u2", units: [{ id: "u1" }, { id: "u2" }] } as unknown as Course;
const stats = (over: Partial<AssignmentStats> = {}): AssignmentStats => ({
  enrolled: 60, submitted: 41, startedNotSubmitted: 3, toGrade: 12, toRelease: 0, late: 3, missing: 0, graded: 0, released: 0,
  avgScore: null, maxPoints: 20, attempted: 0, firstTryCorrectPct: null, ...over,
});
const INSTRUCTOR: Permission[] = ["viewAssignments", "editAssignments", "previewStudent"];
const TA: Permission[] = ["viewAssignments", "previewStudent", "grade"];

describe("defaults by assignment type (§4.5.1)", () => {
  it("uses the homework and in-class tool policies", () => {
    expect(defaultToolPolicy("homework")).toEqual({ rWorkspace: true, allowRunPredict: false, askKiwi: "hints_only", similarPractice: false });
    expect(defaultToolPolicy("practice")).toEqual({ rWorkspace: true, allowRunPredict: true, askKiwi: "explain_concepts", similarPractice: true });
  });
  it("prefills kind, chapter, audience and the course grade-visibility default", () => {
    const input = blankInput(course, { kind: "homework", unitId: "u1", audienceGroupId: "grp-1" }, "on_release");
    expect(input).toMatchObject({ kind: "homework", unitId: "u1", gradesVisibility: "on_release", audience: { type: "groups", groupIds: ["grp-1"] } });
    expect(blankInput(course, { unitId: "missing" }).unitId).toBe("u2");
    expect(blankInput(course, { kind: "practice" }).gradesVisibility).toBe("immediately");
  });
  it("switching type resets help and drops homework-only settings", () => {
    const homework = { ...blankInput(course), timeLimit: { minutes: 30, onExpiry: "reject" as const }, maxAttempts: 2 };
    const practice = withKind(homework, "practice");
    expect(practice.toolPolicy.askKiwi).toBe("explain_concepts");
    expect(practice.timeLimit).toBeNull();
    expect(practice.maxAttempts).toBeNull();
    expect(withKind(practice, "practice")).toBe(practice);
  });
  it("copies the editable fields of a TeacherAssignment and tracks dirty state", () => {
    const work = { ...blankInput(course), id: "w1", status: "draft", version: 1, updatedAt: "x" } as unknown as TeacherAssignment;
    const input = inputOf(work);
    expect(input).not.toHaveProperty("id");
    expect(isDirty(input, inputOf(work))).toBe(false);
    expect(isDirty(input, { ...input, title: "Changed" })).toBe(true);
  });
});

describe("answer protection (decision D2)", () => {
  const tz = "Asia/Shanghai";
  const now = Date.parse("2026-10-20T00:00:00Z");
  const due = "2026-10-24T15:59:00Z";       // Sat 10/24 23:59 in Shanghai
  const lateEnd = "2026-10-26T15:59:00Z";   // Mon 10/26 23:59
  const hw = (over: Partial<Parameters<typeof protectionNote>[0]> = {}) => ({
    kind: "homework" as const, state: "open" as const, dueAt: due, closeAt: null, solutionsVisibility: "after_due" as const,
    latePolicy: { mode: "accept_until" as const, untilAt: lateEnd, graceMinutes: 0, penaltyPctPerDay: 0 }, ...over,
  });
  it("defaults new homework to solutions after the due date and keeps Never explicit", () => {
    expect(blankInput(course, { kind: "homework" }).solutionsVisibility).toBe("after_due");
    expect(blankInput(course, { kind: "practice" }).solutionsVisibility).toBe("never");
    expect(withKind(blankInput(course, { kind: "homework" }), "practice").solutionsVisibility).toBe("never");
    expect(withKind({ ...blankInput(course, { kind: "practice" }), solutionsVisibility: "after_submit" }, "homework").solutionsVisibility)
      .toBe("after_submit");
  });
  it("states the actual protection window", () => {
    expect(protectionNote(hw(), tz, now)).toBe(
      "Ask Kiwi won't give final answers until this homework closes (Sat 10/24 23:59 + late window to Mon 10/26 23:59).");
    expect(protectionNote(hw({ latePolicy: { mode: "not_accepted", untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 } }), tz, now))
      .toBe("Ask Kiwi won't give final answers until this homework closes (Sat 10/24 23:59).");
    expect(protectionNote(hw({ latePolicy: { mode: "not_accepted", untilAt: null, graceMinutes: 15, penaltyPctPerDay: 0 } }), tz, now))
      .toBe("Ask Kiwi won't give final answers until this homework closes (Sat 10/24 23:59 + 15 min grace).");
    expect(protectionNote(hw({ closeAt: lateEnd, latePolicy: { mode: "accept_marked", untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 } }), tz, now))
      .toBe("Ask Kiwi won't give final answers until this homework closes (Sat 10/24 23:59 + late window to Mon 10/26 23:59).");
    expect(protectionNote(hw({ solutionsVisibility: "never" }), tz, now)).toBe(
      "Ask Kiwi won't give final answers until you archive it or make solutions visible (Solutions visible: Never).");
    expect(protectionNote(hw({ state: "closed" }), tz, now)).toBe("Answers are no longer protected: this homework is closed.");
    expect(protectionNote(hw(), tz, Date.parse("2026-10-27T00:00:00Z"))).toBe("Answers are no longer protected: this homework is closed.");
    expect(protectionNote(hw({ state: "closed", solutionsVisibility: "never" }), tz, now)).toContain("(Solutions visible: Never)");
    expect(protectionNote(hw({ state: "archived", solutionsVisibility: "never" }), tz, now))
      .toBe("Answers are no longer protected: this homework is archived.");
    expect(protectionNote(hw({ latePolicy: { mode: "accept_marked", untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 } }), tz, now)).toBe(
      "Ask Kiwi won't give final answers for this homework: there is no closing date, so answers stay protected until you set one or archive the homework.");
    expect(protectionNote(hw({ solutionsVisibility: "after_submit" }), tz, now)).toBe(
      "Ask Kiwi won't give a student final answers until they submit or this homework closes (Sat 10/24 23:59 + late window to Mon 10/26 23:59).");
    expect(protectionNote(hw({ solutionsVisibility: "after_release", dueAt: null, latePolicy: { mode: "accept_marked", untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 } }), tz, now))
      .toContain("there is no closing date");
    expect(protectionNote({ ...hw(), kind: "practice" }, tz, now)).toBeNull();
  });
});

describe("text field parsing", () => {
  it("trims choices, drops empty lines and rejects duplicates inline", () => {
    expect(parseChoices(" A \n\nB\n")).toEqual({ choices: ["A", "B"], error: null });
    expect(parseChoices("A\nA").error).toBe("Duplicate choice: A");
    expect(parseChoices("A\n").error).toBe("Add at least two choices.");
  });
  it("parses and validates tags", () => {
    expect(parseTags("Joins, skill:left_join, joins")).toEqual({ tags: ["joins", "skill:left_join"], error: null });
    expect(parseTags("bad!").error).toContain("bad!");
    expect(parseTags("a,b,c,d,e,f,g,h,i").error).toBe("Use at most 8 tags.");
  });
  it("resets type-specific fields when the question type changes", () => {
    const text = blankInput(course).questions[0];
    expect(text.grading?.autoCheck).toBe(false);
    const choice = withQuestionType({ ...text, answer: "x" }, "choice");
    expect(choice).toMatchObject({ type: "choice", choices: [], answer: "", grading: { autoCheck: true } });   // RV6-m02: no blank lines
    expect(blankQuestion("choice").choices).toEqual([]);
    expect(withQuestionType(choice, "text").choices).toEqual([]);
  });
  it("lists problems before saving", () => {
    const input = blankInput(course, { kind: "practice" });
    input.questions = [{ ...withQuestionType(input.questions[0], "fill"), prompt: "?" }];
    expect(inputProblems(input)).toEqual(["Add a title.", "Question 1: in-class questions need a reference answer to be auto-checked."]);
  });
});

describe("list rows (ASSESS-13, NM10, NM11)", () => {
  const homework: ListItem = {
    id: "w1", title: "HW", kind: "homework", unitId: "u1", status: "published", state: "open", questionCount: 3,
    dueAt: "2026-10-24T15:59:00+00:00", closeAt: null, latePolicy: { mode: "accept_marked", untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 },
    hasAttempts: true, revisionOf: null, stats: stats(), updatedAt: "x",
  };
  it("formats the homework meta line in the course timezone", () => {
    expect(metaLine(homework, "Asia/Shanghai")).toBe("Homework · Due Sat 10/24 23:59 GMT+8 · Submitted 41/60 · To grade 12 · Late 3");
  });
  it("formats the in-class meta line with singular/plural", () => {
    const practice = { ...homework, kind: "practice" as const, questionCount: 1, stats: stats({ attempted: 35, firstTryCorrectPct: 62 }) };
    // RT-02: the same label as Exercise results and the Gradebook
    expect(metaLine(practice)).toBe("In-class exercise · 1 question · Attempted 35/60 · First try correct 62%");
    expect(metaLine({ ...practice, questionCount: 3, status: "draft", stats: stats() })).toBe("In-class exercise · 3 questions");
  });
  it("walks the homework button through Grade → Release → Graded ✓", () => {
    expect(homeworkButton({ toGrade: 3 }).label).toBe("Grade (3)");
    expect(homeworkButton({ toGrade: 0, toRelease: 12 }, "w1")).toEqual({ label: "Release (12)", href: "/teacher/grading/release?assignmentId=w1", kind: "release" });
    expect(homeworkButton({ toGrade: 0, toRelease: 0, submitted: 5 }).label).toBe("Graded ✓");
    expect(homeworkButton({ toGrade: 3 }, "w1").href).toBe("/teacher/grading?assignmentId=w1&show=latest");
  });
  it("offers row menu actions by state and role", () => {
    const actions = (item: Partial<ListItem>, perms = INSTRUCTOR) => rowMenuActions({ ...homework, ...item }, perms).map((a) => a.action);
    expect(actions({})).toEqual(["duplicate", "revision", "preview", "close", "archive"]);
    expect(actions({ status: "draft", state: "draft", hasAttempts: false, hasPreviewRows: true })).toEqual(
      ["duplicate", "preview", "clearPreview", "archive", "delete"]);
    expect(actions({ state: "closed" })).toContain("reopen");
    expect(actions({ state: "archived" })).toEqual(["duplicate", "revision", "unarchive"]);
    expect(actions({}, TA)).toEqual(["preview"]);
  });
  it("labels popover rows", () => {
    expect(studentStatusLabel({ submittedAt: null, late: false, draftAnswered: 2, draftTotal: 3, attempts: 0 })).toBe("Started · 2/3 answered");
    expect(studentStatusLabel({ submittedAt: "x", late: true, draftAnswered: 0, draftTotal: 3, attempts: 2 })).toBe("Submitted · 2 attempts · late");
    expect(studentStatusLabel({ submittedAt: null, late: false, draftAnswered: 0, draftTotal: 3, attempts: 0 })).toBe("Not started");
  });
});


describe("supplementary review (S-M01, S-M02, S-M07)", () => {
  const tz = "Asia/Shanghai";
  const closed = {
    kind: "homework" as const, state: "closed" as const, dueAt: "2026-10-20T15:59:00Z", closeAt: "2026-10-22T08:00:00Z",
    solutionsVisibility: "after_due" as const, latePolicy: { mode: "accept_marked" as const, untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 },
  };
  it("S-M02: a closed original stays protected while its revision accepts submissions", () => {
    const revisions = [{ id: "w2", title: "Files HW — revision", status: "published" as const, state: "past_due" as const }];
    expect(protectionNote({ ...closed, revisions }, tz)).toBe(
      "Closed, but Ask Kiwi still won't give final answers: its revision “Files HW — revision” asks the same questions and accepts submissions.");
    expect(protectionNote({ ...closed, revisions: [{ ...revisions[0], state: "closed" as const }] }, tz)).toBe(
      "Answers are no longer protected: this homework is closed.");
    expect(protectionNote({ ...closed, revisions: [{ ...revisions[0], status: "draft" as const, state: "draft" as const }] }, tz)).toBe(
      "Answers are no longer protected: this homework is closed.");
  });
  it("S-M01: links the original and its revisions and counts students who submitted the original", () => {
    expect(lineageLinks({ revisionOf: "w1", revisionOfTitle: "Files HW", revisions: [] })).toEqual([{ label: "Revision of “Files HW”", id: "w1" }]);
    expect(lineageLinks({ revisionOf: null, revisions: [{ id: "w2", title: "Files HW — revision", status: "draft", state: "draft" }] }))
      .toEqual([{ label: "Revised as “Files HW — revision” (draft)", id: "w2" }]);
    const line = metaLine({ kind: "homework", questionCount: 2, dueAt: null, status: "published", state: "past_due",
      stats: stats({ submitted: 0, enrolled: 2, toGrade: 0, late: 0, missing: 0, submittedOriginal: 2 }) } as ListItem);
    expect(line).toContain("Submitted 0/2");
    expect(line).toContain("Submitted the original 2");
    expect(line).not.toContain("Missing");
    expect(studentStatusLabel({ submittedAt: null, late: false, draftAnswered: 0, draftTotal: 2, attempts: 0, submittedOriginal: true }))
      .toBe("Submitted the original");
  });
  it("S-M07: an archived draft offers Unarchive", () => {
    const actions = rowMenuActions({ status: "draft", state: "archived", hasAttempts: false, hasPreviewRows: false }, INSTRUCTOR).map((a) => a.action);
    expect(actions).toContain("unarchive");
    expect(actions).not.toContain("archive");
    expect(actions).toContain("delete");
  });
});


describe("S-M06: editor limits before Publish", () => {
  it("reports a time limit below 5 minutes next to the field and in the footer list", () => {
    const base = { ...blankInput(course, { kind: "homework" }), title: "Timed", questions: [{ ...blankQuestion(), prompt: "Why?" }] };
    expect(inputProblems(base)).toEqual([]);
    const short = { ...base, timeLimit: { minutes: 1, onExpiry: "submit_marked" as const } };
    expect(inputProblems(short)).toContain("Time limit: use 5 to 600 minutes per attempt.");
    expect(inputProblems({ ...base, maxAttempts: 0 })).toContain("Attempts allowed: use a whole number from 1 to 100, or leave it empty for unlimited.");
    expect(inputProblems({ ...base, latePolicy: { ...base.latePolicy, graceMinutes: 500 } })).toContain("Grace minutes: use a whole number from 0 to 120.");
  });
});
