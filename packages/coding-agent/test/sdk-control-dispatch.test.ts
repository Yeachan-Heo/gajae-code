import { expect, test } from "bun:test";
import { type ControlRequest, type ControlSurface, dispatchControl, TypedControlError } from "../src/sdk/host/control";
import {
	BROKER_RUNTIME_ABORT_CAPABILITY_FIELD,
	redactBrokerRuntimeCapabilities,
	setBrokerRuntimeAbortCapabilityForTest,
} from "../src/sdk/host/control/runtime-gate";
import { OPERATIONS } from "../src/sdk/protocol/operation-registry";

const methodByOperation: Record<string, string> = {
	"turn.prompt": "prompt",
	"turn.steer": "steer",
	"turn.follow_up": "followUp",
	"turn.abort": "abort",
	"turn.abort_and_prompt": "abortAndPrompt",
	"ask.answer": "answerAsk",
	"workflow.gate_answer": "answerGate",
	"workflow.plan_approve": "approvePlan",
	"skill.invoke": "invokeSkill",
	"mode.plan.set": "setPlanMode",
	"mode.goal.operate": "operateGoal",
	"todo.replace": "replaceTodo",
	"model.set": "setModel",
	"model.profile.set": "setModelProfile",
	"model.cycle": "cycleModel",
	"thinking.set": "setThinking",
	"thinking.cycle": "cycleThinking",
	"permission_mode.set": "setPermissionMode",
	"queue.steering_mode.set": "setQueueMode",
	"queue.follow_up_mode.set": "setQueueMode",
	"queue.tool_interrupt_policy.set": "setQueueMode",
	"compaction.run": "runCompaction",
	"compaction.auto.set": "setAutoCompaction",
	"retry.auto.set": "setAutoRetry",
	"retry.abort": "abortRetry",
	"bash.execute": "executeBash",
	"bash.abort": "abortBash",
	"session.new": "newSession",
	"session.fork": "forkSession",
	"session.resume": "resumeSession",
	"session.close": "closeSession",
	"session.switch": "switchSession",
	"session.branch": "branchSession",
	"session.rename": "renameSession",
	"session.handoff": "handoffSession",
	"session.export_html": "exportHtml",
	"config.patch": "patchConfig",
	"runtime.reload": "reloadRuntime",
	"auth.login": "login",
	"host_tools.register": "registerHostTools",
	"host_uri.register": "registerHostUri",
	"service_tier.set": "setServiceTier",
	"tools.active.set": "setActiveTools",
	"queue.message.remove": "removeQueueMessage",
	"queue.message.move": "moveQueueMessage",
	"queue.message.update": "updateQueueMessage",
	"extension.set_enabled": "setExtensionEnabled",
	"context.clear": "clearContext",
	"session.delete": "deleteSession",
	"session.cwd.move": "moveCwd",
	"retry.last": "retryLast",
	"retry.now": "retryNow",
	"bash.background": "backgroundBash",
};

const BROKER_LIFECYCLE_OPERATIONS = new Set([
	"session.new",
	"session.fork",
	"session.resume",
	"session.close",
	"session.switch",
	"session.branch",
	"session.handoff",
	"session.delete",
]);

function request(row: (typeof OPERATIONS)[number]): ControlRequest {
	// turn.abort validates strictly: the generic kitchen-sink input carries
	// `mode: "all"`, which is an invalid mode. Legacy C04 sends `{}` (omitted
	// mode), so the broad fixture uses `{}` for turn.abort.
	const input =
		row.sdkId === "turn.abort"
			? {}
			: {
					text: "text",
					images: [],
					id: "id",
					answer: "answer",
					response: "response",
					choice: "choice",
					name: "name",
					args: [],
					on: true,
					op: "create",
					objective: "goal",
					items: [],
					level: "high",
					mode: "all",
					cmd: "echo hi",
					entryId: "entry",
					target: "target",
					patch: {},
					components: [],
					provider: "provider",
					defs: [],
					tier: "pro",
					names: [],
					before: "before",
					after: "after",
					path: "/tmp",
				};
	return {
		id: row.id,
		operation: row.sdkId,
		input,
		confirm: row.sdkId === "context.clear" || row.sdkId === "session.delete",
	};
}

