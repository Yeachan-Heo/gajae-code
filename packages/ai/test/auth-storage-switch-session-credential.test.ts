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

async function createStorage(
	provider = "anthropic",
): Promise<{ storage: AuthStorage; rows: ReturnType<SqliteAuthCredentialStore["listAuthCredentials"]> }> {
	const store = await SqliteAuthCredentialStore.open(":memory:");
	openStores.push(store);
	const storage = new AuthStorage(store, { rankingStrategyResolver: () => undefined });
	await storage.set(provider, [
		oauth("token-account-a", "a@example.test"),
		oauth("token-account-b", "b@example.test"),
	]);
	return { storage, rows: store.listAuthCredentials(provider) };
}

afterEach(() => {
	for (const store of openStores.splice(0)) store.close();
});

describe("mid-session credential switch", () => {
	test("switches the active session credential even with no quota pressure", async () => {
		const { storage, rows } = await createStorage();
		const rowA = rows[0]!;
		const rowB = rows[1]!;

		// Session starts on whichever account round-robin/balanced ranking picks.
		const firstKey = await storage.getApiKey("anthropic", "live-session");
		const startedOnA = firstKey === "token-account-a";
		const other = startedOnA ? rowB : rowA;

		// Nothing is exhausted; the user just wants the other account.
		storage.switchSessionCredential("anthropic", "live-session", { kind: "id", value: String(other.id) });
		const switchedKey = await storage.getApiKey("anthropic", "live-session");
		expect(switchedKey).toBe((other.credential as OAuthCredential).access);
		expect(switchedKey).not.toBe(firstKey);
	});

	test("the switch stays sticky across repeated calls", async () => {
		const { storage, rows } = await createStorage();
		const target = rows[1]!;
		storage.switchSessionCredential("anthropic", "sticky-session", { kind: "id", value: String(target.id) });

		expect(await storage.getApiKey("anthropic", "sticky-session")).toBe("token-account-b");
		expect(await storage.getApiKey("anthropic", "sticky-session")).toBe("token-account-b");
		expect(await storage.getApiKey("anthropic", "sticky-session")).toBe("token-account-b");
	});

	test("switching one session's credential does not affect a different session", async () => {
		const { storage, rows } = await createStorage();
		const rowB = rows[1]!;

		const otherSessionKey = await storage.getApiKey("anthropic", "unrelated-session");
		storage.switchSessionCredential("anthropic", "target-session", { kind: "id", value: String(rowB.id) });

		expect(await storage.getApiKey("anthropic", "target-session")).toBe("token-account-b");
		// The unrelated session keeps whatever it already resolved to.
		expect(await storage.getApiKey("anthropic", "unrelated-session")).toBe(otherSessionKey);
	});

	test("switching to a blocked row falls back to a usable account instead of forcing it", async () => {
		const { storage, rows } = await createStorage();
		const rowA = rows[0]!;
		const rowB = rows[1]!;

		// Drive session-a onto row A, then exhaust it so it's backoff-blocked.
		storage.switchSessionCredential("anthropic", "session-a", { kind: "id", value: String(rowA.id) });
		expect(await storage.getApiKey("anthropic", "session-a")).toBe("token-account-a");
		expect(await storage.markUsageLimitReached("anthropic", "session-a", { retryAfterMs: 60_000 })).toBe(true);

		// Attempting to switch back to the still-blocked row A does not force it —
		// #resolveOAuthSelection's blocked check safely ignores the sticky pointer.
		storage.switchSessionCredential("anthropic", "session-a", { kind: "id", value: String(rowA.id) });
		expect(await storage.getApiKey("anthropic", "session-a")).toBe((rowB.credential as OAuthCredential).access);
	});

	test("works for a non-Anthropic OAuth provider", async () => {
		const provider = "openai-codex";
		const { storage, rows } = await createStorage(provider);
		storage.switchSessionCredential(provider, "codex-session", { kind: "id", value: String(rows[1]!.id) });
		expect(await storage.getApiKey(provider, "codex-session")).toBe("token-account-b");
	});

	test("rejects an unmatched or non-OAuth selector", async () => {
		const { storage } = await createStorage();
		expect(() => storage.switchSessionCredential("anthropic", "live-session", { kind: "id", value: "999" })).toThrow(
			"No active OAuth credential found for anthropic matching id:999",
		);
	});

	test("refuses to switch while --credential hard-pins the provider", async () => {
		const { storage, rows } = await createStorage();
		storage.setRuntimeCredentialSelector("anthropic", { kind: "id", value: String(rows[0]!.id) });
		expect(() =>
			storage.switchSessionCredential("anthropic", "live-session", { kind: "id", value: String(rows[1]!.id) }),
		).toThrow("--credential already pins this session to one stored row");
	});

	test("refuses to switch while a runtime API key override is active", async () => {
		const { storage, rows } = await createStorage();
		storage.setRuntimeApiKey("anthropic", "sk-runtime-override");
		expect(() =>
			storage.switchSessionCredential("anthropic", "live-session", { kind: "id", value: String(rows[0]!.id) }),
		).toThrow("a runtime API key override (--api-key) is active");
	});

	test("refuses to switch while a config API key override is active", async () => {
		const { storage, rows } = await createStorage();
		storage.setConfigApiKey("anthropic", "sk-config-override");
		expect(() =>
			storage.switchSessionCredential("anthropic", "live-session", { kind: "id", value: String(rows[0]!.id) }),
		).toThrow("a config API key override (models.yml) is active");
	});
});
