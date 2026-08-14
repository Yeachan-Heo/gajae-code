import json
from pathlib import Path

import pytest

from gjc_sdk.discovery import Endpoint, EndpointSelectionError, classify_endpoint, read_session_endpoint, select_live_endpoint


def record(tmp_path: Path, session_id: str, value: dict[str, object]) -> Path:
    path = tmp_path / ".gjc" / "state" / "sdk" / f"{session_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))
    return path


def test_tombstone_allows_empty_token(tmp_path: Path) -> None:
    record(tmp_path, "old", {"version": 1, "url": "ws://127.0.0.1", "pid": 10, "stale": True, "token": ""})
    endpoint = read_session_endpoint(tmp_path, "old")
    assert endpoint is not None
    assert endpoint.token == ""
    assert endpoint.stale is True


def test_live_empty_token_is_warning_not_endpoint(tmp_path: Path) -> None:
    record(tmp_path, "live", {"version": 1, "url": "ws://127.0.0.1", "token": ""})
    assert read_session_endpoint(tmp_path, "live") is None


def test_pid_must_be_positive_integer(tmp_path: Path) -> None:
    for session_id, pid in [("zero", 0), ("negative", -1), ("float", 1.5), ("boolean", True)]:
        record(tmp_path, session_id, {"url": "ws://127.0.0.1", "token": "secret", "pid": pid})
        endpoint = read_session_endpoint(tmp_path, session_id)
        assert endpoint is not None
        assert endpoint.pid is None
        assert classify_endpoint(endpoint) == "unknown"


def test_selection_fails_closed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def endpoint(session_id: str, pid: int | None, stale: bool = False) -> Endpoint:
        return Endpoint(session_id, "ws://endpoint", "token", pid, stale, tmp_path / session_id)

    live = endpoint("live", 1)
    stale = endpoint("stale", 2, True)
    dead = endpoint("dead", 3)
    unknown = endpoint("unknown", None)

    def fake_kill(pid: int, signal: int) -> None:
        assert signal == 0
        if pid == 3:
            raise ProcessLookupError

    monkeypatch.setattr("gjc_sdk.discovery.os.kill", fake_kill)
    assert select_live_endpoint([live]) == live
    assert select_live_endpoint([live, stale]) == live
    with pytest.raises(EndpointSelectionError, match="multiple_live_endpoints"):
        select_live_endpoint([live, endpoint("other", 4)])
    with pytest.raises(EndpointSelectionError, match="no_live_endpoint"):
        select_live_endpoint([stale, dead, unknown])
    for selected, code in [(stale, "endpoint_stale"), (dead, "endpoint_dead"), (unknown, "endpoint_unknown")]:
        with pytest.raises(EndpointSelectionError, match=code):
            select_live_endpoint([selected], selected.session_id)
    with pytest.raises(EndpointSelectionError, match="not_found"):
        select_live_endpoint([live], "missing")


def test_endpoint_repr_hides_token(tmp_path: Path) -> None:
    endpoint = Endpoint("session", "ws://endpoint", "secret-token", 1, False, tmp_path / "record")
    assert "secret-token" not in repr(endpoint)


def test_rejects_unsupported_endpoint_scheme(tmp_path: Path) -> None:
    record(tmp_path, "bad", {"url": "http://127.0.0.1", "token": "secret", "pid": 1})
    with pytest.warns(UserWarning, match="unsupported URL scheme"):
        assert read_session_endpoint(tmp_path, "bad") is None


def test_refuses_symlinked_discovery_directory(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    directory = tmp_path / ".gjc" / "state" / "sdk"
    directory.parent.mkdir(parents=True)
    directory.symlink_to(target, target_is_directory=True)
    with pytest.warns(UserWarning, match="symlinked SDK discovery directory"):
        assert read_session_endpoint(tmp_path, "session") is None


def test_refuses_symlinked_discovery_record(tmp_path: Path) -> None:
    target = tmp_path / "target.json"
    target.write_text('{"url":"ws://127.0.0.1","token":"secret"}')
    directory = tmp_path / ".gjc" / "state" / "sdk"
    directory.mkdir(parents=True)
    (directory / "session.json").symlink_to(target)
    with pytest.warns(UserWarning, match="symlinked SDK discovery record"):
        assert read_session_endpoint(tmp_path, "session") is None


def test_stale_token_is_ignored_with_warning(tmp_path: Path) -> None:
    record(tmp_path, "old", {"url": "ws://127.0.0.1", "token": "secret", "stale": True})
    with pytest.warns(UserWarning, match="stale discovery record contains a token"):
        endpoint = read_session_endpoint(tmp_path, "old")
    assert endpoint is not None
    assert endpoint.token == ""
