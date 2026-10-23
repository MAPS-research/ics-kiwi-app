import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROLE_PERMISSIONS } from "../shell/TeacherContext";
import { TimelineView } from "../students/StudentTimelinePage";
import { ActivityExplorerView } from "./ActivityExplorerPage";
import { AiCallDetailView } from "./AiCallPanel";
import { conversationExports, conversationFilters } from "./AiConversationsPage";
import { AnswersByQuestionView, answersQuery } from "./AnswersByQuestionPage";
import { CodebookPanel, ThreadView, feedbackText } from "./CodingMode";
import { CourseMetricsView, deltaLabel, metricCards, shadedBuckets } from "./CourseMetricsPage";
import { DigestView, itemLabel, parseTopicRules } from "./DigestView";
import { EventContent, eventLabel } from "./EventContent";
import type { AnalyticsTable, Course, CourseMetrics, StudentTimeline, TimeRange } from "../../types";

/* INSIGHTS-14 (labels §10), -07/-09 (metric cards), -16 (generated exercises), -22 (thread tools), -23 (exports). */

const COURSE: Course = {
  title: "CSS", description: "", currentUnitId: "u3", freePracticeScope: "current_and_earlier", linked: false, updatedAt: null,
  units: [{ id: "u3", title: "03 · Wrangling", goal: "", status: "current", access: "default", effectiveAccess: "open", week: 3, startsOn: null,
    runtime: { packages: [], datasetFileIds: [], timeoutSeconds: 12, errorHints: [] } }],
};
const RANGE: TimeRange = { preset: "this_week", effectivePreset: "this_week", from: "a", to: "b", compareFrom: "c", compareTo: "d", label: "This week (since Mon 10/19)", compareLabel: "vs last week" };
const TABLE: AnalyticsTable = {
  rows: [{ id: "s1", studentId: "s1", studentName: "Ada Chen", label: "Ada Chen", lastActive: null, interactions: 3, attempts: 2, checked: 2, correct: 1, codeRuns: 4,
    codeErrors: 1, codeSuccesses: 2, aiQuestions: 1, students: 1, sessions: 0, accuracy: 50, averageAttempts: 2, averageQuestions: 1, serverAccuracy: 50, missingWork: 1 }],
  total: 1, page: 1, pageSize: 25, population: { enrolled: 5, active: 2 },
};
const names = { course: COURSE, assignments: [], groups: [] };
const explorer = (group: "students" | "questions" | "question-activities", preset: "teaching" | "research") =>
  renderToStaticMarkup(
    <ActivityExplorerView course={COURSE} group={group} values={{}} preset={preset} data={TABLE} loading={false} names={names} permissions={ROLE_PERMISSIONS.instructor}
      selected={new Set()} onSelect={() => {}} patch={() => {}} onDetails={() => {}} onAnswers={() => {}} onAddFilter={() => {}} />,
  );

describe("Activity explorer markup", () => {
  it("uses the final names, one chip row and a pinned See details column", () => {
    const html = explorer("students", "teaching");
    for (const text of ["See details", "Question activities", "Auto-checked accuracy (your questions)", "AI tutor questions (incl. hints)", "Lecture reading", "+ Filter", "2 active of 5 enrolled"])
      expect(html).toContain(text);
    expect(html).toContain('class="pinned-col"');
    expect(html).toContain('class="data-table sticky-head"');
    expect(html).not.toContain("Run result not recorded");
    expect(html).not.toContain("Study sessions");
    expect(html).toContain('aria-label="Select Ada Chen"');
    expect(html).not.toContain('class="eyebrow"');
    expect(html).not.toContain("<select");
  });
  it("shows Research columns and the Study sessions group in the Research preset", () => {
    const html = explorer("students", "research");
    expect(html).toContain("Run result not recorded");
    expect(html).toContain("Legacy auto-check (v0.5 rules)");
    expect(html).toContain("Study sessions");
  });
  it("shows the default Origin chip on Questions", () => {
    expect(explorer("questions", "teaching")).toContain("Origin: Your questions");
  });
  it("states the 30-minute rule on the Question activities group only (TELEMETRY-09, AU-D4-M8; INTEGRATION)", () => {
    expect(explorer("question-activities", "teaching")).toContain("events less than 30 minutes apart belong to the same activity, across browser tabs");
    expect(explorer("students", "teaching")).not.toContain("30 minutes apart");
  });
});

