import { expect, it } from "bun:test";
import { Agent, agentLoop, agentLoopContinue } from "@gajae-code/agent-core";
import { createRunResourceLedger } from "@gajae-code/agent-core/run-resource-ledger";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	RunCancellationDomain,
	StreamFn,
} from "@gajae-code/agent-core/types";
import type { AssistantMessage, Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { createAssistantMessage, createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

it("provides a non-optional cancellation-aware maintenance lifecycle without a run signal", async () => {
	const model = createMockModel();
	const responses: AssistantMessage[] = [
		createAssistantMessage([{ type: "toolCall", id: "call-1", name: "echo", arguments: {} }], "toolUse"),
		createAssistantMessage([{ type: "text", text: "complete" }]),
	];
	const streamFn: StreamFn = () => {
		const response = responses.shift();
		if (!response) throw new Error("Unexpected model request");
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
				message: response,
			});
			stream.end(response);
		});
		return stream;
	};
	const tool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Returns a deterministic result.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
	const context: AgentContext = { systemPrompt: ["You are helpful."], messages: [], tools: [tool] };
	let maintenanceCalls = 0;
	const config: AgentLoopConfig = {
		model: model.model,
		convertToLlm: identityConverter,
		maintainContext: async (_context, lifecycle) => {
			maintenanceCalls += 1;
			expect(lifecycle.signal).toBeInstanceOf(AbortSignal);
			expect(lifecycle.signal.aborted).toBe(false);
			await expect(lifecycle.awaitEventDrain(new AbortController().signal)).resolves.toBeUndefined();
			return "not-needed" as const;
		},
	};

	const stream = agentLoop([createUserMessage("run tool")], context, config, undefined, streamFn);
	for await (const _event of stream) {
		// Drain the real consumer path that awaitEventDrain synchronizes with.
	}

	await expect(stream.result()).resolves.toBeDefined();
	expect(maintenanceCalls).toBe(1);
	expect(responses).toEqual([]);
});

it("settles a reserved provider lease when stream creation throws synchronously", async () => {
	const model = createMockModel();
	const ledger = createRunResourceLedger();
	const config: AgentLoopConfig = {
		model: model.model,
		convertToLlm: identityConverter,
		resourceLedger: ledger,
		resourceRunId: "factory-throw",
	};
	const stream = agentLoop(
		[createUserMessage("fail")],
		{ systemPrompt: ["You are helpful."], messages: [], tools: [] },
		config,
		undefined,
		() => {
			throw new Error("factory failed");
		},
	);

	await expect(stream.result()).rejects.toThrow("factory failed");
	expect(await ledger.waitForSettlement("factory-throw", { graceMs: 100 })).toEqual({ status: "settled" });
});

it("settles a provider that resolves after cancellation wins the factory race", async () => {
	const model = createMockModel();
	const ledger = createRunResourceLedger();
	const controller = new AbortController();
	const factoryStarted = Promise.withResolvers<void>();
	const factory = Promise.withResolvers<AssistantMessageEventStream>();
	const config: AgentLoopConfig = {
		model: model.model,
		convertToLlm: identityConverter,
		resourceLedger: ledger,
		resourceRunId: "late-factory",
	};
	const stream = agentLoop(
		[createUserMessage("cancel")],
		{ systemPrompt: ["You are helpful."], messages: [], tools: [] },
		config,
		controller.signal,
		() => {
			factoryStarted.resolve();
			return factory.promise;
		},
	);
	const drain = (async () => {
		for await (const _event of stream) {
			// Drain the cancellation terminal.
		}
	})();
	await factoryStarted.promise;
	controller.abort();
	await drain;
	await stream.result();

	const lateStream = new AssistantMessageEventStream();
	const lateMessage = createAssistantMessage([{ type: "text", text: "late" }]);
	lateStream.push({ type: "done", reason: "stop", message: lateMessage });
	lateStream.end(lateMessage);
	factory.resolve(lateStream);

	expect(await ledger.waitForSettlement("late-factory", { graceMs: 100 })).toEqual({ status: "settled" });
});

