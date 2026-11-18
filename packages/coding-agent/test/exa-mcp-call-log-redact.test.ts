import { afterEach, describe, expect, it, vi } from "bun:test";
import { logger } from "@gajae-code/utils";
import fc from "fast-check";
import { callExaTool, callWebsetsTool } from "../src/exa/mcp-client";

const TOKEN = "sk-synthetictoolargsecret";
const SHORT_SECRET = "short-password";
const ORDINARY_QUERY = "rust ownership model";

function jsonRpcError(message: string, data?: unknown): Response {
	const error: Record<string, unknown> = { code: -32000, message };
	if (data !== undefined) error.data = data;
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function nested(depth: number, leaf: unknown): unknown {
	let value = leaf;
	for (let i = 0; i < depth; i++) value = [value];
	return value;
}

function stubFailure(message: string, data?: unknown) {
	const fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation((() => Promise.resolve(jsonRpcError(message, data))) as unknown as typeof fetch);
	const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
	return { fetchSpy, errorSpy };
}

function loggedContext(errorSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
	return errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MCP tools/call error logs", () => {
	it("drops credential material from the Exa tools/call error log", async () => {
		const args = {
			query: TOKEN,
			nested: { api_key: SHORT_SECRET, note: "ordinary note" },
		};
		const { fetchSpy, errorSpy } = stubFailure(`failed ${TOKEN}`);

		await expect(callExaTool("web_search", args, null)).rejects.toThrow(`MCP error: failed ${TOKEN}`);

		const body = String(fetchSpy.mock.calls[0]?.[1]?.body);
		expect(body).toContain(TOKEN);
		expect(body).toContain(SHORT_SECRET);
		expect(args.query).toBe(TOKEN);
		expect(errorSpy.mock.calls).toHaveLength(1);
		expect(errorSpy.mock.calls[0]?.[0]).toBe("MCP tools/call error");
		const metadata = loggedContext(errorSpy);
		expect(JSON.stringify(metadata)).not.toContain(TOKEN);
		expect(JSON.stringify(metadata)).not.toContain(SHORT_SECRET);
		expect(metadata).toEqual({
			toolName: "web_search",
			args: { query: "«redacted-api-key»", nested: { api_key: "«redacted»", note: "ordinary note" } },
			error: { code: -32000, message: "failed «redacted-api-key»" },
		});
	});

	it("drops credential material from the Websets tools/call error log", async () => {
		const args = { query: TOKEN, api_key: SHORT_SECRET };
		const { fetchSpy, errorSpy } = stubFailure(`failed ${TOKEN}`);

		await expect(callWebsetsTool("exa-account-marker", "websets_search", args)).rejects.toThrow(
			`MCP error: failed ${TOKEN}`,
		);

		const body = String(fetchSpy.mock.calls[0]?.[1]?.body);
		expect(body).toContain(TOKEN);
		expect(body).toContain(SHORT_SECRET);
		expect(errorSpy.mock.calls[0]?.[0]).toBe("Websets MCP tools/call error");
		const metadata = loggedContext(errorSpy);
		expect(JSON.stringify(metadata)).not.toContain(TOKEN);
		expect(JSON.stringify(metadata)).not.toContain(SHORT_SECRET);
		expect(metadata.args).toEqual({ query: "«redacted-api-key»", api_key: "«redacted»" });
	});

	it("keeps ordinary Exa tools/call arguments in the error log and on the request", async () => {
		const args = { query: ORDINARY_QUERY, limit: 3 };
		const { fetchSpy, errorSpy } = stubFailure("rate limit");

		await expect(callExaTool("web_search", args, null)).rejects.toThrow("MCP error: rate limit");

		const body = String(fetchSpy.mock.calls[0]?.[1]?.body);
		expect(body).toContain(ORDINARY_QUERY);
		expect(loggedContext(errorSpy)).toEqual({
			toolName: "web_search",
			args: { query: ORDINARY_QUERY, limit: 3 },
			error: { code: -32000, message: "rate limit" },
		});
	});

	it("keeps ordinary Websets tools/call arguments in the error log and on the request", async () => {
		const args = { query: ORDINARY_QUERY, limit: 2 };
		const { fetchSpy, errorSpy } = stubFailure("rate limit");

		await expect(callWebsetsTool("exa-account-marker", "websets_search", args)).rejects.toThrow(
			"MCP error: rate limit",
		);

		const body = String(fetchSpy.mock.calls[0]?.[1]?.body);
		expect(body).toContain(ORDINARY_QUERY);
		expect(errorSpy.mock.calls[0]?.[0]).toBe("Websets MCP tools/call error");
		expect(loggedContext(errorSpy).args).toEqual({ query: ORDINARY_QUERY, limit: 2 });
	});

	it("keeps the server message when a tools/call error payload is deeply nested", async () => {
		const message = "expected server message";
		for (const depth of [64, 25_000]) {
			vi.restoreAllMocks();
			const data = nested(depth, { note: "leaf" });
			const args = { payload: nested(depth, { note: "leaf" }) };
			const { errorSpy } = stubFailure(message, data);
			await expect(callExaTool("web_search", args, null)).rejects.toThrow(`MCP error: ${message}`);
			expect(errorSpy.mock.calls).toHaveLength(1);
			expect(errorSpy.mock.calls[0]?.[0]).toBe("MCP tools/call error");
			await expect(callWebsetsTool("exa-account-marker", "websets_search", args)).rejects.toThrow(
				`MCP error: ${message}`,
			);
			expect(errorSpy.mock.calls).toHaveLength(2);
			expect(errorSpy.mock.calls[1]?.[0]).toBe("Websets MCP tools/call error");
		}
	});

	it("keeps ordinary tools/call argument text across generated inputs", async () => {
		await fc.assert(
			fc.asyncProperty(fc.stringMatching(/^[a-z][a-z ]{0,24}$/), async query => {
				vi.restoreAllMocks();
				const { fetchSpy, errorSpy } = stubFailure("rate limit");
				const args = { query };
				await expect(callExaTool("web_search", args, null)).rejects.toThrow("MCP error: rate limit");
				expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain(query);
				expect(loggedContext(errorSpy).args).toEqual({ query });
			}),
			{ seed: 128148, numRuns: 64 },
		);
	});

	it("drops api-key shaped tools/call argument text from the error log", async () => {
		await fc.assert(
			fc.asyncProperty(fc.stringMatching(/^[A-Za-z0-9]{8,16}$/), async suffix => {
				vi.restoreAllMocks();
				const token = `sk-${suffix}`;
				const { fetchSpy, errorSpy } = stubFailure("rate limit");
				await expect(callExaTool("web_search", { query: token }, null)).rejects.toThrow("MCP error: rate limit");
				expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain(token);
				expect(JSON.stringify(loggedContext(errorSpy))).not.toContain(token);
			}),
			{ seed: 128148, numRuns: 64 },
		);
	});
});
