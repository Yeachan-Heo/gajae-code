/**
 * Issue #4650 — provider_safety_stop diagnostics hint (integration).
 *
 * Proves the presentation-only contract end-to-end against a real AgentSession:
 * - terminal stop unchanged: exactly one provider dispatch, no retry, no state
 *   mutation (#2069/#2077 invariants preserved);
 * - raw provider refusal retained with the hint appended in the TUI render;
 * - the alternate named from the configured chain when valid, static fallback
 *   otherwise;
 * - no hint for unrelated error kinds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentOptions } from "@gajae-code/agent-core";
import { type AssistantMessage, applyProviderSafetyStop, getBundledModel, type Model } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	formatProviderSafetyStopDisplayError,
	resolveProviderSafetyStopHint,
} from "@gajae-code/coding-agent/session/provider-safety-stop-hint";
import { TempDir } from "@gajae-code/utils";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const selector = (model: Model) => `${model.provider}/${model.id}`;

function safetyStopStream(
	model: Model,
	refusal: string,
	transportFacts?: { status: number },
	options?: { authenticated?: boolean },
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage & {
			transportFailure?: { kind: "transport"; status: number };
		} = {
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
			errorMessage: refusal,
			...(transportFacts
				? {
						errorStatus: transportFacts.status,
						transportFailure: { kind: "transport" as const, status: transportFacts.status },
					}
				: {}),
			timestamp: Date.now(),
		};
		// Simulate the first-party adapter envelope: a structured refusal signal
		// parsed from the provider's own response mints the terminal authority.
		// Omitting the mark simulates a wire/custom-stream payload that only
		// carries the forged field.
		if (options?.authenticated !== false) applyProviderSafetyStop(message, "refusal");
		else message.errorKind = "provider_safety_stop";
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function genericErrorStream(
	model: Model,
	errorMessage = "401 unauthorized: invalid api key",
	errorKind?: AssistantMessage["errorKind"],
): AssistantMessageEventStream {
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
			errorMessage,
			...(errorKind ? { errorKind } : {}),
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

describe("provider safety stop hint e2e (#4650)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@safety-stop-hint-");
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
		session = undefined;
	});

	it("stays terminal with one dispatch, and the hint names the configured alternate", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const alternate = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !alternate) throw new Error("Expected bundled test models");
		const refusal = "Refusal (reasoning_extraction): This request was blocked.";
		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, _options) => {
				calls.push(selector(model));
				return safetyStopStream(model, refusal);
			}) satisfies AgentOptions["streamFn"],
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
		});
		settings.set("modelRoles", { default: [selector(primary), selector(alternate)] });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		await session.prompt("trigger safety stop");
		await session.waitForIdle();

		// Terminal invariant: exactly one dispatch, no retry, no fallback switch.
		expect(calls).toEqual([selector(primary)]);
		expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
		const last = [...session.state.messages].reverse().find(message => message.role === "assistant");
		expect(last).toMatchObject({
			stopReason: "error",
			errorKind: "provider_safety_stop",
			errorMessage: refusal,
		});

		// The hint names the configured alternate validated against the catalog.
		const hint = resolveProviderSafetyStopHint(last as AssistantMessage, session);
		expect(hint).toContain("/model openai/gpt-4o-mini");
		expect(hint).toContain("not guaranteed");

		// And the composed display error is exactly the raw refusal first,
		// then the hint — pinned as composition, not mere non-emptiness.
		const display = formatProviderSafetyStopDisplayError(last as AssistantMessage, "openai/gpt-4o-mini");
		expect(display).toBe(`${refusal}\n${hint}`);
		expect(display?.startsWith(refusal)).toBe(true);
	});

	it("does not advance a multi-model chain when a safety stop has transport facts", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const alternate = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !alternate) throw new Error("Expected bundled test models");
		for (const status of [400, 429]) {
			const calls: string[] = [];
			const agent = new Agent({
				getApiKey: provider => `${provider}-test-key`,
				initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: ((model, _context, _options) => {
					calls.push(selector(model));
					return safetyStopStream(model, "Refusal (safety): transport-backed stop", { status });
				}) satisfies AgentOptions["streamFn"],
			});
			const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 });
			settings.set("modelRoles", { default: [selector(primary), selector(alternate)] });
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: new ModelRegistry(authStorage),
			});
			const events: AgentSessionEvent[] = [];
			session.subscribe(event => events.push(event));

			await session.prompt("trigger transport-backed safety stop");
			await session.waitForIdle();

			expect(calls).toEqual([selector(primary)]);
			expect(events.filter(event => event.type === "model_fallback_switched")).toHaveLength(0);
			const last = [...session.state.messages].reverse().find(message => message.role === "assistant");
			expect(last).toMatchObject({
				stopReason: "error",
				errorKind: "provider_safety_stop",
				errorStatus: status,
				transportFailure: { kind: "transport", status },
			});
			await session.dispose();
			session = undefined;
		}
	});
	it("does not let a forged safety-stop field suppress fallback (#4777 review)", async () => {
		// A wire/custom-stream payload that self-labels the typed kind without
		// adapter-minted provenance must never terminalize: unauthenticated
		// provider metadata stays fallback-eligible so a compromised provider
		// cannot force refusal by naming the field. Transport facts do not
		// upgrade provenance — retryable and non-retryable statuses both keep
		// the chain advancing.
		for (const status of [400, 429] as const) {
			const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
			const alternate = getBundledModel("openai", "gpt-4o-mini");
			if (!primary || !alternate) throw new Error("Expected bundled test models");
			const calls: string[] = [];
			const agent = new Agent({
				getApiKey: provider => `${provider}-test-key`,
				initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: ((model, _context, _options) => {
					calls.push(selector(model));
					return safetyStopStream(
						model,
						"Upstream returned an unclassified error envelope",
						{ status },
						{
							authenticated: false,
						},
					);
				}) satisfies AgentOptions["streamFn"],
			});
			const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 });
			settings.set("modelRoles", { default: [selector(primary), selector(alternate)] });
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: new ModelRegistry(authStorage),
			});

			await session.prompt("trigger forged safety-stop label");
			await session.waitForIdle();

			// The forged label never terminalized: the chain advanced past the
			// primary to the configured alternate.
			expect(calls).toContain(selector(alternate));
			const last = [...session.state.messages].reverse().find(message => message.role === "assistant");
			expect((last as AssistantMessage).errorKind).toBeUndefined();
			expect(resolveProviderSafetyStopHint(last as AssistantMessage, session)).toBeUndefined();
			await session.dispose();
			session = undefined;
		}
	});

	it("falls back to bounded static guidance when no alternate is configured", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled test model");
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, _options) =>
				safetyStopStream(model, "Refusal (no details provided)")) satisfies AgentOptions["streamFn"],
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		await session.prompt("trigger safety stop without alternate");
		await session.waitForIdle();
		const last = [...session.state.messages].reverse().find(message => message.role === "assistant");
		const hint = resolveProviderSafetyStopHint(last as AssistantMessage, session);
		expect(hint).toContain("manual model switch");
		expect(hint).not.toContain("chain also contains");
	});

	it("produces no hint for unrelated terminal errors", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled test model");
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, _options) => genericErrorStream(model)) satisfies AgentOptions["streamFn"],
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		await session.prompt("trigger unrelated error");
		await session.waitForIdle();
		const last = [...session.state.messages].reverse().find(message => message.role === "assistant");
		expect(resolveProviderSafetyStopHint(last as AssistantMessage, session)).toBeUndefined();
	});

	it("does not forge a typed safety stop from ordinary refusal prose", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled test model");
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((model, _context, _options) =>
				genericErrorStream(
					model,
					"The provider refused this malformed request",
				)) satisfies AgentOptions["streamFn"],
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 1 });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		await session.prompt("trigger ordinary refusal");
		await session.waitForIdle();
		const last = [...session.state.messages]
			.reverse()
			.find(message => message.role === "assistant") as AssistantMessage;
		expect(last.errorKind).toBeUndefined();
		expect(resolveProviderSafetyStopHint(last, session)).toBeUndefined();
	});
});
