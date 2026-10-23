import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LectureMaterialsView } from "../chapters/LectureMaterialsPage";
import { DataHealthView, localNote, outageLabel } from "../insights/DataHealthPage";
import { setDisplayTimeZone } from "../../lib/format";
import { KiwiSyncLoop, SYNC_CONTINUE_MS, SYNC_INTERVAL_MS, type KiwiSyncApi } from "./useKiwiSync";
import type { Course, DataHealth, KiwiSyncStatus } from "../../types";

const base: KiwiSyncStatus = { connected: true, lastSynced: null, error: null, hasMore: false, metadataTruncated: false, nativeEvents: 0, materials: [] };

function fakeApi(results: Partial<KiwiSyncStatus>[]) {
  const calls = { status: 0, sync: 0 };
  const api: KiwiSyncApi = {
    status: async () => {
      calls.status += 1;
      return base;
    },
    sync: async () => {
      calls.sync += 1;
      return { ...base, ...(results.length > 1 ? results.shift() : results[0]) };
    },
  };
  return { api, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("KiwiSyncProvider loop (TELEMETRY-30, AU-D4-18, AU-D4-23)", () => {
  it("one loop per teacher session: three pages reading the context issue one sync per interval", async () => {
    const { api, calls } = fakeApi([{ imported: 0 }]);
    const loop = new KiwiSyncLoop("c1", api, () => true);
    const pages = [vi.fn(), vi.fn(), vi.fn()].map((listener) => loop.subscribe(listener));
    loop.start();
    loop.start(); // a second start (e.g. a re-render) does not create a second loop
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.sync).toBe(1);
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(calls.sync).toBe(2);
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 3);
    expect(calls.sync).toBe(5);
    pages.forEach((unsubscribe) => unsubscribe());
    loop.stop();
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 3);
    expect(calls.sync).toBe(5);
  });

  it("newActivity becomes true only when a sync imported records; acknowledge bumps the revision once", async () => {
    const { api } = fakeApi([{ imported: 0, nativeEvents: 4 }, { imported: 0, nativeEvents: 4 }, { imported: 2, nativeEvents: 6 }, { imported: 0 }]);
    const loop = new KiwiSyncLoop("c1", api, () => true);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.getState().newActivity).toBe(false);
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(loop.getState().newActivity).toBe(false);
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(loop.getState().newActivity).toBe(true);
    expect(loop.getState().revision).toBe(0); // loaded pages are not reset by a sync
    loop.acknowledge();
    expect(loop.getState()).toMatchObject({ newActivity: false, revision: 1 });
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(loop.getState().newActivity).toBe(false);
    loop.stop();
  });

  it("continues quickly while Kiwi reports more history, and backs off after an error", async () => {
    let fail = false;
    const calls: number[] = [];
    const api: KiwiSyncApi = {
      status: async () => base,
      sync: async () => {
        calls.push(Date.now());
        if (fail) throw new Error("Could not reach Kiwi");
        return { ...base, hasMore: calls.length < 3, imported: 1 };
      },
    };
    const loop = new KiwiSyncLoop("c1", api, () => true);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SYNC_CONTINUE_MS * 2);
    expect(calls).toHaveLength(3);
    fail = true;
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
    expect(loop.getState().error).toBe("Could not reach Kiwi");
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS - 1);
    expect(calls).toHaveLength(4);
    loop.stop();
  });

  it("does not sync without a Kiwi identity or when the course is not linked", async () => {
    const { api, calls } = fakeApi([{}]);
    const loop = new KiwiSyncLoop("c1", api, () => false);
    loop.start();
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 2);
    expect(calls).toEqual({ status: 1, sync: 0 });
    loop.stop();
  });
});

// Data health view (TELEMETRY-11/16/20 markup); the page reads Kiwi import status from the same sync data.

