import type {
  Course,
  Difficulty,
  EventRecord,
  Question,
  QuestionType,
  WorkQuestion,
  KiwiClient,
} from "../types";
import { api } from "./api";

const random = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;
const qid = () => `q-${crypto.randomUUID()}`;

export function localQuestion(
  unitId: string,
  type: QuestionType,
  difficulty: Difficulty,
): Question {
  const n = random(3, 8 + difficulty * 2),
    step = random(2, 3 + difficulty);
  const base = {
    id: qid(),
    type,
    difficulty,
    unitId,
    source: "local" as const,
  };
  const skill =
    unitId === "text-analysis"
      ? {
          title: "Text preprocessing",
          prompt:
            "Convert the text to lowercase, split it on spaces, and extract the first word.",
          code: 'line <- "SOCIAL digital data"\ntokens <- strsplit(tolower(line), " ")[[1]]',
          expression: "tokens[1]",
          answer: "social",
          choices: ["social", "SOCIAL", "digital", "data"],
          explanation:
            "tolower() normalizes case. R uses one-based indexing, so tokens[1] selects the first word.",
        }
      : unitId === "network-analysis"
        ? {
            title: "Directed network in-degree",
            prompt: "Count the edges that point to node B.",
            code: 'to <- c("B", "A", "B", "C")',
            expression: 'sum(to == "B")',
            answer: "2",
            choices: ["2", "1", "3", "4"],
            explanation:
              'Each TRUE value in to == "B" represents an incoming edge. sum() counts those values.',
          }
        : unitId === "data-wrangling" || unitId === "dataframes"
          ? {
              title: "Filter a data frame",
              prompt: `Count the rows with score greater than ${n}.`,
              code: `df <- data.frame(score = c(${n}, ${n + step}, ${n + step * 2}))`,
              expression: `nrow(df[df$score > ${n}, , drop = FALSE])`,
              answer: "2",
              choices: ["2", "1", "3", "0"],
              explanation:
                "Only the second and third rows satisfy the strict greater-than condition. The comma separates rows from columns.",
            }
          : unitId === "conditions"
            ? {
                title: "Handle missing values",
                prompt: "Count the nonmissing elements of x.",
                code: "x <- c(1, NA, 3)",
                expression: "sum(!is.na(x))",
                answer: "2",
                choices: ["2", "3", "NA", "0"],
                explanation:
                  "is.na() identifies missing values; ! reverses that condition. sum() counts TRUE values.",
              }
            : {
                title:
                  difficulty >= 4
                    ? "Filter a numeric vector"
                    : "Calculate a vector mean",
                prompt:
                  difficulty >= 4
                    ? "Add the values that are strictly greater than the mean of scores."
                    : "Calculate the mean of scores.",
                code: `scores <- c(${n}, ${n + step}, ${n + step * 2})`,
                expression:
                  difficulty >= 4
                    ? "sum(scores[scores > mean(scores)])"
                    : "mean(scores)",
                answer: String(difficulty >= 4 ? n + step * 2 : n + step),
                choices: [
                  String(difficulty >= 4 ? n + step * 2 : n + step),
                  String(n),
                  String(n + step * 3),
                  "0",
                ],
                explanation:
                  difficulty >= 4
                    ? "The last element is the only value strictly above the mean, so the filtered sum equals that value."
                    : "The mean of three equally spaced values is the middle value.",
              };
  if (type === "fill")
    return {
      ...base,
      title: skill.title,
      prompt: `${skill.prompt} Fill the gap with an R expression.`,
      code: `${skill.code}\nresult <- ____`,
      answer: skill.expression,
      explanation: skill.explanation,
    };
  if (type === "choice")
    return {
      ...base,
      title: skill.title,
      prompt: `${skill.prompt} What is the result?`,
      code: skill.code,
      choices: skill.choices,
      answer: skill.answer,
      explanation: skill.explanation,
    };
  if (type === "predict")
    return {
      ...base,
      title: skill.title,
      prompt: "What is the output of the final print()?",
      code: `${skill.code}\nprint(${skill.expression})`,
      answer: skill.answer,
      explanation: skill.explanation,
    };
  return {
    ...base,
    title: skill.title,
    prompt: `${skill.prompt} Replace ____ and run the code.`,
    starterCode: `${skill.code}\nresult <- ____ # TODO: complete the expression\nprint(result)`,
    answer: skill.expression,
    expectedOutput: skill.answer,
    explanation: skill.explanation,
  };
}

