import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import type { Course, CourseSettings } from "../../types";

/* Course info (title, description; saved through PUT /api/course) and grading/AI defaults (PUT /api/teacher/settings). */

export function CourseInfoPanel({ draft, setDraft, busy, readOnly, onSave }: {
  draft: Course; setDraft: (c: Course) => void; busy: boolean; readOnly: boolean; onSave: () => void;
}) {
  return (
    <section className="panel work-panel focused-panel">
      <h2 className="panel-heading">Course info</h2>
      <fieldset className="editor-fields" disabled={readOnly || busy}>
        <label className="work-label">
          Course title
          <input value={draft.title} maxLength={100} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </label>
        <label className="work-label">
          Description
          <textarea rows={3} maxLength={1000} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </label>
      </fieldset>
      {!readOnly && (
        <div className="work-actions">
          <button className="primary-button" disabled={busy} onClick={onSave}>
            <Save size={16} />
            Save course info
          </button>
        </div>
      )}
    </section>
  );
}

export type DefaultsDraft = { grading: CourseSettings["grading"]; ai: CourseSettings["ai"] };

export function DefaultsPanel({ settings, busy, onSave }: { settings: CourseSettings; busy: boolean; onSave: (patch: Partial<CourseSettings>) => void }) {
  const [draft, setDraft] = useState<DefaultsDraft>({ grading: settings.grading, ai: settings.ai });
  useEffect(() => setDraft({ grading: settings.grading, ai: settings.ai }), [settings]);
  return (
    <section className="panel work-panel focused-panel">
      <h2 className="panel-heading">Grading and AI defaults</h2>
      <fieldset className="editor-fields" disabled={busy}>
        <label className="work-label">
          Grades for new homework become visible to students
          <select
            value={draft.grading.defaultGradesVisibility}
            onChange={(e) => setDraft({ ...draft, grading: { ...draft.grading, defaultGradesVisibility: e.target.value as CourseSettings["grading"]["defaultGradesVisibility"] } })}
          >
            <option value="on_release">When I release them (Release & export)</option>
            <option value="immediately">Immediately after saving</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={draft.grading.taCanRelease} onChange={(e) => setDraft({ ...draft, grading: { ...draft.grading, taCanRelease: e.target.checked } })} />
          Teaching assistants may release grades
        </label>
        <label className="work-label">
          Lab AI tutor requests per student per minute
          <input
            type="number"
            min={1}
            max={120}
            value={draft.ai.perStudentPerMinute}
            onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, perStudentPerMinute: Number(e.target.value) } })}
          />
        </label>
        <label className="work-label">
          Lab AI tutor requests per course per minute
          <input type="number" min={1} max={2000} value={draft.ai.classPerMinute} onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, classPerMinute: Number(e.target.value) } })} />
        </label>
      </fieldset>
      <div className="work-actions">
        <button className="primary-button" disabled={busy} onClick={() => onSave({ grading: draft.grading, ai: draft.ai })}>
          <Save size={16} /> Save defaults
        </button>
      </div>
    </section>
  );
}
