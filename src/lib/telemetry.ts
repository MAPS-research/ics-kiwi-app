import { useSyncExternalStore } from "react";
import { api } from "./api";
import { getBrowserSession } from "./navigation";
import { Outbox, type OutboxTransport } from "./outbox";
import type { EventInput, TelemetryContext, TelemetryStatus, Tracker } from "../types";

/*
 * Client telemetry (TELEMETRY; signatures frozen, §7.9 / §11.1). `createTracker` builds the v2 envelope and persists
 * every event in the per-identity durable outbox (src/lib/outbox.ts) before it resolves; delivery, retries and gap
 * reporting happen there. Pages publish their context with `setTelemetryContext`; KiwiChat registers AI replies so a
 * paste can be matched against them by hash (no reply or clipboard text is kept).
 */
export type { Tracker } from "../types";

// ─── Page context (read by the heartbeat) ──────────────────────────────────────────────────────

let telemetryContext: TelemetryContext | null = null;
/** Pages call this on mount and on question change; the heartbeat reads it. */
export function setTelemetryContext(ctx: TelemetryContext | null): void {
  telemetryContext = ctx;
}
export function getTelemetryContext(): TelemetryContext | null {
  return telemetryContext;
}

// ─── SHA-256 (synchronous; used for AI-reply windows) ─────────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const utf8 = new TextEncoder();
/** Hex SHA-256 of a UTF-8 string (FIPS 180-4). */
export function sha256Hex(text: string): string {
  const bytes = utf8.encode(text);
  const length = bytes.length;
  const blocks = Math.ceil((length + 9) / 64);
  const data = new Uint8Array(blocks * 64);
  data.set(bytes);
  data[length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 4, (length * 8) >>> 0);
  view.setUint32(data.length - 8, Math.floor((length * 8) / 2 ** 32));
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let block = 0; block < blocks; block += 1) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block * 64 + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

// ─── AI replies (for paste.matchesAiReply, §11.1) ──────────────────────────────────────────────

export const PASTE_WINDOW = 40;
const MAX_REPLIES = 20;
const MAX_REPLY_WINDOWS = 4000;
const MAX_PASTE_WINDOWS = 2000;
/** Lower-case, collapse whitespace: copies keep matching through re-wrapping and case changes. */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
function windowHashes(text: string, limit: number): string[] {
  const value = normalizeForMatch(text);
  if (value.length < PASTE_WINDOW) return [];
  const count = Math.min(limit, value.length - PASTE_WINDOW + 1);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(sha256Hex(value.slice(i, i + PASTE_WINDOW)));
  return out;
}
const aiReplies: { hashes: Set<string>; chatTurnId: number | null }[] = [];
/** KiwiChat registers every reply; only SHA-256 hashes of 40-char windows are kept (no reply text). */
export function registerAiReply(text: string, chatTurnId: number | null): void {
  const hashes = new Set(windowHashes(text || "", MAX_REPLY_WINDOWS));
  if (!hashes.size) return;
  aiReplies.push({ hashes, chatTurnId });
  if (aiReplies.length > MAX_REPLIES) aiReplies.splice(0, aiReplies.length - MAX_REPLIES);
}
/** Metadata of the registered replies (newest last). */
export function recentAiReplies(): readonly { chatTurnId: number | null; windows: number }[] {
  return aiReplies.map((r) => ({ chatTurnId: r.chatTurnId, windows: r.hashes.size }));
}
/** Whether ≥ 40 normalized characters of `pasted` appear in a registered reply (newest reply wins). */
export function matchAiReply(pasted: string): { matches: boolean; chatTurnId: number | null } {
  const windows = windowHashes(pasted || "", MAX_PASTE_WINDOWS);
  for (let index = aiReplies.length - 1; index >= 0; index -= 1) {
    const reply = aiReplies[index];
    if (windows.some((hash) => reply.hashes.has(hash))) return { matches: true, chatTurnId: reply.chatTurnId };
  }
  return { matches: false, chatTurnId: null };
}
export function clearAiReplies(): void {
  aiReplies.splice(0, aiReplies.length);
}

// ─── Delivery status ───────────────────────────────────────────────────────────────────────────

