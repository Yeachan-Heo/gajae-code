import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@gajae-code/agent-core";
import type { Api, Model, ToolChoice } from "@gajae-code/ai";
import { clearToolChoiceIncapabilityRegistryForTests, markToolChoiceIncapability } from "@gajae-code/ai";
import { ToolChoiceQueue } from "@gajae-code/coding-agent/session/tool-choice-queue";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { queueResolveHandler } from "@gajae-code/coding-agent/tools/resolve";
import { ToolError } from "@gajae-code/coding-agent/tools/tool-errors";
import { buildNamedToolChoiceResult } from "@gajae-code/coding-agent/utils/tool-choice";

const forcedResolve = { type: "tool", name: "resolve" } as const satisfies ToolChoice;
const forcedTodoWrite = { type: "tool", name: "todo_write" } as const satisfies ToolChoice;

function model<TApi extends Api>(api: TApi, compat?: Model<TApi>["compat"]): Model<TApi> {
	return {
		id: `${api}-redteam-model`,
		name: `${api} redteam model`,
		api,
		provider: "redteam",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat,
	};
}

function successfulApply(text = "applied"): Promise<AgentToolResult<unknown>> {
	return Promise.resolve({ content: [{ type: "text", text }] });
}

function createSession(options: {
	queue?: ToolChoiceQueue;
	steers?: unknown[];
	model?: Model<Api>;
	exactNamed?: boolean;
	legacyChoice?: ToolChoice;
}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: {} as ToolSession["settings"],
		getSessionFile: () => null,
		getSessionSpawns: () => "",
		getToolChoiceQueue: () => options.queue,
		...(options.legacyChoice === undefined
			? {
					buildToolChoiceResult: (toolName: string) =>
						options.model
							? buildNamedToolChoiceResult(toolName, options.model)
							: {
									choice: options.exactNamed ? ({ type: "tool", name: toolName } as const) : undefined,
									exactNamed: options.exactNamed ?? false,
									resolved: undefined,
								},
				}
			: {
					buildToolChoice: () => options.legacyChoice,
				}),
		steer: (message: { customType: string; content: string; details?: unknown }) => options.steers?.push(message),
	} as unknown as ToolSession;
}

