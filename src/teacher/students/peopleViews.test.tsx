import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROLE_PERMISSIONS, TeacherProvider } from "../shell/TeacherContext";
import { PresentationToggle } from "../shell/PresentationToggle";
import { roleLabel } from "../shell/AccountMenu";
import { DEFAULT_EXPORT_OPTIONS, EXPORT_ENTRIES, exportParams, ExportsView, exportUnavailable, filterSummary, researchProblem, UNVERIFIED_ROLE_NOTE, visibleExports, type ExportOptions } from "../insights/ExportsPage";
import { GroupsView, randomizeProblem } from "./GroupsPage";
import { cellTone, profileActions, profileHeaderText, StudentProfileView } from "./StudentProfilePage";
import { consentLabel, DemoLinkView, demoLinkUrl, diffText, editDraftFor, ROSTER_COLUMNS, RosterView, rosterPatch } from "./RosterPage";
import { KiwiStaffTable, kiwiRoleText, StaffKeyTable } from "../settings/StaffRolesPanel";
import { scheduleProblem } from "../settings/SchedulePanel";
import { privacyProblem, retentionText } from "../settings/PrivacyPanel";
import { applyConfirmText, importSummary, ImportResultView } from "../settings/CoursePackagePanel";
import { kiwiConnectionLines } from "../settings/KiwiConnectionPanel";
import { AuditTable } from "../settings/AuditLogPanel";
import type { GradebookCell, Group, Me, Permission, RosterEntry, StaffRole, StudentProfile, TeacherContextValue } from "../../types";

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  studentId: "s1", studentName: "Ada Chen", displayName: "Ada Chen", email: "ada@example.edu", pseudonym: "S-001", source: "import",
  status: "active", groups: [{ kind: "section", groupId: "grp-1", name: "Section A" }], consent: "not_asked", consentSource: "none",
  excluded: false, exclusionReason: "", lastActive: null, missingWork: 2, activitiesRecorded: 7, ...over,
});

const me = (role: StaffRole, over: Partial<Me> = {}): Me => ({
  kind: "teacher_key", classId: "c1", userId: "instructor", displayName: "Instructor", role, permissions: [...ROLE_PERMISSIONS[role]] as Permission[],
  isStaff: true, roleSource: "key", exportsForcedPseudonymous: role === "viewer", preview: false, verified: false, classLinked: false, staffId: null, ...over,
});

const cell = (over: Partial<GradebookCell> = {}): GradebookCell => ({
  assignmentId: "w1", state: "released", score: 16, maxPoints: 20, attempts: 1, late: true, lateSeconds: 60, overTime: false,
  latestSubmissionId: "sub-1", scoredSubmissionId: "sub-1", draftAnswered: 0, draftTotal: 2, label: "16/20 · 1 submission", ...over,
});

const profile = (over: Partial<StudentProfile> = {}): StudentProfile => ({
  student: entry(), header: { lastActive: null, missing: 1, late: 1, avgScorePct: 82 }, fullTimelineUrl: "/teacher/students/s/s1/timeline",
  canExportConversations: true,
  assignments: [{ assignmentId: "w1", title: "Week 3 HW", kind: "homework", dueAt: "2026-10-24T15:59:00+00:00", cell: cell(),
                  timelineUrl: "/teacher/students/s/s1/assignments/w1", gradingUrl: "/teacher/grading?assignmentId=w1&studentId=s1", draftAnswered: null }],
  recentErrors: [{ at: "2026-10-20T01:00:00+00:00", questionLabel: "Week 3 HW · q1", error: "object 'x' not found", href: "/teacher/students/s/s1/timeline" }],
  recentAiQuestions: [{ at: "2026-10-20T01:00:00+00:00", prompt: "why NA?", where: "kiwi", threadKey: "kiwi:c1", flagged: true }],
  practiceByChapter: [{ unitId: "u1", title: "03 · Joins", freeItems: 3, similarItems: 1, serverAccuracy: 50, activeMinutes: 12 }],
  ...over,
});

