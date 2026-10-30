import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { type AssistantMessage, type Context, type ToolCall } from "@gajae-code/ai";
import { createMockModel, registerMockApi } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

registerMockApi();

const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions) {
		session.dispose();
	}
	sessions.length = 0;
});

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	model: ReturnType<typeof createMockModel>;
	committed: AssistantMessage;
	live: AssistantMessage;
	settings: Settings;
	getApiKey: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
	const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": true });
	const sessionManager = SessionManager.inMemory();
	const model = createMockModel({ id: "test-model", handler: () => ({ content: ["test answer"] }) });
	const getApiKey = vi.fn(async () => "test-key");

	// Create agent with initial state that will include committed and live messages
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["base system prompt"],
			messages: [
				{ role: "user", content: "committed user message", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "committed assistant message" }],
					api: "mock",
					provider: "mock",
					model: "test-model",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 150,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			],
			tools: [],
		},
		streamFn: model.stream,
		convertToLlm,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: {
			getApiKey,
			authStorage: undefined,
			getAvailable: () => [model],
			getAuthStorageOwner: () => ({}),
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => await body(),
		} as never,
		convertToLlm,
	});
	sessions.push(session);

	const committed: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "committed assistant message" }],
		api: "mock",
		provider: "mock",
		model: "test-model",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	// Commit messages to the session manager (these are the visible messages)
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "committed user message" }],
		timestamp: Date.now(),
	});
	sessionManager.appendMessage(committed);

	return { session, sessionManager, model, committed, live: committed, settings, getApiKey };
}

