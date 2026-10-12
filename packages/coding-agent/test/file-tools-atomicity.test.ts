import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { PathLike, StatOptions } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { LocalProtocolHandler } from "@gajae-code/coding-agent/internal-urls";
import type { ClientBridge } from "@gajae-code/coding-agent/session/client-bridge";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { ReadTool } from "@gajae-code/coding-agent/tools/read";
import { WriteTool } from "@gajae-code/coding-agent/tools/write";
import { FileReadCache } from "../src/edit/file-read-cache";
import { writeFileAtomically } from "../src/tools/atomic-file-write";

function createSession(cwd: string, extras: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		...extras,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("file tool atomicity and read-after-write (#4734)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tools-4734-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("reads a freshly written nested file without a not-found error", async () => {
		const session = createSession(tmpDir);
		const dest = path.join(tmpDir, "frontend", "e2e", "zzop-repro.spec.ts");
		const content = "import { test } from '@playwright/test';\n";
		const writeResult = await new WriteTool(session).execute("write-fresh", { path: dest, content });
		expect(textOf(writeResult)).toContain("Successfully wrote");
		const readResult = await new ReadTool(session).execute("read-fresh", { path: dest });
		expect(textOf(readResult)).toContain("import { test }");
		const stat = await fs.stat(dest);
		expect(stat.size).toBeGreaterThan(0);
	});

	it("leaves an existing file unchanged when the staged write fails", async () => {
		const dest = path.join(tmpDir, "backend", "app", "routers", "automation_snapshots.py");
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.writeFile(dest, "original = True\n");
		const realOpen = fs.open.bind(fs);
		const original = spyOn(fs, "open").mockImplementation(async (target, flags) => {
			if (String(target).includes(".tmp") && flags === "wx") {
				const error = new Error("EPERM: Operation not permitted") as Error & { code: string };
				error.code = "EPERM";
				throw error;
			}
			return realOpen(target, flags);
		});
		try {
			await expect(writeFileAtomically(dest, "mutated = True\n")).rejects.toMatchObject({ code: "EPERM" });
			expect(await fs.readFile(dest, "utf8")).toBe("original = True\n");
			const leftovers = await fs.readdir(path.dirname(dest));
			expect(leftovers.some(name => name.includes(".tmp"))).toBe(false);
		} finally {
			original.mockRestore();
		}
	});

	it("does not create a 0-byte destination when a new-file staged write fails", async () => {
		const dest = path.join(tmpDir, "new-file.py");
		const realOpen = fs.open.bind(fs);
		const original = spyOn(fs, "open").mockImplementation(async (target, flags) => {
			if (String(target).includes(".tmp") && flags === "wx") {
				const error = new Error("EPERM: Operation not permitted") as Error & { code: string };
				error.code = "EPERM";
				throw error;
			}
			return realOpen(target, flags);
		});
		try {
			await expect(writeFileAtomically(dest, "print('hi')\n")).rejects.toMatchObject({ code: "EPERM" });
			expect(
				await fs.stat(dest).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			original.mockRestore();
		}
	});

	it("surfaces a permission error without leaving a 0-byte file in a read-only directory", async () => {
		if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) return;
		const locked = path.join(tmpDir, "locked");
		await fs.mkdir(locked);
		await fs.chmod(locked, 0o555);
		const dest = path.join(locked, "automation_snapshots.py");
		try {
			await expect(
				new WriteTool(createSession(tmpDir)).execute("write-eperm", {
					path: dest,
					content: "print('nope')\n",
				}),
			).rejects.toThrow(/Permission denied writing/);
			expect(
				await fs.stat(dest).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.chmod(locked, 0o755);
		}
	});

	it("reads an ACP buffer that has not been flushed to disk", async () => {
		const dest = path.join(tmpDir, "frontend", "e2e", "zzop-repro.spec.ts");
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true, writeTextFile: true },
			writeTextFile: async () => undefined,
			readTextFile: async () => "export const fromBridge = true;\n",
		};
		const session = createSession(tmpDir, { getClientBridge: () => bridge });
		await new WriteTool(session).execute("acp-write", { path: dest, content: "export const fromBridge = true;\n" });
		expect(
			await fs.stat(dest).then(
				() => true,
				() => false,
			),
		).toBe(false);
		const readResult = await new ReadTool(session).execute("acp-read", { path: dest });
		expect(textOf(readResult)).toContain("fromBridge");
	});

	it("fails closed when ACP read returns an ambiguous OS permission errno", async () => {
		const dest = path.join(tmpDir, "on-disk.ts");
		await fs.writeFile(dest, "export const fromDisk = true;\n");
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => {
				const error = new Error("EPERM: Operation not permitted") as Error & { code: string };
				error.code = "EPERM";
				throw error;
			},
		};
		await expect(
			new ReadTool(createSession(tmpDir, { getClientBridge: () => bridge })).execute("eperm-denied", { path: dest }),
		).rejects.toThrow(/EPERM/);
	});

	it("does not fall back to disk for a structured ACP permission denial", async () => {
		const dest = path.join(tmpDir, "secret.ts");
		await fs.writeFile(dest, "export const leaked = true;\n");
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => {
				const error = new Error("permission denied by client") as Error & { code: string };
				error.code = "permission_denied";
				throw error;
			},
		};
		await expect(
			new ReadTool(createSession(tmpDir, { getClientBridge: () => bridge })).execute("denied", { path: dest }),
		).rejects.toThrow(/permission denied by client/);
	});

	it("invalidates the file-read cache after a successful write", async () => {
		const dest = path.join(tmpDir, "cached.ts");
		const cache = new FileReadCache();
		cache.recordContiguous(dest, 1, ["old line"]);
		const session = createSession(tmpDir, { fileReadCache: cache });
		await new WriteTool(session).execute("cache-write", { path: dest, content: "new line\n" });
		expect(cache.get(dest)).toBeNull();
	});

	it("writes through a destination symlink without replacing the link", async () => {
		const target = path.join(tmpDir, "real.ts");
		const link = path.join(tmpDir, "alias.ts");
		await fs.writeFile(target, "old\n");
		await fs.symlink(target, link);
		await writeFileAtomically(link, "new\n");
		expect(await fs.readFile(target, "utf8")).toBe("new\n");
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(link)).toBe(target);
	});

	it("retries exclusive temp creation when a sibling name already exists", async () => {
		const dest = path.join(tmpDir, "retry.ts");
		const realOpen = fs.open.bind(fs);
		let collisions = 0;
		const original = spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
			if (String(target).includes(".tmp") && flags === "wx" && collisions < 1) {
				collisions += 1;
				await fs.writeFile(String(target), "pre-existing collision\n");
				const error = new Error("EEXIST: file already exists") as Error & { code: string };
				error.code = "EEXIST";
				throw error;
			}
			return realOpen(target, flags, mode);
		});
		try {
			await writeFileAtomically(dest, "after retry\n");
			expect(collisions).toBe(1);
			expect(await fs.readFile(dest, "utf8")).toBe("after retry\n");
			expect((await fs.readdir(tmpDir)).filter(name => name.endsWith(".tmp"))).toHaveLength(1);
		} finally {
			for (const name of await fs.readdir(tmpDir)) {
				if (name.endsWith(".tmp")) await fs.rm(path.join(tmpDir, name), { force: true });
			}
			original.mockRestore();
		}
	});

	it("preserves exact mode bits when replacing an existing file", async () => {
		if (process.platform === "win32") return;
		const dest = path.join(tmpDir, "mode-preserved.ts");
		await fs.writeFile(dest, "old\n", { mode: 0o640 });
		await fs.chmod(dest, 0o640);
		await writeFileAtomically(dest, "new\n");
		expect((await fs.stat(dest)).mode & 0o777).toBe(0o640);
	});

	it("preserves ownership and syncs staged bytes before publication", async () => {
		if (process.platform === "win32") return;
		const dest = path.join(tmpDir, "metadata-preserved.ts");
		await fs.writeFile(dest, "old\n", { mode: 0o640 });
		const before = await fs.stat(dest);
		const realOpen = fs.open.bind(fs);
		let syncs = 0;
		const original = spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
			const handle = await realOpen(target, flags, mode);
			if (String(target).includes(".tmp") && flags === "wx") {
				const realSync = handle.sync.bind(handle);
				spyOn(handle, "sync").mockImplementation(async () => {
					syncs += 1;
					return realSync();
				});
			}
			return handle;
		});
		try {
			await writeFileAtomically(dest, "new\n");
			const after = await fs.stat(dest);
			expect(syncs).toBe(1);
			expect(after.uid).toBe(before.uid);
			expect(after.gid).toBe(before.gid);
		} finally {
			original.mockRestore();
		}
	});

	it("re-applies ownership when the staged inode has different metadata", async () => {
		if (process.platform === "win32") return;
		const dest = path.join(tmpDir, "ownership-reapplied.ts");
		await fs.writeFile(dest, "old\n", { mode: 0o640 });
		const before = await fs.stat(dest);
		const realStat = fs.stat.bind(fs);
		const realChown = fs.chown.bind(fs);
		const chowns: Array<{ uid: number; gid: number }> = [];
		const statImplementation = async (target: PathLike, options?: StatOptions) => {
			const result = options === undefined ? await realStat(target) : await realStat(target, options);
			if (result === undefined) return result;
			if (String(target).includes(".tmp") && options?.bigint !== true) {
				return Object.assign(result, { uid: before.uid + 1, gid: before.gid + 1 });
			}
			return result;
		};
		const stat = spyOn(fs, "stat").mockImplementation(statImplementation as typeof fs.stat);
		const chown = spyOn(fs, "chown").mockImplementation(async (_target, uid, gid) => {
			chowns.push({ uid, gid });
			await realChown(dest, before.uid, before.gid);
		});
		try {
			await writeFileAtomically(dest, "new\n");
			expect(chowns).toEqual([{ uid: before.uid, gid: before.gid }]);
		} finally {
			stat.mockRestore();
			chown.mockRestore();
		}
	});

	it("rejects hard-linked destinations instead of splitting the link group", async () => {
		if (process.platform === "win32") return;
		const dest = path.join(tmpDir, "hard-linked.ts");
		const peer = path.join(tmpDir, "hard-linked-peer.ts");
		await fs.writeFile(dest, "original\n");
		await fs.link(dest, peer);
		await expect(writeFileAtomically(dest, "replacement\n")).rejects.toThrow(/hard-linked/);
		expect(await fs.readFile(dest, "utf8")).toBe("original\n");
		expect(await fs.readFile(peer, "utf8")).toBe("original\n");
	});

	it("rejects a destination identity swap detected before publication", async () => {
		if (process.platform === "win32") return;
		const dest = path.join(tmpDir, "identity-swap.ts");
		const replacement = path.join(tmpDir, "identity-replacement.ts");
		const originalPath = path.join(tmpDir, "identity-original.ts");
		await fs.writeFile(dest, "original\n");
		await fs.writeFile(replacement, "replacement\n");
		const realRename = (from: string, to: string) => fs.rename(from, to);
		let swapped = false;
		const realChmod = fs.chmod.bind(fs) as (target: string, mode: number) => Promise<void>;
		const original = spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
			if (String(target).includes(".tmp") && !swapped) {
				swapped = true;
				await realRename(dest, originalPath);
				await realRename(replacement, dest);
			}
			return realChmod(String(target), mode as number);
		});
		try {
			await expect(writeFileAtomically(dest, "must-not-overwrite\n")).rejects.toThrow(/replaced while staging/);
			expect(await fs.readFile(dest, "utf8")).toBe("replacement\n");
		} finally {
			original.mockRestore();
			await fs.rm(originalPath, { force: true });
		}
	});

	it("publishes through a same-directory atomic rename", async () => {
		const dest = path.join(tmpDir, "plain-rename.ts");
		const renamed: string[] = [];
		const realRename = fs.rename.bind(fs);
		const original = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			renamed.push(`${String(from)} -> ${String(to)}`);
			return realRename(from, to);
		});
		try {
			await writeFileAtomically(dest, "published\n");
			expect(renamed).toHaveLength(1);
			expect(path.dirname(renamed[0]!.split(" -> ")[0])).toBe(path.dirname(dest));
			expect(await fs.readFile(dest, "utf8")).toBe("published\n");
			expect((await fs.readdir(tmpDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			original.mockRestore();
		}
	});

	it("does not flatten non-ENOENT trust-boundary resolution errors", async () => {
		const dest = path.join(tmpDir, "realpath-error.ts");
		const error = new Error("EIO: realpath failed") as Error & { code: string };
		error.code = "EIO";
		const original = spyOn(fs, "realpath").mockRejectedValueOnce(error);
		try {
			await expect(writeFileAtomically(dest, "must-fail\n", { trustBoundary: tmpDir })).rejects.toMatchObject({
				code: "EIO",
			});
			expect(
				await fs.stat(dest).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			original.mockRestore();
		}
	});

	it("cleans a staged file when its close fails", async () => {
		const dest = path.join(tmpDir, "close-fails.ts");
		const realOpen = fs.open.bind(fs);
		const original = spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
			const handle = await realOpen(target, flags, mode);
			if (String(target).includes(".tmp") && flags === "wx") {
				const realClose = handle.close.bind(handle);
				spyOn(handle, "close").mockImplementation(async () => {
					await realClose();
					const error = new Error("EIO: close failed") as Error & { code: string };
					error.code = "EIO";
					throw error;
				});
			}
			return handle;
		});
		try {
			await expect(writeFileAtomically(dest, "must-fail\n")).rejects.toMatchObject({ code: "EIO" });
			expect((await fs.readdir(path.dirname(dest))).some(name => name.endsWith(".tmp"))).toBe(false);
		} finally {
			original.mockRestore();
		}
	});

	it("cleans a staged file when syncing bytes fails", async () => {
		const dest = path.join(tmpDir, "sync-fails.ts");
		const realOpen = fs.open.bind(fs);
		const original = spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
			const handle = await realOpen(target, flags, mode);
			if (String(target).includes(".tmp") && flags === "wx") {
				spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error("EIO: sync failed"), { code: "EIO" }));
			}
			return handle;
		});
		try {
			await expect(writeFileAtomically(dest, "must-fail\n")).rejects.toMatchObject({ code: "EIO" });
			expect((await fs.readdir(path.dirname(dest))).some(name => name.endsWith(".tmp"))).toBe(false);
		} finally {
			original.mockRestore();
		}
	});

	it("does not replace an unwritable target through a writable parent", async () => {
		if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) return;
		const parent = path.join(tmpDir, "writable-parent");
		const dest = path.join(parent, "unwritable.ts");
		await fs.mkdir(parent);
		await fs.writeFile(dest, "original\n");
		await fs.chmod(dest, 0o444);
		try {
			await expect(writeFileAtomically(dest, "replacement\n")).rejects.toThrow(/Permission denied|EACCES|EPERM/);
			expect(await fs.readFile(dest, "utf8")).toBe("original\n");
		} finally {
			await fs.chmod(dest, 0o644);
		}
	});

	it("cleans an owned staging file when publication fails", async () => {
		const dest = path.join(tmpDir, "rename-fails.ts");
		await fs.writeFile(dest, "original\n");
		const original = spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
		try {
			await expect(writeFileAtomically(dest, "replacement\n")).rejects.toMatchObject({ code: "EIO" });
			expect(await fs.readFile(dest, "utf8")).toBe("original\n");
			expect((await fs.readdir(path.dirname(dest))).some(name => name.endsWith(".tmp"))).toBe(false);
		} finally {
			original.mockRestore();
		}
	});

	it("documents last-writer-wins when a successor is published after validation", async () => {
		if (process.platform === "win32") return;
		const dest = path.join(tmpDir, "post-validation-swap.ts");
		await fs.writeFile(dest, "original\n");
		// Publish a different regular file at the destination pathname strictly
		// between the final identity check and the committing rename. This is the
		// window rename(2) cannot close; the write is expected to win.
		const realRename = fs.rename.bind(fs);
		const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to) === dest) {
				await fs.writeFile(dest, "successor-from-another-writer\n");
			}
			return realRename(from as PathLike, to as PathLike);
		});
		try {
			await writeFileAtomically(dest, "ours\n");
			// Documented contract: last writer wins, and the publication is whole --
			// never a mix of the successor and our bytes.
			expect(await fs.readFile(dest, "utf8")).toBe("ours\n");
			expect((await fs.readdir(tmpDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			rename.mockRestore();
		}
	});

	it("keeps writable Windows files editable when delete-sharing blocks rename", async () => {
		if (process.platform === "win32") return;
		const dest = path.join(tmpDir, "windows-share.ts");
		await fs.writeFile(dest, "old\n");
		const rename = spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
		const delays: number[] = [];
		try {
			await writeFileAtomically(dest, "new\n", {
				platform: "win32",
				sleep: async delay => {
					delays.push(delay);
				},
			});
			expect(delays).toEqual([10, 25, 50, 100, 200]);
			expect(await fs.readFile(dest, "utf8")).toBe("new\n");
			expect((await fs.readdir(tmpDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			rename.mockRestore();
		}
	});

	it("restores the original byte-exactly when the Windows in-place fallback fails", async () => {
		if (process.platform === "win32") return;
		const dest = path.join(tmpDir, "windows-rollback.ts");
		// Longer than the replacement so a rollback written at an advanced offset
		// would leave trailing original bytes behind instead of restoring exactly.
		const original = "original-content-that-is-longer\n";
		await fs.writeFile(dest, original);
		const rename = spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
		const realOpen = fs.open.bind(fs);
		const open = spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
			const handle = await realOpen(target as PathLike, flags as string, mode as number);
			if (String(target) !== dest) return handle;
			// Accept the replacement's first chunk, then fail. This is the real
			// hazard: the handle offset has advanced, so a rollback that writes from
			// the current position interleaves instead of restoring from byte 0.
			const realWrite = handle.write.bind(handle);
			const realWriteFile = handle.writeFile.bind(handle);
			let writeCalls = 0;
			const partiallyAcceptThenFail = async (bytes: Uint8Array): Promise<never> => {
				// Unpositioned write: accepting a prefix advances the handle offset, so a
				// rollback that also writes unpositioned resumes mid-file.
				await realWrite(bytes.subarray(0, 4));
				throw Object.assign(new Error("EIO: write failed"), { code: "EIO" });
			};
			handle.write = (async (...args: any[]) => {
				writeCalls++;
				if (writeCalls === 1) return partiallyAcceptThenFail(args[0] as Uint8Array);
				return realWrite(...(args as [any]));
			}) as typeof handle.write;
			handle.writeFile = (async (...args: any[]) => {
				writeCalls++;
				if (writeCalls === 1) return partiallyAcceptThenFail(args[0] as Uint8Array);
				return realWriteFile(...(args as [any]));
			}) as typeof handle.writeFile;
			return handle;
		});
		try {
			await expect(
				writeFileAtomically(dest, "new\n", { platform: "win32", sleep: async () => {} }),
			).rejects.toMatchObject({ publicationState: "not_published", destUnchanged: true });
			// The reported state must match reality: byte-exact original, no mixing.
			expect(await fs.readFile(dest, "utf8")).toBe(original);
			expect((await fs.readdir(tmpDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			open.mockRestore();
			rename.mockRestore();
		}
	});

	it("reports cleanup failure without claiming the staged file was removed", async () => {
		const dest = path.join(tmpDir, "unlink-fails.ts");
		await fs.writeFile(dest, "original\n");
		const rename = spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
		const realUnlink = fs.unlink.bind(fs);
		const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
			if (String(target).includes(".tmp")) {
				throw Object.assign(new Error("EIO: unlink failed"), { code: "EIO" });
			}
			return realUnlink(target);
		});
		try {
			await expect(writeFileAtomically(dest, "replacement\n")).rejects.toThrow(/Failed to clean up staging file/);
			expect((await fs.readdir(path.dirname(dest))).some(name => name.endsWith(".tmp"))).toBe(true);
		} finally {
			rename.mockRestore();
			unlink.mockRestore();
		}
	});

	it("leaves no staging residue across three successful writes", async () => {
		const destinations = ["success-one.ts", "success-two.ts", "success-three.ts"].map(name =>
			path.join(tmpDir, name),
		);
		for (const [index, dest] of destinations.entries()) {
			await writeFileAtomically(dest, `success ${index}\n`);
			expect(await fs.readFile(dest, "utf8")).toBe(`success ${index}\n`);
			expect((await fs.readdir(tmpDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		}
	});

	it.skipIf(process.platform === "win32")(
		"refuses a symlink inside an explicit local root after it is retargeted outside",
		async () => {
			const artifacts = path.join(tmpDir, "artifacts");
			const localRoot = path.join(artifacts, "local");
			const inside = path.join(localRoot, "inside.ts");
			const outside = path.join(tmpDir, "outside-secret.ts");
			const link = path.join(localRoot, "alias.ts");
			await fs.mkdir(localRoot, { recursive: true });
			await fs.writeFile(inside, "inside\n");
			await fs.writeFile(outside, "outside\n");
			await fs.symlink(inside, link);
			await fs.unlink(link);
			await fs.symlink(outside, link);
			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => artifacts,
				getSessionId: () => "explicit-local-trust",
			});
			try {
				await expect(writeFileAtomically(link, "must-not-write\n")).rejects.toThrow(/outside trust boundary/);
				expect(await fs.readFile(outside, "utf8")).toBe("outside\n");
				expect(await fs.readFile(inside, "utf8")).toBe("inside\n");
				expect(await fs.readlink(link)).toBe(outside);
				const kept = path.join(localRoot, "kept.ts");
				await writeFileAtomically(kept, "kept\n");
				expect(await fs.readFile(kept, "utf8")).toBe("kept\n");
			} finally {
				LocalProtocolHandler.setOverride(undefined);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"writes a new nested file under an explicit root reached through a symlink",
		async () => {
			const real = path.join(tmpDir, "real");
			const alias = path.join(tmpDir, "alias");
			const localRoot = path.join(real, "artifacts", "local");
			await fs.mkdir(localRoot, { recursive: true });
			await fs.symlink(real, alias);
			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => path.join(alias, "artifacts"),
				getSessionId: () => "explicit-local-trust",
			});
			try {
				const dest = path.join(alias, "artifacts", "local", "nested", "kept.ts");
				await writeFileAtomically(dest, "kept\n");
				expect(await fs.readFile(path.join(localRoot, "nested", "kept.ts"), "utf8")).toBe("kept\n");
			} finally {
				LocalProtocolHandler.setOverride(undefined);
			}
		},
	);

	it("rejects a symlink escape from the session-scoped gjc-local root", async () => {
		if (process.platform === "win32") return;
		const sessionRoot = path.join(os.tmpdir(), "gjc-local", "atomic-trust-test");
		const outside = path.join(tmpDir, "outside-secret.ts");
		const link = path.join(sessionRoot, "alias.ts");
		await fs.mkdir(sessionRoot, { recursive: true });
		await fs.writeFile(outside, "outside\n");
		await fs.symlink(outside, link);
		try {
			await expect(writeFileAtomically(link, "must-not-write\n")).rejects.toThrow(/outside trust boundary/);
			expect(await fs.readFile(outside, "utf8")).toBe("outside\n");
		} finally {
			await fs.rm(sessionRoot, { recursive: true, force: true });
		}
	});

	it("creates no directories outside the trust boundary for a dangling symlink escape", async () => {
		if (process.platform === "win32") return;
		const sessionRoot = path.join(os.tmpdir(), "gjc-local", "atomic-dangling-test");
		const outsideRoot = path.join(tmpDir, "outside-root");
		// The link target does not exist, and neither do its parents. Resolving it
		// escapes the session root, so nothing under outsideRoot may be created.
		const danglingTarget = path.join(outsideRoot, "attacker", "nested", "payload.ts");
		const link = path.join(sessionRoot, "dangling.ts");
		await fs.mkdir(sessionRoot, { recursive: true });
		await fs.symlink(danglingTarget, link);
		try {
			await expect(writeFileAtomically(link, "must-not-write\n")).rejects.toThrow(/outside trust boundary/);
			// The pre-mkdir boundary check is what this pins: creating parents first
			// would materialize an attacker-selected tree before refusing to publish.
			expect(await Bun.file(danglingTarget).exists()).toBe(false);
			await expect(fs.stat(outsideRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(sessionRoot, { recursive: true, force: true });
		}
	});

	it("does not mkdir an archive path before rejecting a boundary escape", async () => {
		if (process.platform === "win32") return;
		const sessionRoot = path.join(os.tmpdir(), "gjc-local", "archive-boundary-test");
		const outsideRoot = path.join(tmpDir, "archive-outside-root");
		const danglingArchive = path.join(outsideRoot, "attacker", "nested", "payload.zip");
		const link = path.join(sessionRoot, "archive-link.zip");
		await fs.mkdir(sessionRoot, { recursive: true });
		await fs.symlink(danglingArchive, link);
		try {
			await expect(
				new WriteTool(createSession(tmpDir)).execute("archive-boundary", {
					path: `${link}:payload.txt`,
					content: "must not publish\n",
				}),
			).rejects.toThrow(/outside trust boundary/);
			expect(await Bun.file(danglingArchive).exists()).toBe(false);
			await expect(fs.stat(outsideRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(sessionRoot, { recursive: true, force: true });
		}
	});

	it("refuses the Windows in-place fallback when the destination inode was replaced", async () => {
		if (process.platform === "win32") return;
		const dest = path.join(tmpDir, "win-substituted.ts");
		await fs.writeFile(dest, "authorized-original\n");
		const realRename = fs.rename.bind(fs);
		// Every rename attempt reports a sharing violation, and a concurrent writer
		// substitutes a different inode at the same pathname during the retry
		// backoff -- i.e. strictly after the pre-publication identity check, so only
		// the fallback's own revalidation can catch it. The in-place fallback mutates
		// by pathname, so it must refuse rather than overwrite the successor.
		let renameAttempts = 0;
		const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to) === dest) {
				renameAttempts++;
				if (renameAttempts === 1) {
					// Publish a genuinely distinct inode. Deleting and recreating in place
					// is not enough: ext4 reuses the just-freed inode number, so the
					// substitution would be indistinguishable from the authorized file.
					const successor = path.join(tmpDir, "win-successor-source.ts");
					await fs.writeFile(successor, "successor-inode\n");
					await realRename(successor, dest);
				}
				throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
			}
			return realRename(from as PathLike, to as PathLike);
		});
		try {
			await expect(
				writeFileAtomically(dest, "ours\n", { platform: "win32", sleep: async () => {} }),
			).rejects.toMatchObject({ destUnchanged: true, publicationState: "not_published" });
			// The successor must survive untouched, and the report must be truthful.
			expect(await fs.readFile(dest, "utf8")).toBe("successor-inode\n");
			expect((await fs.readdir(tmpDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			rename.mockRestore();
		}
	});

	it("fails closed when the pathname changes after fallback validation", async () => {
		if (process.platform === "win32") return;
		const dest = path.join(tmpDir, "win-post-open-race.ts");
		const successor = path.join(tmpDir, "win-post-open-successor.ts");
		await fs.writeFile(dest, "authorized-original\n");
		const realRename = fs.rename.bind(fs);
		const rename = spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
		let raced = false;
		try {
			await expect(
				writeFileAtomically(dest, "ours\n", {
					platform: "win32",
					sleep: async () => {},
					beforeInPlaceMutation: async () => {
						if (raced) return;
						raced = true;
						await fs.writeFile(successor, "successor-inode\n");
						await realRename(successor, dest);
					},
				}),
			).rejects.toMatchObject({ destUnchanged: true, publicationState: "not_published" });
			expect(raced).toBe(true);
			expect(await fs.readFile(dest, "utf8")).toBe("successor-inode\n");
		} finally {
			rename.mockRestore();
		}
	});

	it("refuses publication when the parent directory is replaced while staging", async () => {
		if (process.platform === "win32") return;
		const parent = path.join(tmpDir, "volatile-parent");
		await fs.mkdir(parent, { recursive: true });
		const dest = path.join(parent, "target.ts");
		await fs.writeFile(dest, "original\n");
		// Swap the parent for a *different* directory at the same path, after the
		// temp is staged and just before publication. The realpath string is
		// unchanged, so only dev/ino identity detects it. The staged temp is carried
		// into the replacement so publication would otherwise succeed there.
		const realStat = fs.stat.bind(fs);
		let swapped = false;
		const stat = spyOn(fs, "stat").mockImplementation((async (target: PathLike, opts?: any) => {
			const isTemp = String(target).includes(".tmp");
			if (!swapped && isTemp) {
				swapped = true;
				const staged = String(target);
				const replacement = path.join(tmpDir, "replacement-parent");
				await fs.mkdir(replacement, { recursive: true });
				await fs.writeFile(path.join(replacement, "target.ts"), "successor\n");
				await fs.copyFile(staged, path.join(replacement, path.basename(staged)));
				await fs.rm(parent, { recursive: true, force: true });
				await fs.rename(replacement, parent);
			}
			return realStat(target, opts);
		}) as typeof fs.stat);
		try {
			await expect(writeFileAtomically(dest, "ours\n")).rejects.toThrow(/parent was retargeted while staging/);
			expect(await fs.readFile(dest, "utf8")).toBe("successor\n");
		} finally {
			stat.mockRestore();
		}
	});

	it("publishes rebuilt archive bytes atomically", async () => {
		const archivePath = path.join(tmpDir, "archive.tar");
		await fs.writeFile(archivePath, await new Bun.Archive({ "pkg/old.txt": "old\n" }).bytes());
		const realOpen = fs.open.bind(fs);
		const original = spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
			if (String(target).includes(".tmp") && flags === "wx") {
				const error = new Error("EPERM: archive publication denied") as Error & { code: string };
				error.code = "EPERM";
				throw error;
			}
			return realOpen(target, flags, mode);
		});
		try {
			await expect(
				new WriteTool(createSession(tmpDir)).execute("archive-atomic", {
					path: `${archivePath}:pkg/new.txt`,
					content: "new\n",
				}),
			).rejects.toThrow(/Permission denied writing/);
			const files = await new Bun.Archive(await fs.readFile(archivePath)).files();
			expect(await files.get("pkg/old.txt")?.text()).toBe("old\n");
			expect(files.has("pkg/new.txt")).toBe(false);
		} finally {
			original.mockRestore();
		}
	});

	it("does not summarize a denied ACP file from disk", async () => {
		const dest = path.join(tmpDir, "denied.ts");
		await fs.writeFile(dest, "export function secret() { return 1; }\nexport function other() { return 2; }\n");
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => {
				const error = new Error("permission denied by client") as Error & { code: string };
				error.code = "permission_denied";
				throw error;
			},
		};
		await expect(
			new ReadTool(createSession(tmpDir, { getClientBridge: () => bridge })).execute("summary-denied", {
				path: dest,
			}),
		).rejects.toThrow(/permission denied by client/);
	});
});
