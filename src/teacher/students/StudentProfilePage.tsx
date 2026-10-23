import { useEffect, useState } from "react";
import { Download, GraduationCap, History, MessageSquare } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { StatusBadge, type BadgeTone } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { downloadBlob } from "../../lib/csv";
import { formatDateTime, formatDue, formatPercent, formatRelative } from "../../lib/format";
import { LABELS } from "../../lib/labels";
import { cellLineageNote } from "../grading/gradebookCells";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import { consentLabel, groupSummary } from "./RosterPage";
import type { GradebookCell, Permission, StudentProfile } from "../../types";

/*
 * Student profile [F08, PEOPLE-01/22, TH09]: header (Last seen · Last learning action · Missing · Avg), assignments with grading and timeline
 * links, recent errors, recent AI questions, practice by chapter. Viewers see neither grading links nor the case file.
 */

export function profileHeaderText(header: StudentProfile["header"], now: number = Date.now()): string {
  // B-m01: last seen (any event) next to the last learning action, the two stamps of the roster and Needs attention
  const parts = [`${LABELS.lastSeen} ${header.lastActive ? formatRelative(header.lastActive, now) : "never"}`,
    `${LABELS.lastLearningAction} ${header.lastLearningAction ? formatRelative(header.lastLearningAction, now) : "none yet"}`,
    `Missing ${header.missing}`];
  if (header.late) parts.push(`Late ${header.late}`);
  parts.push(`Avg ${header.avgScorePct === null ? "—" : formatPercent(header.avgScorePct)}`);
  return parts.join(" · ");
}

export function cellTone(cell: GradebookCell): BadgeTone {
  if (cell.state === "missing") return "danger";
  if (cell.state === "released") return "success";
  if (cell.state === "draft" || cell.state === "submitted_ungraded" || cell.state === "newer_ungraded") return "info";
  return "neutral";
}

/** Which profile actions this staff member gets (PEOPLE-22). */
export function profileActions(profile: Pick<StudentProfile, "canExportConversations">, permissions: readonly Permission[]) {
  const grade = permissions.includes("grade");
  return {
    timeline: true,
    exportConversations: profile.canExportConversations,
    caseFile: grade && permissions.includes("exportActivity"),
    gradeSubmissions: grade,
  };
}

export function gradeStudentPath(studentId: string): string {
  return teacherPaths.grading({ studentId, show: "all" });
}

