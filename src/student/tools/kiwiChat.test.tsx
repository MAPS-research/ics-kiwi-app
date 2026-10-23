import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { ChatRequest, GeneratedItemPublic, GeneratedItemTeacher } from "../../types";

vi.mock("../../lib/telemetry", () => ({ registerAiReply: vi.fn(), setTelemetryContext: vi.fn() }));

import { registerAiReply } from "../../lib/telemetry";
import { ApiError } from "../../lib/api";
import { isRefusal, KiwiChatView, LOCAL_GUIDANCE_NOTE, sendChat, turnFromView } from "./KiwiChat";
import { PracticeItemView, PracticeSettingsView } from "../practice/PracticePage";
import { CheckFeedback } from "../../components/CheckFeedback";
import { foldItems, GeneratedItemsView, ItemCard, provenanceLine, filtersFromSearch, filterQuery, type ItemRow } from "../../teacher/chapters/GeneratedItemsPage";
import { chapterOptions, difficultyOptions } from "../../lib/questions";

/*
 * AIRUN view and client tests (renderToStaticMarkup, no DOM): KiwiChat reports `ai_request_unreached` on a rejecting
 * fetch and registers replies for paste detection (AIRUN-26); notices; Practice settings/item views (AIRUN-04/-25);
 * AI-generated practice review markup (F12, DA06).
 */

const decode = (html: string) =>
  html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const render = (el: ReactElement) => decode(renderToStaticMarkup(el));
const body: ChatRequest = { studentId: "s1", unitId: "r-basics", threadId: "thread-assignment-w1-q1", prompt: "Why NA?", surface: "assignment", assignmentId: "w1", questionId: "q1" };
const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("KiwiChat client", () => {
  it("reports ai_request_unreached through the tracker when fetch rejects (AIRUN-26)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const track = vi.fn(() => Promise.resolve());
    await expect(sendChat("c1", body, track, { surface: "assignment", unitId: "r-basics", assignmentId: "w1", questionId: "q1" })).rejects.toThrow(/Could not reach/);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      "ai_request_unreached",
      { action: "chat", surface: "assignment", reason: "network", httpStatus: null, unitId: "r-basics", assignmentId: "w1", questionId: "q1", itemId: undefined },
      "q1",
    );
    expect(registerAiReply).not.toHaveBeenCalled();
  });

  it("does not report server answers as unreached and registers replies", async () => {
    const replies = [
      new Response(JSON.stringify({ error: "Ask Kiwi is turned off for this assignment.", code: "tool_disabled" }), { status: 403, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ response: "Check is.na().", source: "lab-ai", chatTurnId: 7, aiCallId: 3, policyLabel: "Default rules", guard: { status: "clean" }, flagged: false }),
        { status: 200, headers: { "Content-Type": "application/json" } }),
    ];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(replies.shift() as Response)));
    const track = vi.fn(() => Promise.resolve());
    await expect(sendChat("c1", body, track, { surface: "assignment", unitId: "r-basics" })).rejects.toThrow(/turned off/);
    expect(track).not.toHaveBeenCalled();
    const reply = await sendChat("c1", body, track, { surface: "assignment", unitId: "r-basics" });
    expect(reply.chatTurnId).toBe(7);
    expect(registerAiReply).toHaveBeenCalledWith("Check is.na().", 7);
    const sent = JSON.parse(String((vi.mocked(fetch).mock.calls[1][1] as RequestInit).body));
    expect(sent).not.toHaveProperty("sourceQuestion");
    expect(sent.surface).toBe("assignment");
  });

  it("renders the help-level notice, sources and guard notices", () => {
    const html = render(
      <KiwiChatView
        inputId="kiwi-input-t"
        turns={[
          turnFromView({ id: 1, prompt: "a", response: "Local text", createdAt: "2026-10-22T00:00:00Z", source: "local", policyLabel: "Default rules", flagged: false, guardStatus: "not_applicable" }),
          { prompt: "b", response: "hint", createdAt: "", local: false, guard: "redacted" },
        ]}
        input=""
        busy={false}
        error=""
        notice="Ask Kiwi gives hints only for this assignment"
        aiAvailable
        disabled={false}
        onInput={noop}
        onAsk={noop}
      />,
    );
    expect(html).toContain("Ask Kiwi gives hints only for this assignment");
    expect(html).toContain("Local guidance");
    expect(html).not.toMatch(/\bKiwi AI\b/);   // the student side says "Ask Kiwi" (TEACHER-14)
    expect(html).toContain("Kiwi hid part of this reply");
    expect(html).not.toContain("eyebrow");
    const off = render(<KiwiChatView inputId="x" turns={[]} input="hi" busy={false} error="" notice="Ask Kiwi is turned off for this assignment" aiAvailable disabled onInput={noop} onAsk={noop} />);
    expect(off).toMatch(/<textarea[^>]*disabled/);
  });
  it("keeps a refused question in the thread with the reason (RV6-m14)", () => {
    const html = render(<KiwiChatView inputId="x" turns={[{ prompt: "Explain chapter 4", response: "", createdAt: "", local: false, guard: "not_applicable",
      refused: "This chapter opens later." }]} input="" busy={false} error="" notice={null} aiAvailable disabled={false} onInput={noop} onAsk={noop} />);
    expect(html).toContain("Explain chapter 4");
    expect(html).toContain("Not answered: This chapter opens later.");
    expect(html).not.toContain("Lab AI tutor");
    expect(isRefusal(new ApiError(403, "chapter_locked", "Not open"))).toBe(true);
    expect(isRefusal(new ApiError(503, "unavailable", "Down"))).toBe(false);
    expect(isRefusal(new Error("network"))).toBe(false);
  });
});