test("dispatches every control registry operation to its ControlSurface method", async () => {
	const calls: string[] = [];
	const surface = new Proxy(
		{},
		{
			get:
				(_, property) =>
				(..._args: unknown[]) => {
					calls.push(String(property));
					return String(property);
				},
		},
	) as ControlSurface;
	const rows = OPERATIONS.filter(row => row.kind === "control" && !BROKER_LIFECYCLE_OPERATIONS.has(row.sdkId));
	for (const row of rows) {
		const response = await dispatchControl(surface, row, request(row));
		expect(response).toEqual({ id: row.id, ok: true, result: methodByOperation[row.sdkId] });
	}
	expect(calls).toEqual(rows.map(row => methodByOperation[row.sdkId]));
});

test("forwards expectedSessionId only to durable workflow controls", async () => {
	const calls: unknown[][] = [];
	const surface = {
		answerGate: (...args: unknown[]) => {
			calls.push(args);
			return { resolved: true };
		},
		approvePlan: (...args: unknown[]) => {
			calls.push(args);
			return { resolved: true };
		},
	} as unknown as ControlSurface;
	for (const operation of ["workflow.gate_answer", "workflow.plan_approve"]) {
		const row = OPERATIONS.find(candidate => candidate.sdkId === operation)!;
		const response = await dispatchControl(surface, row, {
			...request(row),
			input: {
				id: "gate",
				...(operation === "workflow.gate_answer" ? { response: "approve" } : { choice: "approve" }),
				expectedSessionId: "session",
			},
		});
		expect(response.ok).toBe(true);
	}
	expect(calls).toEqual([
		["gate", "approve", "session"],
		["gate", "approve", "session"],
	]);
});

test("forwards an explicit workflow gate idempotency key", async () => {
	const gate = OPERATIONS.find(operation => operation.sdkId === "workflow.gate_answer")!;
	const calls: unknown[][] = [];
	const surface = {
		answerGate: (...args: unknown[]) => {
			calls.push(args);
			return { resolved: true };
		},
	} as unknown as ControlSurface;

	const response = await dispatchControl(surface, gate, {
		...request(gate),
		input: { id: "gate", response: "approve", expectedSessionId: "session" },
		idempotencyKey: "gate-answer-key",
	});

	expect(response.ok).toBe(true);
	expect(calls).toEqual([["gate", "approve", "session", "gate-answer-key"]]);
});

test("forwards an optional thinking level with model.set without changing legacy calls", async () => {
	const model = OPERATIONS.find(row => row.sdkId === "model.set")!;
	const calls: unknown[][] = [];
	const surface = {
		setModel: (...args: unknown[]) => {
			calls.push(args);
			return { changed: true };
		},
	} as unknown as ControlSurface;

	await dispatchControl(surface, model, { ...request(model), input: { id: "provider/model" } });
	await dispatchControl(surface, model, {
		...request(model),
		input: { id: "provider/model", thinkingLevel: "high" },
	});

	expect(calls).toEqual([
		["provider/model", undefined],
		["provider/model", "high"],
	]);
});

test("session.handoff remains available only through the Broker lifecycle service", async () => {
	const row = OPERATIONS.find(operation => operation.sdkId === "session.handoff")!;
	let called = false;
	const surface = {
		handoffSession: () => {
			called = true;
		},
	} as unknown as ControlSurface;

	const response = await dispatchControl(surface, row, {
		...request(row),
		input: { target: "focus" },
	});

	expect(response.ok).toBe(false);
	expect(response.error?.code).toBe("operation_prohibited");
	expect(response.error?.details).toBeUndefined();
	expect(called).toBe(false);
});

test("rejects an ordinary session.close request before closeSession can mutate the surface", async () => {
	const row = OPERATIONS.find(operation => operation.sdkId === "session.close")!;
	const effects: string[] = [];
	const surface = {
		closeSession: () => {
			effects.push("close");
			return { closed: true };
		},
	} as unknown as ControlSurface;

	const response = await dispatchControl(surface, row, {
		id: "ordinary-close",
		operation: "session.close",
		input: {},
	});

	expect(response).toEqual({
		id: "ordinary-close",
		ok: false,
		error: {
			code: "operation_prohibited",
			message: "session.close is available only through the Broker lifecycle service.",
		},
	});
	expect(effects).toEqual([]);
});

