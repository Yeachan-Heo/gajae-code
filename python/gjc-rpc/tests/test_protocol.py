from __future__ import annotations

import unittest

from gjc_rpc import (
    AgentEndEvent,
    AgentStartEvent,
    AutoCompactionStartEvent,
    ExtensionUiRequest,
    SessionState,
    ToolExecutionStartEvent,
    UnknownNotification,
    WorkflowGate,
    WorkflowGateEvent,
    TodoReminderEvent,
    TurnStartEvent,
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

    def test_parse_wrapped_agent_start_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "event",
                "protocol_version": 2,
                "session_id": "s",
                "seq": 1,
                "frame_id": "f",
                "payload": {"event_type": "agent_start", "event": {"type": "agent_start"}},
            }
        )

        self.assertIsInstance(notification, AgentStartEvent)

    def test_parse_wrapped_tool_execution_start_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "event",
                "protocol_version": 2,
                "session_id": "s",
                "seq": 1,
                "frame_id": "f",
                "payload": {
                    "event_type": "tool_execution_start",
                    "event": {
                        "type": "tool_execution_start",
                        "toolCallId": "tool-1",
                        "toolName": "read",
                        "args": {"path": "README.md"},
                    },
                },
            }
        )

        self.assertIsInstance(notification, ToolExecutionStartEvent)
        self.assertEqual(notification.tool_call_id, "tool-1")
        self.assertEqual(notification.tool_name, "read")

    def test_parse_wrapped_event_notifications_for_multiple_event_types(self) -> None:
        cases = [
            ("agent_start", {"type": "agent_start"}, AgentStartEvent),
            ("turn_start", {"type": "turn_start"}, TurnStartEvent),
            (
                "auto_compaction_start",
                {"type": "auto_compaction_start", "reason": "threshold", "action": "context-full"},
                AutoCompactionStartEvent,
            ),
            (
                "tool_execution_start",
                {"type": "tool_execution_start", "toolCallId": "tool-2", "toolName": "bash", "args": {}},
                ToolExecutionStartEvent,
            ),
        ]

        for index, (event_type, event, expected_type) in enumerate(cases, start=1):
            with self.subTest(event_type=event_type):
                notification = parse_notification(
                    {
                        "type": "event",
                        "protocol_version": 2,
                        "session_id": "s",
                        "seq": index,
                        "frame_id": f"f-{index}",
                        "payload": {"event_type": event_type, "event": event},
                    }
                )

                self.assertIsInstance(notification, expected_type)

    def test_parse_wrapped_unknown_inner_event_type_as_unknown(self) -> None:
        payload = {
            "type": "event",
            "protocol_version": 2,
            "session_id": "s",
            "seq": 3,
            "frame_id": "f-unknown",
            "payload": {"event_type": "future_event", "event": {"type": "future_event", "extra": True}},
        }
        notification = parse_notification(payload)

        self.assertIsInstance(notification, UnknownNotification)
        self.assertEqual(notification.payload, {"type": "future_event", "extra": True})

    def test_parse_wrapped_event_missing_payload_event_as_unknown(self) -> None:
        for payload in (
            {"type": "event", "protocol_version": 2, "session_id": "s", "seq": 4, "frame_id": "f-missing"},
            {
                "type": "event",
                "protocol_version": 2,
                "session_id": "s",
                "seq": 5,
                "frame_id": "f-empty",
                "payload": {},
            },
        ):
            with self.subTest(payload=payload):
                notification = parse_notification(payload)

                self.assertIsInstance(notification, UnknownNotification)
                self.assertEqual(notification.payload, payload)

    def test_parse_flat_non_event_workflow_gate_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "workflow_gate",
                "gate_id": "gate-flat",
                "stage": "ultragoal:signoff",
                "kind": "execution",
                "schema": {"type": "object"},
                "schema_hash": "hash-flat",
                "context": {"skill": "ultragoal"},
                "created_at": "2026-06-09T00:00:00.000Z",
                "options": [{"value": "approve", "label": "Approve"}],
            }
        )

        self.assertIsInstance(notification, WorkflowGate)
        self.assertEqual(notification.gate_id, "gate-flat")
        self.assertEqual(notification.kind, "execution")

    def test_parse_malformed_wrapped_event_notification_as_unknown(self) -> None:
        payload = {
            "type": "event",
            "protocol_version": 2,
            "session_id": "s",
            "seq": 1,
            "frame_id": "f",
            "payload": {"event_type": "agent_start"},
        }
        notification = parse_notification(payload)

        self.assertIsInstance(notification, UnknownNotification)
        self.assertEqual(notification.payload, payload)

    def test_parse_flat_agent_event_notification_as_unknown(self) -> None:
        payload = {"type": "agent_start"}
        notification = parse_notification(payload)

        self.assertIsInstance(notification, UnknownNotification)
        self.assertEqual(notification.payload, payload)
    def test_parse_wrapped_agent_end_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "event",
                "protocol_version": 2,
                "session_id": "s",
                "seq": 6,
                "frame_id": "f-agent-end",
                "payload": {
                    "event_type": "agent_end",
                    "event": {
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
                    },
                },
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

    def test_parse_wrapped_todo_reminder_notification(self) -> None:
        notification = parse_notification(
            {
                "type": "event",
                "protocol_version": 2,
                "session_id": "s",
                "seq": 7,
                "frame_id": "f-todo-reminder",
                "payload": {
                    "event_type": "todo_reminder",
                    "event": {
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
                    },
                },
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
                    "type": "event",
                    "protocol_version": 2,
                    "session_id": "s",
                    "seq": 8,
                    "frame_id": "f-message-update",
                    "payload": {
                        "event_type": "message_update",
                        "event": {
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
                        },
                    },
                }
            )

    def test_parse_notification_deep_clones_nested_messages(self) -> None:
        payload = {
            "type": "event",
            "protocol_version": 2,
            "session_id": "s",
            "seq": 9,
            "frame_id": "f-agent-end-clone",
            "payload": {
                "event_type": "agent_end",
                "event": {
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
                },
            },
        }

        notification = parse_notification(payload)
        payload["payload"]["event"]["messages"][0]["content"][0]["text"] = "mutated"

        self.assertIsInstance(notification, AgentEndEvent)
        self.assertEqual(notification.messages[0]["content"][0]["text"], "hello")


if __name__ == "__main__":
    unittest.main()
