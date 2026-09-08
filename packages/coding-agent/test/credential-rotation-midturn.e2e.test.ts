import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Message, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import type { CredentialRankingStrategy, UsageProvider, UsageReport } from "@gajae-code/ai/usage";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

const PROVIDER = "openai-codex";
const selector = (model: Model) => `${model.provider}/${model.id}`;

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** The exact failure shape the Codex Responses transport commits on a usage limit: content-free, no status, provider code only. */
function usageLimitStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "Codex error event: The usage limit has been reached (code=usage_limit_reached)",
			timestamp: Date.now(),
			transportFailure: { kind: "transport", providerCode: "usage_limit_reached" },
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

const noopSchema = z.object({});
function noopTool(): AgentTool<typeof noopSchema, Record<string, never>> {
	return {
		name: "noop",
		label: "Noop",
		description: "does nothing",
		parameters: noopSchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

const used: Record<string, number> = { "acct-a": 0.5, "acct-b": 0.1 };
/** When set, account A reports NO usage (null, never cached) until the failing request has been issued, then reads exhausted. */
let staleThenExhausted = false;
let failureIssued = false;
const report = (acct: string): UsageReport => ({
	provider: PROVIDER,
	fetchedAt: Date.now(),
	limits: [
		{
			id: "weekly",
			label: "weekly",
			scope: "account" as never,
			window: { id: "weekly", label: "weekly", durationMs: 7 * 864e5, resetsAt: Date.now() + 6 * 864e5 },
			amount: { usedFraction: used[acct], used: used[acct]! * 100, unit: "percent" as never },
			status: used[acct]! >= 1 ? "exhausted" : "ok",
		},
	],
});
const usageProvider: UsageProvider = {
	id: PROVIDER,
	async fetchUsage(params) {
		const acct = (params.credential as { accountId?: string }).accountId ?? "?";
		if (staleThenExhausted && acct === "acct-a") {
			if (!failureIssued) return null;
			used["acct-a"] = 1;
		}
		return report(acct);
	},
};
const strategy: CredentialRankingStrategy = {
	findWindowLimits: r => ({ primary: r.limits[0] }),
	windowDefaults: { primaryMs: 5 * 3600e3, secondaryMs: 7 * 864e5 },
};

describe("AgentSession credential rotation on a mid-turn Codex usage limit", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@credential-rotation-midturn-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"), {
			usageProviderResolver: p => (p === PROVIDER ? usageProvider : undefined),
			rankingStrategyResolver: p => (p === PROVIDER ? strategy : undefined),
		});
		const far = Date.now() + 36e5;
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "TOKEN-A", refresh: "rA", expires: far, accountId: "acct-a", email: "a@x.test" },
			{ type: "oauth", access: "TOKEN-B", refresh: "rB", expires: far, accountId: "acct-b", email: "b@x.test" },
		]);
		authStorage.setRuntimePreferredCredentialSelector(PROVIDER, { kind: "email", value: "a@x.test" });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		staleThenExhausted = false;
		failureIssued = false;
		used["acct-a"] = 0.5;
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function run(failOnRequest: number): Promise<{
		texts: string[];
		calls: number;
		keys: string[];
		rowAtFailure?: number;
		rowAfter?: number;
		marks: number;
	}> {
		const model = getBundledModel(PROVIDER, "gpt-5.1-codex");
		if (!model) throw new Error("Expected bundled openai-codex model");
		const modelRegistry = new ModelRegistry(authStorage);
		const toolTurn = createMockModel({
			handler: () => ({ content: [{ type: "toolCall" as const, id: "tc-1", name: "noop", arguments: {} }] }),
		});
		const success = createMockModel({ responses: [{ content: ["accepted"] }] });
		let calls = 0;
		const keys: string[] = [];
		let rowAtFailure: number | undefined;
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [noopTool()], messages: [] },
			convertToLlm: identityConverter,
			getApiKey: async provider =>
				(await modelRegistry.getApiKey(model, session!.credentialSessionId)) ?? `${provider}-none`,
			streamFn: (m, context, options) => {
				calls += 1;
				keys.push(String(options?.apiKey));
				if (calls === failOnRequest) {
					failureIssued = true;
					rowAtFailure = authStorage.getSessionCredentialRowId(PROVIDER, session!.credentialSessionId);
					return usageLimitStream(m);
				}
				if (calls < failOnRequest) return toolTurn.stream(m, context, options);
				// Account A is genuinely exhausted from the failing request on: every later attempt on it fails the same way.
				if (options?.apiKey !== "TOKEN-B") return usageLimitStream(m);
				return success.stream(m, context, options);
			},
		});
		// No `retry.*` key on purpose: a configured legacy retry would mask the defect by retrying on
		// backoff even when the credential mark reports the pool exhausted. Defaults mirror the shipped CLI.
		const settings = Settings.isolated({ "compaction.enabled": false });
		for (const key of ["retry.enabled", "retry.maxRetries", "retry.baseDelayMs", "retry.maxDelayMs"] as const) {
			expect(settings.has(key)).toBe(false);
		}
		settings.setModelRole("default", selector(model));
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		const marks = vi.spyOn(authStorage, "markUsageLimitReached");
		await session.prompt("go");
		await session.waitForIdle();
		const rowAfter = authStorage.getSessionCredentialRowId(PROVIDER, session.credentialSessionId);
		const texts = agent.state.messages
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.map(
				m =>
					(Array.isArray(m.content)
						? m.content.map(c => (c.type === "text" ? c.text : `<${c.type}>`)).join("")
						: String(m.content)) + (m.stopReason === "error" ? ` [error: ${m.errorMessage}]` : ""),
			);
		return { texts, calls, keys, rowAtFailure, rowAfter, marks: marks.mock.calls.length };
	}

	it("control: a usage limit on the FIRST request of the turn rotates and replays", async () => {
		const r = await run(1);
		console.log("control:", JSON.stringify(r));
		expect(r.marks).toBe(1);
		expect(r.rowAtFailure).toBeDefined();
		expect(r.rowAfter).toBeDefined();
		expect(r.rowAfter).not.toBe(r.rowAtFailure);
		expect(r.keys.at(-1)).toBe("TOKEN-B");
		expect(r.texts.at(-1)).toBe("accepted");
	});

	it("rotates even when the cached usage report already reads exhausted by the time the failure is handled", async () => {
		// The status-bar poll refreshes the usage cache on its own clock, so the report can flip to
		// exhausted while the request that will fail is in flight. The mark must still block the row
		// the session actually used and replay on the other one.
		staleThenExhausted = true;
		const r = await run(1);
		console.log("stale-then-exhausted:", JSON.stringify(r));
		expect(r.marks).toBe(1);
		expect(r.rowAtFailure).toBeDefined();
		expect(r.rowAfter).toBeDefined();
		expect(r.rowAfter).not.toBe(r.rowAtFailure);
		expect(r.keys.at(-1)).toBe("TOKEN-B");
		expect(r.texts.at(-1)).toBe("accepted");
	});

	it("a usage limit on the request AFTER a tool result rotates and replays (the 2026-09-08 incident shape)", async () => {
		const r = await run(2);
		console.log("mid-turn:", JSON.stringify(r));
		expect(r.marks).toBe(1);
		expect(r.rowAtFailure).toBeDefined();
		expect(r.rowAfter).toBeDefined();
		expect(r.rowAfter).not.toBe(r.rowAtFailure);
		expect(r.keys.at(-1)).toBe("TOKEN-B");
		expect(r.texts.at(-1)).toBe("accepted");
	});
});
