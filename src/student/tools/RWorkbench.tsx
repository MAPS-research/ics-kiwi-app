import { useEffect, useRef, useState } from "react";
import { Eraser, LoaderCircle, Play, RotateCcw, Terminal } from "lucide-react";
import { request } from "../../lib/api";
import { getRuntime, installPackage, isInstalled, resetEnvironment, runR, writeDataFile, type RunResult } from "../../lib/rEngine";
import { errorExcerpt, errorHint, structureOutput } from "../../lib/rOutput";
import { activeTelemetryIdentity } from "../../lib/telemetry";
import { isAllowedWebrPackage, WEBR_PACKAGE_ALLOWLIST } from "../../lib/webrPackages";
import type { FileMeta, RunResultView, RWorkbenchProps, Tracker, UnitRuntime } from "../../types";

/*
 * R workbench (TELEMETRY; props frozen, §7.9). One R environment per `context.envKey`, autoprint, plots, structured
 * streams, allowlisted package installs, chapter package preinstall, dataset mounting, chapter timeouts and error-hint
 * overrides [F11, AU-D2-22, AU-D2-M7, AU-D2-M8, AU-D3-15, AU-D3-M03, AU-D1-M11]. Full run snapshots are tracked on
 * every run (KEEP).
 */

export const DEFAULT_R_CODE = "scores <- c(72, 85, 91)\nprint(mean(scores))";
export const CODE_EDIT_DEBOUNCE_MS = 1800;

export interface WorkbenchRun extends RunResultView {
  code: string;
  hint: { ruleId: string; hint: string } | null;
  bitmaps: ImageBitmap[];
  plotsUnavailable: boolean;
}

/** RunResult (webR) → RunResultView with structured streams; the bitmaps are returned separately for display. */
export function toRunResultView(value: RunResult): RunResultView {
  const structured = structureOutput(value.entries ?? []);
  return {
    ok: value.ok,
    output: structured.output || value.output,
    stdout: structured.stdout,
    ...(value.error ? { error: value.error } : {}),
    warnings: structured.warnings,
    plots: value.plots.length,
    durationMs: value.durationMs,
  };
}

/** `code_run` payload (§11.3): the code, structured output and the environment snapshot of this run. */
export function codeRunPayload(
  context: RWorkbenchProps["context"],
  code: string,
  value: RunResult,
  view: RunResultView,
  plotHashes: string[] = [],
): Record<string, unknown> {
  return {
    unitId: context.unitId,
    ...(context.assignmentId ? { assignmentId: context.assignmentId } : {}),
    ...(context.itemId ? { itemId: context.itemId } : {}),
    ...(context.surface === "workspace" ? { attribution: { chapter: context.unitId ? "selected" : "unattributed" } } : {}),
    code,
    ok: view.ok,
    stdout: view.stdout,
    output: view.output,
    error: view.error || "",
    warnings: view.warnings,
    warningCount: view.warnings.length,
    plots: view.plots,
    ...(plotHashes.length ? { plotHashes } : {}),
    ...(value.plotsUnavailable ? { plotsUnavailable: true } : {}),
    durationMs: view.durationMs,
    envKey: value.envKey || context.envKey,
    runSeq: value.runSeq,
    objectNames: value.objectNames,
    packagesLoaded: value.packagesLoaded,
  };
}

/** Packages a chapter preinstalls: only allowlisted names, each once. */
export function chapterPackages(runtime?: UnitRuntime): string[] {
  return [...new Set((runtime?.packages ?? []).filter(isAllowedWebrPackage))];
}

/** Files to mount: assignment files flagged `mountInR`, plus the chapter's datasets. */
export function filesToMount(files: FileMeta[] | undefined, runtime?: UnitRuntime): { id: string; source: "assignment" | "chapter" }[] {
  const out: { id: string; source: "assignment" | "chapter" }[] = [];
  for (const file of files ?? []) if (file.mountInR) out.push({ id: file.id, source: file.scope === "chapter" ? "chapter" : "assignment" });
  for (const id of runtime?.datasetFileIds ?? []) if (!out.some((f) => f.id === id)) out.push({ id, source: "chapter" });
  return out;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return ""; // WHY: hashing is provenance only; a missing hash must not block loading the data
  }
}

async function plotHash(bitmap: ImageBitmap): Promise<string> {
  if (typeof OffscreenCanvas === "undefined") return "";
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return sha256Bytes(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return "";
  }
}

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const mounted = new Set<string>(); // file ids already written into this page's webR file system

function PlotCanvas({ bitmap, index }: { bitmap: ImageBitmap; index: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }, [bitmap]);
  return <canvas ref={ref} className="r-plot" width={bitmap.width} height={bitmap.height} role="img" aria-label={`Plot ${index + 1}`} />;
}

