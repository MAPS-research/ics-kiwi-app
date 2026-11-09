import { WebR } from "webr";

/*
 * Browser R runtime (webR; TELEMETRY, [F11, AU-D2-22, AU-D2-M8, AU-D3-M03]). One webR worker per page, one R
 * environment per `envKey` (a question, item or the workspace) so variables never leak between contexts, autoprint
 * like an R console (`mean(scores)` prints `[1] 82.66667`), captured plots (504×360) when the browser supports an
 * OffscreenCanvas, structured output entries, and a per-run snapshot (`runSeq`, `objectNames`, `packagesLoaded`).
 * No runtime imports besides webr: scripts/verify-r-capture.mjs transpiles this file alone and runs it in Node.
 */

export interface RunEntry {
  type: string; // stdout | stderr | message | warning | error
  text: string;
}

export interface RunResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
  plots: ImageBitmap[];
  entries: RunEntry[];
  envKey: string;
  runSeq: number;
  objectNames: string[];
  packagesLoaded: string[];
  plotsUnavailable?: boolean;
  timedOut?: boolean;
}

export interface RunOptions {
  envKey?: string;
  timeoutMs?: number;
  /** Capture plots; defaults to true when OffscreenCanvas exists (browsers), false otherwise (Node). */
  graphics?: boolean;
}

export const PLOT_SIZE = { width: 504, height: 360 } as const;
export const DEFAULT_TIMEOUT_MS = 12_000;

let runtime: WebR | null = null;
let starting: Promise<WebR> | null = null;
type Env = Awaited<ReturnType<typeof createEnv>>;
const environments = new Map<string, Env>();
const runCounters = new Map<string, number>();
const installed = new Set<string>();

async function createEnv(webr: WebR) {
  return await new webr.REnvironment({});
}

export const STRAY_FILE_CLEANUP = 'if (file.exists("default.profraw")) invisible(file.remove("default.profraw"))';

export async function getRuntime(): Promise<WebR> {
  if (runtime) return runtime;
  if (!starting) {
    starting = (async () => {
      const webr = new WebR({
        baseUrl: `${location.origin}/webr/`,
        interactive: false,
      });
      try {
        await webr.init();
        // S-m10: the webR build leaves an LLVM profile file in the home folder; students saw it in list.files()
        await webr.evalRVoid(STRAY_FILE_CLEANUP).catch(() => undefined /* WHY: cosmetic; R works without it */);
        runtime = webr;
        return webr;
      } catch (error) {
        webr.close();
        throw error;
      } finally {
        starting = null;
      }
    })();
  }
  return starting;
}

function forgetRuntime(webr: WebR): void {
  webr.close();
  if (runtime === webr) runtime = null;
  environments.clear();
  runCounters.clear();
  installed.clear();
}

type RCondition = { get?: (name: string) => Promise<{ toArray?: () => Promise<unknown[]> }> };
/** Text of a captured stream entry or condition (warning/message/error objects carry a `message` element). */
async function conditionText(value: unknown): Promise<string> {
  if (typeof value === "string") return value;
  const condition = value as RCondition | null;
  if (condition && typeof condition.get === "function") {
    try {
      const message = await condition.get("message");
      const parts = message && typeof message.toArray === "function" ? await message.toArray() : [];
      if (parts.length && typeof parts[0] === "string") return parts[0];
    } catch {
      /* not a condition object; fall through */
    }
  }
  try {
    return String(value);
  } catch {
    return "R condition"; // WHY: webR proxies cannot always be converted to primitives
  }
}

async function environmentFor(webr: WebR, envKey: string): Promise<Env> {
  let env = environments.get(envKey);
  if (!env) {
    env = await createEnv(webr);
    environments.set(envKey, env);
  }
  return env;
}

/** Drop the R environment of one context (its objects are gone; packages stay installed). */
export async function resetEnvironment(envKey: string): Promise<void> {
  const env = environments.get(envKey);
  environments.delete(envKey);
  runCounters.delete(envKey);
  if (env && runtime) {
    try {
      await runtime.destroy(env);
    } catch {
      /* the worker may already be gone; the map entry is removed either way */
    }
  }
}

type CanvasMessage = { type: string; data?: { event?: string; image?: ImageBitmap } };
/** Close the run's canvas device and composite each page's drawing frames (`canvasImage` deltas) into one bitmap. */
async function collectPlots(webr: WebR): Promise<ImageBitmap[]> {
  await webr.evalRVoid("try(grDevices::dev.off(), silent = TRUE)").catch(() => undefined);
  const messages = (await webr.flush()) as CanvasMessage[];
  const pages: ImageBitmap[][] = [];
  for (const message of messages) {
    if (message.type !== "canvas" || !message.data) continue;
    if (message.data.event === "canvasNewPage") pages.push([]);
    else if (message.data.event === "canvasImage" && message.data.image) {
      if (!pages.length) pages.push([]);
      pages[pages.length - 1].push(message.data.image);
    }
  }
  const plots: ImageBitmap[] = [];
  for (const frames of pages) {
    if (!frames.length) continue;
    const canvas = new OffscreenCanvas(frames[0].width, frames[0].height);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const frame of frames) ctx.drawImage(frame, 0, 0);
      plots.push(canvas.transferToImageBitmap());
    }
    for (const frame of frames) frame.close();
  }
  return plots;
}

let executionQueue: Promise<unknown> = Promise.resolve();

