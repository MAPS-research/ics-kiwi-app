import { ArrowRight } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import { StatusBadge, gradeStatusTone } from "../../components/StatusBadge";
import { displayTimeZone, zoneLabel } from "../../lib/format";
import { gradeStateLabel, LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import type { ItemResult, SubmissionDetail, WorkQuestion } from "../../types";
import {
  adjustmentLine, askKiwiLine, cardActions, cardControlLabel, cardLabel, cardStatus, commentFieldLabel, commentInputLabel, draftErrors, draftTotal,
  feedbackInputLabel, firstOpenQuestion, fmtPoints, gradedByLine, historyLine, isSaveAndNextShortcut, isTotalOnly, primaryAction,
  questionBadge, releaseHint, removedPenalty, scoreInputLabel, TOTAL_ONLY_LABEL, type CardDraft,
} from "./gradingKeys";

/*
 * One grading card (GRADE; F04, TH05, NM14–NM16, NM25, LY06). Pure view: the container (ToGradePage) owns loading and
 * saving. Keeps the v0.5.1 answer-vs-reference layout with a link to the work process (KEEP).
 * SB-m06: every control names its card (student, homework, attempt) after its visible text, so a queue with two cards of
 * one student never repeats an accessible name.
 */

export interface GradingCardViewProps {
  detail: SubmissionDetail;
  draft: CardDraft;
  canRelease: boolean;
  canUnrelease: boolean;
  busy: boolean;
  timeZone?: string;
  error?: string;
  status?: string;
  onChange: (draft: CardDraft) => void;
  onSave: (action: "save" | "release", next: boolean) => void;
  onUnrelease?: () => void;
}

export const RELEASED_LOCKED_NOTE = "This grade is released. Ask an instructor to unrelease it before you change it.";
export const RELEASED_DRAFT_NOTE = "This grade is released. Saving a draft withdraws it from the student until you release it again.";

/** "10/21 22:58 GMT+8" in the course zone (review 2, TEACHER-02: the same zone as the due date in the list). */
export function submittedLine(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "";
  const zone = timeZone ?? displayTimeZone();
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date))
    parts[part.type] = part.value;
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute} ${zoneLabel(zone, iso)}`;
}

/** Reference text shown next to the student's answer; the rubric is shown separately. */
export function referenceText(question: WorkQuestion): string {
  const parts: string[] = [];
  if (question.answer) parts.push(question.answer);
  if (question.referenceCode) parts.push(`Reference solution code:\n${question.referenceCode}`);
  if (question.expectedOutput) parts.push(`Expected output:\n${question.expectedOutput}`);
  if (question.acceptedAnswers?.length) parts.push(`Also accepted: ${question.acceptedAnswers.join(" · ")}`);
  return parts.join("\n\n") || "No reference answer. Use the rubric.";
}

/** S-m06: the grading card of an earlier attempt of the same student and homework. */
export function earlierAttemptHref(detail: Pick<SubmissionDetail, "submission">, submissionId: string): string {
  return teacherPaths.grading({ assignmentId: detail.submission.assignmentId, studentId: detail.submission.studentId, submissionId, show: "all" });
}

function go(href: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    navigate(href);
  };
}

function QuestionBlock({ question, item, index, detail, draft, error, open, locked, onChange }: {
  question: WorkQuestion; item: ItemResult; index: number; detail: SubmissionDetail; draft: CardDraft; error?: string; open: boolean;
  /** SB-m03: a released grade the grader may not change has read-only inputs */
  locked: boolean;
  onChange: (draft: CardDraft) => void;
}) {
  const who = { studentLabel: detail.studentLabel, assignmentTitle: detail.assignment.title, attempt: detail.submission.attempt, questionIndex: index };
  const value = draft.items[question.id] ?? { score: "", comment: "" };
  const set = (next: Partial<{ score: string; comment: string }>) =>
    onChange({ ...draft, items: { ...draft.items, [question.id]: { ...value, ...next } } });
  const answer = detail.submission.answers[question.id];
  const badge = questionBadge(item);
  return (
    <details className="grading-question" open={open}>
      <summary aria-label={cardControlLabel(
        `Q${index} · ${fmtPoints(item.points)} ${item.points === 1 ? "point" : "points"} · ${badge.label}${item.overridden ? " · Overridden" : ""}`, who)}>
        <span className="grading-question-title">
          Q{index} · {fmtPoints(item.points)} {item.points === 1 ? "point" : "points"}
        </span>
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        {item.overridden && <StatusBadge tone="info">Overridden</StatusBadge>}
      </summary>
      <p className="grading-prompt">{question.prompt}</p>
      <div className="grading-compare">
        <div>
          <strong>Student answer</strong>
          <pre>{answer || "No answer"}</pre>
        </div>
        <div>
          <strong>Reference answer</strong>
          <pre>{referenceText(question)}</pre>
        </div>
      </div>
      {question.graderRubric && (
        <div className="grading-rubric">
          <strong>Rubric (staff only)</strong>
          <p>{question.graderRubric}</p>
        </div>
      )}
      <div className="grading-score-row">
        <label className="grading-points">
          Points
          <span className="grading-points-input">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={item.points}
              step="any"
              aria-label={scoreInputLabel(who)}
              aria-invalid={error ? true : undefined}
              value={value.score}
              readOnly={locked}
              onChange={(e) => set({ score: e.target.value })}
            />
            <span aria-hidden="true">/ {fmtPoints(item.points)}</span>
          </span>
          {error && <small className="error-text">{error}</small>}
        </label>
        <label className="grading-comment">
          {commentFieldLabel(index)}
          <textarea rows={2} aria-label={commentInputLabel(who)} value={value.comment} readOnly={locked} onChange={(e) => set({ comment: e.target.value })} />
        </label>
      </div>
    </details>
  );
}

export function GradingCardView({ detail, draft, canRelease, canUnrelease, busy, timeZone, error, status, onChange, onSave, onUnrelease }: GradingCardViewProps) {
  const who = { studentLabel: detail.studentLabel, assignmentTitle: detail.assignment.title, attempt: detail.submission.attempt };
  const state = cardStatus(detail);
  const primary = primaryAction(detail.assignment.gradesVisibility, canRelease);
  const total = draftTotal(draft, detail);
  const errors = draftErrors(draft, detail);
  const invalid = Object.keys(errors).length > 0;
  const openId = firstOpenQuestion(detail.items);
  const adjustment = adjustmentLine(draft.adjustment,
    detail.late ? { lateSeconds: detail.submission.lateSeconds ?? 0, penaltyPctPerDay: detail.late.penaltyPctPerDay } : null);
  const graded = gradedByLine(detail.history, timeZone, detail.submission.gradeStatus);
  const badgeFlags = detail.flags.filter((f) => f.kind === "late" || f.kind === "over_time" || f.kind === "newer_attempt");
  const evidenceFlags = detail.flags.filter((f) => !badgeFlags.includes(f));
  const released = detail.submission.gradeStatus === "released";
  // review 2 (CORRECTNESS-01): saving a draft would withdraw a released grade; only roles that release grades may do that
  const locked = released && !canRelease;
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!isSaveAndNextShortcut(e) || busy || invalid || locked) return;
    e.preventDefault();
    onSave(primary, true);
  };
  return (
    <article className="grading-card" aria-label={cardLabel(who)} onKeyDown={onKeyDown}>
      <header className="grading-card-header">
        <div>
          <h2 className="grading-card-title">
            {detail.studentLabel} · {detail.assignment.title}
          </h2>
          <p className="muted">
            Attempt {detail.submission.attempt} · Submitted {submittedLine(detail.submission.submittedAt, timeZone)}
            {detail.submission.isPreview ? " · Preview submission" : ""}
          </p>
        </div>
        <div className="grading-badges">
          <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
          {badgeFlags.map((flag) =>
            flag.href ? (
              <a key={flag.kind} className="grading-flag-link" href={flag.href} onClick={go(flag.href)} aria-label={cardControlLabel(flag.text, who)}>
                <StatusBadge tone="warning">{flag.text}</StatusBadge>
              </a>
            ) : (
              <StatusBadge key={flag.kind} tone="warning">
                {flag.text}
              </StatusBadge>
            ),
          )}
        </div>
      </header>
      <p className="grading-process">
        <span>{askKiwiLine(detail.process)}</span>
        <a className="text-button" href={detail.process.timelineUrl} onClick={go(detail.process.timelineUrl)} aria-label={cardControlLabel(LABELS.seeWorkProcess, who)}>
          {LABELS.seeWorkProcess} <ArrowRight size={15} aria-hidden="true" />
        </a>
      </p>
      {evidenceFlags.length > 0 && (
        <ul className="grading-flags" aria-label="Review prompts (not penalties)">
          {evidenceFlags.map((flag) => (
            <li key={flag.kind}>
              {flag.href ? (
                <a href={flag.href} onClick={go(flag.href)} aria-label={cardControlLabel(flag.text, who)}>
                  {flag.text}
                </a>
              ) : (
                flag.text
              )}
            </li>
          ))}
        </ul>
      )}
      {isTotalOnly(detail) && <p className="muted">{TOTAL_ONLY_LABEL}</p>}
      {detail.assignment.questions.map((question, i) => {
        const item = detail.items.find((it) => it.questionId === question.id);
        if (!item) return null;
        return (
          <QuestionBlock
            key={question.id}
            question={question}
            item={item}
            index={i + 1}
            detail={detail}
            draft={draft}
            error={errors[question.id]}
            open={openId === question.id}
            locked={locked}
            onChange={onChange}
          />
        );
      })}
      <div className="grading-footer">
        <p className="grading-total">
          Total <strong>{total === null ? "–" : fmtPoints(total)}</strong> / {fmtPoints(detail.maxPoints)}
          {total === null && <span className="muted"> · score every question to save a draft</span>}
        </p>
        {adjustment && (
          <p className="grading-adjustment">
            {adjustment}{" "}
            <button type="button" className="text-button" disabled={busy || locked} aria-label={cardControlLabel(`Remove ${adjustment}`, who)}
              onClick={() => onChange({ ...draft, adjustment: removedPenalty() })}>
              Remove
            </button>
          </p>
        )}
        <label className="grading-feedback">
          {LABELS.feedbackToStudent}
          <textarea rows={3} aria-label={feedbackInputLabel(who)} value={draft.feedback} readOnly={locked}
            onChange={(e) => onChange({ ...draft, feedback: e.target.value })} />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {status && (
          <p className="work-message" role="status">
            {status}
          </p>
        )}
        {locked && (
          <p className="muted" role="note">
            {RELEASED_LOCKED_NOTE}
          </p>
        )}
        {released && !locked && <p className="muted">{RELEASED_DRAFT_NOTE}</p>}
        <div className="work-actions grading-actions">
          {cardActions(primary, canRelease).map((a) => (
            <button key={a.id} type="button" className={a.primary ? "primary-button" : "outline-button"}
              disabled={busy || invalid || (a.action === "release" ? total === null : locked)}
              title={a.next ? "Ctrl+Enter or ⌘+Enter" : undefined} aria-label={cardControlLabel(a.label, who)} onClick={() => onSave(a.action, a.next)}>
              {a.label}
            </button>
          ))}
          {released && canUnrelease && (
            <button type="button" className="text-button" disabled={busy || !onUnrelease} aria-label={cardControlLabel("Unrelease", who)} onClick={() => onUnrelease?.()}>
              Unrelease
            </button>
          )}
        </div>
        {!released && <p className="muted grading-release-hint">{releaseHint(primary, canRelease)}</p>}
      </div>
      {detail.earlierAttempts.length > 0 && (
        <details className="grading-earlier">
          <summary aria-label={cardControlLabel(`Earlier attempts (${detail.earlierAttempts.length})`, who)}>Earlier attempts ({detail.earlierAttempts.length})</summary>
          <ul>
            {detail.earlierAttempts.map((a) => {
              // S-m06: an earlier attempt opens on its own card
              const href = earlierAttemptHref(detail, a.id);
              return (
                <li key={a.id}>
                  <a href={href} onClick={go(href)} aria-label={`Attempt ${a.attempt} of ${detail.studentLabel}, ${detail.assignment.title}`}>Attempt {a.attempt}</a> ·{" "}
                  {submittedLine(a.submittedAt, timeZone)} ·{" "}
                  <StatusBadge tone={gradeStatusTone(a.gradeStatus)}>{gradeStateLabel(a.gradeStatus, a.grade, detail.maxPoints)}</StatusBadge>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {graded && (
        <details className="grading-history">
          <summary aria-label={cardControlLabel(`${graded} · History`, who)}>{graded} · History</summary>
          <ol>
            {detail.history.map((entry) => (
              <li key={entry.id}>{historyLine(entry, timeZone)}</li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}
