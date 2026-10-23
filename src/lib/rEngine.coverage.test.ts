import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Coverage for the webR runtime wrapper (TELEMETRY, F11). `webr` is replaced by a scripted fake so the wrapper's own
 * logic runs in Node: runtime start/failure, per-context environments and run counters, captured entries and
 * conditions, canvas plot compositing, timeouts that reset the runtime, package installs and data files.
 * scripts/verify-r-capture.mjs still checks the real webR behaviour.
 */

const fake = vi.hoisted(() => {
  type Output = { type: string; data: unknown };
  type Capture = (code: string, options: Record<string, unknown>) => Promise<{ output: Output[] }>;
  const state = {
    instances: [] as FakeWebR[],
    initError: null as Error | null,
    capture: (async () => ({ output: [] })) as Capture,
    flushMessages: [] as unknown[],
    objects: "x\ny" as string | Error,
    packages: "base\nstats" as string | Error,
    destroyError: null as Error | null,
    installError: null as unknown,
    evalVoidError: null as Error | null,
  };
  class FakeWebR {
    options: Record<string, unknown>;
    closed = 0;
    evalVoid: string[] = [];
    evalString: Array<[string, Record<string, unknown> | undefined]> = [];
    destroyed: unknown[] = [];
    installs: Array<[string[], unknown]> = [];
    purges = 0;
    files: Array<[string, Uint8Array]> = [];
    envCount = 0;
    FS = {
      writeFile: async (path: string, bytes: Uint8Array) => {
        this.files.push([path, bytes]);
      },
    };
    REnvironment: new (init: unknown) => { id: number };
    Shelter: new () => { captureR: Capture; purge: () => Promise<void> };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      state.instances.push(this);
      const owner = this;
      this.REnvironment = class {
        id = ++owner.envCount;
      };
      this.Shelter = class {
        captureR(code: string, opts: Record<string, unknown>) {
          return state.capture(code, opts);
        }
        async purge() {
          owner.purges += 1;
          throw new Error("purge failures are ignored");
        }
      };
    }
    async init() {
      if (state.initError) throw state.initError;
    }
    close() {
      this.closed += 1;
    }
    async evalRVoid(code: string) {
      this.evalVoid.push(code);
      if (state.evalVoidError && code.includes("dev.off")) throw state.evalVoidError;
    }
    async evalRString(code: string, opts?: Record<string, unknown>) {
      this.evalString.push([code, opts]);
      const value = code.includes("ls()") ? state.objects : state.packages;
      if (value instanceof Error) throw value;
      return value;
    }
    async flush() {
      const messages = state.flushMessages;
      state.flushMessages = [];
      return messages;
    }
    async destroy(env: unknown) {
      this.destroyed.push(env);
      if (state.destroyError) throw state.destroyError;
    }
    async installPackages(names: string[], opts: unknown) {
      this.installs.push([names, opts]);
      if (state.installError !== null) throw state.installError;
    }
  }
  return { state, FakeWebR };
});

vi.mock("webr", () => ({ WebR: fake.FakeWebR }));

type REngine = typeof import("./rEngine");
let r: REngine;
const last = () => fake.state.instances[fake.state.instances.length - 1];
/** Lets queued promise callbacks run without moving a fake clock (the fake worker never uses timers). */
async function untilMicrotasks(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !check(); turn++) await Promise.resolve();
  expect(check()).toBe(true);
}

beforeEach(async () => {
  Object.assign(fake.state, {
    instances: [], initError: null, capture: async () => ({ output: [] }), flushMessages: [], objects: "x\ny",
    packages: "base\nstats", destroyError: null, installError: null, evalVoidError: null,
  });
  vi.resetModules();
  r = await import("./rEngine");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runtime start", () => {
  it("starts one webR worker from the page origin and reuses it", async () => {
    const [a, b] = await Promise.all([r.getRuntime(), r.getRuntime()]);
    expect(a).toBe(b);
    expect(await r.getRuntime()).toBe(a);
    expect(fake.state.instances).toHaveLength(1);
    expect(last().options).toEqual({ baseUrl: "http://localhost:3000/webr/", interactive: false });
  });

  it("closes a worker that fails to start and retries on the next call", async () => {
    fake.state.initError = new Error("worker crashed");
    const result = await r.runR("1 + 1", { graphics: false });
    expect(result).toMatchObject({ ok: false, error: "Could not start the R runtime: Error: worker crashed", envKey: "global", runSeq: 0 });
    expect(result.entries).toEqual([{ type: "error", text: "Could not start the R runtime: Error: worker crashed" }]);
    expect(fake.state.instances[0].closed).toBe(1);
    fake.state.initError = null;
    await r.getRuntime();
    expect(fake.state.instances).toHaveLength(2);
  });
});

