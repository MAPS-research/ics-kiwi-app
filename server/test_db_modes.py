"""A database the API creates holds student data, so it is owner-only from the start (final runbook check, 2026-10-23)."""

import os
import stat
import tempfile
import unittest
from pathlib import Path

from server import db


def mode(path: Path) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


class NewDatabaseModesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_a_new_directory_and_database_are_owner_only(self):
        target = self.root / "data" / "kiwi-lab.sqlite3"
        with db.connection(target) as conn:
            conn.execute("CREATE TABLE t (x INTEGER)")
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("INSERT INTO t VALUES (1)")
        self.assertEqual(mode(target.parent), 0o700)
        self.assertEqual(mode(target), 0o600)
        for side in ("-wal", "-shm"):  # SQLite gives side files the database file's mode
            side_file = target.with_name(target.name + side)
            if side_file.exists():
                self.assertEqual(mode(side_file) & 0o077, 0, side)

    def test_existing_directories_and_files_keep_their_modes(self):
        existing_dir = self.root / "shared"
        existing_dir.mkdir()
        os.chmod(existing_dir, 0o755)
        existing_db = existing_dir / "old.sqlite3"
        existing_db.touch()
        os.chmod(existing_db, 0o644)
        with db.connection(existing_db) as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS t (x INTEGER)")
        self.assertEqual(mode(existing_dir), 0o755)   # a custom KIWI_DB_PATH parent is the operator's choice
        self.assertEqual(mode(existing_db), 0o644)    # an existing file is not changed silently

    def test_a_new_database_in_an_existing_directory_is_owner_only(self):
        target = self.root / "fresh.sqlite3"
        with db.connection(target) as conn:
            conn.execute("CREATE TABLE t (x INTEGER)")
        self.assertEqual(mode(target), 0o600)


if __name__ == "__main__":
    unittest.main()
