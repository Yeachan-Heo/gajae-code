import { describe, expect, it } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { estimateMessageTokensHeuristic } from "@gajae-code/agent-core/compaction";
import { getBundledModel, getBundledModels } from "@gajae-code/ai";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession, type ForkContextSeed } from "../../src/session/agent-session";

import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

const model = getBundledModel("anthropic", "claude-sonnet-4-5") ?? getBundledModels("anthropic")[0];

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as never;
const assistant = (text: string) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: model?.id ?? "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	}) as never;
const thinkingOnlyAssistant = () => {
	const message = assistant("hidden") as { content: unknown };
	message.content = [{ type: "thinking", thinking: "hidden chain of thought" }];
	return message as never;
};

async function sessionWith(messages: never[]): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	const agent = new Agent({ initialState: { model, systemPrompt: ["sys"], tools: [], messages } });
	const authStorage = await AuthStorage.create(":memory:");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
	return { session, authStorage };
}

interface SeededResult {
	messages: Array<{ content?: unknown }>;
	metadata: Pick<
		ForkContextSeed["metadata"],
		"includedMessages" | "skippedMessages" | "skippedReasons" | "approximateTokens" | "maxTokens"
	>;
}

function buildSeed(session: AgentSession, maxMessages: number, maxTokens: number): Promise<SeededResult> {
	return (
		session as unknown as {
			buildForkContextSeed(o: {
				maxMessages: number;
				maxTokens: number;
				signal?: AbortSignal;
			}): Promise<SeededResult>;
		}
	).buildForkContextSeed({ maxMessages, maxTokens });
}

function seedTexts(seed: SeededResult): string[] {
	return seed.messages.map(m => {
		const content = m.content as string | Array<{ text?: string }> | undefined;
		return typeof content === "string" ? content : (content?.[0]?.text ?? "");
	});
}

