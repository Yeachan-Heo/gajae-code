import { describe, expect, test } from "bun:test";
import type { Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import * as z from "zod/v4";
import { agentLoop } from "../src/agent-loop";
import { createRunResourceLedger } from "../src/run-resource-ledger";
import type { AgentContext, AgentMessage, AgentTool } from "../src/types";
import { createAssistantMessage, createUserMessage } from "./helpers";

describe("run resource ledger", () => {
	test("keeps tracked resources pending until they settle", async () => {
		const ledger = createRunResourceLedger();
		const resource = Promise.withResolvers<void>();
		ledger.open("run");
		ledger.track("run", "tool", "pending tool", resource.promise);

		expect(ledger.pending("run")).toMatchObject([{ kind: "tool", label: "pending tool" }]);
		resource.resolve();
		await Promise.resolve();
		expect(ledger.pending("run")).toEqual([]);
	});

	test("does not settle a reserved empty run until it is sealed", async () => {
		const ledger = createRunResourceLedger();
		ledger.open("pre-registered");
		const settlement = ledger.waitForSettlement("pre-registered", { graceMs: 1_000 });
		let settled = false;
		void settlement.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		ledger.seal("pre-registered");
		expect(await settlement).toEqual({ status: "settled" });
	});

	test("waits for every tracked resource, including rejected resources", async () => {
		const ledger = createRunResourceLedger();
		const resolved = Promise.withResolvers<void>();
		const rejected = Promise.withResolvers<void>();
		ledger.open("run");
		ledger.track("run", "provider_factory", "factory", resolved.promise);
		ledger.track("run", "provider_iterator", "iterator", rejected.promise);
		const settled = ledger.waitForSettlement("run", { graceMs: 25 });

		resolved.resolve();
		rejected.reject(new Error("iterator failed"));
		ledger.seal("run");
		expect(await settled).toEqual({ status: "settled" });
		expect(ledger.pending("run")).toEqual([]);
	});

	test("reports an unfenced entry after the grace period", async () => {
		const ledger = createRunResourceLedger();
		const never = Promise.withResolvers<void>();
		ledger.open("run");
		ledger.track("run", "post_prompt", "background cleanup", never.promise);
		ledger.seal("run");

		expect(await ledger.waitForSettlement("run", { graceMs: 5 })).toMatchObject({
			status: "unfenced",
			pending: [{ kind: "post_prompt", label: "background cleanup" }],
		});
	});

	test("quarantine resolves existing and future waiters as unfenced", async () => {
		const ledger = createRunResourceLedger();
		const resource = Promise.withResolvers<void>();
		ledger.open("run");
		ledger.track("run", "tool", "late tool", resource.promise);
		const existing = ledger.waitForSettlement("run", { graceMs: 5_000 });

		expect(ledger.quarantine("run")).toMatchObject([{ kind: "tool", label: "late tool" }]);
		expect(await existing).toMatchObject({
			status: "unfenced",
			pending: [{ kind: "tool", label: "late tool" }],
		});
		resource.resolve();
		await Promise.resolve();
		expect(ledger.pending("run")).toMatchObject([{ kind: "tool", label: "late tool" }]);
		expect(await ledger.waitForSettlement("run", { graceMs: 0 })).toMatchObject({ status: "unfenced" });
	});

	test("late registration cannot recreate a quarantined run", async () => {
		const ledger = createRunResourceLedger();
		const late = Promise.withResolvers<void>();
		ledger.open("run");
		ledger.quarantine("run");
		ledger.track("run", "tool", "late registration", late.promise);

		expect(ledger.pending("run")).toMatchObject([{ kind: "tool", label: "late registration" }]);
		expect(await ledger.waitForSettlement("run", { graceMs: 0 })).toMatchObject({
			status: "unfenced",
			pending: [{ kind: "tool", label: "late registration" }],
		});
		late.resolve();
	});

	test("bounds the public quarantine tombstone", async () => {
		const ledger = createRunResourceLedger();
		ledger.open("run");
		ledger.quarantine("run");
		for (let index = 0; index < 512; index++) {
			ledger.track("run", "post_prompt", `late-${index}`, Promise.resolve());
		}

		const pending = ledger.pending("run");
		expect(pending.length).toBeLessThanOrEqual(256);
		expect(pending.at(-1)).toMatchObject({ label: "late-511" });
		expect(await ledger.waitForSettlement("run", { graceMs: 0 })).toMatchObject({ status: "unfenced" });
	});

	test("isolates entries and settlement waiters by resource run id", async () => {
		const ledger = createRunResourceLedger();
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		ledger.open("first");
		ledger.open("second");
		ledger.track("first", "tool", "first tool", first.promise);
		ledger.track("second", "tool", "second tool", second.promise);
		const firstSettled = ledger.waitForSettlement("first", { graceMs: 25 });

		first.resolve();
		ledger.seal("first");
		expect(await firstSettled).toEqual({ status: "settled" });
		expect(ledger.pending("second")).toMatchObject([{ label: "second tool" }]);
		second.resolve();
		ledger.seal("second");
		await Promise.resolve();
		expect(ledger.pending("second")).toEqual([]);
	});
});

test("a sealed lease that also covers a hanging trailing result stays unfenced", async () => {
	const ledger = createRunResourceLedger();
	const iteratorSettled = Promise.resolve();
	const { promise: hangingResult } = Promise.withResolvers<void>();
	// Mirrors the agent loop: the provider lease spans the iterator AND `response.result()`.
	ledger.open("run-hang");
	ledger.track(
		"run-hang",
		"provider_factory",
		"provider/model",
		iteratorSettled.then(() => hangingResult),
	);
	ledger.seal("run-hang");
	const proof = await ledger.waitForSettlement("run-hang", { graceMs: 20 });
	expect(proof.status).toBe("unfenced");
	if (proof.status === "unfenced") expect(proof.pending.map(entry => entry.kind)).toEqual(["provider_factory"]);
});

test("real settlement wakes a waiter well before the grace timer", async () => {
	const ledger = createRunResourceLedger();
	const { promise: work, resolve: finish } = Promise.withResolvers<void>();
	ledger.open("run-early");
	ledger.track("run-early", "tool", "slow-tool", work);
	const started = Date.now();
	const settlement = ledger.waitForSettlement("run-early", { graceMs: 5_000 });
	finish();
	ledger.seal("run-early");
	expect(await settlement).toEqual({ status: "settled" });
	expect(Date.now() - started).toBeLessThan(1_000);
});

test("the provider lifecycle memoizes response.result() across iterator completion", async () => {
	const model = createMockModel().model;
	const ledger = createRunResourceLedger();
	const finalMessage = createAssistantMessage([{ type: "text", text: "done" }]);
	let resultCalls = 0;
	const streamFn = () => {
		const response = new AssistantMessageEventStream();
		const result = response.result.bind(response);
		response.result = () => {
			resultCalls++;
			return result();
		};
		queueMicrotask(() => {
			response.push({ type: "start", partial: finalMessage });
			response.push({ type: "done", reason: "stop", message: finalMessage });
		});
		return response;
	};
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
	const convertToLlm = (messages: AgentMessage[]): Message[] =>
		messages.filter(
			(message): message is Message =>
				message.role === "user" || message.role === "assistant" || message.role === "toolResult",
		);
	const stream = agentLoop(
		[createUserMessage("hello")],
		context,
		{ model, convertToLlm, resourceLedger: ledger, resourceRunId: "provider-run" },
		undefined,
		streamFn,
	);
	for await (const _event of stream) {
		// Drain terminal lifecycle before inspecting the resource proof.
	}

	expect(resultCalls).toBe(1);
	expect(await ledger.waitForSettlement("provider-run", { graceMs: 25 })).toEqual({ status: "settled" });
});

test("scheduler ownership fences dependency waits and tool hooks", async () => {
	const toolSchema = z.object({ value: z.string() });
	const ledger = createRunResourceLedger();
	const hookStarted = Promise.withResolvers<void>();
	const releaseHook = Promise.withResolvers<void>();
	let beforeCalls = 0;
	let afterCalls = 0;
	const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: toolSchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const model = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
			{ content: ["done"] },
		],
	});
	const context: AgentContext = { systemPrompt: [], messages: [], tools: [tool] };
	const convertToLlm = (messages: AgentMessage[]): Message[] =>
		messages.filter(
			(message): message is Message =>
				message.role === "user" || message.role === "assistant" || message.role === "toolResult",
		);
	const stream = agentLoop(
		[createUserMessage("echo")],
		context,
		{
			model: model.model,
			convertToLlm,
			resourceLedger: ledger,
			resourceRunId: "tool-run",
			beforeToolCall: async () => {
				beforeCalls++;
				hookStarted.resolve();
				await releaseHook.promise;
			},
			afterToolCall: async () => {
				afterCalls++;
			},
		},
		undefined,
		model.stream,
	);
	const draining = (async () => {
		for await (const _event of stream) {
			// Drain the lifecycle while the scheduler hook is blocked.
		}
	})();

	await hookStarted.promise;
	const hasToolLease = ledger
		.pending("tool-run")
		.some(entry => entry.kind === "tool" && entry.label === "echo:tool-1");
	expect(hasToolLease).toBe(true);
	releaseHook.resolve();
	await draining;
	expect(beforeCalls).toBe(1);
	expect(afterCalls).toBe(1);
	expect(await ledger.waitForSettlement("tool-run", { graceMs: 25 })).toEqual({ status: "settled" });
});
