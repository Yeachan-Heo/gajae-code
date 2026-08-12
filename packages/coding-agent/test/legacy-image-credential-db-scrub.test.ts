import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath } from "@gajae-code/utils";
import { RetiredImageSecretGateError, runRetiredImageSecretGate } from "../src/config/retired-image-secret-gate";

const tempDirs: string[] = [];
const openDatabases: Database[] = [];

async function makeWorkspace(): Promise<{ root: string; cwd: string; agentDir: string; dbPath: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-image-secret-db-"));
	tempDirs.push(root);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	return { root, cwd, agentDir, dbPath: getAgentDbPath(agentDir) };
}

function track(database: Database): Database {
	openDatabases.push(database);
	return database;
}

async function expectBlocked(action: Promise<unknown>, secret: string): Promise<void> {
	let caught: unknown;
	try {
		await action;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(RetiredImageSecretGateError);
	if (!(caught instanceof RetiredImageSecretGateError)) return;
	expect(caught.source).toBe("legacy-db");
	expect(caught.code).toBe("RETIRED_IMAGE_SECRET_GATE_BLOCKED");
	expect(caught.message).toContain("(legacy-db)");
	expect(caught.message).not.toContain(secret);
}

afterEach(async () => {
	for (const database of openDatabases.splice(0)) {
		try {
			database.close();
		} catch {
			// The test's assertion is authoritative; cleanup is best effort.
		}
	}
	for (const directory of tempDirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("retired image credential SQLite scrubbing", () => {
	it("scrubs modern bare/nested rows transactionally, handles case-variant Settings and WAL sidecars, and proves a clean reopen", async () => {
		const { cwd, agentDir, dbPath } = await makeWorkspace();
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const secrets = {
			bareKey: "modern-bare-key-secret",
			bareEnv: "modern-bare-env-secret",
			nestedEnv: "modern-nested-env-secret",
			caseVariant: "modern-case-variant-secret",
		};
		const writer = track(new Database(dbPath));
		writer.exec("PRAGMA journal_mode=WAL;");
		writer.exec(
			'CREATE TABLE "Settings" (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);',
		);
		writer
			.prepare("INSERT INTO Settings (key, value) VALUES (?, ?)")
			.run("imageCustomKey", JSON.stringify(secrets.bareKey));
		writer
			.prepare("INSERT INTO Settings (key, value) VALUES (?, ?)")
			.run("imageCustomKeyEnv", JSON.stringify(secrets.bareEnv));
		writer
			.prepare("INSERT INTO Settings (key, value) VALUES (?, ?)")
			.run("PROVIDERS.IMAGECUSTOMKEY", JSON.stringify(secrets.caseVariant));
		writer
			.prepare("INSERT INTO Settings (key, value) VALUES (?, ?)")
			.run("providers", JSON.stringify({ imageCustomKeyEnv: secrets.nestedEnv, retained: "safe" }));
		writer
			.prepare("INSERT INTO Settings (key, value) VALUES (?, ?)")
			.run("unrelated", JSON.stringify({ retained: true }));

		const sidecars = await Promise.all(
			(["-wal", "-shm", "-journal"] as const).map(async suffix => {
				try {
					await fs.stat(`${dbPath}${suffix}`);
					return suffix;
				} catch {
					return null;
				}
			}),
		);
		expect(sidecars).toContain("-wal");

		await runRetiredImageSecretGate({ cwd, agentDir });
		writer.close();
		openDatabases.splice(openDatabases.indexOf(writer), 1);

		const mainBytes = await fs.readFile(dbPath);
		for (const secret of Object.values(secrets)) expect(mainBytes.includes(Buffer.from(secret))).toBe(false);
		for (const suffix of ["-wal", "-journal"] as const) {
			try {
				const stat = await fs.lstat(`${dbPath}${suffix}`);
				expect(stat.isFile()).toBe(true);
				expect(stat.isSymbolicLink()).toBe(false);
				expect(stat.size).toBe(0);
			} catch (error) {
				expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
			}
		}

		const reopened = new Database(dbPath, { readonly: true, strict: true });
		try {
			const rows = reopened.prepare("SELECT key, value FROM Settings ORDER BY key").all() as Array<{
				key: string;
				value: string;
			}>;
			expect(rows.map(row => row.key)).toEqual(["providers", "unrelated"]);
			expect(JSON.parse(rows[0]!.value)).toEqual({ retained: "safe" });
			expect(JSON.parse(rows[1]!.value)).toEqual({ retained: true });
			const serialized = JSON.stringify(rows);
			for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
		} finally {
			reopened.close();
		}
	});

	it("scrubs the legacy single-blob shape and verifies the sanitized blob after reopening", async () => {
		const { cwd, agentDir, dbPath } = await makeWorkspace();
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const secret = "legacy-blob-secret";
		const database = track(new Database(dbPath));
		database.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);");
		database
			.prepare("INSERT INTO settings (id, data) VALUES (1, ?)")
			.run(JSON.stringify({ providers: { imageCustomKey: secret, retained: "safe" }, topLevel: true }));
		database.close();
		openDatabases.splice(openDatabases.indexOf(database), 1);

		await runRetiredImageSecretGate({ cwd, agentDir });

		const reopened = new Database(dbPath, { readonly: true, strict: true });
		try {
			const row = reopened.prepare("SELECT data FROM settings WHERE id = 1").get() as { data: string };
			const value = JSON.parse(row.data) as Record<string, unknown>;
			expect(value).toEqual({ providers: { retained: "safe" }, topLevel: true });
			expect(row.data).not.toContain(secret);
		} finally {
			reopened.close();
		}
	});

	it("scans and scrubs every row in the legacy single-blob table before a clean reopen", async () => {
		const { cwd, agentDir, dbPath } = await makeWorkspace();
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const secrets = [
			"legacy-blob-row-two-secret",
			"legacy-blob-row-three-secret",
			"legacy-blob-row-four-secret",
		] as const;
		const database = track(new Database(dbPath));
		database.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);");
		const insert = database.prepare("INSERT INTO settings (id, data) VALUES (?, ?)");
		insert.run(1, JSON.stringify({ retained: "first-row-safe" }));
		insert.run(2, JSON.stringify({ providers: { imageCustomKey: secrets[0], retained: "second-row-safe" }, row: 2 }));
		insert.run(3, JSON.stringify({ nested: { providers: { imageCustomKeyEnv: secrets[1] } }, row: 3 }));
		insert.run(4, JSON.stringify({ providers: { imageCustomKey: secrets[2] }, row: 4 }));
		database.close();
		openDatabases.splice(openDatabases.indexOf(database), 1);

		await runRetiredImageSecretGate({ cwd, agentDir });
		const mainBytes = await fs.readFile(dbPath);
		for (const secret of secrets) expect(mainBytes.includes(Buffer.from(secret))).toBe(false);

		const reopened = new Database(dbPath, { readonly: true, strict: true });
		try {
			const rows = reopened.prepare("SELECT id, data FROM settings ORDER BY id").all() as Array<{
				id: number;
				data: string;
			}>;
			expect(rows).toHaveLength(4);
			expect(JSON.parse(rows[0]!.data)).toEqual({ retained: "first-row-safe" });
			expect(JSON.parse(rows[1]!.data)).toEqual({
				providers: { retained: "second-row-safe" },
				row: 2,
			});
			expect(JSON.parse(rows[2]!.data)).toEqual({ nested: { providers: {} }, row: 3 });
			expect(JSON.parse(rows[3]!.data)).toEqual({ providers: {}, row: 4 });
			const serialized = JSON.stringify(rows);
			for (const secret of secrets) expect(serialized).not.toContain(secret);
		} finally {
			reopened.close();
		}
	});

	it("fails closed on a deterministic SQLITE_BUSY writer without exposing the retained secret", async () => {
		const { cwd, agentDir, dbPath } = await makeWorkspace();
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const secret = "busy-retained-secret";
		const holder = track(new Database(dbPath));
		holder.exec("PRAGMA journal_mode=WAL;");
		holder.exec(
			"CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);",
		);
		holder
			.prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
			.run("providers.imageCustomKey", JSON.stringify(secret));
		holder.exec("BEGIN IMMEDIATE;");

		try {
			await expectBlocked(runRetiredImageSecretGate({ cwd, agentDir }), secret);
		} finally {
			holder.exec("ROLLBACK;");
		}
		const proof = new Database(dbPath, { readonly: true, strict: true });
		try {
			const row = proof.prepare("SELECT value FROM settings WHERE key = ?").get("providers.imageCustomKey") as
				| {
						value?: string;
				  }
				| undefined;
			expect(row?.value).toBe(JSON.stringify(secret));
		} finally {
			proof.close();
		}
	});
});