describe("Practice views", () => {
  const course = {
    units: [
      { id: "ch3", title: "03 · Wrangling", goal: "", status: "current" as const, access: "default" as const, effectiveAccess: "open" as const, week: null, startsOn: null, runtime: { packages: [], datasetFileIds: [], timeoutSeconds: 12, errorHints: [] } },
      { id: "ch5", title: "05 · Networks", goal: "", status: "upcoming" as const, access: "default" as const, effectiveAccess: "locked" as const, week: null, startsOn: null, runtime: { packages: [], datasetFileIds: [], timeoutSeconds: 12, errorHints: [] } },
    ],
  };

  it("shows locked chapters and locked difficulty levels as disabled options", () => {
    const html = render(
      <PracticeSettingsView
        chapters={chapterOptions(course, "practice")}
        types={["choice", "explain"]}
        difficulties={difficultyOptions({ minDifficulty: 1, maxDifficulty: 4 }, 2)}
        settings={{ unitId: "ch3", type: "choice", difficulty: 2, focusNote: "" }}
        policy={{ aiAvailable: true, minDifficulty: 1, maxDifficulty: 4, practice: { allowFocusNote: true, dailyItemLimit: 5 } }}
        usedToday={2}
        busy={false}
        onChange={noop}
        onGenerate={noop}
      />,
    );
    expect(html).toMatch(/<option value="ch5" disabled="">05 · Networks \(Opens later\)<\/option>/);
    expect(html).toMatch(/<option value="3" disabled="">3 · Combine two steps \(locked\)<\/option>/);
    expect(html).toContain("Explain in words");
    expect(html).toContain("3 of 5 exercises left today.");
  });

  it("refuses a chapter that opens later before Generate (RV6-m14)", () => {
    const html = render(
      <PracticeSettingsView chapters={chapterOptions(course, "practice")} types={["choice"]} difficulties={difficultyOptions({ minDifficulty: 1, maxDifficulty: 4 }, 2)}
        settings={{ unitId: "ch5", type: "choice", difficulty: 2, focusNote: "" }}
        policy={{ aiAvailable: true, minDifficulty: 1, maxDifficulty: 4, practice: { allowFocusNote: true, dailyItemLimit: 5 } }}
        usedToday={0} busy={false} onChange={noop} onGenerate={noop} />,
    );
    expect(html).toContain("05 · Networks (Opens later) is not open for practice. Choose another chapter.");
    expect(html).toMatch(/<button class="primary-button" disabled="">[\s\S]*?Generate exercise<\/button>/);
  });

  it("renders a server-checked item without any answer key and shows withheld explanations", () => {
    const item: GeneratedItemPublic = { id: "gi-1", origin: "free", unitId: "ch3", type: "choice", difficulty: 2, title: "Mean", prompt: "Pick", choices: ["3", "4"], source: "ai", policyLabel: "Default rules", needsVerification: false };
    const html = render(
      <PracticeItemView item={item} answer="3" busy={false} canCheck revealed={null}
        result={{ correct: true, attemptIndex: 1, explanationWithheld: true, canReveal: false, verification: "mismatch", verificationNotice: "This exercise failed an automatic check; its answer key may be wrong." }}
        onAnswer={noop} onCheck={noop} onReveal={noop} onNext={noop} onOpenCode={noop} />,
    );
    expect(html).toContain("The explanation is shown after the homework closes.");
    expect(html).toContain("This exercise failed an automatic check; its answer key may be wrong.");
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain("Reveal answer");
  });
  it("renders fenced R code in an AI prompt as a code block, not literal backticks (RV6-M05)", () => {
    const prompt = "Which call keeps rows with `x > 2`?\n```r\ndf <- data.frame(x = 1:4)\ndf[df$x > 2, ]\n```";
    const item: GeneratedItemPublic = { id: "gi-2", origin: "free", unitId: "ch3", type: "choice", difficulty: 2, title: "Filter rows with base R", prompt,
      choices: ["A", "B"], source: "ai", policyLabel: "Default rules", needsVerification: false };
    const html = render(
      <PracticeItemView item={item} answer="" busy={false} canCheck={false} revealed={{ answer: "A", explanation: "Use `df[cond, ]`." }}
        result={null} onAnswer={noop} onCheck={noop} onReveal={noop} onNext={noop} onOpenCode={noop} />,
    );
    expect(html).not.toContain("```");
    expect(html).toContain("<pre><code>df <- data.frame(x = 1:4)\ndf[df$x > 2, ]\n</code></pre>");
    expect(html).toContain("<code>x > 2</code>");
    expect(html).toContain("<code>df[cond, ]</code>");
  });

  it("renders the explanation in the check feedback as Markdown, like the prompt (RT-01)", () => {
    const item: GeneratedItemPublic = { id: "gi-3", origin: "free", unitId: "ch3", type: "choice", difficulty: 2, title: "Filter rows", prompt: "Pick one",
      choices: ["A", "B"], source: "ai", policyLabel: "Default rules", needsVerification: false };
    const explanation = "In base R, `students$score > 80` creates a TRUE/FALSE vector:\n```r\nstudents[students$score > 80, ]\n```";
    const html = render(
      <PracticeItemView item={item} answer="A" busy={false} canCheck revealed={null}
        result={{ correct: true, attemptIndex: 1, explanation, explanationWithheld: false, canReveal: false }}
        onAnswer={noop} onCheck={noop} onReveal={noop} onNext={noop} onOpenCode={noop} />,
    );
    expect(html).not.toContain("`");
    expect(html).toContain('<p class="check-feedback-verdict">Correct.</p>');
    expect(html).toContain("<code>students$score > 80</code>");
    expect(html).toContain("<pre><code>students[students$score > 80, ]\n</code></pre>");
    const withheld = render(<CheckFeedback result={{ correct: true, attemptIndex: 1, explanationWithheld: true, canReveal: false }} />);
    expect(withheld).toContain('role="status"');
    expect(withheld).toContain("The explanation is shown after the homework closes.");
    expect(withheld).not.toContain("response-text");
    const wrong = render(<CheckFeedback result={{ correct: false, attemptIndex: 2, explanation: "Check `filter()`.", explanationWithheld: false, canReveal: true }} />);
    expect(wrong).toContain('class="feedback check-feedback incorrect"');
    expect(wrong).toContain("<code>filter()</code>");
  });

  it("gives the Ask Kiwi composer the full-width class and four rows (RT-04)", () => {
    const html = render(
      <KiwiChatView inputId="kiwi-input-t1" turns={[]} input="" busy={false} error="" notice={null} aiAvailable disabled={false} onInput={noop} onAsk={noop} />,
    );
    expect(html).toMatch(/<textarea id="kiwi-input-t1" class="kiwi-chat-input" rows="4"/);
  });
});

