import type { JSX } from "react";
import { RefreshCw } from "lucide-react";
import { LABELS } from "../../lib/labels";
import { useKiwiSync } from "./useKiwiSync";

/** Top-bar slot: "New activity · Refresh" (FOUNDATION baseline owned by TELEMETRY). */
export function KiwiSyncNotice(): JSX.Element | null {
  const { newActivity, acknowledge, error } = useKiwiSync();
  if (newActivity)
    return (
      <div className="kiwi-sync-notice" role="status">
        <span>{LABELS.newActivity}</span>
        <span aria-hidden="true">·</span>
        <button type="button" className="text-button" onClick={acknowledge}>
          <RefreshCw size={14} /> {LABELS.refresh}
        </button>
      </div>
    );
  if (error)
    return (
      <span className="kiwi-sync-error" role="status" title={error}>
        Kiwi sync paused
      </span>
    );
  return null;
}
