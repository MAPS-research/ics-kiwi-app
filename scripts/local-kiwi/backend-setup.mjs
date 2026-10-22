import fs from 'node:fs';
import path from 'node:path';
import { backendRoot, checkRuntime, createDemoDatabase, loadBackendEnvironment, projectRoot, reportFailure, runBackend } from './backend-common.mjs';
import { applyBackendPatches } from './backend-patches.mjs';

try {
  checkRuntime();
  if (!fs.existsSync(path.join(backendRoot, 'package.json'))) throw new Error('Clone NYUSH-ML/kiwi into .local/kiwi first.');
  await runBackend('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(projectRoot, '.local/npm-cache')]);
  loadBackendEnvironment();
  applyBackendPatches();
  const prismaCli = path.join(backendRoot, 'node_modules/prisma/build/index.js');
  await runBackend(process.execPath, [prismaCli, 'generate']);
  const database = createDemoDatabase();
  try { await database.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector'); }
  finally { await database.$disconnect(); }
  await runBackend(process.execPath, [prismaCli, 'migrate', 'deploy']);
  await runBackend(process.execPath, [path.join(backendRoot, 'node_modules/@nestjs/cli/bin/nest.js'), 'build']);
  console.log('Local Kiwi backend dependencies, schema and build are ready.');
} catch (error) { reportFailure(error); }
