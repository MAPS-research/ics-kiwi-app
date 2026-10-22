import { useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { api } from "./lib/api";
import { navigate } from "./lib/navigation";
import { Pager } from "./TeacherWork";
import { KiwiMaterials } from "./KiwiIntegration";
import type { AnalyticsTable, Course } from "./types";

export function TeacherCourse({
  classId,
  course,
  teacherKey,
  onCourse,
  roster,
  materials,
}: {
  classId: string;
  course: Course;
  teacherKey: string;
  onCourse: (c: Course) => void;
  roster: boolean;
  materials: boolean;
}) {
  const [draft, setDraft] = useState(structuredClone(course));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [students, setStudents] = useState<AnalyticsTable | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setDraft(structuredClone(course));
  }, [course]);
  useEffect(() => {
    if (!roster) return;
    let active = true;
    void api
      .analytics(classId, teacherKey, {
        group: "students",
        search,
        page: String(page),
        sort: "label",
        direction: "asc",
      })
      .then((r) => {
        if (active) setStudents(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [roster, classId, teacherKey, search, page, revision]);
  const save = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const c = await api.saveCourse(classId, draft, teacherKey);
      onCourse(c);
      setMessage(
        "Course updated. Students receive the new plan when they reopen the course.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const importRoster = async () => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const rows = text
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.trim() && !/^student.?id[,\t]/i.test(l))
        .map((line) => {
          const [id, ...parts] = line.split(/[,\t]/);
          return { studentId: id.trim(), studentName: parts.join(" ").trim() };
        });
      const result = await api.importRoster(classId, rows, teacherKey);
      setMessage(
        `${result.count} students added or updated. Existing work and grades are preserved.`,
      );
      setText("");
      setRevision((r) => r + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <nav className="page-tabs" aria-label="Course management pages">
        {[
          ["plan", "Course plan"],
          ["roster", "Enrollment"],
          ["materials", "Kiwi materials"],
        ].map(([id, label]) => (
          <a
            key={id}
            href={`/teacher/course/${id}`}
            aria-current={(materials ? id === "materials" : roster ? id === "roster" : id === "plan") ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/teacher/course/${id}`);
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
      {materials ? <KiwiMaterials classId={classId} teacherKey={teacherKey} course={course} /> : roster ? (
        <section className="panel work-panel">
          <h2>Course enrollment</h2>
          <p className="muted">
            Enrolled students appear even before their first interaction. Search
            a student to open their learning evidence.
          </p>
          <label className="work-label">
            Find a student
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search name or ID"
            />
          </label>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Student ID</th>
                  <th>Learning sessions</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {students?.rows.map((s) => (
                  <tr key={s.studentId}>
                    <td>{s.label}</td>
                    <td>{s.studentId}</td>
                    <td>{s.sessions}</td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() =>
                          navigate(
                            `/teacher/analytics/table?group=sessions&studentId=${s.studentId}`,
                          )
                        }
                      >
                        View sessions
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={page}
            total={students?.total || 0}
            size={25}
            onPage={setPage}
          />
          <details className="roster-import">
            <summary>Add or update students</summary>
            <p>
              Enter one studentId,Student Name per line, up to 500 students per
              import. IDs must match the course identity provider.
            </p>
            <textarea
              aria-label="Student roster CSV"
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"student-001,Ada Chen\nstudent-002,Bo Lin"}
            />
            <div className="work-actions">
              <label className="outline-button">
                Choose CSV / TSV
                <input
                  type="file"
                  accept=".csv,.tsv,.txt"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f)
                      void f
                        .text()
                        .then(setText)
                        .catch((err) => setError(err.message));
                  }}
                />
              </label>
              <button
                className="primary-button"
                disabled={busy || !text.trim()}
                onClick={() => void importRoster()}
              >
                Import students
              </button>
            </div>
          </details>
        </section>
      ) : (
        <section className="panel work-panel focused-panel">
          <h2>Course plan & progress</h2>
          <label className="work-label">
            Course title
            <input
              value={draft.title}
              maxLength={100}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="work-label">
            Description
            <textarea
              rows={3}
              maxLength={1000}
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </label>
          <p className="muted">
            Select the current chapter. Earlier chapters are marked complete;
            the current chapter remains in progress.
          </p>
          <div className="unit-editor-list">
            {draft.units.map((u, i) => (
              <div className="unit-editor-row" key={u.id}>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="current-chapter"
                    checked={draft.currentUnitId === u.id}
                    onChange={() => setDraft({ ...draft, currentUnitId: u.id })}
                  />{" "}
                  Current chapter
                </label>
                <button
                  className="remove-unit"
                  aria-label={`Remove chapter ${i + 1}`}
                  disabled={
                    draft.units.length === 1 || draft.currentUnitId === u.id
                  }
                  onClick={() =>
                    setDraft({
                      ...draft,
                      units: draft.units.filter((v) => v.id !== u.id),
                    })
                  }
                >
                  <Trash2 size={15} />
                </button>
                <label>
                  Chapter {i + 1} title
                  <input
                    value={u.title}
                    maxLength={100}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        units: draft.units.map((v) =>
                          v.id === u.id ? { ...v, title: e.target.value } : v,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Learning goal
                  <input
                    value={u.goal}
                    maxLength={500}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        units: draft.units.map((v) =>
                          v.id === u.id ? { ...v, goal: e.target.value } : v,
                        ),
                      })
                    }
                  />
                </label>
              </div>
            ))}
          </div>
          <div className="work-actions">
            <button
              className="outline-button"
              disabled={draft.units.length >= 30}
              onClick={() =>
                setDraft({
                  ...draft,
                  units: [
                    ...draft.units,
                    {
                      id: `unit-${crypto.randomUUID()}`,
                      title: "New chapter",
                      goal: "Describe the learning goal",
                      status: "upcoming",
                    },
                  ],
                })
              }
            >
              <Plus size={16} />
              Add chapter
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void save()}
            >
              <Save size={16} />
              Save course plan
            </button>
          </div>
        </section>
      )}
    </>
  );
}
