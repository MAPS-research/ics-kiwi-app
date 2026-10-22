import { useEffect, useState } from "react";
import { ArrowLeft, KeyRound } from "lucide-react";
import { api } from "./lib/api";
import { kiwiTeacherEntryUrl } from "./lib/kiwi";
import { navigate } from "./lib/navigation";
import { TeacherWork } from "./TeacherWork";
import { TeacherCourse } from "./TeacherCourse";
import { TeacherAnalytics } from "./TeacherAnalytics";
import type { Course, VerifiedKiwiContext } from "./types";

export function TeacherDashboard({
  classId,
  course,
  onCourse,
  route,
  verified,
}: {
  classId: string;
  course: Course;
  onCourse: (c: Course) => void;
  route: string;
  verified: VerifiedKiwiContext | null;
}) {
  const keyName = `kiwi-teacher-session-${classId}`;
  const [key, setKey] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (verified) return;
    let active = true;
    const saved = sessionStorage.getItem(keyName);
    if (saved) {
      setBusy(true);
      void api
        .verifyTeacher(classId, saved)
        .then(() => {
          if (active) setKey(saved);
        })
        .catch(() => sessionStorage.removeItem(keyName))
        .finally(() => {
          if (active) setBusy(false);
        });
    }
    return () => {
      active = false;
    };
  }, [keyName, classId, verified]);
  const login = async () => {
    setBusy(true);
    setError("");
    try {
      await api.verifyTeacher(classId, input);
      sessionStorage.setItem(keyName, input);
      setKey(input);
      setInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const module = route.split("/")[2];
  useEffect(() => {
    if (verified && module !== "analytics" && !verified.canManageCourse && verified.canViewAnalytics)
      navigate("/teacher/analytics/overview");
  }, [verified, module]);
  const title =
    module === "course"
      ? "Course management"
      : module === "analytics"
        ? "Learning analytics"
        : "Practice & assignments";
  if (!key && !verified?.canTeach)
    return (
      <div className="teacher-login-screen">
        <button
          className="text-button back-button"
          onClick={() => navigate("/entry")}
        >
          <ArrowLeft size={16} />
          Back to workspaces
        </button>
        <section className="login-card">
          <div className="login-icon">
            <KeyRound size={25} />
          </div>
          <p className="eyebrow">TEACHER ACCESS</p>
          <h1>Teacher workspace</h1>
          <p className="muted">
            Sign in through Kiwi to open your teaching course and student learning evidence.
          </p>
          <a className="primary-button full" href={kiwiTeacherEntryUrl()}>Sign in with Kiwi</a>
          <h2 className="local-demo-login-title">Local demo access</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void login();
            }}
          >
            <label className="work-label">
              Local demo access key
              <input
                type="password"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <button className="primary-button full" disabled={busy || !input}>
              {busy ? "Verifying…" : "Open local demo workspace"}
            </button>
          </form>
          <p className="login-footnote">
            A Kiwi account password belongs on the Kiwi sign-in page. This key opens only the standalone demo.
          </p>
        </section>
      </div>
    );
  return (
    <div className="teacher-content">
      <div className="page-intro teacher-intro">
        <div>
          <p className="eyebrow">TEACHER WORKSPACE</p>
          <h1>
            {title}
            <span className="accent-dot">.</span>
          </h1>
          <p className="muted">
            {module === "analytics"
              ? "Understand how students learn, then follow each metric to the actual evidence."
              : module === "course"
                ? "Set chapter goals, update course progress, and manage enrollment."
                : "Publish meaningful work, review submissions, and guide generated practice."}
          </p>
        </div>
        {!verified && <button
          className="text-button"
          onClick={() => {
            sessionStorage.removeItem(keyName);
            setKey("");
          }}
        >
          Lock workspace
        </button>}
      </div>
      {module === "course" ? (
        <TeacherCourse
          classId={classId}
          course={course}
          teacherKey={key}
          onCourse={onCourse}
          roster={route.split("?")[0].endsWith("/roster")}
          materials={route.split("?")[0].endsWith("/materials")}
        />
      ) : module === "analytics" ? (
        <TeacherAnalytics
          classId={classId}
          course={course}
          teacherKey={key}
          route={route}
        />
      ) : (
        <TeacherWork
          classId={classId}
          course={course}
          teacherKey={key}
          route={route}
        />
      )}
    </div>
  );
}