describe("runR", () => {
  it("rejects empty code without starting R", async () => {
    const result = await r.runR("   \n");
    expect(result).toMatchObject({ ok: false, error: "Enter R code to run.", durationMs: 0, objectNames: [], packagesLoaded: [] });
    expect(fake.state.instances).toHaveLength(0);
  });

  it("captures autoprint output, conditions and the run snapshot", async () => {
    const captured: Array<[string, Record<string, unknown>]> = [];
    fake.state.capture = async (code, opts) => {
      captured.push([code, opts]);
      return {
        output: [
          { type: "stdout", data: "[1] 82.66667" },
          { type: "warning", data: { get: async () => ({ toArray: async () => ["NAs introduced by coercion"] }) } },
          { type: "message", data: { get: async () => ({ toArray: async () => [42] }), toString: () => "R message object" } },
        ],
      };
    };
    const result = await r.runR("mean(scores)", { graphics: false });
    expect(result).toMatchObject({
      ok: true, error: undefined, envKey: "global", runSeq: 1, objectNames: ["x", "y"], packagesLoaded: ["base", "stats"],
      plots: [], plotsUnavailable: true,
    });
    expect(result.entries).toEqual([
      { type: "stdout", text: "[1] 82.66667" },
      { type: "warning", text: "NAs introduced by coercion" },
      { type: "message", text: "R message object" },
    ]);
    expect(result.output).toBe("[1] 82.66667\nNAs introduced by coercion\nR message object");
    expect(captured[0][0]).toBe("mean(scores)");
    expect(captured[0][1]).toMatchObject({ withAutoprint: true, captureStreams: true, captureConditions: true, captureGraphics: false, throwJsException: false });
    expect(last().purges).toBe(1);
    expect(last().evalString.map(([code]) => code)).toEqual(['paste(sort(ls()), collapse = "\\n")', 'paste((.packages()), collapse = "\\n")']);
  });

  it("keeps output printed before an R error and reports the error", async () => {
    fake.state.capture = async () => ({
      output: [
        { type: "stdout", data: "[1] 1" },
        { type: "error", data: { get: async () => ({ toArray: async () => ["object 'scores' not found"] }) } },
      ],
    });
    const result = await r.runR("print(1); scores", { graphics: false });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("object 'scores' not found");
    expect(result.output).toBe("[1] 1\nError: object 'scores' not found");
  });

  it("falls back to String() for values that are not condition objects", async () => {
    const unprintable = {
      get: async () => {
        throw new Error("not a condition");
      },
      toString: () => {
        throw new Error("no primitive");
      },
    };
    fake.state.capture = async () => ({
      output: [
        { type: "stdout", data: 7 },
        { type: "warning", data: { get: async () => null, toString: () => "plain" } },
        { type: "warning", data: unprintable },
        { type: "message", data: null },
      ],
    });
    const result = await r.runR("x", { graphics: false });
    expect(result.entries.map((e) => e.text)).toEqual(["7", "plain", "R condition", "null"]);
  });

  it("gives each envKey its own environment and run counter", async () => {
    const envs: unknown[] = [];
    fake.state.capture = async (_code, opts) => {
      envs.push(opts.env);
      return { output: [] };
    };
    const a1 = await r.runR("a <- 1", { envKey: "q1", graphics: false });
    const a2 = await r.runR("a", { envKey: "q1", graphics: false });
    const b1 = await r.runR("b", { envKey: "q2", graphics: false });
    expect([a1.runSeq, a2.runSeq, b1.runSeq]).toEqual([1, 2, 1]);
    expect(envs[0]).toBe(envs[1]);
    expect(envs[2]).not.toBe(envs[0]);
  });

  it("records empty snapshots when the object and package queries fail", async () => {
    fake.state.objects = new Error("env gone");
    fake.state.packages = new Error("worker busy");
    const result = await r.runR("1", { graphics: false });
    expect(result).toMatchObject({ ok: true, objectNames: [], packagesLoaded: [] });
  });

  it("serializes runs on the single worker", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    fake.state.capture = async (code) => {
      order.push(`start ${code}`);
      if (code === "slow") await new Promise<void>((resolve) => (release = resolve));
      order.push(`end ${code}`);
      return { output: [] };
    };
    const slow = r.runR("slow", { graphics: false });
    const fast = r.runR("fast", { graphics: false });
    await vi.waitFor(() => expect(order).toEqual(["start slow"]));
    release();
    await Promise.all([slow, fast]);
    expect(order).toEqual(["start slow", "end slow", "start fast", "end fast"]);
  });

  it("turns thrown errors into failures and keeps the queue usable", async () => {
    fake.state.capture = async () => {
      throw new Error("");
    };
    const failed = await r.runR("boom", { graphics: false });
    expect(failed).toMatchObject({ ok: false, error: "R execution failed. Check the code and retry.", timedOut: false });
    fake.state.capture = async () => {
      throw "worker message";
    };
    expect((await r.runR("boom", { graphics: false })).error).toBe("worker message");
    fake.state.capture = async () => ({ output: [{ type: "stdout", data: "ok" }] });
    expect((await r.runR("fine", { graphics: false })).ok).toBe(true);
  });

  it("resets the runtime when a run exceeds its time limit", async () => {
    vi.useFakeTimers();
    let started = false;
    fake.state.capture = () => {
      started = true;
      return new Promise(() => undefined);
    };
    const pending = r.runR("repeat {}", 1000);
    await untilMicrotasks(() => started); // the time limit is armed before captureR starts
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(result.error).toBe("Execution exceeded 1 seconds. The R runtime was reset. Check loops and input size.");
    expect(fake.state.instances[0].closed).toBe(1);
    vi.useRealTimers();
    fake.state.capture = async () => ({ output: [] });
    const next = await r.runR("1", { envKey: "global", graphics: false });
    expect(fake.state.instances).toHaveLength(2);
    expect(next.runSeq).toBe(1); // counters were cleared with the old worker
  });

  it("uses the default limit for non-positive timeouts", async () => {
    vi.useFakeTimers();
    let started = false;
    fake.state.capture = () => {
      started = true;
      return new Promise(() => undefined);
    };
    const pending = r.runR("repeat {}", { timeoutMs: -5, graphics: false });
    await untilMicrotasks(() => started);
    await vi.advanceTimersByTimeAsync(r.DEFAULT_TIMEOUT_MS - 1);
    expect(fake.state.instances[0].closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).error).toContain(`exceeded ${r.DEFAULT_TIMEOUT_MS / 1000} seconds`);
  });
});

