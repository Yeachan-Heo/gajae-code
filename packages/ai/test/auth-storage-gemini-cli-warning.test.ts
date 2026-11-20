import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import * as geminiCliModule from "../src/utils/oauth/google-gemini-cli";

describe("AuthStorage gemini-cli OAuth warning", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let loginGeminiCliSpy: Mock<typeof geminiCliModule.loginGeminiCli>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-gemini-warning-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		loginGeminiCliSpy = vi.spyOn(geminiCliModule, "loginGeminiCli");
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

	it("shows account suspension warning before google-gemini-cli OAuth login starts", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");

		loginGeminiCliSpy.mockResolvedValueOnce({
			access: "test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3600000,
		});

		const onProgressMessages: string[] = [];
		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
			onProgress: (message: string) => {
				onProgressMessages.push(message);
			},
		};

		await authStorage.login("google-gemini-cli", controller);

		// Verify warning message was passed to onProgress before login
		expect(onProgressMessages).toHaveLength(1);
		expect(onProgressMessages[0]).toContain("WARNING");
		expect(onProgressMessages[0]).toContain("Google may suspend accounts");
		expect(onProgressMessages[0]).toContain("OAuth through third-party clients");
		expect(onProgressMessages[0]).toContain("API key");
		expect(onProgressMessages[0]).toContain("Vertex AI");

		// Verify credentials were still stored
		expect(store.getOAuth("google-gemini-cli")).not.toBeNull();
	});

	it("warning message is shown exactly once per login call", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");

		loginGeminiCliSpy.mockResolvedValueOnce({
			access: "test-token-1",
			refresh: "test-refresh-1",
			expires: Date.now() + 3600000,
		});

		let callCount = 0;
		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
			onProgress: () => {
				callCount += 1;
			},
		};

		await authStorage.login("google-gemini-cli", controller);
		expect(callCount).toBe(1);
	});

	it("warning does not prevent successful OAuth credential storage", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");

		const testEmail = "test@example.com";
		const testAccess = "test-access-token";
		const testRefresh = "test-refresh-token";
		const testExpires = Date.now() + 3600000;

		loginGeminiCliSpy.mockResolvedValueOnce({
			access: testAccess,
			refresh: testRefresh,
			expires: testExpires,
			email: testEmail,
		});

		const controller = {
			onAuth: () => {},
			onPrompt: async () => "",
			onProgress: () => {},
		};

		await authStorage.login("google-gemini-cli", controller);

		const oauth = store.getOAuth("google-gemini-cli");
		expect(oauth).not.toBeNull();
		if (oauth) {
			expect(oauth.access).toBe(testAccess);
			expect(oauth.refresh).toBe(testRefresh);
			expect(oauth.email).toBe(testEmail);
		}
	});
});
