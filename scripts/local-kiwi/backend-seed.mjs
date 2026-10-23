import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { backendRequire, checkRuntime, createDemoDatabase, loadBackendEnvironment, projectRoot, reportFailure } from './backend-common.mjs';

const classId = 'local-css-demo';
const appSlug = 'ics-r-lab';
const appUrl = 'http://127.0.0.1:8100';
const credentialsPath = path.join(projectRoot, '.local/demo-credentials.json');
const scopes = ['class:materials:chunks:read', 'class:analytics:read'];
const materialId = 'local-css-demo-context';
const documentId = 'local-css-demo-context-document';
const materialText = [
  'CSS - Computational Social Science: local demonstration course.',
  'Progress: R fundamentals, vectors, indexing, sequences and data cleaning.',
  'Later units: data frames and filtering, text normalization and word frequency, social networks and in-degree.',
  'Practice formats: multiple choice, fill in the blank, predict R output, complete R code, and short explanations.',
  'Homework: use R to inspect data, calculate summaries and explain findings; retain attempts, debugging and questions.',
  'For assigned homework, explain the reasoning and debugging steps without revealing a complete final solution.',
  'For reinforcement, vary the data while preserving the source question skill; keep the difficulty adjustable.',
  'This summary is demo context, not an official syllabus or a copy of the full course materials.',
].join('\n');

function loadCredentials() {
  if (fs.existsSync(credentialsPath)) {
    const stored = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    if (stored.classId !== classId || stored.appSlug !== appSlug ||
        !stored.teacher?.id || !stored.teacher?.password || !stored.student?.id || !stored.student?.password || !stored.registrationSecret) {
      throw new Error('Existing local demo credentials do not match this setup; preserve and inspect them before reseeding.');
    }
    fs.chmodSync(credentialsPath, 0o600);
    return stored;
  }
  const password = () => crypto.randomBytes(18).toString('base64url');
  const credentials = {
    version: 1, classId, appSlug,
    teacher: { id: '00000000-0000-4000-8000-000000000191', email: 'demo.teacher@css-kiwi.local', password: password() },
    student: { id: '00000000-0000-4000-8000-000000000192', email: 'demo.student@css-kiwi.local', password: password() },
    registrationSecret: password() + password(),
  };
  fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return credentials;
}

