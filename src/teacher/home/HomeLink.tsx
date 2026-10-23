import type { ReactNode } from "react";
import { navigate } from "../../lib/navigation";

/** A link when the role can open the target, plain text otherwise (viewers see `To grade 12` as text [F15, INSIGHTS-25]). */
export function HomeLink({ href, allowed, children, className = "home-link" }: { href: string; allowed: boolean; children: ReactNode; className?: string }) {
  if (!allowed) return <span className={`${className} as-text`}>{children}</span>;
  return (
    <a
      className={className}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
