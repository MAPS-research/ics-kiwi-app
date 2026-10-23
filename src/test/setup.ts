import { beforeEach } from "vitest";

/*
 * vitest setup (§19.1, frozen after FOUNDATION). Tests run with `environment: 'node'` and no DOM library, so this file
 * installs: in-memory localStorage/sessionStorage, a minimal location/history/window (an EventTarget), a document stub,
 * a PopStateEvent class, and a fetch that rejects unless a test installs its own (`vi.stubGlobal("fetch", …)`).
 * Components are tested with react-dom/server `renderToStaticMarkup`.
 */

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

const define = (name: string, value: unknown) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });

const ORIGIN = "http://localhost:3000";
const loc = {
  href: `${ORIGIN}/`,
  origin: ORIGIN,
  protocol: "http:",
  host: "localhost:3000",
  hostname: "localhost",
  port: "3000",
  pathname: "/",
  search: "",
  hash: "",
  assign(url: string) {
    setUrl(url);
  },
  replace(url: string) {
    setUrl(url);
  },
  reload() {
    // no-op in tests
  },
  toString() {
    return loc.href;
  },
};
function setUrl(url: string): void {
  const next = new URL(url, loc.href);
  loc.href = next.href;
  loc.pathname = next.pathname;
  loc.search = next.search;
  loc.hash = next.hash;
}

const historyStub = {
  state: null as unknown,
  length: 1,
  scrollRestoration: "auto" as ScrollRestoration,
  pushState(state: unknown, _title: string, url?: string | URL | null) {
    historyStub.state = state;
    historyStub.length += 1;
    if (url !== undefined && url !== null) setUrl(String(url));
  },
  replaceState(state: unknown, _title: string, url?: string | URL | null) {
    historyStub.state = state;
    if (url !== undefined && url !== null) setUrl(String(url));
  },
  back() {},
  forward() {},
  go() {},
};

class TestPopStateEvent extends Event {
  readonly state: unknown;
  constructor(type: string, init?: { state?: unknown }) {
    super(type);
    this.state = init?.state ?? null;
  }
}

const windowEvents = new EventTarget();
const documentEvents = new EventTarget();
const documentStub = {
  visibilityState: "visible",
  hidden: false,
  referrer: "",
  title: "CSS Kiwi Lab",
  addEventListener: documentEvents.addEventListener.bind(documentEvents),
  removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  dispatchEvent: documentEvents.dispatchEvent.bind(documentEvents),
  createElement(): never {
    throw new Error("document.createElement is not available in node tests; test pure views with renderToStaticMarkup.");
  },
};

define("localStorage", new MemoryStorage());
define("sessionStorage", new MemoryStorage());
define("location", loc);
define("history", historyStub);
define("PopStateEvent", TestPopStateEvent);
define("document", documentStub);
define("window", globalThis);
define("parent", globalThis);
define("addEventListener", windowEvents.addEventListener.bind(windowEvents));
define("removeEventListener", windowEvents.removeEventListener.bind(windowEvents));
define("dispatchEvent", windowEvents.dispatchEvent.bind(windowEvents));
define("scrollTo", () => undefined);
define("matchMedia", (media: string) => ({
  matches: false,
  media,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
}));
define("fetch", async (input: unknown) => {
  throw new Error(`fetch is not stubbed in this test (${String(input)}). Use vi.stubGlobal("fetch", …).`);
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  historyStub.state = null;
  setUrl(`${ORIGIN}/`);
});
