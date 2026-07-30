import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginMara } from "../src/utils/oauth/mara";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("mara login", () => {
	it("opens Mara Cloud key settings and validates against chat completions", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://api.cloud.mara.com/v1/chat/completions");
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({
				"Content-Type": "application/json",
				Authorization: "Bearer mara-test-key",
			});
			expect(JSON.parse(String(init?.body))).toEqual({
				model: "DeepSeek-V3.1",
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				temperature: 0,
			});
			return new Response(JSON.stringify({ choices: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
		global.fetch = fetchMock;

		const apiKey = await loginMara({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async info => {
				promptMessage = info.message;
				promptPlaceholder = info.placeholder;
				return "mara-test-key";
			},
		});

		expect(authUrl).toBe("https://cloud.mara.com/apis");
		expect(authInstructions).toContain("Create or copy your Mara Cloud API key");
		expect(promptMessage).toBe("Paste your Mara Cloud API key");
		expect(promptPlaceholder).toBe("<your-mara-api-key>");
		expect(apiKey).toBe("mara-test-key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects an empty API key", async () => {
		await expect(
			loginMara({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginMara({})).rejects.toThrow("Mara Cloud login requires onPrompt callback");
	});

	it("surfaces chat completions validation errors", async () => {
		global.fetch = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

		await expect(
			loginMara({
				onPrompt: async () => "mara-test-key",
			}),
		).rejects.toThrow("Mara Cloud API key validation failed (401)");
	});
});
