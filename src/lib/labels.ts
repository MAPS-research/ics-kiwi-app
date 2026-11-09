import type { AiQuestionType, AssignmentKind, GradeStatus, TimePreset, WorkQuestionType } from "../types";

/*
 * Final naming table (§10). One label per concept; IDs in comments refer to the fix list.
 * Teacher side: "Lab AI tutor" (this app's AI) vs "Kiwi lecture AI" (Kiwi's native AI). Student side keeps "Ask Kiwi".
 * Frozen after FOUNDATION; label changes go through INTEGRATION.
 */

export const LABELS = {
  // core rules
  platform: "Kiwi",
  labAiTutor: "Lab AI tutor",
  kiwiLectureAi: "Kiwi lecture AI", // NM28 Kiwi native AI
  askKiwi: "Ask Kiwi", // student side
  localGuidance: "Local guidance",
  freePracticeAi: "Free practice", // NM42
  similarPracticeAi: "Similar practice", // NM42 (deviation from the fix list kept, §10)
  aiGeneratedPractice: "AI-generated practice", // F12 review page
  generatedPracticeItems: "Generated practice items", // Exports page (CR-P3)
  needsGrading: "Needs grading", // NM16
  gradedButton: "Graded ✓", // NM11/NM16, assignment-list button only
  waitingForTeacher: "Waiting for teacher", // NM16 student side

  // sidebar (FOUNDATION) — NM01, NM20
  navHome: "Home",
  navAssignments: "Assignments",
  navGrading: "Grading",
  navStudents: "Students",
  navChapters: "Chapters & AI tutor",
  navInsights: "Insights",
  navSettings: "Course settings",

  // top bar (FOUNDATION) — NM46, NM47
  findStudent: "Find a student…",
  timeLabel: "Time",
  presentationMode: "Presentation mode",
  openKiwi: "Open Kiwi",
  backToKiwi: "Back to Kiwi",
  previewAsStudent: "Preview as student",
  previewBanner: "Preview as student — your activity is marked as a test and excluded from analytics.",
  exitPreview: "Exit preview",
  signOutTeacherView: "Sign out of teacher view",
  signedInThroughKiwi: "Signed in through Kiwi",
  newActivity: "New activity",
  refresh: "Refresh",
  pageMoved: "That page moved",
  menu: "Menu",

  // Chapters & AI tutor (AIRULES) — NM02–NM07, NM43
  aiTutorRules: "AI tutor rules",
  aiTutorRulesTitle: "AI tutor rules by chapter",
  tutoringInstructions: "Instructions for Ask Kiwi (tutoring)",
  generationInstructions: "Instructions for generated practice",
  saveAsNewVersion: "Save as new version",
  maxReplyLength: "Max AI reply length (512–4,000 tokens ≈ 380–3,000 English words)",
  lowestDifficulty: "Lowest difficulty",
  highestDifficulty: "Highest difficulty",
  startingDifficulty: "Starting difficulty",
  thisWeeksChapter: "This week's chapter",
  studentAccess: "Student access",
  accessFollowsScope: "Follows free practice scope",
  accessOpen: "Open",
  accessReview: "Review only",
  accessHidden: "Hidden",
  freePracticeScope: "Free practice scope",
  opensLater: "Opens later",
  review: "Review",
  platformRules: "Platform rules (always applied)",
  testThisRule: "Test this rule",
  runSavedChecks: "Run saved checks",
  versionHistory: "Version history",
  compare: "Compare",
  restore: "Restore",

  // Assignments (ASSESS) — NM08–NM11, NM44
  studentExplanation: "Explanation for students (shown after a correct answer)",
  graderRubric: "Grading rubric (staff only — shown while grading)",
  assignmentType: "Assignment type",
  homeworkType: "Homework (graded)",
  inClassType: "In-class exercise (auto-checked, not graded)",
  homework: "Homework",
  inClassExercise: "In-class exercise",
  /** RT-02: one label and one definition for the Assignments row, Exercise results and the Gradebook in-class cell */
  firstTryCorrect: "First try correct",
  firstTryCorrectHelp:
    "Share of answered questions whose first auto-checked answer was correct (only questions still in the exercise; one count per student and question).",
  correctEventually: "Correct eventually",
  /** RT-06: in-class questions carry no points for students or the teacher */
  notGraded: "Auto-checked, not graded",
  results: "Results",
  starterAssignments: "Starter assignments from the course template",
  addStarterAssignments: "Add starter assignments",
  clearTestSubmissions: "Clear test submissions",
  startAttempt: "Start attempt",
  timeLeft: "Time left",
  overTime: "Over time",

  // Grading (GRADE) — NM12–NM19, NM25
  toGrade: "To grade",
  showLatest: "Latest attempts to grade",
  showAll: "All attempts",
  showGraded: "Graded",
  showLate: "Late",
  showFlagged: "Flagged",
  feedbackToStudent: "Feedback to student (visible after release)",
  gradebook: "Gradebook",
  missing: "Missing",
  notDueYet: "Not due yet",
  notStarted: "Not started",
  submittedUngraded: "Submitted · ungraded",
  newerAttemptUngraded: "newer attempt ungraded",
  readyToRelease: "Ready to release",
  exportMenu: "Export",
  gradesForLms: "Grades for LMS (CSV)",
  activityLog: "Activity log",
  aiConversations: "AI conversations",
  researchPackage: "Research package",
  studentAssignmentStatusCsv: "Student × assignment status (CSV)",
  codedConversationsCsv: "Coded conversations (CSV)",
  seeWorkProcess: "See work process (code, errors, AI chats)",

  // Insights (INSIGHTS) — NM21–NM41
  insights: "Insights",
  activityExplorer: "Activity explorer",
  activityExplorerHelp: "Browse activity by student, chapter, assignment, or question",
  seeDetails: "See details",
  questionActivities: "Question activities",
  questionActivity: "Question activity",
  studentAssignmentTimeline: "Student × assignment timeline",
  fullActivityTimeline: "Full activity timeline",
  similarExerciseGenerated: "Similar exercise generated",
  openExercise: "Open exercise",
  aiTutorQuestions: "Tutor requests (AI and local hints)",
  whereLabel: "Where",
  whereAll: "All",
  whereLab: "CSS Lab (assignments & practice)",
  whereKiwi: "Kiwi history (legacy)",
  kiwiNotLinked: "Kiwi · Not linked to this course",
  kiwiNotLinkedBanner: "Standalone mode — Kiwi AI in Lab requires an approved course app session.",
  howToLink: "How to link",
  dismiss: "Dismiss",
  autoCheckedAccuracy: "Auto-checked accuracy (your questions)",
  similarPracticeAccuracy: "Similar practice accuracy (AI)",
  runResultNotRecorded: "Run result not recorded",
  avgLoggedActions: "Avg. learning actions per active student",
  answerAttemptsPerActive: "Answer attempts per active student",
  codeRuns: "Code runs",
  workLabel: "Work",
  workAll: "All work",
  workFree: "Free practice only",
  workAssigned: "Assigned work only",
  questionsNeedingAttempts: "Which questions need more attempts?",
  chaptersAskedMost: "Which chapters do students ask the AI about most?",
  lectureReading: "Lecture reading",
  linkedLectureMaterials: "Linked lecture materials",
  dataHealth: "Data health",
  legacyAutoCheck: "Legacy auto-check (v0.5 rules)",
  showOriginalReply: "Show original reply (staff only)",
  showInstructionsSent: "Show instructions sent",
  clearFlag: "Clear flag",
  includeTeachingStaff: "Include teaching staff",

  // Home (INSIGHTS)
  needsYourAction: "Needs your action",
  studentsNeedingAttention: "Students needing attention",
  whatToReteach: "What to re-teach (your questions only)",
  whatStudentsAsked: "What students asked the tutor",
  thisWeekAtAGlance: "This week at a glance",
  markToReteach: "Mark to re-teach",

  // People (PEOPLE) — NM24, NM46
  // B-m01 (§13.9): two named stamps instead of one "activity"
  lastSeen: "Last seen",
  lastSeenHelp: "Last seen: the newest event of any kind from this student, page views and time on a page included.",
  lastLearningAction: "Last learning action",
  learningActionsHelp: "Learning actions are answers, code runs, Tutor requests and submissions.",
  activeHelp: "Active: enrolled students with at least one learning action (an answer, code run, AI question or submission) in this period.",
  noLearningActions: "No learning actions",
  // D8: a homework and its revisions count once
  missingWork: "Missing work",
  missingWorkHelp:
    "Past-due homework with no submission. A homework and its revisions count once: a submission to any version counts, and an unsubmitted homework is counted on its newest version.",
  activitiesRecorded: "Activities recorded",
  openProfile: "Open profile",
  // K-m05: short notes printed under the roster headers (the full definitions sit above the table)
  lastSeenNote: "any event",
  missingWorkNote: "revisions count once",
  researchConsent: "Research consent",
  excludeFromAnalytics: "Exclude from analytics",
  exportStudentConversations: "Export this student's AI conversations",
  downloadCaseFile: "Download case file",
  createGroupFromSelected: "Create group from selected",
  assignWorkToSelected: "Assign work to selected",
  useAsAiReference: "Use as AI reference (text, ≤ 8,000 chars)",

  // time ranges (§13.0)
  thisClass: "This class",
  vsLastWeek: "vs last week",
  vsPreviousPeriod: "vs previous period",
} as const;

