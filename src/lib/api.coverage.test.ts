import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api, ApiError, hasKiwiIdentity, isPreviewRequestMode, request, requestBlob, setDemoSessionHeader, setKiwiTokenProvider,
  setNameModeHeader, setPreviewHeader, setTeacherKeyHeader,
} from "./api";

/*
 * Coverage for the §8 API client: every method's HTTP method, path, query string and body (the 1:1 §6 endpoint map),
 * plus the transport edge cases api.test.ts does not reach (204/empty bodies, unknown statuses, filename* parsing).
 */

type Call = { url: string; init: RequestInit };
function stubFetch(make: () => Response = () => json({})): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return make();
  });
  return calls;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const headersOf = (call: Call) => call.init.headers as Record<string, string>;

afterEach(() => {
  vi.unstubAllGlobals();
  setKiwiTokenProvider(undefined);
  setTeacherKeyHeader(null);
  setDemoSessionHeader(null);
  setPreviewHeader(false);
  setNameModeHeader("names");
});

const B = { probe: 1 };
const body = B as never;
const C = "c1";

interface Row {
  call: () => Promise<unknown>;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  /** Expected JSON body; `undefined` means no body is sent. */
  body?: unknown;
  /** Expected X-Teacher-Key (legacy per-call keys). */
  key?: string;
}