describe("Roster view (PEOPLE-14, NM24)", () => {
  it("renders the roster columns, consent and Open profile", () => {
    const html = renderToStaticMarkup(
      <RosterView students={[entry()]} total={1} page={1} filters={{ search: "", groupId: "", consent: "", status: "" }} groups={[]} canManage={false}
        selected={new Set()} onFilter={() => {}} onPage={() => {}} onEdit={() => {}} onToggle={() => {}} onToggleAll={() => {}} />,
    );
    expect([...ROSTER_COLUMNS]).toEqual(["Student", "ID", "Group", "Last active", "Missing work", "Research consent", "Profile"]);
    for (const column of ROSTER_COLUMNS) expect(html).toContain(`<th>${column}</th>`);
    expect(html).toContain("Open profile");
    expect(html).toContain("Activities recorded: 7");
    expect(html).toContain("Not asked");
    expect(html).toContain("Section A");
    expect(html).not.toContain(">Edit<");
    const manager = renderToStaticMarkup(
      <RosterView students={[entry({ excluded: true, exclusionReason: "Test" })]} total={1} page={1} filters={{ search: "", groupId: "", consent: "", status: "" }}
        groups={[]} canManage selected={new Set(["s1"])} onFilter={() => {}} onPage={() => {}} onEdit={() => {}} onToggle={() => {}} onToggleAll={() => {}} />,
    );
    expect(manager).toContain('aria-label="Select Ada Chen"');
    expect(manager).toContain('aria-label="Edit Ada Chen"');
    expect(manager).toContain("Excluded from analytics");
  });
  it("hides raw ids in Presentation mode (ids can carry names)", () => {
    const html = renderToStaticMarkup(
      <RosterView students={[entry({ studentId: "demo-ada", studentName: "S-001" })]} total={1} page={1} filters={{ search: "", groupId: "", consent: "", status: "" }}
        groups={[]} canManage={false} selected={new Set()} hideIds onFilter={() => {}} onPage={() => {}} onEdit={() => {}} onToggle={() => {}} onToggleAll={() => {}} />,
    );
    expect(html).not.toContain(">demo-ada<");
    const profileHtml = renderToStaticMarkup(<StudentProfileView profile={profile({ student: entry({ studentId: "demo-ada" }) })} permissions={ROLE_PERMISSIONS.viewer} hideId onExportConversations={() => {}} onCaseFile={() => {}} />);
    expect(profileHtml).not.toContain("demo-ada<");
  });
  it("builds minimal PATCH bodies and readable diffs", () => {
    const e = entry();
    expect(rosterPatch(e, editDraftFor(e))).toBeNull();
    expect(rosterPatch(e, { ...editDraftFor(e), status: "dropped", consent: "yes", note: " Paper form " })).toEqual({
      status: "dropped", consentOverride: { value: "yes", note: "Paper form" },
    });
    expect(rosterPatch(e, { ...editDraftFor(e), excluded: true, reason: "TA account" })).toEqual({ excluded: { value: true, reason: "TA account" } });
    expect(diffText({ displayName: ["Bo", "Bo Lin"], section: [null, "Sec A"] })).toBe("displayName: Bo → Bo Lin; section: — → Sec A");
    expect(consentLabel("yes")).toBe("Yes");
  });
});

describe("Student profile (PEOPLE-01, PEOPLE-22)", () => {
  it("shows the header and every action for an instructor", () => {
    expect(profileHeaderText({ lastActive: null, missing: 1, late: 0, avgScorePct: 82 })).toBe("Last active never · Missing 1 · Avg 82%");
    const html = renderToStaticMarkup(<StudentProfileView profile={profile()} permissions={ROLE_PERMISSIONS.instructor} onExportConversations={() => {}} onCaseFile={() => {}} />);
    for (const text of ["Full activity timeline", "Export this student&#x27;s AI conversations", "Download case file", "Grade this student&#x27;s submissions",
                        "Week 3 HW", "16/20 · 1 submission", "object &#x27;x&#x27; not found", "Kiwi lecture AI", "Flagged", "03 · Joins", "Due", "Late"])
      expect(html).toContain(text);
    expect(html).toContain('href="/teacher/grading?assignmentId=w1&amp;studentId=s1"');
  });
  it("gives a TA grading and the case file, and a viewer neither", () => {
    expect(profileActions({ canExportConversations: true }, ROLE_PERMISSIONS.ta)).toEqual({ timeline: true, exportConversations: true, caseFile: true, gradeSubmissions: true });
    const viewerProfile = profile({ canExportConversations: false, assignments: profile().assignments.map((a) => ({ ...a, gradingUrl: null })) });
    const html = renderToStaticMarkup(<StudentProfileView profile={viewerProfile} permissions={ROLE_PERMISSIONS.viewer} onExportConversations={() => {}} onCaseFile={() => {}} />);
    expect(html).toContain("Full activity timeline");
    expect(html).not.toContain("Download case file");
    expect(html).not.toContain("Grade this student");
    expect(html).not.toContain("Export this student");
    expect(html).not.toContain(">Grade<");
    expect(cellTone(cell({ state: "missing" }))).toBe("danger");
  });
});