test("dispatches session.close only for the exact Broker runtime capability", () => {
	const dispatchModule = new URL("../src/sdk/host/control/dispatch.ts", import.meta.url).href;
	const registryModule = new URL("../src/sdk/protocol/operation-registry.ts", import.meta.url).href;
	const capability = "broker-close-capability";
	const script = `
		import { dispatchControl } from ${JSON.stringify(dispatchModule)};
		import { OPERATIONS } from ${JSON.stringify(registryModule)};

		const row = OPERATIONS.find(operation => operation.kind === "control" && operation.sdkId === "session.close");
		if (!row) throw new Error("Missing session.close control operation.");
		const calls: Array<string | undefined> = [];
		const surface = {
			closeSession: (receivedCapability?: string) => {
				calls.push(receivedCapability);
				return { receivedCapability };
			},
		};
		const responses = [];
		for (const [id, input] of [
			["ordinary", {}],
			["wrong", { __gjcBrokerCloseCapability: "wrong-capability" }],
			["exact", { __gjcBrokerCloseCapability: ${JSON.stringify(capability)} }],
		] as const) {
			responses.push(await dispatchControl(surface as never, row, { id, operation: "session.close", input }));
		}
		process.stdout.write(JSON.stringify({ calls, responses }));
	`;
	const child = Bun.spawnSync([process.execPath, "-e", script], {
		env: { ...process.env, GJC_LIFECYCLE_REQUEST_ID: capability },
		stdout: "pipe",
		stderr: "pipe",
	});

	expect(child.exitCode, child.stderr.toString()).toBe(0);
	const result = JSON.parse(child.stdout.toString()) as {
		calls: string[];
		responses: Array<{ id: string; ok: boolean; result?: { receivedCapability: string }; error?: { code: string } }>;
	};
	expect(result.calls).toEqual([capability]);
	expect(result.responses).toMatchObject([
		{ id: "ordinary", ok: false, error: { code: "operation_prohibited" } },
		{ id: "wrong", ok: false, error: { code: "operation_prohibited" } },
		{ id: "exact", ok: true, result: { receivedCapability: capability } },
	]);
});

test("non-handoff control failures do not attach handoff details", async () => {
	const row = OPERATIONS.find(operation => operation.sdkId === "session.rename")!;
	const surface = {
		renameSession: () => {
			throw Object.assign(new Error("bad"), { code: "invalid_request", handoffDocument: "leak" });
		},
	} as unknown as ControlSurface;
	const response = await dispatchControl(surface, row, { ...request(row), input: { name: "x" } });
	expect(response.ok).toBe(false);
	expect(response.error?.details).toBeUndefined();
});

test("rejects unknown operations, malformed input, and missing destructive confirmation", async () => {
	const surface = {} as ControlSurface;
	const unknown = await dispatchControl(surface, undefined, { id: "x", operation: "no.such.operation", input: {} });
	expect(unknown.error?.code).toBe("unknown_operation");
	const prompt = OPERATIONS.find(row => row.sdkId === "turn.prompt")!;
	expect((await dispatchControl(surface, prompt, { id: "bad", operation: prompt.sdkId, input: [] })).error?.code).toBe(
		"invalid_input",
	);
	const clear = OPERATIONS.find(row => row.sdkId === "context.clear")!;
	const response = await dispatchControl(surface, clear, { id: "clear", operation: clear.sdkId, input: {} });
	expect(response.error).toMatchObject({ code: "invalid_input" });
	expect(response.error?.message).toContain("confirm");
});

test("returns the current revision on an optimistic concurrency conflict", async () => {
	const tools = OPERATIONS.find(row => row.sdkId === "tools.active.set")!;
	const surface = { revisionProvider: () => "new-revision" } as unknown as ControlSurface;
	const response = await dispatchControl(surface, tools, { ...request(tools), expectedRevision: "old-revision" });
	expect(response.error).toEqual({
		code: "revision_conflict",
		message: "The resource revision has changed.",
		currentRevision: "new-revision",
	});
});

test("serializes ordered operations while retry.now bypasses the session chain", async () => {
	const prompt = OPERATIONS.find(row => row.sdkId === "turn.prompt")!;
	const retryNow = OPERATIONS.find(row => row.sdkId === "retry.now")!;
	const started: string[] = [];
	let releaseFirst!: () => void;
	const first = new Promise<void>(resolve => {
		releaseFirst = resolve;
	});
	const surface = {
		prompt: async (value: string) => {
			started.push(value);
			if (value === "first") await first;
		},
		retryNow: () => {
			started.push("retry");
		},
	} as ControlSurface;
	const one = dispatchControl(surface, prompt, { ...request(prompt), id: "one", input: { text: "first" } });
	const two = dispatchControl(surface, prompt, { ...request(prompt), id: "two", input: { text: "second" } });
	const retry = dispatchControl(surface, retryNow, request(retryNow));
	await retry;
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(started).toEqual(["retry", "first"]);
	releaseFirst();
	await Promise.all([one, two, retry]);
	expect(started).toEqual(["retry", "first", "second"]);
});

