import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@gajae-code/ai";
import type { UsageReport } from "@gajae-code/ai/usage";
import * as oauth from "@gajae-code/ai/utils/oauth";

const provider = "openai-codex";

describe("usage-limit mark captures one stored row", () => {
	for (const explicit of [false, true]) {
		for (const mutation of ["pointer", "remove-preceding", "reorder", "remove-target"] as const) {
			test(`${explicit ? "explicit" : "implicit"} row survives ${mutation} during usage lookup`, async () => {
				const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mark-row-"));
				const store: AuthCredentialStore = await SqliteAuthCredentialStore.open(path.join(root, "auth.db"));
				const storage = new AuthStorage(store, {
					rankingStrategyResolver: () => ({
						findWindowLimits: report => ({ primary: report.limits[0] }),
						windowDefaults: { primaryMs: 3_600_000, secondaryMs: 86_400_000 },
					}),
				});
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<UsageReport | null>();
				let pending: ReturnType<typeof storage.markUsageLimitReached> | undefined;
				vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
					const credential = credentials[provider];
					return credential ? { apiKey: credential.access, newCredentials: credential } : null;
				});
				let parked = false;
				store.getUsageReport = async (_provider, credential) => {
					if (parked && credential.accountId === "c") {
						entered.resolve();
						return release.promise;
					}
					return null;
				};
				try {
					await storage.set(
						provider,
						["a", "b", "c"].map(accountId => ({
							type: "oauth" as const,
							access: `synthetic-${accountId}`,
							refresh: `refresh-${accountId}`,
							expires: Date.now() + 3_600_000,
							accountId,
						})),
					);
					const rows = store.listAuthCredentials(provider);
					const target = rows[2]!;
					let currentRows = rows;
					await storage.getApiKey(provider, "mark-session", {
						credentialSelector: { kind: "id", value: String(target.id) },
					});
					expect(storage.getSessionCredentialRowId(provider, "mark-session")).toBe(target.id);
					parked = true;
					pending = storage.markUsageLimitReached(provider, "mark-session", {
						retryAfterMs: 120_000,
						...(explicit ? { rowId: target.id } : {}),
					});
					await Promise.race([
						entered.promise,
						pending.then(() => {
							throw new Error("Mark skipped usage lookup");
						}),
					]);
					if (mutation === "pointer") {
						await storage.getApiKey(provider, "mark-session", {
							credentialSelector: { kind: "id", value: String(rows[1]!.id) },
						});
						expect(storage.getSessionCredentialRowId(provider, "mark-session")).toBe(rows[1]!.id);
					} else {
						currentRows =
							mutation === "reorder"
								? [rows[2]!, rows[0]!, rows[1]!]
								: rows.filter(row => row.id !== (mutation === "remove-target" ? target.id : rows[0]!.id));
						vi.spyOn(store, "listAuthCredentials").mockImplementation(() => currentRows);
						await storage.reload();
					}
					parked = false;
					release.resolve(null);
					const result = await pending;
					expect(result.state).toBe(mutation === "remove-target" ? "not-marked" : "marked");
					expect(result.failedRowId).toBe(target.id);
					expect(result.credentialKind).toBe("oauth");
					expect([...result.remainingCredentialIds].sort((a, b) => a - b)).toEqual(
						currentRows
							.filter(row => row.id !== target.id)
							.map(row => row.id)
							.sort((a, b) => a - b),
					);
					if (mutation === "remove-target") {
						expect(storage.getEarliestUnblockAt(provider)).toBeUndefined();
					} else {
						expect(storage.getEarliestUnblockAt(provider)).toBeGreaterThan(Date.now());
						// Preferred is not pinned: the marked C must lose to an unblocked row.
						expect(
							await storage.getApiKey(provider, "probe", {
								preferredCredentialSelector: { kind: "id", value: String(target.id) },
							}),
						).not.toBe("synthetic-c");
						expect(
							await storage.getApiKey(provider, "healthy", {
								preferredCredentialSelector: { kind: "id", value: String(rows[1]!.id) },
							}),
						).toBe("synthetic-b");
					}
				} finally {
					parked = false;
					release.resolve(null);
					if (pending) await Promise.allSettled([pending]);
					vi.restoreAllMocks();
					storage.close();
					await fs.rm(root, { recursive: true, force: true });
				}
			});
		}
	}

	test("unknown explicit and absent session rows mark nothing", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mark-unknown-"));
		const storage = await AuthStorage.create(path.join(root, "auth.db"));
		try {
			await storage.set(provider, { type: "api_key", key: "synthetic-key" });
			expect(await storage.markUsageLimitReached(provider, "unknown")).toEqual({
				state: "not-marked",
				remainingCredentialIds: [],
			});
			expect(await storage.markUsageLimitReached(provider, "unknown", { rowId: -1 })).toEqual({
				state: "not-marked",
				remainingCredentialIds: [],
			});
			expect(storage.getEarliestUnblockAt(provider)).toBeUndefined();
		} finally {
			storage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
