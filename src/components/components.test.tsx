import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { canConfirm, ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { exportQuery, ExportMenu } from "./ExportMenu";
import { chipText, FilterChips } from "./FilterChips";
import { allSelected, MultiSelectBar, selectionSummary, setAllSelected, toggleSelected } from "./MultiSelectBar";
import { studentLabel } from "./NameContext";
import { PageHeader, SectionTabsView } from "./PageHeader";
import { pageRangeLabel, Pager } from "./Pager";
import { ResponseText } from "./ResponseText";
import { sparkBarGeometry, SparkBars } from "./SparkBars";
import { assignmentStateBadge, gradeStatusTone, StatusBadge } from "./StatusBadge";

describe("PageHeader", () => {
  it("renders one h1, the count and actions without subtitle or eyebrow", () => {
    const html = renderToStaticMarkup(<PageHeader title="Gradebook" count="60" actions={<button>Export</button>} />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Gradebook");
    expect(html).toContain('class="page-header-count">60<');
    expect(html).not.toContain("<p");
    expect(html).not.toContain("eyebrow");
  });
  it("renders section tabs with the active page marked", () => {
    const html = renderToStaticMarkup(
      <SectionTabsView ariaLabel="Grading pages" activeHref="/teacher/grading/gradebook" tabs={[{ label: "To grade", href: "/teacher/grading" }, { label: "Gradebook", href: "/teacher/grading/gradebook" }]} />,
    );
    expect(html).toContain('aria-label="Grading pages"');
    expect(html).toContain('<a href="/teacher/grading/gradebook" aria-current="page">Gradebook</a>');
    expect(renderToStaticMarkup(<SectionTabsView ariaLabel="x" activeHref={null} tabs={[{ label: "Only", href: "/a" }]} />)).toBe("");
  });
  it("shows a live count on a tab when one is given (CR-GRADE-1, NM12)", () => {
    const tabs = [{ label: "To grade", href: "/teacher/grading" }, { label: "Gradebook", href: "/teacher/grading/gradebook" }];
    const html = renderToStaticMarkup(<SectionTabsView ariaLabel="Grading pages" activeHref="/teacher/grading" tabs={tabs} counts={{ "/teacher/grading": 12 }} />);
    expect(html).toContain('<a href="/teacher/grading" aria-current="page">To grade (12)</a>');
    expect(html).toContain(">Gradebook</a>");
    expect(renderToStaticMarkup(<SectionTabsView ariaLabel="x" activeHref={null} tabs={tabs} counts={{}} />)).toContain(">To grade</a>");
  });
});

describe("Pager", () => {
  it("labels ranges", () => {
    expect(pageRangeLabel(1, 0, 20)).toBe("0 results");
    expect(pageRangeLabel(1, 45, 20)).toBe("1–20 of 45");
    expect(pageRangeLabel(3, 45, 20)).toBe("41–45 of 45");
  });
  it("disables previous on the first page and next on the last", () => {
    const html = renderToStaticMarkup(<Pager page={1} total={5} size={20} onPage={() => undefined} />);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe("ExportMenu", () => {
  it("normalizes page filters into export query parameters", () => {
    expect(exportQuery({ unitIds: ["u1", " u2 ", ""], groupIds: [], pseudonymize: true, consent: "yes", page: 2, studentId: "", from: null })).toEqual({
      unitIds: "u1,u2",
      pseudonymize: "1",
      consent: "yes",
      page: "2",
    });
  });
  it("renders a closed Export button", () => {
    const html = renderToStaticMarkup(<ExportMenu classId="c1" items={[{ label: "Grades for LMS (CSV)", path: "grades.csv" }]} />);
    expect(html).toContain("Export");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Grades for LMS");
  });
});

describe("MultiSelectBar", () => {
  it("toggles and bulk-selects immutably", () => {
    const empty = new Set<string>();
    const one = toggleSelected(empty, "a");
    expect([...one]).toEqual(["a"]);
    expect(empty.size).toBe(0);
    expect([...toggleSelected(one, "a")]).toEqual([]);
    const all = setAllSelected(one, ["a", "b", "c"], true);
    expect(allSelected(all, ["a", "b", "c"])).toBe(true);
    expect([...setAllSelected(all, ["a", "b"], false)]).toEqual(["c"]);
    expect(allSelected(new Set(), [])).toBe(false);
  });
  it("summarizes the selection and hides when empty", () => {
    expect(selectionSummary(3, "student")).toBe("3 students selected");
    expect(selectionSummary(1, "student")).toBe("1 student selected");
    expect(renderToStaticMarkup(<MultiSelectBar count={0} noun="student" actions={[]} onClear={() => undefined} />)).toBe("");
    const html = renderToStaticMarkup(
      <MultiSelectBar count={3} noun="student" actions={[{ label: "Create group from selected", onClick: () => undefined }]} onClear={() => undefined} />,
    );
    expect(html).toContain("3 students selected");
    expect(html).toContain("Create group from selected");
  });
});

describe("SparkBars", () => {
  it("scales bars to the maximum and leaves gaps for missing values", () => {
    const bars = sparkBarGeometry([0, 5, 10, null], { width: 46, height: 20, gap: 2 });
    expect(bars.map((b) => b.width)).toEqual([10, 10, 10, 10]);
    expect(bars.map((b) => b.x)).toEqual([0, 12, 24, 36]);
    expect(bars.map((b) => b.height)).toEqual([0, 10, 20, 0]);
    expect(bars[2].y).toBe(0);
    expect(bars[3].value).toBeNull();
    expect(sparkBarGeometry([], { width: 10, height: 10 })).toEqual([]);
    expect(sparkBarGeometry([3, 3], { width: 10, height: 10, max: 6 }).map((b) => b.height)).toEqual([5, 5]);
  });
  it("renders an accessible inline SVG", () => {
    const html = renderToStaticMarkup(<SparkBars values={[1, 2]} labels={["W1", "W2"]} ariaLabel="Active students by week" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Active students by week"');
    expect(html).toContain("<title>W2: 2</title>");
  });
});

describe("ConfirmDialog", () => {
  it("requires the exact confirmation text when set", () => {
    expect(canConfirm(undefined, "")).toBe(true);
    expect(canConfirm("RUN RETENTION", "run retention")).toBe(false);
    expect(canConfirm("RUN RETENTION", " RUN RETENTION ")).toBe(true);
  });
  it("renders a modal dialog only when open", () => {
    expect(renderToStaticMarkup(<ConfirmDialog open={false} title="Delete" confirmLabel="Delete" onConfirm={() => undefined} onCancel={() => undefined} />)).toBe("");
    const html = renderToStaticMarkup(<ConfirmDialog open title="Delete data" confirmLabel="Delete" requireText="demo-ada" danger onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Type demo-ada to confirm");
  });
});

describe("names and badges", () => {
  it("never falls back to ids in presentation mode", () => {
    expect(studentLabel({ studentId: "demo-ada", studentName: "Ada Chen" }, "names")).toBe("Ada Chen");
    expect(studentLabel({ studentId: "3f1c9a77-aaaa", studentName: "" }, "names")).toBe("Student 3f1c9a");
    expect(studentLabel({ studentId: "demo-ada", studentName: "S-001", pseudonym: "S-001" }, "pseudonyms")).toBe("S-001");
    expect(studentLabel({ studentId: "demo-ada", studentName: "" }, "pseudonyms")).toBe("Student");
  });
  it("maps states to semantic tones", () => {
    expect(assignmentStateBadge("past_due")).toEqual({ label: "Past due", tone: "warning" });
    expect(gradeStatusTone("released")).toBe("success");
    expect(gradeStatusTone(null)).toBe("neutral");
    expect(renderToStaticMarkup(<StatusBadge tone="danger">Flagged</StatusBadge>)).toBe('<span class="status-badge tone-danger">Flagged</span>');
  });
  it("labels filter chips with accessible remove buttons", () => {
    expect(chipText("Chapter", "03")).toBe("Chapter: 03");
    const html = renderToStaticMarkup(<FilterChips chips={[{ key: "unitId", label: "Chapter", value: "03", onRemove: () => undefined }]} onAdd={() => undefined} />);
    expect(html).toContain('aria-label="Remove filter Chapter: 03"');
    expect(html).toContain("+ Filter");
  });
  it("renders empty states and response text", () => {
    expect(renderToStaticMarkup(<EmptyState title="Nothing yet">Body</EmptyState>)).toContain("Nothing yet");
    const html = renderToStaticMarkup(<ResponseText text={"Use `mean()` **now**\n```r\nx <- 1\n```"} />);
    expect(html).toContain("<code>mean()</code>");
    expect(html).toContain("<strong>now</strong>");
    expect(html).toContain("x &lt;- 1");
  });
});