describe("Exports (PEOPLE-15, PEOPLE-19)", () => {
  const opts: ExportOptions = { useRange: true, unitIds: ["u1"], groupIds: [], pseudonymize: false, consent: "all", purpose: "", allowUnverified: false, includeRaw: false,
    researchPseudonymize: false, researchConsent: "all" };
  it("labels the exports menu as specified", () => {
    const labels = EXPORT_ENTRIES.map((e) => e.label);
    for (const label of ["Grades for LMS (CSV)", "Student × assignment status (CSV)", "Activity log", "AI conversations", "Coded conversations (CSV)", "Research package"])
      expect(labels).toContain(label);
    const html = renderToStaticMarkup(<ExportsView me={me("instructor")} opts={opts} rangeLabel="Since last class" units={[{ id: "u1", title: "03 · Joins" }]} groups={[]} busy="" onOpts={() => {}} onDownload={() => {}} />);
    expect(html).toContain("Grades for LMS (CSV)");
    expect(html).toContain('aria-label="Download Activity log as JSONL"');
  });
  it("summarizes the collapsed filters", () => {
    expect(filterSummary(opts, "Since last class", false, 5)).toBe("Since last class · 1 of 5 chapters · all groups · with names · all students");
    expect(filterSummary({ ...opts, useRange: false }, "x", true, 5)).toBe("whole term · 1 of 5 chapters · all groups · pseudonymized · consented students only");
  });
  it("forces viewer exports to be pseudonymized with consent and hides what a viewer cannot download", () => {
    const viewer = me("viewer");
    expect(visibleExports(viewer).map((e) => e.id)).toEqual(["activity", "conversations", "items", "codes", "codebook"]);
    const activity = EXPORT_ENTRIES.find((e) => e.id === "activity")!;
    expect(exportParams(activity, opts, { from: "2026-10-20T02:00:00+00:00", to: null }, true)).toEqual({
      from: "2026-10-20T02:00:00+00:00", unitIds: "u1", pseudonymize: "1", consent: "yes",
    });
    const html = renderToStaticMarkup(<ExportsView me={viewer} opts={opts} rangeLabel="x" units={[]} groups={[]} busy="" onOpts={() => {}} onDownload={() => {}} />);
    expect(html).toContain("de-identified exports only");
    expect(html).not.toContain("Grades for LMS");
    // RV6-M07/m18: a standalone course has no verified identities, so the data exports say why they are unavailable
    expect(html).toContain(UNVERIFIED_ROLE_NOTE);
    expect(html).toContain("Filters for your exports:");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Download Activity log as CSV"/);
    expect(exportUnavailable({ id: "codebook" }, viewer)).toBe(false);
    expect(exportUnavailable({ id: "activity" }, { ...viewer, classLinked: true })).toBe(false);
    const linked = renderToStaticMarkup(<ExportsView me={{ ...viewer, classLinked: true }} opts={opts} rangeLabel="x" units={[]} groups={[]} busy="" onOpts={() => {}} onDownload={() => {}} />);
    expect(linked).not.toContain(UNVERIFIED_ROLE_NOTE);
    const research = EXPORT_ENTRIES.find((e) => e.id === "research")!;
    expect(researchProblem(opts, false)).toMatch(/purpose/);
    expect(researchProblem({ ...opts, purpose: "Course reflection" }, false)).toMatch(/pseudonymized/);
    expect(exportParams(research, { ...opts, purpose: "Course reflection", researchPseudonymize: true, researchConsent: "yes" }, { from: null, to: null }, false)).toMatchObject({
      pseudonymize: "1", consent: "yes", purpose: "Course reflection",
    });
  });
  it("defaults the research package to pseudonymized, consented students, independent of the teaching filter", () => {  // TEACHER-04
    const research = EXPORT_ENTRIES.find((e) => e.id === "research")!;
    const activity = EXPORT_ENTRIES.find((e) => e.id === "activity")!;
    const defaults = { ...DEFAULT_EXPORT_OPTIONS, purpose: "Help-seeking study" };
    expect(researchProblem(defaults, false)).toBe("");
    expect(exportParams(research, defaults, { from: null, to: null }, false)).toMatchObject({ pseudonymize: "1", consent: "yes" });
    expect(exportParams(activity, defaults, { from: null, to: null }, false)).toMatchObject({ consent: "all" });
    expect(exportParams(activity, defaults, { from: null, to: null }, false).pseudonymize).toBe("0");
    const html = renderToStaticMarkup(<ExportsView me={me("instructor")} opts={defaults} rangeLabel="x" units={[]} groups={[]} busy="" onOpts={() => {}} onDownload={() => {}} />);
    expect(html).toContain("Filters for the teaching exports");
    expect(html).toContain('aria-label="Students in the research package"');
    const zip = /<button[^>]*aria-label="Download Research package as ZIP"[^>]*>/.exec(html)?.[0] ?? "";
    expect(zip).not.toBe("");
    expect(zip).not.toContain("disabled");
  });
});

