import { useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Plus, Settings2 } from "lucide-react";
import { api } from "./lib/api";
import { navigate } from "./lib/navigation";
import { checkAnswer, generateQuestion } from "./lib/questions";
import { KiwiChat, RWorkbench, type Tracker } from "./LearningTools";
import type {
  Course,
  Difficulty,
  GenerationPolicy,
  Question,
  QuestionType,
} from "./types";
import type { RunResult } from "./lib/rEngine";

export const questionLabels: Record<QuestionType, string> = {
  choice: "Multiple choice",
  fill: "Fill in the blank",
  predict: "Predict output",
  complete: "Complete code",
};
export function Practice({
  classId,
  studentId,
  course,
  tool,
  track,
}: {
  classId: string;
  studentId: string;
  course: Course;
  tool: string;
  track: Tracker;
}) {
  const storageKey = `kiwi-practice-v4-${classId}-${studentId}`;
  const load = () => {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey) || "null") as {
        question: Question | null;
        answer: string;
        code: string;
      } | null;
    } catch {
      return null;
    }
  };
  const initial = useRef(load());
  const [question, setQuestion] = useState<Question | null>(
    initial.current?.question || null,
  );
  const [unitId, setUnit] = useState(
    initial.current?.question?.unitId || course.currentUnitId,
  );
  const [type, setType] = useState<QuestionType>(
    initial.current?.question?.type || "choice",
  );
  const [difficulty, setDifficulty] = useState<Difficulty>(
    initial.current?.question?.difficulty || 2,
  );
  const [policy, setPolicy] = useState<GenerationPolicy | null>(null);
  const [answer, setAnswer] = useState(initial.current?.answer || "");
  const [code, setCode] = useState(
    initial.current?.code || "scores <- c(72, 85, 91)\nprint(mean(scores))",
  );
  const [feedback, setFeedback] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<(RunResult & { code: string }) | null>(
    null,
  );
  const [focus, setFocus] = useState("");
  const context = useRef(unitId);
  context.current = unitId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setPolicy(null);
    setError("");
    void api
      .policy(classId, unitId)
      .then((p) => {
        if (active) {
          setPolicy(p);
          setType((t) => (p.allowedTypes.includes(t) ? t : p.allowedTypes[0]));
          setDifficulty(
            (d) =>
              Math.max(
                p.minDifficulty,
                Math.min(
                  p.maxDifficulty,
                  question?.unitId === unitId ? d : p.defaultDifficulty,
                ),
              ) as Difficulty,
          );
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [classId, unitId]);
  useEffect(() => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ question, answer, code }),
    );
  }, [question, answer, code, storageKey]);
  const create = async () => {
    if (!policy || busy) return;
    setBusy(true);
    setError("");
    const requestedUnit = unitId;
    try {
      const q = await generateQuestion({
        classId,
        studentId,
        course,
        unitId,
        type,
        difficulty,
        focusNote: focus,
      });
      if (!mounted.current || context.current !== requestedUnit) return;
      setQuestion(q);
      setAnswer("");
      setFeedback(null);
      setResult(null);
      if (q.starterCode || q.code) setCode(q.starterCode || q.code || "");
      await track(
        "question_generated",
        {
          unitId,
          title: q.title,
          prompt: q.prompt,
          choices: q.choices || [],
          questionType: q.type,
          difficulty: q.difficulty,
          source: q.source,
        },
        q.id,
      );
      navigate("/student/practice/question");
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const check = () => {
    if (!question) return;
    if (question.type === "complete" && (!result?.ok || result.code !== code)) {
      setError("Run the current code successfully before checking.");
      return;
    }
    const correct = checkAnswer(
      question,
      question.type === "complete" ? code : answer,
      result?.output,
    );
    setFeedback(correct);
    setError("");
    void track(
      "answer_submitted",
      {
        unitId: question.unitId,
        title: question.title,
        questionType: question.type,
        answer: question.type === "complete" ? code : answer,
        correct,
      },
      question.id,
    );
  };
  const unit = course.units.find((u) => u.id === (question?.unitId || unitId));
  return (
    <div className="student-content">
      <div className="page-intro">
        <div>
          <p className="eyebrow">GUIDED PRACTICE</p>
          <h1>
            Build understanding<span className="accent-dot">.</span>
          </h1>
          <p className="muted">
            Practice a chapter at your own pace, within your teacher’s guidance.
          </p>
        </div>
      </div>
      <nav className="page-tabs" aria-label="Practice pages">
        {[
          ["settings", "Practice settings"],
          ["question", "Question"],
          ["code", "R workspace"],
          ["kiwi", "Ask Kiwi"],
        ].map(([id, label]) => (
          <a
            key={id}
            href={`/student/practice/${id}`}
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
        <section className="panel work-panel focused-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">PRACTICE BUILDER</p>
              <h2>Choose your next exercise</h2>
            </div>
            <Settings2 size={20} />
          </div>
          <label className="work-label">
            Chapter
            <select
              value={unitId}
              disabled={busy}
              onChange={(e) => setUnit(e.target.value)}
            >
              {course.units.map((u) => (
                <option value={u.id} key={u.id}>
                  {u.title}
                </option>
              ))}
            </select>
          </label>
          <label className="work-label">
            Question type
            <select
              value={type}
              disabled={!policy || busy}
              onChange={(e) => setType(e.target.value as QuestionType)}
            >
              {policy?.allowedTypes.map((t) => (
                <option key={t} value={t}>
                  {questionLabels[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="work-label">
            Difficulty
            <select
              value={difficulty}
              disabled={!policy || busy}
              onChange={(e) =>
                setDifficulty(Number(e.target.value) as Difficulty)
              }
            >
              {[1, 2, 3, 4, 5]
                .filter(
                  (n) =>
                    policy &&
                    n >= policy.minDifficulty &&
                    n <= policy.maxDifficulty,
                )
                .map((n) => (
                  <option key={n} value={n}>
                    {n} / 5
                  </option>
                ))}
            </select>
          </label>
          <label className="work-label">
            What would you like to work on?
            <textarea
              rows={3}
              maxLength={400}
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="I want to understand logical indexing."
            />
          </label>
          {policy && (
            <p className="muted">
              {policy.aiAvailable
                ? "Kiwi AI uses your teacher’s chapter policy."
                : "Local template exercises are available; AI is not configured."}{" "}
              Difficulty is limited to {policy.minDifficulty}–
              {policy.maxDifficulty}.
            </p>
          )}
          <div className="work-actions">
            <button
              className="primary-button"
              disabled={!policy || busy}
              onClick={() => void create()}
            >
              <Plus size={16} />
              {busy ? "Generating…" : "Generate exercise"}
            </button>
          </div>
        </section>
      ) : tool === "code" ? (
        <>
          <p className="context-caption">
            {unit?.title}
            {question && ` / ${question.title}`}
          </p>
          <RWorkbench
            key={question?.id || "scratch"}
            code={code}
            onCode={(v) => {
              setCode(v);
              setResult(null);
              setFeedback(null);
            }}
            onResult={setResult}
            track={track}
            questionId={question?.id}
            metadata={{
              unitId: question?.unitId || unitId,
              questionTitle: question?.title,
            }}
            storageKey={`kiwi-practice-code-${classId}-${studentId}`}
          />
          {question?.type === "complete" && (
            <div className="work-actions">
              <button
                className="primary-button"
                onClick={() => navigate("/student/practice/question")}
              >
                Return to check answer <ArrowRight size={16} />
              </button>
            </div>
          )}
        </>
      ) : tool === "kiwi" ? (
        <KiwiChat
          key={question?.id || unitId}
          classId={classId}
          studentId={studentId}
          unitId={question?.unitId || unitId}
          questionId={question?.id}
          question={question?.prompt || unit?.goal || ""}
          code={code}
          track={track}
        />
      ) : (
        <section className="panel work-panel focused-panel">
          {question ? (
            <>
              <p className="eyebrow">
                {questionLabels[question.type]} · {question.difficulty}/5 ·{" "}
                {question.source === "kiwi-ai" ? "Kiwi AI" : "Local template"}
              </p>
              <h2>{question.title}</h2>
              <p className="question-prompt">{question.prompt}</p>
              {question.code && (
                <pre className="question-code">{question.code}</pre>
              )}
              {question.type === "choice" ? (
                <div className="choices">
                  {question.choices?.map((c, i) => (
                    <button
                      className={`choice ${answer === c ? "selected" : ""}`}
                      key={i}
                      onClick={() => {
                        setAnswer(c);
                        setFeedback(null);
                      }}
                    >
                      <span>{String.fromCharCode(65 + i)}</span>
                      {c}
                    </button>
                  ))}
                </div>
              ) : question.type === "complete" ? (
                <>
                  <pre className="question-code">{question.starterCode}</pre>
                  <button
                    className="outline-button"
                    onClick={() => navigate("/student/practice/code")}
                  >
                    Complete in R workspace <ArrowRight size={16} />
                  </button>
                </>
              ) : (
                <input
                  className="answer-input"
                  aria-label="Your answer"
                  value={answer}
                  onChange={(e) => {
                    setAnswer(e.target.value);
                    setFeedback(null);
                  }}
                  placeholder="Enter your answer"
                />
              )}
              {feedback !== null && (
                <div
                  role="status"
                  className={`feedback ${feedback ? "correct" : "incorrect"}`}
                >
                  {feedback ? (
                    <>
                      <CheckCircle2 size={18} />
                      <span>Correct. {question.explanation}</span>
                    </>
                  ) : (
                    <span>
                      Try again. Inspect the code or ask Kiwi for a hint.
                    </span>
                  )}
                </div>
              )}
              <div className="work-actions">
                <button
                  className="primary-button"
                  disabled={
                    busy || (question.type !== "complete" && !answer.trim())
                  }
                  onClick={check}
                >
                  Check answer
                </button>
                <button
                  className="outline-button"
                  disabled={busy || !policy}
                  onClick={() => void create()}
                >
                  {busy ? "Generating…" : "Next exercise"}{" "}
                  <ArrowRight size={16} />
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <h2>Choose a chapter to get started</h2>
              <button
                className="primary-button"
                onClick={() => navigate("/student/practice/settings")}
              >
                Open practice settings
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
