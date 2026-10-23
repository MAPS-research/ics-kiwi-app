import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  DEFAULT_TIME_PRESET, TIME_PRESETS, fallbackTimeRange, initialTimeSelection, isTimePreset, readStoredSelection, storeSelection,
  useTimeRange, type TimeRangeStore,
} from "./timeRange";
import type { TimeRange } from "../types";

/*
 * Coverage for the top-bar time range store (§13.0): `useTimeRange` effects (server range, failures, popstate sync,
 * `setTimePreset`) and the storage fallbacks. Node tests have no renderer, so react's hooks are replaced by a minimal
 * synchronous hook runtime (state slots, effects with deps and cleanups, refs, callbacks) — enough for this hook.
 */

const hooks = vi.hoisted(() => {
  type Effect = { deps?: readonly unknown[]; cleanup?: void | (() => void) };
  const rt = {
    slots: [] as unknown[],
    index: 0,
    pending: [] as Array<() => void>,
    render: null as null | (() => void),
    looping: false,
    dirty: false,
    renders: 0,
  };
  const changed = (prev: readonly unknown[] | undefined, next: readonly unknown[] | undefined) =>
    !prev || !next || prev.length !== next.length || prev.some((value, i) => !Object.is(value, next[i]));
  function loop(): void {
    if (rt.looping) {
      rt.dirty = true;
      return;
    }
    rt.looping = true;
    try {
      let guard = 0;
      do {
        if (++guard > 50) throw new Error("render loop");
        rt.dirty = false;
        rt.index = 0;
        rt.renders += 1;
        rt.render?.();
        const effects = rt.pending.splice(0);
        effects.forEach((run) => run());
      } while (rt.dirty);
    } finally {
      rt.looping = false;
    }
  }
  function slot<T>(make: () => T): T {
    const i = rt.index++;
    if (!(i in rt.slots)) rt.slots[i] = make();
    return rt.slots[i] as T;
  }
  return {
    rt,
    loop,
    useState<T>(init: T | (() => T)) {
      const s = slot(() => {
        const box = { value: typeof init === "function" ? (init as () => T)() : init, set: (_next: T | ((prev: T) => T)) => undefined as void };
        box.set = (next) => {
          const value = typeof next === "function" ? (next as (prev: T) => T)(box.value) : next;
          if (Object.is(value, box.value)) return;
          box.value = value;
          loop();
        };
        return box;
      });
      return [s.value, s.set] as const;
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      const s = slot<Effect>(() => ({}));
      if (!changed(s.deps, deps)) return;
      rt.pending.push(() => {
        if (typeof s.cleanup === "function") s.cleanup();
        s.cleanup = effect();
        s.deps = deps;
      });
    },
    useRef<T>(initial: T) {
      return slot(() => ({ current: initial }));
    },
    useCallback<T>(fn: T, deps: readonly unknown[]) {
      const s = slot<{ fn: T; deps?: readonly unknown[] }>(() => ({ fn }));
      if (changed(s.deps, deps)) {
        s.fn = fn;
        s.deps = deps;
      }
      return s.fn;
    },
    unmount() {
      for (const s of rt.slots) {
        const effect = s as Effect;
        if (effect && typeof effect === "object" && "cleanup" in effect && typeof effect.cleanup === "function") effect.cleanup();
      }
      rt.slots = [];
      rt.render = null;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: hooks.useState, useEffect: hooks.useEffect, useRef: hooks.useRef, useCallback: hooks.useCallback };
});

function mount(classId: string, enabled?: boolean): { current: () => TimeRangeStore; unmount: () => void } {
  let latest: TimeRangeStore | undefined;
  hooks.rt.slots = [];
  hooks.rt.render = () => {
    latest = enabled === undefined ? useTimeRange(classId) : useTimeRange(classId, enabled);
  };
  hooks.loop();
  return { current: () => latest as TimeRangeStore, unmount: hooks.unmount };
}

function serverRange(over: Partial<TimeRange> = {}): TimeRange {
  return {
    preset: "this_week", effectivePreset: "this_week", from: "2026-10-19T00:00:00Z", to: "2026-10-26T00:00:00Z",
    compareFrom: "2026-10-12T00:00:00Z", compareTo: "2026-10-19T00:00:00Z", label: "This week", compareLabel: "Last week", ...over,
  };
}

/** A promise the test resolves or rejects later. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let unmountLast: (() => void) | undefined;
beforeEach(() => {
  unmountLast = undefined;
});
afterEach(() => {
  unmountLast?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function track<T extends { unmount: () => void }>(view: T): T {
  unmountLast = view.unmount;
  return view;
}

describe("useTimeRange", () => {
  it("starts from the URL, shows the fallback while loading, then the server range", async () => {
    history.replaceState(null, "", "/teacher/insights/activity?range=this_week");
    const pending = deferred<TimeRange>();
    const spy = vi.spyOn(api, "timeRange").mockReturnValue(pending.promise);
    const view = track(mount("c1"));
    expect(spy).toHaveBeenCalledWith("c1", "this_week", undefined);
    expect(view.current()).toMatchObject({ loading: true, error: "", selection: { preset: "this_week" } });
    expect(view.current().timeRange).toEqual(fallbackTimeRange({ preset: "this_week" }));
    pending.resolve(serverRange());
    await settle();
    expect(view.current()).toMatchObject({ loading: false, error: "", timeRange: serverRange() });
  });

  it("does not ask the server when disabled or without a class", () => {
    const spy = vi.spyOn(api, "timeRange");
    const disabled = mount("c1", false);
    expect(disabled.current().timeRange).toEqual(fallbackTimeRange({ preset: DEFAULT_TIME_PRESET }));
    disabled.unmount();
    track(mount(""));
    expect(spy).not.toHaveBeenCalled();
  });

  it("explains a failed range and keeps a labelled fallback", async () => {
    vi.spyOn(api, "timeRange").mockRejectedValue(new Error("server down"));
    const view = track(mount("c1"));
    await settle();
    expect(view.current().error).toBe("Time range unavailable: server down");
    expect(view.current().loading).toBe(false);
    expect(view.current().timeRange).toMatchObject({
      preset: "since_last_class", from: null, note: "Showing all activity because the time range could not be computed.",
    });
  });

  it("reports non-Error rejections as text", async () => {
    vi.spyOn(api, "timeRange").mockRejectedValue("offline");
    const view = track(mount("c1"));
    await settle();
    expect(view.current().error).toBe("Time range unavailable: offline");
  });

  it("setTimePreset stores the choice, rewrites the URL and requests the new range", async () => {
    history.replaceState({ keep: 1 }, "", "/teacher/home?group=g1");
    const spy = vi.spyOn(api, "timeRange").mockImplementation(async (_classId, preset) => serverRange({ preset, effectivePreset: preset }));
    const popstates: unknown[] = [];
    const onPop = (event: Event) => popstates.push(event.type);
    addEventListener("popstate", onPop);
    const view = track(mount("c1"));
    await settle();
    view.current().setTimePreset("custom", { from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" });
    await settle();
    removeEventListener("popstate", onPop);
    expect(view.current().selection).toEqual({ preset: "custom", from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" });
    expect(location.pathname).toBe("/teacher/home");
    expect(new URLSearchParams(location.search).get("group")).toBe("g1");
    expect(new URLSearchParams(location.search).get("range")).toBe("custom");
    expect(history.state).toEqual({ keep: 1 });
    expect(popstates).toEqual(["popstate"]);
    expect(readStoredSelection()).toEqual({ preset: "custom", from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" });
    expect(spy).toHaveBeenLastCalledWith("c1", "custom", { from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" });
    expect(view.current().timeRange.preset).toBe("custom");
  });

  it("a custom preset without dates falls back to the default preset", async () => {
    vi.spyOn(api, "timeRange").mockResolvedValue(serverRange());
    const view = track(mount("c1"));
    view.current().setTimePreset("whole_term");
    expect(view.current().selection).toEqual({ preset: "whole_term" });
    view.current().setTimePreset("custom");
    expect(view.current().selection).toEqual({ preset: DEFAULT_TIME_PRESET });
    expect(new URLSearchParams(location.search).get("range")).toBe(DEFAULT_TIME_PRESET);
    await settle();
  });

  it("follows back/forward navigation to a different range only", async () => {
    const spy = vi.spyOn(api, "timeRange").mockResolvedValue(serverRange());
    const view = track(mount("c1"));
    const rendersBefore = hooks.rt.renders;
    history.pushState(null, "", "/teacher/home?range=since_last_class");
    dispatchEvent(new PopStateEvent("popstate"));
    history.pushState(null, "", "/teacher/home");
    dispatchEvent(new PopStateEvent("popstate"));
    expect(hooks.rt.renders).toBe(rendersBefore); // same selection, or no ?range: nothing to do
    history.pushState(null, "", "/teacher/home?range=last_7_days");
    dispatchEvent(new PopStateEvent("popstate"));
    expect(view.current().selection).toEqual({ preset: "last_7_days" });
    expect(spy).toHaveBeenLastCalledWith("c1", "last_7_days", undefined);
    await settle();
  });

  it("ignores answers that arrive after unmount and stops listening to popstate", async () => {
    const pending = deferred<TimeRange>();
    vi.spyOn(api, "timeRange").mockReturnValue(pending.promise);
    const removed: string[] = [];
    const realRemove = globalThis.removeEventListener;
    vi.stubGlobal("removeEventListener", (type: string, listener: EventListener) => {
      removed.push(type);
      realRemove(type, listener);
    });
    const view = mount("c1");
    const before = view.current();
    view.unmount();
    expect(removed).toEqual(["popstate"]);
    const renders = hooks.rt.renders;
    pending.resolve(serverRange());
    await settle();
    expect(hooks.rt.renders).toBe(renders);
    expect(before.loading).toBe(true);
  });

  it("ignores a failure that arrives after unmount", async () => {
    const pending = deferred<TimeRange>();
    vi.spyOn(api, "timeRange").mockReturnValue(pending.promise);
    const view = mount("c1");
    view.unmount();
    const renders = hooks.rt.renders;
    pending.reject(new Error("late"));
    await settle();
    expect(hooks.rt.renders).toBe(renders);
  });
});

describe("stored selection", () => {
  it.each([
    ["missing", null, null],
    ["corrupt JSON", "{", null],
    ["an unknown preset", JSON.stringify({ preset: "yesterday" }), null],
    ["a custom range without dates", JSON.stringify({ preset: "custom", from: "a" }), null],
    ["a custom range", JSON.stringify({ preset: "custom", from: "a", to: "b", extra: 1 }), { preset: "custom", from: "a", to: "b" }],
    ["a preset with stray dates", JSON.stringify({ preset: "this_class", from: "a", to: "b" }), { preset: "this_class" }],
  ])("reads %s", (_label, raw, expected) => {
    if (raw !== null) sessionStorage.setItem("kiwi-time-range", raw);
    expect(readStoredSelection()).toEqual(expected);
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(readStoredSelection()).toBeNull();
    expect(() => storeSelection({ preset: "whole_term" })).not.toThrow();
    expect(initialTimeSelection("")).toEqual({ preset: DEFAULT_TIME_PRESET });
  });

  it("knows the six presets", () => {
    expect(TIME_PRESETS).toHaveLength(6);
    expect(TIME_PRESETS.every(isTimePreset)).toBe(true);
    expect(isTimePreset("yesterday")).toBe(false);
    expect(isTimePreset(3)).toBe(false);
  });

  it("labels a fallback with an optional note", () => {
    expect(fallbackTimeRange({ preset: "whole_term" }, "Note")).toMatchObject({ note: "Note", compareFrom: null, compareTo: null });
    expect(fallbackTimeRange({ preset: "custom", from: "2026-10-01T00:00:00Z" })).toMatchObject({ from: null, to: null });
  });
});
