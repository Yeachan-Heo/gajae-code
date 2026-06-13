"""Discovery of running gjc RPC sessions (issue 10).

Each live `gjc --mode rpc` server writes a record under
``<agent-dir>/rpc-sessions/<sessionId>.json``. ``list_sessions`` reads that
directory and reaps records whose owning process is gone, so a crashed server
never leaves a permanent phantom entry.

Directory resolution mirrors the TS side: ``GJC_CODING_AGENT_DIR`` if set, else
``~/.gjc/agent``, plus ``/rpc-sessions``. Custom XDG layouts can pass
``sessions_dir`` explicitly.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True, frozen=True)
class SessionHandle:
    session_id: str
    pid: int
    transport: str
    cwd: str
    started_at: str
    model: str | None = None
    endpoint: str | None = None


def _resolve_sessions_dir(sessions_dir: str | Path | None) -> Path:
    if sessions_dir is not None:
        return Path(sessions_dir)
    agent_dir = os.environ.get("GJC_CODING_AGENT_DIR")
    base = Path(agent_dir) if agent_dir else Path.home() / ".gjc" / "agent"
    return base / "rpc-sessions"


def _process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # alive but owned by another user
    except OSError:
        return False
    return True


def _parse_handle(payload: object) -> SessionHandle | None:
    if not isinstance(payload, dict):
        return None
    session_id = payload.get("sessionId")
    pid = payload.get("pid")
    if not isinstance(session_id, str) or not isinstance(pid, int) or isinstance(pid, bool):
        return None
    model = payload.get("model")
    endpoint = payload.get("endpoint")
    return SessionHandle(
        session_id=session_id,
        pid=pid,
        transport=str(payload.get("transport", "stdio")),
        cwd=str(payload.get("cwd", "")),
        started_at=str(payload.get("startedAt", "")),
        model=model if isinstance(model, str) else None,
        endpoint=endpoint if isinstance(endpoint, str) else None,
    )


def _reap(entry: Path) -> None:
    try:
        entry.unlink()
    except OSError:
        pass


def list_sessions(sessions_dir: str | Path | None = None) -> tuple[SessionHandle, ...]:
    """List live gjc RPC sessions, reaping records whose process is gone (issue 10)."""
    directory = _resolve_sessions_dir(sessions_dir)
    try:
        entries = sorted(directory.glob("*.json"))
    except OSError:
        return ()
    handles: list[SessionHandle] = []
    for entry in entries:
        try:
            raw = entry.read_text(encoding="utf-8")
        except OSError:
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            _reap(entry)
            continue
        handle = _parse_handle(payload)
        if handle is None or not _process_alive(handle.pid):
            _reap(entry)
            continue
        handles.append(handle)
    handles.sort(key=lambda handle: handle.started_at)
    return tuple(handles)
