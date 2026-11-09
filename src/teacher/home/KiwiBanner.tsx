import { LABELS } from "../../lib/labels";
import { teacherPaths } from "../../lib/routes";
import { HomeLink } from "./HomeLink";

/** Home-only banner for courses not linked to Kiwi [NM32, INSIGHTS-18]; dismissal is remembered per class. */
export function KiwiBanner({ linked, dismissed, canSetUp, onDismiss }: { linked: boolean; dismissed: boolean; canSetUp: boolean; onDismiss: () => void }) {
  if (linked || dismissed) return null;
  return (
    <div className="global-status home-kiwi-banner" role="status">
      <p>{LABELS.kiwiNotLinkedBanner}</p>
      <HomeLink className="text-button" href={canSetUp ? teacherPaths.settings("kiwi") : "/teacher/chapters/materials"} allowed>
        {LABELS.howToLink}
      </HomeLink>
      <button type="button" className="text-button" onClick={onDismiss}>
        {LABELS.dismiss}
      </button>
    </div>
  );
}
