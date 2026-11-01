import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { Context, Model, ServiceTier } from "../src/types";
import {
	getPriorityPremiumRequests,
	isFastModeEffectiveForProvider,
	resolveServiceTier,
	shouldSendServiceTier,
} from "../src/types";

describe("getPriorityPremiumRequests", () => {
	it("counts priority tier as one premium request on OpenAI", () => {
		expect(getPriorityPremiumRequests("priority", "openai")).toBe(1);
	});

	it("counts priority tier as one premium request on OpenAI Codex", () => {
		expect(getPriorityPremiumRequests("priority", "openai-codex")).toBe(1);
	});

	it("counts priority tier as one premium request on DeepInfra", () => {
		expect(getPriorityPremiumRequests("priority", "deepinfra")).toBe(1);
	});

	it("ignores non-priority paid tiers", () => {
		expect(getPriorityPremiumRequests("flex", "openai")).toBe(0);
		expect(getPriorityPremiumRequests("scale", "openai")).toBe(0);
	});

	it("ignores default and auto tiers", () => {
		expect(getPriorityPremiumRequests("default", "openai")).toBe(0);
		expect(getPriorityPremiumRequests("auto", "openai")).toBe(0);
	});

	it("ignores priority tier on providers that drop service_tier", () => {
		// `priority` is realized on `openai`, `OpenAI code provider`, `deepinfra`, and direct
		// `anthropic` (as fast mode). Everywhere else it's silently dropped, so it must not
		// be billed as premium.
		expect(getPriorityPremiumRequests("priority", "github-copilot")).toBe(0);
		expect(getPriorityPremiumRequests("priority", "azure")).toBe(0);
		expect(getPriorityPremiumRequests("priority", "bedrock")).toBe(0);
	});

	it("counts priority on direct Anthropic as one premium request (fast mode)", () => {
		expect(getPriorityPremiumRequests("priority", "anthropic")).toBe(1);
	});

	it("returns zero when service tier is unset", () => {
		expect(getPriorityPremiumRequests(undefined, "openai")).toBe(0);
		expect(getPriorityPremiumRequests(null, "openai")).toBe(0);
	});

	describe("scoped tiers", () => {
		it("treats `openai-only` as priority on OpenAI and OpenAI-Codex", () => {
			expect(getPriorityPremiumRequests("openai-only", "openai")).toBe(1);
			expect(getPriorityPremiumRequests("openai-only", "openai-codex")).toBe(1);
		});

		it("treats `openai-only` as inactive on Anthropic and everywhere else", () => {
			expect(getPriorityPremiumRequests("openai-only", "anthropic")).toBe(0);
			expect(getPriorityPremiumRequests("openai-only", "github-copilot")).toBe(0);
			expect(getPriorityPremiumRequests("openai-only", "bedrock")).toBe(0);
		});

		it("treats `claude-only` as priority on direct Anthropic", () => {
			expect(getPriorityPremiumRequests("claude-only", "anthropic")).toBe(1);
		});

		it("treats `claude-only` as inactive on OpenAI, Bedrock/Vertex, and elsewhere", () => {
			expect(getPriorityPremiumRequests("claude-only", "openai")).toBe(0);
			expect(getPriorityPremiumRequests("claude-only", "openai-codex")).toBe(0);
			expect(getPriorityPremiumRequests("claude-only", "bedrock")).toBe(0);
			expect(getPriorityPremiumRequests("claude-only", "vertex")).toBe(0);
		});
	});
});

describe("resolveServiceTier", () => {
	it("passes unscoped tiers through unchanged for any provider", () => {
		expect(resolveServiceTier("flex", "openai")).toBe("flex");
		expect(resolveServiceTier("priority", "anthropic")).toBe("priority");
		expect(resolveServiceTier("auto", "openai-codex")).toBe("auto");
		expect(resolveServiceTier("default", "github-copilot")).toBe("default");
	});

	it("scopes `openai-only` to OpenAI providers", () => {
		expect(resolveServiceTier("openai-only", "openai")).toBe("priority");
		expect(resolveServiceTier("openai-only", "openai-codex")).toBe("priority");
		expect(resolveServiceTier("openai-only", "anthropic")).toBeUndefined();
		expect(resolveServiceTier("openai-only", "bedrock")).toBeUndefined();
		expect(resolveServiceTier("openai-only", undefined)).toBeUndefined();
	});

	it("scopes `claude-only` to direct Anthropic", () => {
		expect(resolveServiceTier("claude-only", "anthropic")).toBe("priority");
		expect(resolveServiceTier("claude-only", "openai")).toBeUndefined();
		expect(resolveServiceTier("claude-only", "bedrock")).toBeUndefined();
		expect(resolveServiceTier("claude-only", "vertex")).toBeUndefined();
	});

	it("returns undefined for null/undefined input", () => {
		expect(resolveServiceTier(undefined, "openai")).toBeUndefined();
		expect(resolveServiceTier(null, "openai")).toBeUndefined();
	});
});

