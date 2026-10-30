import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROLE_PERMISSIONS } from "../shell/TeacherContext";
import { TimeRangePickerView, dateInputToIso, fallbackNote, fallbackShort, isoToDateInputs, presetOptionLabel } from "../shell/TimeRangePicker";
import { AttentionRows } from "./AttentionList";
import { HomeView, type HomeViewData } from "./HomePage";
import { revisionOfNote } from "../../lib/labels";
import { askedLine, assignmentLine, deltaText, glanceItems, headerParts, missingChip, reteachLine } from "./homeModel";
import type { Metric, TimeRange } from "../../types";

/* INSIGHTS-01/02/14/18/25 [F05, TH06, NM32, F15]: Home markup and chip/link rules, rendered with renderToStaticMarkup. */

const metric = (value: number, previous: number | null, deltaPct: number | null): Metric => ({ value, previous, deltaPct });
const RANGE: TimeRange = {
  preset: "since_last_class", effectivePreset: "since_last_class", from: "2026-10-20T02:00:00+00:00", to: "2026-10-22T01:00:00+00:00",
  compareFrom: "2026-10-13T02:00:00+00:00", compareTo: "2026-10-15T01:00:00+00:00", label: "Since last class (Tue 10/20)", compareLabel: "vs last week",
};
const stats = { enrolled: 60, submitted: 41, startedNotSubmitted: 3, toGrade: 12, toRelease: 0, late: 2, missing: 5, graded: 20, released: 10, avgScore: 15.2, maxPoints: 20, attempted: 0, firstTryCorrectPct: null };

function fixture(linked = false): HomeViewData {
  return {
    range: RANGE,
    header: {
      courseTitle: "Intro to CSS", thisWeek: { unitId: "data-wrangling", title: "03 · Wrangling, joins & visualization", index: 3, total: 5 },
      freePracticeLabel: "Ch 01–03", aiRules: { unitId: "data-wrangling", label: "Ch 03 rules v4", customized: true, updatedAt: "2026-10-21T02:00:00+00:00" },
      aiStatus: { configured: true, model: "gpt-5.4-mini", modelAllowlist: [], platformRulesVersion: "platform-rules-v2", concurrency: 4, perStudentPerMinute: 15, classPerMinute: 120 },
      kiwi: { linked, lastSynced: null },
    },
    needsAction: {
      toGrade: 12, toRelease: [{ assignmentId: "hw3", title: "Week 3 HW", count: 12 }],
      missingPastDue: [{ assignmentId: "hw3", title: "Week 3 HW", count: 5, started: 2 }], late: 3, flaggedReplies: 2,
    },
    assignments: [{ id: "hw3", title: "Week 3 HW", kind: "homework", unitId: "data-wrangling", status: "published", state: "open", questionCount: 2,
      dueAt: "2026-10-24T15:59:00+00:00", closeAt: null, latePolicy: { mode: "accept_marked", untilAt: null, graceMinutes: 0, penaltyPctPerDay: 0 },
      hasAttempts: true, revisionOf: null, stats, updatedAt: "2026-10-20T00:00:00+00:00" }],
    attention: { students: [{ studentId: "s1", studentName: "Ada Chen", reasons: [{ rule: "no_activity", text: "No learning actions for 9 days", href: "/teacher/students/s/s1/timeline", at: null },
      { rule: "late_pattern", text: "2 late submissions in 3 weeks", href: "/teacher/grading?studentId=s1&show=late", at: null }] }], total: 4,
      rules: ["No learning actions (answers, code runs, Tutor requests, submissions) for 7+ days"] },
    reteach: { candidates: [{ assignmentId: "hw3", questionId: "q2", label: "HW3 Q2", prompt: "left_join()", students: 9, firstTryCorrectPct: 38, meanTriesToCorrect: 2.9, meanScorePct: null, marked: false }], marked: [] },
    askedAi: { repeated: [{ prompt: "why does merge drop rows?", students: 7, occurrences: 9, threadKeys: ["lab:s1:t1"] }], topics: [{ label: "joins", count: 14 }, { label: "NA handling", count: 9 }], flaggedFinalAnswer: 2 },
    glance: { activeStudents: { ...metric(48, 42, 14), denominator: { label: "enrolled", value: 60 } }, enrolled: 60, aiQuestions: metric(132, 112, 18), codeRuns: metric(910, 800, 14),
      freePracticeItems: metric(214, 100, 114), aiTurnedAway: metric(3, 1, 200) },
  };
}

const render = (permissions = ROLE_PERMISSIONS.instructor, data = fixture(), hidden = false) =>
  renderToStaticMarkup(
    <HomeView data={data} range={RANGE} permissions={permissions} bannerHidden={hidden} onDismissBanner={() => {}} onMark={() => {}} onDone={() => {}} studentLabel={(s) => s.studentName} />,
  );

