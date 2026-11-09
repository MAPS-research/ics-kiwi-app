import { MoreHorizontal } from "lucide-react";
import { Popover } from "../../components/Popover";
import { fieldLabel, rowMenuActions, type ListItem, type RowAction } from "./assignmentRules";
import type { Permission } from "../../types";

/** The ⋯ menu of an assignment row [F13, AU-D1-09]: Duplicate · Create revision · Preview as student · Clear test
 * submissions · Close submissions / Reopen · Archive · Delete draft. Pure view; the page runs the action. */
export function AssignmentRowMenu({
  item,
  permissions,
  busy,
  onAction,
}: {
  item: ListItem;
  permissions: readonly Permission[];
  busy: boolean;
  onAction: (action: RowAction, item: ListItem) => void;
}) {
  const actions = rowMenuActions(item, permissions);
  if (!actions.length) return null;
  return (
    <Popover label={<MoreHorizontal size={16} />} ariaLabel={fieldLabel.rowMenu(item.title)} role="menu" buttonClassName="icon-button">
      {(close) => (
        <ul className="menu-list">
          {actions.map((entry) => (
            <li key={entry.action}>
              <button type="button" role="menuitem" className={`menu-item${entry.action === "delete" ? " assess-danger" : ""}`} disabled={busy}
                onClick={() => {
                  close();
                  onAction(entry.action, item);
                }}>
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}
