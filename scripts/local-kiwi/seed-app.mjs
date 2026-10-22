#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { local, redact } from './config.mjs';
import { getDemoAppToken } from './app-session.mjs';

export async function seedDemoApp() {
  const credentials = JSON.parse(fs.readFileSync(path.join(local, 'demo-credentials.json'), 'utf8'));
  const { accessToken } = await getDemoAppToken('teacher');
  const classId = credentials.classId;
  const base = `http://127.0.0.1:8101/api`;
  async function request(route, body) {
    const response = await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}classId=${encodeURIComponent(classId)}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Demo App request failed (${response.status})`);
    return data;
  }
  const works = await request('/work');
  const definitions = [
    { kind: 'practice', title: 'Demo · R basics and means', unitId: 'r-basics', instructions: 'Check answers, run R, ask Kiwi about your reasoning, and generate similar exercises.', questions: [
      { id: 'demo-mean-choice', type: 'choice', prompt: 'What is the result of mean(c(2, 4, 6))?', points: 5, choices: ['2', '4', '6', '12'], starterCode: '', answer: '4', explanation: 'The mean is (2 + 4 + 6) / 3 = 4.' },
      { id: 'demo-index-fill', type: 'fill', prompt: 'Write an expression that extracts the second element of x.', points: 5, choices: [], starterCode: 'x <- c(10, 20, 30)', answer: 'x[2]', explanation: 'R indices start at 1.' },
    ] },
    { kind: 'homework', title: 'Demo · CSS data analysis homework', unitId: 'data-wrangling', instructions: 'Run and debug R, then use your code as the answer. Add a written explanation and submit. Your teacher can review your learning history and grade your submission.', questions: [
      { id: 'demo-homework-code', type: 'complete', prompt: 'Calculate the mean of scores. Run your code and save the completed code as your answer.', points: 10, choices: [], starterCode: 'scores <- c(60, 75, 90)\n# TODO: calculate and print the mean', answer: 'scores <- c(60, 75, 90)\nprint(mean(scores))', explanation: 'Use mean(scores); the expected output is [1] 75.' },
      { id: 'demo-homework-text', type: 'text', prompt: 'Explain what a mean represents and one data characteristic it may hide.', points: 10, choices: [], starterCode: '', answer: 'A mean represents an average level but does not describe variation or outliers on its own.', explanation: 'Grade the explanation, evidence, and awareness of limitations.' },
    ] },
  ];
  const legacyTitles = { 'Demo · R basics and means': 'Demo · R 基础与均值练习', 'Demo · CSS data analysis homework': 'Demo · CSS 数据分析作业' };
  for (const definition of definitions) {
    let work = works.find(item => item.title === definition.title || item.title === legacyTitles[definition.title]);
    if (!work) work = await request('/work', { ...definition, dueAt: null });
    if (work.status !== 'published') await request(`/work/${work.id}/status`, { status: 'published' });
  }
  await request('/teacher/roster', { students: [{ studentId: credentials.student.id, studentName: 'Demo Student' }] });
  console.log(`Two demonstration assignments and the student roster are ready in ${classId}.`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  seedDemoApp().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
}
