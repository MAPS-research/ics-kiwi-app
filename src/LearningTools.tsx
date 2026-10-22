import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  LoaderCircle,
  Play,
  RotateCcw,
  Sparkles,
  Terminal,
} from "lucide-react";
import { api } from "./lib/api";
import { debugHint, getRuntime, runR, type RunResult } from "./lib/rEngine";
import { threadFor } from "./lib/navigation";

export type Tracker = (
  type: string,
  payload: Record<string, unknown>,
  questionId?: string,
) => Promise<void>;

export function ResponseText({ text }: { text: string }) {
  const inline = (value: string) =>
    value
      .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
      .map((s, i) =>
        s.startsWith("`") ? (
          <code key={i}>{s.slice(1, -1)}</code>
        ) : s.startsWith("**") ? (
          <strong key={i}>{s.slice(2, -2)}</strong>
        ) : (
          s
        ),
      );
  return (
    <div className="response-text">
      {text.split(/(```[\s\S]*?```)/g).map((block, i) =>
        block.startsWith("```") ? (
          <pre key={i}>
            <code>
              {block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}
            </code>
          </pre>
        ) : (
          <div key={i}>
            {block
              .split("\n")
              .filter(Boolean)
              .map((line, j) =>
                /^#{1,6} /.test(line) ? (
                  <h3 key={j}>{inline(line.replace(/^#{1,6} /, ""))}</h3>
                ) : (
                  <p key={j}>{inline(line)}</p>
                ),
              )}
          </div>
        ),
      )}
    </div>
  );
}

export function RWorkbench({
  code,
  onCode,
  onResult,
  track,
  questionId,
  metadata,
  storageKey,
}: {
  code: string;
  onCode: (code: string) => void;
  onResult?: (result: RunResult & { code: string }) => void;
  track: Tracker;
  questionId?: string;
  metadata: Record<string, unknown>;
  storageKey: string;
}) {
  const [result, setResult] = useState<(RunResult & { code: string }) | null>(
    null,
  );
  const [running, setRunning] = useState(false);
  const [toolsBusy, setToolsBusy] = useState(false);
  const [packageName, setPackageName] = useState("");
  const [message, setMessage] = useState("");
  const current = useRef({ code, questionId, storageKey });
  current.current = { code, questionId, storageKey };
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const lastTrackedCode = useRef(code);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async () => {
    if (inFlight.current || !code.trim()) return;
    inFlight.current = true;
    setRunning(true);
    setMessage("");
    setResult(null);
    const snapshot = { code, questionId, storageKey };
    try {
      const value = await runR(code);
      if (
        mounted.current &&
        JSON.stringify(current.current) === JSON.stringify(snapshot)
      ) {
        setResult({ ...value, code });
        onResult?.({ ...value, code });
      } else value.plots.forEach((p) => p.close());
      await track(
        "code_run",
        {
          ...metadata,
          code: snapshot.code,
          ok: value.ok,
          output: value.output,
          error: value.error || "",
          durationMs: value.durationMs,
        },
        questionId,
      );
    } finally {
      inFlight.current = false;
      if (mounted.current) setRunning(false);
    }
  };
  const update = (value: string) => {
    setResult(null);
    onCode(value);
    localStorage.setItem(storageKey, value);
  };
  useEffect(() => {
    if (code === lastTrackedCode.current) return;
    const timer = setTimeout(() => {
      lastTrackedCode.current = code;
      if (code.trim())
        void track("code_edited", { ...metadata, code }, questionId);
    }, 1800);
    return () => clearTimeout(timer);
  }, [code, questionId, storageKey]);
  const load = async (file?: File) => {
    if (!file) return;
    if (!/\.(csv|rds|txt)$/i.test(file.name) || file.size > 10_000_000) {
      setMessage("Choose a CSV, RDS, or TXT file smaller than 10 MB.");
      return;
    }
    setToolsBusy(true);
    try {
      const name = file.name.replace(/[^A-Za-z0-9_.-]/g, "_");
      const runtime = await getRuntime();
      await runtime.FS.writeFile(
        `/home/web_user/${name}`,
        new Uint8Array(await file.arrayBuffer()),
      );
      setMessage(
        `Loaded /home/web_user/${name}. Read it with ${/\.rds$/i.test(name) ? "readRDS" : /\.csv$/i.test(name) ? "read.csv" : "readLines"}().`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setToolsBusy(false);
    }
  };
  const install = async () => {
    if (!/^[A-Za-z][A-Za-z0-9.]{0,60}$/.test(packageName)) {
      setMessage("Enter one R package name, such as dplyr.");
      return;
    }
    setToolsBusy(true);
    setMessage(`Installing ${packageName}…`);
    try {
      const runtime = await getRuntime();
      await runtime.installPackages(packageName);
      setMessage(
        `${packageName} is available. Load it with library(${packageName}).`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setToolsBusy(false);
    }
  };
  return (
    <section className="panel work-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">R WORKSPACE</p>
          <h2>
            <Terminal size={19} /> Run, inspect, improve
          </h2>
        </div>
        <span className="small-pill">Browser webR</span>
      </div>
      <p className="muted">
        Your code is saved on this browser as you type. Run it again after every
        change.
      </p>
      <textarea
        className="work-code mono"
        spellCheck={false}
        aria-label="R code editor"
        value={code}
        onChange={(e) => update(e.target.value)}
      />
      <div className="work-actions">
        <button
          className="run-button"
          disabled={running || toolsBusy || !code.trim()}
          onClick={() => void run()}
        >
          {running ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Play size={16} />
          )}{" "}
          {running ? "Running…" : "Run code"}
        </button>
        <button
          className="text-button"
          disabled={running}
          onClick={() => update("scores <- c(72, 85, 91)\nprint(mean(scores))")}
        >
          <RotateCcw size={15} /> Reset example
        </button>
      </div>
      <div className="output-area" aria-live="polite">
        <div className="output-heading">
          Console {result && `· ${result.durationMs} ms`}
        </div>
        {result && result.code === code ? (
          <>
            <pre className={result.ok ? "" : "output-error"}>
              {result.output ||
                result.error ||
                "Completed with no text output."}
            </pre>
            {!result.ok && (
              <p className="debug-tip">
                {debugHint(result.error || result.output)}
              </p>
            )}
          </>
        ) : (
          <p className="muted">
            Run your code to see its output. The first run loads the R runtime.
          </p>
        )}
      </div>
      <details className="runtime-options">
        <summary>Data files and R packages</summary>
        <div className="runtime-tools">
          <label>
            Load course data
            <input
              type="file"
              accept=".csv,.rds,.txt"
              disabled={toolsBusy || running}
              onChange={(e) => void load(e.target.files?.[0])}
            />
          </label>
          <label>
            R package
            <input
              value={packageName}
              onChange={(e) => setPackageName(e.target.value)}
              placeholder="dplyr"
            />
          </label>
          <button
            className="outline-button"
            disabled={toolsBusy || running || !packageName}
            onClick={() => void install()}
          >
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

export function KiwiChat({
  classId,
  studentId,
  unitId,
  questionId,
  assignmentId,
  question,
  code,
  track,
}: {
  classId: string;
  studentId: string;
  unitId: string;
  questionId?: string;
  assignmentId?: string;
  question: string;
  code: string;
  track: Tracker;
}) {
  const threadId = threadFor(
    `${assignmentId || "practice"}-${questionId || unitId}`,
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [turns, setTurns] = useState<
    { prompt: string; response: string; createdAt: string; local?: boolean }[]
  >([]);
  const [aiAvailable, setAvailable] = useState<boolean | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setTurns([]);
    setError("");
    void Promise.all([
      api.chatHistory(classId, studentId, threadId),
      api.policy(classId, unitId),
    ])
      .then(([history, policy]) => {
        if (active) {
          setTurns(history);
          setAvailable(Boolean(policy.aiAvailable));
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [classId, studentId, unitId, threadId]);
  const ask = async () => {
    if (busy || !input.trim() || aiAvailable === null) return;
    const prompt = input.trim();
    setBusy(true);
    setError("");
    try {
      const response = aiAvailable
        ? (
            await api.chat(classId, {
              studentId,
              unitId,
              questionId,
              assignmentId,
              threadId,
              prompt,
              code,
              sourceQuestion: question,
            })
          ).response
        : "Start by identifying the input, the operation, and the expected output. Use str() to check object types, and print() to inspect one intermediate result at a time. In R, indices start at 1 and missing values need explicit handling. Compare your result with the question before changing the next step.";
      if (mounted.current) {
        setTurns((t) => [
          ...t,
          {
            prompt,
            response,
            createdAt: new Date().toISOString(),
            local: !aiAvailable,
          },
        ]);
        setInput("");
      }
      await track(
        "ai_question",
        {
          unitId,
          assignmentId,
          threadId,
          questionTitle: question,
          prompt,
          response,
          source: aiAvailable ? "kiwi-ai" : "local",
          ok: true,
        },
        questionId,
      );
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section className="panel work-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ASK KIWI</p>
          <h2>Work through the idea</h2>
        </div>
        <Sparkles size={20} />
      </div>
      <p className="muted">
        {aiAvailable
          ? "Kiwi follows your teacher’s chapter guidance. Ask a follow-up in this thread; homework support focuses on reasoning and debugging."
          : "Local guidance is available. AI requires a server API key; local hints use a fixed explanation."}
      </p>
      {turns.length === 0 && !error && (
        <div className="empty-state">
          Ask about a concept or explain where your code gets stuck.
        </div>
      )}
      <div className="chat-turns">
        {turns.map((t, i) => (
          <article className="chat-turn" key={i}>
            <p className="student-message">
              <strong>You</strong> {t.prompt}
            </p>
            <span className="ai-source">
              {t.local ? "Local guidance" : "Kiwi AI"}
            </span>
            <ResponseText text={t.response} />
          </article>
        ))}
      </div>
      <label className="field-label" htmlFor="kiwi-input">
        Your question
      </label>
      <textarea
        id="kiwi-input"
        rows={3}
        maxLength={3000}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Why does mean() return NA, and what should I inspect first?"
      />
      <div className="work-actions">
        <button
          className="primary-button"
          disabled={busy || !input.trim() || aiAvailable === null}
          onClick={() => void ask()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <ArrowRight size={16} />
          )}{" "}
          {busy ? "Thinking…" : "Ask Kiwi"}
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
