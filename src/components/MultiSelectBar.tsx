import { pluralize } from "../lib/labels";

/** Selection helpers for tables with row checkboxes (pure; immutable updates). */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
export function setAllSelected(selected: ReadonlySet<string>, ids: readonly string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}
export function allSelected(selected: ReadonlySet<string>, ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => selected.has(id));
}
/** "3 students selected" */
export function selectionSummary(count: number, noun: string, plural?: string): string {
  return `${pluralize(count, noun, plural)} selected`;
}

export interface MultiSelectAction { label: string; onClick: () => void; disabled?: boolean }

/** Sticky bar shown while rows are selected (e.g. Create group from selected · Assign work to selected). */
export function MultiSelectBar({
  count,
  noun,
  plural,
  actions,
  onClear,
}: {
  count: number;
  noun: string;
  plural?: string;
  actions: readonly MultiSelectAction[];
  onClear: () => void;
}) {
  if (count <= 0) return null;
  return (
    <div className="multi-select-bar" role="region" aria-label="Selection actions">
      <strong>{selectionSummary(count, noun, plural)}</strong>
      <div className="multi-select-actions">
        {actions.map((action) => (
          <button key={action.label} type="button" className="outline-button" disabled={action.disabled} onClick={action.onClick}>
            {action.label}
          </button>
        ))}
      </div>
      <button type="button" className="text-button" onClick={onClear}>
        Clear selection
      </button>
    </div>
  );
}
