#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { root, local, nodeBinary, redact, demoServices } from './config.mjs';
import { seedDemoApp } from './seed-app.mjs';

const registry = path.join(local, 'services.json');
// KIWI_API_PORT (shell, then .env, then 8101) moves the app API and its readiness check; Vite gets the same value.
// Resolved on use, so `demo:stop` works even when the port setting is broken.
const services = () => demoServices(nodeBinary);

async function healthy(service) {
  try {
    const response = await fetch(service.url, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) return false;
    if (service.name === 'kiwi-ui') return (await response.text()).includes('/src/main.tsx');
    const data = await response.json();
    return service.name === 'kiwi-api' ? data.status === 'ok' : data.ok === true && data.runtime === 'browser-webR';
  } catch { return false; }
}

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(registry, 'utf8')); } catch { return {}; }
}

function saveRegistry(records) {
  fs.writeFileSync(registry, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
}

function compose(args) {
  const result = spawnSync('docker', ['compose', '--env-file', '.local/infra.env', '-f', 'scripts/local-kiwi/compose.yaml', ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Docker demo services failed. Is Docker Desktop running?');
}

async function start() {
  if (!fs.existsSync(nodeBinary) || !fs.existsSync(path.join(local, 'demo-credentials.json'))) throw new Error('Run npm run demo:setup first.');
  fs.mkdirSync(path.join(local, 'logs'), { recursive: true });
  compose(['up', '-d', '--wait']);
  const records = readRegistry();
  for (const service of services()) {
    if (await healthy(service)) {
      records[service.name] ||= { reused: true, url: service.url };
      console.log(`${service.name}: already running`);
      continue;
    }
    const logfile = path.join(local, 'logs', `${service.name}.log`);
    const fd = fs.openSync(logfile, 'a', 0o600);
    const child = spawn(service.command, service.args, {
      cwd: root, detached: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, ...service.env, BROWSER: 'none', PATH: `${path.dirname(nodeBinary)}${path.delimiter}${process.env.PATH || ''}` },
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); fs.closeSync(fd);
    records[service.name] = { pid: child.pid, managed: true, url: service.url, logfile, command: service.command, args: service.args };
    saveRegistry(records);
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await healthy(service)) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`${service.name} is not ready. Private log: ${logfile}`);
    console.log(`${service.name}: ready`);
  }
  saveRegistry(records);
  await seedDemoApp();
  console.log('\nKiwi: http://localhost:3001/login');
  console.log('Student App: http://localhost:3001/local-css-demo/app/ics-r-lab');
  console.log('Teacher App: http://localhost:3001/admin/app/ics-r-lab/class/local-css-demo');
  console.log('Login accounts: .local/demo-credentials.json');
}

async function stop() {
  for (const [name, record] of Object.entries(readRegistry())) {
    if (!record.managed || !record.pid) continue;
    const command = spawnSync('ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' }).stdout || '';
    const cwd = spawnSync('lsof', ['-a', '-p', String(record.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).stdout || '';
    if ((!command.includes(root) && !cwd.includes(`n${root}\n`)) || !record.args.some(arg => command.includes(arg))) {
      console.log(`${name}: no owned process remains`); continue;
    }
    try { process.kill(-record.pid, 'SIGTERM'); console.log(`${name}: stopped`); } catch { /* already stopped */ }
  }
  fs.rmSync(registry, { force: true });
  compose(['stop']);
  console.log('Demo stopped. Database volumes and local App data are retained.');
}

try {
  const action = process.argv[2] || 'start';
  if (action === 'stop') await stop();
  else if (action === 'status') {
    for (const service of services()) console.log(`${service.name}: ${await healthy(service) ? 'ready' : 'offline'} (${service.url})`);
  } else if (action === 'start') await start();
  else throw new Error('Usage: start.mjs [start|stop|status]');
} catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
