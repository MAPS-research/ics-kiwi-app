import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// WHY: renderToStaticMarkup (view tests) has no layout phase; useEffect there avoids React's server warning.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Horizontal shift (px) that keeps a panel inside the viewport with a side gutter (review 2, TEACHER-11): negative
 * moves it left when it would run past the right edge, positive moves it right past the left gutter.
 */
export function popoverShift(rect: { left: number; right: number }, viewportWidth: number, gutter = 16): number {
  const width = rect.right - rect.left;
  if (width >= viewportWidth - 2 * gutter) return gutter - rect.left;
  if (rect.right > viewportWidth - gutter) return viewportWidth - gutter - rect.right;
  if (rect.left < gutter) return gutter - rect.left;
  return 0;
}

/** A button that opens a small panel; closes on Escape, outside click, or `close()` from the content. */
export function Popover({
  label,
  ariaLabel,
  children,
  align = "end",
  className = "",
  buttonClassName = "outline-button",
  role = "dialog",
  defaultOpen = false,
}: {
  label: ReactNode;
  ariaLabel?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  className?: string;
  buttonClassName?: string;
  role?: "dialog" | "menu";
  /** open on first render (a deep link to this panel) */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [shift, setShift] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useIsoLayoutEffect(() => {
    if (!open || !panel.current || typeof window === "undefined") {
      setShift(0);
      return;
    }
    const rect = panel.current.getBoundingClientRect();
    setShift(popoverShift({ left: rect.left, right: rect.right }, document.documentElement.clientWidth || window.innerWidth));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div className={`popover ${className}`.trim()} ref={root}>
      <button
        type="button"
        className={buttonClassName}
        aria-label={ariaLabel}
        aria-haspopup={role}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <div id={id} ref={panel} className={`popover-panel align-${align}`} role={role}
          style={shift ? { transform: `translateX(${Math.round(shift)}px)` } : undefined}>
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
