import { useEffect, useRef, useState } from "react";
import { CheckFeedback } from "../../components/CheckFeedback";
import { ResponseText } from "../../components/ResponseText";
import { Eye, Plus } from "lucide-react";
import { api } from "../../lib/api";
import { STUDENT_LABELS } from "../../lib/labels";
import {
  aiErrorMessage,
  checkItem,
  difficultyOptions,
  generateSimilar,
  itemSourceLabel,
  reportUnreached,
  revealItem,
  verifyAfterFirstCheck,
  webRRunner,
  type CheckResultView,
} from "../../lib/questions";
import { RWorkbench } from "../tools/RWorkbench";
import type { Difficulty, GeneratedItemPublic, PublicPolicy, RunResultView, SimilarPanelProps } from "../../types";

/*
 * "Try a similar question" (AIRUN; props frozen, §7.9; rendered by ASSESS's AssignmentPage). POST /api/ai/similar —
 * the server loads the source question itself, applies the assignment's tool policy, rejects items that would leak the
 * homework answer, and stores the item. Checks run on the server; the explanation is withheld while the homework is
 * still protected ("The explanation is shown after the homework closes.").
 */
export function SimilarPanel({ classId, studentId, unitId, assignmentId, question, track, disabledReason }: SimilarPanelProps) {
  const [policy, setPolicy] = useState<PublicPolicy | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>(2);
  const [similar, setSimilar] = useState<GeneratedItemPublic | null>(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<CheckResultView | null>(null);
  const [revealed, setRevealed] = useState<{ answer: string; explanation: string } | null>(null);
  const [code, setCode] = useState("");
  const [run, setRun] = useState<(RunResultView & { code: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shownAt = useRef(Date.now());
  const mounted = useRef(true);
  const storageKey = `kiwi-code-${classId}-${studentId}-${assignmentId}-${question.id}-similar`;
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setPolicy(null);
    api
      .policy(classId, unitId)
      .then((p) => {
        if (!active) return;
        setPolicy(p);
        setDifficulty((p.startingDifficulty ?? p.defaultDifficulty ?? p.minDifficulty) as Difficulty);
      })
      .catch((e: unknown) => {
        if (active) setError(aiErrorMessage(e));
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [classId, unitId]);
  const generate = async () => {
    if (!policy || busy || disabledReason) return;
    setBusy(true);
    setError("");
    try {
      const next = await generateSimilar(classId, { studentId, assignmentId, questionId: question.id, difficulty });
      if (!mounted.current) return;
      setSimilar(next);
      setAnswer("");
      setResult(null);
      setRevealed(null);
      setCode(next.starterCode || next.code || "");
      setRun(null);
      shownAt.current = Date.now();
      void track("question_viewed", { itemId: next.id, unitId, assignmentId, questionTitle: next.title }, next.id);
    } catch (e) {
      await reportUnreached(track, e, { action: "similar", surface: "similar", unitId, assignmentId, questionId: question.id }).catch(() => false);
      if (mounted.current) setError(aiErrorMessage(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const check = async () => {
    if (!similar || busy) return;
    setBusy(true);
    setError("");
    try {
      const outcome = await checkItem(classId, similar.id, {
        answer: similar.type === "complete" ? code : answer,
        ...(similar.type === "complete" && run ? { runOutput: run.output } : {}),
        eventId: crypto.randomUUID(),
        timeOnItemMs: Math.max(0, Math.round(Date.now() - shownAt.current)),
      });
      if (!mounted.current) return;
      setResult(outcome);
      if (outcome.explanation) void track("explanation_shown", { itemId: similar.id, context: "similar" }, similar.id);
      if (outcome.attemptIndex === 1) void verifyAfterFirstCheck(classId, similar, webRRunner).catch(() => false);
    } catch (e) {
      if (mounted.current) setError(aiErrorMessage(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const reveal = async () => {
    if (!similar) return;
    try {
      const shown = await revealItem(classId, similar.id);
      if (mounted.current) setRevealed(shown);
    } catch (e) {
      if (mounted.current) setError(aiErrorMessage(e));
    }
  };
  const levels = policy ? difficultyOptions(policy, null) : [];
  return (
    <section className="panel work-panel focused-panel">
      <h2>{STUDENT_LABELS.trySimilarQuestion}</h2>
      <p className="muted">These exercises help you practice. They do not change your assignment answers.</p>
      {disabledReason ? (
        <p className="empty-state">{disabledReason}</p>
      ) : (
        <div className="work-actions">
          <label>
            Difficulty{" "}
            <select aria-label="Similar question difficulty" value={difficulty} disabled={busy || !policy} onChange={(e) => setDifficulty(Number(e.target.value) as Difficulty)}>
              {levels.map((d) => (
                <option key={d.value} value={d.value} disabled={d.disabled}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-button" disabled={busy || !policy} onClick={() => void generate()}>
            <Plus size={16} />
            {busy ? "Generating…" : similar ? "Next similar exercise" : "Generate similar exercise"}
          </button>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {similar && (
        <div className="similar-card">
          <p className="airun-item-meta">{itemSourceLabel(similar.source)}</p>
          <h2>{similar.title}</h2>
          <ResponseText className="question-prompt" text={similar.prompt} />
          {similar.code && <pre className="question-code">{similar.code}</pre>}
          {similar.type === "choice" ? (
            <div className="choices" role="radiogroup" aria-label="Similar question choices">
              {similar.choices?.map((c, i) => (
                <button
                  key={i}
                  role="radio"
                  aria-checked={answer === c}
                  className={`choice ${answer === c ? "selected" : ""}`}
                  onClick={() => {
                    setAnswer(c);
                    setResult(null);
                  }}
                >
                  <span>{String.fromCharCode(65 + i)}</span>
                  {c}
                </button>
              ))}
            </div>
          ) : similar.type === "complete" ? (
            <RWorkbench
              code={code}
              onCode={(v) => {
                setCode(v);
                setRun(null);
              }}
              onResult={setRun}
              track={(type, payload, qid) => track(type, { ...payload, itemId: similar.id, questionTitle: similar.title }, qid)}
              questionId={similar.id}
              storageKey={storageKey}
              context={{ unitId, surface: "similar", assignmentId, itemId: similar.id, envKey: `similar:${similar.id}` }}
            />
          ) : similar.type === "explain" ? (
            <textarea
              aria-label="Similar question explanation"
              rows={4}
              maxLength={4000}
              value={answer}
              onChange={(e) => {
                setAnswer(e.target.value);
                setResult(null);
              }}
            />
          ) : (
            <input
              aria-label="Similar question answer"
              value={answer}
              onChange={(e) => {
                setAnswer(e.target.value);
                setResult(null);
              }}
            />
          )}
          <div className="work-actions">
            <button
              className="primary-button"
              disabled={busy || (similar.type === "complete" ? !(run?.ok && run.code === code) : !answer.trim())}
              onClick={() => void check()}
            >
              Check similar answer
            </button>
            {result?.canReveal && !revealed && (
              <button className="outline-button" onClick={() => void reveal()}>
                <Eye size={16} /> Reveal answer
              </button>
            )}
          </div>
          {result && <CheckFeedback result={result} />}
          {result?.feedback && <ResponseText className="airun-ai-feedback" text={result.feedback} />}
          {result?.verification === "mismatch" && <p className="airun-warning">{result.verificationNotice}</p>}
          {revealed && (
            <div className="airun-revealed" role="status">
              <strong>Answer:</strong> <code>{revealed.answer}</code>
              {revealed.explanation && <ResponseText text={revealed.explanation} />}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
