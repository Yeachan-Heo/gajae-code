import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginMara } from "../src/utils/oauth/mara";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("mara login", () => {
	it("opens Mara Cloud key settings and validates against models endpoint", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://api.cloud.mara.com/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer mara-test-key" });
			return new Response(JSON.stringify({ data: [] }), {
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

	it("surfaces models endpoint validation errors", async () => {
		global.fetch = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

		await expect(
			loginMara({
				onPrompt: async () => "mara-test-key",
			}),
		).rejects.toThrow("Mara Cloud API key validation failed (401)");
	});
});
