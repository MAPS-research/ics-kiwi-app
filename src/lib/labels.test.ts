import { describe, expect, it } from "vitest";
import {
  activeOfEnrolledLabel,
  allowTypeLabel,
  assignmentKindMeta,
  countLabel,
  DIFFICULTY_OPTIONS,
  gradeStateLabel,
  homeworkSubmissionTitle,
  LABELS,
  pluralize,
  publishedHomeworkLabel,
  questionTypeLabel,
  STUDENT_LABELS,
  thisWeeksChapterLabel,
} from "./labels";
import { studentNavItems } from "../student/StudentApp";

describe("naming table constants (§10, FOUNDATION-09)", () => {
  it("defines the teacher AI practice and review labels", () => {
    expect(LABELS.freePracticeAi).toBe("Free practice (AI)");
    expect(LABELS.similarPracticeAi).toBe("Similar practice (AI)");
    expect(LABELS.aiGeneratedPractice).toBe("AI-generated practice");
    expect(LABELS.labAiTutor).toBe("Lab AI tutor");
    expect(LABELS.kiwiLectureAi).toBe("Kiwi lecture AI");
  });
  it("defines grade states Needs grading / Draft n/m / Released n/m", () => {
    expect(gradeStateLabel("ungraded", null, 20)).toBe("Needs grading");
    expect(gradeStateLabel("draft", 17, 20)).toBe("Draft 17/20");
    expect(gradeStateLabel("released", 17, 20)).toBe("Released 17/20");
    expect(gradeStateLabel("released", 16.5, 20)).toBe("Released 16.5/20");
    expect(LABELS.gradedButton).toBe("Graded ✓");
  });
  it("defines the student labels and uses Practice with AI in the student nav", () => {
    expect(STUDENT_LABELS.navPractice).toBe("Practice with AI");
    expect(STUDENT_LABELS.trySimilarQuestion).toBe("Try a similar question");
    expect(STUDENT_LABELS.waitingForTeacher).toBe("Waiting for teacher");
    const nav = studentNavItems("/student").map((item) => item.label);
    expect(nav).toContain("Practice with AI");
    expect(nav).not.toContain("Guided practice");
  });
  it("never uses the rejected teacher label Similar question (AI)", () => {
    const snapshot = JSON.stringify({ LABELS, STUDENT_LABELS, DIFFICULTY_OPTIONS });
    expect(snapshot).not.toContain("Similar question (AI)");
    expect(snapshot).toMatchSnapshot();
  });
  it("keeps the sidebar names of §3.1", () => {
    expect([LABELS.navHome, LABELS.navAssignments, LABELS.navGrading, LABELS.navStudents, LABELS.navChapters, LABELS.navInsights, LABELS.navSettings])
      .toEqual(["Home", "Assignments", "Grading", "Students", "Chapters & AI tutor", "Insights", "Course settings"]);
    expect(LABELS.previewAsStudent).toBe("Preview as student");
    expect(LABELS.signOutTeacherView).toBe("Sign out of teacher view");
  });
});

describe("label builders", () => {
  it("pluralizes counts", () => {
    expect(pluralize(1, "question")).toBe("1 question");
    expect(pluralize(0, "question")).toBe("0 questions");
    expect(pluralize(3, "submission")).toBe("3 submissions");
    expect(pluralize(2, "child", "children")).toBe("2 children");
  });
  it("labels question types and accessible checkbox names", () => {
    expect(questionTypeLabel("choice")).toBe("Multiple choice");
    expect(questionTypeLabel("text")).toBe("Written response");
    expect(questionTypeLabel("explain")).toBe("Explain in words");
    expect(allowTypeLabel("choice")).toBe("Allow Multiple choice");
    expect(allowTypeLabel("fill")).toBe("Allow Fill in the blank");
    expect(allowTypeLabel("predict")).toBe("Allow Predict output");
    expect(allowTypeLabel("complete")).toBe("Allow Complete code");
    expect(allowTypeLabel("explain")).toBe("Allow Explain in words");
  });
  it("builds list, metric and session labels", () => {
    expect(assignmentKindMeta("practice", 1)).toBe("In-class exercise · 1 question");
    expect(assignmentKindMeta("homework", 4)).toBe("Homework · 4 questions");
    expect(countLabel(LABELS.toGrade, 12)).toBe("To grade (12)");
    expect(homeworkSubmissionTitle(1)).toBe("Homework submission · Attempt 1");
    expect(publishedHomeworkLabel(3)).toBe("Published homework (+3 in-class exercises)");
    expect(publishedHomeworkLabel(1)).toBe("Published homework (+1 in-class exercise)");
    expect(activeOfEnrolledLabel("this_week", 1, 2)).toBe("Active this week: 1 of 2 enrolled");
    expect(activeOfEnrolledLabel("since_last_class", 1, 2)).toBe("Active since last class: 1 of 2 enrolled");
    expect(thisWeeksChapterLabel(3, 2, 5)).toBe("This week's chapter: 03 (2 of 5 completed)");
  });
});
