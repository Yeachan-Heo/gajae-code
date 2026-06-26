import { describe, expect, it } from "bun:test";
import { startAuthGateway } from "../src/auth-gateway/server";
import type { AuthGatewayServerHandle } from "../src/auth-gateway/types";
import type { AuthStorage } from "../src/auth-storage";
import type { Api, Model } from "../src/types";

const TEST_MODEL = {
	id: "test-model",
	provider: "test-provider",
	api: "anthropic-messages",
} as Model<Api>;

async function withGateway(
	bearerTokens: string[],
	fn: (handle: AuthGatewayServerHandle) => Promise<void>,
): Promise<void> {
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens,
		version: "test",
		storage: {} as AuthStorage,
		resolveModel: () => TEST_MODEL,
		listModels: () => [TEST_MODEL],
	});
	try {
		await fn(handle);
	} finally {
		await handle.close();
	}
}

describe("auth-gateway no-auth browser origin guard", () => {
	it("preserves no-auth access for non-browser local clients", async () => {
		await withGateway([], async gateway => {
			const response = await fetch(`${gateway.url}/v1/models`);

			expect(response.status).toBe(200);
			const body = (await response.json()) as { data?: Array<{ id: string }> };
			expect(body.data?.[0]?.id).toBe("test-model");
		});
	});

	it("rejects no-auth browser-origin requests before route handling", async () => {
		await withGateway([], async gateway => {
			const response = await fetch(`${gateway.url}/v1/models`, {
				headers: { Origin: "https://attacker.example" },
			});

			expect(response.status).toBe(403);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
			const body = (await response.json()) as { error?: string };
			expect(body.error).toContain("bearer token");
		});
	});

	it("rejects no-auth browser preflight without wildcard CORS", async () => {
		await withGateway([], async gateway => {
			const response = await fetch(`${gateway.url}/v1/models`, {
				method: "OPTIONS",
				headers: {
					Origin: "https://attacker.example",
					"Access-Control-Request-Method": "GET",
				},
			});

			expect(response.status).toBe(403);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
		});
	});

	it("preserves tokenized browser clients", async () => {
		await withGateway(["secret-token"], async gateway => {
			const preflight = await fetch(`${gateway.url}/v1/models`, {
				method: "OPTIONS",
				headers: {
					Origin: "https://client.example",
					"Access-Control-Request-Method": "GET",
				},
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

			const response = await fetch(`${gateway.url}/v1/models`, {
				headers: {
					Origin: "https://client.example",
					Authorization: "Bearer secret-token",
				},
			});

			expect(response.status).toBe(200);
			expect(response.headers.get("access-control-allow-origin")).toBe("*");
		});
	});
});
