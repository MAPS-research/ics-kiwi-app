import { StatusBadge } from "../../components/StatusBadge";
import { gradeStateLabel, pluralize } from "../../lib/labels";
import type { GradingQueue, WorkQuestion } from "../../types";
import { commentFieldLabel, fmtPoints, parseScore } from "./gradingKeys";
import { referenceText } from "./GradingCard";

/*
 * By question view (GRADE; TH05): one question across the latest submissions, identical normalized answers grouped,
 * with "Apply score to group". Pure view; the container saves each submission of the group as a draft.
 * S-B01: each group names its students with the grade state of their attempt, and released grades are never part of
 * "Apply score to group" (the container sends `keepReleased`, the server refuses to withdraw a released grade).
 */

export type QuestionGroup = NonNullable<GradingQueue["groups"]>[number];
export type GroupMember = NonNullable<QuestionGroup["members"]>[number];
export interface GroupValue { score: string; comment: string }

/** "12 students" — the answer itself is shown below as code (S-m05: line breaks are kept). */
export function groupHeading(count: number, sampleAnswer: string): string {
  return `${pluralize(count, "student")} · ${sampleAnswer.trim() || "(no answer)"}`;
}
/** Accessible name of a group's score input (LY06); `groupIndex` (1-based) keeps groups of equal size apart (S-m05). */
export function groupScoreLabel(count: number, questionIndex: number, groupIndex?: number): string {
  const which = groupIndex ? `answer group ${groupIndex} (${pluralize(count, "student")})` : `${pluralize(count, "student")} with this answer`;
  return `Score for ${which}, question ${questionIndex}`;
}
export function groupKey(group: Pick<QuestionGroup, "normalizedAnswer">): string {
  return group.normalizedAnswer || "(blank)";
}
/** Members that "Apply score to group" writes to: never a released grade (S-B01). */
export function applicableMembers(group: Pick<QuestionGroup, "members" | "submissionIds">): string[] {
  if (!group.members) return [...group.submissionIds];
  return group.members.filter((m) => m.gradeStatus !== "released").map((m) => m.submissionId);
}
/** "Ada Chen · Attempt 1 · Released 16/20" (older attempts are marked). */
export function memberLine(member: GroupMember): string {
  const state = gradeStateLabel(member.gradeStatus, member.grade, member.maxPoints ?? 0);
  return `${member.studentLabel} · Attempt ${member.attempt}${member.latest ? "" : " (older attempt)"} · ${state}`;
}
/** The value shown in a group's inputs: what the teacher typed, else the auto-check score (S-m05). */
export function groupValue(values: Record<string, GroupValue>, group: QuestionGroup): GroupValue {
  const typed = values[groupKey(group)];
  if (typed) return typed;
  return { score: group.autoScore === null || group.autoScore === undefined ? "" : String(group.autoScore), comment: "" };
}
/** "Apply to 2 submissions" (released grades excluded). */
export function applyLabel(count: number): string {
  return count ? `Apply to ${pluralize(count, "submission")}` : "Nothing to apply (all released)";
}
export function releasedNote(released: number): string {
  if (!released) return "";
  return `${released === 1 ? "1 released grade stays" : `${released} released grades stay`} as released. To change one, unrelease it on its card first.`;
}

export function ByQuestionView({ question, questionIndex, groups, values, busy, status, onChange, onApply }: {
  question: WorkQuestion;
  questionIndex: number;
  groups: readonly QuestionGroup[];
  values: Record<string, GroupValue>;
  busy: boolean;
  status?: string;
  onChange: (key: string, value: GroupValue) => void;
  onApply: (group: QuestionGroup, value: { score: number; comment: string }) => void;
}) {
  return (
    <section className="by-question" aria-label={`Question ${questionIndex} grouped by answer`}>
      <header className="by-question-header">
        <h2>
          Q{questionIndex} · {fmtPoints(question.points)} points
        </h2>
        <p>{question.prompt}</p>
        <details>
          <summary>Reference answer and rubric</summary>
          <pre>{referenceText(question)}</pre>
          {question.graderRubric && <p>Rubric (staff only): {question.graderRubric}</p>}
        </details>
      </header>
      {status && (
        <p className="work-message" role="status">
          {status}
        </p>
      )}
      {!groups.length && <p className="muted">No submissions match these filters.</p>}
      <ul className="by-question-groups">
        {groups.map((group, index) => {
          const key = groupKey(group);
          const value = groupValue(values, group);
          const parsed = parseScore(value.score, question.points);
          const count = group.submissionIds.length;
          const targets = applicableMembers(group);
          const released = count - targets.length;
          const groupNumber = index + 1;
          return (
            <li key={key} className="by-question-group">
              <div className="row-between">
                <strong>{pluralize(count, "student")}</strong>
                {group.autoCorrect !== null && (
                  <StatusBadge tone={group.autoCorrect ? "success" : "neutral"}>{group.autoCorrect ? "Auto-checked ✓" : "Auto-checked ✗"}</StatusBadge>
                )}
              </div>
              <pre className="by-question-answer"><code>{group.sampleAnswer.trim() || "(no answer)"}</code></pre>
              {group.members && group.members.length > 0 && (
                <ul className="by-question-members" aria-label={`Students in answer group ${groupNumber}`}>
                  {group.members.map((m) => (
                    <li key={m.submissionId} className={m.gradeStatus === "released" ? "by-question-member-released" : undefined}>
                      {memberLine(m)}
                    </li>
                  ))}
                </ul>
              )}
              {released > 0 && <p className="by-question-released-note">{releasedNote(released)}</p>}
              <div className="grading-score-row">
                <label className="grading-points">
                  Points
                  <span className="grading-points-input">
                    <input type="number" min={0} max={question.points} step="any" aria-label={groupScoreLabel(count, questionIndex, groupNumber)}
                      value={value.score} onChange={(e) => onChange(key, { ...value, score: e.target.value })} />
                    <span aria-hidden="true">/ {fmtPoints(question.points)}</span>
                  </span>
                  {parsed.error && <small className="error-text">{parsed.error}</small>}
                </label>
                <label className="grading-comment">
                  {commentFieldLabel(questionIndex)}
                  <textarea rows={2} aria-label={`${commentFieldLabel(questionIndex)} for answer group ${groupNumber} (${pluralize(count, "student")})`}
                    value={value.comment} onChange={(e) => onChange(key, { ...value, comment: e.target.value })} />
                </label>
                <button type="button" className="outline-button" disabled={busy || !targets.length || parsed.value === null || Boolean(parsed.error)}
                  aria-label={`${applyLabel(targets.length)} in answer group ${groupNumber}`}
                  onClick={() => parsed.value !== null && onApply(group, { score: parsed.value, comment: value.comment })}>
                  {applyLabel(targets.length)}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
