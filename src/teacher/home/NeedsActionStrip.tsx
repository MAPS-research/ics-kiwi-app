import { LABELS } from "../../lib/labels";
import { teacherPaths } from "../../lib/routes";
import { HomeLink } from "./HomeLink";
import { flaggedChip, lateChip, missingChip, releaseChip, toGradeChip, type HomeLinks } from "./homeModel";
import type { HomeData } from "../../types";

/** Needs your action [F05, F04, DA07]: To grade › Start, Ready to release › Release, Missing (started) › List, Late, Flagged replies. */
export function NeedsActionStrip({ action, links }: { action: HomeData["needsAction"]; links: HomeLinks }) {
  const empty = !action.toGrade && !action.toRelease.length && !action.missingPastDue.length && !action.late && !action.flaggedReplies;
  return (
    <section className="panel home-block home-needs" aria-labelledby="home-needs-title">
      <h2 id="home-needs-title">{LABELS.needsYourAction}</h2>
      {empty ? (
        <p className="muted">Nothing needs your action right now.</p>
      ) : (
        <ul className="home-chips">
          {action.toGrade > 0 && (
            <li>
              <HomeLink className="home-chip tone-warning" href={teacherPaths.grading({ show: "latest" })} allowed={links.grading}>
                {toGradeChip(action.toGrade)}
                {links.grading && <span className="chip-action"> › Start</span>}
              </HomeLink>
            </li>
          )}
          {action.toRelease.map((r) => (
            <li key={`release-${r.assignmentId}`}>
              <HomeLink className="home-chip tone-info" href={teacherPaths.release({ assignmentId: r.assignmentId })} allowed={links.grading}>
                {releaseChip(r.count)}
                <span className="chip-context"> · {r.title}</span>
                {links.grading && <span className="chip-action"> › Release</span>}
              </HomeLink>
            </li>
          ))}
          {action.missingPastDue.map((m) => (
            <li key={`missing-${m.assignmentId}`}>
              <HomeLink
                className="home-chip tone-danger"
                href={links.assignments ? teacherPaths.assignments({ search: m.title, open: m.assignmentId, list: "missing" }) : teacherPaths.attention()}
                allowed={links.insights}
              >
                {missingChip(m)}
                {links.insights && <span className="chip-action"> › List</span>}
              </HomeLink>
            </li>
          ))}
          {action.late > 0 && (
            <li>
              <HomeLink className="home-chip tone-warning" href={teacherPaths.grading({ show: "late" })} allowed={links.grading}>
                {lateChip(action.late)}
                {links.grading && <span className="chip-action"> › List</span>}
              </HomeLink>
            </li>
          )}
          {action.flaggedReplies !== null && action.flaggedReplies > 0 && (
            <li>
              <HomeLink className="home-chip tone-danger" href={teacherPaths.aiConversations({ mode: "coding", flagged: "1", unitId: "all" })} allowed={links.insights}>
                {flaggedChip(action.flaggedReplies)}
              </HomeLink>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
