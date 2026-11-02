import { useEffect } from "react";
import type { HostChatPolicy, KiwiClient } from "../types";

/*
 * Kiwi SDK wrapper and host chat policy (§7.9, §15.3). Frozen after FOUNDATION.
 * Nothing here touches `window` or `document` at import time.
 */

declare global {
  interface Window {
    KiwiApp?: { create: (options: Record<string, unknown>) => KiwiClient };
  }
}

let clientPromise: Promise<KiwiClient> | undefined;

const kiwiOrigin = () => (import.meta.env.VITE_KIWI_ORIGIN || "http://localhost:3001").replace(/\/$/, "");
// The host owns course selection and its generic app placements.
export const kiwiTeacherEntryUrl = () => `${kiwiOrigin()}/`;

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
    if (!window.KiwiApp && host && !(location.protocol === "https:" && host.startsWith("http:"))) {
      try {
        await loadScript(`${host}/sdk/v1/kiwi-app-sdk.js`);
      } catch {
        // WHY: the host SDK is optional; the bundled copy below is the fallback and reports its own failure.
      }
    }
    if (!window.KiwiApp) await loadScript("/sdk/v1/kiwi-app-sdk.js");
    if (!window.KiwiApp) throw new Error("Kiwi SDK is not loaded");
    const client = window.KiwiApp.create({
      appSlug: "ics-r-lab",
      mode: window.parent !== window ? "live" : "auto",
      timeoutMs: 125000,
    });
    await Promise.race([
      client.ready(),
      new Promise((_, reject) =>
        window.setTimeout(() => reject(new Error("Kiwi did not provide a course identity. Reopen CSS Lab from your Kiwi course.")), 15000),
      ),
    ]);
    return client;
  })();
  return clientPromise;
}

// ─── Host chat policy (§15.3) ──────────────────────────────────────────────────────────────────

export interface HostMessage {
  type: "kiwi:updateContext";
  payload: Record<string, unknown>;
}

export const CHAT_UNAVAILABLE_REASON = "Ask Kiwi is turned off for this assignment.";

/** Messages that apply a page's chat policy (or, with `policy = null`, restore the StudentApp default). Pure. */
export function hostChatMessages(defaultContext: string, policy: HostChatPolicy | null, learningContext = ""): HostMessage[] {
  const note = policy?.contextNote.trim() ?? "";
  const context = [defaultContext, note, learningContext].filter(Boolean).join("\n");
  return [{ type: "kiwi:updateContext", payload: { context } }];
}

let hostClient: KiwiClient | null = null;
let hostDefaultContext = "";
// The policy of the mounted assignment page, so a default-context refresh (route change) keeps its note.
let activePolicy: HostChatPolicy | null = null;
let activeLearningContext = "";

function publishHostContext(): void {
  sendToHost(hostChatMessages(hostDefaultContext, activePolicy, activeLearningContext)[0]);
}

function sendToHost(message: HostMessage): void {
  hostClient?.updateContext(String(message.payload.context ?? ""));
}

/** StudentApp sets the default context (English course, chapter, page, Lab AI tutor rules) and sends it. */
export function setHostDefaultContext(client: KiwiClient | null, context: string): void {
  hostClient = client;
  hostDefaultContext = context;
  publishHostContext();
}

/**
 * Pages inside an assignment call this with the assignment's tool policy. Sends
 * The supported SDK updateContext message carries a hint, never an enforcement claim.
 * The public SDK has no chat-availability API.
 */
export function useHostChatPolicy(policy: HostChatPolicy | null): void {
  const active = policy !== null;
  const available = policy?.available ?? true;
  const contextNote = policy?.contextNote ?? "";
  useEffect(() => {
    if (!active) return;
    const current: HostChatPolicy = { available, contextNote };
    activePolicy = current;
    publishHostContext();
    return () => {
      if (activePolicy === current) activePolicy = null;
      publishHostContext();
    };
  }, [active, available, contextNote]);
}

/** Keep the host's floating chat in sync with visible work, without creating a second chat. */
export function useHostLearningContext(context: string): void {
  useEffect(() => {
    // Remove the previous question immediately; debounce typing, not stale context.
    activeLearningContext = "";
    publishHostContext();
    const timer = setTimeout(() => {
      activeLearningContext = context;
      publishHostContext();
    }, 200);
    return () => {
      clearTimeout(timer);
      activeLearningContext = "";
      publishHostContext();
    };
  }, [context]);
}
