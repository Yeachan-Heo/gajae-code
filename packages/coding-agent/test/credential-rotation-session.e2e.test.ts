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

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function errorStream(
	model: Model,
	options: {
		status: number;
		errorMessage: string;
		providerCode?: string;
		content?: AssistantMessage["content"];
	},
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: options.content ?? [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: options.errorMessage,
			errorStatus: options.status,
			timestamp: Date.now(),
			transportFailure: {
				kind: "transport",
				status: options.status,
				...(options.providerCode ? { providerCode: options.providerCode } : {}),
			},
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function quotaStream(model: Model): AssistantMessageEventStream {
	return errorStream(model, { status: 429, errorMessage: "rate limit exceeded" });
}

function auth401Stream(model: Model): AssistantMessageEventStream {
	return errorStream(model, { status: 401, errorMessage: "Unauthorized" });
}

function forbidden403Stream(model: Model): AssistantMessageEventStream {
	return errorStream(model, { status: 403, errorMessage: "Forbidden", providerCode: "forbidden" });
}

function successfulStream(model: Model): AssistantMessageEventStream {
	return createMockModel({ responses: [{ content: ["accepted"] }] }).stream(model, {
		systemPrompt: [],
		messages: [],
		tools: [],
	});
}

/**
 * Caller-level regression for the credential pin guard inside
 * `#markFailedCredential`.
 *
 * A controller-only test cannot guard this: the invariant spans the fallback
 * controller's restore budget, the session's live model, and event emission. The
 * defect this pins is that a rotation whose `restorePreviousEntryForRetry()` is
 * REFUSED must not be reported as a credential switch and must not force a
 * same-model retry — the chain has to advance as originally decided, or the
 * controller ends up on one entry while the session requests another.
 */
describe("AgentSession credential pin — no mutation on a pinned provider", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@credential-rotation-session-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		// Three stored credentials on the PRIMARY provider so two successive
		// rotations are possible. Deliberately NO runtime API key for it: a
		// runtime override would trip the pin guard and suppress rotation.
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-1" },
			{ type: "api_key", key: "anthropic-key-2" },
			{ type: "api_key", key: "anthropic-key-3" },
		]);
		// The fallback provider only has to be authenticated for the chain to
		// resolve; it is never rotated.
		authStorage.setRuntimeApiKey("openai", "test-key");
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("does mutate credential state when NOT pinned (positive control for the spies)", async () => {
		// Without this the pinned case's `not.toHaveBeenCalled()` could pass simply
		// because the spies are attached to an object the session never touches.
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");

		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, _options) =>
				selector(model) === selector(primary)
					? quotaStream(model)
					: successfulStream(model)) satisfies AgentOptions["streamFn"],
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

		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		await session.prompt("unpinned provider may rotate");
		await session.waitForIdle();
		expect(markUsageLimitReached).toHaveBeenCalled();
	});

	it("never rotates a `--credential`-pinned row, and therefore never announces a switch", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");

		// Pin the provider to ONE stored row via the runtime credential selector —
		// the `--credential` surface, NOT the `--api-key` override. The pool still
		// has three healthy rows, so only the pin can prevent rotation. Resolving
		// the row id through the public snapshot means a wrong API fails the test
		// instead of silently degrading it to the other override.
		const pinnedRow = authStorage.exportSnapshot().credentials.find(entry => entry.provider === "anthropic");
		if (!pinnedRow) throw new Error("Expected a stored anthropic credential to pin");
		authStorage.setRuntimeCredentialSelector("anthropic", { kind: "id", value: String(pinnedRow.id) });
		expect(authStorage.hasRuntimeCredentialSelector("anthropic")).toBe(true);
		// The pin must NOT be the API-key override: that is a separate guard, and
		// checking only it was the original defect.
		expect(authStorage.hasRuntimeApiKey("anthropic")).toBe(false);

		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, _options) => {
				calls.push(selector(model));
				return selector(model) === selector(primary) ? quotaStream(model) : successfulStream(model);
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

		// Zero switch events alone would ALSO hold if rotation had been attempted
		// and merely failed to produce a distinct row. Spy on the two mutation
		// entry points so the assertion distinguishes "the pin guard stopped it
		// before any mutation" from "rotation ran and happened to yield nothing".
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		const invalidateCredentialMatching = vi.spyOn(authStorage, "invalidateCredentialMatching");

		await session.prompt("pinned credential must not rotate");
		await session.waitForIdle();

		// The pin guard runs FIRST and for every trigger class, so NO credential
		// state may be mutated at all — not merely "no switch was reported".
		expect(markUsageLimitReached).not.toHaveBeenCalled();
		expect(invalidateCredentialMatching).not.toHaveBeenCalled();
		// The primary is tried once and the chain advances as normal.
		expect(calls).toEqual([selector(primary), selector(fallback)]);
	});
});

/**
 * Completes the three residual gaps around mid-session credential rotation
 * (#3723): observable `credential_switched`, 401 rotate-and-retry parity with
 * 429, and a terminal 403 that never mutates credential state.
 */
