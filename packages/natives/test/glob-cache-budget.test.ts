import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const fixtureRoot = path.join(import.meta.dir, "fixtures", `.glob-cache-budget-${crypto.randomUUID()}`);
let setNativeEnvironment: (name: string, value: string | undefined) => void;
let closeEnvironment: () => void;
if (process.platform === "win32") {
	const runtime = dlopen("kernel32.dll", {
		SetEnvironmentVariableW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	});
	const wide = (value: string) => {
		const output = new Uint16Array(value.length + 1);
		for (let index = 0; index < value.length; index++) output[index] = value.charCodeAt(index);
		return output;
	};
	setNativeEnvironment = (name, value) => {
		const nameWide = wide(name);
		const valueWide = value === undefined ? null : ptr(wide(value));
		const code = runtime.symbols.SetEnvironmentVariableW(ptr(nameWide), valueWide);
		if (!code) throw new Error(`SetEnvironmentVariableW(${name}) failed`);
	};
	closeEnvironment = () => runtime.close();
} else {
	const runtime = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
		setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
		unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 },
	});
	setNativeEnvironment = (name, value) => {
		const code = value === undefined ? runtime.symbols.unsetenv(name) : runtime.symbols.setenv(name, value, 1);
		if (code !== 0) throw new Error(`${value === undefined ? "unsetenv" : "setenv"}(${name}) failed with ${code}`);
	};
	closeEnvironment = () => runtime.close();
}

const previousMaxEntries = process.env.FS_SCAN_MAX_ENTRIES;
const previousCacheTtl = process.env.FS_SCAN_CACHE_TTL_MS;
setNativeEnvironment("FS_SCAN_MAX_ENTRIES", "2");
setNativeEnvironment("FS_SCAN_CACHE_TTL_MS", "60000");
const { FileType, glob, invalidateFsScanCache } = await import("../native/index.js");

beforeAll(async () => {
	await fs.mkdir(fixtureRoot, { recursive: true });
});

afterAll(async () => {
	await fs.rm(fixtureRoot, { recursive: true, force: true });
	setNativeEnvironment("FS_SCAN_MAX_ENTRIES", previousMaxEntries);
	setNativeEnvironment("FS_SCAN_CACHE_TTL_MS", previousCacheTtl);
	if (previousMaxEntries === undefined) delete process.env.FS_SCAN_MAX_ENTRIES;
	else process.env.FS_SCAN_MAX_ENTRIES = previousMaxEntries;
	if (previousCacheTtl === undefined) delete process.env.FS_SCAN_CACHE_TTL_MS;
	else process.env.FS_SCAN_CACHE_TTL_MS = previousCacheTtl;
	closeEnvironment();
});

describe("walker scan-cache policy", () => {
	it("rejects a scan that exceeds the configured per-scan entry budget", async () => {
		const root = path.join(fixtureRoot, "entry-budget");
		await fs.mkdir(root, { recursive: true });
		for (const name of ["a.txt", "b.txt", "c.txt"]) {
			await fs.writeFile(path.join(root, name), `${name}\n`);
		}

		await expect(
			glob({
				path: root,
				pattern: "**/*.txt",
				recursive: true,
				hidden: true,
				gitignore: false,
				cache: false,
				fileType: FileType.File,
			}),
		).rejects.toThrow("FS_SCAN_LIMIT operation=collect dimension=entries root=");
	});

	it("invalidates a cached snapshot after a mutation", async () => {
		const root = path.join(fixtureRoot, "mutation");
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(path.join(root, "before.txt"), "before\n");
		const run = async () => {
			const result = await glob({
				path: root,
				pattern: "**/*.txt",
				recursive: true,
				hidden: true,
				gitignore: false,
				cache: true,
				fileType: FileType.File,
			});
			return result.matches.map(entry => entry.path).sort();
		};

		const before = await run();
		await fs.writeFile(path.join(root, "after.txt"), "after\n");
		const stale = await run();
		invalidateFsScanCache(path.join(root, "after.txt"));
		const fresh = await run();

		expect(before).toEqual(["before.txt"]);
		expect(stale).toEqual(["before.txt"]);
		expect(fresh).toEqual(["after.txt", "before.txt"]);
	});
});
