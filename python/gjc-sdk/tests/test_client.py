from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

import pytest

from gjc_sdk import SdkClient
from gjc_sdk.frames import ActionNeeded, ControlResponse, QueryResponse, parse_frame
from gjc_sdk.discovery import Endpoint, EndpointSelectionError


class FakeTransport:
    def __init__(self, received: list[str]) -> None:
        self.received = asyncio.Queue[str]()
        for frame in received:
            self.received.put_nowait(frame)
        self.sent: list[dict[str, Any]] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))

    async def receive_text(self) -> str:
        return await self.received.get()

    async def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_control_correlates_out_of_order_and_preserves_actions() -> None:
    transport = FakeTransport(
        [
            '{"type":"action_needed","id":"a1","kind":"ask","sessionId":"s1"}',
            '{"type":"control_response","id":"second","ok":false,"error":{"code":"conflict"}}',
            '{"type":"control_response","id":"first","ok":true,"result":{"accepted":true}}',
        ]
    )
    client = SdkClient(transport, "secret")

    first = asyncio.create_task(client.control("first.operation", {}, id="first"))
    await asyncio.sleep(0)
    second = asyncio.create_task(client.control("second.operation", {}, id="second"))

    assert await first == ControlResponse("first", True, {"accepted": True})
    assert await second == ControlResponse("second", False, error={"code": "conflict"})
    assert await client.recv() == ActionNeeded("a1", "ask", "s1")


@pytest.mark.asyncio
async def test_query_returns_paginated_response() -> None:
    transport = FakeTransport(
        [
            '{"type":"query_response","id":"q1","ok":true,"page":{"items":[{"id":"one"}],"complete":false,"continuationCursor":"next","revision":"r1"}}'
        ]
    )
    client = SdkClient(transport, "secret")

    response = await client.query("todo.list", {}, cursor="previous", id="q1")

    assert isinstance(response, QueryResponse)
    assert response.page is not None
    assert response.page.items == [{"id": "one"}]
    assert response.page.continuation_cursor == "next"
    assert transport.sent == [
        {"type": "query_request", "id": "q1", "query": "todo.list", "input": {}, "cursor": "previous"}
    ]

@pytest.mark.parametrize(
    ("endpoint", "code"),
    [
        (Endpoint("stale", "ws://endpoint", "secret", 1, True, Path("stale")), "endpoint_stale"),
        (Endpoint("dead", "ws://endpoint", "secret", 1, False, Path("dead")), "endpoint_dead"),
        (Endpoint("unknown", "ws://endpoint", "secret", None, False, Path("unknown")), "endpoint_unknown"),
    ],
)
def test_explicit_session_selection_fails_closed(
    monkeypatch: pytest.MonkeyPatch, endpoint: Endpoint, code: str
) -> None:
    monkeypatch.setattr("gjc_sdk.client.list_session_endpoints", lambda _repo: [endpoint])
    monkeypatch.setattr("gjc_sdk.discovery.os.kill", lambda _pid, _signal: (_ for _ in ()).throw(ProcessLookupError()))
    with pytest.raises(EndpointSelectionError, match=code):
        SdkClient._endpoint(Path("repo"), endpoint.session_id)


ROOT = Path(os.environ.get("GJC_REPO_ROOT", Path(__file__).resolve().parents[3])).resolve()
FIXTURE = ROOT / "packages" / "coding-agent" / "test" / "helpers" / "sdk-python-fixture.ts"
CLI = ROOT / "packages" / "coding-agent" / "src" / "cli.ts"
BUN = shutil.which("bun")
NATIVE = ROOT / "packages" / "natives" / "native"
REAL_SESSION_ENABLED = os.environ.get("GJC_REAL_SESSION_TESTS") == "1" and BUN is not None and NATIVE.exists()


def test_non_canonical_vector_is_parse_tolerant() -> None:
    vector = json.loads(
        (ROOT / "packages" / "coding-agent" / "test" / "fixtures" / "sdk-frame-vectors" / "non-canonical-action-needed.json").read_text()
    )
    frame = parse_frame(vector["rawFrame"])
    assert isinstance(frame, ActionNeeded)
    assert frame.id == "ask-1"
    assert frame.options == ["café", "☃"]


async def _read_event(process: asyncio.subprocess.Process, timeout: float = 10) -> dict[str, Any]:
    assert process.stdout is not None
    raw = await asyncio.wait_for(process.stdout.readline(), timeout)
    if not raw:
        stderr = await process.stderr.read() if process.stderr is not None else b""
        raise RuntimeError(f"fixture exited while waiting for an event: {stderr.decode()}")
    return json.loads(raw)


