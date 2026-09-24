import type { KiwiClient } from '../types';

declare global {
  interface Window {
    KiwiApp?: { create: (options: Record<string, unknown>) => KiwiClient };
  }
}

let clientPromise: Promise<KiwiClient> | undefined;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = window.setTimeout(() => {
      script.remove();
      reject(new Error(`SDK 加载超时：${src}`));
    }, 5000);
    script.src = src;
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); reject(new Error(`SDK 加载失败：${src}`)); };
    document.head.appendChild(script);
  });
}

export function getKiwi(): Promise<KiwiClient> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const host = import.meta.env.VITE_KIWI_ORIGIN?.replace(/\/$/, '');
    if (!window.KiwiApp && host && !(location.protocol === 'https:' && host.startsWith('http:'))) {
      try { await loadScript(`${host}/sdk/v1/kiwi-app-sdk.js`); } catch { /* bundled fallback */ }
    }
    if (!window.KiwiApp) await loadScript('/sdk/v1/kiwi-app-sdk.js');
    if (!window.KiwiApp) throw new Error('Kiwi SDK 未加载');
    const client = window.KiwiApp.create({ appSlug: 'ics-r-lab', mode: 'auto', timeoutMs: 180000 });
    await client.ready();
    return client;
  })();
  return clientPromise;
}
