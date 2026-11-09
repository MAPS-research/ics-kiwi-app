import type { AddEventResponse, EventInput, TelemetryStatus } from "../types";

/*
 * Durable telemetry outbox (§11.1, TELEMETRY). Events are persisted in localStorage per identity before `track()`
 * resolves, flushed in batches (≤ 50 events, ≤ 60 KB) to POST /api/events/batch, retried with exponential backoff on
 * network errors / 5xx / 503 / 401, and deduplicated by the server through `eventId`. Nothing is dropped silently:
 * overflow and rejected singles are reported as one `telemetry_gap` event on the next flush (P3).
 */

export const OUTBOX_LIMITS = {
  maxEvents: 1000,
  maxBytes: 1_500_000,
  batchEvents: 50,
  batchBytes: 60_000,
  debounceMs: 250,
  leaseMs: 10_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  jitter: 0.2,
  forbiddenStop: 3,
} as const;

/** Telemetry-category types dropped first on overflow (§11.1). */
export const DROP_FIRST: ReadonlySet<string> = new Set(["code_edited", "page_view", "visibility", "idle", "study_heartbeat"]);
export const LEASE_KEY = "kiwi-outbox-lease";
export const outboxKey = (classId: string, studentId: string): string => `kiwi-outbox:v1:${classId}:${studentId}`;
export const gapKey = (classId: string, studentId: string): string => `kiwi-outbox-gap:v1:${classId}:${studentId}`;

export type GapReason = "overflow" | "no_storage" | "rejected";
export interface GapState {
  droppedCount: number;
  droppedTypes: Record<string, number>;
  fromTs: number;
  toTs: number;
}
type Gaps = Partial<Record<GapReason, GapState>>;

/** Minimal transport the outbox needs (src/lib/telemetry.ts binds it to `api.eventBatch` / `api.event`). */
export interface OutboxTransport {
  batch(events: EventInput[], keepalive: boolean): Promise<{ results: AddEventResponse[] }>;
  single(event: EventInput): Promise<AddEventResponse>;
}

export interface OutboxOptions {
  classId: string;
  studentId: string;
  transport: OutboxTransport;
  /** Builds a full EventInput for the gap report (same envelope as `track`). */
  makeEvent: (type: string, payload: Record<string, unknown>) => EventInput;
  /** Defaults to `localStorage`; `null` forces the in-memory queue. */
  storage?: Storage | null;
  now?: () => number;
  random?: () => number;
  tabId?: string;
  onStatus?: (status: TelemetryStatus, lastError: string) => void;
}

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
/** UTF-8 size of a JSON value (what the server and the browser keepalive limit count). */
export function byteSize(value: unknown): number {
  const text = JSON.stringify(value) ?? "";
  return encoder ? encoder.encode(text).length : text.length * 3;
}

/** Exponential backoff 1 s → 60 s (×2) with ±20% jitter; `failures` counts consecutive failures (≥ 1). */
export function backoffDelay(failures: number, random: () => number = Math.random): number {
  const base = Math.min(OUTBOX_LIMITS.backoffMaxMs, OUTBOX_LIMITS.backoffBaseMs * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (1 + (random() * 2 - 1) * OUTBOX_LIMITS.jitter));
}

/** Overflow policy: drop the oldest telemetry-category events first, then the oldest of any type. */
export function applyOverflow(
  queue: EventInput[],
  limits: { maxEvents: number; maxBytes: number } = OUTBOX_LIMITS,
): { kept: EventInput[]; dropped: EventInput[] } {
  const kept = [...queue];
  const dropped: EventInput[] = [];
  let bytes = byteSize(kept);
  const over = () => kept.length > limits.maxEvents || bytes > limits.maxBytes;
  while (over() && kept.length) {
    let index = kept.findIndex((e) => DROP_FIRST.has(e.type));
    if (index < 0) index = 0;
    const [removed] = kept.splice(index, 1);
    dropped.push(removed);
    bytes -= byteSize(removed) + 1;
  }
  return { kept, dropped };
}