describe("AI-generated practice review", () => {
  const row = (over: Partial<ItemRow>): ItemRow => ({
    id: "gi-1", origin: "free", studentId: "demo-ada", studentName: "Ada Chen", unitId: "ch3", relatedAssignmentId: "", relatedQuestionId: "",
    questionType: "choice", difficulty: 2, requestedType: "choice", requestedDifficulty: 2, focusNote: "",
    item: { title: "Mean", prompt: "Pick the mean", choices: ["4", "3"], answer: "4", explanation: "Sum / n." },
    source: "ai", model: "gpt-5.4-mini", policyVersionId: 4, policyLabel: "Ch 03 rules v4", noveltyRetries: 0, guardStatus: "clean",
    verification: "not_applicable", clientRunOutput: "", status: "active", flagNote: "", homeworkMatch: null, aiCallId: 11, attempts: 3,
    correctAttempts: 1, createdAt: "2026-10-21T03:00:00.000+00:00", ...over,
  } as GeneratedItemTeacher as ItemRow);
  const units = [{ id: "ch1", title: "01" }, { id: "ch2", title: "02" }, { id: "ch3", title: "03 · Wrangling" }];

  it("folds items by origin, chapter or assignment question, and type", () => {
    const groups = foldItems(
      [row({}), row({ id: "gi-2" }), row({ id: "gi-3", origin: "similar", relatedAssignmentId: "w3", relatedQuestionId: "q2", questionType: "predict" })],
      units,
      { w3: "HW3" },
    );
    expect(groups.map((g) => g.label)).toEqual(["Free practice (AI) · Ch 03 · Multiple choice (2)", "Similar practice (AI) · HW3 · q2 · Predict output (1)"]);
    // SB-m13: local templates are not grouped as "(AI)" and their record is not called an AI call
    const local = foldItems([row({ source: "local_template", model: null })], units, {});
    expect(local.map((g) => g.label)).toEqual(["Free practice (local template, no AI) · Ch 03 · Multiple choice (1)"]);
    const card = render(<ItemCard item={row({ source: "local_template", model: null })} canFlag canRetire={false} busy={false} onAction={noop} />);
    expect(card).toContain("Show request record");
    expect(card).not.toContain("Show AI call");
  });

  it("shows provenance, answer key, verification and role-based actions", () => {
    expect(provenanceLine(row({}), "UTC")).toBe("Lab AI tutor · Ch 03 rules v4 · gpt-5.4-mini · 10/21");
    const mismatch = row({ verification: "mismatch", clientRunOutput: "[1] 3", homeworkMatch: { assignmentId: "w1", questionId: "q1", containment: 1 } });
    const html = render(<ItemCard item={mismatch} canFlag canRetire={false} busy={false} onAction={noop} timeZone="UTC" />);
    expect(html).toContain("Failed automatic check");
    expect(html).toContain("[1] 3");
    expect(html).toContain("Homework match 100%");
    expect(html).toContain("✓ answer");
    expect(html).toContain("Flag as wrong");
    expect(html).not.toContain(">Retire<");
    expect(html).toContain("Show AI call");
    const viewer = render(<ItemCard item={row({ status: "flagged", flagNote: "key wrong" })} canFlag={false} canRetire={false} busy={false} onAction={noop} />);
    expect(viewer).not.toContain("Flag as wrong");
    expect(viewer).not.toContain("Clear flag");
    expect(viewer).toContain("key wrong");
  });

  it("renders the page with one h1 and filter chips", () => {
    const html = render(
      <GeneratedItemsView groups={foldItems([row({})], units, {})} total={1} page={1} chips={[]} filters={filtersFromSearch("?verification=mismatch&origin=bogus")}
        units={units} showFilters busy={false} canFlag canRetire error="" loading={false} call={null}
        onToggleFilters={noop} onFilter={noop} onPage={noop} onAction={noop} onCloseCall={noop} />,
    );
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain("AI-generated practice");
    expect(html).toContain('<option value="mismatch" selected="">Failed automatic check</option>');
    expect(filterQuery(filtersFromSearch("?verification=mismatch&origin=bogus"), 2)).toEqual({ page: "2", pageSize: "50", verification: "mismatch" });
  });
});

describe("SB-m12: no-AI wording for students", () => {
  it("says what the student gets, not how the server is configured", () => {
    const html = renderToStaticMarkup(
      <KiwiChatView inputId="x" turns={[]} input="" busy={false} error="" notice="" aiAvailable={false} disabled={false} onInput={() => undefined} onAsk={() => undefined} />,
    );
    expect(html).toContain(LOCAL_GUIDANCE_NOTE.replace(/'/g, "&#x27;"));
    expect(html).not.toContain("API key");
  });
});
