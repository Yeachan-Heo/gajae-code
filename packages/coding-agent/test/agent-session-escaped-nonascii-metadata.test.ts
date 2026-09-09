import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import type { AssistantMessage, Message } from "@gajae-code/ai";
import { createMockModel, type MockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";

const QUESTION = "마지막 병목";
const usage = {
	input: 7,
	output: 11,
	cacheRead: 13,
	cacheWrite: 17,
	totalTokens: 48,
	premiumRequests: 2,
	reasoningTokens: 5,
	cttl: { ephemeral5m: 3, ephemeral1h: 14 },
	server: { webSearch: 2, webFetch: 1 },
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

/** Only for unpublished recovery: this provider exposes no content before its terminal response. */
function terminalOnlyStream(stream: MockModel["stream"]): MockModel["stream"] {
	return (model, context, options) => {
		const upstream = stream(model, context, options);
		const terminal = new AssistantMessageEventStream();
		void (async () => {
			for await (const event of upstream) {
				if (event.type === "done" || event.type === "error") terminal.push(event);
			}
			terminal.end();
		})().catch(error => terminal.fail(error));
		return terminal;
	};
}

function turn(id: string, escaped: boolean) {
	return {
		content: [
			{
				type: "thinking" as const,
				thinking: "provider reasoning",
				thinkingSignature: "reasoning-signature",
				itemId: "reasoning-item",
				provenance: "mixed" as const,
				summaryText: "summary",
				rawText: "raw",
			},
			{
				type: "toolCall" as const,
				id,
				name: "ask",
				arguments: { question: QUESTION },
				thoughtSignature: "tool-thought-signature",
				...(escaped ? { escapedNonAsciiArguments: true } : {}),
			},
		],
		usage,
		responseId: "provider-response-id",
		disabledFeatures: ["priority"],
		providerPayload: { type: "openaiResponsesHistory" as const, provider: "mock", items: [{ id: "native-item" }] },
	};
}

const schema = z.object({ question: z.string() });

function askTool(): AgentTool<typeof schema, Record<string, never>> {
	return {
		name: "ask",
		label: "Ask",
		description: "Ask",
		parameters: schema,
		async execute() {
			return { content: [{ type: "text", text: "answered" }], details: {} };
		},
	};
}

describe("AgentSession escaped non-ASCII metadata fidelity", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
	});

	it("persists and replays accepted provider metadata without the defective turn", async () => {
		tempDir = TempDir.createSync("@gjc-escaped-metadata-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const mock = createMockModel({
			responses: [turn("tc-defective", true), turn("tc-accepted", false), { content: ["done"] }],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [askTool()], messages: [] },
			convertToLlm: identityConverter,
			streamFn: terminalOnlyStream(mock.stream),
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		await session.prompt("ask me");
		await manager.flush();

		const persisted = manager
			.buildSessionContext()
			.messages.find(
				(message): message is AssistantMessage =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "toolCall" && block.id === "tc-accepted"),
			);
		expect(persisted).toBeDefined();
		expect(persisted?.content[0]).toEqual(turn("unused", false).content[0]);
		expect(persisted?.usage).toEqual(usage);
		expect(persisted?.responseId).toBe("provider-response-id");
		expect(persisted?.disabledFeatures).toEqual(["priority"]);
		expect(persisted?.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "mock",
			items: [{ id: "native-item" }],
		});
		expect(
			manager
				.buildSessionContext()
				.messages.some(
					message =>
						message.role === "assistant" &&
						message.content.some(block => block.type === "toolCall" && block.id === "tc-defective"),
				),
		).toBe(false);
		const replayed = mock.calls[2]?.context.messages.find(
			(message): message is AssistantMessage =>
				message.role === "assistant" &&
				message.content.some(block => block.type === "toolCall" && block.id === "tc-accepted"),
		);
		expect(replayed).toEqual(persisted);
	});
});
