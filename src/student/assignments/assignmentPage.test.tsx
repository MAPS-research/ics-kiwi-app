import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Course, HostChatPolicy, StudentAssignment, StudentSubmission, StudentWorkOption } from "../../types";

/* ASSESS-24 [AU-D2-11, F02]: the view calls useHostChatPolicy; the stub captures what the page asks the Kiwi host. */
const { policies } = vi.hoisted(() => ({ policies: [] as (HostChatPolicy | null)[] }));
vi.mock("../../lib/kiwi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/kiwi")>();
  return { ...actual, useHostChatPolicy: (policy: HostChatPolicy | null) => void policies.push(policy) };
});

import { CHAT_UNAVAILABLE_REASON, hostChatMessages } from "../../lib/kiwi";
import {
  allowedTools,
  AssignmentPageView,
  attemptLabel,
  blockedReason,
  closedEarly,
  dueLines,
  GRADED_HOMEWORK_NOTE,
  originalNote,
  revisionNote,
  hostPolicyFor,
  NOT_AVAILABLE,
  onReturnToPage,
  runAllowed,
  submitRefusal,
  timeLimitIntro,
  withFreshState,
  type AssignmentPageViewProps,
} from "./AssignmentPage";
import { ApiError } from "../../lib/api";
import { AnswerPanel, adjustmentText, feedbackText, fileButtonLabel, lateDuration, lateSubmitWarning, penaltyText } from "./AnswerPanel";
import { AssignmentListView, chapterTitle, groupWorks, statusText } from "./AssignmentListPage";
import { isLowTime, TimeLimitBar, timeLeftText } from "./TimeLimitBar";

const course = { title: "CSS", currentUnitId: "u1", units: [{ id: "u1", title: "R basics" }] } as unknown as Course;
const late = { mode: "accept_marked" as const, untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 };
const homework = (over: Partial<StudentAssignment> = {}): StudentAssignment => ({
  id: "w1", kind: "homework", title: "HW 3", unitId: "u1", instructions: "Go.", state: "open", dueAt: "2026-10-24T15:59:00Z", closeAt: null,
  latePolicy: late, maxAttempts: 3, timeLimit: null, currentAttempt: null,
  toolPolicy: { rWorkspace: true, allowRunPredict: false, askKiwi: "hints_only", similarPractice: false },
  gradesVisibility: "on_release", version: 2,
  questions: [{ id: "q1", type: "fill", prompt: "mean(c(2, 4, 6))?", points: 10, choices: [], starterCode: "" },
    { id: "q2", type: "text", prompt: "Explain.", points: 10, choices: [], starterCode: "" }],
  files: [], attachmentName: null, ...over,
});
const sub = (over: Partial<StudentSubmission> = {}): StudentSubmission => ({
  id: "s1", assignmentId: "w1", attempt: 1, submittedAt: "2026-10-21T14:58:00Z", isLate: false, status: "waiting_for_teacher", grade: null,
  maxPoints: 20, feedback: null, items: null, ...over,
});
const noop = () => undefined;
const view = (work: StudentAssignment, over: Partial<AssignmentPageViewProps> = {}) =>
  renderToStaticMarkup(createElement(AssignmentPageView, {
    work, course, tool: "answer", question: work.questions[0], answers: {}, feedback: null, hints: [], submissions: [], busy: false, notice: "",
    savedText: "", onOpen: noop, onAnswer: noop, onCheck: noop, onSubmit: noop, onStart: noop, onExpire: noop, onDownload: noop, ...over,
  }));

beforeEach(() => {
  policies.length = 0;
});

