"""Additive DDL owned by ASSESS (spec §4.1). Created empty by FOUNDATION.

Each entry is `("0.6.0-assess-NNN-<name>", [sql, ...])`. Allowed statements only:
`CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`, `ALTER TABLE <t> ADD COLUMN <c> <decl>`
(the runner skips an ALTER when the column exists). No backfills, DROP or triggers
(`test_core.test_ws_migrations_additive`). Anything non-additive is a change request.
"""

from __future__ import annotations

# CR-A1 (applied by INTEGRATION once FOUNDATION-10 counted workstream versions): performance-only indexes; behavior is
# unchanged without them.
OPS: list[tuple[str, list[str]]] = [
    ("0.6.0-assess-001-indexes", [
        "CREATE INDEX IF NOT EXISTS idx_drafts_assignment ON answer_drafts(class_id, assignment_id, student_id)",
        "CREATE INDEX IF NOT EXISTS idx_assignments_starter ON assignments(class_id, starter_key) WHERE starter_key IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_assignments_revision ON assignments(class_id, revision_of) WHERE revision_of IS NOT NULL",
    ]),
]
