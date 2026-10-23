import { useEffect, useState } from "react";

/*
 * Client-side navigation helpers (frozen after FOUNDATION).
 * No storage or `location` access happens at import time, so this module loads under the node test environment.
 */

const PREVIEW_STUDENT_PREFIX = "/preview/student";

/**
 * While the staff preview of the student app is open (`/preview/student/…`), moved student pages that
 * navigate to `/student/…` stay inside the preview. Staff never act as students outside preview (§3.4).
 */
export function previewAwarePath(path: string, currentPathname: string): string {
  if (!currentPathname.startsWith(PREVIEW_STUDENT_PREFIX)) return path;
  if (path === "/student" || path.startsWith("/student/") || path.startsWith("/student?"))
    return `/preview${path}`;
  return path;
}

/**
 * `href` for a student link: inside Preview as student it points into the preview, so opening it in a new tab never
 * loads the real student app as the demo student (review 2, TEACHER-15).
 */
export function studentHref(path: string, currentPathname: string = typeof location === "undefined" ? "" : location.pathname): string {
  return previewAwarePath(path, currentPathname);
}

export function navigate(path: string, replace = false): void {
  const target = previewAwarePath(path, location.pathname);
  if (target === location.pathname + location.search) return;
  const changedPage = new URL(target, location.origin).pathname !== location.pathname;
  if (replace) history.replaceState(history.state, "", target);
  else history.pushState({}, "", target);
  window.dispatchEvent(new PopStateEvent("popstate"));
  if (changedPage) window.scrollTo({ top: 0, behavior: "instant" });
}

export function useRoute(): string {
  const read = () => location.pathname + location.search;
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return route;
}

let browserSession: string | null = null;
/** One id per browser tab (sessionStorage), created on first use rather than at import. */
export function getBrowserSession(): string {
  if (browserSession) return browserSession;
  const key = "kiwi-lab-session";
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(key);
  } catch {
    stored = null; // storage unavailable (private mode / tests): fall back to an in-memory id below
  }
  if (stored) {
    browserSession = stored;
    return stored;
  }
  const id = `session-${crypto.randomUUID()}`;
  try {
    sessionStorage.setItem(key, id);
  } catch {
    // WHY: the id still works for this page lifetime; persistence across reloads is best effort.
  }
  browserSession = id;
  return id;
}

export const threadFor = (scope: string): string => {
  const readable = `thread-${scope}`.replace(/[^A-Za-z0-9_.:@-]/g, "-");
  if (readable.length <= 100) return readable;
  let hash = 2166136261;
  for (const character of scope) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${readable.slice(0, 90)}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

/**
 * Match a route pattern against a pathname.
 * `:name` segments capture one URL-decoded segment; a trailing `*` matches any remainder (captured as `*`).
 * Returns the params, or null when the pattern does not match (also for malformed percent-encoding).
 */
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const strip = (value: string) => (value.length > 1 ? value.replace(/\/+$/, "") : value);
  const patternParts = strip(pattern).split("/");
  const pathParts = strip(pathname).split("/");
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    if (expected === "*") {
      params["*"] = pathParts.slice(i).join("/");
      return params;
    }
    const actual = pathParts[i];
    if (actual === undefined) return null;
    if (expected.startsWith(":")) {
      if (!actual) return null;
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return null;
      }
    } else if (expected !== actual) return null;
  }
  return pathParts.length === patternParts.length ? params : null;
}
