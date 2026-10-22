import { WebR } from "webr";

export interface RunResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
  plots: ImageBitmap[];
}

let runtime: WebR | null = null;
let starting: Promise<WebR> | null = null;

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

async function conditionText(value: unknown): Promise<string> {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "toJs" in value &&
    typeof value.toJs === "function"
  ) {
    try {
      const result = (await value.toJs()) as unknown;
      if (typeof result === "string") return result;
      if (result && typeof result === "object" && "message" in result)
        return String(result.message);
      return JSON.stringify(result);
    } catch {
      /* use generic string */
    }
  }
  return String(value);
}

let executionQueue: Promise<unknown> = Promise.resolve();

export function runR(code: string, timeoutMs = 12_000): Promise<RunResult> {
  const task = executionQueue.then(() => executeR(code, timeoutMs));
  executionQueue = task.catch(() => undefined);
  return task;
}

async function executeR(code: string, timeoutMs = 12_000): Promise<RunResult> {
  const started = performance.now();
  if (!code.trim())
    return {
      ok: false,
      output: "",
      error: "Enter R code to run.",
      durationMs: 0,
      plots: [],
    };
  let webr: WebR;
  try {
    webr = await getRuntime();
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: `Could not start the R runtime: ${String(error)}`,
      durationMs: Math.round(performance.now() - started),
      plots: [],
    };
  }
  let timer: number | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      webr.close();
      if (runtime === webr) runtime = null;
      reject(
        new Error(
          `Execution exceeded ${timeoutMs / 1000} seconds. The R runtime was reset. Check loops and input size.`,
        ),
      );
    }, timeoutMs);
  });
  try {
    const execution = (async () => {
      const shelter = await new webr.Shelter();
      try {
        const result = await shelter.captureR(code, { captureGraphics: false });
        const lines: string[] = [];
        let failure = "";
        for (const entry of result.output) {
          const message = await conditionText(entry.data);
          if (entry.type === "error") failure = message;
          lines.push(message);
        }
        return {
          ok: !failure,
          output: lines.join("\n").trim(),
          error: failure || undefined,
          plots: result.images,
          durationMs: Math.round(performance.now() - started),
        };
      } finally {
        await shelter.purge().catch(() => {});
      }
    })();
    return await Promise.race([execution, timedOut]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output: "",
      error: message || "R execution failed. Check the code and retry.",
      durationMs: Math.round(performance.now() - started),
      plots: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

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