/** Student-side labels (NM42). */
export const STUDENT_LABELS = {
  navAssignments: "Assigned work",
  navPractice: "Practice exercises",
  navWorkspace: "R workspace",
  navAskKiwi: "Ask Kiwi",
  navCourse: "Course outline",
  trySimilarQuestion: "Try a similar question",
  waitingForTeacher: "Waiting for teacher",
} as const;

/** Difficulty options with the default rubric (NM06). */
export const DIFFICULTY_OPTIONS: Readonly<Record<1 | 2 | 3 | 4 | 5, string>> = {
  1: "1 · One-step recall",
  2: "2 · Apply one function",
  3: "3 · Combine two steps",
  4: "4 · Debug or adapt code",
  5: "5 · Multi-step task combining chapter skills",
};

export const TIME_PRESET_LABELS: Readonly<Record<TimePreset, string>> = {
  this_class: "This class",
  since_last_class: "Since last class",
  this_week: "This week",
  last_7_days: "Last 7 days",
  whole_term: "Whole term",
  custom: "Custom…",
};

// ─── Builders ──────────────────────────────────────────────────────────────────────────────────

/** "1 question", "3 questions"; irregular plurals are passed explicitly. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const QUESTION_TYPE_LABELS: Readonly<Record<WorkQuestionType | AiQuestionType, string>> = {
  choice: "Multiple choice",
  fill: "Fill in the blank",
  predict: "Predict output",
  complete: "Complete code",
  explain: "Explain in words",
  text: "Written response",
};
export function questionTypeLabel(type: WorkQuestionType | AiQuestionType): string {
  return QUESTION_TYPE_LABELS[type] ?? type;
}
/** Accessible checkbox names in the rules editor (NM07). */
export function allowTypeLabel(type: AiQuestionType): string {
  return `Allow ${questionTypeLabel(type)}`;
}

