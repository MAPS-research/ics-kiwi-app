import type { AiQuestionType, AssignmentKind, GradeStatus, TimePreset, WorkQuestionType } from "../types";

/*
 * Final naming table (§10). One label per concept; IDs in comments refer to the fix list.
 * Teacher side: "Lab AI tutor" (this app's AI) vs "Kiwi lecture AI" (Kiwi's native AI). Student side keeps "Ask Kiwi".
 * Frozen after FOUNDATION; label changes go through INTEGRATION.
 */

export const LABELS = {
  // core rules
  platform: "Kiwi",
  labAiTutor: "Lab AI tutor", // NM28 teacher side
  kiwiLectureAi: "Kiwi lecture AI", // NM28 Kiwi native AI
  askKiwi: "Ask Kiwi", // student side
  localGuidance: "Local guidance",
  freePracticeAi: "Free practice (AI)", // NM42
  similarPracticeAi: "Similar practice (AI)", // NM42 (deviation from the fix list kept, §10)
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
  aiTutorQuestions: "AI tutor questions (incl. hints)",
  whereLabel: "Where",
  whereAll: "All",
  whereLab: "CSS Lab (assignments & practice)",
  whereKiwi: "Kiwi lectures & scratchpad",
  kiwiNotLinked: "Kiwi · Not linked to this course",
  kiwiNotLinkedBanner: "Kiwi not linked — lecture reading and Kiwi lecture AI chats won't appear.",
  howToLink: "How to link",
  dismiss: "Dismiss",
  autoCheckedAccuracy: "Auto-checked accuracy (your questions)",
  similarPracticeAccuracy: "Similar practice accuracy (AI)",
  runResultNotRecorded: "Run result not recorded",
  avgLoggedActions: "Avg. logged actions per active student",
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
  whatStudentsAsked: "What students asked the AI",
  thisWeekAtAGlance: "This week at a glance",
  markToReteach: "Mark to re-teach",

  // People (PEOPLE) — NM24, NM46
  activitiesRecorded: "Activities recorded",
  openProfile: "Open profile",
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
  navPractice: "Practice with AI",
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
/** "Active this week: 1 of 2 enrolled" — the label follows the time range (NM39). */
export function activeOfEnrolledLabel(preset: TimePreset, active: number, enrolled: number): string {
  return `${ACTIVE_LABELS[preset]}: ${active} of ${enrolled} enrolled`;
}

/** "This week's chapter: 03 (2 of 5 completed)" (NM38). */
export function thisWeeksChapterLabel(chapterNumber: number, completed: number, total: number): string {
  return `${LABELS.thisWeeksChapter}: ${String(chapterNumber).padStart(2, "0")} (${completed} of ${total} completed)`;
}

/** Placeholder text for pages a workstream will build (§16.1 item 12). */
export function comingSoonLabel(owner: string): string {
  return `Coming in v0.6.0 — owned by ${owner}`;
}
