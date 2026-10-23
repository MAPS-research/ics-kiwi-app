/*
 * Shared TypeScript types for CSS Kiwi Lab v0.6.0 (architecture spec §7, frozen after FOUNDATION).
 * JSON field names here are the single source of truth; the Python server returns the same camelCase keys.
 * Shapes marked `legacy` are verbatim v0.5.1 shapes served by the legacy endpoints of §6.9 (removed in v0.7).
 */

// ─── §7.1 Primitives & identity ────────────────────────────────────────────────────────────────

export type ISODate = string;
export type QuestionType = "fill" | "choice" | "predict" | "complete";
export type AiQuestionType = QuestionType | "explain";
export type WorkQuestionType = QuestionType | "text";
export type Difficulty = 1 | 2 | 3 | 4 | 5;
export type StaffRole = "instructor" | "ta" | "viewer" | "researcher";   // researcher: decision D3
export type ActorRole = StaffRole | "staff" | "student" | "demo" | "preview" | "unknown";
export type GroupKind = "section" | "condition" | "cohort";
export type NameMode = "names" | "pseudonyms";
export type ConsentState = "yes" | "no" | "not_asked";
export type UnitAccess = "default" | "open" | "review" | "hidden";
export type EffectiveUnitAccess = "open" | "review" | "locked" | "hidden";
export type FreePracticeScope = "current_and_earlier" | "current_only" | "all";
export type HelpLevel = "hints_only" | "explain_concepts" | "worked_examples";
export type AskKiwiMode = "off" | HelpLevel;
export type Surface = "assignment" | "similar" | "free-practice" | "workspace" | "ask-kiwi" | "course-outline" | "teacher-test";
export type PracticeMode = "homework" | "in-class" | "similar" | "free" | "workspace" | "lecture" | "kiwi" | "other" | "";
export type QuestionOrigin = "teacher" | "ai-free" | "ai-similar" | "";
export type GradeStatus = "ungraded" | "draft" | "released";
export type AssignmentKind = "practice" | "homework"; // UI: "In-class exercise" | "Homework"
export type AssignmentState = "draft" | "scheduled" | "open" | "past_due" | "closed" | "archived";
export type Permission =
  | "viewInsights" | "viewStudents" | "previewStudent" | "viewAiRules" | "viewAssignments" | "editAssignments" | "grade" | "releaseGrades"
  | "exportGrades" | "manageCourse" | "manageAiRules" | "flagItems" | "manageStudents" | "exportActivity"
  | "exportResearch" | "manageStaff" | "managePrivacy" | "deleteData" | "viewAudit" | "coursePackage";
export interface ApiErrorBody { error: string; code: string; details?: Record<string, unknown> }

export interface Me {
  kind: "kiwi" | "teacher_key" | "staff_key" | "demo" | "anonymous";
  classId: string; userId: string | null; displayName: string;
  role: StaffRole | "student" | null; permissions: Permission[];
  isStaff: boolean;                                   // true also for Kiwi staff without a Lab role (role null)
  roleSource: "kiwi" | "override" | "key" | null;     // where the Lab role came from (§5.3)
  exportsForcedPseudonymous: boolean;                 // viewer, researcher
  pseudonymsForced?: boolean;                         // researcher: every response uses pseudonyms (decision D3)
  preview: boolean; verified: boolean; classLinked: boolean; staffId: string | null;
}
export interface KiwiContext { classId: string; className?: string; userId: string; username?: string; userRole?: string }
export interface VerifiedKiwiContext extends KiwiContext {
  canTeach: boolean; canManageCourse: boolean; canViewAnalytics: boolean; staffRole?: StaffRole | null;
}
/** unchanged from v0.5.1 src/types.ts:64-93 */
export interface KiwiClient {
  ready(): Promise<KiwiContext>;
  readonly context: KiwiContext | null;
  readonly mode: "live" | "sim";
  getToken(options?: { force?: boolean }): Promise<{ accessToken: string }>;
  navigate(params: { path: string }): Promise<{ ok: boolean; error?: { message: string } }>;
  askAI(
    prompt: string,
    handlers?: {
      onChunk?: (chunk: string, full: string) => void;
      onDone?: (full: string) => void;
      onError?: (error: Error) => void;
    },
  ): Promise<string>;
  updateContext(text: string): void;
  documentChunks(params?: { cursor?: string; limit?: number }): Promise<{
    documents: { fileName: string; chunks: { text: string }[] }[];
    nextCursor: string | null;
    hasMore: boolean;
  }>;
  contextualChat(params: {
    promptId: string;
    userMessage?: string;
    contextRequest: {
      kind: "student_learning_context";
      scope: "current_user_current_class";
      include: ("recent_questions" | "weak_concepts" | "relevant_materials")[];
    };
  }): Promise<{ output: string }>;
}

// ─── §7.2 Course, chapters, schedule, time range ───────────────────────────────────────────────

export interface UnitRuntime { packages: string[]; datasetFileIds: string[]; timeoutSeconds: number; errorHints: { match: string; hint: string }[] }
export interface Unit {
  id: string; title: string; goal: string;
  status: "completed" | "current" | "upcoming";            // derived from order + currentUnitId
  access: UnitAccess; effectiveAccess: EffectiveUnitAccess;
  week: number | null; startsOn: string | null;              // YYYY-MM-DD
  runtime: UnitRuntime;
  notes?: string;                                            // S-M05: teacher-only chapter notes (template notes land here)
  // S-M05: course-template metadata (staff only, read-only in the app; PUT /api/course keeps it when a body omits it)
  rSessions?: TemplateRSession[]; pairing?: TemplatePairing; runLocally?: string[]; liveApi?: string[];
}
export interface TemplateRSession { id: string; title: string; file: string }
/** How a template paired the week with its R sessions: named in the slides, inferred, or no R session that week. */
export type TemplatePairing = "slides" | "inferred" | "none";
/** R-B01: which course view the server sent (staff: hidden chapters and staff-only fields; student: neither). */
export type CourseView = "staff" | "student";
export interface Course {
  title: string; description: string;
  currentUnitId: string;                                     // UI: "This week's chapter"
  freePracticeScope: FreePracticeScope;
  units: Unit[]; linked: boolean; updatedAt: ISODate | null;
  timeZone?: string;                                         // course time zone (CourseSettings.schedule.timezone)
  view?: CourseView;                                         // absent from a v0.5.1 server
}
export type CourseInput = Omit<Course, "linked" | "units" | "updatedAt" | "view"> & { baseUpdatedAt?: ISODate | null;
  units: (Omit<Unit, "status" | "effectiveAccess" | "rSessions" | "pairing" | "runLocally" | "liveApi">
    & Partial<Pick<Unit, "status" | "effectiveAccess">>)[];
  /** R-B01: chapters the teacher removed; a hidden chapter missing from `units` is otherwise kept by the server */
  removeUnitIds?: string[];
};
export interface ClassMeeting { weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; time: string; durationMinutes: number }   // Monday = 1, "HH:MM" course tz, 15–300 (default 90)
export interface CourseSchedule { timezone: string; meetings: ClassMeeting[]; termStart: string | null }
export type TimePreset = "this_class" | "since_last_class" | "this_week" | "last_7_days" | "whole_term" | "custom";
export interface TimeRange {
  preset: TimePreset; effectivePreset: TimePreset;           // differs when falling back (no meetings → last_7_days)
  from: ISODate | null; to: ISODate | null;                  // second-precision UTC, to exclusive (§13.0)
  compareFrom: ISODate | null; compareTo: ISODate | null;
  label: string;                                             // "Since last class (Tue 10/20)"
  compareLabel: string | null;                               // "vs last week" | "vs previous period" | null (whole term)
  note?: string;                                             // "Set class meetings in Course settings to use Since last class"
}

