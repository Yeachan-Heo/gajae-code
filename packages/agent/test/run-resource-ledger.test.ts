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

	test("post-prompt work registered after seal still settles the run", async () => {
		// `agent_end` is published before seal(), so its handlers register their own
		// post-prompt work while the terminal event is still draining. Treating that
		// as an escaped resource made every cancel permanently unfenced.
		const ledger = createRunResourceLedger();
		const late = Promise.withResolvers<void>();
		ledger.open("run");
		ledger.seal("run");
		ledger.track("run", "post_prompt", "agent-session-event", late.promise);

		const settlement = ledger.waitForSettlement("run", { graceMs: 5_000 });
		expect(ledger.pending("run")).toMatchObject([{ kind: "post_prompt", label: "agent-session-event" }]);
		late.resolve();
		expect(await settlement).toEqual({ status: "settled" });
		expect(ledger.pending("run")).toEqual([]);
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
		// Quarantine is terminal: resolving the late work retires nothing, because the
		// entry only ever reached the bounded tombstone and never entered settlement
		// accounting, so the run stays unfenced instead of re-opening as settled.
		late.resolve();
		await Promise.resolve();
		expect(ledger.pending("run")).toMatchObject([{ kind: "tool", label: "late registration" }]);
		expect(await ledger.waitForSettlement("run", { graceMs: 0 })).toMatchObject({ status: "unfenced" });
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

	test("keeps one domain identity until sealed settlement and rejects released handle reuse", async () => {
		const ledger = createRunResourceLedger();
		const domain = ledger.open("identity");
		expect(domain).toBeDefined();
		expect(ledger.open("identity")).toBe(domain);

		const reserved = ledger.reserveProducer("identity", domain, "post_prompt", "child");
		expect(reserved.ok).toBe(true);
		if (!reserved.ok) throw new Error("Expected producer reservation");
		const child = Promise.withResolvers<void>();
		expect(reserved.lease.track("post_prompt", "child-work", child.promise)).toBe(true);
		reserved.lease.closeDiscovery();
		ledger.seal("identity");

		expect(ledger.lookupDomain("identity")).toBe(domain);
		child.resolve();
		expect(await ledger.waitForSettlement("identity", { graceMs: 1_000 })).toEqual({ status: "settled" });
		expect(ledger.lookupDomain("identity")).toBeUndefined();
		expect(ledger.open("identity")).toBeUndefined();
	});

	test("supports descendant discovery after a parent closes", async () => {
		const ledger = createRunResourceLedger();
		const domain = ledger.open("descendants");
		const root = ledger.reserveProducer("descendants", domain, "post_prompt", "root");
		expect(root.ok).toBe(true);
		if (!root.ok) throw new Error("Expected root reservation");
		const child = root.lease.fork(root.lease.domain, "post_prompt", "child");
		expect(child.ok).toBe(true);
		if (!child.ok) throw new Error("Expected child reservation");

		root.lease.closeDiscovery();
		const grandchild = child.lease.fork(child.lease.domain, "post_prompt", "grandchild");
		expect(grandchild.ok).toBe(true);
		if (!grandchild.ok) throw new Error("Expected grandchild reservation");
		grandchild.lease.closeDiscovery();
		child.lease.closeDiscovery();
		ledger.seal("descendants");

		expect(await ledger.waitForSettlement("descendants", { graceMs: 1_000 })).toEqual({ status: "settled" });
	});
	test("allows a live pre-seal lease to fork after root seal", async () => {
		const ledger = createRunResourceLedger();
		const domain = ledger.open("sealed-descendant");
		const root = ledger.reserveProducer("sealed-descendant", domain, "post_prompt", "root");
		expect(root.ok).toBe(true);
		if (!root.ok) throw new Error("Expected root reservation");

		ledger.seal("sealed-descendant");
		const child = root.lease.fork(root.lease.domain, "post_prompt", "child");
		expect(child.ok).toBe(true);
		if (!child.ok) throw new Error("Expected child reservation");
		child.lease.closeDiscovery();
		root.lease.closeDiscovery();

		expect(await ledger.waitForSettlement("sealed-descendant", { graceMs: 1_000 })).toEqual({ status: "settled" });
	});

	test("reports closed and quarantined parents distinctly", () => {
		const ledger = createRunResourceLedger();
		const domain = ledger.open("closed-parent");
		const root = ledger.reserveProducer("closed-parent", domain, "post_prompt", "root");
		expect(root.ok).toBe(true);
		if (!root.ok) throw new Error("Expected root reservation");

		root.lease.closeDiscovery();
		expect(root.lease.fork(root.lease.domain, "post_prompt", "late")).toEqual({
			ok: false,
			reason: "parent_closed",
		});
		expect(root.lease.fork(root.lease.domain, "post_prompt", "later")).toEqual({
			ok: false,
			reason: "quarantined",
		});
		expect(ledger.lookupDomain("closed-parent")).toBeUndefined();
	});
	test("rejects and quarantines a new root reservation after seal", () => {
		const ledger = createRunResourceLedger();
		const domain = ledger.open("sealed-root");
		ledger.seal("sealed-root");

		// The seal boundary rejects genuinely new root work in two steps: the first
		// reservation reports `sealed` and itself quarantines the run, so every
		// reservation after that reports `quarantined` instead.
		expect(ledger.reserveProducer("sealed-root", domain, "post_prompt", "late-root")).toEqual({
			ok: false,
			reason: "sealed",
		});
		expect(ledger.reserveProducer("sealed-root", domain, "post_prompt", "later-root")).toEqual({
			ok: false,
			reason: "quarantined",
		});
		expect(ledger.lookupDomain("sealed-root")).toBeUndefined();
	});

	test("quarantines only the bound run on a domain mismatch", async () => {
		const ledger = createRunResourceLedger();
		const first = ledger.open("first-domain");
		const second = ledger.open("second-domain");
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		if (!first || !second) throw new Error("Expected cancellation domains");

		expect(ledger.reserveProducer("first-domain", second, "tool", "mismatch")).toEqual({
			ok: false,
			reason: "domain_mismatch",
		});
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(false);
		await expect(ledger.waitForSettlement("first-domain", { graceMs: 0 })).resolves.toMatchObject({
			status: "unfenced",
			reason: "quarantined",
		});
		const secondReservation = ledger.reserveProducer("second-domain", second, "tool", "valid");
		expect(secondReservation.ok).toBe(true);
		if (secondReservation.ok) secondReservation.lease.closeDiscovery();
	});

	test("rejects a child fork with a mismatched cancellation domain without affecting its successor", () => {
		const ledger = createRunResourceLedger();
		const first = ledger.open("fork-first");
		const second = ledger.open("fork-second");
		if (!first || !second) throw new Error("Expected cancellation domains");
		const root = ledger.reserveProducer("fork-first", first, "post_prompt", "root");
		if (!root.ok) throw new Error("Expected root reservation");

		expect(root.lease.fork(second, "post_prompt", "mismatch")).toEqual({
			ok: false,
			reason: "domain_mismatch",
		});
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(false);
		expect(ledger.lookupDomain("fork-first")).toBeUndefined();
		expect(ledger.lookupDomain("fork-second")).toBe(second);
	});

	test("duplicate terminal owner claims fail closed without granting a second lease", () => {
		const ledger = createRunResourceLedger();
		const ownerKey = {};
		ledger.bindAgentSessionClaimKey(ownerKey);
		const domain = ledger.open("terminal-claim");
		expect(domain).toBeDefined();
		expect(ledger.claimProducer("terminal-claim", domain, {})).toEqual({ ok: false, reason: "closed" });

		const first = ledger.claimProducer("terminal-claim", domain, ownerKey);
		expect(first.ok).toBe(true);
		const duplicate = ledger.claimProducer("terminal-claim", domain, ownerKey);
		expect(duplicate).toEqual({ ok: false, reason: "already_claimed" });
		expect(domain?.signal.aborted).toBe(true);
		if (first.ok) first.lease.closeDiscovery();
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