export function assignmentKindLabel(kind: AssignmentKind): string {
  return kind === "homework" ? LABELS.homework : LABELS.inClassExercise;
}
/** "In-class exercise · 1 question" (NM10). */
export function assignmentKindMeta(kind: AssignmentKind, questionCount: number): string {
  return `${assignmentKindLabel(kind)} · ${pluralize(questionCount, "question")}`;
}

/** "To grade (12)" (NM12), "Release (12)". */
export function countLabel(label: string, count: number): string {
  return `${label} (${count})`;
}

const fmtScore = (value: number) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100));
/** Grade states on cards, gradebook cells and timelines (NM16): Needs grading → Draft 17/20 → Released 17/20. */
export function gradeStateLabel(status: GradeStatus, score: number | null, maxPoints: number): string {
  if (status === "ungraded" || score === null) return LABELS.needsGrading;
  const value = `${fmtScore(score)}/${fmtScore(maxPoints)}`;
  return status === "draft" ? `Draft ${value}` : `Released ${value}`;
}

/** "Homework submission · Attempt 1" (NM26). */
export function homeworkSubmissionTitle(attempt: number): string {
  return `Homework submission · Attempt ${attempt}`;
}

/** "Published homework (+3 in-class exercises)" (NM35). */
export function publishedHomeworkLabel(inClassExercises: number): string {
  return `Published homework (+${pluralize(inClassExercises, "in-class exercise")})`;
}

const ACTIVE_LABELS: Readonly<Record<TimePreset, string>> = {
  this_class: "Active this class",
  since_last_class: "Active since last class",
  this_week: "Active this week",
  last_7_days: "Active in the last 7 days",
  whole_term: "Active this term",
  custom: "Active in this period",
};
/**
 * "Active this week: 1 of 2 (learning actions)" — the label follows the time range (NM39). K-m01: active means at least
 * one learning action (answer, code run, AI question, submission), the definition of *Last learning action* and the
 * *No learning actions* rule; Home's glance and Course metrics share this one label. `note` joins the parentheses
 * ("learning actions; +6 vs last wk").
 */
export function activeOfEnrolledLabel(preset: TimePreset, active: number, enrolled: number, note = ""): string {
  return `${ACTIVE_LABELS[preset]}: ${active} of ${enrolled} (learning actions${note ? `; ${note}` : ""})`;
}

/** "This week's chapter: 03 (2 of 5 completed)" (NM38). */
export function thisWeeksChapterLabel(chapterNumber: number, completed: number, total: number): string {
  return `${LABELS.thisWeeksChapter}: ${String(chapterNumber).padStart(2, "0")} (${completed} of ${total} completed)`;
}

/** B-m01: "Last learning action: 11 days ago" — `relative` is a formatted time, "" when there is none. */
export function lastLearningActionText(relative: string): string {
  return `${LABELS.lastLearningAction}: ${relative || "none yet"}`;
}

/** D8 tooltip of a missing revision: "New version of Files HW — the homework and its revisions count once." */
export function revisionOfNote(originalTitle: string): string {
  return `New version of ${originalTitle} — the homework and its revisions count once.`;
}

/** D8 tooltip of a Missing work count: "Files HW — revision (new version of Files HW) · Older homework" ("" when none). */
export function missingWorkTooltip(items: readonly { title: string; originalTitle: string | null }[]): string {
  return items.map(missingItemText).join(" · ");
}

/** One missing homework as listed under the roster count (K-m05): "Files HW — revision (new version of Files HW)". */
export function missingItemText(item: { title: string; originalTitle: string | null }): string {
  return item.originalTitle ? `${item.title} (new version of ${item.originalTitle})` : item.title;
}

/** K-m04: a repeated row action names its row ("Open profile for Ada Chen"); the visible text stays first (label in name). */
export function rowActionLabel(action: string, row: string): string {
  return `${action} for ${row}`;
}

/** Placeholder text for pages a workstream will build (§16.1 item 12). */
export function comingSoonLabel(owner: string): string {
  return `Coming in v0.6.0 — owned by ${owner}`;
}
