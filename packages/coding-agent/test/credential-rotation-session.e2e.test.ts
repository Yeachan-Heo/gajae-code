import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import * as oauth from "@gajae-code/ai/utils/oauth";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

const selector = (model: Model) => `${model.provider}/${model.id}`;

function quotaStream(model: Model): AssistantMessageEventStream {
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
			errorMessage: "rate limit exceeded",
			errorStatus: 429,
			timestamp: Date.now(),
			transportFailure: { kind: "transport", status: 429 },
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
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

	it("does not back off a sticky OAuth row for a later env-backed turn failure", async () => {
		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "anthropic-oauth-token",
				refresh: "anthropic-refresh-token",
				expires: Date.now() + 3_600_000,
				accountId: "anthropic-account",
			},
		]);
		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials.anthropic;
			return credential ? { apiKey: credential.access, newCredentials: credential } : null;
		});
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const modelRegistry = new ModelRegistry(authStorage);
		let anthropicRequests = 0;
		const anthropicApiKeys: string[] = [];
		const agent = new Agent({
			getApiKey: provider => {
				if (!session) throw new Error("Session not initialized");
				return modelRegistry.getApiKeyForProvider(provider, session.credentialSessionId);
			},
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, options) => {
				if (model.provider === "anthropic") {
					anthropicApiKeys.push(String(options?.apiKey));
					if (anthropicRequests++ > 0) return quotaStream(model);
				}
				return successfulStream(model);
			}) satisfies AgentOptions["streamFn"],
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 1,
			"retry.enabled": false,
			"retry.maxRetries": 0,
		});
		settings.set("modelRoles", { default: [selector(primary), selector(fallback)] });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("establish the sticky OAuth account");
		await session.waitForIdle();
		const oauthRowId = authStorage.getSessionCredentialRowId("anthropic", session.credentialSessionId);
		if (oauthRowId === undefined) throw new Error("Expected the first request to establish an OAuth row");
		expect(anthropicApiKeys[0]).toBe("anthropic-oauth-token");
		expect(authStorage.getSessionCredentialType("anthropic", session.credentialSessionId)).toBe("oauth");

		authStorage.setConfigApiKey("anthropic", "anthropic-env-key", {
			envSourced: true,
			owner: modelRegistry.getAuthStorageOwner(),
		});
		const markUsageLimitReached = vi.spyOn(authStorage, "markUsageLimitReached");
		const invalidateCredentialMatching = vi.spyOn(authStorage, "invalidateCredentialMatching");

		await session.prompt("fail using the env-backed key");
		await session.waitForIdle();

		expect(anthropicApiKeys[1]).toBe("anthropic-env-key");
		expect(markUsageLimitReached).not.toHaveBeenCalled();
		expect(invalidateCredentialMatching).not.toHaveBeenCalled();
		expect(authStorage.getSessionCredentialRowId("anthropic", session.credentialSessionId)).toBe(oauthRowId);
		expect(authStorage.isCredentialAvailable("anthropic", oauthRowId)).toBe(true);
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
