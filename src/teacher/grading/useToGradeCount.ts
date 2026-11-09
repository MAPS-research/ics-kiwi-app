import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useTeacher } from "../shell/TeacherContext";

/**
 * Live "To grade" count for the Grading section tab on pages that do not load the queue themselves (Gradebook,
 * Release & export; NM12). Added by INTEGRATION to connect CR-GRADE-1. Roles without `grade` never see that tab, so
 * nothing is fetched for them.
 */
export function useToGradeCount(): number | undefined {
  const { classId, me } = useTeacher();
  const canGrade = me.permissions.includes("grade");
  const [count, setCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!canGrade) {
      setCount(undefined);
      return;
    }
    let active = true;
    api
      .gradingQueue(classId, { show: "latest" })
      .then((queue) => {
        if (active) setCount(queue.counts.toGrade);
      })
      .catch(() => {
        // WHY: the count only decorates the tab; on failure the tab keeps its plain "To grade" label and the page's own
        // requests report the error.
        if (active) setCount(undefined);
      });
    return () => {
      active = false;
    };
  }, [classId, canGrade]);
  return count;
}
