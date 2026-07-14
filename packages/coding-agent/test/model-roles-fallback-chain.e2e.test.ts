import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

const selector = (model: Model) => `${model.provider}/${model.id}`;
const discardedAttemptContent = "Discarded primary provisional content";

function rateLimitStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage & { transportFailure: { kind: "transport"; status: number } } = {
			role: "assistant",
			content: [{ type: "text", text: discardedAttemptContent }],
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
			errorMessage: "rate limit exceeded",
			errorStatus: 429,
			timestamp: Date.now(),
			transportFailure: { kind: "transport", status: 429 },
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: discardedAttemptContent, partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function successfulStream(model: Model): AssistantMessageEventStream {
	return createMockModel({ responses: [{ content: ["Fallback accepted"] }] }).stream(model, {
		systemPrompt: [],
		messages: [],
		tools: [],
	});
}

describe("modelRoles fallback chain e2e", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@model-roles-fallback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("loads a direct role array, keeps its fallback across turns, and exposes the active selection", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, options) => {
				calls.push(selector(model));
				expect(options?.fallbackManaged).toBe(true);
				return selector(model) === selector(primary) ? rateLimitStream(model) : successfulStream(model);
			}) satisfies AgentOptions["streamFn"],
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 1,
			"retry.baseDelayMs": 1,
		});
		settings.set("modelRoles", { default: [selector(primary), selector(fallback)] });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		const events: AgentSessionEvent[] = [];
		const switches: Array<Extract<AgentSessionEvent, { type: "model_fallback_switched" }>> = [];
		session.subscribe(event => {
			events.push(event);
			if (event.type === "model_fallback_switched") switches.push(event);
		});

		expect(session.resolveRoleModelWithThinking("default").model?.id).toBe(primary.id);
		await session.prompt("switch from direct role chain");
		await session.waitForIdle();
		await session.prompt("sticky second turn");
		await session.waitForIdle();

		expect(calls).toEqual([selector(primary), selector(fallback), selector(fallback)]);
		expect(switches).toEqual([
			expect.objectContaining({
				from: selector(primary),
				to: selector(fallback),
				role: "default",
				scope: "session",
				activeIndex: 1,
				chainLength: 2,
			}),
		]);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(2);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(2);
		expect(events.filter(event => event.type === "message_end" && event.message.role === "assistant")).toHaveLength(
			2,
		);
		const assistantStarts = events.filter(
			event => event.type === "message_start" && event.message.role === "assistant",
		);
		const discardedMessages = events.flatMap(event =>
			(event.type === "message_start" || event.type === "message_update") && event.message.role === "assistant"
				? [event.message]
				: [],
		);
		expect(assistantStarts).toHaveLength(2);
		expect(discardedMessages.some(message => JSON.stringify(message.content).includes(discardedAttemptContent))).toBe(
			false,
		);

		expect(selector(session.model!)).toBe(selector(fallback));
		expect(session.getConfiguredModelChain("default") ?? settings.getModelRole("default")).toEqual([
			selector(primary),
			selector(fallback),
		]);
	});
});
