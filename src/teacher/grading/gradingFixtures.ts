import type { GradeEventView, SubmissionDetail } from "../../types";

/* Test fixtures for the grading views (GRADE); shapes follow src/types.ts §7.5. Not imported by production code. */

export const gradeEvent = (over: Partial<GradeEventView>): GradeEventView => ({
  id: 1, action: "save_draft", actorLabel: "Wang (TA)", actorRole: "ta", totalBefore: null, totalAfter: 16,
  statusAfter: "draft", createdAt: "2026-10-22T01:10:00.000+00:00", ...over,
});

export function detailFixture(over: Partial<SubmissionDetail> = {}): SubmissionDetail {
  return {
    submission: { id: "sub-23022d71af964c01", assignmentId: "work-1", studentId: "s1", studentName: "Ada Chen", attempt: 1,
      answers: { q1: "4", q2: "A vector holds one type." }, submittedAt: "2026-10-21T14:58:00.000+00:00", grade: null,
      feedback: null, gradedAt: null, gradeStatus: "ungraded", isLate: false, lateSeconds: 0, isPreview: false, overTime: false,
      timeUsedSeconds: null },
    assignment: { id: "work-1", classId: "c1", kind: "homework", title: "Week 3 Homework", unitId: "r-basics", instructions: "",
      dueAt: "2026-10-24T15:59:00.000Z", openAt: null, closeAt: null,
      latePolicy: { mode: "accept_marked", untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 }, maxAttempts: null,
      timeLimit: null, gradesVisibility: "on_release", solutionsVisibility: "never",
      toolPolicy: { rWorkspace: true, allowRunPredict: false, askKiwi: "hints_only", similarPractice: false },
      audience: { type: "all" },
      questions: [
        { id: "q1", type: "fill", prompt: "What does mean(c(2, 4, 6)) return?", points: 10, choices: [], starterCode: "", answer: "4",
          graderRubric: "Full marks for 4." },
        { id: "q2", type: "text", prompt: "Explain a vector.", points: 10, choices: [], starterCode: "", answer: "",
          graderRubric: "Mention one type." },
      ],
      status: "published", state: "open", version: 1, frozen: true, frozenAt: null, attemptCount: 1, revisionOf: null, files: [],
      attachmentName: null, versions: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", archivedAt: null },
    studentLabel: "Ada Chen",
    items: [
      { questionId: "q1", points: 10, autoCorrect: true, autoScore: 10, autoReason: "exact", score: 10, comment: "", overridden: false },
      { questionId: "q2", points: 10, autoCorrect: null, autoScore: null, autoReason: "not_gradable", score: null, comment: "", overridden: false },
    ],
    total: null, maxPoints: 20, adjustment: { points: 0, reason: "", auto: false }, late: null, timeUsed: null,
    history: [gradeEvent({ id: 7, action: "autocheck", actorLabel: "Auto-check", actorRole: "system", totalAfter: null, statusAfter: "ungraded" })],
    latestGradeEventId: 7, earlierAttempts: [],
    process: { askKiwiMode: "hints_only", aiQuestions: 2, flaggedReplies: 0, codeRuns: 3, codeErrors: 1, similarRequested: 0,
      pastesFromAi: 0, activeMinutes: 12, timelineUrl: "/teacher/students/s/s1/assignments/work-1" },
    flags: [],
    ...over,
  };
}
