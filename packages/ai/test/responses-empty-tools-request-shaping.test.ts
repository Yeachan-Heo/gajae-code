/**
 * Final-serialized-body regression coverage for openai-responses /
 * azure-openai-responses request shaping when tools are omitted, empty, or
 * present — including /btw-style opt-out (`tools: []` + `toolChoice: "none"`).
 *
 * Complements #1227 (openai-completions) and the production guard that gates
 * tool serialization on `context.tools?.length`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import type { AssistantMessage, Context, Model, Tool, ToolChoice } from "../src/types";
import { clearToolChoiceIncapabilityRegistryForTests } from "../src/utils/tool-choice-capability";
import {
	createBaseModel,
	createSseResponse,
	testTool,
} from "./openai-tool-choice-test-helpers";

const originalFetch = global.fetch;

beforeEach(() => clearToolChoiceIncapabilityRegistryForTests());
afterEach(() => {
	global.fetch = originalFetch;
});

function okResponse(modelId: string, id = "resp_shape"): Response {
	return createSseResponse([
		{ type: "response.created", response: { id, model: modelId, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { id: "msg_1", type: "message", role: "assistant", content: [] },
		},
		{
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
		{ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "ok" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
		},
		{
			type: "response.completed",
			response: {
				id,
				model: modelId,
				status: "completed",
				output: [],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	]);
}

function openaiModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		...createBaseModel("openai-responses"),
		compat: { toolChoiceSupport: "named", ...(overrides.compat ?? {}) },
		...overrides,
	};
}

function azureModel(overrides: Partial<Model<"azure-openai-responses">> = {}): Model<"azure-openai-responses"> {
	return {
		...createBaseModel("azure-openai-responses"),
		provider: "azure",
		baseUrl: "https://example.openai.azure.com/openai/v1",
		compat: { toolChoiceSupport: "named", ...(overrides.compat ?? {}) },
		...overrides,
	};
}

function captureFetch(): { getPayload: () => Record<string, unknown> | undefined } {
	let payload: Record<string, unknown> | undefined;
	global.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			const modelId = typeof payload.model === "string" ? payload.model : "test-model";
			return okResponse(modelId);
		},
		{ preconnect: originalFetch.preconnect },
	);
	return { getPayload: () => payload };
}

function baseMessages(): Context["messages"] {
	return [{ role: "user", content: "hello", timestamp: 0 }];
}

function assistantWithToolCall(api: string, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "search", arguments: { q: "x" } }],
		api,
		provider,
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolHistoryMessages(api: string, provider: string, modelId: string): Context["messages"] {
	return [
		{ role: "user", content: "search now", timestamp: 0 },
		assistantWithToolCall(api, provider, modelId),
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "search",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 2,
		},
		{ role: "user", content: "btw what is X", timestamp: 3 },
	];
}

const freeformTool: Tool = {
	name: "edit",
	customWireName: "apply_patch",
	description: "edit files",
	parameters: {
		type: "object",
		properties: { input: { type: "string" } },
		required: ["input"],
	},
	customFormat: { syntax: "lark", definition: 'start: "*** Begin Patch" LF' },
};

type ToolBag = "undefined" | "empty" | "present";
type ChoiceCase = {
	label: string;
	toolChoice?: ToolChoice;
	/** Expected wire tool_choice when tools are present and named support is on. */
	whenPresent: unknown;
};

const choiceCases: ChoiceCase[] = [
	{ label: "omitted", toolChoice: undefined, whenPresent: undefined },
	{ label: "none", toolChoice: "none", whenPresent: "none" },
	{ label: "auto", toolChoice: "auto", whenPresent: "auto" },
	{ label: "any", toolChoice: "any", whenPresent: "required" },
	{ label: "required", toolChoice: "required", whenPresent: "required" },
	{
		label: "named-function",
		toolChoice: { type: "function", function: { name: "search" } },
		whenPresent: { type: "function", name: "search" },
	},
];

function toolsFor(bag: ToolBag): Tool[] | undefined {
	if (bag === "undefined") return undefined;
	if (bag === "empty") return [];
	return [testTool];
}

function expectToolsOmitted(payload: Record<string, unknown> | undefined): void {
	expect(payload?.tools).toBeUndefined();
	expect(payload?.tool_choice).toBeUndefined();
}

function expectToolsPresent(
	payload: Record<string, unknown> | undefined,
	expectedToolChoice: unknown,
	minTools = 1,
): void {
	expect(Array.isArray(payload?.tools)).toBe(true);
	expect((payload?.tools as unknown[]).length).toBeGreaterThanOrEqual(minTools);
	if (expectedToolChoice === undefined) {
		expect(payload?.tool_choice).toBeUndefined();
	} else {
		expect(payload?.tool_choice).toEqual(expectedToolChoice);
	}
}