describe("buildForkContextSeed selection", () => {
	it("keeps a contiguous run of the most recent messages under the token budget", async () => {
		// oldest → newest. The middle message overflows the tiny budget.
		const { session, authStorage } = await sessionWith([
			user("OLD-TINY"),
			assistant("B".repeat(2000)),
			user("RECENT-TINY"),
		]);
		try {
			const seed = await buildSeed(session, 10, 64);
			const texts = seedTexts(seed);
			// The oversized recent turn stops selection; the seed must NOT scavenge OLD-TINY.
			expect(texts).toEqual(["RECENT-TINY"]);
			expect(texts).not.toContain("OLD-TINY");
			expect(seed.metadata.includedMessages).toBe(1);
			expect(seed.metadata.skippedReasons["token-limit"] ?? 0).toBeGreaterThanOrEqual(1);
		} finally {
			await session.dispose?.();
			authStorage.close?.();
		}
	});

	it("includes a roughly 500-token newest user message in receipt mode", async () => {
		const message = Array.from({ length: 500 }, (_, index) => `token${index}`).join(" ");
		const { session, authStorage } = await sessionWith([user(message)]);
		try {
			const seed = await buildSeed(session, 1, 2000);
			expect(seed.metadata.includedMessages).toBe(1);
			expect(seedTexts(seed)[0]).toBe(message);
			expect(seed.metadata.skippedReasons["token-limit"] ?? 0).toBe(0);
		} finally {
			await session.dispose?.();
			authStorage.close?.();
		}
	});

	it("truncates a newest message much larger than the budget while preserving one included message", async () => {
		const maxTokens = 128;
		const newest = "newest-ten-times-budget ".repeat(maxTokens * 10);
		const { session, authStorage } = await sessionWith([user("OLDER-SHOULD-NOT-APPEAR"), user(newest)]);
		try {
			const seed = await buildSeed(session, 10, maxTokens);
			const texts = seedTexts(seed);
			expect(seed.metadata.includedMessages).toBe(1);
			expect(texts).toHaveLength(1);
			expect(texts[0]).toContain(
				`[fork-context seed: newest message truncated to fit the ${maxTokens}-token budget]`,
			);
			expect(texts[0]).toContain("newest-ten-times-budget");
			expect(texts[0]).not.toContain("OLDER-SHOULD-NOT-APPEAR");
			expect(seed.metadata.approximateTokens).toBeLessThanOrEqual(seed.metadata.maxTokens);
			expect(seed.metadata.maxTokens).toBe(maxTokens);
			expect(seed.metadata.skippedReasons["newest-message-truncated"]).toBe(1);
		} finally {
			await session.dispose?.();
			authStorage.close?.();
		}
	});

	it("truncates an over-budget newest message instead of returning an empty seed", async () => {
		const newest = "newest-over-budget ".repeat(5000);
		const { session, authStorage } = await sessionWith([user("OLD-TINY"), user(newest)]);
		try {
			const seed = await buildSeed(session, 10, 64);
			const texts = seedTexts(seed);
			expect(seed.metadata.includedMessages).toBe(1);
			expect(texts[0]).toContain("[fork-context seed: newest message truncated to fit the 64-token budget]");
			expect(texts[0]).toContain("newest-over-budget");
			expect(texts).not.toContain("OLD-TINY");
			expect(seed.metadata.skippedReasons["token-limit"]).toBe(1);
			expect(seed.metadata.skippedReasons["newest-message-truncated"]).toBe(1);
			expect(seed.metadata.approximateTokens).toBeLessThanOrEqual(seed.metadata.maxTokens);
		} finally {
			await session.dispose?.();
			authStorage.close?.();
		}
	});

	it("keeps newest-only contiguity when the second-newest message would overflow", async () => {
		const newest = "NEWEST-FITS";
		const secondNewest = "SECOND-NEWEST-OVERFLOWS ".repeat(2000);
		const newestTokens = estimateMessageTokensHeuristic(user(newest));
		const { session, authStorage } = await sessionWith([
			user("OLD-SCAVENGE-CANDIDATE"),
			user(secondNewest),
			user(newest),
		]);
		try {
			const seed = await buildSeed(session, 10, newestTokens + 1);
			const texts = seedTexts(seed);
			expect(texts).toEqual([newest]);
			expect(texts).not.toContain("OLD-SCAVENGE-CANDIDATE");
			expect(texts.join("\n")).not.toContain("SECOND-NEWEST-OVERFLOWS");
			expect(seed.metadata.includedMessages).toBe(1);
			expect(seed.metadata.skippedReasons["token-limit"]).toBe(1);
		} finally {
			await session.dispose?.();
			authStorage.close?.();
		}
	});
	it("includes all recent messages when they fit within the budget", async () => {
		const { session, authStorage } = await sessionWith([user("A-old"), assistant("B-mid"), user("C-recent")]);
		try {
			const seed = await buildSeed(session, 10, 10_000);
			expect(seedTexts(seed)).toEqual(["A-old", "B-mid", "C-recent"]);
			expect(seed.metadata.includedMessages).toBe(3);
		} finally {
			await session.dispose?.();
			authStorage.close?.();
		}
	});

	it("omits non-JSON provider payloads before cloning seeded messages", async () => {
		const { session, authStorage } = await sessionWith([
			{
				role: "user",
				content: [{ type: "text", text: "payload should be stripped" }],
				providerPayload: { type: "openaiResponsesHistory", items: [{ id: 1584n }] },
			} as never,
		]);
		try {
			const seed = await buildSeed(session, 10, 10_000);
			expect(seedTexts(seed)).toEqual(["payload should be stripped"]);
			expect(seed.messages).toHaveLength(1);
			expect(seed.messages.every(message => !("providerPayload" in message))).toBe(true);
		} finally {
			await session.dispose?.();
			authStorage.close?.();
		}
	});

	it("skips messages whose sanitized content is empty", async () => {
		const { session, authStorage } = await sessionWith([user("A-old"), thinkingOnlyAssistant(), user("C-recent")]);
		try {
			const seed = await buildSeed(session, 10, 10_000);
			expect(seedTexts(seed)).toEqual(["A-old", "C-recent"]);
			expect(seed.metadata.includedMessages).toBe(2);
			expect(seed.metadata.skippedMessages).toBe(1);
			expect(seed.metadata.skippedReasons["empty-content"]).toBe(1);
		} finally {
			await session.dispose?.();
			authStorage.close?.();
		}
	});

	it("returns cheap metadata-only empty seeds for non-positive limits", async () => {
		const { session, authStorage } = await sessionWith([user("SHOULD-NOT-BE-TRANSFORMED")]);
		try {
			const zeroTokens = await buildSeed(session, 10, 0);
			expect(zeroTokens.messages).toEqual([]);
			expect(zeroTokens.metadata).toMatchObject({
				includedMessages: 0,
				skippedMessages: 0,
				skippedReasons: {},
				approximateTokens: 0,
				maxTokens: 0,
			});

			const zeroMessages = await buildSeed(session, 0, 100);
			expect(zeroMessages.messages).toEqual([]);
			expect(zeroMessages.metadata).toMatchObject({
				includedMessages: 0,
				skippedMessages: 0,
				skippedReasons: {},
				approximateTokens: 0,
				maxTokens: 100,
			});
		} finally {
			await session.dispose?.();
			authStorage.close?.();
		}
	});

	it("includes a message exactly at the token boundary without truncation", async () => {
		const boundaryText = "BOUNDARY-TOKEN-MESSAGE";
		const boundaryTokens = estimateMessageTokensHeuristic(user(boundaryText));
		const { session, authStorage } = await sessionWith([user(boundaryText)]);
		try {
			const seed = await buildSeed(session, 1, boundaryTokens);
			expect(seedTexts(seed)).toEqual([boundaryText]);
			expect(seed.metadata.includedMessages).toBe(1);
			expect(seed.metadata.approximateTokens).toBe(boundaryTokens);
			expect(seed.metadata.maxTokens).toBe(boundaryTokens);
			expect(seed.metadata.skippedReasons["newest-message-truncated"] ?? 0).toBe(0);
		} finally {
			await session.dispose?.();
			authStorage.close?.();
		}
	});
	it("returns a zero-message seed when every recent message sanitizes to empty", async () => {
		const { session, authStorage } = await sessionWith([thinkingOnlyAssistant()]);
		try {
			const seed = await buildSeed(session, 10, 10_000);
			expect(seed.messages).toEqual([]);
			expect(seed.metadata.includedMessages).toBe(0);
			expect(seed.metadata.skippedMessages).toBe(1);
			expect(seed.metadata.skippedReasons["empty-content"]).toBe(1);
		} finally {
			await session.dispose?.();
			authStorage.close?.();
		}
	});
});
