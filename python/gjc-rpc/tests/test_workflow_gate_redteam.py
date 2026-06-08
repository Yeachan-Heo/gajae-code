from __future__ import annotations

import json
import sys
import textwrap
import threading
import unittest

from gjc_rpc import RpcClient
from gjc_rpc.protocol import parse_workflow_gate


BASE_GATE = {
    "type": "workflow_gate",
    "gate_id": "wg_redteam_ralplan_000001",
    "stage": "ralplan",
    "kind": "approval",
    "schema": {"type": "object"},
    "schema_hash": "hash-redteam",
    "context": {"title": "Approve?"},
    "created_at": "2026-06-05T05:00:00.000Z",
}

ECHO_SERVER = textwrap.dedent(
    """
    import json
    import sys

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\\n")
        sys.stdout.flush()

    emit({"type": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        if msg.get("type") == "workflow_gate_response":
            emit({
                "type": "extension_error",
                "extensionPath": "gate-echo",
                "event": "received",
                "error": json.dumps(msg, sort_keys=True),
            })
            emit({
                "id": msg.get("id"),
                "type": "response",
                "command": "workflow_gate_response",
                "success": True,
                "data": {
                    "gate_id": msg.get("gate_id", ""),
                    "status": "accepted",
                    "answer_hash": "sha256:test",
                    "resolved_at": "2026-06-05T05:01:00.000Z",
                },
            })
    """
)

MULTI_GATE_SERVER = textwrap.dedent(
    """
    import json
    import sys

    gates = [
        {
            "type": "workflow_gate",
            "gate_id": "wg_multi_1",
            "stage": "ralplan",
            "kind": "approval",
            "schema": {"type": "object"},
            "schema_hash": "hash-1",
            "context": {"title": "First"},
            "created_at": "2026-06-05T05:00:00.000Z",
        },
        {
            "type": "workflow_gate",
            "gate_id": "wg_multi_2",
            "stage": "ultragoal",
            "kind": "execution",
            "schema": {"type": "object"},
            "schema_hash": "hash-2",
            "context": {"title": "Second"},
            "created_at": "2026-06-05T05:01:00.000Z",
        },
    ]

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\\n")
        sys.stdout.flush()

    emit({"type": "ready"})
    for gate in gates:
        emit(gate)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        if msg.get("type") == "workflow_gate_response":
            emit({
                "type": "extension_error",
                "extensionPath": "gate-response",
                "event": msg.get("gate_id", ""),
                "error": json.dumps(msg, sort_keys=True),
            })
            emit({
                "id": msg.get("id"),
                "type": "response",
                "command": "workflow_gate_response",
                "success": True,
                "data": {
                    "gate_id": msg.get("gate_id", ""),
                    "status": "accepted",
                    "answer_hash": "sha256:test",
                    "resolved_at": "2026-06-05T05:01:00.000Z",
                },
            })
    """
)


def make_client(server: str) -> RpcClient:
    return RpcClient(command=[sys.executable, "-u", "-c", server], startup_timeout=2.0, request_timeout=2.0)


class WorkflowGateRedTeamTest(unittest.TestCase):
    def test_parse_workflow_gate_rejects_missing_each_core_field(self) -> None:
        core_fields = ("gate_id", "stage", "kind", "schema_hash", "created_at")
        for field in core_fields:
            with self.subTest(field=field):
                payload = dict(BASE_GATE)
                payload.pop(field)
                with self.assertRaises(ValueError):
                    parse_workflow_gate(payload)

    def test_respond_gate_sends_exact_frame_without_idempotency_key(self) -> None:
        client = make_client(ECHO_SERVER)
        echoes: list[dict[str, object]] = []
        done = threading.Event()

        def on_error(event: object) -> None:
            echoes.append(json.loads(getattr(event, "error", "{}")))
            done.set()

        client.on_extension_error(on_error)
        client.start()
        try:
            client.respond_gate("wg_no_idem", {"decision": "approve"})
            self.assertTrue(done.wait(timeout=2.0))
            self.assertEqual(echoes[0], {"id": "req_1", "type": "workflow_gate_response", "gate_id": "wg_no_idem", "answer": {"decision": "approve"}})
        finally:
            client.stop()

    def test_respond_gate_sends_exact_frame_with_idempotency_key(self) -> None:
        client = make_client(ECHO_SERVER)
        echoes: list[dict[str, object]] = []
        done = threading.Event()

        def on_error(event: object) -> None:
            echoes.append(json.loads(getattr(event, "error", "{}")))
            done.set()

        client.on_extension_error(on_error)
        client.start()
        try:
            client.respond_gate("wg_with_idem", "approved", idempotency_key="idem-1")
            self.assertTrue(done.wait(timeout=2.0))
            self.assertEqual(
                echoes[0],
                {
                    "id": "req_1",
                    "type": "workflow_gate_response",
                    "gate_id": "wg_with_idem",
                    "answer": "approved",
                    "idempotency_key": "idem-1",
                },
            )
        finally:
            client.stop()

    def test_run_workflow_gate_policy_answers_multiple_gates(self) -> None:
        client = make_client(MULTI_GATE_SERVER)
        echoes: list[dict[str, object]] = []
        done = threading.Event()

        def on_error(event: object) -> None:
            echoes.append(json.loads(getattr(event, "error", "{}")))
            if len(echoes) == 2:
                done.set()

        client.on_extension_error(on_error)
        client.run_workflow_gate_policy(lambda gate: {"answered": gate.gate_id})
        client.start()
        try:
            self.assertTrue(done.wait(timeout=2.0))
            self.assertEqual([echo["gate_id"] for echo in echoes], ["wg_multi_1", "wg_multi_2"])
            self.assertEqual([echo["answer"] for echo in echoes], [{"answered": "wg_multi_1"}, {"answered": "wg_multi_2"}])
        finally:
            client.stop()

    def test_on_workflow_gate_unsubscribe_stops_delivery(self) -> None:
        client = make_client(MULTI_GATE_SERVER)
        received: list[str] = []
        first = threading.Event()

        def listener(gate: object) -> None:
            received.append(getattr(gate, "gate_id", ""))
            unsubscribe()
            first.set()

        unsubscribe = client.on_workflow_gate(listener)
        client.start()
        try:
            self.assertTrue(first.wait(timeout=2.0))
            threading.Event().wait(timeout=0.2)
            self.assertEqual(received, ["wg_multi_1"])
        finally:
            client.stop()


if __name__ == "__main__":
    unittest.main()
