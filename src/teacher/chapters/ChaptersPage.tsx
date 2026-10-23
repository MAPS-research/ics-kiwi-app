import { useCallback, useEffect, useState, type LiHTMLAttributes } from "react";
import { Archive, ArrowDown, ArrowUp, GripVertical, Pencil, Plus, Save, Trash2, Undo2 } from "lucide-react";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { newUnit, normalizeCourse, removedUnitIds, toCourseInput } from "../../lib/course";
import { LABELS, pluralize } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { WEBR_PACKAGE_ALLOWLIST } from "../../lib/webrPackages";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { Course, CourseInput, FileMeta, Unit, UnitAccess } from "../../types";
import {
  ACCESS_OPTIONS, AI_REFERENCE_OFF_NOTE, aiReferenceMessage, canonicalJson, canUseAsAiReference, chapterNumber, chapterRuleLink, effectiveAccessLabel, formatBytes,
  moveUnit, moveUnitTo, SCOPE_OPTIONS, thisWeekToast, toggleDataset, togglePackage, type ChapterSummary, type ChapterSummaryUnit,
} from "./policyForm";

/*
 * Chapters (/teacher/chapters) [LY03, NM43, F03, TH03, TH13, AU-D1-M04, AU-D1-17]. "This week's chapter" saves on select;
 * everything else (free practice scope, order, weeks, titles, goals, student access, R packages, datasets, error hints)
 * is saved with "Save chapters" through PUT /api/course. Chapters with assignments, activity or materials can only be
 * archived (Student access: Hidden). Chapter files marked "Use as AI reference" toggle immediately (PATCH /api/teacher/files).
 * Read-only without manageCourse (§3.1).
 * S-M05: chapter notes and course-template metadata are shown read-only; editing the notes is an explicit step.
 * R-B01: the page holds the staff course (TeacherApp loads it); a save names removed chapters (`removeUnitIds`).
 */

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

/** Toggle a chapter file's AI-reference flag (ASSESS files API) [AIRULES-12]. */
export function toggleAiReference(classId: string, file: Pick<FileMeta, "id">, aiReference: boolean): Promise<FileMeta> {
  return api.updateFile(classId, file.id, { aiReference });
}
/** GET /api/teacher/chapters/summary (AIRULES convenience endpoint; typed by CR-AIRULES-1). */
export function loadChapterSummary(classId: string): Promise<ChapterSummary> {
  return api.chaptersSummary(classId);
}
/** Unsaved edits on the Chapters page (ignores derived fields and the stale-check timestamp). */
export function chaptersDirty(draft: Course, saved: Course): boolean {
  // WHY view dropped: this only compares two versions in memory; toCourseInput refuses to build a save from a student view.
  const strip = (c: Course) => {
    const input = toCourseInput({ ...c, view: undefined });
    return { ...input, baseUpdatedAt: null, units: input.units.map((u) => ({ ...u, status: undefined })) };
  };
  return canonicalJson(strip(draft)) !== canonicalJson(strip(saved));
}
/** PUT /api/course body of "Save chapters": removed chapters are named, so the server keeps archived ones it was not sent (R-B01). */
export function chaptersSaveInput(draft: Course, saved: Course): CourseInput {
  return toCourseInput(draft, { removeUnitIds: removedUnitIds(saved, draft) });
}
/** S-M05: one line per course-template fact (R sessions, packages to run locally, live-API packages). */
export function templateSummary(unit: Pick<Unit, "rSessions" | "runLocally" | "liveApi">): string[] {
  const lines: string[] = [];
  if (unit.rSessions?.length) lines.push(`R sessions: ${unit.rSessions.map((r) => `${r.id} · ${r.title}`).join(", ")}`);
  if (unit.runLocally?.length) lines.push(`Run locally: ${unit.runLocally.join(", ")}`);
  if (unit.liveApi?.length) lines.push(`Live API steps (use the provided data): ${unit.liveApi.join(", ")}`);
  return lines;
}

