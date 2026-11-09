import { ArrowRight, BookOpen, GraduationCap } from "lucide-react";
import { KiwiReturn } from "./KiwiReturn";
import type { KiwiClient } from "./types";

export type AppRole = "student" | "teacher" | "entry";

export function KiwiBrand() {
  return (
    <div className="brand" aria-label="Kiwi CSS Lab">
      <span className="kiwi-wordmark">kiwi</span>
      <span className="brand-name">
        <b>CSS Lab</b>
      </span>
    </div>
  );
}

export function RoleEntry({
  courseTitle,
  canTeach,
  onChoose,
  kiwi,
}: {
  courseTitle: string;
  canTeach: boolean;
  onChoose: (role: AppRole) => void;
  kiwi: KiwiClient | null;
}) {
  return (
    <main className="role-entry">
      <KiwiBrand />
      <KiwiReturn kiwi={kiwi} />
      <section className="role-entry-content">
        <p className="eyebrow">KIWI · CSS LEARNING</p>
        <h1>Choose your workspace</h1>
        <p className="muted">
          {courseTitle} · A focused space for every learning and teaching task.
        </p>
        <div className="role-entry-grid">
          <button
            className="panel role-entry-card"
            onClick={() => onChoose("student")}
          >
            <BookOpen size={26} />
            <strong>Student workspace</strong>
            <span>
              Complete assignments, practice R, and work through questions with
              Kiwi.
            </span>
            <span className="role-entry-link">
              Start learning <ArrowRight size={17} />
            </span>
          </button>
          {canTeach && (
            <button
              className="panel role-entry-card"
              onClick={() => onChoose("teacher")}
            >
              <GraduationCap size={26} />
              <strong>Teacher workspace</strong>
              <span>
                Manage assignments and courses, then explore the activity behind
                student learning.
              </span>
              <span className="role-entry-link">
                Start teaching <ArrowRight size={17} />
              </span>
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