test("abort-and-prompt cancels pending preflight but waits for prior ordered controls", async () => {
	const prompt = OPERATIONS.find(row => row.sdkId === "turn.prompt")!;
	const model = OPERATIONS.find(row => row.sdkId === "model.set")!;
	const replacement = OPERATIONS.find(row => row.sdkId === "turn.abort_and_prompt")!;
	const promptStarted = Promise.withResolvers<void>();
	const modelStarted = Promise.withResolvers<void>();
	const preflight = Promise.withResolvers<void>();
	const longModelOperation = Promise.withResolvers<void>();
	const calls: string[] = [];
	const surface = {
		prompt: async () => {
			calls.push("prompt");
			promptStarted.resolve();
			await preflight.promise;
		},
		setModel: async () => {
			calls.push("model");
			modelStarted.resolve();
			await longModelOperation.promise;
		},
		abortAndPrompt: () => {
			calls.push("replacement");
		},
		cancelPendingPreflights: () => {
			calls.push("cancel");
			preflight.resolve();
		},
	} as unknown as ControlSurface;
	const initial = dispatchControl(surface, prompt, { ...request(prompt), input: { text: "pending" } });
	await promptStarted.promise;
	const ordered = dispatchControl(surface, model, request(model));
	const replace = dispatchControl(surface, replacement, { ...request(replacement), input: { text: "replace" } });

	expect(calls).toEqual(["prompt", "cancel"]);
	await modelStarted.promise;
	expect(calls).toEqual(["prompt", "cancel", "model"]);
	longModelOperation.resolve();
	await Promise.all([initial, ordered, replace]);
	expect(calls).toEqual(["prompt", "cancel", "model", "replacement"]);
});