describe("isFastModeEffectiveForProvider", () => {
	it("matches providers that realize priority on the wire", () => {
		expect(isFastModeEffectiveForProvider("priority", "openai")).toBe(true);
		expect(isFastModeEffectiveForProvider("priority", "openai-codex")).toBe(true);
		expect(isFastModeEffectiveForProvider("priority", "anthropic")).toBe(true);
		expect(isFastModeEffectiveForProvider("priority", "deepinfra")).toBe(true);
	});

	it("rejects providers that silently drop unscoped priority intent", () => {
		expect(isFastModeEffectiveForProvider("priority", "openrouter")).toBe(false);
		expect(isFastModeEffectiveForProvider("priority", "google")).toBe(false);
		expect(isFastModeEffectiveForProvider("priority", "amazon-bedrock")).toBe(false);
		expect(isFastModeEffectiveForProvider("priority", undefined)).toBe(false);
	});

	it("supports explicit custom-provider opt-in", () => {
		expect(isFastModeEffectiveForProvider("priority", "custom-proxy")).toBe(false);
		expect(isFastModeEffectiveForProvider("priority", "custom-proxy", true)).toBe(true);
	});

	it("honors scoped priority tiers", () => {
		expect(isFastModeEffectiveForProvider("openai-only", "openai")).toBe(true);
		expect(isFastModeEffectiveForProvider("openai-only", "anthropic")).toBe(false);
		expect(isFastModeEffectiveForProvider("claude-only", "anthropic")).toBe(true);
		expect(isFastModeEffectiveForProvider("claude-only", "openai")).toBe(false);
	});
});

describe("shouldSendServiceTier", () => {
	it("returns false for providers that do not accept service_tier", () => {
		expect(shouldSendServiceTier("priority", "fireworks")).toBe(false);
		expect(shouldSendServiceTier("flex", "azure-openai-responses")).toBe(false);
		expect(shouldSendServiceTier("scale", "firepass")).toBe(false);
	});

	it("supports explicit custom-provider opt-in", () => {
		expect(shouldSendServiceTier("priority", "custom-proxy")).toBe(false);
		expect(shouldSendServiceTier("priority", "custom-proxy", true)).toBe(true);
	});

	it("returns true for openai with priority/flex/scale tiers", () => {
		expect(shouldSendServiceTier("priority", "openai")).toBe(true);
		expect(shouldSendServiceTier("flex", "openai")).toBe(true);
		expect(shouldSendServiceTier("scale", "openai")).toBe(true);
	});

	it("returns true for openai-codex with priority/flex/scale tiers", () => {
		expect(shouldSendServiceTier("priority", "openai-codex")).toBe(true);
		expect(shouldSendServiceTier("flex", "openai-codex")).toBe(true);
		expect(shouldSendServiceTier("scale", "openai-codex")).toBe(true);
	});

	it("returns true only for DeepInfra priority tier", () => {
		expect(shouldSendServiceTier("priority", "deepinfra")).toBe(true);
		expect(shouldSendServiceTier("flex", "deepinfra")).toBe(false);
		expect(shouldSendServiceTier("scale", "deepinfra")).toBe(false);
	});

	it("returns false for default tier on OpenAI-compatible service-tier providers", () => {
		expect(shouldSendServiceTier("default", "openai")).toBe(false);
		expect(shouldSendServiceTier("default", "openai-codex")).toBe(false);
		expect(shouldSendServiceTier("default", "deepinfra")).toBe(false);
	});

	it("returns false for auto tier on OpenAI-compatible service-tier providers", () => {
		expect(shouldSendServiceTier("auto", "openai")).toBe(false);
		expect(shouldSendServiceTier("auto", "openai-codex")).toBe(false);
		expect(shouldSendServiceTier("auto", "deepinfra")).toBe(false);
	});

	it("returns false for undefined/null tier", () => {
		expect(shouldSendServiceTier(undefined, "openai")).toBe(false);
		expect(shouldSendServiceTier(null, "openai")).toBe(false);
	});
});

const originalFetch = global.fetch;

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

function completionsSseResponse(): Response {
	const payload = [
		{ choices: [{ delta: { content: "ok" }, index: 0 }] },
		{ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
		"[DONE]",
	]
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n");
	return new Response(`${payload}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("DeepInfra service-tier wire behavior", () => {
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	async function captureDeepInfraBody(serviceTier: ServiceTier): Promise<Record<string, unknown>> {
		const model: Model<"openai-completions"> = {
			id: "deepseek-ai/DeepSeek-V3.2",
			name: "DeepSeek-V3.2",
			api: "openai-completions",
			provider: "deepinfra",
			baseUrl: "https://api.deepinfra.com/v1/openai",
			reasoning: true,
			input: ["text"],
			cost: { input: 0.26, output: 0.38, cacheRead: 0.13, cacheWrite: 0 },
			contextWindow: 163840,
			maxTokens: 64000,
		};
		let capturedBody: Record<string, unknown> = {};
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(
				String(init?.body ?? (input instanceof Request ? await input.clone().text() : "{}")),
			) as Record<string, unknown>;
			return completionsSseResponse();
		});
		global.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect }) as typeof fetch;

		const stream = streamOpenAICompletions(model, context, { apiKey: "test-key", serviceTier });
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
		return capturedBody;
	}

	it("forwards priority service_tier to DeepInfra chat completions", async () => {
		const capturedBody = await captureDeepInfraBody("priority");

		expect(capturedBody.model).toBe("deepseek-ai/DeepSeek-V3.2");
		expect(capturedBody.service_tier).toBe("priority");
	});

	it.each(["flex", "scale"] as const)("does not forward %s service_tier to DeepInfra", async serviceTier => {
		const capturedBody = await captureDeepInfraBody(serviceTier);

		expect(capturedBody.model).toBe("deepseek-ai/DeepSeek-V3.2");
		expect(capturedBody).not.toHaveProperty("service_tier");
	});
});
