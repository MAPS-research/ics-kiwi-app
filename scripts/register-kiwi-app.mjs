#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { appManifest, requiredScopes } from './app-manifest.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[i + 1];
};
function origin(value) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      !(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) {
    throw new Error('Use an HTTPS origin or loopback HTTP origin');
  }
  return u.origin;
}
try {
  if (args.some(a => a.startsWith('--') && !['--app-url', '--kiwi-api', '--register'].includes(a))) {
    throw new Error('Supported options: --app-url ORIGIN, --kiwi-api ORIGIN, --register. Host database access was removed.');
  }
  const appUrl = origin(option('--app-url', process.env.KIWI_R_LAB_BASE_URL || 'http://127.0.0.1:8100'));
  const kiwi = origin(option('--kiwi-api', process.env.KIWI_API_ORIGIN || 'http://localhost:3000'));
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = appManifest(appUrl, version);
  if (!args.includes('--register')) {
    console.log(JSON.stringify({ manifest, requiredScopes }, null, 2));
  } else {
    const secret = process.env.KIWI_REGISTRATION_SECRET;
    if (!secret) throw new Error('Set KIWI_REGISTRATION_SECRET to the secret supplied by the Kiwi administrator.');
    const response = await fetch(`${kiwi}/api/kiwi-apps/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(30_000), body: JSON.stringify({ ...manifest, registrationSecret: secret }),
    });
    if (!response.ok) throw new Error(`Kiwi registration failed (${response.status}). Check the administrator's whitelist entry.`);
    console.log('Registered ics-r-lab through the official API. A Kiwi administrator must approve lab-tutor and enable the app and its scopes for the course.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
