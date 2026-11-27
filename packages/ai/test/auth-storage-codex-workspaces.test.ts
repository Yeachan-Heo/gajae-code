import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthStorage,
	type ConfiguredCredentialPreference,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "../src/auth-storage";
import { openaiCodexUsageProvider } from "../src/usage/openai-codex";

const EMAIL = "user@example.com";
const TEAM = { id: "ws-team", name: "Acme Team" };
const PERSONAL = { id: "ws-personal", name: "Personal" };

const originalFetch = global.fetch;

function codexAccessToken(workspaceId: string, suffix: string): string {
	const payload = {
		"https://api.openai.com/auth": { chatgpt_account_id: workspaceId },
		"https://api.openai.com/profile": { email: EMAIL },
		suffix,
	};
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function workspaceOf(accessToken: string): string | undefined {
	const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
		"https://api.openai.com/auth"?: { chatgpt_account_id?: string };
	};
	return payload["https://api.openai.com/auth"]?.chatgpt_account_id;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The ChatGPT workspace list as `wham/accounts/check` returns it: the personal workspace has no name. */
function workspaceList(): Response {
	return json({
		accounts: [
			{ id: TEAM.id, structure: "workspace", plan_type: "team", name: TEAM.name },
			{ id: PERSONAL.id, structure: "personal", plan_type: "pro", name: null },
		],
	});
}

interface CodexBackend {
	/** Workspace the next token exchange or refresh is bound to. */
	workspaceId: string;
	suffix: string;
	workspaceLookup: () => Response;
	usedPercentByWorkspace: Record<string, number>;
}

function installCodexBackend(backend: CodexBackend): void {
	global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.endsWith("/deviceauth/usercode"))
			return json({ device_auth_id: "device", user_code: "CODE", interval: 0 });
		if (url.endsWith("/deviceauth/token")) return json({ authorization_code: "code", code_verifier: "verifier" });
		if (url === "https://auth.openai.com/oauth/token") {
			return json({
				access_token: codexAccessToken(backend.workspaceId, backend.suffix),
				refresh_token: `refresh-${backend.suffix}`,
				expires_in: 3600,
			});
		}
		if (url.endsWith("/wham/accounts/check")) return backend.workspaceLookup();
		if (url.endsWith("/wham/usage")) {
			const authorization = new Headers(init?.headers).get("authorization") ?? "";
			const workspaceId = workspaceOf(authorization.replace(/^Bearer /, ""));
			const usedPercent = workspaceId ? backend.usedPercentByWorkspace[workspaceId] : undefined;
			if (usedPercent === undefined) return new Response("unauthorized", { status: 401 });
			return json({
				plan_type: "team",
				rate_limit: {
					allowed: usedPercent < 100,
					limit_reached: usedPercent >= 100,
					primary_window: { used_percent: usedPercent, limit_window_seconds: 18_000, reset_after_seconds: 600 },
					secondary_window: { used_percent: 1, limit_window_seconds: 604_800, reset_after_seconds: 6000 },
				},
			});
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
}

function readRows(dbPath: string): Array<{ id: number; identity_key: string | null }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare("SELECT id, identity_key FROM auth_credentials WHERE provider = 'openai-codex' ORDER BY id")
			.all() as Array<{ id: number; identity_key: string | null }>;
	} finally {
		db.close();
	}
}

