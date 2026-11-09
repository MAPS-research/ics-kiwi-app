import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";
import { api, type Q } from "../../lib/api";
import { downloadBlob } from "../../lib/csv";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { GradingQueue } from "../../types";
import { POLICY_OPTIONS, type ScorePolicy } from "./gradebookCells";
import { cardStatus, gradingTabCounts, readyToReleaseLabel, releaseButtonLabel } from "./gradingKeys";
import { useToGradeCount } from "./useToGradeCount";

/*
 * Release & export (GRADE; F04, TH05, TH11, NM11). ?assignmentId=
 * Per homework: Release grades (58/60 graded) and the drafts waiting (Ready to release 12); LMS export options.
 */

export interface ReleaseAssignmentRow { assignmentId: string; header: string; counts: GradingQueue["counts"] }
export interface DraftRow { id: string; studentLabel: string; attempt: number; label: string }
export interface ExportOptions { policy: ScorePolicy; releasedOnly: boolean; layout: "wide" | "long" }

export interface ReleaseExportViewProps {
  assignments: readonly ReleaseAssignmentRow[];
  selectedId: string;
  drafts: readonly DraftRow[];
  canRelease: boolean;
  canExport: boolean;
  busy: boolean;
  status?: string;
  exportOptions: ExportOptions;
  onSelect: (assignmentId: string) => void;
  onRelease: (assignmentId: string) => void;
  onExport: (kind: "grades" | "status") => void;
  onExportOptions: (options: ExportOptions) => void;
}

export function releaseConfirmTitle(count: number): string {
  return `Release ${count} ${count === 1 ? "grade" : "grades"}?`;
}
export function releaseConfirmText(header: string, stillToGrade: number): string {
  const rest = stillToGrade > 0 ? ` ${stillToGrade} ${stillToGrade === 1 ? "submission still needs" : "submissions still need"} grading and stay hidden.` : "";
  return `Students see their scores and feedback for ${header} right away.${rest}`;
}

export function ReleaseExportView({ assignments, selectedId, drafts, canRelease, canExport, busy, status, exportOptions, onSelect, onRelease,
  onExport, onExportOptions }: ReleaseExportViewProps) {
  const selected = assignments.find((a) => a.assignmentId === selectedId);
  return (
    <>
      <section className="panel work-panel release-panel" aria-label="Release grades">
        <h2>Release grades</h2>
        {!canRelease && <p className="muted">Your role can save grades as drafts; an instructor releases them to students.</p>}
        {status && (
          <p className="work-message" role="status">
            {status}
          </p>
        )}
        {!assignments.length && <EmptyState>No published homework yet.</EmptyState>}
        <ul className="release-list">
          {assignments.map((a) => (
            <li key={a.assignmentId} className={a.assignmentId === selectedId ? "release-row is-selected" : "release-row"}>
              <button type="button" className="text-button release-row-title" aria-pressed={a.assignmentId === selectedId} onClick={() => onSelect(a.assignmentId)}>
                {a.header}
              </button>
              <span className="release-row-meta">
                <StatusBadge tone={a.counts.toRelease ? "info" : "neutral"}>{readyToReleaseLabel(a.counts.toRelease)}</StatusBadge>
                {a.counts.toGrade > 0 && <StatusBadge tone="warning">{`${LABELS.needsGrading} ${a.counts.toGrade}`}</StatusBadge>}
              </span>
              {canRelease && (
                <button type="button" className="primary-button" disabled={busy || !a.counts.toRelease} onClick={() => onRelease(a.assignmentId)}>
                  {releaseButtonLabel(a.counts.graded, a.counts.all)}
                </button>
              )}
            </li>
          ))}
        </ul>
        {selected && (
          <div className="release-drafts">
            <h3>{readyToReleaseLabel(selected.counts.toRelease)}</h3>
            {!drafts.length && <p className="muted">No drafts waiting for this assignment.</p>}
            <ul>
              {drafts.map((d) => (
                <li key={d.id}>
                  {d.studentLabel} · Attempt {d.attempt} · <StatusBadge tone="info">{d.label}</StatusBadge>
                </li>
              ))}
            </ul>
            {selected.counts.toRelease > drafts.length && <p className="muted">and {selected.counts.toRelease - drafts.length} more</p>}
          </div>
        )}
      </section>
      {canExport && (
        <section className="panel work-panel export-panel" aria-label="Export grades">
          <h2>Export grades for LMS</h2>
          <div className="table-toolbar">
            <label>
              Score
              <select value={exportOptions.policy} onChange={(e) => onExportOptions({ ...exportOptions, policy: e.target.value === "highest" ? "highest" : "latest" })}>
                {POLICY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label} attempt
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox-label release-only-label">
              <input type="checkbox" checked={exportOptions.releasedOnly} onChange={(e) => onExportOptions({ ...exportOptions, releasedOnly: e.target.checked })} />
              Released only
            </label>
            <label>
              Layout
              <select value={exportOptions.layout} onChange={(e) => onExportOptions({ ...exportOptions, layout: e.target.value === "long" ? "long" : "wide" })}>
                <option value="wide">Wide (one row per student)</option>
                <option value="long">Long (one row per student and assignment)</option>
              </select>
            </label>
          </div>
          <div className="work-actions">
            <button type="button" className="primary-button" disabled={busy} onClick={() => onExport("grades")}>
              {LABELS.gradesForLms}
            </button>
            <button type="button" className="outline-button" disabled={busy} onClick={() => onExport("status")}>
              {LABELS.studentAssignmentStatusCsv}
            </button>
          </div>
        </section>
      )}
    </>
  );
}

