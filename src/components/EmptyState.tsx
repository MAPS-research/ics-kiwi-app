import type { ReactNode } from "react";

/** Empty, loading-complete or not-yet-available content inside a panel. */
export function EmptyState({ title, children, actions }: { title?: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty-state">
      {title && <h2 className="empty-state-title">{title}</h2>}
      {children && <div className="empty-state-body">{children}</div>}
      {actions && <div className="work-actions empty-state-actions">{actions}</div>}
    </div>
  );
}
