import { describe, expect, it } from "bun:test";
import { type Context, getBundledModel, type Model } from "@gajae-code/ai";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import { toolWireSchema } from "@gajae-code/ai/utils/schema";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createTools, type ToolSession } from "@gajae-code/coding-agent/tools";

type JsonObject = Record<string, unknown>;

function createTestSession(stage?: "topology" | "post-topology"): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...(stage ? { getDeepInterviewAskStage: () => stage } : {}),
	};
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectsIn(value: unknown): JsonObject[] {
	if (Array.isArray(value)) return value.flatMap(objectsIn);
	if (!isObject(value)) return [];
	return [value, ...Object.values(value).flatMap(objectsIn)];
}

function hasProperties(value: JsonObject, names: readonly string[]): boolean {
	const properties = value.properties;
	return isObject(properties) && names.every(name => Object.hasOwn(properties, name));
}

function assertMetadataBranches(schema: unknown): void {
	const metadataBranches = objectsIn(schema).filter(branch =>
		hasProperties(branch, ["round", "component", "dimension", "ambiguity"]),
	);
	const ordinary = metadataBranches.find(
		branch => !hasProperties(branch, ["intent_contract"]) && !hasProperties(branch, ["intent_review"]),
	);
	const contract = metadataBranches.find(
		branch => hasProperties(branch, ["intent_contract"]) && !hasProperties(branch, ["intent_review"]),
	);
	const review = metadataBranches.find(
		branch => hasProperties(branch, ["intent_review"]) && !hasProperties(branch, ["intent_contract"]),
	);

	expect(ordinary).toBeDefined();
	expect(contract).toBeDefined();
	expect(review).toBeDefined();
	expect(metadataBranches.some(branch => hasProperties(branch, ["intent_contract", "intent_review"]))).toBe(false);
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function askTool(stage?: "topology" | "post-topology") {
	const tool = (await createTools(createTestSession(stage), ["ask"])).find(candidate => candidate.name === "ask");
	if (!tool) throw new Error("Expected AskTool to be registered");
	return tool;
}

async function capturePayload(stage?: "topology" | "post-topology"): Promise<JsonObject> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const model = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
	const context: Context = {
		messages: [{ role: "user", content: "Confirm locked intent", timestamp: Date.now() }],
		tools: [await askTool(stage)],
	};
	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return (await promise) as JsonObject;
}

describe("issue #2643 — OpenAI completions AskTool wire contract", () => {
	it("emits actual mutually exclusive ordinary, contract, and review metadata branches", async () => {
		const tool = await askTool();
		const wireSchema = toolWireSchema(tool);
		assertMetadataBranches(wireSchema);
		const payload = await capturePayload();
		const tools = payload.tools;
		expect(Array.isArray(tools)).toBe(true);
		const ask = (tools as unknown[]).find(
			candidate => isObject(candidate) && isObject(candidate.function) && candidate.function.name === "ask",
		);
		if (!isObject(ask) || !isObject(ask.function)) throw new Error("OpenAI payload omitted AskTool");

		const parameters = ask.function.parameters;
		assertMetadataBranches(parameters);
		const schemas = objectsIn(parameters);
		const question = schemas.find(schema => hasProperties(schema, ["id", "question", "options", "deepInterview"]));
		expect(question).toBeDefined();
		expect(hasProperties(question as JsonObject, ["workflowGate"])).toBe(true);
	});

	it("exposes only the metadata branch valid for the persisted deep-interview stage", async () => {
		for (const [stage, expected, excluded] of [
			["topology", "intent_contract", "intent_review"],
			["post-topology", "intent_review", "intent_contract"],
		] as const) {
			const payload = await capturePayload(stage);
			const tools = payload.tools;
			expect(Array.isArray(tools)).toBe(true);
			const ask = (tools as unknown[]).find(
				candidate => isObject(candidate) && isObject(candidate.function) && candidate.function.name === "ask",
			);
			if (!isObject(ask) || !isObject(ask.function)) throw new Error("OpenAI payload omitted AskTool");
			const branches = objectsIn(ask.function.parameters).filter(branch =>
				hasProperties(branch, ["round", "component", "dimension", "ambiguity"]),
			);
			expect(branches.some(branch => hasProperties(branch, [expected]))).toBe(true);
			expect(branches.some(branch => hasProperties(branch, [excluded]))).toBe(false);
		}
	});
});
