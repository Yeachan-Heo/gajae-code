import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

/** Build an assistant `message_end` payload signalling the provider auto-dropped fast mode. */
function disabledPriorityMessage(): AssistantMessage {
	return { ...createAssistantMessage("ok"), disabledFeatures: ["priority"] };
}

describe("AgentSession fast-mode predicate", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-fast-mode-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("returns false for an undefined provider even under an unscoped priority tier", () => {
		session.setServiceTier("priority");
		// Unscoped priority applies to a concrete provider...
		expect(session.isFastForProvider("anthropic")).toBe(true);
		expect(session.isFastForProvider("openai")).toBe(true);
		// ...but never when there is no provider (no model selected).
		expect(session.isFastForProvider(undefined)).toBe(false);
	});

	it("is provider-scoped for claude-only", () => {
		session.setServiceTier("claude-only");
		expect(session.isFastForProvider("anthropic")).toBe(true);
		expect(session.isFastForProvider("openai")).toBe(false);
		expect(session.isFastForProvider("openai-codex")).toBe(false);
		expect(session.isFastForProvider(undefined)).toBe(false);
	});

	it("isFastModeActive reflects the current model's provider and the configured tier", () => {
		expect(session.isFastModeActive()).toBe(false);
		session.setServiceTier("priority");
		// current model is anthropic
		expect(session.isFastModeActive()).toBe(true);
		// claude-only still matches the anthropic current model
		session.setServiceTier("claude-only");
		expect(session.isFastModeActive()).toBe(true);
		// openai-only does not match the anthropic current model
		session.setServiceTier("openai-only");
		expect(session.isFastModeActive()).toBe(false);
		session.setServiceTier(undefined);
		expect(session.isFastModeActive()).toBe(false);
	});
});

describe("AgentSession fast-mode Q1 auto-disable (provider-scoped marker)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-fast-mode-q1-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	async function emitDisabledPriority(): Promise<AgentSessionEvent[]> {
		const events: AgentSessionEvent[] = [];
		const unsubscribe = session.subscribe(event => events.push(event));
		const message = disabledPriorityMessage();
		session.agent.emitExternalEvent({ type: "message_end", message });
		// #handleAgentEvent runs synchronously up to its first await; flush microtasks.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		unsubscribe();
		return events;
	}

	const serviceTierEntries = () => sessionManager.getBranch().filter(e => e.type === "service_tier_change");
	const fastWarnings = (events: AgentSessionEvent[]) =>
		events.filter(e => e.type === "notice" && e.source === "priority");

	it("preserves the intended tier and only suppresses the current provider after Q1 auto-disable", async () => {
		session.setServiceTier("priority");
		const events = await emitDisabledPriority();

		// Intent is preserved (not cleared to undefined).
		expect(session.serviceTier).toBe("priority");
		// The current (anthropic) model now shows fast OFF via the effective predicate...
		expect(session.isFastModeActive()).toBe(false);
		// ...but pure intent for other providers is unaffected.
		expect(session.isFastForProvider("openai")).toBe(true);
		// Warning fired exactly once.
		expect(fastWarnings(events)).toHaveLength(1);
	});

	it("is provider-scoped: a different provider still shows fast after an anthropic auto-disable", async () => {
		session.setServiceTier("priority");
		await emitDisabledPriority();
		expect(session.isFastModeActive()).toBe(false); // anthropic current, marked

		// Switch the current model to OpenAI (unmarked provider) → effective fast ON again.
		const openai = getBundledModel("openai", "gpt-5.2");
		if (!openai) throw new Error("Expected built-in openai model to exist");
		session.agent.setModel(openai);
		expect(session.isFastModeActive()).toBe(true);

		// Switch back to anthropic → still suppressed until re-arm.
		const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!anthropic) throw new Error("Expected built-in anthropic model to exist");
		session.agent.setModel(anthropic);
		expect(session.isFastModeActive()).toBe(false);
	});

	it("does NOT append a service_tier_change(null) entry on Q1 auto-disable", async () => {
		session.setServiceTier("priority");
		const beforeCount = serviceTierEntries().length;
		await emitDisabledPriority();
		// Only the explicit setServiceTier("priority") entry exists; no null entry appended.
		expect(serviceTierEntries().length).toBe(beforeCount);
		expect(serviceTierEntries().every(e => e.serviceTier !== null)).toBe(true);
	});

	it("warns only once per provider across repeated disabled-priority messages", async () => {
		session.setServiceTier("priority");
		const first = await emitDisabledPriority();
		const second = await emitDisabledPriority();
		expect(fastWarnings(first)).toHaveLength(1);
		expect(fastWarnings(second)).toHaveLength(0);
	});

	it("/fast on re-arms after auto-disable even when intent is already enabled (no new history)", async () => {
		session.setServiceTier("priority");
		await emitDisabledPriority();
		expect(session.isFastModeActive()).toBe(false);
		const historyBefore = serviceTierEntries().length;

		// setFastMode(true) is the `/fast on` path; intent is unchanged ("priority").
		session.setFastMode(true);

		// Marker cleared → current model effective fast ON again.
		expect(session.isFastModeActive()).toBe(true);
		// Intent unchanged → no new service_tier_change entry appended.
		expect(serviceTierEntries().length).toBe(historyBefore);

		// A later rejection can warn once more (dedup was reset by re-arm).
		const events = await emitDisabledPriority();
		expect(fastWarnings(events)).toHaveLength(1);
	});

	it("explicit /fast off appends a service_tier_change(null) entry", async () => {
		session.setServiceTier("priority");
		const before = serviceTierEntries().length;
		session.setFastMode(false);
		const entries = serviceTierEntries();
		expect(entries.length).toBe(before + 1);
		expect(entries.at(-1)?.serviceTier).toBeNull();
		expect(session.serviceTier).toBeUndefined();
	});
});
