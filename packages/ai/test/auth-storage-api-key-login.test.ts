import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import * as deepseekModule from "../src/utils/oauth/deepseek";
import * as kagiModule from "../src/utils/oauth/kagi";
import * as ollamaCloudModule from "../src/utils/oauth/ollama-cloud";

function countCredentialRows(dbPath: string, provider: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT COUNT(*) AS count FROM auth_credentials WHERE provider = ?").get(provider) as
			| { count?: number }
			| undefined;
		return row?.count ?? 0;
	} finally {
		db.close();
	}
}

describe("AuthStorage api-key login replacement", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let loginDeepSeekSpy: Mock<typeof deepseekModule.loginDeepSeek>;
	let loginKagiSpy: Mock<typeof kagiModule.loginKagi>;
	let loginOllamaCloudSpy: Mock<typeof ollamaCloudModule.loginOllamaCloud>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-api-key-login-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		loginDeepSeekSpy = vi.spyOn(deepseekModule, "loginDeepSeek");
		loginKagiSpy = vi.spyOn(kagiModule, "loginKagi");
		loginOllamaCloudSpy = vi.spyOn(ollamaCloudModule, "loginOllamaCloud");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		dbPath = "";
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("reuses the stored api-key row when re-login returns the same key", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginKagiSpy.mockResolvedValueOnce("same-kagi-key").mockResolvedValueOnce("same-kagi-key");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
		};

		await authStorage.login("kagi", controller);
		await authStorage.login("kagi", controller);

		expect(countCredentialRows(dbPath, "kagi")).toBe(1);
		const credentials = store.listAuthCredentials("kagi");
		expect(credentials).toHaveLength(1);
		const [stored] = credentials;
		expect(stored?.credential.type).toBe("api_key");
		if (stored?.credential.type !== "api_key") {
			throw new Error("expected stored api-key credential");
		}
		expect(stored.credential.key).toBe("same-kagi-key");
		expect(store.getApiKey("kagi")).toBe("same-kagi-key");
		expect(await authStorage.getApiKey("kagi", "session-kagi-relogin")).toBe("same-kagi-key");
	});

	it("reuses the stored api-key row when ollama-cloud re-login returns the same key", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginOllamaCloudSpy.mockResolvedValueOnce("same-ollama-cloud-key").mockResolvedValueOnce("same-ollama-cloud-key");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
		};

		await authStorage.login("ollama-cloud", controller);
		await authStorage.login("ollama-cloud", controller);

		expect(countCredentialRows(dbPath, "ollama-cloud")).toBe(1);
		const credentials = store.listAuthCredentials("ollama-cloud");
		expect(credentials).toHaveLength(1);
		const [stored] = credentials;
		expect(stored?.credential.type).toBe("api_key");
		if (stored?.credential.type !== "api_key") {
			throw new Error("expected stored api-key credential");
		}
		expect(stored.credential.key).toBe("same-ollama-cloud-key");
		expect(store.getApiKey("ollama-cloud")).toBe("same-ollama-cloud-key");
		expect(await authStorage.getApiKey("ollama-cloud", "session-ollama-cloud-relogin")).toBe("same-ollama-cloud-key");
	});

	it("stores DeepSeek login credentials as a reusable api-key credential", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginDeepSeekSpy.mockResolvedValueOnce("same-deepseek-key").mockResolvedValueOnce("same-deepseek-key");

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
		};

		await authStorage.login("deepseek", controller);
		await authStorage.login("deepseek", controller);

		expect(countCredentialRows(dbPath, "deepseek")).toBe(1);
		const credentials = store.listAuthCredentials("deepseek");
		expect(credentials).toHaveLength(1);
		const [stored] = credentials;
		expect(stored?.credential.type).toBe("api_key");
		if (stored?.credential.type !== "api_key") {
			throw new Error("expected stored api-key credential");
		}
		expect(stored.credential.key).toBe("same-deepseek-key");
		expect(store.getApiKey("deepseek")).toBe("same-deepseek-key");
		expect(await authStorage.getApiKey("deepseek", "session-deepseek-relogin")).toBe("same-deepseek-key");
	});
});
