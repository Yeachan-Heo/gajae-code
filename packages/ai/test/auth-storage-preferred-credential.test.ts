import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "../src/auth-storage";

const openStores: SqliteAuthCredentialStore[] = [];

function oauth(access: string, email: string): OAuthCredential {
	return {
		type: "oauth",
		access,
		refresh: `refresh-${access}`,
		expires: Date.now() + 60 * 60_000,
		email,
	};
}

async function createStorage(provider = "anthropic"): Promise<{
	storage: AuthStorage;
	rows: ReturnType<SqliteAuthCredentialStore["listAuthCredentials"]>;
}> {
	const store = await SqliteAuthCredentialStore.open(":memory:");
	openStores.push(store);
	const storage = new AuthStorage(store, { rankingStrategyResolver: () => undefined });
	await storage.set(provider, [
		oauth("token-test-primary", "primary@example.test"),
		oauth("token-test-fallback", "fallback@example.test"),
	]);
	return { storage, rows: store.listAuthCredentials(provider) };
}

afterEach(() => {
	for (const store of openStores.splice(0)) store.close();
});

describe("runtime preferred credential selector", () => {
	test("preferred row is selected ahead of the normal balanced order", async () => {
		const { storage, rows } = await createStorage();
		const baseline = await storage.getApiKey("anthropic", "balanced-session");
		const preferred = rows.find(row => row.credential.type === "oauth" && row.credential.access !== baseline);
		expect(preferred).toBeDefined();

		storage.setRuntimePreferredCredentialSelector("anthropic", { kind: "id", value: String(preferred!.id) });
		expect(await storage.getApiKey("anthropic", "preferred-session")).toBe(
			(preferred!.credential as OAuthCredential).access,
		);
	});

	test("works for non-Anthropic OAuth providers", async () => {
		const provider = "openai-codex";
		const { storage, rows } = await createStorage(provider);
		storage.setRuntimePreferredCredentialSelector(provider, { kind: "id", value: String(rows[0]!.id) });

		expect(await storage.getApiKey(provider, "provider-neutral-session")).toBe("token-test-primary");
		expect(await storage.markUsageLimitReached(provider, "provider-neutral-session", { retryAfterMs: 60_000 })).toBe(
			true,
		);
		expect(await storage.getApiKey(provider, "provider-neutral-session")).toBe("token-test-fallback");
	});

	test("quota blocks the preferred row, falls back immediately, and keeps the fallback sticky", async () => {
		const { storage, rows } = await createStorage();
		const preferred = rows[0]!;
		storage.setRuntimePreferredCredentialSelector("anthropic", { kind: "id", value: String(preferred.id) });

		expect(await storage.getApiKey("anthropic", "session-a")).toBe("token-test-primary");
		expect(await storage.markUsageLimitReached("anthropic", "session-a", { retryAfterMs: 60_000 })).toBe(true);
		expect(await storage.getApiKey("anthropic", "session-a")).toBe("token-test-fallback");
		expect(await storage.getApiKey("anthropic", "session-a")).toBe("token-test-fallback");
	});

	test("an already blocked preferred row is skipped and exhaustion is finite", async () => {
		const { storage, rows } = await createStorage();
		storage.setRuntimePreferredCredentialSelector("anthropic", { kind: "id", value: String(rows[0]!.id) });
		await storage.getApiKey("anthropic", "session-b");
		expect(await storage.markUsageLimitReached("anthropic", "session-b", { retryAfterMs: 60_000 })).toBe(true);
		expect(await storage.getApiKey("anthropic", "session-b")).toBe("token-test-fallback");
		expect(await storage.markUsageLimitReached("anthropic", "session-b", { retryAfterMs: 60_000 })).toBe(false);
	});

	test("hard selector remains pinned and invalid preferred selectors fail closed", async () => {
		const { storage, rows } = await createStorage();
		storage.setRuntimeCredentialSelector("anthropic", { kind: "id", value: String(rows[0]!.id) });
		expect(await storage.getApiKey("anthropic", "hard-pin")).toBe("token-test-primary");
		expect(storage.hasRuntimePreferredCredentialSelector("anthropic")).toBe(false);

		storage.removeRuntimeCredentialSelector("anthropic");
		expect(() => storage.setRuntimePreferredCredentialSelector("anthropic", { kind: "id", value: "999" })).toThrow(
			"No active credential found for anthropic matching id:999",
		);
	});

	test("--credential and --prefer-credential reject combination on the same provider", async () => {
		const { storage, rows } = await createStorage();
		storage.setRuntimePreferredCredentialSelector("anthropic", { kind: "id", value: String(rows[0]!.id) });
		expect(() =>
			storage.setRuntimeCredentialSelector("anthropic", { kind: "id", value: String(rows[1]!.id) }),
		).toThrow("Credential selector cannot be combined with a preferred credential selector for anthropic");

		storage.removeRuntimePreferredCredentialSelector("anthropic");
		storage.setRuntimeCredentialSelector("anthropic", { kind: "id", value: String(rows[0]!.id) });
		expect(() =>
			storage.setRuntimePreferredCredentialSelector("anthropic", { kind: "id", value: String(rows[1]!.id) }),
		).toThrow("Preferred credential selector cannot be combined with a credential selector for anthropic");
	});

	test("resolveRuntimePreferredCredentialSelectorProvider infers a single matching provider", async () => {
		const { storage, rows } = await createStorage("anthropic");
		const resolved = storage.resolveRuntimePreferredCredentialSelectorProvider({
			kind: "id",
			value: String(rows[0]!.id),
		});
		expect(resolved).toBe("anthropic");
	});

	test("resolveRuntimePreferredCredentialSelectorProvider fails closed with no match", async () => {
		const { storage } = await createStorage();
		expect(() => storage.resolveRuntimePreferredCredentialSelectorProvider({ kind: "id", value: "999" })).toThrow(
			"No active credential found matching id:999",
		);
	});
});
