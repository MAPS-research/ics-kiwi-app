import { useEffect, useState } from "react";
import { BookOpen, Code2, GraduationCap, MessagesSquare, Sparkles, type LucideIcon } from "lucide-react";
import { KiwiBrand } from "../RoleEntry";
import { KiwiReturn } from "../KiwiReturn";
import { api } from "../lib/api";
import { setHostDefaultContext } from "../lib/kiwi";
import { LABELS, questionTypeLabel, STUDENT_LABELS } from "../lib/labels";
import { navigate, useRoute } from "../lib/navigation";
import { resolveStudentRoute, studentPaths } from "../lib/routes";
import { TelemetryStatusBanner, useStudentTelemetry } from "./telemetry/TelemetryRoot";
import { AssignmentListPage } from "./assignments/AssignmentListPage";
import { AssignmentPage } from "./assignments/AssignmentPage";
import { PracticePage } from "./practice/PracticePage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { AskKiwiPage } from "./pages/AskKiwiPage";
import { CourseOutlinePage } from "./pages/CourseOutlinePage";
import type { Course, KiwiClient, PublicPolicy, Tracker } from "../types";

/*
 * Student shell (FOUNDATION, frozen; moved from v0.5.1 src/App.tsx:206-480): nav, preview banner, demo identity picker,
 * default Kiwi updateContext (§15.3), one telemetry root. Also serves /preview/student/* for staff (§3.4).
 */

export interface StudentPageProps {
  classId: string;
  course: Course;
  studentId: string;
  studentName: string;
  track: Tracker;
  /** pathname + search */
  route: string;
  params: Record<string, string>;
  preview: boolean;
}

export interface StudentNavItem { href: string; match: string; label: string; icon: LucideIcon }
/** Student navigation; `base` is "/student" or "/preview/student". */
export function studentNavItems(base: string): StudentNavItem[] {
  return [
    { href: `${base}/assignments`, match: `${base}/assignments`, label: STUDENT_LABELS.navAssignments, icon: BookOpen },
    { href: `${base}/practice/settings`, match: `${base}/practice`, label: STUDENT_LABELS.navPractice, icon: Sparkles },
    { href: `${base}/code`, match: `${base}/code`, label: STUDENT_LABELS.navWorkspace, icon: Code2 },
    { href: `${base}/kiwi`, match: `${base}/kiwi`, label: STUDENT_LABELS.navAskKiwi, icon: MessagesSquare },
    { href: `${base}/course`, match: `${base}/course`, label: STUDENT_LABELS.navCourse, icon: GraduationCap },
  ];
}

const HELP_LEVELS: Readonly<Record<string, string>> = {
  hints_only: "hints only",
  explain_concepts: "explain concepts",
  worked_examples: "worked examples",
};
/** Default Kiwi side-panel context (§15.3); assignment pages append their note through useHostChatPolicy. */
export function defaultHostContext(course: Course, path: string, policy: Pick<PublicPolicy, "helpLevel" | "allowedTypes"> | null): string {
  const chapter = course.units.find((u) => u.id === course.currentUnitId)?.title ?? "not set";
  const help = policy?.helpLevel ? HELP_LEVELS[policy.helpLevel] ?? policy.helpLevel : "not set";
  const types = policy?.allowedTypes?.length ? policy.allowedTypes.map((t) => questionTypeLabel(t)).join(", ") : "not set";
  return `English-language R course: ${course.title}. Chapter: ${chapter}. Page: ${path}. Lab AI tutor rules for this chapter: help level ${help}, question types ${types}. Kiwi controls its own chat panel.`;
}

export interface DemoChoice { studentId: string; studentName: string }

