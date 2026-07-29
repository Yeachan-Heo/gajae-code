import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "../../../session/agent-session";
import { ToolItemReducer, type ToolItemReducerOptions, type WireNotification } from "../../items/tool-item-reducer";
import { stableValidators } from "../../protocol-source/schema-validators.generated";

const THREAD_ID = "thread-test";
const TURN_ID = "turn-test";

function reducer(clockValues: readonly number[] = [1_000, 1_500, 2_000, 2_500]): ToolItemReducer {
	let index = 0;
	const options: ToolItemReducerOptions = {
		threadId: THREAD_ID,
		turnId: TURN_ID,
		clock: () => clockValues[index++] ?? clockValues.at(-1) ?? 0,
	};
	return new ToolItemReducer(options);
}

function methods(notifications: readonly WireNotification[]): string[] {
	return notifications.map(notification => notification.method);
}

function expectValidNotifications(notifications: readonly WireNotification[]): void {
	for (const notification of notifications) {
		const validator = stableValidators.serverNotificationParams[notification.method];
		expect(validator(notification.params), notification.method).toBe(true);
	}
}

function partial(content: unknown[], responseId = "response-1", timestamp = 1): unknown {
	return {
		role: "assistant",
		content,
		responseId,
		timestamp,
		stopReason: "toolUse",
	};
}

function messageUpdate(inner: unknown, content: unknown[] = [], responseId = "response-1"): AgentSessionEvent {
	return {
		type: "message_update",
		message: partial(content, responseId) as never,
		assistantMessageEvent: inner as never,
	} as Extract<AgentSessionEvent, { type: "message_update" }>;
}

function completed(
	notifications: readonly WireNotification[],
): Extract<WireNotification, { method: "item/completed" }> {
	const notification = notifications.find(
		(candidate): candidate is Extract<WireNotification, { method: "item/completed" }> =>
			candidate.method === "item/completed",
	);
	expect(notification).toBeDefined();
	return notification!;
}

test("reasoning has start-before-delta, duplicate suppression, and a stable completion", () => {
	const r = reducer([100, 200, 300]);
	const firstContent = [{ type: "thinking", thinking: "" }];
	const secondContent = [{ type: "thinking", thinking: "think" }];
	const first = partial(firstContent);
	const second = partial(secondContent);
	const events: AgentSessionEvent[] = [
		messageUpdate({ type: "thinking_start", contentIndex: 0, partial: first }, firstContent),
		messageUpdate({ type: "thinking_delta", contentIndex: 0, delta: "think", partial: second }, secondContent),
		messageUpdate({ type: "thinking_delta", contentIndex: 0, delta: "think", partial: second }, secondContent),
		messageUpdate({ type: "thinking_end", contentIndex: 0, content: "think", partial: second }, secondContent),
	];
	const notifications = events.flatMap(event => r.accept(event));

	expect(methods(notifications)).toEqual(["item/started", "item/reasoning/textDelta", "item/completed"]);
	expect(completed(notifications).params.item).toMatchObject({ type: "reasoning", content: ["think"], summary: [] });
	expect(r.openItemCount).toBe(0);
	expectValidNotifications(notifications);
});

