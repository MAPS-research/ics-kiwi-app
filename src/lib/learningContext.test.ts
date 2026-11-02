import { describe, expect, it } from "vitest";
import { learningContext } from "./learningContext";

describe("floating-chat learning context boundary", () => {
  it("includes visible problem and student work, never keys, rubrics or released solutions", () => {
    const input = {
      title: "Review homework", chapter: "Vectors", question: {
        prompt: "Find the mean", choices: ["2", "3"], starterCode: "mean(c(1, 2, 3))",
        answerKey: "SECRET_KEY", explanation: "SECRET_SOLUTION", rubric: "SECRET_RUBRIC",
      },
      code: "mean(c(1, 2))", answer: "1.5", run: { output: "[1] 1.5", error: "" },
      studentName: "PRIVATE_NAME", grade: "PRIVATE_GRADE",
    };
    const text = learningContext(input);
    for (const value of ["Find the mean", "mean(c(1, 2))", "[1] 1.5", "Vectors"]) expect(text).toContain(value);
    expect(text).not.toMatch(/SECRET_|PRIVATE_/);
  });
  it("bounds code and output without including a run that was not supplied", () => {
    const text = learningContext({ title: "x", question: { prompt: "p" }, code: "R".repeat(100000) });
    expect(text.length).toBeLessThan(3000);
    expect(text).not.toContain("runOutput");
  });
});