test("serializes concurrent abort-and-prompt replacements after preflight cancellation", async () => {
	const replacement = OPERATIONS.find(row => row.sdkId === "turn.abort_and_prompt")!;
	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const calls: string[] = [];
	const surface = {
		abortAndPrompt: async (text: string) => {
			calls.push(`replacement:${text}`);
			if (text === "first") {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
		},
		cancelPendingPreflights: () => calls.push("cancel"),
	} as unknown as ControlSurface;
	const first = dispatchControl(surface, replacement, {
		...request(replacement),
		id: "first",
		input: { text: "first" },
	});
	const second = dispatchControl(surface, replacement, {
		...request(replacement),
		id: "second",
		input: { text: "second" },
	});
	expect(calls).toEqual(["cancel", "cancel"]);
	await firstStarted.promise;
	expect(calls).toEqual(["cancel", "cancel", "replacement:first"]);
	releaseFirst.resolve();
	await Promise.all([first, second]);
	expect(calls).toEqual(["cancel", "cancel", "replacement:first", "replacement:second"]);
});

test("preserves typed registry errors and maps unknown failures to internal", async () => {
	const tools = OPERATIONS.find(row => row.sdkId === "tools.active.set")!;
	const typed = await dispatchControl(
		{
			setActiveTools: () => {
				throw { code: "unknown_tool", message: "Tool is unavailable." };
			},
		} as unknown as ControlSurface,
		tools,
		request(tools),
	);
	expect(typed.error).toEqual({ code: "unknown_tool", message: "Tool is unavailable." });
	const internal = await dispatchControl(
		{
			setActiveTools: () => {
				throw new Error("database exploded");
			},
		} as unknown as ControlSurface,
		tools,
		request(tools),
	);
	expect(internal.error).toEqual({ code: "internal", message: "Control operation failed." });
	const steer = OPERATIONS.find(row => row.sdkId === "turn.steer")!;
	const conflict = await dispatchControl(
		{
			steer: () => {
				throw { code: "client_ref_conflict", message: "clientRef is already bound to different steer text." };
			},
		} as unknown as ControlSurface,
		steer,
		request(steer),
	);
	expect(conflict.error).toEqual({
		code: "client_ref_conflict",
		message: "clientRef is already bound to different steer text.",
	});
});

test("preserves action_claimed workflow fences through control dispatch", async () => {
	const gate = OPERATIONS.find(row => row.sdkId === "workflow.gate_answer")!;
	const response = await dispatchControl(
		{
			answerGate: () => {
				throw { code: "action_claimed", message: "The active action is already being answered." };
			},
		} as unknown as ControlSurface,
		gate,
		{ ...request(gate), input: { id: "gate", response: "approve", expectedSessionId: "session" } },
	);
	expect(response.error).toEqual({ code: "action_claimed", message: "The active action is already being answered." });
});

test("preserves terminal uncertainty through C07 and C08 control dispatch", async () => {
	for (const [operation, method, input] of [
		["workflow.gate_answer", "answerGate", { id: "gate", response: "approve", expectedSessionId: "session" }],
		["workflow.plan_approve", "approvePlan", { id: "plan", choice: "approve", expectedSessionId: "session" }],
	] as const) {
		const row = OPERATIONS.find(candidate => candidate.sdkId === operation)!;
		const response = await dispatchControl(
			{
				[method]: () => {
					throw { code: "terminal_uncertain", message: "Durable workflow resolution is uncertain." };
				},
			} as unknown as ControlSurface,
			row,
			{ ...request(row), input },
		);
		expect(response.error).toEqual({
			code: "terminal_uncertain",
			message: "Durable workflow resolution is uncertain.",
		});
	}
});

test("bounds default model selection recovery details on the SDK error", async () => {
	const model = OPERATIONS.find(row => row.sdkId === "model.set")!;
	const response = await dispatchControl(
		{
			setModel: () => {
				throw {
					code: "default_model_selection_recovery",
					message: "private failure text",
					recovery: {
						message: "private failure text",
						rollback: {
							disposition: "partial",
							failures: [{ stage: "durable", message: "private durable text" }],
						},
					},
				};
			},
		} as unknown as ControlSurface,
		model,
		request(model),
	);

	expect(response.error).toEqual({
		code: "default_model_selection_recovery",
		message: "Default model selection could not be completed after durable selection.",
		details: {
			message: "Default model selection could not be completed after durable selection.",
			rollback: {
				disposition: "partial",
				failures: [{ stage: "durable", message: "Durable default selection recovery could not be completed." }],
			},
		},
	});
});

test("replays matching idempotency requests, rejects conflicts, and evicts LRU entries", async () => {
	const abort = OPERATIONS.find(row => row.sdkId === "turn.abort")!;
	let calls = 0;
	const surface = { abort: () => ++calls } as unknown as ControlSurface;
	const first = await dispatchControl(surface, abort, {
		id: "one",
		operation: abort.sdkId,
		input: { b: 2, a: 1 },
		idempotencyKey: "same",
	});
	const replay = await dispatchControl(surface, abort, {
		id: "two",
		operation: abort.sdkId,
		input: { a: 1, b: 2 },
		idempotencyKey: "same",
	});
	expect([first, replay]).toEqual([
		{ id: "one", ok: true, result: 1 },
		{ id: "two", ok: true, result: 1 },
	]);
	expect(
		await dispatchControl(surface, abort, {
			id: "conflict",
			operation: abort.sdkId,
			input: { a: 3 },
			idempotencyKey: "same",
		}),
	).toMatchObject({ error: { code: "idempotency_conflict" } });
	for (let index = 0; index < 256; index++)
		await dispatchControl(surface, abort, {
			id: `id-${index}`,
			operation: abort.sdkId,
			input: {},
			idempotencyKey: `key-${index}`,
		});
	await dispatchControl(surface, abort, {
		id: "evicted",
		operation: abort.sdkId,
		input: { a: 1, b: 2 },
		idempotencyKey: "same",
	});
	expect(calls).toBe(258);
});
test("forwards synthetic gajae-code selections with an off thinking level and pins typed result values", async () => {
	const model = OPERATIONS.find(row => row.sdkId === "model.set")!;
	const calls: unknown[][] = [];
	const surface = {
		setModel: (...args: unknown[]) => {
			calls.push(args);
			return { provider: "gajae-code", modelId: "codex-eco", thinkingLevel: "off" };
		},
	} as unknown as ControlSurface;

	const response = await dispatchControl(surface, model, {
		...request(model),
		input: { id: "gajae-code/codex-eco", thinkingLevel: "off" },
	});

	expect(calls).toEqual([["gajae-code/codex-eco", "off"]]);
	expect(response.ok).toBe(true);
	expect(response.result).toEqual({ provider: "gajae-code", modelId: "codex-eco", thinkingLevel: "off" });
});

test("forwards a synthetic selection without a thinking level as undefined", async () => {
	const model = OPERATIONS.find(row => row.sdkId === "model.set")!;
	const calls: unknown[][] = [];
	const surface = {
		setModel: (...args: unknown[]) => {
			calls.push(args);
			return { changed: true };
		},
	} as unknown as ControlSurface;

	const response = await dispatchControl(surface, model, {
		...request(model),
		input: { id: "gajae-code/codex-eco" },
	});

	expect(calls).toEqual([["gajae-code/codex-eco", undefined]]);
	expect(response.result).toEqual({ changed: true });
});

test("turn.abort terminal mode validates strictly and forwards normalized input", async () => {
	const abort = OPERATIONS.find(row => row.sdkId === "turn.abort")!;
	const calls: Array<Record<string, unknown>> = [];
	const surface = {
		abort: () => "legacy",
		abortTerminal: (input: unknown, idempotencyKey?: string) => {
			calls.push({ ...(input as Record<string, unknown>), idempotencyKey });
			return "terminal";
		},
	} as unknown as ControlSurface;
	const terminal = (input: Record<string, unknown>, idempotencyKey?: string) =>
		dispatchControl(surface, abort, {
			id: "t",
			operation: abort.sdkId,
			input,
			idempotencyKey,
		});

	expect(await terminal({ mode: "terminal" }, "key-1")).toEqual({ id: "t", ok: true, result: "terminal" });
	expect(calls).toEqual([{ mode: "terminal", scope: "turn", idempotencyKey: "key-1" }]);
	expect(await terminal({ mode: "terminal", scope: "owned" }, "key-2")).toEqual({
		id: "t",
		ok: true,
		result: "terminal",
	});
	expect(calls).toEqual([
		{ mode: "terminal", scope: "turn", idempotencyKey: "key-1" },
		{ mode: "terminal", scope: "owned", idempotencyKey: "key-2" },
	]);
	// Same-key same-input retry replays at the dispatch layer without invoking
	// the surface again (the durable record covers the evicted/restart window).
	const replay = await terminal({ mode: "terminal" }, "key-1");
	expect(replay).toEqual({ id: "t", ok: true, result: "terminal" });
	expect(calls).toHaveLength(2);
});

test("turn.abort rejects forged public operator authority", async () => {
	const abort = OPERATIONS.find(row => row.sdkId === "turn.abort")!;
	let calls = 0;
	const surface = {
		abort: () => "legacy",
		abortTerminal: () => {
			calls++;
			return "operator";
		},
	} as unknown as ControlSurface;

	const response = await dispatchControl(surface, abort, {
		id: "forged",
		operation: abort.sdkId,
		input: { mode: "terminal", scope: "owned", operator: true },
		idempotencyKey: "forged-key",
		confirm: true,
	});

	expect(response).toMatchObject({
		ok: false,
		error: { code: "operation_prohibited" },
	});
	expect(calls).toBe(0);
});

test("turn.abort private broker capability is removed from diagnostic frames", () => {
	const frame = {
		type: "control_request",
		operation: "turn.abort",
		input: {
			mode: "terminal",
			operator: true,
			[BROKER_RUNTIME_ABORT_CAPABILITY_FIELD]: "secret-capability",
		},
	};
	expect(redactBrokerRuntimeCapabilities(frame)).toEqual({
		type: "control_request",
		operation: "turn.abort",
		input: { mode: "terminal", operator: true },
	});
	expect(frame.input[BROKER_RUNTIME_ABORT_CAPABILITY_FIELD]).toBe("secret-capability");
});

test("turn.abort accepts the verified private operator capability and hashes public input", async () => {
	const abort = OPERATIONS.find(row => row.sdkId === "turn.abort")!;
	const capability = "test-terminal-abort-capability";
	const calls: Array<{ input: unknown; key?: string }> = [];
	const surface = {
		abort: () => "legacy",
		abortTerminal: (input: unknown, key?: string) => {
			calls.push({ input, key });
			return "operator";
		},
	} as unknown as ControlSurface;
	setBrokerRuntimeAbortCapabilityForTest(capability);
	try {
		const input = {
			mode: "terminal",
			scope: "owned",
			operator: true,
			[BROKER_RUNTIME_ABORT_CAPABILITY_FIELD]: capability,
		};
		const first = await dispatchControl(surface, abort, {
			id: "verified-one",
			operation: abort.sdkId,
			input,
			idempotencyKey: "verified-key",
			confirm: true,
		});
		const replay = await dispatchControl(surface, abort, {
			id: "verified-two",
			operation: abort.sdkId,
			input: {
				[BROKER_RUNTIME_ABORT_CAPABILITY_FIELD]: capability,
				operator: true,
				scope: "owned",
				mode: "terminal",
			},
			idempotencyKey: "verified-key",
			confirm: true,
		});

		expect(first).toEqual({ id: "verified-one", ok: true, result: "operator" });
		expect(replay).toEqual({ id: "verified-two", ok: true, result: "operator" });
		expect(calls).toEqual([{ input: { mode: "terminal", scope: "owned", operator: true }, key: "verified-key" }]);
	} finally {
		setBrokerRuntimeAbortCapabilityForTest(undefined);
	}
});

test("turn.abort operator mode requires confirmation and preserves idempotency", async () => {
	const abort = OPERATIONS.find(row => row.sdkId === "turn.abort")!;
	const capability = "test-operator-capability";
	const calls: Array<Record<string, unknown>> = [];
	const surface = {
		abort: () => "legacy",
		abortTerminal: (input: unknown, idempotencyKey?: string) => {
			calls.push({ ...(input as Record<string, unknown>), idempotencyKey });
			return "operator";
		},
	} as unknown as ControlSurface;
	setBrokerRuntimeAbortCapabilityForTest(capability);
	try {
		const request = (input: Record<string, unknown>, idempotencyKey: string | undefined, confirm: boolean) =>
			dispatchControl(surface, abort, {
				id: "operator",
				operation: abort.sdkId,
				input,
				idempotencyKey,
				confirm,
			});
		const operatorInput = {
			mode: "terminal",
			scope: "owned",
			operator: true,
			[BROKER_RUNTIME_ABORT_CAPABILITY_FIELD]: capability,
		};

		expect(await request(operatorInput, "operator-no-confirm", false)).toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
		expect(await request(operatorInput, undefined, true)).toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
		expect(await request({ ...operatorInput, operator: false }, "operator-false", true)).toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
		expect(await request(operatorInput, "operator-key", true)).toEqual({
			id: "operator",
			ok: true,
			result: "operator",
		});
		expect(calls).toEqual([{ mode: "terminal", scope: "owned", operator: true, idempotencyKey: "operator-key" }]);

		// Same-key/same-authority retries replay, while changing authority conflicts.
		expect(await request(operatorInput, "operator-key", true)).toEqual({
			id: "operator",
			ok: true,
			result: "operator",
		});
		expect(calls).toHaveLength(1);
		expect(await request(operatorInput, "operator-key", false)).toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
		expect(await request({ ...operatorInput, operator: false }, "operator-key", true)).toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
		expect(await request({ mode: "terminal", scope: "owned", operator: true }, "operator-key", true)).toMatchObject({
			ok: false,
			error: { code: "operation_prohibited" },
		});
		expect(calls).toHaveLength(1);
		expect(
			await request(
				{ mode: "terminal", scope: "owned", [BROKER_RUNTIME_ABORT_CAPABILITY_FIELD]: capability },
				"operator-key",
				true,
			),
		).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict" },
		});
		expect(calls).toHaveLength(1);
	} finally {
		setBrokerRuntimeAbortCapabilityForTest(undefined);
	}
});
test("turn.abort terminal normalizes omitted scope before idempotency hashing", async () => {
	const abort = OPERATIONS.find(row => row.sdkId === "turn.abort")!;
	let calls = 0;
	const surface = {
		abort: () => "legacy",
		abortTerminal: () => {
			calls++;
			return "terminal";
		},
	} as unknown as ControlSurface;
	const terminal = (input: Record<string, unknown>, idempotencyKey: string) =>
		dispatchControl(surface, abort, {
			id: "t",
			operation: abort.sdkId,
			input,
			idempotencyKey,
		});

	// The defaulted shape and the explicit `scope:"turn"` are the SAME input:
	// the retry must replay (not idempotency_conflict), so it never re-runs the
	// surface and stays eligible for the durable terminal-scope replay.
	expect(await terminal({ mode: "terminal" }, "key-norm")).toEqual({ id: "t", ok: true, result: "terminal" });
	expect(await terminal({ mode: "terminal", scope: "turn" }, "key-norm")).toEqual({
		id: "t",
		ok: true,
		result: "terminal",
	});
	expect(calls).toBe(1);
	// A genuinely different scope with the same key still conflicts.
	const conflict = await terminal({ mode: "terminal", scope: "owned" }, "key-norm");
	expect(conflict).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
	expect(calls).toBe(1);
	// A malformed input (extra field) does NOT normalize: with a FRESH key it
	// is rejected downstream (invalid_input), never replayed against a valid
	// input's key.
	const malformed = await terminal({ mode: "terminal", force: true }, "key-malformed");
	expect(malformed).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});

