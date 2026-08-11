#!/usr/bin/env python3

from __future__ import annotations

# Trusted-local procedural policy only; this template does not isolate a modified process from endpoint authority.

import argparse
import asyncio
from dataclasses import asdict, is_dataclass
import hashlib
import json
from pathlib import Path
import re
import secrets
import sys
from typing import Any, NoReturn
import warnings

from gjc_sdk import Endpoint, SdkClient, read_session_endpoint, select_live_endpoint

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
    parser = SafeArgumentParser(description="Trusted local direct GJC SDK template", allow_abbrev=False)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--session-id")
    parser.add_argument("--mode", choices=("inspect", "control"), default="inspect")
    parser.add_argument("--operation")
    parser.add_argument("--input", default="{}")
    return parser.parse_args()


def redact(value: Any, endpoint_token: str) -> Any:
    if isinstance(value, str):
        return value.replace(endpoint_token, "[REDACTED]")
    if is_dataclass(value) and not isinstance(value, type):
        return redact(asdict(value), endpoint_token)
    if isinstance(value, list):
        return [redact(item, endpoint_token) for item in value]
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if SECRET_FIELD.search(key) else redact(item, endpoint_token)
            for key, item in value.items()
        }
    return value


async def inspect(client: SdkClient, endpoint_token: str) -> dict[str, Any]:
    snapshot: dict[str, Any] = {}
    for query in CORE_QUERIES:
        try:
            response = await client.query(query, {})
            if response.ok:
                snapshot[query] = {"status": "confirmed", "source": query, "value": redact(response, endpoint_token)}
            else:
                snapshot[query] = {"status": "unavailable", "source": query}
        except Exception:
            snapshot[query] = {"status": "unavailable", "source": query}
    return snapshot

def select_endpoint(repo: str, session_id: str | None) -> Endpoint:
    directory = Path(repo) / ".gjc" / "state" / "sdk"
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("unsafe_discovery_directory")
    paths = sorted(directory.glob("*.json"))
    if any(path.is_symlink() or not path.is_file() for path in paths):
        raise ValueError("unsafe_discovery_record")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        endpoints = []
        for path in paths:
            endpoint = read_session_endpoint(repo, path.stem)
            if endpoint is None or endpoint.session_id != path.stem:
                raise ValueError("invalid_discovery_record")
            endpoints.append(endpoint)
        if caught or len({endpoint.session_id for endpoint in endpoints}) != len(endpoints):
            raise ValueError("invalid_discovery_record")
    return select_live_endpoint(endpoints, session_id)

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


async def main() -> None:
    args = parse_args()
    operation_input = json.loads(args.input)
    if not isinstance(operation_input, dict):
        raise ValueError("input must be an object")
    endpoint = select_endpoint(args.repo, args.session_id)
    operation = args.operation
    if args.mode == "control":
        if operation is None or operation not in ALLOWED_CONTROLS:
            raise ValueError("operation_not_allowed")
        if operation == "workflow.gate_answer":
            operation_input["expectedSessionId"] = endpoint.session_id
        require_approval(endpoint.session_id, operation, operation_input)
        revalidated = select_endpoint(args.repo, endpoint.session_id)
        if revalidated != endpoint:
            raise ValueError("endpoint_changed")
        endpoint = revalidated
    client = await SdkClient.connect_ws(
        args.repo,
        endpoint.session_id,
        token=endpoint.token,
        url=endpoint.url,
    )
    try:
        result: object
        if args.mode == "inspect":
            result = await inspect(client, endpoint.token)
        else:
            assert operation is not None
            response = await client.control(operation, operation_input)
            if not response.ok:
                raise RuntimeError("control_failed")
            result = response
        print(json.dumps(redact({"sessionId": endpoint.session_id, "result": result}, endpoint.token), indent=2))
    finally:
        await client.close()


try:
    asyncio.run(main())
except Exception:
    print("GJC SDK request failed safely.", file=sys.stderr)
    raise SystemExit(1)
