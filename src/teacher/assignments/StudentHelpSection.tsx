import { STUDENT_LABELS } from "../../lib/labels";
import { ASK_KIWI_OPTIONS, KIWI_PANEL_HELP } from "./assignmentRules";
import type { AskKiwiMode, AssignmentKind, ToolPolicy } from "../../types";

/** Editor section 3 — "Student help for this assignment" [F02, TH02, AU-D1-03, AU-D2-11]. Pure view. */
export function StudentHelpSection({
  kind,
  policy,
  linked,
  readOnly,
  protection = null,
  onChange,
}: {
  kind: AssignmentKind;
  policy: ToolPolicy;
  linked: boolean;
  readOnly: boolean;
  /** the actual answer-protection state (`protectionNote`, decision D2); homework only */
  protection?: string | null;
  onChange: (policy: ToolPolicy) => void;
}) {
  const set = (values: Partial<ToolPolicy>) => onChange({ ...policy, ...values });
  return (
    <section className="panel assess-section" aria-labelledby="assess-help-title">
      <h2 id="assess-help-title">Student help &amp; AI</h2>
      <fieldset className="assess-fieldset assess-help-fieldset" disabled={readOnly}>
        <legend>Student help for this assignment</legend>
        <label className="checkbox-label">
          <input type="checkbox" checked={policy.rWorkspace} onChange={(e) => set({ rWorkspace: e.target.checked })} />
          R workspace
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={policy.allowRunPredict} onChange={(e) => set({ allowRunPredict: e.target.checked })} />
          Allow running code for Predict output questions
        </label>
        <label className="assess-help-select">
          Ask Kiwi
          <select value={policy.askKiwi} onChange={(e) => set({ askKiwi: e.target.value as AskKiwiMode })}>
            {ASK_KIWI_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={policy.similarPractice} onChange={(e) => set({ similarPractice: e.target.checked })} />
          Similar practice ({STUDENT_LABELS.trySimilarQuestion})
        </label>
      </fieldset>
      {kind === "homework" && protection && <p className="assess-notice" role="note">{protection}</p>}
      {linked && <p className="muted">{KIWI_PANEL_HELP}</p>}
    </section>
  );
}
