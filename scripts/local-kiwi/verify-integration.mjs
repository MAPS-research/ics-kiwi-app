/** Real password/app-token/API checks against `npm run demo:start` (INTEGRATION-06). Does not create assignments or
 * learning events (the v0.6 batch check sends one unknown event type, which is rejected and only logged). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getDemoAppToken } from './app-session.mjs';
import { apiPort, local } from './config.mjs';

const teacher = await getDemoAppToken('teacher'), student = await getDemoAppToken('student');
const headers = session => ({ Authorization: `Bearer ${session.accessToken}` });
const checks = [];
async function check(name, url, expected, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  const body = await response.json();
  assert.equal(response.status, expected, `${name}: ${body.error || response.status}`);
  checks.push(name); return body;
}
const api = `http://127.0.0.1:${apiPort()}/api`, native = 'http://localhost:3000/api/kiwi-apps/ics-r-lab/lab';
const q = `classId=${teacher.classId}`;
const teacherContext = await check('teacher verified SSO', `${api}/kiwi/context?${q}`, 200, { headers: headers(teacher) });
assert.equal(teacherContext.canManageCourse, true); assert.equal(teacherContext.canViewAnalytics, true);
const studentContext = await check('student verified SSO', `${api}/kiwi/context?${q}`, 200, { headers: headers(student) });
assert.equal(studentContext.userId, student.userId); assert.equal(studentContext.canViewAnalytics, false);
await check('teacher no second access key', `${api}/teacher/verify?${q}`, 200, { method: 'POST', headers: headers(teacher) });
await check('student native export denied', `${native}/activity`, 403, { headers: headers(student) });
await check('anonymous native export denied', `${native}/activity`, 401);
await check('student teacher analytics denied', `${api}/teacher/analytics/metrics?${q}`, 403, { headers: { ...headers(student), 'X-Teacher-Key': 'kiwi-local-demo' } });
await check('standalone key cannot bypass linked class', `${api}/teacher/analytics/metrics?${q}`, 401, { headers: { 'X-Teacher-Key': 'kiwi-local-demo' } });
await check('cross-course access denied', `${api}/course?classId=other-course`, 403, { headers: headers(teacher) });
await check('other student private history denied', `${api}/events?${q}&studentId=${teacher.userId}`, 403, { headers: headers(student) });
const forged = { classId: teacher.classId, studentId: teacher.userId, studentName: 'Spoof', sessionId: 'blocked-test', type: 'ai_question', payload: {} };
await check('spoofed student write denied', `${api}/events?${q}`, 403, { method: 'POST', headers: { ...headers(student), 'Content-Type': 'application/json' }, body: JSON.stringify(forged) });
await check('body course cannot bypass identity', `${api}/events?classId=local-r-class`, 403, { method: 'POST', headers: { ...headers(student), 'Content-Type': 'application/json' }, body: JSON.stringify({ ...forged, studentId: student.userId }) });
const first = await check('native sync', `${api}/teacher/kiwi/sync?${q}`, 200, { method: 'POST', headers: headers(teacher) });
const rows = await check('native source table', `${api}/teacher/analytics/table?${q}&source=kiwi&group=sessions`, 200, { headers: headers(teacher) });
const evidence = [];
for (const row of rows.rows) {
  assert.equal(row.source, 'kiwi');
  const details = await check('native session evidence', `${api}/teacher/analytics/session?${q}&sessionId=${row.id}`, 200, { headers: headers(teacher) });
  for (const event of details.events) {
    assert.equal(event.source, 'kiwi'); assert.ok(event.upstreamId);
    if (String(event.payload.prompt).startsWith('Review v0.5 lecture')) assert.equal(event.payload.page, 1);
    evidence.push({ type: event.type, originalId: event.upstreamId, thread: event.payload.threadId, page: event.payload.page,
      hasCode: Boolean(event.payload.code), hasOutput: Boolean(event.payload.output), hasPrompt: Boolean(event.payload.prompt), hasResponse: Boolean(event.payload.response) });
  }
}
const second = await check('repeat sync', `${api}/teacher/kiwi/sync?${q}`, 200, { method: 'POST', headers: headers(teacher) });
assert.equal(first.nativeEvents, second.nativeEvents);
// v0.6 bridge (native-projection-v3, §15.1): metadata counts, Kiwi chat mode, per-student import progress.
assert.equal(typeof second.excludedByDesign, 'number', 'bridge metadata pass reports excludedByDesign');
assert.equal(typeof second.excludedNotEnrolled, 'number', 'bridge metadata pass reports excludedNotEnrolled');
assert.equal(second.nativeTutoringMode, 'guidance', 'upgrade-integration sets tutoringMode guidance (or a course override is reported)');
assert.ok(Array.isArray(second.perStudent));
const health = await check('data health', `${api}/teacher/data-health?${q}`, 200, { headers: headers(teacher) });
assert.equal(health.kiwi.excludedByDesign, second.excludedByDesign);
assert.ok(Array.isArray(health.outages));
const paged = await check('paged teacher events', `${api}/teacher/events?${q}&paged=1&limit=5`, 200, { headers: headers(teacher) });
assert.ok(Array.isArray(paged.events) && typeof paged.hasMore === 'boolean');
const rejected = await check('batch endpoint per-event result', `${api}/events/batch?${q}`, 200, { method: 'POST',
  headers: { ...headers(student), 'Content-Type': 'application/json' },
  body: JSON.stringify({ classId: student.classId, events: [{ eventId: `verify-${Date.now()}`, classId: student.classId, studentId: student.userId,
    studentName: '', sessionId: 'verify-integration', type: 'verify_integration_unknown_type', payload: {}, clientTs: Date.now(), tzOffsetMin: 0,
    seq: 1, schemaVersion: 2 }] }) });
assert.equal(rejected.results[0].status, 'rejected');
const hub = await check('unified teacher Data Hub', `${api}/teacher/hub?${q}`, 200, { headers: headers(teacher) });
const summary = { checkedAt: new Date().toISOString(), checks, nativeEvents: second.nativeEvents,
  excludedByDesign: second.excludedByDesign, excludedNotEnrolled: second.excludedNotEnrolled, nativeTutoringMode: second.nativeTutoringMode,
  sourceSessions: rows.rows.map(r => ({ kind: r.kind, interactions: r.interactions, codeRuns: r.codeRuns, successes: r.codeSuccesses, errors: r.codeErrors, questions: r.aiQuestions })),
  evidence, hubStudents: hub.students.length, repeatedSyncStable: true };
fs.writeFileSync(path.join(local, 'v0.6-integration-check.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ passed: checks.length, nativeEvents: second.nativeEvents, sessions: rows.rows.length, repeatedSyncStable: true }));
