import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import { ArtifactManager } from "../src/session/artifacts";
import { ManagedSessionDescendantStore, managedDirectoryRoot } from "../src/session/internal/managed-session-storage";

const stores: ManagedSessionDescendantStore[] = [];
const directories: string[] = [];

interface ArtifactFixture {
	manager: ArtifactManager;
	store: ManagedSessionDescendantStore;
	root: string;
	artifactsDir: string;
	artifactPath: string;
	id: string;
}

async function fixture(content: string, pathBacked = false): Promise<ArtifactFixture> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-artifact-read-identity-"));
	directories.push(root);
	await fsp.chmod(root, 0o700);
	const artifactsDir = path.join(root, "artifacts");
	let store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir);
	stores.push(store);
	let manager = new ArtifactManager(store);
	const id = await manager.save(content, "tool");
	if (pathBacked) {
		store = new ManagedSessionDescendantStore(
			managedDirectoryRoot(root),
			artifactsDir,
			undefined,
			"default",
			root,
			managedDirectoryRoot(artifactsDir),
			"read-only",
		);
		stores.push(store);
		manager = new ArtifactManager(store);
	}
	return { manager, store, root, artifactsDir, artifactPath: path.join(artifactsDir, `${id}.tool.log`), id };
}

function forwardingNativeFileSpies() {
	const openFile = native.RecoveryFsRoot.prototype.openFile;
	const readChunk = native.RecoveryFsFile.prototype.readChunk;
	const close = native.RecoveryFsFile.prototype.close;
	const openFileSpy = vi.spyOn(native.RecoveryFsRoot.prototype, "openFile").mockImplementation(function (
		this: native.RecoveryFsRoot,
		relativePath: string,
	) {
		return openFile.call(this, relativePath);
	});
	const readChunkSpy = vi.spyOn(native.RecoveryFsFile.prototype, "readChunk").mockImplementation(function (
		this: native.RecoveryFsFile,
		offset: number,
		maxBytes: number,
	) {
		return readChunk.call(this, offset, maxBytes);
	});
	const closeSpy = vi.spyOn(native.RecoveryFsFile.prototype, "close").mockImplementation(function (
		this: native.RecoveryFsFile,
	) {
		return close.call(this);
	});
	return { openFileSpy, readChunkSpy, closeSpy };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		chunks.push(result.value);
		size += result.value.byteLength;
	}
	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