const ROWS: Record<string, Row> = {
  // core (§6.1)
  health: { call: () => api.health(C), method: "GET", url: "/api/health?classId=c1" },
  me: { call: () => api.me(C), method: "GET", url: "/api/me?classId=c1" },
  course: { call: () => api.course(C), method: "GET", url: "/api/course?classId=c1" },
  saveCourse: { call: () => api.saveCourse(C, body), method: "PUT", url: "/api/course?classId=c1", body: B },
  timeRange: { call: () => api.timeRange(C, "this_week"), method: "GET", url: "/api/teacher/time-range?classId=c1&preset=this_week" },
  timeRangeCustom: {
    call: () => api.timeRange(C, "custom", { from: "2026-10-01", to: "2026-10-08" }), method: "GET",
    url: "/api/teacher/time-range?classId=c1&preset=custom&from=2026-10-01&to=2026-10-08",
  },
  demoSession: { call: () => api.demoSession(C, { studentId: "demo-ada" }), method: "POST", url: "/api/demo/session?classId=c1", body: { studentId: "demo-ada" } },
  demoLink: { call: () => api.demoLink(C, "s1"), method: "POST", url: "/api/teacher/demo-links?classId=c1", body: { studentId: "s1" } },

  // telemetry & kiwi (§6.2)
  event: { call: () => api.event(C, body), method: "POST", url: "/api/events?classId=c1", body: B },
  studentEvents: { call: () => api.studentEvents(C, "s1"), method: "GET", url: "/api/events?classId=c1&studentId=s1" },
  teacherEvents: { call: () => api.teacherEvents(C, { type: "code_run" }), method: "GET", url: "/api/teacher/events?classId=c1&type=code_run&paged=1" },
  dataHealth: { call: () => api.dataHealth(C, { from: "a", to: "b" }), method: "GET", url: "/api/teacher/data-health?classId=c1&from=a&to=b" },
  kiwiStatus: { call: () => api.kiwiStatus(C), method: "GET", url: "/api/teacher/kiwi/status?classId=c1" },
  syncKiwi: { call: () => api.syncKiwi(C), method: "POST", url: "/api/teacher/kiwi/sync?classId=c1" },
  mapKiwiMaterial: {
    call: () => api.mapKiwiMaterial(C, "m1", "u1"), method: "PUT", url: "/api/teacher/kiwi/material?classId=c1",
    body: { materialId: "m1", unitId: "u1" },
  },

  // student work (§6.3)
  workOptions: { call: () => api.workOptions(C), method: "GET", url: "/api/work-options?classId=c1" },
  workDetail: { call: () => api.workDetail(C, "w/1"), method: "GET", url: "/api/work/w%2F1?classId=c1" },
  workFile: { call: () => api.workFile(C, "w1", "f 1"), method: "GET", url: "/api/work/w1/files/f%201?classId=c1" },
  attachment: { call: () => api.attachment(C, "w1"), method: "GET", url: "/api/work/w1/attachment?classId=c1" },
  checkInClass: {
    call: () => api.checkInClass(C, "w1", { studentId: "s1", questionId: "q1", answer: "4" }), method: "POST",
    url: "/api/work/w1/check?classId=c1", body: { studentId: "s1", questionId: "q1", answer: "4" },
  },
  startAttempt: { call: () => api.startAttempt(C, "w1", "s1"), method: "POST", url: "/api/work/w1/start?classId=c1", body: { studentId: "s1" } },
  submitWork: {
    call: () => api.submitWork(C, "w1", { studentId: "s1", answers: { q1: "4" }, requestId: "r1" }), method: "POST",
    url: "/api/work/w1/submit?classId=c1", body: { studentId: "s1", answers: { q1: "4" }, requestId: "r1" },
  },
  mySubmissions: { call: () => api.mySubmissions(C, "s1"), method: "GET", url: "/api/submissions?classId=c1&studentId=s1" },
  mySubmissionsFor: { call: () => api.mySubmissions(C, "s1", "w1"), method: "GET", url: "/api/submissions?classId=c1&studentId=s1&assignmentId=w1" },
  getDraft: { call: () => api.getDraft(C, "w1", "s1"), method: "GET", url: "/api/drafts/w1?classId=c1&studentId=s1" },
  saveDraft: {
    call: () => api.saveDraft(C, "w1", { studentId: "s1", answers: {}, clientTs: 5, assignmentVersion: 2 }), method: "PUT",
    url: "/api/drafts/w1?classId=c1", body: { studentId: "s1", answers: {}, clientTs: 5, assignmentVersion: 2 },
  },

  // assignments, staff (§6.3)
  assignments: { call: () => api.assignments(C, { page: "2", status: "" }), method: "GET", url: "/api/teacher/assignments?classId=c1&page=2" },
  createAssignment: { call: () => api.createAssignment(C, body), method: "POST", url: "/api/teacher/assignments?classId=c1", body: B },
  assignmentDetail: { call: () => api.assignmentDetail(C, "w1"), method: "GET", url: "/api/teacher/assignments/w1?classId=c1" },
  updateAssignment: { call: () => api.updateAssignment(C, "w1", body), method: "PUT", url: "/api/teacher/assignments/w1?classId=c1", body: B },
  publishAssignment: { call: () => api.publishAssignment(C, "w1"), method: "POST", url: "/api/teacher/assignments/w1/publish?classId=c1", body: {} },
  publishAssignmentNow: {
    call: () => api.publishAssignment(C, "w1", null), method: "POST", url: "/api/teacher/assignments/w1/publish?classId=c1", body: { openAt: null },
  },
  unpublishAssignment: { call: () => api.unpublishAssignment(C, "w1"), method: "POST", url: "/api/teacher/assignments/w1/unpublish?classId=c1", body: {} },
  closeAssignment: { call: () => api.closeAssignment(C, "w1"), method: "POST", url: "/api/teacher/assignments/w1/close?classId=c1", body: {} },
  closeAssignmentAt: {
    call: () => api.closeAssignment(C, "w1", "2026-10-30T00:00:00Z"), method: "POST", url: "/api/teacher/assignments/w1/close?classId=c1",
    body: { closeAt: "2026-10-30T00:00:00Z" },
  },
  reopenAssignment: { call: () => api.reopenAssignment(C, "w1"), method: "POST", url: "/api/teacher/assignments/w1/reopen?classId=c1", body: {} },
  archiveAssignment: { call: () => api.archiveAssignment(C, "w1"), method: "POST", url: "/api/teacher/assignments/w1/archive?classId=c1", body: {} },
  unarchiveAssignment: { call: () => api.unarchiveAssignment(C, "w1"), method: "POST", url: "/api/teacher/assignments/w1/unarchive?classId=c1", body: {} },
  deleteAssignment: { call: () => api.deleteAssignment(C, "w1"), method: "DELETE", url: "/api/teacher/assignments/w1?classId=c1" },
  duplicateAssignment: {
    call: () => api.duplicateAssignment(C, "w1", { title: "Copy", shiftDays: 7 }), method: "POST",
    url: "/api/teacher/assignments/w1/duplicate?classId=c1", body: { title: "Copy", shiftDays: 7 },
  },
  assignmentStudents: {
    call: () => api.assignmentStudents(C, "w1", "to_grade", "g1"), method: "GET", url: "/api/teacher/assignments/w1/students?classId=c1&state=to_grade&groupId=g1",
  },
  clearPreviewSubmissions: {
    call: () => api.clearPreviewSubmissions(C, "w1"), method: "POST", url: "/api/teacher/assignments/w1/clear-preview?classId=c1", body: {},
  },
  previewCheck: {
    call: () => api.previewCheck(C, "w1", { question: body, answer: "4" }), method: "POST", url: "/api/teacher/assignments/w1/preview-check?classId=c1",
    body: { question: B, answer: "4" },
  },
  starterAssignments: { call: () => api.starterAssignments(C), method: "GET", url: "/api/teacher/starter-assignments?classId=c1" },
  addStarterAssignments: {
    call: () => api.addStarterAssignments(C, { keys: ["hw1"] }), method: "POST", url: "/api/teacher/starter-assignments?classId=c1", body: { keys: ["hw1"] },
  },
  uploadFile: { call: () => api.uploadFile(C, body), method: "POST", url: "/api/teacher/files?classId=c1", body: B },
  updateFile: { call: () => api.updateFile(C, "f1", { mountInR: true }), method: "PATCH", url: "/api/teacher/files/f1?classId=c1", body: { mountInR: true } },
  deleteFile: { call: () => api.deleteFile(C, "f1"), method: "DELETE", url: "/api/teacher/files/f1?classId=c1" },
  listFiles: { call: () => api.listFiles(C, { assignmentId: "w1" }), method: "GET", url: "/api/teacher/files?classId=c1&assignmentId=w1" },

  // grading (§6.4)
  gradingQueue: { call: () => api.gradingQueue(C, { assignmentId: "w1" }), method: "GET", url: "/api/teacher/grading/queue?classId=c1&assignmentId=w1" },
  submissionDetail: { call: () => api.submissionDetail(C, "sub1"), method: "GET", url: "/api/teacher/submissions/sub1?classId=c1" },
  saveGrade: { call: () => api.saveGrade(C, "sub1", body), method: "PUT", url: "/api/teacher/submissions/sub1/grade?classId=c1", body: B },
  releaseGrades: { call: () => api.releaseGrades(C, "w1"), method: "POST", url: "/api/teacher/assignments/w1/release?classId=c1", body: {} },
  releaseSomeGrades: {
    call: () => api.releaseGrades(C, "w1", ["sub1"]), method: "POST", url: "/api/teacher/assignments/w1/release?classId=c1", body: { submissionIds: ["sub1"] },
  },
  unreleaseGrade: { call: () => api.unreleaseGrade(C, "sub1"), method: "POST", url: "/api/teacher/submissions/sub1/unrelease?classId=c1", body: {} },
  gradebook: { call: () => api.gradebook(C, {}), method: "GET", url: "/api/teacher/gradebook?classId=c1" },
  gradesCsv: { call: () => api.gradesCsv(C, { policy: "best" }), method: "GET", url: "/api/teacher/exports/grades.csv?classId=c1&policy=best" },
  assignmentStatusCsv: {
    call: () => api.assignmentStatusCsv(C, { assignmentId: "w1" }), method: "GET", url: "/api/teacher/exports/assignment-status.csv?classId=c1&assignmentId=w1",
  },
  exerciseResults: { call: () => api.exerciseResults(C, "w1", { groupId: "g1" }), method: "GET", url: "/api/teacher/assignments/w1/results?classId=c1&groupId=g1" },

  // ai rules & chapters (§6.5)
  aiStatus: { call: () => api.aiStatus(C), method: "GET", url: "/api/teacher/ai/status?classId=c1" },
  platformRules: { call: () => api.platformRules(C), method: "GET", url: "/api/teacher/ai/platform-rules?classId=c1" },
  aiRulesOverview: { call: () => api.aiRulesOverview(C), method: "GET", url: "/api/teacher/ai/rules?classId=c1" },
  aiRuleScope: {
    call: () => api.aiRuleScope(C, { scope: "unit", unitId: "u1", groupId: "" }), method: "GET", url: "/api/teacher/ai/rules/scope?classId=c1&scope=unit&unitId=u1",
  },
  saveAiRule: { call: () => api.saveAiRule(C, body), method: "POST", url: "/api/teacher/ai/rules?classId=c1", body: B },
  copyAiRule: { call: () => api.copyAiRule(C, body), method: "POST", url: "/api/teacher/ai/rules/copy?classId=c1", body: B },
  aiRuleHistory: {
    call: () => api.aiRuleHistory(C, { scope: "course", unitId: "", groupId: "g1" }), method: "GET",
    url: "/api/teacher/ai/rules/history?classId=c1&scope=course&groupId=g1",
  },
  compareAiRules: { call: () => api.compareAiRules(C, 3, 4), method: "GET", url: "/api/teacher/ai/rules/compare?classId=c1&a=3&b=4" },
  aiRuleVersion: { call: () => api.aiRuleVersion(C, 7), method: "GET", url: "/api/teacher/ai/rules/versions/7?classId=c1" },
  restoreAiRule: { call: () => api.restoreAiRule(C, 7, "undo"), method: "POST", url: "/api/teacher/ai/rules/versions/7/restore?classId=c1", body: { note: "undo" } },
  resetAiRule: {
    call: () => api.resetAiRule(C, { scope: "unit", unitId: "u1", groupId: "" }), method: "POST", url: "/api/teacher/ai/rules/reset?classId=c1",
    body: { scope: "unit", unitId: "u1", groupId: "" },
  },
  testAiRule: { call: () => api.testAiRule(C, body), method: "POST", url: "/api/teacher/ai/test?classId=c1", body: B },
  aiTestSamples: { call: () => api.aiTestSamples(C, { unitId: "u1", groupId: "" }), method: "GET", url: "/api/teacher/ai/test-samples?classId=c1&unitId=u1" },
  saveAiTestSample: { call: () => api.saveAiTestSample(C, body), method: "POST", url: "/api/teacher/ai/test-samples?classId=c1", body: B },
  archiveAiTestSample: { call: () => api.archiveAiTestSample(C, "x 1"), method: "DELETE", url: "/api/teacher/ai/test-samples/x%201?classId=c1" },
  runAiTestSamples: { call: () => api.runAiTestSamples(C, body), method: "POST", url: "/api/teacher/ai/test-samples/run?classId=c1", body: B },
  setThisWeekChapter: { call: () => api.setThisWeekChapter(C, "u2"), method: "PUT", url: "/api/teacher/chapters/this-week?classId=c1", body: { unitId: "u2" } },
  chaptersSummary: { call: () => api.chaptersSummary(C), method: "GET", url: "/api/teacher/chapters/summary?classId=c1" },
  aiRuleHomeworkQuestions: {
    call: () => api.aiRuleHomeworkQuestions(C, "u1"), method: "GET", url: "/api/teacher/ai/rules/homework-questions?classId=c1&unitId=u1",
  },
  aiRuleHomeworkQuestionsAll: { call: () => api.aiRuleHomeworkQuestions(C), method: "GET", url: "/api/teacher/ai/rules/homework-questions?classId=c1" },
  policy: { call: () => api.policy(C, "u1"), method: "GET", url: "/api/policy?classId=c1&unitId=u1" },

  // ai runtime (§6.6)
  chat: { call: () => api.chat(C, body), method: "POST", url: "/api/ai/chat?classId=c1", body: B },
  chatHistory: { call: () => api.chatHistory(C, "s1", "t1"), method: "GET", url: "/api/chat?classId=c1&studentId=s1&threadId=t1" },
  generateItem: { call: () => api.generateItem(C, body), method: "POST", url: "/api/ai/question?classId=c1", body: B },
  generateSimilar: { call: () => api.generateSimilar(C, body), method: "POST", url: "/api/ai/similar?classId=c1", body: B },
  checkItem: { call: () => api.checkItem(C, "gi-1", { answer: "4" }), method: "POST", url: "/api/practice/items/gi-1/check?classId=c1", body: { answer: "4" } },
  practiceStatus: { call: () => api.practiceStatus(C, "u1"), method: "GET", url: "/api/practice/status?classId=c1&unitId=u1" },
  revealItem: { call: () => api.revealItem(C, "gi-1"), method: "POST", url: "/api/practice/items/gi-1/reveal?classId=c1", body: {} },
  verifyItem: {
    call: () => api.verifyItem(C, "gi-1", { runOutput: "[1] 4", ok: true }), method: "POST", url: "/api/practice/items/gi-1/verify?classId=c1",
    body: { runOutput: "[1] 4", ok: true },
  },
  generatedItems: { call: () => api.generatedItems(C, { origin: "free" }), method: "GET", url: "/api/teacher/ai/items?classId=c1&origin=free" },
  flagItem: { call: () => api.flagItem(C, "gi-1", "n"), method: "POST", url: "/api/teacher/ai/items/gi-1/flag?classId=c1", body: { note: "n" } },
  unflagItem: { call: () => api.unflagItem(C, "gi-1", "n"), method: "POST", url: "/api/teacher/ai/items/gi-1/unflag?classId=c1", body: { note: "n" } },
  retireItem: { call: () => api.retireItem(C, "gi-1", "n"), method: "POST", url: "/api/teacher/ai/items/gi-1/retire?classId=c1", body: { note: "n" } },
  restoreItem: { call: () => api.restoreItem(C, "gi-1", "n"), method: "POST", url: "/api/teacher/ai/items/gi-1/restore?classId=c1", body: { note: "n" } },
  flagTurn: { call: () => api.flagTurn(C, 5, "leak"), method: "POST", url: "/api/teacher/ai/turns/5/flag?classId=c1", body: { reason: "leak" } },
  unflagTurn: { call: () => api.unflagTurn(C, 5, "ok"), method: "POST", url: "/api/teacher/ai/turns/5/unflag?classId=c1", body: { reason: "ok" } },
  aiCallDetail: { call: () => api.aiCallDetail(C, 9), method: "GET", url: "/api/teacher/ai/calls/9?classId=c1" },

  // insights (§6.7)
  home: { call: () => api.home(C, { from: "a", to: "b", compareFrom: "c", compareTo: "d" }), method: "GET", url: "/api/teacher/home?classId=c1&from=a&to=b&compareFrom=c&compareTo=d" },
  attention: { call: () => api.attention(C, {}), method: "GET", url: "/api/teacher/attention?classId=c1" },
  attentionRules: { call: () => api.attentionRules(C), method: "GET", url: "/api/teacher/attention/rules?classId=c1" },
  saveAttentionRules: { call: () => api.saveAttentionRules(C, body), method: "PUT", url: "/api/teacher/attention/rules?classId=c1", body: B },
  reteach: { call: () => api.reteach(C, { includeResolved: true }), method: "GET", url: "/api/teacher/reteach?classId=c1&includeResolved=1" },
  reteachOpen: { call: () => api.reteach(C, { includeResolved: false }), method: "GET", url: "/api/teacher/reteach?classId=c1&includeResolved=0" },
  markReteach: { call: () => api.markReteach(C, body), method: "POST", url: "/api/teacher/reteach?classId=c1", body: B },
  updateReteach: { call: () => api.updateReteach(C, 3, { resolved: true }), method: "PATCH", url: "/api/teacher/reteach/3?classId=c1", body: { resolved: true } },
  analytics: { call: () => api.analytics(C, { group: "students" }), method: "GET", url: "/api/teacher/analytics/table?classId=c1&group=students" },
  answers: { call: () => api.answers(C, { assignmentId: "w1" }), method: "GET", url: "/api/teacher/analytics/answers?classId=c1&assignmentId=w1" },
  questionActivity: { call: () => api.questionActivity(C, "qa:1", 5), method: "GET", url: "/api/teacher/analytics/question-activity/qa%3A1?classId=c1&after=5" },
  questionActivityFirst: { call: () => api.questionActivity(C, "qa1"), method: "GET", url: "/api/teacher/analytics/question-activity/qa1?classId=c1" },
  timeline: { call: () => api.timeline(C, { studentId: "s1", where: "lab" }), method: "GET", url: "/api/teacher/timeline?classId=c1&studentId=s1&where=lab" },
  metrics: { call: () => api.metrics(C, {}), method: "GET", url: "/api/teacher/metrics?classId=c1" },
  trends: { call: () => api.trends(C, { unitId: "u1" }), method: "GET", url: "/api/teacher/trends?classId=c1&unitId=u1" },
  learningCurves: { call: () => api.learningCurves(C, {}), method: "GET", url: "/api/teacher/learning-curves?classId=c1" },
  timeOnTask: { call: () => api.timeOnTask(C, { assignmentId: "w1" }), method: "GET", url: "/api/teacher/time-on-task?classId=c1&assignmentId=w1" },
  conversationDigest: { call: () => api.conversationDigest(C, {}), method: "GET", url: "/api/teacher/ai-conversations/digest?classId=c1" },
  conversationThreads: { call: () => api.conversationThreads(C, { page: "1" }), method: "GET", url: "/api/teacher/ai-conversations/threads?classId=c1&page=1" },
  conversationThread: { call: () => api.conversationThread(C, "lab:s1:t1"), method: "GET", url: "/api/teacher/ai-conversations/threads/lab%3As1%3At1?classId=c1" },
  nextUncodedThread: { call: () => api.nextUncodedThread(C, {}), method: "GET", url: "/api/teacher/ai-conversations/next-uncoded?classId=c1" },
  codebook: { call: () => api.codebook(C), method: "GET", url: "/api/teacher/codebook?classId=c1" },
  createCode: { call: () => api.createCode(C, body), method: "POST", url: "/api/teacher/codebook?classId=c1", body: B },
  updateCode: { call: () => api.updateCode(C, "c 1", { label: "x" }), method: "PATCH", url: "/api/teacher/codebook/c%201?classId=c1", body: { label: "x" } },
  addConversationCode: { call: () => api.addConversationCode(C, body), method: "POST", url: "/api/teacher/ai-conversations/codes?classId=c1", body: B },
  removeConversationCode: { call: () => api.removeConversationCode(C, 4), method: "DELETE", url: "/api/teacher/ai-conversations/codes/4?classId=c1" },
  topicRules: { call: () => api.topicRules(C), method: "GET", url: "/api/teacher/topic-rules?classId=c1" },
  saveTopicRules: { call: () => api.saveTopicRules(C, []), method: "PUT", url: "/api/teacher/topic-rules?classId=c1", body: [] },

  // people, settings, governance, exports (§6.8)
  roster: { call: () => api.roster(C, { q: "ada" }), method: "GET", url: "/api/teacher/roster?classId=c1&q=ada" },
  importRoster: { call: () => api.importRoster(C, body), method: "POST", url: "/api/teacher/roster/import?classId=c1", body: B },
  updateRosterEntry: { call: () => api.updateRosterEntry(C, "s 1", { status: "dropped" }), method: "PATCH", url: "/api/teacher/roster/s%201?classId=c1", body: { status: "dropped" } },
  searchStudents: { call: () => api.searchStudents(C, "ada chen"), method: "GET", url: "/api/teacher/students/search?classId=c1&q=ada+chen" },
  studentProfile: { call: () => api.studentProfile(C, "s 1", { from: "a" }), method: "GET", url: "/api/teacher/students/s%201/profile?classId=c1&from=a" },
  groups: { call: () => api.groups(C), method: "GET", url: "/api/teacher/groups?classId=c1" },
  createGroup: { call: () => api.createGroup(C, body), method: "POST", url: "/api/teacher/groups?classId=c1", body: B },
  updateGroup: { call: () => api.updateGroup(C, "g1", { name: "A" }), method: "PATCH", url: "/api/teacher/groups/g1?classId=c1", body: { name: "A" } },
  archiveGroup: { call: () => api.archiveGroup(C, "g1"), method: "DELETE", url: "/api/teacher/groups/g1?classId=c1" },
  setGroupMembers: { call: () => api.setGroupMembers(C, "g1", ["s1"]), method: "PUT", url: "/api/teacher/groups/g1/members?classId=c1", body: { studentIds: ["s1"] } },
  randomizeGroups: { call: () => api.randomizeGroups(C, body), method: "POST", url: "/api/teacher/groups/randomize?classId=c1", body: B },
  groupHistory: { call: () => api.groupHistory(C, { studentId: "s1" }), method: "GET", url: "/api/teacher/groups/history?classId=c1&studentId=s1" },
  staff: { call: () => api.staff(C), method: "GET", url: "/api/teacher/staff?classId=c1" },
  createStaff: { call: () => api.createStaff(C, body), method: "POST", url: "/api/teacher/staff?classId=c1", body: B },
  updateStaff: { call: () => api.updateStaff(C, "st1", { role: "ta" }), method: "PATCH", url: "/api/teacher/staff/st1?classId=c1", body: { role: "ta" } },
  revokeStaff: { call: () => api.revokeStaff(C, "st1"), method: "DELETE", url: "/api/teacher/staff/st1?classId=c1" },
  settings: { call: () => api.settings(C), method: "GET", url: "/api/teacher/settings?classId=c1" },
  saveSettings: { call: () => api.saveSettings(C, body), method: "PUT", url: "/api/teacher/settings?classId=c1", body: B },
  audit: { call: () => api.audit(C, { page: "1" }), method: "GET", url: "/api/teacher/audit?classId=c1&page=1" },
  deleteStudentData: {
    call: () => api.deleteStudentData(C, "s1", { mode: "anonymize", confirm: "s1" }), method: "POST", url: "/api/teacher/students/s1/delete-data?classId=c1",
    body: { mode: "anonymize", confirm: "s1" },
  },
  retention: { call: () => api.retention(C), method: "GET", url: "/api/teacher/retention?classId=c1" },
  runRetention: { call: () => api.runRetention(C, "RUN RETENTION"), method: "POST", url: "/api/teacher/retention/run?classId=c1", body: { confirm: "RUN RETENTION" } },
  downloadExport: { call: () => api.downloadExport(C, "activity.csv", {}), method: "GET", url: "/api/teacher/exports/activity.csv?classId=c1" },
  coursePackage: { call: () => api.coursePackage(C), method: "GET", url: "/api/teacher/course-package.zip?classId=c1" },
  courseTemplates: { call: () => api.courseTemplates(C), method: "GET", url: "/api/teacher/course-templates?classId=c1" },
  importCoursePackage: { call: () => api.importCoursePackage(C, body), method: "POST", url: "/api/teacher/course-package/import?classId=c1", body: B },

  // legacy v0.5.1 methods (§6.9): a non-empty key overrides the context key
  workPage: { call: () => api.workPage(C, "k1", { view: "grading" }), method: "GET", url: "/api/teacher/work-page?classId=c1&view=grading", key: "k1" },
  policies: { call: () => api.policies(C, "k1"), method: "GET", url: "/api/teacher/policies?classId=c1", key: "k1" },
  savePolicy: { call: () => api.savePolicy(C, body, "k1"), method: "PUT", url: "/api/teacher/policies?classId=c1", body: B, key: "k1" },
  generate: { call: () => api.generate(C, B), method: "POST", url: "/api/ai/question?classId=c1", body: B },
  evidence: { call: () => api.evidence(C, "k1", { questionId: "q1" }), method: "GET", url: "/api/teacher/analytics/evidence?classId=c1&questionId=q1", key: "k1" },
  session: { call: () => api.session(C, "k1", "sess-1", 3), method: "GET", url: "/api/teacher/analytics/session?classId=c1&sessionId=sess-1&afterId=3", key: "k1" },
  sessionFirst: { call: () => api.session(C, "k1", "sess-1"), method: "GET", url: "/api/teacher/analytics/session?classId=c1&sessionId=sess-1&afterId=0", key: "k1" },
  hub: { call: () => api.hub(C, "k1"), method: "GET", url: "/api/teacher/hub?classId=c1", key: "k1" },
  grade: { call: () => api.grade(C, "sub1", 9, "ok", "k1"), method: "POST", url: "/api/submissions/sub1/grade?classId=c1", body: { grade: 9, feedback: "ok" }, key: "k1" },
  seedSamples: { call: () => api.seedSamples(C, "k1"), method: "POST", url: "/api/teacher/samples?classId=c1", key: "k1" },
  summary: { call: () => api.summary(C, "k1"), method: "GET", url: "/api/teacher/summary?classId=c1", key: "k1" },
  work: { call: () => api.work(C), method: "GET", url: "/api/work?classId=c1" },
  workWithKey: { call: () => api.work(C, "k1"), method: "GET", url: "/api/work?classId=c1", key: "k1" },
  saveWorkNew: { call: () => api.saveWork(C, B, "k1"), method: "POST", url: "/api/work?classId=c1", body: B, key: "k1" },
  saveWorkExisting: { call: () => api.saveWork(C, B, "k1", "w1"), method: "PUT", url: "/api/work/w1?classId=c1", body: B, key: "k1" },
  workStatus: { call: () => api.workStatus(C, "w1", "published", "k1"), method: "POST", url: "/api/work/w1/status?classId=c1", body: { status: "published" }, key: "k1" },
  submissions: { call: () => api.submissions(C, "s1", "k1", "w1"), method: "GET", url: "/api/submissions?classId=c1&studentId=s1&assignmentId=w1", key: "k1" },
  submissionsAll: { call: () => api.submissions(C), method: "GET", url: "/api/submissions?classId=c1" },
  metricsLegacy: { call: () => api.metricsLegacy(C, "k1"), method: "GET", url: "/api/teacher/analytics/metrics?classId=c1", key: "k1" },
  importRosterLegacy: {
    call: () => api.importRosterLegacy(C, [{ studentId: "s1", studentName: "Ada" }], "k1"), method: "POST", url: "/api/teacher/roster?classId=c1",
    body: { students: [{ studentId: "s1", studentName: "Ada" }] }, key: "k1",
  },
  workDetailLegacy: { call: () => api.workDetailLegacy(C, "w1", "k1"), method: "GET", url: "/api/work/w1?classId=c1", key: "k1" },
};

