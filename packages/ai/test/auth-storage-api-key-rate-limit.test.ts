import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";

describe("AuthStorage api-key usage-limit fallback", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let resolvedConfigValues = new Map<string, string>();

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-api-key-rate-limit-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		resolvedConfigValues = new Map();
		authStorage = new AuthStorage(store, {
			configValueResolver: async key => resolvedConfigValues.get(key) ?? process.env[key] ?? key,
		});
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
	it("does not rotate credentials while reading evidence and honors the runtime selector when peeking", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		authStorage.getProviderEvidenceGeneration("zai");
		authStorage.getProviderEvidenceGeneration("zai");
		expect(await authStorage.peekApiKey("zai")).toBe("zai-key-1");

		const selected = store.listAuthCredentials("zai")[1];
		if (!selected) throw new Error("missing test credential");
		authStorage.setRuntimeCredentialSelector("zai", { kind: "id", value: String(selected.id) });
		expect(await authStorage.peekApiKey("zai")).toBe("zai-key-2");
	});
	it("does not fall back from an expired selected OAuth credential", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("zai", [
			{ type: "oauth", access: "expired-oauth", refresh: "expired-refresh", expires: Date.now() - 1 },
			{ type: "api_key", key: "unselected-api-key" },
		]);
		const selected = store.listAuthCredentials("zai")[0];
		if (!selected) throw new Error("missing test credential");
		authStorage.setRuntimeCredentialSelector("zai", { kind: "id", value: String(selected.id) });

		expect(await authStorage.peekApiKey("zai")).toBeUndefined();
	});
	it("fingerprints OAuth credential expiry", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const now = new Date("2026-07-25T00:00:00.000Z");
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now.getTime());
		try {
			await authStorage.set("zai", [
				{ type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: now.getTime() + 1_000 },
			]);
			const beforeExpiry = authStorage.getProviderEvidenceGeneration("zai");

			nowSpy.mockReturnValue(now.getTime() + 1_001);

			expect(authStorage.getProviderEvidenceGeneration("zai")).not.toBe(beforeExpiry);
		} finally {
			nowSpy.mockRestore();
		}
	});
	it("fingerprints dynamically resolved stored API keys", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("zai", [{ type: "api_key", key: "GJC_TEST_DYNAMIC_KEY" }]);
		const original = process.env.GJC_TEST_DYNAMIC_KEY;
		try {
			process.env.GJC_TEST_DYNAMIC_KEY = "credential-a";
			await authStorage.peekApiKey("zai");
			const first = authStorage.getProviderEvidenceGeneration("zai");
			process.env.GJC_TEST_DYNAMIC_KEY = "credential-b";
			const second = authStorage.getProviderEvidenceGeneration("zai");
			expect(second).not.toBe(first);
			delete process.env.GJC_TEST_DYNAMIC_KEY;
			expect(authStorage.getProviderEvidenceGeneration("zai")).not.toBe(second);
		} finally {
			if (original === undefined) delete process.env.GJC_TEST_DYNAMIC_KEY;
			else process.env.GJC_TEST_DYNAMIC_KEY = original;
		}
	});
	it("fingerprints command-resolved stored API keys after discovery resolution", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("zai", [{ type: "api_key", key: "!test-command" }]);
		resolvedConfigValues.set("!test-command", "credential-a");
		await authStorage.peekApiKey("zai");
		const first = authStorage.getProviderEvidenceGeneration("zai");
		resolvedConfigValues.set("!test-command", "credential-b");
		await authStorage.peekApiKey("zai");

		expect(authStorage.getProviderEvidenceGeneration("zai")).not.toBe(first);
	});
});