describe("host chat policy (ASSESS-24)", () => {
  it("hides Kiwi's chat for homework with Ask Kiwi off and sends the graded-homework note", () => {
    view(homework({ toolPolicy: { rWorkspace: true, allowRunPredict: false, askKiwi: "off", similarPractice: false } }));
    expect(policies.at(-1)).toEqual({ available: false, contextNote: GRADED_HOMEWORK_NOTE });
    expect(hostChatMessages("Course X.", policies.at(-1) ?? null)).toEqual([
      { type: "kiwi:updateContext", payload: { context: `Course X.\n${GRADED_HOMEWORK_NOTE}`, tutoringMode: "guidance" } },
      { type: "kiwi:setChatAvailability", payload: { available: false, reason: CHAT_UNAVAILABLE_REASON } },
    ]);
  });
  it("keeps the chat available for hints-only homework", () => {
    view(homework());
    expect(policies.at(-1)).toEqual({ available: true, contextNote: GRADED_HOMEWORK_NOTE });
    expect(hostChatMessages("Course X.", policies.at(-1) ?? null)[1]).toEqual({ type: "kiwi:setChatAvailability", payload: { available: true, reason: "" } });
    expect(hostPolicyFor(null)).toBeNull();
    expect(hostPolicyFor(homework({ kind: "practice" }))?.contextNote).toContain("In-class exercise: HW 3");
  });
});

describe("tool policy tabs (ASSESS-10)", () => {
  const locked = { rWorkspace: false, allowRunPredict: false, askKiwi: "off" as const, similarPractice: false };
  it("shows only Answer & submit when every tool is off", () => {
    expect(allowedTools(locked)).toEqual(["answer"]);
    const html = view(homework({ toolPolicy: locked }));
    expect(html).not.toContain("R workspace");
    expect(html).not.toContain("Try a similar question");
    expect(html).not.toContain(">Ask Kiwi<");
    expect(html).toContain("Submit assignment");
  });
  it("answers direct navigation to a disabled tool with Not available", () => {
    for (const tool of ["kiwi", "similar", "code"] as const) expect(view(homework({ toolPolicy: locked }), { tool })).toContain(NOT_AVAILABLE);
  });
  it("renders the allowed tabs and disables Run for predict questions unless allowed", () => {
    const html = view(homework({ toolPolicy: { rWorkspace: true, allowRunPredict: true, askKiwi: "hints_only", similarPractice: true } }));
    for (const label of ["Answer &amp; submit", "R workspace", "Ask Kiwi", "Try a similar question"]) expect(html).toContain(label);
    expect(runAllowed({ type: "predict" }, locked)).toBe(false);
    expect(runAllowed({ type: "predict" }, { ...locked, allowRunPredict: true })).toBe(true);
    expect(runAllowed({ type: "complete" }, locked)).toBe(true);
  });
});

