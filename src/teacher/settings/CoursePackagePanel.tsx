import { useEffect, useState } from "react";
import { Download, PackageOpen } from "lucide-react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { StatusBadge, type BadgeTone } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { loadStaffCourse } from "../shell/TeacherContext";
import { downloadBlob } from "../../lib/csv";
import { formatDue } from "../../lib/format";
import type { Course, CoursePackageImportResult, CourseTemplate } from "../../types";

/*
 * Course package [F13, AU-D1-20, PEOPLE-11/21, §14.7]: download this course's design (no student data); import a package
 * (assignments arrive as drafts with dates shifted) or start from a template (chapters with allowlisted packages).
 * Always preview first; nothing is overwritten or published.
 */

type Chapter = CoursePackageImportResult["chapters"][number] & { packages?: string[]; week?: number | null };

/** S-m11: Apply asks first when it would archive chapters. */
export function applyConfirmText(result: CoursePackageImportResult): string | null {
  const archived = result.chapters.filter((c) => c.action === "archive");
  if (!archived.length) return null;
  const added = result.chapters.filter((c) => c.action === "add").length;
  const names = archived.map((c) => c.title).join(", ");
  return `This adds ${added} ${added === 1 ? "chapter" : "chapters"} and archives ${archived.length} (hidden from students, nothing is deleted): ${names}.`;
}

/**
 * One "Start from a template" choice (B-m04): the radio and one text block (title · chapters, description) side by side
 * with a gap; `.radio-label.block` keeps the label's flex layout over `.block`.
 */
export function TemplateOption({ template, checked, onSelect }: { template: CourseTemplate; checked: boolean; onSelect: () => void }) {
  return (
    <label className="radio-label block">
      <input type="radio" name="package-source" checked={checked} onChange={onSelect} />
      <span className="radio-label-text">
        <strong>{template.title}</strong> · {template.chapters} chapters
        <small className="muted block">{template.description}</small>
      </span>
    </label>
  );
}

export function actionTone(action: string): BadgeTone {
  return action === "add" ? "success" : action === "archive" ? "warning" : "neutral";
}

/** "12 chapters to add · 4 to archive · …" in a preview; "12 chapters added · 4 archived · …" once applied (RV6-m10). */
export function importSummary(result: CoursePackageImportResult): string {
  const count = (items: { action: string }[], action: string) => items.filter((i) => i.action === action).length;
  const applied = result.mode === "apply";
  const chapters = count(result.chapters, "add");
  const parts = [
    `${chapters} ${chapters === 1 ? "chapter" : "chapters"} ${applied ? "added" : "to add"}`,
    `${count(result.chapters, "archive")} ${applied ? "archived" : "to archive"}`,
    `${count(result.assignments, "add")} draft assignments`,
    `${count(result.policies, "add")} AI rule versions`,
    `${result.files} files`,
  ];
  return parts.join(" · ");
}

