#!/usr/bin/env node
/**
 * Bridge tests inside the local Kiwi checkouts (spec §15.3, [AU-T-17]; `npm run test:bridge`):
 *   - UI: applies frontend.mjs (host adapters + bridge UI test files) and runs Kiwi UI's vitest for the bridge tests;
 *   - backend: copies the controller and its spec and runs them with Kiwi's Jest (Node 24, `--experimental-vm-modules`).
 * KIWI_UI_DIR / KIWI_BACKEND_DIR point at other trees (e.g. temporary copies). When neither checkout exists the
 * script says so and exits 0 (documented skip).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const uiDir = process.env.KIWI_UI_DIR ? path.resolve(process.env.KIWI_UI_DIR) : path.join(root, '.local', 'kiwi-ui');
const backendDir = process.env.KIWI_BACKEND_DIR ? path.resolve(process.env.KIWI_BACKEND_DIR) : path.join(root, '.local', 'kiwi');
process.env.KIWI_UI_DIR = uiDir;

const has = dir => fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'node_modules'));

function run(command, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } });
    child.once('error', error => { console.error(error.message); resolve(1); });
    child.once('exit', code => resolve(code ?? 1));
  });
}

const results = [];
if (!has(uiDir) && !has(backendDir)) {
  console.log('Skipped bridge tests: .local/kiwi and .local/kiwi-ui are not set up (run `npm run demo:setup` first).');
  process.exit(0);
}
if (has(uiDir)) {
  const { applyFrontendPatches, BRIDGE_UI_TESTS } = await import('./frontend.mjs');
  await applyFrontendPatches();
  const vitest = path.join(uiDir, 'node_modules', 'vitest', 'vitest.mjs');
  const code = await run(process.execPath, [vitest, 'run', ...BRIDGE_UI_TESTS.map(name => `src/components/${name}`)], uiDir);
  results.push(['Kiwi UI bridge tests', code]);
} else {
  console.log(`Skipped Kiwi UI bridge tests: no installed checkout at ${uiDir}.`);
}
if (has(backendDir)) {
  const { installBridgeController } = await import('./backend-patches.mjs');
  const { nodeBinary } = await import('./config.mjs');
  installBridgeController(backendDir);
  const node = fs.existsSync(nodeBinary) ? nodeBinary : process.execPath;
  const jest = path.join(backendDir, 'node_modules', 'jest', 'bin', 'jest.js');
  const code = await run(node, ['--experimental-vm-modules', jest, 'src/kiwi-app/lab-bridge.controller.spec.ts'], backendDir);
  results.push(['Bridge controller spec', code]);
} else {
  console.log(`Skipped the bridge controller spec: no installed checkout at ${backendDir}.`);
}
for (const [name, code] of results) console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${name}`);
process.exit(results.some(([, code]) => code !== 0) ? 1 : 0);