describe("header, attempts and time limit (ASSESS-01/02/22)", () => {
  it("shows due, past due and closed lines", () => {
    expect(dueLines(homework(), "UTC").headline).toBe("Due Sat 10/24, 3:59 PM UTC");
    expect(dueLines(homework({ state: "past_due" }))).toEqual({ headline: "Past due", detail: "Late submissions accepted (marked late)." });
    expect(dueLines(homework({ state: "past_due", latePolicy: { ...late, mode: "accept_until", untilAt: "2026-10-26T15:59:00Z" } }), "UTC").detail)
      .toBe("Late submissions accepted until Mon 10/26, 3:59 PM UTC (marked late).");
    expect(dueLines(homework({ state: "closed" })).detail).toBe("Closed — submissions are no longer accepted.");
  });
  it("K-m02: a homework closed before its due date reads 'Closed early · due …', never 'was due'", () => {
    const early = homework({ state: "closed", closeAt: "2026-10-23T14:21:40Z" });   // due Sat 10/24
    expect(closedEarly(early)).toBe(true);
    expect(dueLines(early, "UTC")).toEqual({ headline: "Closed early · due Sat 10/24, 3:59 PM UTC", detail: "Closed — submissions are no longer accepted." });
    expect(dueLines(homework({ state: "closed", closeAt: "2026-10-25T00:00:00Z" }), "UTC").headline).toBe("Closed · was due Sat 10/24, 3:59 PM UTC");
    // closed by the late policy (no close date): the due date has passed
    expect(dueLines(homework({ state: "closed", closeAt: null }), "UTC").headline).toBe("Closed · was due Sat 10/24, 3:59 PM UTC");
    expect(dueLines(homework({ state: "closed", dueAt: null, closeAt: "2026-10-23T14:21:40Z" })).headline).toBe("Closed");
    expect(closedEarly(homework({ closeAt: "not a date" }))).toBe(false);
    expect(view(early)).toContain("Closed early · due");
    expect(view(early)).not.toContain("was due");
  });
  it("K-m03: the copied-answers notice is a status line at the top of the page", () => {
    expect(view(homework(), { notice: "Your answers from the earlier version were copied here." }))
      .toContain('<p class="assess-notice" role="status">Your answers from the earlier version were copied here.</p>');
  });
  it("counts attempts and explains blocked submissions", () => {
    expect(attemptLabel(homework(), 1)).toBe("Attempt 2 of 3");
    expect(attemptLabel(homework({ maxAttempts: null }), 0)).toBe("Attempt 1");
    expect(attemptLabel(homework(), 3)).toBe("All 3 attempts used");
    expect(blockedReason(homework(), 3)).toBe("You have used every attempt.");
    expect(blockedReason(homework({ state: "closed" }), 0)).toContain("Closed");
    expect(blockedReason(homework({ timeLimit: { minutes: 30, onExpiry: "reject" } }), 0)).toBe("Start the attempt to answer.");
  });
  it("asks to start a timed attempt before showing the questions", () => {
    const html = view(homework({ timeLimit: { minutes: 30, onExpiry: "reject" } }));
    expect(html).toContain(timeLimitIntro(30));
    expect(html).toContain("This homework has a 30-minute time limit. The timer starts when you click Start attempt.");
    expect(html).not.toContain("mean(c(2, 4, 6))?");
    const started = view(homework({ timeLimit: { minutes: 30, onExpiry: "reject" }, currentAttempt: { attempt: 1, startedAt: "x", endsAt: "2099-01-01T00:00:00Z" } }));
    expect(started).toContain("Time left");
    expect(timeLeftText("2026-10-22T10:23:10Z", Date.parse("2026-10-22T10:00:00Z"))).toBe("Time left 23:10");
    expect(timeLeftText("2026-10-22T10:00:00Z", Date.parse("2026-10-22T10:01:00Z"))).toContain("Over time");
  });
  it("shows the assignment-updated notice", () => {
    expect(view(homework(), { notice: "This assignment was updated; review your answers." })).toContain("This assignment was updated");
  });
});

describe("answers, checks and released grades (ASSESS-08, NM16)", () => {
  const panel = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AnswerPanel, {
    work: homework(), question: homework().questions[0], answers: {}, feedback: null, hints: [], answered: 0, busy: false, submissions: [],
    savedLabel: "Saved to your account · 10:42", submitBlocked: "", onAnswer: noop, onCheck: noop, onSubmit: noop, onOpenQuestion: noop,
    onDownload: noop, ...over,
  }));
  it("says Waiting for teacher until the grade is released, then shows comments", () => {
    expect(panel({ submissions: [sub()] })).toContain("Waiting for teacher");
    const released = panel({ submissions: [sub({ status: "released", grade: 16, feedback: "Good work", items: { q1: { score: 8, comment: "ok" }, q2: { score: 8, comment: "" } } })] });
    expect(released).toContain("16 / 20 points");
    expect(released).toContain("Good work");
    expect(released).toContain("Q1 · 8/10 — ok");
    expect(released).not.toContain("Waiting for teacher");
  });
  it("shows the save state and the in-class feedback", () => {
    expect(panel()).toContain("Saved to your account · 10:42");
    const practice = homework({ kind: "practice" });
    const html = panel({ work: practice, question: practice.questions[0], feedback: { correct: false, attemptIndex: 1, attemptsLeft: 2, nextHint: "Add them up." },
      hints: ["Add them up."] });
    expect(html).toContain("Not quite — try again.");
    expect(html).toContain("2 attempts left.");
    expect(html).toContain("Hint 1:");
    expect(feedbackText({ correct: null, status: "recorded", attemptIndex: 1, attemptsLeft: null })).toBe("Answer recorded.");
  });
  it("shows points for homework questions and none for in-class questions, which are not graded (RT-06)", () => {
    expect(panel()).toContain('<p class="question-meta">Fill in the blank · 10 points</p>');
    const practice = homework({ kind: "practice" });
    const html = panel({ work: practice, question: practice.questions[0] });
    expect(html).toContain('<p class="question-meta">Fill in the blank · Auto-checked, not graded</p>');
    expect(html).not.toMatch(/\d+ points?</);
  });
});

