import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader, SectionTabs } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { assignmentKindLabel, LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import type { Course, StarterAssignment } from "../../types";

/*
 * Starter assignments from the course template [NM44, AU-D1-15]: pick samples, map each sample chapter that this
 * course does not have to one of its chapters (or skip it), then add them as drafts. Never stores an assignment
 * against a missing chapter; samples already added are marked and skipped.
 */

export interface StarterChoice { selected: boolean; unitId: string }

export function initialChoices(starters: StarterAssignment[]): Record<string, StarterChoice> {
  return Object.fromEntries(starters.map((s) => [s.key, { selected: !s.alreadyAdded && s.mappedUnitId !== null, unitId: s.mappedUnitId ?? "" }]));
}

/** The POST body: selected keys and the chapter map for samples whose chapter is not in this course. */
export function starterRequest(starters: StarterAssignment[], choices: Record<string, StarterChoice>): { keys: string[]; unitMap: Record<string, string> } {
  const keys = starters.filter((s) => choices[s.key]?.selected && !s.alreadyAdded && choices[s.key].unitId).map((s) => s.key);
  const unitMap: Record<string, string> = {};
  for (const s of starters) if (keys.includes(s.key) && s.mappedUnitId === null) unitMap[s.sampleUnitId] = choices[s.key].unitId;
  return { keys, unitMap };
}

export function StarterAssignmentsView({ course, starters, choices, loaded, busy, onChoice, onAdd }: {
  course: Course; starters: StarterAssignment[]; choices: Record<string, StarterChoice>; loaded: boolean; busy: boolean;
  onChoice: (key: string, choice: StarterChoice) => void; onAdd: () => void;
}) {
  const request = starterRequest(starters, choices);
  return (
    <section className="panel work-panel assess-list">
      <button type="button" className="text-button" onClick={() => navigate(teacherPaths.assignments())}>
        <ArrowLeft size={15} /> Assignment list
      </button>
      <p className="muted">Starter assignments are added as drafts. Review the questions, answers and dates before publishing.</p>
      {!loaded && <p role="status" className="empty-state">Loading starter assignments…</p>}
      {loaded && !starters.length && <EmptyState>No starter assignments are available.</EmptyState>}
      {starters.map((s) => {
        const choice = choices[s.key] ?? { selected: false, unitId: "" };
        return (
          <article className="assess-row" key={s.key}>
            <label className="checkbox-label assess-row-main">
              <input type="checkbox" checked={choice.selected && !s.alreadyAdded} disabled={s.alreadyAdded || busy}
                aria-label={`Add ${s.title}`} onChange={(e) => onChoice(s.key, { ...choice, selected: e.target.checked })} />
              <span>
                <strong>{s.title}</strong>
                <small className="muted"> · {assignmentKindLabel(s.kind)}</small>
              </span>
            </label>
            <div className="assess-row-actions">
              {s.alreadyAdded ? (
                <StatusBadge tone="success">Already added</StatusBadge>
              ) : s.mappedUnitId ? (
                <span className="muted">{course.units.find((u) => u.id === s.mappedUnitId)?.title ?? s.mappedUnitId}</span>
              ) : (
                <label>
                  Chapter for “{s.sampleUnitId}”
                  <select value={choice.unitId} disabled={busy} onChange={(e) => onChoice(s.key, { selected: Boolean(e.target.value), unitId: e.target.value })}>
                    <option value="">Skip (chapter not in this course)</option>
                    {course.units.map((u) => (
                      <option key={u.id} value={u.id}>{u.title}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </article>
        );
      })}
      {loaded && starters.length > 0 && (
        <div className="work-actions">
          <button type="button" className="primary-button" disabled={busy || !request.keys.length} onClick={onAdd}>
            {LABELS.addStarterAssignments} ({request.keys.length})
          </button>
        </div>
      )}
    </section>
  );
}

export function StarterAssignmentsPage(_props: TeacherPageProps) {
  const { classId, course, me } = useTeacher();
  const [starters, setStarters] = useState<StarterAssignment[]>([]);
  const [choices, setChoices] = useState<Record<string, StarterChoice>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const list = await api.starterAssignments(classId);
    setStarters(list);
    setChoices(initialChoices(list));
    setLoaded(true);
  }, [classId]);
  useEffect(() => {
    void load().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    });
  }, [load]);
  const add = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api.addStarterAssignments(classId, starterRequest(starters, choices));
      const skipped = result.skipped.length ? ` Skipped: ${result.skipped.map((s) => `${s.key} (${s.reason})`).join("; ")}.` : "";
      setMessage(`${result.created} starter ${result.created === 1 ? "assignment" : "assignments"} added as drafts.${skipped}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!course) return null;
  const canEdit = me.permissions.includes("editAssignments");
  return (
    <div className="teacher-work">
      <PageHeader title={LABELS.starterAssignments} tabs={<SectionTabs section="assignments" />} />
      {error && <p className="error-text" role="alert">{error}</p>}
      {message && <p className="work-message" role="status">{message}</p>}
      <StarterAssignmentsView course={course} starters={starters} choices={choices} loaded={loaded} busy={busy || !canEdit}
        onChoice={(key, choice) => setChoices((c) => ({ ...c, [key]: choice }))} onAdd={() => void add()} />
    </div>
  );
}
