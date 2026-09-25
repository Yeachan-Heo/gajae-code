import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { type AssistantMessage, getBundledModel, type PromptPrefixTelemetry } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

describe("AgentSession prompt-prefix telemetry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@gjc-prompt-prefix-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: Array.from({ length: 4 }, () => ({ content: ["ack"] })) });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function persistedPrefixes(): (PromptPrefixTelemetry | undefined)[] {
		return sessionManager
			.getEntries()
			.flatMap(entry =>
				entry.type === "message" && entry.message.role === "assistant"
					? [(entry.message as AssistantMessage).promptPrefix]
					: [],
			);
	}

	it("persists a prompt-prefix fingerprint on every assistant entry", async () => {
		await session.prompt("first");
		await session.prompt("second");

		const [first, second] = persistedPrefixes();
		// The first request carries the request-scoped volatile project context plus the prompt.
		expect(first).toMatchObject({ change: "initial", messages: 2, previousMessages: 0 });
		expect(second?.hash).toMatch(/^[0-9a-f]{16}$/);
		expect(second?.hash).not.toBe(first?.hash);
		// The previous request's volatile context is stripped before the next prompt, so
		// the already-sent prefix is rewritten at its position: a client-caused miss.
		expect(second).toMatchObject({
			change: "messages",
			messages: 4,
			previousMessages: 2,
			reusedMessages: 0,
			divergedRole: "user",
		});
	});
});
