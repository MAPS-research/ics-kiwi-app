/** One filter row [LY02, FD06]: `Chapter: 03 ✕ · Work: Free practice only ✕ · + Filter`. */
export interface FilterChip { key: string; label: string; value: string; onRemove: () => void }

export function chipText(label: string, value: string): string {
  return `${label}: ${value}`;
}

export function FilterChips({
  chips,
  onAdd,
  addLabel = "+ Filter",
  onClearAll,
}: {
  chips: readonly FilterChip[];
  onAdd?: () => void;
  addLabel?: string;
  onClearAll?: () => void;
}) {
  if (!chips.length && !onAdd) return null;
  return (
    <div className="filter-chips" role="group" aria-label="Active filters">
      {chips.map((chip) => (
        <button key={chip.key} type="button" className="filter-chip" onClick={chip.onRemove} aria-label={`Remove filter ${chipText(chip.label, chip.value)}`}>
          {chipText(chip.label, chip.value)} <span aria-hidden="true">✕</span>
        </button>
      ))}
      {onAdd && (
        <button type="button" className="filter-chip filter-chip-add" onClick={onAdd}>
          {addLabel}
        </button>
      )}
      {onClearAll && chips.length > 1 && (
        <button type="button" className="text-button" onClick={onClearAll}>
          Clear filters
        </button>
      )}
    </div>
  );
}