/** Consecutive events from the head that fit one batch body (`{classId, events}` ≤ maxBytes, ≤ maxEvents). */
export function takeBatch(queue: EventInput[], classId: string, maxEvents: number = OUTBOX_LIMITS.batchEvents, maxBytes: number = OUTBOX_LIMITS.batchBytes): EventInput[] {
  const batch: EventInput[] = [];
  let bytes = byteSize({ classId, events: [] });
  for (const event of queue) {
    if (batch.length >= maxEvents) break;
    const size = byteSize(event) + (batch.length ? 1 : 0);
    if (batch.length && bytes + size > maxBytes) break;
    batch.push(event);
    bytes += size;
    if (bytes > maxBytes) break; // a single oversized event travels alone (sent as a single POST)
  }
  return batch;
}

export function addGap(gaps: Gaps, reason: GapReason, events: EventInput[], now: number): Gaps {
  const current: GapState = gaps[reason] ?? { droppedCount: 0, droppedTypes: {}, fromTs: Number.POSITIVE_INFINITY, toTs: 0 };
  const next: GapState = { droppedCount: current.droppedCount, droppedTypes: { ...current.droppedTypes }, fromTs: current.fromTs, toTs: current.toTs };
  for (const event of events) {
    next.droppedCount += 1;
    next.droppedTypes[event.type] = (next.droppedTypes[event.type] ?? 0) + 1;
    const ts = typeof event.clientTs === "number" ? event.clientTs : now;
    next.fromTs = Math.min(next.fromTs, ts);
    next.toTs = Math.max(next.toTs, ts);
  }
  if (!events.length) {
    next.fromTs = Math.min(next.fromTs, now);
    next.toTs = Math.max(next.toTs, now);
  }
  return { ...gaps, [reason]: next };
}

function statusOf(error: unknown): number {
  if (error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  return 0; // network failure
}
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // WHY: some privacy modes throw on access; the in-memory queue is used and a gap is reported
  }
}

export class Outbox {
  readonly classId: string;
  readonly studentId: string;
  private readonly opts: OutboxOptions;
  private storage: Storage | null;
  private memoryQueue: EventInput[] = [];
  private memoryGaps: Gaps = {};
  private readonly tabId: string;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private failures = 0;
  private failingSince: number | null = null;
  private forbidden = 0;
  private blocked = false;
  private lastError = "";
  private disposed = false;
  private reportedNoStorage = false;
  /** Events the server rejected (logged server-side in event_rejections); kept for tests and diagnostics. */
  rejected = 0;

