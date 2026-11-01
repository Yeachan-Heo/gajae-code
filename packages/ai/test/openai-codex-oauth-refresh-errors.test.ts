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

/**
 * Deterministic generator for the response shapes this formatter must survive.
 * Covers string errors, object errors with every code/type/message combination,
 * unsupported primitives, and malformed payloads — the classes a fixed-example
 * test cannot enumerate.
 */
function* generatedErrorBodies(): Generator<{ body: unknown; text?: string; expected: string[] }> {
	const descriptions: unknown[] = [undefined, "", "desc", 0, null, { nested: true }];
	const codes: unknown[] = [undefined, "", "auth_error", 401, null, ["x"]];
	const types: unknown[] = [undefined, "", "invalid_request_error", 42, null];
	const messages: unknown[] = [undefined, "", "boom", 7, null, { nested: true }];
	for (const error of ["invalid_grant", "", "single"]) {
		for (const description of descriptions) {
			const body: Record<string, unknown> = { error };
			if (description !== undefined) body.error_description = description;
			const expected = [error, ...(typeof description === "string" ? [description] : [])].filter(
				part => part.length > 0,
			);
			yield { body, expected };
		}
	}
	for (const code of codes) {
		for (const type of types) {
			for (const message of messages) {
				const error: Record<string, unknown> = {};
				if (code !== undefined) error.code = code;
				if (type !== undefined) error.type = type;
				if (message !== undefined) error.message = message;
				const stringCode = typeof code === "string" ? code : undefined;
				const stringType = typeof type === "string" ? type : undefined;
				const stringMessage = typeof message === "string" ? message : undefined;
				const expected = [
					// code wins over type, and each field is only used when it is a non-empty string
					...(stringCode ? [stringCode] : stringType ? [stringType] : []),
					...(stringMessage ? [stringMessage] : []),
				];
				yield { body: { error }, expected };
			}
		}
	}
	for (const error of [0, false, null, [], {}, [1, 2]]) yield { body: { error }, expected: [] };
	for (const body of [null, "plain text", 42, [1, 2, 3], {}]) yield { body, expected: [] };
	yield { body: undefined, text: "not json at all", expected: [] };
}

describe("refreshOpenAICodexToken error formatting properties", () => {
	it("formats only strings, never coercing objects, and keeps the status", async () => {
		for (const generated of generatedErrorBodies()) {
			const payload = generated.text ?? JSON.stringify(generated.body);
			global.fetch = vi.fn(
				async () => new Response(payload, { status: 401, headers: { "Content-Type": "application/json" } }),
			) as unknown as typeof fetch;

			let message: string | undefined;
			try {
				await refreshOpenAICodexToken("old-refresh-token");
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			const label = `payload=${payload}`;
			expect(message, label).toBeDefined();
			const text = message ?? "";
			expect(text, label).toContain("401");
			expect(text, label).not.toContain("[object Object]");
			expect(text, label).not.toContain("undefined");
			expect(text, label).not.toContain("null");
			for (const fragment of generated.expected) expect(text, `${label} fragment=${fragment}`).toContain(fragment);
			// Nothing beyond the status, the error fields, and the fixed separators.
			const detail = text.split("OpenAI Codex token refresh failed: 401").at(-1) ?? "";
			expect(detail.length, label).toBeLessThanOrEqual(
				generated.expected.reduce((total, fragment) => total + fragment.length + 2, 2),
			);
		}
	});
});
