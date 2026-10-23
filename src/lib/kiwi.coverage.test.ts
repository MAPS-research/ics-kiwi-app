import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostChatPolicy, KiwiClient } from "../types";

/*
 * Coverage for the Kiwi SDK wrapper (§7.9) and the host chat policy messaging (§15.3). `getKiwi` caches its client
 * promise at module level, so every test imports a fresh module. Node tests have no DOM: the script loader runs against
 * a small `document` stub, and `useEffect` runs synchronously (react is mocked below) so `useHostChatPolicy` can be
 * exercised without a renderer.
 */

const effects = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (typeof cleanup === "function") effects.cleanups.push(cleanup);
    },
  };
});

type Kiwi = typeof import("./kiwi");
async function freshKiwi(): Promise<Kiwi> {
  vi.resetModules();
  return import("./kiwi");
}

interface FakeScript { src: string; onload: null | (() => void); onerror: null | (() => void); remove: () => void; removed: boolean }
type Loader = (script: FakeScript) => void;

/** `document` stub whose <head> runs `loader` for every appended script (load, fail or hang). */
function stubDocument(loader: Loader, referrer = ""): FakeScript[] {
  const scripts: FakeScript[] = [];
  vi.stubGlobal("document", {
    referrer,
    createElement: (tag: string) => {
      expect(tag).toBe("script");
      const script: FakeScript = {
        src: "", onload: null, onerror: null, removed: false,
        remove() {
          script.removed = true;
        },
      };
      return script;
    },
    head: {
      appendChild: (script: FakeScript) => {
        scripts.push(script);
        loader(script);
      },
    },
  });
  return scripts;
}

function fakeClient(mode: "live" | "sim" = "sim", ready: () => Promise<unknown> = async () => ({})) {
  const updates: string[] = [];
  const client = {
    mode,
    context: null,
    ready,
    updateContext: (text: string) => {
      updates.push(text);
    },
  } as unknown as KiwiClient;
  return { client, updates };
}

function installSdk(client: KiwiClient): Array<Record<string, unknown>> {
  const options: Array<Record<string, unknown>> = [];
  (window as Window).KiwiApp = {
    create: (opts: Record<string, unknown>) => {
      options.push(opts);
      return client;
    },
  };
  return options;
}

beforeEach(() => {
  effects.cleanups.length = 0;
  delete (window as Window).KiwiApp;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (window as Window).KiwiApp;
  location.protocol = "http:";
});

describe("kiwiTeacherEntryUrl", () => {
  it("uses the local Kiwi origin by default", async () => {
    vi.stubEnv("VITE_KIWI_ORIGIN", "");
    const kiwi = await freshKiwi();
    expect(kiwi.kiwiTeacherEntryUrl()).toBe("http://localhost:3001/admin/app/ics-r-lab");
  });
  it("uses the configured origin without its trailing slash", async () => {
    vi.stubEnv("VITE_KIWI_ORIGIN", "https://kiwi.example.edu/");
    const kiwi = await freshKiwi();
    expect(kiwi.kiwiTeacherEntryUrl()).toBe("https://kiwi.example.edu/admin/app/ics-r-lab");
  });
});

