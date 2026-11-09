import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxKey } from "./outbox";
import {
  activeTelemetryIdentity,
  buildEvent,
  clearAiReplies,
  createTracker,
  flushTelemetry,
  getTelemetryContext,
  matchAiReply,
  normalizeForMatch,
  recentAiReplies,
  registerAiReply,
  setTelemetryContext,
  setTelemetryTransport,
  activateTracker,
  releaseTracker,
  sha256Hex,
  telemetryStatus,
} from "./telemetry";
import type { EventInput } from "../types";

const ctx = { classId: "c1", studentId: "s1", studentName: "Ada", preview: false };

beforeEach(() => {
  setTelemetryContext(null);
  clearAiReplies();
});
afterEach(() => {
  setTelemetryTransport(null);
  vi.useRealTimers();
});

describe("envelope (§7.3 EventInput, TELEMETRY-06)", () => {
  it("carries eventId, client time, tz offset, a per-tab sequence, schemaVersion 2, surface and route", () => {
    history.replaceState(null, "", "/student/assignments/w1/answer?q=q1");
    setTelemetryContext({ surface: "assignment", unitId: "r-basics", assignmentId: "w1", questionId: "q1" });
    const first = buildEvent(ctx, "code_run", { ok: true }, "q1");
    const second = buildEvent(ctx, "code_run", { ok: true });
    expect(first.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.schemaVersion).toBe(2);
    expect(typeof first.clientTs).toBe("number");
    expect(first.tzOffsetMin).toBe(-new Date().getTimezoneOffset());
    expect(second.seq).toBe(first.seq + 1);
    expect(first.surface).toBe("assignment");
    expect(first.route).toBe("/student/assignments/w1/answer"); // no query string
    expect(first.questionId).toBe("q1");
    expect(second.questionId).toBeUndefined();
    expect(sessionStorage.length).toBeGreaterThan(0); // kiwi-seq:<browserSession> persisted per tab
  });

  it("stores the page context read by the heartbeat", () => {
    setTelemetryContext({ surface: "workspace", unitId: "", tool: "code" });
    expect(getTelemetryContext()).toEqual({ surface: "workspace", unitId: "", tool: "code" });
    setTelemetryContext(null);
    expect(getTelemetryContext()).toBeNull();
  });
});

describe("createTracker (§11.1)", () => {
  it("resolves after the event is persisted in the outbox, before delivery, and never throws", async () => {
    vi.useFakeTimers();
    const batches: EventInput[][] = [];
    setTelemetryTransport(() => ({
      batch: async (events) => {
        batches.push(events);
        return { results: events.map((e) => ({ eventId: e.eventId, status: "created" as const })) };
      },
      single: async (e) => ({ eventId: e.eventId, status: "created" }),
    }));
    const track = createTracker(ctx);
    await track("code_run", { ok: true });
    expect(JSON.parse(localStorage.getItem(outboxKey("c1", "s1")) || "[]")).toHaveLength(1);
    expect(batches).toHaveLength(0);
    expect(telemetryStatus().pending).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(batches).toHaveLength(1);
    expect(telemetryStatus().pending).toBe(0);
    expect(activeTelemetryIdentity()).toEqual({ classId: "c1", studentId: "s1" });
    await expect(createTracker({ ...ctx, classId: "" })("code_run", {})).resolves.toBeUndefined();
  });

  it("releaseTracker stops an unmounted identity's outbox; its queue is sent with that identity's next event (INTEGRATION)", async () => {
    vi.useFakeTimers();
    const batches: EventInput[][] = [];
    setTelemetryTransport(() => ({
      batch: async (events) => {
        batches.push(events);
        return { results: events.map((e) => ({ eventId: e.eventId, status: "created" as const })) };
      },
      single: async (e) => ({ eventId: e.eventId, status: "created" }),
    }));
    const preview = { ...ctx, studentId: "preview-instructor", preview: true };
    const track = createTracker(preview);
    await track("page_view", { route: "/preview/student/assignments" });
    releaseTracker(preview);   // Exit preview: the student app unmounts before the debounce fires
    await vi.advanceTimersByTimeAsync(5000);
    expect(batches).toHaveLength(0);   // nothing was sent with the teacher's headers
    expect(activeTelemetryIdentity()).toBeNull();
    expect(JSON.parse(localStorage.getItem(outboxKey("c1", "preview-instructor")) || "[]")).toHaveLength(1);
    activateTracker(preview);   // preview again
    await track("page_view", { route: "/preview/student/practice" });
    await vi.advanceTimersByTimeAsync(300);
    expect(batches.map((b) => b.length)).toEqual([2]);
  });

  it("flushTelemetry delivers the active identity's outbox (pagehide keepalive)", async () => {
    const keepalive: boolean[] = [];
    setTelemetryTransport(() => ({
      batch: async (events, k) => {
        keepalive.push(k);
        return { results: events.map((e) => ({ eventId: e.eventId, status: "created" as const })) };
      },
      single: async (e) => ({ eventId: e.eventId, status: "created" }),
    }));
    const track = createTracker(ctx);
    await track("page_view", { route: "/student/code" });
    await flushTelemetry({ keepalive: true });
    expect(keepalive).toEqual([true]);
  });
});

describe("AI-reply registry (paste.matchesAiReply, TELEMETRY-29)", () => {
  it("SHA-256 matches the standard vectors and WebCrypto", async () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const text of ["x".repeat(55), "x".repeat(64), "Use na.rm = TRUE — 中文 ✓", "y".repeat(1000)]) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
      expect(sha256Hex(text)).toBe(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""));
    }
  });

  it("matches a paste of ≥ 40 characters of a registered reply, after normalization, and keeps no text", () => {
    const reply = "To ignore missing values, pass na.rm = TRUE to mean(): mean(scores, na.rm = TRUE) returns the average.";
    registerAiReply(reply, 17);
    registerAiReply("Something unrelated that is long enough to have several windows.", 18);
    const pasted = "PASS NA.RM = TRUE TO MEAN():   mean(scores, na.rm = TRUE)";
    expect(matchAiReply(pasted)).toEqual({ matches: true, chatTurnId: 17 });
    expect(matchAiReply("mean(scores, na.rm = TRUE)")).toEqual({ matches: false, chatTurnId: null }); // < 40 chars
    expect(matchAiReply("A completely different paragraph that the AI never wrote at all.")).toEqual({ matches: false, chatTurnId: null });
    expect(JSON.stringify(recentAiReplies())).not.toContain("na.rm");
    expect(normalizeForMatch("  A\n\tB  ")).toBe("a b");
  });

  it("keeps only the 20 most recent replies", () => {
    for (let i = 0; i < 25; i += 1) registerAiReply(`Reply number ${i} with enough characters to make windows ${"·".repeat(40)}`, i);
    expect(recentAiReplies()).toHaveLength(20);
    expect(recentAiReplies()[0].chatTurnId).toBe(5);
  });
});
