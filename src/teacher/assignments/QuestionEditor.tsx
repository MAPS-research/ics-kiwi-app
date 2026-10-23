import { useState } from "react";
import { Trash2 } from "lucide-react";
import { LABELS, questionTypeLabel } from "../../lib/labels";
import { fieldLabel, GRADING_DEFAULT, parseChoices, parseLines, parseTags, QUESTION_TYPE_OPTIONS, questionHeading, withQuestionType } from "./assignmentRules";
import type { AssignmentKind, CheckResult, GradingSettings, WorkQuestion, WorkQuestionType } from "../../types";

/*
 * One question in the editor (§9.1 Questions) — a pure view with local text state for list fields, so typing
 * an empty line or a trailing comma is not undone. `locked` (attempts exist) keeps only the staff-only rubric and
 * tags editable [TR07].
 */

const REASONS: Readonly<Record<string, string>> = {
  exact: "matches the reference", accepted: "matches an accepted answer", numeric_tolerance: "matches within the numeric tolerance",
  choice: "is the correct choice", output_match: "the output matches", case_mismatch: "differs only in upper/lower case",
  mismatch: "does not match", not_gradable: "is not auto-checked (needs a run or a person)", no_reference: "has no reference answer yet",
};
export function checkResultText(result: CheckResult): string {
  const verdict = result.correct === null ? "Not auto-checked" : result.correct ? "Correct" : "Not correct";
  // RV6-m03: a Complete code check compares the run's output, so it is about "the output", not "the answer"
  const subject = result.basis === "client_run_output" ? "the output" : "the answer";
  const reason = result.reason === "output_match" ? "matches the expected output" : REASONS[result.reason] ?? result.reason;
  return `${verdict} — ${subject} ${reason}.`;
}

export interface QuestionEditorProps {
  index: number;
  question: WorkQuestion;
  kind: AssignmentKind;
  locked: boolean;
  readOnly: boolean;
  canRemove: boolean;
  onChange: (question: WorkQuestion) => void;
  onRemove: () => void;
  /** `runOutput`: for Complete code, what the student's run printed (the auto-check compares output, RV6-m03) */
  onTryCheck?: (question: WorkQuestion, answer: string, runOutput?: string) => Promise<CheckResult>;
}