describe("tool-choice degradation red-team", () => {
	beforeEach(() => {
		clearToolChoiceIncapabilityRegistryForTests();
	});

	it("REQUEUE-LOOP KILL: degradeInFlight cannot resurrect a resolve directive across repeated turns", () => {
		const queue = new ToolChoiceQueue();
		queueResolveHandler(createSession({ exactNamed: true, queue, steers: [] }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: () => successfulApply(),
		});

		expect(queue.nextToolChoice()).toEqual(forcedResolve);
		expect(queue.degradeInFlight("persistent 400")).toBe("pending-action:ast_edit");
		expect(queue.inspect()).toEqual([]);

		for (let turn = 0; turn < 3; turn++) {
			expect(queue.nextToolChoice()).toBeUndefined();
			expect(queue.degradeInFlight("persistent 400")).toBeUndefined();
			expect(queue.inspect()).toEqual([]);
		}
	});

	it("QUEUE INTEGRITY: degrading resolve in-flight preserves a queued todo_write directive", () => {
		const queue = new ToolChoiceQueue();
		queue.pushOnce(forcedTodoWrite, { label: "eager-todo" });
		queueResolveHandler(createSession({ exactNamed: true, queue, steers: [] }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: () => successfulApply(),
		});

		expect(queue.inspect()).toEqual(["pending-action:ast_edit", "eager-todo"]);
		expect(queue.nextToolChoice()).toEqual(forcedResolve);
		expect(queue.degradeInFlight("resolve unsupported")).toBe("pending-action:ast_edit");
		expect(queue.inspect()).toEqual(["eager-todo"]);
		expect(queue.nextToolChoice()).toEqual(forcedTodoWrite);
	});

	it("EXACT-NAMED BYPASS ATTEMPTS: required/auto/none/google never masquerade as exact named", () => {
		const attempts = [
			model("anthropic-messages", { toolChoiceSupport: "required" }),
			model("anthropic-messages", { toolChoiceSupport: "auto" }),
			model("anthropic-messages", { toolChoiceSupport: "none" }),
			model("google-generative-ai", { toolChoiceSupport: "required" }),
			model("google-generative-ai", { toolChoiceSupport: "auto" }),
			model("google-generative-ai", { toolChoiceSupport: "none" }),
		];

		for (const attempt of attempts) {
			const result = buildNamedToolChoiceResult("resolve", attempt);
			expect(result.exactNamed).toBe(false);
			expect(result.choice).toBeUndefined();
		}

		const runtimeModel = model("anthropic-messages", { toolChoiceSupport: "named" });
		expect(buildNamedToolChoiceResult("resolve", runtimeModel).exactNamed).toBe(true);
		markToolChoiceIncapability(runtimeModel, "auto", "runtime 400");
		const degraded = buildNamedToolChoiceResult("resolve", runtimeModel);
		expect(degraded.exactNamed).toBe(false);
		expect(degraded.choice).toBeUndefined();
		expect(degraded.resolved?.supportSource).toBe("runtime");
	});

	it("LEGACY BRIDGE: buildToolChoice-only sessions still push the directive", () => {
		const queue = new ToolChoiceQueue();
		const steers: unknown[] = [];
		queueResolveHandler(createSession({ queue, steers, legacyChoice: forcedResolve }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: () => successfulApply(),
		});

		expect(queue.inspect()).toEqual(["pending-action:ast_edit"]);
		expect(queue.nextToolChoice()).toEqual(forcedResolve);
		expect(steers).toHaveLength(1);
	});

	it("LEGACY BRIDGE: buildToolChoiceResult exactNamed false pushes nothing and steers once", () => {
		const queue = new ToolChoiceQueue();
		const steers: unknown[] = [];
		queueResolveHandler(createSession({ exactNamed: false, queue, steers }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: () => successfulApply(),
		});

		expect(queue.inspect()).toEqual([]);
		expect(queue.nextToolChoice()).toBeUndefined();
		expect(steers).toHaveLength(1);
		expect(steers[0]).toMatchObject({ customType: "resolve-reminder" });
	});

	it("DOUBLE-DEGRADE IDEMPOTENCE: second degradeInFlight is a no-op", () => {
		const queue = new ToolChoiceQueue();
		queueResolveHandler(createSession({ exactNamed: true, queue, steers: [] }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: () => successfulApply(),
		});

		expect(queue.nextToolChoice()).toEqual(forcedResolve);
		expect(queue.degradeInFlight("first 400")).toBe("pending-action:ast_edit");
		expect(queue.degradeInFlight("second 400")).toBeUndefined();
		expect(queue.inspect()).toEqual([]);
	});

	it("apply-error re-push path rebuilds through the exactNamed gate after runtime incapability is marked", async () => {
		const queue = new ToolChoiceQueue();
		const steers: unknown[] = [];
		const runtimeModel = model("anthropic-messages", { toolChoiceSupport: "named" });
		queueResolveHandler(createSession({ queue, steers, model: runtimeModel }), {
			label: "preview",
			sourceToolName: "ast_edit",
			apply: async () => {
				markToolChoiceIncapability(runtimeModel, "auto", "apply failed after provider rejection");
				throw new Error("overlap");
			},
		});

		expect(queue.nextToolChoice()).toEqual(forcedResolve);
		const invoker = queue.peekInFlightInvoker();
		expect(invoker).toBeDefined();
		await expect(invoker!({ action: "apply", reason: "test" })).rejects.toThrow(ToolError);
		queue.degradeInFlight("provider now incapable");

		expect(queue.inspect()).toEqual([]);
		expect(queue.nextToolChoice()).toBeUndefined();
		expect(steers).toHaveLength(2);
	});
});