/** S-M05: the chapter's notes (staff only) as text; "Edit notes" opens the text box for instructors. */
function ChapterNotes({ unit, number, readOnly, busy, onNotes }: {
  unit: Unit; number: string; readOnly: boolean; busy: boolean; onNotes: (notes: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const notes = unit.notes ?? "";
  const lines = notes.split("\n").map((line) => line.trim()).filter(Boolean);
  const template = templateSummary(unit);
  return (
    <section className="airules-notes" aria-label={`Chapter ${number} notes (staff only)`}>
      <div className="airules-notes-head">
        <h3>
          Chapter notes <span className="muted">(staff only)</span>
        </h3>
        {unit.pairing === "inferred" && <StatusBadge tone="warning">R-session pairing inferred</StatusBadge>}
        {!readOnly && !editing && (
          <button type="button" className="text-button" disabled={busy} aria-label={`${lines.length ? "Edit" : "Add"} notes for chapter ${number}`}
            onClick={() => setEditing(true)}>
            <Pencil size={14} aria-hidden="true" />
            {lines.length ? "Edit notes" : "Add notes"}
          </button>
        )}
      </div>
      {template.length > 0 && (
        <p className="airules-template muted">
          From the course template: {template.join(" · ")}
        </p>
      )}
      {editing ? (
        <textarea rows={Math.min(8, Math.max(3, notes.split("\n").length + 1))} maxLength={4000} value={notes} disabled={readOnly || busy}
          aria-label={`Notes for chapter ${number} (staff only)`} onChange={(e) => onNotes(e.target.value)} />
      ) : lines.length ? (
        <ul className="airules-notes-list">
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">No chapter notes yet.</p>
      )}
    </section>
  );
}
/** After "This week's chapter" saved: keep the teacher's unsaved edits, take the new current chapter and timestamp. */
export function mergeThisWeek(draft: Course, saved: Course): Course {
  const byId = new Map(saved.units.map((u) => [u.id, u]));
  return {
    ...draft,
    currentUnitId: saved.currentUnitId,
    updatedAt: saved.updatedAt,
    units: draft.units.map((u) => {
      const s = byId.get(u.id);
      return s ? { ...u, status: s.status, effectiveAccess: s.effectiveAccess } : u;
    }),
  };
}

function Link({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

export function ChapterCardView({
  unit, index, total, course, summary, readOnly, busy, onUnit, onMove, onRemove, onToggleAiReference, onUpload, dragHandlers,
  canOpenAssignments = true,
}: {
  unit: Unit;
  index: number;
  total: number;
  course: Course;
  summary: ChapterSummaryUnit | null;
  readOnly: boolean;
  busy: boolean;
  onUnit: (u: Unit) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onToggleAiReference: (file: FileMeta, value: boolean) => void;
  onUpload: (file: File) => void;
  dragHandlers?: Pick<LiHTMLAttributes<HTMLLIElement>, "draggable" | "onDragStart" | "onDragOver" | "onDrop">;
  /** roles without viewAssignments (viewer, researcher) see the count as text, not a link (§3.1) */
  canOpenAssignments?: boolean;
}) {
  const number = chapterNumber(course, unit.id);
  const dis = readOnly || busy;
  const files = summary?.files ?? [];
  const referenced = summary?.referenced ?? true; // WHY: unknown → assume referenced, so the safe action (archive) is offered
  const isCurrent = course.currentUnitId === unit.id;
  const hidden = unit.access === "hidden";
  const setRuntime = (patch: Partial<Unit["runtime"]>) => onUnit({ ...unit, runtime: { ...unit.runtime, ...patch } });
  return (
    <li className={`panel airules-chapter${hidden ? " is-archived" : ""}`} {...(readOnly ? {} : dragHandlers)}>
      <div className="airules-chapter-head">
        {!readOnly && <GripVertical size={16} className="airules-grip" aria-hidden="true" />}
        <span className="small-pill">Chapter {number}</span>
        {isCurrent && <StatusBadge tone="info">{LABELS.thisWeeksChapter}</StatusBadge>}
        <StatusBadge tone={unit.effectiveAccess === "open" ? "success" : "neutral"}>{hidden ? "Hidden from students" : effectiveAccessLabel(unit.effectiveAccess)}</StatusBadge>
        {!readOnly && (
          <span className="airules-chapter-move">
            <button type="button" className="icon-button" disabled={busy || index === 0} aria-label={`Move chapter ${number} up`} onClick={() => onMove(-1)}>
              <ArrowUp size={15} aria-hidden="true" />
            </button>
            <button type="button" className="icon-button" disabled={busy || index === total - 1} aria-label={`Move chapter ${number} down`} onClick={() => onMove(1)}>
              <ArrowDown size={15} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
      <div className="airules-chapter-fields">
        <label>
          Week
          <input type="number" min={1} max={60} value={unit.week ?? ""} disabled={dis} aria-label={`Week of chapter ${number}`}
            onChange={(e) => onUnit({ ...unit, week: e.target.value ? Number(e.target.value) : null })} />
        </label>
        <label>
          Chapter {number} title
          <input value={unit.title} maxLength={100} disabled={dis} aria-label={`Chapter ${number} title`} onChange={(e) => onUnit({ ...unit, title: e.target.value })} />
        </label>
        <label className="airules-wide">
          Learning goal
          <input value={unit.goal} maxLength={500} disabled={dis} aria-label={`Learning goal of chapter ${number}`} onChange={(e) => onUnit({ ...unit, goal: e.target.value })} />
        </label>
        <label>
          {LABELS.studentAccess}
          <select value={unit.access} disabled={dis} aria-label={`${LABELS.studentAccess} for chapter ${number}`}
            onChange={(e) => onUnit({ ...unit, access: e.target.value as UnitAccess })}>
            {ACCESS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* S-M05: template notes (R sessions, inferred pairings, run-locally packages, milestones) and the teacher's own */}
      <ChapterNotes unit={unit} number={number} readOnly={readOnly} busy={busy} onNotes={(notes) => onUnit({ ...unit, notes })} />
      <details className="airules-packages">
        <summary>R packages: {unit.runtime.packages.length ? unit.runtime.packages.join(", ") : "base R only"}</summary>
        <div className="policy-types">
          {WEBR_PACKAGE_ALLOWLIST.map((pkg) => (
            <label key={pkg}>
              <input type="checkbox" aria-label={`${pkg} for chapter ${number}`} checked={unit.runtime.packages.includes(pkg)} disabled={dis}
                onChange={(e) => setRuntime({ packages: togglePackage(unit.runtime.packages, pkg, e.target.checked) })} />
              {pkg}
            </label>
          ))}
        </div>
      </details>
      <div className="airules-files">
        <h3>Chapter files</h3>
        {files.length ? (
          <ul>
            {files.map((file) => (
              <li key={file.id}>
                <span className="airules-file-name">
                  {file.name} <span className="muted">· {formatBytes(file.size)}</span>
                </span>
                <label className="checkbox-label airules-check">
                  <input type="checkbox" checked={unit.runtime.datasetFileIds.includes(file.id)} disabled={dis} aria-label={`Use ${file.name} as a chapter dataset`}
                    onChange={(e) => setRuntime({ datasetFileIds: toggleDataset(unit.runtime.datasetFileIds, file.id, e.target.checked) })} />
                  Chapter dataset
                </label>
                {canUseAsAiReference(file.name) && (
                  <label className="checkbox-label airules-check">
                    <input type="checkbox" checked={file.aiReference} disabled={dis} aria-label={`Use ${file.name} as AI reference`}
                      onChange={(e) => onToggleAiReference(file, e.target.checked)} />
                    {LABELS.useAsAiReference}
                  </label>
                )}
                {file.aiReference && summary?.aiSeesMaterials === false && (
                  <small className="airules-file-note">
                    {AI_REFERENCE_OFF_NOTE}{" "}
                    <Link href={teacherPaths.aiRulesEditor(unit.id)}>Open AI tutor rules</Link>
                  </small>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No chapter files yet.</p>
        )}
        {!readOnly && (
          <label className="work-label airules-upload">
            Add a chapter file (csv, rds, txt, md, qmd, pdf, r, zip; up to 3 MB)
            <input type="file" disabled={busy} accept=".csv,.rds,.txt,.md,.qmd,.pdf,.r,.R,.zip"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(file);
                e.target.value = "";
              }} />
          </label>
        )}
      </div>
      <div className="airules-hints">
        <h3>Error hints</h3>
        {unit.runtime.errorHints.map((hint, i) => (
          <div className="airules-hint-row" key={i}>
            <input aria-label={`Error text to match, hint ${i + 1}`} placeholder="Error text, e.g. could not find function" value={hint.match} maxLength={200} disabled={dis}
              onChange={(e) => setRuntime({ errorHints: unit.runtime.errorHints.map((h, j) => (j === i ? { ...h, match: e.target.value } : h)) })} />
            <input aria-label={`Hint shown to students, hint ${i + 1}`} placeholder="Hint shown to students" value={hint.hint} maxLength={1000} disabled={dis}
              onChange={(e) => setRuntime({ errorHints: unit.runtime.errorHints.map((h, j) => (j === i ? { ...h, hint: e.target.value } : h)) })} />
            {!readOnly && (
              <button type="button" className="icon-button" aria-label={`Remove error hint ${i + 1}`} disabled={busy}
                onClick={() => setRuntime({ errorHints: unit.runtime.errorHints.filter((_, j) => j !== i) })}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          <button type="button" className="text-button" disabled={busy || unit.runtime.errorHints.length >= 20}
            onClick={() => setRuntime({ errorHints: [...unit.runtime.errorHints, { match: "", hint: "" }] })}>
            <Plus size={14} aria-hidden="true" />
            Add error hint
          </button>
        )}
        {!unit.runtime.errorHints.length && readOnly && <p className="muted">No chapter-specific error hints.</p>}
      </div>
      <p className="airules-links">
        {canOpenAssignments ? (
          <Link href={teacherPaths.assignments({ unitId: unit.id })}>{`Assignments (${summary?.assignments ?? 0})`}</Link>
        ) : (
          <span>{`Assignments (${summary?.assignments ?? 0})`}</span>
        )}
        {" · "}
        <Link href={teacherPaths.aiRulesEditor(unit.id)}>{chapterRuleLink(summary?.aiRules)}</Link>
        {" · "}
        <Link href={teacherPaths.lectureMaterials()}>{`Lecture materials (${summary?.lectureMaterials ?? 0})`}</Link>
        {" · "}
        <Link href={teacherPaths.activity({ group: "chapters", unitId: unit.id, range: "this_week" })}>Activity this week</Link>
      </p>
      {!readOnly && (
        <div className="work-actions">
          {hidden ? (
            <button type="button" className="outline-button" disabled={busy} onClick={() => onUnit({ ...unit, access: "default" })}>
              <Undo2 size={15} aria-hidden="true" />
              Unarchive chapter
            </button>
          ) : referenced || isCurrent ? (
            <button type="button" className="outline-button" disabled={busy || isCurrent} onClick={() => onUnit({ ...unit, access: "hidden" })}>
              <Archive size={15} aria-hidden="true" />
              Archive chapter
            </button>
          ) : (
            <button type="button" className="outline-button" disabled={busy || total === 1} onClick={onRemove}>
              <Trash2 size={15} aria-hidden="true" />
              Remove chapter
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function ChaptersView({
  draft, saved, summary, readOnly, busy, dirty, onDraft, onThisWeek, onSave, onToggleAiReference, onUpload, canOpenAssignments = true,
}: {
  draft: Course;
  saved: Course;
  summary: ChapterSummary | null;
  readOnly: boolean;
  busy: boolean;
  dirty: boolean;
  onDraft: (course: Course) => void;
  onThisWeek: (unitId: string) => void;
  onSave: () => void;
  onToggleAiReference: (file: FileMeta, value: boolean) => void;
  onUpload: (unitId: string, file: File) => void;
  canOpenAssignments?: boolean;
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const byUnit = new Map((summary?.units ?? []).map((u) => [u.unitId, u]));
  const current = saved.units.find((u) => u.id === saved.currentUnitId);
  const setUnit = (unit: Unit) => onDraft({ ...draft, units: draft.units.map((u) => (u.id === unit.id ? unit : u)) });
  return (
    <>
      <section className="panel work-panel airules-section airules-chapters-top" aria-label="Course pacing">
        {readOnly ? (
          <p className="airules-this-week">
            <strong>{LABELS.thisWeeksChapter}:</strong> {current ? current.title : "—"}
          </p>
        ) : (
          <label className="work-label airules-inline-label">
            {LABELS.thisWeeksChapter}
            <select value={saved.currentUnitId} disabled={busy} aria-label={LABELS.thisWeeksChapter} onChange={(e) => onThisWeek(e.target.value)}>
              {saved.units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="work-label airules-inline-label">
          {LABELS.freePracticeScope}
          <select value={draft.freePracticeScope} disabled={readOnly || busy} aria-label={LABELS.freePracticeScope}
            onChange={(e) => onDraft({ ...draft, freePracticeScope: e.target.value as Course["freePracticeScope"] })}>
            {SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          This week's chapter saves as soon as you pick it. Chapters after it show "{LABELS.opensLater}" to students when free practice is limited to current
          and earlier chapters; assigned work stays available.
        </p>
      </section>
      <ol className="airules-chapter-list" aria-label="Chapters">
        {draft.units.map((unit, index) => (
          <ChapterCardView
            key={unit.id}
            unit={unit}
            index={index}
            total={draft.units.length}
            course={draft}
            summary={byUnit.get(unit.id) ?? null}
            readOnly={readOnly}
            canOpenAssignments={canOpenAssignments}
            busy={busy}
            onUnit={setUnit}
            onMove={(delta) => onDraft({ ...draft, units: moveUnit(draft.units, index, delta) })}
            onRemove={() => onDraft({ ...draft, units: draft.units.filter((u) => u.id !== unit.id) })}
            onToggleAiReference={onToggleAiReference}
            onUpload={(file) => onUpload(unit.id, file)}
            dragHandlers={{
              draggable: true,
              onDragStart: () => setDragFrom(index),
              onDragOver: (e) => e.preventDefault(),
              onDrop: () => {
                if (dragFrom !== null && dragFrom !== index) onDraft({ ...draft, units: moveUnitTo(draft.units, dragFrom, index) });
                setDragFrom(null);
              },
            }}
          />
        ))}
      </ol>
      {!readOnly && (
        <div className="work-actions airules-sticky-actions">
          <button type="button" className="outline-button" disabled={busy || draft.units.length >= 30} onClick={() => onDraft({ ...draft, units: [...draft.units, newUnit()] })}>
            <Plus size={16} aria-hidden="true" />
            Add chapter
          </button>
          <button type="button" className="primary-button" disabled={busy || !dirty} onClick={onSave}>
            <Save size={16} aria-hidden="true" />
            Save chapters
          </button>
          {dirty && <span className="muted">Unsaved changes</span>}
        </div>
      )}
    </>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function ChaptersPage(_props: TeacherPageProps) {
  const { classId, course, setCourse, me } = useTeacher();
  const [draft, setDraft] = useState<Course | null>(course ? structuredClone(course) : null);
  const [summary, setSummary] = useState<ChapterSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const readOnly = !me.permissions.includes("manageCourse");
  const dirty = Boolean(draft && course && chaptersDirty(draft, course));
  const loadSummary = useCallback(async (): Promise<ChapterSummary | null> => {
    try {
      const next = await loadChapterSummary(classId);
      setSummary(next);
      return next;
    } catch (e) {
      setError(`Chapter details could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }, [classId]);
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);
  useEffect(() => {
    // WHY: a course update from elsewhere (this-week save, Course info) must not wipe unsaved chapter edits.
    setDraft((prev) => (!prev || !course || !chaptersDirty(prev, course) ? (course ? structuredClone(course) : null) : prev));
  }, [course]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const thisWeek = (unitId: string) =>
    run(async () => {
      const saved = normalizeCourse(await api.setThisWeekChapter(classId, unitId));
      setDraft((prev) => (prev ? mergeThisWeek(prev, saved) : saved));
      setCourse(saved);
      setMessage(`${thisWeekToast(saved, unitId)}.`);
    });
  const save = () =>
    run(async () => {
      if (!draft) return;
      const saved = normalizeCourse(await api.saveCourse(classId, chaptersSaveInput(draft, course ?? draft)));
      setDraft(structuredClone(saved));
      setCourse(saved);
      await loadSummary();
      setMessage(`Chapters saved. Students see the new plan the next time they open the course (${pluralize(saved.units.length, "chapter")}).`);
    });
  const aiReference = (file: FileMeta, value: boolean) =>
    run(async () => {
      await toggleAiReference(classId, file, value);
      const next = await loadSummary();
      const unit = next?.units.find((u) => u.unitId === file.unitId);
      setMessage(aiReferenceMessage(file.name, value, unit?.aiSeesMaterials));
    });
  const upload = (unitId: string, file: File) =>
    run(async () => {
      if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is larger than 3 MB.`);
      const data = await readBase64(file);
      await api.uploadFile(classId, { scope: "chapter", unitId, name: file.name, type: file.type || "application/octet-stream", data });
      await loadSummary();
      setMessage(`Added ${file.name}.`);
    });
  return (
    <>
      <PageHeader title="Chapters" count={draft?.units.length} tabs={<SectionTabs section="chapters" />} />
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
      {draft && course && (
        <ChaptersView
          draft={draft}
          saved={course}
          summary={summary}
          readOnly={readOnly}
          canOpenAssignments={me.permissions.includes("viewAssignments")}
          busy={busy}
          dirty={dirty}
          onDraft={setDraft}
          onThisWeek={(id) => void thisWeek(id)}
          onSave={() => void save()}
          onToggleAiReference={(f, v) => void aiReference(f, v)}
          onUpload={(id, f) => void upload(id, f)}
        />
      )}
    </>
  );
}
