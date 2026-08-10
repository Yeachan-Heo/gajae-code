from __future__ import annotations

import asyncio
import io
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import sys
from typing import Any

import pytest

import gjc_sdk
from gjc_sdk import Endpoint
from gjc_sdk.frames import ControlResponse, QueryResponse

ROOT = Path(__file__).resolve().parents[3]
TEMPLATE = ROOT / "sdk-skills" / "gjc-sdk-author" / "templates" / "direct-sdk.py"
FIXTURE = ROOT / "packages" / "coding-agent" / "test" / "helpers" / "sdk-python-fixture.ts"
BUN = shutil.which("bun")
NATIVE = ROOT / "packages" / "natives" / "native"
REAL_SESSION_ENABLED = os.environ.get("GJC_REAL_SESSION_TESTS") == "1" and BUN is not None and NATIVE.exists()


class FakeClient:
    def __init__(self) -> None:
        self.queries: list[str] = []
        self.controls: list[tuple[str, dict[str, Any]]] = []
        self.closed = False

    async def query(self, query: str, input: dict[str, Any]) -> QueryResponse:
        self.queries.append(query)
        if query == "session.stats":
            return QueryResponse("query", False, error={"code": "unavailable", "message": "failed-must-not-print"})
        return QueryResponse("query", True, result={"query": query, "data": "prefix-must-not-print-suffix"})

    async def control(self, operation: str, input: dict[str, Any]) -> ControlResponse:
        self.controls.append((operation, input))
        return ControlResponse("control", True, result={"accepted": True, "data": "prefix-must-not-print-suffix"})

    async def close(self) -> None:
        self.closed = True


class ChallengeStdin:
    """Answers the approval challenge read from stderr, proving the template
    emits the challenge on stderr and never mixes prose into stdout."""

    def __init__(self, capsys: pytest.CaptureFixture[str], accepted: list[str]) -> None:
        self._capsys = capsys
        self._accepted = accepted

    def readline(self) -> str:
        captured = self._capsys.readouterr()
        match = re.search(r"Approval required: (APPROVE [^\n]+)", captured.err)
        if match is None:
            raise AssertionError("approval challenge was not emitted on stderr")
        self._accepted.append(match.group(1))
        return match.group(1) + "\n"


class FailingStdin:
    def readline(self) -> str:
        pytest.fail("approval prompt must not run")


def configure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, client: FakeClient) -> None:
    directory = tmp_path / ".gjc" / "state" / "sdk"
    directory.mkdir(parents=True)
    record = directory / "session-1.json"
    record.write_text(json.dumps({"url": "ws://127.0.0.1:1", "token": "must-not-print", "pid": 1}), encoding="utf-8")
    endpoint = Endpoint("session-1", "ws://127.0.0.1:1", "must-not-print", 1, False, record)
    monkeypatch.setattr(gjc_sdk, "read_session_endpoint", lambda repo, session_id: endpoint)
    monkeypatch.setattr(gjc_sdk, "select_live_endpoint", lambda endpoints, session_id=None: endpoints[0])

    async def connect_ws(cls: type[gjc_sdk.SdkClient], repo: str, session_id: str | None = None, **kwargs: Any) -> FakeClient:
        return client

    monkeypatch.setattr(gjc_sdk.SdkClient, "connect_ws", classmethod(connect_ws))


def run_template(monkeypatch: pytest.MonkeyPatch, args: list[str]) -> None:
    monkeypatch.setattr(sys, "argv", [str(TEMPLATE), *args])
    runpy.run_path(str(TEMPLATE), run_name="__main__")


def test_python_template_composes_queries_redacts_and_closes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    client = FakeClient()
    configure(monkeypatch, tmp_path, client)
    run_template(monkeypatch, ["--repo", str(tmp_path), "--session-id", "session-1", "--mode", "inspect"])
    captured = capsys.readouterr()
    assert client.queries == [
        "session.metadata",
        "context.get",
        "goal.list/get",
        "todo.list",
        "workflow.gates.list",
        "session.stats",
    ]
    assert '"status": "unavailable"' in captured.out
    assert "must-not-print" not in captured.out + captured.err
    assert client.closed is True


