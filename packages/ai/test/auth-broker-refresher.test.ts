import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthBrokerRefresher, AuthStorage, SqliteAuthCredentialStore } from "../src";
import * as oauthUtils from "../src/utils/oauth";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

describe("AuthBrokerRefresher", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-refresher-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		storage?.close();
		store?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("refreshes credentials inside the skew window", async () => {
		const now = 1_700_000_000_000;
		const skew = 5 * 60_000;
		// Credential expires in 1 minute — well within the 5-min skew → must refresh.
		store!.saveOAuth("anthropic", {
			access: "old",
			refresh: "old-refresh",
			expires: now + 60_000,
			accountId: "a",
		});
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue({
			access: "fresh",
			refresh: "fresh-refresh",
			expires: now + 2 * 60 * 60_000,
			accountId: "a",
		});

		storage = new AuthStorage(store!);
		await storage.reload();
		const refresher = new AuthBrokerRefresher({
			storage,
			refreshSkewMs: skew,
			now: () => now,
		});
		await refresher.tick();

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		const persisted = store!.getOAuth("anthropic");
		expect(persisted?.access).toBe("fresh");
		expect(persisted?.refresh).toBe("fresh-refresh");
	});

	test("does not refresh credentials safely outside the skew window", async () => {
		const now = 1_700_000_000_000;
		const skew = 5 * 60_000;
		store!.saveOAuth("anthropic", {
			access: "ok",
			refresh: "ok-refresh",
			expires: now + 60 * 60_000, // 1 hour out
			accountId: "a",
		});
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue({
			access: "should-not-run",
			refresh: "x",
			expires: now,
		});

		storage = new AuthStorage(store!);
		await storage.reload();
		const refresher = new AuthBrokerRefresher({
			storage,
			refreshSkewMs: skew,
			now: () => now,
		});
		await refresher.tick();

		expect(refreshSpy).not.toHaveBeenCalled();
	});

	test("does not sweep MCP-bound credentials without transient client metadata", async () => {
		const now = 1_700_000_000_000;
		store!.replaceAuthCredentialsForProvider("mcp_oauth_bound", [
			{
				type: "oauth",
				access: "old",
				refresh: "client-authenticated-refresh",
				expires: now + 60_000,
				mcpBinding: {
					resourceOrigin: "https://mcp.example",
					tokenEndpoint: "https://auth.example/token",
				},
			},
		]);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		storage = new AuthStorage(store!);
		await storage.reload();
		const refresher = new AuthBrokerRefresher({ storage, refreshSkewMs: 5 * 60_000, now: () => now });

		await refresher.tick();

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(storage.exportSnapshot().credentials).toHaveLength(1);
	});

	test("disables credentials on definitive failure (invalid_grant)", async () => {
		const now = 1_700_000_000_000;
		store!.saveOAuth("anthropic", {
			access: "old",
			refresh: "old-refresh",
			expires: now + 60_000,
			accountId: "a",
		});
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(new Error("invalid_grant"));

		storage = new AuthStorage(store!);
		const disableEvents: string[] = [];
		storage.onCredentialDisabled(event => {
			disableEvents.push(event.disabledCause);
		});
		await storage.reload();
		const refresher = new AuthBrokerRefresher({
			storage,
			refreshSkewMs: 5 * 60_000,
			now: () => now,
		});
		await refresher.tick();

		expect(disableEvents).toHaveLength(1);
		expect(disableEvents[0]).toMatch(/invalid_grant/);
		// The active row is now disabled; storage.exportSnapshot reflects it.
		expect(storage.exportSnapshot().credentials).toHaveLength(0);
	});

	test("keeps a definitively failed credential when the disable write fails, and the next sweep retries", async () => {
		const now = 1_700_000_000_000;
		store!.saveOAuth("anthropic", {
			access: "old",
			refresh: "old-refresh",
			expires: now + 60_000,
			accountId: "a",
		});
		const refreshSpy = vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(new Error("invalid_grant"));
		// A second connection installs a trigger that rejects every disabling UPDATE, so
		// only the soft-delete fails while refresh leases keep working.
		const admin = new Database(path.join(tempDir, "agent.db"));
		admin.run(
			"CREATE TRIGGER fail_disable BEFORE UPDATE OF disabled_cause ON auth_credentials WHEN NEW.disabled_cause IS NOT NULL BEGIN SELECT RAISE(ABORT, 'disable rejected by test trigger'); END",
		);

		storage = new AuthStorage(store!);
		const disableEvents: string[] = [];
		storage.onCredentialDisabled(event => {
			disableEvents.push(event.disabledCause);
		});
		await storage.reload();
		const refresher = new AuthBrokerRefresher({
			storage,
			refreshSkewMs: 5 * 60_000,
			now: () => now,
		});
		try {
			await refresher.tick();

			expect(disableEvents).toEqual([]);
			expect(storage.exportSnapshot().credentials).toHaveLength(1);
			expect(store!.listAuthCredentials("anthropic")).toHaveLength(1);

			admin.run("DROP TRIGGER fail_disable");
			await refresher.tick();

			expect(refreshSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
			expect(disableEvents).toHaveLength(1);
			expect(store!.listAuthCredentials("anthropic")).toHaveLength(0);
		} finally {
			admin.close();
		}
	});

	test("keeps credentials on transient failures (timeout/network)", async () => {
		const now = 1_700_000_000_000;
		store!.saveOAuth("anthropic", {
			access: "old",
			refresh: "old-refresh",
			expires: now + 60_000,
			accountId: "a",
		});
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));

		storage = new AuthStorage(store!);
		const disableEvents: string[] = [];
		storage.onCredentialDisabled(event => {
			disableEvents.push(event.disabledCause);
		});
		await storage.reload();
		const refresher = new AuthBrokerRefresher({
			storage,
			refreshSkewMs: 5 * 60_000,
			now: () => now,
		});
		await refresher.tick();

		expect(disableEvents).toHaveLength(0);
		expect(storage.exportSnapshot().credentials).toHaveLength(1);
	});
});
