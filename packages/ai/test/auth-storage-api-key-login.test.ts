import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	type AuthCredential,
	type AuthCredentialCommitOptions,
	AuthStorage,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "../src/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/utils/oauth";
import * as commandcodeModule from "../src/utils/oauth/commandcode";
import * as deepseekModule from "../src/utils/oauth/deepseek";
import * as kagiModule from "../src/utils/oauth/kagi";
import * as ollamaCloudModule from "../src/utils/oauth/ollama-cloud";
import * as codexModule from "../src/utils/oauth/openai-codex";
import * as openrouterModule from "../src/utils/oauth/openrouter";
import type { OAuthCredentials } from "../src/utils/oauth/types";
import * as xaiModule from "../src/utils/oauth/xai";

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
	let loginCommandCodeSpy: Mock<typeof commandcodeModule.loginCommandCode>;
	let loginDeepSeekSpy: Mock<typeof deepseekModule.loginDeepSeek>;
	let loginKagiSpy: Mock<typeof kagiModule.loginKagi>;
	let loginOllamaCloudSpy: Mock<typeof ollamaCloudModule.loginOllamaCloud>;
	let loginOpenRouterSpy: Mock<typeof openrouterModule.loginOpenRouter>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-api-key-login-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store);
		loginCommandCodeSpy = vi.spyOn(commandcodeModule, "loginCommandCode");
		loginDeepSeekSpy = vi.spyOn(deepseekModule, "loginDeepSeek");
		loginKagiSpy = vi.spyOn(kagiModule, "loginKagi");
		loginOllamaCloudSpy = vi.spyOn(ollamaCloudModule, "loginOllamaCloud");
		loginOpenRouterSpy = vi.spyOn(openrouterModule, "loginOpenRouter");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		unregisterOAuthProviders("credential-commit-test");
		store?.close();
		store = null;
		authStorage = null;
		dbPath = "";
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	for (const flow of ["api-key", "device", "oauth", "xai"] as const) {
		it(`admits the actual ${flow} credential commit only after provider preflight`, async () => {
			if (!store || !authStorage) throw new Error("test setup failed");
			const storage = authStorage;
			const credentialStore = store;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const events: string[] = [];
			const oauth: OAuthCredentials = {
				access: "synthetic-access",
				refresh: "synthetic-refresh",
				expires: 9_999_999_999_999,
				email: "commit@example.invalid",
			};
			const provider =
				flow === "api-key"
					? "kagi"
					: flow === "device"
						? "openai-codex-device"
						: flow === "xai"
							? "xai"
							: "unit-credential-commit";
			const storedProvider = flow === "device" ? "openai-codex" : provider;
			const expected: AuthCredential =
				flow === "api-key" ? { type: "api_key", key: "synthetic-key" } : { type: "oauth", ...oauth };
			const preflight = async (): Promise<void> => {
				events.push("provider");
				entered.resolve();
				await release.promise;
				events.push("provider-done");
			};
			if (flow === "api-key") {
				loginKagiSpy.mockImplementation(async () => {
					await preflight();
					return "synthetic-key";
				});
			} else if (flow === "device") {
				vi.spyOn(codexModule, "loginOpenAICodexDevice").mockImplementation(async () => {
					await preflight();
					return oauth;
				});
			} else if (flow === "xai") {
				vi.spyOn(xaiModule, "loginXai").mockImplementation(async () => {
					await preflight();
					return oauth;
				});
			} else {
				registerOAuthProvider({
					id: provider,
					name: "Credential commit synthetic",
					sourceId: "credential-commit-test",
					async login() {
						await preflight();
						return oauth;
					},
				});
			}
			const rejected = new Error("credential admission refused");
			let refuse = true;
			const options: AuthCredentialCommitOptions = {
				async withCredentialCommit(commit) {
					events.push("admit");
					if (refuse) throw rejected;
					expect(credentialStore.listAuthCredentials(storedProvider)).toEqual([]);
					const result = commit();
					// The synchronous store effect has already occurred inside admission.
					expect(credentialStore.listAuthCredentials(storedProvider).map(entry => entry.credential)).toEqual([
						expected,
					]);
					events.push("committed");
					return await result;
				},
			};
			const controller = { onAuth: () => {}, onPrompt: async () => "" };
			const pending = storage.login(provider, controller, {}, options);
			const rejectedResult = pending.then(
				() => ({ status: "fulfilled" as const }),
				(error: unknown) => ({ status: "rejected" as const, error }),
			);
			await entered.promise;
			expect(events).toEqual(["provider"]);
			expect(credentialStore.listAuthCredentials(storedProvider)).toEqual([]);
			release.resolve();
			expect(await rejectedResult).toEqual({ status: "rejected", error: rejected });
			expect(events).toEqual(["provider", "provider-done", "admit"]);
			expect(countCredentialRows(dbPath, storedProvider)).toBe(0);
			expect(storage.get(storedProvider)).toBeUndefined();
			refuse = false;
			await storage.login(provider, controller, {}, options);
			expect(events.slice(-4)).toEqual(["provider", "provider-done", "admit", "committed"]);
			expect(credentialStore.listAuthCredentials(storedProvider).map(entry => entry.credential)).toEqual([expected]);
		});
	}

	for (const operation of ["replace", "upsert"] as const) {
		it(`does not dispatch a refused remote ${operation} and owns its original commit future`, async () => {
			if (!store) throw new Error("test setup failed");
			const local = store;
			const response = Promise.withResolvers<StoredAuthCredential[]>();
			const events: string[] = [];
			const provider = operation === "replace" ? "kagi" : "unit-remote-credential";
			const credential: AuthCredential =
				operation === "replace"
					? { type: "api_key", key: "remote-synthetic" }
					: { type: "oauth", access: "remote-access", refresh: "remote-refresh", expires: 9_999_999_999_999 };
			const dispatch = (actualProvider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]> => {
				events.push("remote-dispatch");
				expect(actualProvider).toBe(provider);
				expect(credentials).toEqual([credential]);
				return response.promise;
			};
			const remoteStore = Object.assign(local, {
				replaceAuthCredentialsRemote: dispatch,
				upsertAuthCredentialRemote(actualProvider: string, value: AuthCredential): Promise<StoredAuthCredential[]> {
					return dispatch(actualProvider, [value]);
				},
			});
			const remote = new AuthStorage(remoteStore);
			if (credential.type === "oauth") {
				registerOAuthProvider({
					id: provider,
					name: "Remote credential synthetic",
					sourceId: "credential-commit-test",
					async login() {
						return credential;
					},
				});
			}
			const invoke = (options: AuthCredentialCommitOptions): Promise<void> =>
				operation === "replace"
					? remote.set(provider, credential, options)
					: remote.login(provider, { onAuth: () => {}, onPrompt: async () => "" }, {}, options);
			const refused = new Error("remote admission refused");
			await expect(
				invoke({
					withCredentialCommit: async () => {
						throw refused;
					},
				}),
			).rejects.toBe(refused);
			expect(events).toEqual([]);
			expect(local.listAuthCredentials(provider)).toEqual([]);
			const dispatched = Promise.withResolvers<void>();
			const pending = invoke({
				async withCredentialCommit(commit) {
					events.push("admit");
					const future = commit();
					expect(future).toBe(response.promise);
					dispatched.resolve();
					const result = await future;
					events.push("remote-settled");
					return result;
				},
			});
			await dispatched.promise;
			expect(events).toEqual(["admit", "remote-dispatch"]);
			expect(remote.get(provider)).toBeUndefined();
			response.resolve([{ id: 101, provider, credential, disabledCause: null }]);
			await pending;
			expect(events).toEqual(["admit", "remote-dispatch", "remote-settled"]);
			expect(remote.get(provider)).toEqual(credential);
		});
	}

	it("leaves existing local credentials and selection unchanged when a set is refused", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		await authStorage.set("kagi", { type: "api_key", key: "retained-synthetic" });
		const before = store.listAuthCredentials("kagi");
		const generation = authStorage.getProviderConfigurationGeneration("kagi");
		const refused = new Error("replacement refused");
		await expect(
			authStorage.set(
				"kagi",
				{ type: "api_key", key: "candidate-synthetic" },
				{
					withCredentialCommit: async () => {
						throw refused;
					},
				},
			),
		).rejects.toBe(refused);
		expect(store.listAuthCredentials("kagi")).toEqual(before);
		expect(countCredentialRows(dbPath, "kagi")).toBe(1);
		expect(authStorage.get("kagi")).toEqual({ type: "api_key", key: "retained-synthetic" });
		expect(authStorage.getProviderConfigurationGeneration("kagi")).toBe(generation);
	});

	it("keeps an unguarded local setter synchronous until its returned promise", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		const pending = authStorage.set("kagi", { type: "api_key", key: "ordinary-synthetic" });
		expect(store.getApiKey("kagi")).toBe("ordinary-synthetic");
		expect(authStorage.get("kagi")).toEqual({ type: "api_key", key: "ordinary-synthetic" });
		await pending;
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

	it("stores Command Code login credentials under the canonical provider id", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");
		loginCommandCodeSpy.mockResolvedValueOnce("cmd-test-key").mockResolvedValueOnce("cmd-test-key-2");
		const controller = { onAuth: () => {}, onPrompt: async () => "" };
		await authStorage.login("commandcode-goat", controller);
		await authStorage.login("commandcode-goat", controller);
		expect(countCredentialRows(dbPath, "commandcode-goat")).toBe(2);
		expect(store.getApiKey("commandcode-goat")).toBe("cmd-test-key-2");
		expect(await authStorage.getApiKey("commandcode-goat", "session-commandcode")).toBe("cmd-test-key-2");
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

	it("stores OpenRouter login credentials as a reusable api-key credential", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginOpenRouterSpy.mockResolvedValueOnce("or-test-key");

		await authStorage.login("openrouter", { onAuth: () => {}, onPrompt: async () => "" });

		expect(countCredentialRows(dbPath, "openrouter")).toBe(1);
		const credentials = store.listAuthCredentials("openrouter");
		expect(credentials).toHaveLength(1);
		const [stored] = credentials;
		expect(stored?.credential.type).toBe("api_key");
		if (stored?.credential.type !== "api_key") {
			throw new Error("expected stored api-key credential");
		}
		expect(stored.credential.key).toBe("or-test-key");
		expect(await authStorage.getApiKey("openrouter", "session-openrouter")).toBe("or-test-key");
	});

	it("lists api-key credentials as removal targets and hard-removes them (logout)", async () => {
		if (!store || !authStorage || !dbPath) throw new Error("test setup failed");

		loginOpenRouterSpy.mockResolvedValueOnce("or-test-key");
		await authStorage.login("openrouter", { onAuth: () => {}, onPrompt: async () => "" });
		expect(countCredentialRows(dbPath, "openrouter")).toBe(1);

		const targets = store.listCredentialRemovalTargets("openrouter");
		expect(targets).toHaveLength(1);
		expect(targets[0]?.provider).toBe("openrouter");

		const result = store.removeAuthCredentialsHard(
			"openrouter",
			targets.map(target => ({ id: target.id, provider: "openrouter", expectedRevision: target.expectedRevision })),
		);
		expect(result.kind).toBe("removed");
		expect(countCredentialRows(dbPath, "openrouter")).toBe(0);
		expect(store.getApiKey("openrouter")).toBeNull();
	});
});