describe("Shell controls (TH12, NM46)", () => {
  const value = (nameMode: "names" | "pseudonyms"): TeacherContextValue => ({
    classId: "c1", course: null, setCourse: () => {}, me: me("instructor"), refreshMe: async () => {},
    timeRange: { preset: "whole_term", effectivePreset: "whole_term", from: null, to: null, compareFrom: null, compareTo: null, label: "Whole term", compareLabel: null },
    setTimePreset: () => {}, nameMode, setNameMode: () => {}, teacherKey: "k", setTeacherKey: () => {}, signOut: () => {},
  });
  it("shows the pressed Presentation mode pill", () => {
    const on = renderToStaticMarkup(<TeacherProvider value={value("pseudonyms")}><PresentationToggle /></TeacherProvider>);
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("Presentation mode");
    const off = renderToStaticMarkup(<TeacherProvider value={value("names")}><PresentationToggle /></TeacherProvider>);
    expect(off).toContain('aria-pressed="false"');
    expect(roleLabel({ role: "ta", kind: "staff_key", isStaff: true })).toBe("Teaching assistant (staff key)");
  });
});

describe("Groups (PEOPLE-02)", () => {
  const groups: Group[] = [
    { id: "a", name: "A", kind: "condition", description: "", members: 3, archived: false },
    { id: "b", name: "B", kind: "condition", description: "", members: 3, archived: false },
    { id: "s", name: "Sec 1", kind: "section", description: "Tue", members: 6, archived: false },
    { id: "c", name: "Needs attention · 10/22", kind: "cohort", description: "", members: 2, archived: false },
  ];
  it("renders groups by kind and validates random assignment", () => {
    const html = renderToStaticMarkup(<GroupsView groups={groups} canManage onMembers={() => {}} onRename={() => {}} onArchive={() => {}} />);
    for (const text of ["Sections", "Experimental conditions", "Cohorts", "3 students", "Needs attention · 10/22", "Members"]) expect(html).toContain(text);
    expect(randomizeProblem(groups, ["a", "b"], "css190-f26")).toBe("");
    expect(randomizeProblem(groups, ["a"], "x")).toMatch(/two/);
    expect(randomizeProblem(groups, ["a", "s"], "x")).toMatch(/one kind/);
    expect(randomizeProblem(groups, ["a", "b"], "")).toMatch(/seed/);
  });
});