const METRICS: CourseMetrics = {
  range: RANGE, enrolled: 5, active: { value: 2, previous: 1, deltaPct: 100, denominator: { label: "enrolled", value: 5 } }, publishedHomework: 4, inClassExercises: 3,
  answerAttemptsPerActive: { value: 20, previous: 17, deltaPct: 18 }, loggedActionsPerActive: { value: 30, previous: null, deltaPct: null }, codeRuns: { value: 9, previous: 9, deltaPct: 0 },
  aiTutorQuestions: { value: 4, previous: 5, deltaPct: -20 }, autoCheckedAccuracy: { value: 66.7, previous: null, deltaPct: null }, similarAccuracy: { value: null, previous: null, deltaPct: null },
  thisWeekChapter: { title: "03 · Wrangling", completed: 2, total: 5 }, difficulty: [],
  sources: [{ where: "lab", linked: true, actions: 10, codeRuns: 9, aiQuestions: 4 }, { where: "kiwi", linked: false, actions: 0, codeRuns: 0, aiQuestions: 0 }],
};

describe("Course metrics markup (INSIGHTS-07/09/14)", () => {
  it("states denominators, deltas and the fixed card names", () => {
    const html = renderToStaticMarkup(<CourseMetricsView metrics={METRICS} range={RANGE} trends={{ buckets: [], outages: [] }} curve={[]} timeOnTask={[]} onOpen={() => {}} />);
    for (const text of ["Active this week: 2 of 5 enrolled", "Published homework", "4 (+3 in-class exercises)", "Answer attempts per active student",
      "per active student · 2 of 5 enrolled", "↑ 18% vs last week", "Avg. logged actions per active student", "Kiwi · Not linked to this course",
      "CSS Lab (assignments &amp; practice)", "Which chapters do students ask the AI about most?", "Which questions need more attempts?", "See details",
      "Auto-checked accuracy (your questions)", "Similar practice accuracy (AI)"])
      expect(html).toContain(text);
    expect(html).not.toContain('class="eyebrow"');
  });
  it("computes deltas, card order and outage shading", () => {
    expect(deltaLabel({ value: 4, previous: 5, deltaPct: -20 }, "vs last week")).toBe("↓ 20% vs last week");
    expect(deltaLabel({ value: 4, previous: null, deltaPct: null }, "vs last week")).toBe("");
    expect(deltaLabel({ value: 4, previous: 2, deltaPct: 100 }, null)).toBe("");
    expect(metricCards(METRICS, RANGE).find((c) => c.key === "actions")?.secondary).toBe(true);
    const buckets = [{ start: "2026-10-12T00:00:00Z", active: 1, aiQuestions: 0, attempts: 0, autoCheckedAccuracy: null, activeMinutes: 0 },
      { start: "2026-10-19T00:00:00Z", active: 1, aiQuestions: 0, attempts: 0, autoCheckedAccuracy: null, activeMinutes: 0 }];
    expect(shadedBuckets(buckets, [{ from: "2026-10-20T10:00:00Z", to: "2026-10-20T10:12:00Z", kind: "client_gap", count: 41 }])).toEqual([false, true]);
  });
});

const TIMELINE: StudentTimeline = {
  student: { studentId: "s1", studentName: "Ada Chen" },
  assignment: { id: "hw3", title: "Week 3 Homework", kind: "homework", toolPolicy: { rWorkspace: true, allowRunPredict: false, askKiwi: "hints_only", similarPractice: true } },
  status: { label: "Released 17/20", gradeStatus: "released", score: 17, maxPoints: 20 },
  events: [
    { id: "e:1", at: "2026-10-21T01:03:00Z", kind: "similar_generated", questionId: "gi-1", questionLabel: "AI item", title: "Similar exercise generated", studySessionIndex: 0,
      context: { practiceMode: "similar", assignmentId: "hw3", assignmentLabel: "Week 3 Homework", unitId: "u3" }, provenance: { where: "lab" },
      detail: { stem: "What does mean(c(1, 3)) return?", choices: ["1", "2", "3", "4"], difficulty: 2, questionType: "choice" } },
    { id: "e:2", at: "2026-10-21T01:04:00Z", kind: "ai_turn", questionId: "q1", questionLabel: "Q1", title: "AI tutor question", studySessionIndex: 0,
      context: { practiceMode: "homework", assignmentId: "hw3", assignmentLabel: "Week 3 Homework", unitId: "u3" },
      provenance: { where: "lab", ai: "Lab AI tutor", policyLabel: "Ch 03 rules v4", model: "gpt-5.4-mini", aiCallId: 7 }, detail: { prompt: "Why?", response: "Check the keys." } },
    { id: "g:1", at: "2026-10-21T03:00:00Z", kind: "grade_released", questionId: null, questionLabel: "", title: "Released 17/20", studySessionIndex: 1,
      context: { practiceMode: "homework", assignmentId: "hw3", assignmentLabel: "Week 3 Homework", unitId: "u3" }, provenance: { where: "lab" }, detail: { actorLabel: "Instructor (local key)" } },
  ],
  nextCursor: null, hasMore: false,
};

