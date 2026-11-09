import { useEffect, useState } from "react";
import { Download, FileArchive, FileText } from "lucide-react";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { exportQuery } from "../../components/ExportMenu";
import { api } from "../../lib/api";
import { downloadBlob } from "../../lib/csv";
import { LABELS } from "../../lib/labels";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { CourseSettings, Group, Me, Permission } from "../../types";

/*
 * Exports [DA12, TH11, PEOPLE-06/07/15/19, NM19]: teaching exports (grades for the LMS, status, activity log, AI
 * conversations, generated practice, coded conversations) and the research package with codebook. Every export honors
 * the top-bar time range, chapters and groups; viewers always get pseudonymized, consented-only files (server-enforced).
 */

export interface ExportEntry { id: string; label: string; description: string; formats: readonly ("csv" | "jsonl" | "zip" | "md")[]; path: (fmt: string) => string; permission: Permission | null }

export const EXPORT_ENTRIES: readonly ExportEntry[] = [
  { id: "grades", label: LABELS.gradesForLms, description: "One row per student with scores, late flags and feedback (released grades by default).", formats: ["csv"], path: () => "grades.csv", permission: "exportGrades" },
  { id: "status", label: LABELS.studentAssignmentStatusCsv, description: "Who submitted, started, is missing or late, per assignment.", formats: ["csv"], path: () => "assignment-status.csv", permission: "exportGrades" },
  { id: "activity", label: LABELS.activityLog, description: "Every recorded event with attribution, groups at event time and payload.", formats: ["csv", "jsonl"], path: (f) => `activity.${f}`, permission: "exportActivity" },
  { id: "conversations", label: LABELS.aiConversations, description: "Lab AI tutor and Kiwi lecture AI turns with provenance, guard status and codes.", formats: ["csv", "jsonl"], path: (f) => `ai-conversations.${f}`, permission: "exportActivity" },
  { id: "items", label: LABELS.generatedPracticeItems, description: "AI-generated practice with the full item, verification and attempts.", formats: ["csv", "jsonl"], path: (f) => `generated-items.${f}`, permission: "exportActivity" },
  { id: "codes", label: LABELS.codedConversationsCsv, description: "Qualitative codes applied to AI conversations.", formats: ["csv"], path: () => "conversation-codes.csv", permission: "exportActivity" },
  { id: "research", label: LABELS.researchPackage, description: "Zip with README, codebook, manifest, participants, events, AI turns and calls, group history, submissions.", formats: ["zip"], path: () => "research-package.zip", permission: "exportResearch" },
  { id: "codebook", label: "Codebook", description: "Event types, columns and metric formulas (Markdown).", formats: ["md"], path: () => "codebook.md", permission: null },
];

export function visibleExports(me: Pick<Me, "permissions">): ExportEntry[] {
  return EXPORT_ENTRIES.filter((e) => e.permission === null || me.permissions.includes(e.permission));
}

export interface ExportOptions {
  useRange: boolean; unitIds: string[]; groupIds: string[]; pseudonymize: boolean; consent: "all" | "yes"; purpose: string;
  allowUnverified: boolean; includeRaw: boolean;
  /** research package only (review 2, TEACHER-04; spec §13.6 defaults pseudonymize=1, consent=yes), independent of the
   * teaching exports' filter above */
  researchPseudonymize: boolean; researchConsent: "all" | "yes";
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  useRange: false, unitIds: [], groupIds: [], pseudonymize: false, consent: "all", purpose: "", allowUnverified: false, includeRaw: false,
  researchPseudonymize: true, researchConsent: "yes",
};

/** Query sent for one export; research defaults (pseudonymize=1, consent=yes) come from the options. */
export function exportParams(entry: ExportEntry, opts: ExportOptions, range: { from: string | null; to: string | null }, forced: boolean): Record<string, string> {
  const base: Record<string, string | boolean | readonly string[] | undefined> = {
    from: opts.useRange ? range.from ?? undefined : undefined,
    to: opts.useRange ? range.to ?? undefined : undefined,
    unitIds: opts.unitIds,
    groupIds: opts.groupIds,
  };
  if (entry.id === "grades" || entry.id === "status") {
    return exportQuery({ assignmentIds: undefined, groupIds: opts.groupIds, ...(entry.id === "status" ? { pseudonymize: opts.pseudonymize || forced } : {}) });
  }
  if (entry.id === "codebook") return {};
  const purpose = opts.purpose.trim() || undefined;
  if (entry.id === "research")
    return exportQuery({ ...base, pseudonymize: opts.researchPseudonymize || forced, consent: forced ? "yes" : opts.researchConsent, purpose,
      allowUnverified: opts.allowUnverified || undefined, includeRaw: opts.includeRaw || undefined });
  return exportQuery({ ...base, pseudonymize: opts.pseudonymize || forced, consent: forced ? "yes" : opts.consent, purpose });
}

