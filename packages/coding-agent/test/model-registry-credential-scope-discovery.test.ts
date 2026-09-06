import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@gajae-code/ai";
import { hookFetch, TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";

const openStorages: AuthStorage[] = [];

function oauth(name: string) {
	return {
		type: "oauth" as const,
		access: `${name}-token`,
		refresh: `${name}-refresh`,
		expires: Date.now() + 60 * 60_000,
		accountId: `${name}-account`,
		email: `${name}@example.com`,
	};
}

async function createStorage(order: readonly string[]): Promise<AuthStorage> {
	const store = await SqliteAuthCredentialStore.open(":memory:");
	for (const name of order) store.saveOAuth("pinned-discovery", oauth(name));
	const storage = new AuthStorage(store);
	await storage.reload();
	openStorages.push(storage);
	return storage;
}

afterEach(() => {
	for (const storage of openStorages.splice(0)) storage.close();
});

describe("model discovery credential scopes", () => {
	test("a scoped pin supplies the catalog credential regardless of account order", async () => {
		for (const order of [
			["limited", "entitled"],
			["entitled", "limited"],
		] as const) {
			using tempDir = TempDir.createSync("@gjc-pinned-model-discovery-");
			const modelsPath = path.join(tempDir.path(), "models.yml");
			await fs.writeFile(
				modelsPath,
				[
					"providers:",
					"  pinned-discovery:",
					"    baseUrl: https://catalog.example.test/v1",
					"    api: openai-responses",
					"    discovery:",
					"      type: openai-models-list",
					"    models: []",
				].join("\n"),
			);
			const storage = await createStorage(order);
			storage.acquireCredentialScope("profile-session");
			storage.setSessionCredentialSelector("profile-session", "pinned-discovery", {
				kind: "email",
				value: "entitled@example.com",
			});
			let requestCount = 0;
			using _fetch = hookFetch((input, init) => {
				requestCount++;
				expect(String(input)).toBe("https://catalog.example.test/v1/models");
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe("Bearer entitled-token");
				return new Response(JSON.stringify({ data: [{ id: "profile-required-model" }] }), {
					headers: { "Content-Type": "application/json" },
				});
			});
			const registry = new ModelRegistry(storage, modelsPath);
			try {
				await registry.refreshProvider("pinned-discovery", "online", "profile-session");
				expect(requestCount).toBe(1);
				expect(registry.find("pinned-discovery", "profile-required-model")).toBeDefined();
			} finally {
				await registry.dispose();
			}
		}
	});
});
