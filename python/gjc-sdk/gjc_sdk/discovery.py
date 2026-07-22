from __future__ import annotations

import json
import os
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Endpoint:
    session_id: str
    url: str
    token: str = field(repr=False)
    pid: int | None = None
    stale: bool = False
    path: Path = Path()


class DiscoveryError(Exception):
    pass


class DiscoveryWarning(UserWarning):
    pass


class EndpointSelectionError(DiscoveryError):
    def __init__(self, code: Literal["endpoint_stale", "endpoint_dead", "endpoint_unknown", "no_live_endpoint", "multiple_live_endpoints", "not_found"]) -> None:
        self.code = code
        super().__init__(code)


def _warn(message: str) -> None:
    warnings.warn(message, DiscoveryWarning, stacklevel=3)


def _parse_endpoint(path: Path, session_id: str, value: object) -> Endpoint | None:
    if not isinstance(value, dict):
        raise DiscoveryError("invalid discovery record")
    version = value.get("version")
    if isinstance(version, (int, float)) and not isinstance(version, bool) and version > 1:
        raise DiscoveryError("unsupported discovery version")
    url = value.get("url")
    if not isinstance(url, str) or not url:
        raise DiscoveryError("discovery record has no url")
    if urlsplit(url).scheme not in {"ws", "wss"}:
        _warn("discovery record has an unsupported URL scheme")
        return None
    stale = value.get("stale") is True
    raw_pid = value.get("pid")
    pid = raw_pid if isinstance(raw_pid, int) and not isinstance(raw_pid, bool) and raw_pid > 0 else None
    token = value.get("token")
    if not isinstance(token, str) or not token:
        if stale:
            token = ""
        else:
            return None
    elif stale:
        _warn("stale discovery record contains a token; ignoring it")
        token = ""
    record_session_id = value.get("sessionId")
    return Endpoint(record_session_id if isinstance(record_session_id, str) and record_session_id else session_id, url, token, pid, stale, path)


def read_session_endpoint(repo: str | Path, session_id: str) -> Endpoint | None:
    directory = Path(repo) / ".gjc" / "state" / "sdk"
    path = directory / f"{session_id}.json"
    if directory.is_symlink():
        _warn("refusing symlinked SDK discovery directory")
        return None
    if path.is_symlink():
        _warn("refusing symlinked SDK discovery record")
        return None
    try:
        value: Any = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        raise DiscoveryError("unable to read discovery record") from exc
    return _parse_endpoint(path, session_id, value)


def list_session_endpoints(repo: str | Path) -> list[Endpoint]:
    directory = Path(repo) / ".gjc" / "state" / "sdk"
    if directory.is_symlink():
        _warn("refusing symlinked SDK discovery directory")
        return []
    try:
        paths = sorted(directory.glob("*.json"))
    except OSError as exc:
        raise DiscoveryError("unable to list discovery records") from exc
    endpoints: list[Endpoint] = []
    for path in paths:
        if path.is_symlink():
            _warn("refusing symlinked SDK discovery record")
            continue
        endpoint = read_session_endpoint(repo, path.stem)
        if endpoint is not None:
            endpoints.append(endpoint)
    return endpoints


def classify_endpoint(endpoint: Endpoint) -> Literal["live", "stale", "dead", "unknown"]:
    if endpoint.stale:
        return "stale"
    if endpoint.pid is None:
        return "unknown"
    try:
        os.kill(endpoint.pid, 0)
    except ProcessLookupError:
        return "dead"
    except PermissionError:
        return "live"
    except OSError:
        return "unknown"
    return "live"


def select_live_endpoint(endpoints: list[Endpoint], explicit_session_id: str | None = None) -> Endpoint:
    if explicit_session_id is not None:
        endpoint = next((item for item in endpoints if item.session_id == explicit_session_id), None)
        if endpoint is None:
            raise EndpointSelectionError("not_found")
        state = classify_endpoint(endpoint)
        if state != "live":
            if state == "stale":
                raise EndpointSelectionError("endpoint_stale")
            if state == "dead":
                raise EndpointSelectionError("endpoint_dead")
            raise EndpointSelectionError("endpoint_unknown")
        return endpoint
    live = [endpoint for endpoint in endpoints if classify_endpoint(endpoint) == "live"]
    if len(live) == 1:
        return live[0]
    raise EndpointSelectionError("no_live_endpoint" if not live else "multiple_live_endpoints")