describe("Timeline markup (INSIGHTS-06/08/16)", () => {
  it("renders generated exercises with stem and choices, provenance and study sessions", () => {
    const html = renderToStaticMarkup(<TimelineView timeline={TIMELINE} canGrade loading={false} onLoadMore={() => {}} />);
    for (const text of ["Similar exercise generated", "Open exercise", "What does mean(c(1, 3)) return?", "<li>4</li>", "Multiple choice · 2 · Apply one function",
      "Lab AI tutor · Ch 03 rules v4 · gpt-5.4-mini", "Released 17/20", "Study session 1", "Study session 2", "Open in grading"])
      expect(html).toContain(text);
    expect(html).not.toContain("Student question");
    expect(html).not.toMatch(/\bKiwi AI\b/);
  });
  it("hides grading links for a viewer", () => {
    expect(renderToStaticMarkup(<TimelineView timeline={TIMELINE} canGrade={false} loading={false} onLoadMore={() => {}} />)).not.toContain("Open in grading");
  });
  it("never labels a generated exercise as a student question (INSIGHTS-16)", () => {
    const payload = { itemId: "gi-1", origin: "similar", prompt: "What does mean(c(1, 3)) return?", choices: ["1", "2"], difficulty: 3, type: "choice" };
    expect(eventLabel("question_generated", payload)).toBe("Similar exercise generated");
    expect(eventLabel("question_generated", { ...payload, origin: "free" })).toBe("Practice exercise generated");
    const html = renderToStaticMarkup(<EventContent payload={payload} type="question_generated" />);
    expect(html).toContain("Exercise:");
    expect(html).toContain("3 · Combine two steps");
    expect(html).not.toContain("Student question");
    expect(renderToStaticMarkup(<EventContent payload={{ prompt: "Why NA?", response: "Use na.rm", aiProvider: "openai" }} type="ai_question" />)).toContain("Lab AI tutor");
    expect(renderToStaticMarkup(<EventContent payload={{ prompt: "Why NA?", response: "Use na.rm", source: "kiwi" }} type="ai_question" />)).toContain("Kiwi lecture AI");
  });
});

