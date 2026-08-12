import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginSynthetic } from "../src/utils/oauth/synthetic";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("synthetic login", () => {
	it("validates the API key against the models endpoint, not chat completions", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			// Must hit the models endpoint, never the retired chat-completions probe.
			expect(url).toBe("https://api.synthetic.new/openai/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer sk-synthetic-test" });

			// The retired Kimi selector must never appear in any request payload.
			const body = init?.body;
			if (typeof body === "string") {
				expect(body).not.toContain("hf:moonshotai/Kimi-K2.5");
			}

			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const apiKey = await loginSynthetic({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "sk-synthetic-test";
			},
		});

		expect(authUrl).toBe("https://dev.synthetic.new/docs/api/overview");
		expect(authInstructions).toContain("Copy your API key from the Synthetic dashboard");
		expect(promptMessage).toBe("Paste your Synthetic API key");
		expect(promptPlaceholder).toBe("sk-...");
		expect(apiKey).toBe("sk-synthetic-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Regression guard: the request must not target chat/completions at all.
		const calledUrl = String(fetchMock.mock.calls[0][0]);
		expect(calledUrl).not.toContain("chat/completions");
	});

	it("surfaces models endpoint validation errors", async () => {
		global.fetch = vi.fn(
			async () => new Response('{"error":"invalid_api_key"}', { status: 401 }),
		) as unknown as typeof fetch;

		await expect(
			loginSynthetic({
				onPrompt: async () => "sk-synthetic-test",
			}),
		).rejects.toThrow("Synthetic API key validation failed (401)");
	});

	it("rejects empty keys before any network call", async () => {
		const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			loginSynthetic({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("requires the onPrompt callback", async () => {
		await expect(loginSynthetic({})).rejects.toThrow("Synthetic login requires onPrompt callback");
	});
});