test("turn.abort terminal mode rejects missing/oversized key, invalid mode/scope, and unknown fields", async () => {
	const abort = OPERATIONS.find(row => row.sdkId === "turn.abort")!;
	let terminalCalls = 0;
	const surface = {
		abort: () => "legacy",
		abortTerminal: () => {
			terminalCalls++;
			return "terminal";
		},
	} as unknown as ControlSurface;
	const terminal = (input: Record<string, unknown>, idempotencyKey?: string) =>
		dispatchControl(surface, abort, {
			id: "t",
			operation: abort.sdkId,
			input,
			idempotencyKey,
		});
	const rejection = async (input: Record<string, unknown>, idempotencyKey?: string) => {
		const response = await terminal(input, idempotencyKey);
		expect(response.ok).toBe(false);
		expect((response.error as { code?: string }).code).toBe("invalid_input");
	};

	await rejection({ mode: "terminal" }); // keyless
	await rejection({ mode: "terminal" }, ""); // empty key
	await rejection({ mode: "terminal" }, "x".repeat(129)); // oversized
	await rejection({ mode: "terminal", force: true }, "k-force");
	await rejection({ mode: "unknown" }, "k-mode");
	await rejection({ mode: "terminal", scope: "all" }, "k-scope");
	await rejection({ mode: "terminal", foo: 1 }, "k-field");
	expect(terminalCalls).toBe(0);
});

