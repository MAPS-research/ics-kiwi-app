import { useEffect, useState } from "react";
import { STUDENT_LABELS } from "../../lib/labels";
import { chapterOptions, firstUsableChapter } from "../../lib/questions";
import { setTelemetryContext } from "../../lib/telemetry";
import { KiwiChat } from "../tools/KiwiChat";
import type { StudentPageProps } from "../StudentApp";

/*
 * Standalone Ask Kiwi (AIRUN). Chapters the student cannot open yet show as "… (Opens later)" and cannot be picked;
 * Review chapters stay available for questions. The server enforces the same access rule (§12.4).
 */
export function AskKiwiPage({ classId, studentId, course, track }: StudentPageProps) {
  const [unitId, setUnitId] = useState(() => firstUsableChapter(course, "chat", course.currentUnitId));
  useEffect(() => {
    setTelemetryContext({ surface: "ask-kiwi", unitId, tool: "kiwi" });
    return () => setTelemetryContext(null);
  }, [unitId]);
  const options = chapterOptions(course, "chat");
  return (
    <div className="student-content">
      <div className="page-intro">
        <div>
          <h1>{STUDENT_LABELS.navAskKiwi}</h1>
          <p className="muted">Ask about the ideas of a chapter. For graded homework Kiwi gives hints, not answers.</p>
        </div>
      </div>
      <label className="chapter-picker">
        Chapter
        <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <KiwiChat
        key={`${studentId}-${unitId}`}
        classId={classId}
        studentId={studentId}
        unitId={unitId}
        surface="ask-kiwi"
        question={course.units.find((u) => u.id === unitId)?.goal || ""}
        code=""
        track={track}
      />
    </div>
  );
}
