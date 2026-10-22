import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { backendRoot, checkRuntime, loadBackendEnvironment, reportFailure } from './backend-common.mjs';

try {
  checkRuntime();
  loadBackendEnvironment();
  if (process.env.DEV_AUTH !== 'false') throw new Error('Local demo must use password authentication with DEV_AUTH=false.');
  if (process.env.EMAIL_TEST_MODE !== 'true') throw new Error('Local demo must use EMAIL_TEST_MODE=true.');
  if (process.env.PORT !== '3000') throw new Error('Local demo backend port must be 3000.');
  const entry = path.join(backendRoot, 'dist/main.js');
  if (!fs.existsSync(entry)) throw new Error('Backend build is missing. Run backend-setup.mjs first.');
  const child = spawn(process.execPath, [entry], { cwd: backendRoot, stdio: 'inherit', env: process.env });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.once('error', reportFailure);
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { reportFailure(error); }
