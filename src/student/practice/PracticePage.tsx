import { useEffect, useRef, useState } from "react";
import { ArrowRight, Eye, Plus, Settings2 } from "lucide-react";
import { CheckFeedback } from "../../components/CheckFeedback";
import { ResponseText } from "../../components/ResponseText";
import { api } from "../../lib/api";
import { questionTypeLabel, STUDENT_LABELS } from "../../lib/labels";
import { navigate, studentHref } from "../../lib/navigation";
import {
  aiErrorMessage,
  chapterOptions,
  checkItem,
  difficultyOptions,
  firstUsableChapter,
  generateItem,
  itemSourceLabel,
  lockedFrom,
  practiceStatus,
  reportUnreached,
  revealItem,
  settingsChanges,
  skippedPayload,
  verifyAfterFirstCheck,
  webRRunner,
  type CheckResultView,
  type PracticeSettings,
  type SelectOption,
} from "../../lib/questions";
import { setTelemetryContext } from "../../lib/telemetry";
import { KiwiChat } from "../tools/KiwiChat";
import { RWorkbench, DEFAULT_R_CODE } from "../tools/RWorkbench";
import type { StudentPageProps } from "../StudentApp";
import type { AiQuestionType, Difficulty, GeneratedItemPublic, PublicPolicy, RunResultView, Tracker } from "../../types";

/*
 * Practice exercises (free practice; AIRUN, §9.4/§12.8). Route: /student/practice/:tool (settings | question | code | kiwi).
 * Items come from POST /api/ai/question without answer keys; checks, reveal and the one-shot verification run go through
 * the server. Locked chapters show as "… (Opens later)", Review chapters allow Ask Kiwi only, difficulties above the
 * unlocked level show "(locked)". Settings changes and skipped items are reported as events.
 */

type Stored = { item: GeneratedItemPublic | null; answer: string; code: string; settings: PracticeSettings | null };

export interface PracticeSettingsViewProps {
  chapters: SelectOption<string>[];
  types: AiQuestionType[];
  difficulties: SelectOption<Difficulty>[];
  settings: PracticeSettings;
  policy: Pick<PublicPolicy, "aiAvailable" | "minDifficulty" | "maxDifficulty"> & { practice?: { allowFocusNote?: boolean; dailyItemLimit?: number } } | null;
  usedToday: number | null;
  busy: boolean;
  onChange: (next: PracticeSettings) => void;
  onGenerate: () => void;
}

