from __future__ import annotations

import unittest

from gjc_rpc import (
    AgentEndEvent,
    ExtensionUiRequest,
    SessionState,
    WorkflowGate,
    WorkflowGateEvent,
    TodoReminderEvent,
    assistant_text,
    assistant_text_with_thinking,
    parse_notification,
    parse_session_state,
    parse_workflow_gate,
    parse_workflow_gate_event,
)


class ProtocolParsingTests(unittest.TestCase):
    def test_parse_session_state(self) -> None:
        state = parse_session_state(
            {
                "model": {
                    "id": "claude-sonnet-4-5",
                    "name": "Claude Sonnet 4.5",
                    "api": "anthropic-messages",
                    "provider": "anthropic",
                    "baseUrl": "https://api.anthropic.com",
                    "reasoning": True,
                    "input": ["text", "image"],
                    "cost": {
                        "input": 1.0,
                        "output": 2.0,
                        "cacheRead": 0.1,
                        "cacheWrite": 0.2,
                    },
                    "contextWindow": 200000,
                    "maxTokens": 8192,
                    "thinking": {
                        "minLevel": "minimal",
                        "maxLevel": "high",
                        "mode": "effort",
                    },
                },
                "thinkingLevel": "medium",
                "isStreaming": False,
                "isCompacting": False,
                "steeringMode": "one-at-a-time",
                "followUpMode": "all",
                "interruptMode": "immediate",
                "sessionFile": "/tmp/test.jsonl",
                "sessionId": "session-123",
                "sessionName": "Scratchpad",
                "autoCompactionEnabled": True,
                "messageCount": 4,
                "queuedMessageCount": 1,
                "todoPhases": [
                    {
                        "id": "phase-1",
                        "name": "Todos",
                        "tasks": [
                            {
                                "id": "task-1",
                                "content": "Map tools",
                                "status": "in_progress",
                                "details": "Inspect read and edit first.",
                            }
                        ],
                    }
                ],
                "systemPrompt": "You are useful.",
                "dumpTools": [
                    {
                        "name": "read",
                        "description": "Read files",
                        "parameters": {"type": "object"},
                    }
                ],
            }
        )

        self.assertIsInstance(state, SessionState)
        self.assertEqual(state.session_id, "session-123")
        self.assertEqual(state.follow_up_mode, "all")
        self.assertEqual(state.model.id if state.model else None, "claude-sonnet-4-5")
        self.assertEqual(state.todo_phases[0].tasks[0].status, "in_progress")
        # Legacy bare-string systemPrompt is accepted and wrapped to a tuple.
        self.assertEqual(state.system_prompt, ("You are useful.",))
        self.assertEqual(state.dump_tools[0].name, "read")

    def test_parse_agent_end_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "agent_end",
                "messages": [
                    {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "hello"}],
                        "api": "anthropic-messages",
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-5",
                        "usage": {
                            "input": 1,
                            "output": 1,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "totalTokens": 2,
                            "cost": {
                                "input": 0.0,
                                "output": 0.0,
                                "cacheRead": 0.0,
                                "cacheWrite": 0.0,
                                "total": 0.0,
                            },
                        },
                        "stopReason": "stop",
                        "timestamp": 1,
                    }
                ],
            }
        )

        self.assertIsInstance(notification, AgentEndEvent)
        self.assertEqual(assistant_text(notification.messages[0]), "hello")

    def test_parse_extension_ui_request(self) -> None:
        notification = parse_notification(
            {
                "type": "extension_ui_request",
                "id": "ui-1",
                "method": "confirm",
                "title": "Confirm",
                "message": "Continue?",
                "timeout": 1000,
            }
        )

        self.assertIsInstance(notification, ExtensionUiRequest)
        self.assertEqual(notification.method, "confirm")
        self.assertEqual(notification.message, "Continue?")
        self.assertTrue(notification.is_interactive())
        self.assertTrue(notification.requires_response())
        self.assertFalse(notification.is_passive())


    def test_parse_workflow_gate_event(self) -> None:
        gate = parse_workflow_gate_event(
            {
                "type": "workflow_gate",
                "gate_id": "gate-1",
                "stage": "ralplan:approval",
                "kind": "approval",
                "schema": {"type": "boolean"},
                "options": ["Approve", "Reject"],
                "context": {"skill": "ralplan", "phase": "approval"},
            }
        )

        self.assertIsInstance(gate, WorkflowGateEvent)
        self.assertEqual(gate.gate_id, "gate-1")
        self.assertEqual(gate.kind, "approval")
        self.assertEqual(gate.schema, {"type": "boolean"})
        self.assertEqual(gate.options, ("Approve", "Reject"))
        self.assertEqual(gate.context, {"skill": "ralplan", "phase": "approval"})

    def test_parse_workflow_gate_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "workflow_gate",
                "gate_id": "gate-1",
                "stage": "ralplan:approval",
                "kind": "approval",
                "schema": {"type": "boolean"},
                "schema_hash": "hash-1",
                "context": {"skill": "ralplan", "phase": "approval"},
                "created_at": "2026-06-05T05:00:00.000Z",
                "options": [{"value": "approve", "label": "Approve"}],
            }
        )

        self.assertIsInstance(notification, WorkflowGate)
        self.assertEqual(notification.gate_id, "gate-1")
        self.assertEqual(notification.schema_hash, "hash-1")
        self.assertEqual(notification.created_at, "2026-06-05T05:00:00.000Z")

    def test_workflow_gate_parsers_are_distinct(self) -> None:
        self.assertIsNot(parse_workflow_gate_event, parse_workflow_gate)

    def test_parse_todo_reminder_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "todo_reminder",
                "attempt": 1,
                "maxAttempts": 3,
                "todos": [
                    {
                        "id": "task-1",
                        "content": "Map tools",
                        "status": "pending",
                    }
                ],
            }
        )

        self.assertIsInstance(notification, TodoReminderEvent)
        self.assertEqual(notification.todos[0].content, "Map tools")
        self.assertEqual(notification.todos[0].status, "pending")

    def test_assistant_text_excludes_thinking_by_default(self) -> None:
        message = {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "internal"},
                {"type": "text", "text": "visible"},
            ],
        }

        self.assertEqual(assistant_text(message), "visible")
        self.assertEqual(assistant_text_with_thinking(message), "internalvisible")

    def test_parse_session_state_rejects_invalid_thinking_level(self) -> None:
        with self.assertRaises(ValueError):
            parse_session_state(
                {
                    "sessionId": "session-123",
                    "thinkingLevel": "extreme",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "one-at-a-time",
                    "interruptMode": "immediate",
                }
            )

    def test_parse_session_state_accepts_system_prompt_array(self) -> None:
        state = parse_session_state(
            {
                "sessionId": "session-abc",
                "steeringMode": "one-at-a-time",
                "followUpMode": "one-at-a-time",
                "interruptMode": "immediate",
                "systemPrompt": ["base instructions", "extra policy"],
            }
        )
        self.assertEqual(state.system_prompt, ("base instructions", "extra policy"))

    def test_parse_session_state_defaults_system_prompt_to_empty_tuple(self) -> None:
        state = parse_session_state(
            {
                "sessionId": "session-abc",
                "steeringMode": "one-at-a-time",
                "followUpMode": "one-at-a-time",
                "interruptMode": "immediate",
            }
        )
        self.assertEqual(state.system_prompt, ())

    def test_parse_session_state_rejects_non_string_in_system_prompt_array(self) -> None:
        with self.assertRaises(ValueError):
            parse_session_state(
                {
                    "sessionId": "session-abc",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "one-at-a-time",
                    "interruptMode": "immediate",
                    "systemPrompt": ["ok", 42],
                }
            )

    def test_parse_session_state_rejects_invalid_system_prompt_shape(self) -> None:
        with self.assertRaises(ValueError):
            parse_session_state(
                {
                    "sessionId": "session-abc",
                    "steeringMode": "one-at-a-time",
                    "followUpMode": "one-at-a-time",
                    "interruptMode": "immediate",
                    "systemPrompt": {"unexpected": "object"},
                }
            )

    def test_parse_extension_ui_request_rejects_invalid_method(self) -> None:
        with self.assertRaises(ValueError):
            parse_notification({"type": "extension_ui_request", "id": "ui-1", "method": "launch"})

    def test_parse_message_update_rejects_invalid_assistant_done_reason(self) -> None:
        with self.assertRaises(ValueError):
            parse_notification(
                {
                    "type": "message_update",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "hello"}],
                        "api": "anthropic-messages",
                        "provider": "anthropic",
                        "model": "claude-sonnet-4-5",
                        "usage": {
                            "input": 1,
                            "output": 1,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "totalTokens": 2,
                            "cost": {
                                "input": 0.0,
                                "output": 0.0,
                                "cacheRead": 0.0,
                                "cacheWrite": 0.0,
                                "total": 0.0,
                            },
                        },
                        "stopReason": "stop",
                        "timestamp": 1,
                    },
                    "assistantMessageEvent": {
                        "type": "done",
                        "reason": "error",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "hello"}],
                            "api": "anthropic-messages",
                            "provider": "anthropic",
                            "model": "claude-sonnet-4-5",
                            "usage": {
                                "input": 1,
                                "output": 1,
                                "cacheRead": 0,
                                "cacheWrite": 0,
                                "totalTokens": 2,
                                "cost": {
                                    "input": 0.0,
                                    "output": 0.0,
                                    "cacheRead": 0.0,
                                    "cacheWrite": 0.0,
                                    "total": 0.0,
                                },
                            },
                            "stopReason": "stop",
                            "timestamp": 1,
                        },
                    },
                }
            )

    def test_parse_notification_deep_clones_nested_messages(self) -> None:
        payload = {
            "type": "agent_end",
            "messages": [
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "hello"}],
                    "api": "anthropic-messages",
                    "provider": "anthropic",
                    "model": "claude-sonnet-4-5",
                    "usage": {
                        "input": 1,
                        "output": 1,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 2,
                        "cost": {
                            "input": 0.0,
                            "output": 0.0,
                            "cacheRead": 0.0,
                            "cacheWrite": 0.0,
                            "total": 0.0,
                        },
                    },
                    "stopReason": "stop",
                    "timestamp": 1,
                }
            ],
        }

        notification = parse_notification(payload)
        payload["messages"][0]["content"][0]["text"] = "mutated"

        self.assertIsInstance(notification, AgentEndEvent)
        self.assertEqual(notification.messages[0]["content"][0]["text"], "hello")


if __name__ == "__main__":
    unittest.main()
