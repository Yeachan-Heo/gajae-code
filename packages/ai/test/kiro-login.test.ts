import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginKiro, resolveKiroModelsUrl } from "../src/utils/oauth/kiro";

const originalFetch = global.fetch;
const originalKiroBaseUrl = Bun.env.KIRO_BASE_URL;

afterEach(() => {
	if (originalKiroBaseUrl === undefined) {
		delete Bun.env.KIRO_BASE_URL;
	} else {
		Bun.env.KIRO_BASE_URL = originalKiroBaseUrl;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("kiro relay models endpoint", () => {
	it("defaults to the relay's documented local port", () => {
		delete Bun.env.KIRO_BASE_URL;
		expect(resolveKiroModelsUrl()).toBe("http://127.0.0.1:8080/v1/models");
	});

	it("appends the API version when the configured base URL omits it", () => {
		expect(resolveKiroModelsUrl("http://127.0.0.1:8317")).toBe("http://127.0.0.1:8317/v1/models");
	});

	it("keeps an explicit API version and drops trailing slashes", () => {
		expect(resolveKiroModelsUrl("http://127.0.0.1:8317/v1//")).toBe("http://127.0.0.1:8317/v1/models");
	});

	it("resolves the relay from KIRO_BASE_URL", () => {
		Bun.env.KIRO_BASE_URL = "http://relay.internal:9000/v1";
		expect(resolveKiroModelsUrl()).toBe("http://relay.internal:9000/v1/models");
	});
});

describe("kiro login", () => {
	it("validates the pasted key against the configured relay", async () => {
		Bun.env.KIRO_BASE_URL = "http://127.0.0.1:8317/v1";
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("http://127.0.0.1:8317/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer kiro-relay-test" });
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const apiKey = await loginKiro({
			onAuth: info => {
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "  kiro-relay-test  ";
			},
		});

		expect(authInstructions).toContain("http://127.0.0.1:8317/v1/models");
		expect(promptMessage).toBe("Paste your Kiro relay API key");
		expect(promptPlaceholder).toContain("ksk-");
		expect(apiKey).toBe("kiro-relay-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects empty keys", async () => {
		await expect(loginKiro({ onPrompt: async () => "   " })).rejects.toThrow("API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginKiro({})).rejects.toThrow("Kiro login requires onPrompt callback");
	});

	it("surfaces relay rejections", async () => {
		global.fetch = vi.fn(
			async () => new Response('{"error":{"message":"Invalid or missing API key"}}', { status: 401 }),
		) as unknown as typeof fetch;

		await expect(loginKiro({ onPrompt: async () => "kiro-relay-test" })).rejects.toThrow(
			"Kiro API key validation failed (401)",
		);
	});
});
