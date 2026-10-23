/** Exercise the shared webR runner using real R in Node; this is not a browser UI test (plots need OffscreenCanvas). */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await fs.readFile(path.join(root, 'src/lib/rEngine.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  .replace('`${location.origin}/webr/`', JSON.stringify(path.join(root, 'node_modules/webr/dist/')));
await fs.mkdir(path.join(root, '.local'), { recursive: true });
const file = path.join(root, '.local/verify-r-engine.mjs');
await fs.writeFile(file, output);
globalThis.location = { origin: path.join(root, 'public') };
globalThis.window = globalThis;
const { runR, getRuntime, resetEnvironment } = await import(pathToFileURL(file).href);
try {
  const good = await runR('scores <- c(10,20,30); print(mean(scores))');
  assert.equal(good.ok, true); assert.match(good.output, /20/);
  const bad = await runR('print(review_v05_missing_object)');
  assert.equal(bad.ok, false); assert.match(bad.error, /not found/);
  const fixed = await runR('review_v05_missing_object <- 7; print(review_v05_missing_object)');
  assert.equal(fixed.ok, true); assert.match(fixed.output, /7/);
  // v0.6 (TELEMETRY-05): autoprint, per-context environments, run snapshot fields, structured entries
  const auto = await runR('scores <- c(72, 85, 91)\nmean(scores)', { envKey: 'assignment:a1:q1', graphics: false });
  assert.equal(auto.ok, true); assert.match(auto.output, /\[1\] 82\.66667/);
  assert.equal(auto.envKey, 'assignment:a1:q1'); assert.equal(auto.runSeq, 1);
  assert.deepEqual(auto.objectNames, ['scores']);
  assert.ok(auto.entries.some((e) => e.type === 'stdout' && /82\.66667/.test(e.text)));
  const other = await runR('exists("scores", inherits = FALSE)', { envKey: 'assignment:a1:q2', graphics: false });
  assert.match(other.output, /FALSE/, 'variables must not leak between questions');
  const again = await runR('length(scores)', { envKey: 'assignment:a1:q1', graphics: false });
  assert.match(again.output, /\[1\] 3/); assert.equal(again.runSeq, 2);
  const warned = await runR('as.numeric("x")\nprint(1)', { envKey: 'warn', graphics: false });
  assert.ok(warned.entries.some((e) => e.type === 'warning'), 'warnings are a separate stream');
  await resetEnvironment('assignment:a1:q1');
  const reset = await runR('exists("scores", inherits = FALSE)', { envKey: 'assignment:a1:q1', graphics: false });
  assert.match(reset.output, /FALSE/); assert.equal(reset.runSeq, 1);
  console.log('Real R capture passed: printed mean, missing-object error, corrected run, autoprint [1] 82.66667, per-question environments, warnings stream, reset. Browser plots remain a separate check.');
} finally { (await getRuntime()).close(); }