it("settles a late provider even when iterator acquisition throws synchronously", async () => {
	const model = createMockModel();
	const ledger = createRunResourceLedger();
	const controller = new AbortController();
	const factoryStarted = Promise.withResolvers<void>();
	const factory = Promise.withResolvers<AssistantMessageEventStream>();
	const stream = agentLoop(
		[createUserMessage("cancel")],
		{ systemPrompt: ["You are helpful."], messages: [], tools: [] },
		{
			model: model.model,
			convertToLlm: identityConverter,
			resourceLedger: ledger,
			resourceRunId: "late-broken-factory",
		},
		controller.signal,
		() => {
			factoryStarted.resolve();
			return factory.promise;
		},
	);
	const drain = (async () => {
		for await (const _event of stream) {
			// Drain the cancellation terminal.
		}
	})();
	await factoryStarted.promise;
	controller.abort();
	await drain;
	await stream.result();

	const lateStream = new AssistantMessageEventStream();
	const lateMessage = createAssistantMessage([{ type: "text", text: "late" }]);
	lateStream.end(lateMessage);
	const brokenStream = new Proxy(lateStream, {
		get(target, property, receiver) {
			if (property === Symbol.asyncIterator) {
				return () => {
					throw new Error("iterator acquisition failed");
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	factory.resolve(brokenStream);

	expect(await ledger.waitForSettlement("late-broken-factory", { graceMs: 100 })).toEqual({
		status: "settled",
	});
});

it("ends as aborted when cancellation lands while maintenance resolves", async () => {
	const model = createMockModel();
	const maintenanceEntered = Promise.withResolvers<void>();
	const maintenanceGate = Promise.withResolvers<void>();
	const controller = new AbortController();
	let streamCalls = 0;
	const streamFn: StreamFn = () => {
		streamCalls += 1;
		if (streamCalls > 1) throw new Error("Maintenance cancellation must prevent a second model request");
		const response = createAssistantMessage(
			[{ type: "toolCall", id: "call-1", name: "echo", arguments: {} }],
			"toolUse",
		);
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "toolUse", message: response });
			stream.end(response);
		});
		return stream;
	};
	const tool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Returns a deterministic result.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
	const context: AgentContext = { systemPrompt: ["You are helpful."], messages: [], tools: [tool] };
	const events: Array<{ type: string; stopReason?: string; maintenanceOutcome?: string }> = [];
	const ledger = createRunResourceLedger();
	const config: AgentLoopConfig = {
		model: model.model,
		convertToLlm: identityConverter,
		resourceLedger: ledger,
		resourceRunId: "maintenance-abort",
		maintainContext: async () => {
			maintenanceEntered.resolve();
			await maintenanceGate.promise;
			return "not-needed" as const;
		},
	};

	const stream = agentLoop([createUserMessage("run tool")], context, config, controller.signal, streamFn);
	const drain = (async () => {
		for await (const event of stream) events.push(event);
	})();
	await maintenanceEntered.promise;
	controller.abort();
	maintenanceGate.resolve();
	await drain;
	await expect(stream.result()).resolves.toBeDefined();

	expect(streamCalls).toBe(1);
	expect(
		events.filter(
			event =>
				event.type === "agent_end" && event.stopReason === "maintenance" && event.maintenanceOutcome === "aborted",
		),
	).toHaveLength(1);
	expect(await ledger.waitForSettlement("maintenance-abort", { graceMs: 100 })).toEqual({ status: "settled" });
});
it("requires claimed standalone maintenance ownership and installs its domain before continuation", async () => {
	const model = createMockModel();
	const responses: AssistantMessage[] = [
		createAssistantMessage([{ type: "toolCall", id: "call-1", name: "echo", arguments: {} }], "toolUse"),
		createAssistantMessage([{ type: "text", text: "complete" }]),
	];
	const streamFn: StreamFn = () => {
		const response = responses.shift();
		if (!response) throw new Error("Unexpected model request");
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
				message: response,
			});
			stream.end(response);
		});
		return stream;
	};
	const tool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Returns a deterministic result.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
	const ledger = createRunResourceLedger();
	const config: AgentLoopConfig = {
		model: model.model,
		convertToLlm: identityConverter,
		resourceLedger: ledger,
		resourceRunId: "standalone-maintenance",
		maintainContext: async () => "pruned" as const,
	};
	const context: AgentContext = { systemPrompt: ["You are helpful."], messages: [], tools: [tool] };

	const first = agentLoop([createUserMessage("run tool")], context, config, undefined, streamFn);
	for await (const _event of first) {
		// Drain the maintenance checkpoint.
	}
	const firstMessages = await first.result();
	const ownership = config.standaloneRunOwnership;
	expect(ownership).toBeDefined();
	expect(config.resourceCancellationDomain).toBe(ownership?.domain);
	expect(ledger.lookupDomain("standalone-maintenance")).toBe(ownership?.domain);

	const claimed = ownership?.claimContinuation();
	expect(claimed?.ok).toBe(true);
	if (!claimed?.ok) throw new Error("Expected standalone continuation ownership");
	const continuation = agentLoopContinue(
		{ ...context, messages: firstMessages },
		{ ...config, standaloneRunOwnership: claimed.ownership },
		undefined,
		streamFn,
	);
	for await (const _event of continuation) {
		// Drain the final terminal lifecycle.
	}

	expect(responses).toEqual([]);
	expect(await ledger.waitForSettlement("standalone-maintenance", { graceMs: 100 })).toEqual({ status: "settled" });
	expect(ledger.lookupDomain("standalone-maintenance")).toBeUndefined();
});

