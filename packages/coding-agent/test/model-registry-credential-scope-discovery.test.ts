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

	test("a revoked scoped OAuth pin fails closed without sending an alternate bearer", async () => {
		using tempDir = TempDir.createSync("@gjc-revoked-pinned-discovery-");
		const modelsPath = path.join(tempDir.path(), "models.yml");
		await fs.writeFile(
			modelsPath,
			[
				"providers:",
				"  revoked-pinned-discovery:",
				"    baseUrl: https://revoked-catalog.example.test/v1",
				"    api: openai-responses",
				"    discovery:",
				"      type: openai-models-list",
				"    models: []",
			].join("\n"),
		);
		const store = await SqliteAuthCredentialStore.open(":memory:");
		let refreshCalls = 0;
		const storage = new AuthStorage(store, {
			refreshOAuthCredential: async () => {
				refreshCalls++;
				throw new Error("invalid_grant: refresh token revoked");
			},
		});
		await storage.set("revoked-pinned-discovery", [
			{
				type: "oauth",
				access: "revoked-access",
				refresh: "revoked-refresh",
				expires: Date.now() - 60_000,
				email: "revoked@example.com",
			},
			oauth("alternate"),
		]);
		expect(storage.listCredentialInventory("revoked-pinned-discovery").map(row => row.email)).toEqual([
			"revoked@example.com",
			"alternate@example.com",
		]);
		storage.acquireCredentialScope("revoked-discovery-session");
		storage.setSessionCredentialSelector("revoked-discovery-session", "revoked-pinned-discovery", {
			kind: "email",
			value: "revoked@example.com",
		});
		expect(
			storage.resolveEffectiveCredentialSelector("revoked-pinned-discovery", "revoked-discovery-session"),
		).toEqual({
			kind: "email",
			value: "revoked@example.com",
		});
		const requests: string[] = [];
		using _fetch = hookFetch((_input, init) => {
			const bearer = new Headers(init?.headers).get("Authorization");
			if (bearer) requests.push(bearer);
			return Response.json({ data: [{ id: "must-not-be-discovered" }] });
		});
		const registry = new ModelRegistry(storage, modelsPath);
		try {
			await registry.refreshProvider("revoked-pinned-discovery", "online", "revoked-discovery-session");
			expect(refreshCalls).toBe(2);
			expect(requests).not.toContain("Bearer alternate-token");
			expect(registry.find("revoked-pinned-discovery", "must-not-be-discovered")).toBeUndefined();
			expect(storage.hasSessionCredentialUnavailable("revoked-pinned-discovery", "revoked-discovery-session")).toBe(
				true,
			);
		} finally {
			await registry.dispose();
			storage.close();
		}
	});
});
