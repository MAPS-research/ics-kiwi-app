import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Download, Plus } from "lucide-react";
import { api } from "./lib/api";
import { browserSession, navigate } from "./lib/navigation";
import { checkAnswer, generateQuestion } from "./lib/questions";
import { KiwiChat, RWorkbench, type Tracker } from "./LearningTools";
import { questionLabels } from "./Practice";
import type {
  Assignment,
  Course,
  Difficulty,
  GenerationPolicy,
  Question,
  Submission,
  WorkOption,
} from "./types";
import type { RunResult } from "./lib/rEngine";

export function StudentWork({
  classId,
  course,
  studentId,
  studentName,
  track,
  route,
}: {
  classId: string;
  course: Course;
  studentId: string;
  studentName: string;
  track: Tracker;
  route: string;
}) {
  const [works, setWorks] = useState<WorkOption[]>([]);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [submissions, setSubs] = useState<Submission[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    correct: boolean;
    explanation: string;
  } | null>(null);
  const [policy, setPolicy] = useState<GenerationPolicy | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>(2);
  const [similar, setSimilar] = useState<Question | null>(null);
  const [similarAnswer, setSimilarAnswer] = useState("");
  const [similarFeedback, setSimilarFeedback] = useState<boolean | null>(null);
  const [similarCode, setSimilarCode] = useState("");
  const [similarRun, setSimilarRun] = useState<
    (RunResult & { code: string }) | null
  >(null);
  const [run, setRun] = useState<(RunResult & { code: string }) | null>(null);
  const mounted = useRef(true);
  const refreshId = useRef(0);
  const url = new URL(route, location.origin);
  const parts = url.pathname.split("/");
  const workId = parts[3] || "";
  const tool = parts[4] || "answer";
  const work = assignment?.id === workId ? assignment : null;
  const question =
    work?.questions.find((q) => q.id === url.searchParams.get("q")) ||
    work?.questions[0];
  const draftKey = `kiwi-work-${classId}-${studentId}-${workId}`;
  const codeKey = `kiwi-code-${classId}-${studentId}-${workId}-${question?.id}`;
  const current = useRef({ workId, questionId: question?.id });
  current.current = { workId, questionId: question?.id };
  const refresh = useCallback(async () => {
    if (current.current.workId !== workId) return;
    const request = ++refreshId.current;
    const [w, s, detail] = await Promise.all([
      api.workOptions(classId),
      workId
        ? api.submissions(classId, studentId, undefined, workId)
        : Promise.resolve([]),
      workId ? api.workDetail(classId, workId) : Promise.resolve(null),
    ]);
    if (
      mounted.current &&
      request === refreshId.current &&
      current.current.workId === workId
    ) {
      setWorks(w);
      setSubs(s);
      setAssignment(detail);
    }
  }, [classId, studentId, workId]);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch((e) => setError(e.message));
    return () => {
      mounted.current = false;
      refreshId.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    try {
      setAnswers(JSON.parse(localStorage.getItem(draftKey) || "{}"));
    } catch {
      setAnswers({});
    }
    setMessage("");
    setError("");
  }, [draftKey]);
  useEffect(() => {
    setCode(localStorage.getItem(codeKey) ?? question?.starterCode ?? "");
    setRun(null);
    setFeedback(null);
    setSimilar(null);
    setError("");
  }, [codeKey, question?.starterCode]);
  useEffect(() => {
    if (!work) return;
    let active = true;
    setPolicy(null);
    void api
      .policy(classId, work.unitId)
      .then((p) => {
        if (active) {
          setPolicy(p);
          setDifficulty(p.defaultDifficulty);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [classId, work?.unitId]);
  useEffect(() => {
    if (work && question)
      void track(
        "question_viewed",
        {
          unitId: work.unitId,
          assignmentId: work.id,
          questionTitle: question.prompt,
        },
        question.id,
      );
  }, [work?.id, question?.id]);
  const open = (id: string, page = "answer", qid?: string) =>
    navigate(`/student/assignments/${id}/${page}${qid ? `?q=${qid}` : ""}`);
  const setAnswer = (value: string) => {
    if (!question) return;
    const next = { ...answers, [question.id]: value };
    setAnswers(next);
    localStorage.setItem(draftKey, JSON.stringify(next));
    setFeedback(null);
  };
  const taskTrack: Tracker = useCallback(
    (type, payload, qid) =>
      track(
        type,
        { ...payload, assignmentId: workId, unitId: work?.unitId },
        qid,
      ),
    [track, workId, work?.unitId],
  );
  const check = async () => {
    if (!work || !question || busy) return;
    setBusy(true);
    setError("");
    const snapshot = question.id;
    try {
      const result = await api.checkPractice(classId, work.id, {
        studentId,
        studentName,
        sessionId: browserSession,
        questionId: question.id,
        answer: answers[question.id] || "",
        runOutput:
          run?.ok && run.code === code && answers[question.id] === code
            ? run.output
            : undefined,
      });
      if (mounted.current && current.current.questionId === snapshot)
        setFeedback(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const submit = async () => {
    if (!work || busy) return;
    setBusy(true);
    setError("");
    try {
      const pendingKey = `kiwi-pending-submit-${classId}-${studentId}-${work.id}`;
      const snapshot = JSON.stringify(answers);
      let pending: { snapshot: string; requestId: string } | null = null;
      try {
        pending = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
      } catch {
        /* start a new request */
      }
      if (!pending || pending.snapshot !== snapshot)
        pending = { snapshot, requestId: `submit-${crypto.randomUUID()}` };
      sessionStorage.setItem(pendingKey, JSON.stringify(pending));
      const result = await api.submitWork(classId, work.id, {
        studentId,
        studentName,
        sessionId: browserSession,
        answers,
        requestId: pending.requestId,
      });
      sessionStorage.removeItem(pendingKey);
      if (mounted.current)
        setSubs((old) => [
          ...old.filter((s) => s.id !== result.id),
          {
            ...result,
            assignmentId: work.id,
            studentId,
            studentName,
            answers: { ...answers },
            grade: null,
            feedback: null,
            gradedAt: null,
          },
        ]);
      await taskTrack("work_submitted", {
        attempt: result.attempt,
        submissionId: result.id,
      });
      if (mounted.current)
        setMessage(
          `Submission ${result.attempt} received on ${new Date(result.submittedAt).toLocaleString("en-US")}. Your teacher’s grade will appear here.`,
        );
      await refresh().catch(() => {
        if (mounted.current)
          setError(
            "Your submission was received. Refresh the page to update the submission list.",
          );
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const similarQuestion = async () => {
    if (!work || !question || !policy || busy) return;
    setBusy(true);
    setError("");
    const snapshot = question.id;
    try {
      const preferred =
        question.type === "text" || question.type === "complete"
          ? "predict"
          : question.type;
      const type = policy.allowedTypes.includes(preferred)
        ? preferred
        : policy.allowedTypes[0];
      const q = await generateQuestion({
        classId,
        studentId,
        course,
        unitId: work.unitId,
        type,
        difficulty,
        sourceQuestion: `${question.prompt}\n${question.starterCode}`,
      });
      if (!mounted.current || current.current.questionId !== snapshot) return;
      setSimilar(q);
      setSimilarAnswer("");
      setSimilarFeedback(null);
      setSimilarCode(q.starterCode || q.code || "");
      setSimilarRun(null);
      await taskTrack(
        "similar_requested",
        {
          sourceQuestionId: question.id,
          generatedQuestionId: q.id,
          source: q.source,
        },
        question.id,
      );
      await taskTrack(
        "question_generated",
        {
          title: q.title,
          prompt: q.prompt,
          choices: q.choices || [],
          questionType: q.type,
          difficulty: q.difficulty,
          source: q.source,
        },
        q.id,
      );
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const download = async () => {
    if (!work) return;
    try {
      const file = await api.attachment(classId, work.id);
      const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
      const link = document.createElement("a");
      const href = URL.createObjectURL(new Blob([bytes], { type: file.type }));
      link.href = href;
      link.download = file.name;
      link.click();
      URL.revokeObjectURL(href);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const saved =
    work?.questions.filter((q) => answers[q.id]?.trim()).length || 0;
  const mine = submissions
    .filter((s) => s.assignmentId === workId)
    .sort((a, b) => b.attempt - a.attempt);
  return (
    <div className="student-content">
      <div className="page-intro">
        <div>
          <p className="eyebrow">PRACTICE & ASSIGNMENTS</p>
          <h1>
            {work ? work.title : "Your assigned work"}
            <span className="accent-dot">.</span>
          </h1>
          <p className="muted">
            {work
              ? `${course.units.find((u) => u.id === work.unitId)?.title || "Chapter"} · ${work.kind === "homework" ? "Homework" : "Class practice"} · ${work.questions.length} questions`
              : "Choose an assignment, then focus on one question at a time."}
          </p>
        </div>
        {work && (
          <button
            className="text-button"
            onClick={() => navigate("/student/assignments")}
          >
            <ArrowLeft size={16} /> All assigned work
          </button>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="work-message" role="status">
          {message}
        </p>
      )}
      {!workId ? (
        <div className="assignment-cards">
          {works.map((w) => (
            <a
              className="panel assignment-card"
              href={`/student/assignments/${w.id}/answer`}
              key={w.id}
              onClick={(e) => {
                e.preventDefault();
                open(w.id);
              }}
            >
              <div className="row-between">
                <span className="small-pill">
                  {w.kind === "homework" ? "Homework" : "Practice"}
                </span>
                <BookOpen size={19} />
              </div>
              <h2>{w.title}</h2>
              <p>
                {course.units.find((u) => u.id === w.unitId)?.title || w.unitId}
              </p>
              <small>
                {w.questionCount} questions
                {w.dueAt
                  ? ` · Due ${new Date(w.dueAt).toLocaleString("en-US")}`
                  : ""}
              </small>
              <span className="card-link">
                Open assignment <ArrowRight size={15} />
              </span>
            </a>
          ))}
          {works.length === 0 && (
            <section className="panel work-panel empty-state">
              Your teacher has not published any work yet.
            </section>
          )}
        </div>
      ) : work && question ? (
        <>
          <div className="question-context">
            <label>
              Question
              <select
                aria-label="Assignment question"
                value={question.id}
                disabled={busy}
                onChange={(e) => open(workId, tool, e.target.value)}
              >
                {work.questions.map((q, i) => (
                  <option key={q.id} value={q.id}>
                    Question {i + 1} · {q.prompt.slice(0, 85)}
                  </option>
                ))}
              </select>
            </label>
            <span>
              {saved} of {work.questions.length} answers saved
            </span>
          </div>
          <nav className="page-tabs" aria-label="Assignment pages">
            {[
              ["answer", "Answer & submit"],
              ["code", "R workspace"],
              ["kiwi", "Ask Kiwi"],
              ["similar", "Similar practice"],
            ].map(([id, label]) => (
              <a
                href={`/student/assignments/${workId}/${id}?q=${question.id}`}
                key={id}
                aria-current={tool === id ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  open(workId, id, question.id);
                }}
              >
                {label}
              </a>
            ))}
          </nav>
          {tool === "answer" ? (
            <section className="panel work-panel focused-panel">
              <details className="assignment-instructions">
                <summary>
                  Assignment instructions
                  {work.attachmentName ? " & attachment" : ""}
                </summary>
                <p className="work-instructions">
                  {work.instructions ||
                    "Complete all questions and submit your answers."}
                </p>
                {work.attachmentName && (
                  <button
                    className="outline-button"
                    onClick={() => void download()}
                  >
                    <Download size={15} /> Download {work.attachmentName}
                  </button>
                )}
              </details>
              <p className="eyebrow">
                {question.type === "text"
                  ? "Written response"
                  : questionLabels[question.type]}{" "}
                · {question.points} points
              </p>
              <h2 className="work-prompt">{question.prompt}</h2>
              {question.starterCode && (
                <pre className="question-code">{question.starterCode}</pre>
              )}
              {question.type === "choice" ? (
                <div className="choices">
                  {question.choices.map((c, i) => (
                    <button
                      key={i}
                      className={`choice ${answers[question.id] === c ? "selected" : ""}`}
                      onClick={() => setAnswer(c)}
                    >
                      <span>{String.fromCharCode(65 + i)}</span>
                      {c}
                    </button>
                  ))}
                </div>
              ) : question.type === "fill" || question.type === "predict" ? (
                <input
                  className="answer-input"
                  aria-label="Current question answer"
                  value={answers[question.id] || ""}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Enter your answer"
                />
              ) : (
                <textarea
                  rows={6}
                  className="work-answer"
                  aria-label="Current question answer"
                  value={answers[question.id] || ""}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Write your explanation or completed code"
                />
              )}
              {feedback && (
                <p
                  role="status"
                  className={`feedback ${feedback.correct ? "correct" : "incorrect"}`}
                >
                  {feedback.correct ? "Correct." : "Try again."}{" "}
                  {feedback.explanation}
                </p>
              )}
              <div className="work-actions">
                {work.kind === "practice" ? (
                  <button
                    className="primary-button"
                    disabled={busy || !answers[question.id]?.trim()}
                    onClick={() => void check()}
                  >
                    Check practice answer
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    disabled={busy || saved !== work.questions.length}
                    onClick={() => void submit()}
                  >
                    {busy ? "Submitting…" : "Submit assignment"}
                  </button>
                )}
                <span className="muted">
                  Answers are saved on this browser.
                </span>
              </div>
              <div className="work-question-navigation">
                {work.questions.map((q, i) => (
                  <button
                    key={q.id}
                    className={
                      question.id === q.id ? "primary-button" : "outline-button"
                    }
                    disabled={busy}
                    onClick={() => open(workId, "answer", q.id)}
                  >
                    Q{i + 1}
                    {answers[q.id]?.trim() ? " ✓" : ""}
                  </button>
                ))}
              </div>
              {work.kind === "homework" && (
                <div className="submission-status">
                  <h3>Submissions & feedback</h3>
                  <p className="muted">
                    Showing up to 100 latest submissions for this assignment.
                  </p>
                  {mine.length ? (
                    mine.map((s) => (
                      <p key={s.id}>
                        Attempt {s.attempt} ·{" "}
                        {new Date(s.submittedAt).toLocaleString("en-US")}
                        <br />
                        {s.grade !== null ? (
                          <>
                            <strong>
                              {s.grade} /{" "}
                              {work.questions.reduce((n, q) => n + q.points, 0)}{" "}
                              points
                            </strong>{" "}
                            · {s.feedback || "No written feedback."}
                          </>
                        ) : (
                          "Awaiting teacher review"
                        )}
                      </p>
                    ))
                  ) : (
                    <p>
                      No submissions yet. Complete every question to submit.
                    </p>
                  )}
                </div>
              )}
            </section>
          ) : tool === "code" ? (
            <>
              <p className="context-caption">{question.prompt}</p>
              <RWorkbench
                key={question.id}
                code={code}
                onCode={(v) => {
                  setCode(v);
                  setRun(null);
                }}
                onResult={setRun}
                track={taskTrack}
                questionId={question.id}
                metadata={{ questionTitle: question.prompt }}
                storageKey={codeKey}
              />
              <div className="work-actions">
                <button
                  className="primary-button"
                  onClick={() => {
                    setAnswer(code);
                    void taskTrack(
                      "work_answer_saved",
                      { length: code.length },
                      question.id,
                    );
                    open(workId, "answer", question.id);
                  }}
                >
                  Use code as answer <ArrowRight size={16} />
                </button>
              </div>
            </>
          ) : tool === "kiwi" ? (
            <KiwiChat
              key={question.id}
              classId={classId}
              studentId={studentId}
              unitId={work.unitId}
              assignmentId={work.id}
              questionId={question.id}
              question={question.prompt}
              code={code}
              track={taskTrack}
            />
          ) : (
            <section className="panel work-panel focused-panel">
              <p className="eyebrow">SIMILAR PRACTICE</p>
              <h2>Try the idea with new data</h2>
              <p className="muted">
                These exercises help you practice. They do not change your
                assignment answers.
              </p>
              <div className="work-actions">
                <label>
                  Difficulty{" "}
                  <select
                    aria-label="Similar question difficulty"
                    value={difficulty}
                    disabled={busy || !policy}
                    onChange={(e) =>
                      setDifficulty(Number(e.target.value) as Difficulty)
                    }
                  >
                    {[1, 2, 3, 4, 5]
                      .filter(
                        (d) =>
                          policy &&
                          d >= policy.minDifficulty &&
                          d <= policy.maxDifficulty,
                      )
                      .map((d) => (
                        <option key={d} value={d}>
                          {d}/5
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className="primary-button"
                  disabled={busy || !policy}
                  onClick={() => void similarQuestion()}
                >
                  <Plus size={16} />
                  {busy
                    ? "Generating…"
                    : similar
                      ? "Next similar exercise"
                      : "Generate similar exercise"}
                </button>
              </div>
              {similar && (
                <div className="similar-card">
                  <p className="eyebrow">
                    {similar.source === "kiwi-ai"
                      ? "Kiwi AI"
                      : "Local template"}
                  </p>
                  <h2>{similar.title}</h2>
                  <p>{similar.prompt}</p>
                  {similar.code && (
                    <pre className="question-code">{similar.code}</pre>
                  )}
                  {similar.type === "choice" ? (
                    <div className="choices">
                      {similar.choices?.map((c, i) => (
                        <button
                          key={i}
                          className={`choice ${similarAnswer === c ? "selected" : ""}`}
                          onClick={() => {
                            setSimilarAnswer(c);
                            setSimilarFeedback(null);
                          }}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  ) : similar.type === "complete" ? (
                    <RWorkbench
                      code={similarCode}
                      onCode={(v) => {
                        setSimilarCode(v);
                        setSimilarRun(null);
                      }}
                      onResult={setSimilarRun}
                      track={taskTrack}
                      questionId={similar.id}
                      metadata={{ questionTitle: similar.title }}
                      storageKey={`${codeKey}-similar`}
                    />
                  ) : (
                    <input
                      aria-label="Similar question answer"
                      value={similarAnswer}
                      onChange={(e) => {
                        setSimilarAnswer(e.target.value);
                        setSimilarFeedback(null);
                      }}
                    />
                  )}
                  <div className="work-actions">
                    <button
                      className="primary-button"
                      disabled={
                        similar.type === "complete"
                          ? !(similarRun?.ok && similarRun.code === similarCode)
                          : !similarAnswer.trim()
                      }
                      onClick={() => {
                        const correct = checkAnswer(
                          similar,
                          similarAnswer,
                          similarRun?.output,
                        );
                        setSimilarFeedback(correct);
                        void taskTrack(
                          "answer_submitted",
                          {
                            title: similar.title,
                            answer:
                              similar.type === "complete"
                                ? similarCode
                                : similarAnswer,
                            correct,
                            questionType: similar.type,
                          },
                          similar.id,
                        );
                      }}
                    >
                      Check similar answer
                    </button>
                  </div>
                  {similarFeedback !== null && (
                    <p
                      role="status"
                      className={`feedback ${similarFeedback ? "correct" : "incorrect"}`}
                    >
                      {similarFeedback
                        ? `Correct. ${similar.explanation}`
                        : "Try again. Check the code and your reasoning."}
                    </p>
                  )}
                </div>
              )}
            </section>
          )}
        </>
      ) : (
        <section className="panel work-panel empty-state">
          {works.length
            ? "This assignment is unavailable. Return to your assigned work."
            : "Loading assignment…"}
        </section>
      )}
    </div>
  );
}
