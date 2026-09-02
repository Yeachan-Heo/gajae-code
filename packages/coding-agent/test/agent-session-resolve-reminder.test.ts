import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel, type MockModelHandle } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { queueResolveHandler } from "@gajae-code/coding-agent/tools/resolve";
import { buildNamedToolChoice } from "@gajae-code/coding-agent/utils/tool-choice";
import { Snowflake } from "@gajae-code/utils";

describe("AgentSession resolve reminder", () => {
	let session: AgentSession;
	let tempDir: string;
	let mock: MockModelHandle;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-resolve-reminder-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model not found in registry");
		}

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		mock = createMockModel({
			handler: () => {
				if (mock.calls.length === 1) {
					queueResolveHandler(
						{
							getToolChoiceQueue: () => session.toolChoiceQueue,
							buildToolChoice: (name: string) => buildNamedToolChoice(name, session.model!),
							sendCustomMessage: (
								msg: { customType: string; content: string; details?: unknown },
								opts?: { deliverAs?: "steer" | "followUp" },
							) => session.sendCustomMessage({ ...msg, display: false, attribution: "agent" }, opts),
						} as unknown as ToolSession,
						{
							label: "AST Edit: 1 replacement in 1 file",
							sourceToolName: "ast_edit",
							apply: async () => ({ content: [{ type: "text", text: "Applied" }] }),
						},
					);
				}
				return { content: ["Done"] };
			},
		});

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	it("forces an immediate steering turn and injects resolve reminder before second assistant response", async () => {
		await session.prompt("run preview");

		expect(mock.calls).toHaveLength(2);

		const messages = session.agent.state.messages;
		const assistantIndices = messages
			.map((message, index) => (message.role === "assistant" ? index : -1))
			.filter(index => index >= 0);
		const reminderIndex = messages.findIndex(
			message => message.role === "custom" && message.customType === "resolve-reminder",
		);

		expect(assistantIndices.length).toBe(2);
		expect(reminderIndex).toBeGreaterThan(assistantIndices[0]!);
		expect(reminderIndex).toBeLessThan(assistantIndices[1]!);
	});
});