describe("AI conversations markup (INSIGHTS-05/22)", () => {
  const thread = {
    summary: { threadKey: "lab:s1:t1", where: "lab" as const, studentId: "s1", studentName: "Ada Chen", unitId: "u3", assignmentLabel: "HW3 Q1", turns: 2, firstAt: "a", lastAt: "b", codes: [], flagged: true },
    turns: [
      { chatTurnId: 5, nativeEventId: null, aiCallId: 9, at: "2026-10-21T01:00:00Z", prompt: "Final answer?", response: "Try joining on id.",
        provenance: { where: "lab" as const, ai: "Lab AI tutor" as const, policyLabel: "Ch 03 rules v4" }, guard: "redacted" as const, flagged: true, flagSource: "guard" as const,
        flagUpdatedBy: null, legacyClientRecord: false, feedback: [], codes: [] },
      { chatTurnId: null, nativeEventId: 11, aiCallId: null, at: "2026-10-21T01:05:00Z", prompt: "What is a tibble?", response: "A data frame.",
        provenance: { where: "lab" as const }, guard: "not_applicable" as const, flagged: false, flagSource: "" as const, flagUpdatedBy: null, legacyClientRecord: true,
        feedback: [{ value: 1, reply: null, at: "2026-10-21T01:06:00Z" }], codes: [] },
    ],
  };
  it("offers original reply, instructions sent, Clear flag and the legacy badge", () => {
    const html = renderToStaticMarkup(
      <ThreadView classId="c" thread={thread} codebook={[{ id: "c1", label: "Asks for answer", description: "", color: "warning", archived: false }]} permissions={ROLE_PERMISSIONS.ta}
        onAddCode={() => {}} onRemoveCode={() => {}} onClearFlag={() => {}} />,
    );
    for (const text of ["Show original reply (staff only)", "Show instructions sent", "Clear flag", "Legacy client record", "Guard: final answer redacted", "Flagged by the guard",
      "Lab AI tutor · Ch 03 rules v4", "Thumbs up", "+ Code", "Export"])
      expect(html).toContain(text);
    // INTEGRATION wiring: a thread links to the student's profile and full timeline.
    expect(html).toContain('href="/teacher/students/s/s1"');
    expect(html).toContain('href="/teacher/students/s/s1/timeline"');
    const viewer = renderToStaticMarkup(
      <ThreadView classId="c" thread={thread} codebook={[]} permissions={ROLE_PERMISSIONS.viewer} onAddCode={() => {}} onRemoveCode={() => {}} onClearFlag={() => {}} />,
    );
    expect(viewer).not.toContain("Clear flag");
    expect(feedbackText({ value: -1, reply: "Wrong" })).toBe("Thumbs down · Flag: “Wrong”");
  });
  it("renders the digest sections and parses topic rules", () => {
    const html = renderToStaticMarkup(
      <DigestView canMark onMark={() => {}} onOpen={() => {}} digest={{ range: RANGE, repeated: [{ prompt: "why does merge drop rows?", students: 3, occurrences: 4, examples: [{ threadKey: "lab:s1:t1", studentName: "Ada", at: "a" }] }],
        topics: [{ label: "Joins", turns: 4, students: 3 }], flagged: [], recent: [] }} />,
    );
    for (const text of ["Repeated by several students", "Asked by 3 students · 4 times", "Mark to re-teach", "Topics", "Replies that may contain a final answer", "Recent questions", "Open thread"])
      expect(html).toContain(text);
    // RT-03: recent rows wrap the shortened label, give it the full title and pin the action column
    const recent = renderToStaticMarkup(
      <DigestView canMark={false} onMark={() => {}} onOpen={() => {}} digest={{ range: RANGE, repeated: [], topics: [], flagged: [],
        recent: [{ threadKey: "lab:s1:t1", studentName: "Ada", prompt: "Why?", at: "2026-10-21T01:00:00Z", where: "lab",
          assignmentLabel: "Review-TeacherEval-2026… Q1", assignmentTitle: "Review-TeacherEval-2026-10-21 long title Q1" }] }} />,
    );
    expect(recent).toContain('class="data-table digest-recent-table"');
    expect(recent).toContain('<td class="digest-assignment-cell" title="Review-TeacherEval-2026-10-21 long title Q1">Review-TeacherEval-2026… Q1</td>');
    expect(recent).toContain('<th class="pinned-col">See details</th>');
    expect(recent).toMatch(/<td class="pinned-col"><button type="button" class="text-button" aria-label="Open thread: Ada: Why\?">Open thread<\/button><\/td>/);
    expect(parseTopicRules("Joins: merge, join\n\nPlots: plot")).toEqual([{ label: "Joins", keywords: ["merge", "join"] }, { label: "Plots", keywords: ["plot"] }]);
  });
  it("defaults the Chapter filter to this week's chapter and exports with the page filters", () => {
    expect(conversationFilters({}, COURSE)).toEqual({ unitId: "u3" });
    expect(conversationFilters({ unitId: "all", groupId: "g1" }, COURSE)).toEqual({ groupId: "g1" });
    const items = conversationExports({ unitId: "u3", groupId: "g1" }, { from: "a", to: "b" });
    expect(items.map((i) => i.label)).toEqual(["AI conversations (CSV)", "AI conversations (JSONL)", "Coded conversations (CSV)"]);
    expect(items[0].query).toEqual({ unitIds: "u3", groupIds: "g1", from: "a", to: "b" });
  });
  it("shows the stored reply or the instructions sent", () => {
    const detail = { id: 9, requestId: "r", action: "chat", surface: "assignment", status: "leak_redacted", errorCode: "", policyLabel: "Ch 03 rules v4", policyVersionId: 4,
      policySource: "unit", platformRulesVersion: "platform-rules-v2", model: "gpt-5.4-mini", reasoningEffort: null, promptHash: "h", developerText: "You are a tutor.",
      contextJson: {}, rawOutput: "The answer is 42.", outputTruncated: false, guard: { status: "redacted" as const, rules: ["R1"], matches: [{ rule: "R1", excerpt: "42" }] },
      homeworkMatch: null, inputTokens: 10, outputTokens: 5, latencyMs: 100, requestedAt: "a", respondedAt: "b" };
    expect(renderToStaticMarkup(<AiCallDetailView detail={detail} view="reply" />)).toContain("The answer is 42.");
    expect(renderToStaticMarkup(<AiCallDetailView detail={detail} view="instructions" />)).toContain("You are a tutor.");
  });
});