test("turn.abort terminal mode is rejected when the surface does not implement abortTerminal", async () => {
	const abort = OPERATIONS.find(row => row.sdkId === "turn.abort")!;
	const surface = { abort: () => "legacy" } as unknown as ControlSurface;
	const response = await dispatchControl(surface, abort, {
		id: "t",
		operation: abort.sdkId,
		input: { mode: "terminal" },
		idempotencyKey: "key",
	});
	expect(response).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});

test("turn.abort legacy mode keeps dropping input and calling the argument-less abort", async () => {
	const abort = OPERATIONS.find(row => row.sdkId === "turn.abort")!;
	const calls: unknown[] = [];
	const surface = {
		abort: (...args: unknown[]) => {
			calls.push(args);
			return "legacy";
		},
	} as unknown as ControlSurface;
	for (const input of [{}, { mode: "turn" }, { mode: "turn", scope: "owned", extra: 1 }]) {
		const response = await dispatchControl(surface, abort, {
			id: "t",
			operation: abort.sdkId,
			input,
		});
		expect(response).toEqual({ id: "t", ok: true, result: "legacy" });
	}
	expect(calls).toEqual([[], [], []]);
});

test("turn.abort terminal conflict surfaces as a top-level control error", async () => {
	const abort = OPERATIONS.find(row => row.sdkId === "turn.abort")!;
	// A surface that throws a typed idempotency_conflict (the durable
	// terminal-scope replay conflict path after in-memory eviction) must
	// produce a TOP-LEVEL ok:false response — not a nested result inside a
	// successful control_response.
	const surface = {
		abort: () => "legacy",
		abortTerminal: () => {
			throw new TypedControlError("idempotency_conflict", "Idempotency key was reused with different input.");
		},
	} as unknown as ControlSurface;
	const response = await dispatchControl(surface, abort, {
		id: "t-conflict",
		operation: abort.sdkId,
		input: { mode: "terminal", scope: "turn" },
		idempotencyKey: "k",
	});
	expect(response.ok).toBe(false);
	expect(response.error).toMatchObject({ code: "idempotency_conflict" });
});
