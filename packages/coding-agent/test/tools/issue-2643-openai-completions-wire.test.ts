import { describe, expect, it } from "bun:test";
import { type Context, getBundledModel, type Model, validateToolArguments } from "@gajae-code/ai";
import { streamOpenAICompletions } from "@gajae-code/ai/providers/openai-completions";
import { isJsonSchemaValueValid, toolWireSchema } from "@gajae-code/ai/utils/schema";
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

function countSchemaKeyword(schema: unknown, keyword: string): number {
	return objectsIn(schema).filter(branch => Object.hasOwn(branch, keyword)).length;
}

function askParametersFromPayload(payload: JsonObject): JsonObject {
	const tools = payload.tools;
	if (!Array.isArray(tools)) throw new Error("OpenAI payload omitted tools");
	const ask = tools.find(
		candidate => isObject(candidate) && isObject(candidate.function) && candidate.function.name === "ask",
	);
	if (!isObject(ask) || !isObject(ask.function) || !isObject(ask.function.parameters))
		throw new Error("OpenAI payload omitted AskTool parameters");
	return ask.function.parameters;
}

function roundZeroIntentArguments(intentContract?: JsonObject, intentReview?: JsonObject): JsonObject {
	return {
		questions: [
			{
				id: "round-0-intent",
				question: "Confirm the locked intent",
				options: [{ label: "Confirm" }, { label: "Approve reduction" }],
				deepInterview: {
					round: 0,
					component: "review-topology",
					dimension: "topology",
					ambiguity: 1,
					...(intentContract === undefined ? {} : { intent_contract: intentContract }),
					...(intentReview === undefined ? {} : { intent_review: intentReview }),
				},
			},
		],
	};
}

function positiveRoundIntentReviewArguments(): JsonObject {
	return {
		questions: [
			{
				id: "round-1-intent-review",
				question: "Approve the observed intent",
				options: [{ label: "Approve" }],
				multi: null,
				recommended: null,
				deepInterview: {
					round_id: null,
					round: 1,
					component: "locked-intent",
					dimension: "constraints",
					ambiguity: 0,
					confused_terms: null,
					references: null,
					intent_review: {
						observed_items: [],
						supporting_substitutions: [],
						approval_options: [],
					},
				},
				workflowGate: null,
			},
		],
	};
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
	it("omits deep-interview authority from the inactive provider schema", async () => {
		const tool = await askTool();
		const wireSchema = toolWireSchema(tool);
		expect(objectsIn(wireSchema).some(branch => Object.hasOwn(branch, "deepInterview"))).toBe(false);
		expect(countSchemaKeyword(wireSchema, "minItems")).toBe(1);
		expect(countSchemaKeyword(wireSchema, "exclusiveMinimum")).toBe(0);
		const payload = await capturePayload();
		const parameters = askParametersFromPayload(payload);
		expect(objectsIn(parameters).some(branch => Object.hasOwn(branch, "deepInterview"))).toBe(false);
		expect(countSchemaKeyword(parameters, "minItems")).toBe(0);
		expect(countSchemaKeyword(parameters, "exclusiveMinimum")).toBe(0);
		const schemas = objectsIn(parameters);
		const question = schemas.find(schema => hasProperties(schema, ["id", "question", "options"]));
		expect(question).toBeDefined();
		if (!question) throw new Error("OpenAI payload omitted AskTool question schema");
		expect(hasProperties(question, ["deepInterview"])).toBe(false);
		expect(hasProperties(question, ["workflowGate"])).toBe(true);
	});

	it("locally corrects the bounded Round-0 pair and returns exact rejection codes for stripped constraints", async () => {
		const tool = await askTool("topology");
		const validateRaw = tool.rawArgumentValidation;
		if (!validateRaw) throw new Error("AskTool omitted raw argument validation");
		const contract = {
			items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
			confirmation_options: ["Confirm"],
		};
		const review = {
			observed_items: [{ id: "artifact:report", category: "artifact", statement: "Produce report" }],
			supporting_substitutions: [],
			approval_options: ["Approve reduction"],
		};

		expect(validateRaw(roundZeroIntentArguments({ items: [], confirmation_options: [] }))).toEqual({
			outcome: "reject",
			code: "ask-intent-contract-requires-non-empty-authority",
		});
		expect(
			validateRaw(
				roundZeroIntentArguments(undefined, {
					observed_items: [],
					supporting_substitutions: [],
					approval_options: [],
				}),
			),
		).toEqual({
			outcome: "reject",
			code: "ask-intent-review-requires-positive-round",
		});

		const corrected = validateRaw(roundZeroIntentArguments(contract, review));
		expect(corrected.outcome).toBe("accept");
		if (corrected.outcome !== "accept") throw new Error("AskTool did not correct the canonical Round-0 pair");
		const questions = corrected.arguments.questions;
		if (!Array.isArray(questions) || !isObject(questions[0]) || !isObject(questions[0].deepInterview))
			throw new Error("AskTool returned malformed corrected arguments");
		expect(questions[0].deepInterview.intent_contract).toEqual(contract);
		expect(questions[0].deepInterview).not.toHaveProperty("intent_review");
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

	it("routes wire-valid empty positive-round reviews to canonical Zod diagnostics", async () => {
		// Given
		const payload = await capturePayload("post-topology");
		const parameters = askParametersFromPayload(payload);
		const arguments_ = positiveRoundIntentReviewArguments();
		const tool = await askTool("post-topology");
		const validateRaw = tool.rawArgumentValidation;
		if (!validateRaw) throw new Error("AskTool omitted raw argument validation");

		// When
		const rawValidation = validateRaw(arguments_);
		let validationError: unknown;
		try {
			validateToolArguments(tool, {
				type: "toolCall",
				id: "ask-positive-round-empty-review",
				name: "ask",
				arguments: arguments_,
			});
		} catch (error) {
			validationError = error;
		}

		// Then
		expect(isJsonSchemaValueValid(parameters, arguments_)).toBe(true);
		expect(rawValidation).toEqual({ outcome: "passthrough" });
		expect(validationError).toBeInstanceOf(Error);
		if (!(validationError instanceof Error)) throw new Error("Expected canonical Ask validation to reject");
		expect(validationError.message).toContain("questions/0/deepInterview/intent_review/observed_items");
		expect(validationError.message).toContain("questions/0/deepInterview/intent_review/approval_options");
		expect(validationError.message).not.toContain("raw arguments rejected before coercion");
	});
});
