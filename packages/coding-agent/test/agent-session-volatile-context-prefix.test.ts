import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import * as compactionModule from "@gajae-code/agent-core/compaction";
import * as aiModule from "@gajae-code/ai";
import { type AssistantMessage, getBundledModel, type ToolCall } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import type { ContributionPrepResult } from "@gajae-code/coding-agent/session/contribution-prep";
import * as contributionPrepModule from "@gajae-code/coding-agent/session/contribution-prep";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

function createToolCallAssistantMessage(name: string, args: Record<string, unknown>): AssistantMessage {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: `call_${name}`,
		name,
		arguments: args,
	};
	return {
		role: "assistant",
		content: [toolCall],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createTextAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession volatile context cache prefix extension", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let settings: Settings;
	let authStorage: AuthStorage | undefined;

	const requestContexts: AgentMessage[][] = [];
	let streamCallCount = 0;
	let scriptedResponses: AssistantMessage[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-volatile-context-prefix-");
		requestContexts.length = 0;
		streamCallCount = 0;
		scriptedResponses = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		settings = Settings.isolated({
			"compaction.enabled": false,
		});
		sessionManager = SessionManager.inMemory(tempDir.path());

		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: z.object({ command: z.string() }),
			execute: async () => ({ content: [{ type: "text" as const, text: "command output" }] }),
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test system prompt"],
				tools: [mockBashTool],
				messages: [],
			},
			convertToLlm,
			streamFn: (_model, context) => {
				streamCallCount++;
				// Capture the context (messages) sent to the LLM for each request
				requestContexts.push(structuredClone(context.messages));

				const response = scriptedResponses.shift() ?? createTextAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					const reason = response.stopReason === "toolUse" ? "toolUse" : "stop";
					stream.push({ type: "done", reason, message: response });
				});
				return stream;
			},
		});

		const toolRegistry = new Map<string, AgentTool>([[mockBashTool.name, mockBashTool]]);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	it("maintains volatile context as a prefix extension across multiple turns with tool calls", async () => {
		// Turn 1: Plain text request
		scriptedResponses = [createTextAssistantMessage("first response")];
		await session.prompt("first question?");
		expect(streamCallCount).toBe(1);
		expect(requestContexts).toHaveLength(1);
		const firstRequest = requestContexts[0];
		if (!firstRequest) throw new Error("Expected first request context");

		// Turn 2: Tool call request (causes multiple LLM calls for tool results)
		scriptedResponses = [
			createToolCallAssistantMessage("bash", { command: "echo hello" }),
			createTextAssistantMessage("tool result processed"),
		];
		await session.prompt("please run a command?");
		expect(streamCallCount).toBe(3); // turn1 + turn2_toolcall + turn2_result
		const secondRequest = requestContexts[1];
		if (!secondRequest) throw new Error("Expected second request context");

		// Turn 3: Another plain request
		scriptedResponses = [createTextAssistantMessage("third response")];
		await session.prompt("final question?");
		expect(streamCallCount).toBe(4);
		const thirdRequest = requestContexts[3];
		if (!thirdRequest) throw new Error("Expected third request context");

		// Verify that each request is a prefix-extension of the previous:
		// - Every message in request 1 should be at the same index in request 2 and 3
		// - Request 2 should have request 1 as a prefix, plus new messages appended
		// - Request 3 should have request 2 as a prefix, plus new messages appended

		// Check first->second prefix relationship
		expect(secondRequest.length).toBeGreaterThanOrEqual(firstRequest.length);
		for (let i = 0; i < firstRequest.length; i++) {
			const firstMsg = firstRequest[i];
			const secondMsg = secondRequest[i];
			if (!firstMsg || !secondMsg) throw new Error(`Message missing at index ${i}`);

			// Messages at the same index should be identical (byte-equivalent)
			expect(JSON.stringify(secondMsg)).toBe(JSON.stringify(firstMsg));
		}

		// Check second->third prefix relationship
		expect(thirdRequest.length).toBeGreaterThanOrEqual(secondRequest.length);
		for (let i = 0; i < secondRequest.length; i++) {
			const secondMsg = secondRequest[i];
			const thirdMsg = thirdRequest[i];
			if (!secondMsg || !thirdMsg) throw new Error(`Message missing at index ${i}`);

			// Messages at the same index should be identical (byte-equivalent)
			expect(JSON.stringify(thirdMsg)).toBe(JSON.stringify(secondMsg));
		}
	});

	it("removes volatile context from durable storage but keeps it in agent.state after sending", async () => {
		scriptedResponses = [createTextAssistantMessage("first response")];
		await session.prompt("first question?");

		// Volatile messages should NOT be in durable storage (session manager branch)
		const branchEntries = sessionManager.getBranch();
		const hasVolatileInBranch = branchEntries.some(
			entry => entry.type === "custom_message" && entry.customType === "volatile-project-context",
		);
		expect(hasVolatileInBranch).toBe(false);

		// But they SHOULD be in agent.state (in-memory) after the turn
		const hasVolatileInAgent = session.agent.state.messages.some(
			msg => msg.role === "custom" && msg.customType === "volatile-project-context",
		);
		expect(hasVolatileInAgent).toBe(true);
	});
	it("hides retained ephemerals from session.messages but still counts them in context usage", async () => {
		scriptedResponses = [createTextAssistantMessage("first response")];
		await session.prompt("first question?");

		const isEphemeral = (msg: AgentMessage): boolean =>
			msg.role === "custom" &&
			(msg.customType === "volatile-project-context" || msg.customType === "untrusted-mcp-server-instructions");
		expect(session.agent.state.messages.some(isEphemeral)).toBe(true);
		expect(session.messages.some(isEphemeral)).toBe(false);
		expect(session.messages.filter(msg => !isEphemeral(msg))).toEqual(
			session.agent.state.messages.filter(msg => !isEphemeral(msg)),
		);

		// Context accounting must follow what the provider actually receives, so a
		// large retained ephemeral has to raise the estimate even though it is hidden.
		const before = session.getContextUsage();
		const retained = session.agent.state.messages.findIndex(isEphemeral);
		const original = session.agent.state.messages[retained];
		if (original?.role !== "custom") throw new Error("Expected retained ephemeral message");
		session.agent.appendMessage({ ...original, content: "x".repeat(15_000) });
		const after = session.getContextUsage();
		expect(before?.tokens).not.toBeNull();
		expect(after?.tokens ?? 0).toBeGreaterThan((before?.tokens ?? 0) + 1_000);
	});
	it("excludes retained volatile context from handoff generation input", async () => {
		scriptedResponses = [createTextAssistantMessage("first response"), createTextAssistantMessage("second response")];
		await session.prompt("first question?");
		await session.prompt("second question?");
		expect(
			session.agent.state.messages.some(
				msg => msg.role === "custom" && msg.customType === "volatile-project-context",
			),
		).toBe(true);

		const generateHandoffSpy = spyOn(compactionModule, "generateHandoff").mockResolvedValue("## Goal\nContinue");
		try {
			await session.handoff();
			const handoffMessages = generateHandoffSpy.mock.calls[0]?.[0];
			if (!handoffMessages) throw new Error("Expected generateHandoff call");
			expect(handoffMessages.some(msg => msg.role === "user")).toBe(true);
			expect(
				handoffMessages.some(
					msg =>
						msg.role === "custom" &&
						(msg.customType === "volatile-project-context" ||
							msg.customType === "untrusted-mcp-server-instructions"),
				),
			).toBe(false);
		} finally {
			generateHandoffSpy.mockRestore();
		}
	});

	it("drops retained volatile context naming the old root when the session is rescoped", async () => {
		scriptedResponses = [createTextAssistantMessage("first response")];
		await session.prompt("first question?");
		expect(
			session.agent.state.messages.some(
				msg => msg.role === "custom" && msg.customType === "volatile-project-context",
			),
		).toBe(true);

		session.retireWorkspaceTreeForRescope();

		expect(
			session.agent.state.messages.some(
				msg => msg.role === "custom" && msg.customType === "volatile-project-context",
			),
		).toBe(false);
		expect(session.agent.state.messages.some(msg => msg.role === "user")).toBe(true);
	});
	it("excludes retained volatile context from fork seeds, contribution prep, and session export", async () => {
		scriptedResponses = [createTextAssistantMessage("first response"), createTextAssistantMessage("second response")];
		await session.prompt("first question?");
		await session.prompt("second question?");
		const marker = "current working directory is";
		expect(JSON.stringify(session.agent.state.messages)).toContain(marker);

		const seed = await session.buildForkContextSeed({ maxMessages: 100, maxTokens: 1_000_000 });
		expect(seed.messages.length).toBeGreaterThan(0);
		expect(JSON.stringify(seed.messages)).not.toContain(marker);
		expect(JSON.stringify(seed.agentMessages)).not.toContain(marker);

		expect(session.formatSessionAsText()).toContain("second question?");
		expect(session.formatSessionAsText()).not.toContain(marker);

		const prepSpy = spyOn(contributionPrepModule, "prepareContributionPrep").mockResolvedValue(
			{} as ContributionPrepResult,
		);
		try {
			await session.prepareContributionPrep();
			const prepMessages = prepSpy.mock.calls[0]?.[0]?.messages;
			if (!prepMessages) throw new Error("Expected prepareContributionPrep call");
			expect(prepMessages.some(msg => msg.role === "user")).toBe(true);
			expect(JSON.stringify(prepMessages)).not.toContain(marker);
		} finally {
			prepSpy.mockRestore();
		}
	});
	it("excludes retained volatile context from side-channel ephemeral turns", async () => {
		scriptedResponses = [createTextAssistantMessage("first response"), createTextAssistantMessage("second response")];
		await session.prompt("first question?");
		await session.prompt("second question?");
		const marker = "current working directory is";
		const before = requestContexts.length;

		const sideContexts: unknown[] = [];
		const sideStream = spyOn(aiModule, "streamSimple").mockImplementation((_model, context) => {
			sideContexts.push(structuredClone(context.messages));
			const response = createTextAssistantMessage("side answer");
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: "stop", message: response });
			});
			return stream;
		});
		try {
			await session.runEphemeralTurn({ promptText: "side question" });
		} finally {
			sideStream.mockRestore();
		}

		expect(requestContexts.length).toBe(before);
		const sideRequest = sideContexts[0];
		if (!sideRequest) throw new Error("Expected a side-channel request");
		expect(JSON.stringify(sideRequest)).toContain("side question");
		expect(JSON.stringify(sideRequest)).toContain("second question?");
		expect(JSON.stringify(sideRequest)).not.toContain(marker);
	});
});
