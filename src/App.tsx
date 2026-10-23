import { useCallback, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { RoleEntry } from "./RoleEntry";
import { KiwiReturn } from "./KiwiReturn";
import { StudentApp } from "./student/StudentApp";
import { TeacherApp } from "./teacher/TeacherApp";
import { readStoredTeacherKey } from "./teacher/shell/TeacherContext";
import { api, ApiError, setDemoSessionHeader, setKiwiTokenProvider, setPreviewHeader, setTeacherKeyHeader } from "./lib/api";
import { normalizeCourse } from "./lib/course";
import { setDisplayTimeZone } from "./lib/format";
import {
  demoChoices, ensureDemoSession, exchangeDemoToken, parseDemoFragment, readDemoSession, selectDemoStudent, selectedDemoStudent, stripDemoFragment,
  type DemoSession,
} from "./lib/demoSession";
import { getKiwi } from "./lib/kiwi";
import { navigate, useRoute } from "./lib/navigation";
import { isPreviewPath, legacyRedirect, previewPaths, studentPaths, teacherPaths } from "./lib/routes";
import type { Course, KiwiClient, VerifiedKiwiContext } from "./types";
import { takePreviewReturn } from "./lib/previewReturn";

/*
 * App boot (FOUNDATION, frozen): Kiwi SDK, verified identity, standalone demo sessions (incl. the `#demo=` fragment
 * exchange), role routing, legacy redirects (§3.3) and preview routing (§3.4). Every staff identity that opens the
 * student workspace is sent to /preview/student/… — staff never act as students outside preview [TR05].
 */

type Role = "teacher" | "entry" | "preview" | "student";
export function roleForPath(path: string): Role {
  if (path === "/teacher" || path.startsWith("/teacher/")) return "teacher";
  if (path === "/entry") return "entry";
  if (isPreviewPath(path)) return "preview";
  return "student";
}

/**
 * R-B01: App loads the course for the entry page, the student app and preview (each with that role's headers, so it is
 * the student view). The teacher workspace loads the staff course itself once the staff identity is known, because App's
 * request runs before the teacher key is set (and before a sign-in on the teacher gate).
 */
export function courseLoadedByApp(role: Role): boolean {
  return role !== "teacher";
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function BootScreen({ error, kiwi, teacher, action }: { error?: string; kiwi: KiwiClient | null; teacher?: boolean; action?: { label: string; onClick: () => void } }) {
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
      {error && (
        <>
          <button className="primary-button" onClick={action?.onClick ?? (() => location.reload())}>
            {action?.label ?? "Try again"}
          </button>
          <KiwiReturn kiwi={kiwi} teacher={teacher} />
        </>
      )}
    </div>
  );
}

function App() {
  const route = useRoute();
  const path = route.split("?")[0];
  const search = route.slice(path.length);
  const redirect = legacyRedirect(path, search);
  const role = roleForPath(path);

  const [kiwi, setKiwi] = useState<KiwiClient | null>(null);
  const [verified, setVerified] = useState<VerifiedKiwiContext | null>(null);
  const [mode, setMode] = useState<"connecting" | "sim" | "live">("connecting");
  const [classId, setClass] = useState("");
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [demo, setDemo] = useState<DemoSession | null>(null);
  const [demoState, setDemoState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [demoStudent, setDemoStudent] = useState(selectedDemoStudent);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [demoLinkRevision, setDemoLinkRevision] = useState(0);

  // WHY: opening a `#demo=` link in a tab that already shows the student app is a same-document hash change (no
  // reload), so the exchange below must also run on `hashchange`.
  useEffect(() => {
    const onHash = () => {
      if (parseDemoFragment(location.hash)) setDemoLinkRevision((n) => n + 1);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!redirect) return;
    history.replaceState(redirect.notice ? { kiwiMovedFrom: path } : history.state, "", `${redirect.to}${location.hash}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [redirect?.to, redirect?.notice, path]);

  // Boot: Kiwi SDK and verified identity (v0.5.1 behavior; standalone falls back to the local simulator).
  useEffect(() => {
    let active = true;
    getKiwi()
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
      .catch((e: unknown) => {
        if (!active) return;
        if (window.parent === window) {
          setMode("sim");
          setClass("local-r-class");
        }
        setError(`Kiwi connection unavailable: ${errorText(e)}`);
      });
    return () => {
      active = false;
    };
  }, []);

  // WHY keyed by role: each role's request carries its own headers (preview, demo session), and coming back from the
  // teacher workspace (which may have changed chapters) loads the course again.
  useEffect(() => {
    if (!classId) return;
    setCourse(null);
    if (!courseLoadedByApp(role)) return;
    let active = true;
    api
      .course(classId)
      .then((c) => {
        if (!active) return;
        const normalized = normalizeCourse(c);
        setDisplayTimeZone(normalized.timeZone);   // every page shows dates in the course zone (TEACHER-02)
        setCourse(normalized);
      })
      .catch((e: unknown) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [classId, role]);

  const teacherKey = mode === "sim" && classId ? readStoredTeacherKey(classId) : null;
  const isStaffVisitor = mode === "live" ? Boolean(verified?.canTeach) : mode === "sim" ? Boolean(teacherKey) : false;

  // WHY in render: child pages fire requests in their effects, which run before this component's effects.
  setPreviewHeader(role === "preview");
  if (role === "student") {
    setTeacherKeyHeader(null);
    setDemoSessionHeader(mode === "sim" ? demo?.token ?? null : null);
  } else {
    setDemoSessionHeader(null);
    if (role === "preview") setTeacherKeyHeader(mode === "sim" ? teacherKey : null);
  }

  // Staff in the student app → preview; non-staff on a preview URL → the student app.
  useEffect(() => {
    if (mode === "connecting" || redirect) return;
    if (role === "student" && isStaffVisitor) navigate(`/preview${route}`, true);
    else if (role === "preview" && !isStaffVisitor) navigate(route.replace(/^\/preview/, ""), true);
  }, [mode, role, isStaffVisitor, route, redirect]);

  // Standalone students: `#demo=` exchange, then a session for the selected demo student.
  useEffect(() => {
    if (mode !== "sim" || !classId || role !== "student" || isStaffVisitor) return;
    let active = true;
    const token = parseDemoFragment(location.hash);
    const cached = token ? null : readDemoSession(classId, demoStudent);
    if (cached) {
      setDemo(cached);
      setDemoState("ready");
      return;
    }
    setDemoState("loading");
    (async () => {
      if (token) {
        history.replaceState(history.state, "", `${location.pathname}${location.search}${stripDemoFragment(location.hash)}`);
        try {
          const linked = await exchangeDemoToken(classId, token);
          if (!active) return;
          setDemoStudent(linked.studentId);
          setDemo(linked);
          setDemoState("ready");
          return;
        } catch (e) {
          if (active) setNotice(`This demo link could not be used: ${errorText(e)}`);
        }
      }
      try {
        const session = await ensureDemoSession(classId, demoStudent);
        if (!active) return;
        setDemo(session);
        setDemoState("ready");
      } catch (e) {
        if (!active) return;
        // WHY: a server without demo sessions (v0.5.1) still accepts the student id; a v0.6 server answers 403 visibly.
        if (!(e instanceof ApiError && e.status === 404)) setNotice(`Demo sign-in failed: ${errorText(e)}`);
        setDemo(null);
        setDemoState("failed");
      }
    })();
    return () => {
      active = false;
    };
  }, [mode, classId, role, isStaffVisitor, demoStudent, demoLinkRevision]);

  // Preview: the server derives the preview student id from the staff identity (`preview-<userId>`).
  useEffect(() => {
    if (role !== "preview" || !classId || mode === "connecting" || !isStaffVisitor) return;
    let active = true;
    setPreviewError("");
    api
      .me(classId)
      .then((me) => {
        if (!active) return;
        if (!me.isStaff) {
          setPreviewError("Preview as student is only available to course staff.");
          return;
        }
        setPreviewId(`preview-${me.userId ?? "instructor"}`);
      })
      .catch((e: unknown) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 404) setPreviewId(verified ? `preview-${verified.userId}` : "preview-instructor");
        else setPreviewError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [role, classId, mode, isStaffVisitor, verified]);

  // RV6-m01: back to the page that opened the preview (e.g. the assignment editor), Home otherwise
  const exitPreview = useCallback(() => navigate(takePreviewReturn(teacherPaths.home())), []);

  if (redirect) return null;
  // R-B01: the teacher workspace does not wait for App's course (it loads the staff course after sign-in)
  if (role === "teacher" && classId && mode !== "connecting") return <TeacherApp key={classId} classId={classId} kiwi={kiwi} verified={verified} />;
  if (!course || mode === "connecting") return <BootScreen error={error} kiwi={kiwi} teacher={role === "teacher"} />;

  if (role === "entry")
    return (
      <RoleEntry
        courseTitle={course.title}
        canTeach={mode === "sim" || Boolean(verified?.canTeach)}
        kiwi={kiwi}
        onChoose={(r) =>
          navigate(r === "teacher" ? teacherPaths.home() : r === "student" ? (isStaffVisitor ? previewPaths.assignments() : studentPaths.assignments()) : studentPaths.entry())
        }
      />
    );

  if (role === "preview") {
    if (!isStaffVisitor) return <BootScreen kiwi={kiwi} />;
    if (previewError)
      return <BootScreen error={previewError} kiwi={kiwi} teacher action={{ label: "Open the teacher workspace", onClick: () => navigate(teacherPaths.home()) }} />;
    if (!previewId) return <BootScreen kiwi={kiwi} />;
    return (
      <StudentApp
        key={`${classId}-${previewId}`}
        classId={classId}
        course={course}
        kiwi={kiwi}
        mode={mode}
        studentId={previewId}
        studentName="Preview student"
        preview
        demo={null}
        notice=""
        onDismissNotice={() => undefined}
        onExitPreview={exitPreview}
      />
    );
  }

  // Student workspace
  if (isStaffVisitor) return <BootScreen kiwi={kiwi} />;
  if (mode === "live") {
    const studentId = verified?.userId || "";
    return (
      <StudentApp
        key={`${classId}-${studentId}`}
        classId={classId}
        course={course}
        kiwi={kiwi}
        mode={mode}
        studentId={studentId}
        studentName={verified?.username || studentId}
        preview={false}
        demo={null}
        notice={notice || error}
        onDismissNotice={() => {
          setNotice("");
          setError("");
        }}
        onExitPreview={exitPreview}
      />
    );
  }
  if (demoState === "idle" || demoState === "loading") return <BootScreen kiwi={kiwi} />;
  const choices = demoChoices(classId);
  const studentId = demo?.studentId ?? demoStudent;
  const studentName = demo?.studentName ?? choices.find((c) => c.studentId === studentId)?.studentName ?? studentId;
  return (
    <StudentApp
      key={`${classId}-${studentId}`}
      classId={classId}
      course={course}
      kiwi={kiwi}
      mode={mode}
      studentId={studentId}
      studentName={studentName}
      preview={false}
      demo={{
        choices,
        selected: studentId,
        onSelect: (id) => {
          selectDemoStudent(id);
          setDemoStudent(id);
        },
      }}
      notice={notice || error}
      onDismissNotice={() => {
        setNotice("");
        setError("");
      }}
      onExitPreview={exitPreview}
    />
  );
}
export default App;
