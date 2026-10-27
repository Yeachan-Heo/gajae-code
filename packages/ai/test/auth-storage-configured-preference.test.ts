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

const CHEAP = "cheap@example.test";
const SHARED = "shared@example.test";
const PERSONAL = "personal@example.test";

const openStores: SqliteAuthCredentialStore[] = [];
const usageByEmail = new Map<string, UsageReport>();

/**
 * Usage-report shapes by provider type. Each provider names its windows differently; the cap must read the windows
 * each provider actually reports rather than assume Anthropic's ids.
 */
type ProviderCase = "anthropic" | "openai-codex" | "kimi-code";
const WINDOW_IDS: Record<ProviderCase, { short: string; long: string }> = {
	anthropic: { short: "anthropic:5h", long: "anthropic:7d" },
	"openai-codex": { short: "openai-codex:primary", long: "openai-codex:secondary" },
	"kimi-code": { short: "kimi-code:0", long: "kimi-code:1" },
};

function limit(id: string, provider: string, durationMs: number, usedFraction: number): UsageLimit {
	return {
		id,
		label: id,
		scope: { provider, windowId: id, shared: true },
		window: { id, label: id, durationMs, resetsAt: Date.now() + durationMs / 2 },
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

function setUsage(email: string, shortUsed: number, longUsed: number, provider: ProviderCase = "anthropic"): void {
	const ids = WINDOW_IDS[provider];
	usageByEmail.set(email, {
		provider,
		fetchedAt: Date.now(),
		limits: [limit(ids.short, provider, 5 * HOUR_MS, shortUsed), limit(ids.long, provider, 7 * DAY_MS, longUsed)],
		metadata: { email },
	});
}

function oauth(email: string, accountId?: string): OAuthCredential {
	return {
		type: "oauth",
		access: `token-${email}`,
		refresh: `refresh-${email}`,
		expires: Date.now() + HOUR_MS,
		email,
		...(accountId ? { accountId } : {}),
	};
}

function token(email: string): string {
	return `token-${email}`;
}

function prefer(email: string, maxUsedPercent?: number): ConfiguredCredentialPreference {
	return maxUsedPercent === undefined
		? { selector: { kind: "email", value: email } }
		: { selector: { kind: "email", value: email }, maxUsedFraction: maxUsedPercent / 100 };
}

async function createStorage(
	preferences: readonly ConfiguredCredentialPreference[] | undefined,
	options: { provider?: ProviderCase; reportsUsage?: boolean; emails?: readonly string[] } = {},
): Promise<AuthStorage> {
	const provider = options.provider ?? "anthropic";
	const store = await SqliteAuthCredentialStore.open(":memory:");
	openStores.push(store);
	const usageProvider: UsageProvider = {
		id: provider,
		async fetchUsage(params) {
			const email = params.credential.email;
			return email ? (usageByEmail.get(email) ?? null) : null;
		},
	};
	const storage = new AuthStorage(store, {
		usageProviderResolver: resolved =>
			options.reportsUsage !== false && resolved === provider ? usageProvider : undefined,
		...(preferences ? { credentialPreferences: { [provider]: preferences } } : {}),
	});
	await storage.set(
		provider,
		(options.emails ?? [PERSONAL, CHEAP, SHARED]).map(email => oauth(email)),
	);
	return storage;
}

afterEach(() => {
	usageByEmail.clear();
	for (const store of openStores.splice(0)) store.close();
});

describe("ordered credential preferences", () => {
	test("balanced ranking picks the least-used account without preferences", async () => {
		setUsage(PERSONAL, 0.1, 0.1);
		setUsage(CHEAP, 0.5, 0.5);
		setUsage(SHARED, 0.3, 0.3);
		const storage = await createStorage(undefined);

		expect(await storage.getApiKey("anthropic", "no-preference")).toBe(token(PERSONAL));
	});

	test("the first listed account is used ahead of balanced ranking", async () => {
		setUsage(PERSONAL, 0.1, 0.1);
		setUsage(CHEAP, 0.5, 0.5);
		setUsage(SHARED, 0.3, 0.3);
		const storage = await createStorage([prefer(CHEAP), prefer(SHARED, 75)]);

		expect(await storage.getApiKey("anthropic", "first")).toBe(token(CHEAP));
	});

	test("a rate-limited first account moves selection to the second listed account, not to balanced ranking", async () => {
		setUsage(PERSONAL, 0.1, 0.1);
		setUsage(CHEAP, 1, 0.4);
		setUsage(SHARED, 0.3, 0.3);
		const storage = await createStorage([prefer(CHEAP), prefer(SHARED, 75)]);

		expect(await storage.getApiKey("anthropic", "second")).toBe(token(SHARED));
	});

	test.each([
		[74, SHARED],
		[75, PERSONAL],
	])("a listed account at %i%% of a 75%% cap resolves to %s", async (usedPercent, expected) => {
		setUsage(PERSONAL, 0.5, 0.5);
		setUsage(CHEAP, 1, 0.4);
		setUsage(SHARED, usedPercent / 100, 0.1);
		const storage = await createStorage([prefer(CHEAP), prefer(SHARED, 75)]);

		expect(await storage.getApiKey("anthropic", `cap-${usedPercent}`)).toBe(token(expected));
	});

	test("the long window alone can put a listed account over its cap", async () => {
		setUsage(PERSONAL, 0.5, 0.5);
		setUsage(CHEAP, 0.05, 0.95);
		const storage = await createStorage([prefer(CHEAP, 90)], { emails: [PERSONAL, CHEAP] });

		expect(await storage.getApiKey("anthropic", "long-window")).toBe(token(PERSONAL));
	});

	test("once every listed account is past its cap the unlisted accounts are ranked normally", async () => {
		setUsage(PERSONAL, 0.6, 0.6);
		setUsage(CHEAP, 0.8, 0.2);
		setUsage(SHARED, 0.9, 0.2);
		const storage = await createStorage([prefer(CHEAP, 50), prefer(SHARED, 75)]);

		expect(await storage.getApiKey("anthropic", "all-capped")).toBe(token(PERSONAL));
	});

	test("an account past its cap is still used when every other account is rate-limited", async () => {
		setUsage(PERSONAL, 1, 0.9);
		setUsage(CHEAP, 1, 0.5);
		setUsage(SHARED, 0.9, 0.2);
		const storage = await createStorage([prefer(CHEAP), prefer(SHARED, 75)]);

		expect(await storage.getApiKey("anthropic", "capped-last-resort")).toBe(token(SHARED));
	});

	test.each([
		"openai-codex",
		"kimi-code",
	] as const)("%s caps read the windows that provider reports", async provider => {
		setUsage(PERSONAL, 0.5, 0.5, provider);
		setUsage(CHEAP, 0.2, 0.2, provider);
		setUsage(SHARED, 0.8, 0.1, provider);
		const storage = await createStorage([prefer(SHARED, 75), prefer(CHEAP)], { provider });

		expect(await storage.getApiKey(provider, `${provider}-cap`)).toBe(token(CHEAP));
	});

	test("a provider without usage reporting follows list order and treats caps as not reached", async () => {
		const storage = await createStorage([prefer(SHARED, 10), prefer(CHEAP)], { reportsUsage: false });

		expect(await storage.getApiKey("anthropic", "no-usage")).toBe(token(SHARED));
	});

	test("unknown usage for one account does not count as over its cap", async () => {
		setUsage(PERSONAL, 0.1, 0.1);
		const storage = await createStorage([prefer(CHEAP, 50)], { emails: [PERSONAL, CHEAP] });

		expect(await storage.getApiKey("anthropic", "unknown-usage")).toBe(token(CHEAP));
	});

	test("a quota failure during a session moves to the next listed account", async () => {
		const storage = await createStorage([prefer(CHEAP), prefer(SHARED, 75)]);

		expect(await storage.getApiKey("anthropic", "quota")).toBe(token(CHEAP));
		expect(await storage.markUsageLimitReached("anthropic", "quota", { retryAfterMs: 60_000 })).toMatchObject({
			state: "marked",
		});
		expect(await storage.getApiKey("anthropic", "quota")).toBe(token(SHARED));
	});

	test("a session keeps its account after crossing the cap instead of switching mid-session", async () => {
		setUsage(PERSONAL, 0.5, 0.5);
		setUsage(SHARED, 0.5, 0.1);
		const storage = await createStorage([prefer(SHARED, 75)], { emails: [PERSONAL, SHARED] });

		expect(await storage.getApiKey("anthropic", "sticky")).toBe(token(SHARED));
		setUsage(SHARED, 0.9, 0.1);
		expect(await storage.getApiKey("anthropic", "sticky")).toBe(token(SHARED));
	});

	test("a listed account that is not stored is skipped", async () => {
		setUsage(PERSONAL, 0.1, 0.1);
		setUsage(CHEAP, 0.5, 0.5);
		setUsage(SHARED, 0.3, 0.3);
		const storage = await createStorage([prefer("removed@example.test"), prefer(CHEAP)]);

		expect(await storage.getApiKey("anthropic", "missing")).toBe(token(CHEAP));
	});

	describe("a list that names one stored account twice", () => {
		const CHEAP_ACCOUNT = "acct-cheap";
		const aliasedPreferences: ConfiguredCredentialPreference[] = [
			{ selector: { kind: "email", value: CHEAP }, maxUsedFraction: 0.5 },
			prefer(SHARED),
			{ selector: { kind: "account", value: CHEAP_ACCOUNT } },
		];

		async function createAliasedStorage(
			preferences: readonly ConfiguredCredentialPreference[],
			credentials: readonly OAuthCredential[],
		): Promise<AuthStorage> {
			const store = await SqliteAuthCredentialStore.open(":memory:");
			openStores.push(store);
			const storage = new AuthStorage(store, {
				usageProviderResolver: () => ({
					id: "anthropic",
					async fetchUsage(params) {
						const email = params.credential.email;
						return email ? (usageByEmail.get(email) ?? null) : null;
					},
				}),
				credentialPreferences: { anthropic: preferences },
			});
			await storage.set("anthropic", [...credentials]);
			return storage;
		}

		test("through email and account selectors is reported with the shared row", async () => {
			const storage = await createAliasedStorage(aliasedPreferences, [
				oauth(PERSONAL),
				oauth(CHEAP, CHEAP_ACCOUNT),
				oauth(SHARED),
			]);
			const cheapRow = storage.listCredentialInventory("anthropic").find(row => row.email === CHEAP);

			expect(storage.findDuplicateCredentialPreferences()).toEqual([
				{ provider: "anthropic", credentialId: cheapRow!.id },
			]);
		});

		test("is ignored as a whole instead of honoring only the first entry's cap", async () => {
			setUsage(PERSONAL, 0.1, 0.1);
			setUsage(CHEAP, 0.6, 0.1);
			setUsage(SHARED, 0.3, 0.3);
			const storage = await createAliasedStorage(aliasedPreferences, [
				oauth(PERSONAL),
				oauth(CHEAP, CHEAP_ACCOUNT),
				oauth(SHARED),
			]);

			// Applied, the list would pick SHARED (CHEAP is over its 50% cap); ignored, balanced ranking picks PERSONAL.
			expect(await storage.getApiKey("anthropic", "aliased")).toBe(token(PERSONAL));
		});

		test("is not reported when the aliases designate different rows", async () => {
			const storage = await createAliasedStorage(aliasedPreferences, [
				oauth(PERSONAL, CHEAP_ACCOUNT),
				oauth(CHEAP),
				oauth(SHARED),
			]);

			expect(storage.findDuplicateCredentialPreferences()).toEqual([]);
		});
	});

	test.each([
		["configured preference", "configured"],
		["runtime --prefer-credential", "runtime"],
	] as const)("%s selects the designated OAuth row in a pool that also stores an API key", async (_label, source) => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		openStores.push(store);
		const selector = { kind: "email", value: CHEAP } as const;
		const storage = new AuthStorage(store, {
			rankingStrategyResolver: () => undefined,
			configValueResolver: async value => (value === "unusable-api-key" ? undefined : value),
			...(source === "configured" ? { credentialPreferences: { anthropic: [{ selector }] } } : {}),
		});
		await storage.set("anthropic", [{ type: "api_key", key: "unusable-api-key" }, oauth(CHEAP), oauth(PERSONAL)]);
		if (source === "runtime") storage.setRuntimePreferredCredentialSelector("anthropic", selector);

		expect(await storage.getApiKey("anthropic", `mixed-${source}`)).toBe(token(CHEAP));
	});

	test("a runtime --prefer-credential selector outranks configured preferences", async () => {
		const storage = await createStorage([prefer(CHEAP)]);
		storage.setRuntimePreferredCredentialSelector("anthropic", { kind: "email", value: PERSONAL });

		expect(await storage.getApiKey("anthropic", "runtime-wins")).toBe(token(PERSONAL));
	});
});