describe("API endpoint map (§8 → §6)", () => {
  it.each(Object.entries(ROWS))("%s", async (_name, row) => {
    const calls = stubFetch();
    await row.call();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(row.url);
    expect(call.init.method ?? "GET").toBe(row.method);
    if (row.body === undefined) {
      expect(call.init.body).toBeUndefined();
      expect(headersOf(call)["Content-Type"]).toBeUndefined();
    } else {
      expect(JSON.parse(String(call.init.body))).toEqual(row.body);
      expect(headersOf(call)["Content-Type"]).toBe("application/json");
    }
    expect(headersOf(call)["X-Teacher-Key"]).toBe(row.key);
  });

  it("legacy methods fall back to the context key when the per-call key is empty", async () => {
    const calls = stubFetch();
    setTeacherKeyHeader("context-key");
    await api.hub(C, "");
    await api.work(C);
    expect(headersOf(calls[0])["X-Teacher-Key"]).toBe("context-key");
    expect(headersOf(calls[1])["X-Teacher-Key"]).toBe("context-key");
  });

  it("returns the downloaded blob with a filename from the path", async () => {
    stubFetch(() => new Response("PK", { status: 200 }));
    const file = await api.coursePackage(C);
    expect(file.filename).toBe("course-package.zip");
    expect(await file.blob.text()).toBe("PK");
  });
});

