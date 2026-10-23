import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// WHY: agents and reviewers point the dev proxy at a scratch API (KIWI_API_PORT) instead of the live 8101 server (CR-G1).
// ALT: `npm i -D @types/node` — avoided to keep dependencies unchanged; this config only reads one env var.
declare const process: { env: Record<string, string | undefined> };
const apiPort = process.env.KIWI_API_PORT || '8101';
if (!/^\d{2,5}$/.test(apiPort)) throw new Error(`KIWI_API_PORT must be a port number, got "${apiPort}"`);

export default defineConfig({
  plugins: [react()],
  server: {
    // WHY xfwd: the API rate-limits teacher-key failures per client address (§5.3); the proxy forwards the browser's.
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, xfwd: true } },
    fs: { deny: ['**/.env', '**/.env.*', '**/*.{crt,pem}', '**/.git/**', '**/server/**', '**/data/**', '**/.local/**'] },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