export function PracticeSettingsView({ chapters, types, difficulties, settings, policy, usedToday, busy, onChange, onGenerate }: PracticeSettingsViewProps) {
  const allowFocus = policy?.practice?.allowFocusNote !== false;
  const limit = policy?.practice?.dailyItemLimit ?? 0;
  // RV6-m14: a chapter that is not open for practice (Opens later / Review) is refused before Generate, not after
  const chapter = chapters.find((c) => c.value === settings.unitId);
  const chapterBlocked = Boolean(chapter?.disabled);
  return (
    <section className="panel work-panel focused-panel">
      <div className="panel-heading">
        <div>
          <h2>Choose your next exercise</h2>
        </div>
        <Settings2 size={20} aria-hidden="true" />
      </div>
      <label className="work-label">
        Chapter
        <select value={settings.unitId} disabled={busy} onChange={(e) => onChange({ ...settings, unitId: e.target.value })}>
          {chapters.map((c) => (
            <option value={c.value} key={c.value} disabled={c.disabled}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="work-label">
        Question type
        <select value={settings.type} disabled={!policy || busy} onChange={(e) => onChange({ ...settings, type: e.target.value as AiQuestionType })}>
          {types.map((t) => (
            <option key={t} value={t}>
              {questionTypeLabel(t)}
            </option>
          ))}
        </select>
      </label>
      <label className="work-label">
        Difficulty
        <select value={settings.difficulty} disabled={!policy || busy} onChange={(e) => onChange({ ...settings, difficulty: Number(e.target.value) as Difficulty })}>
          {difficulties.map((d) => (
            <option key={d.value} value={d.value} disabled={d.disabled}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      {allowFocus && (
        <label className="work-label">
          What would you like to work on?
          <textarea rows={3} maxLength={400} value={settings.focusNote} onChange={(e) => onChange({ ...settings, focusNote: e.target.value })} placeholder="I want to understand logical indexing." />
        </label>
      )}
      {policy && (
        <p className="muted">
          {policy.aiAvailable ? "Ask Kiwi uses your teacher's chapter rules." : "Ready-made template exercises are available; the AI is not available right now."}
          {limit > 0 && usedToday !== null ? ` ${Math.max(0, limit - usedToday)} of ${limit} exercises left today.` : ""}
        </p>
      )}
      {chapterBlocked && chapter && (
        <p className="airun-warning" role="note">
          {chapter.label} is not open for practice. Choose another chapter.
        </p>
      )}
      <div className="work-actions">
        <button className="primary-button" disabled={!policy || busy || !types.length || chapterBlocked} onClick={onGenerate}>
          <Plus size={16} />
          {busy ? "Generating…" : "Generate exercise"}
        </button>
      </div>
    </section>
  );
}

export interface PracticeItemViewProps {
  item: GeneratedItemPublic;
  answer: string;
  result: CheckResultView | null;
  revealed: { answer: string; explanation: string } | null;
  busy: boolean;
  canCheck: boolean;
  onAnswer: (value: string) => void;
  onCheck: () => void;
  onReveal: () => void;
  onNext: () => void;
  onOpenCode: () => void;
}

export function PracticeItemView({ item, answer, result, revealed, busy, canCheck, onAnswer, onCheck, onReveal, onNext, onOpenCode }: PracticeItemViewProps) {
  return (
    <section className="panel work-panel focused-panel">
      <p className="airun-item-meta">
        {questionTypeLabel(item.type)} · {item.difficulty}/5 · {itemSourceLabel(item.source)}
      </p>
      <h2>{item.title}</h2>
      <ResponseText className="question-prompt" text={item.prompt} />
      {item.code && <pre className="question-code">{item.code}</pre>}
      {item.type === "choice" ? (
        <div className="choices" role="radiogroup" aria-label="Answer choices">
          {item.choices?.map((c, i) => (
            <button className={`choice ${answer === c ? "selected" : ""}`} key={i} role="radio" aria-checked={answer === c} onClick={() => onAnswer(c)}>
              <span>{String.fromCharCode(65 + i)}</span>
              {c}
            </button>
          ))}
        </div>
      ) : item.type === "complete" ? (
        <>
          <pre className="question-code">{item.starterCode}</pre>
          <button className="outline-button" onClick={onOpenCode}>
            Complete in R workspace <ArrowRight size={16} />
          </button>
        </>
      ) : item.type === "explain" ? (
        <textarea className="answer-input" aria-label="Your explanation" rows={4} maxLength={4000} value={answer} onChange={(e) => onAnswer(e.target.value)} placeholder="Explain in your own words" />
      ) : (
        <input className="answer-input" aria-label="Your answer" value={answer} onChange={(e) => onAnswer(e.target.value)} placeholder="Enter your answer" />
      )}
      {result && <CheckFeedback result={result} />}
      {result?.feedback && <ResponseText className="airun-ai-feedback" text={result.feedback} />}
      {result?.verification === "mismatch" && <p className="airun-warning">{result.verificationNotice ?? "This exercise failed an automatic check; its answer key may be wrong."}</p>}
      {revealed && (
        <div className="airun-revealed" role="status">
          <strong>Answer:</strong> <code>{revealed.answer}</code>
          {revealed.explanation && <ResponseText text={revealed.explanation} />}
        </div>
      )}
      <div className="work-actions">
        <button className="primary-button" disabled={busy || !canCheck} onClick={onCheck}>
          Check answer
        </button>
        {result?.canReveal && !revealed && (
          <button className="outline-button" disabled={busy} onClick={onReveal}>
            <Eye size={16} /> Reveal answer
          </button>
        )}
        <button className="outline-button" disabled={busy} onClick={onNext}>
          {busy ? "Generating…" : "Next exercise"} <ArrowRight size={16} />
        </button>
      </div>
    </section>
  );
}

const PRACTICE_TABS: [string, string][] = [
  ["settings", "Practice settings"],
  ["question", "Question"],
  ["code", "R workspace"],
  ["kiwi", "Ask Kiwi"],
];

export function PracticePage({ classId, studentId, course, track, params }: StudentPageProps) {
  const tool = params.tool || "settings";
  const storageKey = `kiwi-practice-v6-${classId}-${studentId}`;
  const initial = useRef<Stored | null>(null);
  if (initial.current === null) {
    try {
      initial.current = JSON.parse(sessionStorage.getItem(storageKey) || "null") as Stored | null;
    } catch {
      initial.current = null; // WHY: a corrupt or unavailable store starts a fresh session
    }
  }
  const [item, setItem] = useState<GeneratedItemPublic | null>(initial.current?.item || null);
  const [settings, setSettings] = useState<PracticeSettings>(
    initial.current?.settings || { unitId: firstUsableChapter(course, "practice", course.currentUnitId), type: "choice", difficulty: 2, focusNote: "" },
  );
  const [policy, setPolicy] = useState<PublicPolicy | null>(null);
  const [unlockedMax, setUnlockedMax] = useState<number | null>(null);
  const [usedToday, setUsedToday] = useState<number | null>(null);
  const [answer, setAnswer] = useState(initial.current?.answer || "");
  const [code, setCode] = useState(initial.current?.code || DEFAULT_R_CODE);
  const [result, setResult] = useState<CheckResultView | null>(null);
  const [revealed, setRevealed] = useState<{ answer: string; explanation: string } | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<(RunResultView & { code: string }) | null>(null);
  const shownAt = useRef(Date.now());
  const context = useRef(settings.unitId);
  context.current = settings.unitId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setTelemetryContext({ surface: "free-practice", unitId: item?.unitId || settings.unitId, itemId: item?.id, tool });
    return () => setTelemetryContext(null);
  }, [item?.unitId, item?.id, settings.unitId, tool]);
  useEffect(() => {
    let active = true;
    setPolicy(null);
    setError("");
    Promise.all([api.policy(classId, settings.unitId), practiceStatus(classId, settings.unitId).catch(() => null)])
      .then(([p, status]) => {
        if (!active) return;
        setPolicy(p);
        const unlocked = status?.unlockedMaxDifficulty ?? p.practice?.unlockedMaxDifficulty ?? null;
        setUnlockedMax(unlocked);
        setUsedToday(status?.usedToday ?? p.practice?.usedToday ?? null);
        setSettings((s) => {
          const types = p.allowedTypes;
          const type = types.includes(s.type) ? s.type : types[0] ?? s.type;
          const start = p.startingDifficulty ?? p.defaultDifficulty ?? p.minDifficulty;
          const top = Math.min(p.maxDifficulty, unlocked ?? p.maxDifficulty);
          const difficulty = Math.max(p.minDifficulty, Math.min(top, s.unitId === item?.unitId ? s.difficulty : start)) as Difficulty;
          return type === s.type && difficulty === s.difficulty ? s : { ...s, type, difficulty };
        });
      })
      .catch((e: unknown) => {
        if (active) setError(aiErrorMessage(e));
      });
    return () => {
      active = false;
    };
    // WHY: the chapter policy and unlock state are reloaded when the chapter changes.
  }, [classId, settings.unitId]);
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ item, answer, code, settings }));
    } catch {
      // WHY: losing the in-progress exercise on reload is acceptable when storage is unavailable.
    }
  }, [item, answer, code, settings, storageKey]);
  const changeSettings = (next: PracticeSettings) => {
    for (const change of settingsChanges(settings, next)) void track("practice_settings_changed", { ...change, unitId: next.unitId });
    setSettings(next);
  };
  const codeTrack: Tracker = (eventType, payload, qid) =>
    track(eventType, { ...payload, unitId: item?.unitId || settings.unitId, itemId: item?.id, questionTitle: item?.title }, qid);
  const create = async () => {
    if (!policy || busy) return;
    const skipped = skippedPayload(item, result?.correct, attempts);
    if (skipped) void track("question_skipped", skipped, skipped.itemId);
    setBusy(true);
    setError("");
    const requestedUnit = settings.unitId;
    try {
      const next = await generateItem(classId, {
        studentId, unitId: settings.unitId, type: settings.type, difficulty: settings.difficulty,
        ...(settings.focusNote.trim() ? { focusNote: settings.focusNote.trim() } : {}),
      });
      if (!mounted.current || context.current !== requestedUnit) return;
      setItem(next);
      setAnswer("");
      setResult(null);
      setRevealed(null);
      setRun(null);
      setAttempts(0);
      shownAt.current = Date.now();
      setUsedToday((n) => (n === null ? n : n + 1));
      if (next.starterCode || next.code) setCode(next.starterCode || next.code || "");
      void track("question_viewed", { itemId: next.id, unitId: next.unitId, questionTitle: next.title }, next.id);
      navigate("/student/practice/question");
    } catch (e) {
      await reportUnreached(track, e, { action: "question", surface: "free-practice", unitId: requestedUnit }).catch(() => false);
      const locked = lockedFrom(e);
      if (locked !== null) setUnlockedMax(locked);
      if (mounted.current) setError(aiErrorMessage(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const check = async () => {
    if (!item || busy) return;
    if (item.type === "complete" && (!run?.ok || run.code !== code)) {
      setError("Run the current code successfully before checking.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const outcome = await checkItem(classId, item.id, {
        answer: item.type === "complete" ? code : answer,
        ...(item.type === "complete" && run ? { runOutput: run.output } : {}),
        eventId: crypto.randomUUID(),
        timeOnItemMs: Math.max(0, Math.round(Date.now() - shownAt.current)),
      });
      if (!mounted.current) return;
      setResult(outcome);
      setAttempts((n) => n + 1);
      if (outcome.explanation) void track("explanation_shown", { itemId: item.id, context: "free-practice" }, item.id);
      if (outcome.attemptIndex === 1) void verifyAfterFirstCheck(classId, item, webRRunner).catch(() => false);
    } catch (e) {
      if (mounted.current) setError(aiErrorMessage(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const reveal = async () => {
    if (!item) return;
    try {
      const shown = await revealItem(classId, item.id);
      if (mounted.current) setRevealed(shown);
    } catch (e) {
      if (mounted.current) setError(aiErrorMessage(e));
    }
  };
  const unit = course.units.find((u) => u.id === (item?.unitId || settings.unitId));
  const difficulties = policy ? difficultyOptions(policy, unlockedMax) : [];
  return (
    <div className="student-content">
      <div className="page-intro">
        <div>
          <h1>{STUDENT_LABELS.navPractice}</h1>
          <p className="muted">
            Practice a chapter at your own pace, within your teacher's guidance.
            {/* SB-m12: say so when the exercises come from templates, not from AI */}
            {policy && policy.aiAvailable === false ? " The AI is not available right now, so exercises come from ready-made templates." : ""}
          </p>
        </div>
      </div>
      <nav className="page-tabs" aria-label="Practice pages">
        {PRACTICE_TABS.map(([id, label]) => (
          <a
            key={id}
            href={studentHref(`/student/practice/${id}`)}
            aria-current={tool === id ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/student/practice/${id}`);
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {tool === "settings" ? (
        <PracticeSettingsView
          chapters={chapterOptions(course, "practice")}
          types={policy?.allowedTypes ?? []}
          difficulties={difficulties}
          settings={settings}
          policy={policy}
          usedToday={usedToday}
          busy={busy}
          onChange={changeSettings}
          onGenerate={() => void create()}
        />
      ) : tool === "code" ? (
        <>
          <p className="context-caption">
            {unit?.title}
            {item && ` / ${item.title}`}
          </p>
          <RWorkbench
            key={item?.id || "scratch"}
            code={code}
            onCode={(v) => {
              setCode(v);
              setRun(null);
              setResult(null);
            }}
            onResult={setRun}
            track={codeTrack}
            questionId={item?.id}
            storageKey={`kiwi-practice-code-${classId}-${studentId}`}
            context={{ unitId: item?.unitId || settings.unitId, surface: "free-practice", ...(item ? { itemId: item.id } : {}), envKey: `practice:${item?.id || "scratch"}` }}
            runtime={unit?.runtime}
          />
          {item?.type === "complete" && (
            <div className="work-actions">
              <button className="primary-button" onClick={() => navigate("/student/practice/question")}>
                Return to check answer <ArrowRight size={16} />
              </button>
            </div>
          )}
        </>
      ) : tool === "kiwi" ? (
        <>
        {/* RV6-m14: the practice chat names the chapter (and exercise) it is about */}
        <p className="context-caption">
          Ask Kiwi about {unit?.title || "this chapter"}
          {item && ` / ${item.title}`}
        </p>
        <KiwiChat
          key={item?.id || settings.unitId}
          classId={classId}
          studentId={studentId}
          unitId={item?.unitId || settings.unitId}
          surface="free-practice"
          itemId={item?.id}
          question={item?.prompt || unit?.goal || ""}
          code={code}
          track={track}
          lastRun={run ? { ok: run.ok, output: run.output, ...(run.error ? { error: run.error } : {}) } : null}
          answerDraft={item && item.type !== "complete" ? answer : undefined}
        />
        </>
      ) : item ? (
        <PracticeItemView
          item={item}
          answer={answer}
          result={result}
          revealed={revealed}
          busy={busy}
          canCheck={item.type === "complete" ? Boolean(run?.ok && run.code === code) : Boolean(answer.trim())}
          onAnswer={(v) => {
            setAnswer(v);
            setResult(null);
          }}
          onCheck={() => void check()}
          onReveal={() => void reveal()}
          onNext={() => void create()}
          onOpenCode={() => navigate("/student/practice/code")}
        />
      ) : (
        <section className="panel work-panel focused-panel">
          <div className="empty-state">
            <h2>Choose a chapter to get started</h2>
            <button className="primary-button" onClick={() => navigate("/student/practice/settings")}>
              Open practice settings
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
