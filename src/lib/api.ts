import type { Assignment, Course, EventRecord, HubData, StudentSummary, Submission } from '../types';

async function request<T>(path: string, options: RequestInit = {}, teacherKey?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(teacherKey ? { 'X-Teacher-Key': teacherKey } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}

const query = (values: Record<string, string>) => new URLSearchParams(values).toString();

export const api = {
  health: () => request<{ ok: boolean }>('/health'),
  course: (classId: string) => request<Course>(`/course?${query({ classId })}`),
  saveCourse: (classId: string, course: Course, key: string) =>
    request<Course>(`/course?${query({ classId })}`, { method: 'PUT', body: JSON.stringify(course) }, key),
  event: (event: {
    classId: string; studentId: string; studentName: string; sessionId: string;
    type: string; questionId?: string; payload: Record<string, unknown>;
  }) => request<{ id: number }>('/events', { method: 'POST', body: JSON.stringify(event) }),
  studentEvents: (classId: string, studentId: string) =>
    request<EventRecord[]>(`/events?${query({ classId, studentId })}`),
  verifyTeacher: (key: string) => request<{ ok: boolean }>('/teacher/verify', { method: 'POST' }, key),
  summary: (classId: string, key: string) =>
    request<{ students: StudentSummary[]; totalEvents: number }>(`/teacher/summary?${query({ classId })}`, {}, key),
  teacherEvents: (classId: string, key: string, studentId?: string, beforeId?: number) =>
    request<EventRecord[]>(`/teacher/events?${query({ classId, ...(studentId ? { studentId } : {}), ...(beforeId ? { beforeId: String(beforeId) } : {}) })}`, {}, key),
  work: (classId: string, key?: string) => request<Assignment[]>(`/work?${query({ classId })}`, {}, key),
  saveWork: (classId: string, data: object, key: string, id?: string) =>
    request<Assignment>(`/work${id ? `/${id}` : ''}?${query({ classId })}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) }, key),
  workStatus: (classId: string, id: string, status: 'draft' | 'published', key: string) =>
    request<Assignment>(`/work/${id}/status?${query({ classId })}`, { method: 'POST', body: JSON.stringify({ status }) }, key),
  attachment: (classId: string, id: string, key?: string) =>
    request<{ name: string; type: string; data: string }>(`/work/${id}/attachment?${query({ classId })}`, {}, key),
  submitWork: (classId: string, id: string, data: { studentId: string; studentName: string; answers: Record<string, string> }) =>
    request<{ id: string; attempt: number; submittedAt: string }>(`/work/${id}/submit?${query({ classId })}`, { method: 'POST', body: JSON.stringify(data) }),
  checkPractice: (classId: string, id: string, data: { studentId: string; studentName: string; questionId: string; answer: string; runOutput?: string }) =>
    request<{ correct: boolean; explanation: string }>(`/work/${id}/check?${query({ classId })}`, { method: 'POST', body: JSON.stringify(data) }),
  submissions: (classId: string, studentId?: string, key?: string) =>
    request<Submission[]>(`/submissions?${query({ classId, ...(studentId ? { studentId } : {}) })}`, {}, key),
  grade: (classId: string, id: string, grade: number, feedback: string, key: string) =>
    request<{ id: string; grade: number }>(`/submissions/${id}/grade?${query({ classId })}`, { method: 'POST', body: JSON.stringify({ grade, feedback }) }, key),
  hub: (classId: string, key: string) => request<HubData>(`/teacher/hub?${query({ classId })}`, {}, key),
  seedSamples: (classId: string, key: string) => request<{ created: number }>(`/teacher/samples?${query({ classId })}`, { method: 'POST' }, key),
  importRoster: (classId: string, students: { studentId: string; studentName: string }[], key: string) =>
    request<{ count: number }>(`/teacher/roster?${query({ classId })}`, { method: 'POST', body: JSON.stringify({ students }) }, key),
};
