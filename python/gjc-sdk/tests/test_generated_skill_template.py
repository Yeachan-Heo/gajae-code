from __future__ import annotations

import io
import json
from pathlib import Path
import re
import runpy
import subprocess
import sys
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[3]
TEMPLATE = ROOT / "sdk-skills" / "gjc-sdk-author" / "templates" / "direct-sdk.py"
CORE_QUERIES = (
    "session.metadata",
    "context.get",
    "goal.list/get",
    "todo.list",
    "workflow.gates.list",
    "session.stats",
)


class FakeCli:
    def __init__(self) -> None:
        self.calls: list[tuple[list[str], str]] = []
        self.secret = "must-not-print"

    def run(
        self,
        args: list[str],
        *,
        cwd: str,
        stdin: Any,
        stdout: Any,
        stderr: Any,
        text: bool,
        check: bool,
        timeout: int,
    ) -> subprocess.CompletedProcess[str]:
        self.calls.append((args, cwd))
        query_index = args.index("--query") if "--query" in args else -1
        query = args[query_index + 1] if query_index >= 0 else None
        if query == "session.stats":
            return subprocess.CompletedProcess(args, 1, "", f"private={self.secret}")
        return subprocess.CompletedProcess(
            args,
            0,
            json.dumps({"ok": True, "result": {"query": query or "control", "token": self.secret}}),
            "",
        )


class ChallengeStdin:
    """Answers the approval challenge from stderr, keeping successful stdout JSON-only."""

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


def configure(monkeypatch: pytest.MonkeyPatch, cli: FakeCli) -> None:
    monkeypatch.setattr(subprocess, "run", cli.run)


def run_template(monkeypatch: pytest.MonkeyPatch, args: list[str]) -> None:
    monkeypatch.setattr(sys, "argv", [str(TEMPLATE), *args])
    runpy.run_path(str(TEMPLATE), run_name="__main__")


def test_python_template_composes_queries_through_broker_cli_and_redacts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cli = FakeCli()
    configure(monkeypatch, cli)
    run_template(monkeypatch, ["--repo", str(tmp_path), "--session-id", "session-1", "--mode", "inspect"])
    captured = capsys.readouterr()
    assert [call[0][-1] for call in cli.calls] == list(CORE_QUERIES)
    assert all(
        args == ["gjc", "sdk", "session", "raw", "query", "session-1", "--query", query]
        for (args, cwd), query in zip(cli.calls, CORE_QUERIES)
    )
    assert all(cwd == str(tmp_path) for _, cwd in cli.calls)
    assert '"status": "unavailable"' in captured.out
    assert "[REDACTED]" in captured.out
    assert cli.secret not in captured.out + captured.err


def test_python_template_requires_exact_bound_approval(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cli = FakeCli()
    configure(monkeypatch, cli)
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
    assert cli.calls == []
    assert cli.secret not in captured.out + captured.err

    accepted: list[str] = []
    monkeypatch.setattr(sys, "stdin", ChallengeStdin(capsys, accepted))
    run_template(monkeypatch, args)
    captured = capsys.readouterr()
    assert cli.calls == [
        (
            [
                "gjc",
                "sdk",
                "session",
                "raw",
                "control",
                "session-1",
                "--op",
                "turn.prompt",
                "--json-input",
                '{"prompt":"hello"}',
                "--confirm",
            ],
            str(tmp_path),
        )
    ]
    assert cli.secret not in captured.out + captured.err
    assert len(accepted) == 1

    monkeypatch.setattr(sys, "stdin", io.StringIO(accepted[0] + "\n"))
    with pytest.raises(SystemExit) as replayed:
        run_template(monkeypatch, args)
    assert replayed.value.code == 1
    assert len(cli.calls) == 1


def test_python_template_requires_explicit_session_and_rejects_bypass_inputs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cli = FakeCli()
    configure(monkeypatch, cli)
    endpoint_path = tmp_path / ".gjc" / "state" / "sdk" / "session-1.json"
    endpoint_path.parent.mkdir(parents=True)
    endpoint_path.write_text('{"token":"must-not-read"}\n', encoding="utf-8")

    with pytest.raises(SystemExit) as missing_session:
        run_template(monkeypatch, ["--repo", str(tmp_path), "--mode", "inspect"])
    assert missing_session.value.code == 1

    with pytest.raises(SystemExit) as token_argument:
        run_template(monkeypatch, ["--repo", str(tmp_path), "--session-id", "session-1", "--token", "must-not-print"])
    assert token_argument.value.code == 1

    with pytest.raises(SystemExit) as secret_input:
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
                '{"token":"must-not-print"}',
            ],
        )
    assert secret_input.value.code == 1
    captured = capsys.readouterr()
    assert cli.calls == []
    assert "must-not-print" not in captured.out + captured.err


def test_python_template_rejects_forbidden_operation_before_approval(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cli = FakeCli()
    configure(monkeypatch, cli)
    monkeypatch.setattr(sys, "stdin", FailingStdin())
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
                "session.delete",
            ],
        )
    assert failed.value.code == 1
    assert cli.calls == []


def test_python_template_binds_workflow_gate_answer_to_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cli = FakeCli()
    configure(monkeypatch, cli)
    accepted: list[str] = []
    monkeypatch.setattr(sys, "stdin", ChallengeStdin(capsys, accepted))
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
            "workflow.gate_answer",
            "--input",
            '{"id":"gate-1","response":"approve"}',
        ],
    )
    args, cwd = cli.calls[0]
    input_index = args.index("--json-input")
    assert cwd == str(tmp_path)
    assert json.loads(args[input_index + 1]) == {
        "id": "gate-1",
        "response": "approve",
        "expectedSessionId": "session-1",
    }


def test_python_template_contains_no_endpoint_authority_bypass() -> None:
    source = TEMPLATE.read_text(encoding="utf-8")
    for marker in (
        ".gjc/state/sdk",
        "read_session_endpoint",
        "select_live_endpoint",
        "SdkClient",
        "connect_ws",
        "WebSocket",
        "endpoint.url",
        "endpoint.token",
    ):
        assert marker not in source
    assert '["gjc", "sdk", "session", *arguments]' in source
    assert "cwd=repo" in source