afterEach(async () => {
	for (const store of stores.splice(0)) store.close();
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map(directory => fsp.rm(directory, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("managed artifact reads stay bound to captured file identity", () => {
	it("preserves Blob text decoding for BOM, split UTF-8, and numeric byte ranges", async () => {
		const { manager, id, artifactPath } = await fixture("﻿hé𐐀tail");
		const file = Bun.file(artifactPath);
		for (const range of [
			{ start: 0, endExclusive: 14 },
			{ start: 0, endExclusive: 3 },
			{ start: 4, endExclusive: 5 },
			{ start: 5, endExclusive: 8 },
			{ start: 0.8, endExclusive: 10.9 },
			{ start: -4, endExclusive: 100 },
			{ start: Number.POSITIVE_INFINITY, endExclusive: Number.POSITIVE_INFINITY },
			{ start: Number.NaN, endExclusive: 8 },
			{ start: 4, endExclusive: Number.NaN },
		]) {
			const start = Math.max(0, Math.min(file.size, range.start));
			const end = Math.max(start, Math.min(file.size, range.endExclusive));
			expect(await manager.readRange(id, range)).toBe(await file.slice(start, end).text());
		}
	});

	it("reads exact bounded ranges and streams through the retained native read object", async () => {
		const text = `${"first-chunk-".repeat(7000)}${"second-chunk-".repeat(7000)}`;
		const { manager, id } = await fixture(text);
		const spies = forwardingNativeFileSpies();

		expect(await manager.readRange(id, { start: 7, endExclusive: 29 })).toBe(text.slice(7, 29));
		const streamed = await readStream(
			await manager.openReadStream(id, { start: 13, endExclusive: text.length - 11 }),
		);
		expect(new TextDecoder().decode(streamed)).toBe(text.slice(13, -11));
		expect(spies.openFileSpy).toHaveBeenCalledTimes(1);
		expect(spies.readChunkSpy.mock.calls.length).toBeGreaterThan(1);
		expect(spies.closeSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects a leaf replaced with an outside symlink after native identity capture", async () => {
		const { manager, id, artifactPath, root } = await fixture("trusted bytes");
		const outside = path.join(root, "outside.txt");
		const displaced = path.join(root, "displaced.txt");
		await fsp.writeFile(outside, "outside secret");
		const stat = native.RecoveryFsRoot.prototype.stat;
		let replaced = false;
		vi.spyOn(native.RecoveryFsRoot.prototype, "stat").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath: string,
		) {
			const result = stat.call(this, relativePath);
			if (!replaced && relativePath === `${id}.tool.log`) {
				replaced = true;
				fs.renameSync(artifactPath, displaced);
				fs.symlinkSync(outside, artifactPath);
			}
			return result;
		});

		await expect(manager.readRange(id)).rejects.toThrow();
		expect(replaced).toBe(true);
		expect(await fsp.readFile(outside, "utf8")).toBe("outside secret");
	});

	it("rejects a same-name new inode rather than returning its bytes", async () => {
		const { manager, id, artifactPath, root } = await fixture("original bytes");
		const replacement = path.join(root, "replacement.txt");
		const displaced = path.join(root, "original.txt");
		await fsp.writeFile(replacement, "replacement bytes");
		const stat = native.RecoveryFsRoot.prototype.stat;
		let replaced = false;
		vi.spyOn(native.RecoveryFsRoot.prototype, "stat").mockImplementation(function (
			this: native.RecoveryFsRoot,
			relativePath: string,
		) {
			const result = stat.call(this, relativePath);
			if (!replaced && relativePath === `${id}.tool.log`) {
				replaced = true;
				fs.renameSync(artifactPath, displaced);
				fs.renameSync(replacement, artifactPath);
			}
			return result;
		});

		await expect(manager.readRange(id)).rejects.toThrow("source_changed");
		expect(replaced).toBe(true);
	});

	it("rejects in-place mutation between stream chunks and closes the actual native handle", async () => {
		const text = "a".repeat(ARTIFACT_TEST_STREAM_BYTES);
		const { manager, id, artifactPath } = await fixture(text);
		const spies = forwardingNativeFileSpies();
		const reader = (await manager.openReadStream(id)).getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBe(64 * 1024);
		fs.appendFileSync(artifactPath, "changed after the first chunk");

		await expect(reader.read()).rejects.toThrow("source_changed");
		expect(spies.readChunkSpy.mock.calls.length).toBe(1);
		expect(spies.closeSpy).toHaveBeenCalledTimes(1);
	});

	it("does not switch to a same-name replacement between stream chunks", async () => {
		const { manager, id, artifactPath, root } = await fixture("a".repeat(ARTIFACT_TEST_STREAM_BYTES));
		const replacement = path.join(root, "replacement.log");
		const displaced = path.join(root, "original.log");
		const spies = forwardingNativeFileSpies();
		const reader = (await manager.openReadStream(id)).getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBe(64 * 1024);
		await fsp.writeFile(replacement, "B".repeat(ARTIFACT_TEST_STREAM_BYTES));
		await fsp.rename(artifactPath, displaced);
		await fsp.rename(replacement, artifactPath);

		await expect(reader.read()).rejects.toThrow("source_changed");
		expect(spies.readChunkSpy.mock.calls.length).toBe(1);
		expect(spies.closeSpy).toHaveBeenCalledTimes(1);
		expect(await fsp.readFile(artifactPath, "utf8")).toBe("B".repeat(ARTIFACT_TEST_STREAM_BYTES));
	});

	it("closes the retained native handle when a consumer cancels", async () => {
		const { manager, id } = await fixture("x".repeat(ARTIFACT_TEST_STREAM_BYTES));
		const spies = forwardingNativeFileSpies();
		const reader = (await manager.openReadStream(id)).getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBe(64 * 1024);
		await reader.cancel("consumer stopped");

		expect(spies.openFileSpy).toHaveBeenCalledTimes(1);
		expect(spies.readChunkSpy).toHaveBeenCalledTimes(1);
		expect(spies.closeSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects a replaced managed root between stream chunks and still releases the file handle", async () => {
		const { manager, id, artifactsDir, root } = await fixture("r".repeat(ARTIFACT_TEST_STREAM_BYTES));
		const moved = path.join(root, "moved-artifacts");
		const spies = forwardingNativeFileSpies();
		const reader = (await manager.openReadStream(id)).getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBe(64 * 1024);
		await fsp.rename(artifactsDir, moved);
		await fsp.mkdir(artifactsDir, { mode: 0o700 });
		await fsp.writeFile(path.join(artifactsDir, `${id}.tool.log`), "untrusted replacement");

		await expect(reader.read()).rejects.toThrow("Managed descendant root binding changed");
		expect(spies.closeSpy).toHaveBeenCalledTimes(1);
	});

	it("path-backed range reads reject a symlink swapped in after the leaf descriptor opens", async () => {
		const { manager, id, artifactPath, root } = await fixture("path-backed trusted", true);
		const outside = path.join(root, "outside.txt");
		const displaced = path.join(root, "displaced.txt");
		await fsp.writeFile(outside, "path-backed outside secret");
		expect(await manager.readRange(id, { start: 2, endExclusive: 10 })).toBe("th-backe");
		const openSync = fs.openSync.bind(fs);
		let replaced = false;
		vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
			const fd = openSync(file, flags as never, mode as never);
			const pathname = typeof file === "string" ? file : file.toString();
			if (!replaced && path.resolve(pathname) === path.resolve(artifactPath)) {
				replaced = true;
				fs.renameSync(artifactPath, displaced);
				fs.symlinkSync(outside, artifactPath);
			}
			return fd;
		}) as typeof fs.openSync);

		await expect(manager.readRange(id)).rejects.toThrow("managed_range_generation_mismatch");
		expect(replaced).toBe(true);
		expect(await fsp.readFile(outside, "utf8")).toBe("path-backed outside secret");
	});

	it("path-backed streams pin the captured metadata across chunks and close every opened descriptor", async () => {
		const { manager, id, artifactPath } = await fixture("p".repeat(ARTIFACT_TEST_STREAM_BYTES), true);
		const openSync = fs.openSync.bind(fs);
		const closeSync = fs.closeSync.bind(fs);
		const readDescriptors = new Set<number>();
		let openedReadDescriptors = 0;
		let closedReadDescriptors = 0;
		vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
			const fd = openSync(file, flags as never, mode as never);
			const pathname = typeof file === "string" ? file : file.toString();
			if (
				path.resolve(pathname) === path.resolve(artifactPath) &&
				typeof flags === "number" &&
				(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0
			) {
				openedReadDescriptors++;
				readDescriptors.add(fd);
			}
			return fd;
		}) as typeof fs.openSync);
		vi.spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
			if (readDescriptors.delete(fd)) closedReadDescriptors++;
			return closeSync(fd);
		}) as typeof fs.closeSync);
		const reader = (await manager.openReadStream(id)).getReader();
		const first = await reader.read();
		expect(first.value?.byteLength).toBe(64 * 1024);
		fs.appendFileSync(artifactPath, "changed after the first chunk");

		await expect(reader.read()).rejects.toThrow("managed_range_generation_mismatch");
		expect(openedReadDescriptors).toBeGreaterThan(0);
		expect(closedReadDescriptors).toBe(openedReadDescriptors);
		expect(readDescriptors.size).toBe(0);
	});
});

const ARTIFACT_TEST_STREAM_BYTES = 2 * 64 * 1024 + 17;
