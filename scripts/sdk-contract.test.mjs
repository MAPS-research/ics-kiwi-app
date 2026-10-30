import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appManifest, requiredScopes } from './app-manifest.mjs';

test('registration uses generic placements and minimum scopes', () => {
  const manifest = appManifest('https://lab.example.edu', '0.7.0');
  assert.deepEqual(manifest.uis.map(ui => ui.placement), ['class-tab', 'class-admin-panel']);
  assert.deepEqual(requiredScopes, ['context:student_learning:read', 'llm:prompt:lab-tutor']);
  assert(requiredScopes.includes(`llm:prompt:${manifest.prompts[0].promptId}`));
  assert(!('registrationSecret' in manifest));
});
test('manifest preview is read-only and never needs a host checkout or credentials', () => {
  const output = execFileSync(process.execPath, ['scripts/register-kiwi-app.mjs'], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).manifest.slug, 'ics-r-lab');
});
test('legacy database flags are rejected', () => {
  assert.throws(() => execFileSync(process.execPath, ['scripts/register-kiwi-app.mjs', '--list-classes'], { stdio: 'pipe' }),
    error => error.status === 1 && error.stderr.toString().includes('Host database access was removed'));
});
