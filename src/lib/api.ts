import type {
  Assignment,
  Course,
  EventRecord,
  HubData,
  StudentSummary,
  Submission,
  AnalyticsMetrics,
  AnalyticsTable,
  SessionEvidence,
  QuestionEvidence,
  GenerationPolicy,
  Question,
  WorkPage,
  WorkOption,
  VerifiedKiwiContext,
  KiwiSyncStatus,
} from "../types";

let tokenProvider: ((force?: boolean) => Promise<string>) | undefined;
export function setKiwiTokenProvider(provider: (force?: boolean) => Promise<string>) {
  tokenProvider = provider;
}
export function hasKiwiIdentity() { return Boolean(tokenProvider); }

async function request<T>(
  path: string,
  options: RequestInit = {},
  teacherKey?: string,
  retry = true,
): Promise<T> {
  const token = tokenProvider ? await tokenProvider(false) : undefined;
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(teacherKey ? { "X-Teacher-Key": teacherKey } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && tokenProvider && retry) {
    await tokenProvider(true);
    return request(path, options, teacherKey, false);
  }
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

const query = (values: Record<string, string>) =>
  new URLSearchParams(values).toString();

const analyticsQuery = (classId: string, values: Record<string, string> = {}) =>
  query({ ...values, classId });
export const api = {
  kiwiContext: (classId: string) => request<VerifiedKiwiContext>(`/kiwi/context?${query({ classId })}`),
  kiwiStatus: (classId: string, key: string) => request<KiwiSyncStatus>(`/teacher/kiwi/status?${query({ classId })}`, {}, key),
  syncKiwi: (classId: string) => request<KiwiSyncStatus>(`/teacher/kiwi/sync?${query({ classId })}`, { method: "POST" }),
  mapKiwiMaterial: (classId: string, key: string, materialId: string, unitId: string) => request<KiwiSyncStatus>(`/teacher/kiwi/material?${query({ classId })}`, { method: "PUT", body: JSON.stringify({ materialId, unitId }) }, key),
  workOptions: (classId: string, key?: string) =>
    request<WorkOption[]>(`/work-options?${query({ classId })}`, {}, key),
  workDetail: (classId: string, id: string, key?: string) =>
    request<Assignment>(
      `/work/${encodeURIComponent(id)}?${query({ classId })}`,
      {},
      key,
    ),
  workPage: (classId: string, key: string, values: Record<string, string>) =>
    request<WorkPage>(
      `/teacher/work-page?${query({ ...values, classId })}`,
      {},
      key,
    ),
  policy: (classId: string, unitId: string) =>
    request<GenerationPolicy>(`/policy?${query({ classId, unitId })}`),
  policies: (classId: string, key: string) =>
    request<GenerationPolicy[]>(
      `/teacher/policies?${query({ classId })}`,
      {},
      key,
    ),
  savePolicy: (classId: string, data: GenerationPolicy, key: string) =>
    request<GenerationPolicy>(
      `/teacher/policies?${query({ classId })}`,
      { method: "PUT", body: JSON.stringify(data) },
      key,
    ),
  generate: (classId: string, data: object) =>
    request<Question>(`/ai/question?${query({ classId })}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  chat: (classId: string, data: object) =>
    request<{ response: string; source: "kiwi-ai" }>(
      `/ai/chat?${query({ classId })}`,
      { method: "POST", body: JSON.stringify(data) },
    ),
  chatHistory: (classId: string, studentId: string, threadId: string) =>
    request<{ prompt: string; response: string; createdAt: string }[]>(
      `/chat?${query({ classId, studentId, threadId })}`,
    ),
  metrics: (classId: string, key: string) =>
    request<AnalyticsMetrics>(
      `/teacher/analytics/metrics?${query({ classId })}`,
      {},
      key,
    ),
  analytics: (classId: string, key: string, values: Record<string, string>) =>
    request<AnalyticsTable>(
      `/teacher/analytics/table?${analyticsQuery(classId, values)}`,
      {},
      key,
    ),
  evidence: (classId: string, key: string, values: Record<string, string>) =>
    request<QuestionEvidence>(
      `/teacher/analytics/evidence?${analyticsQuery(classId, values)}`,
      {},
      key,
    ),
  session: (classId: string, key: string, sessionId: string, afterId = 0) =>
    request<SessionEvidence>(
      `/teacher/analytics/session?${query({ classId, sessionId, afterId: String(afterId) })}`,
      {},
      key,
    ),
  health: () => request<{ ok: boolean; aiAvailable: boolean }>("/health"),
  course: (classId: string) => request<Course>(`/course?${query({ classId })}`),
  saveCourse: (classId: string, course: Course, key: string) =>
    request<Course>(
      `/course?${query({ classId })}`,
      { method: "PUT", body: JSON.stringify(course) },
      key,
    ),
  event: (event: {
    classId: string;
    studentId: string;
    studentName: string;
    sessionId: string;
    type: string;
    questionId?: string;
    payload: Record<string, unknown>;
  }) =>
    request<{ id: number }>(`/events?${query({ classId: event.classId })}`, {
      method: "POST",
      body: JSON.stringify(event),
    }),
  studentEvents: (classId: string, studentId: string) =>
    request<EventRecord[]>(`/events?${query({ classId, studentId })}`),
  verifyTeacher: (classId: string, key: string) =>
    request<{ ok: boolean }>(`/teacher/verify?${query({ classId })}`, { method: "POST" }, key),
  summary: (classId: string, key: string) =>
    request<{ students: StudentSummary[]; totalEvents: number }>(
      `/teacher/summary?${query({ classId })}`,
      {},
      key,
    ),
  teacherEvents: (
    classId: string,
    key: string,
    studentId?: string,
    beforeId?: number,
  ) =>
    request<EventRecord[]>(
      `/teacher/events?${query({ classId, ...(studentId ? { studentId } : {}), ...(beforeId ? { beforeId: String(beforeId) } : {}) })}`,
      {},
      key,
    ),
  work: (classId: string, key?: string) =>
    request<Assignment[]>(`/work?${query({ classId })}`, {}, key),
  saveWork: (classId: string, data: object, key: string, id?: string) =>
    request<Assignment>(
      `/work${id ? `/${id}` : ""}?${query({ classId })}`,
      { method: id ? "PUT" : "POST", body: JSON.stringify(data) },
      key,
    ),
  workStatus: (
    classId: string,
    id: string,
    status: "draft" | "published",
    key: string,
  ) =>
    request<Assignment>(
      `/work/${id}/status?${query({ classId })}`,
      { method: "POST", body: JSON.stringify({ status }) },
      key,
    ),
  attachment: (classId: string, id: string, key?: string) =>
    request<{ name: string; type: string; data: string }>(
      `/work/${id}/attachment?${query({ classId })}`,
      {},
      key,
    ),
  submitWork: (
    classId: string,
    id: string,
    data: {
      studentId: string;
      studentName: string;
      sessionId?: string;
      requestId?: string;
      answers: Record<string, string>;
    },
  ) =>
    request<{
      id: string;
      attempt: number;
      submittedAt: string;
      replayed?: boolean;
    }>(`/work/${id}/submit?${query({ classId })}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  checkPractice: (
    classId: string,
    id: string,
    data: {
      studentId: string;
      studentName: string;
      questionId: string;
      sessionId?: string;
      answer: string;
      runOutput?: string;
    },
  ) =>
    request<{ correct: boolean; explanation: string }>(
      `/work/${id}/check?${query({ classId })}`,
      { method: "POST", body: JSON.stringify(data) },
    ),
  submissions: (
    classId: string,
    studentId?: string,
    key?: string,
    assignmentId?: string,
  ) =>
    request<Submission[]>(
      `/submissions?${query({ classId, ...(studentId ? { studentId } : {}), ...(assignmentId ? { assignmentId } : {}) })}`,
      {},
      key,
    ),
  grade: (
    classId: string,
    id: string,
    grade: number,
    feedback: string,
    key: string,
  ) =>
    request<{ id: string; grade: number }>(
      `/submissions/${id}/grade?${query({ classId })}`,
      { method: "POST", body: JSON.stringify({ grade, feedback }) },
      key,
    ),
  hub: (classId: string, key: string) =>
    request<HubData>(`/teacher/hub?${query({ classId })}`, {}, key),
  seedSamples: (classId: string, key: string) =>
    request<{ created: number }>(
      `/teacher/samples?${query({ classId })}`,
      { method: "POST" },
      key,
    ),
  importRoster: (
    classId: string,
    students: { studentId: string; studentName: string }[],
    key: string,
  ) =>
    request<{ count: number }>(
      `/teacher/roster?${query({ classId })}`,
      { method: "POST", body: JSON.stringify({ students }) },
      key,
    ),
};
