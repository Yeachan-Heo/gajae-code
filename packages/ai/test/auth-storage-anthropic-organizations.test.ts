import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "../src/auth-storage";
import { claudeUsageProvider } from "../src/usage/claude";

const EMAIL = "user@example.com";
const ACCOUNT = "account-uuid";
const TEAM = { uuid: "org-team", name: "Acme Team" };
const PERSONAL = { uuid: "org-personal", name: "Personal Max" };

const originalFetch = global.fetch;

function tokenResponse(organization: { uuid: string; name: string } | undefined, suffix: string): Response {
	return new Response(
		JSON.stringify({
			access_token: `access-${suffix}`,
			refresh_token: `refresh-${suffix}`,
			expires_in: 3600,
			account: { uuid: ACCOUNT, email_address: EMAIL },
			...(organization ? { organization } : {}),
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function readRows(dbPath: string): Array<{ id: number; identity_key: string | null; disabled_cause: string | null }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT id, identity_key, disabled_cause FROM auth_credentials WHERE provider = 'anthropic' ORDER BY id",
			)
			.all() as Array<{ id: number; identity_key: string | null; disabled_cause: string | null }>;
	} finally {
		db.close();
	}
}

describe("AuthStorage anthropic organizations", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-anthropic-orgs-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsageProvider : undefined),
			// Resolve per call: each test swaps `global.fetch` after construction.
			usageFetch: ((input: string | URL | Request, init?: RequestInit) => global.fetch(input, init)) as typeof fetch,
		});
	});

	afterEach(async () => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function login(organization: { uuid: string; name: string } | undefined, suffix: string): Promise<void> {
		global.fetch = vi.fn(async () => tokenResponse(organization, suffix)) as unknown as typeof fetch;
		await authStorage.login(
			"anthropic",
			{
				onAuth: () => {},
				onPrompt: async () => "",
				onManualCodeInput: async () => `code-${suffix}`,
			},
			{ manualCode: true },
		);
	}

	function activeOrganizations(): Array<string | undefined> {
		return store
			.listAuthCredentials("anthropic")
			.map(entry => (entry.credential.type === "oauth" ? entry.credential.organizationId : undefined));
	}

	it("keeps one credential per organization for the same account", async () => {
		await login(TEAM, "team");
		await login(PERSONAL, "personal");

		expect(activeOrganizations()).toEqual([TEAM.uuid, PERSONAL.uuid]);
		expect(readRows(dbPath).map(row => row.identity_key)).toEqual([
			`email:${EMAIL}|org:${TEAM.uuid}`,
			`email:${EMAIL}|org:${PERSONAL.uuid}`,
		]);
		const names = store
			.listAuthCredentials("anthropic")
			.map(entry => (entry.credential.type === "oauth" ? entry.credential.organizationName : undefined));
		expect(names).toEqual([TEAM.name, PERSONAL.name]);
	});

	it("replaces the credential when the same organization logs in again", async () => {
		await login(TEAM, "team-1");
		await login(PERSONAL, "personal");
		await login(TEAM, "team-2");

		const active = store.listAuthCredentials("anthropic");
		expect(active).toHaveLength(2);
		const team = active.find(
			entry => entry.credential.type === "oauth" && entry.credential.organizationId === TEAM.uuid,
		);
		expect(team?.credential.type === "oauth" ? team.credential.access : undefined).toBe("access-team-2");
		expect(readRows(dbPath)[0]?.disabled_cause).toBeNull();
	});

	describe("a row stored before organizations were tracked", () => {
		const legacy: OAuthCredential = {
			type: "oauth",
			access: "access-legacy",
			refresh: "refresh-legacy",
			expires: Date.now() + 60_000,
			accountId: ACCOUNT,
			email: EMAIL,
		};

		async function seedLegacyThenLogin(organization: { uuid: string; name: string }): Promise<number> {
			const [stored] = store.upsertAuthCredentialForProvider("anthropic", legacy);
			await authStorage.reload();
			await login(organization, "login");
			expect(readRows(dbPath).map(row => row.identity_key)).toEqual([
				`email:${EMAIL}`,
				`email:${EMAIL}|org:${organization.uuid}`,
			]);
			return stored?.id ?? -1;
		}

		async function refreshLegacyCredential(
			legacyId: number,
			organization: { uuid: string; name: string },
			suffix: string,
		): Promise<void> {
			const expired = { ...legacy, expires: Date.now() - 60_000 };
			store.updateAuthCredential(legacyId, expired);
			await authStorage.reload();
			global.fetch = vi.fn(async () => tokenResponse(organization, suffix)) as unknown as typeof fetch;
			await authStorage.forceRefreshOAuthCredential("anthropic", expired);
		}

		it("refreshes a legacy row into a different organization without replacing the known one", async () => {
			const legacyId = await seedLegacyThenLogin(TEAM);
			await refreshLegacyCredential(legacyId, PERSONAL, "legacy-personal");

			expect(activeOrganizations()).toEqual([PERSONAL.uuid, TEAM.uuid]);
		});

		it("deduplicates a legacy row immediately when refresh names the same organization", async () => {
			const legacyId = await seedLegacyThenLogin(TEAM);
			await refreshLegacyCredential(legacyId, TEAM, "legacy-team");

			const active = store.listAuthCredentials("anthropic");
			expect(active).toHaveLength(1);
			expect(active[0]?.id).toBe(legacyId);
			expect(active[0]?.credential.type === "oauth" ? active[0].credential.access : undefined).toBe(
				"access-legacy-team",
			);
		});
	});

	it("still replaces by account when the token response carries no organization", async () => {
		await login(undefined, "first");
		await login(undefined, "second");

		const active = store.listAuthCredentials("anthropic");
		expect(active).toHaveLength(1);
		expect(active[0]?.credential.type === "oauth" ? active[0].credential.access : undefined).toBe("access-second");
	});

	it("switches a session by organization id or name", async () => {
		await login(TEAM, "team");
		await login(PERSONAL, "personal");
		const [teamRow, personalRow] = store.listAuthCredentials("anthropic");

		authStorage.switchSessionCredential("anthropic", "session-1", { kind: "org", value: "personal max" });
		expect(authStorage.getSessionCredentialRowId("anthropic", "session-1")).toBe(personalRow?.id);

		authStorage.switchSessionCredential("anthropic", "session-1", { kind: "org", value: TEAM.uuid });
		expect(authStorage.getSessionCredentialRowId("anthropic", "session-1")).toBe(teamRow?.id);

		expect(() =>
			authStorage.switchSessionCredential("anthropic", "session-1", { kind: "org", value: "unknown" }),
		).toThrow(/matching org:unknown/);
	});

	it("pins by organization while an email selector is ambiguous", async () => {
		await login(TEAM, "team");
		await login(PERSONAL, "personal");
		const personalRow = store.listAuthCredentials("anthropic")[1];

		expect(authStorage.resolveOAuthPinTarget("anthropic", { kind: "org", value: PERSONAL.name })).toEqual({
			credentialId: personalRow?.id,
			canonicalSelector: { kind: "id", value: String(personalRow?.id) },
		});
		expect(() => authStorage.resolveOAuthPinTarget("anthropic", { kind: "email", value: EMAIL })).toThrow(
			/matches multiple OAuth credentials/,
		);
	});

	describe("removing a row while a session is pinned by the shared email", () => {
		const emailSelector = { kind: "email", value: EMAIL } as const;

		async function pinByEmail(): Promise<{ teamId: number; personalId: number }> {
			await login(TEAM, "team");
			await login(PERSONAL, "personal");
			const [team, personal] = store.listAuthCredentials("anthropic");
			authStorage.setSessionCredentialSelector("session-1", "anthropic", emailSelector);
			// An email selector resolves to the first matching row, here the Team organization.
			expect(authStorage.getOAuthCredential("anthropic", "session-1")?.organizationId).toBe(TEAM.uuid);
			return { teamId: team!.id, personalId: personal!.id };
		}

		function removeHard(id: number): void {
			const targets = authStorage.listCredentialRemovalTargets("anthropic").filter(target => target.id === id);
			expect(authStorage.removeAuthCredentialsHard("anthropic", targets).kind).toBe("removed");
		}

		it("keeps the pin when the disabled row is not the one it selects", async () => {
			const { personalId } = await pinByEmail();

			authStorage.disableCredentialById(personalId, "disabled in test");

			expect(authStorage.hasSessionCredentialUnavailable("anthropic", "session-1")).toBe(false);
			expect(authStorage.getOAuthCredential("anthropic", "session-1")?.organizationId).toBe(TEAM.uuid);
		});

		it("marks the pin unavailable when the disabled row is the one it selects", async () => {
			const { teamId } = await pinByEmail();

			authStorage.disableCredentialById(teamId, "disabled in test");

			expect(authStorage.hasSessionCredentialUnavailable("anthropic", "session-1")).toBe(true);
		});

		it("keeps the pin when a hard-removed row is not the one it selects", async () => {
			const { personalId } = await pinByEmail();

			removeHard(personalId);

			expect(authStorage.hasSessionCredentialSelector("anthropic", "session-1")).toBe(true);
			expect(authStorage.getOAuthCredential("anthropic", "session-1")?.organizationId).toBe(TEAM.uuid);
		});

		it("clears the pin when the hard-removed row is the one it selects", async () => {
			const { teamId } = await pinByEmail();

			removeHard(teamId);

			expect(authStorage.hasSessionCredentialSelector("anthropic", "session-1")).toBe(false);
		});
	});

	describe("organization selectors that designate more than one row", () => {
		const SHARED_NAME = "Acme";
		const FIRST = { uuid: "org-first", name: SHARED_NAME };
		const SECOND = { uuid: "org-second", name: SHARED_NAME };

		it("rejects a shared organization name instead of using the first row, on every selection path", async () => {
			await login(FIRST, "first");
			await login(SECOND, "second");
			const ids = store.listAuthCredentials("anthropic").map(entry => entry.id);
			expect(ids).toHaveLength(2);
			const selector = { kind: "org", value: SHARED_NAME } as const;
			const ambiguous = new RegExp(`matches multiple .*ids: ${ids.join(", ")}`);

			expect(() => authStorage.switchSessionCredential("anthropic", "session-1", selector)).toThrow(ambiguous);
			expect(authStorage.getSessionCredentialRowId("anthropic", "session-1")).toBeUndefined();
			expect(() => authStorage.setSessionCredentialSelector("session-1", "anthropic", selector)).toThrow(ambiguous);
			expect(() => authStorage.setRuntimeCredentialSelector("anthropic", selector)).toThrow(ambiguous);
			expect(() => authStorage.setRuntimePreferredCredentialSelector("anthropic", selector)).toThrow(ambiguous);
			expect(() => authStorage.resolveOAuthPinTarget("anthropic", selector)).toThrow(/matches multiple/);
		});

		it("selects by exact organization id even when that id is also another organization's name", async () => {
			await login(FIRST, "first");
			await login({ uuid: "org-named-like-an-id", name: FIRST.uuid }, "impostor");
			const [firstRow] = store.listAuthCredentials("anthropic");
			const selector = { kind: "org", value: FIRST.uuid } as const;

			authStorage.switchSessionCredential("anthropic", "session-1", selector);
			expect(authStorage.getSessionCredentialRowId("anthropic", "session-1")).toBe(firstRow?.id);
			expect(authStorage.resolveOAuthPinTarget("anthropic", selector).credentialId).toBe(firstRow?.id);
		});

		it("fails a pinned selector at request time once a later login makes it ambiguous", async () => {
			await login(FIRST, "first");
			authStorage.setRuntimeCredentialSelector("anthropic", { kind: "org", value: SHARED_NAME });
			expect(authStorage.getOAuthCredential("anthropic", "session-1")?.access).toBe("access-first");

			await login(SECOND, "second");
			await expect(authStorage.getApiKey("anthropic", "session-1")).rejects.toThrow(/matches multiple/);
		});
	});

	it("labels each organization's credential in the inventory", async () => {
		await login(TEAM, "team");
		await login(PERSONAL, "personal");

		expect(authStorage.listCredentialInventory("anthropic").map(row => row.identityLabel)).toEqual([
			`${EMAIL} (${TEAM.name})`,
			`${EMAIL} (${PERSONAL.name})`,
		]);
	});

	it("reports usage per organization instead of merging the shared account", async () => {
		await login(TEAM, "team");
		await login(PERSONAL, "personal");
		const utilizationByToken: Record<string, number> = { "Bearer access-team": 80, "Bearer access-personal": 5 };
		global.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const authorization = new Headers(init?.headers).get("authorization") ?? "";
			const utilization = utilizationByToken[authorization];
			if (utilization === undefined) return new Response("unauthorized", { status: 401 });
			return new Response(
				JSON.stringify({
					five_hour: { utilization, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
					seven_day: { utilization: 1, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const reports = (await authStorage.fetchUsageReports())?.filter(report => report.provider === "anthropic") ?? [];
		const byOrganization = Object.fromEntries(
			reports.map(report => [
				report.metadata?.orgId,
				report.limits.find(limit => limit.id === "anthropic:5h")?.amount.used,
			]),
		);
		expect(byOrganization).toEqual({ [TEAM.uuid]: 80, [PERSONAL.uuid]: 5 });
	});
});
