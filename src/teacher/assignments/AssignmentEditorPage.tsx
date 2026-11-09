import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Copy, Eye, Plus, Save, Send, Upload } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { StatusBadge, assignmentStateBadge } from "../../components/StatusBadge";
import { api, ApiError } from "../../lib/api";
import { LABELS, pluralize } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { rememberPreviewReturn } from "../../lib/previewReturn";
import { previewPaths, teacherPaths } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import { DatesSection } from "./DatesSection";
import { QuestionEditor } from "./QuestionEditor";
import { StudentHelpSection } from "./StudentHelpSection";
import { displayTimeZone } from "../../lib/format";
import {
  blankInput,
  blankQuestion,
  FROZEN_BANNER,
  fieldLabel,
  inputOf,
  inputProblems,
  isDirty,
  lineageLinks,
  protectionNote,
  stateNote,
  withDatesPatch,
  withKind,
} from "./assignmentRules";
import type { AssignmentInput, AssignmentKind, CheckResult, Course, FileMeta, Group, TeacherAssignment, WorkQuestion } from "../../types";

/*
 * Assignment editor (/teacher/assignments/new | /:id/edit) — four sections and a sticky footer [F09, LY04, TH15]:
 * Details · Questions · Student help & AI · Dates & late policy; footer Save draft · Preview as student · Publish now
 * (draft) / Save changes (published). After the first student attempt the questions are locked [TR07].
 */

const MAX_QUESTIONS = 30;
const FILE_ACCEPT = ".csv,.rds,.txt,.md,.qmd,.pdf,.r,.zip";

/** Message carried across the navigation from "new" (or a revision) to its edit page. */
let flashMessage = "";

export interface EditorViewProps {
  course: Course;
  input: AssignmentInput;
  setInput: (update: (input: AssignmentInput) => AssignmentInput) => void;
  work: TeacherAssignment | null;
  linked: boolean;
  timeZone: string;
  defaultGradesVisibility: "immediately" | "on_release";
  groups: Group[];
  groupsNote?: string;
  readOnly: boolean;
  busy: boolean;
  dirty: boolean;
  onSaveDraft: () => void;
  onPublish: () => void;
  onPreview: () => void;
  onRevision: () => void;
  onUpload: (file: File, questionId: string) => void;
  onRemoveFile: (file: FileMeta) => void;
  onToggleMount: (file: FileMeta, value: boolean) => void;
  onTryCheck?: (question: WorkQuestion, answer: string, runOutput?: string) => Promise<CheckResult>;
  /** new homework: the default late window follows the due date until the teacher edits the late policy (TEACHER-03) */
  autoLate?: boolean;
  onDatesChange?: (patch: Partial<AssignmentInput>) => void;
  /** clock for the answer-protection note (ms; tests pin it) */
  now?: number;
  /** S-M06: a failed save or publish, shown next to the footer buttons (the sticky footer is always on screen) */
  error?: string;
}

