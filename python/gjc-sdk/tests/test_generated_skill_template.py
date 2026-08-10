from __future__ import annotations

import json
from pathlib import Path
import re
import runpy
import sys
from typing import Any

import pytest

import gjc_sdk
from gjc_sdk import Endpoint
from gjc_sdk.frames import ControlResponse, QueryResponse


TEMPLATE = Path(__file__).resolve().parents[3] / "sdk-skills" / "gjc-sdk-author" / "templates" / "direct-sdk.py"


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
    monkeypatch.setattr("builtins.input", lambda prompt: "DENY")


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
    with pytest.raises(SystemExit) as denied:
        run_template(monkeypatch, args)
    assert denied.value.code == 1
    captured = capsys.readouterr()
    assert client.controls == []
    assert client.closed is False
    assert "must-not-print" not in captured.out + captured.err

    accepted: list[str] = []

    def accept(prompt: str) -> str:
        challenge = re.search(r"Approval required: (APPROVE [^\n]+)", prompt)
        assert challenge is not None
        accepted.append(challenge.group(1))
        return challenge.group(1)

    monkeypatch.setattr("builtins.input", accept)
    run_template(monkeypatch, args)
    captured = capsys.readouterr()
    assert client.controls == [("turn.prompt", {"prompt": "hello"})]
    assert client.closed is True
    assert "must-not-print" not in captured.out + captured.err

    monkeypatch.setattr("builtins.input", lambda prompt: accepted[0])
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
    monkeypatch.setattr("builtins.input", lambda prompt: pytest.fail("approval prompt must not run"))
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


def test_python_template_revalidates_after_approval(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    client = FakeClient()
    configure(monkeypatch, tmp_path, client)
    record = tmp_path / ".gjc" / "state" / "sdk" / "session-1.json"
    original = Endpoint("session-1", "ws://127.0.0.1:1", "must-not-print", 1, False, record)
    replacement = Endpoint("session-1", "ws://127.0.0.1:2", "replacement-token", 1, False, record)
    reads = iter([original, replacement])
    monkeypatch.setattr(gjc_sdk, "read_session_endpoint", lambda repo, session_id: next(reads))

    def accept(prompt: str) -> str:
        challenge = re.search(r"Approval required: (APPROVE [^\n]+)", prompt)
        assert challenge is not None
        return challenge.group(1)

    monkeypatch.setattr("builtins.input", accept)
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
