import { expect, test } from "bun:test";
import { type ControlRequest, type ControlSurface, dispatchControl } from "../src/sdk/host/control";
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
	"model.cycle": "cycleModel",
	"thinking.set": "setThinking",
	"thinking.cycle": "cycleThinking",
	"permission_mode.set": "setPermissionMode",
	"queue.steering_mode.set": "setQueueMode",
	"queue.follow_up_mode.set": "setQueueMode",
	"queue.interrupt_mode.set": "setQueueMode",
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

function request(row: (typeof OPERATIONS)[number]): ControlRequest {
	return {
		id: row.id,
		operation: row.sdkId,
		input: {
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
		},
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
	const rows = OPERATIONS.filter(row => row.kind === "control");
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

test("session.handoff surfaces the retained handoff document in the error details", async () => {
	const row = OPERATIONS.find(operation => operation.sdkId === "session.handoff")!;
	const surface = {
		handoffSession: () => {
			throw Object.assign(new Error("Handoff is unavailable for the current state."), {
				code: "invalid_request",
				handoffDocument: "## Goal\nRetained across the SDK wire",
			});
		},
	} as unknown as ControlSurface;

	const response = await dispatchControl(surface, row, {
		...request(row),
		input: { target: "focus" },
	});

	expect(response.ok).toBe(false);
	expect(response.error?.code).toBe("invalid_request");
	expect(response.error?.details).toEqual({ handoffDocument: "## Goal\nRetained across the SDK wire" });
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
