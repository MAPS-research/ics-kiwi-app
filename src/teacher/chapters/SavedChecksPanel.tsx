import { useCallback, useEffect, useState } from "react";
import { ListChecks, Trash2 } from "lucide-react";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { LABELS } from "../../lib/labels";
import type { AiTestSample, AiTestSampleResult, PolicyConfig } from "../../types";
import { expectationLabel, savedCheckOutcome, savedChecksSummary, testActionLabel, type RuleScope } from "./policyForm";
import { ResponseText } from "../../components/ResponseText";

/*
 * Saved checks [AU-D1-M07, AIRULES-14]: "Test this rule" samples saved with an expectation and replayed against the
 * rules as edited before "Save as new version". Failing checks are a warning only; they never block a save.
 */

export function SavedChecksPanelView({
  samples,
  results,
  readOnly,
  busy,
  dryRun,
  onDryRun,
  configured,
  onArchive,
}: {
  samples: readonly AiTestSample[];
  results: readonly AiTestSampleResult[] | null;
  readOnly: boolean;
  busy: boolean;
  dryRun: boolean;
  onDryRun: (v: boolean) => void;
  configured: boolean;
  onArchive: (sample: AiTestSample) => void;
}) {
  const byId = new Map((results ?? []).map((r) => [r.sampleId, r]));
  return (
    <section className="panel work-panel airules-section" aria-labelledby="saved-checks-title">
      <div className="panel-heading">
        <h2 id="saved-checks-title">
          <ListChecks size={17} aria-hidden="true" />
          Saved checks
        </h2>
        {!readOnly && samples.length > 0 && (
          <div className="airules-heading-actions">
            <label className="checkbox-label airules-check">
              <input type="checkbox" aria-label="Run saved checks as a dry run" checked={dryRun} disabled={!configured || busy} onChange={(e) => onDryRun(e.target.checked)} />
              {LABELS.runSavedChecks}: dry run only (assemble prompts, no AI call)
            </label>
          </div>
        )}
      </div>
      {!samples.length ? (
        <p className="muted">No saved checks for these rules.{readOnly ? "" : " Use Test this rule, then Save as saved check to add one."}</p>
      ) : (
        <ul className="airules-checks">
          {samples.map((s) => {
            const r = byId.get(s.id);
            const outcome = r ? savedCheckOutcome(r) : null;
            return (
              <li key={s.id}>
                <div>
                  <strong>{s.label}</strong>
                  <span className="muted">
                    {" "}
                    {testActionLabel(s.action)} · {expectationLabel(s.expect)}
                  </span>
                  {r && (
                    <p className="muted airules-check-detail">
                      {outcome && <StatusBadge tone={outcome.tone}>{outcome.label}</StatusBadge>} {r.detail}
                    </p>
                  )}
                  {r?.reply && (
                    <details className="airules-check-reply">
                      <summary>{s.action === "chat" ? "Reply that was checked" : "Generated exercise that was checked"}</summary>
                      <ResponseText text={r.reply} />
                    </details>
                  )}
                </div>
                {!readOnly && (
                  <button type="button" className="text-button" disabled={busy} onClick={() => onArchive(s)} aria-label={`Remove saved check ${s.label}`}>
                    <Trash2 size={14} aria-hidden="true" />
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {results && (
        <p className={results.some((r) => r.passed === false) ? "error-text" : "muted"} role="status">
          {savedChecksSummary(results)}
        </p>
      )}
    </section>
  );
}

/** Container: lists GET /api/teacher/ai/test-samples, runs POST …/run with the edited config, archives with DELETE. */
export function SavedChecksPanel({
  classId,
  scope,
  config,
  readOnly,
  configured,
  refreshKey,
  runRequest,
  onError,
}: {
  classId: string;
  scope: RuleScope;
  config: PolicyConfig | null;
  readOnly: boolean;
  configured: boolean;
  /** Changes when a check was saved elsewhere (the test panel). */
  refreshKey: number;
  /** Changes when the editor's "Run saved checks" button was pressed. */
  runRequest: number;
  onError: (message: string) => void;
}) {
  const [samples, setSamples] = useState<AiTestSample[]>([]);
  const [results, setResults] = useState<AiTestSampleResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dryRun, setDryRun] = useState(!configured);
  useEffect(() => setDryRun(!configured), [configured]);
  const load = useCallback(async () => {
    setSamples(await api.aiTestSamples(classId, { unitId: scope.unitId, groupId: scope.groupId }));
  }, [classId, scope.unitId, scope.groupId]);
  useEffect(() => {
    setResults(null);
    void load().catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  }, [load, refreshKey, onError]);
  const run = useCallback(async () => {
    setBusy(true);
    try {
      const out = await api.runAiTestSamples(classId, {
        unitId: scope.unitId, groupId: scope.groupId, ...(config ? { config } : {}), dryRun: dryRun || !configured,
      });
      setResults(out.results);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [classId, scope.unitId, scope.groupId, config, dryRun, configured, onError]);
  useEffect(() => {
    if (runRequest > 0 && !readOnly) void run();
    // WHY: only an explicit "Run saved checks" press (a new runRequest value) runs the checks, not every config edit.
  }, [runRequest]);
  const archive = async (sample: AiTestSample) => {
    setBusy(true);
    try {
      await api.archiveAiTestSample(classId, sample.id);
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SavedChecksPanelView
      samples={samples}
      results={results}
      readOnly={readOnly}
      busy={busy}
      dryRun={dryRun || !configured}
      onDryRun={setDryRun}
      configured={configured}
      onArchive={(s) => void archive(s)}
    />
  );
}