function formatSize(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

export function AttachmentsList({ files, questions, readOnly, onRemove, onToggleMount }: {
  files: FileMeta[]; questions: WorkQuestion[]; readOnly: boolean;
  onRemove: (file: FileMeta) => void; onToggleMount: (file: FileMeta, value: boolean) => void;
}) {
  if (!files.length) return <p className="muted">No attachments yet.</p>;
  return (
    <ul className="assess-files">
      {files.map((file) => {
        const index = questions.findIndex((q) => q.id === file.questionId);
        const legacy = file.id.startsWith("legacy-");
        return (
          <li key={file.id}>
            <span className="assess-file-name">{file.name}</span>
            <small className="muted">{formatSize(file.size)} · {index >= 0 ? `Question ${index + 1}` : "Whole assignment"}</small>
            <label className="checkbox-label">
              <input type="checkbox" checked={file.mountInR} disabled={readOnly || legacy} aria-label={fieldLabel.attachmentMount(file.name)}
                onChange={(e) => onToggleMount(file, e.target.checked)} />
              Load into R automatically
            </label>
            {!readOnly && (
              <button type="button" className="text-button" aria-label={fieldLabel.removeFile(file.name)} onClick={() => onRemove(file)}>
                Remove
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AssignmentEditorView(props: EditorViewProps) {
  const { course, input, setInput, work, readOnly, busy } = props;
  const [uploadTarget, setUploadTarget] = useState("");
  const locked = Boolean(work?.frozen);
  const problems = inputProblems(input);
  const published = work?.status === "published";
  const setQuestion = (index: number, question: WorkQuestion) =>
    setInput((d) => ({ ...d, questions: d.questions.map((q, i) => (i === index ? question : q)) }));
  const note = work ? stateNote(work.state) : null;
  return (
    <div className="assess-editor">
      <button type="button" className="text-button" onClick={() => navigate(teacherPaths.assignments())}>
        <ArrowLeft size={15} /> Assignment list
      </button>
      {work && (
        <p className="assess-editor-status">
          <StatusBadge tone={assignmentStateBadge(work.state).tone}>{assignmentStateBadge(work.state).label}</StatusBadge>
          <span className="muted">Version {work.version} · {pluralize(work.attemptCount, "student attempt")}</span>
          {note && <span className="muted">{note}</span>}
        </p>
      )}
      {work && lineageLinks(work).length > 0 && (
        <p className="assess-lineage">
          {lineageLinks(work).map((link) => (
            <a key={link.id} href={teacherPaths.assignmentEdit(link.id)} onClick={(e) => { e.preventDefault(); navigate(teacherPaths.assignmentEdit(link.id)); }}>
              {link.label}
            </a>
          ))}
        </p>
      )}
      <section className="panel assess-section" aria-labelledby="assess-details-title">
        <h2 id="assess-details-title">Details</h2>
        <fieldset className="assess-fieldset" disabled={readOnly}>
          <div className="work-form-grid">
            <label>
              {LABELS.assignmentType}
              <select value={input.kind} disabled={locked} onChange={(e) => setInput((d) => withKind(d, e.target.value as AssignmentKind))}>
                <option value="homework">{LABELS.homeworkType}</option>
                <option value="practice">{LABELS.inClassType}</option>
              </select>
            </label>
            <label>
              Chapter
              <select value={input.unitId} disabled={locked} onChange={(e) => setInput((d) => ({ ...d, unitId: e.target.value }))}>
                {course.units.map((u) => (
                  <option key={u.id} value={u.id}>{u.title}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="work-label">
            Title
            <input value={input.title} maxLength={120} placeholder="Week 3 · Data filtering" onChange={(e) => setInput((d) => ({ ...d, title: e.target.value }))} />
          </label>
          <label className="work-label">
            Instructions
            <textarea rows={4} maxLength={12000} value={input.instructions} onChange={(e) => setInput((d) => ({ ...d, instructions: e.target.value }))} />
          </label>
        </fieldset>
        <div className="assess-attachments">
          <h3>Attachments</h3>
          <AttachmentsList files={work?.files ?? []} questions={input.questions} readOnly={readOnly} onRemove={props.onRemoveFile}
            onToggleMount={props.onToggleMount} />
          {!readOnly && (work ? (
            <div className="assess-upload">
              <label>
                Attach to
                <select value={uploadTarget} onChange={(e) => setUploadTarget(e.target.value)}>
                  <option value="">Whole assignment</option>
                  {input.questions.map((q, i) => (
                    <option key={q.id} value={q.id}>Question {i + 1}</option>
                  ))}
                </select>
              </label>
              <label className="outline-button assess-file-button">
                <Upload size={15} /> Add a file (up to 3 MB)
                <input type="file" accept={FILE_ACCEPT} className="assess-visually-hidden" disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) props.onUpload(file, uploadTarget);
                    e.target.value = "";
                  }} />
              </label>
            </div>
          ) : (
            <p className="muted">Save the draft to add attachments.</p>
          ))}
        </div>
      </section>
      <section className="panel assess-section" aria-labelledby="assess-questions-title">
        <h2 id="assess-questions-title">Questions</h2>
        {locked && (
          <div className="assess-banner" role="note">
            {FROZEN_BANNER}
            {!readOnly && (
              <button type="button" className="outline-button" disabled={busy} onClick={props.onRevision}>
                <Copy size={15} /> Create revision
              </button>
            )}
          </div>
        )}
        <div className="work-question-list">
          {input.questions.map((q, i) => (
            <QuestionEditor key={q.id} index={i} question={q} kind={input.kind} locked={locked} readOnly={readOnly}
              canRemove={input.questions.length > 1} onChange={(next) => setQuestion(i, next)}
              onRemove={() => setInput((d) => ({ ...d, questions: d.questions.filter((_, k) => k !== i) }))} onTryCheck={props.onTryCheck} />
          ))}
        </div>
        {!readOnly && !locked && (
          <button type="button" className="outline-button" disabled={input.questions.length >= MAX_QUESTIONS}
            onClick={() => setInput((d) => ({ ...d, questions: [...d.questions, blankQuestion()] }))}>
            <Plus size={15} /> Add question
          </button>
        )}
      </section>
      <StudentHelpSection kind={input.kind} policy={input.toolPolicy} linked={props.linked} readOnly={readOnly}
        protection={protectionNote({ ...input, state: work?.state, revisions: work?.revisions }, props.timeZone, props.now ?? Date.now())}
        onChange={(toolPolicy) => setInput((d) => ({ ...d, toolPolicy }))} />
      <DatesSection input={input} timeZone={props.timeZone} defaultGradesVisibility={props.defaultGradesVisibility} groups={props.groups}
        groupsNote={props.groupsNote} readOnly={readOnly} autoLate={props.autoLate}
        onChange={(patch) => (props.onDatesChange ? props.onDatesChange(patch) : setInput((d) => ({ ...d, ...patch })))} />
      {!readOnly && (
        <footer className="assess-footer" aria-label="Save and publish">
          {props.error && <p className="error-text assess-footer-error" role="alert">{props.error}</p>}
          {problems.length > 0 && (
            <ul className="assess-problems" aria-live="polite">
              {problems.slice(0, 3).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="work-actions">
            {!published && (
              <button type="button" className="outline-button" disabled={busy || !props.dirty && Boolean(work)} onClick={props.onSaveDraft}>
                <Save size={15} /> Save draft
              </button>
            )}
            <button type="button" className="outline-button" disabled={busy} onClick={props.onPreview}>
              <Eye size={15} /> {LABELS.previewAsStudent}
            </button>
            {published ? (
              <button type="button" className="primary-button" disabled={busy || !props.dirty} onClick={props.onSaveDraft}>
                <Save size={15} /> Save changes
              </button>
            ) : (
              <button type="button" className="primary-button" disabled={busy || problems.length > 0} onClick={props.onPublish}>
                <Send size={15} /> Publish now
              </button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code === "stale_version") return `${e.message} Your unsaved changes are still in the form.`;
  return e instanceof Error ? e.message : String(e);
}

export function AssignmentEditorPage({ params, route }: TeacherPageProps) {
  const { classId, course, me } = useTeacher();
  const editId = params.assignmentId || "";
  const query = useMemo(() => new URL(route, "http://lab.local").searchParams, [route]);
  const readOnly = !me.permissions.includes("editAssignments");
  const [work, setWork] = useState<TeacherAssignment | null>(null);
  const [saved, setSaved] = useState<AssignmentInput | null>(null);
  const [input, setInputState] = useState<AssignmentInput | null>(() =>
    editId || !course ? null : blankInput(course, { kind: query.get("kind"), unitId: query.get("unitId"), audienceGroupId: query.get("audienceGroupId") }));
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsNote, setGroupsNote] = useState("");
  const [defaults, setDefaults] = useState<{ timeZone: string; grades: "immediately" | "on_release" }>({ timeZone: displayTimeZone() ?? "Asia/Shanghai", grades: "on_release" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(() => {
    const value = flashMessage;
    flashMessage = "";
    return value;
  });

  useEffect(() => {
    let active = true;
    api.settings(classId).then((s) => {
      if (!active) return;
      setDefaults({ timeZone: s.schedule.timezone || "Asia/Shanghai", grades: s.grading.defaultGradesVisibility });
      if (!editId) setInputState((d) => (d && d.kind === "homework" ? { ...d, gradesVisibility: s.grading.defaultGradesVisibility } : d));
    }).catch(() => undefined /* WHY: the editor works with the documented defaults when settings are unavailable */);
    api.groups(classId).then((g) => active && setGroups(g)).catch(() => active && setGroupsNote("Groups are unavailable right now; the assignment goes to all students."));
    return () => {
      active = false;
    };
  }, [classId, editId]);

  const load = useCallback(async () => {
    if (!editId) return;
    const detail = await api.assignmentDetail(classId, editId);
    setWork(detail);
    setSaved(inputOf(detail));
    setInputState(inputOf(detail));
  }, [classId, editId]);
  useEffect(() => {
    void load().catch((e: unknown) => setError(errorText(e)));
  }, [load]);

  const setInput = (update: (d: AssignmentInput) => AssignmentInput) => setInputState((d) => (d ? update(d) : d));
  const [autoLate, setAutoLate] = useState(!editId);
  const onDatesChange = (patch: Partial<AssignmentInput>) => {
    if ("latePolicy" in patch) setAutoLate(false);
    const follow = autoLate && !("latePolicy" in patch);
    setInput((d) => withDatesPatch(d, patch, follow));
  };
  const dirty = isDirty(input, saved);

  /** Saves the form; returns the saved assignment (navigates to the edit page after the first save). */
  const persist = async (): Promise<TeacherAssignment | null> => {
    if (!input) return null;
    if (work && !dirty) return work;
    const next = work
      ? await api.updateAssignment(classId, work.id, { ...input, baseUpdatedAt: work.updatedAt })
      : await api.createAssignment(classId, input);
    setWork(next);
    setSaved(inputOf(next));
    setInputState(inputOf(next));
    return next;
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const saveDraft = () =>
    run(async () => {
      const next = await persist();
      if (!next) return;
      const text = next.status === "published" ? "Changes saved." : "Draft saved.";
      if (!editId) {
        flashMessage = text;
        navigate(teacherPaths.assignmentEdit(next.id), true);
      } else setMessage(text);
    });
  const publish = () =>
    run(async () => {
      const next = await persist();
      if (!next) return;
      const published = await api.publishAssignment(classId, next.id);
      setWork(published);
      setSaved(inputOf(published));
      setInputState(inputOf(published));
      const text = published.state === "scheduled" ? "Published — students see it when it opens." : "Published to students.";
      if (!editId) {
        flashMessage = text;
        navigate(teacherPaths.assignmentEdit(published.id), true);
      } else setMessage(text);
    });
  const preview = () =>
    run(async () => {
      const next = readOnly ? work : await persist();
      if (next) {
        rememberPreviewReturn(teacherPaths.assignmentEdit(next.id));   // RV6-m01: Exit preview returns to this editor
        navigate(previewPaths.assignment(next.id));
      }
    });
  const revision = () =>
    run(async () => {
      if (!work) return;
      const copy = await api.duplicateAssignment(classId, work.id, { asRevision: true, retireOriginalOnPublish: true });
      flashMessage = "Revision created as a draft. Publishing it closes the original; its grades stay intact.";
      navigate(teacherPaths.assignmentEdit(copy.id));
    });
  const refreshFiles = async () => {
    if (!work) return;
    const files = await api.listFiles(classId, { assignmentId: work.id });
    setWork((w) => (w ? { ...w, files, attachmentName: files.find((f) => f.id.startsWith("legacy-"))?.name ?? null } : w));
  };
  const upload = (file: File, questionId: string) =>
    run(async () => {
      if (!work) return;
      if (file.size > 3_000_000) throw new Error("Attachments must be smaller than 3 MB.");
      const data = await readBase64(file);
      await api.uploadFile(classId, { scope: "assignment", assignmentId: work.id, questionId: questionId || undefined, name: file.name,
        type: file.type || "application/octet-stream", data, mountInR: true });
      await refreshFiles();
      setMessage(`${file.name} attached.`);
    });
  const removeFile = (file: FileMeta) =>
    run(async () => {
      await api.deleteFile(classId, file.id);
      await refreshFiles();
      setMessage(`${file.name} removed.`);
    });
  const toggleMount = (file: FileMeta, value: boolean) =>
    run(async () => {
      await api.updateFile(classId, file.id, { mountInR: value });
      await refreshFiles();
    });
  const tryCheck = (question: WorkQuestion, answer: string, runOutput?: string) =>
    api.previewCheck(classId, work?.id || "new", { question, answer, ...(runOutput !== undefined ? { runOutput } : {}) });

  if (!course) return null;
  const title = editId ? (readOnly ? "View assignment" : "Edit assignment") : "New assignment";
  return (
    <div className="teacher-work">
      <PageHeader title={title} meta={input?.title || undefined} />
      {error && (!input || readOnly) && <p className="error-text" role="alert">{error}</p>}
      {message && <p className="work-message" role="status">{message}</p>}
      {input ? (
        <AssignmentEditorView course={course} input={input} setInput={setInput} work={work} linked={course.linked} timeZone={defaults.timeZone}
          error={readOnly ? undefined : error}
          defaultGradesVisibility={defaults.grades} groups={groups} groupsNote={groupsNote} readOnly={readOnly} busy={busy} dirty={dirty}
          onSaveDraft={() => void saveDraft()} onPublish={() => void publish()} onPreview={() => void preview()} onRevision={() => void revision()}
          onUpload={(file, qid) => void upload(file, qid)} onRemoveFile={(file) => void removeFile(file)}
          onToggleMount={(file, value) => void toggleMount(file, value)} onTryCheck={readOnly ? undefined : tryCheck}
          autoLate={autoLate && !editId} onDatesChange={onDatesChange} />
      ) : (
        !error && <p role="status" className="empty-state">Loading assignment…</p>
      )}
    </div>
  );
}