describe("header state", () => {
  it("reports whether a Kiwi identity and preview mode are active", () => {
    expect(hasKiwiIdentity()).toBe(false);
    setKiwiTokenProvider(async () => "t");
    expect(hasKiwiIdentity()).toBe(true);
    expect(isPreviewRequestMode()).toBe(false);
    setPreviewHeader(true);
    expect(isPreviewRequestMode()).toBe(true);
  });

  it("treats empty header values as unset and keeps caller headers last", async () => {
    const calls = stubFetch();
    setTeacherKeyHeader("");
    setDemoSessionHeader("");
    setNameModeHeader("names");
    setKiwiTokenProvider(async () => "");
    await request("/x", { headers: { "X-Extra": "1" } });
    expect(headersOf(calls[0])).toEqual({ "X-Extra": "1" });
  });

  it("sends the bearer token from the provider without forcing a refresh", async () => {
    const calls = stubFetch();
    const forced: boolean[] = [];
    setKiwiTokenProvider(async (force) => {
      forced.push(Boolean(force));
      return "tok";
    });
    await api.me(C);
    expect(forced).toEqual([false]);
    expect(headersOf(calls[0]).Authorization).toBe("Bearer tok");
  });
});

describe("transport edge cases", () => {
  it("resolves 204 and empty bodies to undefined", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await expect(request("/x")).resolves.toBeUndefined();
    stubFetch(() => new Response("", { status: 200 }));
    await expect(request("/x")).resolves.toBeUndefined();
  });

  it("parses JSON success bodies", async () => {
    stubFetch(() => json({ ok: true, n: 2 }));
    await expect(request<{ ok: boolean; n: number }>("/x")).resolves.toEqual({ ok: true, n: 2 });
  });

  it("does not retry a 401 without a Kiwi token provider", async () => {
    const calls = stubFetch(() => json({ error: "Sign in again" }, 401));
    await expect(request("/x")).rejects.toMatchObject({ status: 401, code: "unauthenticated", message: "Sign in again" });
    expect(calls).toHaveLength(1);
  });

  it("refreshes the token only once when the retried request is still 401", async () => {
    const calls = stubFetch(() => json({}, 401));
    let refreshes = 0;
    setKiwiTokenProvider(async (force) => {
      if (force) refreshes += 1;
      return "tok";
    });
    await expect(request("/x")).rejects.toMatchObject({ status: 401, code: "unauthenticated", message: "Request failed (401)" });
    expect(calls).toHaveLength(2);
    expect(refreshes).toBe(1);
  });

  it("does not refresh when the caller disables the retry", async () => {
    const calls = stubFetch(() => json({}, 401));
    setKiwiTokenProvider(async () => "tok");
    await expect(request("/x", {}, { retry: false })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it.each([
    [400, "invalid_request"], [403, "forbidden"], [404, "not_found"], [405, "method_not_allowed"], [409, "conflict"],
    [422, "invalid_payload"], [429, "rate_limited"], [500, "internal_error"], [503, "unavailable"], [418, "request_failed"],
  ])("maps status %i without a server code to %s", async (status, code) => {
    stubFetch(() => new Response("", { status }));
    const error = (await request("/x").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.name).toBe("ApiError");
    expect(error).toMatchObject({ status, code, message: `Request failed (${status})` });
    expect(error.details).toBeUndefined();
  });

  it("explains network failures that are not Error objects", async () => {
    vi.stubGlobal("fetch", async () => {
      throw "offline";
    });
    await expect(request("/x")).rejects.toMatchObject({
      status: 0, code: "network_error", message: expect.stringContaining("(offline)"),
    });
  });

  it("maps blob download failures to ApiError with the server message", async () => {
    stubFetch(() => json({ error: "Export too large", code: "export_too_large" }, 413));
    await expect(requestBlob("/teacher/exports/research-package.zip")).rejects.toMatchObject({
      status: 413, code: "export_too_large", message: "Export too large",
    });
  });
});

describe("download filenames", () => {
  async function filenameFor(disposition: string | null, path = "/teacher/exports/fallback.csv"): Promise<string> {
    stubFetch(() => new Response("x", { status: 200, headers: disposition === null ? {} : { "Content-Disposition": disposition } }));
    return (await requestBlob(path)).filename;
  }

  it("prefers the RFC 5987 filename* parameter", async () => {
    expect(await filenameFor("attachment; filename=\"plain.csv\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20grades.csv")).toBe("résumé grades.csv");
  });
  it("falls back to the plain filename when filename* is malformed", async () => {
    expect(await filenameFor("attachment; filename*=UTF-8''%E0%A4%A; filename=\"safe.csv\"")).toBe("safe.csv");
  });
  it("accepts an unquoted plain filename", async () => {
    expect(await filenameFor("attachment; filename=grades.csv")).toBe("grades.csv");
  });
  it("uses the decoded path name when the header has no filename", async () => {
    expect(await filenameFor("attachment")).toBe("fallback.csv");
    expect(await filenameFor(null, "/teacher/exports/student/ada%20chen.zip?classId=c1")).toBe("ada chen.zip");
  });
  it("uses 'download' when the path has no name", async () => {
    expect(await filenameFor(null, "/")).toBe("download");
  });
});
