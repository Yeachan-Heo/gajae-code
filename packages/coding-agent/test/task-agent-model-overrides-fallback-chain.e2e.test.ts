import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import { type AssistantMessage, Effort, getBundledModel, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	isExplicitProviderModelSelector,
	resolveAgentModelPatterns,
	resolveModelOverrideWithAuthFallback,
} from "@gajae-code/coding-agent/config/model-resolver";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { runSubprocess, runSubprocessOnce } from "@gajae-code/coding-agent/task/executor";
import type { TaskRoutingEvidence } from "@gajae-code/coding-agent/task/types";
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

	it("fails closed on a missing explicit provider/model without parent substitution", async () => {
		const parent = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!parent) throw new Error("Expected bundled parent model");
		const getApiKey = vi.fn(async (model: Model) => (model.provider === parent.provider ? "test-key" : undefined));
		const registry = {
			getAvailable: () => [parent],
			getApiKey,
		};
		const result = await resolveModelOverrideWithAuthFallback(
			["google-antigravity/gemini-3.8-flash-tiered"],
			selector(parent),
			registry as never,
		);
		expect(result.model).toBeUndefined();
		expect(result.authFallbackUsed).toBe(false);
		expect(result.parentFallbackSelector).toBeUndefined();
		expect(getApiKey).not.toHaveBeenCalled();
	});

	it("fails closed on an unauthenticated explicit selector without parent substitution", async () => {
		const parent = getBundledModel("anthropic", "claude-sonnet-4-5");
		const requested = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!parent || !requested) throw new Error("Expected bundled test models");
		const getApiKey = vi.fn(async (model: Model) => (model.id === parent.id ? "test-key" : undefined));
		const registry = {
			getAvailable: () => [parent, requested],
			getApiKey,
		};
		const result = await resolveModelOverrideWithAuthFallback(
			[selector(requested)],
			selector(parent),
			registry as never,
		);
		expect(result.model).toBeUndefined();
		expect(result.authFallbackUsed).toBe(false);
		expect(result.parentFallbackSelector).toBeUndefined();
		expect(result.skips).toEqual([{ selector: selector(requested), reason: "unauthenticated" }]);
		expect(getApiKey.mock.calls.map(call => (call[0] as Model).id)).toEqual([requested.id]);
	});

	it("preserves an authenticated explicit chain tail without parent substitution", async () => {
		const parent = getBundledModel("anthropic", "claude-sonnet-4-5");
		const primary = getBundledModel("anthropic", "claude-sonnet-4-6");
		const fallback = getBundledModel("anthropic", "claude-opus-4-6");
		if (!parent || !primary || !fallback) throw new Error("Expected bundled test models");
		const getApiKey = vi.fn(async (model: Model) =>
			model.id === fallback.id || model.id === parent.id ? "test-key" : undefined,
		);
		const registry = {
			getAvailable: () => [parent, primary, fallback],
			getApiKey,
		};
		const result = await resolveModelOverrideWithAuthFallback(
			[selector(primary), selector(fallback)],
			selector(parent),
			registry as never,
			undefined,
			undefined,
			{ managedFallback: true },
		);
		expect(result.model?.id).toBe(fallback.id);
		expect(result.authFallbackUsed).toBe(false);
		expect(result.parentFallbackSelector).toBeUndefined();
		expect(result.activeIndex).toBe(1);
		expect(result.skips).toEqual([{ selector: selector(primary), reason: "unauthenticated" }]);
		expect(getApiKey.mock.calls.map(call => (call[0] as Model).id)).toEqual([primary.id, fallback.id]);
	});

	it("executor setup fails closed with zero parent/other-provider calls for a missing exact selector", async () => {
		const parent = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!parent) throw new Error("Expected bundled parent model");
		const getApiKey = vi.fn(async () => "parent-key");
		const modelRegistry = {
			refresh: async () => {},
			getAvailable: () => [parent],
			getApiKey,
			authStorage,
		} as unknown as ModelRegistry;
		const result = await runSubprocess({
			cwd: tempDir.path(),
			agent: { name: "critic", description: "test", systemPrompt: "test", source: "bundled" },
			task: "do not substitute parent",
			index: 0,
			id: "critic-missing-exact",
			modelOverride: "google-antigravity/gemini-3.8-flash-tiered",
			parentActiveModelPattern: selector(parent),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			enableLsp: false,
		});
		expect(result.exitCode).toBe(1);
		expect(result.modelSubstitutionWarning).toBeUndefined();
		expect(result.setupFailure?.summary).toMatch(/google-antigravity\/gemini-3\.8-flash-tiered/);
		expect(result.setupFailure?.summary).toMatch(/fail closed|do not fall back/i);
		expect(getApiKey).not.toHaveBeenCalled();
	});

	it("keeps parent fallback for mixed explicit-plus-unqualified chains", async () => {
		const parent = getBundledModel("anthropic", "claude-sonnet-4-5");
		const requested = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!parent || !requested) throw new Error("Expected bundled test models");
		const getApiKey = vi.fn(async (model: Model) => (model.id === parent.id ? "test-key" : undefined));
		const result = await resolveModelOverrideWithAuthFallback([selector(requested), requested.id], selector(parent), {
			getAvailable: () => [parent, requested],
			getApiKey,
		} as never);
		expect(result.model?.id).toBe(parent.id);
		expect(result.authFallbackUsed).toBe(true);
		expect(result.parentFallbackSelector).toBe(selector(parent));
	});

	it("does not treat glob selectors as explicit exact pins", () => {
		expect(isExplicitProviderModelSelector("anthropic/*")).toBe(false);
		expect(isExplicitProviderModelSelector("*/claude-sonnet-4-5")).toBe(false);
		expect(isExplicitProviderModelSelector("anthropic/claude-sonnet-4-5")).toBe(true);
	});

	it("still seeds canonical parent stickiness for explicit exact selectors", async () => {
		const parent = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!parent) throw new Error("Expected bundled parent model");
		const seedCanonicalVariant = vi.fn();
		await resolveModelOverrideWithAuthFallback(
			["google-antigravity/gemini-3.8-flash-tiered"],
			selector(parent),
			{
				getAvailable: () => [parent],
				getApiKey: async () => "parent-key",
				seedCanonicalVariant,
			} as never,
			undefined,
			"parent-session",
			undefined,
			"child-canonical",
		);
		expect(seedCanonicalVariant).toHaveBeenCalledWith("child-canonical", parent);
	});

	it("autorouting preflight preserves credentialMissing advance for an unauthenticated exact candidate", async () => {
		const unauthed = getBundledModel("anthropic", "claude-sonnet-4-5");
		const authed = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!unauthed || !authed) throw new Error("Expected bundled test models");
		const getApiKey = vi.fn(async (model: Model) => (model.id === authed.id ? "test-key" : undefined));
		const modelRegistry = {
			refresh: async () => {},
			getAvailable: () => [unauthed, authed],
			getApiKey,
			authStorage,
		} as unknown as ModelRegistry;
		const probe = await runSubprocessOnce({
			cwd: tempDir.path(),
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "preflight unauth",
			index: 0,
			id: "preflight-unauth-exact",
			modelOverride: [selector(unauthed)],
			parentActiveModelPattern: undefined,
			preflightProbe: true,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			enableLsp: false,
		});
		expect(probe.preflightProbeAccepted).toBeFalsy();
		expect(probe.preflightFailure).toEqual({ kind: "local", op: "auth_resolve", transient: false });
		expect(probe.modelSubstitutionWarning).toBeUndefined();
		expect(getApiKey.mock.calls.map(call => (call[0] as Model).id)).toEqual([unauthed.id]);

		const unauthedSelector = selector(unauthed);
		const authedSelector = selector(authed);
		const routing: TaskRoutingEvidence = {
			tier: "balanced",
			requestedSelector: unauthedSelector,
			effectiveModel: unauthedSelector,
			substitutions: [],
		};
		const ledger = await runSubprocess({
			cwd: tempDir.path(),
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "advance after unauth",
			index: 0,
			id: "preflight-advance-unauth",
			runMode: "initial",
			autoroutingPreflight: true,
			autoroutingCandidates: [unauthedSelector, authedSelector],
			parentActiveModelPattern: undefined,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			enableLsp: false,
			routing,
		});
		const attempts = ledger.routing?.attempts ?? [];
		expect(attempts[0]).toEqual(
			expect.objectContaining({
				selector: unauthedSelector,
				phase: "probe",
				code: "credential_unavailable",
			}),
		);
		expect(attempts.some(attempt => attempt.selector === authedSelector)).toBe(true);
		expect(new Set(attempts.map(attempt => attempt.selector))).toEqual(new Set([unauthedSelector, authedSelector]));
	});
});
