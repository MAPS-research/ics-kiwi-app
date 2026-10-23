import fs from 'node:fs';
import path from 'node:path';
import { checkRuntime, projectRoot, reportFailure } from './backend-common.mjs';

// Run before browser review: password logins rotate the demo accounts' refresh
// tokens. During a live demo use demo:status or read-only database checks.
const apiBase = 'http://127.0.0.1:3000';
async function request(route, options = {}) {
  const response = await fetch(apiBase + route, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${route} returned HTTP ${response.status}.`);
  return response;
}

try {
  checkRuntime();
  const credentials = JSON.parse(fs.readFileSync(path.join(projectRoot, '.local/demo-credentials.json'), 'utf8'));
  const health = await (await request('/health')).json();
  if (health.status !== 'ok') throw new Error('Kiwi health check is not ready.');
  for (const [role, account, expectedSystemRole] of [
    ['teacher', credentials.teacher, 'admin'], ['student', credentials.student, 'user'],
  ]) {
    const login = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: account.email, password: account.password }) });
    const token = (await login.json()).accessToken;
    if (!token) throw new Error(`${role} password login did not return an access token.`);
    const headers = { Authorization: `Bearer ${token}`, Cookie: login.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ') };
    const profile = await (await request('/auth/profile', { headers })).json();
    const systemRole = await (await request('/auth/role', { headers })).json();
    if (profile.sub !== account.id || systemRole.role !== expectedSystemRole) throw new Error(`${role} session identity or role does not match the local demo.`);
    const enrollments = await (await request('/student/enrollments', { headers })).json();
    if (!enrollments.enrollments.some(enrollment => enrollment.classId === credentials.classId)) throw new Error(`${role} is not enrolled in the CSS demo class.`);
    const appTokenResponse = await request(`/api/kiwi-apps/${credentials.appSlug}/token`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ classId: credentials.classId }) });
    const appToken = await appTokenResponse.json();
    if (!appToken.scopes.includes('class:materials:chunks:read')) throw new Error(`${role} app token lacks its approved material scope.`);
    const chunks = await (await request(`/api/kiwi-apps/classes/${credentials.classId}/document-chunks`, { headers: { Authorization: `Bearer ${appToken.accessToken}` } })).json();
    const chunkCount = chunks.documents.reduce((count, document) => count + document.chunks.length, 0);
    if (!chunkCount) throw new Error(`${role} cannot read the local CSS demo material chunks.`);
    console.log(`${role}: password login, session, role, enrollment, app token and ${chunkCount} material chunks verified.`);
  }
  const anonymous = await fetch(apiBase + '/student/enrollments');
  if (anonymous.status !== 401) throw new Error('Protected student data unexpectedly allows anonymous access.');
  console.log('Local Kiwi backend checks passed. No OpenAI request was made by this check.');
} catch (error) { reportFailure(error); }
