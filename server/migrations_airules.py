"""Additive DDL owned by AIRULES (spec §4.1). Created empty by FOUNDATION.

Each entry is `("0.6.0-airules-NNN-<name>", [sql, ...])`. Allowed statements only:
`CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`, `ALTER TABLE <t> ADD COLUMN <c> <decl>`
(the runner skips an ALTER when the column exists). No backfills, DROP or triggers
(`test_core.test_ws_migrations_additive`). Anything non-additive is a change request.
"""

from __future__ import annotations

# AIRULES handoff D10 (tried and reverted while FOUNDATION-10 compared against the core list only; re-added by
# INTEGRATION): saved checks are listed per scope, newest first.
OPS: list[tuple[str, list[str]]] = [
    ("0.6.0-airules-001-indexes", [
        "CREATE INDEX IF NOT EXISTS idx_ai_test_samples_scope ON ai_test_samples(class_id, unit_id, group_id, created_at)",
    ]),
]
