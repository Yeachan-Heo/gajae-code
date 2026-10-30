import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, execSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effort } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { complete, getEnvApiKey, stream, streamSimple } from "@gajae-code/ai/stream";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	OptionsForApi,
	Tool,
	ToolResultMessage,
} from "@gajae-code/ai/types";
import { $which } from "@gajae-code/utils";
import * as z from "zod/v4";
import {
	CustomApiRegistry,
	type CustomStreamFn,
	type CustomStreamSimpleFn,
	clearCustomApis,
	registerCustomApi,
} from "../src/api-registry";
import { AssistantMessageEventStream } from "../src/utils/event-stream";
import { e2eApiKey, resolveApiKey } from "./oauth";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("google-antigravity"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, geminiCliToken, antigravityToken, openaiCodexToken] = oauthTokens;

function hasBedrockCredentials(): boolean {
	const region = Bun.env.AWS_REGION ?? Bun.env.AWS_DEFAULT_REGION;
	if (!region) return false;

	// Conservative check: Bedrock needs a region plus either explicit env creds or a profile.
	// (There are other ways to authenticate, but we avoid running E2E tests accidentally.)
	return Boolean(
		(Bun.env.AWS_ACCESS_KEY_ID && Bun.env.AWS_SECRET_ACCESS_KEY) ||
			(Bun.env.AWS_PROFILE && Bun.env.AWS_PROFILE.length > 0),
	);
}

