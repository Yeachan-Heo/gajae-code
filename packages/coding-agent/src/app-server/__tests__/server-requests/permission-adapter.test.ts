import { expect, test } from "bun:test";
import type { ReviewDecision } from "../../../../vendor/codex-app-server-schema/stable/typescript/ReviewDecision";
import {
	mapPermissionRequest,
	mapReviewDecisionToChildOutcome,
	mapToolCallToCodexRequest,
	PermissionAdapter,
	PermissionAdapterError,
} from "../../server-requests/permission-adapter";

const options = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" as const },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" as const },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" as const },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" as const },
];

const commandToolCall = {
	toolCallId: "call-1",
	toolName: "bash",
	title: "echo hi",
	rawInput: {
		command: "echo hi",
		cwd: "/tmp",
		parsedCmd: [{ type: "unknown", cmd: "echo hi" }],
	},
};

const patchToolCall = {
	toolCallId: "call-2",
	toolName: "edit",
	title: "edit file",
	rawInput: { fileChanges: { "a.ts": { type: "update", unified_diff: "@@", move_path: null } } },
};

test("command tool calls map explicitly to execCommandApproval", () => {
	const mapped = mapToolCallToCodexRequest(commandToolCall, {
		conversationId: "conversation-1",
		reason: "needs approval",
		approvalId: "approval-1",
	});
	expect(mapped).toEqual({
		method: "execCommandApproval",
		params: {
			conversationId: "conversation-1",
			callId: "call-1",
			approvalId: "approval-1",
			command: ["echo hi"],
			cwd: "/tmp",
			reason: "needs approval",
			parsedCmd: [{ type: "unknown", cmd: "echo hi" }],
		},
	});
});

test("patch and file-change tool calls map explicitly to applyPatchApproval", () => {
	const mapped = mapToolCallToCodexRequest(patchToolCall, {
		conversationId: "conversation-1",
		grantRoot: "/workspace",
	});
	expect(mapped).toEqual({
		method: "applyPatchApproval",
		params: {
			conversationId: "conversation-1",
			callId: "call-2",
			fileChanges: { "a.ts": { type: "update", unified_diff: "@@", move_path: null } },
			reason: null,
			grantRoot: "/workspace",
		},
	});
});

test("unclassifiable child tool calls fail closed with a typed reason", () => {
	expect(() =>
		mapPermissionRequest(
			{ toolCall: { ...commandToolCall, toolName: "mystery" }, options },
			{ conversationId: "conversation-1" },
		),
	).toThrow(PermissionAdapterError);
	try {
		mapPermissionRequest(
			{ toolCall: { ...commandToolCall, toolName: "mystery" }, options },
			{ conversationId: "conversation-1" },
		);
		throw new Error("Expected mapping to fail.");
	} catch (error) {
		expect(error).toMatchObject({ code: "unmappable_tool_call" });
	}
});

test("every supported ReviewDecision maps to the corresponding child outcome", () => {
	expect(mapReviewDecisionToChildOutcome("approved", options)).toEqual({
		outcome: "selected",
		optionId: "allow_once",
		kind: "allow_once",
	});
	expect(mapReviewDecisionToChildOutcome("approved_for_session", options)).toEqual({
		outcome: "selected",
		optionId: "allow_always",
		kind: "allow_always",
	});
	expect(mapReviewDecisionToChildOutcome({ denied: { rejection: "no" } }, options)).toEqual({
		outcome: "selected",
		optionId: "reject_once",
		kind: "reject_once",
	});
	expect(mapReviewDecisionToChildOutcome("timed_out", options)).toEqual({ outcome: "cancelled" });
	expect(mapReviewDecisionToChildOutcome("abort", options)).toEqual({ outcome: "cancelled" });
});

test("amendment decisions fail closed instead of being coerced into approval", () => {
	const amendments: ReviewDecision[] = [
		{ approved_execpolicy_amendment: { proposed_execpolicy_amendment: {} as never } },
		{ network_policy_amendment: { network_policy_amendment: {} as never } },
	];
	for (const decision of amendments) {
		expect(() => mapReviewDecisionToChildOutcome(decision, options)).toThrow(PermissionAdapterError);
		try {
			mapReviewDecisionToChildOutcome(decision, options);
			throw new Error("Expected amendment mapping to fail.");
		} catch (error) {
			expect(error).toMatchObject({ code: "unmappable_review_decision" });
		}
	}
});

