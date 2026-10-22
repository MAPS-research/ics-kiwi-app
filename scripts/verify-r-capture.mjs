/** Exercise the shared webR runner using real R in Node; this is not a browser UI test. */
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
const { runR, getRuntime } = await import(pathToFileURL(file).href);
try {
  const good = await runR('scores <- c(10,20,30); print(mean(scores))');
  assert.equal(good.ok, true); assert.match(good.output, /20/);
  const bad = await runR('print(review_v05_missing_object)');
  assert.equal(bad.ok, false); assert.match(bad.error, /not found/);
  const fixed = await runR('review_v05_missing_object <- 7; print(review_v05_missing_object)');
  assert.equal(fixed.ok, true); assert.match(fixed.output, /7/);
  console.log('Real R capture passed: printed mean, missing-object error, corrected run. Browser presentation remains a separate check.');
} finally { (await getRuntime()).close(); }
