import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage, Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import {
	applyPreparedModelProfileActivation,
	prepareModelProfileActivation,
} from "@gajae-code/coding-agent/config/model-profile-activation";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

// Regression coverage for the combo-preset resume bug: activating a model
// profile (e.g. opus-codex) whose main model differs from the startup base
// model used to record the main model with role="temporary". On resume the
// session restored `models.default` (the stale pre-profile base model, e.g.
// openai-codex/gpt-5.5), flipping the main provider away from the profile's
// intended main model. Profile activation now records its main model as the
// session default via `persistAsSessionDefault`, while transient switches
// (retry/fallback/context-promotion/plan mode) stay role="temporary".
describe("AgentSession setModelTemporary persistAsSessionDefault", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-profile-resume-default-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function makeSession(
		startModel: Model,
		requestedModels?: string[],
		allowSkillRuntimePreferences: boolean = true,
	): AgentSession {
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: startModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels?.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			allowSkillRuntimePreferences,
		});
	}

	function resolveModels(): { base: Model; profileMain: Model } {
		const base = modelRegistry.find("openai-codex", "gpt-5.5");
		const profileMain = modelRegistry.find("anthropic", "claude-opus-4-8");
		if (!base || !profileMain) {
			throw new Error("Expected codex and anthropic opus models to exist");
		}
		return { base, profileMain };
	}

	it("records the profile main model as the resume default without touching global settings", async () => {
		const { base, profileMain } = resolveModels();
		session = makeSession(base);

		// Session start records the base default model.
		await session.setModel(base);
		expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
		const globalDefaultBefore = session.settings.getModelRole("default");

		// Combo-profile activation applies the main model for this session only.
		await session.setModelTemporary(profileMain, undefined, { persistAsSessionDefault: true });

		// The default that resume restores is now the profile's main model.
		expect(session.sessionManager.buildSessionContext().models.default).toBe("anthropic/claude-opus-4-8");
		// Global default setting is untouched (apply-for-this-session semantics).
		expect(session.settings.getModelRole("default")).toBe(globalDefaultBefore);
	});

	it("keeps a transient switch as role=temporary so resume does not adopt it", async () => {
		const { base, profileMain } = resolveModels();
		session = makeSession(base);

		await session.setModel(base);
		// No persistAsSessionDefault: simulates a retry/fallback/plan-mode switch.
		await session.setModelTemporary(profileMain);

		expect(session.model?.provider).toBe("anthropic");
		expect(session.model?.id).toBe("claude-opus-4-8");
		// Resume still restores the explicit base default, not the transient model.
		expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
	});
	it("applies a skill's requested model and effort for its turn, then restores the session model", async () => {
		const { base, profileMain } = resolveModels();
		const requestedModels: string[] = [];
		session = makeSession(base, requestedModels);
		const originalThinking = session.thinkingLevel;

		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "# Creative\nWrite.",
			display: true,
			attribution: "user",
			details: {
				name: "creative",
				path: "/tmp/creative/SKILL.md",
				lineCount: 2,
				requestedModel: "opus[1m]",
				requestedEffort: "high",
			},
		});

		expect(requestedModels).toEqual([`${profileMain.provider}/${profileMain.id}`]);
		expect(session.model).toBe(base);
		expect(session.thinkingLevel).toBe(originalThinking);
	});
	it("resolves a single-integer Claude family version as the newest available model", async () => {
		const { base } = resolveModels();
		const sonnet5 = modelRegistry.find("anthropic", "claude-sonnet-5");
		if (!sonnet5) throw new Error("Expected anthropic sonnet 5 model to exist");
		const requestedModels: string[] = [];
		session = makeSession(base, requestedModels);

		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "# Creative\nWrite.",
			display: true,
			attribution: "user",
			details: {
				name: "creative",
				path: "/tmp/creative/SKILL.md",
				lineCount: 2,
				requestedModel: "sonnet",
			},
		});

		expect(requestedModels).toEqual([`${sonnet5.provider}/${sonnet5.id}`]);
		expect(session.model).toBe(base);
	});
	it("keeps an explicit session model authoritative over skill frontmatter", async () => {
		const { base } = resolveModels();
		const requestedModels: string[] = [];
		session = makeSession(base, requestedModels);
		await session.setModel(base);

		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "# Creative\nWrite.",
			display: true,
			attribution: "user",
			details: {
				name: "creative",
				path: "/tmp/creative/SKILL.md",
				lineCount: 2,
				requestedModel: "opus[1m]",
				requestedEffort: "high",
			},
		});

		expect(requestedModels).toEqual([`${base.provider}/${base.id}`]);
		expect(session.model).toBe(base);
	});
	it("keeps an explicit model profile authoritative over skill frontmatter", async () => {
		const { base } = resolveModels();
		const requestedModels: string[] = [];
		session = makeSession(base, requestedModels);
		await session.setModelTemporary(base, undefined, { persistAsSessionDefault: true });

		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "# Creative\nWrite.",
			display: true,
			attribution: "user",
			details: {
				name: "creative",
				path: "/tmp/creative/SKILL.md",
				lineCount: 2,
				requestedModel: "opus[1m]",
				requestedEffort: "high",
			},
		});

		expect(requestedModels).toEqual([`${base.provider}/${base.id}`]);
		expect(session.model).toBe(base);
	});
	it("fails closed when a skill's requested context window is unavailable", async () => {
		const { base } = resolveModels();
		session = makeSession(base);

		const invocation = session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "# Creative\nWrite.",
			display: true,
			attribution: "user",
			details: {
				name: "creative",
				path: "/tmp/creative/SKILL.md",
				lineCount: 2,
				requestedModel: "opus[2m]",
			},
		});

		await expect(invocation).rejects.toThrow(/no available model has that context window/);
		expect(session.model).toBe(base);
	});

	it("defers a chained skill with model metadata to a fresh model turn", async () => {
		const { base, profileMain } = resolveModels();
		const requestedModels: string[] = [];
		let streamCalls = 0;
		let finishFirst: (() => void) | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: base, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: model => {
				streamCalls += 1;
				requestedModels.push(`${model.provider}/${model.id}`);
				const stream = new AssistantMessageEventStream();
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				} as AssistantMessage;
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					if (streamCalls === 1) {
						finishFirst = () => stream.push({ type: "done", reason: "stop", message });
					} else {
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstTurn = session.prompt("start");
		for (let i = 0; i < 100 && !finishFirst; i += 1) await Bun.sleep(5);
		expect(finishFirst).toBeDefined();

		await session.sendCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "# Interview\nContinue.",
				display: true,
				attribution: "user",
				details: {
					name: "vc-characterchat-interview",
					path: "/tmp/interview/SKILL.md",
					lineCount: 2,
					requestedModel: "opus[1m]",
					requestedEffort: "high",
				},
			},
			{ triggerTurn: false },
		);
		finishFirst?.();
		await firstTurn;
		for (let i = 0; i < 200 && requestedModels.length < 2; i += 1) await Bun.sleep(5);

		expect(requestedModels).toEqual([`${base.provider}/${base.id}`, `${profileMain.provider}/${profileMain.id}`]);
		expect(session.model).toBe(base);
	});
	it("drops a deferred skill when its runtime model preferences cannot be applied", async () => {
		const { base } = resolveModels();
		const requestedModels: string[] = [];
		let finishFirst: (() => void) | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: base, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: model => {
				requestedModels.push(`${model.provider}/${model.id}`);
				const stream = new AssistantMessageEventStream();
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				} as AssistantMessage;
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					if (requestedModels.length === 1) {
						finishFirst = () => stream.push({ type: "done", reason: "stop", message });
					} else {
						stream.push({ type: "done", reason: "stop", message });
					}
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstTurn = session.prompt("start");
		for (let i = 0; i < 100 && !finishFirst; i += 1) await Bun.sleep(5);
		expect(finishFirst).toBeDefined();

		await session.sendCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "# Interview\nContinue.",
				display: true,
				attribution: "user",
				details: {
					name: "vc-characterchat-interview",
					path: "/tmp/interview/SKILL.md",
					lineCount: 2,
					requestedModel: "opus[2m]",
				},
			},
			{ triggerTurn: false },
		);
		finishFirst?.();
		await firstTurn;
		await Bun.sleep(50);

		expect(requestedModels).toEqual([`${base.provider}/${base.id}`]);
		expect(JSON.stringify(agent.state.messages)).not.toContain("# Interview");

		await session.prompt("after");
		expect(requestedModels).toEqual([`${base.provider}/${base.id}`, `${base.provider}/${base.id}`]);
	});
	it("rollback of a failed activation restores the pre-activation resume default, not the transient live model", async () => {
		// A = persisted resume default, B = transient live model (e.g. retry/
		// fallback/plan switch), profileMain = the profile's main model the failed
		// activation already recorded as the session default before throwing.
		const base = modelRegistry.find("openai-codex", "gpt-5.5");
		const transient = modelRegistry.find("anthropic", "claude-sonnet-4-6");
		const profileMain = modelRegistry.find("anthropic", "claude-opus-4-8");
		if (!base || !transient || !profileMain) {
			throw new Error("Expected codex gpt-5.5 + anthropic sonnet/opus models to exist");
		}
		session = makeSession(base);

		// Persisted resume default A.
		await session.setModel(base);
		// Transient switch to B (role=temporary): resume default stays A (#849).
		await session.setModelTemporary(transient);
		expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
		expect(session.model?.id).toBe("claude-sonnet-4-6");
		const globalProfileDefaultBefore = session.settings.get("modelProfile.default");

		// Prepare snapshots the pre-activation state: the live model is B, but the
		// resume default is A — captured separately.
		const prepared = await prepareModelProfileActivation({
			session,
			modelRegistry,
			settings: session.settings,
			profileName: "opus-codex",
		});
		expect(prepared.previousModel?.id).toBe("claude-sonnet-4-6");
		expect(prepared.previousSessionDefaultModel).toBe("openai-codex/gpt-5.5");
		expect(prepared.defaultModel?.id).toBe("claude-opus-4-8");

		// Force the activation to fail AFTER the profile main model is recorded as
		// the session default: the agent-model-override step throws.
		prepared.settings = new Proxy(session.settings, {
			get(target, prop, receiver) {
				if (prop === "override") {
					return () => {
						throw new Error("simulated activation failure after model change");
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as typeof prepared.settings;

		await expect(applyPreparedModelProfileActivation(prepared)).rejects.toThrow(
			"simulated activation failure after model change",
		);

		// Resume default remains A: the failed profile main model did not poison it,
		// and the transient live model B was NOT promoted to the resume default.
		expect(session.sessionManager.buildSessionContext().models.default).toBe("openai-codex/gpt-5.5");
		// Runtime rollback is intentional: the live model returns to B as temporary.
		expect(session.model?.id).toBe("claude-sonnet-4-6");
		expect(session.sessionManager.buildSessionContext().models.temporary).toBe("anthropic/claude-sonnet-4-6");
		// Apply-for-this-session setting untouched.
		expect(session.settings.get("modelProfile.default")).toBe(globalProfileDefaultBefore);
	});
});
