import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import { getBundledModel, type Model } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { assistantMsg, userMsg } from "./utilities";

describe("AgentSession oversized auto-maintenance guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-oversized-maintenance-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
				"retry.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
		});
		session.subscribe(() => {});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function appendConversation(seed = "seed"): void {
		for (let i = 0; i < 4; i++) {
			const user = userMsg(`${seed} user ${i}`);
			const assistant = assistantMsg(`${seed} assistant ${i}`);
			session.agent.appendMessage(user);
			sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			sessionManager.appendMessage(assistant);
		}
	}
	function replaceSession(model: Model, settingsOverrides: Record<string, unknown> = {}): void {
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
				"retry.enabled": false,
				"todo.reminders": false,
				...settingsOverrides,
			}),
			modelRegistry,
		});
		session.subscribe(() => {});
	}

	it("skips an unchanged oversized auto-maintenance retry after a context-length failure", async () => {
		appendConversation();
		const events: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") events.push(event);
		});
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockRejectedValue(new Error("prompt is too long: 213462 tokens > 200000 maximum"));

		await session.runIdleCompaction();
		await session.runIdleCompaction();

		// One maintenance attempt may try multiple model candidates. The retry must
		// not start a second attempt with the same unchanged request.
		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			errorMessage: expect.stringContaining("prompt is too long"),
			willRetry: false,
		});
		expect(events[0].skipped).toBeUndefined();
		expect(events[1]).toMatchObject({
			skipped: true,
			willRetry: false,
			errorMessage: expect.stringContaining("previous unchanged maintenance request exceeded"),
		});
	});

	it("allows a new oversized maintenance attempt after the conversation changes", async () => {
		appendConversation("initial");
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error("request_too_large"));

		await session.runIdleCompaction();
		await session.runIdleCompaction();

		const user = userMsg("new reduced context boundary");
		session.agent.appendMessage(user);
		sessionManager.appendMessage(user);

		await session.runIdleCompaction();

		expect(compactSpy).toHaveBeenCalledTimes(4);
	});
	it("does not retry a Kimi Code compaction first-event timeout on the same candidate", async () => {
		const model = getBundledModel("kimi-code", "kimi-k2.5");
		if (!model) throw new Error("Expected bundled Kimi Code model");
		await session.dispose();
		replaceSession(model, {
			"retry.enabled": true,
			"retry.maxRetries": 2,
			"retry.baseDelayMs": 1,
		});
		appendConversation("Kimi compaction timeout");
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockImplementation((_preparation, candidate) =>
				Promise.reject(
					new Error(
						candidate.provider === "kimi-code"
							? "Summarization failed: Provider stream timed out while waiting for the first event"
							: "terminal compaction failure",
					),
				),
			);

		await session.runIdleCompaction();

		const matchingCalls = compactSpy.mock.calls.filter(([, candidate]) => candidate.id === model.id);
		expect(matchingCalls).toHaveLength(1);
	});
	it("does not retry exported Alibaba Token Plan compaction timeout wrappers for the same candidate", async () => {
		const responsesModel = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		const completionsModel = getBundledModel("alibaba-token-plan", "deepseek-v4-pro");
		if (!responsesModel || !completionsModel) throw new Error("Expected bundled Alibaba Token Plan models");
		const cases = [
			{
				model: responsesModel,
				timeoutMessage: "Provider stream timed out while waiting for the first event",
				prefix: "Summarization failed",
			},
			{
				model: completionsModel,
				timeoutMessage: "Provider stream timed out while waiting for the first event",
				prefix: "Turn prefix summarization failed",
			},
		] as const;
		await session.dispose();
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const compactSpy = vi.spyOn(compactionModule, "compact");

		for (const testCase of cases) {
			replaceSession(testCase.model, {
				"retry.enabled": true,
				"retry.maxRetries": 2,
				"retry.baseDelayMs": 1,
			});
			appendConversation(`Alibaba ${testCase.model.api}`);
			const events: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>[] = [];
			session.subscribe(event => {
				if (event.type === "auto_compaction_end") events.push(event);
			});
			const wrapper = `${testCase.prefix}: ${testCase.timeoutMessage}`;
			compactSpy.mockClear();
			compactSpy.mockImplementation((_preparation, candidate) =>
				Promise.reject(new Error(candidate.id === testCase.model.id ? wrapper : "terminal compaction failure")),
			);

			await session.runIdleCompaction();

			const matchingCalls = compactSpy.mock.calls.filter(([, candidate]) => candidate.id === testCase.model.id);
			expect(matchingCalls).toHaveLength(1);
			expect(compactSpy.mock.calls.length).toBeGreaterThan(matchingCalls.length);
			expect(waitSpy).not.toHaveBeenCalled();
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ willRetry: false });
			waitSpy.mockClear();
			if (testCase !== cases.at(-1)) await session.dispose();
		}
	});

	it("keeps cross-API Alibaba compaction timeout wrappers retryable", async () => {
		const model = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		if (!model) throw new Error("Expected bundled Alibaba Token Plan model");
		await session.dispose();
		replaceSession(model, {
			"retry.enabled": true,
			"retry.maxRetries": 1,
			"retry.baseDelayMs": 1,
		});
		appendConversation("cross-API Alibaba compaction retry");
		const wrongApiWrapper =
			"Summarization failed: OpenAI completions stream timed out while waiting for the first event";
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockImplementation((_preparation, candidate) =>
				Promise.reject(new Error(candidate.id === model.id ? wrongApiWrapper : "terminal compaction failure")),
			);
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.runIdleCompaction();

		const matchingCalls = compactSpy.mock.calls.filter(([, candidate]) => candidate.id === model.id);
		expect(matchingCalls.length).toBeGreaterThan(1);
		expect(waitSpy).toHaveBeenCalled();
	});
	it("retains auto-compaction retries for unrelated or near-miss timeout wrappers", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		await session.dispose();
		replaceSession(model, {
			"retry.enabled": true,
			"retry.maxRetries": 1,
			"retry.baseDelayMs": 1,
		});
		appendConversation("unrelated compaction retry");
		const events: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") events.push(event);
		});
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockImplementation((_preparation, candidate) =>
				Promise.reject(
					new Error(
						candidate.id === model.id
							? "Summarization failed: Anthropic stream timed out while waiting for the first event"
							: "terminal compaction failure",
					),
				),
			);
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.runIdleCompaction();

		const matchingCalls = compactSpy.mock.calls.filter(([, candidate]) => candidate.id === model.id);
		expect(matchingCalls.length).toBeGreaterThan(1);
		expect(waitSpy).toHaveBeenCalled();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ willRetry: false });
	});
});