// ─── §7.3 Telemetry ────────────────────────────────────────────────────────────────────────────

export interface EventInput {
  eventId: string; classId: string; studentId: string; studentName: string; sessionId: string;
  type: string; questionId?: string; payload: Record<string, unknown>;
  clientTs: number; tzOffsetMin: number; seq: number; schemaVersion: 2;
  surface?: Surface; route?: string;
}
export interface AddEventResponse {
  eventId: string; status: "created" | "duplicate" | "rejected"; id?: number; createdAt?: ISODate;
  code?: string; error?: string; truncated?: Record<string, number>;
}
export interface EventRecord {
  id: number; classId: string; studentId: string; studentName: string; sessionId: string; type: string;
  questionId?: string; payload: Record<string, unknown>; createdAt: ISODate;
  receivedAt?: ISODate; source?: "lab" | "kiwi"; upstreamId?: string | null; learningSessionId?: string | null;
  practiceMode?: PracticeMode; checkedBy?: "" | "server" | "client" | "legacy_server"; actorRole?: ActorRole; isPreview?: boolean;
  truncated?: Record<string, number>;
}
export interface DataHealth {
  range: TimeRange;
  aiTurns: { serverTurns: number; withServerEvent: number; legacyClientOnly: number; mismatch: number };
  aiCalls: { total: number; ok: number; turnedAway: number; failed: number; byStatus: Record<string, number>;
    blocked?: number; other?: number;                       // review 2: course-rule refusals; pending/invalid requests
    teacherTests?: number;                                  // RV6-m06: "Test this rule" runs, not counted above
    local?: number };                                       // SB-m13: answered by local guidance (no AI), part of ok
  events: { received: number; duplicatesIgnored: number; truncated: number; clientGapsReported: number;
            clockSkewOver5Min: number; rejected: { code: string; count: number }[] };
  heartbeats: { received: number; counted: number; duplicates: number };
  identity: { unverifiedEvents: number; nonRosterIdentities: number; previewEvents: number; staffEvents: number };
  generatedItems: { total: number; verified: number; mismatch: number; rejected: number; flagged: number; local?: number };   // SB-m13: local templates
  clientReported: { aiRequestsUnreached: number; serverOwnedFromClient: number; unknownPayloadKeys: { type: string; keys: string[]; count: number }[] };
  legacyChecks: { legacyServer: number; rejudged: number; notRejudged: number };
  outages: OutagePeriod[];
  kiwi: KiwiSyncStatus & { perStudent: { studentId: string; label: string; lastImportedAt: ISODate | null; backfilled: boolean }[] };
  retentionDue: Record<string, number>;
}
export interface OutagePeriod { from: ISODate; to: ISODate; kind: "client_gap" | "server_error" | "kiwi_unreachable"; count: number;
  browsers?: number }                                        // CR-T3: distinct browsers in a client-gap period
export interface KiwiSyncStatus {
  connected: boolean; lastSynced: ISODate | null; error: string | null; hasMore: boolean; busy?: boolean;
  metadataTruncated: boolean; nativeEvents: number; imported?: number;
  excludedByDesign?: number;                                 // legacy app-ics-r-lab-* student records (counted by the bridge)
  excludedNotEnrolled?: number;                              // records of users no longer enrolled as students (not imported)
  nativeTutoringMode?: string | null;                        // effective Kiwi chat tutoringMode on Lab pages (bridge metadata pass, §15.1)
  nativeTutoringModeSource?: "app" | "class_override" | null; // ClassKiwiApp.config overrides App.config (kiwi-app.service.ts:484-489)
  materials: { id: string; title: string; unitId: string }[];
  perStudent?: { studentId: string; label: string; lastImportedAt: ISODate | null; backfilled: boolean }[];   // CR-T3 (sync response)
}

// ─── §7.4 Assignments & student work ───────────────────────────────────────────────────────────

