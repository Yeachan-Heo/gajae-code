import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginOpenGateway } from "../src/utils/oauth/opengateway";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("opengateway login", () => {
	it("opens OpenGateway dashboard and validates against models endpoint", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://apis.opengateway.ai/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer sk-opengateway-test" });
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const apiKey = await loginOpenGateway({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "sk-opengateway-test";
			},
		});

		expect(authUrl).toBe("https://opengateway.ai/dashboard");
		expect(authInstructions).toContain("Create or copy your OpenGateway API key");
		expect(promptMessage).toBe("Paste your OpenGateway API key");
		expect(promptPlaceholder).toBe("sk-...");
		expect(apiKey).toBe("sk-opengateway-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects empty keys", async () => {
		await expect(
			loginOpenGateway({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginOpenGateway({})).rejects.toThrow("OpenGateway by Sionic AI login requires onPrompt callback");
	});

	it("surfaces models endpoint validation errors", async () => {
		global.fetch = vi.fn(
			async () => new Response('{"error":"invalid_api_key"}', { status: 401 }),
		) as unknown as typeof fetch;

		await expect(
			loginOpenGateway({
				onPrompt: async () => "sk-opengateway-test",
			}),
		).rejects.toThrow("OpenGateway by Sionic AI API key validation failed (401)");
	});
});
