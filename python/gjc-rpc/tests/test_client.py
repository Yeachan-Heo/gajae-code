from __future__ import annotations

import json
import sys
import textwrap
import threading
import time
import unittest

from gjc_rpc import RpcClient, RpcCommandError, RpcConcurrencyError, RpcError, host_tool, host_uri


FAKE_SERVER = textwrap.dedent(
    """
    import json
    import sys
    import time

    def usage():
        return {
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
        }

    def model_info(model_id: str, provider: str = "anthropic"):
        return {
            "id": model_id,
            "name": f"Model {model_id}",
            "api": "anthropic-messages",
            "provider": provider,
            "baseUrl": "https://api.anthropic.com",
            "reasoning": True,
            "input": ["text"],
            "cost": {
                "input": 1.0,
                "output": 2.0,
                "cacheRead": 0.0,
                "cacheWrite": 0.0,
            },
            "contextWindow": 200000,
            "maxTokens": 8192,
        }

    def assistant_message(text: str):
        return {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "api": "anthropic-messages",
            "provider": model_provider,
            "model": model_id,
            "usage": usage(),
            "stopReason": "stop",
            "timestamp": 1,
        }

    event_seq = 0

    def emit_event(event):
        global event_seq
        event_seq += 1
        print(
            json.dumps(
                {
                    "type": "event",
                    "protocol_version": 2,
                    "session_id": "fake-session",
                    "seq": event_seq,
                    "frame_id": f"frame-{event_seq}",
                    "payload": {"event_type": event.get("type"), "event": event},
                }
            ),
            flush=True,
        )

    registered_host_tools = []

    def current_state():
        return {
            "model": model_info(model_id, model_provider),
            "thinkingLevel": thinking_level,
            "isStreaming": False,
            "isCompacting": False,
            "steeringMode": steering_mode,
            "followUpMode": follow_up_mode,
            "interruptMode": interrupt_mode,
            "sessionId": "fake-session",
            "sessionName": session_name,
            "autoCompactionEnabled": auto_compaction_enabled,
            "messageCount": len(messages),
            "queuedMessageCount": 0,
            "todoPhases": todo_phases,
            "dumpTools": [{"name": "read", "description": "Read files", "parameters": {"type": "object"}}] + registered_host_tools,
        }

    def emit_prompt_turn(text: str, delay: float = 0.0, include_extra_events: bool = False):
        global last_assistant_text, messages
        emit_event({"type": "agent_start"})
        emit_event({"type": "turn_start"})
        partial = assistant_message("")
        emit_event({"type": "message_start", "message": partial})
        emit_event(
            {
                "type": "message_update",
                "message": partial,
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": text,
                    "partial": partial,
                },
            }
        )

        if delay:
            time.sleep(delay)

        if include_extra_events:
            emit_event(
                {
                    "type": "tool_execution_start",
                    "toolCallId": "tool-1",
                    "toolName": "read",
                    "args": {"path": "README.md"},
                    "intent": "Inspect docs",
                }
            )
            emit_event(
                {
                    "type": "tool_execution_update",
                    "toolCallId": "tool-1",
                    "toolName": "read",
                    "args": {"path": "README.md"},
                    "partialResult": {"bytes": 12},
                }
            )
            emit_event(
                {
                    "type": "tool_execution_end",
                    "toolCallId": "tool-1",
                    "toolName": "read",
                    "result": {"text": "docs"},
                    "isError": False,
                }
            )
            emit_event({"type": "auto_compaction_start", "reason": "threshold", "action": "context-full"})
            emit_event(
                {
                    "type": "auto_compaction_end",
                    "action": "context-full",
                    "result": {
                        "summary": "trimmed",
                        "shortSummary": "trimmed",
                        "firstKeptEntryId": "entry-1",
                        "tokensBefore": 123,
                    },
                    "aborted": False,
                    "willRetry": False,
                }
            )
            emit_event(
                {
                    "type": "auto_retry_start",
                    "attempt": 1,
                    "maxAttempts": 3,
                    "delayMs": 25,
                    "errorMessage": "retrying",
                }
            )
            emit_event({"type": "auto_retry_end", "success": True, "attempt": 1})
            emit_event({"type": "retry_fallback_applied", "from": "a", "to": "b", "role": "primary"})
            emit_event({"type": "retry_fallback_succeeded", "model": "b", "role": "primary"})
            emit_event({"type": "ttsr_triggered", "rules": [{"id": "rule-1"}]})
            emit_event(
                {
                    "type": "todo_reminder",
                    "attempt": 1,
                    "maxAttempts": 2,
                    "todos": [{"id": "task-1", "content": "Map tools", "status": "pending"}],
                }
            )
            emit_event({"type": "todo_auto_clear"})

        assistant = assistant_message(text)
        emit_event({"type": "message_end", "message": assistant})
        emit_event({"type": "turn_end", "message": assistant, "toolResults": []})
        emit_event({"type": "agent_end", "messages": [assistant]})
        last_assistant_text = text
        messages = [assistant]

    def respond(request_id, command, data=None, success=True, error=None):
        payload = {"id": request_id, "type": "response", "command": command, "success": success}
        if success and data is not None:
            payload["data"] = data
        if not success:
            payload["error"] = error
        print(json.dumps(payload), flush=True)

    print(json.dumps({"type": "ready"}), flush=True)
    todo_phases = []
    messages = []
    branch_messages = [{"entryId": "entry-1", "text": "branch message"}]
    model_provider = "anthropic"
    model_id = "claude-sonnet-4-5"
    thinking_level = "medium"
    steering_mode = "one-at-a-time"
    follow_up_mode = "one-at-a-time"
    interrupt_mode = "immediate"
    auto_compaction_enabled = True
    auto_retry_enabled = True
    session_name = "Scratchpad"
    last_assistant_text = None

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        command = json.loads(raw_line)
        command_type = command["type"]
        request_id = command.get("id")

        if command_type == "extension_ui_response":
            emit_prompt_turn("ui acknowledged")
            continue
        if command_type == "workflow_gate_response":
            answer = command.get("answer")
            if command.get("gate_id") == "ui-2" and not isinstance(answer, bool):
                respond(request_id, "workflow_gate_response", success=False, error="invalid_workflow_gate_response: answer must be a boolean")
                continue
            if command.get("gate_id") == "ui-select" and answer not in {"alpha", "beta"}:
                respond(request_id, "workflow_gate_response", success=False, error="invalid_workflow_gate_response: answer must match one of the advertised enum values")
                continue
            respond(request_id, "workflow_gate_response", {})
            emit_prompt_turn("ui acknowledged")
            continue

        if command_type == "get_state":
            respond(request_id, "get_state", current_state())
        elif command_type == "set_host_tools":
            registered_host_tools = command.get("tools", [])
            respond(
                request_id,
                "set_host_tools",
                {"toolNames": [tool.get("name", "") for tool in registered_host_tools]},
            )
        elif command_type == "set_todos":
            todo_phases = command.get("phases", [])
            respond(request_id, "set_todos", {"todoPhases": todo_phases})
        elif command_type == "get_messages":
            respond(request_id, "get_messages", {"messages": messages})
        elif command_type == "set_host_tools":
            tool_names = [tool.get("name", "") for tool in command.get("tools", [])]
            respond(request_id, "set_host_tools", {"toolNames": tool_names})
        elif command_type == "set_model":
            model_provider = command["provider"]
            model_id = command["modelId"]
            respond(request_id, "set_model", model_info(model_id, model_provider))
        elif command_type == "cycle_model":
            model_id = "claude-sonnet-4-6" if model_id == "claude-sonnet-4-5" else "claude-sonnet-4-5"
            respond(request_id, "cycle_model", {"model": model_info(model_id, model_provider), "thinkingLevel": thinking_level, "isScoped": False})
        elif command_type == "get_available_models":
            respond(
                request_id,
                "get_available_models",
                {
                    "models": [
                        model_info("claude-sonnet-4-5", "anthropic"),
                        model_info("claude-sonnet-4-6", "anthropic"),
                    ]
                },
            )
        elif command_type == "set_thinking_level":
            thinking_level = command["level"]
            respond(request_id, "set_thinking_level", {})
        elif command_type == "cycle_thinking_level":
            thinking_level = "high" if thinking_level != "high" else "low"
            respond(request_id, "cycle_thinking_level", {"level": thinking_level})
        elif command_type == "set_steering_mode":
            steering_mode = command["mode"]
            respond(request_id, "set_steering_mode", {})
        elif command_type == "set_follow_up_mode":
            follow_up_mode = command["mode"]
            respond(request_id, "set_follow_up_mode", {})
        elif command_type == "set_interrupt_mode":
            interrupt_mode = command["mode"]
            respond(request_id, "set_interrupt_mode", {})
        elif command_type == "compact":
            respond(
                request_id,
                "compact",
                {"summary": "trimmed", "shortSummary": "trimmed", "firstKeptEntryId": "entry-1", "tokensBefore": 123},
            )
        elif command_type == "set_auto_compaction":
            auto_compaction_enabled = command["enabled"]
            respond(request_id, "set_auto_compaction", {})
        elif command_type == "set_auto_retry":
            auto_retry_enabled = command["enabled"]
            respond(request_id, "set_auto_retry", {})
        elif command_type == "abort_retry":
            respond(request_id, "abort_retry", {})
        elif command_type == "bash":
            respond(
                request_id,
                "bash",
                {
                    "output": "hello\\n",
                    "exitCode": 0,
                    "cancelled": False,
                    "truncated": False,
                    "totalLines": 1,
                    "totalBytes": 6,
                    "outputLines": 1,
                    "outputBytes": 6,
                },
            )
        elif command_type == "abort_bash":
            respond(request_id, "abort_bash", {})
        elif command_type == "get_session_stats":
            respond(
                request_id,
                "get_session_stats",
                {
                    "sessionFile": "/tmp/fake-session.jsonl",
                    "sessionId": "fake-session",
                    "userMessages": 1,
                    "assistantMessages": len(messages),
                    "toolCalls": 1,
                    "toolResults": 1,
                    "totalMessages": len(messages) + 1,
                    "tokens": {"input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "total": 15},
                    "premiumRequests": 0,
                    "cost": 0.0,
                },
            )
        elif command_type == "get_pending_workflow_gates":
            respond(
                request_id,
                "get_pending_workflow_gates",
                {
                    "gates": [
                        {
                            "type": "workflow_gate",
                            "gate_id": "wg_pending_1",
                            "stage": "ralplan",
                            "kind": "approval",
                            "schema": {"type": "object"},
                            "schema_hash": "hash-pending",
                            "created_at": "2026-06-09T00:00:00.000Z",
                            "options": [{"value": "approve", "label": "Approve"}],
                            "required": True,
                            "context": {"title": "Approve?"},
                        }
                    ]
                },
            )
        elif command_type == "export_html":
            respond(request_id, "export_html", {"path": command.get("outputPath") or "/tmp/session.html"})
        elif command_type == "new_session":
            respond(request_id, "new_session", {"cancelled": False})
        elif command_type == "switch_session":
            respond(request_id, "switch_session", {"cancelled": False})
        elif command_type == "branch":
            branch_messages = [{"entryId": command["entryId"], "text": "branch message"}]
            respond(request_id, "branch", {"text": "branch created", "cancelled": False})
        elif command_type == "get_branch_messages":
            respond(request_id, "get_branch_messages", {"messages": branch_messages})
        elif command_type == "get_last_assistant_text":
            respond(request_id, "get_last_assistant_text", {"text": last_assistant_text})
        elif command_type == "set_session_name":
            session_name = command["name"]
            respond(request_id, "set_session_name", {})
        elif command_type in {"steer", "follow_up", "abort"}:
            respond(request_id, command_type, {})
        elif command_type in {"prompt", "abort_and_prompt"}:
            respond(request_id, command_type, {})
            message = command["message"]
            if message == "needs ui":
                print(json.dumps({"type": "workflow_gate", "gate_id": "ui-1", "stage": "input", "kind": "question", "schema": {"type": "string"}, "schema_hash": "hash-ui-1", "created_at": "2026-06-09T00:00:00.000Z", "context": {"method": "input", "title": "Need input"}}), flush=True)
                print(json.dumps({"type": "extension_ui_request", "id": "ui-1", "method": "input", "title": "Need input", "placeholder": "value"}), flush=True)
                continue
            if message == "needs confirm":
                print(json.dumps({"type": "workflow_gate", "gate_id": "ui-2", "stage": "confirm", "kind": "approval", "schema": {"type": "boolean"}, "schema_hash": "hash-ui-2", "created_at": "2026-06-09T00:00:00.000Z", "context": {"method": "confirm", "title": "Confirm", "message": "Continue?"}}), flush=True)
                print(json.dumps({"type": "extension_ui_request", "id": "ui-2", "method": "confirm", "title": "Confirm", "message": "Continue?"}), flush=True)
                continue
            if message == "needs select":
                print(json.dumps({"type": "workflow_gate", "gate_id": "ui-select", "stage": "select", "kind": "question", "schema": {"type": "string", "enum": ["alpha", "beta"]}, "schema_hash": "hash-ui-select", "created_at": "2026-06-09T00:00:00.000Z", "options": [{"value": "alpha", "label": "Alpha"}, {"value": "beta", "label": "Beta"}], "required": True, "context": {"method": "select", "title": "Pick"}}), flush=True)
                print(json.dumps({"type": "extension_ui_request", "id": "ui-select", "method": "select", "title": "Pick", "options": ["alpha", "beta"]}), flush=True)
                continue
            if message == "needs cancel":
                print(json.dumps({"type": "extension_ui_request", "id": "ui-3", "method": "editor", "title": "Edit", "placeholder": "value"}), flush=True)
                continue
            if message == "needs open url":
                print(json.dumps({"type": "extension_ui_request", "id": "ui-4", "method": "open_url", "url": "https://example.com/oauth", "instructions": "Open this URL to continue login."}), flush=True)
                emit_prompt_turn("url emitted")
                continue
            if message == "needs host tool":
                emit_event({"type": "agent_start"})
                print(
                    json.dumps(
                        {
                            "type": "host_tool_call",
                            "id": "host-call-1",
                            "toolCallId": "toolu_host_1",
                            "toolName": "echo_host",
                            "arguments": {"message": "hello"},
                        }
                    ),
                    flush=True,
                )
                continue
            if message == "notifications":
                print(json.dumps({"type": "extension_error", "extensionPath": "/tmp/ext.py", "event": "run", "error": "boom"}), flush=True)
                print(json.dumps({"type": "unknown_future_event", "value": 1}), flush=True)
            emit_prompt_turn("pong", delay=0.3 if message == "slow" else 0.0, include_extra_events=message == "all events")
        elif command_type == "host_tool_update":
            emit_event(
                {
                    "type": "tool_execution_update",
                    "toolCallId": "toolu_host_1",
                    "toolName": "echo_host",
                    "args": {"message": "hello"},
                    "partialResult": command["partialResult"],
                }
            )
        elif command_type == "host_tool_result":
            emit_event(
                {
                    "type": "tool_execution_end",
                    "toolCallId": "toolu_host_1",
                    "toolName": "echo_host",
                    "result": command["result"],
                    "isError": command.get("isError", False),
                }
            )
            emit_event({"type": "agent_end", "messages": []})
        else:
            respond(request_id, command_type, success=False, error=f"unsupported: {command_type}")
    """
)

