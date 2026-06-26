from __future__ import annotations

import sys
import textwrap
import threading
import unittest

from gjc_rpc import RpcClient, WorkflowGate


# Fake server: announces ready, emits one workflow_gate, then waits for a
# workflow_gate_response request on stdin. It echoes the answer as an
# extension_error frame and sends the accepted resolution envelope so the client
# can assert the headless respond_gate round-trip.
GATE_SERVER = textwrap.dedent(
    """
    import json
    import sys

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\\n")
        sys.stdout.flush()

    emit({"type": "ready"})
    emit({
        "type": "workflow_gate",
        "gate_id": "wg_test_ralplan_000001",
        "stage": "ralplan",
        "kind": "approval",
        "schema": {"type": "object", "properties": {"decision": {"type": "string"}}, "required": ["decision"]},
        "schema_hash": "hash-1",
        "context": {"title": "Approve?"},
        "created_at": "2026-06-05T05:00:00.000Z",
        "required": True,
    })
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        if msg.get("type") == "workflow_gate_response":
            emit({
                "type": "extension_error",
                "extensionPath": "gate-echo",
                "event": msg.get("gate_id", ""),
                "error": json.dumps(msg.get("answer")),
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


class WorkflowGateClientTest(unittest.TestCase):
    def make_client(self, server: str = GATE_SERVER) -> RpcClient:
        return RpcClient(command=[sys.executable, "-u", "-c", server], startup_timeout=2.0, request_timeout=2.0)

    def test_on_workflow_gate_receives_typed_gate(self) -> None:
        client = self.make_client()
        received: list[WorkflowGate] = []
        done = threading.Event()
        client.on_workflow_gate(lambda gate: (received.append(gate), done.set()))
        client.start()
        try:
            self.assertTrue(done.wait(timeout=2.0))
            self.assertEqual(received[0].gate_id, "wg_test_ralplan_000001")
            self.assertEqual(received[0].kind, "approval")
        finally:
            client.stop()

    def test_respond_gate_waits_for_resolution_envelope(self) -> None:
        client = self.make_client()
        client.start()
        try:
            resolution = client.respond_gate("wg_test_ralplan_000001", {"decision": "approve"}, idempotency_key="idem-1")
            self.assertEqual(resolution["gate_id"], "wg_test_ralplan_000001")
            self.assertEqual(resolution["status"], "accepted")
            self.assertEqual(resolution["answer_hash"], "sha256:test")
        finally:
            client.stop()

    def test_run_workflow_gate_policy_responds_and_round_trips(self) -> None:
        client = self.make_client()
        echoes: list[str] = []
        done = threading.Event()

        def on_error(event: object) -> None:
            # The fake server echoes the answer back as an extension_error.
            echoes.append(getattr(event, "error", ""))
            done.set()

        client.on_extension_error(on_error)
        client.run_workflow_gate_policy(lambda gate: {"decision": "approve"} if gate.kind == "approval" else {"selected": []})
        client.start()
        try:
            self.assertTrue(done.wait(timeout=2.0))
            self.assertIn("approve", echoes[0])
        finally:
            client.stop()


if __name__ == "__main__":
    unittest.main()
