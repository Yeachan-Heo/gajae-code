import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialIfAbsentResult,
	type AuthCredentialStore,
	AuthStorage,
	REMOTE_REFRESH_SENTINEL,
	SqliteAuthCredentialStore,
} from "../src/auth-storage";
import { withEnv } from "./helpers";

const SUPPRESS_ANTHROPIC_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
} as const;

function oauth(suffix = "1"): AuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60_000,
		accountId: `acct-${suffix}`,
		email: `user-${suffix}@example.com`,
	};
}

class CountingStore implements AuthCredentialStore {
	rows: ReturnType<SqliteAuthCredentialStore["listAuthCredentials"]> = [];
	ifAbsentCalls = 0;
	remoteIfAbsentCalls = 0;
	close(): void {}
	listAuthCredentials(provider?: string) {
		return provider ? this.rows.filter(row => row.provider === provider) : this.rows;
	}
	updateAuthCredential(): void {}
	deleteAuthCredential(): void {}
	tryDisableAuthCredentialIfMatches(): boolean {
		return false;
	}
	replaceAuthCredentialsForProvider(): never {
		throw new Error("not used");
	}
	upsertAuthCredentialForProvider(): never {
		throw new Error("local upsert must not be used");
	}
	upsertAuthCredentialForProviderIfAbsent(provider: string, credential: AuthCredential): AuthCredentialIfAbsentResult {
		this.ifAbsentCalls += 1;
		this.rows = [{ id: 1, provider, credential, disabledCause: null }];
		return { inserted: true, reason: "inserted", provider, entries: this.rows };
	}
	async upsertAuthCredentialRemoteIfAbsent(
		provider: string,
		credential: AuthCredential,
	): Promise<AuthCredentialIfAbsentResult> {
		this.remoteIfAbsentCalls += 1;
		this.rows = [{ id: 2, provider, credential, disabledCause: null }];
		return { inserted: true, reason: "inserted", provider, entries: this.rows };
	}
	deleteAuthCredentialsForProvider(): void {}
	getCache(): string | null {
		return null;
	}
	setCache(): void {}
	cleanExpiredCache(): void {}
}

