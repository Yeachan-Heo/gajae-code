import { describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Agent } from "./agent";
import { AppendOnlyContextManager } from "./append-only-context";
import { agentLoop } from "./agent-loop";
import {
	commitToolOutputPrune,
	planToolOutputPrune,
	type PruneConfig,
	type ToolOutputPrunePlan,
} from "./compaction/pruning";
import type { SessionEntry, SessionMessageEntry } from "./compaction/entries";
import type { AgentMessage, AgentTool, ContextMaintenanceResult } from "./types";

const PRUNE_CONFIG: PruneConfig = {
	protectTokens: 0,
	minimumSavings: 0,
	protectedTools: [],
	protectRecentTurns: 0,
};

function toolResult(text: string, toolCallId = "call-1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function sessionEntry(message: AgentMessage, id: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	};
}

function jsonBytes(value: unknown): string {
	return JSON.stringify(value);
}

function containsText(value: unknown, needle: string, seen = new WeakSet<object>()): boolean {
	if (typeof value === "string") return value.includes(needle);
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	for (const child of Object.values(value)) {
		if (containsText(child, needle, seen)) return true;
	}
	return false;
}

function forceGc(): void {
	if (typeof Bun.gc === "function") Bun.gc(true);
}

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-2.5-flash-lite-preview-06-17",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function streamDone(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() =>
		stream.push({
			type: "done",
			reason: message.stopReason === "length" ? "length" : message.stopReason === "toolUse" ? "toolUse" : "stop",
			message,
		}),
	);
	return stream;
}