describe("plots", () => {
  interface Bitmap { width: number; height: number; closed: boolean; close: () => void; label: string }
  const bitmap = (label: string): Bitmap => {
    const b: Bitmap = { width: 504, height: 360, closed: false, label, close: () => (b.closed = true) };
    return b;
  };
  function stubCanvas(withContext = true) {
    const drawn: string[] = [];
    class FakeOffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        if (!withContext) return null;
        return {
          fillStyle: "",
          fillRect: (_x: number, _y: number, w: number, h: number) => drawn.push(`fill ${w}x${h}`),
          drawImage: (image: Bitmap) => drawn.push(`draw ${image.label}`),
        };
      }
      transferToImageBitmap() {
        return bitmap(`plot ${drawn.length}`);
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    return drawn;
  }

  it("opens a canvas device and composites each page's frames into one bitmap", async () => {
    const drawn = stubCanvas();
    const frames = [bitmap("f1"), bitmap("f2"), bitmap("f3"), bitmap("f4")];
    fake.state.capture = async () => {
      fake.state.flushMessages = [
        { type: "canvas", data: { event: "canvasImage", image: frames[0] } }, // before any canvasNewPage
        { type: "canvas", data: { event: "canvasNewPage" } },
        { type: "canvas", data: { event: "canvasImage", image: frames[1] } },
        { type: "canvas", data: { event: "canvasImage", image: frames[2] } },
        { type: "stdout", data: "ignored" },
        { type: "canvas" },
        { type: "canvas", data: { event: "canvasImage" } },
        { type: "canvas", data: { event: "canvasNewPage" } }, // empty page: no plot
        { type: "canvas", data: { event: "canvasNewPage" } },
        { type: "canvas", data: { event: "canvasImage", image: frames[3] } },
      ];
      return { output: [] };
    };
    const result = await r.runR("plot(1:10)");
    expect(result.plotsUnavailable).toBeUndefined();
    expect(result.plots).toHaveLength(3);
    expect(drawn).toEqual(["fill 504x360", "draw f1", "fill 504x360", "draw f2", "draw f3", "fill 504x360", "draw f4"]);
    expect(frames.every((f) => f.closed)).toBe(true);
    // S-m10: the runtime first removes the stray default.profraw file once, at start-up
    expect(last().evalVoid).toEqual([r.STRAY_FILE_CLEANUP, "webr::canvas(width = 504, height = 360)", "try(grDevices::dev.off(), silent = TRUE)"]);
    expect(r.PLOT_SIZE).toEqual({ width: 504, height: 360 });
  });

  it("closes frames without a plot when no 2D context is available", async () => {
    stubCanvas(false);
    const frame = bitmap("f1");
    fake.state.capture = async () => {
      fake.state.flushMessages = [{ type: "canvas", data: { event: "canvasImage", image: frame } }];
      return { output: [] };
    };
    const result = await r.runR("plot(1)");
    expect(result.plots).toEqual([]);
    expect(frame.closed).toBe(true);
  });

  it("closes the device and drops leftover frames when the run fails", async () => {
    stubCanvas();
    fake.state.evalVoidError = new Error("no device");
    const leftover = bitmap("left");
    fake.state.capture = async () => {
      fake.state.flushMessages = [{ type: "canvas", data: { event: "canvasImage", image: leftover } }];
      throw new Error("worker lost");
    };
    const result = await r.runR("plot(1)");
    expect(result).toMatchObject({ ok: false, error: "worker lost" });
    expect(leftover.closed).toBe(true);
    expect(last().purges).toBe(1);
  });

  it("skips the device when graphics are turned off", async () => {
    stubCanvas();
    const result = await r.runR("plot(1)", { graphics: false });
    expect(result.plotsUnavailable).toBe(true);
    expect(last().evalVoid).toEqual([r.STRAY_FILE_CLEANUP]);
  });
});