describe("getKiwi", () => {
  it("creates one client from an already loaded SDK and caches it", async () => {
    vi.stubEnv("VITE_KIWI_ORIGIN", "");
    const scripts = stubDocument(() => {
      throw new Error("no script should load");
    });
    const { client } = fakeClient();
    const options = installSdk(client);
    const kiwi = await freshKiwi();
    const first = kiwi.getKiwi();
    expect(kiwi.getKiwi()).toBe(first);
    await expect(first).resolves.toBe(client);
    expect(scripts).toHaveLength(0);
    expect(options).toEqual([{ appSlug: "ics-r-lab", mode: "auto", timeoutMs: 15000 }]);
  });

  it("asks for live mode when the Lab runs inside a parent frame", async () => {
    vi.stubEnv("VITE_KIWI_ORIGIN", "");
    vi.stubGlobal("parent", { postMessage: () => undefined });
    const { client } = fakeClient("live");
    const options = installSdk(client);
    const kiwi = await freshKiwi();
    await kiwi.getKiwi();
    expect(options[0].mode).toBe("live");
  });

  it("loads the host SDK first when an origin is configured", async () => {
    vi.stubEnv("VITE_KIWI_ORIGIN", "http://kiwi.test:3001/");
    const { client } = fakeClient();
    const scripts = stubDocument((script) => {
      installSdk(client);
      script.onload?.();
    });
    const kiwi = await freshKiwi();
    await expect(kiwi.getKiwi()).resolves.toBe(client);
    expect(scripts.map((s) => s.src)).toEqual(["http://kiwi.test:3001/sdk/v1/kiwi-app-sdk.js"]);
  });

  it("falls back to the bundled SDK when the host SDK fails", async () => {
    vi.stubEnv("VITE_KIWI_ORIGIN", "http://kiwi.test:3001");
    const { client } = fakeClient();
    const scripts = stubDocument((script) => {
      if (script.src.startsWith("http://kiwi.test")) script.onerror?.();
      else {
        installSdk(client);
        script.onload?.();
      }
    });
    const kiwi = await freshKiwi();
    await expect(kiwi.getKiwi()).resolves.toBe(client);
    expect(scripts.map((s) => s.src)).toEqual(["http://kiwi.test:3001/sdk/v1/kiwi-app-sdk.js", "/sdk/v1/kiwi-app-sdk.js"]);
  });

  it("skips an http host SDK on an https page (mixed content)", async () => {
    vi.stubEnv("VITE_KIWI_ORIGIN", "http://kiwi.test:3001");
    location.protocol = "https:";
    const { client } = fakeClient();
    const scripts = stubDocument((script) => {
      installSdk(client);
      script.onload?.();
    });
    const kiwi = await freshKiwi();
    await kiwi.getKiwi();
    expect(scripts.map((s) => s.src)).toEqual(["/sdk/v1/kiwi-app-sdk.js"]);
  });

  it("reports a bundled SDK that cannot load", async () => {
    vi.stubEnv("VITE_KIWI_ORIGIN", "");
    stubDocument((script) => script.onerror?.());
    const kiwi = await freshKiwi();
    await expect(kiwi.getKiwi()).rejects.toThrow("SDK could not load: /sdk/v1/kiwi-app-sdk.js");
  });

  it("reports a script that loads without defining KiwiApp", async () => {
    vi.stubEnv("VITE_KIWI_ORIGIN", "");
    stubDocument((script) => script.onload?.());
    const kiwi = await freshKiwi();
    await expect(kiwi.getKiwi()).rejects.toThrow("Kiwi SDK is not loaded");
  });

  it("times out a script that never answers and removes it", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_KIWI_ORIGIN", "");
    const scripts = stubDocument(() => undefined);
    const kiwi = await freshKiwi();
    const result = kiwi.getKiwi().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(String(await result)).toContain("SDK loading timed out: /sdk/v1/kiwi-app-sdk.js");
    expect(scripts[0].removed).toBe(true);
  });

  it("fails when Kiwi never provides a course identity", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_KIWI_ORIGIN", "");
    const { client } = fakeClient("sim", () => new Promise(() => undefined));
    installSdk(client);
    const kiwi = await freshKiwi();
    const result = kiwi.getKiwi().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15000);
    expect(String(await result)).toContain("Kiwi did not provide a course identity");
  });
});