describe("student assignment list", () => {
  const option = (over: Partial<StudentWorkOption> = {}): StudentWorkOption => ({
    id: "w1", title: "HW 3", kind: "homework", unitId: "u1", status: "published", questionCount: 2, hasSubmissions: false, dueAt: null,
    state: "open", closeAt: null, latePolicy: late, maxAttempts: null, myAttempts: 0, myLatestStatus: "none", ...over,
  });
  it("separates open from past due and closed work and marks preview drafts", () => {
    const html = renderToStaticMarkup(createElement(AssignmentListView, {
      course, loaded: true, works: [option(), option({ id: "w2", title: "Old HW", state: "closed" }), option({ id: "w3", status: "draft", state: "draft", isPreviewDraft: true })],
    }));
    expect(html.indexOf("Closed</h2>")).toBeLessThan(html.indexOf("Old HW"));
    expect(html).toContain("Draft (preview)");
    expect(statusText(option({ myLatestStatus: "submitted", myAttempts: 1 }))).toBe("Waiting for teacher");
    expect(statusText(option({ myLatestStatus: "graded" }))).toBe("Graded");
  });
});

describe("browser review RV6 (late window, penalty, released adjustment)", () => {
  const option = (over: Partial<StudentWorkOption> = {}): StudentWorkOption => ({
    id: "w1", title: "HW 3", kind: "homework", unitId: "u1", status: "published", questionCount: 2, hasSubmissions: false, dueAt: "2026-10-20T15:59:00Z",
    state: "open", closeAt: null, latePolicy: late, maxAttempts: null, myAttempts: 0, myLatestStatus: "none", ...over,
  });
  const window = { mode: "accept_until" as const, untilAt: "2026-10-27T15:59:00Z", graceMinutes: 0, penaltyPctPerDay: 10 };
  it("RV6-M09 keeps past-due work with an open late window with the open work and shows the window", () => {
    const pastDue = option({ id: "late", title: "Late HW", state: "past_due", latePolicy: window });
    const grouped = groupWorks([option({ id: "open", title: "Open HW" }), pastDue, option({ id: "old", title: "Old HW", state: "closed" })]);
    expect(grouped.open.map((w) => w.id)).toEqual(["late", "open"]);
    expect(grouped.closed.map((w) => w.id)).toEqual(["old"]);
    const html = renderToStaticMarkup(createElement(AssignmentListView, { course, loaded: true, works: [pastDue, option({ id: "old", title: "Old HW", state: "closed" })] }));
    expect(html.indexOf("Late HW")).toBeLessThan(html.indexOf("Closed</h2>"));
    expect(html).toContain("Late submissions accepted until");
    expect(html).not.toContain("Past due &amp; closed");
  });
  it("RV6-M01 states the late penalty in the header and before submitting", () => {
    const work = homework({ state: "past_due", latePolicy: window });
    expect(penaltyText(10)).toBe("\u221210% of the points per day late; each started day counts as a full day");
    expect(penaltyText(0)).toBe("");
    expect(dueLines(work, "UTC").detail).toBe(
      "Late submissions accepted until Tue 10/27, 3:59 PM UTC (marked late; \u221210% of the points per day late; each started day counts as a full day).");
    expect(lateSubmitWarning(work)).toBe(
      "The due date has passed: this submission will be marked late (\u221210% of the points per day late; each started day counts as a full day).");
    expect(lateSubmitWarning(homework())).toBe("");
    expect(lateSubmitWarning(homework({ kind: "practice", state: "past_due" }))).toBe("");
  });
  it("RV6-M01 explains the automatic late penalty of a released grade so the scores add up", () => {
    expect(adjustmentText({ points: -6, reason: "Late penalty (auto)" }, 68 * 3600, 10))
      .toBe("Late penalty: \u22126 points (submitted 2 d 20 h late, counted as 3 days × 10% per day; each started day counts as a full day)");
    expect(adjustmentText({ points: 1, reason: "Bonus" }, 0, 0)).toBe("Bonus: +1 point");
    expect(adjustmentText(null, 0, 10)).toBe("");
    const panel = renderToStaticMarkup(createElement(AnswerPanel, {
      work: homework({ latePolicy: window }), question: homework().questions[0], answers: {}, feedback: null, hints: [], answered: 0, busy: false,
      submissions: [sub({ status: "released", grade: 13, isLate: true, lateSeconds: 68 * 3600, adjustment: { points: -6, reason: "Late penalty (auto)" },
        items: { q1: { score: 9, comment: "" }, q2: { score: 10, comment: "" } } })],
      savedLabel: "", submitBlocked: "", onAnswer: noop, onCheck: noop, onSubmit: noop, onOpenQuestion: noop, onDownload: noop,
    }));
    expect(panel).toContain("13 / 20 points");
    expect(panel).toContain("Q1 · 9/10");
    expect(panel).toContain("Late penalty: \u22126 points (submitted 2 d 20 h late, counted as 3 days × 10% per day; each started day counts as a full day)");
  });
  it("RV6-m19 marks answered questions with a dot, hides empty instructions and uses a code font for code answers", () => {
    const work = homework({ instructions: "", questions: [{ id: "q1", type: "complete", prompt: "Finish it.", points: 10, choices: [], starterCode: "x <-" }] });
    const html = renderToStaticMarkup(createElement(AnswerPanel, {
      work, question: work.questions[0], answers: { q1: "x <- 1" }, feedback: null, hints: [], answered: 1, busy: false, submissions: [],
      savedLabel: "", submitBlocked: "", onAnswer: noop, onCheck: noop, onSubmit: noop, onOpenQuestion: noop, onDownload: noop,
    }));
    expect(html).not.toContain("Assignment instructions");
    expect(html).not.toContain("✓");
    expect(html).toContain('aria-label="Question 1, answered"');
    expect(html).toContain('class="work-answer mono"');
  });
});


