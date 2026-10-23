import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { navSectionsFor } from "../../lib/routes";
import { ROLE_PERMISSIONS, classifyMe, effectiveNameMode, legacyMe } from "./TeacherContext";
import { showsGlobalTimeRange, TeacherShellView } from "./TeacherShell";
import { roleLabel } from "./AccountMenu";
import { KiwiStaffTable, ROLE_LABELS, roleChangeTitle, STAFF_ROLES_HELP, StaffKeyTable } from "../settings/StaffRolesPanel";

const render = (narrow: boolean, drawerOpen = false, role: "instructor" | "ta" | "viewer" | "researcher" = "instructor") =>
  renderToStaticMarkup(
    <TeacherShellView
      narrow={narrow}
      drawerOpen={drawerOpen}
      onDrawer={() => undefined}
      nav={navSectionsFor(ROLE_PERMISSIONS[role])}
      active="grading"
      courseTitle="Computational Social Science"
      identity={{ name: "Lin", role: "Instructor" }}
      topBar={<span>tools</span>}
    >
      <p>page</p>
    </TeacherShellView>,
  );

describe("TeacherShellView (FOUNDATION-01/03)", () => {
  it("renders the sidebar with the seven instructor sections on wide screens", () => {
    const html = render(false);
    expect(html).toContain('<aside class="sidebar">');
    expect(html.match(/class="nav-item/g)).toHaveLength(7);
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("menu-button");
  });
  it("replaces the sidebar with a menu button and drawer below 768 px", () => {
    const closed = render(true);
    expect(closed).toContain('class="menu-button"');
    expect(closed).toContain('aria-label="Menu"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('aria-controls="teacher-nav-drawer"');
    expect(closed).not.toContain('<aside class="sidebar">');
    expect(closed).not.toContain("teacher-nav-drawer\" class");
    const open = render(true, true);
    expect(open).toContain('id="teacher-nav-drawer"');
    expect(open).toContain('aria-expanded="true"');
    expect(open.match(/class="nav-item/g)).toHaveLength(7);
  });
  it("shows fewer sections for TAs and viewers", () => {
    expect(render(false, false, "ta").match(/class="nav-item/g)).toHaveLength(6);
    expect(render(false, false, "viewer").match(/class="nav-item/g)).toHaveLength(4);
  });
  it("gives a researcher Groups, Chapters & AI tutor and Insights only (decision D3)", () => {
    const html = render(false, false, "researcher");
    expect(html.match(/class="nav-item/g)).toHaveLength(3);
    expect(html).toContain('href="/teacher/students/groups"');
    expect(html).not.toContain('href="/teacher/home"');
    expect(html).not.toContain('href="/teacher/grading"');
    expect(ROLE_PERMISSIONS.researcher).not.toContain("viewStudents");
    expect(ROLE_PERMISSIONS.researcher).not.toContain("previewStudent");
    expect(ROLE_PERMISSIONS.viewer).toContain("viewStudents");
  });
});

describe("global time-range picker (CR-GRADE-2)", () => {
  it("is hidden on Exercise results, which has its own This class picker, and for roles without viewInsights", () => {
    const instructor = ROLE_PERMISSIONS.instructor;
    expect(showsGlobalTimeRange("/teacher/home", instructor)).toBe(true);
    expect(showsGlobalTimeRange("/teacher/assignments/work-1/results", instructor)).toBe(false);
    // review 2 (TEACHER-09): pages with whole-term numbers do not show the picker
    for (const path of ["/teacher/assignments/work-1/edit", "/teacher/assignments", "/teacher/grading", "/teacher/grading/gradebook",
      "/teacher/chapters", "/teacher/students", "/teacher/students/s/s1/timeline"])
      expect(showsGlobalTimeRange(path, instructor)).toBe(false);
    for (const path of ["/teacher/insights/activity", "/teacher/insights/ai-conversations", "/teacher/students/attention", "/teacher/students/s/s1"])
      expect(showsGlobalTimeRange(path, instructor)).toBe(true);
    expect(showsGlobalTimeRange("/teacher/home", [])).toBe(false);
  });
});

describe("researcher identity (decision D3)", () => {
  it("labels the role and always shows pseudonyms", () => {
    const researcher = { ...legacyMe("c1", null)!, kind: "staff_key" as const, role: "researcher" as const,
      permissions: [...ROLE_PERMISSIONS.researcher], pseudonymsForced: true };
    expect(roleLabel(researcher)).toBe("Researcher (staff key)");
    expect(effectiveNameMode(researcher, "names")).toBe("pseudonyms");
    const viewer = { ...researcher, pseudonymsForced: false, role: "viewer" as const };
    expect(effectiveNameMode(viewer, "names")).toBe("names");
    expect(effectiveNameMode(null, "pseudonyms")).toBe("pseudonyms");
  });
});

describe("Staff & roles offers the researcher role (decision D3)", () => {
  it("lists Researcher for staff keys and as a Kiwi override", () => {
    const keys = renderToStaticMarkup(
      <StaffKeyTable staff={[{ id: "staff-r", displayName: "Shen", role: "researcher", kiwiUserId: null, keyPrefix: "ab12cd34", createdAt: "2026-10-22T01:00:00+00:00", revokedAt: null }]}
        me={{ staffId: null }} busy={false} onRole={() => {}} onRevoke={() => {}} />,
    );
    expect(keys).toContain('<option value="researcher" selected="">Researcher</option>');
    const kiwi = renderToStaticMarkup(
      <KiwiStaffTable rows={[{ kiwiUserId: "r1", username: "shen@nyu.edu", kiwiRole: "professor", canManageCourse: false, canViewAnalytics: true,
        effectiveRole: "researcher", roleSource: "override", overrideStaffId: "staff-r", lastSeenAt: "2026-10-22T01:00:00+00:00" }]}
        me={{ userId: "t1" }} busy={false} onChange={() => {}} />,
    );
    expect(kiwi).toContain("<td>Researcher</td>");
    expect(kiwi).toContain('<option value="researcher" selected="">Researcher</option>');
    expect(ROLE_LABELS.researcher).toBe("Researcher");
    expect(STAFF_ROLES_HELP).toContain("pseudonyms only");
  });
});

describe("teacher identity helpers", () => {
  it("derives a compatibility identity when /api/me is unavailable", () => {
    expect(legacyMe("c1", null)?.role).toBe("instructor");
    expect(legacyMe("c1", null)?.permissions).toContain("manageCourse");
    const viewer = legacyMe("c1", { classId: "c1", userId: "u1", canTeach: true, canManageCourse: false, canViewAnalytics: true });
    expect(viewer?.role).toBe("viewer");
    expect(viewer?.exportsForcedPseudonymous).toBe(true);
    const staffOnly = legacyMe("c1", { classId: "c1", userId: "u2", canTeach: true, canManageCourse: false, canViewAnalytics: false });
    expect(staffOnly?.role).toBeNull();
    expect(staffOnly?.permissions).toEqual(["previewStudent"]);
    expect(legacyMe("c1", { classId: "c1", userId: "s", canTeach: false, canManageCourse: false, canViewAnalytics: false })).toBeNull();
  });
  it("treats an anonymous /api/me answer to a stored key as a stale key (cleared, back to the gate)", () => {
    const instructor = legacyMe("c1", null);
    const anonymous = { ...instructor!, kind: "anonymous" as const, role: null, permissions: [], isStaff: false, userId: null };
    const student = { ...anonymous, kind: "demo" as const, role: "student" as const, userId: "demo-ada" };
    expect(classifyMe(instructor, true)).toBe("ready");
    expect(classifyMe(anonymous, true)).toBe("stale_key");
    expect(classifyMe(null, true)).toBe("stale_key");
    expect(classifyMe(anonymous, false)).toBe("no_access");
    expect(classifyMe(student, true)).toBe("no_access");
    expect(classifyMe(null, false)).toBe("signed_out");
  });
  it("labels roles for the account menu", () => {
    expect(roleLabel({ role: "instructor", kind: "teacher_key", isStaff: true })).toBe("Instructor (local key)");
    expect(roleLabel({ role: "ta", kind: "kiwi", isStaff: true })).toBe("Teaching assistant");
    expect(roleLabel({ role: null, kind: "kiwi", isStaff: true })).toBe("Kiwi course staff");
  });
});

describe("SB-m05: skip link", () => {
  it("puts Skip to content first and targets the focusable page content", () => {
    const html = render(false);
    expect(html.indexOf("Skip to content")).toBeLessThan(html.indexOf('class="nav-item'));
    expect(html).toContain('href="#teacher-content"');
    expect(html).toContain('id="teacher-content" tabindex="-1"');
  });
});


describe("SB-m14: staff role changes are confirmed", () => {
  it("names the person and the new role", () => {
    expect(roleChangeTitle("Shen", "Teaching assistant")).toBe("Change Shen to teaching assistant?");
  });
});