describe("if-absent auth credential writes", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-if-absent-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("SqliteAuthCredentialStore inserts when empty and skips when any active row exists", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			const inserted = store.upsertAuthCredentialForProviderIfAbsent("anthropic", oauth("a"));
			expect(inserted.inserted).toBe(true);
			expect(inserted.reason).toBe("inserted");
			expect(inserted.entries).toHaveLength(1);

			const skippedOauth = store.upsertAuthCredentialForProviderIfAbsent("anthropic", oauth("b"));
			expect(skippedOauth.inserted).toBe(false);
			expect(skippedOauth.reason).toBe("skipped-existing");
			expect(skippedOauth.entries).toHaveLength(1);

			const apiStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "api.db"));
			try {
				apiStore.saveApiKey("anthropic", "api-key");
				const skippedApiKey = apiStore.upsertAuthCredentialForProviderIfAbsent("anthropic", oauth("c"));
				expect(skippedApiKey.inserted).toBe(false);
				expect(skippedApiKey.reason).toBe("skipped-existing");
				expect(skippedApiKey.entries).toHaveLength(1);
				expect(skippedApiKey.entries[0].credential.type).toBe("api_key");
			} finally {
				apiStore.close();
			}
		} finally {
			store.close();
		}
	});

	test("SqliteAuthCredentialStore returns skipped-invalid without inserting", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "invalid.db"));
		try {
			const result = store.upsertAuthCredentialForProviderIfAbsent("anthropic", {
				type: "bogus",
			} as unknown as AuthCredential);
			expect(result).toEqual({ inserted: false, reason: "skipped-invalid", provider: "anthropic", entries: [] });
			expect(store.listAuthCredentials("anthropic")).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("two worker processes racing if-absent leave one active row and one skipped-existing loser", async () => {
		const dbPath = path.join(tempDir, "race.db");
		const startPath = path.join(tempDir, "race.start");
		const readyPaths = [path.join(tempDir, "worker-1.ready"), path.join(tempDir, "worker-2.ready")];
		const packageDir = path.resolve(import.meta.dir, "..");

		const setup = await SqliteAuthCredentialStore.open(dbPath);
		setup.close();

		let lockDb: Database | undefined;
		try {
			const workerCode = String.raw`
const fs = require("node:fs");
const { SqliteAuthCredentialStore } = await import("./src/auth-storage.ts");
const dbPath = process.env.AUTH_RACE_DB_PATH;
const readyPath = process.env.AUTH_RACE_READY_PATH;
const startPath = process.env.AUTH_RACE_START_PATH;
const suffix = process.env.AUTH_RACE_SUFFIX;
try {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	try {
		fs.writeFileSync(readyPath, "ready");
		const deadline = Date.now() + 5000;
		while (!fs.existsSync(startPath)) {
			if (Date.now() > deadline) throw new Error("timed out waiting for start barrier");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
		const result = store.upsertAuthCredentialForProviderIfAbsent("anthropic", {
			type: "oauth",
			access: "access-" + suffix,
			refresh: "refresh-" + suffix,
			expires: Date.now() + 60000,
			accountId: "acct-" + suffix,
			email: "user-" + suffix + "@example.com",
		});
		console.log(JSON.stringify({ inserted: result.inserted, reason: result.reason }));
	} finally {
		store.close();
	}
} catch (error) {
	console.error(error instanceof Error ? error.name + ": " + error.message + "\n" + (error.stack ?? "") : String(error));
	process.exit(1);
}
`;

			const workers = readyPaths.map((readyPath, index) =>
				Bun.spawn(["bun", "-e", workerCode], {
					cwd: packageDir,
					env: {
						...process.env,
						AUTH_RACE_DB_PATH: dbPath,
						AUTH_RACE_READY_PATH: readyPath,
						AUTH_RACE_START_PATH: startPath,
						AUTH_RACE_SUFFIX: String(index + 1),
					},
					stderr: "pipe",
					stdout: "pipe",
				}),
			);

			const readyDeadline = Date.now() + 5000;
			while (!(await Promise.all(readyPaths.map(readyPath => fs.exists(readyPath)))).every(Boolean)) {
				if (Date.now() > readyDeadline) throw new Error("timed out waiting for worker ready barriers");
				await Bun.sleep(10);
			}

			lockDb = new Database(dbPath);
			lockDb.run("PRAGMA busy_timeout=5000");
			lockDb.run("BEGIN IMMEDIATE");

			await fs.writeFile(startPath, "start");
			await Bun.sleep(250);
			lockDb.run("COMMIT");

			const outputs = await Promise.all(
				workers.map(async worker => ({
					exitCode: await worker.exited,
					stdout: await new Response(worker.stdout).text(),
					stderr: await new Response(worker.stderr).text(),
				})),
			);

			expect(outputs.map(output => ({ exitCode: output.exitCode, stderr: output.stderr }))).toEqual([
				{ exitCode: 0, stderr: "" },
				{ exitCode: 0, stderr: "" },
			]);
			const results = outputs.map(
				output => JSON.parse(output.stdout.trim()) as Pick<AuthCredentialIfAbsentResult, "inserted" | "reason">,
			);
			expect(results.filter(result => result.inserted && result.reason === "inserted")).toHaveLength(1);
			expect(results.filter(result => !result.inserted && result.reason === "skipped-existing")).toHaveLength(1);
		} finally {
			if (lockDb?.inTransaction) lockDb.run("ROLLBACK");
			lockDb?.close();
		}

		const finalStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(finalStore.listAuthCredentials("anthropic")).toHaveLength(1);
		} finally {
			finalStore.close();
		}
	}, 10_000);

	test("SqliteAuthCredentialStore returns skipped-invalid for cyclic OAuth credentials without inserting", async () => {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "cyclic.db"));
		try {
			const credential = oauth("cyclic") as AuthCredential & { cycle?: unknown };
			credential.cycle = credential;

			const result = store.upsertAuthCredentialForProviderIfAbsent("anthropic", credential);

			expect(result).toEqual({ inserted: false, reason: "skipped-invalid", provider: "anthropic", entries: [] });
			expect(store.listAuthCredentials("anthropic")).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("AuthStorage.importCredentialIfAbsent classifies broad pre-skip sources before store writes", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const runtimeStore = new CountingStore();
			const runtime = new AuthStorage(runtimeStore);
			runtime.setRuntimeApiKey("anthropic", "runtime");
			expect((await runtime.importCredentialIfAbsent("anthropic", oauth("runtime"))).reason).toBe(
				"skipped-existing-runtime",
			);
			expect(runtimeStore.ifAbsentCalls).toBe(0);

			const configStore = new CountingStore();
			const config = new AuthStorage(configStore);
			config.setConfigApiKey("anthropic", "config");
			expect((await config.importCredentialIfAbsent("anthropic", oauth("config"))).reason).toBe(
				"skipped-existing-config",
			);
			expect(configStore.ifAbsentCalls).toBe(0);

			const storedStore = new CountingStore();
			storedStore.rows = [{ id: 7, provider: "anthropic", credential: oauth("stored"), disabledCause: null }];
			const stored = new AuthStorage(storedStore);
			await stored.reload();
			expect((await stored.importCredentialIfAbsent("anthropic", oauth("incoming"))).reason).toBe(
				"skipped-existing",
			);
			expect(storedStore.ifAbsentCalls).toBe(0);

			const fallbackStore = new CountingStore();
			const fallback = new AuthStorage(fallbackStore);
			fallback.setFallbackResolver(provider => (provider === "anthropic" ? "fallback" : undefined));
			expect((await fallback.importCredentialIfAbsent("anthropic", oauth("fallback"))).reason).toBe(
				"skipped-existing-fallback",
			);
			expect(fallbackStore.ifAbsentCalls).toBe(0);
		});

		await withEnv({ ANTHROPIC_API_KEY: "env-key", ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
			const envStore = new CountingStore();
			const envStorage = new AuthStorage(envStore);
			expect((await envStorage.importCredentialIfAbsent("anthropic", oauth("env"))).reason).toBe(
				"skipped-existing-env",
			);
			expect(envStore.ifAbsentCalls).toBe(0);
		});
	});

	test("AuthStorage.importCredentialIfAbsent delegates to remote if-absent and redacts OAuth refresh", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const store = new CountingStore();
			const storage = new AuthStorage(store);
			const result = await storage.importCredentialIfAbsent("anthropic", oauth("remote"));
			expect(store.remoteIfAbsentCalls).toBe(1);
			expect(store.ifAbsentCalls).toBe(0);
			expect(result.inserted).toBe(true);
			expect(result.entries[0].credential.type).toBe("oauth");
			if (result.entries[0].credential.type === "oauth") {
				expect(result.entries[0].credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
			}
		});
	});

	test("AuthStorage.importCredentialIfAbsent inserts into empty local storage", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "local.db"));
			const storage = new AuthStorage(store);
			try {
				await storage.reload();
				const result = await storage.importCredentialIfAbsent("anthropic", oauth("local"));
				expect(result.inserted).toBe(true);
				expect(result.reason).toBe("inserted");
				expect(storage.has("anthropic")).toBe(true);
				expect(result.entries).toHaveLength(1);
			} finally {
				storage.close();
			}
		});
	});
});
