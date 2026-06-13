import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";

function oldDidSessionMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
	return (
		JSON.stringify(previousMessages.map(message => normalizeBaseline(message))) !==
		JSON.stringify(nextMessages.map(message => normalizeBaseline(message)))
	);
}

function normalizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => normalizeValue(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, normalizeValue(entryValue)]));
	}
	return value;
}

function normalizeBaseline(message: AgentMessage): unknown {
	switch (message.role) {
		case "user":
		case "developer":
			return {
				role: message.role,
				content: normalizeValue(message.content),
				providerPayload: message.providerPayload,
			};
		case "assistant": {
			const isResponsesFamilyMessage =
				message.api === "openai-responses" || message.api === "openai-codex-responses";
			return {
				role: message.role,
				content:
					isResponsesFamilyMessage && Array.isArray(message.content)
						? message.content.flatMap(block => {
								if (block.type === "thinking") return [];
								if (block.type === "toolCall") {
									return [{ type: block.type, id: block.id, name: block.name, arguments: block.arguments }];
								}
								if (block.type === "text") {
									return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
								}
								return [normalizeValue(block)];
							})
						: normalizeValue(message.content),
				api: message.api,
				provider: message.provider,
				model: message.model,
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
			};
		}
		case "toolResult":
			return {
				role: message.role,
				toolName: message.toolName,
				toolCallId: message.toolCallId,
				isError: message.isError,
				content: normalizeValue(message.content),
			};
		case "bashExecution":
		case "pythonExecution":
			return {
				role: message.role,
				...(message.role === "bashExecution" ? { command: message.command } : { code: message.code }),
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				meta: message.meta
					? {
							truncation: normalizeValue(message.meta.truncation),
							limits: normalizeValue(message.meta.limits),
							diagnostics: message.meta.diagnostics
								? normalizeValue({
										summary: message.meta.diagnostics.summary,
										messages: message.meta.diagnostics.messages,
									})
								: undefined,
						}
					: undefined,
				excludeFromContext: message.excludeFromContext,
			};
		case "custom":
		case "hookMessage":
			return { role: message.role, customType: message.customType, content: normalizeValue(message.content) };
		case "branchSummary":
			return { role: message.role, summary: message.summary };
		case "compactionSummary":
			return { role: message.role, summary: message.summary, providerPayload: message.providerPayload };
		case "fileMention":
			return {
				role: message.role,
				files: message.files.map(file => ({ path: file.path, content: file.content, image: file.image })),
			};
		default:
			return normalizeValue(message);
	}
}

function newDidSessionMessagesChange(
	messagesA: AgentMessage[],
	messagesB: AgentMessage[],
	hashSource = Bun.hash.xxHash64,
): boolean {
	const cache = new WeakMap<AgentMessage, { source: string; hash: bigint }>();
	const sourceFor = (message: AgentMessage): { source: string; hash: bigint } => {
		const cached = cache.get(message);
		if (cached) return cached;
		const source = JSON.stringify(normalizeBaseline(message));
		const entry = { source, hash: hashSource(source) };
		cache.set(message, entry);
		return entry;
	};
	if (messagesA.length !== messagesB.length) return true;
	const aSources: Array<{ source: string; hash: bigint }> = [];
	const bSources: Array<{ source: string; hash: bigint }> = [];
	for (let i = 0; i < messagesA.length; i++) {
		const a = sourceFor(messagesA[i]!);
		const b = sourceFor(messagesB[i]!);
		if (a.hash !== b.hash) return true;
		aSources.push(a);
		bSources.push(b);
	}
	for (let i = 0; i < aSources.length; i++) {
		if (aSources[i]!.source !== bSources[i]!.source) return true;
	}
	return false;
}

const fixtures: AgentMessage[] = [
	{
		role: "user",
		content: [
			{ type: "text", text: "hello" },
			{ type: "image", data: "abc", mimeType: "image/png" },
		],
		timestamp: 1,
	},
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hidden" },
			{ type: "text", text: "visible", textSignature: "sig" },
			{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a", missing: undefined } },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt",
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolName: "read",
		toolCallId: "tc1",
		isError: false,
		content: [{ type: "text", text: "file" }],
		timestamp: 3,
	},
	{
		role: "fileMention",
		files: [{ path: "img.png", content: "bytes", image: { type: "image", mimeType: "image/png", data: "abc" } }],
		timestamp: 4,
	},
	{
		role: "bashExecution",
		command: "echo hi",
		output: "hi",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		meta: {
			truncation: {
				direction: "tail",
				truncatedBy: "lines",
				totalLines: 20,
				totalBytes: 200,
				outputLines: 10,
				outputBytes: 100,
			},
			limits: { resultLimit: { reached: 10, suggestion: 20 } },
			diagnostics: { summary: "ok", messages: ["one"] },
		},
		timestamp: 5,
	},
];

describe("session message equality", () => {
	it("matches the old normalized JSON stringify verdicts for provider-visible fixture variants", () => {
		for (let changedIndex = 0; changedIndex < fixtures.length; changedIndex++) {
			const previous = fixtures.map(message => ({ ...message })) as AgentMessage[];
			const next = fixtures.map(message => ({ ...message })) as AgentMessage[];
			expect(newDidSessionMessagesChange(previous, next)).toBe(false);
			const changed = {
				...next[changedIndex]!,
				providerPayload: { type: "openaiResponsesHistory", items: [{ changedIndex }] },
			} as AgentMessage;
			next[changedIndex] = changed;
			expect(newDidSessionMessagesChange(previous, next)).toBe(oldDidSessionMessagesChange(previous, next));
		}
	});

	it("falls back to source comparison when hashes collide", () => {
		const previous = [{ role: "user", content: "a", timestamp: 1 }] as AgentMessage[];
		const next = [{ role: "user", content: "b", timestamp: 1 }] as AgentMessage[];
		expect(newDidSessionMessagesChange(previous, next, () => 1n)).toBe(true);
	});
});
