import { describe, expect, test } from "bun:test";
import { type AuthCredentialSelector, AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

const PROVIDER = "unit-literal-cache-provenance";
const FIRST_KEY = "fixture-literal-first";
const SECOND_KEY = "fixture-literal-second";

async function createFixture(): Promise<{
	storage: AuthStorage;
	store: SqliteAuthCredentialStore;
	first: AuthCredentialSelector;
	second: AuthCredentialSelector;
}> {
	const store = await SqliteAuthCredentialStore.open(":memory:");
	store.replaceAuthCredentialsForProvider(PROVIDER, [
		{ type: "api_key", key: FIRST_KEY },
		{ type: "api_key", key: SECOND_KEY },
	]);
	const storage = new AuthStorage(store);
	await storage.reload();
	const [firstRow, secondRow] = storage.listCredentialInventory(PROVIDER);
	if (!firstRow || !secondRow) throw new Error("Expected two active literal rows");
	return {
		storage,
		store,
		first: { kind: "id", value: String(firstRow.id) },
		second: { kind: "id", value: String(secondRow.id) },
	};
}

describe("AuthStorage exact literal cache provenance", () => {
	test("keeps exact-row evidence across scoped choices while configuration barriers advance", async () => {
		const { storage, first, second } = await createFixture();
		try {
			const owner = {};
			storage.setFallbackResolver(() => undefined, owner);
			const ownedEvidence = storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, owner);
			const unownedEvidence = storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first);
			if (!ownedEvidence || !unownedEvidence) throw new Error("Expected active literal cache evidence");
			expect(storage.getProviderEvidenceGeneration(PROVIDER, FIRST_KEY, owner)).toBe(ownedEvidence);
			expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, second, owner)).not.toBe(ownedEvidence);
			let notifications = 0;
			const unsubscribe = storage.onGenerationChanged(() => {
				notifications += 1;
			});
			const choices = [
				() => storage.setSessionCredentialSelector("scope", PROVIDER, first, owner),
				() => storage.setSessionCredentialSelector("scope", PROVIDER, first, owner),
				() => storage.setSessionCredentialAuto(PROVIDER, "scope"),
				() => storage.clearSessionCredentialSelector(PROVIDER, "scope"),
				() => storage.setSessionCredentialSelector("scope", PROVIDER, first, owner),
				() => storage.markSessionCredentialUnavailable("scope", PROVIDER, first),
			];
			for (const choose of choices) {
				const generation = storage.getGeneration();
				const configuration = storage.getProviderConfigurationGeneration(PROVIDER);
				const ownedConfiguration = storage.getProviderConfigurationGeneration(PROVIDER, owner);
				choose();
				expect(storage.getGeneration()).toBeGreaterThan(generation);
				expect(storage.getProviderConfigurationGeneration(PROVIDER)).toBeGreaterThan(configuration);
				expect(storage.getProviderConfigurationGeneration(PROVIDER, owner)).toBeGreaterThan(ownedConfiguration);
				expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, owner)).toBe(ownedEvidence);
				expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first)).toBe(unownedEvidence);
			}
			expect(notifications).toBe(choices.length);
			unsubscribe();
			await expect(storage.getApiKey(PROVIDER, "scope", { owner })).rejects.toThrow(/is unavailable/);
			storage.setSessionCredentialSelector("scope", PROVIDER, first, owner);
			await expect(storage.getApiKey(PROVIDER, "scope", { owner })).resolves.toBe(FIRST_KEY);
			storage.setSessionCredentialSelector("scope", PROVIDER, second, owner);
			await expect(storage.getApiKey(PROVIDER, "scope", { owner })).resolves.toBe(SECOND_KEY);
			expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, owner)).toBe(ownedEvidence);
		} finally {
			storage.close();
		}
	});

	test("invalidates disabled and replaced rows instead of reusing their cached evidence", async () => {
		const { storage, store, first, second } = await createFixture();
		try {
			const owner = {};
			const firstEvidence = storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, owner);
			const secondEvidence = storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, second, owner);
			if (!firstEvidence || !secondEvidence) throw new Error("Expected active literal cache evidence");
			store.deleteAuthCredential(Number(first.value), "fixture-disabled");
			await storage.reload();
			expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, owner)).toBeUndefined();
			expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, second, owner)).not.toBe(secondEvidence);
			expect(() => storage.setSessionCredentialSelector("scope", PROVIDER, first, owner)).toThrow(
				/No credential found/,
			);
			store.updateAuthCredential(Number(second.value), { type: "api_key", key: "fixture-literal-replacement" });
			await storage.reload();
			const replacementEvidence = storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, second, owner);
			expect(replacementEvidence).toBeDefined();
			expect(replacementEvidence).not.toBe(firstEvidence);
			expect(replacementEvidence).not.toBe(secondEvidence);
			storage.setSessionCredentialSelector("scope", PROVIDER, second, owner);
			await expect(storage.getApiKey(PROVIDER, "scope", { owner })).resolves.toBe("fixture-literal-replacement");
		} finally {
			storage.close();
		}
	});

	test("keeps owner isolation and refuses runtime/config overrides for exact-row admission", async () => {
		const { storage, first } = await createFixture();
		try {
			const owner = {};
			const sibling = {};
			storage.setFallbackResolver(() => undefined, owner);
			const evidence = storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, owner);
			const fork = storage.forkConfigOwner(owner);
			const forkEvidence = storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, fork);
			if (!evidence || !forkEvidence) throw new Error("Expected active literal cache evidence");
			storage.releaseConfigOwner(fork);
			expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, fork)).not.toBe(forkEvidence);
			expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, owner)).toBe(evidence);
			storage.setConfigApiKey(PROVIDER, "fixture-config-override", { owner: sibling });
			expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, sibling)).toBeUndefined();
			expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, owner)).toBe(evidence);
			storage.setConfigApiKey(PROVIDER, "fixture-own-config-override", { owner });
			expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, owner)).toBeUndefined();
			storage.removeConfigApiKey(PROVIDER, owner);
			expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, owner)).not.toBe(evidence);
			storage.setRuntimeApiKey(PROVIDER, "fixture-runtime-override");
			expect(storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, first, owner)).toBeUndefined();
		} finally {
			storage.close();
		}
	});

	test("refuses command and environment references as literal cache evidence", async () => {
		const storage = await AuthStorage.create(":memory:");
		const envName = "GJC_UNIT_LITERAL_CACHE_PROVENANCE_KEY";
		const original = process.env[envName];
		try {
			process.env[envName] = "fixture-environment-key";
			await storage.set(PROVIDER, [
				{ type: "api_key", key: "!fixture-command-must-not-execute" },
				{ type: "api_key", key: envName },
			]);
			for (const row of storage.listCredentialInventory(PROVIDER)) {
				expect(
					storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, { kind: "id", value: String(row.id) }),
				).toBeUndefined();
			}
			expect(
				storage.getStoredLiteralApiKeyEvidenceGeneration(PROVIDER, { kind: "id", value: "missing" }),
			).toBeUndefined();
		} finally {
			if (original === undefined) delete process.env[envName];
			else process.env[envName] = original;
			storage.close();
		}
	});

	test("preserves nonliteral OAuth freshness when scoped account selection changes", async () => {
		const storage = await AuthStorage.create(":memory:");
		try {
			await storage.set(PROVIDER, [
				{
					type: "oauth",
					access: "fixture-oauth-access",
					refresh: "fixture-oauth-refresh",
					expires: Date.now() + 60_000,
					accountId: "fixture-oauth-account",
				},
			]);
			const row = storage.listCredentialInventory(PROVIDER)[0];
			if (!row) throw new Error("Expected an OAuth row");
			const owner = {};
			const before = storage.getProviderEvidenceGeneration(PROVIDER, "fixture-oauth-access", owner);
			storage.setSessionCredentialSelector("scope", PROVIDER, { kind: "id", value: String(row.id) }, owner);
			expect(storage.getProviderEvidenceGeneration(PROVIDER, "fixture-oauth-access", owner)).not.toBe(before);
			expect(storage.getOAuthCredential(PROVIDER, "scope")?.accountId).toBe("fixture-oauth-account");
		} finally {
			storage.close();
		}
	});
});
