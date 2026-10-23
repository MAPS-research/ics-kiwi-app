import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import {
  BarChart3, BookOpen, ClipboardCheck, House, Layers, Menu, Settings2, Users, X, type LucideIcon,
} from "lucide-react";
import { KiwiBrand } from "../../RoleEntry";
import { KiwiReturn } from "../../KiwiReturn";
import { NameModeProvider } from "../../components/NameContext";
import { LABELS } from "../../lib/labels";
import { navigate, useRoute } from "../../lib/navigation";
import { activeNavSection, navSectionsFor, resolveTeacherRoute, type NavSection, type NavSectionId, type TeacherPageId } from "../../lib/routes";
import { KiwiSyncNotice } from "../kiwi/KiwiSyncNotice";
import { KiwiSyncProvider } from "../kiwi/KiwiSyncProvider";
import { AccountMenu, roleLabel } from "./AccountMenu";
import { PresentationToggle } from "./PresentationToggle";
import { StudentSearch } from "./StudentSearch";
import { TimeRangePicker } from "./TimeRangePicker";
import { useTeacher } from "./TeacherContext";
import type { KiwiClient } from "../../types";

/*
 * Teacher shell (§3.1, §3.6; FOUNDATION, frozen): sidebar (≥ 768 px) or menu button + drawer (< 768 px), global top bar,
 * one <KiwiSyncProvider> around the page. Pages render their own <PageHeader>.
 */

export const NARROW_QUERY = "(max-width: 767px)";

export function useNarrowViewport(): boolean {
  const query = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null);
  const [narrow, setNarrow] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const media = query();
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

const NAV_ICONS: Readonly<Record<NavSectionId, LucideIcon>> = {
  home: House,
  assignments: BookOpen,
  grading: ClipboardCheck,
  students: Users,
  chapters: Layers,
  insights: BarChart3,
  settings: Settings2,
};