async function streamOpenAI(context: Context, toolChoice?: ToolChoice, model = openaiModel()) {
	const capture = captureFetch();
	await streamOpenAIResponses(model, context, {
		apiKey: "test-key",
		...(toolChoice !== undefined ? { toolChoice } : {}),
	}).result();
	return capture.getPayload();
}

async function streamAzure(context: Context, toolChoice?: ToolChoice, model = azureModel()) {
	const capture = captureFetch();
	await streamAzureOpenAIResponses(model, context, {
		apiKey: "test-key",
		azureBaseUrl: model.baseUrl,
		...(toolChoice !== undefined ? { toolChoice } : {}),
	}).result();
	return capture.getPayload();
}

describe("Responses request shaping: tools undefined vs [] vs present", () => {
	for (const provider of ["openai-responses", "azure-openai-responses"] as const) {
		const stream = provider === "openai-responses" ? streamOpenAI : streamAzure;

		describe(provider, () => {
			for (const bag of ["undefined", "empty", "present"] as const) {
				for (const choice of choiceCases) {
					it(`tools=${bag} + toolChoice=${choice.label}`, async () => {
						const payload = await stream(
							{ messages: baseMessages(), tools: toolsFor(bag) },
							choice.toolChoice,
						);

						if (bag === "present") {
							expectToolsPresent(payload, choice.whenPresent);
						} else {
							// Empty and undefined both skip tool serialization; any
							// toolChoice (including none/required/named) must not leak.
							expectToolsOmitted(payload);
						}
					});
				}
			}

			it("preserves tool_choice none when non-empty tools are present", async () => {
				const payload = await stream(
					{ messages: baseMessages(), tools: [testTool] },
					"none",
				);
				expectToolsPresent(payload, "none");
			});

			it("omits tools/tool_choice with prior tool history when tools=[] + toolChoice none", async () => {
				const api = provider;
				const providerName = provider === "openai-responses" ? "custom" : "azure";
				const modelId = `${provider}-test-model`;
				const payload = await stream(
					{
						messages: toolHistoryMessages(api, providerName, modelId),
						tools: [],
					},
					"none",
				);

				expectToolsOmitted(payload);

				// History must still serialize as Responses function_call items.
				const input = payload?.input;
				expect(Array.isArray(input)).toBe(true);
				const items = input as Array<{ type?: string; call_id?: string }>;
				expect(items.some(i => i.type === "function_call")).toBe(true);
				expect(items.some(i => i.type === "function_call_output")).toBe(true);
				expect(items.some(i => i.call_id === "call_1" || i.type === "function_call")).toBe(true);
			});

			it("keeps tools when history exists and tools are non-empty", async () => {
				const api = provider;
				const providerName = provider === "openai-responses" ? "custom" : "azure";
				const modelId = `${provider}-test-model`;
				const payload = await stream(
					{
						messages: toolHistoryMessages(api, providerName, modelId),
						tools: [testTool],
					},
					"auto",
				);
				expectToolsPresent(payload, "auto");
				const input = payload?.input as Array<{ type?: string }>;
				expect(input.some(i => i.type === "function_call")).toBe(true);
				expect(input.some(i => i.type === "function_call_output")).toBe(true);
			});
		});
	}
});

describe("openai-responses freeform / custom tool preservation", () => {
	it("emits custom tool entries and maps named choice to custom tool_choice", async () => {
		const model = openaiModel({
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			applyPatchToolType: "freeform",
		});
		const capture = captureFetch();
		await streamOpenAIResponses(
			model,
			{
				messages: baseMessages(),
				tools: [freeformTool, testTool],
			},
			{
				apiKey: "test-key",
				toolChoice: { type: "function", function: { name: "edit" } },
			},
		).result();
		const payload = capture.getPayload();
		expect(Array.isArray(payload?.tools)).toBe(true);
		const tools = payload?.tools as Array<{ type?: string; name?: string }>;
		expect(tools.some(t => t.type === "custom" && t.name === "apply_patch")).toBe(true);
		expect(tools.some(t => t.type === "function" && t.name === "search")).toBe(true);
		expect(payload?.tool_choice).toEqual({ type: "custom", name: "apply_patch" });
		// Custom grammar tools force serial tool calling for the turn.
		expect(payload?.parallel_tool_calls).toBe(false);
	});

	it("still omits tools and tool_choice for freeform model when tools=[] + none", async () => {
		const model = openaiModel({
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			applyPatchToolType: "freeform",
		});
		const capture = captureFetch();
		await streamOpenAIResponses(
			model,
			{
				messages: baseMessages(),
				tools: [],
			},
			{ apiKey: "test-key", toolChoice: "none" },
		).result();
		expectToolsOmitted(capture.getPayload());
	});
});