/** One-line summary shown on the collapsed filter panel. */
export function filterSummary(opts: ExportOptions, rangeLabel: string, forced: boolean, chapterCount: number): string {
  return [
    opts.useRange ? rangeLabel : "whole term",
    opts.unitIds.length ? `${opts.unitIds.length} of ${chapterCount} chapters` : "all chapters",
    opts.groupIds.length ? `${opts.groupIds.length} groups` : "all groups",
    opts.pseudonymize || forced ? "pseudonymized" : "with names",
    forced || opts.consent === "yes" ? "consented students only" : "all students",
  ].join(" · ");
}

/**
 * Viewer and researcher exports include Kiwi-verified identities only (decision D3, RV6-M07): in a standalone (demo)
 * course every data export is refused by the server, so the buttons say why instead of failing.
 */
export const UNVERIFIED_ROLE_NOTE = "This course is not linked to Kiwi, so student identities are not verified. Exports for your role include Kiwi-verified students only, so only the codebook is available here.";
export function exportUnavailable(entry: Pick<ExportEntry, "id">, me: Pick<Me, "exportsForcedPseudonymous" | "classLinked">): boolean {
  return me.exportsForcedPseudonymous && !me.classLinked && entry.id !== "codebook";
}

export function researchProblem(opts: ExportOptions, forced: boolean): string {
  if (opts.purpose.trim().length < 5) return "Every research package needs a purpose (5–500 characters).";
  if (!forced && opts.researchConsent === "all" && !opts.researchPseudonymize) return "Students without research consent can only be exported pseudonymized.";
  return "";
}