it("rejects reuse of a consumed standalone continuation claim before provider work", async () => {
	const model = createMockModel();
	const continuationStarted = Promise.withResolvers<void>();
	const pendingContinuation = new AssistantMessageEventStream();
	let streamCalls = 0;
	const streamFn: StreamFn = () => {
		streamCalls += 1;
		if (streamCalls === 1) {
			const response = createAssistantMessage(
				[{ type: "toolCall", id: "call-1", name: "echo", arguments: {} }],
				"toolUse",
			);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "toolUse", message: response });
				stream.end(response);
			});
			return stream;
		}
		if (streamCalls === 2) {
			continuationStarted.resolve();
			return pendingContinuation;
		}
		throw new Error("Rejected continuation must not reach the provider");
	};
	const tool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Returns a deterministic result.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
	const ledger = createRunResourceLedger();
	const config: AgentLoopConfig = {
		model: model.model,
		convertToLlm: identityConverter,
		resourceLedger: ledger,
		resourceRunId: "standalone-duplicate",
		maintainContext: async () => "pruned" as const,
	};
	const context: AgentContext = { systemPrompt: ["You are helpful."], messages: [], tools: [tool] };
	const first = agentLoop([createUserMessage("run tool")], context, config, undefined, streamFn);
	for await (const _event of first) {
		// Drain the maintenance checkpoint.
	}
	const firstMessages = await first.result();
	const claim = config.standaloneRunOwnership?.claimContinuation();
	if (!claim?.ok) throw new Error("Expected standalone continuation ownership");

	const continuation = agentLoopContinue(
		{ ...context, messages: firstMessages },
		{ ...config, standaloneRunOwnership: claim.ownership },
		undefined,
		streamFn,
	);
	const continuationDrain = (async () => {
		for await (const _event of continuation) {
			// Drain the rightful continuation after the duplicate quarantines it.
		}
	})();
	await continuationStarted.promise;

	const duplicate = agentLoopContinue(
		{ ...context, messages: firstMessages },
		{ ...config, standaloneRunOwnership: claim.ownership },
		undefined,
		streamFn,
	);
	await expect(duplicate.result()).rejects.toThrow("Standalone prompt continuation ownership is unavailable");

	const terminal = createAssistantMessage([{ type: "text", text: "late completion" }]);
	pendingContinuation.push({ type: "done", reason: "stop", message: terminal });
	pendingContinuation.end(terminal);
	await continuationDrain;
	await continuation.result();

	expect(streamCalls).toBe(2);
	const proof = await ledger.waitForSettlement("standalone-duplicate", { graceMs: 100 });
	expect(proof.status).toBe("unfenced");
	if (proof.status === "unfenced") expect(proof.reason).toBe("quarantined");
});

