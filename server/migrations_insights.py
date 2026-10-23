"""Additive DDL owned by INSIGHTS (spec §4.1). Created empty by FOUNDATION.

Each entry is `("0.6.0-insights-NNN-<name>", [sql, ...])`. Allowed statements only:
`CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`, `ALTER TABLE <t> ADD COLUMN <c> <decl>`
(the runner skips an ALTER when the column exists). No backfills, DROP or triggers
(`test_core.test_ws_migrations_additive`). Anything non-additive is a change request.
"""

from __future__ import annotations

OPS: list[tuple[str, list[str]]] = []