# Echoes every extension_ui_response back as an extension_error frame so tests
# can assert the exact wire command the headless UI handler sends (regression:
# it used to answer UI requests with workflow_gate_response).
HEADLESS_UI_ECHO_SERVER = textwrap.dedent(
    """
    import json
    import sys

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\\n")
        sys.stdout.flush()

    def emit_event(event, seq):
        emit({
            "type": "event",
            "protocol_version": 2,
            "session_id": "fake-session",
            "seq": seq,
            "frame_id": "frame-%d" % seq,
            "payload": {"event_type": event.get("type"), "event": event},
        })

    emit({"type": "ready"})
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        msg = json.loads(raw_line)
        msg_type = msg.get("type")
        if msg_type in {"prompt", "abort_and_prompt"}:
            emit({"id": msg.get("id"), "type": "response", "command": msg_type, "success": True, "data": {}})
            emit_event({"type": "agent_start"}, 1)
            if msg.get("message") == "needs confirm":
                emit({"type": "extension_ui_request", "id": "ui-confirm-1", "method": "confirm", "title": "Confirm", "message": "Continue?"})
            else:
                emit({"type": "extension_ui_request", "id": "ui-input-1", "method": "input", "title": "Need input"})
            continue
        if msg_type == "extension_ui_response":
            emit({"type": "extension_error", "extensionPath": "ui-echo", "event": "extension_ui_response", "error": json.dumps(msg)})
            emit_event({"type": "agent_end", "messages": []}, 2)
            continue
        if msg_type == "workflow_gate_response":
            emit({"id": msg.get("id"), "type": "response", "command": "workflow_gate_response", "success": False, "error": "workflow gates are not available on this session"})
            continue
        emit({"id": msg.get("id"), "type": "response", "command": msg_type, "success": True, "data": {}})
    """
)

