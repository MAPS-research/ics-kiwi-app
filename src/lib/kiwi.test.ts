import { describe, expect, it } from "vitest";
import { CHAT_UNAVAILABLE_REASON, hostChatMessages } from "./kiwi";
import { defaultHostContext } from "../student/StudentApp";
import type { Course } from "../types";

describe("host chat policy messages (§15.3)", () => {
  it("appends the page note and keeps tutoringMode guidance", () => {
    expect(hostChatMessages("Course X.", { available: true, contextNote: "Assignment: HW 3." })).toEqual([
      { type: "kiwi:updateContext", payload: { context: "Course X.\nAssignment: HW 3.", tutoringMode: "guidance" } },
      { type: "kiwi:setChatAvailability", payload: { available: true, reason: "" } },
    ]);
  });
  it("hides the native chat when Ask Kiwi is off and restores the default", () => {
    expect(hostChatMessages("Course X.", { available: false, contextNote: "" })[1]).toEqual({
      type: "kiwi:setChatAvailability", payload: { available: false, reason: CHAT_UNAVAILABLE_REASON },
    });
    expect(hostChatMessages("Course X.", null)).toEqual([
      { type: "kiwi:updateContext", payload: { context: "Course X.", tutoringMode: "guidance" } },
      { type: "kiwi:setChatAvailability", payload: { available: true, reason: "" } },
    ]);
  });
  it("describes the course, chapter, page and Lab AI tutor rules by default", () => {
    const course = {
      title: "CSS", currentUnitId: "u1", units: [{ id: "u1", title: "R basics" }],
    } as unknown as Course;
    const text = defaultHostContext(course, "/student/kiwi", { helpLevel: "hints_only", allowedTypes: ["choice", "fill"] });
    expect(text).toBe(
      "English-language R course: CSS. Chapter: R basics. Page: /student/kiwi. Lab AI tutor rules for this chapter: help level hints only, question types Multiple choice, Fill in the blank. Native Kiwi chat follows Kiwi's guidance mode.",
    );
    expect(text).not.toContain("Teacher policy is enforced");
  });
});