export function StudentApp({
  classId,
  course,
  kiwi,
  mode,
  studentId,
  studentName,
  preview,
  demo,
  notice,
  onDismissNotice,
  onExitPreview,
}: {
  classId: string;
  course: Course;
  kiwi: KiwiClient | null;
  mode: "live" | "sim";
  studentId: string;
  studentName: string;
  preview: boolean;
  /** standalone demo identity picker (absent for Kiwi students and in preview) */
  demo: { choices: DemoChoice[]; selected: string; onSelect: (studentId: string) => void } | null;
  notice: string;
  onDismissNotice: () => void;
  onExitPreview: () => void;
}) {
  const route = useRoute();
  const path = route.split("?")[0];
  const base = preview ? "/preview/student" : "/student";
  const track = useStudentTelemetry({ classId, studentId, studentName, preview });
  const [policy, setPolicy] = useState<PublicPolicy | null>(null);

  useEffect(() => {
    let active = true;
    api
      .policy(classId, course.currentUnitId)
      .then((p) => {
        if (active) setPolicy(p);
      })
      .catch(() => {
        // WHY: the host context then says "not set"; the chat itself loads and reports the policy error.
        if (active) setPolicy(null);
      });
    return () => {
      active = false;
    };
  }, [classId, course.currentUnitId, studentId]);
  useEffect(() => {
    setHostDefaultContext(kiwi, defaultHostContext(course, path, policy));
  }, [kiwi, course, path, policy]);

  const resolved = resolveStudentRoute(path);
  const nav = studentNavItems(base);
  const current = nav.find((item) => path.startsWith(item.match));
  const completed = course.units.filter((u) => u.status === "completed").length;
  const pageProps: StudentPageProps = { classId, course, studentId, studentName, track, route, params: resolved?.params ?? {}, preview };
  const identityKey = `${classId}-${studentId}`;
  const page = (() => {
    switch (resolved?.id) {
      case "assignment":
        return <AssignmentPage key={`${identityKey}-${resolved.params.assignmentId}`} {...pageProps} />;
      case "practice":
        return <PracticePage key={identityKey} {...pageProps} />;
      case "workspace":
        return <WorkspacePage key={identityKey} {...pageProps} />;
      case "askKiwi":
        return <AskKiwiPage key={identityKey} {...pageProps} />;
      case "courseOutline":
        return <CourseOutlinePage key={identityKey} {...pageProps} />;
      default:
        return <AssignmentListPage key={identityKey} {...pageProps} />;
    }
  })();

  return (
    <div className={`app-shell role-student${preview ? " is-preview" : ""}`}>
      <aside className="sidebar">
        <KiwiBrand />
        <nav className="sidebar-scroll" aria-label="Student navigation">
          <div className="sidebar-section-title">STUDENT WORKSPACE</div>
          {nav.map((item) => {
            const active = path.startsWith(item.match);
            return (
              <a
                key={item.href}
                href={item.href}
                className={`nav-item ${active ? "active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(item.href);
                }}
              >
                <item.icon size={18} />
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="progress-label">
            <span>Chapters completed</span>
            <strong>
              {completed}/{course.units.length}
            </strong>
          </div>
          <div className="progress-track">
            <span style={{ width: `${course.units.length ? (completed / course.units.length) * 100 : 0}%` }} />
          </div>
          <div className="sidebar-profile">
            <span className="avatar">{studentName[0]?.toUpperCase()}</span>
            <span>
              <strong>{studentName}</strong>
              <small>{preview ? "Preview (test activity)" : mode === "live" ? "Kiwi student" : "Local demo student"}</small>
            </span>
          </div>
        </div>
      </aside>
      <main className="main-area">
        {preview && (
          <div className="preview-banner" role="status">
            <span>{LABELS.previewBanner}</span>
            <button type="button" className="outline-button" onClick={onExitPreview}>
              {LABELS.exitPreview}
            </button>
          </div>
        )}
        <header className="topbar">
          <div className="breadcrumb">
            Student
            <span>/</span>
            {course.title}
            <span>/</span>
            <strong>{current?.label || "Workspace"}</strong>
          </div>
          <div className="topbar-right">
            <KiwiReturn kiwi={kiwi} />
            {!preview && (
              <button className="text-button role-switch" onClick={() => navigate(studentPaths.entry())}>
                Choose workspace
              </button>
            )}
            <span className={`connection-pill ${mode === "live" ? "live" : ""}`}>
              <span className="connection-dot" />
              {preview ? "PREVIEW" : mode === "live" ? "KIWI LIVE" : "LOCAL DEMO"}
            </span>
          </div>
        </header>
        {notice && (
          <div className="global-status">
            <p className="error-text" role="alert">
              {notice}
            </p>
            <button className="text-button" onClick={onDismissNotice}>
              Dismiss
            </button>
          </div>
        )}
        <TelemetryStatusBanner />
        {demo && (
          <div className="demo-identity">
            <label>
              Demo student
              <select value={demo.selected} onChange={(e) => demo.onSelect(e.target.value)}>
                {demo.choices.map((choice) => (
                  <option key={choice.studentId} value={choice.studentId}>
                    {choice.studentName}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {page}
      </main>
    </div>
  );
}