export function ExportsView({
  me, opts, rangeLabel, units, groups, busy, onOpts, onDownload,
}: {
  me: Me;
  opts: ExportOptions;
  rangeLabel: string;
  units: { id: string; title: string }[];
  groups: Group[];
  busy: string;
  onOpts: (o: ExportOptions) => void;
  onDownload: (entry: ExportEntry, fmt: string) => void;
}) {
  const forced = me.exportsForcedPseudonymous;
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <>
      <details className="panel work-panel exports-filter-panel">
        <summary>
          <strong>{forced ? "Filters for your exports:" : "Filters for the teaching exports:"}</strong> {filterSummary(opts, rangeLabel, forced, units.length)}
        </summary>
        <div className="exports-filters">
        <label className="checkbox-label">
          <input type="checkbox" checked={opts.useRange} onChange={(e) => onOpts({ ...opts, useRange: e.target.checked })} />
          Only the top-bar time range ({rangeLabel}); off = whole term
        </label>
        <fieldset className="checkbox-row">
          <legend>Chapters</legend>
          {units.map((u) => (
            <label key={u.id} className="checkbox-label">
              <input type="checkbox" checked={opts.unitIds.includes(u.id)} onChange={() => onOpts({ ...opts, unitIds: toggle(opts.unitIds, u.id) })} />
              {u.title}
            </label>
          ))}
        </fieldset>
        {groups.length > 0 && (
          <fieldset className="checkbox-row">
            <legend>Groups</legend>
            {groups.map((g) => (
              <label key={g.id} className="checkbox-label">
                <input type="checkbox" checked={opts.groupIds.includes(g.id)} onChange={() => onOpts({ ...opts, groupIds: toggle(opts.groupIds, g.id) })} />
                {g.name}
              </label>
            ))}
          </fieldset>
        )}
        <label className="checkbox-label">
          <input type="checkbox" checked={opts.pseudonymize || forced} disabled={forced} onChange={(e) => onOpts({ ...opts, pseudonymize: e.target.checked })} />
          Pseudonymize (research ids instead of names and emails)
        </label>
        <label className="work-label">
          {LABELS.researchConsent}
          <select value={forced ? "yes" : opts.consent} disabled={forced} onChange={(e) => onOpts({ ...opts, consent: e.target.value as ExportOptions["consent"] })}>
            <option value="all">All students (teaching use)</option>
            <option value="yes">Only students who consented</option>
          </select>
        </label>
        <label className="work-label">
          Purpose (required for the research package and for exports of one student; logged)
          <input value={opts.purpose} maxLength={500} onChange={(e) => onOpts({ ...opts, purpose: e.target.value })} />
        </label>
        </div>
      </details>
      {forced && (
        <p className="muted" role="note">
          Your {me.role === "researcher" ? "researcher" : "viewer"} role gets de-identified exports only: files are pseudonymized and include only students who consented and whose identity Kiwi verified.
        </p>
      )}
      {forced && !me.classLinked && (
        <p className="muted" role="note">
          {UNVERIFIED_ROLE_NOTE}
        </p>
      )}
      <section className="panel work-panel">
        <h2 className="panel-heading">Exports</h2>
        <ul className="export-list">
          {visibleExports(me).map((entry) => (
            <li key={entry.id} className="export-row">
              <div>
                <strong>{entry.label}</strong>
                <p className="muted">{entry.description}</p>
                {entry.id === "research" && (
                  <div className="checkbox-row">
                    <label className="checkbox-label">
                      <input type="checkbox" checked={opts.researchPseudonymize || forced} disabled={forced}
                        onChange={(e) => onOpts({ ...opts, researchPseudonymize: e.target.checked })} />
                      Pseudonymize (research ids)
                    </label>
                    <label className="checkbox-label">
                      {LABELS.researchConsent}{" "}
                      <select value={forced ? "yes" : opts.researchConsent} disabled={forced} aria-label="Students in the research package"
                        onChange={(e) => onOpts({ ...opts, researchConsent: e.target.value as ExportOptions["researchConsent"] })}>
                        <option value="yes">Only students who consented</option>
                        <option value="all">All students (pseudonymized)</option>
                      </select>
                    </label>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={opts.allowUnverified} disabled={forced} onChange={(e) => onOpts({ ...opts, allowUnverified: e.target.checked })} />
                      Include unverified (demo) identities
                    </label>
                    {me.role === "instructor" && (
                      <label className="checkbox-label">
                        <input type="checkbox" checked={opts.includeRaw} onChange={(e) => onOpts({ ...opts, includeRaw: e.target.checked })} />
                        Include AI instructions sent and original replies
                      </label>
                    )}
                    {researchProblem(opts, forced) && <small className="muted block">{researchProblem(opts, forced)}</small>}
                  </div>
                )}
              </div>
              <div className="work-actions">
                {entry.formats.map((fmt) => (
                  <button
                    key={fmt}
                    className="outline-button"
                    disabled={Boolean(busy) || exportUnavailable(entry, me) || (entry.id === "research" && Boolean(researchProblem(opts, forced)))}
                    aria-label={`Download ${entry.label} as ${fmt.toUpperCase()}`}
                    onClick={() => onDownload(entry, fmt)}
                  >
                    {fmt === "zip" ? <FileArchive size={15} /> : fmt === "md" ? <FileText size={15} /> : <Download size={15} />} {busy === `${entry.id}.${fmt}` ? "Preparing…" : fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function ExportsPage(_props: TeacherPageProps) {
  const { classId, me, course, timeRange } = useTeacher();
  const [groups, setGroups] = useState<Group[]>([]);
  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    api.groups(classId).then(setGroups).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    api
      .settings(classId)
      .then((s: CourseSettings) => setOpts((o) => (o.purpose ? o : { ...o, purpose: s.privacy.researchPurpose })))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [classId]);
  const download = async (entry: ExportEntry, fmt: string) => {
    setBusy(`${entry.id}.${fmt}`);
    setError("");
    setMessage("");
    try {
      const file = await api.downloadExport(classId, entry.path(fmt), exportParams(entry, opts, timeRange, me.exportsForcedPseudonymous));
      downloadBlob(file.blob, file.filename);
      setMessage(`${entry.label} downloaded (${file.filename}).`);
    } catch (e) {
      setError(`${entry.label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <PageHeader title="Exports" tabs={<SectionTabs section="insights" />} />
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
      <ExportsView
        me={me}
        opts={opts}
        rangeLabel={timeRange.label}
        units={(course?.units ?? []).map((u) => ({ id: u.id, title: u.title }))}
        groups={groups}
        busy={busy}
        onOpts={setOpts}
        onDownload={(entry, fmt) => void download(entry, fmt)}
      />
    </>
  );
}