export function localSimilarQuestion(
  original: WorkQuestion,
  unitId: string,
  difficulty: Difficulty,
): Question {
  const text = `${original.prompt} ${original.starterCode}`.toLowerCase();
  const type =
    original.type === "text" || original.type === "complete"
      ? "predict"
      : original.type;
  if (/mean\(|average|mean/.test(text))
    return localQuestion("r-basics", type, difficulty);
  if (/seq\(/.test(text)) {
    const start = random(1, 4),
      by = random(2, 5),
      end = start + by * 3;
    return {
      id: qid(),
      unitId,
      difficulty,
      type: "predict",
      source: "local",
      title: "Sequence length",
      prompt: "What does the final print() output?",
      code: `x <- seq(${start}, ${end}, by = ${by})\nprint(length(x))`,
      answer: "4",
      explanation:
        "The sequence contains the start and three further values at the specified interval.",
    };
  }
  return localQuestion(unitId, type, difficulty);
}

export function normalizeAnswer(answer: string): string {
  return answer
    .trim()
    .toLowerCase()
    .replace(/^\[1\]\s*/, "")
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+/g, "");
}
export function checkAnswer(
  question: Question,
  answer: string,
  runOutput?: string,
): boolean {
  if (question.type === "complete")
    return Boolean(
      runOutput &&
      question.expectedOutput &&
      normalizeAnswer(runOutput.split("\n").at(-1) || "") ===
        normalizeAnswer(question.expectedOutput),
    );
  return [question.answer, ...(question.acceptedAnswers || [])].some(
    (expected) => normalizeAnswer(expected) === normalizeAnswer(answer),
  );
}
export function learningContext(events: EventRecord[]): string {
  const recent = events
    .filter((e) => e.type !== "study_heartbeat")
    .slice(0, 25);
  return `${recent.length} recent interactions · ${recent.filter((e) => e.type === "answer_submitted" && e.payload.correct === false).length} incorrect attempts · ${recent.filter((e) => e.type === "code_run" && e.payload.ok === false).length} R errors`;
}
export async function generateQuestion(input: {
  classId: string;
  studentId: string;
  course: Course;
  unitId: string;
  type: QuestionType;
  difficulty: Difficulty;
  events?: EventRecord[];
  kiwi?: KiwiClient | null;
  focusNote?: string;
  sourceQuestion?: string;
}): Promise<Question> {
  // Read the effective constraints before either path. The server repeats these checks for AI requests.
  const policy = await api.policy(input.classId, input.unitId);
  if (
    !policy.allowedTypes.includes(input.type) ||
    input.difficulty < policy.minDifficulty ||
    input.difficulty > policy.maxDifficulty
  )
    throw new Error(
      "The teacher changed the practice settings. Refresh and choose an allowed type and difficulty.",
    );
  if (!policy.aiAvailable) {
    if (input.sourceQuestion) {
      const original: WorkQuestion = {
        id: "source",
        type: input.type,
        prompt: input.sourceQuestion,
        points: 0,
        choices: [],
        starterCode: "",
      };
      const local = localSimilarQuestion(
        original,
        input.unitId,
        input.difficulty,
      );
      // Keep the teacher-selected type and chapter, even when a source skill specializes the local template.
      const unit = /mean\(|average|mean/i.test(input.sourceQuestion)
        ? "r-basics"
        : input.unitId;
      return {
        ...localQuestion(unit, input.type, input.difficulty),
        unitId: input.unitId,
        id: local.id,
      };
    }
    return localQuestion(input.unitId, input.type, input.difficulty);
  }
  return api.generate(input.classId, {
    studentId: input.studentId,
    unitId: input.unitId,
    type: input.type,
    difficulty: input.difficulty,
    focusNote: input.focusNote || "",
    sourceQuestion: input.sourceQuestion || "",
  });
}
