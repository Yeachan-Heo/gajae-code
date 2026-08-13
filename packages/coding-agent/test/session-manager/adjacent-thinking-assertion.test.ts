import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai/core";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as utils from "@gajae-code/utils";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SessionManager adjacent-thinking transcript assertion (#4443)", () => {
	it("warns once when appending an assistant message with adjacent thinking blocks", () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const session = SessionManager.inMemory();

		session.appendMessage(
			assistantMessage(
				[
					{ type: "thinking", thinking: "first", thinkingSignature: "sig_a" },
					{ type: "thinking", thinking: "second", thinkingSignature: "sig_b" },
					{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.md" } },
				],
				{ stopReason: "toolUse" },
			),
		);

		const adjacentWarn = warnSpy.mock.calls.find(
			([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
		);
		expect(adjacentWarn).toBeDefined();
		const metadata = adjacentWarn![1] as Record<string, unknown>;
		expect(metadata).toHaveProperty("contentBlockCount", 3);
		expect(metadata).toHaveProperty("hasAdjacentPrivateBlocks", true);
		expect(metadata).toHaveProperty("role", "assistant");
		expect(metadata).toHaveProperty("provider", "anthropic");
		// Never leaks raw thinking text, signatures, or payloads
		expect(JSON.stringify(metadata)).not.toContain("first");
		expect(JSON.stringify(metadata)).not.toContain("second");
		expect(JSON.stringify(metadata)).not.toContain("sig_a");
		expect(JSON.stringify(metadata)).not.toContain("sig_b");
	});

	it("warns for adjacent thinking + redactedThinking (one adjacency class)", () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const session = SessionManager.inMemory();

		session.appendMessage(
			assistantMessage([
				{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig_a" },
				{ type: "redactedThinking", data: "opaque-blob" },
			]),
		);

		const adjacentWarn = warnSpy.mock.calls.find(
			([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
		);
		expect(adjacentWarn).toBeDefined();
		expect((adjacentWarn![1] as Record<string, unknown>).contentBlockCount).toBe(2);
		// Never leaks the redacted payload
		expect(JSON.stringify(adjacentWarn![1])).not.toContain("opaque-blob");
	});

	it("does not warn when thinking blocks are separated by a tool_use (interleaved)", () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const session = SessionManager.inMemory();

		session.appendMessage(
			assistantMessage(
				[
					{ type: "thinking", thinking: "first", thinkingSignature: "sig_a" },
					{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.md" } },
					{ type: "thinking", thinking: "second", thinkingSignature: "sig_b" },
					{ type: "toolCall", id: "toolu_2", name: "read", arguments: { path: "b.md" } },
				],
				{ stopReason: "toolUse" },
			),
		);

		const adjacentWarn = warnSpy.mock.calls.find(
			([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
		);
		expect(adjacentWarn).toBeUndefined();
	});

	it("does not warn for a single thinking block", () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const session = SessionManager.inMemory();

		session.appendMessage(
			assistantMessage([
				{ type: "thinking", thinking: "sole", thinkingSignature: "sig_a" },
				{ type: "text", text: "answer" },
			]),
		);

		const adjacentWarn = warnSpy.mock.calls.find(
			([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
		);
		expect(adjacentWarn).toBeUndefined();
	});

	it("does not warn for non-assistant messages", () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const session = SessionManager.inMemory();

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 2,
		});

		const adjacentWarn = warnSpy.mock.calls.find(
			([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
		);
		expect(adjacentWarn).toBeUndefined();
	});

	it("does not warn for non-Anthropic assistant messages (provider-scoped)", () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const session = SessionManager.inMemory();

		// OpenAI Responses assembler creates one thinking block per reasoning
		// output item; adjacent blocks there are not an Anthropic replay defect.
		session.appendMessage(
			assistantMessage(
				[
					{ type: "thinking", thinking: "first", thinkingSignature: "reasoning_item_1" },
					{ type: "thinking", thinking: "second", thinkingSignature: "reasoning_item_2" },
					{ type: "text", text: "answer" },
				],
				{ api: "openai-responses", provider: "openai", model: "gpt-5" },
			),
		);

		const adjacentWarn = warnSpy.mock.calls.find(
			([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
		);
		expect(adjacentWarn).toBeUndefined();
	});

	it("does not mutate storage: entry is persisted with all blocks intact", () => {
		vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const session = SessionManager.inMemory();

		const originalContent: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "first", thinkingSignature: "sig_a" },
			{ type: "thinking", thinking: "second", thinkingSignature: "sig_b" },
			{ type: "text", text: "answer" },
		];
		session.appendMessage(assistantMessage(originalContent));

		// The persisted message must have all blocks intact — no mutation
		const entries = session.getEntries();
		const msgEntry = entries.find(e => e.type === "message");
		expect(msgEntry).toBeDefined();
		expect(msgEntry?.type).toBe("message");
		if (msgEntry?.type !== "message") return;
		const persisted = msgEntry.message as AssistantMessage;
		expect(persisted.content).toEqual(originalContent);
		expect(persisted.content).toHaveLength(3);
	});

	it("warns at most once per session manager instance (bounded, no repeated logs)", () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const session = SessionManager.inMemory();

		// Append three messages, each with adjacent thinking blocks
		for (let i = 0; i < 3; i++) {
			session.appendMessage(
				assistantMessage([
					{ type: "thinking", thinking: `t${i}a`, thinkingSignature: `s${i}a` },
					{ type: "thinking", thinking: `t${i}b`, thinkingSignature: `s${i}b` },
				]),
			);
		}

		const adjacentWarns = warnSpy.mock.calls.filter(
			([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
		);
		expect(adjacentWarns).toHaveLength(1);
	});

	it("does not warn in production builds (explicit environment gate)", () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const originalNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "production";
		try {
			const session = SessionManager.inMemory();
			session.appendMessage(
				assistantMessage([
					{ type: "thinking", thinking: "first", thinkingSignature: "sig_a" },
					{ type: "thinking", thinking: "second", thinkingSignature: "sig_b" },
				]),
			);
			// Production must never emit this diagnostic or transcript-path metadata
			const adjacentWarn = warnSpy.mock.calls.find(
				([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
			);
			expect(adjacentWarn).toBeUndefined();
		} finally {
			// Restore to avoid global env leakage / order dependence
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
		}
	});

	it("warns in development builds (gate permits dev/test)", () => {
		const warnSpy = vi.spyOn(utils.logger, "warn").mockImplementation(() => {});
		const originalNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";
		try {
			const session = SessionManager.inMemory();
			session.appendMessage(
				assistantMessage([
					{ type: "thinking", thinking: "first", thinkingSignature: "sig_a" },
					{ type: "thinking", thinking: "second", thinkingSignature: "sig_b" },
				]),
			);
			const adjacentWarn = warnSpy.mock.calls.find(
				([message]) => typeof message === "string" && message.includes("adjacent thinking blocks"),
			);
			expect(adjacentWarn).toBeDefined();
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = originalNodeEnv;
			}
		}
	});
});
