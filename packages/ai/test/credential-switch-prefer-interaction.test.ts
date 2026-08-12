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

afterEach(() => {
	for (const store of openStores.splice(0)) store.close();
});

describe("merged contract: /credential switch vs --prefer-credential (PR #4317)", () => {
	test("an explicit switch beats the soft preference while the switched row is usable", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		openStores.push(store);
		const storage = new AuthStorage(store, { rankingStrategyResolver: () => undefined });
		await storage.set("anthropic", [
			oauth("token-account-a", "a@example.test"),
			oauth("token-account-b", "b@example.test"),
		]);
		const rows = store.listAuthCredentials("anthropic");
		const rowA = rows[0]!;
		const rowB = rows[1]!;

		// Soft preference names row A; explicit session switch targets row B.
		storage.setRuntimePreferredCredentialSelector("anthropic", { kind: "id", value: String(rowA.id) });
		storage.switchSessionCredential("anthropic", "live-session", { kind: "id", value: String(rowB.id) });

		// Sticky reorder runs after the prefer reorder -> the switch wins while usable.
		expect(await storage.getApiKey("anthropic", "live-session")).toBe("token-account-b");
	});

	test("the soft preference wins only when the switched-to row is blocked", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		openStores.push(store);
		const storage = new AuthStorage(store, { rankingStrategyResolver: () => undefined });
		await storage.set("anthropic", [
			oauth("token-account-a", "a@example.test"),
			oauth("token-account-b", "b@example.test"),
		]);
		const rows = store.listAuthCredentials("anthropic");
		const rowA = rows[0]!;
		const rowB = rows[1]!;

		// Soft preference row A; switch to row B then exhaust B so it is backoff-blocked.
		storage.setRuntimePreferredCredentialSelector("anthropic", { kind: "id", value: String(rowA.id) });
		storage.switchSessionCredential("anthropic", "live-session", { kind: "id", value: String(rowB.id) });
		expect(await storage.getApiKey("anthropic", "live-session")).toBe("token-account-b");
		expect(await storage.markUsageLimitReached("anthropic", "live-session", { retryAfterMs: 60_000 })).toBe(true);

		// Blocked switched row falls through to the soft-preferred row, not to a 429.
		expect(await storage.getApiKey("anthropic", "live-session")).toBe("token-account-a");
	});
});
