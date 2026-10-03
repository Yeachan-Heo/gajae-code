import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "../src/auth-storage";
import { openaiCodexUsageProvider } from "../src/usage/openai-codex";
import * as oauth from "../src/utils/oauth";

function credential(access = "rejected-access", refresh = "original-refresh"): OAuthCredential {
	return {
		type: "oauth",
		access,
		refresh,
		expires: Date.now() + 3_600_000,
		accountId: "account-a",
		email: "a@example.test",
	};
}

function usageResponse(): Response {
	return Response.json({
		plan_type: "pro",
		rate_limit: {
			allowed: true,
			primary_window: { used_percent: 25, limit_window_seconds: 604800, reset_after_seconds: 3600 },
		},
	});
}

function unauthorized(): Response {
	return Response.json({ error: { code: "token_invalidated", message: "untrusted-secret-echo" } }, { status: 401 });
}

describe("usage authentication recovery", () => {
	let root: string;
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let rowId: number;
	let respond: (authorization: string, signal?: AbortSignal | null) => Promise<Response>;
	let requests: string[];
	let peers: AuthStorage[];

	function makeStorage(backing: SqliteAuthCredentialStore): AuthStorage {
		const usageFetch = Object.assign(
			async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const authorization = new Headers(init?.headers).get("Authorization") ?? "";
				requests.push(authorization);
				return respond(authorization, init?.signal);
			},
			{ preconnect: fetch.preconnect },
		);
		return new AuthStorage(backing, {
			usageFetch,
			usageProviderResolver: provider => (provider === "openai-codex" ? openaiCodexUsageProvider : undefined),
		});
	}

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-auth-recovery-"));
		store = await SqliteAuthCredentialStore.open(path.join(root, "agent.db"));
		requests = [];
		peers = [];
		respond = async authorization => (authorization === "Bearer rejected-access" ? unauthorized() : usageResponse());
		storage = makeStorage(store);
		await storage.set("openai-codex", [credential()]);
		rowId = store.listAuthCredentials("openai-codex")[0]!.id;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const peer of peers) peer.close();
		storage.close();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("renews a rejected unexpired token once and persists a fresh usage report", async () => {
		const refresh = vi
			.spyOn(oauth, "refreshOAuthToken")
			.mockResolvedValue(credential("renewed-access", "rotated-refresh"));
		const [result] = await storage.checkCredentials({ provider: "openai-codex" });
		expect(result?.ok).toBe(true);
		expect(result?.report?.limits[0]?.amount.usedFraction).toBe(0.25);
		expect(requests).toEqual(["Bearer rejected-access", "Bearer renewed-access"]);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(store.listAuthCredentials("openai-codex")[0]?.credential).toMatchObject({
			access: "renewed-access",
			refresh: "rotated-refresh",
		});
		expect(storage.getCachedUsageReport("openai-codex", rowId)?.freshness).toBe("fresh");
		await storage.checkCredentials({ provider: "openai-codex" });
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("also recovers ordinary usage retrieval rather than only accounts check", async () => {
		const refresh = vi
			.spyOn(oauth, "refreshOAuthToken")
			.mockResolvedValue(credential("renewed-access", "rotated-refresh"));
		const reports = await storage.fetchUsageReports();
		expect(reports?.find(report => report.provider === "openai-codex")?.limits[0]?.amount.usedFraction).toBe(0.25);
		expect(requests).toEqual(["Bearer rejected-access", "Bearer renewed-access"]);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("surfaces a second 401 without looping or echoing its response body", async () => {
		respond = async () => unauthorized();
		const refresh = vi
			.spyOn(oauth, "refreshOAuthToken")
			.mockResolvedValue(credential("renewed-access", "rotated-refresh"));
		const [result] = await storage.checkCredentials({ provider: "openai-codex" });
		expect(result?.ok).toBe(false);
		expect(result?.reason).toContain("401");
		expect(result?.reason).not.toContain("untrusted-secret-echo");
		expect(requests).toHaveLength(2);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(store.listAuthCredentials("openai-codex")).toHaveLength(1);
	});

	it("reports refresh failure without disabling the row or replaying the refresh token", async () => {
		const original = store.listAuthCredentials("openai-codex")[0]?.credential;
		const refresh = vi
			.spyOn(oauth, "refreshOAuthToken")
			.mockRejectedValue(new Error("invalid_grant original-refresh rejected-access"));
		const [result] = await storage.checkCredentials({ provider: "openai-codex" });
		expect(result?.ok).toBe(false);
		expect(result?.reason).toContain("invalid_grant");
		expect(result?.reason).not.toContain("original-refresh");
		expect(result?.reason).not.toContain("rejected-access");
		await storage.checkCredentials({ provider: "openai-codex" });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(store.listAuthCredentials("openai-codex")[0]?.credential).toEqual(original);
	});

	it.each([403, 429, 500])("does not rotate credentials on HTTP %s", async status => {
		respond = async () => new Response("not an authentication failure", { status });
		const refresh = vi.spyOn(oauth, "refreshOAuthToken");
		const [result] = await storage.checkCredentials({ provider: "openai-codex" });
		expect(result?.ok).not.toBe(true);
		expect(requests).toHaveLength(1);
		expect(refresh).not.toHaveBeenCalled();
	});

	it("does not rotate credentials on transport failure", async () => {
		respond = async () => {
			throw new TypeError("connection reset");
		};
		const refresh = vi.spyOn(oauth, "refreshOAuthToken");
		const [result] = await storage.checkCredentials({ provider: "openai-codex" });
		expect(result?.ok).toBeNull();
		expect(requests).toHaveLength(1);
		expect(refresh).not.toHaveBeenCalled();
	});

	it("reports authentication failure when the row has no refresh token", async () => {
		store.updateAuthCredential(rowId, credential("rejected-access", ""));
		await storage.reload();
		const refresh = vi.spyOn(oauth, "refreshOAuthToken");
		const [result] = await storage.checkCredentials({ provider: "openai-codex" });
		expect(result?.ok).toBe(false);
		expect(result?.reason).toContain("401");
		expect(requests).toHaveLength(1);
		expect(refresh).not.toHaveBeenCalled();
	});

	it("does not start a refresh after caller cancellation", async () => {
		const controller = new AbortController();
		respond = async () => {
			controller.abort();
			return unauthorized();
		};
		const refresh = vi.spyOn(oauth, "refreshOAuthToken");
		await storage.checkCredentials({ provider: "openai-codex", signal: controller.signal });
		expect(refresh).not.toHaveBeenCalled();
		expect(requests).toHaveLength(1);
	});

	it("adopts a peer rotation observed after the rejected usage request", async () => {
		respond = async authorization => {
			if (authorization === "Bearer rejected-access") {
				store.updateAuthCredential(rowId, credential("peer-access", "peer-refresh"));
				return unauthorized();
			}
			return usageResponse();
		};
		const refresh = vi.spyOn(oauth, "refreshOAuthToken");
		const [result] = await storage.checkCredentials({ provider: "openai-codex" });
		expect(result?.ok).toBe(true);
		expect(requests).toEqual(["Bearer rejected-access", "Bearer peer-access"]);
		expect(refresh).not.toHaveBeenCalled();
		expect(store.listAuthCredentials("openai-codex")[0]?.credential).toMatchObject({ refresh: "peer-refresh" });
	});

	it("shares a refresh lease across two independent storage instances", async () => {
		const peer = makeStorage(await SqliteAuthCredentialStore.open(path.join(root, "agent.db")));
		peers.push(peer);
		await peer.reload();
		const bothRejected = Promise.withResolvers<void>();
		let rejected = 0;
		respond = async authorization => {
			if (authorization !== "Bearer rejected-access") return usageResponse();
			if (++rejected === 2) bothRejected.resolve();
			await bothRejected.promise;
			return unauthorized();
		};
		const refresh = vi
			.spyOn(oauth, "refreshOAuthToken")
			.mockResolvedValue(credential("renewed-access", "rotated-refresh"));
		const results = await Promise.all([
			storage.checkCredentials({ provider: "openai-codex" }),
			peer.checkCredentials({ provider: "openai-codex" }),
		]);
		expect(results.map(batch => batch[0]?.ok)).toEqual([true, true]);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(requests.filter(request => request === "Bearer renewed-access")).toHaveLength(2);
	});

	it.each([
		false,
		true,
	])("does not overwrite a newer peer token after lease persistence (expired=%s)", async expired => {
		if (expired) {
			store.updateAuthCredential(rowId, { ...credential(), expires: Date.now() - 60_000 });
			await storage.reload();
		}
		const complete = store.completeOAuthRefreshLease.bind(store);
		vi.spyOn(store, "completeOAuthRefreshLease").mockImplementation((lease, renewed) => {
			const completed = complete(lease, renewed);
			store.updateAuthCredential(rowId, credential("newer-peer-access", "newer-peer-refresh"));
			return completed;
		});
		vi.spyOn(oauth, "refreshOAuthToken").mockResolvedValue(credential("renewed-access", "rotated-refresh"));
		const [result] = await storage.checkCredentials({ provider: "openai-codex" });
		expect(result?.ok).toBe(true);
		expect(store.listAuthCredentials("openai-codex")[0]?.credential).toMatchObject({
			access: "newer-peer-access",
			refresh: "newer-peer-refresh",
		});
	});
});