it("keeps one Agent logical resource domain across single-model maintenance continuation", async () => {
	const model = createMockModel();
	const responses: AssistantMessage[] = [
		createAssistantMessage([{ type: "toolCall", id: "call-1", name: "echo", arguments: {} }], "toolUse"),
		createAssistantMessage([{ type: "text", text: "complete" }]),
	];
	const streamFn: StreamFn = () => {
		const response = responses.shift();
		if (!response) throw new Error("Unexpected model request");
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
				message: response,
			});
			stream.end(response);
		});
		return stream;
	};
	const tool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Returns a deterministic result.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
	let maintenanceCalls = 0;
	const agent = new Agent({
		initialState: { model: model.model, systemPrompt: ["You are helpful."], tools: [tool], messages: [] },
		streamFn,
	});
	agent.setMaintainContext(async () => {
		maintenanceCalls += 1;
		return "pruned" as const;
	});
	const events: AgentEvent[] = [];
	let maintenanceHandle: string | undefined;
	let maintenanceDomain: RunCancellationDomain | undefined;
	agent.subscribe(event => {
		events.push(event);
		if (event.type === "agent_end" && event.stopReason === "maintenance") {
			maintenanceHandle = agent.activeResourceRunId;
			maintenanceDomain = maintenanceHandle ? agent.resourceLedger.lookupDomain(maintenanceHandle) : undefined;
		}
	});

	await agent.prompt("run tool");
	expect(maintenanceHandle).toBeDefined();
	expect(maintenanceDomain).toBeDefined();
	await agent.continue({
		maintenanceContinuation: true,
		onRunAccepted: () => {
			expect(agent.activeResourceRunId).toBe(maintenanceHandle);
			expect(agent.resourceLedger.lookupDomain(maintenanceHandle!)).toBe(maintenanceDomain);
		},
	});

	expect(responses).toEqual([]);
	expect(maintenanceCalls).toBe(1);
	expect(events.filter(event => event.type === "agent_start")).toHaveLength(1);
	expect(events.filter(event => event.type === "agent_end" && event.stopReason === "maintenance")).toHaveLength(1);
	expect(events.filter(event => event.type === "agent_end" && event.stopReason !== "maintenance")).toHaveLength(1);
	expect(await agent.resourceLedger.waitForSettlement(maintenanceHandle!, { graceMs: 100 })).toEqual({
		status: "settled",
	});
});

it("rejects an unclaimed fresh-config standalone continuation", async () => {
	const model = createMockModel();
	const ledger = createRunResourceLedger();
	ledger.open("standalone-bypass");
	const bypass = agentLoopContinue(
		{
			systemPrompt: ["You are helpful."],
			messages: [createUserMessage("continue")],
			tools: [],
		},
		{
			model: model.model,
			convertToLlm: identityConverter,
			resourceLedger: ledger,
			resourceRunId: "standalone-bypass",
		},
	);

	await expect(bypass.result()).rejects.toThrow("Standalone prompt continuation ownership is unavailable");
	expect(ledger.lookupDomain("standalone-bypass")).toBeUndefined();
});
