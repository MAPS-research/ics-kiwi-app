import { ResponseText } from "../../components/ResponseText";
import { DIFFICULTY_OPTIONS, LABELS, questionTypeLabel } from "../../lib/labels";
import type { AiQuestionType, Difficulty, WorkQuestionType } from "../../types";

/*
 * Event payload rendering for Question activity and Answers [AU-D4-28, NM27, NM28] — owned by INSIGHTS.
 * Teacher-side AI names follow §10: this app's AI is "Lab AI tutor", Kiwi's native AI is "Kiwi lecture AI".
 * A generated exercise is never shown as a "Student question".
 */

export const EVENT_LABELS: Readonly<Record<string, string>> = {
  question_generated: "Practice exercise generated",
  question_viewed: "Question opened",
  answer_submitted: "Answer attempt",
  answer_draft: "Answer draft saved",
  answer_revealed: "Answer revealed",
  code_run: "Code execution",
  code_shared: "Code shared with Kiwi",
  material_viewed: "Lecture page opened",
  code_edited: "Code saved",
  hint_requested: "Hint requested",
  hint_shown: "Hint shown",
  ai_question: "AI tutor conversation",
  ai_request_failed: "AI request failed",
  ai_feedback: "Feedback on a Kiwi reply",
  similar_requested: LABELS.similarExerciseGenerated,
  work_answer_saved: "Assignment answer saved",
  work_submitted: "Assignment submitted",
  attempt_started: "Attempt started",
  grade_released: "Grade released",
  work_opened: "Assignment opened",
  topic_changed: "Chapter changed",
  difficulty_changed: "Difficulty changed",
  profile_updated: "Learning focus updated",
  practice_settings_changed: "Practice settings changed",
  question_skipped: "Exercise skipped",
  paste: "Pasted text",
};

/** Event title; `question_generated` reads "Similar exercise generated" for similar items (NM27). */
export function eventLabel(type: string, payload?: Record<string, unknown>): string {
  if (type === "question_generated" && payload && (payload.origin === "similar" || payload.surface === "similar")) return LABELS.similarExerciseGenerated;
  return EVENT_LABELS[type] || type.replace(/_/g, " ");
}

/** "lab-ai"/"kiwi-ai" = this app's AI, "kiwi" = Kiwi's native AI, "local" = local guidance. */
export function aiProvenanceLabel(source: unknown): string {
  return source === "kiwi-ai" || source === "lab-ai" || source === "openai" ? LABELS.labAiTutor : source === "kiwi" ? LABELS.kiwiLectureAi : LABELS.localGuidance;
}

function GeneratedExercise({ p }: { p: Record<string, unknown> }) {
  const choices = Array.isArray(p.choices) ? (p.choices as unknown[]).map(String) : [];
  const level = typeof p.difficulty === "number" ? DIFFICULTY_OPTIONS[p.difficulty as Difficulty] ?? `Difficulty ${p.difficulty}` : "";
  const type = typeof p.type === "string" ? questionTypeLabel(p.type as WorkQuestionType | AiQuestionType) : "";
  return (
    <div className="generated-exercise">
      <p className="exercise-meta">{[type, level].filter(Boolean).join(" · ")}</p>
      <p>
        <strong>Exercise:</strong> {String(p.prompt || p.title || "")}
      </p>
      {choices.length > 0 && (
        <ol className="exercise-choices">
          {choices.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function EventContent({ payload: p, type = "" }: { payload: Record<string, unknown>; type?: string }) {
  if (type === "question_generated") return <div className="event-content"><GeneratedExercise p={p} /></div>;
  const asked = Boolean(p.prompt) && (type === "" || type === "ai_question" || type === "hint_requested");
  return (
    <div className="event-content">
      {p.source === "kiwi" && (
        <>
          <p className="event-provenance">
            <span className="source-badge">Kiwi · {String(p.surface || "chat")}</span>
            {p.materialTitle ? ` ${String(p.materialTitle)}` : ""}
            {typeof p.page === "number" ? ` · page ${p.page}` : ""}
          </p>
          <details className="event-record-ids">
            <summary>Original record & thread</summary>
            <p>Kiwi interaction: {String(p.upstreamId)}</p>
            <p>Thread: {String(p.threadId)}</p>
            {Boolean(p.upstreamActionId) && <p>AI response: {String(p.upstreamActionId)}</p>}
          </details>
          {p.upstreamType === "frontend-interaction-ide-runcode" && p.ok === undefined && <p className="muted">Kiwi did not record the outcome status for this run.</p>}
          {p.responseState === "not-recorded" && p.surface !== "scratchpad" && Boolean(p.prompt) && (
            <p className="muted">No AI response has been recorded for this question yet.</p>
          )}
          {Boolean(p.truncated) && <p className="muted">Long evidence is abbreviated here. The original Kiwi record ID is shown above.</p>}
        </>
      )}
      {Boolean(p.recoveredFromSubmission) && <p className="muted">Recovered from the original homework submission snapshot.</p>}
      {Boolean(p._clientReported) && <p className="muted">Client-reported copy (not counted in metrics).</p>}
      {asked && (
        <p>
          <strong>Student question:</strong> {String(p.prompt)}
        </p>
      )}
      {p.answer !== undefined && (
        <>
          <strong>Answer attempt</strong>
          <pre>{String(p.answer)}</pre>
          <p>{p.correct === true ? "Checked correct" : p.correct === false ? "Checked incorrect" : "Not auto-checked"}</p>
        </>
      )}
      {Boolean(p.code) && (
        <>
          <strong>Code{p.language && p.language !== "not-recorded" ? ` · ${String(p.language)}` : ""}</strong>
          <pre>{String(p.code)}</pre>
        </>
      )}
      {p.ok !== undefined && <span className={p.ok ? "success-text" : "error-text"}>{p.ok ? "Completed" : "Failed"}</span>}
      {Boolean(p.output) && (
        <>
          <strong>Output</strong>
          <pre>{String(p.output)}</pre>
        </>
      )}
      {Boolean(p.error) && (
        <>
          <strong>Error</strong>
          <pre className="error-text">{String(p.error)}</pre>
        </>
      )}
      {Boolean(p.response || p.hint) && (
        <>
          <span className="ai-source">{aiProvenanceLabel(p.source === "kiwi" ? "kiwi" : p.aiProvider || p.source || "lab-ai")}</span>
          <ResponseText text={String(p.response || p.hint)} />
        </>
      )}
      {!p.prompt && !p.answer && !p.code && !p.response && !p.hint && <p>{String(p.questionTitle || p.title || p.action || "Activity recorded.")}</p>}
    </div>
  );
}
