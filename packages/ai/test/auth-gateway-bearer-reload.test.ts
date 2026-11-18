import { describe, expect, it } from "bun:test";
import { startAuthGateway } from "../src/auth-gateway/server";
import type { AuthStorage } from "../src/auth-storage";
import type { Api, Model } from "../src/types";

const TEST_MODEL = {
	id: "test-model",
	provider: "test-provider",
	api: "anthropic-messages",
} as Model<Api>;

const PREVIOUS = "previous-gateway-bearer";
const REPLACEMENT = "replacement-gateway-bearer";

function startGateway(options: {
	bearerTokens: string[];
	currentBearerTokens?: (signal: AbortSignal) => ReadonlySet<string> | Promise<ReadonlySet<string>>;
}) {
	return startAuthGateway({
		bind: "127.0.0.1:0",
		providerScope: { provider: TEST_MODEL.provider },
		hasProviderCredential: () => true,
		reloadProviderCredentials: async () => {},
		validateProviderCredential: () => true,
		bearerTokens: options.bearerTokens,
		currentBearerTokens: options.currentBearerTokens,
		version: "test",
		storage: {
			exportSnapshot: () => ({ credentials: [{ provider: TEST_MODEL.provider }] }),
		} as unknown as AuthStorage,
		resolveModel: () => TEST_MODEL,
		listModels: () => [TEST_MODEL],
	});
}

async function modelsStatus(port: number, token?: string): Promise<number> {
	const headers: Record<string, string> = {};
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers });
	await response.arrayBuffer();
	return response.status;
}

describe("auth-gateway bearer reload", () => {
	it("still allows the boot bearer when no live allow-list is set", async () => {
		const gateway = startGateway({ bearerTokens: [PREVIOUS] });
		try {
			expect(await modelsStatus(gateway.port, PREVIOUS)).toBe(200);
			expect(await modelsStatus(gateway.port, REPLACEMENT)).toBe(401);
		} finally {
			await gateway.close();
		}
	});

	it("still allows a tokenless models request on the bound host", async () => {
		const gateway = startGateway({ bearerTokens: [] });
		try {
			expect(await modelsStatus(gateway.port)).toBe(200);
		} finally {
			await gateway.close();
		}
	});

	it("keeps the boot bearer when the live allow-list is empty", async () => {
		const gateway = startGateway({
			bearerTokens: [PREVIOUS],
			currentBearerTokens: () => new Set<string>(),
		});
		try {
			expect(await modelsStatus(gateway.port, PREVIOUS)).toBe(200);
			expect(await modelsStatus(gateway.port, REPLACEMENT)).toBe(401);
		} finally {
			await gateway.close();
		}
	});

	it("rejects a bearer removed from the live allow-list", async () => {
		let allow = new Set<string>([PREVIOUS]);
		const gateway = startGateway({
			bearerTokens: [PREVIOUS],
			currentBearerTokens: () => allow,
		});
		try {
			expect(await modelsStatus(gateway.port, PREVIOUS)).toBe(200);
			allow = new Set<string>([REPLACEMENT]);
			expect(await modelsStatus(gateway.port, PREVIOUS)).toBe(401);
			expect(await modelsStatus(gateway.port, REPLACEMENT)).toBe(200);
		} finally {
			await gateway.close();
		}
	});
});