export function RWorkbench({ code, onCode, onResult, track, questionId, storageKey, context, runtime, files, allowRun = true, resetCode = DEFAULT_R_CODE }: RWorkbenchProps) {
  const [result, setResult] = useState<WorkbenchRun | null>(null);
  const [running, setRunning] = useState(false);
  const [toolsBusy, setToolsBusy] = useState(false);
  const [packageName, setPackageName] = useState("");
  const [message, setMessage] = useState("");
  const current = useRef({ code, questionId, storageKey });
  current.current = { code, questionId, storageKey };
  const isMounted = useRef(true);
  const inFlight = useRef(false);
  const prepared = useRef(false);
  const lastTrackedCode = useRef(code);
  const trackRef = useRef<Tracker>(track);
  trackRef.current = track;
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      for (const bitmap of result?.bitmaps ?? []) bitmap.close();
    },
    [result],
  );

  /** Chapter packages and datasets, once per workbench, right before the first run (webR loads on demand). */
  const prepare = async () => {
    if (prepared.current) return;
    prepared.current = true;
    for (const name of chapterPackages(runtime)) {
      if (isInstalled(name)) continue;
      setMessage(`Installing ${name} for this chapter…`);
      const outcome = await installPackage(name);
      void trackRef.current("r_package_install", { package: name, ok: outcome.ok, error: outcome.error || "", durationMs: outcome.durationMs, preinstall: true });
    }
    const identity = activeTelemetryIdentity();
    for (const file of filesToMount(files, runtime)) {
      if (mounted.has(file.id) || !identity) continue;
      try {
        const data = await request<{ name: string; type: string; data: string }>(
          `/files/${encodeURIComponent(file.id)}?classId=${encodeURIComponent(identity.classId)}`,
        );
        const bytes = base64Bytes(data.data);
        await writeDataFile(data.name, bytes);
        mounted.add(file.id);
        void trackRef.current("data_file_loaded", { name: data.name, size: bytes.length, sha256: await sha256Bytes(bytes), source: file.source });
      } catch (e) {
        setMessage(`A course data file could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (isMounted.current) setMessage("");
  };

  const run = async () => {
    if (inFlight.current || !code.trim() || !allowRun) return;
    inFlight.current = true;
    setRunning(true);
    setMessage("");
    setResult(null);
    const snapshot = { code, questionId, storageKey };
    try {
      await prepare();
      const value = await runR(code, { envKey: context.envKey, timeoutMs: (runtime?.timeoutSeconds ?? 12) * 1000 });
      const view = toRunResultView(value);
      const hint = view.ok ? null : errorHint(view.error || view.output, runtime?.errorHints ?? []);
      const stillCurrent = isMounted.current && JSON.stringify(current.current) === JSON.stringify(snapshot);
      const hashes = (await Promise.all(value.plots.map(plotHash))).filter(Boolean);
      if (stillCurrent) {
        setResult({ ...view, code, hint, bitmaps: value.plots, plotsUnavailable: Boolean(value.plotsUnavailable) });
        onResult?.({ ...view, code });
      } else {
        for (const bitmap of value.plots) bitmap.close();
      }
      await track("code_run", codeRunPayload(context, snapshot.code, value, view, hashes), questionId);
      if (hint && stillCurrent) {
        await track("hint_shown", { hintKind: "r_error_rule", ruleId: hint.ruleId, errorExcerpt: errorExcerpt(view.error || ""), unitId: context.unitId, ...(context.assignmentId ? { assignmentId: context.assignmentId } : {}) }, questionId);
      }
    } finally {
      inFlight.current = false;
      if (isMounted.current) setRunning(false);
    }
  };
  const update = (value: string) => {
    setResult(null);
    onCode(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      setMessage("This browser could not save your code; keep a copy before leaving the page.");
    }
  };
  useEffect(() => {
    if (code === lastTrackedCode.current) return;
    const edit = { code, questionId, ctx: contextRef.current };
    const send = () => {
      lastTrackedCode.current = edit.code;
      if (edit.code.trim())
        void trackRef.current(
          "code_edited",
          { code: edit.code, unitId: edit.ctx.unitId, ...(edit.ctx.assignmentId ? { assignmentId: edit.ctx.assignmentId } : {}), ...(edit.ctx.itemId ? { itemId: edit.ctx.itemId } : {}), envKey: edit.ctx.envKey },
          edit.questionId,
        );
    };
    let sent = false;
    const timer = setTimeout(() => {
      sent = true;
      send();
    }, CODE_EDIT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      // [AU-D3-06] a pending edit is enqueued immediately on unmount or question change instead of being dropped
      if (!sent && (!isMounted.current || current.current.questionId !== edit.questionId)) send();
    };
    // WHY: the timer restarts only when the code or question changes, not on new track/context objects.
  }, [code, questionId, storageKey]);
  const load = async (file?: File) => {
    if (!file) return;
    if (!/\.(csv|rds|txt|tsv|json)$/i.test(file.name) || file.size > 10_000_000) {
      setMessage("Choose a CSV, TSV, JSON, RDS, or TXT file smaller than 10 MB.");
      return;
    }
    setToolsBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const path = await writeDataFile(file.name, bytes);
      const name = path.split("/").pop() || file.name;
      void track("data_file_loaded", { name, size: bytes.length, sha256: await sha256Bytes(bytes), source: "upload" }, questionId);
      setMessage(`Loaded ${path}. Read it with ${/\.rds$/i.test(name) ? "readRDS" : /\.csv$/i.test(name) ? "read.csv" : "readLines"}().`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setToolsBusy(false);
    }
  };
  const install = async () => {
    const name = packageName.trim();
    if (!/^[A-Za-z][A-Za-z0-9.]{0,60}$/.test(name)) {
      setMessage("Enter one R package name, such as dplyr.");
      return;
    }
    if (!isAllowedWebrPackage(name)) {
      setMessage(`${name} is not on this course's package list. Available: ${WEBR_PACKAGE_ALLOWLIST.join(", ")}.`);
      return;
    }
    setToolsBusy(true);
    setMessage(`Installing ${name}…`);
    try {
      await getRuntime();
      const outcome = await installPackage(name);
      void track("r_package_install", { package: name, ok: outcome.ok, error: outcome.error || "", durationMs: outcome.durationMs }, questionId);
      setMessage(outcome.ok ? `${name} is available. Load it with library(${name}).` : `Could not install ${name}: ${outcome.error}`);
    } finally {
      setToolsBusy(false);
    }
  };
  const resetEnv = async () => {
    await resetEnvironment(context.envKey);
    setResult(null);
    setMessage("The R environment for this question was cleared. Run your code again.");
  };
  return (
    <section className="panel work-panel r-workbench">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">R WORKSPACE</p>
          <h2>
            <Terminal size={19} /> Run, inspect, improve
          </h2>
        </div>
        <span className="small-pill">Browser webR</span>
      </div>
      <p className="muted">Your code is saved on this browser as you type. Each question has its own R environment.</p>
      <textarea className="work-code mono" spellCheck={false} aria-label="R code editor" data-paste-target="code" value={code} onChange={(e) => update(e.target.value)} />
      <div className="work-actions">
        <button className="run-button" disabled={running || toolsBusy || !code.trim() || !allowRun} onClick={() => void run()}>
          {running ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />} {running ? "Running…" : "Run code"}
        </button>
        <button className="text-button" disabled={running} onClick={() => update(resetCode)}>
          <RotateCcw size={15} /> Reset example
        </button>
        <button className="text-button" disabled={running} onClick={() => void resetEnv()}>
          <Eraser size={15} /> Clear R environment
        </button>
        {!allowRun && <span className="muted">Running code is turned off for this question.</span>}
      </div>
      <RunOutputView result={result && result.code === code ? result : null} />
      <details className="runtime-options">
        <summary>Data files and R packages</summary>
        <div className="runtime-tools">
          <label>
            Load course data
            <input type="file" accept=".csv,.tsv,.json,.rds,.txt" disabled={toolsBusy || running} onChange={(e) => void load(e.target.files?.[0])} />
          </label>
          <label>
            R package
            <input value={packageName} onChange={(e) => setPackageName(e.target.value)} placeholder="dplyr" list="webr-packages" />
            <datalist id="webr-packages">
              {WEBR_PACKAGE_ALLOWLIST.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </label>
          <button className="outline-button" disabled={toolsBusy || running || !packageName} onClick={() => void install()}>
            Install package
          </button>
        </div>
      </details>
      {message && (
        <p role="status" className="work-message">
          {message}
        </p>
      )}
    </section>
  );
}

/** Console view: output (errors in red), the hint, warnings and plots — KEEP: code, output, red errors, run result. */
export function RunOutputView({ result }: { result: WorkbenchRun | null }) {
  return (
    <div className="output-area" aria-live="polite">
      <div className="output-heading">Console {result && `· ${result.durationMs} ms`}</div>
      {result ? (
        <>
          <pre className={result.ok ? "" : "output-error"}>{result.output || result.error || "Completed with no text output."}</pre>
          {result.warnings.length > 0 && (
            <p className="r-warnings muted">
              {result.warnings.length === 1 ? "1 warning" : `${result.warnings.length} warnings`} — see the console above.
            </p>
          )}
          {result.hint && <p className="debug-tip">{result.hint.hint}</p>}
          {result.bitmaps.length > 0 && (
            <div className="r-plots">
              {result.bitmaps.map((bitmap, index) => (
                <PlotCanvas key={index} bitmap={bitmap} index={index} />
              ))}
            </div>
          )}
          {result.plotsUnavailable && result.plots === 0 && /plot\(|ggplot|hist\(|barplot\(/.test(result.code) && (
            <p className="muted">Plot not available on this device.</p>
          )}
        </>
      ) : (
        <p className="muted">Run your code to see its output. The first run loads the R runtime.</p>
      )}
    </div>
  );
}
