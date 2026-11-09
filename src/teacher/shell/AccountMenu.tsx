import type { JSX } from "react";
import { ChevronDown, LogOut, MonitorPlay, UserRound } from "lucide-react";
import { LABELS } from "../../lib/labels";
import { navigate } from "../../lib/navigation";
import { previewPaths } from "../../lib/routes";
import { Popover } from "../../components/Popover";
import { useTeacher } from "./TeacherContext";
import type { Me } from "../../types";
import { rememberPreviewReturn } from "../../lib/previewReturn";

/** Decision D3: shown to researchers, whose Presentation mode cannot be turned off. */
export const PSEUDONYMS_FORCED_NOTE = "Researcher accounts always see pseudonyms (S-014), never names or emails.";

const ROLE_NAMES: Readonly<Record<string, string>> = { instructor: "Instructor", ta: "Teaching assistant", viewer: "Viewer", researcher: "Researcher" };

export function roleLabel(me: Pick<Me, "role" | "kind" | "isStaff">): string {
  const role = (me.role && ROLE_NAMES[me.role]) || (me.isStaff ? "Kiwi course staff" : "Student");
  return me.kind === "teacher_key" ? `${role} (local key)` : me.kind === "staff_key" ? `${role} (staff key)` : role;
}

/** Account menu [NM46] — FOUNDATION baseline owned by PEOPLE: identity, role, Presentation mode, sign out. */
export function AccountMenu(): JSX.Element {
  const { me, nameMode, setNameMode, signOut } = useTeacher();
  return (
    <Popover
      className="account-menu"
      buttonClassName="account-button"
      ariaLabel="Account menu"
      label={
        <>
          <span className="avatar" aria-hidden="true">
            {(me.displayName || "T")[0]?.toUpperCase()}
          </span>
          <ChevronDown size={14} />
        </>
      }
    >
      {(close) => (
        <div className="account-panel">
          <p className="account-identity">
            <UserRound size={15} /> <strong>{me.displayName || "Teacher"}</strong>
          </p>
          {roleLabel(me) !== me.displayName && <p className="muted">{roleLabel(me)}</p>}
          <label className="checkbox-label">
            <input type="checkbox" checked={nameMode === "pseudonyms"} disabled={Boolean(me.pseudonymsForced)}
              onChange={(e) => setNameMode(e.target.checked ? "pseudonyms" : "names")} />
            {LABELS.presentationMode}
          </label>
          {me.pseudonymsForced && <p className="muted">{PSEUDONYMS_FORCED_NOTE}</p>}
          {me.permissions.includes("previewStudent") && (
            <button
              type="button"
              className="outline-button preview-button"
              onClick={() => {
                close();
                rememberPreviewReturn(location.pathname + location.search);   // RV6-m01
                navigate(previewPaths.assignments());
              }}
            >
              <MonitorPlay size={15} /> {LABELS.previewAsStudent}
            </button>
          )}
          {me.kind === "kiwi" ? (
            <p className="muted">{LABELS.signedInThroughKiwi}</p>
          ) : (
            <button
              type="button"
              className="outline-button"
              onClick={() => {
                close();
                signOut();
              }}
            >
              <LogOut size={15} /> {LABELS.signOutTeacherView}
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}