describe("Home view", () => {
  it("renders the blocks in order with the fixed labels and no eyebrow", () => {
    const html = render();
    const order = ["Needs your action", "Students needing attention (4)", "What to re-teach (your questions only)", "Assignments", "What students asked the tutor", "This week at a glance"];
    const positions = order.map((t) => html.indexOf(t));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).not.toContain('class="eyebrow"');
    expect(html).not.toMatch(/\bKiwi AI\b(?! in Lab)/);
  });
  it("shows Needs your action chips with links for an instructor (INSIGHTS-02)", () => {
    const html = render();
    expect(html).toContain("To grade 12");
    expect(html).toContain("› Start");
    expect(html).toContain("Ready to release 12");
    expect(html).toContain("› Release");
    expect(html).toContain("Missing · Week 3 HW 5 (2 started)");
    expect(html).toContain('href="/teacher/grading?show=latest"');
    expect(html).toContain('href="/teacher/grading/release?assignmentId=hw3"');
    expect(html).toContain("Flagged replies 2");
    expect(html).toContain("Late 3");
  });
  it("opens AI conversations across all chapters, matching the course-wide Home counts (INTEGRATION wiring)", () => {
    const html = render();
    // WHY: the AI conversations page defaults its Chapter chip to this week's chapter; Home counts every chapter.
    expect(html).toContain('href="/teacher/insights/ai-conversations?mode=coding&amp;flagged=1&amp;unitId=all"');
    expect(html).toContain('href="/teacher/insights/ai-conversations?unitId=all"');
    expect(html).not.toContain('href="/teacher/insights/ai-conversations"');
  });
  it("renders grading numbers as text for a viewer (INSIGHTS-25)", () => {
    const html = render(ROLE_PERMISSIONS.viewer);
    expect(html).toContain("To grade 12");
    expect(html).not.toContain('href="/teacher/grading');
    expect(html).not.toContain("› Start");
    expect(html).not.toContain("+ New assignment");
    expect(html).toContain('<span class="home-chip tone-warning as-text">To grade 12</span>');
    expect(html).toContain("2 late submissions in 3 weeks</span>");
  });
  it("shows the Kiwi banner only when the course is not linked and not dismissed (INSIGHTS-18)", () => {
    expect(render()).toContain("Standalone mode — Kiwi AI in Lab requires an approved course app session.");
    expect(render()).toContain("How to link");
    expect(render()).toContain("Dismiss");
    expect(render(ROLE_PERMISSIONS.instructor, fixture(true))).not.toContain("Kiwi not linked");
    expect(render(ROLE_PERMISSIONS.instructor, fixture(), true)).not.toContain("Kiwi not linked");
  });
  it("hides Flagged replies while the guard has not run", () => {
    const data = fixture();
    const html = render(ROLE_PERMISSIONS.instructor, { ...data, needsAction: { ...data.needsAction, flaggedReplies: null } });
    expect(html).not.toContain("Flagged replies");
    expect(html).not.toContain("may state a final answer");
  });
});

describe("Home texts", () => {
  it("formats chips, glance, assignment rows, re-teach and asked lines", () => {
    expect(missingChip({ assignmentId: "a", title: "Week 3 HW", count: 5, started: 0 })).toBe("Missing · Week 3 HW 5");
    const items = glanceItems(fixture().glance, RANGE).map((i) => i.text);
    // K-m01: the glance names its definition, with the label Course metrics uses
    expect(items[0]).toBe("Active since last class: 48 of 60 (learning actions; +6 vs last wk)");
    expect(glanceItems(fixture().glance, RANGE)[0].title).toMatch(/^Active: enrolled students with at least one learning action/);
    expect(glanceItems({ ...fixture().glance, activeStudents: metric(1, null, null) }, { ...RANGE, compareLabel: null })[0].text)
      .toBe("Active since last class: 1 of 60 (learning actions)");
    expect(items[1]).toBe("Tutor requests 132 (+18%)");
    expect(items).toContain("AI requests turned away 3");
    expect(deltaText(metric(10, null, null), "pct", null)).toBe("");
    expect(assignmentLine(fixture().assignments[0], "Asia/Shanghai")).toBe("Week 3 HW · Due Sat 10/24 23:59 GMT+8 · Submitted 41/60 · To grade 12");
    expect(assignmentLine({ ...fixture().assignments[0], state: "closed", stats: { ...stats, submitted: 58 } })).toBe("Week 3 HW · Closed · 58/60 · Avg 15.2/20");
    expect(reteachLine(fixture().reteach.candidates[0], 0)).toBe("1. HW3 Q2 left_join() 38% first try · 2.9 tries · 9 students");
    expect(askedLine({ prompt: "why does merge drop rows?", students: 7 })).toBe("Asked by 7: “why does merge drop rows?”");
    const parts = headerParts(fixture().header, () => "10/21");
    expect(parts.thisWeek).toBe("This week: Ch 03 Wrangling, joins & visualization");
    expect(parts.aiRules).toBe("AI tutor: Ch 03 rules v4 (customized 10/21)");
    expect(parts.aiStatus).toBe("Connected");
  });
});

