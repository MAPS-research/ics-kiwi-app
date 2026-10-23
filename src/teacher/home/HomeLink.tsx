import type { ReactNode } from "react";
import { navigate } from "../../lib/navigation";

/** A link when the role can open the target, plain text otherwise (viewers see `To grade 12` as text [F15, INSIGHTS-25]). */
export function HomeLink({ href, allowed, children, className = "home-link", title }: {
  href: string; allowed: boolean; children: ReactNode; className?: string;
  /** Tooltip, e.g. the original of a missing revision (D8) */
  title?: string;
}) {
  if (!allowed) return <span className={`${className} as-text`} title={title}>{children}</span>;
  return (
    <a
      className={className}
      href={href}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