test("command, file, MCP/web search, and plan families use their pinned catalog shapes", () => {
	const command = reducer([1, 2, 3]);
	const commandNotifications = [
		...command.accept({
			type: "tool_execution_start",
			toolCallId: "cmd",
			toolName: "bash",
			args: { command: "echo hi", cwd: "/tmp" },
		}),
		...command.accept({
			type: "tool_execution_update",
			toolCallId: "cmd",
			toolName: "bash",
			args: { command: "echo hi", cwd: "/tmp" },
			partialResult: { content: [{ type: "text", text: "hi" }] },
		}),
		...command.accept({
			type: "tool_execution_end",
			toolCallId: "cmd",
			toolName: "bash",
			result: { content: [{ type: "text", text: "hi" }], details: { exitCode: 0 } },
			isError: false,
		}),
	];
	expect(completed(commandNotifications).params.item).toMatchObject({
		type: "commandExecution",
		status: "completed",
		exitCode: 0,
		aggregatedOutput: "hi",
	});
	expectValidNotifications(commandNotifications);

	const file = reducer([10, 20]);
	const fileNotifications = [
		...file.accept({ type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path: "a.ts" } }),
		...file.accept({
			type: "tool_execution_end",
			toolCallId: "edit-1",
			toolName: "edit",
			result: { details: { changes: [{ path: "a.ts", kind: { type: "update", move_path: null }, diff: "@@" }] } },
			isError: false,
		}),
	];
	expect(completed(fileNotifications).params.item).toMatchObject({
		type: "fileChange",
		status: "completed",
		changes: [{ path: "a.ts", diff: "@@" }],
	});
	expectValidNotifications(fileNotifications);

	const mcp = reducer([30, 40, 50]);
	const mcpNotifications = [
		...mcp.accept({
			type: "tool_execution_start",
			toolCallId: "mcp-1",
			toolName: "mcp__calendar_list_events",
			args: { range: "today" },
		}),
		...mcp.accept({
			type: "tool_execution_update",
			toolCallId: "mcp-1",
			toolName: "mcp__calendar_list_events",
			args: { range: "today" },
			partialResult: { message: "working" },
		}),
		...mcp.accept({
			type: "tool_execution_end",
			toolCallId: "mcp-1",
			toolName: "mcp__calendar_list_events",
			result: { content: ["ok"], structuredContent: null, _meta: null },
			isError: false,
		}),
	];
	expect(completed(mcpNotifications).params.item).toMatchObject({
		type: "mcpToolCall",
		server: "calendar",
		tool: "list_events",
		status: "completed",
		result: { content: ["ok"] },
	});
	expect(methods(mcpNotifications)).toContain("item/mcpToolCall/progress");
	expectValidNotifications(mcpNotifications);

	const web = reducer([60, 70]);
	const webNotifications = [
		...web.accept({
			type: "tool_execution_start",
			toolCallId: "web-1",
			toolName: "web_search",
			args: { query: "weather" },
		}),
		...web.accept({
			type: "tool_execution_end",
			toolCallId: "web-1",
			toolName: "web_search",
			result: { details: { results: [{ title: "forecast" }] } },
			isError: false,
		}),
	];
	expect(completed(webNotifications).params.item).toMatchObject({
		type: "webSearch",
		query: "weather",
		results: [{ title: "forecast" }],
	});
	expectValidNotifications(webNotifications);

	const plan = reducer([80, 90, 100]);
	const planNotifications = [
		...plan.accept({
			type: "todo_reminder",
			todos: [{ content: "write test", status: "in_progress" }],
			attempt: 1,
			maxAttempts: 1,
		}),
		...plan.accept({ type: "todo_auto_clear" }),
		...plan.completeTurn({ kind: "interrupted" }),
	];
	expect(methods(planNotifications)).toEqual(["item/started", "item/plan/delta", "item/plan/delta", "item/completed"]);
	expect(completed(planNotifications).params.item).toMatchObject({ type: "plan", text: "[]" });
	expectValidNotifications(planNotifications);
});

test("model toolcall_start and execution_start produce one logical item", () => {
	const r = reducer([100, 200, 300]);
	const call = { type: "toolCall", id: "logical-1", name: "bash", arguments: { command: "echo one" } };
	const notifications = [
		...r.accept(messageUpdate({ type: "toolcall_start", contentIndex: 0, partial: partial([call]) }, [call])),
		...r.accept({
			type: "tool_execution_start",
			toolCallId: "logical-1",
			toolName: "bash",
			args: { command: "echo one" },
		}),
		...r.accept({
			type: "tool_execution_end",
			toolCallId: "logical-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "one" }] },
			isError: false,
		}),
	];

	expect(notifications.filter(notification => notification.method === "item/started")).toHaveLength(1);
	expect(notifications.filter(notification => notification.method === "item/completed")).toHaveLength(1);
	expect(r.openItemCount).toBe(0);
	expectValidNotifications(notifications);
});

