from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any


from gjc_sdk.discovery import read_session_endpoint
from gjc_sdk.frames import GenericFrame, Reply, parse_frame

ROOT = Path(__file__).resolve().parents[3]
VECTORS = ROOT / "packages" / "coding-agent" / "test" / "fixtures" / "sdk-frame-vectors"
NATIVE = ROOT / "packages" / "natives" / "native"


def load_vectors() -> list[dict[str, Any]]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(VECTORS.glob("*.json"))]


def expand(vector: dict[str, Any]) -> str:
    generate = vector["generate"]
    assert isinstance(vector["prefix"], str) and isinstance(vector["suffix"], str)
    assert isinstance(generate, dict)
    character, count = generate["character"], generate["count"]
    assert isinstance(character, str) and len(character) == 1
    assert isinstance(count, int) and count >= 0
    return vector["prefix"] + character * count + vector["suffix"]


def test_every_vector_has_v1_schema_and_executable_shape() -> None:
    vectors = load_vectors()
    assert vectors
    for vector in vectors:
        assert vector["$schema"] == "sdk-frame-vectors/v1"
        assert isinstance(vector.get("name"), str)
        assert vector.get("kind") in {"frame", "record", "generator"}
        assert isinstance(vector.get("expectations"), dict)
        if vector["kind"] == "frame":
            text = vector.get("rawFrame") or json.dumps(vector["frame"])
            assert isinstance(text, str)
            assert isinstance(json.loads(text), dict)
            assert parse_frame(text)
            assert "rawFrame" in vector or isinstance(vector.get("frame"), dict)
        elif vector["kind"] == "record":
            for frame in vector.get("frames", []):
                assert isinstance(frame, dict) and isinstance(frame.get("type"), str)
                assert parse_frame(json.dumps(frame))
            if "lines" in vector:
                lines = vector["lines"]
                assert lines["authSuccess"] == "gjc-sdk-transport/1 token=discovery-token-required\n"
                assert json.loads(lines["authFailure"])["type"] == "transport_error"
            if "staleDiscovery" in vector:
                assert vector["staleDiscovery"]["stale"] is True
            assert any(key in vector for key in ("frames", "lines", "staleDiscovery"))
        else:
            text = expand(vector)
            assert len(text.encode()) >= vector["expectations"]["minimumBytes"]
            assert isinstance(json.loads(text), dict)
            assert parse_frame(text)


def test_vector_semantics_and_tolerance(tmp_path: Path) -> None:
    for vector in load_vectors():
        expectations = vector["expectations"]
        frames = vector.get("frames", [])
        if expectations.get("correlatesBy") == "id":
            assert frames[0]["id"] == frames[1]["id"]
        if "lifecycle" in expectations:
            assert [frame["type"] for frame in frames] == expectations["lifecycle"]
        if expectations.get("replyTokenRequired"):
            reply = parse_frame(json.dumps(next(frame for frame in frames if frame["type"] == "reply")))
            assert isinstance(reply, Reply) and reply.token
        if "rawFrame" in vector:
            assert isinstance(parse_frame(vector["rawFrame"]), GenericFrame) is False
        if "staleDiscovery" in vector:
            state = tmp_path / ".gjc" / "state" / "sdk"
            state.mkdir(parents=True)
            (state / "stale.json").write_text(json.dumps(vector["staleDiscovery"]), encoding="utf-8")
            endpoint = read_session_endpoint(tmp_path, "stale")
            assert endpoint is not None and endpoint.stale and endpoint.token == "" and endpoint.pid is None


def test_real_session_enabled_guard() -> None:
    if os.environ.get("GJC_REAL_SESSION_TESTS") != "1":
        return
    assert shutil.which("bun"), "GJC_REAL_SESSION_TESTS=1 requires bun on PATH"
    has_native = NATIVE.exists() and (any(NATIVE.glob("*.node")) or (NATIVE / "embedded-addon.js").exists())
    assert has_native, "GJC_REAL_SESSION_TESTS=1 requires a downloaded or embedded native addon"
