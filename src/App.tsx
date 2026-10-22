import { useCallback, useEffect, useRef, useState } from "react";
import {
  BarChart3,
  BookOpen,
  Check,
  Code2,
  GraduationCap,
  LoaderCircle,
  MessagesSquare,
  Settings2,
  Sparkles,
} from "lucide-react";
import { TeacherDashboard } from "./TeacherDashboard";
import { StudentWork } from "./StudentWork";
import { Practice } from "./Practice";
import { KiwiBrand, RoleEntry, type AppRole } from "./RoleEntry";
import { KiwiReturn } from "./KiwiReturn";
import { KiwiChat, RWorkbench } from "./LearningTools";
import { api, setKiwiTokenProvider } from "./lib/api";
import { getKiwi } from "./lib/kiwi";
import { browserSession, navigate, useRoute } from "./lib/navigation";
import type { Course, KiwiClient, VerifiedKiwiContext } from "./types";

const rootPath = {
  student: "/student/assignments",
  teacher: "/teacher/work/assignments",
  entry: "/entry",
};
function App() {
  const route = useRoute();
  const path = route.split("?")[0];
  const role: AppRole = path.startsWith("/teacher")
    ? "teacher"
    : path === "/entry"
      ? "entry"
      : "student";
  const [kiwi, setKiwi] = useState<KiwiClient | null>(null);
  const [verified, setVerified] = useState<VerifiedKiwiContext | null>(null);
  const [mode, setMode] = useState<"connecting" | "sim" | "live">("connecting");
  const [classId, setClass] = useState("");
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState(
    localStorage.getItem("kiwi-lab-student") || "ada",
  );
  const studentId =
    mode === "live" ? verified?.userId || "" : `demo-${choice}`;
  const studentName =
    mode === "live"
      ? verified?.username || studentId
      : choice === "ada"
        ? "Ada Chen"
        : "Bo Lin";
  const canTeach =
    mode === "sim" ||
    Boolean(mode === "live" && verified?.canTeach);
  const context = useRef({ classId, studentId });
  context.current = { classId, studentId };
  const scratchKey = `kiwi-scratch-${classId}-${studentId}`;
  const [scratchCode, setScratch] = useState("");
  const [chatUnit, setChatUnit] = useState("");
  useEffect(() => {
    let active = true;
    void getKiwi()
      .then(async (client) => {
        if (!active) return;
        setKiwi(client);
        if (client.mode === "live") {
          const cid = client.context?.classId;
          if (!cid) throw new Error("Choose a course in Kiwi before opening CSS Lab.");
          setKiwiTokenProvider(async (force) => (await client.getToken({ force })).accessToken);
          const identity = await api.kiwiContext(cid);
          if (!active) return;
          setVerified(identity);
          setClass(identity.classId);
        } else setClass("local-r-class");
        setMode(client.mode);
      })
      .catch((e) => {
        if (active) {
          if (window.parent === window) { setMode("sim"); setClass("local-r-class"); }
          setError(
            `Kiwi connection unavailable: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!classId) return;
    let active = true;
    setCourse(null);
    void api
      .course(classId)
      .then((c) => {
        if (active) {
          setCourse(c);
          setChatUnit(c.currentUnitId);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [classId]);
  useEffect(() => {
    const replacements: Record<string, string> = {
      "/": "/student/assignments",
      "/student": "/student/assignments",
      "/teacher": "/teacher/work/assignments",
      "/teacher/work": "/teacher/work/assignments",
      "/teacher/course": "/teacher/course/plan",
      "/teacher/analytics": "/teacher/analytics/overview",
      "/student/practice": "/student/practice/settings",
    };
    if (replacements[path]) {
      history.replaceState({}, "", replacements[path]);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [path]);
  useEffect(() => {
    setScratch(
      localStorage.getItem(scratchKey) ||
        "scores <- c(72, 85, 91)\nprint(mean(scores))",
    );
  }, [scratchKey]);
  const track = useCallback(
    async (
      type: string,
      payload: Record<string, unknown>,
      questionId?: string,
    ) => {
      try {
        await api.event({
          classId,
          studentId,
          studentName,
          sessionId: browserSession,
          type,
          questionId,
          payload,
        });
      } catch (e) {
        if (
          context.current.classId === classId &&
          context.current.studentId === studentId
        )
          setError(
            `Activity could not be saved: ${e instanceof Error ? e.message : String(e)}`,
          );
      }
    },
    [classId, studentId, studentName],
  );
  useEffect(() => {
    if (!classId || !studentId || role !== "student") return;
    let last = Date.now();
    const active = () => {
      last = Date.now();
    };
    addEventListener("pointerdown", active);
    addEventListener("keydown", active);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - last < 60000)
        void track("study_heartbeat", { seconds: 30, page: path });
    }, 30000);
    return () => {
      clearInterval(timer);
      removeEventListener("pointerdown", active);
      removeEventListener("keydown", active);
    };
  }, [classId, studentId, role, track, path]);
  useEffect(() => {
    if (course && role === "student")
      kiwi?.updateContext(
        `English-language R course: ${course.title}. Current chapter: ${course.units.find((u) => u.id === course.currentUnitId)?.title}. Page: ${path}. Teacher policy is enforced by the course API.`,
      );
  }, [kiwi, course, role, path]);
  if (!course || mode === "connecting")
    return (
      <div className="boot-screen">
        <span className="kiwi-wordmark">kiwi</span>
        {!error && <LoaderCircle className="spin" size={22} />}
        <p>{error ? "Unable to open your workspace" : "Loading your workspace…"}</p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {error && <><button className="primary-button" onClick={() => location.reload()}>Try again</button><KiwiReturn kiwi={kiwi} teacher={role === "teacher"} /></>}
      </div>
    );
  if (role === "entry")
    return (
      <RoleEntry
        courseTitle={course.title}
        canTeach={canTeach}
        kiwi={kiwi}
        onChoose={(r) => navigate(rootPath[r])}
      />
    );
  const teacherNav = [
    ["/teacher/work", "Practice & assignments", BookOpen],
    ["/teacher/course", "Course management", Settings2],
    ["/teacher/analytics", "Data analytics", BarChart3],
  ] as const;
  const studentNav = [
    ["/student/assignments", "Assigned work", BookOpen],
    ["/student/practice", "Guided practice", Sparkles],
    ["/student/code", "R workspace", Code2],
    ["/student/kiwi", "Ask Kiwi", MessagesSquare],
    ["/student/course", "Course outline", GraduationCap],
  ] as const;
  const nav = role === "teacher" ? teacherNav.filter(([p]) => mode !== "live" || (p.includes("analytics") ? verified?.canViewAnalytics : verified?.canManageCourse)) : studentNav;
  const current = nav.find(([p]) => path.startsWith(p));
  const completed = course.units.filter((u) => u.status === "completed").length;
  const identity =
    role === "teacher"
      ? mode === "live"
        ? verified?.username || "Teacher"
        : "Teacher demo"
      : studentName;
  return (
    <div className={`app-shell role-${role}`}>
      <aside className="sidebar">
        <KiwiBrand />
        <nav
          className="sidebar-scroll"
          aria-label={`${role === "teacher" ? "Teacher" : "Student"} navigation`}
        >
          <div className="sidebar-section-title">
            {role === "teacher" ? "TEACHER WORKSPACE" : "STUDENT WORKSPACE"}
          </div>
          {nav.map(([p, label, Icon]) => (
            <a
              key={p}
              href={
                p === "/student/practice"
                  ? `${p}/settings`
                  : p.startsWith("/teacher/")
                    ? `${p}/${p.endsWith("work") ? "assignments" : p.endsWith("course") ? "plan" : "overview"}`
                    : p
              }
              className={`nav-item ${path.startsWith(p) ? "active" : ""}`}
              aria-current={path.startsWith(p) ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(e.currentTarget.getAttribute("href")!);
              }}
            >
              <Icon size={18} />
              {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {role === "student" && (
            <>
              <div className="progress-label">
                <span>Chapters completed</span>
                <strong>
                  {completed}/{course.units.length}
                </strong>
              </div>
              <div className="progress-track">
                <span
                  style={{
                    width: `${(completed / course.units.length) * 100}%`,
                  }}
                />
              </div>
            </>
          )}
          <div className="sidebar-profile">
            <span className="avatar">{identity[0]?.toUpperCase()}</span>
            <span>
              <strong>{identity}</strong>
              <small>
                {role === "teacher"
                  ? "Teacher workspace"
                  : mode === "live"
                    ? "Kiwi student"
                    : "Local demo student"}
              </small>
            </span>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            {role === "teacher" ? "Teacher" : "Student"}
            <span>/</span>
            {course.title}
            <span>/</span>
            <strong>{current?.[1] || "Workspace"}</strong>
          </div>
          <div className="topbar-right">
            <KiwiReturn kiwi={kiwi} teacher={role === "teacher"} />
            <button
              className="text-button role-switch"
              onClick={() => navigate("/entry")}
            >
              Switch workspace
            </button>
            <span
              className={`connection-pill ${mode === "live" ? "live" : ""}`}
            >
              <span className="connection-dot" />
              {mode === "live" ? "KIWI LIVE" : "LOCAL DEMO"}
            </span>
          </div>
        </header>
        {error && (
          <div className="global-status">
            <p className="error-text" role="alert">
              {error}
            </p>
            <button className="text-button" onClick={() => setError("")}>
              Dismiss
            </button>
          </div>
        )}
        {role === "student" && mode !== "live" && (
          <div className="demo-identity">
            <label>
              Demo student
              <select
                value={choice}
                onChange={(e) => {
                  setChoice(e.target.value);
                  localStorage.setItem("kiwi-lab-student", e.target.value);
                }}
              >
                <option value="ada">Ada Chen</option>
                <option value="bo">Bo Lin</option>
              </select>
            </label>
          </div>
        )}
        {role === "teacher" ? (
          canTeach ? (
          <TeacherDashboard
            verified={verified}
              key={classId}
              classId={classId}
              course={course}
              onCourse={setCourse}
              route={route}
            />
          ) : (
            <section className="teacher-login-screen">
              <h1>Teacher access is required</h1>
              <button
                className="primary-button"
                onClick={() => navigate(rootPath.student)}
              >
                Return to learning
              </button>
            </section>
          )
        ) : path.startsWith("/student/practice") ? (
          <Practice
            key={`${classId}-${studentId}`}
            classId={classId}
            studentId={studentId}
            course={course}
            tool={path.split("/")[3] || "settings"}
            track={track}
          />
        ) : path === "/student/code" ? (
          <div className="student-content">
            <div className="page-intro">
              <div>
                <p className="eyebrow">R WORKSPACE</p>
                <h1>
                  Explore with R<span className="accent-dot">.</span>
                </h1>
                <p className="muted">
                  A scratch workspace for your own experiments. Use the R page
                  inside an assignment to attach code to a specific question.
                </p>
              </div>
            </div>
            <RWorkbench
              key={scratchKey}
              code={scratchCode}
              onCode={setScratch}
              track={track}
              storageKey={scratchKey}
              metadata={{
                unitId: course.currentUnitId,
                title: "Independent R workspace",
              }}
            />
          </div>
        ) : path === "/student/kiwi" ? (
          <div className="student-content">
            <div className="page-intro">
              <div>
                <p className="eyebrow">ASK KIWI</p>
                <h1>
                  Ask, reflect, connect<span className="accent-dot">.</span>
                </h1>
              </div>
            </div>
            <label className="chapter-picker">
              Chapter
              <select
                value={chatUnit}
                onChange={(e) => setChatUnit(e.target.value)}
              >
                {course.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.title}
                  </option>
                ))}
              </select>
            </label>
            <KiwiChat
              key={`${studentId}-${chatUnit}`}
              classId={classId}
              studentId={studentId}
              unitId={chatUnit}
              question={course.units.find((u) => u.id === chatUnit)?.goal || ""}
              code=""
              track={track}
            />
          </div>
        ) : path === "/student/course" ? (
          <div className="student-content">
            <div className="page-intro">
              <div>
                <p className="eyebrow">COURSE OUTLINE</p>
                <h1>{course.title}</h1>
                <p className="muted">{course.description}</p>
              </div>
            </div>
            <div className="course-outline">
              {course.units.map((u, i) => (
                <section className="panel work-panel" key={u.id}>
                  <div className="row-between">
                    <span className="small-pill">Chapter {i + 1}</span>
                    <span className="chapter-status">
                      {u.status === "completed" ? (
                        <>
                          <Check size={15} />
                          Completed
                        </>
                      ) : u.status === "current" ? (
                        "In progress"
                      ) : (
                        "Upcoming"
                      )}
                    </span>
                  </div>
                  <h2>{u.title}</h2>
                  <p className="muted">{u.goal}</p>
                </section>
              ))}
            </div>
          </div>
        ) : (
          <StudentWork
            key={`${classId}-${studentId}`}
            classId={classId}
            course={course}
            studentId={studentId}
            studentName={studentName}
            track={track}
            route={route}
          />
        )}
      </main>
    </div>
  );
}
export default App;
