import { Check } from "lucide-react";
import { LABELS } from "../../lib/labels";
import { navigate, studentHref } from "../../lib/navigation";
import { readScratchDraft } from "./ScratchDraftPage";
import type { StudentPageProps } from "../StudentApp";
import type { Course, Unit } from "../../types";

/*
 * Student course outline (AIRULES) [F03, TH03]: chapters in course order with their progress; chapters that open later
 * (free practice scope) show "Opens later", review chapters show "Review"; hidden chapters are never listed (the server
 * already omits them for students; filtered here too).
 */

export function outlineBadge(unit: Pick<Unit, "effectiveAccess">): string {
  if (unit.effectiveAccess === "locked") return LABELS.opensLater;
  if (unit.effectiveAccess === "review") return LABELS.review;
  return "";
}

export function CourseOutlineView({ course, hosted = false }: { course: Course; hosted?: boolean }) {
  const units = course.units.filter((u) => u.effectiveAccess !== "hidden");
  return (
    <ol className="course-outline">
      {units.map((u, i) => {
        const badge = outlineBadge(u);
        return (
          <li className={`panel work-panel${u.effectiveAccess === "locked" ? " is-locked" : ""}`} key={u.id}>
            <div className="row-between">
              <span className="small-pill">Chapter {i + 1}</span>
              <span className="chapter-status">
                {u.status === "completed" ? (
                  <>
                    <Check size={15} aria-hidden="true" />
                    Completed
                  </>
                ) : u.status === "current" ? (
                  "In progress"
                ) : (
                  "Upcoming"
                )}
                {badge && <span className="status-badge tone-neutral outline-access">{badge}</span>}
              </span>
            </div>
            <h2>{u.title}</h2>
            <p className="muted">{u.goal}</p>
            {u.effectiveAccess === "review" && <p className="muted">{hosted ? "Review this chapter with Kiwi’s floating chat; new practice is closed." : "Ask Kiwi is available for review; new practice is closed."}</p>}
          </li>
        );
      })}
    </ol>
  );
}

export function CourseOutlinePage({ course, hosted, classId, studentId }: StudentPageProps) {
  return (
    <div className="student-content">
      <div className="page-intro">
        <div>
          <h1>{course.title}</h1>
          <p className="muted">{course.description}</p>
        </div>
      </div>
      <CourseOutlineView course={course} hosted={hosted} />
      {hosted && readScratchDraft(classId, studentId) !== null && (
        <p className="muted"><a href={studentHref("/student/code")} onClick={(e) => { e.preventDefault(); navigate("/student/code"); }}>Recover an earlier R workspace draft</a></p>
      )}
    </div>
  );
}
