import { useEffect, useState } from "react";
import { FlaskConical, Play, Save } from "lucide-react";
import { ResponseText } from "../../components/ResponseText";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { LABELS, questionTypeLabel } from "../../lib/labels";
import type { AiQuestionType, AiTestRequest, Difficulty, PolicyConfig } from "../../types";
import {
  difficultyOptions, EXPECTATION_OPTIONS, expectFromChoice, guardStatusLabel, homeworkContextLine, testActionLabel, type ExpectationChoice,
  type HomeworkQuestionOption, type RuleScope, type TestRunResult,
} from "./policyForm";

/*
 * "Test this rule" [F06, AU-D2-08, AU-D1-M07]: try the unsaved rules on a sample (free text or a homework question of
 * this chapter, optionally with an injection attempt). "Show assembled prompt" is a dry run (no API key needed, nothing
 * written); "Run test" calls the AI once and records only a teacher-test AI call. "Save as saved check" stores the sample
 * with an expectation for "Run saved checks".
 */

export type TestAction = AiTestRequest["action"];
export interface TestSampleDraft {
  prompt: string; code: string; type: AiQuestionType | ""; difficulty: Difficulty | 0; questionKey: string; injection: boolean;
}
export const EMPTY_SAMPLE: TestSampleDraft = { prompt: "", code: "", type: "", difficulty: 0, questionKey: "", injection: false };

export function questionKey(q: Pick<HomeworkQuestionOption, "assignmentId" | "questionId">): string {
  return `${q.assignmentId}::${q.questionId}`;
}
/** Draft → `AiTestRequest.sample` (empty fields omitted). */
export function sampleBody(action: TestAction, draft: TestSampleDraft): AiTestRequest["sample"] {
  const out: AiTestRequest["sample"] = {};
  if (draft.prompt.trim()) out.prompt = draft.prompt;
  if (draft.code.trim() && action === "chat") out.code = draft.code;
  if (action === "question" && draft.type) out.type = draft.type;
  if (action === "question" && draft.difficulty) out.difficulty = draft.difficulty;
  if (draft.questionKey) {
    const [assignmentId, questionId] = draft.questionKey.split("::");
    out.assignmentId = assignmentId;
    out.questionId = questionId;
  }
  if (draft.injection) out.injection = true;
  return out;
}

