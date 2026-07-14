import { beforeEach, describe, expect, it } from "bun:test";
import { buildGoogleGenerateContentParams, mapToolChoice, streamGoogleGenAI } from "../src/providers/google-shared";
import type { Context, Model, Tool } from "../src/types";
import {
	clearToolChoiceIncapabilityRegistryForTests,
	markToolChoiceIncapability,
} from "../src/utils/tool-choice-capability";
import {
	collectEvents,
	createErrorResponse,
	createSseResponse,
	expectSingleCleanFallbackEvents,
} from "./openai-tool-choice-test-helpers";

const tool: Tool = {
	name: "read",
	description: "Read",
	parameters: { type: "object", properties: {}, additionalProperties: false },
};

const model: Model<"google-generative-ai"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
	tools: [tool],
};

beforeEach(() => clearToolChoiceIncapabilityRegistryForTests());

describe("Google shared tool choice", () => {
	it("maps required and any to FunctionCallingConfig ANY", () => {
		expect(mapToolChoice("required")).toBe("ANY");
		expect(mapToolChoice("any")).toBe("ANY");
		expect(mapToolChoice("none")).toBe("NONE");
		expect(mapToolChoice("auto")).toBe("AUTO");
	});

	it("builds required as ANY", () => {
		const params = buildGoogleGenerateContentParams(model, context, { toolChoice: "required" });
		expect(params.config?.toolConfig?.functionCallingConfig?.mode).toBe("ANY");
	});

	it("omits toolConfig for static forced-tool incapability while keeping tools", () => {
		const params = buildGoogleGenerateContentParams({ ...model, compat: { toolChoiceSupport: "auto" } }, context, {
			toolChoice: "required",
		});
		expect(params.config?.tools).toBeDefined();
		expect(params.config?.toolConfig).toBeUndefined();
	});

	it("omits toolConfig after runtime auto marking", () => {
		const target = { ...model, compat: { toolChoiceSupport: "named" as const } };
		markToolChoiceIncapability(target, "auto", "tool_choice is not supported");
		const params = buildGoogleGenerateContentParams(target, context, { toolChoice: "required" });
		expect(params.config?.tools).toBeDefined();
		expect(params.config?.toolConfig).toBeUndefined();
	});

	it("retries from post-onPayload params and strips only toolConfig", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = { ...model, id: "runtime-google" };
		const stream = streamGoogleGenAI({
			model: testModel,
			api: "google-generative-ai",
			options: {
				toolChoice: "required",
				onPayload: payload => {
					const params = payload as { config?: Record<string, unknown> };
					return { ...params, config: { ...params.config, customInjected: "kept" } };
				},
			},
			prepare: () => ({
				params: buildGoogleGenerateContentParams(testModel, context, { toolChoice: "required" }),
				url: "https://google.example.test/stream",
				headers: {},
				fetch: async (_input, init) => {
					bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
					return bodies.length === 1
						? createErrorResponse("forced tool_choice is not supported")
						: createSseResponse([
								{
									candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
									usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
								},
							]);
				},
			}),
		});

		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.toolConfig).toBeDefined();
		expect(bodies[1]?.toolConfig).toBeUndefined();
		expect(bodies[1]?.contents).toEqual(bodies[0]?.contents);
		expectSingleCleanFallbackEvents(events);
	});

	it("does not retry forced tool choice in managed mode", async () => {
		let calls = 0;
		const testModel = { ...model, id: "managed-runtime-google" };
		const result = await streamGoogleGenAI({
			model: testModel,
			api: "google-generative-ai",
			options: { toolChoice: "required", fallbackManaged: true },
			prepare: () => ({
				params: buildGoogleGenerateContentParams(testModel, context, { toolChoice: "required" }),
				url: "https://google.example.test/stream",
				headers: {},
				fetch: async () => {
					calls += 1;
					return createErrorResponse("forced tool_choice is not supported");
				},
			}),
		}).result();
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
	});
});
