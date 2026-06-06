from __future__ import annotations

import unittest

from gjc_rpc import WorkflowGate, WorkflowGateOption, parse_notification
from gjc_rpc.protocol import parse_workflow_gate


GATE_PAYLOAD = {
    "type": "workflow_gate",
    "gate_id": "wg_4845_ralplan_000001",
    "stage": "ralplan",
    "kind": "approval",
    "schema": {"type": "object", "properties": {"decision": {"type": "string"}}, "required": ["decision"]},
    "schema_hash": "abc123",
    "options": [
        {"value": "approve", "label": "Approve execution", "description": "recommended"},
        {"value": "reject", "label": "Reject"},
    ],
    "context": {"title": "Approve plan?", "summary": "PRD v2"},
    "created_at": "2026-06-05T05:00:00.000Z",
    "required": True,
}


class WorkflowGateParseTest(unittest.TestCase):
    def test_parse_workflow_gate_fields(self) -> None:
        gate = parse_workflow_gate(GATE_PAYLOAD)
        self.assertIsInstance(gate, WorkflowGate)
        self.assertEqual(gate.gate_id, "wg_4845_ralplan_000001")
        self.assertEqual(gate.stage, "ralplan")
        self.assertEqual(gate.kind, "approval")
        self.assertEqual(gate.schema_hash, "abc123")
        self.assertEqual(gate.created_at, "2026-06-05T05:00:00.000Z")
        self.assertEqual(gate.context, {"title": "Approve plan?", "summary": "PRD v2"})
        assert gate.options is not None
        self.assertEqual(len(gate.options), 2)
        self.assertEqual(gate.options[0], WorkflowGateOption(value="approve", label="Approve execution", description="recommended"))
        self.assertEqual(gate.options[1].description, None)

    def test_parse_notification_dispatches_workflow_gate(self) -> None:
        gate = parse_notification(GATE_PAYLOAD)
        self.assertIsInstance(gate, WorkflowGate)
        self.assertEqual(gate.type, "workflow_gate")

    def test_parse_workflow_gate_without_options(self) -> None:
        payload = {**GATE_PAYLOAD}
        del payload["options"]
        gate = parse_workflow_gate(payload)
        self.assertIsNone(gate.options)

    def test_parse_workflow_gate_requires_core_fields(self) -> None:
        for missing in ("gate_id", "stage", "kind", "schema_hash", "created_at"):
            payload = {**GATE_PAYLOAD}
            del payload[missing]
            with self.assertRaises(ValueError):
                parse_workflow_gate(payload)


if __name__ == "__main__":
    unittest.main()
