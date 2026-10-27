import { afterEach, describe, expect, it, vi } from "bun:test";
import { logger } from "@gajae-code/utils";
import { callMCP } from "../../src/runtime-mcp/json-rpc";

describe("runtime MCP JSON-RPC diagnostics", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("redacts endpoint credentials from HTTP failure diagnostics without changing the request URL", async () => {
		const endpoint =
			"https://synthetic-user-marker:synthetic-password-marker@example.test/synthetic-path-token-marker?access_token=synthetic-query-marker&plain=synthetic-plain-marker#synthetic-fragment";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 502 }));
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		await expect(callMCP(endpoint, "tools/list")).rejects.toThrow("MCP request failed: 502");

		expect(fetchSpy).toHaveBeenCalledWith(endpoint, expect.any(Object));
		const metadata = errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
		const loggedEndpoint = String(metadata.url);
		expect(loggedEndpoint).toContain("%3Credacted%3E");
		expect(loggedEndpoint).not.toContain("synthetic-user-marker");
		expect(loggedEndpoint).not.toContain("synthetic-password-marker");
		expect(loggedEndpoint).not.toContain("synthetic-path-token-marker");
		expect(loggedEndpoint).not.toContain("synthetic-query-marker");
		expect(loggedEndpoint).not.toContain("synthetic-plain-marker");
		expect(loggedEndpoint).not.toContain("synthetic-fragment");
	});

	it("redacts sensitive JSON-RPC parameters from HTTP failure diagnostics", async () => {
		const secret = "synthetic-parameter-secret";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 502 }));
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		await expect(
			callMCP("https://example.test/mcp", "tools/call", {
				access_token: secret,
				nested: { clientSecret: secret, ordinary: "safe" },
			}),
		).rejects.toThrow("MCP request failed: 502");

		const metadata = errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(JSON.stringify(metadata)).not.toContain(secret);
		expect(metadata.params).toEqual({
			access_token: "<redacted>",
			nested: { clientSecret: "<redacted>", ordinary: "safe" },
		});
	});

	it("omits response bodies and redacts endpoint credentials from parse failure diagnostics", async () => {
		const endpoint = "https://example.test/mcp?apiKey=synthetic-parse-marker";
		const echoedSecret = "synthetic-echoed-parameter-secret";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`invalid:${echoedSecret}`, { status: 200 }));
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		await expect(callMCP(endpoint, "tools/call", { access_token: echoedSecret })).rejects.toThrow(
			"Failed to parse MCP response",
		);

		const metadata = errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
		const loggedEndpoint = String(metadata.url);
		expect(loggedEndpoint).toContain("apiKey=%3Credacted%3E");
		expect(loggedEndpoint).not.toContain("synthetic-parse-marker");
		expect(metadata).not.toHaveProperty("responseText");
		expect(JSON.stringify(metadata)).not.toContain(echoedSecret);
	});

	it("refuses a cross-origin redirect before a second request is sent", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://evil.test/steal" } }));

		await expect(callMCP("https://example.test/mcp", "tools/call", { name: "x" })).rejects.toThrow(
			"cross-origin redirects are not allowed",
		);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.test/mcp");
		expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("manual");
		expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain('"method":"tools/call"');
	});

	it("fails closed when a malformed endpoint cannot be parsed for redaction", async () => {
		const endpoint = "http://alpha-marker:beta-marker@[::1";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 502 }));
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		await expect(callMCP(endpoint, "tools/list")).rejects.toThrow("MCP request failed: 502");

		expect(fetchSpy).toHaveBeenCalledWith(endpoint, expect.any(Object));
		const metadata = errorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(metadata.url).toBe("<redacted>");
		expect(JSON.stringify(metadata)).not.toContain("alpha-marker");
		expect(JSON.stringify(metadata)).not.toContain("beta-marker");
	});
});
