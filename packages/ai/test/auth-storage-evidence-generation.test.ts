import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/utils/oauth";

const SOURCE_ID = "auth-storage-evidence-generation-test";

describe("AuthStorage provider evidence generation", () => {
	let tempDir = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-evidence-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		unregisterOAuthProviders(SOURCE_ID);
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("keeps evidence stable before and after resolving a runtime override", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-runtime-override-evidence";
		const firstKey = "runtime-evidence-key-a";
		authStorage.setRuntimeApiKey(provider, firstKey);

		const beforeResolution = authStorage.getProviderEvidenceGeneration(provider);
		await expect(authStorage.getApiKey(provider)).resolves.toBe(firstKey);
		expect(authStorage.getProviderEvidenceGeneration(provider, firstKey)).toBe(beforeResolution);

		const secondKey = "runtime-evidence-key-b";
		authStorage.setRuntimeApiKey(provider, secondKey);
		const afterRotation = authStorage.getProviderEvidenceGeneration(provider);
		expect(afterRotation).not.toBe(beforeResolution);
		expect(authStorage.getProviderEvidenceGeneration(provider, secondKey)).toBe(afterRotation);
	});

	test("keeps owner-scoped config evidence stable before and after resolving its override", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-owner-config-override-evidence";
		const owner = {};
		const firstKey = "owner-config-evidence-key-a";
		authStorage.setConfigApiKey(provider, firstKey, { owner });

		const beforeResolution = authStorage.getProviderEvidenceGeneration(provider, undefined, owner);
		await expect(authStorage.getApiKey(provider, undefined, { owner })).resolves.toBe(firstKey);
		expect(authStorage.getProviderEvidenceGeneration(provider, firstKey, owner)).toBe(beforeResolution);

		const secondKey = "owner-config-evidence-key-b";
		authStorage.setConfigApiKey(provider, secondKey, { owner });
		const afterRotation = authStorage.getProviderEvidenceGeneration(provider, undefined, owner);
		expect(afterRotation).not.toBe(beforeResolution);
		expect(authStorage.getProviderEvidenceGeneration(provider, secondKey, owner)).toBe(afterRotation);
	});

	test("isolates owned fallback evidence, copies it on fork, and rejects stale disposers", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-owned-fallback-evidence";
		const ownerA = {};
		const ownerB = {};
		const ownerWithoutFallback = {};
		const ownerLateFallback = {};
		const aliasOwner = {};
		authStorage.setFallbackResolver(() => "unowned-fallback", undefined);
		authStorage.setFallbackResolver(() => "owner-a-v1", ownerA);
		const forked = authStorage.forkConfigOwner(ownerA);
		const ownerAConfiguration = authStorage.getProviderConfigurationGeneration(provider, ownerA);
		const ownerAEvidence = authStorage.getProviderEvidenceGeneration(provider, "owner-a-v1", ownerA);
		const oldDisposer = authStorage.setFallbackResolver(() => "owner-b-v1", ownerB);
		authStorage.setFallbackResolver(() => "owner-b-v2", ownerB);
		oldDisposer();

		expect(await authStorage.getApiKey(provider, undefined, { owner: ownerA })).toBe("owner-a-v1");
		expect(await authStorage.getApiKey(provider, undefined, { owner: ownerB })).toBe("owner-b-v2");
		expect(await authStorage.getApiKey(provider, undefined, { owner: ownerWithoutFallback })).toBeUndefined();
		expect(await authStorage.getApiKey(provider, undefined, { owner: forked })).toBe("owner-a-v1");
		const lateAbsent = authStorage.getProviderConfigurationGeneration(provider, ownerLateFallback);
		expect(await authStorage.getApiKey(provider, undefined, { owner: ownerLateFallback })).toBeUndefined();
		const installLateFallback = authStorage.setFallbackResolver(() => "late-owner-key", ownerLateFallback);
		expect(authStorage.getProviderConfigurationGeneration(provider, ownerLateFallback)).not.toBe(lateAbsent);
		expect(await authStorage.getApiKey(provider, undefined, { owner: ownerLateFallback })).toBe("late-owner-key");
		const removeLateFallback = authStorage.setFallbackResolver(() => "late-owner-reinstalled", ownerLateFallback);
		installLateFallback();
		expect(await authStorage.getApiKey(provider, undefined, { owner: ownerLateFallback })).toBe(
			"late-owner-reinstalled",
		);
		removeLateFallback();
		expect(await authStorage.getApiKey(provider, undefined, { owner: ownerLateFallback })).toBeUndefined();
		const absentAgain = authStorage.getProviderConfigurationGeneration(provider, ownerLateFallback);
		const reinstallLateFallback = authStorage.setFallbackResolver(() => "late-owner-final", ownerLateFallback);
		expect(authStorage.getProviderConfigurationGeneration(provider, ownerLateFallback)).not.toBe(absentAgain);
		installLateFallback();
		expect(await authStorage.getApiKey(provider, undefined, { owner: ownerLateFallback })).toBe("late-owner-final");
		reinstallLateFallback();
		authStorage.setFallbackResolver(() => "canonical-codex-key", aliasOwner);
		expect(await authStorage.getApiKey("openai-codex-device", undefined, { owner: aliasOwner })).toBe(
			"canonical-codex-key",
		);
		expect(await authStorage.getApiKey("openai-codex", undefined, { owner: aliasOwner })).toBe("canonical-codex-key");
		expect(authStorage.getProviderEvidenceGeneration("openai-codex-device", "canonical-codex-key", aliasOwner)).toBe(
			authStorage.getProviderEvidenceGeneration("openai-codex", "canonical-codex-key", aliasOwner),
		);
		expect(authStorage.getProviderConfigurationGeneration("openai-codex-device", aliasOwner)).toBe(
			authStorage.getProviderConfigurationGeneration("openai-codex", aliasOwner),
		);
		expect(authStorage.getProviderEvidenceGeneration(provider, "owner-a-v1", ownerA)).toBe(ownerAEvidence);
		expect(authStorage.getProviderConfigurationGeneration(provider, ownerA)).toBe(ownerAConfiguration);
		expect(authStorage.getProviderEvidenceGeneration(provider, "owner-b-v2", ownerB)).not.toBe(ownerAEvidence);

		const replaceOwnerA = authStorage.setFallbackResolver(() => "owner-a-v2", ownerA);
		expect(authStorage.getProviderConfigurationGeneration(provider, ownerA)).not.toBe(ownerAConfiguration);
		expect(await authStorage.getApiKey(provider, undefined, { owner: ownerA })).toBe("owner-a-v2");
		expect(await authStorage.getApiKey(provider, undefined, { owner: forked })).toBe("owner-a-v1");
		replaceOwnerA();
		expect(await authStorage.getApiKey(provider, undefined, { owner: ownerA })).toBeUndefined();
		const forkBeforeRelease = authStorage.getProviderEvidenceGeneration(provider, "owner-a-v1", forked);
		authStorage.releaseConfigOwner(forked);
		expect(authStorage.getProviderEvidenceGeneration(provider, "owner-a-v1", forked)).not.toBe(forkBeforeRelease);
		expect(await authStorage.getApiKey(provider, undefined, { owner: forked })).toBeUndefined();
	});

	test("owned config changes preserve sibling evidence while shared row replacement invalidates it", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-owned-shared-row-evidence";
		const ownerA = {};
		const ownerB = {};
		authStorage.setConfigApiKey(provider, "owner-a-key", { owner: ownerA });
		const evidenceA = authStorage.getProviderEvidenceGeneration(provider, undefined, ownerA);
		const configurationA = authStorage.getProviderConfigurationGeneration(provider, ownerA);
		authStorage.setConfigApiKey(provider, "owner-b-key", { owner: ownerB });
		expect(authStorage.getProviderEvidenceGeneration(provider, undefined, ownerA)).toBe(evidenceA);
		expect(authStorage.getProviderConfigurationGeneration(provider, ownerA)).toBe(configurationA);

		await authStorage.set(provider, [{ type: "api_key", key: "shared-row-key" }]);
		expect(authStorage.getProviderEvidenceGeneration(provider, undefined, ownerA)).not.toBe(evidenceA);
		expect(authStorage.getProviderConfigurationGeneration(provider, ownerA)).not.toBe(configurationA);
	});

	test("shares stored command resolution across owner config changes but fences row replacement", async () => {
		if (!store) throw new Error("test setup failed");
		store.close();
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const shared = Promise.withResolvers<string | undefined>();
		const stale = Promise.withResolvers<string | undefined>();
		const current = Promise.withResolvers<string | undefined>();
		const matching = Promise.withResolvers<string | undefined>();
		const sharedStarted = Promise.withResolvers<void>();
		const staleStarted = Promise.withResolvers<void>();
		const matchingStarted = Promise.withResolvers<void>();
		let sharedCalls = 0;
		let staleCalls = 0;
		let currentCalls = 0;
		authStorage = new AuthStorage(store, {
			configValueResolver: async config => {
				if (config === "!shared-command-shared") {
					sharedCalls += 1;
					sharedStarted.resolve();
					return shared.promise;
				}
				if (config === "!shared-command-stale") {
					staleCalls += 1;
					staleStarted.resolve();
					return stale.promise;
				}
				if (config === "!shared-command-current") {
					currentCalls += 1;
					return current.promise;
				}
				if (config === "!shared-command-matching") {
					matchingStarted.resolve();
					return matching.promise;
				}
				return undefined;
			},
		});
		const provider = "unit-shared-command-owner-fence";
		const ownerA = {};
		const ownerB = {};
		await authStorage.set(provider, [{ type: "api_key", key: "!shared-command-shared" }]);
		const first = authStorage.getApiKey(provider, undefined, { owner: ownerA });
		await sharedStarted.promise;
		const joined = authStorage.getApiKey(provider, undefined, { owner: ownerB });
		authStorage.setConfigApiKey(provider, "owner-b-pending-config", { owner: ownerB });
		authStorage.setFallbackResolver(() => "owner-b-fallback", ownerB);
		shared.resolve("shared-command-result");
		expect(await Promise.all([first, joined])).toEqual(["shared-command-result", "shared-command-result"]);
		expect(sharedCalls).toBe(1);
		authStorage.removeConfigApiKey(provider, ownerB);

		await authStorage.set(provider, [{ type: "api_key", key: "!shared-command-stale" }]);
		const staleResult = authStorage.getApiKey(provider, undefined, { owner: ownerA });
		await staleStarted.promise;
		await authStorage.set(provider, [{ type: "api_key", key: "!shared-command-current" }]);
		const fresh = authStorage.getApiKey(provider, undefined, { owner: ownerA });
		expect(currentCalls).toBe(1);
		stale.resolve("stale-command-result");
		expect(await staleResult).toBeUndefined();
		current.resolve("current-command-result");
		expect(await fresh).toBe("current-command-result");
		expect(staleCalls).toBe(1);

		await authStorage.set(provider, [{ type: "api_key", key: "!shared-command-matching" }]);
		const invalidate = authStorage.invalidateCredentialMatching(provider, "matching-command-result");
		await matchingStarted.promise;
		await authStorage.set(provider, [{ type: "api_key", key: "replacement-row" }]);
		matching.resolve("matching-command-result");
		expect(await invalidate).toBe(false);
	});

	test("keeps evidence stable before and after resolving an environment key", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const previousKey = Bun.env.OPENAI_API_KEY;
		const key = "environment-evidence-key";
		Bun.env.OPENAI_API_KEY = key;
		try {
			const beforeResolution = authStorage.getProviderEvidenceGeneration("openai");
			await expect(authStorage.getApiKey("openai")).resolves.toBe(key);
			expect(authStorage.getProviderEvidenceGeneration("openai", key)).toBe(beforeResolution);
		} finally {
			if (previousKey === undefined) delete Bun.env.OPENAI_API_KEY;
			else Bun.env.OPENAI_API_KEY = previousKey;
		}
	});

	test("keeps evidence stable when an OAuth token refreshes in place", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-refresh";
		registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Evidence Refresh",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: "access-after-refresh",
					refresh: "refresh-after-refresh",
					expires: Date.now() + 60 * 60_000,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "access-before-refresh",
				refresh: "refresh-before-refresh",
				expires: Date.now() + 30_000,
				email: "refresh@example.com",
			},
		]);
		const evidenceBefore = authStorage.getProviderEvidenceGeneration(provider);
		const configurationBefore = authStorage.getProviderConfigurationGeneration(provider);

		await expect(authStorage.getApiKey(provider, "evidence-session")).resolves.toBe("access-after-refresh");

		// Rotation for a known account does not bump configuration, so there is nothing for callers to discount.
		expect(authStorage.getProviderOAuthRefreshGeneration(provider)).toBe(0);
		expect(authStorage.getProviderEvidenceGeneration(provider)).toBe(evidenceBefore);
		expect(authStorage.getProviderConfigurationGeneration(provider)).toBe(configurationBefore);
	});

	test("keeps evidence stable when a store reload rotates tokens for the same account", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-reload";
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "snapshot-access-1",
				refresh: "snapshot-refresh-1",
				expires: Date.now() + 30_000,
				email: "reload@example.com",
			},
		]);
		const [row] = store.listAuthCredentials(provider);
		if (row?.credential.type !== "oauth") throw new Error("expected stored oauth row");
		const evidenceBefore = authStorage.getProviderEvidenceGeneration(provider);
		const configurationBefore = authStorage.getProviderConfigurationGeneration(provider);
		let notifications = 0;
		const unsubscribe = authStorage.onGenerationChanged(() => {
			notifications += 1;
		});

		store.updateAuthCredential(row.id, {
			...row.credential,
			access: "snapshot-access-2",
			refresh: "snapshot-refresh-2",
			expires: Date.now() + 2 * 60 * 60_000,
		});
		await authStorage.reload();
		unsubscribe();

		expect(notifications).toBe(1);
		expect(authStorage.getProviderEvidenceGeneration(provider)).toBe(evidenceBefore);
		expect(authStorage.getProviderConfigurationGeneration(provider)).toBe(configurationBefore);
	});

	test("keeps evidence stable for a structured OAuth key when the same account's token rotates", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-structured";
		const structuredKey = (access: string, expires: number) =>
			JSON.stringify({
				token: access,
				projectId: "structured-project",
				refreshToken: `${access}-refresh`,
				expiresAt: expires,
			});
		const firstExpires = Date.now() + 60 * 60_000;
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "structured-access-1",
				refresh: "structured-access-1-refresh",
				expires: firstExpires,
				email: "structured@example.com",
				projectId: "structured-project",
			},
		]);
		const [row] = store.listAuthCredentials(provider);
		if (row?.credential.type !== "oauth") throw new Error("expected stored oauth row");
		const evidenceBefore = authStorage.getProviderEvidenceGeneration(
			provider,
			structuredKey("structured-access-1", firstExpires),
		);

		const secondExpires = Date.now() + 2 * 60 * 60_000;
		store.updateAuthCredential(row.id, {
			...row.credential,
			access: "structured-access-2",
			refresh: "structured-access-2-refresh",
			expires: secondExpires,
		});
		await authStorage.reload();

		expect(
			authStorage.getProviderEvidenceGeneration(provider, structuredKey("structured-access-2", secondExpires)),
		).toBe(evidenceBefore);
	});

	test("changes evidence when a reload swaps the OAuth account", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-account";
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "account-a-access",
				refresh: "account-a-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "account-a@example.com",
			},
		]);
		const [row] = store.listAuthCredentials(provider);
		if (row?.credential.type !== "oauth") throw new Error("expected stored oauth row");
		const evidenceBefore = authStorage.getProviderEvidenceGeneration(provider);

		store.updateAuthCredential(row.id, {
			...row.credential,
			access: "account-b-access",
			refresh: "account-b-refresh",
			email: "account-b@example.com",
		});
		await authStorage.reload();

		expect(authStorage.getProviderEvidenceGeneration(provider)).not.toBe(evidenceBefore);
	});

	test("changes evidence when an OAuth credential without identity rotates", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-anonymous";
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "anonymous-access-1",
				refresh: "anonymous-refresh-1",
				expires: Date.now() + 60 * 60_000,
			},
		]);
		const [row] = store.listAuthCredentials(provider);
		if (row?.credential.type !== "oauth") throw new Error("expected stored oauth row");
		const evidenceBefore = authStorage.getProviderEvidenceGeneration(provider);

		store.updateAuthCredential(row.id, {
			...row.credential,
			access: "anonymous-access-2",
			refresh: "anonymous-refresh-2",
			expires: Date.now() + 2 * 60 * 60_000,
		});
		await authStorage.reload();

		expect(authStorage.getProviderEvidenceGeneration(provider)).not.toBe(evidenceBefore);
	});

	test("changes evidence when the OAuth credential is removed", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-removal";
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "removal-access",
				refresh: "removal-access-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "removal@example.com",
			},
		]);
		const evidenceBefore = authStorage.getProviderEvidenceGeneration(provider);

		await authStorage.set(provider, []);

		expect(authStorage.getProviderEvidenceGeneration(provider)).not.toBe(evidenceBefore);
	});

	test("changes evidence and bumps configuration when the OAuth project changes for the same account", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-project";
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "project-access",
				refresh: "project-access-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "project@example.com",
				projectId: "project-a",
			},
		]);
		const [row] = store.listAuthCredentials(provider);
		if (row?.credential.type !== "oauth") throw new Error("expected stored oauth row");
		const evidenceBefore = authStorage.getProviderEvidenceGeneration(provider);
		const configurationBefore = authStorage.getProviderConfigurationGeneration(provider);

		store.updateAuthCredential(row.id, { ...row.credential, projectId: "project-b" });
		await authStorage.reload();

		expect(authStorage.getProviderEvidenceGeneration(provider)).not.toBe(evidenceBefore);
		expect(authStorage.getProviderConfigurationGeneration(provider)).toBe(configurationBefore + 1);
	});

	test("advances configuration and refresh generations together when an identity-less OAuth token refreshes", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-anonymous-refresh";
		registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Evidence Anonymous Refresh",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: "anonymous-after-refresh",
					refresh: "anonymous-refresh-2",
					expires: Date.now() + 60 * 60_000,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "anonymous-before-refresh",
				refresh: "anonymous-before-refresh-refresh",
				expires: Date.now() + 30_000,
			},
		]);
		const configurationBefore = authStorage.getProviderConfigurationGeneration(provider);

		await expect(authStorage.getApiKey(provider, "anonymous-session")).resolves.toBe("anonymous-after-refresh");

		expect(authStorage.getProviderConfigurationGeneration(provider)).toBe(configurationBefore + 1);
		expect(authStorage.getProviderOAuthRefreshGeneration(provider)).toBe(1);
	});

	test("keeps evidence stable when only the OAuth row of a mixed API key and OAuth provider rotates", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-mixed";
		await authStorage.set(provider, [
			{ type: "api_key", key: "mixed-literal-key" },
			{
				type: "oauth",
				access: "mixed-access-1",
				refresh: "mixed-access-1-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "mixed@example.com",
			},
		]);
		const row = store.listAuthCredentials(provider).find(candidate => candidate.credential.type === "oauth");
		if (row?.credential.type !== "oauth") throw new Error("expected stored oauth row");
		const evidenceBefore = authStorage.getProviderEvidenceGeneration(provider);
		const configurationBefore = authStorage.getProviderConfigurationGeneration(provider);

		store.updateAuthCredential(row.id, {
			...row.credential,
			access: "mixed-access-2",
			refresh: "mixed-access-2-refresh",
			expires: Date.now() + 2 * 60 * 60_000,
		});
		await authStorage.reload();

		expect(authStorage.getProviderEvidenceGeneration(provider)).toBe(evidenceBefore);
		expect(authStorage.getProviderConfigurationGeneration(provider)).toBe(configurationBefore);
	});

	test("keeps evidence stable for a caller still holding the key resolved before rotation", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-stale-key";
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "stale-access-1",
				refresh: "stale-access-1-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "stale@example.com",
			},
		]);
		const [row] = store.listAuthCredentials(provider);
		if (row?.credential.type !== "oauth") throw new Error("expected stored oauth row");
		const evidenceBefore = authStorage.getProviderEvidenceGeneration(provider, "stale-access-1");

		store.updateAuthCredential(row.id, {
			...row.credential,
			access: "stale-access-2",
			refresh: "stale-access-2-refresh",
			expires: Date.now() + 2 * 60 * 60_000,
		});
		await authStorage.reload();

		expect(authStorage.getProviderEvidenceGeneration(provider, "stale-access-1")).toBe(evidenceBefore);
		expect(authStorage.getProviderEvidenceGeneration(provider, "stale-access-2")).toBe(evidenceBefore);
	});

	test("changes evidence when an account-backed OAuth credential expires without refreshing", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-expired";
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "expiring-access",
				refresh: "expiring-access-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "expired@example.com",
			},
		]);
		const [row] = store.listAuthCredentials(provider);
		if (row?.credential.type !== "oauth") throw new Error("expected stored oauth row");
		const evidenceBefore = authStorage.getProviderEvidenceGeneration(provider);

		store.updateAuthCredential(row.id, { ...row.credential, expires: Date.now() - 60_000 });
		await authStorage.reload();

		expect(authStorage.getProviderEvidenceGeneration(provider)).not.toBe(evidenceBefore);
	});

	test("does not map an unrelated key to the account-backed OAuth row", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-unrelated-key";
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "row-access",
				refresh: "row-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "unrelated@example.com",
			},
		]);

		expect(authStorage.getProviderEvidenceGeneration(provider, "unrelated-key")).not.toBe(
			authStorage.getProviderEvidenceGeneration(provider, "row-access"),
		);
	});

	test("does not map a structured OAuth key for another project to the row", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-structured-project";
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "project-row-access",
				refresh: "project-row-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "structured-project@example.com",
				projectId: "project-a",
			},
		]);
		const keyFor = (projectId: string) => JSON.stringify({ token: "project-row-access", projectId });

		expect(authStorage.getProviderEvidenceGeneration(provider, keyFor("project-b"))).not.toBe(
			authStorage.getProviderEvidenceGeneration(provider, keyFor("project-a")),
		);
	});

	test("does not count a refresh that also changes the OAuth project as a pure refresh", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "unit-oauth-evidence-project-refresh";
		registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Evidence Project Refresh",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60 * 60_000 };
			},
			async refreshToken(credentials) {
				return {
					...credentials,
					access: "project-refresh-access-2",
					refresh: "project-refresh-refresh-2",
					expires: Date.now() + 60 * 60_000,
					projectId: "project-after-refresh",
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		await authStorage.set(provider, [
			{
				type: "oauth",
				access: "project-refresh-access-1",
				refresh: "project-refresh-refresh-1",
				expires: Date.now() + 30_000,
				email: "project-refresh@example.com",
				projectId: "project-before-refresh",
			},
		]);
		const configurationBefore = authStorage.getProviderConfigurationGeneration(provider);

		await expect(authStorage.getApiKey(provider, "project-refresh-session")).resolves.toBe(
			"project-refresh-access-2",
		);

		expect(authStorage.getProviderConfigurationGeneration(provider)).toBe(configurationBefore + 1);
		expect(authStorage.getProviderOAuthRefreshGeneration(provider)).toBe(0);
	});
});
