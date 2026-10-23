import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { api } from "../../lib/api";
import { LABELS } from "../../lib/labels";
import { AuditLogPanel } from "./AuditLogPanel";
import type { CourseSettings, NameMode } from "../../types";

/*
 * Privacy [TH12, DA13, PEOPLE-04/08/12, §14.1–14.5]: emails, default name mode (Presentation mode), research purpose and
 * IRB protocol, viewer research exports, retention (report + typed confirmation), per-student anonymize/delete, audit log.
 */

export type PrivacyDraft = CourseSettings["privacy"];

/** "events 5, chat_turns 1 · name or email removed from 3 texts" (SB-B01: `<table>_text` counts are texts scrubbed). */
export function anonymizeCountText(counts: Record<string, number>): string {
  const rows = Object.entries(counts).filter(([t, n]) => n > 0 && !t.endsWith("_text")).map(([t, n]) => `${t} ${n}`);
  const texts = Object.entries(counts).filter(([t]) => t.endsWith("_text")).reduce((sum, [, n]) => sum + n, 0);
  const base = rows.join(", ") || "no rows";
  return texts ? `${base} · name or email removed from ${texts === 1 ? "1 text" : `${texts} texts`}` : base;
}

export function privacyProblem(draft: PrivacyDraft): string {
  if (draft.retentionDays !== null && (!Number.isInteger(draft.retentionDays) || draft.retentionDays < 1 || draft.retentionDays > 3650))
    return "Retention is empty (keep everything) or 1–3650 days.";
  if (draft.researchPurpose.length > 500) return "The research purpose is at most 500 characters.";
  return "";
}