function createCustomApiModel(api: string): Model<Api> {
	return {
		id: "custom-model",
		name: "Custom model",
		api,
		provider: "custom-provider",
		baseUrl: "https://custom.invalid",
		reasoning: false,
		input: ["text"],
		output: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

function createCustomApiResult(model: Model<Api>, text: string): AssistantMessageEventStream {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	const events = new AssistantMessageEventStream();
	events.push({ type: "start", partial: message });
	events.end(message);
	return events;
}

function resultText(message: AssistantMessage): string | undefined {
	const block = message.content[0];
	return block?.type === "text" ? block.text : undefined;
}

async function collectCustomResult(events: AssistantMessageEventStream): Promise<AssistantMessage> {
	let sawStart = false;
	for await (const event of events) {
		if (event.type === "start") sawStart = true;
	}
	expect(sawStart).toBe(true);
	return events.result();
}

afterEach(() => {
	clearCustomApis();
});

describe("scoped custom API stream dispatch", () => {
	const context: Context = { messages: [] };

	it("dispatches the same API and source independently in stream and streamSimple", async () => {
		const registryA = new CustomApiRegistry();
		const registryB = new CustomApiRegistry();
		const streamSimpleA: CustomStreamSimpleFn = model => createCustomApiResult(model, "simple-a");
		const streamSimpleB: CustomStreamSimpleFn = model => createCustomApiResult(model, "simple-b");
		const streamA: CustomStreamFn = model => createCustomApiResult(model, "stream-a");
		const streamB: CustomStreamFn = model => createCustomApiResult(model, "stream-b");
		registryA.register("custom-isolated", streamSimpleA, "same-source", streamA);
		registryB.register("custom-isolated", streamSimpleB, "same-source", streamB);
		const model = createCustomApiModel("custom-isolated");

		const aLowLevel = await collectCustomResult(stream(model, context, { customApiRegistry: registryA }));
		const bLowLevel = await collectCustomResult(stream(model, context, { customApiRegistry: registryB }));
		const aSimple = await collectCustomResult(streamSimple(model, context, { customApiRegistry: registryA }));
		const bSimple = await collectCustomResult(streamSimple(model, context, { customApiRegistry: registryB }));

		expect(resultText(aLowLevel)).toBe("stream-a");
		expect(resultText(bLowLevel)).toBe("stream-b");
		expect(resultText(aSimple)).toBe("simple-a");
		expect(resultText(bSimple)).toBe("simple-b");
		registryA.dispose();
		registryB.dispose();
	});

	it("uses the explicit scope with structured-cloned and JSON-copied models", async () => {
		const registry = new CustomApiRegistry();
		let calls = 0;
		registry.register("custom-copy", model => {
			calls += 1;
			return createCustomApiResult(model, "explicit-scope");
		});
		const model = createCustomApiModel("custom-copy");
		const models = [structuredClone(model), JSON.parse(JSON.stringify(model)) as Model<Api>];

		for (const copiedModel of models) {
			const result = await collectCustomResult(streamSimple(copiedModel, context, { customApiRegistry: registry }));
			expect(resultText(result)).toBe("explicit-scope");
		}
		expect(calls).toBe(2);
		registry.dispose();
	});

	it("retains process-wide dispatch when no scope is supplied", async () => {
		let calls = 0;
		registerCustomApi(
			"custom-global-dispatch",
			model => {
				calls += 1;
				return createCustomApiResult(model, "global-simple");
			},
			"global-source",
			model => {
				calls += 1;
				return createCustomApiResult(model, "global-stream");
			},
		);
		const model = createCustomApiModel("custom-global-dispatch");

		const simple = await collectCustomResult(streamSimple(model, context));
		const lowLevel = await collectCustomResult(stream(model, context));

		expect(resultText(simple)).toBe("global-simple");
		expect(resultText(lowLevel)).toBe("global-stream");
		expect(calls).toBe(2);
	});

	it("does not use global handlers for a missing scoped custom API", () => {
		let globalCalls = 0;
		registerCustomApi("custom-scoped-miss", model => {
			globalCalls += 1;
			return createCustomApiResult(model, "global");
		});
		const registry = new CustomApiRegistry();
		const model = createCustomApiModel("custom-scoped-miss");

		expect(() => stream(model, context, { customApiRegistry: registry })).toThrow(
			"Unhandled API: custom-scoped-miss",
		);
		expect(() => streamSimple(model, context, { customApiRegistry: registry })).toThrow(
			"Unhandled API: custom-scoped-miss",
		);
		expect(globalCalls).toBe(0);
		registry.dispose();
	});

	it("rejects disposed and fabricated scopes before built-in API dispatch", () => {
		const model = createCustomApiModel("openai-completions");
		const disposed = new CustomApiRegistry();
		disposed.dispose();
		const fabricated = Object.create(CustomApiRegistry.prototype) as CustomApiRegistry;

		for (const registry of [disposed, fabricated]) {
			expect(() => stream(model, context, { customApiRegistry: registry })).toThrow();
			expect(() => streamSimple(model, context, { customApiRegistry: registry })).toThrow();
		}
	});

	it("preserves the explicit registry through custom callback auth retry", async () => {
		const registry = new CustomApiRegistry();
		const seenRegistries: CustomApiRegistry[] = [];
		let calls = 0;
		registry.register("custom-auth-retry", (_model, _context, options) => {
			seenRegistries.push(options!.customApiRegistry!);
			calls += 1;
			if (calls === 1) throw Object.assign(new Error("unauthorized"), { status: 401 });
			return createCustomApiResult(_model, "retried");
		});
		const result = await collectCustomResult(
			streamSimple(createCustomApiModel("custom-auth-retry"), context, {
				customApiRegistry: registry,
				apiKey: "old-key",
				onAuthError: async () => "new-key",
			}),
		);

		expect(resultText(result)).toBe("retried");
		expect(calls).toBe(2);
		expect(seenRegistries).toHaveLength(2);
		expect(seenRegistries[0]).toBe(registry);
		expect(seenRegistries[1]).toBe(registry);
		registry.dispose();
	});
});

// Calculator tool definition (same as examples)
const calculatorSchema = z.object({
	a: z.number().describe("First number"),
	b: z.number().describe("Second number"),
	operation: z
		.enum(["add", "subtract", "multiply", "divide"])
		.describe("The operation to perform. One of 'add', 'subtract', 'multiply', 'divide'."),
});

const calculatorTool: Tool<typeof calculatorSchema> = {
	name: "math_operation",
	description: "Perform basic arithmetic operations",
	parameters: calculatorSchema,
};

async function basicTextGeneration<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	const context: Context = {
		systemPrompt: ["You are a helpful assistant. Be concise."],
		messages: [{ role: "user", content: "Reply with exactly: 'Hello test successful'", timestamp: Date.now() }],
	};
	const response = await complete(model, context, options);

	expect(response.role).toBe("assistant");
	expect(response.content).toBeTruthy();
	expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
	expect(response.usage.output).toBeGreaterThan(0);
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.map(b => (b.type === "text" ? b.text : "")).join("")).toContain("Hello test successful");

	context.messages.push(response);
	context.messages.push({ role: "user", content: "Now say 'Goodbye test successful'", timestamp: Date.now() });

	const secondResponse = await complete(model, context, options);

	expect(secondResponse.role).toBe("assistant");
	expect(secondResponse.content).toBeTruthy();
	expect(secondResponse.usage.input + secondResponse.usage.cacheRead).toBeGreaterThan(0);
	expect(secondResponse.usage.output).toBeGreaterThan(0);
	expect(secondResponse.errorMessage).toBeFalsy();
	expect(secondResponse.content.map(b => (b.type === "text" ? b.text : "")).join("")).toContain(
		"Goodbye test successful",
	);
}