describe("Answers by question (INSIGHTS-04)", () => {
  it("renders one table per question with correct / incorrect / not auto-checked", () => {
    const html = renderToStaticMarkup(
      <AnswersByQuestionView data={{ questions: [
        { questionId: "q1", label: "HW2 Q1", origin: "teacher", prompt: "Code", totalAttempts: 3, hasMore: false, answers: [{ answer: "mean(x)", attempts: 2, students: 2, correct: 2, incorrect: 0, unchecked: 0, share: 66.7 }] },
        { questionId: "q2", label: "HW2 Q2", origin: "teacher", prompt: "Explain", totalAttempts: 3, hasMore: false, answers: [{ answer: "A missing value", attempts: 3, students: 3, correct: 0, incorrect: 0, unchecked: 3, share: 100 }] },
      ] }} />,
    );
    expect(html.match(/<table/g)).toHaveLength(2);
    for (const text of ["HW2 Q1", "HW2 Q2", "Not auto-checked", "Correct", "Incorrect", "Your questions"]) expect(html).toContain(text);
    expect(answersQuery({ assignmentId: "hw2", group: "x" }, { from: "a" })).toEqual({ assignmentId: "hw2", from: "a" });
    expect(answersQuery({ unitId: "unattributed" }, {})).toBeNull();
  });
});


describe("supplementary review (SB-m06, SB-m07, SB-m14)", () => {
  const digest = {
    range: { preset: "whole_term", effectivePreset: "whole_term", from: null, to: null, compareFrom: null, compareTo: null, label: "Whole term", compareLabel: null },
    repeated: [{ prompt: "Why NA?", students: 2, occurrences: 3, examples: [{ threadKey: "lab:s1:t1", studentName: "Ada", at: "2026-10-21T00:00:00Z" }] }],
    topics: [{ label: "Joins", turns: 2, students: 2 }, { label: "Plots", turns: 1, students: 1 }],
    flagged: [], recent: [{ threadKey: "lab:s1:t1", studentName: "Ada", prompt: "Why NA?", at: "2026-10-21T00:00:00Z", where: "lab" as const, assignmentLabel: "" }],
  } as unknown as Parameters<typeof DigestView>[0]["digest"];
  it("names repeated buttons after their item and shows Marked for a marked topic", () => {
    const html = renderToStaticMarkup(<DigestView digest={digest} canMark marked={new Set(["Joins"])} onMark={() => undefined} onOpen={() => undefined} />);
    expect(html).toContain(`aria-label="${itemLabel("Mark to re-teach", "Plots")}"`);
    expect(html).not.toContain(`aria-label="${itemLabel("Mark to re-teach", "Joins")}"`);
    expect(html).toContain(">Marked</span>");
    expect(html).toContain('aria-label="Open thread: Ada: Why NA?"');
    expect(itemLabel("Open thread", "x".repeat(100)).length).toBe("Open thread: ".length + 80);
  });
  it("keeps a code's label, description and Archive apart", () => {
    const html = renderToStaticMarkup(<CodebookPanel codebook={[{ id: "c1", label: "Asks for answer", description: "(review code)", color: "warning", archived: false }]}
      onCreate={() => undefined} onArchive={() => undefined} />);
    expect(html).toContain('<span class="codebook-description"> — (review code)</span>');
    expect(html).toContain('aria-label="Archive code Asks for answer"');
  });
});
