import type {
  AddEventResponse, AiCallDetail, AiQuestionType, AiRuleScope, AiRulesOverview, AiStatus, AiTestRequest, AiTestResult,
  AiTestSample, AiTestSampleResult, AnalyticsMetrics, ChapterSummary, HomeworkQuestionOption, PracticeStatus, AnalyticsTable, AnswerDraft, AnswersByQuestion, Assignment,
  AssignmentInput, AssignmentListItem, AssignmentStudentStatus, AttentionItem, AttentionRules, AuditEntry, ChatRequest,
  ChatResponse, ChatTurnView, CheckResult, CodebookCode, ConversationCode, ConversationDigest, ConversationThread, Course,
  CourseInput, CourseMetrics, CoursePackageImportResult, CourseSettings, CourseTemplate, DataHealth, Difficulty,
  EventInput, EventRecord, ExerciseResults, FileMeta, GeneratedItemPublic, GeneratedItemTeacher, GenerationPolicy,
  Gradebook, GradeInput, GradingQueue, Group, GroupKind, GroupMembershipChange, HomeData, HubData, InClassCheckResult,
  ItemCheckResult, KiwiStaffSeen, KiwiSyncStatus, Me, NameMode, OutagePeriod, PlatformRule, PolicyConfig, PolicyDiff,
  PolicyVersion, PublicPolicy, Question, QuestionActivity, QuestionEvidence, ReteachCandidate, ReteachMark, RosterEntry,
  RosterImportResult, RosterImportRow, SessionEvidence, StaffMember, StaffRole, StarterAssignment, StudentAssignment,
  StudentProfile, StudentSearchHit, StudentSubmission, StudentSummary, StudentTimeline, StudentWorkOption, Submission,
  SubmissionDetail, SubmitResult, TeacherAssignment, ThreadSummary, TimePreset, TimeRange, TopicRule, TrendBucket,
  VerifiedKiwiContext, WorkOption, WorkPage, WorkQuestion,
} from "../types";

/*
 * API client (§8, frozen after FOUNDATION). Every method takes `classId` first and maps 1:1 to a §6 endpoint.
 * Header state (Kiwi token, teacher/staff key, demo session, preview, name mode) is set by App/TeacherContext/
 * StudentApp through the setters below; nothing reads storage or `location` at import time.
 */

// ─── Errors ────────────────────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const STATUS_CODES: Readonly<Record<number, string>> = {
  400: "invalid_request", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 405: "method_not_allowed",
  409: "conflict", 422: "invalid_payload", 429: "rate_limited", 500: "internal_error", 502: "ai_provider_error", 503: "unavailable",
};

// ─── Header state ──────────────────────────────────────────────────────────────────────────────

let tokenProvider: ((force?: boolean) => Promise<string>) | undefined;
let teacherKeyHeader: string | null = null;
let demoSessionHeader: string | null = null;
let previewHeader = false;
let nameModeHeader: NameMode = "names";

export function setKiwiTokenProvider(provider: ((force?: boolean) => Promise<string>) | undefined): void {
  tokenProvider = provider;
}
export function hasKiwiIdentity(): boolean {
  return Boolean(tokenProvider);
}
/** Teacher key or per-staff key (standalone classes), set by TeacherContext. */
export function setTeacherKeyHeader(key: string | null): void {
  teacherKeyHeader = key || null;
}
/** Demo session token for standalone students (§5.3 step 3). */
export function setDemoSessionHeader(token: string | null): void {
  demoSessionHeader = token || null;
}
/** Staff previewing the student app (§3.4): every request carries X-Kiwi-Preview: 1. */
export function setPreviewHeader(preview: boolean): void {
  previewHeader = preview;
}
export function isPreviewRequestMode(): boolean {
  return previewHeader;
}
/** Presentation mode: X-Name-Mode: pseudonyms (§14.1). */
export function setNameModeHeader(mode: NameMode): void {
  nameModeHeader = mode;
}

// ─── Transport ─────────────────────────────────────────────────────────────────────────────────

export interface RequestOpts {
  /** Overrides the context teacher key (POST /teacher/verify, legacy per-call keys). */
  teacherKey?: string;
  /** Internal: whether a 401 may refresh the Kiwi token once. */
  retry?: boolean;
}

