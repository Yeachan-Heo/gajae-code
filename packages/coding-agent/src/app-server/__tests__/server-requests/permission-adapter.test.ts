import { expect, test } from "bun:test";
import type { ReviewDecision } from "../../../../vendor/codex-app-server-schema/stable/typescript/ReviewDecision";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
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
		// `edit`/`apply_patch` args carry no unified diff at this seam, so they fail closed.
		["edit", "unmapped"],
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
			// Real child args: AgentSession forwards raw tool arguments, so these are the actual
			// shapes each tool sends rather than a pre-normalized Codex fileChanges map.
			rawInput:
				toolName === "write"
					? { path: "a.ts", content: "x" }
					: toolName === "move"
						? { oldPath: "a.ts", newPath: "b.ts" }
						: toolName === "delete"
							? { path: "a.ts" }
							: toolName === "eval"
								? { cells: [{ language: "py", code: "print(1)" }], cwd: "/tmp" }
								: { command: "echo hi", cwd: "/tmp" },
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

test("real child tool arguments map to protocol-valid approval params", () => {
	// AgentSession forwards raw tool args (`rawInput: args`), so these are the ACTUAL shapes the
	// permission-gated tools send. Each mapped param object must satisfy the generated validator.
	const cases: Array<{
		readonly toolName: string;
		readonly rawInput: Record<string, unknown>;
		readonly method: "execCommandApproval" | "applyPatchApproval";
	}> = [
		{ toolName: "bash", rawInput: { command: "ls -la", cwd: "/tmp" }, method: "execCommandApproval" },
		{ toolName: "write", rawInput: { path: "/tmp/a.ts", content: "hello" }, method: "applyPatchApproval" },
		{ toolName: "delete", rawInput: { path: "/tmp/a.ts" }, method: "applyPatchApproval" },
		{ toolName: "move", rawInput: { oldPath: "/tmp/a.ts", newPath: "/tmp/b.ts" }, method: "applyPatchApproval" },
	];

	for (const { toolName, rawInput, method } of cases) {
		const mapped = mapToolCallToCodexRequest(
			{ toolCallId: `call-${toolName}`, toolName, title: toolName, rawInput },
			{ conversationId: "thread-1" },
		);
		expect(mapped.method, toolName).toBe(method);
		const validate = stableValidators.serverRequestParams[method];
		expect(validate(mapped.params), `${toolName} -> ${method}`).toBe(true);
	}
});

test("patch arguments that cannot yield a pinned FileChange fail closed", () => {
	for (const [toolName, rawInput] of [
		// edit/apply_patch args are mode-dependent and carry no unified diff at this seam.
		["edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }],
		["apply_patch", { input: "*** Begin Patch" }],
		// A supplied map whose members are not pinned FileChange values.
		["write", { fileChanges: { "a.ts": { content: "x" } } }],
		// An empty map would approve nothing while looking valid.
		["write", { fileChanges: {} }],
		// Missing the content a write needs to become an add.
		["write", { path: "a.ts" }],
		// Missing the destination a move needs.
		["move", { oldPath: "a.ts" }],
	] as Array<[string, Record<string, unknown>]>) {
		expect(
			() =>
				mapToolCallToCodexRequest(
					{ toolCallId: "c", toolName, title: toolName, rawInput },
					{ conversationId: "thread-1" },
				),
			`${toolName} ${JSON.stringify(rawInput)}`,
		).toThrow(PermissionAdapterError);
	}
});

test("malformed parsedCmd entries are rejected rather than cast through", () => {
	expect(() =>
		mapToolCallToCodexRequest(
			{
				toolCallId: "c",
				toolName: "bash",
				title: "ls",
				rawInput: { command: "ls", cwd: "/tmp", parsedCmd: [{ type: "read" }] },
			},
			{ conversationId: "thread-1" },
		),
	).toThrow(PermissionAdapterError);
});

test("ambiguous or reason-less denials fail closed instead of becoming a plain rejection", () => {
	const unmappable: ReviewDecision[] = [
		// A denial with no usable rejection reason.
		{ denied: { rejection: "" } } as ReviewDecision,
		{ denied: { rejection: "   " } } as ReviewDecision,
		// A denial carrying an extra discriminator is ambiguous: it is not simply a rejection.
		{ denied: { rejection: "no" }, network_policy_amendment: { network_policy_amendment: {} } } as ReviewDecision,
	];
	for (const decision of unmappable) {
		expect(() => mapReviewDecisionToChildOutcome(decision, options), JSON.stringify(decision)).toThrow(
			PermissionAdapterError,
		);
	}
	// A well-formed denial still maps to the non-persistent rejection option.
	expect(mapReviewDecisionToChildOutcome({ denied: { rejection: "not allowed" } }, options)).toMatchObject({
		outcome: "selected",
		kind: "reject_once",
	});
});

test("eval cells project into a protocol-valid command approval", () => {
	// `eval` is permission-gated and classified as execution, but its input is `cells`, never
	// `command`. Reading `command` made every eval approval throw before reaching Codex.
	const mapped = mapToolCallToCodexRequest(
		{
			toolCallId: "call-eval",
			toolName: "eval",
			title: "eval",
			rawInput: {
				cells: [
					{ language: "py", code: "print(1)" },
					{ language: "js", code: "1+1" },
				],
				cwd: "/tmp",
			},
		},
		{ conversationId: "thread-1" },
	);
	expect(mapped.method).toBe("execCommandApproval");
	const params = mapped.params as { command: string[] };
	// The approval states honestly what will run, per cell.
	expect(params.command).toEqual(["eval", "py:print(1)", "js:1+1"]);
	expect(stableValidators.serverRequestParams.execCommandApproval(mapped.params)).toBe(true);

	// No cells, or a cell without a code body, cannot be represented honestly.
	for (const rawInput of [{ cwd: "/tmp" }, { cells: [], cwd: "/tmp" }, { cells: [{ language: "py" }], cwd: "/tmp" }]) {
		expect(() =>
			mapToolCallToCodexRequest(
				{ toolCallId: "c", toolName: "eval", title: "eval", rawInput },
				{ conversationId: "thread-1" },
			),
		).toThrow(PermissionAdapterError);
	}
});

test("a write that overwrites is not described as an add", () => {
	// WriteTool creates OR overwrites. Claiming `add` for an overwrite tells the approving human the
	// file does not exist, which is a materially different decision.
	const overwrite = mapToolCallToCodexRequest(
		{
			toolCallId: "c",
			toolName: "write",
			title: "write",
			rawInput: { path: "/tmp/a.ts", content: "next", overwrites: true },
		},
		{ conversationId: "thread-1" },
	);
	expect(
		(overwrite.params as { fileChanges: Record<string, { type: string }> }).fileChanges["/tmp/a.ts"],
	).toMatchObject({ type: "update" });
	expect(stableValidators.serverRequestParams.applyPatchApproval(overwrite.params)).toBe(true);

	// With no overwrite signal, a create is still reported as an add.
	const create = mapToolCallToCodexRequest(
		{ toolCallId: "c", toolName: "write", title: "write", rawInput: { path: "/tmp/new.ts", content: "hi" } },
		{ conversationId: "thread-1" },
	);
	expect(
		(create.params as { fileChanges: Record<string, { type: string }> }).fileChanges["/tmp/new.ts"],
	).toMatchObject({
		type: "add",
	});
});
