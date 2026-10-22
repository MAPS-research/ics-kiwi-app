export type QuestionType = "fill" | "choice" | "predict" | "complete";
export type Difficulty = 1 | 2 | 3 | 4 | 5;

export interface Unit {
  id: string;
  title: string;
  goal: string;
  status: "completed" | "current" | "upcoming";
}

export interface Course {
  title: string;
  description: string;
  currentUnitId: string;
  units: Unit[];
}

export interface Question {
  id: string;
  type: QuestionType;
  difficulty: Difficulty;
  unitId: string;
  title: string;
  prompt: string;
  code?: string;
  choices?: string[];
  answer: string;
  acceptedAnswers?: string[];
  explanation: string;
  starterCode?: string;
  expectedOutput?: string;
  source: "kiwi-ai" | "local";
}

export interface EventRecord {
  id: number;
  classId: string;
  studentId: string;
  studentName: string;
  sessionId: string;
  type: string;
  questionId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface StudentSummary {
  student_id: string;
  name: string;
  events: number;
  runs: number;
  answers: number;
  last_active: string;
}

export interface KiwiContext {
  classId: string;
  className?: string;
  userId: string;
  username?: string;
  userRole?: string;
}

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

export type WorkQuestionType = QuestionType | "text";
export interface WorkQuestion {
  id: string;
  type: WorkQuestionType;
  prompt: string;
  points: number;
  choices: string[];
  starterCode: string;
  answer?: string;
  explanation?: string;
}
export interface Assignment {
  id: string;
  classId: string;
  kind: "practice" | "homework";
  title: string;
  unitId: string;
  instructions: string;
  dueAt: string | null;
  status: "draft" | "published";
  questions: WorkQuestion[];
  attachmentName: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Submission {
  id: string;
  assignmentId: string;
  studentId: string;
  studentName: string;
  attempt: number;
  answers: Record<string, string>;
  submittedAt: string;
  grade: number | null;
  feedback: string | null;
  gradedAt: string | null;
}
export interface HubStudent {
  studentId: string;
  studentName: string;
  scoreByAssignment: Record<string, number>;
  attemptsByAssignment: Record<string, number>;
  interactions: number;
  learningSeconds: number;
  freePracticeCount: number;
  codeRuns: number;
  aiQuestions: number;
  lastActive: string | null;
}
export interface HubData {
  assignments: { id: string; title: string }[];
  students: HubStudent[];
}

export interface GenerationPolicy {
  unitId?: string;
  systemPrompt?: string;
  minDifficulty: Difficulty;
  maxDifficulty: Difficulty;
  defaultDifficulty: Difficulty;
  allowedTypes: QuestionType[];
  maxOutputTokens: number;
  aiAvailable?: boolean;
}
export interface AnalyticsMetrics {
  sources: { source: string; sessions: number; interactions: number; codeRuns: number; aiQuestions: number }[];
  activeStudents: number;
  engagedStudents: number;
  publishedAssignments: number;
  averageAttempts: number;
  averageInteractions: number;
  completedUnits: number;
  totalUnits: number;
  currentUnitId: string;
  interactions: number;
  attempts: number;
  codeRuns: number;
  aiQuestions: number;
  sessions: number;
}
export interface AnalyticsRow {
  source?: "lab" | "kiwi";
  materialId?: string;
  id?: string;
  label?: string;
  title?: string;
  studentId?: string;
  studentName?: string;
  unitId?: string;
  assignmentId?: string;
  questionId?: string;
  kind?: string;
  startedAt?: string;
  lastActive: string | null;
  interactions: number;
  attempts: number;
  checked: number;
  correct: number;
  codeRuns: number;
  codeErrors: number;
  codeSuccesses: number;
  aiQuestions: number;
  students: number;
  sessions: number;
  accuracy: number | null;
  averageAttempts: number;
  averageQuestions: number;
}

export interface VerifiedKiwiContext extends KiwiContext {
  canTeach: boolean;
  canManageCourse: boolean;
  canViewAnalytics: boolean;
}
export interface KiwiSyncStatus {
  connected: boolean;
  lastSynced: string | null;
  error: string | null;
  hasMore: boolean;
  busy?: boolean;
  metadataTruncated: boolean;
  nativeEvents: number;
  materials: { id: string; title: string; unitId: string }[];
}
export interface AnalyticsTable {
  rows: AnalyticsRow[];
  total: number;
  page: number;
  pageSize: number;
}
export interface SessionEvidence {
  session: AnalyticsRow;
  events: {
    id: number;
    type: string;
    createdAt: string;
    payload: Record<string, unknown>;
  }[];
  hasMore: boolean;
}
export interface QuestionEvidence {
  sharedTopics: {
    theme: string;
    questions: number;
    students: number;
    examples: { studentName: string; prompt: string; sessionId: string }[];
  }[];
  distribution: {
    answer: string;
    attempts: number;
    students: number;
    share: number;
  }[];
  commonQuestions: { prompt: string; occurrences: number; students: number }[];
  questions: {
    id: number;
    studentName: string;
    createdAt: string;
    sessionId: string;
    payload: Record<string, unknown>;
  }[];
  hasMore: boolean;
}

export interface WorkOption {
  id: string;
  title: string;
  kind: "practice" | "homework";
  unitId: string;
  status: "draft" | "published";
  questionCount: number;
  hasSubmissions: boolean;
  dueAt: string | null;
}
export interface WorkPage {
  assignments: Assignment[];
  submissions: Submission[];
  options: WorkOption[];
  total: number;
  page: number;
  pageSize: number;
}
