from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from gjc_rpc import SessionHandle, list_sessions


def _write(directory: Path, name: str, payload: dict[str, object]) -> None:
    (directory / f"{name}.json").write_text(json.dumps(payload), encoding="utf-8")


def _record(session_id: str, pid: int, started_at: str, **extra: object) -> dict[str, object]:
    return {
        "sessionId": session_id,
        "pid": pid,
        "transport": "stdio",
        "cwd": "/tmp",
        "startedAt": started_at,
        **extra,
    }


class RegistryTests(unittest.TestCase):
    def test_lists_live_and_reaps_dead(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            _write(directory, "alive", _record("alive", os.getpid(), "2026-01-01T00:00:00Z", model="m"))
            _write(directory, "dead", _record("dead", 2**30, "2026-01-02T00:00:00Z"))
            sessions = list_sessions(sessions_dir=directory)
            self.assertEqual([s.session_id for s in sessions], ["alive"])
            self.assertIsInstance(sessions[0], SessionHandle)
            self.assertEqual(sessions[0].model, "m")
            self.assertFalse((directory / "dead.json").exists())

    def test_reaps_unparseable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "junk.json").write_text("{not valid json", encoding="utf-8")
            _write(directory, "ok", _record("ok", os.getpid(), "2026-01-01T00:00:00Z"))
            sessions = list_sessions(sessions_dir=directory)
            self.assertEqual([s.session_id for s in sessions], ["ok"])
            self.assertFalse((directory / "junk.json").exists())

    def test_sorts_by_started_at(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            _write(directory, "b", _record("second", os.getpid(), "2026-02-01T00:00:00Z"))
            _write(directory, "a", _record("first", os.getpid(), "2026-01-01T00:00:00Z"))
            sessions = list_sessions(sessions_dir=directory)
            self.assertEqual([s.session_id for s in sessions], ["first", "second"])

    def test_missing_dir_is_empty(self) -> None:
        self.assertEqual(list_sessions(sessions_dir="/no/such/registry/dir"), ())

    def test_env_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous = os.environ.get("GJC_CODING_AGENT_DIR")
            os.environ["GJC_CODING_AGENT_DIR"] = tmp
            try:
                registry = Path(tmp) / "rpc-sessions"
                registry.mkdir(parents=True)
                _write(registry, "x", _record("x", os.getpid(), "2026-01-01T00:00:00Z"))
                self.assertEqual([s.session_id for s in list_sessions()], ["x"])
            finally:
                if previous is None:
                    os.environ.pop("GJC_CODING_AGENT_DIR", None)
                else:
                    os.environ["GJC_CODING_AGENT_DIR"] = previous


if __name__ == "__main__":
    unittest.main()
