import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "../src/model-manager";
import { getBundledModel, getBundledModels } from "../src/models";
import { githubCopilotModelManagerOptions } from "../src/provider-models/openai-compat";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { streamOpenAIResponses } from "../src/providers/openai-responses";
import type { Model } from "../src/types";
import { createSseResponse, testContext } from "./openai-tool-choice-test-helpers";

const originalFetch = global.fetch;

const usage = {
	input_tokens: 5,
	output_tokens: 1,
	total_tokens: 6,
	input_tokens_details: { cached_tokens: 0 },
};

function completedResponseEvents(serviceTier?: string): unknown[] {
	return [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage,
				...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
			},
		},
	];
}

function completionsResponseEvents(serviceTier?: string, modelId = "gpt-6-astra"): unknown[] {
	const reportedTier = serviceTier === undefined ? {} : { service_tier: serviceTier };
	return [
		{
			id: "chatcmpl_1",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			...reportedTier,
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		},
		{
			id: "chatcmpl_1",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			...reportedTier,
			choices: [],
			usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
		},
		"[DONE]",
	];
}

function captureRequests(events: unknown[]): Record<string, unknown>[] {
	const bodies: Record<string, unknown>[] = [];
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		bodies.push(typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {});
		return createSseResponse(events);
	});
	global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;
	return bodies;
}

function codexTestToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("ultrafast request serialization for bundled models", () => {
	it("sends ultrafast for an opted-in GitHub Copilot Completions model", async () => {
		const model = getBundledModel("github-copilot", "gpt-6-astra") as Model<"openai-completions">;
		expect(model.compat).toMatchObject({ supportsUltrafastTier: true });
		expect(model.compat?.supportsServiceTier).toBeUndefined();
		const bodies = captureRequests([
			{
				id: "chatcmpl_1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "ghu_test_copilot_token",
			serviceTier: "ultrafast",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies[0]?.service_tier).toBe("ultrafast");
	});

	it("retains ultrafast through authenticated Copilot discovery and serializes it for both GPT-6 models", async () => {
		const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ultrafast-refresh-"));
		const modelIds = ["gpt-6-astra", "gpt-6.1-sol"];
		try {
			const discoveryFetch = vi.fn(async (_input: string | URL | Request) =>
				Response.json({
					data: modelIds.map(id => ({ id, name: id, context_length: 1_050_000, max_completion_tokens: 128_000 })),
				}),
			);
			global.fetch = Object.assign(discoveryFetch, { preconnect: originalFetch.preconnect }) as typeof fetch;

			const result = await resolveProviderModels(
				{
					...githubCopilotModelManagerOptions({ apiKey: "ghu_test_copilot_token" }),
					staticModels: getBundledModels("github-copilot"),
					cacheDbPath: path.join(cacheDir, "models.db"),
				},
				"online",
			);
			expect(discoveryFetch).toHaveBeenCalledTimes(1);

			for (const modelId of modelIds) {
				const model = result.models.find(candidate => candidate.id === modelId);
				if (!model) throw new Error(`expected refreshed Copilot model ${modelId}`);
				expect(model.compat).toMatchObject({ supportsUltrafastTier: true });
				expect(
					model.compat && "supportsServiceTier" in model.compat ? model.compat.supportsServiceTier : undefined,
				).toBeUndefined();

				const bodies = captureRequests(completionsResponseEvents(undefined, modelId));
				const response = await streamOpenAICompletions(model as Model<"openai-completions">, testContext, {
					apiKey: "ghu_test_copilot_token",
					serviceTier: "ultrafast",
				}).result();
				expect(response.stopReason).toBe("stop");
				expect(bodies[0]?.service_tier).toBe("ultrafast");
			}
		} finally {
			fs.rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	it("keeps GitHub Copilot fail-closed for existing service tiers", async () => {
		const model = getBundledModel("github-copilot", "gpt-6-astra") as Model<"openai-completions">;
		for (const serviceTier of ["priority", "flex", "scale"] as const) {
			const bodies = captureRequests(completionsResponseEvents());
			const result = await streamOpenAICompletions(model, testContext, {
				apiKey: "ghu_test_copilot_token",
				serviceTier,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(bodies[0]?.service_tier).toBeUndefined();
		}
	});

	it("sends ultrafast for an opted-in OpenCode Zen Responses model", async () => {
		const model = getBundledModel("opencode-zen", "gpt-6.1-sol") as Model<"openai-responses">;
		expect(model.compat).toMatchObject({ supportsUltrafastTier: true });
		expect(model.compat?.supportsServiceTier).toBeUndefined();
		const bodies = captureRequests(completedResponseEvents());

		const result = await streamOpenAIResponses(model, testContext, {
			apiKey: "test-key",
			serviceTier: "ultrafast",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies[0]?.service_tier).toBe("ultrafast");
	});

	it("sends ultrafast through the shared Responses mapper for OpenAI API-key models", async () => {
		const model = getBundledModel("openai", "gpt-6-astra") as Model<"openai-responses">;
		expect(model.compat).toMatchObject({ supportsUltrafastTier: true });
		const bodies = captureRequests(completedResponseEvents());

		const result = await streamOpenAIResponses(model, testContext, {
			apiKey: "test-openai-api-key",
			serviceTier: "ultrafast",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies[0]?.service_tier).toBe("ultrafast");
	});

	it("sends ultrafast to an explicitly opted-in custom model without enabling other tiers", async () => {
		const model: Model<"openai-completions"> = {
			id: "custom-gpt-6-astra",
			name: "Custom GPT-6 Astra",
			api: "openai-completions",
			provider: "custom-proxy",
			baseUrl: "https://proxy.example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
			compat: { supportsUltrafastTier: true },
		};
		const bodies = captureRequests(completionsResponseEvents());

		const result = await streamOpenAICompletions(model, testContext, {
			apiKey: "proxy-key",
			serviceTier: "ultrafast",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies[0]?.service_tier).toBe("ultrafast");
	});

	it("prices Responses usage using its effective tier and falls back when the response omits it", async () => {
		const model = getBundledModel("opencode-zen", "gpt-6.1-sol") as Model<"openai-responses">;
		const scenarios = [
			{ requestedTier: "ultrafast", responseTier: "default", effectiveTier: "default", expectedCost: 0.00002 },
			{ requestedTier: "priority", responseTier: "ultrafast", effectiveTier: "ultrafast", expectedCost: 0.00012 },
			{
				requestedTier: "ultrafast",
				responseTier: undefined,
				effectiveTier: "ultrafast",
				expectedCost: 0.00012,
			},
		] as const;

		for (const scenario of scenarios) {
			const bodies = captureRequests(completedResponseEvents(scenario.responseTier));
			const result = await streamOpenAIResponses(model, testContext, {
				apiKey: "test-key",
				serviceTier: scenario.requestedTier,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(bodies[0]?.service_tier).toBe(scenario.requestedTier === "ultrafast" ? "ultrafast" : undefined);
			expect(result.serviceTier).toBe(scenario.effectiveTier);
			expect(result.usage.cost.total).toBeCloseTo(scenario.expectedCost, 12);
			expect(result.usage.cost.total).toBe(
				result.usage.cost.input +
					result.usage.cost.output +
					result.usage.cost.cacheRead +
					result.usage.cost.cacheWrite,
			);
		}
	});

	it("prices Completions usage using its effective tier and falls back when the response omits it", async () => {
		const model = getBundledModel("github-copilot", "gpt-6-astra") as Model<"openai-completions">;
		const scenarios = [
			{ requestedTier: "ultrafast", responseTier: "default", effectiveTier: "default", expectedCost: 0.0001 },
			{ requestedTier: "priority", responseTier: "ultrafast", effectiveTier: "ultrafast", expectedCost: 0.0006 },
			{
				requestedTier: "ultrafast",
				responseTier: undefined,
				effectiveTier: "ultrafast",
				expectedCost: 0.0006,
			},
		] as const;

		for (const scenario of scenarios) {
			const bodies = captureRequests(completionsResponseEvents(scenario.responseTier));
			const result = await streamOpenAICompletions(model, testContext, {
				apiKey: "ghu_test_copilot_token",
				serviceTier: scenario.requestedTier,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(bodies[0]?.service_tier).toBe(scenario.requestedTier === "ultrafast" ? "ultrafast" : undefined);
			expect(result.serviceTier).toBe(scenario.effectiveTier);
			expect(result.usage.cost.total).toBeCloseTo(scenario.expectedCost, 12);
			expect(result.usage.cost.total).toBe(
				result.usage.cost.input +
					result.usage.cost.output +
					result.usage.cost.cacheRead +
					result.usage.cost.cacheWrite,
			);
		}
	});

	it("sends ultrafast and applies Codex included-usage multipliers", async () => {
		const catalogModel = getBundledModel("openai-codex", "gpt-6-astra") as Model<"openai-codex-responses">;
		expect(catalogModel.compat?.supportsUltrafastTier).toBe(true);
		const model = { ...catalogModel, preferWebsockets: false };
		const standardBodies = captureRequests(completedResponseEvents());
		const standardResult = await streamOpenAICodexResponses(model, testContext, {
			apiKey: codexTestToken(),
			serviceTier: "default",
		}).result();

		const priorityBodies = captureRequests(completedResponseEvents());
		const priorityResult = await streamOpenAICodexResponses(model, testContext, {
			apiKey: codexTestToken(),
			serviceTier: "priority",
		}).result();

		const ultrafastBodies = captureRequests(completedResponseEvents());

		const ultrafastResult = await streamOpenAICodexResponses(model, testContext, {
			apiKey: codexTestToken(),
			serviceTier: "ultrafast",
		}).result();

		expect(standardResult.stopReason).toBe("stop");
		expect(priorityResult.stopReason).toBe("stop");
		expect(ultrafastResult.stopReason).toBe("stop");
		expect(standardBodies[0]?.service_tier).toBeUndefined();
		expect(priorityBodies[0]?.service_tier).toBe("priority");
		expect(ultrafastBodies[0]?.service_tier).toBe("ultrafast");
		expect(priorityResult.serviceTier).toBe("priority");
		expect(ultrafastResult.serviceTier).toBe("ultrafast");
		expect(priorityResult.usage.cost.total).toBeCloseTo(standardResult.usage.cost.total * 2.5, 12);
		expect(ultrafastResult.usage.cost.input).toBeCloseTo(standardResult.usage.cost.input * 8, 12);
		expect(ultrafastResult.usage.cost.output).toBeCloseTo(standardResult.usage.cost.output * 8, 12);
		expect(ultrafastResult.usage.cost.cacheRead).toBeCloseTo(standardResult.usage.cost.cacheRead * 8, 12);
		expect(ultrafastResult.usage.cost.cacheWrite).toBeCloseTo(standardResult.usage.cost.cacheWrite * 8, 12);
		expect(ultrafastResult.usage.cost.total).toBeCloseTo(standardResult.usage.cost.total * 8, 12);
		expect(ultrafastResult.usage.cost.total).toBe(
			ultrafastResult.usage.cost.input +
				ultrafastResult.usage.cost.output +
				ultrafastResult.usage.cost.cacheRead +
				ultrafastResult.usage.cost.cacheWrite,
		);
	});

	it("omits ultrafast for the Fast-only bundled Codex gpt-5.6-sol model", async () => {
		const catalogModel = getBundledModel("openai-codex", "gpt-5.6-sol") as Model<"openai-codex-responses">;
		expect(catalogModel.compat?.supportsUltrafastTier).not.toBe(true);
		const model = { ...catalogModel, preferWebsockets: false };
		const bodies = captureRequests(completedResponseEvents());

		const result = await streamOpenAICodexResponses(model, testContext, {
			apiKey: codexTestToken(),
			serviceTier: "ultrafast",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies[0]?.service_tier).toBeUndefined();
		expect(result.serviceTier).toBeUndefined();
	});
});
