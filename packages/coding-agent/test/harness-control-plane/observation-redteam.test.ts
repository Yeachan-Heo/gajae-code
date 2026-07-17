import { describe, expect, it } from "bun:test";
import { observeAgentWireFrame as mapAgentWireFrame } from "../../src/modes/shared/agent-wire/event-observation";

function evt(event: Record<string, unknown>): Record<string, unknown> {
	return { type: "event", payload: { event_type: event.type, event } };
}

function expectNoSecrets(value: unknown, secrets: string[]): void {
	const json = JSON.stringify(value);
	for (const secret of secrets) expect(json).not.toContain(secret);
}

describe("observation red-team mapping", () => {
	it("maps wrapped agent events to expected bounded owner observations", () => {
		expect(mapAgentWireFrame(evt({ type: "agent_start" }))).toMatchObject({
			eventType: "agent_start",
			kind: "rpc_agent_started",
			signal: "SessionStart",
			semantic: true,
			coalesceKey: null,
		});

		expect(
			mapAgentWireFrame(
				evt({
					type: "tool_execution_start",
					toolCallId: "test-1",
					toolName: "bash",
					args: { command: "bun test ./x" },
				}),
			),
		).toMatchObject({
			eventType: "tool_execution_start",
			kind: "rpc_tool_started",
			signal: "test-running",
			semantic: true,
			evidence: { toolId: "test-1", toolName: "bash" },
		});

		expect(
			mapAgentWireFrame(
				evt({
					type: "tool_execution_start",
					toolCallId: "plain-1",
					toolName: "bash",
					args: { command: "echo hi" },
				}),
			),
		).toMatchObject({
			eventType: "tool_execution_start",
			kind: "rpc_tool_started",
			signal: "tool-call",
			semantic: true,
			evidence: { toolId: "plain-1", toolName: "bash" },
		});

		expect(
			mapAgentWireFrame(
				evt({
					type: "tool_execution_end",
					toolCallId: "ok-1",
					toolName: "read",
					result: { details: { status: "ok" } },
				}),
			),
		).toMatchObject({
			eventType: "tool_execution_end",
			kind: "rpc_tool_ended",
			signal: "tool-call",
			severity: "info",
			semantic: true,
			evidence: { toolId: "ok-1", toolName: "read", status: "ok" },
		});

		expect(
			mapAgentWireFrame(
				evt({
					type: "tool_execution_end",
					toolCallId: "err-1",
					toolName: "bash",
					result: { details: { status: "failed" } },
					isError: true,
				}),
			),
		).toMatchObject({
			eventType: "tool_execution_end",
			kind: "rpc_tool_ended",
			signal: "tool-call",
			severity: "warn",
			semantic: true,
			evidence: { toolId: "err-1", toolName: "bash", status: "error" },
		});

		expect(mapAgentWireFrame(evt({ type: "message_update", message: { id: "msg-1" } }))).toMatchObject({
			eventType: "message_update",
			kind: "rpc_message_activity",
			signal: null,
			semantic: false,
			coalesceKey: "message:msg-1",
			evidence: { phase: "message_update", messageId: "msg-1" },
		});
	});

	it("enforces strict event envelope boundary for raw flat agent frames", () => {
		expect(mapAgentWireFrame({ type: "agent_start" })).toBeNull();
		expect(
			mapAgentWireFrame({
				type: "tool_execution_start",
				toolCallId: "raw",
				toolName: "bash",
				args: { command: "bun test" },
			}),
		).toBeNull();
		expect(mapAgentWireFrame({ type: "agent_end", stopReason: "completed" })).toBeNull();
	});

	it("keeps flat control frames observable with bounded evidence", () => {
		expect(
			mapAgentWireFrame({ type: "host_tool_call", id: "h1", toolName: "openExternal", args: { secret: "DROP_ME" } }),
		).toMatchObject({
			frameType: "host_tool_call",
			kind: "rpc_host_tool_call",
			signal: "tool-call",
			evidence: { id: "h1", toolName: "openExternal" },
		});
		expect(
			mapAgentWireFrame({
				type: "host_uri_request",
				id: "u1",
				operation: "open",
				scheme: "file",
				uri: "file://SECRET_URI",
			}),
		).toMatchObject({
			frameType: "host_uri_request",
			kind: "rpc_host_uri_request",
			signal: "tool-call",
			evidence: { id: "u1", operation: "open", scheme: "file" },
		});
		expect(
			mapAgentWireFrame({
				type: "workflow_gate",
				gate_id: "g1",
				kind: "approval",
				stage: "pending",
				prompt: "SECRET_PROMPT",
			}),
		).toMatchObject({
			frameType: "workflow_gate",
			kind: "rpc_workflow_gate",
			signal: null,
			semantic: true,
			evidence: { gate_id: "g1", kind: "approval", stage: "pending" },
		});
		expect(
			mapAgentWireFrame({
				type: "extension_error",
				extensionPath: "/ext",
				event: "activate",
				error: "SECRET_ERROR",
			}),
		).toMatchObject({
			frameType: "extension_error",
			kind: "rpc_extension_error",
			signal: "error",
			semantic: true,
			evidence: { extensionPath: "/ext", event: "activate" },
		});
	});

	it("redacts wrapped tool secrets and long extension error messages from evidence", () => {
		const secrets = ["SECRET_ARG", "SECRET_COMMAND", "SECRET_OUTPUT", "SECRET_EXTENSION_MESSAGE"];
		const started = mapAgentWireFrame(
			evt({
				type: "tool_execution_start",
				toolCallId: "secret-start",
				toolName: "bash",
				args: { command: "echo SECRET_COMMAND", token: "SECRET_ARG" },
			}),
		);
		const ended = mapAgentWireFrame(
			evt({
				type: "tool_execution_end",
				toolCallId: "secret-end",
				toolName: "bash",
				result: { content: [{ type: "text", text: "SECRET_OUTPUT" }], details: { status: "ok" } },
			}),
		);
		const extensionError = mapAgentWireFrame({
			type: "extension_error",
			extensionPath: "/ext",
			event: "activate",
			error: `${"SECRET_EXTENSION_MESSAGE"}${"x".repeat(4096)}`,
		});

		expectNoSecrets(started?.evidence, secrets);
		expectNoSecrets(ended?.evidence, secrets);
		expectNoSecrets(extensionError?.evidence, secrets);
		expect(started).toMatchObject({ evidence: { toolId: "secret-start", toolName: "bash" } });
		expect(ended).toMatchObject({ evidence: { toolId: "secret-end", toolName: "bash", status: "ok" } });
		expect(extensionError).toMatchObject({ evidence: { extensionPath: "/ext", event: "activate" } });
	});

	it("maps wrapped agent_end only to rpc_agent_completed", () => {
		const mapped = mapAgentWireFrame(evt({ type: "agent_end", stopReason: "error", messages: [] }));
		expect(mapped).toMatchObject({
			eventType: "agent_end",
			kind: "rpc_agent_completed",
			signal: "completed",
			semantic: true,
		});
		expect(mapped?.kind).not.toContain("failed");
		expect(mapped?.kind).not.toContain("failure");
	});
});
