import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setDisplayTimeZone } from "../../lib/format";
import { applicableMembers, ByQuestionView, groupHeading, groupScoreLabel, groupValue, memberLine, releasedNote, type QuestionGroup } from "./ByQuestionView";
import { ExerciseResultsView, refreshedLabel, RESULTS_DEFAULT_PRESET, RESULTS_REFRESH_MS } from "./ExerciseResultsPage";
import { GradebookView } from "./GradebookPage";
import { earlierAttemptHref, GradingCardView } from "./GradingCard";
import { draftFromDetail } from "./gradingKeys";
import { detailFixture, gradeEvent } from "./gradingFixtures";
import { releaseConfirmText, releaseConfirmTitle, ReleaseExportView } from "./ReleaseExportPage";
import { applyToGroup, groupApplyStatus, QueueFiltersView, unreleaseConfirmText } from "./ToGradePage";
import { ApiError } from "../../lib/api";
import type { ExerciseResults, Gradebook, SubmissionDetail } from "../../types";

const noop = () => undefined;
function card(detail: SubmissionDetail, over: Partial<Parameters<typeof GradingCardView>[0]> = {}) {
  return renderToStaticMarkup(
    <GradingCardView detail={detail} draft={draftFromDetail(detail)} canRelease={false} canUnrelease={false} busy={false}
      timeZone="Asia/Shanghai" onChange={noop} onSave={noop} {...over} />,
  );
}