describe("supplementary review (S-M01, S-M04, S-m08)", () => {
  const option = (over: Partial<StudentWorkOption> = {}): StudentWorkOption => ({
    id: "w2", title: "Files HW — revision", kind: "homework", unitId: "u1", status: "published", questionCount: 2, hasSubmissions: false,
    dueAt: "2026-10-20T15:59:00Z", state: "past_due", closeAt: null, latePolicy: late, maxAttempts: null, myAttempts: 0, myLatestStatus: "none", ...over,
  });
  it("S-M04: a 24 h 57 min late submission says it counted as 2 days", () => {
    expect(lateDuration(25 * 60)).toBe("25 min");
    expect(lateDuration(24 * 3600 + 57 * 60)).toBe("24 h 57 min");
    expect(lateDuration(68 * 3600)).toBe("2 d 20 h");
    expect(adjustmentText({ points: -4, reason: "Late penalty (auto)" }, 24 * 3600 + 57 * 60, 10))
      .toBe("Late penalty: \u22124 points (submitted 24 h 57 min late, counted as 2 days × 10% per day; each started day counts as a full day)");
  });
  it("S-M01: a revision of homework the student submitted is not 'Not submitted' and not urgent", () => {
    const revision = option({ submittedOriginal: { id: "w1", title: "Files HW" } });
    expect(statusText(revision)).toBe(originalNote("Files HW"));
    expect(originalNote("Files HW")).toBe("You submitted the original version (Files HW). Its grade stays there.");
    expect(statusText(option())).toBe("Not submitted");
    const grouped = groupWorks([option({ id: "open", state: "open" }), revision, option({ id: "missing" })]);
    expect(grouped.open.map((w) => w.id)).toEqual(["missing", "open", "w2"]);
    const html = view(homework({ submittedOriginal: { id: "w1", title: "Files HW" } }));
    expect(html).toContain("You submitted the original version (Files HW).");
    expect(view(homework({ submittedOriginal: { id: "w1", title: "Files HW" } }), { submissions: [sub()] })).not.toContain("original version");
  });
  it("R-m01: a closed original links to the revision that replaced it instead of saying it was updated", () => {
    const closed = homework({ state: "closed", revisedAs: { id: "w9", title: "Files HW (revised)" } });
    const html = view(closed);
    expect(html).toContain(revisionNote(closed));
    expect(revisionNote(closed)).toBe("This homework was closed when its new version was published:");
    expect(html).toContain('href="/student/assignments/w9/answer"');
    expect(html).toContain("Files HW (revised)");
    expect(revisionNote(homework({ revisedAs: { id: "w9", title: "New" } }))).toBe("A new version of this homework is available:");
    expect(view(homework({ revisedAs: null }))).not.toContain("new version");
  });
  it("S-m08: a hidden chapter's homework shows the chapter title, never the raw id", () => {
    expect(chapterTitle(option({ unitId: "network-analysis", unitTitle: "Social network analysis II" }), course)).toBe("Social network analysis II");
    expect(chapterTitle(option({ unitId: "network-analysis" }), course)).toBe("");
    expect(chapterTitle(option(), course)).toBe("R basics");
    const html = renderToStaticMarkup(createElement(AssignmentListView, { course, loaded: true, works: [option({ unitId: "network-analysis" })] }));
    expect(html).not.toContain("network-analysis");
  });
});