/** A purpose prompt for exports of one student (5–500 characters, logged with the export). */
export function PurposeDialogView({ title, purpose, busy, onPurpose, onConfirm, onCancel }: {
  title: string; purpose: string; busy: boolean; onPurpose: (v: string) => void; onConfirm: () => void; onCancel: () => void;
}) {
  const ok = purpose.trim().length >= 5 && purpose.trim().length <= 500;
  return (
    <div className="dialog-backdrop">
      <div className="panel dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <label className="work-label">
          Purpose (required, logged with the export)
          <input value={purpose} maxLength={500} placeholder="Academic integrity review, case 12" onChange={(e) => onPurpose(e.target.value)} />
        </label>
        <p className="muted">This export contains the student's name. It is recorded in the course audit log.</p>
        <div className="work-actions dialog-actions">
          <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={busy || !ok} onClick={onConfirm}>
            {busy ? "Preparing…" : "Download"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function StudentProfileView({
  profile, permissions, onExportConversations, onCaseFile, hideId = false,
}: {
  /** Presentation mode hides the raw id (it can carry a name). */
  hideId?: boolean;
  profile: StudentProfile;
  permissions: readonly Permission[];
  onExportConversations: () => void;
  onCaseFile: () => void;
}) {
  const actions = profileActions(profile, permissions);
  const s = profile.student;
  return (
    <>
      <section className="panel work-panel profile-header">
        <p className="profile-summary">
          <strong>{profileHeaderText(profile.header)}</strong>
        </p>
        <p className="muted">
          {hideId ? "" : <>ID <span className="mono">{s.studentId}</span> · </>}
          {s.pseudonym} · Group {groupSummary(s.groups)} · {LABELS.researchConsent}:{" "}
          {consentLabel(s.consent)}
          {s.status === "dropped" ? " · Dropped" : ""}
          {s.excluded ? " · Excluded from analytics" : ""}
        </p>
        <div className="work-actions">
          <a className="outline-button" href={profile.fullTimelineUrl} onClick={(e) => (e.preventDefault(), navigate(profile.fullTimelineUrl))}>
            <History size={15} /> {LABELS.fullActivityTimeline}
          </a>
          {actions.gradeSubmissions && (
            <a className="outline-button" href={gradeStudentPath(s.studentId)} onClick={(e) => (e.preventDefault(), navigate(gradeStudentPath(s.studentId)))}>
              <GraduationCap size={15} /> Grade this student's submissions
            </a>
          )}
          {actions.exportConversations && (
            <button className="outline-button" onClick={onExportConversations}>
              <MessageSquare size={15} /> {LABELS.exportStudentConversations}
            </button>
          )}
          {actions.caseFile && (
            <button className="outline-button" onClick={onCaseFile}>
              <Download size={15} /> {LABELS.downloadCaseFile}
            </button>
          )}
        </div>
      </section>
      <section className="panel work-panel">
        <h2 className="panel-heading">Assignments</h2>
        {profile.assignments.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Assignment</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Attempts</th>
                  <th>Late</th>
                  <th>Links</th>
                </tr>
              </thead>
              <tbody>
                {profile.assignments.map((a) => (
                  <tr key={a.assignmentId}>
                    <td>{a.title}</td>
                    <td>{a.dueAt ? formatDue(a.dueAt, Date.now(), undefined, { zone: true }) : "No due date"}</td>
                    <td>
                      <StatusBadge tone={cellTone(a.cell)} title={cellLineageNote(a.cell) || undefined}>{a.cell.label}</StatusBadge>
                    </td>
                    <td>{a.cell.score === null ? "—" : `${a.cell.score}/${a.cell.maxPoints}`}</td>
                    <td>{a.cell.attempts}</td>
                    <td>{a.cell.late ? "Late" : "—"}</td>
                    <td className="row-actions">
                      <a href={a.timelineUrl} onClick={(e) => (e.preventDefault(), navigate(a.timelineUrl))}>
                        Timeline
                      </a>
                      {a.gradingUrl && (
                        <a href={a.gradingUrl} onClick={(e) => (e.preventDefault(), navigate(a.gradingUrl as string))}>
                          Grade
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No published homework for this student yet.</EmptyState>
        )}
      </section>
      <div className="profile-grid">
        <section className="panel work-panel">
          <h2 className="panel-heading">Recent errors</h2>
          {profile.recentErrors.length ? (
            <ul className="link-list">
              {profile.recentErrors.map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <a href={e.href} onClick={(ev) => (ev.preventDefault(), navigate(e.href))}>
                    {e.questionLabel}
                  </a>{" "}
                  <small className="muted">{formatDateTime(e.at)}</small>
                  <code className="block">{e.error}</code>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>No R errors recorded.</EmptyState>
          )}
        </section>
        <section className="panel work-panel">
          <h2 className="panel-heading">Recent AI questions</h2>
          {profile.recentAiQuestions.length ? (
            <ul className="link-list">
              {profile.recentAiQuestions.map((q, i) => {
                const href = teacherPaths.aiConversations({ mode: "coding", thread: q.threadKey });
                return (
                  <li key={`${q.at}-${i}`}>
                    <StatusBadge tone="info">{q.where === "lab" ? LABELS.labAiTutor : LABELS.kiwiLectureAi}</StatusBadge>{" "}
                    {q.flagged && <StatusBadge tone="warning">Flagged</StatusBadge>}{" "}
                    <a href={href} onClick={(e) => (e.preventDefault(), navigate(href))}>
                      {q.prompt || "(empty prompt)"}
                    </a>{" "}
                    <small className="muted">{formatDateTime(q.at)}</small>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState>No AI questions yet.</EmptyState>
          )}
        </section>
      </div>
      <section className="panel work-panel">
        <h2 className="panel-heading">Practice by chapter</h2>
        {profile.practiceByChapter.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Chapter</th>
                  <th>{LABELS.freePracticeAi}</th>
                  <th>{LABELS.similarPracticeAi}</th>
                  <th>Auto-checked accuracy</th>
                  <th>Active minutes</th>
                </tr>
              </thead>
              <tbody>
                {profile.practiceByChapter.map((p) => (
                  <tr key={p.unitId}>
                    <td>{p.title}</td>
                    <td>{p.freeItems}</td>
                    <td>{p.similarItems}</td>
                    <td>{formatPercent(p.serverAccuracy)}</td>
                    <td>{p.activeMinutes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState>No practice recorded in this time range.</EmptyState>
        )}
      </section>
    </>
  );
}

export function StudentProfilePage({ params }: TeacherPageProps) {
  const { classId, me, nameMode, timeRange } = useTeacher();
  const studentId = params.studentId || "";
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState<null | "conversations" | "caseFile">(null);
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setProfile(null);
    api
      .studentProfile(classId, studentId, { from: timeRange.from ?? undefined, to: timeRange.to ?? undefined })
      .then((p) => {
        if (active) setProfile(p);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [classId, studentId, nameMode, timeRange.from, timeRange.to]);
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      const path = prompt === "caseFile" ? `student/${studentId}.zip` : "ai-conversations.csv";
      const file = await api.downloadExport(classId, path, prompt === "caseFile" ? { purpose: purpose.trim() } : { studentId, purpose: purpose.trim() });
      downloadBlob(file.blob, file.filename);
      setPrompt(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title={profile ? profile.student.studentName : "Student profile"} meta={timeRange.label} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!profile && !error && <p className="muted">Loading…</p>}
      {profile && (
        <StudentProfileView
          profile={profile}
          permissions={me.permissions}
          hideId={nameMode === "pseudonyms"}
          onExportConversations={() => setPrompt("conversations")}
          onCaseFile={() => setPrompt("caseFile")}
        />
      )}
      {prompt && (
        <PurposeDialogView
          title={prompt === "caseFile" ? LABELS.downloadCaseFile : LABELS.exportStudentConversations}
          purpose={purpose}
          busy={busy}
          onPurpose={setPurpose}
          onConfirm={() => void download()}
          onCancel={() => setPrompt(null)}
        />
      )}
    </>
  );
}