async def _start_fixture() -> tuple[asyncio.subprocess.Process, dict[str, str]]:
    assert BUN is not None
    process = await asyncio.create_subprocess_exec(
        BUN,
        str(FIXTURE),
        cwd=ROOT,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    metadata = await _read_event(process)
    assert set(("sessionId", "url", "token", "repo")) <= set(metadata)
    return process, metadata


async def _command(process: asyncio.subprocess.Process, command: dict[str, Any]) -> dict[str, Any]:
    assert process.stdin is not None
    process.stdin.write(json.dumps(command).encode() + b"\n")
    await process.stdin.drain()
    return await _read_event(process)


async def _stop_fixture(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None and process.stdin is not None:
        process.stdin.write(b'{"cmd":"stop"}\n')
        await process.stdin.drain()
        process.stdin.close()
    await asyncio.wait_for(process.wait(), 15)
    assert process.returncode == 0


@pytest.mark.asyncio
async def test_fixture_boots_and_registers_ask_when_available() -> None:
    if BUN is None or not NATIVE.exists():
        pytest.skip("bun or native addon unavailable")
    process, _metadata = await _start_fixture()
    try:
        registered = await _command(process, {"cmd": "trigger_ask", "question": "Ready?", "options": ["yes"]})
        assert registered == {"event": "registered", "kind": "ask"}
    finally:
        await _stop_fixture(process)


async def _recv_action(client: SdkClient, *, gate: bool) -> ActionNeeded:
    for _ in range(20):
        frame = await asyncio.wait_for(client.recv(), 10)
        if isinstance(frame, ActionNeeded) and (frame.workflow_gate_id is not None) == gate:
            return frame
    raise AssertionError("transport did not deliver the expected action_needed frame")


async def _exercise(client: SdkClient, fixture: asyncio.subprocess.Process, *, gate: bool = False) -> None:
    command: dict[str, Any]
    if gate:
        command = {
            "cmd": "trigger_gate",
            "stage": "deep-interview",
            "kind": "question",
            "schema": {"type": "string", "enum": ["continue"]},
        }
    else:
        command = {"cmd": "trigger_ask", "question": "Continue?", "options": ["continue", "stop"]}
    registered = await _command(fixture, command)
    assert registered == {"event": "registered", "kind": "workflow_gate" if gate else "ask"}
    frame = await _recv_action(client, gate=gate)
    if gate:
        assert frame.workflow_gate_id is not None
        await client.answer_gate(frame.workflow_gate_id, "continue", expected_session_id=frame.session_id)
    else:
        assert frame.kind == "ask"
        await client.send_reply(frame.id, 0)
    resolved = await _read_event(fixture)
    assert resolved["event"] == "resolved"
    assert resolved["kind"] == ("workflow_gate" if gate else "ask")


@pytest.mark.asyncio
@pytest.mark.skipif(not REAL_SESSION_ENABLED, reason="requires GJC_REAL_SESSION_TESTS=1, bun, and native addon")
async def test_real_session_all_transports_cleanup() -> None:
    process, metadata = await _start_fixture()
    socket_dir = Path(tempfile.mkdtemp(prefix="gjc-sdk-", dir="/tmp"))
    os.chmod(socket_dir, 0o700)
    socket_path = socket_dir / "sdk.sock"
    socket_server: asyncio.subprocess.Process | None = None
    socket_stderr: list[str] = []
    socket_stderr_task: asyncio.Task[None] | None = None
    clients: list[SdkClient] = []
    try:
        ws = await SdkClient.connect_ws(metadata["repo"], metadata["sessionId"])
        clients.append(ws)
        await _exercise(ws, process, gate=True)
        await _exercise(ws, process)
        await ws.close()
        clients.remove(ws)
        await _stop_fixture(process)
        process, metadata = await _start_fixture()

        assert BUN is not None
        socket_server = await asyncio.create_subprocess_exec(
            BUN, str(CLI), "sdk", "serve", "--socket", str(socket_path), "--session", metadata["sessionId"],
            cwd=metadata["repo"], stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        assert socket_server.stderr is not None

        async def capture_socket_stderr() -> None:
            while line := await socket_server.stderr.readline():
                socket_stderr.append(line.decode(errors="replace").rstrip())

        socket_stderr_task = asyncio.create_task(capture_socket_stderr())
        for _ in range(100):
            if socket_path.exists():
                break
            await asyncio.sleep(0.05)
        if not socket_path.exists():
            await asyncio.wait_for(socket_server.wait(), 10)
            assert socket_server.stderr is not None
            raise AssertionError(f"socket relay failed: {await socket_server.stderr.read()!r}")
        socket = await SdkClient.connect_socket(str(socket_path), repo=metadata["repo"], session_id=metadata["sessionId"])
        clients.append(socket)
        try:
            await _exercise(socket, process, gate=True)
            await _exercise(socket, process)
        except BaseException as error:
            raise AssertionError(f"socket relay exercise failed; stderr: {socket_stderr}") from error
        await socket.close()
        clients.remove(socket)
        if socket_server.returncode is None:
            socket_server.terminate()
            await asyncio.wait_for(socket_server.wait(), 10)
        await socket_stderr_task
        socket_stderr_task = None
        assert not socket_path.exists()
        await _stop_fixture(process)
        process, metadata = await _start_fixture()

        previous_cwd = Path.cwd()
        os.chdir(metadata["repo"])
        try:
            stdio = await SdkClient.connect_stdio(
                repo=metadata["repo"], session_id=metadata["sessionId"],
                argv=[BUN, str(CLI), "sdk", "serve", "--stdio", "--session", metadata["sessionId"]],
            )
        finally:
            os.chdir(previous_cwd)
        clients.append(stdio)
        await _exercise(stdio, process, gate=True)
        await _exercise(stdio, process)
    finally:
        for client in reversed(clients):
            await client.close()
        if socket_server is not None and socket_server.returncode is None:
            socket_server.terminate()
            await asyncio.wait_for(socket_server.wait(), 10)
        if socket_stderr_task is not None:
            await socket_stderr_task
        await _stop_fixture(process)
    assert not socket_path.exists()
    socket_dir.rmdir()
    assert all(getattr(client._transport, "_process", None) is None or client._transport._process.returncode is not None for client in clients)
