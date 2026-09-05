import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadAcceptedModelPresetRegistry,
	loadAcceptedModelPresetRegistryAsync,
} from "../src/config/model-preset-registry";

const limit = 32 * 1024 * 1024;
let root: string;
let control: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-registry-fingerprint-"));
	control = path.join(root, "model-presets", "control.json");
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function makeOversized(): Promise<void> {
	await Bun.write(control, "{}");
	const handle = await fs.open(control, "r+");
	try {
		await handle.truncate(limit + 1024 * 1024);
	} finally {
		await handle.close();
	}
}

describe("registry fingerprint admission", () => {
	test.each([
		"sync",
		"async",
	] as const)("rejects oversized %s input before content reads rather than reusing absence", async mode => {
		const load = () =>
			mode === "sync" ? loadAcceptedModelPresetRegistry(root) : loadAcceptedModelPresetRegistryAsync(root);
		expect((await load()).error).toBeUndefined();
		await makeOversized();
		const readSpy = spyOn(fsSync, "readSync");
		const fileSpy = spyOn(Bun, "file");
		const wholeReadSpy = spyOn(fsSync, "readFileSync");
		try {
			expect((await load()).error).toMatch(/oversized/i);
			expect(readSpy).not.toHaveBeenCalled();
			expect(wholeReadSpy.mock.calls.filter(([file]) => file === control)).toHaveLength(0);
			expect(fileSpy.mock.calls.filter(([file]) => String(file) === control)).toHaveLength(0);
		} finally {
			readSpy.mockRestore();
			fileSpy.mockRestore();
			wholeReadSpy.mockRestore();
		}
	});

	test.each(["sync", "async"] as const)("valid %s input retains the SHA-256 byte fingerprint", async mode => {
		const bytes = Buffer.from(`${JSON.stringify({ version: 1, disabled: false })}${" ".repeat(70_000)}\n`);
		await Bun.write(control, bytes);
		const expected = crypto.createHash("sha256").update(bytes).digest("hex");
		const digestSpy = spyOn(crypto.Hash.prototype, "digest");
		const readSpy = spyOn(fsSync, "readSync");
		try {
			const result =
				mode === "sync" ? loadAcceptedModelPresetRegistry(root) : await loadAcceptedModelPresetRegistryAsync(root);
			expect(result.error).toBeUndefined();
			expect(digestSpy.mock.results.map(result => result.value)).toContain(expected);
			if (mode === "sync") {
				expect(readSpy.mock.calls.length).toBeGreaterThan(2);
				for (const call of readSpy.mock.calls)
					expect((call as readonly unknown[])[3]).toBeLessThanOrEqual(64 * 1024);
			}
		} finally {
			digestSpy.mockRestore();
			readSpy.mockRestore();
		}
	});

	test("sync fingerprint reads at most the limit plus one byte when a file grows after stat", async () => {
		control = path.join(root, "model-presets", "state.json");
		await Bun.write(control, "{}");
		const staleStat = fsSync.lstatSync(control);
		await makeOversized();
		const statSpy = spyOn(fsSync, "lstatSync").mockReturnValueOnce(staleStat);
		const readSpy = spyOn(fsSync, "readSync");
		try {
			expect(loadAcceptedModelPresetRegistry(root).error).toBe("Registry primary cache state is unreadable.");
			expect(readSpy.mock.results.reduce((total, result) => total + Number(result.value), 0)).toBe(limit + 1);
			for (const call of readSpy.mock.calls) expect((call as readonly unknown[])[3]).toBeLessThanOrEqual(64 * 1024);
		} finally {
			statSpy.mockRestore();
			readSpy.mockRestore();
		}
	});

	test("async fingerprint bounds its handle read when a file grows after stat", async () => {
		control = path.join(root, "model-presets", "state.json");
		await Bun.write(control, "{}");
		const staleStat = await fs.lstat(control, { bigint: true });
		await makeOversized();
		const statSpy = spyOn(fs, "lstat").mockResolvedValueOnce(staleStat);
		const realFile = Bun.file;
		let sliceSpy: { mock: { calls: readonly unknown[][] }; mockRestore(): void } | undefined;
		const fileSpy = spyOn(Bun, "file").mockImplementation((value, ...args) => {
			const file = realFile(value as string, ...args);
			if (typeof value === "number") sliceSpy = spyOn(file, "slice");
			return file;
		});
		try {
			expect((await loadAcceptedModelPresetRegistryAsync(root)).error).toBe(
				"Registry primary cache state is unreadable.",
			);
			expect(sliceSpy).toBeDefined();
			expect(sliceSpy!.mock.calls.length).toBeGreaterThan(0);
			for (const call of sliceSpy!.mock.calls) {
				expect((call as readonly unknown[])[1]).toBeLessThanOrEqual(32 * 1024 * 1024 + 1);
			}
		} finally {
			statSpy.mockRestore();
			fileSpy.mockRestore();
			sliceSpy?.mockRestore();
		}
	});

	test("sync payload reads remain bounded when a file grows after stat", async () => {
		await Bun.write(control, "{}");
		const staleStat = fsSync.lstatSync(control);
		await makeOversized();
		const statSpy = spyOn(fsSync, "lstatSync").mockReturnValueOnce(staleStat);
		const readSpy = spyOn(fsSync, "readSync");
		try {
			const result = loadAcceptedModelPresetRegistry(root, { manifestUrl: "https://example.com/registry.json" });
			expect(result.error).toMatch(/oversized/i);
			expect(readSpy.mock.results.reduce((total, result) => total + Number(result.value), 0)).toBe(limit + 1);
			for (const call of readSpy.mock.calls) expect((call as readonly unknown[])[3]).toBeLessThanOrEqual(64 * 1024);
		} finally {
			statSpy.mockRestore();
			readSpy.mockRestore();
		}
	});

	test("async payload reads remain bounded when a file grows after stat", async () => {
		await Bun.write(control, "{}");
		const staleStat = await fs.lstat(control, { bigint: true });
		await makeOversized();
		const statSpy = spyOn(fs, "lstat").mockResolvedValueOnce(staleStat);
		const realFile = Bun.file;
		let sliceSpy: { mock: { calls: readonly unknown[][] }; mockRestore(): void } | undefined;
		const fileSpy = spyOn(Bun, "file").mockImplementation((value, ...args) => {
			const file = realFile(value as string, ...args);
			if (typeof value === "number") sliceSpy = spyOn(file, "slice");
			return file;
		});
		try {
			const result = await loadAcceptedModelPresetRegistryAsync(root, {
				manifestUrl: "https://example.com/registry.json",
			});
			expect(result.error).toMatch(/oversized/i);
			expect(sliceSpy).toBeDefined();
			expect(sliceSpy!.mock.calls.length).toBeGreaterThan(0);
			for (const call of sliceSpy!.mock.calls) {
				expect((call as readonly unknown[])[1]).toBeLessThanOrEqual(32 * 1024 * 1024 + 1);
			}
		} finally {
			statSpy.mockRestore();
			fileSpy.mockRestore();
			sliceSpy?.mockRestore();
		}
	});

	test.each(["sync", "async"] as const)("rejects %s payload replacement after admission", async mode => {
		await Bun.write(control, "{}");
		const replacement = path.join(root, "replacement.json");
		await Bun.write(replacement, "{}");
		if (mode === "sync") {
			const realOpen = fsSync.openSync;
			const replacementFd = realOpen(replacement, "r");
			const openSpy = spyOn(fsSync, "openSync").mockImplementation((file, flags, ...args) =>
				String(file) === control ? replacementFd : realOpen(file, flags, ...args),
			);
			try {
				const result = loadAcceptedModelPresetRegistry(root, { manifestUrl: "https://example.com/registry.json" });
				expect(result.error).toMatch(/changed while opening/i);
			} finally {
				openSpy.mockRestore();
			}
			return;
		}
		const realOpen = fs.open;
		const replacementHandle = await realOpen(replacement, "r");
		const openSpy = spyOn(fs, "open").mockImplementation(async (file, ...args) =>
			String(file) === control ? replacementHandle : realOpen(file, ...args),
		);
		try {
			const result = await loadAcceptedModelPresetRegistryAsync(root, {
				manifestUrl: "https://example.com/registry.json",
			});
			expect(result.error).toMatch(/changed while opening/i);
		} finally {
			openSpy.mockRestore();
		}
	});

	test.each([
		"replace",
		"remove",
	] as const)("rejects sync payload %s after reading and closes its fd", async action => {
		await Bun.write(control, "{}");
		const replacement = path.join(root, "replacement.json");
		await Bun.write(replacement, "{}");
		const realStat = fsSync.fstatSync;
		let fd: number | undefined;
		let statCalls = 0;
		const readSpy = spyOn(fsSync, "readSync");
		const closeSpy = spyOn(fsSync, "closeSync");
		const statSpy = spyOn(fsSync, "fstatSync").mockImplementation(((
			openedFd: number,
			options?: fsSync.StatOptions,
		) => {
			fd = openedFd;
			if (++statCalls === 2) {
				expect(readSpy.mock.results.map(result => result.value)).toEqual([2, 0]);
				if (action === "replace") fsSync.renameSync(replacement, control);
				else fsSync.unlinkSync(control);
			}
			return realStat(openedFd, options);
		}) as typeof fsSync.fstatSync);
		try {
			const result = loadAcceptedModelPresetRegistry(root, { manifestUrl: "https://example.com/registry.json" });
			expect(result.error).toBe("Registry cache path changed while reading.");
			expect(statCalls).toBe(2);
			expect(closeSpy.mock.calls).toEqual([[fd!]]);
			expect(() => realStat(fd!)).toThrow(/bad file descriptor|EBADF/i);
		} finally {
			statSpy.mockRestore();
			closeSpy.mockRestore();
			readSpy.mockRestore();
		}
	});

	test.each([
		"replace",
		"remove",
	] as const)("rejects async payload %s after reading and closes its handle", async action => {
		await Bun.write(control, "{}");
		const replacement = path.join(root, "replacement.json");
		await Bun.write(replacement, "{}");
		const realOpen = fs.open;
		let statCalls = 0;
		let handle: fs.FileHandle | undefined;
		const restores: (() => void)[] = [];
		let closeSpy: { mock: { calls: readonly unknown[][] } } | undefined;
		const realFile = Bun.file;
		let readCompleted = false;
		const fileSpy = spyOn(Bun, "file").mockImplementation((value, ...args) => {
			const file = realFile(value as string, ...args);
			if (typeof value === "number" && value === handle?.fd) {
				const realSlice = file.slice.bind(file);
				const sliceSpy = spyOn(file, "slice").mockImplementation(
					(start?: number | string, end?: number | string, contentType?: string) => {
						const slice = realSlice(start as number | undefined, end as number | undefined, contentType);
						const realRead = slice.arrayBuffer.bind(slice);
						const readSpy = spyOn(slice, "arrayBuffer").mockImplementation(async () => {
							const bytes = await realRead();
							expect(Buffer.from(bytes).toString()).toBe("{}");
							readCompleted = true;
							return bytes;
						});
						restores.push(() => readSpy.mockRestore());
						return slice;
					},
				);
				restores.push(() => sliceSpy.mockRestore());
			}
			return file;
		});
		const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
			const opened = await realOpen(...args);
			if (String(args[0]) === control) {
				handle = opened;
				const realStat = opened.stat.bind(opened);
				const statSpy = spyOn(opened, "stat").mockImplementation((async (options?: fsSync.StatOptions) => {
					if (++statCalls === 2) {
						expect(readCompleted).toBe(true);
						if (action === "replace") await fs.rename(replacement, control);
						else await fs.unlink(control);
					}
					return realStat(options);
				}) as typeof opened.stat);
				const close = spyOn(opened, "close");
				closeSpy = close;
				restores.push(
					() => statSpy.mockRestore(),
					() => close.mockRestore(),
				);
			}
			return opened;
		});
		try {
			const result = await loadAcceptedModelPresetRegistryAsync(root, {
				manifestUrl: "https://example.com/registry.json",
			});
			expect(result.error).toBe("Registry cache path changed while reading.");
			expect(statCalls).toBe(2);
			expect(closeSpy?.mock.calls).toHaveLength(1);
			expect(handle?.fd).toBe(-1);
		} finally {
			openSpy.mockRestore();
			fileSpy.mockRestore();
			for (const restore of restores) restore();
		}
	});

	test.each(["sync", "async"] as const)("rejects %s symlinks without hashing their target", async mode => {
		await Bun.write(path.join(root, "target.json"), "{}");
		await fs.mkdir(path.dirname(control), { recursive: true });
		await fs.symlink(path.join(root, "target.json"), control);
		const result =
			mode === "sync" ? loadAcceptedModelPresetRegistry(root) : await loadAcceptedModelPresetRegistryAsync(root);
		expect(result.error).toMatch(/regular file/i);
	});
});
