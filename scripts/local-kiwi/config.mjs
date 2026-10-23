import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const local = path.join(root, '.local');
const projectRoot = root;
const localRoot = local;
export const nodeVersion = '24.21.0';
export const manifest = {
  kiwi: { url: 'https://github.com/NYUSH-ML/kiwi.git', commit: '2fe8d2d331dc619a1e22fe2fa61df2758ba7b353' },
  'kiwi-ui': { url: 'https://github.com/NYUSH-ML/kiwi-ui.git', commit: 'fbc29beab4c6063c07fcf273d89e7237fad850b7' },
};
export const runtimeName = `node-v${nodeVersion}-darwin-${process.arch}`;
export const nodeBinary = path.join(local, 'runtime', runtimeName, 'bin/node');

/** The ports of the App: the API port follows KIWI_API_PORT; the UI stays on 8100 (the Kiwi app registration uses it). */
export const defaultApiPort = '8101';
export const appUiPort = '8100';

const warnedDuplicates = new Set();

/**
 * Parse a dotenv file. The first line of a name wins, as in `server/app.py` (`load_dotenv`), so the API and these
 * scripts agree on which line counts; a name set on several lines gets one warning per file naming it (never its value).
 * `warn` is injectable for tests.
 */
export function readEnv(file, { warn = message => console.warn(message) } = {}) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  const repeated = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const name = match[1];
    if (Object.hasOwn(values, name)) {
      if (!repeated.includes(name)) repeated.push(name);
      continue; // WHY: first line wins (a later duplicate never replaces it)
    }
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    values[name] = value;
  }
  const key = `${path.resolve(file)}:${repeated.join(',')}`;
  if (repeated.length && !warnedDuplicates.has(key)) {
    warnedDuplicates.add(key);
    warn(`Warning: ${path.basename(file)} sets ${repeated.join(', ')} on more than one line; the first line of each is used.`);
  }
  return values;
}

/**
 * The App API port, resolved like `server/app.py`: the environment first, then the project `.env`, then 8101.
 * Throws for a value that is not a port number (the same check as `vite.config.ts`).
 */
export function apiPort(env = process.env, projectEnv = readEnv(path.join(root, '.env'))) {
  const value = env.KIWI_API_PORT !== undefined ? env.KIWI_API_PORT : projectEnv.KIWI_API_PORT ?? defaultApiPort;
  if (!/^\d{2,5}$/.test(String(value))) throw new Error(`KIWI_API_PORT must be a port number, got "${value}"`);
  return String(value);
}

/**
 * The services `npm run demo:start` launches and polls (start.mjs). The app API's URL follows `apiPort()`, and the API
 * and Vite both get that KIWI_API_PORT (Vite reads it from its environment only, never from .env).
 */
export function demoServices(node = nodeBinary, port = apiPort()) {
  const appEnv = { KIWI_API_PORT: port };
  return [
    { name: 'kiwi-api', url: 'http://localhost:3000/health', command: node, args: ['scripts/local-kiwi/backend-start.mjs'] },
    { name: 'kiwi-ui', url: 'http://localhost:3001/', command: node, args: ['scripts/local-kiwi/frontend.mjs', 'start'] },
    { name: 'app-api', url: `http://127.0.0.1:${port}/api/health`, command: 'python3', args: ['server/app.py'], env: appEnv },
    { name: 'app-ui', url: `http://127.0.0.1:${appUiPort}/api/health`, command: node,
      args: ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', appUiPort, '--strictPort'], env: appEnv },
  ];
}

/** Environment for git: never wait for a password prompt (a private repository without access fails at once). */
export function gitEnv(env = process.env) {
  // WHY GCM_INTERACTIVE: Git Credential Manager would otherwise open a sign-in window and wait just the same
  return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
}

/** What to say when `git clone` fails; exit code 128 is git's "fatal" (no access, repository not found, no network). */
export function cloneFailureMessage(url, code) {
  const repository = String(url).replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (code === 128) {
    return `cannot access ${repository} — check GitHub access (sign in with \`gh auth login\` or add an SSH key, `
      + `and make sure your account can open https://github.com/${repository}), then run npm run demo:setup again.`;
  }
  return `git clone of ${repository} failed (exit ${code}).`;
}

function privateEnv(file, values) {
  fs.writeFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** `root` and `local` are parameters only so tests can run this in a temporary directory. */
export function configureLocalDemo({ root = projectRoot, local = localRoot } = {}) {
  fs.mkdirSync(local, { recursive: true });
  const project = readEnv(path.join(root, '.env'));
  const key = project.OPEN_AI_TEST_KEY || project.OPENAI_API_KEY;
  if (!key) throw new Error('Add OPEN_AI_TEST_KEY to the project .env before running demo:setup.');
  // v0.6.0: no fallback teacher key. The standalone teacher workspace stays closed until KIWI_TEACHER_KEY is set.
  // The API reads the key from .env; nothing reads a copy, so none is written (.local/app-access.json is retired).
  if (!project.KIWI_TEACHER_KEY) {
    console.log('KIWI_TEACHER_KEY is not set: the standalone teacher workspace stays closed (Kiwi-linked courses are not affected).');
    console.log('To use it, add a long random value to .env, e.g.  KIWI_TEACHER_KEY=$(openssl rand -hex 24)  and restart the app API.');
  }
  if (fs.existsSync(path.join(local, 'app-access.json'))) {
    console.log('.local/app-access.json is no longer used and may hold an old copy of the teacher key; you can delete it (rm .local/app-access.json).');
  }
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
