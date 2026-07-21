import { afterEach, describe, expect, test, vi } from "bun:test";
import modelsJson from "../src/models.json" with { type: "json" };
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { alibabaTokenPlanModelManagerOptions } from "../src/provider-models/openai-compat";
import { detectOpenAICompat } from "../src/providers/openai-completions-compat";
import { getEnvApiKey } from "../src/stream";
import type { Model } from "../src/types";
import { getOAuthProviders } from "../src/utils/oauth";
import { loginAlibabaTokenPlan } from "../src/utils/oauth/alibaba-token-plan";

const TOKEN_PLAN_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const CODING_PLAN_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
const EXPECTED_MODEL_IDS = [
	"qwen3.7-max",
	"qwen3.8-max-preview",
	"qwen3.7-plus",
	"qwen3.6-flash",
	"glm-5.2",
	"deepseek-v4-pro",
];

const originalKey = Bun.env.ALIBABA_TOKEN_PLAN_API_KEY;
const originalCodingKey = Bun.env.ALIBABA_CODING_PLAN_API_KEY;
const originalFetch = global.fetch;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
	} else {
		Bun.env[name] = value;
	}
}

afterEach(() => {
	restoreEnv("ALIBABA_TOKEN_PLAN_API_KEY", originalKey);
	restoreEnv("ALIBABA_CODING_PLAN_API_KEY", originalCodingKey);
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function tokenPlanModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: TOKEN_PLAN_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<"openai-completions">;
}

describe("alibaba-token-plan provider support", () => {
	test("resolves ALIBABA_TOKEN_PLAN_API_KEY from environment", () => {
		Bun.env.ALIBABA_TOKEN_PLAN_API_KEY = "token-plan-test-key";
		expect(getEnvApiKey("alibaba-token-plan")).toBe("token-plan-test-key");
		// Red-team: the sibling coding-plan key must not be satisfied by the token-plan key.
		delete Bun.env.ALIBABA_CODING_PLAN_API_KEY;
		expect(getEnvApiKey("alibaba-coding-plan")).toBeUndefined();
	});

	test("registers built-in descriptor, default model, and env var", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "alibaba-token-plan");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("qwen3.7-max");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("ALIBABA_TOKEN_PLAN_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER["alibaba-token-plan"]).toBe("qwen3.7-max");
	});

	test("registers Alibaba Token Plan in the OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "alibaba-token-plan");
		expect(provider?.name).toBe("Alibaba Token Plan");
		expect(provider?.available).toBe(true);
		expect(typeof loginAlibabaTokenPlan).toBe("function");
	});

	test("model manager options target the token-plan endpoint", async () => {
		const captured: string[] = [];
		global.fetch = vi.fn(async (input: string | URL | Request) => {
			captured.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			return new Response(
				JSON.stringify({ data: EXPECTED_MODEL_IDS.map(id => ({ id, object: "model", owned_by: "system" })) }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const options = alibabaTokenPlanModelManagerOptions({ apiKey: "token-plan-test-key" });
		expect(options.providerId).toBe("alibaba-token-plan");
		expect(options.fetchDynamicModels).toBeDefined();

		await options.fetchDynamicModels?.();
		// The discovery call must hit the token-plan gateway, never the coding-plan dashscope host.
		expect(captured.some(url => url.startsWith(TOKEN_PLAN_BASE_URL))).toBe(true);
		expect(captured.some(url => url.includes("dashscope"))).toBe(false);
	});

	test("models.json seeds the six token-plan chat models correctly", () => {
		const catalog = (modelsJson as Record<string, Record<string, Model<"openai-completions">>>)["alibaba-token-plan"];
		expect(catalog).toBeDefined();
		expect(Object.keys(catalog).sort()).toEqual([...EXPECTED_MODEL_IDS].sort());
		for (const [id, model] of Object.entries(catalog)) {
			expect(model.id).toBe(id);
			expect(model.provider).toBe("alibaba-token-plan");
			expect(model.api).toBe("openai-completions");
			expect(model.baseUrl).toBe(TOKEN_PLAN_BASE_URL);
			// Distinct from the sibling coding-plan provider.
			expect(model.baseUrl).not.toBe(CODING_PLAN_BASE_URL);
			// Compat fix so GLM and other models accept the request (no OpenAI "developer" role).
			expect(model.compat?.supportsDeveloperRole).toBe(false);
		}
	});

	test("detectOpenAICompat applies Alibaba (Qwen) shaping to token-plan models", () => {
		const compat = detectOpenAICompat(tokenPlanModel("qwen3.7-max"));
		// isAlibaba -> single system message + qwen thinking format.
		expect(compat.supportsMultipleSystemMessages).toBe(false);
		expect(compat.thinkingFormat).toBe("qwen");
	});
});
