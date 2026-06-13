import { beforeEach, describe, expect, it } from "bun:test";
import type {
	Api,
	AssistantMessageEvent,
	Model,
	ToolChoice,
	ToolChoiceCompat,
	ToolChoiceSupport,
} from "@gajae-code/ai";
import {
	clearToolChoiceIncapabilityRegistryForTests,
	deriveToolChoiceSupport,
	getToolChoiceCapabilityOverride,
	isForcedToolChoiceUnsupportedError,
	markToolChoiceIncapability,
	resolveToolChoice,
	toolChoiceRegistryKey,
} from "@gajae-code/ai";

const supportRank: Record<ToolChoiceSupport, number> = {
	none: 0,
	auto: 1,
	required: 2,
	named: 3,
};

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "model-id",
		name: "Model",
		api: "openai-completions",
		provider: "provider-a",
		baseUrl: "https://api.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		wireModelId: "wire-model-id",
		...overrides,
	};
}

function errorWith(path: "status" | "response.status" | "cause", status: number, message: string): unknown {
	const error = new Error(message) as Error & { status?: number; response?: { status: number }; cause?: unknown };
	if (path === "status") error.status = status;
	if (path === "response.status") error.response = { status };
	if (path === "cause") error.cause = Object.assign(new Error(message), { status });
	return error;
}

beforeEach(() => {
	clearToolChoiceIncapabilityRegistryForTests();
});

describe("red-team static tool choice support derivation", () => {
	const cases: Array<{
		compat: ToolChoiceCompat | undefined;
		expected: { support: ToolChoiceSupport; source: "static" | "derived" };
	}> = [
		{
			compat: { toolChoiceSupport: "required", supportsToolChoice: false, supportsForcedToolChoice: false },
			expected: { support: "required", source: "static" },
		},
		{
			compat: { toolChoiceSupport: "none", supportsToolChoice: true, supportsForcedToolChoice: true },
			expected: { support: "none", source: "static" },
		},
		{
			compat: { supportsToolChoice: false, supportsForcedToolChoice: true },
			expected: { support: "none", source: "derived" },
		},
		{ compat: { supportsForcedToolChoice: false }, expected: { support: "auto", source: "derived" } },
		{ compat: undefined, expected: { support: "named", source: "derived" } },
		{ compat: {}, expected: { support: "named", source: "derived" } },
	];

	for (const { compat, expected } of cases) {
		it(`derives ${expected.support} from ${JSON.stringify(compat)}`, () => {
			expect(deriveToolChoiceSupport(compat)).toEqual(expected);
		});
	}
});

describe("red-team resolveToolChoice clamping properties", () => {
	const requests: Array<{
		label: string;
		choice: ToolChoice | undefined;
		requestedLevel: ToolChoiceSupport;
		targetToolName?: string;
	}> = [
		{ label: "undefined", choice: undefined, requestedLevel: "auto" },
		{ label: "none", choice: "none", requestedLevel: "none" },
		{ label: "auto", choice: "auto", requestedLevel: "auto" },
		{ label: "any", choice: "any", requestedLevel: "required" },
		{ label: "required", choice: "required", requestedLevel: "required" },
		{
			label: "named-direct",
			choice: { type: "function", name: "read_file" },
			requestedLevel: "named",
			targetToolName: "read_file",
		},
		{
			label: "named-function",
			choice: { type: "function", function: { name: "write_file" } },
			requestedLevel: "named",
			targetToolName: "write_file",
		} as unknown as { label: string; choice: ToolChoice; requestedLevel: ToolChoiceSupport; targetToolName: string },
	];
	const supports: ToolChoiceSupport[] = ["none", "auto", "required", "named"];

	for (const support of supports) {
		for (const request of requests) {
			it(`keeps resolved rank within ${support} support for ${request.label}`, () => {
				const result = resolveToolChoice(makeModel({ compat: { toolChoiceSupport: support } }), request.choice);
				expect(result.requestedLevel).toBe(request.requestedLevel);
				expect(result.support).toBe(support);
				if (request.choice !== undefined) {
					expect(supportRank[result.resolvedLevel]).toBeLessThanOrEqual(supportRank[support]);
				}

				if (request.choice === undefined) {
					expect(result.resolvedChoice).toBeUndefined();
					expect(result.resolvedLevel).toBe("auto");
					expect(result.degraded).toBe(false);
					return;
				}

				if (request.choice === "none" && support !== "none") {
					expect(result.resolvedChoice).toBe("none");
					expect(result.resolvedLevel).toBe("none");
					expect(result.degraded).toBe(false);
					return;
				}

				const expectedDegraded = supportRank[request.requestedLevel] > supportRank[result.resolvedLevel];
				expect(result.degraded).toBe(expectedDegraded);
				if (request.requestedLevel === "named" && result.degraded) {
					expect(result.targetToolName).toBe(request.targetToolName);
				}
			});
		}
	}
});

