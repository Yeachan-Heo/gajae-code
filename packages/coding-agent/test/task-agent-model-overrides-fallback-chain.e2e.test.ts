import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import { type AssistantMessage, Effort, getBundledModel, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resolveAgentModelPatterns } from "@gajae-code/coding-agent/config/model-resolver";
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
	return createMockModel({ responses: [{ content: ["Override fallback accepted"] }] }).stream(model, {
		systemPrompt: [],
		messages: [],
		tools: [],
	});
}

describe("task.agentModelOverrides fallback chain e2e", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@task-override-fallback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("resolves an executor array into fresh child sessions that independently switch from its head", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const chain = [selector(primary), selector(fallback)];
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 1,
			"retry.baseDelayMs": 1,
			"task.agentModelOverrides": { executor: chain },
		});
		const configured = resolveAgentModelPatterns({
			settingsOverride: settings.get("task.agentModelOverrides").executor,
			agentModel: "pi/default",
			settings,
		});
		expect(configured).toEqual(chain);
		const calls: string[] = [];
		const childSessions: AgentSession[] = [];
		try {
			for (const task of ["first executor call", "second executor call"]) {
				const agent = new Agent({
					getApiKey: provider => `${provider}-test-key`,
					initialState: {
						model: primary,
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
						thinkingLevel: Effort.XHigh,
					},
					streamFn: ((model, _context, options) => {
						calls.push(selector(model));
						expect(options?.fallbackManaged).toBe(true);
						return selector(model) === selector(primary) ? rateLimitStream(model) : successfulStream(model);
					}) satisfies AgentOptions["streamFn"],
				});
				const child = new AgentSession({
					agent,
					sessionManager: SessionManager.inMemory(),
					settings,
					modelRegistry: new ModelRegistry(authStorage),
					thinkingLevel: Effort.XHigh,
				});
				childSessions.push(child);
				const events: AgentSessionEvent[] = [];
				child.subscribe(event => events.push(event));
				child.setConfiguredModelChain("default", configured, "subagent", "executor", true);
				expect(child.getConfiguredModelChain("default")).toEqual(chain);
				await child.prompt(task);
				await child.waitForIdle();
				expect(selector(child.model!)).toBe(selector(fallback));
				expect(events.filter(event => event.type === "model_fallback_switched")).toEqual([
					expect.objectContaining({
						from: selector(primary),
						to: selector(fallback),
						role: "executor",
						activeIndex: 1,
						chainLength: 2,
					}),
				]);
				expect(child.thinkingLevel).toBe(Effort.High);
				expect(
					events.filter(event => event.type === "message_end" && event.message.role === "assistant"),
				).toHaveLength(1);
				const assistantStarts = events.filter(
					event => event.type === "message_start" && event.message.role === "assistant",
				);
				const discardedMessages = events.flatMap(event =>
					(event.type === "message_start" || event.type === "message_update") && event.message.role === "assistant"
						? [event.message]
						: [],
				);
				expect(assistantStarts).toHaveLength(1);
				expect(
					discardedMessages.some(message => JSON.stringify(message.content).includes(discardedAttemptContent)),
				).toBe(false);

				expect(events.filter(event => event.type === "turn_end")).toHaveLength(1);
				expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
			}
		} finally {
			await Promise.all(childSessions.map(child => child.dispose()));
		}
		expect(calls).toEqual([selector(primary), selector(fallback), selector(primary), selector(fallback)]);
	});
	it("re-clamps thinking after resolution skips to a narrower fallback", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.XHigh },
			streamFn: ((model, _context, options) => {
				calls.push(selector(model));
				expect(options?.fallbackManaged).toBe(true);
				return successfulStream(model);
			}) satisfies AgentOptions["streamFn"],
		});
		const child = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			thinkingLevel: Effort.XHigh,
		});
		try {
			child.setConfiguredModelChain("default", ["unknown/primary", selector(fallback)], "test");
			await child.prompt("Resolve the fallback before requesting");
			await child.waitForIdle();

			expect(calls).toEqual([selector(fallback)]);
			expect(child.thinkingLevel).toBe(Effort.High);
		} finally {
			await child.dispose();
		}
	});
});
