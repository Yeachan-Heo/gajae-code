import { beforeEach, describe, expect, it } from "bun:test";
import { convertToolConfig, stripBedrockForcedToolChoiceForRetry } from "../src/providers/amazon-bedrock";
import type { Model, Tool } from "../src/types";
import {
	clearToolChoiceIncapabilityRegistryForTests,
	isForcedToolChoiceUnsupportedError,
	markToolChoiceIncapability,
	resolveToolChoice,
} from "../src/utils/tool-choice-capability";

const tool: Tool = {
	name: "read",
	description: "Read",
	parameters: { type: "object", properties: {}, additionalProperties: false },
};

const model: Model<"bedrock-converse-stream"> = {
	id: "anthropic.claude-test",
	name: "Claude Test",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

beforeEach(() => clearToolChoiceIncapabilityRegistryForTests());

describe("Bedrock tool choice", () => {
	it("maps required and any to Bedrock any", () => {
		expect(convertToolConfig([tool], "required")?.toolChoice).toEqual({ any: {} });
		expect(convertToolConfig([tool], "any")?.toolChoice).toEqual({ any: {} });
	});

	it("keeps tools but omits toolChoice when resolvedChoice is undefined", () => {
		const resolved = resolveToolChoice({ ...model, compat: { supportsForcedToolChoice: false } }, "required");
		const config = convertToolConfig([tool], resolved.resolvedChoice);
		expect(config?.tools).toHaveLength(1);
		expect(config?.toolChoice).toBeUndefined();
	});

	it("keeps tools but omits toolChoice after runtime auto marking", () => {
		const target = { ...model, compat: { toolChoiceSupport: "named" as const } };
		markToolChoiceIncapability(target, "auto", "tool_choice is not supported");
		const resolved = resolveToolChoice(target, "required");
		const config = convertToolConfig([tool], resolved.resolvedChoice);
		expect(config?.tools).toHaveLength(1);
		expect(config?.toolChoice).toBeUndefined();
	});

	it("fallback retry body strips only toolConfig.toolChoice", () => {
		const body = {
			messages: [{ role: "user", content: [{ text: "hi" }] }],
			system: [{ text: "system" }],
			inferenceConfig: { maxTokens: 10, temperature: 0.2 },
			toolConfig: {
				tools: [{ toolSpec: { name: "read", description: "Read", inputSchema: { json: { type: "object" } } } }],
				toolChoice: { any: {} },
			},
			additionalModelRequestFields: { customInjected: "kept" },
		};

		const retry = stripBedrockForcedToolChoiceForRetry(body);

		expect(retry).toBe(body);
		expect(retry.toolConfig.tools).toHaveLength(1);
		expect(retry.toolConfig.toolChoice).toBeUndefined();
		expect(retry.messages).toEqual([{ role: "user", content: [{ text: "hi" }] }]);
		expect(retry.system).toEqual([{ text: "system" }]);
		expect(retry.inferenceConfig).toEqual({ maxTokens: 10, temperature: 0.2 });
		expect(retry.additionalModelRequestFields).toEqual({ customInjected: "kept" });
	});

	it("classifies Bedrock validationException forced tool_choice errors as unsupported", () => {
		const error = Object.assign(new Error("validationException: This model does not support forced toolChoice"), {
			status: 400,
		});

		expect(resolveToolChoice(model, "required").resolvedChoice).toBe("required");
		expect(isForcedToolChoiceUnsupportedError(error, true)).toBe(true);
		expect(
			stripBedrockForcedToolChoiceForRetry({ toolConfig: convertToolConfig([tool], "required") }).toolConfig
				?.toolChoice,
		).toBeUndefined();
	});
});

describe("Bedrock tool schema root", () => {
	// Regression: a union-root tool (e.g. `computer`, a z.union) serialized to
	// { anyOf: [...] } with no root `type`, which Bedrock Converse rejects with
	// TOOL_SCHEMA_INVALID: inputSchema.json.type must be one of the following: object.
	const unionTool: Tool = {
		name: "computer",
		description: "Union-root tool",
		parameters: {
			anyOf: [
				{
					type: "object",
					properties: { action: { const: "screenshot" } },
					required: ["action"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { action: { const: "click" }, x: { type: "number" }, y: { type: "number" } },
					required: ["action", "x", "y"],
					additionalProperties: false,
				},
			],
		} as unknown as Tool["parameters"],
	};

	it("flattens a union root to type:object so Bedrock accepts it", () => {
		const config = convertToolConfig([unionTool], "auto");
		const json = config?.tools[0]?.toolSpec.inputSchema.json as Record<string, unknown>;
		expect(json.type).toBe("object");
		expect(json).not.toHaveProperty("anyOf");
		expect(json).not.toHaveProperty("oneOf");
		expect((json.properties as Record<string, unknown>).action).toBeDefined();
	});

	it("leaves an object-root tool's schema unchanged", () => {
		const config = convertToolConfig([tool], "auto");
		const json = config?.tools[0]?.toolSpec.inputSchema.json as Record<string, unknown>;
		expect(json.type).toBe("object");
		expect(json).not.toHaveProperty("anyOf");
	});
});
