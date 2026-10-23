#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { root, local, manifest, nodeVersion, runtimeName, nodeBinary, configureLocalDemo, redact, gitEnv, cloneFailureMessage } from './config.mjs';

async function run(command, args, cwd = root, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve()
      : reject(Object.assign(new Error(`${path.basename(command)} exited ${code}`), { exitCode: code })));
  });
}

async function ensureRuntime() {
  if (fs.existsSync(nodeBinary)) return;
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('This demo bootstrap currently supports macOS arm64/x64.');
  const directory = path.join(local, 'runtime'); fs.mkdirSync(directory, { recursive: true });
  const base = `https://nodejs.org/dist/v${nodeVersion}/`;
  const name = `${runtimeName}.tar.xz`;
  const checksums = await (await fetch(`${base}SHASUMS256.txt`, { signal: AbortSignal.timeout(60000) })).text();
  const expected = checksums.split('\n').find(line => line.trim().endsWith(` ${name}`))?.split(/\s+/)[0];
  if (!expected) throw new Error('Official Node checksum not found.');
  const response = await fetch(base + name, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Node download failed (${response.status}).`);
  const data = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(data).digest('hex') !== expected) throw new Error('Node checksum mismatch.');
  const archive = path.join(directory, name); fs.writeFileSync(archive, data);
  await run('tar', ['-xJf', archive, '-C', directory]);
}

try {
  fs.mkdirSync(local, { recursive: true });
  for (const [name, repository] of Object.entries(manifest)) {
    const checkout = path.join(local, name);
    if (!fs.existsSync(path.join(checkout, '.git'))) {
      // Private repositories: git must fail instead of waiting for a password nobody sees (GIT_TERMINAL_PROMPT=0)
      try {
        await run('git', ['clone', '--no-checkout', repository.url, checkout], root, gitEnv());
      } catch (error) {
        if (error.exitCode === undefined) throw error;   // git itself did not start (not installed)
        throw new Error(cloneFailureMessage(repository.url, error.exitCode), { cause: error });
      }
      await run('git', ['checkout', '--detach', repository.commit], checkout, gitEnv());
    }
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' });
    if (revision.status !== 0 || revision.stdout.trim() !== repository.commit) {
      throw new Error(`${name} is on a different commit. Review your local checkout and stack manifest before setup; existing changes are preserved.`);
    }
  }
  await ensureRuntime();
  configureLocalDemo();
  await run('docker', ['compose', '--env-file', '.local/infra.env', '-f', 'scripts/local-kiwi/compose.yaml', 'up', '-d', '--wait']);
  const env = { ...process.env, PATH: `${path.dirname(nodeBinary)}${path.delimiter}${process.env.PATH || ''}` };
  await run(nodeBinary, ['scripts/local-kiwi/backend-setup.mjs'], root, env);
  await run(nodeBinary, ['scripts/local-kiwi/backend-seed.mjs'], root, env);
  await run(nodeBinary, ['scripts/local-kiwi/upgrade-integration.mjs'], root, env);
  await run(nodeBinary, ['scripts/local-kiwi/frontend.mjs', 'setup'], root, env);
  console.log('Setup complete. Run npm run demo:start to launch Kiwi and the CSS App.');
} catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
