import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildAnthropicClientOptions, streamAnthropic } from "../src/providers/anthropic";
import type { Context, Model } from "../src/types";
import { buildAnthropicUrl } from "../src/utils/anthropic-auth";
import { OPENCODE_HEADERS } from "../src/utils/oauth/github-copilot";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function makeCopilotClaudeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		headers: { ...OPENCODE_HEADERS },
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function getRequestHeaders(input: string | URL | Request, init: RequestInit | undefined): Headers {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	new Headers(init?.headers).forEach((value, key) => {
		headers.set(key, value);
	});
	return headers;
}

describe("Anthropic Copilot auth config", () => {
	it("uses apiKey: null and Authorization Bearer for Copilot models", () => {
		const model = makeCopilotClaudeModel();
		const token = "ghu_test_token_12345";
		const options = buildAnthropicClientOptions({
			model,
			apiKey: token,
			extraBetas: ["interleaved-thinking-2025-05-14"],
			stream: true,
			dynamicHeaders: {
				"X-Initiator": "user",
				"Openai-Intent": "conversation-edits",
			},
		});

		expect(options.apiKey).toBeNull();
		expect(new Headers(options.defaultHeaders).get("authorization")).toBe(`Bearer ${token}`);
	});

	it("unwraps structured Copilot credentials before setting Authorization", () => {
		const model = makeCopilotClaudeModel();
		const options = buildAnthropicClientOptions({
			model,
			apiKey: JSON.stringify({ token: "ghu_test_token_12345", enterpriseUrl: "ghe.example.com" }),
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(options.apiKey).toBeNull();
		expect(new Headers(options.defaultHeaders).get("authorization")).toBe("Bearer ghu_test_token_12345");
	});

	it("uses model baseUrl directly (no proxy-ep extraction)", () => {
		const model = makeCopilotClaudeModel();
		const token = "ghu_test_token_12345";
		const options = buildAnthropicClientOptions({
			model,
			apiKey: token,
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(options.baseURL).toBe("https://api.githubcopilot.com");
	});

	it("routes structured enterprise credentials to the enterprise baseUrl", () => {
		const model = makeCopilotClaudeModel();
		const options = buildAnthropicClientOptions({
			model,
			apiKey: JSON.stringify({ token: "ghu_test_token_12345", enterpriseUrl: "ghe.example.com" }),
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(options.baseURL).toBe("https://copilot-api.ghe.example.com");
	});
	it("includes Copilot static headers from model.headers", () => {
		const model = makeCopilotClaudeModel();
		const options = buildAnthropicClientOptions({
			model,
			apiKey: "ghu_test",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(new Headers(options.defaultHeaders).get("user-agent")).toContain("opencode");
	});

	it("includes interleaved-thinking beta header when enabled", () => {
		const model = makeCopilotClaudeModel();
		const options = buildAnthropicClientOptions({
			model,
			apiKey: "ghu_test",
			extraBetas: ["interleaved-thinking-2025-05-14"],
			stream: true,
			dynamicHeaders: {},
		});

		const beta = new Headers(options.defaultHeaders).get("anthropic-beta");
		expect(beta).not.toBeNull();
		expect(beta).toContain("interleaved-thinking-2025-05-14");
	});

	it("does not include fine-grained-tool-streaming beta for Copilot", () => {
		const model = makeCopilotClaudeModel();
		const options = buildAnthropicClientOptions({
			model,
			apiKey: "ghu_test",
			extraBetas: ["interleaved-thinking-2025-05-14"],
			stream: true,
			dynamicHeaders: {},
		});

		const beta = new Headers(options.defaultHeaders).get("anthropic-beta");
		expect(beta).not.toBeNull();
		expect(beta).not.toContain("fine-grained-tool-streaming");
	});

	it("does not set isOAuthToken for Copilot models", () => {
		const model = makeCopilotClaudeModel();
		const result = buildAnthropicClientOptions({
			model,
			apiKey: "ghu_test",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(result.isOAuthToken).toBe(false);
	});

	it("normalizes trailing /v1 in anthropic base URLs", () => {
		const model = {
			...makeCopilotClaudeModel(),
			provider: "custom-proxy",
			baseUrl: "http://127.0.0.1:8317/v1",
		};
		const result = buildAnthropicClientOptions({
			model,
			apiKey: "test-key",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		expect(result.baseURL).toBe("http://127.0.0.1:8317");
	});

	it("builds anthropic auth URLs from the normalized service root", () => {
		const url = buildAnthropicUrl({
			apiKey: "test-key",
			baseUrl: "http://127.0.0.1:8317/v1",
			isOAuth: false,
		});

		expect(url).toBe("http://127.0.0.1:8317/v1/messages?beta=true");
	});

	it("forwards auth, static, beta, and initiator headers to Copilot message requests", async () => {
		const requests: Headers[] = [];
		global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push(getRequestHeaders(input, init));
			return new Response(JSON.stringify({ error: { type: "authentication_error", message: "Unauthorized" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const model = makeCopilotClaudeModel();
		const result = await streamAnthropic(model, testContext, {
			apiKey: "ghu_test_copilot_token",
			betas: ["interleaved-thinking-2025-05-14"],
			initiatorOverride: "agent",
		}).result();

		const headers = requests[0];
		expect(result.stopReason).toBe("error");
		expect(headers?.get("authorization")).toBe("Bearer ghu_test_copilot_token");
		expect(headers?.get("user-agent")).toContain("opencode");
		expect(headers?.get("anthropic-beta")).toContain("interleaved-thinking-2025-05-14");
		expect(headers?.get("x-initiator")).toBe("agent");
		expect(headers?.has("x-api-key")).toBe(false);
	});
});