test("tool errors complete their item without terminalizing the turn", () => {
	const r = reducer([1000, 1500]);
	const started = r.accept({
		type: "tool_execution_start",
		toolCallId: "bad",
		toolName: "bash",
		args: { command: "false" },
	});
	const boundary = r.accept({ type: "turn_end", message: partial([]) as never, toolResults: [] });
	const maintenance = [
		...r.accept({ type: "auto_compaction_start", reason: "threshold", action: "context-full" }),
		...r.accept({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 10, errorMessage: "retry" }),
		...r.accept({ type: "auto_retry_end", attempt: 1, success: false, finalError: "retry" }),
	];
	const failed = r.accept({
		type: "tool_execution_end",
		toolCallId: "bad",
		toolName: "bash",
		result: { content: [{ type: "text", text: "failed" }], details: { exitCode: 1 } },
		isError: true,
	});
	const maintenanceEnd = r.accept({ type: "agent_end", messages: [], stopReason: "maintenance" });
	const all = [...started, ...boundary, ...maintenance, ...maintenanceEnd, ...failed];
	expect(boundary).toEqual([]);
	expect(maintenance).toEqual([]);
	expect(maintenanceEnd).toEqual([]);
	expect(methods(failed)).toContain("item/completed");
	expect(completed(failed).params.item).toMatchObject({ type: "commandExecution", status: "failed" });
	// The item reducer must never emit a turn-level lifecycle method: a tool error and a
	// maintenance boundary are item-scoped, so only item/* notifications may appear.
	expect(all.every(notification => notification.method.startsWith("item/"))).toBe(true);
	expect(r.openItemCount).toBe(0);
	expectValidNotifications(all);
});

test("duplicate and late tool lifecycle events are suppressed and replay ordering is deterministic", () => {
	const run = (): readonly WireNotification[] => {
		const r = reducer([100, 200, 300, 400]);
		return [
			...r.accept({
				type: "tool_execution_start",
				toolCallId: "stable",
				toolName: "bash",
				args: { command: "echo stable" },
			}),
			...r.accept({
				type: "tool_execution_update",
				toolCallId: "stable",
				toolName: "bash",
				args: { command: "echo stable" },
				partialResult: { content: [{ type: "text", text: "stable" }] },
			}),
			...r.accept({
				type: "tool_execution_end",
				toolCallId: "stable",
				toolName: "bash",
				result: { content: [{ type: "text", text: "stable" }] },
				isError: false,
			}),
		];
	};
	const first = run();
	const replay = run();
	expect(replay).toEqual(first);

	const late = reducer([1, 2]);
	late.accept({ type: "tool_execution_start", toolCallId: "late", toolName: "bash", args: { command: "echo late" } });
	late.accept({
		type: "tool_execution_end",
		toolCallId: "late",
		toolName: "bash",
		result: { content: [{ type: "text", text: "late" }] },
		isError: false,
	});
	expect(
		late.accept({
			type: "tool_execution_start",
			toolCallId: "late",
			toolName: "bash",
			args: { command: "echo late" },
		}),
	).toEqual([]);
	expect(
		late.accept({
			type: "tool_execution_update",
			toolCallId: "late",
			toolName: "bash",
			args: { command: "echo late" },
			partialResult: { content: [{ type: "text", text: "late" }] },
		}),
	).toEqual([]);
	expect(late.openItemCount).toBe(0);
});

test("item timestamps are emitted in milliseconds, never converted to turn seconds", () => {
	const r = reducer([1_000, 2_500]);
	const notifications = [
		...r.accept({ type: "tool_execution_start", toolCallId: "clock", toolName: "bash", args: { command: "date" } }),
		...r.accept({ type: "tool_execution_end", toolCallId: "clock", toolName: "bash", result: {}, isError: false }),
	];
	const started = notifications.find(notification => notification.method === "item/started");
	const done = notifications.find(notification => notification.method === "item/completed");
	expect(started?.params.startedAtMs).toBe(1_000);
	expect(done?.params.completedAtMs).toBe(2_500);
	// The reducer must pass the ms clock straight through. A seconds conversion would yield 1 and
	// 2.5 here, so these equalities are what actually pin the unit.
	expect(done?.params.completedAtMs).not.toBe(2_500 / 1_000);
	expect(Number.isInteger(done?.params.completedAtMs)).toBe(true);
	expectValidNotifications(notifications);
});

