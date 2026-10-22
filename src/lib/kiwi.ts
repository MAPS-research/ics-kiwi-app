import type { KiwiClient } from "../types";

declare global {
  interface Window {
    KiwiApp?: { create: (options: Record<string, unknown>) => KiwiClient };
  }
}

let clientPromise: Promise<KiwiClient> | undefined;

export const kiwiTeacherEntryUrl = () => `${(import.meta.env.VITE_KIWI_ORIGIN || "http://localhost:3001").replace(/\/$/, "")}/admin/app/ics-r-lab`;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => {
      script.remove();
      reject(new Error(`SDK loading timed out: ${src}`));
    }, 5000);
    script.src = src;
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`SDK could not load: ${src}`));
    };
    document.head.appendChild(script);
  });
}

export function getKiwi(): Promise<KiwiClient> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const host = import.meta.env.VITE_KIWI_ORIGIN?.replace(/\/$/, "");
    if (
      !window.KiwiApp &&
      host &&
      !(location.protocol === "https:" && host.startsWith("http:"))
    ) {
      try {
        await loadScript(`${host}/sdk/v1/kiwi-app-sdk.js`);
      } catch {
        /* bundled fallback */
      }
    }
    if (!window.KiwiApp) await loadScript("/sdk/v1/kiwi-app-sdk.js");
    if (!window.KiwiApp) throw new Error("Kiwi SDK is not loaded");
    const client = window.KiwiApp.create({
      appSlug: "ics-r-lab",
      mode: window.parent !== window ? "live" : "auto",
      timeoutMs: 15000,
    });
    await Promise.race([client.ready(), new Promise((_, reject) => window.setTimeout(() => reject(new Error("Kiwi did not provide a course identity. Reopen CSS Lab from your Kiwi course.")), 15000))]);
    return client;
  })();
  return clientPromise;
}