export function retentionText(report: { due: Record<string, number>; retentionDays: number | null } | null): string {
  if (!report) return "";
  if (report.retentionDays === null) return "No retention period is set; nothing is removed.";
  const total = Object.values(report.due).reduce((a, b) => a + b, 0);
  const parts = Object.entries(report.due).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`);
  return `${total} records are older than ${report.retentionDays} days${parts.length ? ` (${parts.join(", ")})` : ""}.`;
}

export function PrivacyForm({ draft, setDraft, busy }: { draft: PrivacyDraft; setDraft: (d: PrivacyDraft) => void; busy: boolean }) {
  return (
    <fieldset className="editor-fields" disabled={busy}>
      <label className="checkbox-label">
        <input type="checkbox" checked={draft.showEmails} onChange={(e) => setDraft({ ...draft, showEmails: e.target.checked })} />
        Show Kiwi emails when a student has no display name
      </label>
      <label className="work-label">
        Default for {LABELS.presentationMode}
        <select value={draft.defaultNameMode} onChange={(e) => setDraft({ ...draft, defaultNameMode: e.target.value as NameMode })}>
          <option value="names">Names (Presentation mode off)</option>
          <option value="pseudonyms">Pseudonyms S-014 (Presentation mode on)</option>
        </select>
      </label>
      <label className="work-label">
        Research purpose (pre-fills exports)
        <textarea rows={2} maxLength={500} value={draft.researchPurpose} onChange={(e) => setDraft({ ...draft, researchPurpose: e.target.value })} />
      </label>
      <label className="work-label">
        IRB protocol (optional, printed in research package READMEs)
        <input maxLength={200} value={draft.irbProtocol} onChange={(e) => setDraft({ ...draft, irbProtocol: e.target.value })} />
      </label>
      <label className="work-label">
        Keep student activity for (days; empty = keep)
        <input
          type="number"
          min={1}
          max={3650}
          value={draft.retentionDays ?? ""}
          onChange={(e) => setDraft({ ...draft, retentionDays: e.target.value === "" ? null : Number(e.target.value) })}
        />
      </label>
      <label className="checkbox-label">
        <input type="checkbox" checked={draft.viewerCanExportResearch} onChange={(e) => setDraft({ ...draft, viewerCanExportResearch: e.target.checked })} />
        Viewers may download the research package (always pseudonymized, consented students only)
      </label>
    </fieldset>
  );
}

export function PrivacyPanel({ classId, settings, busy, onSave }: { classId: string; settings: CourseSettings; busy: boolean; onSave: (patch: Partial<CourseSettings>) => void }) {
  const [draft, setDraft] = useState<PrivacyDraft>(settings.privacy);
  const [report, setReport] = useState<{ due: Record<string, number>; retentionDays: number | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirmRetention, setConfirmRetention] = useState(false);
  const [target, setTarget] = useState({ studentId: "", mode: "anonymize" as "anonymize" | "delete" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => setDraft(settings.privacy), [settings]);
  useEffect(() => {
    api.retention(classId).then(setReport).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [classId, revision, settings]);
  const problem = privacyProblem(draft);
  const run = async (work: () => Promise<string>) => {
    setWorking(true);
    setError("");
    try {
      setMessage(await work());
      setRevision((r) => r + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  const countText = (counts: Record<string, number>) => anonymizeCountText(counts);
  return (
    <>
      <section className="panel work-panel focused-panel">
        <h2 className="panel-heading">Privacy</h2>
        <p className="muted">
          {LABELS.researchConsent} comes from Kiwi and can be overridden per student on the Roster (with a note). Research exports include only students who
          consented unless you export pseudonymized data for all.
        </p>
        <PrivacyForm draft={draft} setDraft={setDraft} busy={busy} />
        {problem && <p className="error-text">{problem}</p>}
        <div className="work-actions">
          <button className="primary-button" disabled={busy || Boolean(problem)} onClick={() => onSave({ privacy: draft })}>
            <Save size={16} /> Save privacy settings
          </button>
        </div>
      </section>
      <section className="panel work-panel focused-panel">
        <h2 className="panel-heading">Retention</h2>
        <p>{retentionText(report)}</p>
        <p className="muted">Running retention anonymizes old events, AI chats, AI calls, drafts and generated items. Grades and submissions are kept.</p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="work-message" role="status">
            {message}
          </p>
        )}
        <button className="danger-button" disabled={working || !report?.retentionDays} onClick={() => setConfirmRetention(true)}>
          Run retention now
        </button>
      </section>
      <section className="panel work-panel focused-panel">
        <h2 className="panel-heading">Delete or anonymize one student</h2>
        <p className="muted">
          Anonymize replaces the student's id everywhere and removes their name and email from the roster and from the text that is kept (questions to the
          AI, answers, drafts, feedback); the content stays (recommended when grades must be kept). A name written another way, such as a first name alone,
          is not detected. Delete removes the student's records including submissions and grades. Both are recorded without student content and honored by
          Kiwi sync.
        </p>
        <div className="inline-form">
          <label className="work-label">
            Student ID
            <input value={target.studentId} onChange={(e) => setTarget({ ...target, studentId: e.target.value.trim() })} />
          </label>
          <label className="work-label">
            Mode
            <select value={target.mode} onChange={(e) => setTarget({ ...target, mode: e.target.value as "anonymize" | "delete" })}>
              <option value="anonymize">Anonymize (keep content)</option>
              <option value="delete">Delete student data</option>
            </select>
          </label>
          <button className="danger-button" disabled={working || !target.studentId} onClick={() => setConfirmDelete(true)}>
            {target.mode === "anonymize" ? "Anonymize student" : "Delete student data"}
          </button>
        </div>
      </section>
      <AuditLogPanel classId={classId} />
      <ConfirmDialog
        open={confirmRetention}
        title="Run retention?"
        confirmLabel="Run retention"
        danger
        requireText="RUN RETENTION"
        busy={working}
        onCancel={() => setConfirmRetention(false)}
        onConfirm={() =>
          void run(async () => {
            const r = await api.runRetention(classId, "RUN RETENTION");
            setConfirmRetention(false);
            return `Retention anonymized ${countText(r.counts)}.`;
          })
        }
      >
        {retentionText(report)}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDelete}
        title={target.mode === "anonymize" ? "Anonymize this student?" : "Delete this student's data?"}
        confirmLabel={target.mode === "anonymize" ? "Anonymize" : "Delete"}
        danger
        requireText={target.studentId}
        busy={working}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() =>
          void run(async () => {
            const r = await api.deleteStudentData(classId, target.studentId, { mode: target.mode, confirm: target.studentId });
            setConfirmDelete(false);
            setTarget({ ...target, studentId: "" });
            return `${target.mode === "anonymize" ? "Anonymized" : "Deleted"}: ${countText(r.counts)}.`;
          })
        }
      >
        This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
