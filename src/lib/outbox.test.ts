import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  addGap,
  applyOverflow,
  backoffDelay,
  byteSize,
  gapKey,
  LEASE_KEY,
  Outbox,
  OUTBOX_LIMITS,
  outboxKey,
  takeBatch,
  type OutboxTransport,
} from "./outbox";
import type { AddEventResponse, EventInput } from "../types";

let counter = 0;
function event(type = "code_run", extra: Partial<EventInput> = {}): EventInput {
  counter += 1;
  return {
    eventId: `evt-${counter}`,
    classId: "c1",
    studentId: "s1",
    studentName: "Ada",
    sessionId: "tab",
    type,
    payload: { n: counter },
    clientTs: 1_000_000 + counter,
    tzOffsetMin: 480,
    seq: counter,
    schemaVersion: 2,
    ...extra,
  };
}

/** A fake server: `down` simulates an outage (network error); otherwise it stores by eventId (dedup). */
function fakeServer() {
  const stored = new Map<string, EventInput>();
  const state = { down: false, batchCalls: 0, singleCalls: 0, keepalive: [] as boolean[], status: 0 };
  const result = (e: EventInput): AddEventResponse => {
    const duplicate = stored.has(e.eventId);
    stored.set(e.eventId, e);
    return { eventId: e.eventId, status: duplicate ? "duplicate" : "created" };
  };
  const transport: OutboxTransport = {
    batch: async (events, keepalive) => {
      state.batchCalls += 1;
      state.keepalive.push(keepalive);
      if (state.down) throw new ApiError(state.status, state.status ? "unavailable" : "network_error", "down");
      return { results: events.map(result) };
    },
    single: async (e) => {
      state.singleCalls += 1;
      if (state.down) throw new ApiError(state.status, "network_error", "down");
      return result(e);
    },
  };
  return { stored, state, transport };
}

