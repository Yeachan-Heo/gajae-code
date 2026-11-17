import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, isSqliteCorruptionError, SqliteAuthCredentialStore } from "@gajae-code/ai/core";
import { OAuthSelectorComponent } from "../src/modes/components/oauth-selector";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { setThemeInstance } from "../src/modes/theme/theme";
import { CREDENTIAL_STORE_UNREADABLE_MESSAGE } from "../src/session/credential-store-errors";
import { loadTestTheme } from "./helpers/test-theme";

const roots: string[] = [];
const cliEntry = path.join(import.meta.dir, "../src/cli.ts");

beforeAll(async () => {
	const testTheme = await loadTestTheme();
	setThemeInstance(testTheme);
});

async function tempRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

async function seedCredentialDb(dbPath: string): Promise<void> {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	try {
		for (let index = 0; index < 400; index += 1) {
			const provider = index % 5 === 0 ? "anthropic" : `fixture-provider-${index % 5}`;
			store.saveOAuth(provider, {
				access: `access-${index}`,
				refresh: `refresh-${index}`,
				expires: Date.now() + 60_000,
				email: `account-${index}@example.test`,
			});
		}
	} finally {
		store.close();
	}
}

async function corruptIndexRootPage(dbPath: string, indexName: string): Promise<Buffer<ArrayBuffer>> {
	const database = new Database(dbPath);
	let pageSize: number;
	let rootPage: number;
	try {
		database.run("PRAGMA wal_checkpoint(TRUNCATE)");
		pageSize = (database.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
		rootPage = (
			database.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName) as {
				rootpage: number;
			}
		).rootpage;
	} finally {
		database.close();
	}
	const fileBytes = new Uint8Array(await Bun.file(dbPath).arrayBuffer());
	const bytes = Buffer.alloc(fileBytes.byteLength);
	bytes.set(fileBytes);
	const pageOffset = (rootPage - 1) * pageSize;
	expect(bytes[pageOffset]).toBe(2);
	bytes[pageOffset] = 0;
	await Bun.write(dbPath, bytes);
	return bytes;
}

async function captureOpenError(dbPath: string): Promise<unknown> {
	try {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.close();
		return undefined;
	} catch (error) {
		return error;
	}
}

function captureSqliteError(operation: () => void): unknown {
	try {
		operation();
		return undefined;
	} catch (error) {
		return error;
	}
}

