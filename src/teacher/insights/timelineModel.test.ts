import { describe, expect, it } from "vitest";
import {
  appendTimeline, contextLabel, groupStudySessions, kindLabel, outcomeText, provenanceDetail, provenanceLabel, statusTone, timelineExportQuery,
  timelineTitle,
} from "./timelineModel";
import type { StudentTimeline, TimelineEvent } from "../../types";

/* INSIGHTS-06/08/16/19 [TR08, NM27, NM28]: provenance labels, merge order, study-session gaps. */

const event = (id: string, at: string, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, at, kind: "code_run", questionId: null, questionLabel: "", title: "", studySessionIndex: 0, detail: {},
  context: { practiceMode: "workspace", assignmentId: null, assignmentLabel: null, unitId: "" }, provenance: { where: "lab" }, ...extra,
});

describe("provenance labels (INSIGHTS-08)", () => {
  it("names Lab replies with the rule version and native replies as Kiwi lecture AI", () => {
    expect(provenanceLabel({ where: "lab", ai: "Lab AI tutor", policyLabel: "Ch 03 rules v4" })).toBe("Lab AI tutor · Ch 03 rules v4");
    expect(provenanceLabel({ where: "kiwi", ai: "Kiwi lecture AI" })).toBe("Kiwi lecture AI");
    expect(provenanceLabel({ where: "lab", ai: "Local guidance" })).toBe("Local guidance");
    expect(provenanceDetail({ where: "lab", ai: "Lab AI tutor", policyLabel: "Ch 03 rules v4", model: "gpt-5.4-mini" })).toBe("Lab AI tutor · Ch 03 rules v4 · gpt-5.4-mini");
    for (const p of [{ where: "lab" as const, ai: "Lab AI tutor" as const }, { where: "kiwi" as const, ai: "Kiwi lecture AI" as const }, { where: "kiwi" as const }])
      expect(provenanceDetail(p)).not.toMatch(/\bKiwi AI\b/);
  });
});

describe("timeline structure", () => {
  it("groups events by study session and keeps time order", () => {
    const events = [event("e:1", "2026-10-21T01:00:00Z"), event("e:2", "2026-10-21T01:05:00Z"), event("e:3", "2026-10-21T01:36:00Z", { studySessionIndex: 1 })];
    const sessions = groupStudySessions(events);
    expect(sessions.map((s) => [s.index, s.events.map((e) => e.id)])).toEqual([[0, ["e:1", "e:2"]], [1, ["e:3"]]]);
    expect(sessions[0].end).toBe("2026-10-21T01:05:00Z");
  });
  it("appends Load more pages without duplicates", () => {
    const page = (ids: string[], more: boolean): StudentTimeline => ({ student: { studentId: "s1", studentName: "Ada" }, assignment: null, status: null,
      events: ids.map((id, i) => event(id, `2026-10-21T01:0${i}:00Z`)), nextCursor: more ? "x" : null, hasMore: more });
    const merged = appendTimeline(page(["e:1", "e:2"], true), page(["e:2", "e:3"], false));
    expect(merged.events.map((e) => e.id)).toEqual(["e:1", "e:2", "e:3"]);
    expect(merged.hasMore).toBe(false);
  });
  it("labels contexts, titles, outcomes and kinds", () => {
    expect(contextLabel({ practiceMode: "homework", assignmentId: "hw3", assignmentLabel: "Week 3 Homework", unitId: "u" })).toBe("Week 3 Homework");
    expect(contextLabel({ practiceMode: "free", assignmentId: null, assignmentLabel: null, unitId: "u" })).toBe("Free practice (AI)");
    expect(contextLabel({ practiceMode: "similar", assignmentId: "hw3", assignmentLabel: "Week 3 Homework", unitId: "u" })).toBe("Similar practice (AI) · Week 3 Homework");
    expect(contextLabel({ practiceMode: "workspace", assignmentId: null, assignmentLabel: null, unitId: "" })).toBe("R workspace");
    expect(timelineTitle("Ada Chen")).toBe("Ada Chen — full activity timeline");
    expect(timelineTitle("Ada Chen", "Week 3 Homework")).toBe("Ada Chen · Week 3 Homework — full timeline");
    expect(outcomeText(event("e", "t", { kind: "code_run", detail: { ok: false } }))).toBe("Error");
    expect(outcomeText(event("e", "t", { kind: "answer_attempt", detail: { correct: true } }))).toBe("Correct");
    expect(outcomeText(event("e", "t", { kind: "code_run", detail: {} }))).toBe("Run result not recorded");
    expect(kindLabel("similar_generated")).toBe("Similar exercise generated");
    expect(statusTone({ label: "Released 17/20", gradeStatus: "released", score: 17, maxPoints: 20 })).toBe("success");
    expect(statusTone({ label: "Draft 17/20", gradeStatus: "draft", score: 17, maxPoints: 20 })).toBe("info");
    expect(timelineExportQuery("s1", { assignmentId: "hw3", unitId: "u3", where: "lab" })).toEqual({ studentId: "s1", assignmentId: "hw3", unitIds: "u3", where: "lab" });
  });
});