function makeOutbox(transport: OutboxTransport, extra: Partial<ConstructorParameters<typeof Outbox>[0]> = {}) {
  return new Outbox({
    classId: "c1",
    studentId: "s1",
    transport,
    makeEvent: (type, payload) => event(type, { payload }),
    random: () => 0.5,
    tabId: "tab-a",
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  counter = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("outbox persistence and delivery (TELEMETRY-01, AU-D3-06, AU-D4-M4, AU-T-15)", () => {
  it("persists before delivery, retries with backoff while the API is down and delivers exactly once after recovery", async () => {
    const server = fakeServer();
    server.state.down = true;
    const outbox = makeOutbox(server.transport);
    for (let i = 0; i < 5; i += 1) outbox.enqueue(event());
    expect(JSON.parse(localStorage.getItem(outboxKey("c1", "s1")) || "[]")).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(OUTBOX_LIMITS.debounceMs);
    expect(server.state.batchCalls).toBe(1);
    expect(outbox.status().failingSince).not.toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(server.state.batchCalls).toBe(1); // backoff 1 s (jitter 0 with random 0.5)
    await vi.advanceTimersByTimeAsync(1);
    expect(server.state.batchCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.state.batchCalls).toBe(3); // ×2
    server.state.down = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect(server.stored.size).toBe(5);
    expect(outbox.pending()).toBe(0);
    expect(outbox.status()).toEqual({ pending: 0, failingSince: null, blocked: false });
    // a replay of the same events is harmless: the server deduplicates by eventId
    const before = server.stored.size;
    await outbox.flush();
    expect(server.stored.size).toBe(before);
    outbox.dispose();
  });

  it("survives a reload: a new outbox for the same identity sends what the old one persisted", async () => {
    const down = fakeServer();
    down.state.down = true;
    const first = makeOutbox(down.transport);
    first.enqueue(event());
    first.enqueue(event());
    first.dispose();
    const up = fakeServer();
    const second = makeOutbox(up.transport);
    await second.flush();
    expect(up.stored.size).toBe(2);
    second.dispose();
  });

  it("keeps a different student's events apart (per-identity key)", () => {
    const server = fakeServer();
    const a = makeOutbox(server.transport);
    const b = makeOutbox(server.transport, { studentId: "s2" });
    a.enqueue(event());
    expect(b.pending()).toBe(0);
    expect(localStorage.getItem(outboxKey("c1", "s2"))).toBeNull();
    a.dispose();
    b.dispose();
  });

  it("backoff schedule: 1 s doubling to 60 s with ±20% jitter", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelay(n, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(backoffDelay(1, () => 0)).toBe(800);
    expect(backoffDelay(1, () => 1)).toBe(1200);
  });

  it("stops after three consecutive 403s and reports blocked", async () => {
    const server = fakeServer();
    server.state.down = true;
    server.state.status = 403;
    const outbox = makeOutbox(server.transport);
    outbox.enqueue(event());
    await vi.advanceTimersByTimeAsync(OUTBOX_LIMITS.debounceMs);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.state.batchCalls).toBe(3);
    expect(outbox.status().blocked).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.state.batchCalls).toBe(3);
    expect(outbox.pending()).toBe(1); // kept, not dropped
    outbox.dispose();
  });

  it("keeps events on 503/5xx and on network errors", async () => {
    for (const status of [0, 500, 503]) {
      localStorage.clear();
      const server = fakeServer();
      server.state.down = true;
      server.state.status = status;
      const outbox = makeOutbox(server.transport);
      outbox.enqueue(event());
      await vi.advanceTimersByTimeAsync(OUTBOX_LIMITS.debounceMs);
      expect(outbox.pending()).toBe(1);
      expect(outbox.status().blocked).toBe(false);
      outbox.dispose();
    }
  });
});

describe("batch errors and rejections (TELEMETRY-24)", () => {
  it("a batch answered 400 is retried as singles; 422 singles are dropped and counted; a 400 single becomes a rejected gap", async () => {
    const sent: EventInput[] = [];
    let singles = 0;
    const transport: OutboxTransport = {
      batch: async (events) => {
        if (events.some((e) => e.type !== "telemetry_gap")) throw new ApiError(400, "invalid_request", "events must be an array");
        sent.push(...events);
        return { results: events.map((e) => ({ eventId: e.eventId, status: "created" as const })) };
      },
      single: async (e) => {
        singles += 1;
        if (e.type === "bad_type") throw new ApiError(422, "invalid_payload", "Unsupported event type");
        if (e.type === "broken") throw new ApiError(400, "invalid_request", "bad body");
        sent.push(e);
        return { eventId: e.eventId, status: "created" };
      },
    };
    const outbox = makeOutbox(transport);
    outbox.enqueue(event("code_run"));
    outbox.enqueue(event("bad_type"));
    outbox.enqueue(event("broken", { clientTs: 5_000 }));
    await outbox.flush();
    expect(singles).toBe(3);
    expect(outbox.rejected).toBe(1);
    expect(outbox.pending()).toBe(0);
    expect(sent.map((e) => e.type)).toEqual(["code_run"]);
    expect(JSON.parse(localStorage.getItem(gapKey("c1", "s1")) || "{}").rejected.droppedCount).toBe(1);
    await outbox.flush();
    const gap = sent.find((e) => e.type === "telemetry_gap");
    expect(gap?.payload).toMatchObject({ reason: "rejected", droppedCount: 1, droppedTypes: { broken: 1 }, fromTs: 5_000, toTs: 5_000 });
    expect(localStorage.getItem(gapKey("c1", "s1"))).toBeNull();
    outbox.dispose();
  });

  it("removes batch results that the server rejected and counts them", async () => {
    const transport: OutboxTransport = {
      batch: async (events) => ({ results: events.map((e, i) => ({ eventId: e.eventId, status: i === 0 ? "rejected" : "created" })) }),
      single: async (e) => ({ eventId: e.eventId, status: "created" }),
    };
    const outbox = makeOutbox(transport);
    outbox.enqueue(event());
    outbox.enqueue(event());
    await outbox.flush();
    expect(outbox.rejected).toBe(1);
    expect(outbox.pending()).toBe(0);
    outbox.dispose();
  });
});

describe("overflow policy with a gap event (P3)", () => {
  it("drops the oldest telemetry-category events first, then the oldest of any type", () => {
    const queue = [event("code_run"), event("page_view"), event("code_run"), event("study_heartbeat"), event("answer_draft")];
    const { kept, dropped } = applyOverflow(queue, { maxEvents: 3, maxBytes: 1e9 });
    expect(dropped.map((e) => e.type)).toEqual(["page_view", "study_heartbeat"]);
    expect(kept.map((e) => e.type)).toEqual(["code_run", "code_run", "answer_draft"]);
    const more = applyOverflow([event("code_run"), event("code_run"), event("code_run")], { maxEvents: 2, maxBytes: 1e9 });
    expect(more.dropped.map((e) => e.eventId)).toEqual([more.dropped[0].eventId]);
    expect(more.kept).toHaveLength(2);
  });

  it("caps the outbox at 1,000 events and reports the dropped ones with fromTs/toTs on the next flush", async () => {
    const server = fakeServer();
    server.state.down = true;
    const outbox = makeOutbox(server.transport);
    for (let i = 0; i < OUTBOX_LIMITS.maxEvents; i += 1) outbox.enqueue(event("code_run"));
    outbox.enqueue(event("page_view", { clientTs: 42 }));
    outbox.enqueue(event("code_run", { clientTs: 7 }));
    expect(outbox.pending()).toBe(OUTBOX_LIMITS.maxEvents);
    const gaps = JSON.parse(localStorage.getItem(gapKey("c1", "s1")) || "{}");
    expect(gaps.overflow.droppedCount).toBe(2);
    expect(gaps.overflow.droppedTypes).toEqual({ page_view: 1, code_run: 1 });
    server.state.down = false;
    await outbox.flush();
    const gap = [...server.stored.values()].find((e) => e.type === "telemetry_gap");
    expect(gap?.payload).toMatchObject({ reason: "overflow", droppedCount: 2 });
    expect(Number(gap?.payload.fromTs)).toBeLessThanOrEqual(Number(gap?.payload.toTs));
    outbox.dispose();
  });

  it("caps the outbox at 1.5 MB", () => {
    const big = Array.from({ length: 4 }, () => event("code_run", { payload: { code: "x".repeat(600_000) } }));
    const { kept, dropped } = applyOverflow(big);
    expect(byteSize(kept)).toBeLessThanOrEqual(OUTBOX_LIMITS.maxBytes);
    expect(dropped.length).toBe(2);
  });

  it("falls back to memory and reports no_storage once when localStorage is unavailable", async () => {
    const server = fakeServer();
    const broken = { getItem: () => null, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined } as unknown as Storage;
    const outbox = makeOutbox(server.transport, { storage: broken });
    outbox.enqueue(event());
    await outbox.flush();
    const gaps = [...server.stored.values()].filter((e) => e.type === "telemetry_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].payload.reason).toBe("no_storage");
    outbox.enqueue(event());
    await outbox.flush();
    expect([...server.stored.values()].filter((e) => e.type === "telemetry_gap")).toHaveLength(1);
    outbox.dispose();
  });

  it("addGap accumulates counts per type and the time span", () => {
    const gaps = addGap(addGap({}, "overflow", [event("a", { clientTs: 10 })], 0), "overflow", [event("a", { clientTs: 3 }), event("b", { clientTs: 20 })], 0);
    expect(gaps.overflow).toEqual({ droppedCount: 3, droppedTypes: { a: 2, b: 1 }, fromTs: 3, toTs: 20 });
  });
});

describe("batches, keepalive and the cross-tab lease", () => {
  it("batches hold at most 50 events and 60 KB", () => {
    const many = Array.from({ length: 80 }, () => event());
    expect(takeBatch(many, "c1")).toHaveLength(50);
    const large = Array.from({ length: 10 }, () => event("code_run", { payload: { code: "y".repeat(20_000) } }));
    const batch = takeBatch(large, "c1");
    expect(batch.length).toBe(2);
    expect(byteSize({ classId: "c1", events: batch })).toBeLessThanOrEqual(OUTBOX_LIMITS.batchBytes);
  });

  it("pagehide flush sends one keepalive batch ≤ 60 KB", async () => {
    const server = fakeServer();
    const outbox = makeOutbox(server.transport);
    for (let i = 0; i < 60; i += 1) outbox.enqueue(event("code_edited", { payload: { code: "z".repeat(2_000) } }));
    await outbox.flush({ keepalive: true });
    expect(server.state.batchCalls).toBe(1);
    expect(server.state.keepalive).toEqual([true]);
    expect(server.stored.size).toBeGreaterThan(0);
    expect(server.stored.size).toBeLessThan(60);
    const sent = [...server.stored.values()];
    expect(byteSize({ classId: "c1", events: sent })).toBeLessThanOrEqual(OUTBOX_LIMITS.batchBytes);
    outbox.dispose();
  });

  it("an oversized single event is sent alone with POST /api/events", async () => {
    const server = fakeServer();
    const outbox = makeOutbox(server.transport);
    outbox.enqueue(event("code_run", { payload: { output: "o".repeat(300_000) } }));
    await outbox.flush();
    expect(server.state.batchCalls).toBe(0);
    expect(server.state.singleCalls).toBe(1);
    outbox.dispose();
  });

  it("another tab's live lease defers this tab's flush (server dedup makes overlaps harmless)", async () => {
    const server = fakeServer();
    localStorage.setItem(LEASE_KEY, JSON.stringify({ tab: "tab-b", until: Date.now() + 5_000 }));
    const outbox = makeOutbox(server.transport);
    outbox.enqueue(event());
    await vi.advanceTimersByTimeAsync(OUTBOX_LIMITS.debounceMs);
    expect(server.state.batchCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(OUTBOX_LIMITS.leaseMs);
    expect(server.stored.size).toBe(1);
    outbox.dispose();
  });
});
