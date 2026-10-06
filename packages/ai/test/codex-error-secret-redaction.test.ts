import { describe, expect, it } from "bun:test";
import { parseCodexError } from "../src/providers/openai-codex/response-handler";

describe("parseCodexError", () => {
	it("does not persist a bearer token reflected in an error body", async () => {
		const response = new Response(JSON.stringify({ error: { message: "nope Bearer sk-live-secret tail" } }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
		const info = await parseCodexError(response);
		expect(info.raw).not.toContain("sk-live-secret");
		expect(info.message).not.toContain("sk-live-secret");
		expect(info.raw).toContain("Bearer [REDACTED]");
		expect(info.status).toBe(401);
	});

	it("keeps the error code when a compact JSON body reflects a bearer token", async () => {
		const info = await parseCodexError(
			new Response('{"error":{"message":"denied Bearer abc123","code":"rate_limit_exceeded"}}', {
				status: 429,
				headers: { "content-type": "application/json" },
			}),
		);
		expect(info.code).toBe("rate_limit_exceeded");
		expect(info.friendlyMessage).toContain("rate limit");
		expect(info.raw).not.toContain("abc123");
		expect(info.message).not.toContain("abc123");
		expect(info.message).toContain("Bearer [REDACTED]");
	});

	it("does not persist a bare sk- token in a non-JSON body", async () => {
		const info = await parseCodexError(new Response("upstream said sk-live-secret", { status: 500 }));
		expect(info.raw).not.toContain("sk-live-secret");
		expect(info.message).not.toContain("sk-live-secret");
		expect(info.message).toContain("[REDACTED]");
	});
});
