import { LABELS } from "../../lib/labels";
import { teacherPaths } from "../../lib/routes";
import { HomeLink } from "./HomeLink";
import { glanceItems } from "./homeModel";
import type { HomeData, TimeRange } from "../../types";

/** This week at a glance (one small row) — every number links to its view (drill-down chain, KEEP). */
export function GlanceRow({ glance, range }: { glance: HomeData["glance"]; range: TimeRange }) {
  const items = glanceItems(glance, range);
  return (
    <section className="home-glance" aria-label={LABELS.thisWeekAtAGlance}>
      <h2 className="home-glance-title">{LABELS.thisWeekAtAGlance}</h2>
      <p>
        {items.map((item, i) => (
          <span key={item.key}>
            {i > 0 && " · "}
            <HomeLink href={item.href} allowed>
              {item.text}
            </HomeLink>
          </span>
        ))}
        {" · "}
        <HomeLink href={teacherPaths.metrics()} allowed>
          All metrics
        </HomeLink>
      </p>
    </section>
  );
}