// A small valid PDF gives the official material viewer a real local object.
// Parsed chunks are seeded from the same source text; no parser or RAG claim is made.
function demoPdf() {
  const lines = materialText.split('\n').flatMap(line => line.match(/.{1,86}(?:\s|$)|.{1,86}/g) || []).map(line => line.trim());
  const escape = line => line.replace(/([\\()])/g, '\\$1');
  const stream = `BT /F1 11 Tf 48 742 Td 16 TL\n${lines.map((line, i) => `${i ? 'T* ' : ''}(${escape(line)}) Tj`).join('\n')}\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function storeDemoMaterial() {
  const endpoint = new URL(process.env.OSS_ENDPOINT || '');
  if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.port !== '9002') {
    throw new Error('Refusing to upload demonstration content outside local object storage on port 9002.');
  }
  const { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand } = backendRequire('@aws-sdk/client-s3');
  const storage = new S3Client({
    endpoint: endpoint.href, forcePathStyle: true, region: process.env.OSS_REGION || 'us-east-1',
    credentials: { accessKeyId: process.env.OSS_ACCESS_KEY_ID, secretAccessKey: process.env.OSS_ACCESS_KEY_SECRET },
  });
  const key = 'css-demo/course-context.pdf';
  try {
    try { await storage.send(new HeadBucketCommand({ Bucket: process.env.OSS_BUCKET })); }
    catch (error) {
      if (error.$metadata?.httpStatusCode !== 404) throw error;
      await storage.send(new CreateBucketCommand({ Bucket: process.env.OSS_BUCKET }));
    }
    await storage.send(new PutObjectCommand({ Bucket: process.env.OSS_BUCKET, Key: key, Body: demoPdf(), ContentType: 'application/pdf' }));
  }
  finally { storage.destroy(); }
  return key;
}

let database;
try {
  checkRuntime();
  loadBackendEnvironment();
  const credentials = loadCredentials();
  const bcrypt = backendRequire('bcryptjs');
  database = createDemoDatabase();
  const users = [];
  for (const [account, systemRole] of [[credentials.teacher, 'admin'], [credentials.student, 'user']]) {
    const passwordSalt = await bcrypt.genSalt(10);
    const fields = { oauthId: `css-demo-${account.id}`, oauth: false, consent: true, systemRole,
      passwordSalt, passwordHash: await bcrypt.hash(account.password, passwordSalt) };
    const user = await database.user.upsert({ where: { email: account.email }, update: fields, create: { id: account.id, email: account.email, ...fields } });
    users.push(user);
    await database.userWhitelist.upsert({ where: { email: account.email }, update: { status: 'enabled' }, create: { email: account.email, status: 'enabled' } });
  }
  const [teacher, student] = users;
  const classMetadata = {
    className: 'CSS - Computational Social Science (Local Demo)',
    professorName: 'Local Demo Teacher', professorEmail: teacher.email,
    description: 'Isolated local CSS/R demonstration course. Not connected to a production class.',
    systemPrompts: { defaultSystemMessage: 'You are a CSS and R teaching assistant. Explain reasoning clearly, help students debug, and follow the tutoring rules provided by the active app. ' + materialText },
  };
  await database.class.upsert({ where: { id: classId }, update: { classMetadata, professorId: teacher.id }, create: { id: classId, classMetadata, professorId: teacher.id } });
  await database.instructorClass.upsert({ where: { userId_classId: { userId: teacher.id, classId } }, update: { isActive: true, role: 'instructor' }, create: { userId: teacher.id, classId, role: 'instructor', isActive: true, permissions: { canManageMaterials: true, canViewAnalytics: true } } });
  for (const [userId, role] of [[teacher.id, 'instructor'], [student.id, 'student']]) {
    await database.enrollment.upsert({ where: { classId_userId: { classId, userId } }, update: { role }, create: { classId, userId, role } });
  }
  await database.featureFlag.upsert({ where: { id: 'local-css-demo-r-language' }, update: { feature: 'RLanguageClass', classId }, create: { id: 'local-css-demo-r-language', feature: 'RLanguageClass', classId } });
  await database.kiwiAppWhitelist.upsert({ where: { slug: appSlug }, update: { status: 'approved', baseUrl: appUrl, maxScopes: scopes },
    create: { slug: appSlug, baseUrl: appUrl, registrationSecret: await bcrypt.hash(credentials.registrationSecret, 10), status: 'approved', maxScopes: scopes, approvedBy: teacher.id, description: 'Local CSS demo only' } });
  // [AU-D2-24] no "Adaptive" claim; [AU-D2-11] tutoringMode "guidance": Kiwi's own chat on Lab pages gives hints, not answers.
  const appFields = { name: 'CSS Kiwi R Lab', description: 'R practice, assignments and teacher analytics.', baseUrl: appUrl,
    version: JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version,
    appType: 'frontend_only', category: 'plugin', isActive: true, capabilities: ['auth', 'frontend-actions'], config: { tutoringMode: 'guidance' } };
  const app = await database.kiwiApp.upsert({ where: { slug: appSlug }, update: appFields, create: { slug: appSlug, ...appFields } });
  for (const fields of [
    { uiSlug: 'student', uiName: 'CSS R Practice', uiUrl: `${appUrl}/student`, placement: 'class-tab', allowedRoles: ['student', 'ta', 'instructor', 'professor', 'admin'] },
    { uiSlug: 'teacher', uiName: 'CSS Teacher Workspace', uiUrl: `${appUrl}/teacher`, placement: 'admin-panel', allowedRoles: ['ta', 'instructor', 'professor', 'admin'] },
  ]) {
    await database.kiwiAppUI.upsert({ where: { appId_uiSlug: { appId: app.id, uiSlug: fields.uiSlug } }, update: { ...fields, isEnabled: true }, create: { appId: app.id, ...fields, isEnabled: true } });
  }
  await database.classKiwiApp.upsert({ where: { classId_appId: { classId, appId: app.id } }, update: { isEnabled: true, enabledScopes: scopes },
    create: { classId, appId: app.id, isEnabled: true, tabLabel: 'CSS R Lab', enabledScopes: scopes, enabledBy: teacher.id } });
  const fileUrl = await storeDemoMaterial();
  const materialFields = { classId, title: 'CSS local demonstration context', materialType: 'class materials',
    materialMetadata: { name: 'CSS local demonstration context' }, materialContent: materialText, status: 'processed', lifecycle: 'PUBLISHED' };
  await database.classMaterial.upsert({ where: { id: materialId }, update: materialFields, create: { id: materialId, ...materialFields } });
  const chunks = materialText.split('\n').map((text, index) => ({ element_id: `${documentId}:${index}`, type: 'CompositeElement', text, metadata: { page_number: 1 } }));
  const docFields = { fileName: 'CSS-demo-course-context.pdf', fileUrl, classMaterialId: materialId, chunks,
    role: 'STUDENT', isStudent: true, isLlm: true, processingStatus: 'READY', processedAt: new Date() };
  await database.document.upsert({ where: { id: documentId }, update: docFields, create: { id: documentId, ...docFields } });
  console.log(`Local teacher, student, class ${classId}, course context and ${appSlug} app are ready.`);
  console.log('Passwords are stored only in .local/demo-credentials.json (permissions 600).');
} catch (error) { reportFailure(error); }
finally { if (database) await database.$disconnect(); }