describe("red-team registry isolation and poisoning", () => {
	it("keys boundary baseUrl values and wireModelId instead of id", () => {
		const emptyBase = makeModel({ baseUrl: "", id: "public-id", wireModelId: "wire-id" });
		const malformedBase = makeModel({ baseUrl: "http://[malformed", id: "public-id", wireModelId: "wire-id" });
		const idOnly = makeModel({ baseUrl: "", id: "public-id", wireModelId: undefined });

		expect(toolChoiceRegistryKey(emptyBase)).toBe("openai-completions|provider-a||wire-id");
		expect(toolChoiceRegistryKey(malformedBase)).toBe("openai-completions|provider-a|http://[malformed|wire-id");
		expect(toolChoiceRegistryKey(idOnly)).toBe("openai-completions|provider-a||public-id");
		expect(toolChoiceRegistryKey(emptyBase)).not.toBe(toolChoiceRegistryKey(idOnly));
	});

	it("does not let runtime markings upgrade static capability or previously lowered capability", () => {
		const target = makeModel({ compat: { toolChoiceSupport: "required" } });
		markToolChoiceIncapability(target, "named", "poison with higher support");
		expect(getToolChoiceCapabilityOverride(target)).toBe("named");
		expect(resolveToolChoice(target, { type: "function", name: "target" }).support).toBe("required");

		markToolChoiceIncapability(target, "auto", "real lower support");
		expect(getToolChoiceCapabilityOverride(target)).toBe("auto");
		expect(resolveToolChoice(target, "required").support).toBe("auto");

		markToolChoiceIncapability(target, "required", "second poison attempt");
		expect(getToolChoiceCapabilityOverride(target)).toBe("auto");
		expect(resolveToolChoice(target, "required").support).toBe("auto");
	});

	it("isolates registry entries by provider and reset", () => {
		const providerA = makeModel({ provider: "provider-a", compat: { toolChoiceSupport: "named" } });
		const providerB = makeModel({ provider: "provider-b", compat: { toolChoiceSupport: "named" } });
		expect(toolChoiceRegistryKey(providerA)).not.toBe(toolChoiceRegistryKey(providerB));

		markToolChoiceIncapability(providerA, "auto", "provider-specific failure");
		expect(getToolChoiceCapabilityOverride(providerA)).toBe("auto");
		expect(getToolChoiceCapabilityOverride(providerB)).toBeUndefined();
		expect(resolveToolChoice(providerB, { type: "function", name: "target" }).support).toBe("named");

		clearToolChoiceIncapabilityRegistryForTests();
		expect(getToolChoiceCapabilityOverride(providerA)).toBeUndefined();
	});
});

describe("red-team forced tool choice unsupported classifier", () => {
	const productionMessage = "tool_choice forces tool use is not compatible with this model";

	it("matches exact production 400 message", () => {
		expect(isForcedToolChoiceUnsupportedError(errorWith("status", 400, productionMessage), true)).toBe(true);
	});

	it("matches supported status locations and casing/multiline variants", () => {
		const messages = [
			"TOOL_CHOICE forces tool use is NOT COMPATIBLE with this model",
			"tool choice\nforces tool use\nis not supported by this model",
			"tool-choice is incompatible with this model",
		];
		for (const message of messages) {
			expect(isForcedToolChoiceUnsupportedError(errorWith("status", 400, message), true)).toBe(true);
			expect(isForcedToolChoiceUnsupportedError(errorWith("response.status", 400, message), true)).toBe(true);
			expect(isForcedToolChoiceUnsupportedError(errorWith("cause", 400, message), true)).toBe(true);
		}
	});

	it("rejects non-400 statuses even with exact production message", () => {
		for (const status of [401, 403, 429, 500]) {
			expect(isForcedToolChoiceUnsupportedError(errorWith("status", status, productionMessage), true)).toBe(false);
		}
	});

	it("rejects unsent forced choice, unrelated 400s, nested-only messages, and lookalike billing messages", () => {
		expect(isForcedToolChoiceUnsupportedError(errorWith("status", 400, productionMessage), false)).toBe(false);
		expect(isForcedToolChoiceUnsupportedError(errorWith("status", 400, "invalid request body"), true)).toBe(false);
		expect(isForcedToolChoiceUnsupportedError({ status: 400, error: { message: productionMessage } }, true)).toBe(
			false,
		);
		expect(
			isForcedToolChoiceUnsupportedError(
				errorWith("status", 400, "billing does not allow forced tool selection"),
				true,
			),
		).toBe(false);
	});
});

describe("red-team public type surface", () => {
	it("exposes toolChoiceIncapability event and agent callback types", () => {
		const event: Extract<AssistantMessageEvent, { type: "toolChoiceIncapability" }> = {
			type: "toolChoiceIncapability",
			api: "openai-completions",
			provider: "provider-a",
			model: "wire-model-id",
			requestedLevel: "named",
			resolvedLevel: "required",
			reason: "named tool_choice degraded to required",
			registryKey: "openai-completions|provider-a|https://api.example.test/v1|wire-model-id",
		};
		const config: {
			onToolChoiceIncapability?: (event: Extract<AssistantMessageEvent, { type: "toolChoiceIncapability" }>) => void;
		} = {
			onToolChoiceIncapability: received => {
				expect(received).toBe(event);
			},
		};
		config.onToolChoiceIncapability?.(event);
	});
});
