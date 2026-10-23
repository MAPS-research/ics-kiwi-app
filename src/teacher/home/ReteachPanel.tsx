import { LABELS } from "../../lib/labels";
import { teacherPaths } from "../../lib/routes";
import { HomeLink } from "./HomeLink";
import { reteachLine } from "./homeModel";
import type { ReteachCandidate, ReteachMark } from "../../types";

/** What to re-teach (your questions only) [DA02, TH06]: weakest teacher questions + the class-prep list of marked items. */
export function ReteachPanel({
  candidates,
  marked,
  canMark,
  busy,
  onMark,
  onDone,
}: {
  candidates: readonly ReteachCandidate[];
  marked: readonly ReteachMark[];
  canMark: boolean;
  busy?: string;
  onMark: (c: ReteachCandidate) => void;
  onDone: (m: ReteachMark) => void;
}) {
  return (
    <section className="panel home-block home-reteach" aria-labelledby="home-reteach-title">
      <h2 id="home-reteach-title">{LABELS.whatToReteach}</h2>
      {candidates.length ? (
        <ol className="reteach-list">
          {candidates.map((c, i) => (
            <li key={`${c.assignmentId}:${c.questionId}`}>
              <HomeLink href={teacherPaths.answers({ assignmentId: c.assignmentId, questionId: c.questionId })} allowed>
                {reteachLine(c, i).replace(/^\d+\.\s*/, "")}
              </HomeLink>
              {c.marked ? (
                <span className="status-badge tone-info">Marked</span>
              ) : (
                canMark && (
                  <button type="button" className="text-button" disabled={busy === `${c.assignmentId}:${c.questionId}`} onClick={() => onMark(c)}
                    aria-label={`${LABELS.markToReteach}: ${reteachLine(c, i).replace(/^\d+\.\s*/, "")}`}>
                    {LABELS.markToReteach}
                  </button>
                )
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No question has 3 or more students attempting it in this period yet.</p>
      )}
      {marked.length > 0 && (
        <div className="reteach-marked">
          <h3>Class prep list</h3>
          <ul>
            {marked.map((m) => (
              <li key={m.id}>
                <span>{m.label}</span>
                {m.note && <small className="muted"> — {m.note}</small>}
                {canMark && (
                  <button type="button" className="text-button" onClick={() => onDone(m)} aria-label={`Done: ${m.label}`}>
                    Done
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