describe("W4 heap eviction acceptance: Agent retainers and rewrite boundaries", () => {
	test("historyRewrite releases Agent, append-only, loop, conversion, and prune retainers", () => {
		const marker = `w4-heap-marker-${crypto.randomUUID()}-${"x".repeat(8_192)}`;
		let markerHolder: { marker: string } | undefined = { marker };
		const markerHolderRef = new WeakRef(markerHolder!);
		let original = toolResult(marker);
		// The holder is intentionally non-enumerable: it models a diagnostic/closure
		// retainer that JSON-based digest plans must not preserve.
		Object.defineProperty(original, "__w4MarkerHolder", { value: markerHolder, configurable: true });

		const appendOnly = new AppendOnlyContextManager();
		const agent = new Agent({
			initialState: { messages: [original] },
			appendOnlyContext: appendOnly,
		});
		const providerMessage = structuredClone(original) as Message;
		appendOnly.syncMessages([providerMessage]);
		const currentContext = { systemPrompt: [], messages: appendOnly.log.toMessages(), tools: [] };
		appendOnly.build(currentContext, { intentTracing: false });
		const convertedContextCache: Message[] = [structuredClone(providerMessage) as Message];
		const newMessages: AgentMessage[] = [original];

		const planEntries = [sessionEntry(structuredClone(original) as AgentMessage, "marker-entry")];
		const plan = planToolOutputPrune(planEntries, PRUNE_CONFIG);
		expect(plan.digests).toHaveLength(1);
		expect(plan.digests[0]).toMatchObject({ entryId: "marker-entry" });
		expect((plan as unknown as Record<string, unknown>).originalText).toBeUndefined();
		expect(JSON.stringify(plan)).not.toContain("originalText");
		expect(JSON.stringify(plan)).not.toContain(marker);

		// Commit uses the digest-only plan against the original entry, then the
		// owning Agent performs the sole history rewrite boundary.
		const commitEntries = [sessionEntry(structuredClone(original) as AgentMessage, "marker-entry")];
		const commit = commitToolOutputPrune(commitEntries, plan);
		expect(commit).toEqual([{ entryId: "marker-entry", outcome: "committed" }]);
		expect(JSON.stringify(commit)).not.toContain("originalText");
		agent.replaceMessages([], { historyRewrite: { reason: "w4-eviction" } });
		currentContext.messages.length = 0;
		newMessages.length = 0;
		convertedContextCache.length = 0;
		original = undefined as unknown as ToolResultMessage;
		markerHolder = undefined;

		const retainers = [agent.state, appendOnly.log.toMessages(), currentContext, newMessages, convertedContextCache, plan, commit];
		expect(retainers.some(value => containsText(value, marker))).toBe(false);
		expect(agent.state.messages).toEqual([]);
		expect(appendOnly.log.length).toBe(0);
		expect(containsText(appendOnly.log.toMessages(), marker)).toBe(false);

		forceGc();
		expect(markerHolderRef.deref()).toBeUndefined();
	});

	test("provider-normalized bytes remain append-only until replaceMessages crosses historyRewrite", () => {
		const marker = `provider-stable-${crypto.randomUUID()}`;
		const source = toolResult(marker);
		const appendOnly = new AppendOnlyContextManager();
		const agent = new Agent({ initialState: { messages: [source] }, appendOnlyContext: appendOnly });
		const normalized = structuredClone(source) as Message;
		appendOnly.syncMessages([normalized]);
		const before = jsonBytes(appendOnly.log.toMessages());

		// Mutating Agent-owned history in place must not mutate the already-normalized
		// provider snapshot. A converter normally owns this clone boundary.
		source.content = [{ type: "text", text: `${marker}-mutated` }];
		agent.touchContext();
		expect(jsonBytes(appendOnly.log.toMessages())).toBe(before);

		appendOnly.syncMessages([normalized, { role: "user", content: "next", timestamp: Date.now() }]);
		expect(jsonBytes(appendOnly.log.toMessages()).startsWith(before.slice(0, -1))).toBe(true);

		agent.replaceMessages([], { historyRewrite: { reason: "provider-rewrite" } });
		expect(appendOnly.log.length).toBe(0);
	});

	test("append-only log clones nested provider messages at sync and rebase boundaries", () => {
		const message = {
			role: "user",
			content: [{ type: "text", text: "nested-source" }],
			metadata: { nested: { enabled: true } },
		} as unknown as Message;
		const manager = new AppendOnlyContextManager();
		manager.syncMessages([message]);
		message.content = [{ type: "text", text: "mutated-source" }];
		(message as unknown as { metadata: { nested: { enabled: boolean } } }).metadata.nested.enabled = false;
		expect(manager.log.toMessages()[0]).toMatchObject({
			content: [{ type: "text", text: "nested-source" }],
			metadata: { nested: { enabled: true } },
		});

		manager.seedNormalizedMessages([message], { reset: true });
		message.content = [{ type: "text", text: "mutated-after-rebase" }];
		expect(manager.log.toMessages()[0]).toMatchObject({ content: [{ type: "text", text: "mutated-source" }] });
	});

	test("seeded fork prefixes survive a child history rewrite", () => {
		const prefix: Message[] = [
			{ role: "user", content: "seeded-prefix", timestamp: Date.now() },
		];
		const manager = AppendOnlyContextManager.forkFromSeed({
			messages: prefix,
			options: { intentTracing: false },
		});
		const agent = new Agent({
			initialState: { messages: prefix as AgentMessage[] },
			appendOnlyContext: manager,
		});
		const prefixBytes = jsonBytes(manager.log.toMessages()[0]);

		agent.replaceMessages(
			[
				prefix[0] as AgentMessage,
				{ role: "user", content: "child-before-rewrite", timestamp: Date.now() },
			],
			{ historyRewrite: { reason: "child-rewrite", preserveSeededPrefix: true } },
		);
		expect(jsonBytes(manager.log.toMessages()[0])).toBe(prefixBytes);
		expect(manager.log.length).toBe(1);

		manager.syncMessages([
			prefix[0],
			{ role: "user", content: "child-after-rewrite", timestamp: Date.now() },
		]);
		expect(jsonBytes(manager.log.toMessages()[0])).toBe(prefixBytes);
		expect(manager.log.toMessages().at(-1)).toMatchObject({ content: "child-after-rewrite" });
	});

	test("digest mismatch aborts only the tampered entry while another commits", () => {
		const first = sessionEntry(toolResult("first-output-".repeat(2_000), "call-first"), "first");
		const second = sessionEntry(toolResult("second-output-".repeat(2_000), "call-second"), "second");
		const planEntries = structuredClone([first, second]) as SessionEntry[];
		const plan: ToolOutputPrunePlan = planToolOutputPrune(planEntries, PRUNE_CONFIG);
		expect(plan.digests.map(digest => digest.entryId)).toEqual(["second", "first"]);
		expect(plan.digests.every(digest => Object.keys(digest).sort().join(",") === "bytes,entryId,sha256")).toBe(true);

		const commitEntries = structuredClone([first, second]) as SessionEntry[];
		const tampered = commitEntries[0];
		if (tampered.type === "message" && tampered.message.role === "toolResult") {
			tampered.message.content = [{ type: "text", text: "tampered" }];
		}
		const outcomes = commitToolOutputPrune(commitEntries, plan);
		expect(outcomes.find(outcome => outcome.entryId === "first")).toMatchObject({ outcome: "mismatch" });
		expect(outcomes.find(outcome => outcome.entryId === "second")).toEqual({ entryId: "second", outcome: "committed" });
	});

	test("ContextMaintenanceResult releaseCurrentContext clears loop context and newMessages", async () => {
		let maintenanceCalls = 0;
		const events: Array<{ type: string; messages?: AgentMessage[]; stopReason?: string }> = [];
		const tool: AgentTool<any> = {
			name: "w4_probe",
			label: "W4 probe",
			description: "W4 maintenance probe",
			parameters: { type: "object", properties: {}, additionalProperties: false } as any,
			execute: async () => ({ content: [{ type: "text", text: "probe-result" }] }),
		};
		let calls = 0;
		const streamFn = () => {
			const message =
				calls++ === 0
					? assistantMessage([{ type: "toolCall", id: "w4-call", name: "w4_probe", arguments: {} }], "toolUse")
					: assistantMessage([{ type: "text", text: "unexpected second provider call" }], "stop");
			return streamDone(message);
		};
		const stream = agentLoop(
			[],
			{ systemPrompt: [], messages: [], tools: [tool] },
			{
				model: getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17"),
				maintainContext: (): ContextMaintenanceResult => {
					maintenanceCalls++;
					return { outcome: "pruned", releaseCurrentContext: true };
				},
				convertToLlm: messages =>
					messages.filter(
						(message): message is Message =>
							message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					),
			},
			undefined,
			streamFn,
			false,
		);
		for await (const event of stream) {
			if (event.type === "agent_end") events.push(event);
		}
		const result = await stream.result();
		expect(maintenanceCalls).toBe(1);
		expect(calls).toBe(1);
		expect(result).toEqual([]);
		expect(events.at(-1)).toMatchObject({ stopReason: "maintenance", messages: [] });
	});
});
