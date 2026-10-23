import { LABELS } from "../../lib/labels";
import { HomeLink } from "./HomeLink";
import type { AttentionItem } from "../../types";

/** One row per student with the triggered reasons; each reason links to its evidence (profile, timeline or grading). */
export function AttentionRows({
  students,
  canGrade,
  selected,
  onToggle,
  studentLabel,
}: {
  students: readonly AttentionItem[];
  canGrade: boolean;
  selected?: ReadonlySet<string>;
  onToggle?: (studentId: string) => void;
  studentLabel: (item: AttentionItem) => string;
}) {
  if (!students.length) return <p className="muted">No student matches the attention rules for this period.</p>;
  return (
    <ul className="attention-list">
      {students.map((s) => (
        <li key={s.studentId} className="attention-row">
          {onToggle && (
            <input
              type="checkbox"
              aria-label={`Select ${studentLabel(s)}`}
              checked={selected?.has(s.studentId) ?? false}
              onChange={() => onToggle(s.studentId)}
            />
          )}
          <HomeLink className="attention-name" href={`/teacher/students/s/${encodeURIComponent(s.studentId)}`} allowed>
            {studentLabel(s)}
          </HomeLink>
          <span className="attention-reasons">
            {s.reasons.map((r, i) => (
              <span key={`${r.rule}-${i}`} className="attention-reason">
                <HomeLink href={r.href} allowed={canGrade || !r.href.startsWith("/teacher/grading")}>
                  {r.text}
                </HomeLink>
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Home block "Students needing attention (n)" with the `rules (i)` popover text and `Open roster`. */
export function AttentionList({
  students,
  total,
  rulesText,
  canGrade,
  studentLabel,
}: {
  students: readonly AttentionItem[];
  total: number;
  rulesText: readonly string[];
  canGrade: boolean;
  studentLabel: (item: AttentionItem) => string;
}) {
  return (
    <section className="panel home-block home-attention" aria-labelledby="home-attention-title">
      <div className="home-block-head">
        <h2 id="home-attention-title">
          {LABELS.studentsNeedingAttention} ({total})
        </h2>
        <details className="rules-info">
          <summary aria-label="Attention rules">rules (i)</summary>
          <ul>
            {rulesText.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </details>
      </div>
      <AttentionRows students={students} canGrade={canGrade} studentLabel={studentLabel} />
      <HomeLink className="text-button" href="/teacher/students/attention" allowed>
        Open Needs attention
      </HomeLink>
    </section>
  );
}