export interface ToolPolicy { rWorkspace: boolean; allowRunPredict: boolean; askKiwi: AskKiwiMode; similarPractice: boolean }
export interface LatePolicy { mode: "not_accepted" | "accept_until" | "accept_marked"; untilAt: ISODate | null; graceMinutes: number; penaltyPctPerDay: number }
export interface GradingSettings { caseSensitive: boolean; whitespace: "outside_strings" | "collapse" | "exact"; numericTolerance: number | null; autoCheck: boolean }
export interface WorkQuestion {
  id: string; type: WorkQuestionType; prompt: string; points: number; choices: string[]; starterCode: string;
  // staff-only fields (absent in student payloads):
  answer?: string; referenceCode?: string; expectedOutput?: string; acceptedAnswers?: string[];
  grading?: GradingSettings; graderRubric?: string; tags?: string[];
  // shared:
  maxAttempts?: number | null; hints?: string[]; studentExplanation?: string;
  /** @deprecated legacy field, read-only mapping (§4.5.2) */ explanation?: string;
}
export type Audience = { type: "all" } | { type: "groups"; groupIds: string[] };   // any group kind, cohorts included
export interface FileMeta { id: string; name: string; mime: string; size: number; scope: "assignment" | "chapter"; questionId: string; unitId: string; mountInR: boolean; aiReference: boolean; createdAt: ISODate }
export interface TimeLimit { minutes: number; onExpiry: "submit_marked" | "reject" }
export type SolutionsVisibility = "never" | "after_submit" | "after_due" | "after_release";
export interface AssignmentInput {
  kind: AssignmentKind; title: string; unitId: string; instructions: string;
  dueAt: ISODate | null; openAt: ISODate | null; closeAt: ISODate | null; latePolicy: LatePolicy;
  maxAttempts: number | null; timeLimit: TimeLimit | null;   // homework only
  gradesVisibility: "immediately" | "on_release"; solutionsVisibility: SolutionsVisibility;
  toolPolicy: ToolPolicy; audience: Audience; questions: WorkQuestion[];
  retireOriginalOnPublish?: boolean;
}
export interface TeacherAssignment extends AssignmentInput {
  id: string; classId: string; status: "draft" | "published"; state: AssignmentState;
  version: number; frozen: boolean; frozenAt: ISODate | null; attemptCount: number;
  revisionOf: string | null; files: FileMeta[]; attachmentName: string | null;
  revisionOfTitle?: string | null; revisions?: AssignmentLineage["revisions"];   // S-M01
  versions: { version: number; createdAt: ISODate; reason: string }[];
  createdAt: ISODate; updatedAt: ISODate; archivedAt: ISODate | null;
}
/** legacy v0.5.1 shape (src/types.ts:106-119), returned by /api/work and /api/teacher/work-page */
export interface Assignment { id: string; classId: string; kind: AssignmentKind; title: string; unitId: string; instructions: string; dueAt: string | null; status: "draft" | "published"; questions: WorkQuestion[]; attachmentName: string | null; createdAt: string; updatedAt: string }
/** legacy */
export interface WorkPage { assignments: Assignment[]; submissions: Submission[]; options: WorkOption[]; total: number; page: number; pageSize: number }
export interface AssignmentStats {
  enrolled: number; submitted: number; startedNotSubmitted: number; toGrade: number; toRelease: number; late: number; missing: number;
  graded: number; released: number; avgScore: number | null; maxPoints: number;
  attempted: number; firstTryCorrectPct: number | null;                     // in-class exercises
  submittedOriginal?: number;                                  // S-M01: no submission here, but one on the original of this revision
}
/** S-M01: what links an original and its revisions (editor and list). */
export interface AssignmentLineage {
  revisionOfTitle?: string | null;
  revisions?: { id: string; title: string; status: "draft" | "published"; state: AssignmentState }[];
}
export interface AssignmentListItem {
  id: string; title: string; kind: AssignmentKind; unitId: string; status: "draft" | "published"; state: AssignmentState;
  questionCount: number; dueAt: ISODate | null; closeAt: ISODate | null; latePolicy: LatePolicy;
  hasAttempts: boolean; revisionOf: string | null; stats: AssignmentStats; updatedAt: ISODate;
  openAt?: ISODate | null; solutionsVisibility?: SolutionsVisibility;   // decision D2: protection line on the list
  hasPreviewRows?: boolean;                                     // CR-A3: preview rows exist → "Clear test submissions"
  revisionOfTitle?: string | null; revisions?: AssignmentLineage["revisions"];   // S-M01
}
export interface WorkOption {   // staff picker metadata (v0.5.1 fields kept)
  id: string; title: string; kind: AssignmentKind; unitId: string; status: "draft" | "published";
  questionCount: number; hasSubmissions: boolean; dueAt: ISODate | null; state?: AssignmentState;
}
export interface StudentWorkOption extends WorkOption {
  state: AssignmentState; closeAt: ISODate | null; latePolicy: LatePolicy; maxAttempts: number | null;
  myAttempts: number; myLatestStatus: "none" | "submitted" | "graded"; isPreviewDraft?: boolean;
  submittedOriginal?: { id: string; title: string } | null;   // S-M01: this is a revision of homework the student submitted
  unitTitle?: string;                                          // S-m08: chapter title even when the chapter is hidden
}
export interface StudentAssignment {
  id: string; kind: AssignmentKind; title: string; unitId: string; instructions: string;
  state: AssignmentState; dueAt: ISODate | null; closeAt: ISODate | null; latePolicy: LatePolicy; maxAttempts: number | null;
  timeLimit: TimeLimit | null; currentAttempt: { attempt: number; startedAt: ISODate; endsAt: ISODate } | null;
  toolPolicy: ToolPolicy; gradesVisibility: "immediately" | "on_release"; version: number;
  questions: WorkQuestion[]; files: FileMeta[]; attachmentName: string | null;
  submittedOriginal?: { id: string; title: string } | null;   // S-M01
  revisedAs?: { id: string; title: string } | null;           // R-m01: the published revision that replaces this one
}
export interface InClassCheckResult {
  correct: boolean | null; status?: "recorded"; attemptIndex: number; attemptsLeft: number | null;
  explanation?: string; nextHint?: string; revealedAnswer?: string;
}
export interface SubmitResult {
  id: string; assignmentId: string; attempt: number; submittedAt: ISODate; replayed?: boolean;
  late: boolean; lateSeconds: number; overTime: boolean; timeUsedSeconds: number | null; autoChecked: Record<string, boolean | null>;
}
export interface Submission {   // staff view
  id: string; assignmentId: string; studentId: string; studentName: string; attempt: number;
  answers: Record<string, string>; submittedAt: ISODate; grade: number | null; feedback: string | null;
  gradedAt: ISODate | null; gradeStatus?: GradeStatus; isLate?: boolean; lateSeconds?: number; isPreview?: boolean;
  overTime?: boolean; timeUsedSeconds?: number | null;
}
export interface StudentSubmission {
  id: string; assignmentId: string; attempt: number; submittedAt: ISODate; isLate: boolean;
  status: "waiting_for_teacher" | "released";   // UI: "Waiting for teacher"
  grade: number | null; maxPoints: number; feedback: string | null;
  items: Record<string, { score: number | null; comment: string }> | null;
  /** released adjustment such as the automatic late penalty (RV6-M01); null when none */
  adjustment?: { points: number; reason: string } | null;
  lateSeconds?: number;
}
export interface AnswerDraft { assignmentId: string; answers: Record<string, { value: string; updatedAt: ISODate }>; updatedAt: ISODate | null; assignmentVersion: number | null }
export interface AssignmentStudentStatus {
  studentId: string; studentName: string; section: string | null; condition: string | null;
  lastActive: ISODate | null; submittedAt: ISODate | null; late: boolean; attempts: number; gradeStatus: GradeStatus | null;
  draftAnswered: number; draftTotal: number; draftUpdatedAt: ISODate | null;   // "Started · 2/3 answered" when draftAnswered > 0 and no submission [DA07]
  submittedOriginal?: boolean;                                 // S-M01
}
export interface CheckResult { correct: boolean | null; scoreFraction: number | null; reason: string; basis: "answer_text" | "client_run_output"; normalizedAnswer: string }
export interface StarterAssignment { key: string; title: string; kind: AssignmentKind; sampleUnitId: string; mappedUnitId: string | null; alreadyAdded: boolean }

// ─── §7.5 Grading ──────────────────────────────────────────────────────────────────────────────

