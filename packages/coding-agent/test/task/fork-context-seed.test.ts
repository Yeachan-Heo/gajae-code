import { describe, expect, it } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel, getBundledModels } from "@gajae-code/ai";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
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
	metadata: { includedMessages: number; skippedReasons: Record<string, number> };
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
});