describe("host chat messages", () => {
  it("sends nothing before a client is known", async () => {
    const kiwi = await freshKiwi();
    expect(() => kiwi.setHostDefaultContext(null, "Course X.")).not.toThrow();
  });

  it("updates the simulator context only (the simulator has no chat availability message)", async () => {
    const kiwi = await freshKiwi();
    const { client, updates } = fakeClient("sim");
    kiwi.setHostDefaultContext(client, "Course X.");
    expect(updates).toEqual(["Course X."]);
    kiwi.useHostChatPolicy({ available: false, contextNote: "Assignment: HW 3." });
    expect(updates).toEqual(["Course X.", "Course X.\nAssignment: HW 3."]);
  });

  it("posts both messages to the parent frame at the referrer origin in live mode", async () => {
    vi.stubEnv("VITE_KIWI_ORIGIN", "");
    const posted: Array<[unknown, string]> = [];
    vi.stubGlobal("parent", { postMessage: (message: unknown, origin: string) => posted.push([message, origin]) });
    stubDocument(() => undefined, "https://kiwi.example.edu/course/42");
    const kiwi = await freshKiwi();
    const { client, updates } = fakeClient("live");
    kiwi.setHostDefaultContext(client, "Course X.");
    kiwi.useHostChatPolicy({ available: false, contextNote: "" });
    expect(updates).toEqual([]);
    expect(posted).toEqual([
      [{ type: "kiwi:updateContext", payload: { context: "Course X.", tutoringMode: "guidance" } }, "https://kiwi.example.edu"],
      [{ type: "kiwi:updateContext", payload: { context: "Course X.", tutoringMode: "guidance" } }, "https://kiwi.example.edu"],
      [{ type: "kiwi:setChatAvailability", payload: { available: false, reason: kiwi.CHAT_UNAVAILABLE_REASON } }, "https://kiwi.example.edu"],
    ]);
  });

  it.each([
    ["a malformed referrer", "not a url"],
    ["no referrer", ""],
  ])("targets the configured Kiwi origin with %s", async (_label, referrer) => {
    vi.stubEnv("VITE_KIWI_ORIGIN", "https://kiwi.example.edu/");
    const origins: string[] = [];
    vi.stubGlobal("parent", { postMessage: (_message: unknown, origin: string) => origins.push(origin) });
    stubDocument(() => undefined, referrer);
    const kiwi = await freshKiwi();
    kiwi.setHostDefaultContext(fakeClient("live").client, "Course X.");
    expect(origins).toEqual(["https://kiwi.example.edu"]);
  });

  it("uses the simulator path for a live client that is not framed", async () => {
    const kiwi = await freshKiwi();
    const { client, updates } = fakeClient("live");
    kiwi.setHostDefaultContext(client, "Course X.");
    expect(updates).toEqual(["Course X."]);
  });
});

describe("useHostChatPolicy", () => {
  it("does nothing without a page policy", async () => {
    const kiwi = await freshKiwi();
    const { client, updates } = fakeClient("sim");
    kiwi.setHostDefaultContext(client, "Course X.");
    kiwi.useHostChatPolicy(null);
    expect(updates).toEqual(["Course X."]);
    expect(effects.cleanups).toHaveLength(0);
  });

  it("keeps the page note across default-context refreshes and restores the default on unmount", async () => {
    const kiwi = await freshKiwi();
    const { client, updates } = fakeClient("sim");
    kiwi.setHostDefaultContext(client, "Course X.");
    const policy: HostChatPolicy = { available: true, contextNote: "  Assignment: HW 3.  " };
    kiwi.useHostChatPolicy(policy);
    kiwi.setHostDefaultContext(client, "Course X, page 2.");
    expect(updates).toEqual(["Course X.", "Course X.\nAssignment: HW 3.", "Course X, page 2.\nAssignment: HW 3."]);
    effects.cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(updates.at(-1)).toBe("Course X, page 2.");
    kiwi.setHostDefaultContext(client, "Course X, page 3.");
    expect(updates.at(-1)).toBe("Course X, page 3.");
  });

  it("an older page's cleanup does not clear a newer page's policy", async () => {
    const kiwi = await freshKiwi();
    const { client, updates } = fakeClient("sim");
    kiwi.setHostDefaultContext(client, "Course X.");
    kiwi.useHostChatPolicy({ available: true, contextNote: "First page." });
    const [firstCleanup] = effects.cleanups.splice(0);
    kiwi.useHostChatPolicy({ available: true, contextNote: "Second page." });
    firstCleanup();
    kiwi.setHostDefaultContext(client, "Course X.");
    expect(updates.at(-1)).toBe("Course X.\nSecond page.");
  });
});