async function buildHeaders(init: RequestInit, opts: RequestOpts): Promise<Record<string, string>> {
  const token = tokenProvider ? await tokenProvider(false) : undefined;
  const key = opts.teacherKey || teacherKeyHeader;
  return {
    ...(init.body !== undefined && init.body !== null ? { "Content-Type": "application/json" } : {}),
    ...(key ? { "X-Teacher-Key": key } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(demoSessionHeader ? { "X-Demo-Session": demoSessionHeader } : {}),
    ...(previewHeader ? { "X-Kiwi-Preview": "1" } : {}),
    ...(nameModeHeader === "pseudonyms" ? { "X-Name-Mode": "pseudonyms" } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
}

async function send(path: string, init: RequestInit, opts: RequestOpts): Promise<Response> {
  const headers = await buildHeaders(init, opts);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiError(0, "network_error", `Could not reach the CSS Lab server (${reason}). Check your connection and try again.`);
  }
  if (response.status === 401 && tokenProvider && opts.retry !== false) {
    await tokenProvider(true);
    return send(path, init, { ...opts, retry: false });
  }
  return response;
}

async function errorFrom(response: Response): Promise<ApiError> {
  let body: Partial<{ error: string; code: string; details: Record<string, unknown> }> = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = {}; // WHY: proxies and crashes can answer with non-JSON bodies; the status still explains the failure.
  }
  return new ApiError(
    response.status,
    body.code || STATUS_CODES[response.status] || "request_failed",
    body.error || `Request failed (${response.status})`,
    body.details,
  );
}

/** JSON request with v0.5.1 semantics (Kiwi token provider, one 401 refresh). 204 resolves to undefined. */
export async function request<T>(path: string, init: RequestInit = {}, opts: RequestOpts = {}): Promise<T> {
  const response = await send(path, init, opts);
  if (!response.ok) throw await errorFrom(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(response.status, "invalid_response", "The server sent a response the app could not read.");
  }
}

function filenameFrom(disposition: string | null, fallback: string): string {
  if (disposition) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (star) {
      try {
        return decodeURIComponent(star[1].trim());
      } catch {
        // fall through to the plain filename parameter
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    if (plain) return plain[1].trim();
  }
  return fallback;
}

/** Authenticated download (exports need auth headers, so `<a href>` links are not used). */
export async function requestBlob(path: string, init: RequestInit = {}, opts: RequestOpts = {}): Promise<{ blob: Blob; filename: string }> {
  const response = await send(path, init, opts);
  if (!response.ok) throw await errorFrom(response);
  const fallback = decodeURIComponent(path.split("?")[0].split("/").pop() || "download");
  return { blob: await response.blob(), filename: filenameFrom(response.headers.get("Content-Disposition"), fallback) };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────────────────────

type QueryInput = Record<string, string | number | boolean | null | undefined>;
/** `classId` plus the non-empty values; booleans are sent as 1/0. */
function qs(classId: string, values: QueryInput = {}): string {
  const params = new URLSearchParams();
  params.set("classId", classId);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "" || key === "classId") continue;
    params.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  return `?${params.toString()}`;
}
const enc = encodeURIComponent;
const json = (body: unknown): string => JSON.stringify(body);

function get<T>(classId: string, path: string, query?: QueryInput, opts?: RequestOpts): Promise<T> {
  return request<T>(`${path}${qs(classId, query)}`, {}, opts);
}
function write<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", classId: string, path: string, body?: unknown, opts?: RequestOpts & { keepalive?: boolean }): Promise<T> {
  return request<T>(
    `${path}${qs(classId)}`,
    { method, ...(body !== undefined ? { body: json(body) } : {}), ...(opts?.keepalive ? { keepalive: true } : {}) },
    opts,
  );
}
function blob(classId: string, path: string, query?: QueryInput): Promise<{ blob: Blob; filename: string }> {
  return requestBlob(`${path}${qs(classId, query)}`);
}
/** Legacy per-call key: a non-empty key overrides the context key, an empty one falls back to it. */
const legacyKey = (key?: string): RequestOpts => (key ? { teacherKey: key } : {});

export type Q = Record<string, string>;
export interface R { from?: string; to?: string; compareFrom?: string; compareTo?: string; groupId?: string; unitId?: string }
type FlagResult = { flagged: boolean; flagSource: string; flagUpdatedBy: string | null; flagUpdatedAt: string | null };
type Download = { blob: Blob; filename: string };

// ─── API ───────────────────────────────────────────────────────────────────────────────────────

export const api = {
  // core (§6.1)
  health: (classId: string) => get<{ ok: boolean; aiAvailable: boolean; version: string }>(classId, "/health"),
  me: (classId: string) => get<Me>(classId, "/me"),
  kiwiContext: (classId: string) => get<VerifiedKiwiContext>(classId, "/kiwi/context"),
  course: (classId: string) => get<Course>(classId, "/course"),
  saveCourse: (classId: string, c: CourseInput) => write<Course>("PUT", classId, "/course", c),
  timeRange: (classId: string, preset: TimePreset, custom?: R) => get<TimeRange>(classId, "/teacher/time-range", { preset, ...custom }),
  demoSession: (classId: string, body: { studentId?: string; token?: string }) =>
    write<{ token: string; studentId: string; studentName: string; expiresAt: string }>("POST", classId, "/demo/session", body),
  demoLink: (classId: string, studentId: string) => write<{ url: string; expiresAt: string }>("POST", classId, "/teacher/demo-links", { studentId }),
  verifyTeacher: (classId: string, key: string) =>
    write<{ ok: boolean; role: StaffRole | null }>("POST", classId, "/teacher/verify", undefined, { teacherKey: key }),

  // telemetry & kiwi (§6.2)
  event: (classId: string, e: EventInput) => write<AddEventResponse>("POST", classId, "/events", e),
  eventBatch: (classId: string, events: EventInput[], opts?: { keepalive?: boolean }) =>
    write<{ results: AddEventResponse[] }>("POST", classId, "/events/batch", { classId, events }, { keepalive: opts?.keepalive }),
  studentEvents: (classId: string, studentId: string) => get<EventRecord[]>(classId, "/events", { studentId }),
  teacherEvents: (classId: string, q: Q) =>
    get<{ events: EventRecord[]; nextCursor: string | null; hasMore: boolean }>(classId, "/teacher/events", { ...q, paged: "1" }),
  dataHealth: (classId: string, r: R) => get<DataHealth>(classId, "/teacher/data-health", { ...r }),
  kiwiStatus: (classId: string) => get<KiwiSyncStatus>(classId, "/teacher/kiwi/status"),
  syncKiwi: (classId: string) => write<KiwiSyncStatus>("POST", classId, "/teacher/kiwi/sync"),
  mapKiwiMaterial: (classId: string, materialId: string, unitId: string) =>
    write<KiwiSyncStatus>("PUT", classId, "/teacher/kiwi/material", { materialId, unitId }),

  // student work (§6.3)
  /** Students get StudentWorkOption[]; staff get WorkOption[] (`api.workOptions<WorkOption>(classId)`). */
  workOptions: <T extends WorkOption = StudentWorkOption>(classId: string) => get<T[]>(classId, "/work-options"),
  workDetail: (classId: string, id: string) => get<StudentAssignment>(classId, `/work/${enc(id)}`),
  workFile: (classId: string, id: string, fileId: string) =>
    get<{ name: string; type: string; data: string }>(classId, `/work/${enc(id)}/files/${enc(fileId)}`),
  attachment: (classId: string, id: string) => get<{ name: string; type: string; data: string }>(classId, `/work/${enc(id)}/attachment`),
  checkInClass: (classId: string, id: string, b: { studentId: string; questionId: string; answer: string; runOutput?: string; sessionId?: string; eventId?: string }) =>
    write<InClassCheckResult>("POST", classId, `/work/${enc(id)}/check`, b),
  startAttempt: (classId: string, id: string, studentId: string) =>
    write<{ attempt: number; startedAt: string; endsAt: string }>("POST", classId, `/work/${enc(id)}/start`, { studentId }),
  submitWork: (classId: string, id: string, b: { studentId: string; answers: Record<string, string>; requestId: string; sessionId?: string; autoSubmit?: boolean }) =>
    write<SubmitResult>("POST", classId, `/work/${enc(id)}/submit`, b),
  mySubmissions: (classId: string, studentId: string, assignmentId?: string) =>
    get<StudentSubmission[]>(classId, "/submissions", { studentId, assignmentId }),
  getDraft: (classId: string, assignmentId: string, studentId: string) => get<AnswerDraft>(classId, `/drafts/${enc(assignmentId)}`, { studentId }),
  saveDraft: (classId: string, assignmentId: string, b: { studentId: string; answers: Record<string, string>; clientTs: number; assignmentVersion: number }) =>
    write<AnswerDraft>("PUT", classId, `/drafts/${enc(assignmentId)}`, b),

  // assignments, staff (§6.3)
  assignments: (classId: string, q: Q) =>
    get<{ assignments: AssignmentListItem[]; total: number; page: number; pageSize: number }>(classId, "/teacher/assignments", q),
  createAssignment: (classId: string, a: AssignmentInput) => write<TeacherAssignment>("POST", classId, "/teacher/assignments", a),
  assignmentDetail: (classId: string, id: string) => get<TeacherAssignment>(classId, `/teacher/assignments/${enc(id)}`),
  updateAssignment: (classId: string, id: string, a: AssignmentInput & { baseUpdatedAt: string }) =>
    write<TeacherAssignment>("PUT", classId, `/teacher/assignments/${enc(id)}`, a),
  publishAssignment: (classId: string, id: string, openAt?: string | null) =>
    write<TeacherAssignment>("POST", classId, `/teacher/assignments/${enc(id)}/publish`, openAt === undefined ? {} : { openAt }),
  unpublishAssignment: (classId: string, id: string) => write<TeacherAssignment>("POST", classId, `/teacher/assignments/${enc(id)}/unpublish`, {}),
  closeAssignment: (classId: string, id: string, closeAt?: string) =>
    write<TeacherAssignment>("POST", classId, `/teacher/assignments/${enc(id)}/close`, closeAt ? { closeAt } : {}),
  reopenAssignment: (classId: string, id: string) => write<TeacherAssignment>("POST", classId, `/teacher/assignments/${enc(id)}/reopen`, {}),
  archiveAssignment: (classId: string, id: string) => write<TeacherAssignment>("POST", classId, `/teacher/assignments/${enc(id)}/archive`, {}),
  unarchiveAssignment: (classId: string, id: string) => write<TeacherAssignment>("POST", classId, `/teacher/assignments/${enc(id)}/unarchive`, {}),
  deleteAssignment: (classId: string, id: string) => write<void>("DELETE", classId, `/teacher/assignments/${enc(id)}`),
  duplicateAssignment: (classId: string, id: string, b: { title?: string; asRevision?: boolean; retireOriginalOnPublish?: boolean; shiftDays?: number }) =>
    write<TeacherAssignment>("POST", classId, `/teacher/assignments/${enc(id)}/duplicate`, b),
  assignmentStudents: (classId: string, id: string, state: "submitted" | "not_submitted" | "started" | "missing" | "late" | "to_grade", groupId?: string) =>
    get<{ students: AssignmentStudentStatus[]; emails: string[] | null }>(classId, `/teacher/assignments/${enc(id)}/students`, { state, groupId }),
  clearPreviewSubmissions: (classId: string, id: string) =>
    write<{ counts: Record<string, number> }>("POST", classId, `/teacher/assignments/${enc(id)}/clear-preview`, {}),
  previewCheck: (classId: string, id: string, b: { question: WorkQuestion; answer: string; runOutput?: string }) =>
    write<CheckResult>("POST", classId, `/teacher/assignments/${enc(id)}/preview-check`, b),
  starterAssignments: (classId: string) => get<StarterAssignment[]>(classId, "/teacher/starter-assignments"),
  addStarterAssignments: (classId: string, b: { keys?: string[]; unitMap?: Record<string, string> }) =>
    write<{ created: number; skipped: { key: string; reason: string }[] }>("POST", classId, "/teacher/starter-assignments", b),
  uploadFile: (classId: string, b: { scope: "assignment" | "chapter"; assignmentId?: string; unitId?: string; questionId?: string; name: string; type: string; data: string; mountInR?: boolean; aiReference?: boolean }) =>
    write<FileMeta>("POST", classId, "/teacher/files", b),
  updateFile: (classId: string, fileId: string, b: { mountInR?: boolean; aiReference?: boolean }) =>
    write<FileMeta>("PATCH", classId, `/teacher/files/${enc(fileId)}`, b),
  deleteFile: (classId: string, fileId: string) => write<void>("DELETE", classId, `/teacher/files/${enc(fileId)}`),
  listFiles: (classId: string, q: { assignmentId?: string; unitId?: string }) => get<FileMeta[]>(classId, "/teacher/files", q),

  // grading (§6.4)
  gradingQueue: (classId: string, q: Q) => get<GradingQueue>(classId, "/teacher/grading/queue", q),
  submissionDetail: (classId: string, id: string) => get<SubmissionDetail>(classId, `/teacher/submissions/${enc(id)}`),
  saveGrade: (classId: string, id: string, g: GradeInput) => write<SubmissionDetail>("PUT", classId, `/teacher/submissions/${enc(id)}/grade`, g),
  releaseGrades: (classId: string, assignmentId: string, submissionIds?: string[]) =>
    write<{ released: number }>("POST", classId, `/teacher/assignments/${enc(assignmentId)}/release`, submissionIds ? { submissionIds } : {}),
  unreleaseGrade: (classId: string, id: string) => write<SubmissionDetail>("POST", classId, `/teacher/submissions/${enc(id)}/unrelease`, {}),
  gradebook: (classId: string, q: Q) => get<Gradebook>(classId, "/teacher/gradebook", q),
  gradesCsv: (classId: string, q: Q): Promise<Download> => blob(classId, "/teacher/exports/grades.csv", q),
  assignmentStatusCsv: (classId: string, q: Q): Promise<Download> => blob(classId, "/teacher/exports/assignment-status.csv", q),
  exerciseResults: (classId: string, assignmentId: string, r: R) =>
    get<ExerciseResults>(classId, `/teacher/assignments/${enc(assignmentId)}/results`, { ...r }),

  // ai rules & chapters (§6.5)
  aiStatus: (classId: string) => get<AiStatus>(classId, "/teacher/ai/status"),
  platformRules: (classId: string) => get<{ version: string; rules: PlatformRule[]; precedence: string[] }>(classId, "/teacher/ai/platform-rules"),
  aiRulesOverview: (classId: string) => get<AiRulesOverview>(classId, "/teacher/ai/rules"),
  aiRuleScope: (classId: string, q: { scope: "course" | "unit"; unitId: string; groupId: string }) => get<AiRuleScope>(classId, "/teacher/ai/rules/scope", q),
  saveAiRule: (classId: string, b: { scope: "course" | "unit"; unitId: string; groupId: string; config: PolicyConfig; note: string; baseVersion: number | null }) =>
    write<PolicyVersion>("POST", classId, "/teacher/ai/rules", b),
  copyAiRule: (classId: string, b: { fromVersionId: number; targets: { scope: "course" | "unit"; unitId: string; groupId: string }[]; note: string }) =>
    write<{ created: PolicyVersion[] }>("POST", classId, "/teacher/ai/rules/copy", b),
  aiRuleHistory: (classId: string, q: { scope: string; unitId: string; groupId: string }) => get<PolicyVersion[]>(classId, "/teacher/ai/rules/history", q),
  compareAiRules: (classId: string, a: number, b: number) =>
    get<{ a: PolicyVersion; b: PolicyVersion; diff: PolicyDiff[] }>(classId, "/teacher/ai/rules/compare", { a, b }),
  aiRuleVersion: (classId: string, versionId: number) => get<PolicyVersion>(classId, `/teacher/ai/rules/versions/${versionId}`),
  restoreAiRule: (classId: string, versionId: number, note: string) =>
    write<PolicyVersion>("POST", classId, `/teacher/ai/rules/versions/${versionId}/restore`, { note }),
  resetAiRule: (classId: string, b: { scope: string; unitId: string; groupId: string }) => write<PolicyVersion>("POST", classId, "/teacher/ai/rules/reset", b),
  testAiRule: (classId: string, b: AiTestRequest) => write<AiTestResult>("POST", classId, "/teacher/ai/test", b),
  aiTestSamples: (classId: string, q: { unitId: string; groupId: string }) => get<AiTestSample[]>(classId, "/teacher/ai/test-samples", q),
  saveAiTestSample: (classId: string, b: Omit<AiTestSample, "id" | "createdBy" | "createdAt">) => write<AiTestSample>("POST", classId, "/teacher/ai/test-samples", b),
  archiveAiTestSample: (classId: string, sampleId: string) => write<void>("DELETE", classId, `/teacher/ai/test-samples/${enc(sampleId)}`),
  runAiTestSamples: (classId: string, b: { unitId: string; groupId: string; config?: PolicyConfig; sampleIds?: string[]; dryRun: boolean }) =>
    write<{ results: AiTestSampleResult[] }>("POST", classId, "/teacher/ai/test-samples/run", b),
  setThisWeekChapter: (classId: string, unitId: string) => write<Course>("PUT", classId, "/teacher/chapters/this-week", { unitId }),
  chaptersSummary: (classId: string) => get<ChapterSummary>(classId, "/teacher/chapters/summary"),   // CR-AIRULES-1
  aiRuleHomeworkQuestions: (classId: string, unitId?: string) =>
    get<HomeworkQuestionOption[]>(classId, "/teacher/ai/rules/homework-questions", { unitId }),
  policy: (classId: string, unitId: string) => get<PublicPolicy>(classId, "/policy", { unitId }),

  // ai runtime (§6.6)
  chat: (classId: string, b: ChatRequest) => write<ChatResponse>("POST", classId, "/ai/chat", b),
  chatHistory: (classId: string, studentId: string, threadId: string) => get<ChatTurnView[]>(classId, "/chat", { studentId, threadId }),
  generateItem: (classId: string, b: { studentId: string; unitId: string; type: AiQuestionType; difficulty: Difficulty; focusNote?: string; surface: "free-practice" }) =>
    write<GeneratedItemPublic>("POST", classId, "/ai/question", b),
  generateSimilar: (classId: string, b: { studentId: string; assignmentId: string; questionId: string; difficulty: Difficulty; type?: AiQuestionType }) =>
    write<GeneratedItemPublic>("POST", classId, "/ai/similar", b),
  checkItem: (classId: string, itemId: string, b: { answer: string; runOutput?: string; eventId?: string; timeOnItemMs?: number }) =>
    write<ItemCheckResult>("POST", classId, `/practice/items/${enc(itemId)}/check`, b),
  practiceStatus: (classId: string, unitId: string) => get<PracticeStatus>(classId, "/practice/status", { unitId }),   // CR-AIRUN-3
  revealItem: (classId: string, itemId: string) => write<{ answer: string; explanation: string }>("POST", classId, `/practice/items/${enc(itemId)}/reveal`, {}),
  verifyItem: (classId: string, itemId: string, b: { runOutput: string; ok: boolean }) =>
    write<{ recorded: true }>("POST", classId, `/practice/items/${enc(itemId)}/verify`, b),
  generatedItems: (classId: string, q: Q) =>
    get<{ items: GeneratedItemTeacher[]; total: number; page: number; pageSize: number }>(classId, "/teacher/ai/items", q),
  flagItem: (classId: string, itemId: string, note: string) => write<GeneratedItemTeacher>("POST", classId, `/teacher/ai/items/${enc(itemId)}/flag`, { note }),
  unflagItem: (classId: string, itemId: string, note: string) => write<GeneratedItemTeacher>("POST", classId, `/teacher/ai/items/${enc(itemId)}/unflag`, { note }),
  retireItem: (classId: string, itemId: string, note: string) => write<GeneratedItemTeacher>("POST", classId, `/teacher/ai/items/${enc(itemId)}/retire`, { note }),
  restoreItem: (classId: string, itemId: string, note: string) => write<GeneratedItemTeacher>("POST", classId, `/teacher/ai/items/${enc(itemId)}/restore`, { note }),
  flagTurn: (classId: string, chatTurnId: number, reason: string) => write<FlagResult>("POST", classId, `/teacher/ai/turns/${chatTurnId}/flag`, { reason }),
  unflagTurn: (classId: string, chatTurnId: number, reason: string) => write<FlagResult>("POST", classId, `/teacher/ai/turns/${chatTurnId}/unflag`, { reason }),
  aiCallDetail: (classId: string, aiCallId: number) => get<AiCallDetail>(classId, `/teacher/ai/calls/${aiCallId}`),

  // insights (§6.7)
  home: (classId: string, r: R) => get<HomeData>(classId, "/teacher/home", { ...r }),
  attention: (classId: string, r: R) =>
    get<{ rules: AttentionRules; students: AttentionItem[]; evaluatedAt: string; descriptions?: Record<string, string> }>(classId, "/teacher/attention", { ...r }),
  attentionRules: (classId: string) => get<AttentionRules>(classId, "/teacher/attention/rules"),
  saveAttentionRules: (classId: string, rules: AttentionRules) => write<AttentionRules>("PUT", classId, "/teacher/attention/rules", rules),
  reteach: (classId: string, r: R & { includeResolved?: boolean }) =>
    get<{ candidates: ReteachCandidate[]; marked: ReteachMark[] }>(classId, "/teacher/reteach", { ...r }),
  markReteach: (classId: string, b: Omit<ReteachMark, "id" | "createdBy" | "createdAt" | "resolvedAt">) => write<ReteachMark>("POST", classId, "/teacher/reteach", b),
  updateReteach: (classId: string, id: number, b: { resolved?: boolean; note?: string }) => write<ReteachMark>("PATCH", classId, `/teacher/reteach/${id}`, b),
  analytics: (classId: string, q: Q) => get<AnalyticsTable>(classId, "/teacher/analytics/table", q),
  answers: (classId: string, q: Q) => get<AnswersByQuestion>(classId, "/teacher/analytics/answers", q),
  questionActivity: (classId: string, activityId: string, after?: number) =>
    get<QuestionActivity>(classId, `/teacher/analytics/question-activity/${enc(activityId)}`, { after }),
  timeline: (classId: string, q: { studentId: string; assignmentId?: string; from?: string; to?: string; unitId?: string; where?: "lab" | "kiwi"; after?: string }) =>
    get<StudentTimeline>(classId, "/teacher/timeline", q),
  metrics: (classId: string, r: R) => get<CourseMetrics>(classId, "/teacher/metrics", { ...r }),
  trends: (classId: string, q: Q) => get<{ buckets: TrendBucket[]; outages: OutagePeriod[] }>(classId, "/teacher/trends", q),
  learningCurves: (classId: string, q: Q) => get<{ points: { attemptIndex: number; accuracy: number | null; n: number }[] }>(classId, "/teacher/learning-curves", q),
  timeOnTask: (classId: string, q: Q) =>
    get<{ questions: { questionId: string; label: string; medianMinutes: number; p75Minutes: number; students: number }[] }>(classId, "/teacher/time-on-task", q),
  conversationDigest: (classId: string, q: Q) => get<ConversationDigest>(classId, "/teacher/ai-conversations/digest", q),
  conversationThreads: (classId: string, q: Q) =>
    get<{ threads: ThreadSummary[]; total: number; page: number; pageSize: number }>(classId, "/teacher/ai-conversations/threads", q),
  conversationThread: (classId: string, threadKey: string) => get<ConversationThread>(classId, `/teacher/ai-conversations/threads/${enc(threadKey)}`),
  nextUncodedThread: (classId: string, q: Q) => get<{ threadKey: string | null }>(classId, "/teacher/ai-conversations/next-uncoded", q),
  codebook: (classId: string) => get<CodebookCode[]>(classId, "/teacher/codebook"),
  createCode: (classId: string, b: Omit<CodebookCode, "id" | "archived">) => write<CodebookCode>("POST", classId, "/teacher/codebook", b),
  updateCode: (classId: string, id: string, b: Partial<CodebookCode>) => write<CodebookCode>("PATCH", classId, `/teacher/codebook/${enc(id)}`, b),
  addConversationCode: (classId: string, b: { threadKey: string; chatTurnId?: number; nativeEventId?: number; codeId: string; note?: string }) =>
    write<ConversationCode>("POST", classId, "/teacher/ai-conversations/codes", b),
  removeConversationCode: (classId: string, id: number) => write<void>("DELETE", classId, `/teacher/ai-conversations/codes/${id}`),
  topicRules: (classId: string) => get<TopicRule[]>(classId, "/teacher/topic-rules"),
  saveTopicRules: (classId: string, rules: TopicRule[]) => write<TopicRule[]>("PUT", classId, "/teacher/topic-rules", rules),

  // people, settings, governance, exports (§6.8)
  roster: (classId: string, q: Q) => get<{ students: RosterEntry[]; total: number; page: number; pageSize: number }>(classId, "/teacher/roster", q),
  importRoster: (classId: string, b: { rows: RosterImportRow[]; mode: "preview" | "apply"; matchBy: "studentId" | "email" }) =>
    write<RosterImportResult>("POST", classId, "/teacher/roster/import", b),
  updateRosterEntry: (classId: string, studentId: string, b: { displayName?: string; status?: "active" | "dropped"; excluded?: { value: boolean; reason: string }; consentOverride?: { value: "yes" | "no" | null; note: string } }) =>
    write<RosterEntry>("PATCH", classId, `/teacher/roster/${enc(studentId)}`, b),
  searchStudents: (classId: string, q: string) => get<StudentSearchHit[]>(classId, "/teacher/students/search", { q }),
  studentProfile: (classId: string, studentId: string, r: R) => get<StudentProfile>(classId, `/teacher/students/${enc(studentId)}/profile`, { ...r }),
  groups: (classId: string) => get<Group[]>(classId, "/teacher/groups"),
  createGroup: (classId: string, b: { name: string; kind: GroupKind; description: string; studentIds?: string[] }) => write<Group>("POST", classId, "/teacher/groups", b),
  updateGroup: (classId: string, id: string, b: Partial<{ name: string; description: string }>) => write<Group>("PATCH", classId, `/teacher/groups/${enc(id)}`, b),
  archiveGroup: (classId: string, id: string) => write<void>("DELETE", classId, `/teacher/groups/${enc(id)}`),
  setGroupMembers: (classId: string, id: string, studentIds: string[]) => write<Group>("PUT", classId, `/teacher/groups/${enc(id)}/members`, { studentIds }),
  randomizeGroups: (classId: string, b: { groupIds: string[]; seed: string; studentIds?: string[]; overwrite: boolean }) =>
    write<{ assignments: { studentId: string; groupId: string }[]; seed: string; algorithm: string }>("POST", classId, "/teacher/groups/randomize", b),
  groupHistory: (classId: string, q: { studentId?: string; kind?: GroupKind }) => get<GroupMembershipChange[]>(classId, "/teacher/groups/history", q),
  staff: (classId: string) => get<{ staff: StaffMember[]; kiwiStaff: KiwiStaffSeen[] }>(classId, "/teacher/staff"),
  createStaff: (classId: string, b: { displayName: string; role: StaffRole; kiwiUserId?: string }) =>
    write<{ staff: StaffMember; key?: string }>("POST", classId, "/teacher/staff", b),
  updateStaff: (classId: string, id: string, b: Partial<{ displayName: string; role: StaffRole }>) => write<StaffMember>("PATCH", classId, `/teacher/staff/${enc(id)}`, b),
  revokeStaff: (classId: string, id: string) => write<void>("DELETE", classId, `/teacher/staff/${enc(id)}`),
  settings: (classId: string) => get<CourseSettings>(classId, "/teacher/settings"),
  saveSettings: (classId: string, b: Partial<CourseSettings>) => write<CourseSettings>("PUT", classId, "/teacher/settings", b),
  audit: (classId: string, q: Q) => get<{ entries: AuditEntry[]; total: number; page: number; pageSize: number }>(classId, "/teacher/audit", q),
  deleteStudentData: (classId: string, studentId: string, b: { mode: "anonymize" | "delete"; confirm: string }) =>
    write<{ counts: Record<string, number> }>("POST", classId, `/teacher/students/${enc(studentId)}/delete-data`, b),
  retention: (classId: string) => get<{ due: Record<string, number>; retentionDays: number | null }>(classId, "/teacher/retention"),
  runRetention: (classId: string, confirm: "RUN RETENTION") => write<{ counts: Record<string, number> }>("POST", classId, "/teacher/retention/run", { confirm }),
  /** `path`: "activity.csv", "ai-conversations.jsonl", "student/<id>.zip", "research-package.zip", …; `q` lists are comma-separated. */
  downloadExport: (classId: string, path: string, q: Q): Promise<Download> =>
    blob(classId, `/teacher/exports/${path.split("/").map(enc).join("/")}`, q),
  coursePackage: (classId: string): Promise<Download> => blob(classId, "/teacher/course-package.zip"),
  courseTemplates: (classId: string) => get<CourseTemplate[]>(classId, "/teacher/course-templates"),
  importCoursePackage: (classId: string, b: { zipBase64?: string; templateKey?: string; mode: "preview" | "apply"; shiftWeeks?: number; archiveUnreferencedDefaults?: boolean }) =>
    write<CoursePackageImportResult>("POST", classId, "/teacher/course-package/import", b),

  // legacy v0.5.1 methods with their v0.5.1 signatures (src/lib/api.ts:57-272), for moved code; removed in v0.7.
  // A non-empty `key` overrides the context teacher key; an empty one uses it.
  workPage: (classId: string, key: string, values: Record<string, string>) => get<WorkPage>(classId, "/teacher/work-page", values, legacyKey(key)),
  policies: (classId: string, key: string) => get<GenerationPolicy[]>(classId, "/teacher/policies", {}, legacyKey(key)),
  savePolicy: (classId: string, data: GenerationPolicy, key: string) => write<GenerationPolicy>("PUT", classId, "/teacher/policies", data, legacyKey(key)),
  generate: (classId: string, data: object) => write<Question>("POST", classId, "/ai/question", data),
  evidence: (classId: string, key: string, values: Record<string, string>) => get<QuestionEvidence>(classId, "/teacher/analytics/evidence", values, legacyKey(key)),
  session: (classId: string, key: string, sessionId: string, afterId = 0) =>
    get<SessionEvidence>(classId, "/teacher/analytics/session", { sessionId, afterId: String(afterId) }, legacyKey(key)),
  hub: (classId: string, key: string) => get<HubData>(classId, "/teacher/hub", {}, legacyKey(key)),
  grade: (classId: string, id: string, grade: number, feedback: string, key: string) =>
    write<{ id: string; grade: number }>("POST", classId, `/submissions/${enc(id)}/grade`, { grade, feedback }, legacyKey(key)),
  seedSamples: (classId: string, key: string) => write<{ created: number }>("POST", classId, "/teacher/samples", undefined, legacyKey(key)),
  summary: (classId: string, key: string) => get<{ students: StudentSummary[]; totalEvents: number }>(classId, "/teacher/summary", {}, legacyKey(key)),
  work: (classId: string, key?: string) => get<Assignment[]>(classId, "/work", {}, legacyKey(key)),
  saveWork: (classId: string, data: object, key: string, id?: string) =>
    write<Assignment>(id ? "PUT" : "POST", classId, id ? `/work/${enc(id)}` : "/work", data, legacyKey(key)),
  workStatus: (classId: string, id: string, status: "draft" | "published", key: string) =>
    write<Assignment>("POST", classId, `/work/${enc(id)}/status`, { status }, legacyKey(key)),
  submissions: (classId: string, studentId?: string, key?: string, assignmentId?: string) =>
    get<Submission[]>(classId, "/submissions", { studentId, assignmentId }, legacyKey(key)),
  /** GET /teacher/analytics/metrics → AnalyticsMetrics */
  metricsLegacy: (classId: string, key: string) => get<AnalyticsMetrics>(classId, "/teacher/analytics/metrics", {}, legacyKey(key)),
  /** POST /teacher/roster {students} */
  importRosterLegacy: (classId: string, students: { studentId: string; studentName: string }[], key: string) =>
    write<{ count: number }>("POST", classId, "/teacher/roster", { students }, legacyKey(key)),
  /** GET /work/{id} with staff auth → Assignment (full questions incl. reference answers) */
  workDetailLegacy: (classId: string, id: string, key?: string) => get<Assignment>(classId, `/work/${enc(id)}`, {}, legacyKey(key)),
};

export type Api = typeof api;
