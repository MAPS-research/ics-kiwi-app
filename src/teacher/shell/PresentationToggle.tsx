import type { JSX } from "react";
import { Eye, EyeOff } from "lucide-react";
import { LABELS } from "../../lib/labels";
import { PSEUDONYMS_FORCED_NOTE } from "./AccountMenu";
import { useTeacher } from "./TeacherContext";

/** One-click Presentation mode [TH12] — FOUNDATION baseline owned by PEOPLE. Pressed state = purple-outline pill. */
export function PresentationToggle(): JSX.Element {
  const { me, nameMode, setNameMode } = useTeacher();
  const forced = Boolean(me.pseudonymsForced);
  const on = forced || nameMode === "pseudonyms";
  return (
    <button
      type="button"
      className={`presentation-toggle ${on ? "pressed" : ""}`}
      aria-pressed={on}
      disabled={forced}
      title={forced ? PSEUDONYMS_FORCED_NOTE : on ? "Names are hidden (pseudonyms shown)" : "Hide student names and emails"}
      onClick={() => setNameMode(on ? "names" : "pseudonyms")}
    >
      {on ? <EyeOff size={15} /> : <Eye size={15} />}
      <span>{LABELS.presentationMode}</span>
    </button>
  );
}