describe("S-m07: timed homework bar", () => {
  it("turns red in the last 5 minutes", () => {
    const now = Date.parse("2026-10-22T10:00:00Z");
    expect(isLowTime("2026-10-22T10:04:59Z", now)).toBe(true);
    expect(isLowTime("2026-10-22T10:05:01Z", now)).toBe(false);
    expect(isLowTime("2026-10-22T09:59:00Z", now)).toBe(false);
    const low = renderToStaticMarkup(createElement(TimeLimitBar, { endsAt: "2026-10-22T10:03:00Z", now }));
    expect(low).toContain('class="time-limit-bar low"');
    expect(low).toContain("less than 5 minutes left");
    expect(renderToStaticMarkup(createElement(TimeLimitBar, { endsAt: "2026-10-22T10:30:00Z", now }))).toContain('class="time-limit-bar"');
  });
});


describe("S-m10: per-question files", () => {
  it("names the question a file belongs to", () => {
    const questions = homework().questions;
    expect(fileButtonLabel({ name: "data.csv", questionId: "q1" }, questions)).toBe("Download data.csv (for Question 1)");
    expect(fileButtonLabel({ name: "notes.md", questionId: "" }, questions)).toBe("Download notes.md");
    expect(fileButtonLabel({ name: "old.csv", questionId: "gone" }, questions)).toBe("Download old.csv");
  });
});


