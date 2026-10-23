/*
 * Accessible names of rendered markup, for view tests (SB-m06, K-m04). Not a test file: `src/lib/a11y.scan.test.ts` and
 * `src/lib/a11y.views.test.tsx` both import it.
 * The names follow the accessible-name rules for the markup React renders: aria-labelledby, aria-label, <label for>, a
 * wrapping <label> (without the control's own content), the element's text (aria-hidden parts left out), then title.
 */
interface El { tag: string; attrs: Record<string, string>; children: (El | string)[]; parent: El | null }
const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
const decode = (text: string) => text.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_m, code: string) => {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  if (named[code.toLowerCase()]) return named[code.toLowerCase()];
  return String.fromCodePoint(code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10));
});

export function parseMarkup(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [], parent: null };
  let current = root;
  const tokens = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html))) {
    const [, closing, rawTag, rawAttrs, selfClosing, text] = match;
    if (text !== undefined) {
      current.children.push(decode(text));
      continue;
    }
    if (!rawTag) continue;   // a comment
    const tag = rawTag.toLowerCase();
    if (closing) {
      for (let node: El | null = current; node; node = node.parent) if (node.tag === tag) { current = node.parent ?? root; break; }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? "").matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? "");
    const el: El = { tag, attrs, children: [], parent: current };
    current.children.push(el);
    if (!selfClosing && !VOID.has(tag)) current = el;
  }
  return root;
}

const walk = (el: El, visit: (e: El) => void) => {
  visit(el);
  for (const child of el.children) if (typeof child !== "string") walk(child, visit);
};
const FORM = new Set(["input", "textarea", "select"]);
function textOf(el: El, skip?: El): string {
  if (el === skip || el.attrs["aria-hidden"] === "true") return "";
  if (el !== skip && el.parent && el.attrs["aria-label"] && el.tag !== "#root") return el.attrs["aria-label"];
  return el.children.map((c) => (typeof c === "string" ? c : FORM.has(c.tag) ? "" : textOf(c, skip))).join("");
}
function ownText(el: El): string {
  return el.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}
const clean = (text: string) => text.replace(/\s+/g, " ").trim();

export function accessibleNames(html: string): { tag: string; name: string }[] {
  const root = parseMarkup(html);
  const byId = new Map<string, El>();
  walk(root, (e) => { if (e.attrs.id) byId.set(e.attrs.id, e); });
  const out: { tag: string; name: string }[] = [];
  walk(root, (el) => {
    const control = FORM.has(el.tag) || el.tag === "button" || el.tag === "summary" || (el.tag === "a" && "href" in el.attrs);
    if (!control || (el.tag === "input" && el.attrs.type === "hidden")) return;
    let name = "";
    if (el.attrs["aria-labelledby"]) name = el.attrs["aria-labelledby"].split(/\s+/).map((id) => (byId.get(id) ? ownText(byId.get(id)!) : "")).join(" ");
    if (!clean(name) && el.attrs["aria-label"]) name = el.attrs["aria-label"];
    if (!clean(name) && FORM.has(el.tag)) {
      let label: El | undefined;
      walk(root, (e) => { if (e.tag === "label" && el.attrs.id && e.attrs.for === el.attrs.id) label = e; });
      for (let up = el.parent; !label && up; up = up.parent) if (up.tag === "label") label = up;
      if (label) name = textOf(label, el);
    }
    if (!clean(name) && !FORM.has(el.tag)) name = ownText(el);
    if (!clean(name) && el.attrs.title) name = el.attrs.title;
    out.push({ tag: el.tag, name: clean(name) });
  });
  return out;
}

/** Accessible names used by more than one control ("" counts: an unnamed control is a problem of its own). */
export function duplicateNames(html: string): string[] {
  const seen = new Map<string, number>();
  for (const { name } of accessibleNames(html)) seen.set(name.toLowerCase(), (seen.get(name.toLowerCase()) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([name]) => name);
}