export interface ItemResult {
  questionId: string; points: number; autoCorrect: boolean | null; autoScore: number | null; autoReason: string;
  score: number | null; comment: string; overridden: boolean;
}
export interface GradeEventView { id: number; action: string; actorLabel: string; actorRole: string; totalBefore: number | null; totalAfter: number | null; statusAfter: GradeStatus | null; createdAt: ISODate }
export interface ProcessSummary {
  askKiwiMode: AskKiwiMode; aiQuestions: number; flaggedReplies: number; codeRuns: number; codeErrors: number;
  similarRequested: number; pastesFromAi: number; activeMinutes: number; timelineUrl: string;
}
export interface SubmissionDetail {
  submission: Submission; assignment: TeacherAssignment; studentLabel: string;
  items: ItemResult[]; total: number | null; maxPoints: number;
  adjustment: { points: number; reason: string; auto: boolean };
  // auto=true: pre-filled late penalty when penaltyPctPerDay > 0 and no grade saved yet:
  // points = -round(maxPoints * pct/100 * ceil(lateHours/24), 2), reason "Late penalty (auto)"; card shows "Late penalty −2 (auto) [Remove]"
  late: { lateHours: number; penaltyPctPerDay: number } | null;
  timeUsed: { seconds: number; limitMinutes: number; overTime: boolean } | null;
  history: GradeEventView[]; latestGradeEventId: number | null;
  earlierAttempts: { id: string; attempt: number; submittedAt: ISODate; gradeStatus: GradeStatus; grade: number | null }[];
  process: ProcessSummary; flags: { kind: "late" | "over_time" | "ai_final_answer" | "paste_from_ai" | "identical_answer" | "newer_attempt"; text: string; href?: string }[];
}
export interface GradeInput {
  items: Record<string, { score: number | null; comment: string }>; feedback?: string;
  adjustment?: { points: number; reason: string; auto?: boolean }; action: "save" | "release"; baseGradeEventId?: number | null;
  keepReleased?: boolean;                                      // S-B01: 409 grade_released instead of withdrawing a released grade
}
export interface GradingQueue {
  counts: { toGrade: number; late: number; flagged: number; draft: number; toRelease: number; graded: number; all: number };
  view: "student" | "question"; show: string; order: string[];
  cards: SubmissionDetail[];                                   // view=student, page of ≤ 10
  groups?: {                                                   // view=question
    normalizedAnswer: string; sampleAnswer: string; submissionIds: string[]; autoCorrect: boolean | null;
    autoScore?: number | null;                                 // S-m05: pre-fills the group's Points box
    members?: {                                                // S-B01: who is in the group and the state of each attempt
      submissionId: string; studentId: string; studentLabel: string; attempt: number; latest: boolean;
      gradeStatus: GradeStatus; grade: number | null; score: number | null; maxPoints: number | null;
    }[];
  }[];
  total: number; page: number; pageSize: number;
}
export type GradebookCellState = "not_due" | "not_submitted" | "missing" | "submitted_ungraded" | "newer_ungraded" | "draft" | "released";
export interface GradebookCell {
  assignmentId: string; state: GradebookCellState; score: number | null; maxPoints: number; attempts: number;
  late: boolean; lateSeconds: number; overTime: boolean; latestSubmissionId: string | null; scoredSubmissionId: string | null;
  draftAnswered: number; draftTotal: number;                   // from answer_drafts when no submission exists
  label: string;
  onOriginal?: boolean; originalId?: string; originalTitle?: string;   // S-M01: "Submitted the original" (state not_submitted)
  // label rules (grading_rules.cell_label): released "18/20 · 1 submission" (n submissions pluralized);
  // draft "Draft 16/20"; submitted_ungraded "Submitted · ungraded"; newer_ungraded "16/20 · newer attempt ungraded";
  // missing "Missing" or, with a draft, "Missing · started (2/3 answered)"; not_due "Not due yet" or "Not due yet · started";
  // not_submitted (no due date) "Not started" or "Started · 2/3 answered"
}
export interface Gradebook {
  policy: "latest" | "highest";
  columns: { assignmentId: string; title: string; maxPoints: number; dueAt: ISODate | null; header: string }[];   // "Week 3 HW (20 pts) · Due 10/24"
  inClassColumns: { assignmentId: string; title: string }[];
  rows: { studentId: string; studentName: string; pseudonym: string; section: string | null; condition: string | null; groups: string[]; cells: GradebookCell[];
          inClass: { assignmentId: string; completionPct: number | null; accuracyPct: number | null; correctFirstTryPct?: number | null }[];   // accuracyPct = correct eventually (RV6-M03)
          activeMinutes: number; aiQuestions: number; codeRuns: number; lastActive: ISODate | null }[];
  total: number; page: number; pageSize: number;
}
export interface ExerciseResults {
  assignment: TeacherAssignment; enrolled: number; refreshedAt: ISODate;
  questions: { questionId: string; label: string; attempted: number; correctFirstTryPct: number | null;
               correctEventuallyPct: number | null; topWrongAnswers: { answer: string; students: number }[];
               stuck: { studentId: string; studentName: string; wrongAttempts: number; lastAttemptAt: ISODate }[] }[];
  students: { studentId: string; studentName: string; correct: number; attempted: number; lastActive: ISODate | null }[];
}
/** legacy */ export interface HubStudent { studentId: string; studentName: string; scoreByAssignment: Record<string, number>; attemptsByAssignment: Record<string, number>; interactions: number; learningSeconds: number; freePracticeCount: number; codeRuns: number; aiQuestions: number; lastActive: string | null }
/** legacy */ export interface HubData { assignments: { id: string; title: string }[]; students: HubStudent[] }

// ─── §7.6 AI rules, runtime, generated items ───────────────────────────────────────────────────

