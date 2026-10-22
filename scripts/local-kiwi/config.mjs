import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const local = path.join(root, '.local');
export const nodeVersion = '24.21.0';
export const manifest = {
  kiwi: { url: 'https://github.com/NYUSH-ML/kiwi.git', commit: '2fe8d2d331dc619a1e22fe2fa61df2758ba7b353' },
  'kiwi-ui': { url: 'https://github.com/NYUSH-ML/kiwi-ui.git', commit: 'fbc29beab4c6063c07fcf273d89e7237fad850b7' },
};
export const runtimeName = `node-v${nodeVersion}-darwin-${process.arch}`;
export const nodeBinary = path.join(local, 'runtime', runtimeName, 'bin/node');

export function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return [];
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    return [[match[1], value]];
  }));
}

function privateEnv(file, values) {
  fs.writeFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function configureLocalDemo() {
  fs.mkdirSync(local, { recursive: true });
  const project = readEnv(path.join(root, '.env'));
  const key = project.OPEN_AI_TEST_KEY || project.OPENAI_API_KEY;
  if (!key) throw new Error('Add OPEN_AI_TEST_KEY to the project .env before running demo:setup.');
  fs.writeFileSync(path.join(local, 'app-access.json'), JSON.stringify({ teacherKey: project.KIWI_TEACHER_KEY || 'kiwi-local-demo' }) + '\n', { mode: 0o600 });
  fs.chmodSync(path.join(local, 'app-access.json'), 0o600);
  const infraPath = path.join(local, 'infra.env');
  let infra = readEnv(infraPath);
  if (!Object.keys(infra).length) {
    infra = { KIWI_DEMO_DB_PASSWORD: crypto.randomBytes(18).toString('hex'), KIWI_DEMO_OSS_USER: 'css-kiwi-demo', KIWI_DEMO_OSS_PASSWORD: crypto.randomBytes(18).toString('hex') };
    privateEnv(infraPath, infra);
  }
  const backendEnvPath = path.join(local, 'kiwi/.env');
  const old = readEnv(backendEnvPath);
  const secret = name => old[name] || crypto.randomBytes(32).toString('hex');
  const model = project.KIWI_DEMO_MODEL || 'gpt-5.4-mini';
  privateEnv(backendEnvPath, {
    DATABASE_URL: `postgresql://kiwi_demo:${infra.KIWI_DEMO_DB_PASSWORD}@127.0.0.1:5433/kiwi_demo`,
    PORT: '3000', JWT_SECRET: secret('JWT_SECRET'), SESSION_SECRET: secret('SESSION_SECRET'),
    GOOGLE_CLIENT_ID: 'local-demo-unused', GOOGLE_CLIENT_SECRET: 'local-demo-unused', GOOGLE_CALLBACK_URL: 'http://localhost:3000/auth/google', GOOGLE_DOMAIN: '',
    LLM_API_KEY: key, LLM_BASE_URL: 'https://api.openai.com/v1', LLM_CHAT_MODEL: model, LLM_EMBEDDING_MODEL: 'text-embedding-3-small', LLM_TOKEN_LIMIT: '100000',
    QWEN_API_KEY: '', QWEN_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', QWEN_CHAT_MODEL: 'qwen-plus', QWEN_EMBEDDING_MODEL: 'text-embedding-v2', QWEN_VISION_MODEL: 'qwen-vl-max',
    PARSER: 'unstructured', UNSTRUCTURED_API_URL: 'http://127.0.0.1:9500',
    FRONTEND_URL: 'http://localhost:3001', SERVER_URL: 'http://localhost:3000', BASE_URL: 'localhost:3000', DEV_AUTH: 'false',
    REDIS_HOST: '127.0.0.1', REDIS_PORT: '6380', REDIS_PASSWORD: '',
    OSS_ACCESS_KEY_ID: infra.KIWI_DEMO_OSS_USER, OSS_ACCESS_KEY_SECRET: infra.KIWI_DEMO_OSS_PASSWORD, OSS_BUCKET: 'css-kiwi-demo', OSS_REGION: 'us-east-1', OSS_ENDPOINT: 'http://127.0.0.1:9002', OSS_VENDOR: 'minio',
    EMAIL_TEST_MODE: 'true', AWS_SES_SMTP_HOST: '127.0.0.1', AWS_SES_SMTP_PORT: '1025', AWS_SES_SMTP_USER: 'local-demo-unused', AWS_SES_SMTP_PASSWORD: 'local-demo-unused', AWS_SES_FROM_EMAIL: 'noreply@css-kiwi.local', AWS_SES_FROM_NAME: 'CSS Kiwi Demo',
    COMPETITION_API_URL: 'http://127.0.0.1:8005', CODEGEN_API_URL: 'http://127.0.0.1:8001', NODE_ENV: 'development', LOG_LEVEL_DEBUG: 'false',
  });
  const publicSettings = { VITE_KIWI_ORIGIN: 'http://localhost:3001' };
  const projectEnvPath = path.join(root, '.env');
  const lines = fs.readFileSync(projectEnvPath, 'utf8').split(/\r?\n/).filter(line => !Object.keys(publicSettings).some(key => line.startsWith(`${key}=`)));
  fs.writeFileSync(projectEnvPath, lines.filter(Boolean).join('\n') + '\n' + Object.entries(publicSettings).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(projectEnvPath, 0o600);
  fs.writeFileSync(path.join(local, 'stack-manifest.json'), JSON.stringify({ nodeVersion, ...manifest, model, classId: 'local-css-demo', appSlug: 'ics-r-lab' }, null, 2) + '\n');
  console.log(`Local Kiwi configuration ready (${model}); credentials stay in .local/.`);
}

export function redact(message) {
  let text = String(message);
  const files = [path.join(root, '.env'), path.join(local, 'infra.env'), path.join(local, 'kiwi/.env')];
  for (const file of files) {
    for (const [name, value] of Object.entries(readEnv(file))) {
      if (value && /KEY|PASSWORD|SECRET|DATABASE_URL/.test(name)) text = text.split(value).join('[redacted]');
    }
  }
  return text.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]');
}
