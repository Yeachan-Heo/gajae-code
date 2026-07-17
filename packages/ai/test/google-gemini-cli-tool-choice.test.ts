import { beforeEach, describe, expect, it } from "bun:test";
import { buildRequest, streamGoogleGeminiCli } from "../src/providers/google-gemini-cli";
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

const model: Model<"google-gemini-cli"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
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

describe("Google Gemini CLI tool choice", () => {
	it("builds required as ANY", () => {
		const request = buildRequest(model, context, "project", { toolChoice: "required" });
		expect(request.request.toolConfig?.functionCallingConfig?.mode).toBe("ANY");
	});

	it("builds none as NONE", () => {
		const request = buildRequest(model, context, "project", { toolChoice: "none" });
		expect(request.request.toolConfig?.functionCallingConfig?.mode).toBe("NONE");
	});

	it("omits toolConfig for static forced-tool incapability while keeping tools", () => {
		const request = buildRequest({ ...model, compat: { supportsForcedToolChoice: false } }, context, "project", {
			toolChoice: "required",
		});
		expect(request.request.tools).toBeDefined();
		expect(request.request.toolConfig).toBeUndefined();
	});

	it("omits toolConfig after runtime auto marking", () => {
		const target = { ...model, compat: { toolChoiceSupport: "named" as const } };
		markToolChoiceIncapability(target, "auto", "tool_choice is not supported");
		const request = buildRequest(target, context, "project", { toolChoice: "required" });
		expect(request.request.tools).toBeDefined();
		expect(request.request.toolConfig).toBeUndefined();
	});

	// Test updated: Real Antigravity IDE sends VALIDATED for Claude requests
	// whenever tools are present, regardless of tool choice resolution.
	// Evidence: network interception of official IDE traffic + disassembly.
	// The old test expected toolConfig to be undefined when toolChoiceSupport
	// was "auto", but the real IDE doesn't check tool choice capability.
	it("forces VALIDATED for Antigravity Claude when tools are present", () => {
		const request = buildRequest(
			{ ...model, id: "claude-test", provider: "google-antigravity", compat: { toolChoiceSupport: "auto" } },
			context,
			"project",
			{ toolChoice: "required" },
			true,
		);

		expect(request.request.tools).toBeDefined();
		expect(request.request.toolConfig?.functionCallingConfig?.mode).toBe("VALIDATED");
	});

	it("retries from post-onPayload request body and strips only request.toolConfig", async () => {
		const bodies: Record<string, unknown>[] = [];
		const apiKey = JSON.stringify({ token: "token", projectId: "project" });
		const testModel = { ...model, id: "runtime-gemini-cli", baseUrl: "https://gemini-cli.example.test" };
		const stream = streamGoogleGeminiCli(testModel, context, {
			apiKey,
			toolChoice: "required",
			onPayload: body => ({ ...(body as Record<string, unknown>), customInjected: "kept" }),
			fetch: async (_input, init) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				return bodies.length === 1
					? createErrorResponse("forced tool_choice is not supported")
					: createSseResponse([
							{
								response: {
									candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
									usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
								},
							},
						]);
			},
		});

		const events = await collectEvents(stream);
		const result = await stream.result();
		const firstRequest = bodies[0]?.request as { toolConfig?: unknown } | undefined;
		const retryRequest = bodies[1]?.request as { toolConfig?: unknown } | undefined;

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(firstRequest?.toolConfig).toBeDefined();
		expect(retryRequest?.toolConfig).toBeUndefined();
		expect(bodies[1]?.customInjected).toBe("kept");
		expectSingleCleanFallbackEvents(events);
	});

	it("does not retry forced tool choice in managed mode", async () => {
		let calls = 0;
		const result = await streamGoogleGeminiCli({ ...model, id: "managed-runtime-gemini-cli" }, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "project" }),
			toolChoice: "required",
			fallbackManaged: true,
			fetch: async () => {
				calls += 1;
				return createErrorResponse("forced tool_choice is not supported");
			},
		}).result();
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
	});
});
