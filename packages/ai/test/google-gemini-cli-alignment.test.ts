import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@gajae-code/utils";
import * as geminiCliProvider from "../src/providers/google-gemini-cli";
import {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	buildRequest,
	parseGeminiCliCredentials,
	shouldRefreshGeminiCliCredentials,
	streamGoogleGeminiCli,
} from "../src/providers/google-gemini-cli";
import type { Context, Model, TJsonSchema } from "../src/types";
import { classifyFallbackTrigger } from "../src/utils/fallback-transport";
import { getOAuthApiKey } from "../src/utils/oauth";

function createModel(provider: "google-gemini-cli" | "google-antigravity"): Model<"google-gemini-cli"> {
	return {
		id: provider === "google-antigravity" ? "gemini-3-flash" : "gemini-2.5-flash",
		name: provider,
		api: "google-gemini-cli",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "implement token refresh", timestamp: Date.now() }],
	};
}

describe("Google Gemini CLI alignment", () => {
	it("encodes enriched OAuth JSON while preserving token + projectId", async () => {
		const expiresAt = Date.now() + 60 * 60 * 1000;
		const result = await getOAuthApiKey("google-gemini-cli", {
			"google-gemini-cli": {
				access: "access-token",
				refresh: "refresh-token",
				expires: expiresAt,
				projectId: "proj-123",
				email: "dev@example.com",
				accountId: "acct-1",
			},
		});

		expect(result).not.toBeNull();
		const payload = JSON.parse(result!.apiKey) as {
			token?: string;
			projectId?: string;
			refreshToken?: string;
			expiresAt?: number;
			email?: string;
			accountId?: string;
		};
		expect(payload.token).toBe("access-token");
		expect(payload.projectId).toBe("proj-123");
		expect(payload.refreshToken).toBe("refresh-token");
		expect(payload.expiresAt).toBe(expiresAt);
		expect(payload.email).toBe("dev@example.com");
		expect(payload.accountId).toBe("acct-1");
	});

	it("accepts legacy, alias, and enriched OAuth JSON payloads", () => {
		const legacy = parseGeminiCliCredentials(JSON.stringify({ token: "legacy-token", projectId: "proj-legacy" }));
		expect(legacy).toEqual({
			accessToken: "legacy-token",
			projectId: "proj-legacy",
			refreshToken: undefined,
			expiresAt: undefined,
		});

		const aliasPayload = parseGeminiCliCredentials(
			JSON.stringify({
				token: "alias-token",
				project_id: "proj-alias",
				refresh: "refresh-alias",
				expires: 1_737_000_000,
			}),
		);
		expect(aliasPayload).toEqual({
			accessToken: "alias-token",
			projectId: "proj-alias",
			refreshToken: "refresh-alias",
			expiresAt: 1_737_000_000_000,
		});

		const enriched = parseGeminiCliCredentials(
			JSON.stringify({
				token: "enriched-token",
				projectId: "proj-enriched",
				refreshToken: "refresh-token",
				expiresAt: 1_737_000_000_000,
			}),
		);
		expect(enriched).toEqual({
			accessToken: "enriched-token",
			projectId: "proj-enriched",
			refreshToken: "refresh-token",
			expiresAt: 1_737_000_000_000,
		});
	});

	it("avoids excessive antigravity refresh churn with pre-buffered OAuth expiry", () => {
		const issuedAt = 1_700_000_000_000;
		const preBufferedExpiry = issuedAt + 55 * 60 * 1000;

		expect(shouldRefreshGeminiCliCredentials(preBufferedExpiry, true, issuedAt + 10 * 60 * 1000)).toBe(false);
		expect(shouldRefreshGeminiCliCredentials(preBufferedExpiry, true, issuedAt + 54 * 60 * 1000)).toBe(true);
		expect(shouldRefreshGeminiCliCredentials(preBufferedExpiry, false, issuedAt + 54 * 60 * 1000)).toBe(true);
	});

	it("does not export provider-direct refresh helper", () => {
		expect(shouldRefreshGeminiCliCredentials).toBe(geminiCliProvider.shouldRefreshGeminiCliCredentials);
		expect(Object.hasOwn(geminiCliProvider, "refreshGeminiCliCredentialsIfNeeded")).toBe(false);
	});
	it("omits antigravity-only metadata in non-antigravity request payloads", () => {
		const model = createModel("google-gemini-cli");
		const payload = buildRequest(model, createContext(), "proj-123", {}, false) as {
			request: { sessionId?: string };
			requestType?: string;
			userAgent?: string;
			requestId?: string;
		};

		expect(payload.request.sessionId).toBeUndefined();
		expect(payload.requestType).toBeUndefined();
		expect(payload.userAgent).toBeUndefined();
		expect(payload.requestId).toBeUndefined();
	});
	it("keeps every system prompt block in systemInstruction instead of conversation contents", () => {
		const model = createModel("google-gemini-cli");
		const context: Context = {
			systemPrompt: ["primary instruction", "", "supplemental \uD800instruction"],
			messages: [{ role: "user", content: "implement token refresh", timestamp: Date.now() }],
		};
		const payload = buildRequest(model, context, "proj-123", {}, false) as {
			request: {
				contents: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
				systemInstruction?: { role?: string; parts: Array<{ text: string }> };
			};
		};

		expect(payload.request.systemInstruction).toEqual({
			parts: [{ text: "primary instruction" }, { text: "supplemental �instruction" }],
		});
		expect(payload.request.systemInstruction?.role).toBeUndefined();
		expect(payload.request.contents).toEqual([{ role: "user", parts: [{ text: "implement token refresh" }] }]);
	});

	it("keeps antigravity metadata in antigravity request payloads", () => {
		const model = createModel("google-antigravity");
		const payload = buildRequest(model, createContext(), "proj-123", {}, true) as {
			request: { sessionId?: string };
			requestType?: string;
			userAgent?: string;
			requestId?: string;
		};

		expect(payload.request.sessionId).toMatch(/^-[0-9]+$/);
		expect(payload.requestType).toBe("agent");
		expect(payload.userAgent).toBe("antigravity");
		expect(payload.requestId).toMatch(/^agent-/);
	});

	it("strips patternProperties when antigravity rewrites tools to legacy parameters", () => {
		const model = createModel("google-antigravity");
		const toolContext: Context = {
			messages: [{ role: "user", content: "rewrite files", timestamp: Date.now() }],
			tools: [
				{
					name: "rewrite_rules",
					description: "Map rewrite regex to replacement",
					parameters: {
						type: "object",
						properties: {
							rules: {
								type: "object",
								patternProperties: {
									"^(.*)$": { type: "string" },
								},
							},
						},
						required: ["rules"],
					} as TJsonSchema,
				},
			],
		};
		const payload = buildRequest(model, toolContext, "proj-123", {}, true) as {
			request: { tools?: Array<{ functionDeclarations: Array<{ parameters?: unknown }> }> };
		};

		const parameters = payload.request.tools?.[0]?.functionDeclarations[0]?.parameters;
		expect(parameters).toBeDefined();
		expect(JSON.stringify(parameters)).not.toContain('"patternProperties"');
	});
	it("injects ANTIGRAVITY_SYSTEM_INSTRUCTION for gemini-3.1-pro-high and gemini-3.1-pro-low", () => {
		// Regression test for #1274: shouldInjectAntigravitySystemInstruction checked
		// "gemini-3-pro-high" (hyphen) but the deployed model IDs use "gemini-3.1-pro-high" (dot),
		// so the injection was silently skipped and the Cloud Code Assist API returned HTTP 400.
		for (const modelId of ["gemini-3.1-pro-high", "gemini-3.1-pro-low"] as const) {
			const model: Model<"google-gemini-cli"> = {
				...createModel("google-antigravity"),
				id: modelId,
			};
			const context: Context = {
				systemPrompt: ["my instructions"],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const payload = buildRequest(model, context, "proj-123", {}, true) as {
				request: { systemInstruction?: { role?: string; parts: Array<{ text: string }> } };
			};

			const parts = payload.request.systemInstruction?.parts ?? [];
			// The antigravity identity header must be injected as the first part.
			expect(parts[0]?.text).toBe(ANTIGRAVITY_SYSTEM_INSTRUCTION);
			// The user-supplied system prompt must appear after the injected parts.
			expect(parts.some(p => p.text === "my instructions")).toBe(true);
		}
	});
	it("adds anthropic-beta for Antigravity Claude reasoning models without relying on id suffix", async () => {
		let requestHeaders: Headers | undefined;
		using _hook = hookFetch(async (_url, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response('{"error":{"message":"bad request"}}', { status: 400 });
		});

		const model: Model<"google-gemini-cli"> = {
			...createModel("google-antigravity"),
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			reasoning: true,
		};

		const result = await streamGoogleGeminiCli(model, createContext(), {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requestHeaders).toBeDefined();
		expect(requestHeaders!.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
		expect(requestHeaders!.get("X-Goog-Api-Client")).toBeNull();
		expect(requestHeaders!.get("Client-Metadata")).toBeNull();
	});

	describe("retry guardrails", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("does not treat explicit HTTP failures as network retry errors", async () => {
			let fetchCalls = 0;
			using _hook = hookFetch(async () => {
				fetchCalls += 1;
				return new Response('{"error":{"code":"server_error","message":"busy"}}', {
					status: 503,
					headers: { "retry-after": "120" },
				});
			});

			const model = createModel("google-gemini-cli");
			const stream = streamGoogleGeminiCli(model, createContext(), {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				maxRetryDelayMs: 1000,
			});

			const result = await stream.result();
			expect(fetchCalls).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Cloud Code Assist API error (503)");
			expect(result.transportFailure).toMatchObject({
				kind: "transport",
				status: 503,
				providerCode: "server_error",
			});
			expect(result.transportFailure?.headers).toEqual({ "retry-after": "120" });
			expect(classifyFallbackTrigger(result.transportFailure)).toEqual({ class: "server", retryAfterMs: 120_000 });
		});

		it("does not attach transport facts to non-transport errors", async () => {
			const result = await streamGoogleGeminiCli(createModel("google-gemini-cli"), createContext(), {}).result();

			expect(result.stopReason).toBe("error");
			expect(result.transportFailure).toBeUndefined();
		});
	});
});
