import { beforeEach, describe, expect, it } from "bun:test";
import type { Model, ToolChoice, ToolChoiceSupport } from "../src/types";
import {
	clearToolChoiceIncapabilityRegistryForTests,
	deriveToolChoiceSupport,
	getToolChoiceCapabilityOverride,
	isForcedToolChoiceUnsupportedError,
	markToolChoiceIncapability,
	resolveToolChoice,
	toolChoiceRegistryKey,
} from "../src/utils/tool-choice-capability";

function model(support?: ToolChoiceSupport): Model<"openai-completions"> {
	return {
		id: "local-id",
		name: "Local",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		wireModelId: "wire-id",
		compat: support ? { toolChoiceSupport: support } : undefined,
	};
}

function statusError(status: number, message: string): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}

beforeEach(() => {
	clearToolChoiceIncapabilityRegistryForTests();
});

describe("deriveToolChoiceSupport", () => {
	it("uses explicit support before legacy flags", () => {
		expect(
			deriveToolChoiceSupport({
				toolChoiceSupport: "required",
				supportsToolChoice: false,
				supportsForcedToolChoice: false,
			}),
		).toEqual({ support: "required", source: "static" });
	});

	it("derives none when supportsToolChoice is false", () => {
		expect(deriveToolChoiceSupport({ supportsToolChoice: false })).toEqual({ support: "none", source: "derived" });
	});

	it("derives auto when forced tool choice is false", () => {
		expect(deriveToolChoiceSupport({ supportsForcedToolChoice: false })).toEqual({
			support: "auto",
			source: "derived",
		});
	});

	it("defaults to named", () => {
		expect(deriveToolChoiceSupport(undefined)).toEqual({ support: "named", source: "derived" });
	});
});

describe("resolveToolChoice", () => {
	const requestedChoices: {
		label: string;
		choice: ToolChoice | undefined;
		level: ToolChoiceSupport;
		targetToolName?: string;
	}[] = [
		{ label: "undefined", choice: undefined, level: "auto" },
		{ label: "none", choice: "none", level: "none" },
		{ label: "auto", choice: "auto", level: "auto" },
		{ label: "any", choice: "any", level: "required" },
		{ label: "required", choice: "required", level: "required" },
		{ label: "named", choice: { type: "function", name: "read" }, level: "named", targetToolName: "read" },
	];
	const supports: ToolChoiceSupport[] = ["none", "auto", "required", "named"];
	const rank: Record<ToolChoiceSupport, number> = { none: 0, auto: 1, required: 2, named: 3 };

	for (const support of supports) {
		for (const requested of requestedChoices) {
			it(`clamps ${requested.label} with ${support} support`, () => {
				const result = resolveToolChoice(model(support), requested.choice);
				expect(result.requestedChoice).toEqual(requested.choice);
				expect(result.requestedLevel).toBe(requested.level);
				expect(result.support).toBe(support);
				expect(result.supportSource).toBe("static");
				expect(result.targetToolName).toBe(requested.targetToolName);

				if (requested.choice === undefined) {
					expect(result.resolvedChoice).toBeUndefined();
					expect(result.resolvedLevel).toBe("auto");
					expect(result.degraded).toBe(false);
					return;
				}

				if (support === "none") {
					expect(result.resolvedChoice).toBeUndefined();
					expect(result.resolvedLevel).toBe("none");
					expect(result.degraded).toBe(requested.level !== "none");
					return;
				}

				const clampLevel = requested.level === "none" ? "auto" : requested.level;
				if (rank[support] >= rank[clampLevel]) {
					expect(result.resolvedChoice).toEqual(requested.choice);
					expect(result.resolvedLevel).toBe(requested.level);
					expect(result.degraded).toBe(false);
				} else if (requested.level === "named" && support === "required") {
					expect(result.resolvedChoice).toBe("required");
					expect(result.resolvedLevel).toBe("required");
					expect(result.degraded).toBe(true);
				} else {
					expect(result.resolvedChoice).toBeUndefined();
					expect(result.resolvedLevel).toBe("auto");
					expect(result.degraded).toBe(true);
				}
			});
		}
	}
});

describe("tool-choice registry", () => {
	it("lowers but never raises capability overrides", () => {
		const target = model("named");
		markToolChoiceIncapability(target, "required", "first");
		expect(getToolChoiceCapabilityOverride(target)).toBe("required");
		markToolChoiceIncapability(target, "named", "raise ignored");
		expect(getToolChoiceCapabilityOverride(target)).toBe("required");
		markToolChoiceIncapability(target, "auto", "lowered");
		expect(getToolChoiceCapabilityOverride(target)).toBe("auto");
	});

	it("resets overrides", () => {
		const target = model("named");
		markToolChoiceIncapability(target, "auto");
		clearToolChoiceIncapabilityRegistryForTests();
		expect(getToolChoiceCapabilityOverride(target)).toBeUndefined();
	});

	it("uses runtime overrides only when they lower static support", () => {
		const target = model("required");
		markToolChoiceIncapability(target, "named");
		expect(resolveToolChoice(target, { type: "function", name: "read" }).support).toBe("required");
		expect(resolveToolChoice(target, { type: "function", name: "read" }).supportSource).toBe("static");
		markToolChoiceIncapability(target, "auto");
		const result = resolveToolChoice(target, "required");
		expect(result.support).toBe("auto");
		expect(result.supportSource).toBe("runtime");
		expect(result.resolvedChoice).toBeUndefined();
	});

	it("keys by api provider baseUrl and wire model", () => {
		expect(toolChoiceRegistryKey(model("named"))).toBe(
			"openai-completions|openai|https://api.openai.example/v1|wire-id",
		);
	});
});

describe("isForcedToolChoiceUnsupportedError", () => {
	it("matches unsupported forced tool_choice 400s", () => {
		expect(
			isForcedToolChoiceUnsupportedError(
				statusError(400, "tool_choice forces tool use is not compatible with this model"),
				true,
			),
		).toBe(true);
	});

	it("rejects non-400 errors", () => {
		expect(
			isForcedToolChoiceUnsupportedError(
				statusError(500, "tool_choice forces tool use is not compatible with this model"),
				true,
			),
		).toBe(false);
	});

	it("rejects requests that did not send forced tool_choice", () => {
		expect(
			isForcedToolChoiceUnsupportedError(
				statusError(400, "tool_choice forces tool use is not compatible with this model"),
				false,
			),
		).toBe(false);
	});

	it("rejects unrelated 400 messages", () => {
		expect(isForcedToolChoiceUnsupportedError(statusError(400, "invalid request body"), true)).toBe(false);
	});
});

const bedrockModel = {
	...model(),
	api: "bedrock-converse-stream",
	compat: { toolChoiceSupport: "required" },
} satisfies Model<"bedrock-converse-stream">;

const googleModel = {
	...model(),
	api: "google-generative-ai",
	compat: { toolChoiceSupport: "named" },
} satisfies Model<"google-generative-ai">;

void bedrockModel;
void googleModel;
