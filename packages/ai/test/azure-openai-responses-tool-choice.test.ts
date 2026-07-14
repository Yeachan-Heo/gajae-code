import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses";
import type { Model } from "../src/types";
import {
	clearToolChoiceIncapabilityRegistryForTests,
	getToolChoiceCapabilityOverride,
} from "../src/utils/tool-choice-capability";
import {
	collectEvents,
	createBaseModel,
	createErrorResponse,
	createSseResponse,
	expectSingleCleanFallbackEvents,
	testContext,
} from "./openai-tool-choice-test-helpers";

const originalFetch = global.fetch;

beforeEach(() => clearToolChoiceIncapabilityRegistryForTests());
afterEach(() => {
	global.fetch = originalFetch;
});

function model(overrides: Partial<Model<"azure-openai-responses">> = {}): Model<"azure-openai-responses"> {
	return {
		...createBaseModel("azure-openai-responses"),
		provider: "azure",
		baseUrl: "https://example.openai.azure.com/openai/v1",
		...overrides,
	};
}

function okResponse(modelId: string): Response {
	return createSseResponse([
		{ type: "response.created", response: { id: "resp_az", model: modelId, status: "in_progress" } },
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
				id: "resp_az",
				model: modelId,
				status: "completed",
				output: [],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	]);
}

describe("Azure OpenAI responses tool choice capability", () => {
	it("passes through named tool_choice when named choices are supported", async () => {
		let payload: Record<string, unknown> | undefined;
		const testModel = model({ compat: { toolChoiceSupport: "named" } });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return okResponse(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);
		await streamAzureOpenAIResponses(testModel, testContext, {
			apiKey: "test-key",
			azureBaseUrl: testModel.baseUrl,
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();
		expect(payload?.tool_choice).toEqual({ type: "function", name: "search" });
	});

	it("omits forced tool_choice but keeps tools when forced choices are unsupported", async () => {
		let payload: Record<string, unknown> | undefined;
		const testModel = model({ compat: { supportsForcedToolChoice: false } });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return okResponse(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);
		await streamAzureOpenAIResponses(testModel, testContext, {
			apiKey: "test-key",
			azureBaseUrl: testModel.baseUrl,
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();
		expect(payload?.tool_choice).toBeUndefined();
		expect(payload?.tools).toEqual(expect.any(Array));
	});

	it("retries once without forced tool_choice on semantic 400 and records runtime incapability", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = model({ id: "runtime-azure" });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				return bodies.length === 1
					? createErrorResponse("tool_choice forces tool use is not compatible with this model")
					: okResponse(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);
		const stream = streamAzureOpenAIResponses(testModel, testContext, {
			apiKey: "test-key",
			azureBaseUrl: testModel.baseUrl,
			toolChoice: { type: "function", function: { name: "search" } },
			sessionId: "session-a",
		});
		const events = await collectEvents(stream);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.tool_choice).toEqual({ type: "function", name: "search" });
		expect(bodies[1]?.tool_choice).toBeUndefined();
		expect(bodies[1]?.tools).toEqual(expect.any(Array));
		expect(getToolChoiceCapabilityOverride(testModel)).toBe("auto");
		expectSingleCleanFallbackEvents(events);
	});

	it("does not retry forced tool choice in managed mode", async () => {
		let calls = 0;
		const testModel = model({ id: "managed-runtime-azure" });
		global.fetch = Object.assign(
			async () => {
				calls += 1;
				return createErrorResponse("tool_choice forces tool use is not compatible with this model");
			},
			{ preconnect: originalFetch.preconnect },
		);
		const result = await streamAzureOpenAIResponses(testModel, testContext, {
			apiKey: "test-key",
			azureBaseUrl: testModel.baseUrl,
			toolChoice: { type: "function", function: { name: "search" } },
			fallbackManaged: true,
		}).result();
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("propagates unrelated 400 without retry or registry mark", async () => {
		let calls = 0;
		const testModel = model({ id: "unrelated-azure" });
		global.fetch = Object.assign(
			async () => {
				calls += 1;
				return createErrorResponse("some other bad request");
			},
			{ preconnect: originalFetch.preconnect },
		);
		const result = await streamAzureOpenAIResponses(testModel, testContext, {
			apiKey: "test-key",
			azureBaseUrl: testModel.baseUrl,
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(getToolChoiceCapabilityOverride(testModel)).toBeUndefined();
	});
});