describe("AgentSession /btw fork-prefix (cache identity) design", () => {
	it("includes full AgentMessage[] (tool calls and results) in /btw scope", async () => {
		const harness = createHarness();
		const model = harness.model;

		// Simulate a tool call in the main session
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-123",
			name: "read",
			arguments: { path: "/test/file.ts" },
		};
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "I'll read the file" }, toolCall],
			api: "mock",
			provider: "mock",
			model: "test-model",
			usage: {
				input: 50,
				output: 25,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 75,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		// Add a tool result
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-123",
			toolName: "read",
			content: [{ type: "text", text: "file content" }],
			isError: false,
			timestamp: Date.now(),
		});

		// Create scope and run /btw
		const scope = harness.session.createBtwConversationScope("btw instruction");

		// Verify scope includes full messages with tool calls and results
		expect(scope.messages.length).toBeGreaterThan(0);
		const hasToolCall = scope.messages.some(m => {
			if (m.role !== "assistant") return false;
			const assistant = m as AssistantMessage;
			if (!Array.isArray(assistant.content)) return false;
			return assistant.content.some((c: any) => c.type === "toolCall");
		});
		const hasToolResult = scope.messages.some(m => m.role === "toolResult");

		expect(hasToolCall).toBe(true);
		expect(hasToolResult).toBe(true);
	});

	it("cuts at last complete assistant turn (no dangling tool_use)", async () => {
		const harness = createHarness();

		// Append a complete assistant turn with tool call and result
		const toolCall1: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { path: "/file1.ts" },
		};
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [toolCall1],
			api: "mock",
			provider: "mock",
			model: "test-model",
			usage: {
				input: 50,
				output: 25,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 75,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "result1" }],
			isError: false,
			timestamp: Date.now(),
		});

		// Add a user message
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "next user message" }],
			timestamp: Date.now(),
		});

		// Add a dangling assistant turn with incomplete tool call
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-2",
					name: "read",
					arguments: { path: "/file2.ts" },
				} as any,
			],
			api: "mock",
			provider: "mock",
			model: "test-model",
			usage: {
				input: 50,
				output: 25,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 75,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		// Create scope and verify it doesn't include the dangling tool call
		const scope = harness.session.createBtwConversationScope("btw instruction");

		// The dangling assistant turn should be excluded, so the last message is the user message
		const lastMessage = scope.messages[scope.messages.length - 1];
		expect(lastMessage.role).toBe("user");
		const contentText = Array.isArray((lastMessage as any).content)
			? (lastMessage as any).content.find((c: any) => c.type === "text")?.text
			: (lastMessage as any).content;
		expect(contentText).toContain("next user message");
	});

	it("includes tools from main session for cache identity", async () => {
		const harness = createHarness();
		const readTool = { name: "read", description: "Read a file" } as any;
		const editTool = { name: "edit", description: "Edit a file" } as any;

		// Add tools to the agent
		harness.session.agent.state.tools.push(readTool, editTool);

		const scope = harness.session.createBtwConversationScope("btw instruction");

		// Verify scope includes tools
		expect(scope.tools.length).toBe(2);
		expect(scope.tools.some(t => t.name === "read")).toBe(true);
		expect(scope.tools.some(t => t.name === "edit")).toBe(true);
	});

	it("preserves system prompt byte-identically for cache hit", async () => {
		const harness = createHarness();
		const originalSystemPrompt = harness.session.systemPrompt;

		const scope = harness.session.createBtwConversationScope("btw instruction");

		// System prompt should be the base one (no /btw instruction added)
		expect(scope.systemPrompt).toBe(originalSystemPrompt);
		expect(scope.systemPrompt).toEqual(["base system prompt"]);
	});

	it("never executes tools in /btw response", async () => {
		const harness = createHarness();
		let providedContext: Context | undefined;

		const model = createMockModel({
			handler: context => {
				providedContext = context;
				return { content: ["answer with tool attempt"] };
			},
		});
		harness.session.agent.setModel(model);

		// Add a tool
		const readTool = { name: "read", description: "Read a file" } as any;
		harness.session.agent.state.tools.push(readTool);

		const turn = harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "test question",
				scope: harness.session.createBtwConversationScope("btw instruction"),
			},
		});

		await turn;

		// Verify toolChoice is "none"
		expect(model.calls[0]?.options?.toolChoice).toBe("none");

		// Verify tools are included (for cache identity)
		expect(providedContext?.tools?.length).toBeGreaterThan(0);
	});

	it("keeps main session unchanged after /btw turn", async () => {
		const harness = createHarness();
		const messagesBefore = structuredClone(harness.session.agent.state.messages);
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());

		await harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "btw question",
				scope: harness.session.createBtwConversationScope("btw instruction"),
			},
		});

		// Verify main session history is unchanged
		expect(harness.session.agent.state.messages).toEqual(messagesBefore);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
	});

	it("ignores/rejects tool calls in /btw response", async () => {
		const harness = createHarness();

		// Create a custom model that returns a tool call
		const model = createMockModel({
			handler: () => ({
				content: [
					{ type: "text", text: "answer" },
					{ type: "toolCall", id: "btw-call", name: "read", arguments: { path: "/test" } },
				],
			}),
		});
		harness.session.agent.setModel(model);

		// Add tool
		const readTool = { name: "read", description: "Read" } as any;
		harness.session.agent.state.tools.push(readTool);

		const messagesBefore = structuredClone(harness.session.agent.state.messages);

		const { replyText } = await harness.session.runEphemeralTurn({
			purpose: "btw",
			turn: {
				question: "test",
				scope: harness.session.createBtwConversationScope("btw instruction"),
			},
		});

		// Verify tool call was not executed (main session unchanged)
		expect(harness.session.agent.state.messages).toEqual(messagesBefore);
		// Verify we got the answer text
		expect(replyText).toContain("answer");
	});

	it("scope includes tools and system prompt for cache identity", async () => {
		const harness = createHarness();

		// Add tools to the agent
		const testTool = { name: "test", description: "Test", safeSummary: "Test tool" } as any;
		harness.session.agent.state.tools.push(testTool);

		// Create scope
		const scope = harness.session.createBtwConversationScope("btw instruction");

		// Verify scope includes tools (for cache identity, not execution)
		expect(scope.tools.length).toBeGreaterThan(0);
		expect(scope.tools.some(t => t.name === "test")).toBe(true);

		// Verify system prompt is base prompt (no /btw instruction added)
		expect(scope.systemPrompt).toEqual(["base system prompt"]);
	});
});