async function handleToolCall<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	const context: Context = {
		systemPrompt: ["You are a helpful assistant that uses tools when asked."],
		messages: [
			{
				role: "user",
				content: "Calculate 15 + 27 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	const s = stream(model, context, options);
	let hasToolStart = false;
	let hasToolDelta = false;
	let hasToolEnd = false;
	let accumulatedToolArgs = "";
	let index = 0;
	for await (const event of s) {
		if (event.type === "toolcall_start") {
			hasToolStart = true;
			const toolCall = event.partial.content[event.contentIndex];
			index = event.contentIndex;
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				expect(toolCall.id).toBeTruthy();
			}
		}
		if (event.type === "toolcall_delta") {
			hasToolDelta = true;
			const toolCall = event.partial.content[event.contentIndex];
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				accumulatedToolArgs += event.delta;
				// Check that we have a parsed arguments object during streaming
				expect(toolCall.arguments).toBeDefined();
				expect(typeof toolCall.arguments).toBe("object");
				// The arguments should be partially populated as we stream
				// At minimum it should be an empty object, never undefined
				expect(toolCall.arguments).not.toBeNull();
			}
		}
		if (event.type === "toolcall_end") {
			hasToolEnd = true;
			const toolCall = event.partial.content[event.contentIndex];
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				JSON.parse(accumulatedToolArgs);
				expect(toolCall.arguments).not.toBeUndefined();
				expect((toolCall.arguments as any).a).toBe(15);
				expect((toolCall.arguments as any).b).toBe(27);
				expect(["add", "subtract", "multiply", "divide"]).toContain((toolCall.arguments as any).operation);
			}
		}
	}

	expect(hasToolStart).toBe(true);
	expect(hasToolDelta).toBe(true);
	expect(hasToolEnd).toBe(true);

	const response = await s.result();
	expect(response.stopReason).toBe("toolUse");
	expect(response.content.some(b => b.type === "toolCall")).toBeTruthy();
	const toolCall = response.content.find(b => b.type === "toolCall");
	if (toolCall && toolCall.type === "toolCall") {
		expect(toolCall.name).toBe("math_operation");
		expect(toolCall.id).toBeTruthy();
	} else {
		throw new Error("No tool call found in response");
	}
}

async function handleStreaming<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	let textStarted = false;
	let textChunks = "";
	let textCompleted = false;

	const context: Context = {
		messages: [{ role: "user", content: "Count from 1 to 3", timestamp: Date.now() }],
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "text_start") {
			textStarted = true;
		} else if (event.type === "text_delta") {
			textChunks += event.delta;
		} else if (event.type === "text_end") {
			textCompleted = true;
		}
	}

	const response = await s.result();

	expect(textStarted).toBe(true);
	expect(textChunks.length).toBeGreaterThan(0);
	expect(textCompleted).toBe(true);
	expect(response.content.some(b => b.type === "text")).toBeTruthy();
}

async function handleThinking<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	let thinkingStarted = false;
	let thinkingChunks = "";
	let thinkingCompleted = false;

	const context: Context = {
		messages: [
			{
				role: "user",
				content: `Think long and hard about ${
					(Math.random() * 255) | 0
				} + 27. Think step by step. Then output the result.`,
				timestamp: Date.now(),
			},
		],
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "thinking_start") {
			thinkingStarted = true;
		} else if (event.type === "thinking_delta") {
			thinkingChunks += event.delta;
		} else if (event.type === "thinking_end") {
			thinkingCompleted = true;
		}
	}

	const response = await s.result();

	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(thinkingStarted).toBe(true);
	expect(thinkingChunks.length).toBeGreaterThan(0);
	expect(thinkingCompleted).toBe(true);
	expect(response.content.some(b => b.type === "thinking")).toBeTruthy();
}