test("a maintenance boundary with an item still open does not complete or terminalize it", () => {
	// Multiple internal GJC turns may live inside ONE Codex turn. A maintenance agent_end is an
	// internal boundary, so an in-flight tool item must survive it and complete only on its own
	// explicit tool_execution_end.
	const r = reducer([1000, 1500, 2000]);
	const started = r.accept({
		type: "tool_execution_start",
		toolCallId: "still-running",
		toolName: "bash",
		args: { command: "sleep 1" },
	});
	expect(methods(started)).toContain("item/started");
	expect(r.openItemCount).toBe(1);

	// The internal boundary arrives while the item is genuinely open.
	const maintenanceEnd = r.accept({ type: "agent_end", messages: [], stopReason: "maintenance" });
	expect(maintenanceEnd).toEqual([]);
	expect(r.openItemCount).toBe(1);

	// Only the tool's own terminal event closes it.
	const finished = r.accept({
		type: "tool_execution_end",
		toolCallId: "still-running",
		toolName: "bash",
		result: { content: [{ type: "text", text: "done" }] },
		isError: false,
	});
	expect(methods(finished)).toContain("item/completed");
	expect(r.openItemCount).toBe(0);
	expectValidNotifications([...started, ...maintenanceEnd, ...finished]);
});

test("a tool call that changes identity under one call id fails closed", () => {
	const r = reducer([1000, 1500]);
	r.accept({ type: "tool_execution_start", toolCallId: "shared", toolName: "bash", args: { command: "ls" } });
	// The same call id arriving as a different tool would silently rewrite the item's catalog type.
	expect(() =>
		r.accept({ type: "tool_execution_start", toolCallId: "shared", toolName: "edit", args: { path: "a.ts" } }),
	).toThrow(/changed identity/u);
});

test("a summary part is announced before the first delta targeting it", () => {
	const r = reducer([100, 200, 300]);
	const summaryContent = [{ type: "thinking", thinking: "" }];
	const withText = [{ type: "thinking", thinking: "summary text" }];
	const events: AgentSessionEvent[] = [
		messageUpdate(
			{ type: "reasoning_summary_start", contentIndex: 0, partial: partial(summaryContent) },
			summaryContent,
		),
		messageUpdate(
			{ type: "reasoning_summary_delta", contentIndex: 0, delta: "summary text", partial: partial(withText) },
			withText,
		),
		messageUpdate(
			{ type: "reasoning_summary_end", contentIndex: 0, content: "summary text", partial: partial(withText) },
			withText,
		),
	];
	const notifications = events.flatMap(event => r.accept(event));
	const emitted = methods(notifications);

	// A delta for summary index 0 is meaningless until the client knows that part exists.
	const partAdded = emitted.indexOf("item/reasoning/summaryPartAdded");
	const firstDelta = emitted.indexOf("item/reasoning/summaryTextDelta");
	expect(partAdded).toBeGreaterThanOrEqual(0);
	expect(firstDelta).toBeGreaterThanOrEqual(0);
	expect(partAdded).toBeLessThan(firstDelta);
	// It is announced exactly once, not per delta.
	expect(emitted.filter(method => method === "item/reasoning/summaryPartAdded")).toHaveLength(1);
	expectValidNotifications(notifications);
});

test("named catalog tools actually emit validated items, not just a mapping claim", () => {
	// Classification advertising a type is worthless if the reducer drops the events: assert the
	// full lifecycle reaches the wire and passes the generated stable validators.
	for (const toolName of ["computer", "generate_image"]) {
		const r = reducer([1_000, 2_000]);
		const started = r.accept({
			type: "tool_execution_start",
			toolCallId: `call-${toolName}`,
			toolName,
			args: { prompt: "do the thing" },
		});
		expect(methods(started), toolName).toContain("item/started");
		expect(r.openItemCount, toolName).toBe(1);

		const finished = r.accept({
			type: "tool_execution_end",
			toolCallId: `call-${toolName}`,
			toolName,
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(methods(finished), toolName).toContain("item/completed");
		// A terminalized item must report its real outcome, not a stale inProgress/success:null.
		expect(completed(finished).params.item, toolName).toMatchObject({
			type: "dynamicToolCall",
			status: "completed",
			success: true,
			tool: toolName,
		});
		expect(r.openItemCount, toolName).toBe(0);
		expectValidNotifications([...started, ...finished]);
	}
});
