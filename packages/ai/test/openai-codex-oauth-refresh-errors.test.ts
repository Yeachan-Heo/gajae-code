import { afterEach, describe, expect, it, vi } from "bun:test";
import { refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("refreshOpenAICodexToken error handling", () => {
	it("includes string error message and error_description when present", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: "invalid_grant",
						error_description: "The refresh token has expired",
					}),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(refreshOpenAICodexToken("old-refresh-token")).rejects.toThrow(/invalid_grant.*has expired/);
	});

	it("includes string error message without error_description", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: "invalid_request",
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(refreshOpenAICodexToken("old-refresh-token")).rejects.toThrow(/400.*invalid_request/);
	});

	it("handles object error with message, type, and code fields", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "Refresh token expired",
							type: "invalid_grant_error",
							code: "refresh_token_expired",
						},
					}),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(refreshOpenAICodexToken("old-refresh-token")).rejects.toThrow(
			/401.*refresh_token_expired.*Refresh token expired/,
		);
	});

	it("handles object error with only message field", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "Invalid credentials",
						},
					}),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(refreshOpenAICodexToken("old-refresh-token")).rejects.toThrow(/401.*Invalid credentials/);
	});

	it("falls back to status code when error is null or undefined", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: null,
					}),
					{ status: 503, headers: { "Content-Type": "application/json" } },
				),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(refreshOpenAICodexToken("old-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed: 503/,
		);
	});

	it("handles non-JSON response body gracefully", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("Internal Server Error", {
					status: 500,
					headers: { "Content-Type": "text/plain" },
				}),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(refreshOpenAICodexToken("old-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed: 500/,
		);
	});

	it("never produces [object Object] in error messages for object errors", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							code: "auth_error",
							message: "Authentication failed",
						},
					}),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		try {
			await refreshOpenAICodexToken("old-refresh-token");
			expect.unreachable("should have thrown");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).not.toContain("[object Object]");
			expect(message).toContain("401");
			expect(message).toContain("auth_error");
		}
	});
});