describe("GradingCardView (GRADE-07, NM14–NM16, NM25)", () => {
  it("names score inputs after the student, never after the submission id", () => {
    const html = card(detailFixture());
    expect(html).toContain('aria-label="Score for Ada Chen, Week 3 Homework, attempt 1, question 2"');   // SB-m06: the card's homework too
    expect(html).toContain('aria-label="Score for Ada Chen, Week 3 Homework, attempt 1, question 1"');
    const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(3);
    expect(labels.some((l) => l.includes("sub-") || l.includes("23022d71af964c01"))).toBe(false);
  });
  it("shows answer vs reference, the staff rubric, auto-check lines and per-question comments", () => {
    const html = card(detailFixture());
    expect(html).toContain("Reference answer");
    expect(html).toContain("Rubric (staff only)");
    expect(html).toContain("Full marks for 4.");
    expect(html).toContain("Auto-checked ✓ 10/10");
    expect(html).toContain("Needs review");
    expect(html).toContain("Comment on Q1");
    expect(html).toContain("Comment on Q2");
    expect(html).toMatch(/Feedback to student \(visible after release\)<textarea/);
    expect(html).toContain("Needs grading");
    expect(html).toContain("Attempt 1 · Submitted 10/21 22:58");
    expect(html).toContain("Ask Kiwi: hints only · 2 questions asked");
    expect(html).toContain('href="/teacher/students/s/s1/assignments/work-1"');
    expect(html).toContain("See work process (code, errors, AI chats)");
  });
  it("opens only the first unscored question", () => {
    const html = card(detailFixture());
    expect(html.match(/<details class="grading-question"( open="")?/g)).toEqual(['<details class="grading-question"', '<details class="grading-question" open=""']);
  });
  it("offers Save draft and Save & next, and Release only to graders who may release (GRADE-05)", () => {
    const ta = card(detailFixture());
    expect(ta).toContain(">Save draft<");
    expect(ta).toContain(">Save &amp; next ungraded<");
    expect(ta).not.toContain(">Release<");
    expect(ta).not.toContain("Save &amp; release");
    const instructor = card(detailFixture(), { canRelease: true });
    expect(instructor).toContain(">Release<");
    const detail = detailFixture();
    const immediate = card({ ...detail, assignment: { ...detail.assignment, gradesVisibility: "immediately" } }, { canRelease: true });
    expect(immediate).toContain(">Save &amp; release<");
  });
  it("keeps the card actions in one order on every card (RV6-M11)", () => {
    const order = (html: string) => [...html.matchAll(/<div class="work-actions grading-actions">(.*?)<\/div>/g)][0][1]
      .match(/<button[^>]*>([^<]*)<\/button>/g)?.map((b) => b.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")) ?? [];
    const detail = detailFixture();
    const onRelease = card(detail, { canRelease: true });
    const immediate = card({ ...detail, assignment: { ...detail.assignment, gradesVisibility: "immediately" } }, { canRelease: true });
    expect(order(onRelease)).toEqual(["Save draft", "Save & next ungraded", "Release"]);
    expect(order(immediate)).toEqual(["Save draft", "Save, release & next", "Save & release"]);
    expect(onRelease).toContain("Students see this grade only after you release it.");
    expect(immediate).toContain("Grades for this homework are visible immediately");
    // the filled (primary) button follows the grade visibility, the positions do not move
    expect(onRelease).toMatch(/class="primary-button"[^>]*>Save draft</);
    expect(immediate).toMatch(/class="primary-button"[^>]*>Save &amp; release</);
  });
  it("drops Needs review from a question once its score is saved (RV6-M02)", () => {
    const base = detailFixture();
    const scored = { ...base, total: 19, submission: { ...base.submission, gradeStatus: "released" as const },
      items: base.items.map((i) => ({ ...i, score: i.questionId === "q2" ? 9 : 10 })) };
    const html = card(scored, { canRelease: true });
    expect(html).not.toContain("Needs review");
    expect(html).toContain("Scored 9/10");
    expect(html).toContain("Released 19/20");
  });
  it("marks overridden auto scores and shows saved states", () => {
    const base = detailFixture();
    const overridden = { ...base, total: 17, submission: { ...base.submission, gradeStatus: "draft" as const },
      items: base.items.map((i) => (i.questionId === "q1" ? { ...i, score: 8, overridden: true } : { ...i, score: 9 })) };
    const html = card(overridden);
    expect(html).toContain("Overridden");
    expect(html).toContain("Draft 17/20");
    const released = card({ ...overridden, submission: { ...overridden.submission, gradeStatus: "released" } }, { canUnrelease: true });
    expect(released).toContain("Released 17/20");
    expect(released).toContain(">Unrelease<");
  });
  it("pre-fills the automatic late penalty with a Remove button (GRADE-14)", () => {
    const base = detailFixture();
    const late = { ...base, late: { lateHours: 26, penaltyPctPerDay: 10 }, adjustment: { points: -4, reason: "Late penalty (auto)", auto: true },
      flags: [{ kind: "late" as const, text: "Late · 26 h" }] };
    const html = card(late);
    expect(html).toContain("Late penalty −4 (auto)");
    expect(html).toContain(">Remove<");
    expect(html).toContain("Late · 26 h");
  });
  it("lists integrity flags with evidence links, earlier attempts and the grader history (GRADE-03, GRADE-04)", () => {
    const base = detailFixture();
    const html = card({
      ...base,
      flags: [{ kind: "ai_final_answer", text: "AI reply may contain the final answer", href: "/teacher/students/s/s1/assignments/work-1" },
        { kind: "identical_answer", text: "Same answer as 2 other students", href: "/teacher/grading?assignmentId=work-1&view=question" }],
      earlierAttempts: [{ id: "sub-old", attempt: 1, submittedAt: "2026-10-20T01:00:00Z", gradeStatus: "released", grade: 15 }],
      history: [...base.history, gradeEvent({ id: 9, actorLabel: "Wang (TA)" })],
    });
    expect(html).toContain("AI reply may contain the final answer");
    expect(html).toContain("Same answer as 2 other students");
    expect(html).toContain("Earlier attempts (1)");
    expect(html).toContain("Released 15/20");
    // S-m06: this card still needs grading, so the last save is not called "Graded by"
    expect(html).toContain("Last saved by Wang (TA) · 10/22 09:10");
    const graded = card({ ...base, history: [...base.history, gradeEvent({ id: 9, actorLabel: "Wang (TA)" })],
      submission: { ...base.submission, gradeStatus: "draft" } });
    expect(graded).toContain("Graded by Wang (TA) · 10/22 09:10");
  });
  it("labels a total-only legacy grade", () => {
    const base = detailFixture();
    const html = card({ ...base, total: 18, submission: { ...base.submission, gradeStatus: "released", grade: 18 },
      items: base.items.map((i) => ({ ...i, score: null, autoCorrect: null })) });
    expect(html).toContain("Total-only grade (before v0.6)");
  });
});

describe("ByQuestionView (TH05)", () => {
  it("groups identical answers and applies one score to a group", () => {
    const question = detailFixture().assignment.questions[1];
    const html = renderToStaticMarkup(
      <ByQuestionView question={question} questionIndex={2} busy={false} onChange={noop} onApply={noop} values={{}}
        groups={[{ normalizedAnswer: "left_join(a, b)", sampleAnswer: "left_join(a, b)", submissionIds: ["x", "y"], autoCorrect: null },
          { normalizedAnswer: "merge(a, b)", sampleAnswer: "merge(a, b)", submissionIds: ["z"], autoCorrect: false }]} />,
    );
    expect(groupHeading(12, "left_join(a, b)")).toBe("12 students · left_join(a, b)");
    expect(html).toContain("2 students");
    expect(html).toContain("<code>left_join(a, b)</code>");
    expect(html).toContain("<code>merge(a, b)</code>");
    expect(html).toContain(`aria-label="${groupScoreLabel(2, 2, 1)}"`);
    expect(groupScoreLabel(2, 2)).toBe("Score for 2 students with this answer, question 2");
    expect(groupScoreLabel(2, 2, 1)).toBe("Score for answer group 1 (2 students), question 2");
    expect(html).toContain("Apply to 2 submissions");
  });

  const released: QuestionGroup = {
    normalizedAnswer: "left join keeps every row", sampleAnswer: "x <- left_join(a, b)\ny <- count(x)", submissionIds: ["ada", "bo"],
    autoCorrect: null, autoScore: null,
    members: [
      { submissionId: "ada", studentId: "s1", studentLabel: "Ada Chen", attempt: 1, latest: true, gradeStatus: "released", grade: 16, score: 6, maxPoints: 20 },
      { submissionId: "bo", studentId: "s2", studentLabel: "Bo Lin", attempt: 2, latest: true, gradeStatus: "ungraded", grade: null, score: null, maxPoints: 20 },
    ],
  };

  it("S-B01: names the students, shows released grades and never applies to them", () => {
    const question = detailFixture().assignment.questions[1];
    const html = renderToStaticMarkup(
      <ByQuestionView question={question} questionIndex={2} busy={false} onChange={noop} onApply={noop} values={{}} groups={[released]} />,
    );
    expect(html).toContain("Ada Chen · Attempt 1 · Released 16/20");
    expect(html).toContain("Bo Lin · Attempt 2 · Needs grading");
    expect(html).toContain(releasedNote(1));
    expect(releasedNote(1)).toBe("1 released grade stays as released. To change one, unrelease it on its card first.");
    expect(html).toContain("Apply to 1 submission");
    expect(applicableMembers(released)).toEqual(["bo"]);
    expect(memberLine({ ...released.members![1], latest: false })).toBe("Bo Lin · Attempt 2 (older attempt) · Needs grading");
    const allReleased = { ...released, members: released.members!.map((m) => ({ ...m, gradeStatus: "released" as const, grade: 16 })) };
    const disabled = renderToStaticMarkup(
      <ByQuestionView question={question} questionIndex={2} busy={false} onChange={noop} onApply={noop} values={{ [released.normalizedAnswer]: { score: "7", comment: "" } }}
        groups={[allReleased]} />,
    );
    expect(disabled).toMatch(/<button[^>]*disabled=""[^>]*>Nothing to apply \(all released\)<\/button>/);
  });

  it("S-B01: the apply loop sends keepReleased and counts a grade released meanwhile as kept", async () => {
    const sent: string[] = [];
    const result = await applyToGroup(["a", "b", "c"], async (id) => {
      sent.push(id);
      if (id === "b") throw new ApiError(409, "grade_released", "This grade is released, so it was not changed.");
      if (id === "c") throw new ApiError(400, "invalid_request", "Score for question 2 must be from 0 to 10");
      return null;
    });
    expect(sent).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ done: 1, kept: 1, failures: ["Score for question 2 must be from 0 to 10"] });
    expect(groupApplyStatus(7, 1, 1, 1, [])).toBe("Applied 7 points to 1 of 1 submission. 1 released grade was not changed.");
    expect(groupApplyStatus(1, 2, 2, 0, [])).toBe("Applied 1 point to 2 of 2 submissions.");
  });

  it("S-m05: an auto-checked group's Points box starts at the auto score; code keeps its line breaks", () => {
    const question = detailFixture().assignment.questions[0];
    expect(groupValue({}, { ...released, autoCorrect: true, autoScore: 10 })).toEqual({ score: "10", comment: "" });
    expect(groupValue({ [released.normalizedAnswer]: { score: "3", comment: "ok" } }, { ...released, autoScore: 10 })).toEqual({ score: "3", comment: "ok" });
    const html = renderToStaticMarkup(
      <ByQuestionView question={question} questionIndex={1} busy={false} onChange={noop} onApply={noop} values={{}}
        groups={[{ ...released, autoCorrect: true, autoScore: 10 }, { ...released, normalizedAnswer: "other", submissionIds: ["z"], members: [] }]} />,
    );
    expect(html).toContain('value="10"');
    expect(html).toContain("x &lt;- left_join(a, b)\ny &lt;- count(x)");
    const labels = [...html.matchAll(/aria-label="(Score for [^"]*)"/g)].map((m) => m[1]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

const book: Gradebook = {
  policy: "latest",
  columns: [{ assignmentId: "work-1", title: "Week 3 HW", maxPoints: 20, dueAt: "2026-10-24T15:59:00Z", header: "Week 3 HW (20 pts) · Due 10/24" }],
  inClassColumns: [{ assignmentId: "ex-1", title: "Warm-up" }],
  rows: [
    { studentId: "s1", studentName: "Ada Chen", pseudonym: "S-001", section: "Section A", condition: "Hints", groups: ["Section A", "Hints"],
      cells: [{ assignmentId: "work-1", state: "released", score: 17, maxPoints: 20, attempts: 1, late: true, lateSeconds: 3600, overTime: false,
        latestSubmissionId: "sub-1", scoredSubmissionId: "sub-1", draftAnswered: 0, draftTotal: 2, label: "17/20 · 1 submission" }],
      inClass: [{ assignmentId: "ex-1", completionPct: 100, accuracyPct: 50 }], activeMinutes: 30, aiQuestions: 2, codeRuns: 4, lastActive: null },
    { studentId: "s2", studentName: "Bo Lin", pseudonym: "S-002", section: null, condition: null, groups: [],
      cells: [{ assignmentId: "work-1", state: "missing", score: null, maxPoints: 20, attempts: 0, late: false, lateSeconds: 0, overTime: false,
        latestSubmissionId: null, scoredSubmissionId: null, draftAnswered: 2, draftTotal: 3, label: "Missing · started (2/3 answered)" }],
      inClass: [{ assignmentId: "ex-1", completionPct: 0, accuracyPct: null }], activeMinutes: 0, aiQuestions: 0, codeRuns: 0, lastActive: null },
  ],
  total: 2, page: 1, pageSize: 50,
};
function gradebook(over: Partial<Parameters<typeof GradebookView>[0]> = {}) {
  return renderToStaticMarkup(
    <GradebookView book={book} canGrade canExport groups={[]} policy="latest" search="" groupId="" page={1} loading={false}
      onPolicy={noop} onSearch={noop} onGroup={noop} onPage={noop} {...over} />,
  );
}

describe("GradebookView (GRADE-06, GRADE-11, NM17–NM19)", () => {
  it("renders headers with points and due date, state cells, Section/Condition and in-class columns", () => {
    const html = gradebook();
    expect(html).toContain("Week 3 HW (20 pts) · Due 10/24");
    expect(html).toContain("Released 17/20 · 1 submission");
    expect(html).toContain("Missing · started (2/3 answered)");
    expect(html).toMatch(/status-badge tone-danger/);
    expect(html).toContain(">Late<");
    expect(html).toContain("Section A");
    expect(html).toContain("Hints");
    expect(html).toContain("100% done · Correct eventually 50%");
    expect(html).toContain('href="/teacher/grading?assignmentId=work-1&amp;studentId=s1&amp;submissionId=sub-1&amp;show=all"');
    expect(html).toContain('href="/teacher/students/s/s2/assignments/work-1"');
    expect(html).toContain("Grades for LMS (CSV)");
  });
  it("leaves out empty Section and Condition columns (RV6-m15)", () => {
    const plain: Gradebook = { ...book, rows: book.rows.map((r) => ({ ...r, section: null, condition: null, groups: [] })) };
    const html = gradebook({ book: plain });
    expect(html).not.toContain(">Section<");
    expect(html).not.toContain(">Condition<");
    expect(gradebook()).toContain(">Section<");
  });
  it("shows viewers the same data without grading links or the LMS export", () => {
    const html = gradebook({ canGrade: false, canExport: false });
    expect(html).toContain("Released 17/20 · 1 submission");
    expect(html).not.toContain("/teacher/grading?");
    expect(html).not.toContain("Grades for LMS (CSV)");
    expect(html).toContain("Activity log");
  });
});

describe("release confirmation (RV6-m20)", () => {
  it("says how many grades become visible and what stays hidden", () => {
    expect(releaseConfirmTitle(12)).toBe("Release 12 grades?");
    expect(releaseConfirmTitle(1)).toBe("Release 1 grade?");
    expect(releaseConfirmText("Week 3 HW (20 pts) · Due 10/24", 2))
      .toBe("Students see their scores and feedback for Week 3 HW (20 pts) · Due 10/24 right away. 2 submissions still need grading and stay hidden.");
    expect(releaseConfirmText("HW", 0)).toBe("Students see their scores and feedback for HW right away.");
  });
});

describe("ReleaseExportView (GRADE-12)", () => {
  it("lists drafts ready to release and the LMS export options", () => {
    const html = renderToStaticMarkup(
      <ReleaseExportView canRelease canExport busy={false} selectedId="work-1" onSelect={noop} onRelease={noop} onExport={noop}
        exportOptions={{ policy: "latest", releasedOnly: true, layout: "wide" }} onExportOptions={noop}
        assignments={[{ assignmentId: "work-1", header: "Week 3 HW (20 pts) · Due 10/24",
          counts: { toGrade: 0, late: 0, flagged: 0, draft: 12, toRelease: 12, graded: 58, all: 60 } }]}
        drafts={[{ id: "sub-1", studentLabel: "Ada Chen", attempt: 1, label: "Draft 17/20" }]} />,
    );
    expect(html).toContain("Ready to release 12");
    expect(html).toContain("Release grades (58/60 graded)");
    expect(html).toContain("Ada Chen");
    expect(html).toContain("Draft 17/20");
    expect(html).toContain("Released only");
    expect(html).toContain("Grades for LMS (CSV)");
    expect(html).toContain("Student × assignment status (CSV)");
  });
  it("hides the release button from graders who may not release", () => {
    const html = renderToStaticMarkup(
      <ReleaseExportView canRelease={false} canExport busy={false} selectedId="" onSelect={noop} onRelease={noop} onExport={noop}
        exportOptions={{ policy: "latest", releasedOnly: true, layout: "wide" }} onExportOptions={noop} assignments={[]} drafts={[]} />,
    );
    expect(html).not.toContain("Release grades (");
    expect(html).toContain("Your role can save grades as drafts");
  });
});

const results: ExerciseResults = {
  assignment: detailFixture().assignment, enrolled: 3, refreshedAt: "2026-10-22T02:42:05.000Z",
  questions: [{ questionId: "q1", label: "Q1 · What does mean(c(2, 4, 6)) return?", attempted: 3, correctFirstTryPct: 33,
    correctEventuallyPct: 67, topWrongAnswers: [{ answer: "5", students: 2 }],
    stuck: [{ studentId: "s2", studentName: "Bo Lin", wrongAttempts: 3, lastAttemptAt: "2026-10-22T02:40:00Z" }] }],
  students: [{ studentId: "s1", studentName: "Ada Chen", correct: 1, attempted: 1, lastActive: null }],
};

describe("ExerciseResultsView (GRADE-09, F10)", () => {
  it("defaults to This class and refreshes every 15 s", () => {
    expect(RESULTS_DEFAULT_PRESET).toBe("this_class");
    expect(RESULTS_REFRESH_MS).toBe(15000);
    expect(refreshedLabel("2026-10-22T02:42:05.000Z", "Asia/Shanghai")).toBe("Refreshed 10:42:05");
  });
  it("uses the course zone App set when the page passes none, not the browser zone (RT-07)", () => {
    // WHY: a UTC+14 zone differs from any zone a test machine runs in, so a browser-zone fallback cannot pass by accident
    setDisplayTimeZone("Pacific/Kiritimati");
    try {
      expect(refreshedLabel("2026-10-22T02:42:05.000Z")).toBe("Refreshed 16:42:05");
      expect(refreshedLabel("2026-10-22T02:42:05.000Z", "Asia/Shanghai")).toBe("Refreshed 10:42:05");
      const html = renderToStaticMarkup(
        <ExerciseResultsView results={results} preset="this_class" onPreset={noop} groups={[]} groupId="" onGroup={noop} rangeLabel="This class" />,
      );
      expect(html).toContain("Refreshed 16:42:05");
    } finally {
      setDisplayTimeZone(null);
    }
  });
  it("shows attempted, first-try and eventual accuracy, wrong answers and stuck students", () => {
    const html = renderToStaticMarkup(
      <ExerciseResultsView results={results} preset="this_class" onPreset={noop} groups={[]} groupId="" onGroup={noop}
        timeZone="Asia/Shanghai" rangeLabel="This class (Tue 10/20 10:00)" />,
    );
    expect(html).toContain("Attempted 3/3");
    expect(html).toContain("First try correct 33%");
    expect(html).toContain("Correct eventually 67%");
    expect(html).toContain("Stuck now");
    expect(html).toContain("Bo Lin");
    expect(html).toContain("5 (2 students)");
    expect(html).toContain("Refreshed 10:42:05");
    expect(html).toContain("This class (Tue 10/20 10:00)");
    expect(html).toContain('aria-label="Time range for these results"');
  });
});

describe("QueueFiltersView (NM12, NM13)", () => {
  it("renders the Show filter, the view toggle and the live count title", () => {
    const html = renderToStaticMarkup(
      <QueueFiltersView show="latest" view="student" assignmentId="" assignments={[{ id: "work-1", title: "Week 3 HW" }]} questions={[]}
        questionId="" search="" chips={[]} onChange={noop} onSearch={noop} />,
    );
    expect(html).toContain("Latest attempts to grade");
    expect(html).toContain("Flagged");
    expect(html).toContain(">By student<");
    expect(html).toContain(">By question<");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Week 3 HW");
  });
});


describe("S-m06: grading card details", () => {
  it("links earlier attempts to their own card and confirms an unrelease by name", () => {
    const detail = detailFixture();
    const withEarlier = { ...detail, earlierAttempts: [{ id: "sub-old", attempt: 1, submittedAt: "2026-10-20T01:00:00Z", gradeStatus: "released" as const, grade: 12 }] };
    const html = card(withEarlier);
    const href = earlierAttemptHref(withEarlier, "sub-old");
    expect(href).toContain("submissionId=sub-old");
    expect(href).toContain("show=all");
    expect(html).toContain(`href="${href.replace(/&/g, "&amp;")}"`);
    expect(unreleaseConfirmText(detail)).toBe(`${detail.studentLabel} no longer sees this grade (attempt ${detail.submission.attempt}) until you release it again. The history keeps the release.`);
  });
});


describe("S-m14: gradebook names", () => {
  it("shows the student id under the name, not the pseudonym, when Presentation mode is off", () => {
    const html = gradebook();
    expect(html).toContain(">s1</small>");
    expect(html).not.toContain(">S-001</small>");
  });
});