export function TeacherNavList({ items, active, onNavigate }: { items: readonly NavSection[]; active: NavSectionId | null; onNavigate?: () => void }) {
  return (
    <nav className="sidebar-scroll teacher-nav" aria-label="Teacher navigation">
      {items.map((item) => {
        const Icon = NAV_ICONS[item.id];
        const current = item.id === active;
        return (
          <a
            key={item.id}
            href={item.root}
            className={`nav-item ${current ? "active" : ""}`}
            aria-current={current ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              onNavigate?.();
              navigate(item.root);
            }}
          >
            <Icon size={18} aria-hidden="true" />
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}

/** Pure shell layout (tested with renderToStaticMarkup; `narrow` switches to the menu button + drawer). */
export const SKIP_TO_CONTENT = "Skip to content";
/** Moves focus to the page content without changing the route (the app uses history routing, not hash links). */
function skipToContent(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  document.getElementById("teacher-content")?.focus();
}

export function TeacherShellView({
  narrow,
  drawerOpen,
  onDrawer,
  nav,
  active,
  courseTitle,
  identity,
  topBar,
  notice,
  children,
}: {
  narrow: boolean;
  drawerOpen: boolean;
  onDrawer: (open: boolean) => void;
  nav: readonly NavSection[];
  active: NavSectionId | null;
  courseTitle: string;
  identity: { name: string; role: string };
  topBar: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}) {
  const profile = (
    <div className="sidebar-profile">
      <span className="avatar" aria-hidden="true">
        {identity.name[0]?.toUpperCase() || "T"}
      </span>
      <span>
        <strong>{identity.name}</strong>
        <small>{identity.role}</small>
      </span>
    </div>
  );
  return (
    <div className={`app-shell role-teacher${narrow ? " is-narrow" : ""}`}>
      {/* SB-m05: keyboard users jump past the navigation and the top bar */}
      <a className="skip-link" href="#teacher-content" onClick={skipToContent}>{SKIP_TO_CONTENT}</a>
      {!narrow && (
        <aside className="sidebar">
          <KiwiBrand />
          <TeacherNavList items={nav} active={active} />
          <div className="sidebar-bottom">{profile}</div>
        </aside>
      )}
      {narrow && drawerOpen && (
        <>
          <div className="drawer-backdrop" onClick={() => onDrawer(false)} />
          <aside id="teacher-nav-drawer" className="teacher-drawer" role="dialog" aria-modal="true" aria-label="Teacher navigation menu">
            <div className="teacher-drawer-head">
              <KiwiBrand />
              <button type="button" className="icon-button" aria-label="Close menu" onClick={() => onDrawer(false)}>
                <X size={18} />
              </button>
            </div>
            <TeacherNavList items={nav} active={active} onNavigate={() => onDrawer(false)} />
            <div className="sidebar-bottom">{profile}</div>
          </aside>
        </>
      )}
      <main className="main-area">
        <header className="topbar teacher-topbar">
          {narrow && (
            <button
              type="button"
              className="menu-button"
              aria-label={LABELS.menu}
              aria-expanded={drawerOpen}
              aria-controls="teacher-nav-drawer"
              onClick={() => onDrawer(!drawerOpen)}
            >
              <Menu size={20} />
            </button>
          )}
          <span className="topbar-course" title={courseTitle}>
            {courseTitle}
          </span>
          <div className="topbar-right teacher-topbar-tools">{topBar}</div>
        </header>
        {notice}
        <div className="teacher-content" id="teacher-content" tabIndex={-1}>{children}</div>
      </main>
    </div>
  );
}

/**
 * Pages whose numbers follow the global time range. Review 2 (TEACHER-09): the picker is hidden elsewhere (Assignments,
 * Grading, Gradebook, Chapters, roster, groups, timelines) so a range never appears to filter whole-term numbers.
 * Exercise results has its own page-local `Time: This class ▾` picker (§3.2; CR-GRADE-2).
 */
export const RANGE_PAGES: ReadonlySet<TeacherPageId> = new Set<TeacherPageId>([
  "home", "needsAttention", "studentProfile", "aiConversations", "activityExplorer", "answersByQuestion", "courseMetrics", "exports",
  "dataHealth", "courseSettings",
]);
export function showsGlobalTimeRange(path: string, permissions: readonly string[]): boolean {
  const route = resolveTeacherRoute(path);
  return permissions.includes("viewInsights") && route !== null && RANGE_PAGES.has(route.route.id);
}

function movedFromState(): string | null {
  const state: unknown = history.state;
  if (state && typeof state === "object" && "kiwiMovedFrom" in state) return String((state as { kiwiMovedFrom: unknown }).kiwiMovedFrom);
  return null;
}

export function TeacherShell({ kiwi, children }: { kiwi: KiwiClient | null; children: ReactNode }) {
  const { me, course, nameMode } = useTeacher();
  const route = useRoute();
  const path = route.split("?")[0];
  const narrow = useNarrowViewport();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [movedFrom, setMovedFrom] = useState<string | null>(null);
  useEffect(() => {
    setDrawerOpen(false);
    setMovedFrom(movedFromState());
  }, [route]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);
  const permissions = me.permissions;
  const topBar = (
    <>
      {permissions.includes("viewStudents") && <StudentSearch />}
      {showsGlobalTimeRange(path, permissions) && <TimeRangePicker />}
      <PresentationToggle />
      <KiwiSyncNotice />
      <KiwiReturn kiwi={kiwi} teacher />
      {/* review 2 (TEACHER-10): Preview as student moved into the account menu so the top bar stays one row */}
      <AccountMenu />
    </>
  );
  const notice = movedFrom ? (
    <div className="global-status moved-notice" role="status">
      <p>{LABELS.pageMoved}. Bookmarks to {movedFrom} now open Home.</p>
      <button type="button" className="text-button" onClick={() => setMovedFrom(null)}>
        {LABELS.dismiss}
      </button>
    </div>
  ) : null;
  return (
    <KiwiSyncProvider>
      <NameModeProvider mode={nameMode}>
        <TeacherShellView
          narrow={narrow}
          drawerOpen={drawerOpen}
          onDrawer={setDrawerOpen}
          nav={navSectionsFor(permissions)}
          active={activeNavSection(path)}
          courseTitle={course?.title ?? "CSS Lab"}
          identity={{ name: me.displayName || "Teacher", role: roleLabel(me) === me.displayName ? "Teacher workspace" : roleLabel(me) }}
          topBar={topBar}
          notice={notice}
        >
          {children}
        </TeacherShellView>
      </NameModeProvider>
    </KiwiSyncProvider>
  );
}
