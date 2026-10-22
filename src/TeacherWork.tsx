import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Copy, Plus, Save } from "lucide-react";
import { api } from "./lib/api";
import { navigate } from "./lib/navigation";
import { questionLabels } from "./Practice";
import type {
  Assignment,
  Course,
  GenerationPolicy,
  Submission,
  WorkQuestion,
  WorkOption,
} from "./types";

const newQuestion = (): WorkQuestion => ({
  id: `q-${crypto.randomUUID()}`,
  type: "text",
  prompt: "",
  points: 10,
  choices: [],
  starterCode: "",
  answer: "",
  explanation: "",
});
const blank = (course: Course) => ({
  kind: "homework" as Assignment["kind"],
  title: "",
  unitId: course.currentUnitId,
  instructions: "",
  dueAt: null as string | null,
  questions: [newQuestion()],
});
type Draft = ReturnType<typeof blank> & {
  id?: string;
  status?: Assignment["status"];
  attachmentName?: string | null;
  attachmentSourceId?: string;
};
const toLocal = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  return new Date(d.valueOf() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};

export function TeacherWork({
  classId,
  course,
  teacherKey,
  route,
}: {
  classId: string;
  course: Course;
  teacherKey: string;
  route: string;
}) {
  const [works, setWorks] = useState<Assignment[]>([]);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [options, setOptions] = useState<WorkOption[]>([]);
  const [total, setTotal] = useState(0);
  const loadId = useRef(0);
  const [appliedSearch, setAppliedSearch] = useState("");
  const [draft, setDraft] = useState<Draft>(blank(course));
  const [attachment, setAttachment] = useState<{
    name: string;
    type: string;
    data: string;
  } | null>(null);
  const [grades, setGrades] = useState<
    Record<string, { grade: string; feedback: string }>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [policies, setPolicies] = useState<GenerationPolicy[]>([]);
  const [policyUnit, setPolicyUnit] = useState(course.currentUnitId);
  const [policy, setPolicy] = useState<GenerationPolicy | null>(null);
  const [loaded, setLoaded] = useState(false);
  const url = new URL(route, location.origin),
    section = url.pathname.split("/")[3] || "assignments",
    editId = url.pathname.split("/")[4] || "";
  const selectedAssignment = url.searchParams.get("assignmentId") || "";
  const loadedEditor = useRef("");
  useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const refresh = useCallback(async () => {
    const request = ++loadId.current;
    setLoaded(false);
    if (section === "assignments" || section === "grading") {
      const result = await api.workPage(classId, teacherKey, {
        view: section,
        page: String(page),
        search: appliedSearch,
        status: filter,
        assignmentId: selectedAssignment,
      });
      if (request !== loadId.current) return;
      setWorks(result.assignments);
      setSubs(result.submissions);
      setOptions(result.options);
      setTotal(result.total);
    } else if (section === "edit") {
      const [detail, opts] = await Promise.all([
        api.workDetail(classId, editId, teacherKey),
        api.workOptions(classId, teacherKey),
      ]);
      if (request !== loadId.current) return;
      setWorks([detail]);
      setOptions(opts);
    } else if (section === "policies") {
      const policies = await api.policies(classId, teacherKey);
      if (request !== loadId.current) return;
      setPolicies(policies);
    }
    if (request === loadId.current) setLoaded(true);
  }, [
    classId,
    teacherKey,
    section,
    editId,
    page,
    appliedSearch,
    filter,
    selectedAssignment,
  ]);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    return () => {
      loadId.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    setPolicy(policies.find((p) => p.unitId === policyUnit) || null);
  }, [policies, policyUnit]);
  useEffect(() => {
    setMessage("");
    setError("");
  }, [section, editId]);
  useEffect(() => {
    if (section === "new" && loadedEditor.current !== "new") {
      setDraft(blank(course));
      setAttachment(null);
      loadedEditor.current = "new";
    }
    if (section === "edit" && editId && loadedEditor.current !== editId) {
      const w = works.find((w) => w.id === editId);
      if (w) {
        setDraft(structuredClone(w));
        setAttachment(null);
        loadedEditor.current = editId;
      }
    }
  }, [section, editId, works, course]);
  const update = (id: string, values: Partial<WorkQuestion>) =>
    setDraft((d) => ({
      ...d,
      questions: d.questions.map((q) =>
        q.id === id ? { ...q, ...values } : q,
      ),
    }));
  const save = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const value = await api.saveWork(
        classId,
        { ...draft, ...(attachment ? { attachment } : {}) },
        teacherKey,
        draft.id,
      );
      setDraft(value);
      setAttachment(null);
      await refresh();
      loadedEditor.current = value.id;
      navigate(`/teacher/work/edit/${value.id}`);
      setMessage(
        value.status === "published"
          ? "Published assignment updated."
          : "Draft saved. Publish it from the assignment list when ready.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const upload = async (file?: File) => {
    if (!file) return;
    if (file.size > 3_000_000) {
      setError("Attachments must be smaller than 3 MB.");
      return;
    }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Could not read the attachment"));
      reader.readAsDataURL(file);
    });
    setAttachment({
      name: file.name,
      type: file.type || "application/octet-stream",
      data,
    });
    if (/\.(md|qmd|txt)$/i.test(file.name)) {
      const text = await file.text();
      setDraft((d) => ({ ...d, instructions: text.slice(0, 12000) }));
    }
  };
  const toggle = async (w: Assignment) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.workStatus(
        classId,
        w.id,
        w.status === "draft" ? "published" : "draft",
        teacherKey,
      );
      await refresh();
      setMessage(
        w.status === "draft"
          ? "Assignment published to students."
          : "Assignment returned to draft.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const revision = (w: Assignment) => {
    loadedEditor.current = "new";
    setDraft({
      ...structuredClone(w),
      id: undefined,
      status: "draft",
      title: `${w.title} — revision`,
      attachmentSourceId: w.id,
      questions: w.questions.map((q) => ({
        ...q,
        id: `q-${crypto.randomUUID()}`,
      })),
    });
    setAttachment(null);
    navigate("/teacher/work/new");
  };
  const filtered = works;
  const filteredSubs = subs;
  const frozen = Boolean(
    draft.id && options.find((w) => w.id === draft.id)?.hasSubmissions,
  );
  return (
    <div className="teacher-work">
      <nav className="page-tabs" aria-label="Practice and assignment pages">
        {[
          ["assignments", "Assignments"],
          ["grading", "Grading"],
          ["policies", "Generation settings"],
        ].map(([id, label]) => (
          <a
            href={`/teacher/work/${id}`}
            key={id}
            aria-current={
              section === id ||
              (id === "assignments" && ["new", "edit"].includes(section))
                ? "page"
                : undefined
            }
            onClick={(e) => {
              e.preventDefault();
              setSearch("");
              setFilter("all");
              setPage(1);
              navigate(`/teacher/work/${id}`);
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="work-message" role="status">
          {message}
        </p>
      )}
      {section === "policies" ? (
        <section className="panel work-panel focused-panel">
          <p className="eyebrow">TEACHER GENERATION POLICY</p>
          <h2>Guide practice by chapter</h2>
          <p className="muted">
            Your system prompt is applied by the server above student requests.
            Difficulty and question types are enforced on every generated
            request. Changes apply to new exercises and replies.
          </p>
          <label className="work-label">
            Chapter
            <select
              value={policyUnit}
              onChange={(e) => setPolicyUnit(e.target.value)}
            >
              {course.units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.title}
                </option>
              ))}
            </select>
          </label>
          {policy && (
            <>
              <label className="work-label">
                Teacher system prompt (English)
                <textarea
                  aria-label="Teacher system prompt"
                  rows={7}
                  maxLength={6000}
                  value={policy.systemPrompt || ""}
                  onChange={(e) =>
                    setPolicy({ ...policy, systemPrompt: e.target.value })
                  }
                />
              </label>
              <div className="work-form-grid">
                {(
                  [
                    "minDifficulty",
                    "maxDifficulty",
                    "defaultDifficulty",
                  ] as const
                ).map((k, i) => (
                  <label key={k}>
                    {
                      [
                        "Minimum difficulty",
                        "Maximum difficulty",
                        "Default difficulty",
                      ][i]
                    }
                    <input
                      type="number"
                      min={1}
                      max={5}
                      value={policy[k]}
                      onChange={(e) =>
                        setPolicy({ ...policy, [k]: Number(e.target.value) })
                      }
                    />
                  </label>
                ))}
                <label>
                  Output token limit
                  <input
                    type="number"
                    min={512}
                    max={4000}
                    step={128}
                    value={policy.maxOutputTokens}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        maxOutputTokens: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <fieldset className="policy-types">
                <legend>Allowed question types</legend>
                {Object.entries(questionLabels).map(([id, label]) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={policy.allowedTypes.includes(
                        id as (typeof policy.allowedTypes)[number],
                      )}
                      onChange={(e) =>
                        setPolicy({
                          ...policy,
                          allowedTypes: e.target.checked
                            ? [
                                ...policy.allowedTypes,
                                id as (typeof policy.allowedTypes)[number],
                              ]
                            : policy.allowedTypes.filter((t) => t !== id),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
              <div className="work-actions">
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    setMessage("");
                    void api
                      .savePolicy(
                        classId,
                        { ...policy, unitId: policyUnit },
                        teacherKey,
                      )
                      .then(() => refresh())
                      .then(() =>
                        setMessage("Chapter generation policy saved."),
                      )
                      .catch((e) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  <Save size={16} />
                  Save chapter policy
                </button>
              </div>
            </>
          )}
        </section>
      ) : section === "grading" ? (
        <section className="panel work-panel">
          <div className="panel-heading">
            <h2>Review submissions</h2>
            <button
              className="outline-button"
              onClick={() => void refresh().catch((e) => setError(e.message))}
            >
              Refresh submissions
            </button>
          </div>
          <div className="table-toolbar">
            <label>
              Assignment
              <select
                value={selectedAssignment}
                onChange={(e) => {
                  setPage(1);
                  navigate(
                    `/teacher/work/grading${e.target.value ? `?assignmentId=${e.target.value}` : ""}`,
                  );
                }}
              >
                <option value="">All assignments</option>
                {options
                  .filter((w) => w.kind === "homework")
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Student
              <input
                placeholder="Search name or ID"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label>
              Status
              <select
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">All submissions</option>
                <option value="ungraded">Awaiting grade</option>
              </select>
            </label>
          </div>
          {!loaded && (
            <p role="status" className="empty-state">
              Loading submissions…
            </p>
          )}
          {loaded &&
            filteredSubs.map((s) => {
              const w = works.find((w) => w.id === s.assignmentId);
              if (!w) return null;
              const max = w.questions.reduce((n, q) => n + q.points, 0);
              const value = grades[s.id] || {
                grade: s.grade?.toString() || "",
                feedback: s.feedback || "",
              };
              return (
                <article className="grading-card" key={s.id}>
                  <div className="row-between">
                    <div>
                      <strong>
                        {s.studentName} · {w.title}
                      </strong>
                      <p className="muted">
                        Attempt {s.attempt} ·{" "}
                        {new Date(s.submittedAt).toLocaleString("en-US")}
                      </p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() =>
                        navigate(
                          `/teacher/analytics/table?group=sessions&studentId=${s.studentId}&assignmentId=${w.id}`,
                        )
                      }
                    >
                      View learning sessions <ArrowRight size={15} />
                    </button>
                  </div>
                  {w.questions.map((q, i) => (
                    <details className="grading-answer" key={q.id} open>
                      <summary>
                        Question {i + 1} · {q.points} points
                      </summary>
                      <p>{q.prompt}</p>
                      <pre>{s.answers[q.id] || "No answer"}</pre>
                      <small>
                        Reference: {q.answer || "Use your grading rubric."}
                      </small>
                    </details>
                  ))}
                  <div className="grade-controls">
                    <label>
                      Score / {max}
                      <input
                        aria-label={`Score for ${s.id}`}
                        type="number"
                        min={0}
                        max={max}
                        value={value.grade}
                        onChange={(e) =>
                          setGrades({
                            ...grades,
                            [s.id]: { ...value, grade: e.target.value },
                          })
                        }
                      />
                    </label>
                    <label>
                      Feedback
                      <input
                        aria-label={`Feedback for ${s.id}`}
                        value={value.feedback}
                        onChange={(e) =>
                          setGrades({
                            ...grades,
                            [s.id]: { ...value, feedback: e.target.value },
                          })
                        }
                      />
                    </label>
                    <button
                      className="primary-button"
                      disabled={busy || value.grade === ""}
                      onClick={() => {
                        setBusy(true);
                        setError("");
                        setMessage("");
                        void api
                          .grade(
                            classId,
                            s.id,
                            Number(value.grade),
                            value.feedback,
                            teacherKey,
                          )
                          .then(() => refresh())
                          .then(() =>
                            setMessage(
                              `Grade saved for ${s.studentName}, attempt ${s.attempt}.`,
                            ),
                          )
                          .catch((e) => setError(e.message))
                          .finally(() => setBusy(false));
                      }}
                    >
                      Save grade
                    </button>
                  </div>
                </article>
              );
            })}
          {loaded && !filteredSubs.length && (
            <p className="empty-state">No submissions match these filters.</p>
          )}
          <Pager page={page} total={total} size={10} onPage={setPage} />
        </section>
      ) : section === "new" || section === "edit" ? (
        <section className="panel work-panel focused-panel">
          <button
            className="text-button"
            onClick={() => navigate("/teacher/work/assignments")}
          >
            <ArrowLeft size={15} /> Assignment list
          </button>
          <h2>{draft.id ? "Edit assignment" : "Create assignment"}</h2>
          {frozen && (
            <div className="work-message">
              This assignment has submissions. Create a revision to preserve the
              original questions and grades.
              <button
                className="text-button"
                onClick={() => revision(works.find((w) => w.id === draft.id)!)}
              >
                <Copy size={15} />
                Create revision
              </button>
            </div>
          )}
          <fieldset
            className="editor-fields"
            disabled={!loaded || frozen || busy}
          >
            <div className="work-form-grid">
              <label>
                Kind
                <select
                  value={draft.kind}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      kind: e.target.value as Draft["kind"],
                    })
                  }
                >
                  <option value="homework">Homework</option>
                  <option value="practice">Class practice</option>
                </select>
              </label>
              <label>
                Chapter
                <select
                  value={draft.unitId}
                  onChange={(e) =>
                    setDraft({ ...draft, unitId: e.target.value })
                  }
                >
                  {course.units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Title
                <input
                  value={draft.title}
                  maxLength={120}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                  placeholder="Week 3 · Data filtering"
                />
              </label>
              <label>
                Due date (your local time)
                <input
                  type="datetime-local"
                  value={toLocal(draft.dueAt)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      dueAt: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : null,
                    })
                  }
                />
              </label>
            </div>
            <label className="work-label">
              Instructions
              <textarea
                rows={4}
                maxLength={12000}
                value={draft.instructions}
                onChange={(e) =>
                  setDraft({ ...draft, instructions: e.target.value })
                }
              />
            </label>
            <label className="work-label">
              Attachment · up to 3 MB
              <input
                type="file"
                accept=".qmd,.md,.txt,.pdf,.csv,.r,.rds,.zip"
                onChange={(e) =>
                  void upload(e.target.files?.[0]).catch((err) =>
                    setError(err.message),
                  )
                }
              />
            </label>
            {(attachment?.name || draft.attachmentName) && (
              <p className="muted">
                {attachment?.name || draft.attachmentName}
              </p>
            )}
            <div className="work-question-list">
              {draft.questions.map((q, i) => (
                <article className="work-question-edit" key={q.id}>
                  <div className="row-between">
                    <h3>Question {i + 1}</h3>
                    <button
                      className="text-button"
                      disabled={draft.questions.length === 1}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          questions: draft.questions.filter(
                            (v) => v.id !== q.id,
                          ),
                        })
                      }
                    >
                      Remove question
                    </button>
                  </div>
                  <div className="work-form-grid">
                    <label>
                      Question type
                      <select
                        value={q.type}
                        onChange={(e) =>
                          update(q.id, {
                            type: e.target.value as WorkQuestion["type"],
                          })
                        }
                      >
                        <option value="text">Written response</option>
                        {Object.entries(questionLabels).map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Points
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={q.points}
                        onChange={(e) =>
                          update(q.id, { points: Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                  <label className="work-label">
                    Question prompt
                    <textarea
                      rows={3}
                      value={q.prompt}
                      maxLength={4000}
                      onChange={(e) => update(q.id, { prompt: e.target.value })}
                    />
                  </label>
                  {q.type === "choice" && (
                    <label className="work-label">
                      Choices (one per line)
                      <textarea
                        rows={4}
                        value={q.choices.join("\n")}
                        onChange={(e) =>
                          update(q.id, { choices: e.target.value.split("\n") })
                        }
                      />
                    </label>
                  )}
                  {["complete", "predict"].includes(q.type) && (
                    <label className="work-label">
                      Starter R code
                      <textarea
                        rows={4}
                        className="mono"
                        value={q.starterCode}
                        onChange={(e) =>
                          update(q.id, { starterCode: e.target.value })
                        }
                      />
                    </label>
                  )}
                  <label className="work-label">
                    Reference answer
                    <textarea
                      rows={2}
                      value={q.answer || ""}
                      onChange={(e) => update(q.id, { answer: e.target.value })}
                    />
                  </label>
                  <label className="work-label">
                    Explanation / grading rubric
                    <textarea
                      rows={2}
                      value={q.explanation || ""}
                      onChange={(e) =>
                        update(q.id, { explanation: e.target.value })
                      }
                    />
                  </label>
                </article>
              ))}
            </div>
            <div className="work-actions">
              <button
                className="outline-button"
                disabled={draft.questions.length >= 30}
                onClick={() =>
                  setDraft({
                    ...draft,
                    questions: [...draft.questions, newQuestion()],
                  })
                }
              >
                <Plus size={15} /> Add question
              </button>
              <button className="primary-button" onClick={() => void save()}>
                <Save size={15} />
                {draft.status === "published"
                  ? "Save published changes"
                  : "Save draft"}
              </button>
            </div>
          </fieldset>
        </section>
      ) : (
        <section className="panel work-panel">
          <div className="panel-heading">
            <h2>Manage assigned work</h2>
            <button
              className="primary-button"
              onClick={() => {
                loadedEditor.current = "";
                navigate("/teacher/work/new");
              }}
            >
              <Plus size={16} /> New assignment
            </button>
          </div>
          <div className="table-toolbar">
            <label>
              Find an assignment
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search assignment titles"
              />
            </label>
            <label>
              Status
              <select
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">All</option>
                <option value="draft">Drafts</option>
                <option value="published">Published</option>
              </select>
            </label>
          </div>
          <div className="work-list">
            {!loaded && (
              <p role="status" className="empty-state">
                Loading assignments…
              </p>
            )}
            {loaded &&
              filtered.map((w) => (
                <article className="work-list-row" key={w.id}>
                  <div>
                    <strong>{w.title}</strong>
                    <small>
                      {w.kind === "homework" ? "Homework" : "Practice"} ·{" "}
                      {w.questions.length} questions ·{" "}
                      {w.status === "draft" ? "Draft" : "Published"} ·{" "}
                      {course.units.find((u) => u.id === w.unitId)?.title ||
                        w.unitId}
                    </small>
                  </div>
                  <button
                    className="outline-button"
                    onClick={() => navigate(`/teacher/work/edit/${w.id}`)}
                  >
                    Edit
                  </button>
                  <button
                    className="outline-button"
                    onClick={() =>
                      navigate(`/teacher/work/grading?assignmentId=${w.id}`)
                    }
                  >
                    Grade
                  </button>
                  <button
                    className="primary-button"
                    disabled={
                      busy ||
                      (w.status === "published" &&
                        options.find((o) => o.id === w.id)?.hasSubmissions)
                    }
                    onClick={() => void toggle(w)}
                  >
                    {w.status === "draft" ? "Publish" : "Unpublish"}
                  </button>
                </article>
              ))}
          </div>
          {loaded && !filtered.length && (
            <p className="empty-state">
              No assignments match. Create a draft to get started.
            </p>
          )}
          <Pager page={page} total={total} size={20} onPage={setPage} />
          <details className="sample-loader">
            <summary>Course example drafts</summary>
            <p className="muted">
              Create editable examples based on the course skills. Review
              answers and instructions before publishing.
            </p>
            <button
              className="outline-button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api
                  .seedSamples(classId, teacherKey)
                  .then((r) => {
                    setMessage(`${r.created} example drafts created.`);
                    return refresh();
                  })
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              Load CSS example drafts
            </button>
          </details>
        </section>
      )}
    </div>
  );
}
export function Pager({
  page,
  total,
  size,
  onPage,
}: {
  page: number;
  total: number;
  size: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        {total
          ? `${(page - 1) * size + 1}–${Math.min(page * size, total)} of ${total}`
          : "0 results"}
      </span>
      <button
        className="outline-button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <ArrowLeft size={15} />
        Previous
      </button>
      <button
        className="outline-button"
        disabled={page * size >= total}
        onClick={() => onPage(page + 1)}
      >
        Next
        <ArrowRight size={15} />
      </button>
    </div>
  );
}
