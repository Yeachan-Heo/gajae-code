import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { withEnv } from "./helpers";

const SUPPRESS_ANTHROPIC_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
} as const;

describe("AuthStorage config-override apiKey", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-config-override-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		authStorage.setUsageProbeMode("cache-only");
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	async function seedOAuth(provider: string, access: string): Promise<void> {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set(provider, [
			{
				type: "oauth",
				access,
				refresh: `${access}-refresh`,
				expires: Date.now() + 60 * 60_000,
			},
		]);
	}

	test("setConfigApiKey beats OAuth access token for getApiKey", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKey("anthropic", "gateway-bearer");

			expect(await authStorage.getApiKey("anthropic")).toBe("gateway-bearer");
			expect(await authStorage.peekApiKey("anthropic")).toBe("gateway-bearer");
		});
	});

	test("runtime override (--api-key) still beats setConfigApiKey", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKey("anthropic", "gateway-bearer");
			authStorage.setRuntimeApiKey("anthropic", "cli-flag-bearer");

			expect(await authStorage.getApiKey("anthropic")).toBe("cli-flag-bearer");
		});
	});

	test("removeConfigApiKey restores OAuth resolution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKey("anthropic", "gateway-bearer");
			expect(await authStorage.getApiKey("anthropic")).toBe("gateway-bearer");

			authStorage.removeConfigApiKey("anthropic");
			expect(await authStorage.getApiKey("anthropic")).toBe("oauth-from-broker");
		});
	});

	test("clearConfigApiKeys drops every config override at once", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-anthropic");
			await seedOAuth("openai-codex", "oauth-codex");
			authStorage.setConfigApiKey("anthropic", "gateway-bearer-A");
			authStorage.setConfigApiKey("openai-codex", "gateway-bearer-B");

			authStorage.clearConfigApiKeys();

			expect(await authStorage.getApiKey("anthropic")).toBe("oauth-anthropic");
			expect(await authStorage.getApiKey("openai-codex")).toBe("oauth-codex");
		});
	});

	test("setConfigApiKey suppresses OAuth account_uuid attribution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					access: "oauth-with-account",
					refresh: "r",
					expires: Date.now() + 60 * 60_000,
					accountId: "acc-123",
				},
			]);
			// Sanity: without override, accountId is exposed.
			expect(authStorage.getOAuthAccountId("anthropic")).toBe("acc-123");

			authStorage.setConfigApiKey("anthropic", "gateway-bearer");
			// With an explicit config bearer in play, OAuth account attribution
			// must NOT leak — outbound auth is the gateway bearer, not OAuth.
			expect(authStorage.getOAuthAccountId("anthropic")).toBeUndefined();
		});
	});

	test("describeCredentialSource reports config override", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKey("anthropic", "gateway-bearer");
			expect(authStorage.describeCredentialSource("anthropic")).toBe("config override (models.yml)");
		});
	});
	test("env-sourced override yields to a stored login api_key", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.set("anthropic", [{ type: "api_key", key: "stored-login-key" }]);
			authStorage.setConfigApiKey("anthropic", "stale-env-key", { envSourced: true });

			expect(await authStorage.getApiKey("anthropic")).toBe("stored-login-key");
			expect(await authStorage.peekApiKey("anthropic")).toBe("stored-login-key");
		});
	});

	test("env-sourced override applies when no stored credential exists", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			authStorage.setConfigApiKey("anthropic", "env-key", { envSourced: true });

			expect(await authStorage.getApiKey("anthropic")).toBe("env-key");
			expect(await authStorage.peekApiKey("anthropic")).toBe("env-key");
		});
	});

	test("env-sourced override still beats a stored OAuth credential", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.setConfigApiKey("anthropic", "gateway-bearer-from-env", { envSourced: true });

			expect(await authStorage.getApiKey("anthropic")).toBe("gateway-bearer-from-env");
			expect(await authStorage.peekApiKey("anthropic")).toBe("gateway-bearer-from-env");
		});
	});

	test("literal config override still beats a stored login api_key", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.set("anthropic", [{ type: "api_key", key: "stored-login-key" }]);
			authStorage.setConfigApiKey("anthropic", "literal-pin");

			expect(await authStorage.getApiKey("anthropic")).toBe("literal-pin");
			expect(await authStorage.peekApiKey("anthropic")).toBe("literal-pin");
		});
	});

	test("re-pinning a literal key after an env-sourced override restores top priority", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.set("anthropic", [{ type: "api_key", key: "stored-login-key" }]);
			authStorage.setConfigApiKey("anthropic", "stale-env-key", { envSourced: true });
			expect(await authStorage.getApiKey("anthropic")).toBe("stored-login-key");

			authStorage.setConfigApiKey("anthropic", "literal-pin");
			expect(await authStorage.getApiKey("anthropic")).toBe("literal-pin");
		});
	});

	test("hasLiteralConfigApiKey distinguishes a literal key from an env-sourced one per owner", () => {
		if (!authStorage) throw new Error("test setup failed");
		const owner = {};
		const otherOwner = {};
		authStorage.setConfigApiKey("anthropic", "env-key", { envSourced: true, owner });
		expect(authStorage.hasConfigApiKey("anthropic", owner)).toBe(true);
		expect(authStorage.hasLiteralConfigApiKey("anthropic", owner)).toBe(false);

		authStorage.setConfigApiKey("anthropic", "literal-key", { owner });
		expect(authStorage.hasLiteralConfigApiKey("anthropic", owner)).toBe(true);
		expect(authStorage.hasLiteralConfigApiKey("anthropic", otherOwner)).toBe(false);
	});

	test("describeCredentialSource reports the stored credential that shadows an env-sourced override", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.set("anthropic", [{ type: "api_key", key: "stored-login-key" }]);
			authStorage.setConfigApiKey("anthropic", "stale-env-key", { envSourced: true });

			expect(authStorage.describeCredentialSource("anthropic")).toContain("api_key");
		});
	});

	test("owner-scoped config reads do not cross-use same-provider registrations", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			const firstOwner = {};
			const secondOwner = {};
			const unregisteredOwner = {};
			await seedOAuth("anthropic", "oauth-global");
			authStorage.setConfigApiKey("anthropic", "first-key", { owner: firstOwner });
			authStorage.setConfigApiKey("anthropic", "second-key", { owner: secondOwner });

			expect(await authStorage.getApiKey("anthropic", undefined, { owner: firstOwner })).toBe("first-key");
			expect(await authStorage.peekApiKey("anthropic", { owner: firstOwner })).toBe("first-key");
			expect(authStorage.hasAuth("anthropic", undefined, { owner: firstOwner })).toBe(true);
			expect(authStorage.getEffectiveCredentialType("anthropic", undefined, { owner: firstOwner })).toBe("api_key");
			expect(authStorage.describeCredentialSource("anthropic", undefined, { owner: firstOwner })).toBe(
				"config override (models.yml)",
			);
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: secondOwner })).toBe("second-key");
			// A caller with no registration of its own must never borrow the latest
			// sibling owner key; it resolves the shared stored OAuth credential.
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: unregisteredOwner })).toBe("oauth-global");
			expect(await authStorage.peekApiKey("anthropic", { owner: unregisteredOwner })).toBe("oauth-global");
			expect(authStorage.hasAuth("anthropic", undefined, { owner: unregisteredOwner })).toBe(true);
			expect(authStorage.getEffectiveCredentialType("anthropic", undefined, { owner: unregisteredOwner })).toBe(
				"oauth",
			);
			authStorage.setConfigApiKey("openai-codex-device", "alias-key", { owner: firstOwner });
			expect(await authStorage.getApiKey("openai-codex", undefined, { owner: firstOwner })).toBe("alias-key");

			// Unowned callers continue to observe the latest process-wide registration.
			expect(await authStorage.getApiKey("anthropic")).toBe("second-key");
		});
	});

	test("owned fallback lookup is strict, copied by forks, and protected from stale disposers", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			const ownerA = {};
			const ownerB = {};
			const ownerWithoutFallback = {};
			const removeGlobal = authStorage.setFallbackResolver(() => "global-fallback");
			const removeA1 = authStorage.setFallbackResolver(() => "owner-a-v1", ownerA);
			const forkA = authStorage.forkConfigOwner(ownerA);
			const removeA2 = authStorage.setFallbackResolver(() => "owner-a-v2", ownerA);
			removeA1();
			const removeB1 = authStorage.setFallbackResolver(() => "owner-b-v1", ownerB);
			const removeB2 = authStorage.setFallbackResolver(() => "owner-b-v2", ownerB);
			removeB1();

			expect(await authStorage.getApiKey("anthropic", undefined, { owner: ownerA })).toBe("owner-a-v2");
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkA })).toBe("owner-a-v1");
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: ownerB })).toBe("owner-b-v2");
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: ownerWithoutFallback })).toBeUndefined();

			removeA2();
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: ownerA })).toBeUndefined();
			removeGlobal();
			removeB2();
			authStorage.releaseConfigOwner(forkA);
		});
	});

	test("forkConfigOwner captures config provenance while shared credential authorities remain live", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			const sourceOwner = {};
			const siblingOwner = {};
			authStorage.setConfigApiKey("anthropic", "source-env-key", { owner: sourceOwner, envSourced: true });
			const forkOwner = authStorage.forkConfigOwner(sourceOwner);

			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("source-env-key");
			expect(authStorage.hasConfigApiKey("anthropic", forkOwner)).toBe(true);
			expect(authStorage.hasLiteralConfigApiKey("anthropic", forkOwner)).toBe(false);

			authStorage.setConfigApiKey("anthropic", "sibling-key", { owner: siblingOwner });
			authStorage.setConfigApiKey("anthropic", "source-updated-key", { owner: sourceOwner });
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("source-env-key");
			authStorage.clearConfigApiKeys(sourceOwner);
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("source-env-key");

			await authStorage.set("anthropic", [{ type: "api_key", key: "stored-login-key-v1" }]);
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("stored-login-key-v1");
			await authStorage.set("anthropic", [{ type: "api_key", key: "stored-login-key-v2" }]);
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("stored-login-key-v2");

			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("stored-login-key-v2");
		});
	});

	test("forkConfigOwner capture and release preserve parent generations and unowned selection", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			const capturedStorage = authStorage;
			await seedOAuth("anthropic", "shared-oauth");
			authStorage.setConfigApiKey("anthropic", "unowned-key");
			const sourceOwner = {};
			authStorage.setConfigApiKey("anthropic", "source-key", { owner: sourceOwner });
			const globalKey = await authStorage.getApiKey("anthropic");
			const globalGeneration = authStorage.getGeneration();
			const providerGeneration = authStorage.getProviderConfigurationGeneration("anthropic");
			const sourceEvidence = authStorage.getProviderEvidenceGeneration("anthropic", undefined, sourceOwner);

			const forkOwner = authStorage.forkConfigOwner(sourceOwner);
			const unownedFallbackFork = authStorage.forkConfigOwner({});
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: unownedFallbackFork })).toBe(
				"unowned-key",
			);
			expect(await authStorage.getApiKey("anthropic")).toBe(globalKey);
			expect(authStorage.getGeneration()).toBe(globalGeneration);
			expect(authStorage.getProviderConfigurationGeneration("anthropic")).toBe(providerGeneration);
			expect(authStorage.getProviderEvidenceGeneration("anthropic", undefined, sourceOwner)).toBe(sourceEvidence);

			authStorage.clearConfigApiKeys(forkOwner);
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("shared-oauth");
			const localGeneration = authStorage.getProviderEvidenceGeneration("anthropic", undefined, forkOwner);
			authStorage.setConfigApiKey("anthropic", "rebuilt-source-key", { owner: forkOwner });
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("rebuilt-source-key");
			const evidenceAfterWrite = authStorage.getProviderEvidenceGeneration("anthropic", undefined, forkOwner);
			expect(evidenceAfterWrite).not.toBe(localGeneration);
			authStorage.clearConfigApiKeys(forkOwner);
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("shared-oauth");
			expect(authStorage.getProviderEvidenceGeneration("anthropic", undefined, forkOwner)).not.toBe(
				evidenceAfterWrite,
			);
			authStorage.setConfigApiKey("anthropic", "rebuilt-again-key", { owner: forkOwner });
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("rebuilt-again-key");
			expect(await authStorage.getApiKey("anthropic")).toBe(globalKey);
			authStorage.releaseConfigOwner(unownedFallbackFork);
			expect(await authStorage.getApiKey("anthropic")).toBe(globalKey);
			expect(authStorage.getGeneration()).toBe(globalGeneration);
			expect(authStorage.getProviderConfigurationGeneration("anthropic")).toBe(providerGeneration);
			expect(authStorage.getProviderEvidenceGeneration("anthropic", undefined, sourceOwner)).toBe(sourceEvidence);

			const siblingOwner = {};
			authStorage.setConfigApiKey("anthropic", "sibling-b-key", { owner: siblingOwner });
			const generationBeforeRelease = authStorage.getGeneration();
			const providerGenerationBeforeRelease = authStorage.getProviderConfigurationGeneration("anthropic");
			authStorage.releaseConfigOwner(forkOwner);
			authStorage.releaseConfigOwner(forkOwner);
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: forkOwner })).toBe("shared-oauth");
			expect(authStorage.hasConfigApiKey("anthropic", forkOwner)).toBe(false);
			expect(() => capturedStorage.setConfigApiKey("anthropic", "released-write", { owner: forkOwner })).toThrow(
				"released config owner",
			);
			expect(authStorage.getGeneration()).toBe(generationBeforeRelease);
			expect(authStorage.getProviderConfigurationGeneration("anthropic")).toBe(providerGenerationBeforeRelease);
			expect(() => capturedStorage.releaseConfigOwner(siblingOwner)).toThrow("not created by forkConfigOwner");
		});
	});

	test("forkConfigOwner isolates absent baselines and writes while shared selector masks remain active", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.set("anthropic", [
				{
					type: "oauth",
					accountId: "account-first",
					email: "first@example.com",
					access: "first-access",
					refresh: "first-refresh",
					expires: Date.now() + 60 * 60_000,
				},
				{
					type: "oauth",
					accountId: "account-second",
					email: "second@example.com",
					access: "second-access",
					refresh: "second-refresh",
					expires: Date.now() + 60 * 60_000,
				},
			]);
			const forkOwner = authStorage.forkConfigOwner({});
			const storedRows = authStorage.listCredentialInventory("anthropic");
			const secondRow = storedRows[1];
			if (!secondRow) throw new Error("Expected two stored OAuth rows");
			authStorage.acquireCredentialScope("fork-auto");
			const autoAccess = await authStorage.getApiKey("anthropic", "fork-auto", { owner: forkOwner });
			const autoCredential = authStorage.getOAuthCredential("anthropic", "fork-auto", { owner: forkOwner })?.access;
			const pinnedEmail = autoCredential === "first-access" ? "second@example.com" : "first@example.com";
			authStorage.setRuntimeCredentialSelector("anthropic", { kind: "email", value: pinnedEmail });
			expect(authStorage.getOAuthCredential("anthropic")?.access).not.toBe(autoCredential);
			authStorage.setSessionCredentialAuto("anthropic", "fork-auto");
			expect(authStorage.resolveEffectiveCredentialSelector("anthropic", "fork-auto")).toBeUndefined();
			const globalGeneration = authStorage.getGeneration();
			const providerGeneration = authStorage.getProviderConfigurationGeneration("anthropic");
			authStorage.setConfigApiKey("anthropic", "sibling-key", { owner: {} });
			expect(await authStorage.getApiKey("anthropic", "fork-auto", { owner: forkOwner })).toBe(autoAccess);

			const forkEvidence = authStorage.getProviderEvidenceGeneration("anthropic", undefined, forkOwner);
			authStorage.setConfigApiKey("anthropic", "fork-key", { owner: forkOwner });
			expect(await authStorage.getApiKey("anthropic", "fork-auto", { owner: forkOwner })).toBe("fork-key");
			await expect(authStorage.getApiKey("anthropic")).rejects.toThrow("config API key override is active");
			expect(authStorage.getGeneration()).toBe(globalGeneration + 1);
			expect(authStorage.getProviderConfigurationGeneration("anthropic")).toBe(providerGeneration + 1);
			expect(authStorage.getProviderEvidenceGeneration("anthropic", undefined, forkOwner)).not.toBe(forkEvidence);

			authStorage.removeConfigApiKey("anthropic", forkOwner);
			expect(await authStorage.getApiKey("anthropic", "fork-auto", { owner: forkOwner })).toBe(autoAccess);
			const generationAfterForkWrite = authStorage.getGeneration();
			authStorage.clearConfigApiKeys(forkOwner);
			expect(await authStorage.getApiKey("anthropic", "fork-auto", { owner: forkOwner })).toBe(autoAccess);
			expect(authStorage.getOAuthCredential("anthropic", "fork-auto", { owner: forkOwner })?.access).toBe(
				autoCredential,
			);
			expect(authStorage.getGeneration()).toBe(generationAfterForkWrite);
		});
	});

	test("owner-scoped selector guards ignore a sibling same-provider override", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			const storage = authStorage;
			await seedOAuth("anthropic", "oauth-from-broker");
			const firstOwner = {};
			const secondOwner = {};
			const row = storage.listCredentialInventory("anthropic")[0];
			if (!row) throw new Error("Expected seeded OAuth row");
			const selector = { kind: "id" as const, value: String(row.id) };
			storage.setConfigApiKey("anthropic", "second-owner-key", { owner: secondOwner });

			storage.setSessionCredentialSelector("owner-a", "anthropic", selector, firstOwner);
			expect(storage.resolveOAuthPinTarget("anthropic", selector, firstOwner).canonicalSelector).toEqual({
				kind: "id",
				value: String(row.id),
			});
			storage.switchSessionCredential("anthropic", "owner-a", selector, firstOwner);

			expect(() => authStorage!.setSessionCredentialSelector("owner-b", "anthropic", selector, secondOwner)).toThrow(
				"config API key override",
			);
			expect(() => authStorage!.resolveOAuthPinTarget("anthropic", selector, secondOwner)).toThrow(
				"override is active",
			);
			expect(() => authStorage!.switchSessionCredential("anthropic", "owner-b", selector, secondOwner)).toThrow(
				"config API key override",
			);

			// Unowned callers retain process-wide override semantics.
			expect(() => authStorage!.setSessionCredentialSelector("global", "anthropic", selector)).toThrow(
				"config API key override",
			);

			// A registry's own override still takes precedence over its selector.
			authStorage.setConfigApiKey("anthropic", "first-owner-key", { owner: firstOwner });
			expect(() => authStorage!.setSessionCredentialSelector("owner-a", "anthropic", selector, firstOwner)).toThrow(
				"config API key override",
			);
		});
	});

	test("owner-aware import preflight ignores sibling overrides but preserves omitted-owner global semantics", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			const ownerA = {};
			const ownerB = {};
			authStorage.setConfigApiKey("anthropic", "owner-a-key", { owner: ownerA });

			const ownerBImport = await authStorage.importCredentialIfAbsent(
				"anthropic",
				{
					type: "oauth",
					access: "owner-b-access",
					refresh: "owner-b-refresh",
					expires: Date.now() + 60 * 60_000,
				},
				ownerB,
			);
			expect(ownerBImport).toMatchObject({ inserted: true, reason: "inserted", provider: "anthropic" });
			expect(await authStorage.getApiKey("anthropic", undefined, { owner: ownerB })).toBe("owner-b-access");

			const omittedOwnerImport = await authStorage.importCredentialIfAbsent("anthropic", {
				type: "oauth",
				access: "omitted-owner-access",
				refresh: "omitted-owner-refresh",
				expires: Date.now() + 60 * 60_000,
			});
			expect(omittedOwnerImport).toMatchObject({
				inserted: false,
				reason: "skipped-existing-config",
				provider: "anthropic",
			});
			expect(await authStorage.getApiKey("anthropic")).toBe("owner-a-key");
		});
	});
});
