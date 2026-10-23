import { useEffect, useState } from "react";
import { setTelemetryContext } from "../../lib/telemetry";
import { DEFAULT_R_CODE, RWorkbench } from "../tools/RWorkbench";
import type { StudentPageProps } from "../StudentApp";
import type { Course } from "../../types";

/*
 * Independent R workspace (TELEMETRY). The student picks the chapter the work belongs to, or leaves it "Not tied to a
 * chapter": runs then carry `attribution: {chapter: 'selected' | 'unattributed'}` and are never silently attributed
 * to this week's chapter [AU-D4-M6]. The selected chapter's runtime (packages, datasets, timeout, hints) applies.
 */

export const UNATTRIBUTED = "";
const unitKey = (classId: string, studentId: string) => `kiwi-workspace-unit:${classId}:${studentId}`;

/** Chapters a student can pick (hidden chapters are never offered). */
export function workspaceChapters(course: Course): { id: string; title: string }[] {
  return course.units.filter((u) => u.effectiveAccess !== "hidden").map((u) => ({ id: u.id, title: u.title }));
}

export function WorkspacePage({ classId, studentId, course, track }: StudentPageProps) {
  const scratchKey = `kiwi-scratch-${classId}-${studentId}`;
  const chapters = workspaceChapters(course);
  const [code, setCode] = useState(() => {
    try {
      return localStorage.getItem(scratchKey) || DEFAULT_R_CODE;
    } catch {
      return DEFAULT_R_CODE;
    }
  });
  const [unitId, setUnitId] = useState(() => {
    try {
      const stored = localStorage.getItem(unitKey(classId, studentId));
      return stored && chapters.some((c) => c.id === stored) ? stored : UNATTRIBUTED;
    } catch {
      return UNATTRIBUTED;
    }
  });
  const choose = (value: string) => {
    setUnitId(value);
    try {
      localStorage.setItem(unitKey(classId, studentId), value);
    } catch {
      // WHY: the choice still applies to this page; it is just not remembered after a reload
    }
  };
  useEffect(() => {
    setTelemetryContext({ surface: "workspace", unitId, tool: "code" });
    return () => setTelemetryContext(null);
  }, [unitId]);
  const unit = course.units.find((u) => u.id === unitId);
  return (
    <div className="student-content">
      <div className="page-intro">
        <div>
          <p className="eyebrow">R WORKSPACE</p>
          <h1>
            Explore with R<span className="accent-dot">.</span>
          </h1>
          <p className="muted">A scratch workspace for your own experiments. Use the R page inside an assignment to attach code to a specific question.</p>
        </div>
      </div>
      <label className="workspace-chapter">
        Chapter for this work
        <select aria-label="Chapter for this work" value={unitId} onChange={(e) => choose(e.target.value)}>
          <option value={UNATTRIBUTED}>Not tied to a chapter</option>
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <RWorkbench
        key={scratchKey}
        code={code}
        onCode={setCode}
        track={(type, payload, qid) => track(type, { ...payload, title: "Independent R workspace" }, qid)}
        storageKey={scratchKey}
        context={{ unitId, surface: "workspace", envKey: "workspace" }}
        runtime={unit?.runtime}
      />
    </div>
  );
}