describe("AuthStorage openai-codex workspaces", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore;
	let authStorage: AuthStorage;
	let backend: CodexBackend;

	function createStorage(preferences?: readonly ConfiguredCredentialPreference[]): AuthStorage {
		return new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "openai-codex" ? openaiCodexUsageProvider : undefined),
			// Resolve per call: each test swaps `global.fetch` after construction.
			usageFetch: ((input: string | URL | Request, init?: RequestInit) => global.fetch(input, init)) as typeof fetch,
			...(preferences ? { credentialPreferences: { "openai-codex": preferences } } : {}),
		});
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-workspaces-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = createStorage();
		backend = { workspaceId: TEAM.id, suffix: "initial", workspaceLookup: workspaceList, usedPercentByWorkspace: {} };
		installCodexBackend(backend);
		// The device flow waits between polls; the mocked backend answers immediately.
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function login(workspaceId: string, suffix: string, storage = authStorage): Promise<void> {
		backend.workspaceId = workspaceId;
		backend.suffix = suffix;
		await storage.login("openai-codex-device", { onAuth: () => {}, onPrompt: async () => "" });
	}

	function stored(): Array<{ id: number; credential: OAuthCredential }> {
		return store
			.listAuthCredentials("openai-codex")
			.flatMap(entry => (entry.credential.type === "oauth" ? [{ id: entry.id, credential: entry.credential }] : []));
	}

	it("keeps one credential per workspace of the same login, labeled by workspace", async () => {
		await login(TEAM.id, "team");
		await login(PERSONAL.id, "personal");

		expect(stored().map(({ credential }) => [credential.organizationId, credential.organizationName])).toEqual([
			[TEAM.id, TEAM.name],
			[PERSONAL.id, PERSONAL.name],
		]);
		expect(readRows(dbPath).map(row => row.identity_key)).toEqual([
			`email:${EMAIL}|org:${TEAM.id}`,
			`email:${EMAIL}|org:${PERSONAL.id}`,
		]);
		expect(authStorage.listCredentialInventory("openai-codex").map(row => row.identityLabel)).toEqual([
			`${EMAIL} (${TEAM.name})`,
			`${EMAIL} (${PERSONAL.name})`,
		]);
	});

	it("replaces only the matching workspace when it logs in again", async () => {
		await login(TEAM.id, "team-1");
		await login(PERSONAL.id, "personal");
		await login(TEAM.id, "team-2");

		const rows = stored();
		expect(rows).toHaveLength(2);
		expect(rows.find(row => row.credential.organizationId === TEAM.id)?.credential.refresh).toBe("refresh-team-2");
		expect(rows.find(row => row.credential.organizationId === PERSONAL.id)?.credential.refresh).toBe(
			"refresh-personal",
		);
	});

	it("stores the workspace id when the workspace name lookup fails", async () => {
		backend.workspaceLookup = () => new Response("unavailable", { status: 503 });
		await login(TEAM.id, "team");
		backend.workspaceLookup = () => {
			throw new Error("network down");
		};
		await login(PERSONAL.id, "personal");

		expect(stored().map(({ credential }) => [credential.organizationId, credential.organizationName])).toEqual([
			[TEAM.id, undefined],
			[PERSONAL.id, undefined],
		]);
	});

	it("refreshes without the workspace lookup and keeps the stored workspace name", async () => {
		await login(TEAM.id, "team");
		const [team] = stored();
		if (!team) throw new Error("team row missing");
		const generationBefore = authStorage.getProviderConfigurationGeneration("openai-codex");
		// A lookup that never answers must not hold up a refresh that has already rotated the refresh token.
		let lookups = 0;
		backend.workspaceLookup = () => {
			lookups += 1;
			return new Promise<Response>(() => {}) as unknown as Response;
		};
		backend.suffix = "team-refreshed";

		await authStorage.forceRefreshOAuthCredential("openai-codex", team.credential);

		expect(lookups).toBe(0);
		const [refreshed] = stored();
		expect(refreshed?.credential.refresh).toBe("refresh-team-refreshed");
		expect([refreshed?.credential.organizationId, refreshed?.credential.organizationName]).toEqual([
			TEAM.id,
			TEAM.name,
		]);
		expect(readRows(dbPath).map(row => row.identity_key)).toEqual([`email:${EMAIL}|org:${TEAM.id}`]);
		// Token rotation for a known workspace is not a configuration change.
		expect(authStorage.getProviderConfigurationGeneration("openai-codex")).toBe(generationBefore);
	});

	it("pins and switches by workspace name while the shared email is ambiguous", async () => {
		await login(TEAM.id, "team");
		await login(PERSONAL.id, "personal");
		const [teamRow, personalRow] = stored();

		expect(authStorage.resolveOAuthPinTarget("openai-codex", { kind: "org", value: "personal" }).credentialId).toBe(
			personalRow?.id,
		);
		expect(() => authStorage.resolveOAuthPinTarget("openai-codex", { kind: "email", value: EMAIL })).toThrow(
			/matches multiple OAuth credentials/,
		);
		authStorage.switchSessionCredential("openai-codex", "session-1", { kind: "org", value: TEAM.name });
		expect(authStorage.getSessionCredentialRowId("openai-codex", "session-1")).toBe(teamRow?.id);
	});

	it("reports usage per workspace instead of merging the shared email", async () => {
		await login(TEAM.id, "team");
		await login(PERSONAL.id, "personal");
		backend.usedPercentByWorkspace = { [TEAM.id]: 80, [PERSONAL.id]: 5 };

		const reports =
			(await authStorage.fetchUsageReports())?.filter(report => report.provider === "openai-codex") ?? [];
		const byWorkspace = Object.fromEntries(
			reports.map(report => [
				report.metadata?.orgId,
				report.limits.find(limit => limit.id === "openai-codex:primary")?.amount.usedFraction,
			]),
		);
		expect(byWorkspace).toEqual({ [TEAM.id]: 0.8, [PERSONAL.id]: 0.05 });
	});

	async function preferTeamThenPersonal(): Promise<AuthStorage> {
		await login(TEAM.id, "team");
		await login(PERSONAL.id, "personal");
		const preferred = createStorage([
			{ selector: { kind: "org", value: TEAM.id } },
			{ selector: { kind: "org", value: PERSONAL.id } },
		]);
		await preferred.reload();
		return preferred;
	}

	it("uses the preferred workspace ahead of a less-used one, then the next one after a quota failure", async () => {
		const preferred = await preferTeamThenPersonal();
		// Balanced ranking alone would pick the less-used personal workspace.
		backend.usedPercentByWorkspace = { [TEAM.id]: 40, [PERSONAL.id]: 5 };

		expect(workspaceOf((await preferred.getApiKey("openai-codex", "session")) ?? "")).toBe(TEAM.id);
		expect(await preferred.markUsageLimitReached("openai-codex", "session", { retryAfterMs: 60_000 })).toMatchObject({
			state: "marked",
		});
		expect(workspaceOf((await preferred.getApiKey("openai-codex", "session")) ?? "")).toBe(PERSONAL.id);
	});

	it("skips a preferred workspace whose usage is exhausted", async () => {
		const preferred = await preferTeamThenPersonal();
		backend.usedPercentByWorkspace = { [TEAM.id]: 100, [PERSONAL.id]: 5 };

		expect(workspaceOf((await preferred.getApiKey("openai-codex", "exhausted")) ?? "")).toBe(PERSONAL.id);
	});

	describe("a row stored before workspaces were tracked", () => {
		async function seedLegacy(workspaceId: string, expires = Date.now() - 60_000): Promise<number> {
			const legacy: OAuthCredential = {
				type: "oauth",
				access: codexAccessToken(workspaceId, "legacy"),
				refresh: "refresh-legacy",
				expires,
				accountId: workspaceId,
				email: EMAIL,
			};
			const [row] = store.upsertAuthCredentialForProvider("openai-codex", legacy);
			await authStorage.reload();
			return row?.id ?? -1;
		}

		async function refreshLegacy(legacyId: number, workspaceId: string): Promise<OAuthCredential> {
			const legacy = stored().find(row => row.id === legacyId)?.credential;
			if (!legacy) throw new Error("legacy row missing");
			backend.workspaceId = workspaceId;
			backend.suffix = "legacy-refreshed";
			return await authStorage.forceRefreshOAuthCredential("openai-codex", legacy);
		}

		it("is not replaced by a login to another workspace and learns its workspace on refresh", async () => {
			const legacyId = await seedLegacy(PERSONAL.id);
			await login(TEAM.id, "team");
			expect(readRows(dbPath).map(row => row.identity_key)).toEqual([
				`email:${EMAIL}`,
				`email:${EMAIL}|org:${TEAM.id}`,
			]);

			await refreshLegacy(legacyId, PERSONAL.id);

			const legacy = stored().find(row => row.id === legacyId)?.credential;
			// Refresh records the workspace id from the token; the name is only looked up at login.
			expect([legacy?.organizationId, legacy?.organizationName]).toEqual([PERSONAL.id, undefined]);
			expect(stored()).toHaveLength(2);
			expect(readRows(dbPath).find(row => row.id === legacyId)?.identity_key).toBe(
				`email:${EMAIL}|org:${PERSONAL.id}`,
			);
		});

		it("is deduplicated against a login of the same workspace once refresh names it", async () => {
			const legacyId = await seedLegacy(TEAM.id);
			await login(TEAM.id, "team");
			expect(stored()).toHaveLength(2);

			await refreshLegacy(legacyId, TEAM.id);

			const rows = stored();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.id).toBe(legacyId);
			expect(rows[0]?.credential.organizationId).toBe(TEAM.id);
			// The pruned login row carried the workspace name; the surviving row keeps it, in memory and on disk.
			expect(rows[0]?.credential.organizationName).toBe(TEAM.name);
			// The pruned row stays listed as disabled; the surviving active row is labeled by its workspace.
			expect(
				authStorage
					.listCredentialInventory("openai-codex")
					.filter(row => !row.disabled)
					.map(row => [row.id, row.identityLabel]),
			).toEqual([[legacyId, `${EMAIL} (${TEAM.name})`]]);
			expect(authStorage.resolveOAuthPinTarget("openai-codex", { kind: "org", value: TEAM.name }).credentialId).toBe(
				legacyId,
			);
			const reopened = await SqliteAuthCredentialStore.open(dbPath);
			try {
				const [persisted] = reopened.listAuthCredentials("openai-codex");
				expect(persisted?.credential.type === "oauth" ? persisted.credential.organizationName : undefined).toBe(
					TEAM.name,
				);
			} finally {
				reopened.close();
			}
		});

		it("serves a request whose own refresh names it against a login of the same workspace", async () => {
			// Fresh when selection starts, so the pre-request refresh pass skips it; the usage check of the pinned row
			// then moves the clock past expiry and the request path performs the refresh that prunes the named row.
			const startMs = Date.now();
			let clockMs = startMs;
			vi.spyOn(Date, "now").mockImplementation(() => clockMs);
			const legacyId = await seedLegacy(TEAM.id, startMs + 120_000);
			await login(TEAM.id, "team");
			expect(stored()).toHaveLength(2);
			backend.suffix = "legacy-refreshed";
			backend.usedPercentByWorkspace[TEAM.id] = 5;
			const usageLookup = global.fetch;
			global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.endsWith("/wham/usage")) clockMs = startMs + 90_000;
				return usageLookup(input, init);
			}) as typeof fetch;

			const apiKey = await authStorage.getApiKey("openai-codex", "session", {
				credentialSelector: { kind: "id", value: String(legacyId) },
			});

			expect(apiKey).toBe(codexAccessToken(TEAM.id, "legacy-refreshed"));
			const rows = stored();
			expect(rows.map(row => [row.id, row.credential.organizationId, row.credential.organizationName])).toEqual([
				[legacyId, TEAM.id, TEAM.name],
			]);
		});

		it("adds the carried name without rolling back a peer's newer token rotation", async () => {
			const legacyId = await seedLegacy(TEAM.id);
			await login(TEAM.id, "team");
			// Another process commits a newer token pair right after this process's refresh lease completes and before
			// the refreshed credential is applied in memory.
			const peer = await SqliteAuthCredentialStore.open(dbPath);
			const peerAccess = codexAccessToken(TEAM.id, "peer");
			const completeLease = store.completeOAuthRefreshLease.bind(store);
			store.completeOAuthRefreshLease = (lease, credential) => {
				const completed = completeLease(lease, credential);
				if (completed) {
					peer.updateAuthCredential(legacyId, {
						...credential,
						access: peerAccess,
						refresh: "refresh-peer",
						organizationId: TEAM.id,
					});
				}
				return completed;
			};
			let returned: OAuthCredential;
			try {
				returned = await refreshLegacy(legacyId, TEAM.id);
			} finally {
				peer.close();
			}

			const persisted = stored().find(row => row.id === legacyId)?.credential;
			expect([persisted?.access, persisted?.refresh]).toEqual([peerAccess, "refresh-peer"]);
			expect([persisted?.organizationId, persisted?.organizationName]).toEqual([TEAM.id, TEAM.name]);
			// The caller and the cache get the stored row, not this refresh's older snapshot.
			expect([returned.access, returned.organizationName]).toEqual([peerAccess, TEAM.name]);
			const cached = authStorage.getAll()["openai-codex"];
			expect(Array.isArray(cached) ? undefined : cached?.type === "oauth" ? cached.access : undefined).toBe(
				peerAccess,
			);
		});

		it("caches the name a peer wrote first when the carried name loses its condition", async () => {
			const legacyId = await seedLegacy(TEAM.id);
			await login(TEAM.id, "team");
			// Another process names the row right after this process's refresh lease completes, so the conditional
			// name-only write finds a name already set and changes nothing.
			const peerName = "Acme Renamed";
			const peer = await SqliteAuthCredentialStore.open(dbPath);
			const completeLease = store.completeOAuthRefreshLease.bind(store);
			store.completeOAuthRefreshLease = (lease, credential) => {
				const completed = completeLease(lease, credential);
				if (completed) {
					peer.updateAuthCredential(legacyId, {
						...credential,
						organizationId: TEAM.id,
						organizationName: peerName,
					});
				}
				return completed;
			};
			try {
				await refreshLegacy(legacyId, TEAM.id);
			} finally {
				peer.close();
			}

			expect(stored().map(row => [row.id, row.credential.organizationName])).toEqual([[legacyId, peerName]]);
			// The in-memory row carries the name on disk, so `org:<name>` (resolved against memory) finds it.
			expect(
				authStorage
					.listCredentialInventory("openai-codex")
					.filter(row => !row.disabled)
					.map(row => [row.id, row.identityLabel]),
			).toEqual([[legacyId, `${EMAIL} (${peerName})`]]);
			expect(authStorage.resolveOAuthPinTarget("openai-codex", { kind: "org", value: peerName }).credentialId).toBe(
				legacyId,
			);
		});

		it("keeps the named duplicate active when a peer disables the refreshed row before the name is written", async () => {
			const legacyId = await seedLegacy(TEAM.id);
			await login(TEAM.id, "team");
			const loginId = stored().find(row => row.id !== legacyId)?.id ?? -1;
			// Another process disables the refreshed row right after this process's refresh lease completes, so the
			// conditional name-only write finds no active row. Pruning the named login row too would leave none active.
			const peer = await SqliteAuthCredentialStore.open(dbPath);
			const completeLease = store.completeOAuthRefreshLease.bind(store);
			store.completeOAuthRefreshLease = (lease, credential) => {
				const completed = completeLease(lease, credential);
				if (completed) peer.deleteAuthCredential(legacyId, "deduplicated duplicate credential");
				return completed;
			};
			try {
				await refreshLegacy(legacyId, TEAM.id);
			} finally {
				peer.close();
			}

			expect(stored().map(row => [row.id, row.credential.organizationName])).toEqual([[loginId, TEAM.name]]);
		});

		it("keeps the refreshed row authoritative when the carried name cannot be written", async () => {
			const legacyId = await seedLegacy(TEAM.id);
			await login(TEAM.id, "team");
			store.setOAuthOrganizationNameIfUnset = () => {
				throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
			};

			await refreshLegacy(legacyId, TEAM.id);

			// The lease committed the new tokens, so the refresh succeeds and the duplicate is pruned: kept, it would win
			// the next reload's dedupe (the later row) with its older tokens. The name is not carried.
			const refreshed = codexAccessToken(TEAM.id, "legacy-refreshed");
			expect(stored().map(row => [row.id, row.credential.organizationName, row.credential.access])).toEqual([
				[legacyId, undefined, refreshed],
			]);
			await authStorage.reload();
			expect(authStorage.resolveOAuthPinTarget("openai-codex", { kind: "org", value: TEAM.id }).credentialId).toBe(
				legacyId,
			);
			expect(stored().map(row => [row.id, row.credential.access])).toEqual([[legacyId, refreshed]]);
		});

		it("keeps the refreshed row authoritative when a lease-backed store has no name-only writer", async () => {
			const legacyId = await seedLegacy(TEAM.id);
			await login(TEAM.id, "team");
			// A custom store may implement the refresh lease hooks without the optional name-only writer.
			Object.defineProperty(store, "setOAuthOrganizationNameIfUnset", { value: undefined, configurable: true });

			await refreshLegacy(legacyId, TEAM.id);

			const refreshed = codexAccessToken(TEAM.id, "legacy-refreshed");
			expect(stored().map(row => [row.id, row.credential.organizationName, row.credential.access])).toEqual([
				[legacyId, undefined, refreshed],
			]);
			await authStorage.reload();
			expect(stored().map(row => [row.id, row.credential.access])).toEqual([[legacyId, refreshed]]);
		});

		it("keeps the named duplicate when the name write loses and the row cannot be read back", async () => {
			const legacyId = await seedLegacy(TEAM.id);
			await login(TEAM.id, "team");
			const loginId = stored().find(row => row.id !== legacyId)?.id ?? -1;
			// The conditional write loses, and re-reading the row fails, so whether it is still active is unknown.
			store.setOAuthOrganizationNameIfUnset = () => undefined;
			const list = store.listAuthCredentials.bind(store);
			let failReads = false;
			const completeLease = store.completeOAuthRefreshLease.bind(store);
			store.completeOAuthRefreshLease = (lease, credential) => {
				const completed = completeLease(lease, credential);
				failReads = completed;
				return completed;
			};
			store.listAuthCredentials = provider => {
				if (failReads) {
					failReads = false;
					throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
				}
				return list(provider);
			};

			await refreshLegacy(legacyId, TEAM.id);

			expect(stored().map(row => [row.id, row.credential.organizationName])).toEqual([
				[legacyId, undefined],
				[loginId, TEAM.name],
			]);
			expect(stored().find(row => row.id === legacyId)?.credential.access).toBe(
				codexAccessToken(TEAM.id, "legacy-refreshed"),
			);
		});

		it("serves the stored key when a peer rotates the row after this request's refresh lease", async () => {
			const startMs = Date.now();
			let clockMs = startMs;
			vi.spyOn(Date, "now").mockImplementation(() => clockMs);
			const legacyId = await seedLegacy(TEAM.id, startMs + 120_000);
			await login(TEAM.id, "team");
			backend.suffix = "legacy-refreshed";
			backend.usedPercentByWorkspace[TEAM.id] = 5;
			const usageLookup = global.fetch;
			global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.endsWith("/wham/usage")) clockMs = startMs + 90_000;
				return usageLookup(input, init);
			}) as typeof fetch;
			const peer = await SqliteAuthCredentialStore.open(dbPath);
			const peerAccess = codexAccessToken(TEAM.id, "peer");
			const completeLease = store.completeOAuthRefreshLease.bind(store);
			store.completeOAuthRefreshLease = (lease, credential) => {
				const completed = completeLease(lease, credential);
				if (completed) {
					peer.updateAuthCredential(legacyId, {
						...credential,
						access: peerAccess,
						refresh: "refresh-peer",
						expires: clockMs + 3_600_000,
						organizationId: TEAM.id,
					});
				}
				return completed;
			};
			let apiKey: string | undefined;
			try {
				apiKey = await authStorage.getApiKey("openai-codex", "session", {
					credentialSelector: { kind: "id", value: String(legacyId) },
				});
			} finally {
				peer.close();
			}

			expect(apiKey).toBe(peerAccess);
			expect(stored().map(row => [row.id, row.credential.access, row.credential.organizationName])).toEqual([
				[legacyId, peerAccess, TEAM.name],
			]);
		});

		it("does not serve or disable a peer-rotated row that is already expired", async () => {
			const startMs = Date.now();
			let clockMs = startMs;
			vi.spyOn(Date, "now").mockImplementation(() => clockMs);
			const legacyId = await seedLegacy(TEAM.id, startMs + 120_000);
			await login(TEAM.id, "team");
			backend.suffix = "legacy-refreshed";
			backend.usedPercentByWorkspace[TEAM.id] = 5;
			const usageLookup = global.fetch;
			global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.endsWith("/wham/usage")) clockMs = startMs + 90_000;
				return usageLookup(input, init);
			}) as typeof fetch;
			const peer = await SqliteAuthCredentialStore.open(dbPath);
			const peerAccess = codexAccessToken(TEAM.id, "peer");
			const completeLease = store.completeOAuthRefreshLease.bind(store);
			store.completeOAuthRefreshLease = (lease, credential) => {
				const completed = completeLease(lease, credential);
				if (completed) {
					peer.updateAuthCredential(legacyId, {
						...credential,
						access: peerAccess,
						refresh: "refresh-peer",
						expires: clockMs - 1_000,
						organizationId: TEAM.id,
					});
				}
				return completed;
			};
			let apiKey: string | undefined;
			try {
				apiKey = await authStorage.getApiKey("openai-codex", "session", {
					credentialSelector: { kind: "id", value: String(legacyId) },
				});
			} finally {
				peer.close();
			}

			// The expired peer key is not served (the next resolution refreshes the row), and the row is not classified
			// as a failed refresh and disabled.
			expect(apiKey).toBeUndefined();
			expect(stored().map(row => row.id)).toEqual([legacyId]);
		});

		it("keeps a duplicate in memory when the store could not retire it", async () => {
			const legacyId = await seedLegacy(TEAM.id);
			await login(TEAM.id, "team");
			const loginId = stored().find(row => row.id !== legacyId)?.id ?? -1;
			store.setOAuthOrganizationNameIfUnset = () => {
				throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
			};
			// The delete fails, so the duplicate stays active on disk.
			store.deleteAuthCredential = () => {
				throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
			};

			await refreshLegacy(legacyId, TEAM.id);

			expect(stored().map(row => row.id)).toEqual([legacyId, loginId]);
			// Memory matches the store instead of publishing a pruned view.
			const cached = authStorage.getAll()["openai-codex"];
			expect(Array.isArray(cached) ? cached.length : 1).toBe(2);
			expect(
				authStorage.resolveOAuthPinTarget("openai-codex", { kind: "id", value: String(loginId) }).credentialId,
			).toBe(loginId);
		});
	});
});
