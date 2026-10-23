import { useEffect, useState } from "react";
import { ArrowRight, BookOpen } from "lucide-react";
import { api } from "../../lib/api";
import { assignmentKindLabel, pluralize, STUDENT_LABELS } from "../../lib/labels";
import { navigate, studentHref } from "../../lib/navigation";
import { studentPaths } from "../../lib/routes";
import { dueLines, originalNote } from "./AssignmentPage";
import type { StudentPageProps } from "../StudentApp";
import type { Course, StudentWorkOption } from "../../types";

/*
 * Student assignment list (ASSESS) — GET /api/work-options. Work the student can still submit first (past due with an
 * open late window, then open), then closed work (read-only). Each card shows the due line, attempts and the student's own status [F01, NM16].
 */

export function statusText(w: Pick<StudentWorkOption, "kind" | "myAttempts" | "myLatestStatus" | "maxAttempts" | "submittedOriginal">): string {
  if (w.kind === "practice") return w.myAttempts ? `${pluralize(w.myAttempts, "answer")} checked` : "Not started";
  if (w.myLatestStatus === "graded") return "Graded";
  if (w.myLatestStatus === "submitted") return STUDENT_LABELS.waitingForTeacher;
  if (w.submittedOriginal) return originalNote(w.submittedOriginal.title);   // S-M01
  return "Not submitted";
}

/** S-m08: the chapter title, also for a chapter hidden from students; never a raw chapter id. */
export function chapterTitle(w: Pick<StudentWorkOption, "unitId" | "unitTitle">, course: Course): string {
  return course.units.find((u) => u.id === w.unitId)?.title || w.unitTitle || "";
}

function Card({ w, course }: { w: StudentWorkOption; course: Course }) {
  const lines = dueLines({ state: w.state, dueAt: w.dueAt, latePolicy: w.latePolicy, closeAt: w.closeAt });
  return (
    <a className="panel assignment-card" href={studentHref(studentPaths.assignment(w.id))}
      onClick={(e) => { e.preventDefault(); navigate(studentPaths.assignment(w.id)); }}>
      <div className="row-between">
        <span className="small-pill">{w.isPreviewDraft ? "Draft (preview)" : assignmentKindLabel(w.kind)}</span>
        <BookOpen size={19} />
      </div>
      <h2>{w.title}</h2>
      {chapterTitle(w, course) && <p>{chapterTitle(w, course)}</p>}
      <small>
        {pluralize(w.questionCount, "question")} · {lines.headline}
        {w.kind === "homework" && w.maxAttempts !== null ? ` · ${w.myAttempts}/${w.maxAttempts} attempts` : ""}
      </small>
      {/* RV6-M09: a past-due card says that (and until when) late work is still accepted */}
      {w.state === "past_due" && lines.detail && <small className="assess-late-window">{lines.detail}</small>}
      <small className="muted">{statusText(w)}</small>
      <span className="card-link">Open assignment <ArrowRight size={15} /></span>
    </a>
  );
}

/**
 * RV6-M09: work the student can still submit — open, or past due with late submissions accepted — stays in the first
 * group (past-due homework not yet submitted first, it is the most urgent); only closed work moves to "Closed".
 */
export function groupWorks(works: readonly StudentWorkOption[]): { open: StudentWorkOption[]; closed: StudentWorkOption[] } {
  const submittable = works.filter((w) => w.state !== "closed" && w.state !== "archived");
  const urgent = (w: StudentWorkOption) => w.state === "past_due" && w.kind === "homework" && w.myLatestStatus === "none" && !w.submittedOriginal;
  return {
    open: [...submittable.filter(urgent), ...submittable.filter((w) => !urgent(w))],
    closed: works.filter((w) => w.state === "closed" || w.state === "archived"),
  };
}

export function AssignmentListView({ works, course, loaded }: { works: StudentWorkOption[]; course: Course; loaded: boolean }) {
  const { open, closed: later } = groupWorks(works);
  return (
    <>
      <div className="assignment-cards">
        {open.map((w) => <Card key={w.id} w={w} course={course} />)}
        {loaded && works.length === 0 && <section className="panel work-panel empty-state">Your teacher has not published any work yet.</section>}
      </div>
      {later.length > 0 && (
        <>
          <h2 className="assess-subhead">Closed</h2>
          <div className="assignment-cards">
            {later.map((w) => <Card key={w.id} w={w} course={course} />)}
          </div>
        </>
      )}
    </>
  );
}

export function AssignmentListPage({ classId, course }: StudentPageProps) {
  const [works, setWorks] = useState<StudentWorkOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.workOptions(classId)
      .then((w) => active && setWorks(w))
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoaded(true));
    return () => {
      active = false;
    };
  }, [classId]);
  return (
    <div className="student-content">
      <div className="page-intro">
        <div>
          <h1>Your assigned work</h1>
          <p className="muted">Choose an assignment, then focus on one question at a time.</p>
        </div>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <AssignmentListView works={works} course={course} loaded={loaded} />
    </div>
  );
}