let status: TelemetryStatus = { pending: 0, failingSince: null, blocked: false };
let lastError = "";
const listeners = new Set<() => void>();
function setStatus(next: TelemetryStatus, error: string): void {
  lastError = error;
  if (next.pending === status.pending && next.failingSince === status.failingSince && next.blocked === status.blocked) return;
  status = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => status;

export function useTelemetryStatus(): TelemetryStatus {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function telemetryStatus(): TelemetryStatus {
  return status;
}
/** Message of the most recent failed delivery. */
export function lastTelemetryError(): string {
  return lastError;
}

// ─── Envelope & tracker ────────────────────────────────────────────────────────────────────────

let memorySeq = 0;
function nextSeq(): number {
  const key = `kiwi-seq:${getBrowserSession()}`;
  try {
    const value = Number(sessionStorage.getItem(key) || "0") + 1;
    sessionStorage.setItem(key, String(value));
    return value;
  } catch {
    memorySeq += 1; // storage unavailable: per-page counter
    return memorySeq;
  }
}

export function buildEvent(
  ctx: { classId: string; studentId: string; studentName: string },
  type: string,
  payload: Record<string, unknown>,
  questionId?: string,
): EventInput {
  return {
    eventId: crypto.randomUUID(),
    classId: ctx.classId,
    studentId: ctx.studentId,
    studentName: ctx.studentName,
    sessionId: getBrowserSession(),
    type,
    ...(questionId ? { questionId } : {}),
    payload,
    clientTs: Date.now(),
    tzOffsetMin: -new Date().getTimezoneOffset(),
    seq: nextSeq(),
    schemaVersion: 2,
    ...(telemetryContext?.surface ? { surface: telemetryContext.surface } : {}),
    route: location.pathname,
  };
}

const outboxes = new Map<string, Outbox>();
let activeKey = "";
let transportFactory = (classId: string): OutboxTransport => ({
  batch: (events, keepalive) => api.eventBatch(classId, events, { keepalive }),
  single: (event) => api.event(classId, event),
});
/** Test hook: replace the HTTP transport (and drop cached outboxes). */
export function setTelemetryTransport(factory: ((classId: string) => OutboxTransport) | null): void {
  for (const outbox of outboxes.values()) outbox.dispose();
  outboxes.clear();
  activeKey = "";
  status = { pending: 0, failingSince: null, blocked: false };
  if (factory) transportFactory = factory;
  else
    transportFactory = (classId) => ({
      batch: (events, keepalive) => api.eventBatch(classId, events, { keepalive }),
      single: (event) => api.event(classId, event),
    });
}

/** One outbox per identity (a different student never flushes another's events). */
export function outboxFor(ctx: { classId: string; studentId: string; studentName: string }): Outbox {
  const key = `${ctx.classId}:${ctx.studentId}`;
  let outbox = outboxes.get(key);
  if (!outbox) {
    outbox = new Outbox({
      classId: ctx.classId,
      studentId: ctx.studentId,
      transport: transportFactory(ctx.classId),
      makeEvent: (type, payload) => buildEvent(ctx, type, payload),
      onStatus: (next, error) => {
        if (activeKey === key) setStatus(next, error);
      },
    });
    outboxes.set(key, outbox);
  }
  return outbox;
}

/** Makes this identity's outbox the active one (status banner, `flushTelemetry`, `activeTelemetryIdentity`). */
export function activateTracker(ctx: { classId: string; studentId: string; studentName: string }): void {
  if (!ctx.classId || !ctx.studentId) return;
  const outbox = outboxFor(ctx);
  activeKey = `${ctx.classId}:${ctx.studentId}`;
  setStatus(outbox.status(), outbox.error());
}

/**
 * Stops an identity's outbox when the student app unmounts (Exit preview, switching workspace). Without this its
 * pending debounce/retry timers deliver the queue later with the next identity's request headers (e.g. the teacher
 * key without X-Kiwi-Preview → 403 → the cached outbox stays blocked). Queued events stay persisted and are sent with
 * that identity's next event. (INTEGRATION wiring fix.)
 */
export function releaseTracker(ctx: { classId: string; studentId: string }): void {
  const key = `${ctx.classId}:${ctx.studentId}`;
  const outbox = outboxes.get(key);
  if (!outbox) return;
  outbox.dispose();
  outboxes.delete(key);
  if (activeKey === key) {
    activeKey = "";
    setStatus({ pending: 0, failingSince: null, blocked: false }, "");
  }
}

/** Returns `track(type, payload, questionId?)`; it resolves once the event is persisted and never throws. */
export function createTracker(ctx: { classId: string; studentId: string; studentName: string; preview: boolean }): Tracker {
  if (!ctx.classId || !ctx.studentId) return async () => undefined;
  activateTracker(ctx);
  return async (type, payload, questionId) => {
    try {
      // WHY per call: after releaseTracker (unmount) a later event re-creates the outbox, which loads the persisted queue
      outboxFor(ctx).enqueue(buildEvent(ctx, type, payload, questionId));
    } catch (error) {
      // WHY: telemetry must never break the page; the failure is visible in the status banner instead
      setStatus({ ...status, failingSince: status.failingSince ?? Date.now() }, error instanceof Error ? error.message : String(error));
    }
  };
}

/** The identity whose events are being tracked (classId/studentId of the active outbox), if any. */
export function activeTelemetryIdentity(): { classId: string; studentId: string } | null {
  const outbox = outboxes.get(activeKey);
  return outbox ? { classId: outbox.classId, studentId: outbox.studentId } : null;
}

/** Flush the active identity's outbox (online, visibility hidden, pagehide with keepalive). */
export function flushTelemetry(options: { keepalive?: boolean } = {}): Promise<void> {
  const outbox = outboxes.get(activeKey);
  return outbox ? outbox.flush(options) : Promise.resolve();
}