export function ReleaseExportPage({ route }: TeacherPageProps) {
  const { classId, me } = useTeacher();
  const toGradeCount = useToGradeCount();
  const query = new URL(route, "http://lab.local").searchParams;
  const selectedId = query.get("assignmentId") || "";
  const [rows, setRows] = useState<ReleaseAssignmentRow[]>([]);
  const [drafts, setDrafts] = useState<{ id: string; studentLabel: string; attempt: number; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [exportOptions, setExportOptions] = useState<ExportOptions>({ policy: "latest", releasedOnly: true, layout: "wide" });
  const canRelease = me.permissions.includes("releaseGrades");
  const canExport = me.permissions.includes("exportGrades");

  const load = useCallback(async () => {
    const book = await api.gradebook(classId, { pageSize: "1" });
    const next: ReleaseAssignmentRow[] = [];
    let selectedDrafts: typeof drafts = [];
    for (const column of book.columns) {
      const queue = await api.gradingQueue(classId, { assignmentId: column.assignmentId, show: "draft" });
      next.push({ assignmentId: column.assignmentId, header: column.header, counts: queue.counts });
      if (column.assignmentId === selectedId)
        selectedDrafts = queue.cards.map((c) => ({ id: c.submission.id, studentLabel: c.studentLabel, attempt: c.submission.attempt, label: cardStatus(c).label }));
    }
    setRows(next);
    setDrafts(selectedDrafts);
  }, [classId, selectedId]);

  useEffect(() => {
    void load().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  // RV6-m20: releasing shows grades to students, so it is confirmed first
  const [confirming, setConfirming] = useState<ReleaseAssignmentRow | null>(null);
  const release = async (assignmentId: string) => {
    setConfirming(null);
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await api.releaseGrades(classId, assignmentId);
      setStatus(`Released ${result.released} ${result.released === 1 ? "grade" : "grades"}. Students can see them now.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const exportFile = async (kind: "grades" | "status") => {
    setBusy(true);
    setError("");
    try {
      const q: Q = kind === "grades"
        ? { policy: exportOptions.policy, releasedOnly: exportOptions.releasedOnly ? "1" : "0", layout: exportOptions.layout }
        : {};
      if (selectedId) q.assignmentIds = selectedId;
      const file = kind === "grades" ? await api.gradesCsv(classId, q) : await api.assignmentStatusCsv(classId, q);
      downloadBlob(file.blob, file.filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="Release & export" tabs={<SectionTabs section="grading" counts={gradingTabCounts(toGradeCount)} />} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <ReleaseExportView
        assignments={rows}
        selectedId={selectedId}
        drafts={drafts}
        canRelease={canRelease}
        canExport={canExport}
        busy={busy}
        status={status}
        exportOptions={exportOptions}
        onSelect={(id) => navigate(teacherPaths.release({ assignmentId: id === selectedId ? "" : id }), true)}
        onRelease={(id) => setConfirming(rows.find((r) => r.assignmentId === id) ?? null)}
        onExport={(kind) => void exportFile(kind)}
        onExportOptions={setExportOptions}
      />
      <ConfirmDialog
        open={Boolean(confirming)}
        title={confirming ? releaseConfirmTitle(confirming.counts.toRelease) : ""}
        confirmLabel="Release grades"
        busy={busy}
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirming && void release(confirming.assignmentId)}
      >
        {confirming && <p>{releaseConfirmText(confirming.header, confirming.counts.toGrade)}</p>}
      </ConfirmDialog>
    </>
  );
}