describe("Course settings panels (PEOPLE-03/18/21, §14)", () => {
  it("lists Kiwi staff with role source and disables the caller's own row", () => {
    const rows = [
      { kiwiUserId: "t1", username: "lin@nyu.edu", kiwiRole: "professor", canManageCourse: true, canViewAnalytics: true, effectiveRole: "instructor" as const, roleSource: "kiwi" as const, overrideStaffId: null, lastSeenAt: "2026-10-22T01:00:00+00:00" },
      { kiwiUserId: "t2", username: "wang@nyu.edu", kiwiRole: "ta", canManageCourse: true, canViewAnalytics: true, effectiveRole: "viewer" as const, roleSource: "override" as const, overrideStaffId: "staff-1", lastSeenAt: "2026-10-22T01:00:00+00:00" },
    ];
    const html = renderToStaticMarkup(<KiwiStaffTable rows={rows} me={{ userId: "t1" }} busy={false} onChange={() => {}} />);
    expect(html).toContain("From Kiwi");
    expect(html).toContain("Override");
    expect(html).toContain("Assistant (TA)");
    expect(html).toMatch(/aria-label="Change Lab role for lin@nyu.edu" disabled=""/);
    expect(html).not.toMatch(/aria-label="Change Lab role for wang@nyu.edu" disabled=""/);
    expect(kiwiRoleText("admin")).toBe("Kiwi admin");
    const keys = renderToStaticMarkup(
      <StaffKeyTable staff={[{ id: "staff-1", displayName: "Wang TA", role: "ta", kiwiUserId: null, keyPrefix: "ab12cd34", createdAt: "2026-10-22T01:00:00+00:00", revokedAt: null }]}
        me={{ staffId: null }} busy={false} onRole={() => {}} onRevoke={() => {}} />,
    );
    expect(keys).toContain("ab12cd34…");
    expect(keys).toContain("Revoke");
  });
  it("validates schedule and privacy drafts and describes retention", () => {
    expect(scheduleProblem({ timezone: "Asia/Shanghai", meetings: [{ weekday: 2, time: "10:00", durationMinutes: 90 }], termStart: null })).toBe("");
    expect(scheduleProblem({ timezone: "Asia/Shanghai", meetings: [{ weekday: 2, time: "25:00", durationMinutes: 90 }], termStart: null })).toMatch(/HH:MM/);
    expect(scheduleProblem({ timezone: "Asia/Shanghai", meetings: [{ weekday: 2, time: "10:00", durationMinutes: 5 }], termStart: null })).toMatch(/15–300/);
    const privacy = { showEmails: true, defaultNameMode: "names" as const, researchPurpose: "", irbProtocol: "", retentionDays: 0, viewerCanExportResearch: false };
    expect(privacyProblem(privacy)).toMatch(/Retention/);
    expect(privacyProblem({ ...privacy, retentionDays: null })).toBe("");
    expect(retentionText({ due: { events: 3, chat_turns: 1 }, retentionDays: 30 })).toBe("4 records are older than 30 days (events 3, chat_turns 1).");
    expect(retentionText({ due: {}, retentionDays: null })).toMatch(/No retention/);
    expect(kiwiConnectionLines(false, null)[0]).toBe("Kiwi · Not linked to this course");
  });
  it("summarizes a template preview with packages and archived chapters", () => {
    const result = {
      mode: "preview" as const, files: 0, warnings: ["This week's chapter moves to Module 01."], policies: [], assignments: [],
      chapters: [{ id: "css-m06", title: "Module 06 · Text as data", action: "add" as const, packages: ["quanteda", "tidytext"] }, { id: "text-analysis", title: "04 · Text analysis", action: "archive" as const }],
    };
    expect(importSummary(result)).toBe("1 chapter to add · 1 to archive · 0 draft assignments · 0 AI rule versions · 0 files");
    // RV6-m10: an applied import says what happened, not what is "to add"
    expect(importSummary({ ...result, mode: "apply" })).toBe("1 chapter added · 1 archived · 0 draft assignments · 0 AI rule versions · 0 files");
    const html = renderToStaticMarkup(<ImportResultView result={result} />);
    expect(html).toContain("quanteda, tidytext");
    expect(html).toContain("archive");
    expect(html).toContain("Preview — nothing saved yet");
    // S-m11: Apply asks first when it archives chapters; the Week column appears when the package has weeks
    expect(applyConfirmText(result)).toBe("This adds 1 chapter and archives 1 (hidden from students, nothing is deleted): 04 · Text analysis.");
    expect(applyConfirmText({ ...result, chapters: [result.chapters[0]] })).toBeNull();
    const weekly = renderToStaticMarkup(<ImportResultView result={{ ...result, chapters: [{ ...result.chapters[0], week: 6 }] }} />);
    expect(weekly).toContain("<th>Week</th>");
    expect(weekly).toContain("<td>6</td>");
  });
  it("renders audit entries", () => {
    const html = renderToStaticMarkup(
      <AuditTable kind="actions" entries={[{ id: 1, kind: "action", actorLabel: "Instructor (local key)", actorRole: "instructor", action: "roster_update", targetType: "roster", targetId: "s1", summary: "status: active → dropped", createdAt: "2026-10-22T01:00:00+00:00" }]} />,
    );
    expect(html).toContain("roster_update");
    expect(html).toContain("status: active → dropped");
  });
});

describe("student demo links (RV6-m11)", () => {
  it("lets an instructor of a standalone course create and copy a demo link", () => {
    const noop = () => undefined;
    const empty = renderToStaticMarkup(<DemoLinkView studentName="Ada Chen" link={null} busy={false} error="" copied={false} onCreate={noop} onCopy={noop} />);
    expect(empty).toContain("Create demo link");
    expect(empty).toContain("share it only with this student");
    const made = renderToStaticMarkup(<DemoLinkView studentName="Ada Chen" link={{ url: "http://127.0.0.1:8100/student/assignments#demo=abc", expiresAt: "2026-11-05T00:00:00Z" }}
      busy={false} error="" copied={false} onCreate={noop} onCopy={noop} />);
    expect(made).toContain('value="http://127.0.0.1:8100/student/assignments#demo=abc"');
    expect(made).toContain("Copy link");
    expect(demoLinkUrl("/student/assignments#demo=abc", "http://lab.local")).toBe("http://lab.local/student/assignments#demo=abc");
  });
});