describe("B-m03: a stale page learns that the homework closed", () => {
  it("turns closed, not-open and attempt-limit refusals into an alert that keeps the draft", () => {
    expect(submitRefusal(new ApiError(409, "assignment_closed", "Closed — submissions are no longer accepted.")))
      .toBe("Closed — submissions are no longer accepted. Your answers are still saved as a draft.");
    expect(submitRefusal(new ApiError(409, "late_not_accepted", "The due date has passed and late submissions are not accepted.")))
      .toContain("late submissions are not accepted. Your answers are still saved as a draft.");
    expect(submitRefusal(new ApiError(409, "not_open_yet", "This assignment is not open yet."))).toContain("not open yet");
    expect(submitRefusal(new ApiError(409, "max_attempts_reached", "This homework allows 2 attempts."))).toContain("allows 2 attempts");
    for (const other of [new ApiError(400, "incomplete_submission", "Answer every question"), new ApiError(409, "time_limit_exceeded", "x"),
      new ApiError(503, "unavailable", "x"), new Error("offline"), "boom"])
      expect(submitRefusal(other)).toBe("");
  });
  it("refreshes only the assignment state, so the questions and the draft stay as they are", () => {
    const stale = homework({ state: "past_due", latePolicy: { ...late, mode: "accept_until", untilAt: "2026-10-30T12:00:00Z" } });
    const fresh = homework({ state: "closed", closeAt: "2026-10-23T12:00:00Z", version: 3, questions: [], revisedAs: { id: "w9", title: "HW 3 — revision" } });
    const merged = withFreshState(stale, fresh);
    expect(merged.questions).toBe(stale.questions);
    expect(merged.version).toBe(2);
    expect([merged.state, merged.closeAt, merged.revisedAs?.id]).toEqual(["closed", "2026-10-23T12:00:00Z", "w9"]);
    expect(withFreshState(stale, { ...fresh, id: "other" })).toBe(stale);
  });
  it("shows the alert next to Submit, disables Submit and links the new version", () => {
    const work = homework({ state: "closed", revisedAs: { id: "w9", title: "HW 3 — revision" } });
    const html = view(work, { refusal: "Closed — submissions are no longer accepted. Your answers are still saved as a draft.", answers: { q1: "4", q2: "x" } });
    const button = html.indexOf("Submit assignment");
    const alert = html.indexOf('role="alert"');
    expect(button).toBeGreaterThan(0);
    expect(alert).toBeGreaterThan(button);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Submit assignment<\/button>/);
    expect(html).toMatch(/<div class="assess-submit-alert" role="alert" tabindex="-1">/i);
    expect(html.slice(alert)).toContain('href="/student/assignments/w9/answer"');
    // the refusal disables Submit even before the refreshed state arrives
    const stale = view(homework({ state: "past_due" }), { refusal: "Closed — submissions are no longer accepted. Your answers are still saved as a draft.",
      answers: { q1: "4", q2: "x" } });
    expect(stale).toMatch(/<button[^>]*disabled=""[^>]*>Submit assignment<\/button>/);
    expect(view(homework(), { answers: { q1: "4", q2: "x" } })).not.toContain('role="alert"');
  });
  it("a closed homework says Closed in the header, without the late window or an attempt counter", () => {
    const closed = homework({ state: "closed", latePolicy: { ...late, mode: "accept_until", untilAt: "2026-10-30T12:00:00Z" } });
    expect(dueLines(closed, "UTC")).toEqual({ headline: "Closed · was due Sat 10/24, 3:59 PM UTC", detail: "Closed — submissions are no longer accepted." });
    expect(dueLines(homework({ state: "closed", dueAt: null }))).toEqual({ headline: "Closed", detail: "Closed — submissions are no longer accepted." });
    expect(attemptLabel(closed, 1)).toBe("");
    expect(attemptLabel(homework({ state: "archived" }), 1)).toBe("");
    const html = view(closed, { submissions: [sub()] });
    expect(html).not.toContain("Attempt 2");
    expect(html).not.toContain("Late submissions accepted");
  });
  it("re-checks the state when the student returns to the page, at most once per interval", () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    let clock = 1_000_000;
    let calls = 0;
    const stop = onReturnToPage(win, doc, () => { calls += 1; }, 10_000, () => clock);
    win.dispatchEvent(new Event("focus"));
    doc.dispatchEvent(new Event("visibilitychange"));   // within the interval
    expect(calls).toBe(1);
    clock += 10_001;
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));   // hidden: nothing to show
    expect(calls).toBe(1);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toBe(2);
    stop();
    clock += 20_000;
    win.dispatchEvent(new Event("focus"));
    expect(calls).toBe(2);
  });
});