  constructor(opts: OutboxOptions) {
    this.opts = opts;
    this.classId = opts.classId;
    this.studentId = opts.studentId;
    this.tabId = opts.tabId ?? `tab-${Math.random().toString(36).slice(2)}`;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    if (!this.probe()) this.toMemory();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private probe(): boolean {
    if (!this.storage) return false;
    try {
      const key = `${LEASE_KEY}:probe`;
      this.storage.setItem(key, "1");
      this.storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  private toMemory(): void {
    this.storage = null;
    if (this.reportedNoStorage) return;
    this.reportedNoStorage = true; // reported once per outbox as telemetry_gap {reason: 'no_storage'}
    this.memoryGaps = addGap(this.memoryGaps, "no_storage", [], this.now());
  }

  // ── persistence ─────────────────────────────────────────────────────────────────────────────
  read(): EventInput[] {
    if (!this.storage) return [...this.memoryQueue];
    try {
      const raw = this.storage.getItem(outboxKey(this.classId, this.studentId));
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as EventInput[]) : [];
    } catch {
      return []; // WHY: a corrupted entry must not block new events; the next write replaces it
    }
  }

  private write(queue: EventInput[]): void {
    if (this.storage) {
      try {
        if (queue.length) this.storage.setItem(outboxKey(this.classId, this.studentId), JSON.stringify(queue));
        else this.storage.removeItem(outboxKey(this.classId, this.studentId));
        return;
      } catch {
        this.toMemory(); // quota exceeded or storage revoked: keep going in memory and report it
      }
    }
    this.memoryQueue = [...queue];
  }

  private readGaps(): Gaps {
    if (!this.storage) return { ...this.memoryGaps };
    try {
      const raw = this.storage.getItem(gapKey(this.classId, this.studentId));
      return { ...(raw ? (JSON.parse(raw) as Gaps) : {}), ...this.memoryGaps };
    } catch {
      return { ...this.memoryGaps };
    }
  }

  private writeGaps(gaps: Gaps): void {
    const empty = !Object.keys(gaps).length;
    if (this.storage) {
      try {
        if (empty) this.storage.removeItem(gapKey(this.classId, this.studentId));
        else this.storage.setItem(gapKey(this.classId, this.studentId), JSON.stringify(gaps));
        this.memoryGaps = {};
        return;
      } catch {
        this.toMemory();
      }
    }
    this.memoryGaps = gaps;
  }

  // ── public API ──────────────────────────────────────────────────────────────────────────────
  /** Persist one event (synchronously) and schedule a debounced flush. Never throws. */
  enqueue(event: EventInput): void {
    const { kept, dropped } = applyOverflow([...this.read(), event]);
    this.write(kept);
    if (dropped.length) this.writeGaps(addGap(this.readGaps(), "overflow", dropped, this.now()));
    this.emit();
    this.schedule(OUTBOX_LIMITS.debounceMs);
  }

  pending(): number {
    return this.read().length;
  }

  status(): TelemetryStatus {
    return { pending: this.pending(), failingSince: this.failingSince, blocked: this.blocked };
  }

  error(): string {
    return this.lastError;
  }

  /** Flush now. `keepalive` (pagehide) sends one batch ≤ 60 KB with `fetch(..., {keepalive: true})`. */
  flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.disposed || this.blocked) return Promise.resolve();
    if (options.keepalive) return this.run(true);
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = this.run(false).finally(() => {
      this.inFlight = null;
      if (this.again) {
        this.again = false;
        this.schedule(0);
      }
    });
    return this.inFlight;
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.retry) clearTimeout(this.retry);
    this.debounce = this.retry = null;
  }

  // ── flushing ────────────────────────────────────────────────────────────────────────────────
  private schedule(delay: number): void {
    if (this.disposed || this.blocked || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.flush();
    }, delay);
  }

  private scheduleRetry(delay: number): void {
    if (this.disposed || this.blocked) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.flush();
    }, delay);
  }

  private acquireLease(): boolean {
    if (!this.storage) return true;
    try {
      const raw = this.storage.getItem(LEASE_KEY);
      const lease = raw ? (JSON.parse(raw) as { tab: string; until: number }) : null;
      if (lease && lease.tab !== this.tabId && lease.until > this.now()) return false;
      this.storage.setItem(LEASE_KEY, JSON.stringify({ tab: this.tabId, until: this.now() + OUTBOX_LIMITS.leaseMs }));
      return true;
    } catch {
      return true; // WHY: the lease only reduces cross-tab duplicates; the server deduplicates by eventId anyway
    }
  }

  private releaseLease(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(LEASE_KEY);
      const lease = raw ? (JSON.parse(raw) as { tab: string }) : null;
      if (lease?.tab === this.tabId) this.storage.removeItem(LEASE_KEY);
    } catch {
      // the lease expires on its own after 10 s
    }
  }

  /** Pending gap counters become `telemetry_gap` events at the head of the queue (sent first). */
  private emitGaps(): void {
    const gaps = this.readGaps();
    const reasons = (Object.keys(gaps) as GapReason[]).filter((r) => gaps[r]);
    if (!reasons.length) return;
    const events = reasons.map((reason) => {
      const gap = gaps[reason] as GapState;
      return this.opts.makeEvent("telemetry_gap", {
        droppedCount: gap.droppedCount,
        droppedTypes: gap.droppedTypes,
        reason,
        fromTs: Number.isFinite(gap.fromTs) ? gap.fromTs : this.now(),
        toTs: gap.toTs || this.now(),
      });
    });
    this.write([...events, ...this.read()]);
    this.writeGaps({});
  }

  private async run(keepalive: boolean): Promise<void> {
    if (!keepalive && this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (!keepalive && !this.acquireLease()) {
      this.scheduleRetry(OUTBOX_LIMITS.leaseMs);
      return;
    }
    try {
      this.emitGaps();
      for (let round = 0; round < (keepalive ? 1 : 200); round += 1) {
        if (this.blocked) break;
        const queue = this.read();
        if (!queue.length) break;
        const batch = takeBatch(queue, this.classId);
        const alone = batch.length === 1 && byteSize({ classId: this.classId, events: batch }) > OUTBOX_LIMITS.batchBytes;
        if (alone && keepalive) break; // too large for a keepalive request; the next page load sends it
        const ok = alone ? await this.sendSingles(batch) : await this.sendBatch(batch, keepalive);
        if (!ok) break;
      }
    } finally {
      if (!keepalive) this.releaseLease();
      this.emit();
    }
  }

  private remove(ids: string[]): void {
    if (!ids.length) return;
    const drop = new Set(ids);
    this.write(this.read().filter((e) => !drop.has(e.eventId)));
  }

  private async sendBatch(batch: EventInput[], keepalive: boolean): Promise<boolean> {
    try {
      const { results } = await this.opts.transport.batch(batch, keepalive);
      const done: string[] = [];
      batch.forEach((event, index) => {
        const result = results?.[index];
        if (!result) return;
        if (result.status === "rejected") this.rejected += 1; // the server already logged it in event_rejections
        done.push(event.eventId);
      });
      this.remove(done);
      this.succeeded();
      if (done.length === batch.length) return true;
      this.scheduleRetry(OUTBOX_LIMITS.backoffBaseMs); // a short results array: retry the rest shortly
      return false;
    } catch (error) {
      if (statusOf(error) === 400) return this.sendSingles(batch); // envelope error: retry one by one
      return this.failed(error);
    }
  }

  private async sendSingles(batch: EventInput[]): Promise<boolean> {
    for (const event of batch) {
      try {
        await this.opts.transport.single(event);
        this.remove([event.eventId]);
        this.succeeded();
      } catch (error) {
        const status = statusOf(error);
        if (status === 422) {
          this.rejected += 1;
          this.remove([event.eventId]);
          continue;
        }
        if (status === 400) {
          this.remove([event.eventId]);
          this.writeGaps(addGap(this.readGaps(), "rejected", [event], this.now()));
          continue;
        }
        return this.failed(error);
      }
    }
    return true;
  }

  private succeeded(): void {
    this.failures = 0;
    this.failingSince = null;
    this.forbidden = 0;
    this.lastError = "";
  }

  private failed(error: unknown): false {
    const status = statusOf(error);
    this.failures += 1;
    this.failingSince ??= this.now();
    this.lastError = messageOf(error);
    if (status === 403) {
      this.forbidden += 1;
      if (this.forbidden >= OUTBOX_LIMITS.forbiddenStop) {
        this.blocked = true; // "Your activity can't be saved for this course"; events stay in the outbox
        this.emit();
        return false;
      }
    } else {
      this.forbidden = 0;
    }
    this.scheduleRetry(backoffDelay(this.failures, this.opts.random));
    this.emit();
    return false;
  }

  private emit(): void {
    this.opts.onStatus?.(this.status(), this.lastError);
  }
}
