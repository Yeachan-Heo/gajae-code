import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@gajae-code/ai/models";
import { convertMessages } from "@gajae-code/ai/providers/openai-completions";
import type { AssistantMessage, Context, Model, OpenAICompat, ToolResultMessage, Usage } from "@gajae-code/ai/types";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat: Required<OpenAICompat> = {
	supportsStore: true,
	supportsDeveloperRole: true,
	sendSessionHeaders: false,
	supportsMultipleSystemMessages: true,
	supportsReasoningEffort: true,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	supportsToolChoice: true,
	supportsForcedToolChoice: true,
	toolChoiceSupport: "named",
	disableReasoningOnForcedToolChoice: false,
	disableReasoningOnToolChoice: false,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresMistralToolIds: false,
	thinkingFormat: "openai",
	reasoningContentField: "reasoning_content",
	requiresReasoningContentForToolCalls: false,
	allowsSyntheticReasoningContentForToolCalls: true,
	requiresAssistantContentForToolCalls: false,
	openRouterRouting: {},
	vercelGatewayRouting: {},
	extraBody: {},
	supportsStrictMode: true,
	toolStrictMode: "none",
};

function buildToolResult(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		],
		isError: false,
		timestamp,
	};
}

describe("openai-completions convertMessages", () => {
	it("batches tool-result images after consecutive tool results", () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text", "image"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "img-1.png" } },
				{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "img-2.png" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Read the images", timestamp: now - 2 },
				assistantMessage,
				buildToolResult("tool-1", now + 1),
				buildToolResult("tool-2", now + 2),
			],
		};

		const messages = convertMessages(model, context, compat);
		const roles = messages.map(message => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "tool", "user"]);

		const imageMessage = messages[messages.length - 1];
		expect(imageMessage.role).toBe("user");
		expect(Array.isArray(imageMessage.content)).toBe(true);

		const imageParts = (imageMessage.content as Array<{ type?: string }>).filter(part => part?.type === "image_url");
		expect(imageParts.length).toBe(2);
	});
	it("uses generated tool_call_id values when assistant/tool IDs are empty", () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "", name: "read", arguments: { path: "README.md" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Read README", timestamp: now - 1 },
				assistantMessage,
				{
					role: "toolResult",
					toolCallId: "",
					toolName: "read",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: now + 1,
				},
			],
		};

		const messages = convertMessages(model, context, compat);
		const assistantParam = messages.find(message => message.role === "assistant") as
			| { role: "assistant"; tool_calls?: Array<{ id: string }> }
			| undefined;
		expect(assistantParam).toBeDefined();
		expect(assistantParam?.tool_calls).toBeDefined();
		const generatedId = assistantParam!.tool_calls![0].id;
		expect(generatedId.length).toBeGreaterThan(0);

		const toolParam = messages.find(message => message.role === "tool") as { tool_call_id: string } | undefined;
		expect(toolParam).toBeDefined();
		expect(toolParam?.tool_call_id).toBe(generatedId);
	});

	it("serializes string tool arguments into valid JSON objects", () => {
		const baseModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "tool-1",
					name: "read",
					arguments: '{"path":"README.md"}' as unknown as Record<string, any>,
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [{ role: "user", content: "Read README", timestamp: now - 1 }, assistantMessage],
		};

		const messages = convertMessages(model, context, compat);
		const assistantParam = messages.find(message => message.role === "assistant") as
			| { role: "assistant"; tool_calls?: Array<{ function: { arguments: string } }> }
			| undefined;
		expect(assistantParam).toBeDefined();
		expect(assistantParam?.tool_calls).toBeDefined();
		const serializedArgs = assistantParam!.tool_calls![0].function.arguments;
		expect(JSON.parse(serializedArgs)).toEqual({ path: "README.md" });
	});
});
