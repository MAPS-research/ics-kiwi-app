import type { ReactNode } from "react";
import { navigate, useRoute } from "../lib/navigation";
import { activeTabHref, sectionTabsFor, SECTION_TABS, type NavSectionId, type SectionTab } from "../lib/routes";
import { useOptionalTeacher } from "../teacher/shell/TeacherContext";

/*
 * Page header rule [LY01]: one line — h1 title (24 px) + optional count/meta + right-aligned actions;
 * no eyebrow, no subtitle, no purple period. Section tabs sit directly under it.
 */
export function PageHeader({
  title,
  count,
  meta,
  actions,
  tabs,
}: {
  title: string;
  count?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
}) {
  const hasCount = count !== undefined && count !== null && count !== "";
  return (
    <>
      <header className="page-header">
        <div className="page-header-title">
          <h1>{title}</h1>
          {hasCount && <span className="page-header-count">{count}</span>}
          {meta && <span className="page-header-meta">{meta}</span>}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </header>
      {tabs}
    </>
  );
}

/** Pure tab row (testable with renderToStaticMarkup). */
export function SectionTabsView({ tabs, activeHref, ariaLabel, counts }: {
  tabs: readonly SectionTab[]; activeHref: string | null; ariaLabel: string;
  /** Live counts per tab href, rendered as `To grade (12)` (CR-GRADE-1, NM12). */
  counts?: Readonly<Record<string, number>>;
}) {
  if (tabs.length < 2) return null;
  return (
    <nav className="page-tabs section-tabs" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <a
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === activeHref ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate(tab.href);
          }}
        >
          {counts?.[tab.href] === undefined ? tab.label : `${tab.label} (${counts[tab.href]})`}
        </a>
      ))}
    </nav>
  );
}

const SECTION_ARIA: Readonly<Record<NavSectionId, string>> = {
  home: "Home pages",
  assignments: "Assignment pages",
  grading: "Grading pages",
  students: "Student pages",
  chapters: "Chapters and AI tutor pages",
  insights: "Insights pages",
  settings: "Course settings pages",
};

/** Section tabs for the current route, filtered by the signed-in role (all tabs outside the teacher context). */
export function SectionTabs({ section, counts }: { section: NavSectionId; counts?: Readonly<Record<string, number>> }) {
  const route = useRoute();
  const teacher = useOptionalTeacher();
  const tabs = teacher ? sectionTabsFor(section, teacher.me.permissions) : [...(SECTION_TABS[section] ?? [])];
  return <SectionTabsView tabs={tabs} activeHref={activeTabHref(tabs, route.split("?")[0])} ariaLabel={SECTION_ARIA[section]} counts={counts} />;
}
