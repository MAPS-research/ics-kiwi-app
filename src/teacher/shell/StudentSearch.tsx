import { useEffect, useId, useRef, useState, type JSX } from "react";
import { Search } from "lucide-react";
import { api } from "../../lib/api";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { teacherPaths } from "../../lib/routes";
import { useTeacher } from "./TeacherContext";
import type { StudentSearchHit } from "../../types";

/** `Find a student…` combobox → profile [F08] — FOUNDATION baseline owned by PEOPLE. */
export function StudentSearch(): JSX.Element {
  const { classId, nameMode } = useTeacher();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<StudentSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(-1);
  const listId = useId();
  const request = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setError("");
      return;
    }
    const id = ++request.current;
    const timer = setTimeout(() => {
      api
        .searchStudents(classId, q)
        .then((result) => {
          if (id !== request.current) return;
          setHits(result);
          setError("");
          setActive(-1);
        })
        .catch((e: unknown) => {
          if (id !== request.current) return;
          setHits([]);
          setError(`Search unavailable: ${e instanceof Error ? e.message : String(e)}`);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [classId, query, nameMode]);
  const choose = (hit: StudentSearchHit) => {
    setOpen(false);
    setQuery("");
    navigate(teacherPaths.studentProfile(hit.studentId));
  };
  const showList = open && query.trim().length > 0;
  return (
    <div className="student-search">
      <Search size={15} aria-hidden="true" />
      <input
        role="combobox"
        aria-label="Find a student"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        placeholder={LABELS.findStudent}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((i) => Math.min(hits.length - 1, i + 1));
          else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
          else if (e.key === "Enter" && hits[active >= 0 ? active : 0]) choose(hits[active >= 0 ? active : 0]);
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {showList && (
        <ul id={listId} role="listbox" className="student-search-list">
          {hits.map((hit, i) => (
            <li
              key={hit.studentId}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(hit);
              }}
            >
              <strong>{hit.studentName}</strong>
              {hit.pseudonym && hit.pseudonym !== hit.studentName && <small>{hit.pseudonym}</small>}
            </li>
          ))}
          {!hits.length && <li className="student-search-empty">{error || "No matching students"}</li>}
        </ul>
      )}
    </div>
  );
}
