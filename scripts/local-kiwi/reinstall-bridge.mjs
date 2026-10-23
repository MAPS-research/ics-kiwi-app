#!/usr/bin/env node
/**
 * Reinstall the CSS Lab bridge into the local Kiwi backend (spec §15.4, TELEMETRY):
 *   1. copy the bridge controller and its Jest spec (backend-patches.mjs; every local patch is idempotent),
 *   2. `nest build` only (no `npm ci`, no schema change),
 *   3. upgrade-integration.mjs (app description, Kiwi chat tutoringMode "guidance", version; course content is kept).
 *      It writes to the demo PostgreSQL, which `npm run demo:stop` stops, so the demo database container is started
 *      first (`docker compose … up -d --wait db`; Kiwi API/UI and the app servers stay stopped).
 * Stop the demo first (`npm run demo:stop`) and start it again afterwards (`npm run demo:start` re-applies the UI
 * adapters). `--dry-run` only checks that the sources and the backend checkout exist.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { backendRoot, projectRoot, reportFailure } from './backend-common.mjs';
import { nodeBinary } from './config.mjs';

const dryRun = process.argv.includes('--dry-run');

function portInUse(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** Start only the demo PostgreSQL container (INTEGRATION: upgrade-integration.mjs needs it after demo:stop). */
function startDemoDatabase() {
  if (!fs.existsSync(path.join(projectRoot, '.local/infra.env'))) throw new Error('Missing .local/infra.env. Run `npm run demo:setup` first.');
  const result = spawnSync('docker', ['compose', '--env-file', '.local/infra.env', '-f', 'scripts/local-kiwi/compose.yaml', 'up', '-d', '--wait', 'db'],
    { cwd: projectRoot, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Could not start the demo database container. Is Docker Desktop running?');
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit',
      env: { ...process.env, PATH: `${path.dirname(command)}${path.delimiter}${process.env.PATH || ''}` } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(args[0] || command)} exited with code ${code}`)));
  });
}

try {
  if (!fs.existsSync(path.join(backendRoot, 'package.json'))) {
    throw new Error('No local Kiwi backend in .local/kiwi. Run `npm run demo:setup` first.');
  }
  for (const name of ['lab-bridge.controller.ts', 'lab-bridge.controller.spec.ts']) {
    if (!fs.existsSync(new URL(`./bridge/${name}`, import.meta.url))) throw new Error(`Missing scripts/local-kiwi/bridge/${name}.`);
  }
  const node = fs.existsSync(nodeBinary) ? nodeBinary : process.execPath;
  const nest = path.join(backendRoot, 'node_modules/@nestjs/cli/bin/nest.js');
  if (!fs.existsSync(nest)) throw new Error('The Kiwi backend has no installed dependencies. Run `npm run demo:setup` first.');
  if (dryRun) {
    console.log(`Would copy the bridge controller and spec into ${path.relative(projectRoot, backendRoot)}/src/kiwi-app, run nest build with ${node}, start the demo database container, then upgrade-integration.mjs.`);
  } else {
    if (await portInUse(3000)) console.warn('Kiwi is still running on port 3000; the new bridge is used after `npm run demo:stop` and `npm run demo:start`.');
    const { applyBackendPatches } = await import('./backend-patches.mjs');
    applyBackendPatches();
    console.log('Bridge controller and spec copied.');
    await run(node, [nest, 'build'], backendRoot);
    console.log('Kiwi backend rebuilt (nest build).');
    startDemoDatabase();
    await run(node, [path.join(projectRoot, 'scripts/local-kiwi/upgrade-integration.mjs')], projectRoot);
    console.log('Bridge reinstalled. Next: npm run demo:start, then npm run test:bridge (optional).');
  }
} catch (error) { reportFailure(error); }
