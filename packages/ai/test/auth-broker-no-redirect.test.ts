import { describe, expect, it } from "bun:test";
import { AuthBrokerClient } from "../src/auth-broker/client";
import type { AuthCredential } from "../src/auth-storage";

describe("auth broker credential redirect", () => {
	it("does not follow redirects on a credential JSON post", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const client = new AuthBrokerClient({
			url: "http://127.0.0.1:9",
			token: "secret-token",
			maxRetries: 0,
			fetchImpl: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				inits.push(init);
				return new Response(JSON.stringify({ entries: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch,
		});
		await client.uploadCredential("anthropic", { type: "api_key", key: "k" } as AuthCredential);
		expect(inits[0]?.redirect).toBe("error");
	});
});
