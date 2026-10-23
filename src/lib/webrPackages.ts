/*
 * R packages verified installable in webR 0.6.0 for this course (§12.3). Mirrors server/webr_packages.py;
 * `duke`, `ldatuning` and `rsvg` are excluded. Frozen after FOUNDATION.
 */
export const WEBR_PACKAGE_ALLOWLIST: readonly string[] = [
  "DiagrammeR", "DiagrammeRsvg", "RColorBrewer", "dplyr", "ggplot2", "ggraph", "ggwordcloud", "httpuv", "manynet",
  "nycflights13", "palmerpenguins", "quanteda", "quanteda.textplots", "quanteda.textstats", "reshape2", "skimr", "sotu",
  "stm", "stringr", "taylor", "textstem", "tidygraph", "tidyr", "tidytext", "tidyverse", "topicmodels", "tuber", "usethis",
  "visNetwork", "vosonSML", "word2vec",
];

const ALLOWED = new Set(WEBR_PACKAGE_ALLOWLIST);
/** R package names are case-sensitive, so the check is exact. */
export function isAllowedWebrPackage(name: string): boolean {
  return ALLOWED.has(name.trim());
}