/** Run R code in the context's environment; runs are serialized (one worker). */
export function runR(code: string, options: number | RunOptions = {}): Promise<RunResult> {
  const opts: RunOptions = typeof options === "number" ? { timeoutMs: options } : options;
  const task = executionQueue.then(() => executeR(code, opts));
  executionQueue = task.catch(() => undefined);
  return task;
}

function failure(envKey: string, error: string, started: number, extra: Partial<RunResult> = {}): RunResult {
  return {
    ok: false,
    output: "",
    error,
    durationMs: Math.round(performance.now() - started),
    plots: [],
    entries: [{ type: "error", text: error }],
    envKey,
    runSeq: runCounters.get(envKey) ?? 0,
    objectNames: [],
    packagesLoaded: [],
    ...extra,
  };
}

async function executeR(code: string, opts: RunOptions): Promise<RunResult> {
  const started = performance.now();
  const envKey = opts.envKey || "global";
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const graphics = opts.graphics ?? typeof OffscreenCanvas !== "undefined";
  if (!code.trim()) return failure(envKey, "Enter R code to run.", started, { durationMs: 0 });
  let webr: WebR;
  try {
    webr = await getRuntime();
  } catch (error) {
    return failure(envKey, `Could not start the R runtime: ${String(error)}`, started);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      forgetRuntime(webr);
      reject(new Error(`Execution exceeded ${timeoutMs / 1000} seconds. The R runtime was reset. Check loops and input size.`));
    }, timeoutMs);
  });
  try {
    const execution = (async (): Promise<RunResult> => {
      const env = await environmentFor(webr, envKey);
      const runSeq = (runCounters.get(envKey) ?? 0) + 1;
      runCounters.set(envKey, runSeq);
      const shelter = await new webr.Shelter();
      let device = false;
      try {
        if (graphics) {
          // WHY: captureR's own plot capture fails without cross-origin isolation (PostMessage channel), while the
          // regular canvas device streams its frames through the output queue, which works in every channel.
          await webr.flush();
          await webr.evalRVoid(`webr::canvas(width = ${PLOT_SIZE.width}, height = ${PLOT_SIZE.height})`);
          device = true;
        }
        const result = await shelter.captureR(code, {
          env,
          withAutoprint: true,
          captureStreams: true,
          captureConditions: true,
          captureGraphics: false,
          throwJsException: false, // R errors become `error` entries, so output printed before the error is kept
        });
        const entries: RunEntry[] = [];
        let failureText = "";
        for (const entry of result.output) {
          const message = await conditionText(entry.data);
          if (entry.type === "error") failureText = message;
          entries.push({ type: entry.type, text: message });
        }
        const plots = device ? await collectPlots(webr) : [];
        device = false;
        const objects = await webr.evalRString('paste(sort(ls()), collapse = "\\n")', { env, captureGraphics: false }).catch(() => "");
        const packages = await webr.evalRString('paste((.packages()), collapse = "\\n")', { captureGraphics: false }).catch(() => "");
        return {
          ok: !failureText,
          output: entries.map((e) => (e.type === "error" ? `Error: ${e.text}` : e.text)).join("\n").trim(),
          error: failureText || undefined,
          plots,
          entries,
          envKey,
          runSeq,
          objectNames: objects ? objects.split("\n").filter(Boolean) : [],
          packagesLoaded: packages ? packages.split("\n").filter(Boolean) : [],
          durationMs: Math.round(performance.now() - started),
          ...(graphics ? {} : { plotsUnavailable: true }),
        };
      } finally {
        if (device) await collectPlots(webr).then((left) => left.forEach((b) => b.close())).catch(() => undefined);
        await shelter.purge().catch(() => {});
      }
    })();
    return await Promise.race([execution, timedOut]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(envKey, message || "R execution failed. Check the code and retry.", started, {
      timedOut: /exceeded/.test(message),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Install one package in webR (callers check the course allowlist first). */
export async function installPackage(name: string): Promise<{ ok: boolean; error?: string; durationMs: number }> {
  const started = performance.now();
  try {
    const webr = await getRuntime();
    if (!installed.has(name)) {
      await webr.installPackages([name], { quiet: true });
      installed.add(name);
    }
    return { ok: true, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Math.round(performance.now() - started) };
  }
}

export function isInstalled(name: string): boolean {
  return installed.has(name);
}

/** Write a data file into the R working directory (`/home/web_user/<name>`); returns the path. */
export async function writeDataFile(name: string, bytes: Uint8Array): Promise<string> {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
  const webr = await getRuntime();
  const path = `/home/web_user/${safe}`;
  await webr.FS.writeFile(path, bytes);
  return path;
}

/** v0.5.1 hint (kept for callers that do not pass chapter rules; RWorkbench uses rOutput.errorHint). */
export function debugHint(error: string): string {
  const text = error.toLowerCase();
  if (text.includes("object") && text.includes("not found"))
    return "Check that the variable is defined, and verify its spelling and capitalization.";
  if (text.includes("unexpected"))
    return "Check parentheses, commas, and matching quotation marks near the error.";
  if (text.includes("subscript out of bounds"))
    return "Check whether the index exceeds the vector or data frame length. R indices start at 1.";
  if (text.includes("non-numeric"))
    return "Check whether the values are numeric; inspect their types with str().";
  return "Start with the first error line, then inspect intermediate values with print() or str(). Update the code and run again.";
}