export interface PolicyConfig {
  tutoringInstructions: string;          // "Instructions for Ask Kiwi (tutoring)", 0–6000
  generationInstructions: string;        // "Instructions for generated practice", 0–6000
  groundingNotes: string;                // "Reference notes for the AI", 0–4000
  helpLevel: HelpLevel;                  // "Ask Kiwi may…" (chapter default; assignments may override)
  replyLanguage: string;                 // default "English", 2–40 chars
  minDifficulty: Difficulty; maxDifficulty: Difficulty; startingDifficulty: Difficulty;
  difficultyRubric: Record<"1" | "2" | "3" | "4" | "5", string>;
  allowedTypes: AiQuestionType[]; choiceCount: 3 | 4 | 5;
  maxOutputTokens: number;               // 512–4000
  historyTurns: number;                  // 2–12, default 6
  model: string | null;                  // null = server default; must be in allowlist
  reasoningEffort: "default" | "low" | "medium" | "high";
  aiTutorEnabled: boolean; generationEnabled: boolean;
  feedback: { revealAfterAttempts: number; showExplanationOnWrong: boolean };   // 0 = never reveal
  practice: { allowFocusNote: boolean; dailyItemLimit: number;                 // 0 = unlimited
              unlockAfterCorrect: number };                                     // 0 = off; else N correct at level k-1 unlock level k (> starting) [AU-D2-15]
  contextFields: ("code" | "error" | "output" | "answer" | "instructions" | "datasets" | "materials")[];   // materials = chapter files marked "Use as AI reference"
  localGuidance: string;                 // shown when AI is not configured, ≤ 2000
}
export interface PolicyVersion {
  id: number; scope: "course" | "unit"; unitId: string; groupId: string; version: number;
  config: PolicyConfig | { inherit: true }; configHash: string; note: string; restoredFrom: number | null;
  createdBy: string; createdByRole: string; createdAt: ISODate;
}
export interface ResolvedPolicyView { config: PolicyConfig; versionId: number | null; version: number | null; source: "unit-group" | "unit" | "course-group" | "course" | "platform"; scopeLabel: string; updatedAt: ISODate | null; updatedBy: string | null }
export interface PolicyLint { severity: "warning" | "info"; field: keyof PolicyConfig | "platform"; message: string }
export interface PolicyDiff { field: string; before: unknown; after: unknown }
export interface AiRuleScope { current: PolicyVersion | null; effective: ResolvedPolicyView; lint: PolicyLint[] }
export interface AiRulesOverview {
  groups: Group[];
  courseDefault: { status: "default" | "customized"; version: number | null; updatedAt: ISODate | null };
  courseCells?: Record<string /* groupId */, AiRuleCell>;     // CR-AIRULES-2: course × group cells
  units: { unitId: string; title: string; effectiveAccess: EffectiveUnitAccess;
           cells: Record<string /* groupId or "" */, AiRuleCell> }[];
}
export interface AiRuleCell {
  status: "default" | "customized" | "inherits"; version: number | null; updatedAt: ISODate | null; updatedBy: string | null;
  inheritsFrom?: "unit" | "unit-group" | "course" | "course-group" | null;   // CR-AIRULES-2
}
export interface ChapterSummaryUnit {
  unitId: string; assignments: number; lectureMaterials: number; aiRules: AiRuleCell | null; referenced: boolean; files: FileMeta[];
  aiSeesMaterials?: boolean;   // S-M03: the chapter's AI tutor rules include "Chapter files marked Use as AI reference"
}
export interface ChapterSummary { units: ChapterSummaryUnit[]; courseDefault: AiRulesOverview["courseDefault"] }   // GET /api/teacher/chapters/summary
export interface HomeworkQuestionOption {     // GET /api/teacher/ai/rules/homework-questions (prompts only, no answers)
  assignmentId: string; assignmentTitle: string; questionId: string; label: string; type: string; prompt: string;
  status: string; protected: boolean; askKiwi: string;
}
export interface PlatformRule { id: string; title: string; text: string }
export interface AiStatus { configured: boolean; model: string | null; modelAllowlist: string[]; platformRulesVersion: string; concurrency: number; perStudentPerMinute: number; classPerMinute: number }
export interface GuardView { status: "not_applicable" | "clean" | "retried_clean" | "redacted" | "blocked"; rules: string[]; matches: { rule: string; excerpt: string }[] }
export interface AiTestRequest {
  scope: "course" | "unit"; unitId: string; groupId: string; config: PolicyConfig; action: "chat" | "question";
  sample: { prompt?: string; code?: string; error?: string; type?: AiQuestionType; difficulty?: Difficulty; assignmentId?: string; questionId?: string; injection?: boolean };
  dryRun: boolean;
}
export interface AiTestResult { messages: { role: string; content: string }[]; promptHash: string; result?: { text?: string; item?: GeneratedItemTeacher; guard: GuardView }; homeworkMatch?: { assignmentId: string; questionId: string; containment: number } | null; aiCallId?: number;
  status?: string; error?: string; policyLabel?: string }     // CR-AIRULES-2: ai_calls status of a real run, invalid item, label
export interface AiTestSample {
  id: string; unitId: string; groupId: string; label: string; action: "chat" | "question";
  sample: AiTestRequest["sample"];
  expect: { guard?: "clean" | "leak_handled"; itemValid?: boolean; homeworkMatched?: boolean };   // leak_handled = retried_clean|redacted|blocked
  createdBy: string; createdAt: ISODate;
}
export interface AiTestSampleResult {   // passed null = dry run (assembly only)
  sampleId: string; label: string; passed: boolean | null; detail: string; guard: GuardView["status"] | null; promptHash: string;
  reply?: string | null;               // S-m13: the reply (or generated item prompt) that was checked
}
export interface AiCallDetail {
  id: number; requestId: string; action: string; surface: string; status: string; errorCode: string;
  policyLabel: string; policyVersionId: number | null; policySource: string; platformRulesVersion: string;
  model: string | null; reasoningEffort: string | null; promptHash: string;
  developerText: string; contextJson: Record<string, unknown>; rawOutput: string; outputTruncated: boolean;
  guard: GuardView; homeworkMatch: { assignmentId: string; questionId: string; containment: number | null; jaccard: number | null } | null;
  inputTokens: number | null; outputTokens: number | null; latencyMs: number | null; requestedAt: ISODate; respondedAt: ISODate | null;
  // CR-AIRUN-2: fields the server already returns
  errorMessage?: string; reasoningTokens?: number | null; queueMs?: number | null; attempt?: number; parentCallId?: number | null;
  retries?: { id: number; attempt: number; status: string; rawOutput: string; guardStatus: string; developerText: string; latencyMs: number | null }[];
  isPreview?: boolean; unitId?: string; assignmentId?: string; questionId?: string; itemId?: string;
}
export interface PublicPolicy {
  unitId: string; access: EffectiveUnitAccess; accessLabel: string;     // "Opens later", "Review", ""
  minDifficulty: Difficulty; maxDifficulty: Difficulty; startingDifficulty: Difficulty; difficultyRubric: PolicyConfig["difficultyRubric"];
  allowedTypes: AiQuestionType[]; choiceCount: number; helpLevel: HelpLevel; replyLanguage: string;
  aiAvailable: boolean; aiTutorEnabled: boolean; generationEnabled: boolean;
  feedback: PolicyConfig["feedback"]; practice: PolicyConfig["practice"] & { usedToday: number; unlockedMaxDifficulty: Difficulty };
  packages: string[]; datasets: FileMeta[]; policyLabel: string;
  /** v0.5.1 compatibility */ defaultDifficulty: Difficulty; maxOutputTokens: number;
}
/** legacy v0.5.1 shape (src/types.ts:149-158) for /api/teacher/policies */
export interface GenerationPolicy { unitId?: string; systemPrompt?: string; minDifficulty: Difficulty; maxDifficulty: Difficulty; defaultDifficulty: Difficulty; allowedTypes: QuestionType[]; maxOutputTokens: number; aiAvailable?: boolean; isCustomized?: boolean; updatedAt?: ISODate | null }
export interface ChatRequest {
  studentId: string; unitId: string; threadId: string; prompt: string; surface: Surface;
  assignmentId?: string; questionId?: string; itemId?: string; code?: string; runOutput?: string; error?: string; answerDraft?: string;
}
export interface ChatResponse { response: string; source: "lab-ai" | "local"; chatTurnId: number; aiCallId: number | null; policyLabel: string; guard: { status: GuardView["status"] }; flagged: boolean;
  helpLevel?: AskKiwiMode }                                  // CR-AIRUN-2
