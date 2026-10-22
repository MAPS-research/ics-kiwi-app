/** Use the same password + app-token exchange as the real host. Never log tokens. */
import fs from 'node:fs';
import path from 'node:path';
import { local } from './config.mjs';

export async function getDemoAppToken(role = 'teacher') {
  const credentials = JSON.parse(fs.readFileSync(path.join(local, 'demo-credentials.json'), 'utf8'));
  const account = credentials[role];
  const login = await fetch('http://localhost:3000/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }), signal: AbortSignal.timeout(10000),
  });
  if (!login.ok) throw new Error(`Local ${role} password login failed (${login.status}). Run the integration upgrade to restore the retained local demo credentials.`);
  const { accessToken } = await login.json();
  const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const response = await fetch('http://localhost:3000/api/kiwi-apps/ics-r-lab/token', {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ classId: credentials.classId }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Local ${role} app-token exchange failed (${response.status}).`);
  return { ...(await response.json()), classId: credentials.classId, userId: account.id };
}
