"""Additive DDL owned by TELEMETRY (spec §4.1). Created empty by FOUNDATION.

Each entry is `("0.6.0-telemetry-NNN-<name>", [sql, ...])`. Allowed statements only:
`CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`, `ALTER TABLE <t> ADD COLUMN <c> <decl>`
(the runner skips an ALTER when the column exists). No backfills, DROP or triggers
(`test_core.test_ws_migrations_additive`). Anything non-additive is a change request.
"""

from __future__ import annotations

# CR-T5 (applied by INTEGRATION after CR-T1): duplicate receipts are counted per minute in event_ingest_stats (they are
# not rejections), and the Kiwi chat mode from the bridge metadata pass is persisted in kiwi_sync so it survives a
# restart (it was a per-process value).
OPS: list[tuple[str, list[str]]] = [
    ("0.6.0-telemetry-001-health", [
        "CREATE TABLE IF NOT EXISTS event_ingest_stats (class_id TEXT NOT NULL, minute TEXT NOT NULL, kind TEXT NOT NULL, "
        "count INTEGER NOT NULL, PRIMARY KEY (class_id, minute, kind))",
        "ALTER TABLE kiwi_sync ADD COLUMN native_tutoring_mode TEXT",
        "ALTER TABLE kiwi_sync ADD COLUMN native_tutoring_mode_source TEXT",
    ]),
]
