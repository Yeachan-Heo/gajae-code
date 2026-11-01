/**
 * Keybindings migration file mode and final-component symlinks.
 * Regular files still migrate. A mode 0600 file stays 0600.
 * A symlink at the marker, backup, or temp path is not followed.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setKeybindings } from "@gajae-code/tui";
import { KeybindingsManager } from "../src/config/keybindings";

const skipWin32 = process.platform === "win32";

async function symlinkSupported(): Promise<boolean> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-keybindings-link-probe-"));
	try {
		const target = path.join(dir, "target");
		await fs.writeFile(target, "x");
		await fs.symlink(target, path.join(dir, "link"));
		return true;
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		if (code === "EPERM" || code === "EACCES") return false;
		throw error;
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const canSymlink = await symlinkSupported();

async function hardlinkSupported(): Promise<boolean> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-keybindings-link-probe-"));
	try {
		const target = path.join(dir, "target");
		await fs.writeFile(target, "x");
		await fs.link(target, path.join(dir, "link"));
		return true;
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EXDEV") return false;
		throw error;
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const canLink = await hardlinkSupported();

const LEGACY = `${JSON.stringify({ fork: "ctrl+f" }, null, 2)}\n`;

describe.serial("keybindings migration file mode", () => {
	let agentDir: string | undefined;

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(async () => {
		setKeybindings(KeybindingsManager.inMemory());
		if (agentDir) await fs.rm(agentDir, { recursive: true, force: true });
		agentDir = undefined;
	});

	async function fixture(): Promise<{ dir: string; file: string; marker: string; bak: string }> {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-keybindings-mode-"));
		const file = path.join(agentDir, "keybindings.json");
		return { dir: agentDir, file, marker: `${file}.migration-v1`, bak: `${file}.bak` };
	}

	test("still allows migration of a regular legacy file and writes a regular marker", async () => {
		const { dir, file, marker, bak } = await fixture();
		await fs.writeFile(bak, "old-bak");
		await fs.writeFile(file, LEGACY);
		const manager = KeybindingsManager.create(dir);
		const written = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
		expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
		expect(written["app.session.fork"]).toBe("ctrl+f");
		expect(written).not.toHaveProperty("fork");
		expect(await fs.readFile(marker, "utf8")).toBe("v1\n");
		expect((await fs.lstat(marker)).isFile()).toBe(true);
		expect(await fs.readFile(bak, "utf8")).toBe(LEGACY);
		expect((await fs.lstat(bak)).isFile()).toBe(true);
	});

	test("still leaves a file unchanged when a regular migration marker exists", async () => {
		const { dir, file, marker } = await fixture();
		await fs.writeFile(file, LEGACY);
		await fs.writeFile(marker, "v1\n");
		KeybindingsManager.create(dir);
		expect(await fs.readFile(file, "utf8")).toBe(LEGACY);
		expect(await fs.readFile(marker, "utf8")).toBe("v1\n");
	});

	test("still allows migration when a leftover regular temp file is in the way", async () => {
		const { dir, file } = await fixture();
		const temp = `${file}.${process.pid}.tmp`;
		await fs.writeFile(file, LEGACY);
		await fs.writeFile(temp, "leftover");
		KeybindingsManager.create(dir);
		expect(JSON.parse(await fs.readFile(file, "utf8"))["app.session.fork"]).toBe("ctrl+f");
		await expect(fs.lstat(temp)).rejects.toThrow();
	});

	test.skipIf(skipWin32 || !canSymlink)(
		"still allows migration when keybindings.json symlinks a regular file",
		async () => {
			const { dir, file } = await fixture();
			const real = path.join(dir, "real.json");
			await fs.writeFile(real, LEGACY, { mode: 0o600 });
			await fs.chmod(real, 0o600);
			await fs.symlink(real, file);
			const manager = KeybindingsManager.create(dir);
			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect((await fs.lstat(file)).isSymbolicLink()).toBe(false);
			expect(JSON.parse(await fs.readFile(file, "utf8"))["app.session.fork"]).toBe("ctrl+f");
			expect(await fs.readFile(real, "utf8")).toBe(LEGACY);
			expect((await fs.lstat(real)).mode & 0o777).toBe(0o600);
		},
	);

	test.skipIf(skipWin32 || !canSymlink)("still leaves an existing marker symlink target unchanged", async () => {
		const { dir, file, marker } = await fixture();
		const target = path.join(dir, "marker-target");
		await fs.writeFile(file, LEGACY);
		await fs.writeFile(target, "v1\n");
		await fs.symlink(target, marker);
		KeybindingsManager.create(dir);
		expect(await fs.readFile(file, "utf8")).toBe(LEGACY);
		expect(await fs.readFile(target, "utf8")).toBe("v1\n");
		expect((await fs.lstat(marker)).isSymbolicLink()).toBe(true);
	});

	test.skipIf(skipWin32)("migrated file and marker are mode 0600", async () => {
		const { dir, file, marker } = await fixture();
		const previous = process.umask(0o022);
		try {
			await fs.writeFile(file, LEGACY, { mode: 0o600 });
			await fs.chmod(file, 0o600);
			expect((await fs.lstat(file)).mode & 0o777).toBe(0o600);
			KeybindingsManager.create(dir);
			expect((await fs.lstat(file)).mode & 0o777).toBe(0o600);
			expect((await fs.lstat(marker)).isFile()).toBe(true);
			expect((await fs.lstat(marker)).mode & 0o777).toBe(0o600);
			expect(await fs.readFile(marker, "utf8")).toBe("v1\n");
		} finally {
			process.umask(previous);
		}
	});

	test.skipIf(skipWin32 || !canSymlink)("does not follow a dangling migration marker symlink", async () => {
		const { dir, file, marker } = await fixture();
		const victim = path.join(dir, "marker-victim");
		await fs.writeFile(file, LEGACY, { mode: 0o600 });
		await fs.chmod(file, 0o600);
		await fs.symlink(victim, marker);
		KeybindingsManager.create(dir);
		await expect(fs.lstat(victim)).rejects.toThrow();
		expect((await fs.lstat(marker)).isSymbolicLink()).toBe(true);
		expect((await fs.lstat(file)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await fs.readFile(file, "utf8"))["app.session.fork"]).toBe("ctrl+f");
	});

	test.skipIf(skipWin32 || !canSymlink)("does not follow a symlink at the migration backup path", async () => {
		const { dir, file, bak } = await fixture();
		const victim = path.join(dir, "bak-victim");
		await fs.writeFile(file, LEGACY);
		await fs.writeFile(victim, "SECRET");
		await fs.symlink(victim, bak);
		KeybindingsManager.create(dir);
		expect(await fs.readFile(victim, "utf8")).toBe("SECRET");
		expect((await fs.lstat(bak)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(file, "utf8")).toBe(LEGACY);
	});

	test("still allows a complete migration when each writeSync returns a short count", async () => {
		const { dir, file, marker, bak } = await fixture();
		await fs.writeFile(file, LEGACY);
		const original = fsSync.writeSync;
		const spy = spyOn(fsSync, "writeSync").mockImplementation(((
			fd: number,
			data: string | NodeJS.ArrayBufferView,
			offset?: number | null,
			length?: number | null,
		) => {
			if (typeof data === "string") return original(fd, data.slice(0, 8));
			const start = typeof offset === "number" ? offset : 0;
			const available = typeof length === "number" ? length : data.byteLength - start;
			return original(fd, data, start, Math.min(8, available));
		}) as typeof fsSync.writeSync);
		try {
			const manager = KeybindingsManager.create(dir);
			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(JSON.parse(await fs.readFile(file, "utf8"))["app.session.fork"]).toBe("ctrl+f");
			expect(await fs.readFile(bak, "utf8")).toBe(LEGACY);
			expect(await fs.readFile(marker, "utf8")).toBe("v1\n");
		} finally {
			spy.mockRestore();
		}
	});

	test("still allows the original file to stay when the replacement write stops", async () => {
		const { dir, file, marker } = await fixture();
		await fs.writeFile(file, LEGACY);
		let calls = 0;
		let stopped = false;
		const original = fsSync.writeSync;
		const spy = spyOn(fsSync, "writeSync").mockImplementation(((...args: Parameters<typeof original>) => {
			calls += 1;
			if (calls > 1) {
				stopped = true;
				throw Object.assign(new Error("no space"), { code: "ENOSPC" });
			}
			return original(...args);
		}) as typeof fsSync.writeSync);
		try {
			KeybindingsManager.create(dir);
		} finally {
			spy.mockRestore();
		}
		if (stopped) {
			expect(await fs.readFile(file, "utf8")).toBe(LEGACY);
			await expect(fs.lstat(marker)).rejects.toThrow();
			expect((await fs.lstat(file)).isFile()).toBe(true);
		} else {
			expect(JSON.parse(await fs.readFile(file, "utf8"))["app.session.fork"]).toBe("ctrl+f");
			expect(await fs.readFile(marker, "utf8")).toBe("v1\n");
		}
	});

	test.skipIf(skipWin32 || !canLink)(
		"still allows migration when the backup is a hardlink of the config",
		async () => {
			const { dir, file, marker, bak } = await fixture();
			await fs.writeFile(file, LEGACY);
			await fs.link(file, bak);
			const manager = KeybindingsManager.create(dir);
			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(JSON.parse(await fs.readFile(file, "utf8"))["app.session.fork"]).toBe("ctrl+f");
			expect(await fs.readFile(bak, "utf8")).toBe(LEGACY);
			expect(await fs.readFile(marker, "utf8")).toBe("v1\n");
		},
	);

	test.skipIf(skipWin32 || !canLink)(
		"preserves legacy bytes when replacement write stops on a hardlinked backup",
		async () => {
			const { dir, file, bak } = await fixture();
			await fs.writeFile(file, LEGACY);
			await fs.link(file, bak);
			let calls = 0;
			let stopped = false;
			const original = fsSync.writeSync;
			const spy = spyOn(fsSync, "writeSync").mockImplementation(((...args: Parameters<typeof original>) => {
				calls += 1;
				if (calls >= 1) {
					stopped = true;
					throw Object.assign(new Error("no space"), { code: "ENOSPC" });
				}
				return original(...args);
			}) as typeof fsSync.writeSync);
			try {
				KeybindingsManager.create(dir);
			} finally {
				spy.mockRestore();
			}
			expect(stopped).toBe(true);
			expect(calls).toBeGreaterThan(0);
			expect(await fs.readFile(file, "utf8")).toBe(LEGACY);
			expect(await fs.readFile(bak, "utf8")).toBe(LEGACY);
		},
	);

	test.skipIf(skipWin32 || !canSymlink)("does not follow a symlink at the migration temp path", async () => {
		const { dir, file } = await fixture();
		const victim = path.join(dir, "temp-victim");
		const temp = `${file}.${process.pid}.tmp`;
		await fs.writeFile(file, LEGACY);
		await fs.writeFile(victim, "SECRET");
		await fs.symlink(victim, temp);
		KeybindingsManager.create(dir);
		expect(await fs.readFile(victim, "utf8")).toBe("SECRET");
		expect((await fs.lstat(temp)).isSymbolicLink()).toBe(true);
		expect((await fs.lstat(file)).isFile()).toBe(true);
		expect(await fs.readFile(file, "utf8")).toBe(LEGACY);
	});
});
