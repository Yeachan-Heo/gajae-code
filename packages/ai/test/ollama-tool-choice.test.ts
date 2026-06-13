import { beforeEach, describe, expect, it } from "bun:test";
import { createChatBody, streamOllama } from "../src/providers/ollama";
import type { Context, Model, Tool } from "../src/types";
import {
	clearToolChoiceIncapabilityRegistryForTests,
	markToolChoiceIncapability,
} from "../src/utils/tool-choice-capability";
import { collectEvents, expectSingleCleanFallbackEvents } from "./openai-tool-choice-test-helpers";

const tool = (name: string): Tool => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object", properties: {}, additionalProperties: false },
});

const baseModel: Model<"ollama-chat"> = {
	id: "llama",
	name: "Llama",
	api: "ollama-chat",
	provider: "ollama",
	baseUrl: "http://127.0.0.1:11434",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
};

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
	tools: [tool("read"), tool("write")],
};

beforeEach(() => clearToolChoiceIncapabilityRegistryForTests());

describe("Ollama tool choice request building", () => {
	it("maps forced choices and narrows named choices only when resolved to required support", () => {
		const body = createChatBody({ ...baseModel, compat: { toolChoiceSupport: "required" } }, context, {
			toolChoice: { type: "function", name: "write" },
		});
		expect(body.tool_choice).toBe("required");
		expect(body.tools?.map(t => t.function.name)).toEqual(["write"]);
	});

	it("omits unsupported forced tool_choice but keeps tools for static auto-only support", () => {
		const body = createChatBody({ ...baseModel, compat: { supportsForcedToolChoice: false } }, context, {
			toolChoice: "required",
		});
		expect(body.tool_choice).toBeUndefined();
		expect(body.tools?.map(t => t.function.name)).toEqual(["read", "write"]);
	});

	it("omits tool_choice and does not narrow tools after runtime auto marking", () => {
		const model = { ...baseModel, compat: { toolChoiceSupport: "named" as const } };
		markToolChoiceIncapability(model, "auto", "tool_choice is not supported");
		const body = createChatBody(model, context, { toolChoice: { type: "function", name: "write" } });
		expect(body.tool_choice).toBeUndefined();
		expect(body.tools?.map(t => t.function.name)).toEqual(["read", "write"]);
	});

	it("retries from post-onPayload body and strips only tool_choice", async () => {
		const bodies: Record<string, unknown>[] = [];
		const testModel = { ...baseModel, id: "runtime-ollama", baseUrl: "http://ollama.example.test" };
		const stream = streamOllama(testModel, context, {
			apiKey: "test-key",
			toolChoice: "required",
			onPayload: body => ({ ...(body as Record<string, unknown>), customInjected: "kept" }),
			fetch: async (_input, init) => {
				bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
				return bodies.length === 1
					? new Response("tool_choice is not supported", { status: 400 })
					: new Response(
							`${JSON.stringify({ message: { content: "ok" }, done: false })}\n${JSON.stringify({ done: true, eval_count: 1, prompt_eval_count: 1 })}\n`,
							{ status: 200 },
						);
			},
		});

		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.tool_choice).toBe("required");
		expect(bodies[1]?.tool_choice).toBeUndefined();
		expect(bodies[1]?.customInjected).toBe("kept");
		expect(bodies[1]?.tools).toEqual(bodies[0]?.tools);
		expectSingleCleanFallbackEvents(events);
	});
});