POST_READY_SETUP_FAILURE_SERVER = textwrap.dedent(
    """
    import json
    import sys

    print(json.dumps({"type": "ready"}), flush=True)

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        command = json.loads(raw_line)
        if command["type"] in {"set_host_tools", "set_host_uri_schemes"}:
            print(
                json.dumps(
                    {
                        "id": command["id"],
                        "type": "response",
                        "command": command["type"],
                        "success": False,
                        "error": "post-ready setup failed",
                    }
                ),
                flush=True,
            )
    """
)

IDLESS_ERROR_SERVER = textwrap.dedent(
    """
    import json
    import sys

    print(json.dumps({"type": "ready"}), flush=True)

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        command = json.loads(raw_line)
        if command["type"] == "set_host_tools":
            print(
                json.dumps(
                    {
                        "id": command.get("id"),
                        "type": "response",
                        "command": "set_host_tools",
                        "success": True,
                        "data": {"toolNames": []},
                    }
                ),
                flush=True,
            )
            continue
        print(
            json.dumps(
                {
                    "type": "response",
                    "command": command["type"],
                    "success": False,
                    "error": f"unsupported: {command['type']}",
                }
            ),
            flush=True,
        )
    """
)

LATE_PROMPT_FAILURE_SERVER = textwrap.dedent(
    """
    import json
    import sys

    print(json.dumps({"type": "ready"}), flush=True)

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        command = json.loads(raw_line)
        request_id = command.get("id")
        if command["type"] == "set_host_tools":
            print(
                json.dumps(
                    {
                        "id": request_id,
                        "type": "response",
                        "command": "set_host_tools",
                        "success": True,
                        "data": {"toolNames": []},
                    }
                ),
                flush=True,
            )
            continue
        if command["type"] == "prompt":
            print(
                json.dumps(
                    {
                        "id": request_id,
                        "type": "response",
                        "command": "prompt",
                        "success": True,
                    }
                ),
                flush=True,
            )
            print(
                json.dumps(
                    {
                        "id": request_id,
                        "type": "response",
                        "command": "prompt",
                        "success": False,
                        "error": "late failure",
                    }
                ),
                flush=True,
            )
        else:
            print(
                json.dumps(
                    {
                        "id": request_id,
                        "type": "response",
                        "command": command["type"],
                        "success": True,
                    }
                ),
                flush=True,
            )
    """
)

