import { useEffect, useRef, type ReactNode } from "react";
import { Download } from "lucide-react";
import { displayTimeZone, zoneLabel } from "../../lib/format";
import { LABELS, pluralize, questionTypeLabel, STUDENT_LABELS } from "../../lib/labels";
import type { FileMeta, InClassCheckResult, StudentAssignment, StudentSubmission, WorkQuestion } from "../../types";

/*
 * "Answer & submit" tab (ASSESS) — pure view. In-class exercises check one question at a time (hints, attempts left,
 * revealed answer); homework submits every answer once and shows "Waiting for teacher" until grades are released,
 * then the total, the feedback and per-question comments [NM16, DA07].
 */

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const MINUS = "\u2212";

/** "Fri 10/24, 11:59 PM GMT+8" in the course time zone (review 2, TEACHER-02), or a given zone. */
export function formatStudentDate(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "";
  const zone = timeZone ?? displayTimeZone();
  const day = date.toLocaleDateString("en-US", { weekday: "short", month: "2-digit", day: "2-digit", timeZone: zone }).replace(",", "");
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: zone });
  return `${day}, ${time} ${zoneLabel(zone, iso)}`;
}

/** "−10% of the points per day late; each started day counts as a full day" (empty without a penalty, S-M04). */
export function penaltyText(pctPerDay: number | null | undefined): string {
  return pctPerDay && pctPerDay > 0 ? `${MINUS}${fmt(pctPerDay)}% of the points per day late; ${STARTED_DAY_RULE}` : "";
}
/** S-M04: the server counts every started day late as a full day (``ceil(lateHours / 24)``). */
export const STARTED_DAY_RULE = "each started day counts as a full day";

/** "25 min", "24 h 57 min", "2 d 20 h" — how late a submission was. */
export function lateDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/**
 * The adjustment line of a released grade (RV6-M01): "Late penalty: −6 points (3 days late × 10% per day)", so the
 * question scores and the total add up. Empty when there is no adjustment.
 */
export function adjustmentText(adjustment: StudentSubmission["adjustment"], lateSeconds: number, pctPerDay: number | null | undefined): string {
  if (!adjustment || !adjustment.points) return "";
  const amount = `${adjustment.points < 0 ? MINUS : "+"}${fmt(Math.abs(adjustment.points))} ${Math.abs(adjustment.points) === 1 ? "point" : "points"}`;
  if (adjustment.reason === "Late penalty (auto)") {
    // S-M04: say how late the submission was and that every started day counts, so 25 h reading as 2 days is no surprise
    const days = Math.max(1, Math.ceil(lateSeconds / 86400));
    const rate = pctPerDay && pctPerDay > 0 ? ` × ${fmt(pctPerDay)}% per day` : "";
    const counted = `${days} ${days === 1 ? "day" : "days"}`;
    return lateSeconds > 0
      ? `Late penalty: ${amount} (submitted ${lateDuration(lateSeconds)} late, counted as ${counted}${rate}; ${STARTED_DAY_RULE})`
      : `Late penalty: ${amount} (${counted} late${rate})`;
  }
  return `${adjustment.reason || "Adjustment"}: ${amount}`;
}

/** S-m10: "Download data.csv (for Question 1)" when a file belongs to one question. */
export function fileButtonLabel(file: Pick<FileMeta, "name" | "questionId">, questions: readonly Pick<WorkQuestion, "id">[]): string {
  const index = file.questionId ? questions.findIndex((q) => q.id === file.questionId) : -1;
  return index >= 0 ? `Download ${file.name} (for Question ${index + 1})` : `Download ${file.name}`;
}

/** Warning next to Submit once the due date has passed (RV6-m19). */
export function lateSubmitWarning(work: Pick<StudentAssignment, "kind" | "state" | "latePolicy">): string {
  if (work.kind !== "homework" || work.state !== "past_due") return "";
  const penalty = penaltyText(work.latePolicy.penaltyPctPerDay);
  return `The due date has passed: this submission will be marked late${penalty ? ` (${penalty})` : ""}.`;
}

export function feedbackText(result: InClassCheckResult): string {
  if (result.correct === null) return result.explanation ? `Answer recorded. ${result.explanation}` : "Answer recorded.";
  return result.correct ? "Correct." : "Not quite — try again.";
}