export function QuestionEditor({ index, question: q, kind, locked, readOnly, canRemove, onChange, onRemove, onTryCheck }: QuestionEditorProps) {
  const [choicesText, setChoicesText] = useState(() => q.choices.join("\n"));
  const [acceptedText, setAcceptedText] = useState(() => (q.acceptedAnswers ?? []).join("\n"));
  const [tagsText, setTagsText] = useState(() => (q.tags ?? []).join(", "));
  const [tryAnswer, setTryAnswer] = useState("");
  const [tryResult, setTryResult] = useState("");
  const set = (values: Partial<WorkQuestion>) => onChange({ ...q, ...values });
  const grading: GradingSettings = { ...GRADING_DEFAULT, autoCheck: q.type !== "text", ...(q.grading ?? {}) };
  const setGrading = (values: Partial<GradingSettings>) => set({ grading: { ...grading, ...values } });
  const frozen = readOnly || locked;
  const choiceError = q.type === "choice" ? parseChoices(choicesText).error : null;
  const tagError = parseTags(tagsText).error;
  const autoCheckable = q.type !== "text" && q.type !== "choice";
  const hints = [...(q.hints ?? []), "", "", ""].slice(0, 3);
  const id = (name: string) => `q${index}-${name}`;
  const tryCheck = async () => {
    if (!onTryCheck) return;
    setTryResult("Checking…");
    try {
      // RV6-m03: Complete code is checked on the output of a run, so the typed text is treated as that output
      const result = q.type === "complete" ? await onTryCheck(q, q.referenceCode ?? "", tryAnswer) : await onTryCheck(q, tryAnswer);
      setTryResult(checkResultText(result));
    } catch (e) {
      setTryResult(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <article className="work-question-edit assess-question" aria-labelledby={id("heading")}>
      <div className="row-between">
        <h3 id={id("heading")}>{questionHeading(index, q, kind)}</h3>
        {!readOnly && !locked && (
          <button type="button" className="text-button" disabled={!canRemove} aria-label={fieldLabel.remove(index)} onClick={onRemove}>
            <Trash2 size={15} /> Remove
          </button>
        )}
      </div>
      <fieldset className="assess-fieldset" disabled={frozen}>
        <div className="work-form-grid">
          <label>
            Question type
            <select aria-label={fieldLabel.questionType(index)} value={q.type}
              onChange={(e) => {
                const next = withQuestionType(q, e.target.value as WorkQuestionType);
                setChoicesText(next.choices.join("\n"));
                onChange(next);
              }}>
              {QUESTION_TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>{questionTypeLabel(type)}</option>
              ))}
            </select>
          </label>
          {/* RT-06: in-class exercises are auto-checked and not graded, so their questions have no Points field */}
          {kind === "practice" ? (
            <p className="muted assess-not-graded">{LABELS.notGraded}</p>
          ) : (
            <label>
              Points
              <input type="number" min={1} max={100} aria-label={fieldLabel.points(index)} value={q.points}
                onChange={(e) => set({ points: Number(e.target.value) })} />
            </label>
          )}
        </div>
        <label className="work-label">
          Question prompt
          <textarea rows={3} maxLength={4000} aria-label={fieldLabel.prompt(index)} value={q.prompt} onChange={(e) => set({ prompt: e.target.value })} />
        </label>
        {q.type === "choice" && (
          <label className="work-label">
            Choices (one per line)
            <textarea rows={4} value={choicesText} aria-invalid={choiceError ? true : undefined} aria-describedby={choiceError ? id("choices-error") : undefined}
              onChange={(e) => {
                setChoicesText(e.target.value);
                const parsed = parseChoices(e.target.value).choices;
                set({ choices: parsed, answer: parsed.includes(q.answer ?? "") ? q.answer : "" });
              }} />
            {choiceError && <span id={id("choices-error")} className="assess-field-error">{choiceError}</span>}
          </label>
        )}
        {(q.type === "complete" || q.type === "predict") && (
          <label className="work-label">
            Starter R code
            <textarea rows={4} className="mono" value={q.starterCode} onChange={(e) => set({ starterCode: e.target.value })} />
          </label>
        )}
        {q.type === "choice" ? (
          <label className="work-label">
            Reference answer
            <select value={q.answer ?? ""} onChange={(e) => set({ answer: e.target.value })}>
              <option value="">{kind === "practice" ? "Pick the correct choice" : "No reference (grade by hand)"}</option>
              {q.choices.filter((choice) => choice.trim()).map((choice, i) => (
                <option key={`${i}-${choice}`} value={choice}>{choice}</option>
              ))}
            </select>
          </label>
        ) : q.type === "complete" ? (
          <div className="work-form-grid">
            <label className="work-label">
              Reference solution code
              <textarea rows={4} className="mono" value={q.referenceCode ?? ""} onChange={(e) => set({ referenceCode: e.target.value })} />
            </label>
            <label className="work-label">
              Expected output
              <textarea rows={4} className="mono" value={q.expectedOutput ?? ""} placeholder="[1] 80" onChange={(e) => set({ expectedOutput: e.target.value })} />
            </label>
          </div>
        ) : (
          <label className="work-label">
            {q.type === "text" ? "Reference answer (staff only)" : "Reference answer"}
            <textarea rows={2} value={q.answer ?? ""} onChange={(e) => set({ answer: e.target.value })} />
          </label>
        )}
        {autoCheckable && (
          <>
            <label className="work-label">
              Accepted answers (one per line)
              <textarea rows={2} value={acceptedText}
                onChange={(e) => {
                  setAcceptedText(e.target.value);
                  set({ acceptedAnswers: parseLines(e.target.value) });
                }} />
            </label>
            <fieldset className="assess-inline-group">
              <legend>Auto-check settings</legend>
              <label className="checkbox-label">
                <input type="checkbox" checked={grading.autoCheck} onChange={(e) => setGrading({ autoCheck: e.target.checked })} />
                Auto-check this question
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={grading.caseSensitive} onChange={(e) => setGrading({ caseSensitive: e.target.checked })} />
                Match case
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={grading.whitespace !== "exact"}
                  onChange={(e) => setGrading({ whitespace: e.target.checked ? "outside_strings" : "exact" })} />
                Ignore spacing outside quotes
              </label>
              <label>
                Numeric tolerance (relative, e.g. 0.01 = 1%)
                <input type="number" min={0} max={1} step="any" value={grading.numericTolerance ?? ""}
                  onChange={(e) => setGrading({ numericTolerance: e.target.value === "" ? null : Number(e.target.value) })} />
              </label>
            </fieldset>
          </>
        )}
        {kind === "practice" && (
          <div className="work-form-grid">
            <label>
              Attempts allowed
              <input type="number" min={1} max={20} placeholder="Unlimited" value={q.maxAttempts ?? ""}
                onChange={(e) => set({ maxAttempts: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
            <fieldset className="assess-inline-group">
              <legend>Hints for students (shown one at a time after a wrong answer)</legend>
              {hints.map((hint, i) => (
                <input key={i} aria-label={`Hint ${i + 1} for question ${index + 1}`} value={hint} maxLength={1000}
                  onChange={(e) => {
                    const next = [...hints];
                    next[i] = e.target.value;
                    // WHY: keep positions while typing; trailing empty slots are dropped (the server drops empty hints too)
                    set({ hints: next.slice(0, next.reduce((n, h, k) => (h.trim() ? k + 1 : n), 0)) });
                  }} />
              ))}
            </fieldset>
          </div>
        )}
        <label className="work-label">
          {LABELS.studentExplanation}
          <textarea rows={2} maxLength={4000} value={q.studentExplanation ?? ""} onChange={(e) => set({ studentExplanation: e.target.value })} />
        </label>
      </fieldset>
      <fieldset className="assess-fieldset" disabled={readOnly}>
        {/* RV6-M08: in-class exercises are not graded, so there is no grading rubric */}
        {kind === "homework" && (
          <label className="work-label">
            {LABELS.graderRubric}
            <textarea rows={2} maxLength={4000} value={q.graderRubric ?? ""} onChange={(e) => set({ graderRubric: e.target.value })} />
          </label>
        )}
        <label className="work-label">
          Tags (comma-separated, e.g. joins, skill:left_join)
          <input value={tagsText} aria-invalid={tagError ? true : undefined}
            onChange={(e) => {
              setTagsText(e.target.value);
              set({ tags: parseTags(e.target.value).tags });
            }} />
          {tagError && <span className="assess-field-error">{tagError}</span>}
        </label>
      </fieldset>
      {onTryCheck && q.type !== "text" && !readOnly && (
        <div className="assess-try-check">
          <label>
            {q.type === "complete" ? "Try the auto-check (output a student's code prints)" : "Try the auto-check"}
            <input value={tryAnswer} placeholder={q.type === "complete" ? q.expectedOutput || "[1] 80" : "A student's answer"}
              className={q.type === "complete" ? "mono" : undefined} onChange={(e) => setTryAnswer(e.target.value)} />
          </label>
          <button type="button" className="outline-button" disabled={!tryAnswer.trim()} onClick={() => void tryCheck()}>
            Check
          </button>
          {tryResult && <span role="status">{tryResult}</span>}
        </div>
      )}
    </article>
  );
}