STDERR_SERVER = textwrap.dedent(
    """
    import json
    import sys

    sys.stderr.write("first\\n")
    sys.stderr.flush()
    sys.stderr.write("second\\n")
    sys.stderr.flush()
    print(json.dumps({"type": "ready"}), flush=True)

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        command = json.loads(raw_line)
        if command["type"] == "set_host_tools":
            print(
                json.dumps(
                    {
                        "id": command.get("id"),
                        "type": "response",
                        "command": "set_host_tools",
                        "success": True,
                        "data": {"toolNames": []},
                    }
                ),
                flush=True,
            )
    """
)

INVALID_JSON_SERVER = textwrap.dedent(
    """
    import sys

    sys.stdout.write('{"type":"ready"}\\n')
    sys.stdout.flush()
    sys.stdout.write('{"type":"broken"\\n')
    sys.stdout.flush()
    """
)

BROKEN_STARTUP_SERVER = textwrap.dedent(
    """
    import sys

    sys.stdout.write('not-json\\n')
    sys.stdout.flush()
    """
)


class RpcClientTests(unittest.TestCase):
    def make_client(self, server: str = FAKE_SERVER, **kwargs: object) -> RpcClient:
        return RpcClient(command=[sys.executable, "-u", "-c", server], startup_timeout=2.0, request_timeout=2.0, **kwargs)

    def test_command_builder_supports_common_rpc_options(self) -> None:
        client = RpcClient(
            executable="gjc",
            model="openrouter/anthropic/claude-sonnet-4.6",
            cwd="/tmp/workspace",
            thinking="high",
            append_system_prompt="extra instructions",
            provider_session_id="provider-session-1",
            tools=("read", "edit", "write"),
            no_session=True,
            no_skills=True,
            no_rules=True,
            extra_args=("--foo", "bar"),
        )

        self.assertEqual(
            client.command,
            (
                "gjc",
                "--mode",
                "rpc",
                "--model",
                "openrouter/anthropic/claude-sonnet-4.6",
                "--thinking",
                "high",
                "--append-system-prompt",
                "extra instructions",
                "--provider-session-id",
                "provider-session-1",
                "--tools",
                "read,edit,write",
                "--no-session",
                "--no-skills",
                "--no-rules",
                "--no-title",
                "--foo",
                "bar",
            ),
        )

    def test_get_state_and_bash(self) -> None:
        with self.make_client() as client:
            state = client.get_state()
            self.assertEqual(state.session_id, "fake-session")
            self.assertEqual(state.model.id if state.model else None, "claude-sonnet-4-5")

            result = client.bash("echo hello")
            self.assertEqual(result.output, "hello\n")
            self.assertEqual(result.exit_code, 0)

    def test_prompt_and_wait_returns_assistant_text(self) -> None:
        with self.make_client() as client:
            turn = client.prompt_and_wait("say hello", timeout=2.0)
            self.assertEqual(turn.require_assistant_text(), "pong")
            self.assertGreaterEqual(len(turn.events), 3)

    def test_custom_tools_are_registered_and_executed_via_rpc(self) -> None:
        def echo_host(args: dict[str, str], context) -> str:
            context.send_update(f"working:{args['message']}")
            return f"host:{args['message']}"

        with self.make_client(
            custom_tools=(
                host_tool(
                    name="echo_host",
                    description="Echo from the Python host process",
                    parameters={
                        "type": "object",
                        "properties": {"message": {"type": "string"}},
                        "required": ["message"],
                        "additionalProperties": False,
                    },
                    execute=echo_host,
                ),
            )
        ) as client:
            state = client.get_state()
            self.assertEqual(state.dump_tools[-1].name, "echo_host")

            turn = client.prompt_and_wait("needs host tool", timeout=2.0)
            update_events = [event for event in turn.events if getattr(event, "type", None) == "tool_execution_update"]
            end_events = [event for event in turn.events if getattr(event, "type", None) == "tool_execution_end"]

            self.assertEqual(len(update_events), 1)
            self.assertEqual(update_events[0].partial_result["content"][0]["text"], "working:hello")
            self.assertEqual(len(end_events), 1)
            self.assertEqual(end_events[0].result["content"][0]["text"], "host:hello")

    def test_post_ready_setup_failure_stops_process_and_clears_client_state(self) -> None:
        setups = (
            (
                "custom_tools",
                "set_host_tools",
                {
                    "custom_tools": (
                        host_tool(
                            name="startup_tool",
                            description="Fails during startup registration",
                            parameters={"type": "object"},
                            execute=lambda _args, _context: "unused",
                        ),
                    )
                },
            ),
            (
                "host_uris",
                "set_host_uri_schemes",
                {
                    "host_uris": (
                        host_uri(
                            scheme="startup",
                            read=lambda _url, _context: "unused",
                        ),
                    )
                },
            ),
        )

        for setup, command, kwargs in setups:
            with self.subTest(setup=setup):
                client = self.make_client(server=POST_READY_SETUP_FAILURE_SERVER, **kwargs)
                stopped_processes = []
                stop = client.stop

                def capture_stop() -> None:
                    if client._process is not None:
                        stopped_processes.append(client._process)
                    stop()

                client.stop = capture_stop  # type: ignore[method-assign]

                with self.assertRaises(RpcCommandError) as ctx:
                    client.start()

                self.assertEqual(ctx.exception.command, command)
                self.assertEqual(ctx.exception.error, "post-ready setup failed")
                self.assertEqual(len(stopped_processes), 1)
                self.assertIsNotNone(stopped_processes[0].poll())
                self.assertIsNone(client._process)
                self.assertIsNone(client._stdout_thread)
                self.assertIsNone(client._stderr_thread)
                self.assertEqual(client._pending, {})
    def test_extension_ui_round_trip(self) -> None:
        with self.make_client() as client:
            client.prompt("needs ui")
            request = client.next_ui_request(timeout=2.0)
            self.assertEqual(request.method, "input")

            client.send_ui_value(request.id, "approved")
            client.wait_for_idle(timeout=2.0)

    def test_install_headless_ui_cancels_interactive_requests(self) -> None:
        seen_methods: list[str] = []

        with self.make_client() as client:
            client.install_headless_ui(on_request=lambda request: seen_methods.append(request.method))
            client.prompt_and_wait("needs ui", timeout=2.0)

        self.assertEqual(seen_methods, ["input"])

    def test_install_headless_ui_answers_input_via_extension_ui_response(self) -> None:
        echoes: list[dict] = []
        done = threading.Event()

        with self.make_client(server=HEADLESS_UI_ECHO_SERVER) as client:
            client.on_extension_error(lambda event: (echoes.append(json.loads(event.error)), done.set()))
            client.install_headless_ui(input_value="approved")
            client.prompt_and_wait("needs ui", timeout=2.0)
            self.assertTrue(done.wait(timeout=2.0))

        frame = echoes[0]
        self.assertEqual(frame["type"], "extension_ui_response")
        self.assertEqual(frame["id"], "ui-input-1")
        self.assertEqual(frame["value"], "approved")

    def test_install_headless_ui_answers_confirm_via_extension_ui_response(self) -> None:
        echoes: list[dict] = []
        done = threading.Event()

        with self.make_client(server=HEADLESS_UI_ECHO_SERVER) as client:
            client.on_extension_error(lambda event: (echoes.append(json.loads(event.error)), done.set()))
            client.install_headless_ui(confirm=True)
            client.prompt_and_wait("needs confirm", timeout=2.0)
            self.assertTrue(done.wait(timeout=2.0))

        frame = echoes[0]
        self.assertEqual(frame["type"], "extension_ui_response")
        self.assertEqual(frame["id"], "ui-confirm-1")
        self.assertIs(frame["confirmed"], True)

    def test_open_url_ui_request_does_not_tear_down_client(self) -> None:
        seen_methods: list[str] = []

        with self.make_client() as client:
            client.install_headless_ui(on_request=lambda request: seen_methods.append(request.method))
            client.prompt_and_wait("needs open url", timeout=2.0)
            request = client.next_ui_request(timeout=2.0)
            self.assertEqual(request.method, "open_url")
            self.assertEqual(request.url, "https://example.com/oauth")
            self.assertEqual(request.instructions, "Open this URL to continue login.")
            self.assertTrue(request.is_passive())
            # The reader loop must survive the frame: a follow-up request still works.
            state = client.get_state()
            self.assertEqual(state.session_id, "fake-session")

        self.assertEqual(seen_methods, ["open_url"])

    def test_get_pending_workflow_gates_typed(self) -> None:
        with self.make_client() as client:
            gates = client.get_pending_workflow_gates()

        self.assertEqual(len(gates), 1)
        gate = gates[0]
        self.assertEqual(gate.gate_id, "wg_pending_1")
        self.assertEqual(gate.stage, "ralplan")
        assert gate.options is not None
        self.assertEqual(gate.options[0].label, "Approve")
        self.assertTrue(gate.required)

    def test_ready_and_typed_event_listeners(self) -> None:
        ready_types: list[str] = []
        event_types: list[str] = []
        notification_types: list[str] = []
        client = self.make_client()
        client.on_ready(lambda event: ready_types.append(event.type))
        client.on_notification(lambda notification: notification_types.append(notification.type))
        client.on_turn_start(lambda event: event_types.append(event.type))
        client.on_message_update(lambda event: event_types.append(event.type))
        client.on_agent_end(lambda event: event_types.append(event.type))

        try:
            client.start()
            client.prompt_and_wait("say hello", timeout=2.0)
        finally:
            client.stop()

        self.assertEqual(ready_types, ["ready"])
        self.assertEqual(event_types, ["turn_start", "message_update", "agent_end"])
        self.assertIn("ready", notification_types)
        self.assertIn("turn_start", notification_types)
        self.assertIn("agent_end", notification_types)

    def test_set_todos_supports_flat_items(self) -> None:
        with self.make_client() as client:
            phases = client.set_todos(["Map tools", "Exercise edits"])

            self.assertEqual(len(phases), 1)
            self.assertEqual(phases[0].name, "Todos")
            self.assertEqual(phases[0].tasks[0].content, "Map tools")
            self.assertEqual(phases[0].tasks[1].status, "pending")

            state = client.get_state()
            self.assertEqual(state.todo_phases[0].tasks[1].content, "Exercise edits")

    def test_model_mode_and_session_commands(self) -> None:
        with self.make_client() as client:
            model = client.set_model("anthropic", "claude-sonnet-4-6")
            self.assertEqual(model.id, "claude-sonnet-4-6")

            cycled = client.cycle_model()
            self.assertIsNotNone(cycled)
            self.assertEqual(cycled.model.id, "claude-sonnet-4-5")

            available = client.get_available_models()
            self.assertEqual([item.id for item in available], ["claude-sonnet-4-5", "claude-sonnet-4-6"])

            client.set_thinking_level("high")
            self.assertEqual(client.get_state().thinking_level, "high")

            cycled_level = client.cycle_thinking_level()
            self.assertIsNotNone(cycled_level)
            self.assertEqual(cycled_level.level, "low")

            client.set_steering_mode("all")
            client.set_follow_up_mode("all")
            client.set_interrupt_mode("wait")
            client.set_auto_compaction(False)
            client.set_auto_retry(False)
            client.set_session_name("Renamed")

            state = client.get_state()
            self.assertEqual(state.steering_mode, "all")
            self.assertEqual(state.follow_up_mode, "all")
            self.assertEqual(state.interrupt_mode, "wait")
            self.assertFalse(state.auto_compaction_enabled)
            self.assertEqual(state.session_name, "Renamed")

            compacted = client.compact()
            self.assertEqual(compacted.summary, "trimmed")

            stats = client.get_session_stats()
            self.assertEqual(stats.session_id, "fake-session")
            self.assertEqual(stats.tokens.total, 15)

            exported = client.export_html("/tmp/custom.html")
            self.assertEqual(str(exported), "/tmp/custom.html")

            new_session = client.new_session()
            switched = client.switch_session("/tmp/session.jsonl")
            self.assertFalse(new_session.cancelled)
            self.assertFalse(switched.cancelled)

            branch = client.branch("entry-9")
            self.assertEqual(branch.text, "branch created")
            branch_messages = client.get_branch_messages()
            self.assertEqual(branch_messages[0].entry_id, "entry-9")

    def test_message_and_control_commands(self) -> None:
        with self.make_client() as client:
            turn = client.prompt_and_wait("say hello", timeout=2.0)
            self.assertEqual(turn.require_assistant_text(), "pong")
            self.assertEqual(client.get_last_assistant_text(), "pong")

            messages = client.get_messages()
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0]["role"], "assistant")

            client.clear_todos()
            self.assertEqual(client.get_todos(), ())

            client.steer("nudge")
            client.follow_up("later")
            client.abort()
            client.abort_retry()
            client.abort_bash()

            client.abort_and_prompt("say hello")
            client.wait_for_idle(timeout=2.0)
            self.assertEqual(client.get_last_assistant_text(), "pong")

    def test_collect_events_returns_turn_events(self) -> None:
        with self.make_client() as client:
            client.prompt("slow")
            events = client.collect_events(timeout=2.0)

        self.assertGreaterEqual(len(events), 1)
        self.assertEqual(events[-1].type, "agent_end")

    def test_all_typed_event_listeners_receive_eventful_prompt(self) -> None:
        seen: list[str] = []

        with self.make_client() as client:
            client.on_event(lambda event: seen.append(f"event:{event.type}"))
            client.on_agent_start(lambda event: seen.append(event.type))
            client.on_turn_end(lambda event: seen.append(event.type))
            client.on_message_start(lambda event: seen.append(event.type))
            client.on_message_end(lambda event: seen.append(event.type))
            client.on_tool_execution_start(lambda event: seen.append(event.type))
            client.on_tool_execution_update(lambda event: seen.append(event.type))
            client.on_tool_execution_end(lambda event: seen.append(event.type))
            client.on_auto_compaction_start(lambda event: seen.append(event.type))
            client.on_auto_compaction_end(lambda event: seen.append(event.type))
            client.on_auto_retry_start(lambda event: seen.append(event.type))
            client.on_auto_retry_end(lambda event: seen.append(event.type))
            client.on_retry_fallback_applied(lambda event: seen.append(event.type))
            client.on_retry_fallback_succeeded(lambda event: seen.append(event.type))
            client.on_ttsr_triggered(lambda event: seen.append(event.type))
            client.on_todo_reminder(lambda event: seen.append(event.type))
            client.on_todo_auto_clear(lambda event: seen.append(event.type))

            turn = client.prompt_and_wait("all events", timeout=2.0)

        self.assertEqual(turn.require_assistant_text(), "pong")
        for expected in [
            "agent_start",
            "message_start",
            "message_end",
            "turn_end",
            "tool_execution_start",
            "tool_execution_update",
            "tool_execution_end",
            "auto_compaction_start",
            "auto_compaction_end",
            "auto_retry_start",
            "auto_retry_end",
            "retry_fallback_applied",
            "retry_fallback_succeeded",
            "ttsr_triggered",
            "todo_reminder",
            "todo_auto_clear",
        ]:
            self.assertIn(expected, seen)

    def test_extension_and_unknown_notification_listeners(self) -> None:
        seen_extension_errors: list[str] = []
        seen_unknown: list[str] = []

        with self.make_client() as client:
            client.on_extension_error(lambda event: seen_extension_errors.append(event.error))
            client.on_unknown_notification(lambda event: seen_unknown.append(str(event.payload.get("type"))))
            client.prompt_and_wait("notifications", timeout=2.0)

        self.assertEqual(seen_extension_errors, ["boom"])
        self.assertEqual(seen_unknown, ["unknown_future_event"])

    def test_workflow_gate_round_trip_and_validation(self) -> None:
        seen_gates: list[str] = []
        with self.make_client() as client:
            client.on_workflow_gate(lambda gate: seen_gates.append(f"{gate.gate_id}:{gate.kind}"))
            client.prompt("needs select")
            gate = client.next_workflow_gate(timeout=2.0)
            request = client.next_ui_request(timeout=2.0)

            self.assertEqual(gate.gate_id, request.id)
            self.assertEqual(gate.kind, "question")
            self.assertEqual(gate.schema, {"type": "string", "enum": ["alpha", "beta"]})
            assert gate.options is not None
            self.assertEqual([option.value for option in gate.options], ["alpha", "beta"])
            self.assertEqual([option.label for option in gate.options], ["Alpha", "Beta"])
            self.assertTrue(gate.required)
            with self.assertRaises(RpcCommandError) as invalid:
                client.send_workflow_gate_response(gate.gate_id, "gamma")
            self.assertIn("invalid_workflow_gate_response", str(invalid.exception))

            client.send_workflow_gate_response(gate.gate_id, "alpha")
            client.wait_for_idle(timeout=2.0)

        self.assertEqual(seen_gates, ["ui-select:question"])

    def test_ui_confirmation_and_cancel_round_trip(self) -> None:
        with self.make_client() as client:
            client.prompt("needs confirm")
            confirm_request = client.next_ui_request(timeout=2.0)
            self.assertEqual(confirm_request.method, "confirm")
            client.send_workflow_gate_response(confirm_request.id, True)
            client.wait_for_idle(timeout=2.0)

            client.prompt("needs cancel")
            editor_request = client.next_ui_request(timeout=2.0)
            self.assertEqual(editor_request.method, "editor")
            client.cancel_ui_request(editor_request.id)
            client.wait_for_idle(timeout=2.0)

    def test_prompt_lifecycle_collectors_are_single_flight(self) -> None:
        results: list[str] = []
        errors: list[BaseException] = []

        with self.make_client() as client:
            def run_prompt() -> None:
                try:
                    results.append(client.prompt_and_wait("slow", timeout=2.0).require_assistant_text())
                except BaseException as exc:  # pragma: no cover - defensive thread capture
                    errors.append(exc)

            thread = threading.Thread(target=run_prompt)
            thread.start()

            deadline = time.time() + 1.0
            while client._prompt_lifecycle.active_operation != "prompt_and_wait" and time.time() < deadline:
                time.sleep(0.01)

            self.assertEqual(client._prompt_lifecycle.active_operation, "prompt_and_wait")
            with self.assertRaises(RpcConcurrencyError):
                client.collect_events(timeout=1.0)

            thread.join(timeout=2.0)
            self.assertFalse(thread.is_alive())

        self.assertEqual(errors, [])
        self.assertEqual(results, ["pong"])

    def test_listener_mutation_does_not_change_retained_turn(self) -> None:
        with self.make_client() as client:
            client.on_message_end(lambda event: event.message["content"].__setitem__(0, {"type": "text", "text": "mutated"}))
            turn = client.prompt_and_wait("say hello", timeout=2.0)
            messages = client.get_messages()

        self.assertEqual(turn.require_assistant_text(), "pong")
        self.assertEqual(messages[0]["content"][0]["text"], "pong")

    def test_id_less_error_responses_are_correlated(self) -> None:
        with self.make_client(server=IDLESS_ERROR_SERVER) as client:
            with self.assertRaises(RpcCommandError) as ctx:
                client.request_raw("unknown")

        self.assertEqual(ctx.exception.command, "unknown")
        self.assertEqual(ctx.exception.error, "unsupported: unknown")

    def test_prompt_and_wait_raises_for_late_prompt_failure(self) -> None:
        protocol_errors: list[str] = []
        client = self.make_client(server=LATE_PROMPT_FAILURE_SERVER)
        client.on_protocol_error(lambda error: protocol_errors.append(str(error)))

        try:
            client.start()
            with self.assertRaises(RpcCommandError) as ctx:
                client.prompt_and_wait("say hello", timeout=2.0)
        finally:
            client.stop()

        self.assertEqual(ctx.exception.command, "prompt")
        self.assertEqual(ctx.exception.error, "late failure")
        self.assertEqual(len(protocol_errors), 1)
        self.assertIn("late failure", protocol_errors[0])
        self.assertEqual(len(client.protocol_errors), 1)

    def test_listener_exceptions_are_reported_without_stopping_client(self) -> None:
        listener_errors: list[tuple[str, str | None, str]] = []
        client = self.make_client()
        client.on_notification(
            lambda notification: (_ for _ in ()).throw(RuntimeError("boom"))
            if notification.type == "turn_start"
            else None
        )
        client.on_listener_error(
            lambda event: listener_errors.append((event.listener_kind, event.source_type, str(event.error)))
        )

        try:
            client.start()
            turn = client.prompt_and_wait("say hello", timeout=2.0)
        finally:
            client.stop()

        self.assertEqual(turn.require_assistant_text(), "pong")
        self.assertEqual(listener_errors, [("notification", "turn_start", "boom")])
        self.assertEqual(len(client.listener_errors), 1)
        self.assertEqual(client.listener_errors[0].listener_kind, "notification")

    def test_stderr_history_is_bounded(self) -> None:
        client = self.make_client(server=STDERR_SERVER, max_stderr_chunks=1)

        try:
            client.start()
        finally:
            client.stop()

        self.assertEqual(client.stderr, "second\n")

    def test_broken_startup_frame_is_reported(self) -> None:
        client = self.make_client(server=BROKEN_STARTUP_SERVER)

        with self.assertRaises(RpcError) as ctx:
            client.start()

        self.assertIn("Frame: 'not-json'", str(ctx.exception))

    def test_event_history_limit_reports_overflow(self) -> None:
        with self.make_client(max_event_history=2) as client:
            with self.assertRaises(RpcError) as ctx:
                client.prompt_and_wait("say hello", timeout=2.0)

        self.assertIn("max_event_history", str(ctx.exception))



