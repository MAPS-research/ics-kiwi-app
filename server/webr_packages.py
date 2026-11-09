"""R packages verified installable in webR 0.6.0 for this course (spec §12.3; FOUNDATION, frozen).

Mirrored by ``src/lib/webrPackages.ts``. ``duke``, ``ldatuning`` and ``rsvg`` are excluded.
"""

from __future__ import annotations

WEBR_PACKAGE_ALLOWLIST: tuple[str, ...] = (
    "DiagrammeR",
    "DiagrammeRsvg",
    "RColorBrewer",
    "dplyr",
    "ggplot2",
    "ggraph",
    "ggwordcloud",
    "httpuv",
    "manynet",
    "nycflights13",
    "palmerpenguins",
    "quanteda",
    "quanteda.textplots",
    "quanteda.textstats",
    "reshape2",
    "skimr",
    "sotu",
    "stm",
    "stringr",
    "taylor",
    "textstem",
    "tidygraph",
    "tidyr",
    "tidytext",
    "tidyverse",
    "topicmodels",
    "tuber",
    "usethis",
    "visNetwork",
    "vosonSML",
    "word2vec",
)


def is_allowed(package: object) -> bool:
    return isinstance(package, str) and package in WEBR_PACKAGE_ALLOWLIST
