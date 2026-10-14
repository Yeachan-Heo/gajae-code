import { afterEach, describe, expect, test } from "bun:test";
import {
	AuthStorage,
	type ConfiguredCredentialPreference,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "../src/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "../src/usage";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const openStores: SqliteAuthCredentialStore[] = [];
const usageByEmail = new Map<string, UsageReport>();

const usageProvider: UsageProvider = {
	id: "anthropic",
	async fetchUsage(params) {
		const email = params.credential.email;
		return email ? (usageByEmail.get(email) ?? null) : null;
	},
};

function limit(provider: string, windowId: "5h" | "7d", usedFraction: number): UsageLimit {
	const durationMs = windowId === "5h" ? 5 * HOUR_MS : 7 * DAY_MS;
	return {
		id: `${provider}:${windowId}`,
		label: windowId,
		scope: { provider, windowId, shared: true },
		window: { id: windowId, label: windowId, durationMs, resetsAt: Date.now() + durationMs / 2 },
		amount: {
			unit: "percent",
			used: usedFraction * 100,
			limit: 100,
			remaining: (1 - usedFraction) * 100,
			usedFraction,
			remainingFraction: 1 - usedFraction,
		},
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function report(email: string, fiveHourUsed: number, sevenDayUsed: number, provider = "anthropic"): UsageReport {
	return {
		provider,
		fetchedAt: Date.now(),
		limits: [limit(provider, "5h", fiveHourUsed), limit(provider, "7d", sevenDayUsed)],
		metadata: { email },
	};
}

function oauth(access: string, email: string): OAuthCredential {
	return { type: "oauth", access, refresh: `refresh-${access}`, expires: Date.now() + HOUR_MS, email };
}

async function createStorage(
	preference?: ConfiguredCredentialPreference,
	rankingStrategyResolver?: () => undefined,
	provider: "anthropic" | "kimi-code" = "anthropic",
): Promise<AuthStorage> {
	const store = await SqliteAuthCredentialStore.open(":memory:");
	openStores.push(store);
	const usageProviderForStorage: UsageProvider =
		provider === "anthropic"
			? usageProvider
			: {
					id: provider,
					async fetchUsage(params) {
						const email = params.credential.email;
						return email ? (usageByEmail.get(email) ?? null) : null;
					},
				};
	const storage = new AuthStorage(store, {
		usageProviderResolver: resolvedProvider => (resolvedProvider === provider ? usageProviderForStorage : undefined),
		...(rankingStrategyResolver ? { rankingStrategyResolver } : {}),
		...(preference ? { credentialPreferences: { [provider]: preference } } : {}),
	});
	await storage.set(provider, [
		oauth("token-personal", "personal@example.test"),
		oauth("token-cheap", "cheap@example.test"),
	]);
	return storage;
}

afterEach(() => {
	usageByEmail.clear();
	for (const store of openStores.splice(0)) store.close();
});

describe("configured credential preference", () => {
	test("balanced ranking picks the less-used account without a preference", async () => {
		usageByEmail.set("personal@example.test", report("personal@example.test", 0.1, 0.1));
		usageByEmail.set("cheap@example.test", report("cheap@example.test", 0.5, 0.5));
		const storage = await createStorage();

		expect(await storage.getApiKey("anthropic", "no-preference")).toBe("token-personal");
	});

	test("the preferred account is used ahead of the balanced ranking", async () => {
		usageByEmail.set("personal@example.test", report("personal@example.test", 0.1, 0.1));
		usageByEmail.set("cheap@example.test", report("cheap@example.test", 0.5, 0.5));
		const storage = await createStorage({ selector: { kind: "email", value: "cheap@example.test" } });

		expect(await storage.getApiKey("anthropic", "preferred")).toBe("token-cheap");
	});

	test("the preference yields to balanced ranking once any window reaches maxUsedFraction", async () => {
		usageByEmail.set("personal@example.test", report("personal@example.test", 0.1, 0.1));
		usageByEmail.set("cheap@example.test", report("cheap@example.test", 0.9, 0.2));
		const storage = await createStorage({
			selector: { kind: "email", value: "cheap@example.test" },
			maxUsedFraction: 0.9,
		});

		expect(await storage.getApiKey("anthropic", "over-threshold")).toBe("token-personal");
	});

	test("the long window alone can push the preference over maxUsedFraction", async () => {
		usageByEmail.set("personal@example.test", report("personal@example.test", 0.1, 0.1));
		usageByEmail.set("cheap@example.test", report("cheap@example.test", 0.05, 0.95));
		const storage = await createStorage({
			selector: { kind: "email", value: "cheap@example.test" },
			maxUsedFraction: 0.9,
		});

		expect(await storage.getApiKey("anthropic", "long-window-over-threshold")).toBe("token-personal");
	});

	test("the threshold applies when usage is available without a ranking strategy", async () => {
		usageByEmail.set("personal@example.test", report("personal@example.test", 0.1, 0.1, "kimi-code"));
		usageByEmail.set("cheap@example.test", report("cheap@example.test", 0.95, 0.2, "kimi-code"));
		const storage = await createStorage(
			{
				selector: { kind: "email", value: "cheap@example.test" },
				maxUsedFraction: 0.9,
			},
			() => undefined,
			"kimi-code",
		);

		expect(await storage.getApiKey("kimi-code")).toBe("token-personal");
	});

	test("the preference still applies just below maxUsedFraction", async () => {
		usageByEmail.set("personal@example.test", report("personal@example.test", 0.1, 0.1));
		usageByEmail.set("cheap@example.test", report("cheap@example.test", 0.89, 0.2));
		const storage = await createStorage({
			selector: { kind: "email", value: "cheap@example.test" },
			maxUsedFraction: 0.9,
		});

		expect(await storage.getApiKey("anthropic", "under-threshold")).toBe("token-cheap");
	});

	test("unknown usage does not count as over the threshold", async () => {
		const storage = await createStorage({
			selector: { kind: "email", value: "cheap@example.test" },
			maxUsedFraction: 0.5,
		});

		expect(await storage.getApiKey("anthropic", "unknown-usage")).toBe("token-cheap");
	});

	test("a quota failure on the preferred account rotates away for the rest of the session", async () => {
		const storage = await createStorage({ selector: { kind: "email", value: "cheap@example.test" } });

		expect(await storage.getApiKey("anthropic", "quota")).toBe("token-cheap");
		expect(await storage.markUsageLimitReached("anthropic", "quota", { retryAfterMs: 60_000 })).toMatchObject({
			state: "marked",
		});
		expect(await storage.getApiKey("anthropic", "quota")).toBe("token-personal");
		expect(await storage.getApiKey("anthropic", "quota-next-session")).toBe("token-personal");
	});

	test("a preference that matches no stored account leaves ranking untouched", async () => {
		usageByEmail.set("personal@example.test", report("personal@example.test", 0.5, 0.5));
		usageByEmail.set("cheap@example.test", report("cheap@example.test", 0.1, 0.1));
		const storage = await createStorage({ selector: { kind: "email", value: "removed@example.test" } });

		expect(await storage.getApiKey("anthropic", "missing")).toBe("token-cheap");
	});

	test.each([
		["configured preference", "configured"],
		["runtime --prefer-credential", "runtime"],
	] as const)("%s selects the designated OAuth row in a pool that also stores an API key", async (_label, source) => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		openStores.push(store);
		const selector = { kind: "email", value: "cheap@example.test" } as const;
		const storage = new AuthStorage(store, {
			rankingStrategyResolver: () => undefined,
			configValueResolver: async value => (value === "unusable-api-key" ? undefined : value),
			...(source === "configured" ? { credentialPreferences: { anthropic: { selector } } } : {}),
		});
		await storage.set("anthropic", [
			{ type: "api_key", key: "unusable-api-key" },
			oauth("token-cheap", "cheap@example.test"),
			oauth("token-personal", "personal@example.test"),
		]);
		if (source === "runtime") storage.setRuntimePreferredCredentialSelector("anthropic", selector);

		expect(await storage.getApiKey("anthropic", `mixed-${source}`)).toBe("token-cheap");
	});

	test("a runtime --prefer-credential selector outranks the configured preference", async () => {
		const storage = await createStorage({ selector: { kind: "email", value: "cheap@example.test" } });
		storage.setRuntimePreferredCredentialSelector("anthropic", { kind: "email", value: "personal@example.test" });

		expect(await storage.getApiKey("anthropic", "runtime-wins")).toBe("token-personal");
	});
});