export function ImportResultView({ result }: { result: CoursePackageImportResult }) {
  const dated = result.chapters.some((c) => c.startsOn);
  const weeks = (result.chapters as Chapter[]).some((c) => typeof c.week === "number");
  return (
    <div className="package-result">
      <p className="work-message" role="status">
        {result.mode === "apply" ? "Imported: " : "Preview — nothing saved yet: "}
        {importSummary(result)}
      </p>
      {result.warnings.length > 0 && (
        <ul className="warning-list">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {weeks && <th>Week</th>}
              <th className="package-chapter-col">Chapter</th>
              <th>Action</th>
              {dated && <th>Starts</th>}
              <th>R packages</th>
            </tr>
          </thead>
          <tbody>
            {(result.chapters as Chapter[]).map((c) => (
              <tr key={`${c.id}-${c.action}`}>
                {weeks && <td>{typeof c.week === "number" ? c.week : "—"}</td>}
                <td className="package-chapter-col">
                  {c.title}
                  {/* Template notes (decision D4): R sessions, inferred pairings, packages to run locally. */}
                  {c.notes && c.notes.length > 0 && (
                    <ul className="package-notes muted">
                      {c.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>
                  <StatusBadge tone={actionTone(c.action)}>{c.action}</StatusBadge>
                </td>
                {dated && <td>{c.startsOn || "—"}</td>}
                <td>{c.packages?.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.assignments.length > 0 && (
        <ul className="link-list">
          {result.assignments.map((a, i) => (
            <li key={`${a.title}-${i}`}>
              <StatusBadge tone={actionTone(a.action)}>{a.action === "add" ? "draft" : a.action}</StatusBadge> {a.title}
              {a.dueAt ? ` · ${formatDue(a.dueAt, Date.now(), undefined, { zone: true })}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function CoursePackagePanel({ classId, setCourse }: { classId: string; setCourse: (c: Course) => void }) {
  const [templates, setTemplates] = useState<CourseTemplate[]>([]);
  const [source, setSource] = useState<{ kind: "template"; key: string } | { kind: "file"; name: string; data: string } | null>(null);
  const [shiftWeeks, setShiftWeeks] = useState(0);
  const [archiveDefaults, setArchiveDefaults] = useState(false);
  const [result, setResult] = useState<CoursePackageImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmApply, setConfirmApply] = useState(false);
  useEffect(() => {
    api.courseTemplates(classId).then(setTemplates).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [classId]);
  const run = async (mode: "preview" | "apply") => {
    if (!source) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        ...(source.kind === "template" ? { templateKey: source.key } : { zipBase64: source.data }),
        mode,
        shiftWeeks,
        archiveUnreferencedDefaults: archiveDefaults,
      };
      const r = await api.importCoursePackage(classId, body);
      setResult(r);
      if (mode === "apply") setCourse(await loadStaffCourse(classId));   // R-B01: the staff view, with archived chapters and notes
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel work-panel focused-panel">
      <h2 className="panel-heading">Course package</h2>
      <div className="work-actions">
        <button
          className="outline-button"
          disabled={busy}
          onClick={() =>
            void api
              .coursePackage(classId)
              .then((f) => downloadBlob(f.blob, f.filename))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          }
        >
          <Download size={15} /> Download course package
        </button>
      </div>
      <p className="muted">Chapters, assignments, AI tutor rules, group names and course files — no student data.</p>
      <h3>Start from a template</h3>
      {templates.map((t) => (
        <TemplateOption key={t.key} template={t} checked={source?.kind === "template" && source.key === t.key}
          onSelect={() => {
            setSource({ kind: "template", key: t.key });
            setResult(null);
          }} />
      ))}
      <h3>Import a course package</h3>
      <label className="outline-button file-picker">
        <PackageOpen size={15} /> Choose .zip
        <input
          type="file"
          accept=".zip,application/zip"
          aria-label="Choose course package"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void file
              .arrayBuffer()
              .then((buffer) => {
                setSource({ kind: "file", name: file.name, data: toBase64(buffer) });
                setResult(null);
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
          }}
        />
      </label>
      {source?.kind === "file" && <p className="muted">Selected: {source.name}</p>}
      <div className="inline-form">
        <label className="work-label">
          Shift dates by weeks
          <input type="number" min={-52} max={52} value={shiftWeeks} onChange={(e) => setShiftWeeks(Number(e.target.value) || 0)} />
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={archiveDefaults} onChange={(e) => setArchiveDefaults(e.target.checked)} />
          Archive current chapters that nothing refers to
        </label>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="work-actions">
        <button className="outline-button" disabled={busy || !source} onClick={() => void run("preview")}>
          Preview
        </button>
        <button className="primary-button" disabled={busy || !source || result?.mode !== "preview"}
          onClick={() => (result && applyConfirmText(result) ? setConfirmApply(true) : void run("apply"))}>
          Apply
        </button>
      </div>
      {result && <ImportResultView result={result} />}
      <ConfirmDialog
        open={confirmApply}
        title="Apply and archive chapters?"
        confirmLabel="Apply"
        busy={busy}
        onCancel={() => setConfirmApply(false)}
        onConfirm={() => {
          setConfirmApply(false);
          void run("apply");
        }}
      >
        {result ? applyConfirmText(result) : null}
      </ConfirmDialog>
    </section>
  );
}
