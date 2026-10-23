import { formatRelative } from "../../lib/format";
import { LABELS } from "../../lib/labels";
import { HomeLink } from "./HomeLink";
import type { AttentionItem } from "../../types";

/** B-m01: " · last seen 2 min ago" after "No learning actions…" (any student event), "" when the student was never seen. */
export function lastSeenSuffix(reason: AttentionItem["reasons"][number], now: number = Date.now()): string {
  return reason.rule === "no_activity" && reason.lastSeenAt ? ` · last seen ${formatRelative(reason.lastSeenAt, now)}` : "";
}

/**
 * One row per student with the triggered reasons; each reason links to its evidence (profile, timeline or grading).
 * A "No learning actions" reason adds when the student was last seen (B-m01); a reason's tooltip names the original of a
 * missing revision (D8).
 */
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
                <HomeLink href={r.href} allowed={canGrade || !r.href.startsWith("/teacher/grading")} title={r.title}>
                  {r.text}
                </HomeLink>
                {lastSeenSuffix(r) && <span className="attention-seen">{lastSeenSuffix(r)}</span>}
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