HANGING_SERVER = textwrap.dedent(
    """
    import json
    import sys

    print(json.dumps({"type": "ready"}), flush=True)
    # Read one line (the prompt) and acknowledge it, then never emit agent_end.
    # The client's prompt_and_wait should sit in _wait_for_agent_end forever
    # unless stop() unblocks it.
    line = sys.stdin.readline()
    if line:
        command = json.loads(line)
        if command.get("type") == "prompt":
            print(
                json.dumps(
                    {
                        "id": command["id"],
                        "type": "response",
                        "command": "prompt",
                        "success": True,
                    }
                ),
                flush=True,
            )
    # Block forever on stdin so the subprocess does not exit on its own.
    sys.stdin.read()
    """
)


class StopUnblocksPromptAndWaitTests(unittest.TestCase):
    """Regression: stop() must wake `_wait_for_agent_end` immediately.

    Previously, the stdout reader's "if not self._stopping:" guard caused
    `_mark_closed` to be skipped after stop(), so `_closed_error` stayed
    `None` and `_wait_for_agent_end` blocked on its condition variable until
    the prompt timeout. The fix sets `_closed_error` from `stop()` itself.
    """

    def test_stop_during_prompt_unblocks_waiter(self) -> None:
        from gjc_rpc import RpcProcessExitError

        client = RpcClient(
            command=[sys.executable, "-u", "-c", HANGING_SERVER],
            startup_timeout=2.0,
            request_timeout=2.0,
        )
        client.start()
        try:
            errors: list[BaseException] = []

            def run_prompt() -> None:
                try:
                    # 30s is more than enough to let stop() race in; if the
                    # bug regresses, the worker hangs the full 30s.
                    client.prompt_and_wait("hang", timeout=30.0)
                except BaseException as exc:
                    errors.append(exc)

            thread = threading.Thread(target=run_prompt)
            thread.start()

            # Wait until the prompt is in flight.
            deadline = time.time() + 2.0
            while client._prompt_lifecycle.active_operation != "prompt_and_wait" and time.time() < deadline:
                time.sleep(0.01)
            self.assertEqual(client._prompt_lifecycle.active_operation, "prompt_and_wait")

            t0 = time.time()
            client.stop()
            thread.join(timeout=2.0)
            elapsed = time.time() - t0

            self.assertFalse(thread.is_alive(), "prompt_and_wait did not return after stop()")
            self.assertLess(elapsed, 2.0, f"stop() took {elapsed:.2f}s to unblock prompt_and_wait")
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], RpcProcessExitError)
        finally:
            # stop() is idempotent; safe to call again on cleanup paths.
            client.stop()

if __name__ == "__main__":
    unittest.main()
