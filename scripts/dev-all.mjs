import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const commands = [
  [process.env.KIWI_PYTHON || (existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3'), ['server/app.py']],
  ['npm', ['run', 'dev']],
];
const children = commands.map(([command, args]) => spawn(command, args, { stdio: 'inherit' }));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250).unref();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
for (const child of children) {
  child.on('error', error => { console.error(error); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 1); });
}