describe("Time range picker (gate finding: no duplicate Last 7 days)", () => {
  const fallback: TimeRange = { ...RANGE, effectivePreset: "last_7_days", label: "Last 7 days", note: "Set class meetings in Course settings to use Since last class" };
  it("keeps every option distinct when Since last class falls back", () => {
    const labels = ["this_class", "since_last_class", "this_week", "last_7_days", "whole_term", "custom"].map((p) => presetOptionLabel(p as TimeRange["preset"], fallback));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.filter((l) => l === "Last 7 days")).toHaveLength(1);
    expect(labels[1]).toBe("Since last class (last 7 days)");
    expect(fallbackNote(fallback)).toBe("Set class meetings in Course settings to use Since last class");
    expect(fallbackNote(RANGE)).toBeNull();
    expect(fallbackShort(fallback)).toBe("No class meetings set");
    expect(presetOptionLabel("since_last_class", RANGE)).toBe("Since last class (Tue 10/20)");
  });
  it("shows the fallback note next to the picker with a schedule link for instructors", () => {
    const html = renderToStaticMarkup(
      <TimeRangePickerView range={fallback} custom={false} onPreset={() => {}} onCustom={() => {}} canSetSchedule from="" to="" onFrom={() => {}} onTo={() => {}} onApply={() => {}} error="" />,
    );
    expect(html).toContain('role="note"');
    expect(html).toContain("No class meetings set");
    expect(html).toContain("Set class meetings in Course settings to use Since last class");
    expect(html).toContain('href="/teacher/settings?tab=schedule"');
    expect(html.match(/>Last 7 days</g)).toHaveLength(1);
  });
});


describe("S-m03: custom time range in the course time zone", () => {
  it("turns the inclusive From/To dates into course-zone midnights and back", () => {
    expect(dateInputToIso("2026-10-12", false, "Asia/Shanghai")).toBe("2026-10-11T16:00:00.000Z");
    expect(dateInputToIso("2026-10-21", true, "Asia/Shanghai")).toBe("2026-10-21T16:00:00.000Z");
    expect(dateInputToIso("2026-02-30", false, "Asia/Shanghai")).toBeNull();
    expect(dateInputToIso("10/21/2026", false, "Asia/Shanghai")).toBeNull();
    expect(isoToDateInputs("2026-10-11T16:00:00.000Z", "2026-10-21T16:00:00.000Z", "Asia/Shanghai")).toEqual({ from: "2026-10-12", to: "2026-10-21" });
    expect(isoToDateInputs(null, null, "Asia/Shanghai")).toEqual({ from: "", to: "" });
  });
});

describe("B-m01 / D8 on Home", () => {
  const rows = (reasons: HomeViewData["attention"]["students"][number]["reasons"]) => renderToStaticMarkup(
    <AttentionRows students={[{ studentId: "s2", studentName: "Bo Lin", reasons }]} canGrade studentLabel={(s) => s.studentName} />,
  );
  it("B-m01: a No learning actions reason says when the student was last seen", () => {
    const seen = new Date(Date.now() - 120_000).toISOString();
    const html = rows([{ rule: "no_activity", text: "No learning actions for 11 days", href: "/teacher/students/s/s2/timeline", at: null, lastSeenAt: seen }]);
    expect(html).toContain("No learning actions for 11 days</a>");
    expect(html).toContain('<span class="attention-seen"> · last seen 2 min ago</span>');
    const never = rows([{ rule: "no_activity", text: "No learning actions recorded yet", href: "/teacher/students/s/s2", at: null, lastSeenAt: null }]);
    expect(never).not.toContain("last seen");
  });
  it("D8: a missing reason and a missing revision chip name the original in their tooltip", () => {
    const html = rows([{ rule: "missing_work", text: "Missing 2 assignments", href: "/teacher/students/s/s2/timeline", at: null,
      title: "Files HW — revision (new version of Files HW) · Older homework" }]);
    expect(html).toContain('title="Files HW — revision (new version of Files HW) · Older homework"');
    const data = fixture();
    const home = render(ROLE_PERMISSIONS.instructor, { ...data, needsAction: { ...data.needsAction,
      missingPastDue: [{ assignmentId: "hw3r", title: "Week 3 HW — revision", count: 1, started: 0, originalTitle: "Week 3 HW" }] } });
    expect(home).toContain(`title="${revisionOfNote("Week 3 HW")}"`);
    expect(home).toContain("Missing · Week 3 HW — revision 1");
  });
});
