import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

describe("AuthStorage api-key usage-limit fallback", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-api-key-rate-limit-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		await authStorage.set("zai", [
			{ type: "api_key", key: "zai-key-1" },
			{ type: "api_key", key: "zai-key-2" },
			{ type: "api_key", key: "zai-key-3" },
		]);
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

	it("switches an api-key session away from the credential that hit a usage limit", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const sessionId = "zai-api-key-usage-limit-session";
		const firstKey = await authStorage.getApiKey("zai", sessionId);

		const switched = await authStorage.markUsageLimitReached("zai", sessionId, { retryAfterMs: 60_000 });
		const retryKey = await authStorage.getApiKey("zai", sessionId);

		expect(switched).toBe(true);
		expect(retryKey).toBeDefined();
		expect(retryKey).not.toBe(firstKey);
		expect(new Set([firstKey, retryKey]).size).toBe(2);
	});
});
