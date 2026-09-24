export type QuestionType = 'fill' | 'choice' | 'predict' | 'complete';
export type Difficulty = 1 | 2 | 3 | 4 | 5;

export interface Unit {
  id: string;
  title: string;
  goal: string;
  status: 'completed' | 'current' | 'upcoming';
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
  source: 'kiwi-ai' | 'local';
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
  readonly mode: 'live' | 'sim';
  askAI(prompt: string): Promise<string>;
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
      kind: 'student_learning_context';
      scope: 'current_user_current_class';
      include: ('recent_questions' | 'weak_concepts' | 'relevant_materials')[];
    };
  }): Promise<{ output: string }>;
}

export type WorkQuestionType = QuestionType | 'text';
export interface WorkQuestion {
  id: string; type: WorkQuestionType; prompt: string; points: number;
  choices: string[]; starterCode: string; answer?: string; explanation?: string;
}
export interface Assignment {
  id: string; classId: string; kind: 'practice' | 'homework'; title: string;
  unitId: string; instructions: string; dueAt: string | null;
  status: 'draft' | 'published'; questions: WorkQuestion[];
  attachmentName: string | null; createdAt: string; updatedAt: string;
}
export interface Submission {
  id: string; assignmentId: string; studentId: string; studentName: string;
  attempt: number; answers: Record<string, string>; submittedAt: string;
  grade: number | null; feedback: string | null; gradedAt: string | null;
}
export interface HubStudent {
  studentId: string; studentName: string; scoreByAssignment: Record<string, number>;
  attemptsByAssignment: Record<string, number>; interactions: number;
  learningSeconds: number; freePracticeCount: number; codeRuns: number;
  aiQuestions: number; lastActive: string | null;
}
export interface HubData { assignments: { id: string; title: string }[]; students: HubStudent[] }