export interface ChatTurnView { id: number; prompt: string; response: string; createdAt: ISODate; source: "lab-ai" | "local"; policyLabel: string; flagged: boolean; guardStatus: GuardView["status"] }
export interface GeneratedItemPublic {
  id: string; origin: "free" | "similar"; unitId: string; type: AiQuestionType; difficulty: Difficulty;
  title: string; prompt: string; code?: string; starterCode?: string; choices?: string[];
  source: "ai" | "local_template" | "teacher_bank"; policyLabel: string; needsVerification: boolean;
}
/** legacy v0.5.1 shape (src/types.ts:18-33) used by moved practice code until AIRUN switches to GeneratedItemPublic */
export interface Question { id: string; type: QuestionType; difficulty: Difficulty; unitId: string; title: string; prompt: string; code?: string; choices?: string[]; answer: string; acceptedAnswers?: string[]; explanation: string; starterCode?: string; expectedOutput?: string; source: "kiwi-ai" | "local" }
export interface ItemCheckResult {
  correct: boolean | null; attemptIndex: number; explanation?: string;
  explanationWithheld: boolean;          // homework-derived item while the homework is protected: "The explanation is shown after the homework closes."
  canReveal: boolean; revealedAnswer?: string;
  verification?: "verified" | "mismatch" | "unverified";   // only after the first check; mismatch → "This exercise failed an automatic check; its answer key may be wrong."
  feedback?: string | null;          // CR-AIRUN-2: AI feedback on explain items (AIRUN-14)
  verificationNotice?: string;       // shown with verification === "mismatch"
  withheldMessage?: string;          // "The explanation is shown after the homework closes."
}
/** GET /api/practice/status (AIRUN, additive; CR-AIRUN-2/3) */
export interface PracticeStatus { unitId: string; usedToday: number; dailyItemLimit: number; unlockAfterCorrect: number; startingDifficulty: number;
  unlockedMaxDifficulty: number; effectiveAccess?: EffectiveUnitAccess; policyLabel?: string }
export interface GeneratedItemTeacher {
  id: string; origin: "free" | "similar" | "teacher_test"; studentId: string; studentName: string;
  unitId: string; relatedAssignmentId: string; relatedQuestionId: string; questionType: string; difficulty: number;
  requestedType: string; requestedDifficulty: number; focusNote: string;
  item: { title: string; prompt: string; code?: string; starterCode?: string; choices?: string[]; answer: string; acceptedAnswers?: string[]; expectedOutput?: string; explanation: string; rubric?: string };
  source: "ai" | "local_template" | "teacher_bank"; model: string | null; policyVersionId: number | null; policyLabel: string;
  noveltyRetries: number; guardStatus: string; verification: string; clientRunOutput: string; status: string; flagNote: string;
  homeworkMatch: { assignmentId: string; questionId: string; containment: number } | null;
  aiCallId: number | null; attempts: number; correctAttempts: number; createdAt: ISODate;
  flaggedBy?: string | null; flaggedAt?: ISODate | null; retiredBy?: string | null; retiredAt?: ISODate | null; isPreview?: boolean;   // CR-AIRUN-2
}

// ─── §7.7 Insights ─────────────────────────────────────────────────────────────────────────────