async function runAccounts(
	agentDir: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const root = path.dirname(agentDir);
	const processHandle = Bun.spawn([process.execPath, cliEntry, "accounts", ...args], {
		cwd: path.join(import.meta.dir, "../../.."),
		env: {
			CI: "1",
			HOME: root,
			NO_COLOR: "1",
			PATH: process.env.PATH ?? "",
			TMPDIR: root,
			XDG_CACHE_HOME: path.join(root, "cache"),
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_STATE_HOME: path.join(root, "state"),
			GJC_CODING_AGENT_DIR: agentDir,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	return { exitCode, stdout, stderr };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("credential SQLite corruption classification", () => {
	test("recognizes only SQLITE_CORRUPT and SQLITE_NOTADB from isolated credential stores", async () => {
		const root = await tempRoot("gjc-credential-errors-");
		const validPath = path.join(root, "valid.db");
		await seedCredentialDb(validPath);
		const validStore = await SqliteAuthCredentialStore.open(validPath);
		expect(validStore.listCredentialInventory("anthropic").length).toBeGreaterThan(0);
		validStore.close();

		const corruptPath = path.join(root, "corrupt.db");
		await Bun.write(corruptPath, Bun.file(validPath));
		await corruptIndexRootPage(corruptPath, "idx_auth_provider");
		const corruptStore = await SqliteAuthCredentialStore.open(corruptPath);
		const corruptError = captureSqliteError(() => corruptStore.listCredentialInventory("anthropic"));
		corruptStore.close();
		expect(corruptError).toMatchObject({ code: "SQLITE_CORRUPT" });
		expect(isSqliteCorruptionError(corruptError)).toBe(true);

		const notDatabasePath = path.join(root, "not-a-database.db");
		await Bun.write(notDatabasePath, "not a database token=credential-secret");
		const notDatabaseError = await captureOpenError(notDatabasePath);
		expect(notDatabaseError).toMatchObject({ code: "SQLITE_NOTADB" });
		expect(isSqliteCorruptionError(notDatabaseError)).toBe(true);

		const malformedPath = path.join(root, "malformed-schema.db");
		const malformed = new Database(malformedPath);
		malformed.run("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT)");
		malformed.close();
		const malformedError = await captureOpenError(malformedPath);
		expect(malformedError).toMatchObject({ code: "SQLITE_ERROR" });
		expect(isSqliteCorruptionError(malformedError)).toBe(false);

		const busyPath = path.join(root, "busy.db");
		await Bun.write(busyPath, Bun.file(validPath));
		const lock = new Database(busyPath);
		lock.run("PRAGMA journal_mode=DELETE");
		lock.run("BEGIN EXCLUSIVE");
		const contender = new Database(busyPath);
		contender.run("PRAGMA busy_timeout=1");
		const busyError = captureSqliteError(() => contender.run("PRAGMA journal_mode=WAL"));
		contender.close();
		lock.run("ROLLBACK");
		lock.close();
		expect(busyError).toMatchObject({ code: "SQLITE_BUSY" });
		expect(isSqliteCorruptionError(busyError)).toBe(false);
	});

	test("healthy hard logout keeps credential indexes consistent", async () => {
		const root = await tempRoot("gjc-credential-logout-");
		const dbPath = path.join(root, "agent.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth("anthropic", {
			access: "access-a",
			refresh: "refresh-a",
			expires: Date.now() + 60_000,
			email: "a@example.test",
		});
		store.saveOAuth("anthropic", {
			access: "access-b",
			refresh: "refresh-b",
			expires: Date.now() + 60_000,
			email: "b@example.test",
		});
		const before = store.listCredentialInventory("anthropic");
		expect(before).toHaveLength(2);
		const removed = store.removeAuthCredentialsHard("anthropic", [
			{ id: before[0]!.id, provider: "anthropic", expectedRevision: 1 },
		]);
		expect(removed).toEqual({ kind: "removed", ids: [before[0]!.id] });
		expect(store.listCredentialInventory("anthropic").map(row => row.id)).toEqual([before[1]!.id]);
		store.close();

		const database = new Database(dbPath, { readonly: true });
		try {
			expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
			expect(
				database
					.prepare(
						"SELECT count(*) AS count FROM auth_credentials INDEXED BY idx_auth_provider WHERE provider = ?",
					)
					.get("anthropic"),
			).toEqual({ count: 1 });
			expect(
				database
					.prepare(
						"SELECT count(*) AS count FROM auth_credentials INDEXED BY idx_auth_provider_identity WHERE provider = ? AND identity_key IS NOT NULL",
					)
					.get("anthropic"),
			).toEqual({ count: 1 });
		} finally {
			database.close();
		}
	});

	test.each(["SQLITE_CORRUPT", "SQLITE_BUSY"])("OAuth refresh persistence propagates %s", async code => {
		const root = await tempRoot("gjc-credential-refresh-write-");
		const dbPath = path.join(root, "agent.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth("anthropic", {
			access: "expired-access",
			refresh: "refresh-token",
			expires: Date.now() - 60_000,
			email: "refresh@example.test",
		});
		let refreshCalls = 0;
		const authStorage = new AuthStorage(store, {
			refreshOAuthCredential: async () => {
				refreshCalls += 1;
				return {
					access: "fresh-access",
					refresh: "fresh-refresh",
					expires: Date.now() + 60_000,
					email: "refresh@example.test",
				};
			},
		});
		await authStorage.reload();
		store.updateAuthCredential = () => {
			throw Object.assign(new Error("credential database persistence failed"), { code });
		};

		await expect(authStorage.getApiKey("anthropic")).rejects.toMatchObject({ code });
		expect(refreshCalls).toBe(1);
		store.close();
	});

	test("the real SQLite update path propagates index corruption", async () => {
		const root = await tempRoot("gjc-credential-real-update-");
		const dbPath = path.join(root, "agent.db");
		await seedCredentialDb(dbPath);
		await corruptIndexRootPage(dbPath, "idx_auth_provider_identity");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const row = store.listCredentialInventory("anthropic")[0];
		expect(row).toBeDefined();
		expect(() =>
			store.updateAuthCredential(row!.id, {
				type: "oauth",
				access: "replacement-access",
				refresh: "replacement-refresh",
				expires: Date.now() + 60_000,
				email: row!.email,
			}),
		).toThrow(expect.objectContaining({ code: "SQLITE_CORRUPT" }));
		store.close();
	});
});

describe("credential corruption presentation", () => {
	test("bare /login async validation surfaces known corruption through the selector callback", async () => {
		const corruption = Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
		const errors: string[] = [];
		let selector: OAuthSelectorComponent;
		selector = new OAuthSelectorComponent(
			"login",
			{
				hasAuth: (provider: string) => provider === "anthropic",
				getGeneration: () => 1,
			} as never,
			() => undefined,
			() => undefined,
			{
				validateAuth: async () => {
					throw corruption;
				},
				onValidationError: error => {
					if (!isSqliteCorruptionError(error)) return false;
					selector.stopValidation();
					errors.push(CREDENTIAL_STORE_UNREADABLE_MESSAGE);
					return true;
				},
			},
		);
		await Bun.sleep(0);
		expect(errors).toEqual([CREDENTIAL_STORE_UNREADABLE_MESSAGE]);
		selector.dispose();

		const pending = Promise.withResolvers<boolean>();
		const staleErrors: unknown[] = [];
		const staleSelector = new OAuthSelectorComponent(
			"login",
			{
				hasAuth: (provider: string) => provider === "anthropic",
				getGeneration: () => 1,
			} as never,
			() => undefined,
			() => undefined,
			{
				validateAuth: () => pending.promise,
				onValidationError: error => {
					staleErrors.push(error);
					return true;
				},
			},
		);
		staleSelector.dispose();
		pending.reject(corruption);
		await Bun.sleep(0);
		expect(staleErrors).toEqual([]);
	});

	test("bare /logout maps corruption, surfaces SQLite busy, and contains provider failures", async () => {
		const errors: string[] = [];
		const corruptionController = new SelectorController({
			session: {
				credentialSessionId: "credential-session",
				modelRegistry: {
					getApiKeyForProvider: async () => {
						throw Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
					},
				},
			},
			showError: (message: string) => errors.push(message),
		} as never);
		await expect(corruptionController.showOAuthSelector("logout")).resolves.toBeUndefined();
		expect(errors).toEqual([CREDENTIAL_STORE_UNREADABLE_MESSAGE]);

		const busyController = new SelectorController({
			session: {
				credentialSessionId: "credential-session",
				modelRegistry: {
					getApiKeyForProvider: async () => {
						throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
					},
				},
			},
			showError: (message: string) => errors.push(message),
		} as never);
		await expect(busyController.showOAuthSelector("logout")).resolves.toBeUndefined();
		expect(errors.at(-1)).toBe("Logout failed: credential store operation failed (SQLITE_BUSY).");

		const arbitraryFailure = new Error("credential refresh transport failed");
		const arbitraryController = new SelectorController({
			isStopped: () => true,
			session: {
				credentialSessionId: "credential-session",
				modelRegistry: {
					authStorage: { hasAuth: () => true },
					getApiKeyForProvider: async () => {
						throw arbitraryFailure;
					},
				},
			},
			showError: () => errors.push("unexpected arbitrary error"),
		} as never);
		await expect(arbitraryController.showOAuthSelector("logout")).resolves.toBeUndefined();
		expect(errors).not.toContain("unexpected arbitrary error");
	});

	test("provider /login contains SQLITE_CORRUPT without closing or rewriting the credential store", async () => {
		const root = await tempRoot("gjc-credential-login-");
		const dbPath = path.join(root, "agent.db");
		await seedCredentialDb(dbPath);
		const corruptedBytes = await corruptIndexRootPage(dbPath, "idx_auth_provider");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const errors: string[] = [];
		const controller = new SelectorController({
			session: {
				modelRegistry: {
					authStorage: new AuthStorage(store),
					getModelProfiles: () => new Map(),
				},
			},
			showError: (message: string) => errors.push(message),
		} as never);

		await expect(controller.showOAuthSelector("login", "anthropic")).resolves.toBeUndefined();
		expect(errors).toEqual([CREDENTIAL_STORE_UNREADABLE_MESSAGE]);
		expect(errors[0]!.length).toBeLessThanOrEqual(256);
		expect(errors[0]).not.toMatch(/SQLITE_|database disk image|access-|refresh-|example\.test/);
		expect(Buffer.from(await Bun.file(dbPath).arrayBuffer())).toEqual(corruptedBytes);
		store.close();
	});

	test("accounts list emits bounded redacted text and JSON errors while preserving SQLITE_NOTADB files", async () => {
		const root = await tempRoot("gjc-credential-accounts-");
		const agentDir = path.join(root, "agent");
		const dbPath = path.join(agentDir, "agent.db");
		await fs.mkdir(agentDir, { recursive: true });
		const original = Buffer.from("not a database token=credential-secret");
		await Bun.write(dbPath, original);

		const text = await runAccounts(agentDir, ["list"]);
		expect(text.exitCode).toBe(1);
		expect(text.stdout).toBe("");
		expect(text.stderr).toBe(`${CREDENTIAL_STORE_UNREADABLE_MESSAGE}\n`);
		expect(text.stderr.length).toBeLessThanOrEqual(512);
		expect(text.stderr).not.toMatch(/credential-secret|SQLITE_|file is not a database/);
		expect(Buffer.from(await Bun.file(dbPath).arrayBuffer())).toEqual(original);

		const json = await runAccounts(agentDir, ["list", "--json"]);
		expect(json.exitCode).toBe(1);
		expect(json.stderr).toBe("");
		expect(JSON.parse(json.stdout)).toEqual({
			ok: false,
			error: { code: "accounts-error", message: CREDENTIAL_STORE_UNREADABLE_MESSAGE },
		});
		expect(json.stdout.length).toBeLessThanOrEqual(768);
		expect(json.stdout).not.toMatch(/credential-secret|SQLITE_|file is not a database/);
		expect(Buffer.from(await Bun.file(dbPath).arrayBuffer())).toEqual(original);
	});
});
