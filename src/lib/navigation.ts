import { useEffect, useState } from "react";

export function navigate(path: string, replace = false) {
  if (path === location.pathname + location.search) return;
  const changedPage =
    new URL(path, location.origin).pathname !== location.pathname;
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  if (changedPage) window.scrollTo({ top: 0, behavior: "instant" });
}
export function useRoute() {
  const read = () => location.pathname + location.search;
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return route;
}
export const browserSession = (() => {
  const key = "kiwi-lab-session";
  const stored = sessionStorage.getItem(key);
  if (stored) return stored;
  const id = `session-${crypto.randomUUID()}`;
  sessionStorage.setItem(key, id);
  return id;
})();
export const threadFor = (scope: string) => {
  const readable = `thread-${scope}`.replace(/[^A-Za-z0-9_.:@-]/g, "-");
  if (readable.length <= 100) return readable;
  let hash = 2166136261;
  for (const character of scope)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${readable.slice(0, 90)}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};
