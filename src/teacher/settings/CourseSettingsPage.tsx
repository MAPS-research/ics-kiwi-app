import { useCallback, useEffect, useState } from "react";
import { PageHeader, SectionTabsView } from "../../components/PageHeader";
import { setDisplayTimeZone } from "../../lib/format";
import { api } from "../../lib/api";
import { normalizeCourse, toCourseInput } from "../../lib/course";
import { teacherPaths } from "../../lib/routes";
import { useTeacher, type TeacherPageProps } from "../shell/TeacherContext";
import { CourseInfoPanel, DefaultsPanel } from "./CourseInfoPanel";
import { CoursePackagePanel } from "./CoursePackagePanel";
import { KiwiConnectionPanel } from "./KiwiConnectionPanel";
import { PrivacyPanel } from "./PrivacyPanel";
import { SchedulePanel } from "./SchedulePanel";
import { StaffRolesPanel } from "./StaffRolesPanel";
import type { Course, CourseSettings } from "../../types";

/*
 * Course settings [§3.1, §14] — owned by PEOPLE. Tabs: Course info (+ grading/AI defaults), Class schedule, Kiwi
 * connection, Staff & roles, Privacy (incl. retention, deletion, audit log), Course package.
 * Query: ?tab=course|schedule|kiwi|staff|privacy|package
 */

export { CourseInfoPanel } from "./CourseInfoPanel";

export type SettingsTab = "course" | "schedule" | "kiwi" | "staff" | "privacy" | "package";
export const SETTINGS_TABS: readonly { id: SettingsTab; label: string; description: string }[] = [
  { id: "course", label: "Course info", description: "Title, description and grading/AI defaults." },
  { id: "schedule", label: "Class schedule", description: "Class meetings and time zone used by Since last class and This class." },
  { id: "kiwi", label: "Kiwi connection", description: "Kiwi link status, native chat guidance mode and import counts." },
  { id: "staff", label: "Staff & roles", description: "Instructors, teaching assistants, viewers and researchers, including Kiwi course staff." },
  { id: "privacy", label: "Privacy", description: "Emails, default name mode, research purpose, consent, retention and audit log." },
  { id: "package", label: "Course package", description: "Export this course as a package or start from a course template." },
];
export function settingsTab(value: string | null): SettingsTab {
  return SETTINGS_TABS.some((t) => t.id === value) ? (value as SettingsTab) : "course";
}

export function CourseSettingsPage({ route }: TeacherPageProps) {
  const { classId, course, setCourse, me, timeRange, setTimePreset } = useTeacher();
  const tab = settingsTab(new URL(route, "http://lab.local").searchParams.get("tab"));
  const [draft, setDraft] = useState<Course | null>(course ? structuredClone(course) : null);
  const [settings, setSettings] = useState<CourseSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => setDraft(course ? structuredClone(course) : null), [course]);
  useEffect(() => {
    api.settings(classId).then(setSettings).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [classId]);
  const saveCourse = async () => {
    if (!draft || !course) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      // WHY: only title/description change here; chapters keep the stored values.
      const saved = normalizeCourse(await api.saveCourse(classId, toCourseInput({ ...course, title: draft.title, description: draft.description })));
      setCourse(saved);
      setMessage("Course info updated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const saveSettings = useCallback(
    async (patch: Partial<CourseSettings>) => {
      setBusy(true);
      setError("");
      setMessage("");
      try {
        const saved = await api.saveSettings(classId, patch);
        setSettings(saved);
        setDisplayTimeZone(saved.schedule.timezone);   // dates follow a changed course zone at once (TEACHER-02)
        // S-m04: a new schedule changes "This class" / "Since last class": ask the server for the range again
        if (patch.schedule) setTimePreset(timeRange.preset, timeRange.preset === "custom" && timeRange.from && timeRange.to
          ? { from: timeRange.from, to: timeRange.to } : undefined);
        setMessage("Settings saved.");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [classId, setTimePreset, timeRange.preset, timeRange.from, timeRange.to],
  );
  const tabs = SETTINGS_TABS.map((t) => ({ label: t.label, href: teacherPaths.settings(t.id === "course" ? undefined : t.id) }));
  const linked = Boolean(course?.linked || me.classLinked);
  return (
    <>
      <PageHeader
        title="Course settings"
        tabs={<SectionTabsView tabs={tabs} activeHref={teacherPaths.settings(tab === "course" ? undefined : tab)} ariaLabel="Course settings pages" />}
      />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="work-message" role="status">
          {message}
        </p>
      )}
      {tab === "course" && (
        <>
          {draft && <CourseInfoPanel draft={draft} setDraft={setDraft} busy={busy} readOnly={!me.permissions.includes("manageCourse")} onSave={() => void saveCourse()} />}
          {settings && <DefaultsPanel settings={settings} busy={busy} onSave={(p) => void saveSettings(p)} />}
        </>
      )}
      {tab === "schedule" && settings && <SchedulePanel settings={settings} busy={busy} rangeLabel={timeRange.label} onSave={(p) => void saveSettings(p)} />}
      {tab === "kiwi" && <KiwiConnectionPanel classId={classId} linked={linked} />}
      {tab === "staff" && <StaffRolesPanel classId={classId} me={me} linked={linked} />}
      {tab === "privacy" && settings && <PrivacyPanel classId={classId} settings={settings} busy={busy} onSave={(p) => void saveSettings(p)} />}
      {tab === "package" && <CoursePackagePanel classId={classId} setCourse={setCourse} />}
    </>
  );
}