def test_python_template_requires_exact_bound_approval(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    client = FakeClient()
    configure(monkeypatch, tmp_path, client)
    args = [
        "--repo",
        str(tmp_path),
        "--session-id",
        "session-1",
        "--mode",
        "control",
        "--operation",
        "turn.prompt",
        "--input",
        '{"prompt":"hello"}',
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("DENY\n"))
    with pytest.raises(SystemExit) as denied:
        run_template(monkeypatch, args)
    assert denied.value.code == 1
    captured = capsys.readouterr()
    assert client.controls == []
    assert client.closed is False
    assert "must-not-print" not in captured.out + captured.err

    accepted: list[str] = []
    monkeypatch.setattr(sys, "stdin", ChallengeStdin(capsys, accepted))
    run_template(monkeypatch, args)
    captured = capsys.readouterr()
    assert client.controls == [("turn.prompt", {"prompt": "hello"})]
    assert client.closed is True
    assert "must-not-print" not in captured.out + captured.err
    assert len(accepted) == 1

    monkeypatch.setattr(sys, "stdin", io.StringIO(accepted[0] + "\n"))
    with pytest.raises(SystemExit) as replayed:
        run_template(monkeypatch, args)
    assert replayed.value.code == 1
    assert client.controls == [("turn.prompt", {"prompt": "hello"})]


def test_python_template_rejects_mismatched_discovery_identity(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    client = FakeClient()
    configure(monkeypatch, tmp_path, client)
    record = tmp_path / ".gjc" / "state" / "sdk" / "session-1.json"
    mismatched = Endpoint("other-session", "ws://127.0.0.1:1", "must-not-print", 1, False, record)
    monkeypatch.setattr(gjc_sdk, "read_session_endpoint", lambda repo, session_id: mismatched)
    with pytest.raises(SystemExit) as failed:
        run_template(monkeypatch, ["--repo", str(tmp_path), "--session-id", "session-1", "--mode", "inspect"])
    assert failed.value.code == 1
    assert client.queries == []


def test_python_template_rejects_forbidden_operation_before_approval(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    client = FakeClient()
    configure(monkeypatch, tmp_path, client)
    monkeypatch.setattr(sys, "stdin", FailingStdin())
    with pytest.raises(SystemExit) as failed:
        run_template(
            monkeypatch,
            ["--repo", str(tmp_path), "--session-id", "session-1", "--mode", "control", "--operation", "session.delete"],
        )
    assert failed.value.code == 1
    assert client.controls == []


def test_python_template_sanitizes_argument_errors(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as failed:
        run_template(monkeypatch, ["--repo", str(tmp_path), "--token", "must-not-print"])
    assert failed.value.code == 1
    captured = capsys.readouterr()
    assert "must-not-print" not in captured.out + captured.err
    assert "GJC SDK request failed safely." in captured.err


def test_python_template_revalidates_after_approval(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    client = FakeClient()
    configure(monkeypatch, tmp_path, client)
    record = tmp_path / ".gjc" / "state" / "sdk" / "session-1.json"
    original = Endpoint("session-1", "ws://127.0.0.1:1", "must-not-print", 1, False, record)
    replacement = Endpoint("session-1", "ws://127.0.0.1:2", "replacement-token", 1, False, record)
    reads = iter([original, replacement])
    monkeypatch.setattr(gjc_sdk, "read_session_endpoint", lambda repo, session_id: next(reads))

    accepted: list[str] = []
    monkeypatch.setattr(sys, "stdin", ChallengeStdin(capsys, accepted))
    with pytest.raises(SystemExit) as failed:
        run_template(
            monkeypatch,
            [
                "--repo",
                str(tmp_path),
                "--session-id",
                "session-1",
                "--mode",
                "control",
                "--operation",
                "turn.prompt",
                "--input",
                '{"prompt":"hello"}',
            ],
        )
    assert failed.value.code == 1
    assert client.controls == []


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
    assert process.stdout is not None
    raw = await asyncio.wait_for(process.stdout.readline(), 30)
    metadata = json.loads(raw)
    assert set(("sessionId", "url", "token", "repo")) <= set(metadata)
    return process, metadata


async def _stop_fixture(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None and process.stdin is not None:
        process.stdin.write(b'{"cmd":"stop"}\n')
        await process.stdin.drain()
        process.stdin.close()
    await asyncio.wait_for(process.wait(), 30)


@pytest.mark.asyncio
@pytest.mark.skipif(not REAL_SESSION_ENABLED, reason="requires GJC_REAL_SESSION_TESTS=1, bun, and native addon")
async def test_python_template_control_stdout_is_pure_json() -> None:
    """The actual contract an external consumer depends on: after a successful
    control, the template's stdout parses directly as JSON. The approval
    challenge must live on stderr, never mixed into stdout."""
    process, metadata = await _start_fixture()
    try:
        repo = Path(metadata["repo"])
        record = repo / ".gjc" / "state" / "sdk" / f'{metadata["sessionId"]}.json'
        assert record.is_file(), f"host did not write a discovery record: {record}"
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            str(TEMPLATE),
            "--repo",
            str(repo),
            "--session-id",
            metadata["sessionId"],
            "--mode",
            "control",
            "--operation",
            "session.rename",
            "--input",
            '{"name":"repair-template-test"}',
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
        challenge: str | None = None
        stderr_lines: list[bytes] = []
        while challenge is None:
            line = await asyncio.wait_for(proc.stderr.readline(), 30)
            if not line:
                break
            stderr_lines.append(line)
            match = re.search(rb"Approval required: (APPROVE [^\n]+)", line)
            if match:
                challenge = match.group(1).decode()
        assert challenge is not None, f"approval challenge was not emitted on stderr: {stderr_lines!r}"
        proc.stdin.write(challenge.encode() + b"\n")
        await proc.stdin.drain()
        proc.stdin.close()
        stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), 60)
        assert proc.returncode == 0, f"template failed: {stderr_bytes.decode(errors='replace')}"
        stdout = stdout_bytes.decode(errors="replace")
        payload = json.loads(stdout)
        assert "Approval required" not in stdout
        assert metadata["token"] not in stdout
        assert payload["sessionId"] == metadata["sessionId"]
    finally:
        await _stop_fixture(process)