export interface AttentionRule { id: "no_activity" | "missing_work" | "stuck_question" | "repeated_ai_help" | "low_accuracy" | "late_pattern"; enabled: boolean; params: Record<string, number> }
export interface AttentionRules { rules: AttentionRule[] }
export interface AttentionItem { studentId: string; studentName: string; reasons: { rule: AttentionRule["id"]; text: string; href: string; at: ISODate | null }[] }
export interface ReteachCandidate { assignmentId: string; questionId: string; label: string; prompt: string; students: number; firstTryCorrectPct: number | null; meanTriesToCorrect: number | null; meanScorePct: number | null; marked: boolean }
export interface ReteachMark { id: number; targetKind: "question" | "item_group" | "ai_prompt" | "topic"; assignmentId: string; questionId: string; unitId: string; chatTurnId: number | null; label: string; note: string; createdBy: string; createdAt: ISODate; resolvedAt: ISODate | null }
export interface HomeData {
  range: TimeRange;
  header: { courseTitle: string; thisWeek: { unitId: string; title: string; index: number; total: number }; freePracticeLabel: string;
            aiRules: { unitId: string; label: string; customized: boolean; updatedAt: ISODate | null }; aiStatus: AiStatus; kiwi: { linked: boolean; lastSynced: ISODate | null } };
  needsAction: { toGrade: number; toRelease: { assignmentId: string; title: string; count: number }[];
                 missingPastDue: { assignmentId: string; title: string; count: number; started: number }[];   // "Missing · Week 3 HW 5 (2 started)"
                 late: number; flaggedReplies: number | null };
  assignments: AssignmentListItem[];                        // due soon + recently closed (≤ 6)
  attention: { students: AttentionItem[]; total: number; rules?: string[] };   // CR-I1: enabled rule texts for the "rules (i)" popover
  reteach: { candidates: ReteachCandidate[]; marked: ReteachMark[] };
  askedAi: { repeated: { prompt: string; students: number; occurrences: number; threadKeys: string[] }[]; topics: { label: string; count: number }[]; flaggedFinalAnswer: number };
  glance: { activeStudents: Metric; enrolled: number; aiQuestions: Metric; codeRuns: Metric; freePracticeItems: Metric; aiTurnedAway: Metric };
}
export interface Metric { value: number | null; previous: number | null; deltaPct: number | null; denominator?: { label: string; value: number } }
export interface CourseMetrics {
  range: TimeRange; enrolled: number; active: Metric;
  publishedHomework: number; inClassExercises: number;            // "Published homework (+3 in-class exercises)"
  answerAttemptsPerActive: Metric; loggedActionsPerActive: Metric; codeRuns: Metric; aiTutorQuestions: Metric;
  autoCheckedAccuracy: Metric; similarAccuracy: Metric; thisWeekChapter: { title: string; number?: number; completed: number; total: number };
  sources: { where: "lab" | "kiwi"; linked: boolean; actions: number; codeRuns: number; aiQuestions: number }[];
  difficulty: { level: number; nominal: number; items: number; observedCorrectPct: number | null }[];
}
export interface TrendBucket { start: ISODate; active: number; aiQuestions: number; attempts: number; autoCheckedAccuracy: number | null; activeMinutes: number }
export interface AnalyticsRow {   // v0.5.1 fields kept; v0.6.0 additions
  source?: "lab" | "kiwi"; materialId?: string; id?: string; label?: string; title?: string; studentId?: string; studentName?: string;
  unitId?: string; assignmentId?: string; questionId?: string; kind?: string; startedAt?: string; lastActive: string | null;
  interactions: number; attempts: number; checked: number; correct: number; codeRuns: number; codeErrors: number; codeSuccesses: number;
  aiQuestions: number; students: number; sessions: number; accuracy: number | null; averageAttempts: number; averageQuestions: number;
  practiceMode?: PracticeMode; origin?: QuestionOrigin; actions?: number; activeMinutes?: number;
  serverAccuracy?: number | null; similarAccuracy?: number | null; clientAccuracy?: number | null; homeworkAvgScorePct?: number | null;
  legacyAccuracy?: number | null;                            // "Legacy auto-check (v0.5 rules)", Research preset only
  firstTryCorrectPct?: number | null; missingWork?: number; views?: number; result?: string;
  questionType?: string; difficulty?: number | null; policyVersionId?: number | null; groupNames?: string[]; tags?: string[];
  aiItemGroup?: { unitId: string; origin: QuestionOrigin; questionType: string; items: number } | null;
  disambiguation?: string;                                   // "· HW3 Q2"
  submitted?: number | null; runResultNotRecorded?: number; kiwiAiQuestions?: number; chapterLabel?: string;   // CR-I3 (v2 explorer)
}
export interface AnalyticsTable { rows: AnalyticsRow[]; total: number; page: number; pageSize: number; population?: { enrolled: number; active: number } }
export interface AnswersByQuestion {
  questions: { questionId: string; label: string; origin: QuestionOrigin; prompt: string; totalAttempts: number;
               answers: { answer: string; attempts: number; students: number; correct: number; incorrect: number; unchecked: number; share: number }[]; hasMore: boolean }[];
}
export interface TimelineEvent {
  id: string; at: ISODate; kind: "question_viewed" | "code_run" | "code_edited" | "answer_draft" | "answer_attempt" | "ai_turn" | "ai_failed"
    | "ai_feedback" | "similar_generated" | "practice_generated" | "item_check" | "attempt_started" | "submission" | "grade" | "grade_released"
    | "hint_shown" | "paste" | "material_viewed" | "other";
  questionId: string | null; questionLabel: string; title: string;
  context: { practiceMode: PracticeMode; assignmentId: string | null; assignmentLabel: string | null; unitId: string };   // full timeline groups by this
  detail: Record<string, unknown>;                          // typed per kind in EventContent
  provenance: { where: "lab" | "kiwi"; ai?: "Lab AI tutor" | "Kiwi lecture AI" | "Local guidance"; policyLabel?: string; model?: string; checkedBy?: string; aiCallId?: number };
  studySessionIndex: number;                                // new index after a ≥ 30 min gap
}
export interface StudentTimeline {
  student: { studentId: string; studentName: string };
  assignment: { id: string; title: string; kind: AssignmentKind; toolPolicy: ToolPolicy } | null;      // null = full activity timeline
  status: { label: string; gradeStatus: GradeStatus | null; score: number | null; maxPoints: number } | null;   // "Released 17/20", "Draft 17/20", "Needs grading"
  events: TimelineEvent[]; nextCursor: string | null; hasMore: boolean;
}
/** kept name for moved code */ export type StudentAssignmentTimeline = StudentTimeline;
export interface QuestionActivity { activity: AnalyticsRow; events: EventRecord[]; hasMore: boolean; aliasOf?: string }
/** legacy v0.5.1 shape (src/types.ts:225-234) for /api/teacher/analytics/session */
export interface SessionEvidence { session: AnalyticsRow; events: { id: number; type: string; createdAt: string; payload: Record<string, unknown> }[]; hasMore: boolean }
/** legacy */ export interface StudentSummary { student_id: string; name: string; events: number; runs: number; answers: number; last_active: string }
export interface ConversationDigest {
  range: TimeRange;
  repeated: { prompt: string; students: number; occurrences: number; examples: { threadKey: string; studentName: string; at: ISODate }[] }[];
  topics: { label: string; turns: number; students: number }[];
  flagged: { chatTurnId: number; threadKey: string; studentName: string; prompt: string; reason: string; at: ISODate }[];
  recent: { threadKey: string; studentName: string; prompt: string; at: ISODate; where: "lab" | "kiwi"; assignmentLabel: string;
            assignmentTitle?: string }[];   // RT-03: full title (+ Q n) behind a shortened assignmentLabel, for its tooltip
}
export interface ThreadSummary { threadKey: string; where: "lab" | "kiwi"; studentId: string; studentName: string; unitId: string; assignmentLabel: string; turns: number; firstAt: ISODate; lastAt: ISODate; codes: string[]; flagged: boolean }
export interface ConversationThread {
  summary: ThreadSummary;
  threadCodes?: ConversationCode[];                          // CR-I4: thread-level codes (chatTurnId and nativeEventId null)
  turns: { chatTurnId: number | null; nativeEventId: number | null; aiCallId: number | null; at: ISODate; prompt: string; response: string;
           provenance: TimelineEvent["provenance"]; guard: GuardView["status"];
           flagged: boolean; flagSource: "" | "guard" | "staff"; flagUpdatedBy: string | null;
           legacyClientRecord: boolean;                       // badge "Legacy client record"
           feedback: { value: number | null; reply: string | null; at: ISODate }[];   // Kiwi thumbs/flag on native turns [DA11]
           codes: ConversationCode[] }[];
}
export interface CodebookCode { id: string; label: string; description: string; color: "neutral" | "info" | "success" | "warning" | "danger"; archived: boolean }
export interface ConversationCode { id: number; threadKey: string; chatTurnId: number | null; nativeEventId: number | null; codeId: string; coder: string; note: string; createdAt: ISODate }
export interface TopicRule { label: string; keywords: string[] }
/** v0.5.1 evidence page shape kept */ export interface QuestionEvidence { sharedTopics: { theme: string; questions: number; students: number; examples: { studentName: string; prompt: string; sessionId: string }[] }[]; distribution: { answer: string; attempts: number; students: number; share: number; questionId?: string }[]; commonQuestions: { prompt: string; occurrences: number; students: number }[]; questions: { id: number; studentName: string; createdAt: string; sessionId: string; payload: Record<string, unknown> }[]; hasMore: boolean }
/** v0.5.1 overview shape kept */ export interface AnalyticsMetrics { sources: { source: string; sessions: number; interactions: number; codeRuns: number; aiQuestions: number }[]; activeStudents: number; engagedStudents: number; publishedAssignments: number; averageAttempts: number; averageInteractions: number; completedUnits: number; totalUnits: number; currentUnitId: string; interactions: number; attempts: number; codeRuns: number; aiQuestions: number; sessions: number }

// ─── §7.8 People, governance, settings ─────────────────────────────────────────────────────────

