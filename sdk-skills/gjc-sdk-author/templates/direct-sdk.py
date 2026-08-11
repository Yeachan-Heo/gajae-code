#!/usr/bin/env python3

from __future__ import annotations

# Trusted-local procedural policy only. The Broker and SessionRouter retain session lifecycle and attachment authority.

import argparse
import hashlib
import json
import re
import secrets
import subprocess
import sys
from typing import Any, NoReturn

CORE_QUERIES = (
    "session.metadata",
    "context.get",
    "goal.list/get",
    "todo.list",
    "workflow.gates.list",
    "session.stats",
)
ALLOWED_CONTROLS = ['turn.prompt','turn.steer','turn.follow_up','ask.answer','workflow.gate_answer','todo.replace','session.switch','session.rename']
SECRET_FIELD = re.compile(r"(?:secret|token|password|credential|authorization|api[_-]?key)", re.IGNORECASE)


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise ValueError("invalid_argument")


def parse_args() -> argparse.Namespace:
    parser = SafeArgumentParser(description="Trusted local broker-bound GJC session template", allow_abbrev=False)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--mode", choices=("inspect", "control"), default="inspect")
    parser.add_argument("--operation")
    parser.add_argument("--input", default="{}")
    return parser.parse_args()


def has_secret_field(value: Any) -> bool:
    if isinstance(value, list):
        return any(has_secret_field(item) for item in value)
    if not isinstance(value, dict):
        return False
    return any(SECRET_FIELD.search(key) or has_secret_field(item) for key, item in value.items())


def redact(value: Any) -> Any:
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if SECRET_FIELD.search(key) else redact(item)
            for key, item in value.items()
        }
    return value


def run_gjc_session(repo: str, arguments: list[str]) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            ["gjc", "sdk", "session", *arguments],
            cwd=repo,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        raise ValueError("broker_request_failed") from None
    if completed.returncode != 0:
        raise ValueError("broker_request_failed")
    try:
        response: Any = json.loads(completed.stdout)
    except json.JSONDecodeError:
        raise ValueError("invalid_cli_response") from None
    if not isinstance(response, dict):
        raise ValueError("invalid_cli_response")
    return response


def inspect(repo: str, session_id: str) -> dict[str, Any]:
    snapshot: dict[str, Any] = {}
    for query in CORE_QUERIES:
        try:
            response = run_gjc_session(repo, ["raw", "query", session_id, "--query", query])
            if response.get("ok") is False:
                raise ValueError("query_unavailable")
            snapshot[query] = {"status": "confirmed", "source": query, "value": redact(response)}
        except Exception:
            snapshot[query] = {"status": "unavailable", "source": query}
    return snapshot


def require_approval(session_id: str, operation: str, operation_input: dict[str, Any]) -> None:
    payload = json.dumps(
        {"sessionId": session_id, "operation": operation, "input": operation_input},
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    challenge = f"APPROVE {session_id} {operation} {digest} {secrets.token_hex(8)}"
    print(f"Approval required: {challenge}\nType the exact challenge: ", file=sys.stderr, end="", flush=True)
    answer = sys.stdin.readline()
    if answer.strip() != challenge:
        raise ValueError("human_approval_required")


def main() -> None:
    args = parse_args()
    operation_input = json.loads(args.input)
    if not isinstance(operation_input, dict):
        raise ValueError("input must be an object")
    if has_secret_field(operation_input):
        raise ValueError("secret_input_forbidden")
    if args.mode == "inspect":
        result = inspect(args.repo, args.session_id)
        print(json.dumps(redact({"sessionId": args.session_id, "result": result}), indent=2))
        return
    operation = args.operation
    if operation is None or operation not in ALLOWED_CONTROLS:
        raise ValueError("operation_not_allowed")
    if operation == "workflow.gate_answer":
        operation_input = {**operation_input, "expectedSessionId": args.session_id}
    require_approval(args.session_id, operation, operation_input)
    result = run_gjc_session(
        args.repo,
        [
            "raw",
            "control",
            args.session_id,
            "--op",
            operation,
            "--json-input",
            json.dumps(operation_input, separators=(",", ":")),
            "--confirm",
        ],
    )
    if result.get("ok") is False:
        raise ValueError("control_failed")
    print(json.dumps(redact({"sessionId": args.session_id, "result": result}), indent=2))


try:
    main()
except Exception:
    print("GJC SDK request failed safely.", file=sys.stderr)
    raise SystemExit(1)
