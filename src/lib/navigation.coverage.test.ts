import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Coverage for the client navigation helpers: `navigate` (push/replace, preview-aware paths, scroll on page change),
 * `useRoute` (react's hooks are replaced by a synchronous stand-in so the popstate subscription runs in Node),
 * the per-tab browser session id, thread ids and the route matcher.
 */

const hooks = vi.hoisted(() => ({
  state: [] as unknown[],
  cleanups: [] as Array<() => void>,
  rerenders: 0,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(init: T | (() => T)) => {
      const box = { value: typeof init === "function" ? (init as () => T)() : init };
      hooks.state.push(box);
      return [box.value, (next: T) => {
        box.value = next;
        hooks.rerenders += 1;
      }] as const;
    },
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (typeof cleanup === "function") hooks.cleanups.push(cleanup);
    },
  };
});

type Nav = typeof import("./navigation");
let nav: Nav;
beforeEach(async () => {
  hooks.state.length = 0;
  hooks.cleanups.length = 0;
  hooks.rerenders = 0;
  vi.resetModules();
  nav = await import("./navigation");
});
afterEach(() => {
  hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function recordPopstates(): string[] {
  const seen: string[] = [];
  const listener = () => seen.push(location.pathname + location.search);
  addEventListener("popstate", listener);
  hooks.cleanups.push(() => removeEventListener("popstate", listener));
  return seen;
}

describe("navigate", () => {
  it("pushes a new entry, announces it and scrolls to the top of a new page", () => {
    const scrolls: unknown[] = [];
    vi.stubGlobal("scrollTo", (options: unknown) => scrolls.push(options));
    const seen = recordPopstates();
    const before = history.length;
    nav.navigate("/teacher/grading?assignmentId=w1");
    expect(location.pathname + location.search).toBe("/teacher/grading?assignmentId=w1");
    expect(history.length).toBe(before + 1);
    expect(history.state).toEqual({});
    expect(seen).toEqual(["/teacher/grading?assignmentId=w1"]);
    expect(scrolls).toEqual([{ top: 0, behavior: "instant" }]);
  });

  it("replaces the entry and keeps its state; a query-only change does not scroll", () => {
    history.replaceState({ keep: true }, "", "/teacher/grading?assignmentId=w1");
    const scrolls: unknown[] = [];
    vi.stubGlobal("scrollTo", (options: unknown) => scrolls.push(options));
    const before = history.length;
    nav.navigate("/teacher/grading?assignmentId=w2", true);
    expect(location.search).toBe("?assignmentId=w2");
    expect(history.length).toBe(before);
    expect(history.state).toEqual({ keep: true });
    expect(scrolls).toEqual([]);
  });

  it("does nothing when the target is the current URL", () => {
    history.replaceState(null, "", "/teacher/home?range=this_week");
    const seen = recordPopstates();
    nav.navigate("/teacher/home?range=this_week");
    expect(seen).toEqual([]);
  });

  it("keeps student links inside the staff preview", () => {
    history.replaceState(null, "", "/preview/student/assignments");
    nav.navigate("/student/assignments/w1/answer");
    expect(location.pathname).toBe("/preview/student/assignments/w1/answer");
    nav.navigate("/teacher/home");
    expect(location.pathname).toBe("/teacher/home");
  });

  it("previewAwarePath only rewrites /student paths while previewing", () => {
    expect(nav.previewAwarePath("/student", "/preview/student/kiwi")).toBe("/preview/student");
    expect(nav.previewAwarePath("/student?x=1", "/preview/student/kiwi")).toBe("/preview/student?x=1");
    expect(nav.previewAwarePath("/students", "/preview/student/kiwi")).toBe("/students");
    expect(nav.previewAwarePath("/student/kiwi", "/student/code")).toBe("/student/kiwi");
  });
});

describe("useRoute", () => {
  it("reads the current route and follows popstate until unmounted", () => {
    history.replaceState(null, "", "/student/assignments?q=1");
    expect(nav.useRoute()).toBe("/student/assignments?q=1");
    history.pushState(null, "", "/student/code");
    dispatchEvent(new PopStateEvent("popstate"));
    expect((hooks.state[0] as { value: string }).value).toBe("/student/code");
    hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
    const rerenders = hooks.rerenders;
    dispatchEvent(new PopStateEvent("popstate"));
    expect(hooks.rerenders).toBe(rerenders);
  });
});

describe("getBrowserSession", () => {
  it("creates one id per tab, stores it and reuses it", () => {
    const id = nav.getBrowserSession();
    expect(id).toMatch(/^session-[0-9a-f-]{36}$/);
    expect(sessionStorage.getItem("kiwi-lab-session")).toBe(id);
    sessionStorage.setItem("kiwi-lab-session", "session-other");
    expect(nav.getBrowserSession()).toBe(id); // cached in memory after first use
  });

  it("reuses an id stored by an earlier page load", () => {
    sessionStorage.setItem("kiwi-lab-session", "session-earlier");
    expect(nav.getBrowserSession()).toBe("session-earlier");
  });

  it("falls back to an in-memory id when storage is unavailable", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    const id = nav.getBrowserSession();
    expect(id).toMatch(/^session-/);
    expect(nav.getBrowserSession()).toBe(id);
  });
});

describe("threadFor", () => {
  it("keeps short scopes readable and replaces unsafe characters", () => {
    expect(nav.threadFor("hw 3/q1")).toBe("thread-hw-3-q1");
    expect(nav.threadFor("a:b@c.d_e-f")).toBe("thread-a:b@c.d_e-f");
  });
  it("hashes long scopes to a stable 99-character id", () => {
    const long = "x".repeat(200);
    const id = nav.threadFor(long);
    expect(id).toHaveLength(99);
    expect(id.startsWith(`thread-${"x".repeat(83)}-`)).toBe(true);
    expect(id).toMatch(/-[0-9a-f]{8}$/);
    expect(nav.threadFor(long)).toBe(id);
    expect(nav.threadFor(`${long}y`)).not.toBe(id);
  });
});

describe("matchRoute", () => {
  it("captures decoded segments and a trailing wildcard", () => {
    expect(nav.matchRoute("/a/:id", "/a/x%20y/")).toEqual({ id: "x y" });
    expect(nav.matchRoute("/files/*", "/files/a/b/c")).toEqual({ "*": "a/b/c" });
    expect(nav.matchRoute("/", "/")).toEqual({});
  });
  it("rejects missing, empty, extra or malformed segments", () => {
    expect(nav.matchRoute("/a/:id", "/a")).toBeNull();
    expect(nav.matchRoute("/a/:id/b", "/a//b")).toBeNull();
    expect(nav.matchRoute("/a", "/a/b")).toBeNull();
    expect(nav.matchRoute("/a/:id", "/a/%E0%A4%A")).toBeNull();
    expect(nav.matchRoute("/a/b", "/a/c")).toBeNull();
  });
});