test("adapter requests Codex approval and maps its result back to the offered child option", async () => {
	let requested:
		| {
				method: string;
				params: Record<string, unknown>;
		  }
		| undefined;
	const adapter = new PermissionAdapter({
		conversationId: "conversation-1",
		requestApproval: async (method, params) => {
			requested = { method, params: params as Record<string, unknown> };
			return { decision: "approved_for_session" };
		},
	});
	expect(await adapter.handle({ toolCall: commandToolCall, options })).toEqual({
		outcome: "selected",
		optionId: "allow_always",
		kind: "allow_always",
	});
	expect(requested).toEqual({
		method: "execCommandApproval",
		params: expect.objectContaining({ callId: "call-1", conversationId: "conversation-1" }),
	});
});

test("provider loss during an approval settles the child request as cancelled", async () => {
	const adapter = new PermissionAdapter({
		conversationId: "conversation-1",
		requestApproval: async () => {
			throw new Error("provider disconnected");
		},
	});
	expect(await adapter.handle({ toolCall: commandToolCall, options })).toEqual({ outcome: "cancelled" });
});

test("a cancelled signal settles without contacting the provider", async () => {
	let called = false;
	const adapter = new PermissionAdapter({
		conversationId: "conversation-1",
		requestApproval: async () => {
			called = true;
			return { decision: "approved" };
		},
	});
	const controller = new AbortController();
	controller.abort();
	expect(await adapter.handle({ toolCall: commandToolCall, options }, controller.signal)).toEqual({
		outcome: "cancelled",
	});
	expect(called).toBe(false);
});

test("provider loss signalled by abort settles a hanging approval", async () => {
	const adapter = new PermissionAdapter({
		conversationId: "conversation-1",
		requestApproval: async () => await new Promise<unknown>(() => {}),
	});
	const controller = new AbortController();
	const pending = adapter.handle({ toolCall: commandToolCall, options }, controller.signal);
	controller.abort();
	expect(await pending).toEqual({ outcome: "cancelled" });
});

test("tool classification follows the canonical ACP kind vocabulary, not invented names", () => {
	// `mapToolKind` is the single existing authority. These are the real kinds it produces, so the
	// adapter must agree with it rather than maintaining a second drifting name list.
	const byName: Array<[string, "execCommandApproval" | "applyPatchApproval" | "unmapped"]> = [
		["bash", "execCommandApproval"],
		["shell", "execCommandApproval"],
		["exec", "execCommandApproval"],
		["eval", "execCommandApproval"],
		["write", "applyPatchApproval"],
		["edit", "applyPatchApproval"],
		["delete", "applyPatchApproval"],
		["move", "applyPatchApproval"],
		// Real tool names that map to kinds no Codex approval method represents.
		["read", "unmapped"],
		["search", "unmapped"],
		["web_search", "unmapped"],
		["todo_write", "unmapped"],
		["computer", "unmapped"],
		["generate_image", "unmapped"],
	];

	for (const [toolName, expected] of byName) {
		const toolCall = {
			toolCallId: `call-${toolName}`,
			toolName,
			title: toolName,
			rawInput: { command: "echo hi", cwd: "/tmp", fileChanges: { "a.ts": { add: { content: "x" } } } },
		};
		if (expected === "unmapped") {
			expect(() => mapToolCallToCodexRequest(toolCall, { conversationId: "thread-1" }), toolName).toThrow(
				PermissionAdapterError,
			);
			continue;
		}
		expect(mapToolCallToCodexRequest(toolCall, { conversationId: "thread-1" }).method, toolName).toBe(expected);
	}

	// A declared `kind` wins over the tool name, and an unrepresentable kind fails closed.
	expect(
		mapToolCallToCodexRequest(
			{ toolCallId: "c", toolName: "read", title: "t", kind: "execute", rawInput: { command: "ls", cwd: "/tmp" } },
			{ conversationId: "thread-1" },
		).method,
	).toBe("execCommandApproval");
	expect(() =>
		mapToolCallToCodexRequest(
			{ toolCallId: "c", toolName: "bash", title: "t", kind: "think", rawInput: { command: "ls", cwd: "/tmp" } },
			{ conversationId: "thread-1" },
		),
	).toThrow(PermissionAdapterError);
});
