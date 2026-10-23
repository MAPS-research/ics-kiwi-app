import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDraftSync,
  draftNotice,
  mergeDrafts,
  pruneStale,
  readLocalDraft,
  savedLabel,
  UPDATED_NOTICE,
  writeLocalDraft,
} from "./draftSync";
import type { AnswerDraft } from "../../types";

const draft = (answers: Record<string, [string, string]>, version: number | null = 1): AnswerDraft => ({
  assignmentId: "w1", answers: Object.fromEntries(Object.entries(answers).map(([k, [value, updatedAt]]) => [k, { value, updatedAt }])),
  updatedAt: null, assignmentVersion: version,
});

describe("draft sync debounce (ASSESS-11)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves once 2 s after the last edit with the latest values", async () => {
    const save = vi.fn(async (answers: Record<string, string>) => draft(Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [v, "2026-10-22T00:00:00Z"]]))));
    const saved = vi.fn();
    let clock = 1000;
    const sync = createDraftSync({ save, onSaved: saved, now: () => clock });
    sync.update("q1", "4");
    clock = 1500;
    vi.advanceTimersByTime(1500);
    sync.update("q1", "42");
    sync.update("q2", "words");
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ q1: "42", q2: "words" }, 1500);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(sync.pending()).toEqual({});
  });

  it("keeps failed saves pending and retries on flush", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(draft({}));
    const onError = vi.fn();
    const sync = createDraftSync({ save, onError });
    sync.update("q1", "4");
    await sync.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(sync.pending()).toEqual({ q1: "4" });
    await sync.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(sync.pending()).toEqual({});
  });

  it("does not drop an edit made while a save is in flight", async () => {
    let release: (d: AnswerDraft) => void = () => undefined;
    const save = vi.fn(() => new Promise<AnswerDraft>((resolve) => (release = resolve)));
    const sync = createDraftSync({ save });
    sync.update("q1", "a");
    const first = sync.flush();
    sync.update("q1", "ab");
    release(draft({}));
    await first;
    expect(sync.pending()).toEqual({ q1: "ab" });
    sync.dispose();
  });
});

describe("stale keys and merging (ASSESS-12, AU-D1-14)", () => {
  it("prunes answers of removed questions", () => {
    expect(pruneStale({ q1: "4", old: "x" }, ["q1", "q2"])).toEqual({ answers: { q1: "4" }, removed: ["old"] });
  });
  it("keeps the newer of server and local values", () => {
    const server = draft({ q1: ["server", "2026-10-22T10:00:00Z"], q2: ["kept", "2026-10-22T10:00:00Z"] });
    const local = { q1: { value: "local newer", ts: Date.parse("2026-10-22T10:05:00Z") }, q2: { value: "local older", ts: 1 }, q3: { value: "only here", ts: 5 } };
    expect(mergeDrafts(server, local)).toEqual({ answers: { q1: "local newer", q2: "kept", q3: "only here" }, unsynced: ["q1", "q3"] });
    expect(mergeDrafts(null, {})).toEqual({ answers: {}, unsynced: [] });
  });
  it("shows the updated notice when the version changed or keys were dropped", () => {
    expect(draftNotice(1, 2, [])).toBe(UPDATED_NOTICE);
    expect(draftNotice(2, 2, ["old"])).toBe(UPDATED_NOTICE);
    expect(draftNotice(2, 2, [])).toBe("");
    expect(draftNotice(null, 2, [])).toBe("");
  });
  it("R-m01: no 'updated' notice once the assignment no longer accepts answers (closed by its revision)", () => {
    expect(draftNotice(1, 2, [], "closed")).toBe("");
    expect(draftNotice(1, 2, ["old"], "archived")).toBe("");
    expect(draftNotice(1, 2, [], "past_due")).toBe(UPDATED_NOTICE);
    expect(draftNotice(1, 2, [], "open")).toBe(UPDATED_NOTICE);
  });
});

describe("local fallback copy", () => {
  it("round-trips v2 entries and reads the v0.5.1 format", () => {
    expect(writeLocalDraft("k", { q1: { value: "4", ts: 9 } })).toBe(true);
    expect(readLocalDraft("k")).toEqual({ q1: { value: "4", ts: 9 } });
    localStorage.setItem("legacy", JSON.stringify({ q1: "old answer", bad: 3 }));
    expect(readLocalDraft("legacy")).toEqual({ q1: { value: "old answer", ts: 0 } });
    localStorage.setItem("broken", "{");
    expect(readLocalDraft("broken")).toEqual({});
  });
  it("labels the save state", () => {
    expect(savedLabel({ savedAt: Date.parse("2026-10-22T02:42:00Z"), pending: 0, failing: false }, "Asia/Shanghai")).toBe("Saved to your account · 10:42");
    expect(savedLabel({ savedAt: null, pending: 1, failing: false })).toBe("Saving…");
    expect(savedLabel({ savedAt: null, pending: 1, failing: true })).toBe("Saved on this device only — will retry");
  });
});
