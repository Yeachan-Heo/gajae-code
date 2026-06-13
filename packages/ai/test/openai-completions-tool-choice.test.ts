import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
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

beforeEach(() => {
	clearToolChoiceIncapabilityRegistryForTests();
});

afterEach(() => {
	global.fetch = originalFetch;
});

function model(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return { ...createBaseModel("openai-completions"), ...overrides };
}

function okChunk(modelId: string): Response {
	return createSseResponse([
		{
			id: "chatcmpl-tool-choice",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "chatcmpl-tool-choice",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	]);
}

describe("OpenAI completions tool choice capability", () => {
	it("passes through named tool_choice when named choices are supported", async () => {
		let payload: Record<string, unknown> | undefined;
		const testModel = model({ compat: { toolChoiceSupport: "named" } });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return okChunk(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(payload?.tool_choice).toEqual({ type: "function", function: { name: "search" } });
	});

	it("omits forced tool_choice but keeps tools when forced choices are unsupported", async () => {
		let payload: Record<string, unknown> | undefined;
		const testModel = model({ compat: { supportsForcedToolChoice: false } });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return okChunk(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);

		await streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();

		expect(payload?.tool_choice).toBeUndefined();
		expect(payload?.tools).toEqual(expect.any(Array));
		expect((payload?.tools as unknown[]).length).toBeGreaterThan(0);
	});

	it("retries once without forced tool_choice on semantic 400 and records runtime incapability", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = model({ id: "runtime-completions" });
		global.fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				if (bodies.length === 1) {
					return createErrorResponse("tool_choice forces tool use is not compatible with this model");
				}
				return okChunk(testModel.id);
			},
			{ preconnect: originalFetch.preconnect },
		);

		const stream = streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		});
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.tool_choice).toEqual({ type: "function", function: { name: "search" } });
		expect(bodies[1]?.tool_choice).toBeUndefined();
		expect(bodies[1]?.tools).toEqual(expect.any(Array));
		expect(getToolChoiceCapabilityOverride(testModel)).toBe("auto");
		expectSingleCleanFallbackEvents(events);
	});

	it("propagates unrelated 400 without retry or registry mark", async () => {
		let calls = 0;
		const testModel = model({ id: "unrelated-completions" });
		global.fetch = Object.assign(
			async () => {
				calls += 1;
				return createErrorResponse("some other bad request");
			},
			{ preconnect: originalFetch.preconnect },
		);

		const result = await streamOpenAICompletions(testModel, testContext, {
			apiKey: "test-key",
			toolChoice: { type: "function", function: { name: "search" } },
		}).result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(getToolChoiceCapabilityOverride(testModel)).toBeUndefined();
	});
});
