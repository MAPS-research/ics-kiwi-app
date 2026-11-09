import { useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { LABELS } from "../../lib/labels";
import type { PolicyDiff, PolicyVersion } from "../../types";
import { diffRows, isInheritConfig, textDiff, versionDescription, versionLabel } from "./policyForm";

/*
 * Version history of one AI tutor rules scope [F06, AIRULES-01]: newest first, Compare (any two versions) and Restore
 * (creates a new version; nothing is changed in place). TAs and viewers see the list and comparisons, never Restore.
 */

export interface CompareState { a: PolicyVersion; b: PolicyVersion; diff: PolicyDiff[] }

export function VersionHistoryView({
  history,
  readOnly,
  busy,
  compareBase,
  onCompareBase,
  comparison,
  onCompare,
  onRestore,
  timeZone,
}: {
  history: readonly PolicyVersion[];
  readOnly: boolean;
  busy: boolean;
  compareBase: number | null;
  onCompareBase: (versionId: number | null) => void;
  comparison: CompareState | null;
  onCompare: (versionId: number) => void;
  onRestore: (version: PolicyVersion) => void;
  timeZone?: string;
}) {
  const latest = history[0];
  return (
    <section className="panel work-panel airules-section" aria-labelledby="ai-rules-history">
      <div className="panel-heading">
        <h2 id="ai-rules-history">
          <History size={17} aria-hidden="true" />
          {LABELS.versionHistory}
        </h2>
      </div>
      {!history.length ? (
        <p className="muted">No saved versions for these rules yet. The rules shown above come from the course default or the platform.</p>
      ) : (
        <>
          <label className="work-label airules-inline-label">
            Compare against
            <select value={compareBase ?? latest?.id ?? ""} onChange={(e) => onCompareBase(e.target.value ? Number(e.target.value) : null)}>
              {history.map((v) => (
                <option key={v.id} value={v.id}>
                  {versionLabel(v, timeZone)}
                </option>
              ))}
            </select>
          </label>
          <ol className="airules-history">
            {history.map((v) => (
              <li key={v.id}>
                <div className="airules-history-main">
                  <strong>{versionLabel(v, timeZone)}</strong>
                  {v.id === latest?.id && <StatusBadge tone="success">Current</StatusBadge>}
                  {isInheritConfig(v.config) && <StatusBadge tone="neutral">Reset</StatusBadge>}
                  <span className="muted">{versionDescription(v, history)}</span>
                </div>
                <div className="airules-history-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy || (compareBase ?? latest?.id) === v.id}
                    onClick={() => onCompare(v.id)}
                    aria-label={`${LABELS.compare} v${v.version}`}
                  >
                    {LABELS.compare}
                  </button>
                  {!readOnly && v.id !== latest?.id && (
                    <button type="button" className="text-button" disabled={busy} onClick={() => onRestore(v)} aria-label={`${LABELS.restore} v${v.version}`}>
                      <RotateCcw size={14} aria-hidden="true" />
                      {LABELS.restore}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      {comparison && <ComparisonView comparison={comparison} />}
    </section>
  );
}

type Change = ReturnType<typeof textDiff>;
const Before = ({ change }: { change: Change }) => (
  <>
    {change.prefix}
    {change.removed && <del className="airules-diff-removed">{change.removed}</del>}
    {change.suffix}
  </>
);
const After = ({ change }: { change: Change }) => (
  <>
    {change.prefix}
    {change.added && <ins className="airules-diff-added">{change.added}</ins>}
    {change.suffix}
  </>
);

/**
 * Compare two versions: a Setting · older · newer table on wide screens (RV6-M06). RT-05: at phone width the table is
 * replaced by one card per changed setting that shows the newer version (with the marked change) first, then the older
 * one, so the change is never in a column scrolled off-screen. CSS shows exactly one of the two layouts.
 */
export function ComparisonView({ comparison }: { comparison: CompareState }) {
  const { a, b } = comparison;
  const summary = `v${a.version} → v${b.version}: ${comparison.diff.length ? `${comparison.diff.length} changed` : "no differences"}`;
  const rows = diffRows(comparison.diff).map((row) => ({ label: row.label, change: textDiff(row.before, row.after) }));
  return (
    <div className="airules-compare" aria-live="polite">
      <div className="table-scroll airules-diff-scroll">
        <table className="data-table airules-diff">
          <colgroup>
            <col className="airules-diff-setting" />
            <col />
            <col />
          </colgroup>
          <caption className="airules-caption">{summary}</caption>
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">v{a.version}</th>
              <th scope="col">v{b.version}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, change }) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td className="airules-diff-value">
                  <Before change={change} />
                </td>
                <td className="airules-diff-value">
                  <After change={change} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="airules-diff-stacked">
        <p className="airules-caption">{summary}</p>
        {rows.map(({ label, change }) => (
          <section key={label} className="airules-diff-card" aria-label={label}>
            <h3>{label}</h3>
            <dl>
              <dt>v{b.version}</dt>
              <dd className="airules-diff-value">
                <After change={change} />
              </dd>
              <dt>v{a.version}</dt>
              <dd className="airules-diff-value">
                <Before change={change} />
              </dd>
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Container: compares through GET /api/teacher/ai/rules/compare and restores through POST …/versions/{id}/restore. */
export function VersionHistory({
  classId,
  history,
  readOnly,
  dirty,
  onRestored,
  onError,
  timeZone,
}: {
  classId: string;
  history: readonly PolicyVersion[];
  readOnly: boolean;
  dirty: boolean;
  onRestored: (version: PolicyVersion) => void;
  onError: (message: string) => void;
  timeZone?: string;
}) {
  const [compareBase, setCompareBase] = useState<number | null>(null);
  const [comparison, setComparison] = useState<CompareState | null>(null);
  const [restoring, setRestoring] = useState<PolicyVersion | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const compare = async (versionId: number) => {
    const base = compareBase ?? history[0]?.id;
    if (!base) return;
    setBusy(true);
    try {
      setComparison(await api.compareAiRules(classId, versionId, base));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (!restoring) return;
    setBusy(true);
    try {
      const saved = await api.restoreAiRule(classId, restoring.id, note.trim());
      setRestoring(null);
      setNote("");
      setComparison(null);
      onRestored(saved);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <VersionHistoryView
        history={history}
        readOnly={readOnly}
        busy={busy}
        compareBase={compareBase}
        onCompareBase={(id) => {
          setCompareBase(id);
          setComparison(null);
        }}
        comparison={comparison}
        onCompare={(id) => void compare(id)}
        onRestore={setRestoring}
        timeZone={timeZone}
      />
      <ConfirmDialog
        open={Boolean(restoring)}
        title={restoring ? `Restore v${restoring.version}?` : ""}
        confirmLabel={LABELS.restore}
        busy={busy}
        onCancel={() => setRestoring(null)}
        onConfirm={() => void restore()}
      >
        <p>
          Restoring creates a new version with the settings of v{restoring?.version}. Earlier versions stay in the history.
          {dirty ? " Your unsaved edits on this page will be replaced." : ""}
        </p>
        <label className="work-label">
          Version note (optional)
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </label>
      </ConfirmDialog>
    </>
  );
}