describe("environments, packages and files", () => {
  it("drops one context's environment and counter", async () => {
    await r.runR("a <- 1", { envKey: "q1", graphics: false });
    await r.runR("a", { envKey: "q1", graphics: false });
    await r.resetEnvironment("q1");
    expect(last().destroyed).toHaveLength(1);
    expect((await r.runR("a", { envKey: "q1", graphics: false })).runSeq).toBe(1);
  });

  it("ignores destroy failures and unknown contexts", async () => {
    await r.runR("a <- 1", { envKey: "q1", graphics: false });
    fake.state.destroyError = new Error("worker gone");
    await expect(r.resetEnvironment("q1")).resolves.toBeUndefined();
    await expect(r.resetEnvironment("never-used")).resolves.toBeUndefined();
    expect(last().destroyed).toHaveLength(1);
  });

  it("drops the map entry even before the runtime started", async () => {
    await expect(r.resetEnvironment("q1")).resolves.toBeUndefined();
    expect(fake.state.instances).toHaveLength(0);
  });

  it("installs a package once", async () => {
    expect(r.isInstalled("dplyr")).toBe(false);
    expect(await r.installPackage("dplyr")).toMatchObject({ ok: true });
    expect(await r.installPackage("dplyr")).toMatchObject({ ok: true });
    expect(r.isInstalled("dplyr")).toBe(true);
    expect(last().installs).toEqual([[["dplyr"], { quiet: true }]]);
  });

  it("reports install failures", async () => {
    fake.state.installError = new Error("package not available for webR");
    expect(await r.installPackage("rsvg")).toMatchObject({ ok: false, error: "package not available for webR" });
    fake.state.installError = "offline";
    expect(await r.installPackage("rsvg")).toMatchObject({ ok: false, error: "offline" });
    expect(r.isInstalled("rsvg")).toBe(false);
  });

  it("writes data files under the R home with a safe name", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await r.writeDataFile("my data (1).csv", bytes)).toBe("/home/web_user/my_data__1_.csv");
    expect(last().files).toEqual([["/home/web_user/my_data__1_.csv", bytes]]);
  });
});

describe("debugHint (v0.5.1)", () => {
  it.each([
    ["Error: object 'x' not found", "Check that the variable is defined"],
    ["Error: unexpected ')' in \"mean(x))\"", "Check parentheses"],
    ["Error in x[[5]] : subscript out of bounds", "R indices start at 1"],
    ["non-numeric argument to binary operator", "inspect their types with str()"],
    ["something else", "Start with the first error line"],
  ])("%s", (error, hint) => {
    expect(r.debugHint(error)).toContain(hint);
  });
});
