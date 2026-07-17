import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import { getBundledModel } from "@gajae-code/ai";
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
});
