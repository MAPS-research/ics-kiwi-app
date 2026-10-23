/**
 * Tests for the demo script helpers in config.mjs (`npm run test:scripts`; node:test, no dependencies).
 * Everything runs in temporary directories: nothing here reads or writes the project's .env or .local/.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { apiPort, appUiPort, cloneFailureMessage, configureLocalDemo, defaultApiPort, demoServices, gitEnv, readEnv } from './config.mjs';

const made = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-config-test-'));
  made.push(dir);
  return dir;
}
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

test('readEnv: the first line of a name wins, as in server/app.py', () => {
  const dir = tempDir();
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'DUP=first-secret\nONE="quoted value"\nDUP=second-secret\nTWO=a\nTWO=b\n# DUP=comment\n');
  const warnings = [];
  const values = readEnv(file, { warn: message => warnings.push(message) });
  assert.deepEqual(values, { DUP: 'first-secret', ONE: 'quoted value', TWO: 'a' });
  assert.deepEqual(warnings, ['Warning: .env sets DUP, TWO on more than one line; the first line of each is used.']);
  for (const secret of ['first-secret', 'second-secret']) assert.ok(!warnings[0].includes(secret), 'never prints a value');
  readEnv(file, { warn: message => warnings.push(message) });
  assert.equal(warnings.length, 1, 'one warning per file');
});

test('readEnv: no warning without duplicates; a missing file is empty', () => {
  const dir = tempDir();
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, "A=1\nB='two'\n");
  const warnings = [];
  assert.deepEqual(readEnv(file, { warn: message => warnings.push(message) }), { A: '1', B: 'two' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(readEnv(path.join(dir, 'missing.env')), {});
});

test('apiPort: the environment, then .env, then 8101', () => {
  assert.equal(defaultApiPort, '8101');
  assert.equal(apiPort({}, {}), '8101');
  assert.equal(apiPort({}, { KIWI_API_PORT: '8401' }), '8401');
  assert.equal(apiPort({ KIWI_API_PORT: '8402' }, { KIWI_API_PORT: '8401' }), '8402');
  assert.throws(() => apiPort({ KIWI_API_PORT: 'eighty' }, {}), /KIWI_API_PORT must be a port number, got "eighty"/);
  assert.throws(() => apiPort({ KIWI_API_PORT: '' }, { KIWI_API_PORT: '8401' }), /must be a port number/);
});

test('demoServices: the app API and its readiness check follow the port; Vite gets it too', () => {
  const services = Object.fromEntries(demoServices('/bin/node', '8402').map(s => [s.name, s]));
  assert.equal(services['app-api'].url, 'http://127.0.0.1:8402/api/health');
  assert.deepEqual(services['app-api'].env, { KIWI_API_PORT: '8402' });
  assert.equal(services['app-ui'].url, `http://127.0.0.1:${appUiPort}/api/health`);
  assert.deepEqual(services['app-ui'].env, { KIWI_API_PORT: '8402' });
  assert.deepEqual(services['app-ui'].args, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '8100', '--strictPort']);
  assert.equal(services['kiwi-api'].env, undefined);
  assert.equal(demoServices('/bin/node', '8101').find(s => s.name === 'app-api').url, 'http://127.0.0.1:8101/api/health');
});

test('gitEnv never lets git wait for a password', () => {
  const env = gitEnv({ PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '1' });
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'never');
  assert.equal(env.PATH, '/usr/bin');
});

test('cloneFailureMessage names the repository on exit code 128', () => {
  assert.match(cloneFailureMessage('https://github.com/NYUSH-ML/kiwi.git', 128), /^cannot access NYUSH-ML\/kiwi — check GitHub access/);
  assert.equal(cloneFailureMessage('https://github.com/NYUSH-ML/kiwi-ui.git', 1), 'git clone of NYUSH-ML/kiwi-ui failed (exit 1).');
});

test('configureLocalDemo no longer writes .local/app-access.json and says an old one can go', () => {
  const root = tempDir();
  const local = path.join(root, '.local');
  fs.mkdirSync(path.join(local, 'kiwi'), { recursive: true });
  // placeholders only: no real key, nothing is called
  fs.writeFileSync(path.join(root, '.env'), 'OPEN_AI_TEST_KEY=placeholder-not-a-key\nKIWI_TEACHER_KEY=placeholder-teacher\n');
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    configureLocalDemo({ root, local });
    assert.equal(fs.existsSync(path.join(local, 'app-access.json')), false);
    assert.ok(!lines.some(line => line.includes('app-access.json')));
    fs.writeFileSync(path.join(local, 'app-access.json'), '{"teacherKey":"placeholder-teacher"}\n', { mode: 0o600 });
    configureLocalDemo({ root, local });
  } finally {
    console.log = original;
  }
  const notice = lines.find(line => line.includes('app-access.json'));
  assert.match(notice, /no longer used/);
  assert.ok(!lines.some(line => line.includes('placeholder-teacher')), 'never prints the key');
  assert.equal(fs.readFileSync(path.join(local, 'app-access.json'), 'utf8'), '{"teacherKey":"placeholder-teacher"}\n', 'left for the user');
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /^VITE_KIWI_ORIGIN=http:\/\/localhost:3001$/m);
});