export interface Group { id: string; name: string; kind: GroupKind; description: string; members: number; archived: boolean }
export interface GroupMembershipChange { studentId: string; studentName?: string; kind: GroupKind; groupId: string; groupName: string; method: string; seed: string | null; assignedBy: string; validFrom: ISODate; validTo: ISODate | null }
export interface KiwiStaffSeen {
  kiwiUserId: string; username: string; kiwiRole: string; canManageCourse: boolean; canViewAnalytics: boolean;
  effectiveRole: StaffRole | null; roleSource: "kiwi" | "override"; overrideStaffId: string | null; lastSeenAt: ISODate;
}
export interface CourseTemplate { key: string; title: string; description: string; chapters: number }
export interface RosterEntry {
  studentId: string; studentName: string; displayName: string; email: string | null; pseudonym: string;
  source: "import" | "kiwi" | "activity"; status: "active" | "dropped"; groups: { kind: GroupKind; groupId: string; name: string }[];
  consent: ConsentState; consentSource: "kiwi" | "teacher" | "none"; excluded: boolean; exclusionReason: string;
  lastActive: ISODate | null; missingWork: number; activitiesRecorded: number;
}
export interface RosterImportRow { studentId?: string; name?: string; email?: string; section?: string; condition?: string }
export interface RosterImportResult { mode: "preview" | "apply"; rows: { index: number; action: "add" | "update" | "unchanged" | "error"; studentId: string | null; message: string; diff: Record<string, [unknown, unknown]> }[]; applied: number }
export interface StudentSearchHit { studentId: string; studentName: string; pseudonym: string; matchedOn: "name" | "id" | "email" | "pseudonym" }
export interface StudentProfile {
  student: RosterEntry; header: { lastActive: ISODate | null; missing: number; late: number; avgScorePct: number | null };
  fullTimelineUrl: string;                                   // /teacher/students/s/:id/timeline
  canExportConversations: boolean;                           // exportActivity and not viewer-pseudonymized
  assignments: { assignmentId: string; title: string; kind: AssignmentKind; dueAt: ISODate | null; cell: GradebookCell; timelineUrl: string; gradingUrl: string | null; draftAnswered: number | null }[];
  recentErrors: { at: ISODate; questionLabel: string; error: string; href: string }[];
  recentAiQuestions: { at: ISODate; prompt: string; where: "lab" | "kiwi"; threadKey: string; flagged: boolean }[];
  practiceByChapter: { unitId: string; title: string; freeItems: number; similarItems: number; serverAccuracy: number | null; activeMinutes: number }[];
}
export interface StaffMember { id: string; displayName: string; role: StaffRole; kiwiUserId: string | null; keyPrefix: string | null; createdAt: ISODate; revokedAt: ISODate | null }
export interface CourseSettings {
  schedule: CourseSchedule;
  privacy: { showEmails: boolean; defaultNameMode: NameMode; researchPurpose: string; irbProtocol: string; retentionDays: number | null; viewerCanExportResearch: boolean };
  grading: { defaultGradesVisibility: "immediately" | "on_release"; taCanRelease: boolean };
  ai: { perStudentPerMinute: number; classPerMinute: number };
  attentionRules: AttentionRules; topicRules: TopicRule[];
}
export interface AuditEntry { id: number; kind: "action" | "access"; actorLabel: string; actorRole: string; action: string; targetType: string; targetId: string; summary: string; createdAt: ISODate;
  before?: string | null; after?: string | null }            // CR-P2: raw JSON (≤ 4,000 chars), null in Presentation mode
export interface CoursePackageImportResult { mode: "preview" | "apply"; chapters: { id: string; title: string; action: "add" | "skip" | "archive"; packages?: string[]; startsOn?: string | null; notes?: string[]; week?: number | null }[]; assignments: { title: string; action: "add" | "skip"; dueAt: ISODate | null }[]; policies: { scope: string; action: "add" | "skip" }[]; files: number; warnings: string[]; source?: string }

// ─── §7.9 Frozen component props and hook signatures (cross-workstream) ────────────────────────

// implemented in src/student/tools/RWorkbench.tsx (TELEMETRY)
export interface RWorkbenchProps {
  code: string; onCode: (code: string) => void; onResult?: (r: RunResultView & { code: string }) => void;
  track: Tracker; questionId?: string; storageKey: string;
  context: { unitId: string; surface: Surface; assignmentId?: string; itemId?: string; envKey: string };   // envKey isolates R environments
  runtime?: UnitRuntime; files?: FileMeta[]; allowRun?: boolean; resetCode?: string;
}
export interface RunResultView { ok: boolean; output: string; stdout: string; error?: string; warnings: string[]; plots: number; durationMs: number }
// implemented in src/student/tools/KiwiChat.tsx (AIRUN)
export interface KiwiChatProps {
  classId: string; studentId: string; unitId: string; surface: Surface; question: string; code: string;
  track: Tracker; assignmentId?: string; questionId?: string; itemId?: string;
  lastRun?: { ok: boolean; output: string; error?: string } | null; answerDraft?: string;
}
// implemented in src/student/assignments/SimilarPanel.tsx (AIRUN), rendered by AssignmentPage (ASSESS)
export interface SimilarPanelProps {
  classId: string; studentId: string; unitId: string; assignmentId: string; question: WorkQuestion;   // student-redacted question
  track: Tracker; disabledReason?: string;                  // "Not available for this assignment" when similarPractice=false
}
// declared in src/types.ts, re-exported by src/lib/telemetry.ts (TELEMETRY)
export type Tracker = (type: string, payload: Record<string, unknown>, questionId?: string) => Promise<void>;
export interface TelemetryContext { surface: Surface; unitId: string; assignmentId?: string; questionId?: string; itemId?: string; tool?: string }
export interface TelemetryStatus { pending: number; failingSince: number | null; blocked: boolean }
// src/teacher/kiwi/KiwiSyncProvider.tsx (TELEMETRY)
export interface KiwiSyncState { status: KiwiSyncStatus | null; newActivity: boolean; acknowledge: () => void; refresh: () => void; error: string }
// src/teacher/shell/TeacherContext.tsx (FOUNDATION, frozen)
export interface TeacherContextValue {
  classId: string; course: Course | null; setCourse: (c: Course) => void; me: Me; refreshMe: () => Promise<void>;
  timeRange: TimeRange; setTimePreset: (p: TimePreset, custom?: { from: string; to: string }) => void;
  nameMode: NameMode; setNameMode: (m: NameMode) => void;   // persisted in sessionStorage; sent as X-Name-Mode
  teacherKey: string | null; setTeacherKey: (k: string | null) => void; signOut: () => void;   // used by TeacherGate/AccountMenu (PEOPLE)
}
// src/lib/kiwi.ts (FOUNDATION, frozen) — called by AssignmentPage (ASSESS) with the assignment's tool policy
export interface HostChatPolicy { available: boolean; contextNote: string }    // tutoringMode is always "guidance"