async function handleImage<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	// Check if the model supports images
	if (!model.input.includes("image")) {
		console.log(`Skipping image test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	const imagePath = path.join(import.meta.dir, "data", "red-circle.png");
	const imageBuffer = await fs.readFile(imagePath);
	const base64Image = imageBuffer.toBase64();

	const imageContent: ImageContent = {
		type: "image",
		data: base64Image,
		mimeType: "image/png",
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "What do you see in this image? Please describe the shape (circle, rectangle, square, triangle, ...) and color (red, blue, green, ...). You MUST reply in English.",
					},
					imageContent,
				],
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(model, context, options);

	// Check the response mentions red and circle
	expect(response.content.length > 0).toBeTruthy();
	const textContent = response.content.find(b => b.type === "text");
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

async function multiTurn<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	const context: Context = {
		systemPrompt: ["You are a helpful assistant that can use tools to answer questions."],
		messages: [
			{
				role: "user",
				content: "Think about this briefly, then calculate 42 * 17 and 453 + 434 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	// Collect all text content from all assistant responses
	let allTextContent = "";
	let hasSeenThinking = false;
	let hasSeenToolCalls = false;
	const maxTurns = 5; // Prevent infinite loops

	for (let turn = 0; turn < maxTurns; turn++) {
		const response = await complete(model, context, options);

		// Add the assistant response to context
		context.messages.push(response);

		// Process content blocks
		const results: ToolResultMessage[] = [];
		for (const block of response.content) {
			if (block.type === "text") {
				allTextContent += block.text;
			} else if (block.type === "thinking") {
				hasSeenThinking = true;
			} else if (block.type === "toolCall") {
				hasSeenToolCalls = true;

				// Process the tool call
				expect(block.name).toBe("math_operation");
				expect(block.id).toBeTruthy();
				expect(block.arguments).toBeTruthy();

				const { a, b, operation } = block.arguments;
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "multiply":
						result = a * b;
						break;
					default:
						result = 0;
				}

				// Add tool result to context
				results.push({
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name,
					content: [{ type: "text", text: `${result}` }],
					isError: false,
					timestamp: Date.now(),
				});
			}
		}
		context.messages.push(...results);

		// If we got a stop response with text content, we're likely done
		expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
		if (response.stopReason === "stop") {
			break;
		}
	}

	// Verify we got either thinking content or tool calls (or both)
	expect(hasSeenThinking || hasSeenToolCalls).toBe(true);

	// The accumulated text should reference both calculations
	expect(allTextContent).toBeTruthy();
	expect(allTextContent.includes("714")).toBe(true);
	expect(allTextContent.includes("887")).toBe(true);
}

describe("Generate E2E Tests", () => {
	describe.skipIf(!e2eApiKey("GEMINI_API_KEY"))("Gemini Provider (gemini-2.5-flash)", () => {
		const llm = getBundledModel("google", "gemini-2.5-flash");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle ",
			async () => {
				await handleThinking(llm, { thinking: { enabled: true, budgetTokens: 1024 } });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { thinking: { enabled: true, budgetTokens: 2048 } });
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe("google-vertex env auth", () => {
		it("treats GOOGLE_CLOUD_API_KEY as a configured google-vertex credential", () => {
			const originalApiKey = Bun.env.GOOGLE_CLOUD_API_KEY;
			const originalProject = Bun.env.GOOGLE_CLOUD_PROJECT;
			const originalGcloudProject = Bun.env.GCLOUD_PROJECT;
			const originalLocation = Bun.env.GOOGLE_CLOUD_LOCATION;
			const originalApplicationCredentials = Bun.env.GOOGLE_APPLICATION_CREDENTIALS;

			try {
				Bun.env.GOOGLE_CLOUD_API_KEY = "vertex-test-key";
				delete Bun.env.GOOGLE_CLOUD_PROJECT;
				delete Bun.env.GCLOUD_PROJECT;
				delete Bun.env.GOOGLE_CLOUD_LOCATION;
				delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;

				expect(getEnvApiKey("google-vertex")).toBe("vertex-test-key");
			} finally {
				if (originalApiKey === undefined) delete Bun.env.GOOGLE_CLOUD_API_KEY;
				else Bun.env.GOOGLE_CLOUD_API_KEY = originalApiKey;
				if (originalProject === undefined) delete Bun.env.GOOGLE_CLOUD_PROJECT;
				else Bun.env.GOOGLE_CLOUD_PROJECT = originalProject;
				if (originalGcloudProject === undefined) delete Bun.env.GCLOUD_PROJECT;
				else Bun.env.GCLOUD_PROJECT = originalGcloudProject;
				if (originalLocation === undefined) delete Bun.env.GOOGLE_CLOUD_LOCATION;
				else Bun.env.GOOGLE_CLOUD_LOCATION = originalLocation;
				if (originalApplicationCredentials === undefined) delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
				else Bun.env.GOOGLE_APPLICATION_CREDENTIALS = originalApplicationCredentials;
			}
		});

		it("ignores sentinel apiKey values like '<authenticated>' passed from agent loop", async () => {
			const originalProject = Bun.env.GOOGLE_CLOUD_PROJECT;
			const originalLocation = Bun.env.GOOGLE_CLOUD_LOCATION;
			const originalApiKey = Bun.env.GOOGLE_CLOUD_API_KEY;
			const llm = getBundledModel("google-vertex", "gemini-3-flash-preview");
			const controller = new AbortController();
			controller.abort();

			// Capture console.debug to detect SDK warnings
			const debugMessages: string[] = [];
			const origDebug = console.debug;
			console.debug = (...args: unknown[]) => {
				debugMessages.push(args.map(String).join(" "));
			};

			try {
				Bun.env.GOOGLE_CLOUD_PROJECT = "test-project";
				Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";
				delete Bun.env.GOOGLE_CLOUD_API_KEY;

				// The agent loop passes "<authenticated>" as apiKey for credential-less providers.
				// google-vertex should ignore this sentinel and use ADC (project/location) instead.
				await complete(
					llm,
					{ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
					{ apiKey: "<authenticated>", signal: controller.signal },
				);

				// Should NOT trigger the SDK warning about API key taking precedence
				const hasWarning = debugMessages.some(m => m.includes("API key will take precedence"));
				expect(hasWarning).toBe(false);
			} finally {
				console.debug = origDebug;
				if (originalProject === undefined) delete Bun.env.GOOGLE_CLOUD_PROJECT;
				else Bun.env.GOOGLE_CLOUD_PROJECT = originalProject;
				if (originalLocation === undefined) delete Bun.env.GOOGLE_CLOUD_LOCATION;
				else Bun.env.GOOGLE_CLOUD_LOCATION = originalLocation;
				if (originalApiKey === undefined) delete Bun.env.GOOGLE_CLOUD_API_KEY;
				else Bun.env.GOOGLE_CLOUD_API_KEY = originalApiKey;
			}
		});

		it("keeps every system prompt array entry in Vertex systemInstruction", async () => {
			const llm = getBundledModel("google-vertex", "gemini-3-flash-preview");
			const controller = new AbortController();
			const { promise, resolve } = Promise.withResolvers<{
				config: { systemInstruction?: unknown };
				contents: unknown[];
			}>();
			const events = stream(
				llm,
				{
					systemPrompt: ["Primary instruction.", "Secondary instruction."],
					messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
				},
				{
					apiKey: "vertex-test-key",
					signal: controller.signal,
					onPayload: payload => {
						resolve(payload as { config: { systemInstruction?: unknown }; contents: unknown[] });
						controller.abort();
					},
				},
			);

			const drain = (async () => {
				for await (const _ of events) {
				}
			})();

			const payload = await promise;
			await drain;

			expect(payload.config.systemInstruction).toEqual({
				parts: [{ text: "Primary instruction." }, { text: "Secondary instruction." }],
			});
			expect(payload.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);
		});

		it("allows explicit Vertex API keys without requiring project or location", async () => {
			const originalApiKey = Bun.env.GOOGLE_CLOUD_API_KEY;
			const originalProject = Bun.env.GOOGLE_CLOUD_PROJECT;
			const originalGcloudProject = Bun.env.GCLOUD_PROJECT;
			const originalLocation = Bun.env.GOOGLE_CLOUD_LOCATION;
			const llm = getBundledModel("google-vertex", "gemini-3-flash-preview");
			const controller = new AbortController();
			controller.abort();

			try {
				delete Bun.env.GOOGLE_CLOUD_API_KEY;
				delete Bun.env.GOOGLE_CLOUD_PROJECT;
				delete Bun.env.GCLOUD_PROJECT;
				delete Bun.env.GOOGLE_CLOUD_LOCATION;

				const response = await complete(
					llm,
					{ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
					{ apiKey: "vertex-test-key", signal: controller.signal },
				);

				expect(response.stopReason).toBe("aborted");
				expect(response.errorMessage).toBeTruthy();
				expect(response.errorMessage).not.toContain("Vertex AI requires a project ID");
				expect(response.errorMessage).not.toContain("Vertex AI requires a location");
			} finally {
				if (originalApiKey === undefined) delete Bun.env.GOOGLE_CLOUD_API_KEY;
				else Bun.env.GOOGLE_CLOUD_API_KEY = originalApiKey;
				if (originalProject === undefined) delete Bun.env.GOOGLE_CLOUD_PROJECT;
				else Bun.env.GOOGLE_CLOUD_PROJECT = originalProject;
				if (originalGcloudProject === undefined) delete Bun.env.GCLOUD_PROJECT;
				else Bun.env.GCLOUD_PROJECT = originalGcloudProject;
				if (originalLocation === undefined) delete Bun.env.GOOGLE_CLOUD_LOCATION;
				else Bun.env.GOOGLE_CLOUD_LOCATION = originalLocation;
			}
		});
	});

	describe("Google Vertex Provider (gemini-3-flash-preview)", () => {
		const vertexApiKey = Bun.env.GOOGLE_CLOUD_API_KEY;
		const vertexProject = Bun.env.GOOGLE_CLOUD_PROJECT || Bun.env.GCLOUD_PROJECT;
		const vertexLocation = Bun.env.GOOGLE_CLOUD_LOCATION;
		const isVertexConfigured = Boolean(vertexProject && vertexLocation);
		const vertexOptions = { project: vertexProject, location: vertexLocation } as const;
		const llm = getBundledModel("google-vertex", "gemini-3-flash-preview");

		it.skipIf(!vertexApiKey)(
			"should complete basic text generation with Vertex API key",
			async () => {
				await basicTextGeneration(llm, { apiKey: vertexApiKey! });
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, vertexOptions);
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, vertexOptions);
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should handle thinking",
			async () => {
				await handleThinking(llm, {
					...vertexOptions,
					thinking: { enabled: true, budgetTokens: 1024, level: "LOW" },
				});
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, vertexOptions);
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, {
					...vertexOptions,
					thinking: { enabled: true, budgetTokens: 1024, level: "MEDIUM" },
				});
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should handle image input",
			async () => {
				await handleImage(llm, vertexOptions);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Completions Provider (gpt-4o-mini)", () => {
		const llm: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
		};

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Responses Provider (gpt-5-mini)", () => {
		const llm = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking",
			async () => {
				await handleThinking(llm, { reasoning: Effort.High });
			},
			{ retry: 2 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.High });
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("Anthropic Provider (claude-haiku-4-5-20251001)", () => {
		const model = getBundledModel("anthropic", "claude-haiku-4-5-20251001");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(model, { thinkingEnabled: true });
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(model);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(model);
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(model);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Responses Provider (gpt-5-mini)", () => {
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(model);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(model);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(model);
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(model);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("XAI_API_KEY"))("xAI Provider (grok-code-fast-1 via OpenAI Completions)", () => {
		const llm = getBundledModel("xai", "grok-code-fast-1");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("GROQ_API_KEY"))("Groq Provider (gpt-oss-20b via OpenAI Completions)", () => {
		const llm = getBundledModel("groq", "openai/gpt-oss-20b");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("CEREBRAS_API_KEY"))("Cerebras Provider (gpt-oss-120b via OpenAI Completions)", () => {
		const llm = getBundledModel("cerebras", "gpt-oss-120b");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENROUTER_API_KEY"))("OpenRouter Provider (glm-4.5v via OpenAI Completions)", () => {
		const llm = getBundledModel("openrouter", "z-ai/glm-4.5v");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 2 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("ZAI_API_KEY"))("zAI Provider (glm-4.5-air via OpenAI Completions)", () => {
		const llm = getBundledModel("zai", "glm-4.5-air");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it.skip(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("ZAI_API_KEY"))("zAI Provider (glm-4.5v via OpenAI Completions)", () => {
		const llm = getBundledModel("zai", "glm-4.5v");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("MISTRAL_API_KEY"))(
		"Mistral Provider (devstral-medium-latest via OpenAI Completions)",
		() => {
			const llm = getBundledModel("mistral", "devstral-medium-latest");

			it(
				"should complete basic text generation",
				async () => {
					await basicTextGeneration(llm);
				},
				{ retry: 3 },
			);

			it(
				"should handle tool calling",
				async () => {
					await handleToolCall(llm);
				},
				{ retry: 3 },
			);

			it(
				"should handle streaming",
				async () => {
					await handleStreaming(llm);
				},
				{ retry: 3 },
			);

			it(
				"should handle thinking mode",
				async () => {
					// FIXME Skip for now, getting a 422 stauts code, need to test with official SDK
					// const llm = getModel("mistral", "magistral-medium-latest");
					// await handleThinking(llm, { reasoningEffort: "medium" });
				},
				{ retry: 3 },
			);

			it(
				"should handle multi-turn with thinking and tools",
				async () => {
					await multiTurn(llm, { reasoning: Effort.Medium });
				},
				{ retry: 3 },
			);
		},
	);

	describe.skipIf(!e2eApiKey("MISTRAL_API_KEY"))("Mistral Provider (pixtral-12b with image support)", () => {
		const llm = getBundledModel("mistral", "pixtral-12b");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe("Anthropic OAuth Provider (claude-sonnet-4-20250514)", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-20250514");

		it.skipIf(!anthropicOAuthToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(model, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(model, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(model, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle thinking",
			async () => {
				await handleThinking(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true });
			},
			{ retry: 3 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true });
			},
			{ retry: 3 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle image input",
			async () => {
				await handleImage(model, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3 },
		);
	});

	describe("GitHub Copilot Provider (gpt-4o via OpenAI Completions)", () => {
		const llm = getBundledModel("github-copilot", "gpt-4o");

		it.skipIf(!githubCopilotToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle thinking",
			async () => {
				const thinkingModel = getBundledModel("github-copilot", "gpt-5-mini");
				await handleThinking(thinkingModel, { apiKey: githubCopilotToken, reasoning: Effort.High });
			},
			{ retry: 2 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				const thinkingModel = getBundledModel("github-copilot", "gpt-5-mini");
				await multiTurn(thinkingModel, { apiKey: githubCopilotToken, reasoning: Effort.High });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle image input",
			async () => {
				await handleImage(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);
	});

	describe("Google Gemini CLI Provider (gemini-2.5-flash)", () => {
		const llm = getBundledModel("google-gemini-cli", "gemini-2.5-flash");

		it.skipIf(!geminiCliToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle thinking",
			async () => {
				await handleThinking(llm, { apiKey: geminiCliToken, thinking: { enabled: true, budgetTokens: 1024 } });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { apiKey: geminiCliToken, thinking: { enabled: true, budgetTokens: 2048 } });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle image input",
			async () => {
				await handleImage(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3 },
		);
	});

	describe("Google Gemini CLI Provider (gemini-3-flash-preview with thinkingLevel)", () => {
		const llm = getBundledModel("google-gemini-cli", "gemini-3-flash-preview");

		it.skipIf(!geminiCliToken)(
			"should handle thinking with thinkingLevel",
			async () => {
				await handleThinking(llm, { apiKey: geminiCliToken, thinking: { enabled: true, level: "LOW" } });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { apiKey: geminiCliToken, thinking: { enabled: true, level: "MEDIUM" } });
			},
			{ retry: 3 },
		);
	});

	describe("Google Antigravity Provider (gemini-3-pro-high)", () => {
		const llm = getBundledModel("google-antigravity", "gemini-3-pro-high");

		it.skipIf(!antigravityToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle thinking with thinkingLevel",
			async () => {
				// gemini-3-pro only supports LOW/HIGH
				await handleThinking(llm, {
					apiKey: antigravityToken,
					thinking: { enabled: true, level: "LOW" },
				});
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { apiKey: antigravityToken, thinking: { enabled: true, level: "HIGH" } });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle image input",
			async () => {
				await handleImage(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);
	});

	describe("Google Antigravity Provider (claude-sonnet-4-5)", () => {
		const llm = getBundledModel("google-antigravity", "claude-sonnet-4-5");

		it.skipIf(!antigravityToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle thinking",
			async () => {
				// Anthropic model-sonnet-4-5 has reasoning: false, use Anthropic model-sonnet-4-5-thinking
				const thinkingModel = getBundledModel("google-antigravity", "claude-sonnet-4-5-thinking");
				await handleThinking(thinkingModel, {
					apiKey: antigravityToken,
					thinking: { enabled: true, budgetTokens: 4096 },
				});
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				const thinkingModel = getBundledModel("google-antigravity", "claude-sonnet-4-5-thinking");
				await multiTurn(thinkingModel, {
					apiKey: antigravityToken,
					thinking: { enabled: true, budgetTokens: 4096 },
				});
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle image input",
			async () => {
				await handleImage(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);
	});

	describe("OpenAI Codex Provider (gpt-5.2-codex)", () => {
		const llm = getBundledModel("openai-codex", "gpt-5.2-codex");

		it.skipIf(!openaiCodexToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!openaiCodexToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!openaiCodexToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!openaiCodexToken)(
			"should handle thinking",
			async () => {
				await handleThinking(llm, { apiKey: openaiCodexToken, reasoning: Effort.High });
			},
			{ retry: 3 },
		);

		it.skipIf(!openaiCodexToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!openaiCodexToken)(
			"should handle image input",
			async () => {
				await handleImage(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider (claude-opus-4-6 interleaved thinking)", () => {
		const llm = getBundledModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");

		it(
			"should use adaptive thinking without anthropic_beta",
			async () => {
				let capturedPayload: unknown;
				const response = await complete(
					llm,
					{
						systemPrompt: ["You are a helpful assistant that uses tools when asked."],
						messages: [
							{
								role: "user",
								content: "Think first, then calculate 15 + 27 using the math_operation tool.",
								timestamp: Date.now(),
							},
						],
						tools: [calculatorTool],
					},
					{
						reasoning: Effort.XHigh,
						interleavedThinking: true,
						onPayload: payload => {
							capturedPayload = payload;
						},
					},
				);

				expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
				expect(capturedPayload).toBeTruthy();

				const payload = capturedPayload as {
					additionalModelRequestFields?: {
						thinking?: { type?: string };
						output_config?: { effort?: string };
						anthropic_beta?: string[];
					};
				};

				expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive" });
				expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "max" });
				expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
			},
			{ retry: 3 },
		);
	});

	// Ollama tests require PI_LOCAL_LLM=1 and ollama installed
	const ollamaInstalled = !!Bun.env.PI_LOCAL_LLM && !!$which("ollama");

	describe.skipIf(!ollamaInstalled)("Ollama Provider (gpt-oss-20b via OpenAI Completions)", () => {
		let llm: Model<"openai-completions"> | undefined;
		let ollamaProcess: ChildProcess | null = null;

		beforeAll(async () => {
			if (!ollamaInstalled) return;
			// Check if model is available, if not pull it
			try {
				execSync("ollama list | grep -q 'gpt-oss:20b'", { stdio: "ignore" });
			} catch {
				console.log("Pulling gpt-oss:20b model for Ollama tests...");
				try {
					execSync("ollama pull gpt-oss:20b", { stdio: "inherit" });
				} catch {
					console.warn("Failed to pull gpt-oss:20b model, tests will be skipped");
					return;
				}
			}

			// Start ollama server
			ollamaProcess = spawn("ollama", ["serve"], {
				stdio: "ignore",
			});

			// Wait for server to be ready
			await new Promise<void>(resolve => {
				const checkServer = async () => {
					try {
						const response = await fetch("http://localhost:11434/api/tags");
						if (response.ok) {
							resolve();
						} else {
							setTimeout(checkServer, 500);
						}
					} catch {
						setTimeout(checkServer, 500);
					}
				};
				setTimeout(checkServer, 1000); // Initial delay
			});

			llm = {
				id: "gpt-oss:20b",
				api: "openai-completions",
				provider: "ollama",
				baseUrl: "http://localhost:11434/v1",
				reasoning: true,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16000,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				name: "Ollama GPT-OSS 20B",
			};
		}, 30000); // 30 second timeout for setup

		afterAll(() => {
			// Kill ollama server
			if (ollamaProcess) {
				ollamaProcess.kill("SIGTERM");
				ollamaProcess = null;
			}
		});

		it(
			"should complete basic text generation",
			async () => {
				if (!llm) return;
				await basicTextGeneration(llm, { apiKey: "test" });
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				if (!llm) return;
				await handleToolCall(llm, { apiKey: "test" });
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				if (!llm) return;
				await handleStreaming(llm, { apiKey: "test" });
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				if (!llm) return;
				await handleThinking(llm, { apiKey: "test", reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				if (!llm) return;
				await multiTurn(llm, { apiKey: "test", reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);
	});
});