export function attemptsText(result: InClassCheckResult): string {
  if (result.attemptsLeft === null) return "";
  if (result.attemptsLeft === 0) return "No attempts left for this question.";
  return `${result.attemptsLeft} ${result.attemptsLeft === 1 ? "attempt" : "attempts"} left.`;
}

export function SubmissionHistory({ submissions, questions, penaltyPctPerDay, timeZone }: {
  submissions: StudentSubmission[]; questions: WorkQuestion[]; penaltyPctPerDay?: number; timeZone?: string;
}) {
  if (!submissions.length) return <p>No submissions yet. Complete every question to submit.</p>;
  return (
    <ol className="assess-submissions">
      {submissions.map((s) => (
        <li key={s.id}>
          <p>
            {/* RV6-m05: the course time zone, like the due date */}
            <strong>Attempt {s.attempt}</strong> · {formatStudentDate(s.submittedAt, timeZone)}
            {s.isLate && <span className="assess-late"> · Late</span>}
          </p>
          {s.status === "released" && s.grade !== null ? (
            <div className="assess-released">
              <p><strong>{fmt(s.grade)} / {fmt(s.maxPoints)} points</strong></p>
              {s.feedback && <p className="work-instructions">{s.feedback}</p>}
              {s.items && (
                <ul>
                  {questions.map((q, i) => {
                    const item = s.items?.[q.id];
                    if (!item || (item.score === null && !item.comment)) return null;
                    return (
                      <li key={q.id}>
                        Q{i + 1}{item.score !== null ? ` · ${fmt(item.score)}/${fmt(q.points)}` : ""}{item.comment ? ` — ${item.comment}` : ""}
                      </li>
                    );
                  })}
                </ul>
              )}
              {adjustmentText(s.adjustment, s.lateSeconds ?? 0, penaltyPctPerDay) && (
                <p className="assess-adjustment">{adjustmentText(s.adjustment, s.lateSeconds ?? 0, penaltyPctPerDay)}</p>
              )}
            </div>
          ) : (
            <p className="muted">{STUDENT_LABELS.waitingForTeacher}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

export function AnswerPanel({
  work,
  question,
  answers,
  feedback,
  hints,
  answered,
  busy,
  submissions,
  savedLabel,
  submitBlocked,
  onAnswer,
  onCheck,
  onSubmit,
  onOpenQuestion,
  onDownload,
  refusal = "",
  refusalLink = null,
}: {
  work: StudentAssignment;
  question: WorkQuestion;
  answers: Record<string, string>;
  feedback: InClassCheckResult | null;
  /** Teacher hints revealed so far for this question (one per wrong in-class attempt). */
  hints: string[];
  answered: number;
  busy: boolean;
  submissions: StudentSubmission[];
  savedLabel: string;
  /** Why submitting/checking is not possible right now ("" when it is). */
  submitBlocked: string;
  onAnswer: (value: string) => void;
  onCheck: () => void;
  onSubmit: () => void;
  onOpenQuestion: (questionId: string) => void;
  onDownload: (file: FileMeta) => void;
  /** B-m03: the server refused the submit (closed, not open, attempts used): an alert next to Submit, focused once */
  refusal?: string;
  /** B-m03: where to go instead (the published revision), shown inside the alert */
  refusalLink?: ReactNode;
}) {
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // WHY: the refusal answers a click on Submit; moving focus here makes it the next thing read, near the button
    if (refusal) alertRef.current?.focus();
  }, [refusal]);
  const value = answers[question.id] || "";
  const files = work.files.filter((f) => !f.questionId || f.questionId === question.id);
  const instructions = (work.instructions || "").trim();
  const lateWarning = lateSubmitWarning(work);
  return (
    <section className="panel work-panel focused-panel">
      {/* RV6-m19: no empty "Assignment instructions" block when the teacher wrote none and attached nothing */}
      {(instructions || files.length > 0) && (
        <details className="assignment-instructions">
          <summary>{instructions ? `Assignment instructions${files.length ? " & files" : ""}` : "Files"}</summary>
          {instructions && <p className="work-instructions">{instructions}</p>}
          {files.map((file) => (
            <button key={file.id} type="button" className="outline-button" onClick={() => onDownload(file)}>
              <Download size={15} /> {fileButtonLabel(file, work.questions)}
            </button>
          ))}
        </details>
      )}
      {/* RT-06: in-class exercises are not graded, so they show no points */}
      <p className="question-meta">{questionTypeLabel(question.type)} · {work.kind === "practice" ? LABELS.notGraded : pluralize(question.points, "point")}</p>
      <h2 className="work-prompt">{question.prompt}</h2>
      {question.starterCode && <pre className="question-code">{question.starterCode}</pre>}
      {question.type === "choice" ? (
        <div className="choices" role="radiogroup" aria-label="Answer choices">
          {question.choices.map((c, i) => (
            <button key={i} type="button" role="radio" aria-checked={value === c} className={`choice ${value === c ? "selected" : ""}`} onClick={() => onAnswer(c)}>
              <span>{String.fromCharCode(65 + i)}</span>
              {c}
            </button>
          ))}
        </div>
      ) : question.type === "fill" || question.type === "predict" ? (
        <input className="answer-input" aria-label="Current question answer" value={value} onChange={(e) => onAnswer(e.target.value)} placeholder="Enter your answer" />
      ) : (
        <textarea rows={6} className={question.type === "complete" ? "work-answer mono" : "work-answer"} aria-label="Current question answer" value={value}
          onChange={(e) => onAnswer(e.target.value)} spellCheck={question.type === "complete" ? false : undefined}
          placeholder={question.type === "complete" ? "Write your completed code (run it in the R workspace first)" : "Write your answer"} />
      )}
      {feedback && (
        <div role="status" className={`feedback ${feedback.correct === null ? "" : feedback.correct ? "correct" : "incorrect"}`}>
          <p>{feedbackText(feedback)} {feedback.correct && feedback.explanation ? feedback.explanation : ""}</p>
          {attemptsText(feedback) && <p className="muted">{attemptsText(feedback)}</p>}
          {feedback.revealedAnswer && <p>Answer: <code>{feedback.revealedAnswer}</code></p>}
        </div>
      )}
      {work.kind === "practice" && hints.length > 0 && (
        <div className="hint-box">
          {hints.map((hint, i) => (
            <p key={i}><strong>Hint {i + 1}:</strong> {hint}</p>
          ))}
        </div>
      )}
      {question.studentExplanation && <p className="assess-explanation">{question.studentExplanation}</p>}
      <div className="work-actions">
        {work.kind === "practice" ? (
          <button type="button" className="primary-button" disabled={busy || !value.trim() || Boolean(submitBlocked)} onClick={onCheck}>
            Check answer
          </button>
        ) : (
          <button type="button" className="primary-button" disabled={busy || answered !== work.questions.length || Boolean(submitBlocked)} onClick={onSubmit}>
            {busy ? "Submitting…" : "Submit assignment"}
          </button>
        )}
        <span className="muted" aria-live="polite">{refusal ? savedLabel : submitBlocked || savedLabel}</span>
      </div>
      {refusal && (
        <div className="assess-submit-alert" role="alert" tabIndex={-1} ref={alertRef}>
          <p>{refusal}</p>
          {refusalLink && <p>{refusalLink}</p>}
        </div>
      )}
      {lateWarning && !submitBlocked && <p className="assess-late-warning" role="note">{lateWarning}</p>}
      <div className="work-question-navigation">
        {work.questions.map((q, i) => {
          // RV6-m19: a filled dot means "answered"; a check mark read as "correct" after a wrong in-class answer
          const done = Boolean(answers[q.id]?.trim());
          return (
            <button key={q.id} type="button" className={question.id === q.id ? "primary-button" : "outline-button"} disabled={busy}
              aria-label={`Question ${i + 1}${done ? ", answered" : ""}`} onClick={() => onOpenQuestion(q.id)}>
              Q{i + 1}
              {done && <span className="question-answered-dot" aria-hidden="true"> ●</span>}
            </button>
          );
        })}
      </div>
      {work.kind === "homework" && (
        <div className="submission-status">
          <h3>Submissions &amp; feedback</h3>
          <SubmissionHistory submissions={submissions} questions={work.questions} penaltyPctPerDay={work.latePolicy.penaltyPctPerDay} />
        </div>
      )}
    </section>
  );
}