export function TestRulePanelView({
  action,
  onAction,
  sample,
  onSample,
  questions,
  config,
  configured,
  busy,
  result,
  error,
  onDryRun,
  onRun,
  checkLabel,
  onCheckLabel,
  expectation,
  onExpectation,
  onSaveCheck,
  savedMessage,
}: {
  action: TestAction;
  onAction: (a: TestAction) => void;
  sample: TestSampleDraft;
  onSample: (s: TestSampleDraft) => void;
  questions: readonly HomeworkQuestionOption[];
  config: PolicyConfig;
  configured: boolean;
  busy: boolean;
  result: TestRunResult | null;
  error: string;
  onDryRun: () => void;
  onRun: () => void;
  checkLabel: string;
  onCheckLabel: (v: string) => void;
  expectation: ExpectationChoice;
  onExpectation: (v: ExpectationChoice) => void;
  onSaveCheck: () => void;
  savedMessage: string;
}) {
  const item = result?.result?.item;
  const guard = result?.result?.guard;
  const canSave = Boolean(checkLabel.trim()) && (action === "question" || Boolean(sample.prompt.trim() || sample.questionKey));
  return (
    <section className="panel work-panel airules-section" id="test-rule" aria-labelledby="test-rule-title">
      <div className="panel-heading">
        <h2 id="test-rule-title">
          <FlaskConical size={17} aria-hidden="true" />
          {LABELS.testThisRule}
        </h2>
      </div>
      <p className="muted">Uses the rules as edited on this page (saved or not). Nothing is written to student data.</p>
      <div className="work-form-grid">
        <label>
          Try
          <select value={action} onChange={(e) => onAction(e.target.value as TestAction)}>
            <option value="chat">{testActionLabel("chat")}</option>
            <option value="question">{testActionLabel("question")}</option>
          </select>
        </label>
        <label>
          Homework question (tests the final-answer guard)
          <select value={sample.questionKey} onChange={(e) => onSample({ ...sample, questionKey: e.target.value })}>
            <option value="">None — free text only</option>
            {questions.map((q) => (
              <option key={questionKey(q)} value={questionKey(q)}>
                {`${q.assignmentTitle} · ${q.label} · ${q.prompt.slice(0, 60)}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="work-label">
        {action === "chat" ? "Student message" : "Focus note (\"What would you like to work on?\")"}
        <textarea
          rows={3}
          maxLength={action === "chat" ? 3000 : 400}
          value={sample.prompt}
          placeholder={action === "chat" ? "Leave empty to paste the chosen homework question" : "Optional"}
          onChange={(e) => onSample({ ...sample, prompt: e.target.value })}
        />
      </label>
      {action === "chat" ? (
        <label className="work-label">
          Student code (optional)
          <textarea rows={2} maxLength={12000} className="mono" value={sample.code} onChange={(e) => onSample({ ...sample, code: e.target.value })} />
        </label>
      ) : (
        <div className="work-form-grid">
          <label>
            Question type
            <select value={sample.type} onChange={(e) => onSample({ ...sample, type: e.target.value as AiQuestionType | "" })}>
              <option value="">First allowed type</option>
              {config.allowedTypes.map((t) => (
                <option key={t} value={t}>
                  {questionTypeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Difficulty
            <select value={sample.difficulty} onChange={(e) => onSample({ ...sample, difficulty: Number(e.target.value) as Difficulty | 0 })}>
              <option value={0}>Starting difficulty</option>
              {difficultyOptions(config.difficultyRubric)
                .filter((o) => o.value >= config.minDifficulty && o.value <= config.maxDifficulty)
                .map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
            </select>
          </label>
        </div>
      )}
      <label className="checkbox-label airules-check">
        <input type="checkbox" aria-label="Add an injection attempt" checked={sample.injection} onChange={(e) => onSample({ ...sample, injection: e.target.checked })} />
        Add an injection attempt
      </label>
      <div className="work-actions">
        <button type="button" className="outline-button" disabled={busy} onClick={onDryRun}>
          Show assembled prompt
        </button>
        <button type="button" className="primary-button" disabled={busy || !configured} onClick={onRun} title={configured ? undefined : "AI is not configured on the server"}>
          <Play size={15} aria-hidden="true" />
          Run test
        </button>
        {!configured && <span className="muted">Run test needs the AI to be configured; the assembled prompt works without it.</span>}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="airules-test-result" aria-live="polite">
          <dl className="airules-facts">
            <div>
              <dt>Rules tested</dt>
              <dd>{result.policyLabel ?? "Unsaved rules"}</dd>
            </div>
            <div>
              <dt>Prompt hash</dt>
              <dd className="mono">{result.promptHash.slice(0, 16)}…</dd>
            </div>
            <div>
              <dt>Homework context</dt>
              <dd>{homeworkContextLine(questions.find((q) => questionKey(q) === sample.questionKey) ?? null, result.homeworkMatch, questions)}</dd>
            </div>
            {guard && (
              <div>
                <dt>Final-answer guard</dt>
                <dd>
                  <StatusBadge tone={guard.status === "clean" || guard.status === "not_applicable" ? "success" : "warning"}>{guardStatusLabel(guard.status)}</StatusBadge>
                  {guard.rules.length > 0 && <span className="muted"> Rules: {guard.rules.join(", ")}</span>}
                </dd>
              </div>
            )}
          </dl>
          {result.error && <p className="error-text">{result.error}</p>}
          {result.result?.text !== undefined && !item && (
            <>
              <h3>AI reply</h3>
              <pre className="airules-pre">{result.result.text}</pre>
            </>
          )}
          {item && (
            <>
              <h3>Generated item · {questionTypeLabel(item.questionType as AiQuestionType)} · difficulty {item.difficulty}</h3>
              <div className="airules-item">
                <strong>{item.item.title}</strong>
                <ResponseText className="question-prompt" text={item.item.prompt} />
                {item.item.code && <pre className="airules-pre">{item.item.code}</pre>}
                {item.item.starterCode && <pre className="airules-pre">{item.item.starterCode}</pre>}
                {item.item.choices && (
                  <ol type="A">
                    {item.item.choices.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ol>
                )}
                <p>
                  <strong>Answer:</strong> {item.item.answer}
                </p>
                {item.item.explanation && <ResponseText className="muted" text={item.item.explanation} />}
              </div>
            </>
          )}
          <details className="airules-messages">
            <summary>Assembled prompt ({result.messages.length} messages)</summary>
            <ol>
              {result.messages.map((m, i) => (
                <li key={i}>
                  <span className="small-pill">{m.role}</span>
                  <pre className="airules-pre">{m.content}</pre>
                </li>
              ))}
            </ol>
          </details>
        </div>
      )}
      <div className="airules-save-check">
        <h3>Save as saved check</h3>
        <div className="work-form-grid">
          <label>
            Check name
            <input value={checkLabel} maxLength={120} onChange={(e) => onCheckLabel(e.target.value)} placeholder="e.g. HW3 Q1 pasted into Ask Kiwi" />
          </label>
          <label>
            Expectation
            <select value={expectation} onChange={(e) => onExpectation(e.target.value as ExpectationChoice)}>
              {EXPECTATION_OPTIONS.filter((o) => !o.action || o.action === action).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="work-actions">
          <button type="button" className="outline-button" disabled={busy || !canSave} onClick={onSaveCheck}>
            <Save size={15} aria-hidden="true" />
            Save as saved check
          </button>
          {savedMessage && (
            <span className="success-text" role="status">
              {savedMessage}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/** GET /api/teacher/ai/rules/homework-questions (AIRULES convenience endpoint; typed by CR-AIRULES-1). */
export function loadHomeworkQuestions(classId: string, unitId: string): Promise<HomeworkQuestionOption[]> {
  return api.aiRuleHomeworkQuestions(classId, unitId || undefined);
}

/** Container (instructors only; the editor does not mount it for TAs and viewers). */
export function TestRulePanel({
  classId,
  scope,
  config,
  configured,
  onSavedCheck,
}: {
  classId: string;
  scope: RuleScope;
  config: PolicyConfig;
  configured: boolean;
  onSavedCheck: () => void;
}) {
  const [action, setAction] = useState<TestAction>("chat");
  const [sample, setSample] = useState<TestSampleDraft>(EMPTY_SAMPLE);
  const [questions, setQuestions] = useState<HomeworkQuestionOption[]>([]);
  const [result, setResult] = useState<TestRunResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkLabel, setCheckLabel] = useState("");
  const [expectation, setExpectation] = useState<ExpectationChoice>("guard_clean");
  const [savedMessage, setSavedMessage] = useState("");
  useEffect(() => {
    let live = true;
    loadHomeworkQuestions(classId, scope.unitId)
      .then((rows) => live && setQuestions(rows))
      .catch((e: unknown) => live && setError(`Homework questions could not be loaded: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      live = false;
    };
  }, [classId, scope.unitId]);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError("");
    try {
      setResult(
        (await api.testAiRule(classId, { scope: scope.scope, unitId: scope.unitId, groupId: scope.groupId, config, action, sample: sampleBody(action, sample), dryRun })) as TestRunResult,
      );
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const saveCheck = async () => {
    setBusy(true);
    setError("");
    setSavedMessage("");
    try {
      await api.saveAiTestSample(classId, {
        unitId: scope.unitId, groupId: scope.groupId, label: checkLabel.trim(), action, sample: sampleBody(action, sample),
        expect: expectFromChoice(expectation),
      });
      setSavedMessage(`Saved check "${checkLabel.trim()}".`);
      setCheckLabel("");
      onSavedCheck();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <TestRulePanelView
      action={action}
      onAction={(a) => {
        setAction(a);
        setResult(null);
        if (a === "chat" && expectation === "item_valid") setExpectation("guard_clean");
      }}
      sample={sample}
      onSample={setSample}
      questions={questions}
      config={config}
      configured={configured}
      busy={busy}
      result={result}
      error={error}
      onDryRun={() => void run(true)}
      onRun={() => void run(false)}
      checkLabel={checkLabel}
      onCheckLabel={setCheckLabel}
      expectation={expectation}
      onExpectation={setExpectation}
      onSaveCheck={() => void saveCheck()}
      savedMessage={savedMessage}
    />
  );
}
