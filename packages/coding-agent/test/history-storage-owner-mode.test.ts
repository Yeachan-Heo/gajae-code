import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HistoryStorage } from "@gajae-code/coding-agent/session/history-storage";

const skipPosix = process.platform === "win32";
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-history-mode-"));
	tempRoots.push(dir);
	return dir;
}

async function relaxForCleanup(dir: string): Promise<void> {
	await fs.chmod(dir, 0o700).catch(() => undefined);
	const names = await fs.readdir(dir).catch(() => []);
	for (const name of names) {
		const child = path.join(dir, name);
		const stat = await fs.lstat(child).catch(() => undefined);
		if (stat?.isDirectory() && !stat.isSymbolicLink()) await relaxForCleanup(child);
	}
}

afterAll(async () => {
	HistoryStorage.resetInstance();
	await Promise.all(
		tempRoots.splice(0).map(async dir => {
			await relaxForCleanup(dir);
			await fs.rm(dir, { recursive: true, force: true });
		}),
	);
});

async function modeOf(filePath: string): Promise<number> {
	return (await fs.lstat(filePath)).mode & 0o777;
}

describe("history database owner-only files", () => {
	it("still allows a history readback", async () => {
		const root = await tempDir();
		vi.useFakeTimers();
		try {
			HistoryStorage.resetInstance();
			const storage = HistoryStorage.open(path.join(root, "history.db"));
			const pending = storage.add("still-allowed prompt", root);
			vi.advanceTimersByTime(100);
			await pending;
			expect(storage.getRecent(5).map(row => row.prompt)).toEqual(["still-allowed prompt"]);
		} finally {
			HistoryStorage.resetInstance();
			vi.useRealTimers();
		}
	});

	it.skipIf(skipPosix)("creates history.db and WAL sidecars mode 0600 under a permissive umask", async () => {
		const previous = process.umask(0);
		try {
			const root = await tempDir();
			const parent = path.join(root, "data");
			const dbPath = path.join(parent, "history.db");
			HistoryStorage.resetInstance();
			const storage = await HistoryStorage.openAsync(dbPath);
			expect(storage.getRecent(1)).toEqual([]);
			expect(await modeOf(parent)).toBe(0o700);
			for (const suffix of ["", "-wal", "-shm"]) {
				expect(await modeOf(`${dbPath}${suffix}`)).toBe(0o600);
			}
		} finally {
			HistoryStorage.resetInstance();
			process.umask(previous);
		}
	});

	it.skipIf(skipPosix)("tightens an existing mode 0666 history database and its sidecars", async () => {
		const root = await tempDir();
		const parent = path.join(root, "data");
		await fs.mkdir(parent, { mode: 0o755 });
		const dbPath = path.join(parent, "history.db");
		vi.useFakeTimers();
		try {
			HistoryStorage.resetInstance();
			const first = HistoryStorage.open(dbPath);
			const pending = first.add("kept prompt", root);
			vi.advanceTimersByTime(100);
			await pending;
			HistoryStorage.resetInstance();
			await fs.chmod(parent, 0o755);
			for (const suffix of ["", "-wal", "-shm"]) await fs.chmod(`${dbPath}${suffix}`, 0o666);

			const again = HistoryStorage.open(dbPath);
			expect(again.getRecent(5).map(row => row.prompt)).toEqual(["kept prompt"]);
			expect(await modeOf(parent)).toBe(0o700);
			for (const suffix of ["", "-wal", "-shm"]) expect(await modeOf(`${dbPath}${suffix}`)).toBe(0o600);
		} finally {
			HistoryStorage.resetInstance();
			vi.useRealTimers();
		}
	});

	it.skipIf(skipPosix)("refuses a symlink history database without writing the target", async () => {
		const root = await tempDir();
		const victim = path.join(root, "victim.db");
		HistoryStorage.resetInstance();
		HistoryStorage.open(victim);
		HistoryStorage.resetInstance();
		const marker = "victim-marker";
		const { Database } = await import("bun:sqlite");
		const probe = new Database(victim);
		probe.run("CREATE TABLE IF NOT EXISTS marker (note TEXT)");
		probe.run("INSERT INTO marker (note) VALUES (?)", [marker]);
		probe.close();
		const before = await fs.readFile(victim);
		const link = path.join(root, "history.db");
		await fs.symlink(victim, link);

		expect(() => HistoryStorage.open(link)).toThrow(/not a regular file/);
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(victim)).toEqual(before);
	});

	it.skipIf(skipPosix)("refuses a symlink history directory without creating a database", async () => {
		const dir = await tempDir();
		const outside = path.join(dir, "outside");
		await fs.mkdir(outside);
		const link = path.join(dir, "data");
		await fs.symlink(outside, link, "dir");
		HistoryStorage.resetInstance();
		expect(() => HistoryStorage.open(path.join(link, "history.db"))).toThrow(/not a real directory/);
		expect(await fs.readdir(outside)).toEqual([]);
	});

	it.skipIf(skipPosix)("still allows a history file inside a sticky directory", async () => {
		const root = await tempDir();
		const parent = path.join(root, "sticky");
		await fs.mkdir(parent, { mode: 0o755 });
		await fs.chmod(parent, 0o1755);
		const dbPath = path.join(parent, "history.db");
		HistoryStorage.resetInstance();
		const storage = HistoryStorage.open(dbPath);
		expect(storage.getRecent(1)).toEqual([]);
		expect((await fs.lstat(parent)).mode & 0o1777).toBe(0o1755);
	});

	it.skipIf(skipPosix)("still allows history open in a mode 0300 directory", async () => {
		const root = await tempDir();
		const parent = path.join(root, "data");
		await fs.mkdir(parent);
		await fs.chmod(parent, 0o300);
		try {
			HistoryStorage.resetInstance();
			const storage = HistoryStorage.open(path.join(parent, "history.db"));
			expect(storage.getRecent(1)).toEqual([]);
			expect(await modeOf(parent)).toBe(0o300);
		} finally {
			HistoryStorage.resetInstance();
			await fs.chmod(parent, 0o700);
		}
	});

	it.skipIf(skipPosix)("creates mode 0600 history files in a mode 0300 directory", async () => {
		const root = await tempDir();
		const parent = path.join(root, "data");
		await fs.mkdir(parent);
		await fs.chmod(parent, 0o300);
		const dbPath = path.join(parent, "history.db");
		try {
			HistoryStorage.resetInstance();
			const storage = HistoryStorage.open(dbPath);
			expect(storage.getRecent(1)).toEqual([]);
			expect(await modeOf(parent)).toBe(0o300);
			for (const suffix of ["", "-wal", "-shm"]) expect(await modeOf(`${dbPath}${suffix}`)).toBe(0o600);
		} finally {
			HistoryStorage.resetInstance();
			await fs.chmod(parent, 0o700);
		}
	});

	it.skipIf(skipPosix)("tightens a mode 0333 history directory to 0700 and creates mode 0600 files", async () => {
		const root = await tempDir();
		const parent = path.join(root, "data");
		await fs.mkdir(parent);
		await fs.chmod(parent, 0o333);
		const dbPath = path.join(parent, "history.db");
		vi.useFakeTimers();
		try {
			HistoryStorage.resetInstance();
			const storage = HistoryStorage.open(dbPath);
			const pending = storage.add("readable prompt", root);
			vi.advanceTimersByTime(100);
			await pending;
			expect(storage.getRecent(5).map(row => row.prompt)).toEqual(["readable prompt"]);
			expect(await modeOf(parent)).toBe(0o700);
			for (const suffix of ["", "-wal", "-shm"]) expect(await modeOf(`${dbPath}${suffix}`)).toBe(0o600);
		} finally {
			HistoryStorage.resetInstance();
			vi.useRealTimers();
			await fs.chmod(parent, 0o700);
		}
	});

	it.skipIf(skipPosix)("refuses a WAL symlink before creating history.db", async () => {
		const root = await tempDir();
		const parent = path.join(root, "data");
		await fs.mkdir(parent, { mode: 0o755 });
		await fs.chmod(parent, 0o755);
		const outside = path.join(root, "outside.db");
		await fs.writeFile(outside, "kept");
		const dbPath = path.join(parent, "history.db");
		await fs.symlink(outside, `${dbPath}-wal`);
		HistoryStorage.resetInstance();
		expect(() => HistoryStorage.open(dbPath)).toThrow(/not a regular file/);
		await expect(fs.lstat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(outside, "utf-8")).toBe("kept");
		expect((await fs.lstat(`${dbPath}-wal`)).isSymbolicLink()).toBe(true);
		expect(await modeOf(parent)).toBe(0o755);
	});

	it.skipIf(skipPosix)("refuses a WAL symlink in a mode 0333 directory without creating the database", async () => {
		const root = await tempDir();
		const parent = path.join(root, "data");
		await fs.mkdir(parent);
		await fs.chmod(parent, 0o333);
		const outside = path.join(root, "outside.db");
		await fs.writeFile(outside, "kept");
		const dbPath = path.join(parent, "history.db");
		await fs.symlink(outside, `${dbPath}-wal`);
		try {
			HistoryStorage.resetInstance();
			expect(() => HistoryStorage.open(dbPath)).toThrow(/not a regular file/);
			await expect(fs.lstat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await fs.readFile(outside, "utf-8")).toBe("kept");
			expect((await fs.lstat(`${dbPath}-wal`)).isSymbolicLink()).toBe(true);
			expect(await modeOf(parent)).toBe(0o333);
		} finally {
			HistoryStorage.resetInstance();
			await fs.chmod(parent, 0o700);
		}
	});

	it.skipIf(skipPosix)("refuses a sidecar symlink without changing the existing database", async () => {
		const root = await tempDir();
		const parent = path.join(root, "data");
		await fs.mkdir(parent);
		const dbPath = path.join(parent, "history.db");
		HistoryStorage.resetInstance();
		HistoryStorage.open(dbPath);
		HistoryStorage.resetInstance();
		await fs.chmod(dbPath, 0o666);
		await fs.chmod(parent, 0o755);
		const outside = path.join(root, "outside-shm");
		await fs.writeFile(outside, "kept");
		await fs.rm(`${dbPath}-shm`);
		await fs.symlink(outside, `${dbPath}-shm`);
		expect(() => HistoryStorage.open(dbPath)).toThrow(/not a regular file/);
		expect(await modeOf(dbPath)).toBe(0o666);
		expect(await modeOf(parent)).toBe(0o755);
		expect(await fs.readFile(outside, "utf-8")).toBe("kept");
		expect((await fs.lstat(`${dbPath}-shm`)).isSymbolicLink()).toBe(true);
	});

	it("leaves the history database in place when the first open fails", () => {
		const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-history-mode-"));
		tempRoots.push(root);
		const dbPath = path.join(root, "history.db");
		const realRun = Database.prototype.run;
		const run = vi.spyOn(Database.prototype, "run").mockImplementation(function (this: Database, sql, ...args) {
			if (typeof sql === "string" && sql.includes("CREATE TABLE IF NOT EXISTS history")) {
				throw new Error("SQLITE_BUSY");
			}
			return realRun.call(this, sql, ...args);
		});
		HistoryStorage.resetInstance();
		try {
			expect(() => HistoryStorage.open(dbPath)).toThrow(/SQLITE_BUSY/);
			expect(fsSync.existsSync(dbPath)).toBe(true);
		} finally {
			run.mockRestore();
			HistoryStorage.resetInstance();
		}
	});

	it("does not delete a history database another process has open when the first open fails", () => {
		const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-history-mode-"));
		tempRoots.push(root);
		const dbPath = path.join(root, "history.db");
		const ready = path.join(root, "ready");
		const script = path.join(root, "hold.ts");
		fsSync.writeFileSync(
			script,
			[
				'import { Database } from "bun:sqlite";',
				'import * as fs from "node:fs";',
				"const db = new Database(process.argv[2]);",
				'db.run("PRAGMA journal_mode=WAL");',
				'db.run("CREATE TABLE IF NOT EXISTS marker (note TEXT)");',
				`db.run("INSERT INTO marker (note) VALUES ('adopted-by-child')");`,
				'db.run("BEGIN");',
				'db.prepare("SELECT note FROM marker").get();',
				'fs.writeFileSync(process.argv[3], "ready");',
				"setInterval(() => {}, 1_000_000);",
				"",
			].join("\n"),
		);
		let child: ReturnType<typeof Bun.spawn> | undefined;
		const realRun = Database.prototype.run;
		const run = vi.spyOn(Database.prototype, "run").mockImplementation(function (this: Database, sql, ...args) {
			if (typeof sql === "string" && sql.includes("CREATE TABLE IF NOT EXISTS history")) {
				child = Bun.spawn([process.execPath, script, dbPath, ready], { stdout: "ignore", stderr: "pipe" });
				const start = Date.now();
				while (!fsSync.existsSync(ready)) {
					if (Date.now() - start > 10000) throw new Error("child not ready");
				}
				throw new Error("SQLITE_BUSY");
			}
			return realRun.call(this, sql, ...args);
		});
		HistoryStorage.resetInstance();
		try {
			expect(() => HistoryStorage.open(dbPath)).toThrow(/SQLITE_BUSY/);
			expect(fsSync.existsSync(dbPath)).toBe(true);
			const probe = new Database(dbPath, { readonly: true });
			const row = probe.prepare("SELECT note FROM marker").get() as { note: string };
			probe.close();
			expect(row.note).toBe("adopted-by-child");
			expect(child?.exitCode).toBeNull();
		} finally {
			child?.kill();
			run.mockRestore();
			HistoryStorage.resetInstance();
		}
	});

	it("does not delete a history database another opener created when the first open fails", () => {
		const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-history-mode-"));
		tempRoots.push(root);
		const dbPath = path.join(root, "history.db");
		const realLstat = fsSync.lstatSync;
		const realRun = Database.prototype.run;
		let armed = false;
		let forced = 0;
		const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation(((
			target: fsSync.PathLike,
			options?: fsSync.StatOptions,
		) => {
			const name = String(target);
			if (forced < 3 && (name === dbPath || name === `${dbPath}-wal` || name === `${dbPath}-shm`)) {
				forced += 1;
				if (forced === 3) {
					const planted = new Database(dbPath);
					planted.run(
						"CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT); INSERT INTO history (prompt) VALUES ('adopted-prompt')",
					);
					planted.close();
					armed = true;
				}
				const error = new Error("ENOENT") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			return realLstat(target, options as { bigint: true });
		}) as typeof fsSync.lstatSync);
		const run = vi.spyOn(Database.prototype, "run").mockImplementation(function (this: Database, sql, ...args) {
			if (armed && typeof sql === "string" && sql.includes("CREATE TABLE IF NOT EXISTS history")) {
				throw new Error("SQLITE_BUSY");
			}
			return realRun.call(this, sql, ...args);
		});
		HistoryStorage.resetInstance();
		try {
			expect(() => HistoryStorage.open(dbPath)).toThrow(/SQLITE_BUSY/);
			expect(fsSync.existsSync(dbPath)).toBe(true);
			const probe = new Database(dbPath, { readonly: true });
			const row = probe.prepare("SELECT prompt FROM history").get() as { prompt: string };
			probe.close();
			expect(row.prompt).toBe("adopted-prompt");
		} finally {
			lstat.mockRestore();
			run.mockRestore();
			HistoryStorage.resetInstance();
		}
	});

	it.skipIf(process.platform !== "win32")(
		"still opens a history database when owner-only protection can be established",
		() => {
			const native = require("@gajae-code/natives") as typeof import("@gajae-code/natives");
			const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-history-mode-"));
			tempRoots.push(root);
			const parent = path.join(root, "data");
			const dbPath = path.join(parent, "history.db");
			HistoryStorage.resetInstance();
			try {
				const storage = HistoryStorage.open(dbPath);
				expect(storage.getRecent(1)).toEqual([]);
				expect(native.verifyOwnerOnlyPathSecurity(parent, "directory").ok).toBe(true);
				for (const suffix of ["", "-wal", "-shm"]) {
					expect(native.verifyOwnerOnlyPathSecurity(`${dbPath}${suffix}`, "file").ok).toBe(true);
				}
			} finally {
				HistoryStorage.resetInstance();
			}
		},
	);

	it.skipIf(process.platform !== "win32")(
		"fails closed when history owner-only protection cannot be established",
		() => {
			const native = require("@gajae-code/natives") as typeof import("@gajae-code/natives");
			const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-history-mode-"));
			tempRoots.push(root);
			const dbPath = path.join(root, "history.db");
			const apply = vi.spyOn(native, "applyOwnerOnlyPathSecurity").mockReturnValue({
				ok: false,
				code: "acl_apply_failed",
			});
			HistoryStorage.resetInstance();
			try {
				expect(() => HistoryStorage.open(dbPath)).toThrow(/owner-only protection/);
				expect(fsSync.existsSync(dbPath)).toBe(false);
			} finally {
				apply.mockRestore();
				HistoryStorage.resetInstance();
			}
		},
	);
});
