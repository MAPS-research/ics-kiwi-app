import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  checkAnswer,
  generateQuestion,
  localQuestion,
  normalizeAnswer,
} from "./questions";
import type {
  Course,
  Difficulty,
  GenerationPolicy,
  QuestionType,
} from "../types";
const course: Course = {
  title: "R course",
  description: "",
  currentUnitId: "r-basics",
  units: [
    {
      id: "r-basics",
      title: "R basics",
      goal: "Learn base R",
      status: "current",
    },
  ],
};
const policy: GenerationPolicy = {
  minDifficulty: 1,
  maxDifficulty: 5,
  defaultDifficulty: 2,
  allowedTypes: ["choice", "fill", "predict", "complete"],
  maxOutputTokens: 2400,
  aiAvailable: false,
};
afterEach(() => vi.restoreAllMocks());
describe("answer evaluation", () => {
  it("normalizes R console prefixes, whitespace, and string quotes", () => {
    expect(normalizeAnswer('[1] "Social"')).toBe("social");
    expect(normalizeAnswer(" x [ 2 ] ")).toBe("x[2]");
  });
  it("requires the latest runnable output for completion checks", () => {
    const q = localQuestion("network-analysis", "complete", 2);
    expect(checkAnswer(q, 'sum(to == "B")')).toBe(false);
    expect(checkAnswer(q, "nonsense", "[1] 3")).toBe(false);
    expect(checkAnswer(q, 'sum(to == "B")', "[1] 2")).toBe(true);
  });
  it("accepts full choice values and rejects option letters", () => {
    const q = localQuestion("network-analysis", "choice", 2);
    expect(checkAnswer(q, "2")).toBe(true);
    expect(checkAnswer(q, "A")).toBe(false);
  });
});
describe("local exercise contracts", () => {
  for (const unit of [
    "r-basics",
    "data-wrangling",
    "text-analysis",
    "network-analysis",
  ])
    for (const type of [
      "fill",
      "choice",
      "predict",
      "complete",
    ] as QuestionType[])
      it(`${unit} / ${type} is English and answerable`, () => {
        for (const d of [1, 3, 5] as Difficulty[]) {
          const q = localQuestion(unit, type, d);
          expect(q.unitId).toBe(unit);
          expect(q.answer.trim()).not.toBe("");
          expect(JSON.stringify(q)).not.toMatch(/[\u3400-\u9fff]/);
          if (type === "choice") {
            expect(new Set(q.choices).size).toBe(4);
            expect(q.choices).toContain(q.answer);
          }
          if (type === "complete") {
            expect(q.starterCode).toContain("____");
            expect(q.expectedOutput).toBeTruthy();
          }
        }
      });
});
describe("teacher policy boundary", () => {
  const input = {
    classId: "class",
    studentId: "student",
    course,
    unitId: "r-basics",
    type: "choice" as const,
    difficulty: 2 as Difficulty,
  };
  it("blocks a stale type/difficulty before requesting generation", async () => {
    vi.spyOn(api, "policy").mockResolvedValue({
      ...policy,
      allowedTypes: ["predict"],
      minDifficulty: 3,
    });
    const generate = vi.spyOn(api, "generate");
    await expect(generateQuestion(input)).rejects.toThrow("teacher changed");
    expect(generate).not.toHaveBeenCalled();
  });
  it("does not mask provider failures with a local exercise", async () => {
    vi.spyOn(api, "policy").mockResolvedValue({ ...policy, aiAvailable: true });
    vi.spyOn(api, "generate").mockRejectedValue(
      new Error("AI service unavailable"),
    );
    await expect(generateQuestion(input)).rejects.toThrow(
      "AI service unavailable",
    );
  });
  it("uses a clearly labeled local template only when AI is unconfigured", async () => {
    vi.spyOn(api, "policy").mockResolvedValue(policy);
    expect((await generateQuestion(input)).source).toBe("local");
  });
});