const health: DataHealth = {
  range: { preset: "whole_term", effectivePreset: "whole_term", from: null, to: "2026-10-22T02:00:00+00:00", compareFrom: null, compareTo: null, label: "Whole term", compareLabel: null },
  aiTurns: { serverTurns: 3, withServerEvent: 2, legacyClientOnly: 1, mismatch: 1 },
  aiCalls: { total: 6, ok: 3, turnedAway: 1, blocked: 1, other: 0, failed: 1, byStatus: { ok: 3, rate_limited: 1, provider_error: 1, blocked_chapter: 1 } },
  events: { received: 120, duplicatesIgnored: 4, truncated: 1, clientGapsReported: 41, clockSkewOver5Min: 0, rejected: [{ code: "invalid_payload", count: 2 }] },
  heartbeats: { received: 50, counted: 40, duplicates: 10 },
  identity: { unverifiedEvents: 0, nonRosterIdentities: 0, previewEvents: 3, staffEvents: 0 },
  generatedItems: { total: 2, verified: 1, mismatch: 0, rejected: 0, flagged: 1 },
  clientReported: { aiRequestsUnreached: 2, serverOwnedFromClient: 1, unknownPayloadKeys: [{ type: "code_run", keys: ["questionTitle"], count: 7 }] },
  legacyChecks: { legacyServer: 4, rejudged: 3, notRejudged: 1 },
  outages: [{ from: "2026-10-21T02:00:00+00:00", to: "2026-10-21T02:12:00+00:00", kind: "client_gap", count: 41, browsers: 3 } as DataHealth["outages"][number]],
  kiwi: {
    connected: true, lastSynced: "2026-10-22T01:00:00+00:00", error: null, hasMore: false, metadataTruncated: false, nativeEvents: 21,
    excludedByDesign: 13, excludedNotEnrolled: 4, materials: [],
    perStudent: [{ studentId: "s1", label: "Demo Student", lastImportedAt: "2026-10-22T01:00:00+00:00", backfilled: true }],
  },
  retentionDue: {},
};

describe("Data health view", () => {
  it("reports counts, outage periods and Kiwi import gaps in teacher language", () => {
    const html = renderToStaticMarkup(createElement(DataHealthView, { health, timeZone: "Asia/Shanghai" }));
    expect(html).toContain("Kiwi activity from students no longer enrolled: 4 (not imported)");
    // review 2 (TEACHER-13): course-rule refusals are their own row, and the turn count names what it counts
    expect(html).toContain("Blocked by course rules");
    expect(html).toContain("With a server analytics event");
    expect(html).not.toContain("Visible in analytics");
    expect(html).toContain("Legacy CSS Lab chats stored in Kiwi (excluded by design): 13");
    expect(html).toContain("10/21 10:00–10:12 · Activity not saved by 3 browsers (41 events)");
    expect(html).toContain("Lab AI tutor turns");
    expect(html).toContain("Missing from analytics");
    expect(html).toContain("questionTitle");
    expect(html).toContain("Demo Student");
    expect(html).not.toContain('class="eyebrow"');
  });
  it("labels server-error and Kiwi outages", () => {
    expect(outageLabel({ from: "2026-10-21T02:20:00+00:00", to: "2026-10-21T02:23:00+00:00", kind: "server_error", count: 6 }, "Asia/Shanghai")).toBe(
      "10/21 10:20–10:23 · Server errors (6)",
    );
    expect(outageLabel({ from: "2026-10-21T02:30:00+00:00", to: "2026-10-21T02:31:00+00:00", kind: "kiwi_unreachable", count: 1 }, "Asia/Shanghai")).toContain(
      "Kiwi unreachable (1 failed request)",
    );
    // RT-07: with no zone passed, the times follow the course zone like the date does (not the browser zone)
    setDisplayTimeZone("Pacific/Kiritimati");
    try {
      expect(outageLabel({ from: "2026-10-21T02:20:00+00:00", to: "2026-10-21T02:23:00+00:00", kind: "server_error", count: 6 })).toBe(
        "10/21 16:20–16:23 · Server errors (6)",
      );
    } finally {
      setDisplayTimeZone(null);
    }
  });
});

describe("Linked lecture materials (TELEMETRY-18, NM45)", () => {
  it("links each material's reading data and says mapping never changes recorded activity", () => {
    const course = { units: [{ id: "r-basics", title: "R basics" }] } as unknown as Course;
    const status = { connected: true, lastSynced: null, error: null, hasMore: false, metadataTruncated: false, nativeEvents: 1, materials: [{ id: "m1", title: "Lecture 2", unitId: "" }] };
    const html = renderToStaticMarkup(createElement(LectureMaterialsView, { course, status, busyId: "", readOnly: false, onMap: () => undefined }));
    expect(html).toContain("View lecture reading");
    expect(html).toContain("group=reading");
    expect(html).toContain("never");
    expect(html).toContain('aria-label="Chapter for Lecture 2"');
  });
});

describe("SB-m13: local fallbacks in Data health", () => {
  it("says how many answers and items came without AI", () => {
    expect(localNote(6, 6, "by local guidance")).toBe("All by local guidance, no AI");
    expect(localNote(2, 6, "local templates")).toBe("2 local templates, no AI");
    expect(localNote(0, 6, "local templates")).toBeUndefined();
    expect(localNote(undefined, 6, "local templates")).toBeUndefined();
  });
});