describe("AgentSession credential rotation — observability and 401 parity (#3723)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@credential-rotation-obs-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-1" },
			{ type: "api_key", key: "anthropic-key-2" },
			{ type: "api_key", key: "anthropic-key-3" },
		]);
		authStorage.setRuntimeApiKey("openai", "test-key");
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function rowIds(): number[] {
		return authStorage
			.exportSnapshot()
			.credentials.filter(entry => entry.provider === "anthropic")
			.map(entry => entry.id);
	}

	it("emits credential_switched with opaque row ids on a content-free 429 rotation", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled test model");

		const ids = rowIds();
		expect(ids.length).toBeGreaterThanOrEqual(2);

		let attempts = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, _options) => {
				attempts += 1;
				// First attempt fails with quota; the rotated credential succeeds.
				return attempts === 1 ? quotaStream(model) : successfulStream(model);
			}) satisfies AgentOptions["streamFn"],
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			// Single-entry chain so this exercises non-managed mid-session rotation.
			modelRoles: { default: selector(primary) },
			"retry.enabled": true,
			"retry.maxRetries": 2,
			"retry.baseDelayMs": 1,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		const switches: Array<Extract<AgentSessionEvent, { type: "credential_switched" }>> = [];
		session.subscribe(event => {
			if (event.type === "credential_switched") switches.push(event);
		});

		await session.prompt("rotate on 429 and announce");
		await session.waitForIdle();

		expect(attempts).toBe(2);
		expect(switches).toHaveLength(1);
		const event = switches[0]!;
		expect(event.provider).toBe("anthropic");
		expect(event.reason).toBe("rate_limit");
		expect(typeof event.from).toBe("number");
		expect(typeof event.to).toBe("number");
		expect(event.from).not.toBe(event.to);
		expect(ids).toContain(event.from);
		expect(ids).toContain(event.to);
		// Opacity: the wire payload must not carry key material.
		expect(JSON.stringify(event)).not.toContain("anthropic-key-");
		expect(typeof event.eventId).toBe("string");
		expect(typeof event.timestamp).toBe("number");
	});

	it("rotates-and-retries the same model on a content-free 401 and emits credential_switched", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");

		const ids = rowIds();
		const calls: string[] = [];
		let primaryAttempts = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, _options) => {
				calls.push(selector(model));
				if (selector(model) === selector(primary)) {
					primaryAttempts += 1;
					// First primary attempt is a content-free 401; after rotation the
					// same model succeeds. Fallback must not be reached.
					return primaryAttempts === 1 ? auth401Stream(model) : successfulStream(model);
				}
				return successfulStream(model);
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

		const switches: Array<Extract<AgentSessionEvent, { type: "credential_switched" }>> = [];
		const fallbackSwitches: Array<Extract<AgentSessionEvent, { type: "model_fallback_switched" }>> = [];
		session.subscribe(event => {
			if (event.type === "credential_switched") switches.push(event);
			if (event.type === "model_fallback_switched") fallbackSwitches.push(event);
		});

		const invalidateCredentialMatching = vi.spyOn(authStorage, "invalidateCredentialMatching");

		await session.prompt("401 should rotate-and-retry same model");
		await session.waitForIdle();

		expect(invalidateCredentialMatching).toHaveBeenCalled();
		// Same model, two attempts (failed + rotated success). Fallback unused.
		expect(primaryAttempts).toBe(2);
		expect(calls.every(call => call === selector(primary))).toBe(true);
		expect(fallbackSwitches).toHaveLength(0);
		expect(switches).toHaveLength(1);
		expect(switches[0]).toEqual(
			expect.objectContaining({
				type: "credential_switched",
				provider: "anthropic",
				reason: "auth",
			}),
		);
		expect(ids).toContain(switches[0]!.from);
		expect(ids).toContain(switches[0]!.to);
		expect(switches[0]!.from).not.toBe(switches[0]!.to);
	});

	it("does not mutate credentials or emit credential_switched on a terminal 403", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");

		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, _options) => {
				calls.push(selector(model));
				return selector(model) === selector(primary) ? forbidden403Stream(model) : successfulStream(model);
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

		const switches: Array<Extract<AgentSessionEvent, { type: "credential_switched" }>> = [];
		session.subscribe(event => {
			if (event.type === "credential_switched") switches.push(event);
		});

		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		const invalidateCredentialMatching = vi.spyOn(authStorage, "invalidateCredentialMatching");

		await session.prompt("403 is terminal");
		await session.waitForIdle();

		expect(markUsageLimitReached).not.toHaveBeenCalled();
		expect(invalidateCredentialMatching).not.toHaveBeenCalled();
		expect(switches).toHaveLength(0);
		// Terminal forbidden never enters retry/fallback admission.
		expect(calls).toEqual([selector(primary)]);
	});

	it("does not announce a switch when a single-row pool cannot rotate on 401", async () => {
		// Replace the multi-row pool with a single credential so invalidation
		// cannot produce a distinct row.
		await authStorage.set("anthropic", [{ type: "api_key", key: "only-anthropic-key" }]);

		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled test model");

		let attempts = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, _options) => {
				attempts += 1;
				return auth401Stream(model);
			}) satisfies AgentOptions["streamFn"],
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			modelRoles: { default: selector(primary) },
			"retry.enabled": true,
			"retry.maxRetries": 3,
			"retry.baseDelayMs": 1,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});

		const switches: Array<Extract<AgentSessionEvent, { type: "credential_switched" }>> = [];
		session.subscribe(event => {
			if (event.type === "credential_switched") switches.push(event);
		});

		await session.prompt("single-row 401 must surface");
		await session.waitForIdle();

		// One attempt only: auth without a distinct alternate does not same-key retry.
		expect(attempts).toBe(1);
		expect(switches).toHaveLength(0);
	});
});
