import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

describe("AuthStorage api-key usage-limit fallback", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let rejectedConfigKey: string | undefined;

	beforeEach(async () => {
		rejectedConfigKey = undefined;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-api-key-rate-limit-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			configValueResolver: async config => {
				if (config === rejectedConfigKey) throw new Error("credential resolver failed");
				return config;
			},
		});
		await authStorage.set("zai", [
			{ type: "api_key", key: "zai-key-1" },
			{ type: "api_key", key: "zai-key-2" },
			{ type: "api_key", key: "zai-key-3" },
		]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		rejectedConfigKey = undefined;
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("switches an api-key session away from the credential that hit a usage limit", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const sessionId = "zai-api-key-usage-limit-session";
		const firstKey = await authStorage.getApiKey("zai", sessionId);
		const failedRowId = authStorage.getSessionCredentialRowId("zai", sessionId)!;

		const result = await authStorage.markUsageLimitReached("zai", sessionId, { retryAfterMs: 60_000 });
		const retryKey = await authStorage.getApiKey("zai", sessionId);

		expect(result).toEqual({
			state: "marked",
			failedRowId,
			credentialKind: "api_key",
			remainingCredentialIds: store!
				.listAuthCredentials("zai")
				.filter(row => row.id !== failedRowId)
				.map(row => row.id),
		});
		expect(retryKey).toBeDefined();
		expect(retryKey).not.toBe(firstKey);
		expect(new Set([firstKey, retryKey]).size).toBe(2);
	});

	it("reports a blocked row unavailable while an unblocked same-kind peer remains available", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const sessionId = "zai-api-key-availability-session";
		await authStorage.getApiKey("zai", sessionId);
		const failedRowId = authStorage.getSessionCredentialRowId("zai", sessionId)!;
		const peerRowId = store.listAuthCredentials("zai").find(row => row.id !== failedRowId)!.id;

		await authStorage.markUsageLimitReached("zai", sessionId, { retryAfterMs: 60_000 });

		expect(authStorage.isCredentialAvailable("zai", failedRowId)).toBe(false);
		expect(authStorage.isCredentialAvailable("zai", peerRowId)).toBe(true);
	});

	it("matches a resolved key to its stored row after the shared session pointer advances", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const sessionId = "zai-api-key-row-match-session";
		const apiKey = await authStorage.getApiKey("zai", sessionId);
		if (apiKey === undefined) throw new Error("test setup did not resolve a stored API key");
		const selectedRowId = authStorage.getSessionCredentialRowId("zai", sessionId);
		if (selectedRowId === undefined) throw new Error("test setup did not record the selected stored row");
		const siblingRowId = store.listAuthCredentials("zai").find(row => row.id !== selectedRowId)?.id;
		if (siblingRowId === undefined) throw new Error("test setup did not provide a sibling stored row");

		await authStorage.getApiKey("zai", sessionId, {
			credentialSelector: { kind: "id", value: String(siblingRowId) },
		});

		expect(authStorage.getSessionCredentialRowId("zai", sessionId)).toBe(siblingRowId);
		expect(await authStorage.getCredentialRowIdsMatchingApiKey("zai", apiKey)).toEqual([selectedRowId]);
		expect(await authStorage.getCredentialRowIdsMatchingApiKey("zai", "not-a-stored-key")).toEqual([]);
	});

	it("matches every stored row that resolves to the same API key", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("zai", [
			{ type: "api_key", key: "shared-zai-key" },
			{ type: "api_key", key: "shared-zai-key" },
		]);
		const rowIds = store.listAuthCredentials("zai").map(row => row.id);
		const matchingRowIds = await authStorage.getCredentialRowIdsMatchingApiKey("zai", "shared-zai-key");

		expect(matchingRowIds).toHaveLength(2);
		expect(new Set(matchingRowIds)).toEqual(new Set(rowIds));
	});

	it("continues matching when an unrelated API-key resolver rejects", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const rows = store.listAuthCredentials("zai");
		const matchedRow = rows.find(row => row.credential.type === "api_key" && row.credential.key === "zai-key-1");
		const rejectedRow = rows.find(row => row.credential.type === "api_key" && row.credential.key === "zai-key-2");
		if (!matchedRow || !rejectedRow) throw new Error("test setup did not create the expected credentials");
		rejectedConfigKey = "zai-key-2";
		const warning = vi.spyOn(logger, "warn");

		await expect(authStorage.getCredentialRowIdsMatchingApiKey("zai", "zai-key-1")).resolves.toEqual([matchedRow.id]);
		expect(warning).toHaveBeenCalledWith("Failed to resolve stored API key while matching credential rows", {
			provider: "zai",
			credentialId: rejectedRow.id,
			errorType: "Error",
		});
	});
});
