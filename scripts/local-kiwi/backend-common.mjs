import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const backendRoot = path.join(projectRoot, '.local/kiwi');
export const backendRequire = createRequire(path.join(backendRoot, 'package.json'));

export function checkRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error('Kiwi requires Node 24.15 or later; use the local Node runtime installed by the demo setup.');
  }
}

export function loadBackendEnvironment() {
  const envPath = path.join(backendRoot, '.env');
  if (!fs.existsSync(envPath)) throw new Error('Missing .local/kiwi/.env. Run the local demo environment setup first.');
  backendRequire('dotenv').config({ path: envPath, quiet: true, override: true });
  assertDemoDatabase();
}

export function assertDemoDatabase() {
  let target;
  try { target = new URL(process.env.DATABASE_URL || ''); }
  catch { throw new Error('Local demo DATABASE_URL is missing or invalid.'); }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      target.port !== '5433' || target.pathname !== '/kiwi_demo') {
    throw new Error('Refusing to modify a database outside the local Kiwi demo (localhost:5433/kiwi_demo).');
  }
}

export function createDemoDatabase() {
  assertDemoDatabase();
  const { PrismaClient } = backendRequire('@prisma/client');
  const { PrismaPg } = backendRequire('@prisma/adapter-pg');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 }) });
}

export async function runBackend(command, args = []) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: backendRoot,
      stdio: 'inherit',
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Backend command failed (${signal || code}): ${path.basename(command)}`)));
  });
}

export function reportFailure(error) {
  // Do not print environment variables, request headers, or nested SDK objects.
  let message = error instanceof Error ? error.message : 'Local backend operation failed.';
  for (const name of ['LLM_API_KEY', 'JWT_SECRET', 'SESSION_SECRET', 'OSS_ACCESS_KEY_SECRET', 'REDIS_PASSWORD', 'DATABASE_URL']) {
    const value = process.env[name];
    if (value) message = message.split(value).join('[redacted]');
  }
  message = message.replace(/(postgres(?:ql)?:\/\/[^\s:]+:)[^@\s]+@/g, '$1[redacted]@');
  console.error(message);
  process.exitCode = 1;
}
