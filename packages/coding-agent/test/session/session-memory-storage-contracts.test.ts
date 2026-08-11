/**
 * P1 storage contracts for bounded-RAM cold-session offloading: descriptor-validated
 * recorded-length range reads (sync + async, file/memory parity), staged streaming
 * writers for immutable one-shot destinations, and checked commit-marker
 * create/replace with `missing` vs physically `present` raw/hash expectations.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	createSessionCommitMarkerCheckedSync,
	FileSessionStorage,
	MemorySessionStorage,
	readSessionCommitMarkerSync,
	replaceSessionCommitMarkerCheckedSync,
	SESSION_RANGE_READ_MAX_BYTES,
	SESSION_STORAGE_BUFFERED_WRITER_MAX_BYTES,
	SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES,
	type SessionStorageBufferedWriter,
	type SessionStorageExclusiveLock,
	SessionStorageWriterRetryableCloseError,
	STAGED_MEMORY_WRITER_MAX_BYTES,
	STAGED_WRITER_PATCH_LIMIT_BYTES,
	STAGED_WRITER_PATCH_MAX_COUNT,
} from "../../src/session/session-storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fsp.rm(directory, { recursive: true, force: true })),
	);
});

async function makeTempDir(prefix: string): Promise<string> {
	const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

const sampleLines = ["alpha", "beta", "gamma-delta", "epsilon"];
const sampleContent = `${sampleLines.join("\n")}\n`;

describe("descriptor-validated bounded range reads", () => {
	it("sync read returns exact bytes and a matching descriptor snapshot", async () => {
		const dir = await makeTempDir("gjc-range-sync-");
		const filePath = path.join(dir, "transcript.jsonl");
		const file = new FileSessionStorage();
		file.writeTextSync(filePath, sampleContent);

		const snapshot = file.readRangeSync(filePath, 0, sampleContent.length);
		expect(Buffer.from(snapshot.bytes).toString("utf8")).toBe(sampleContent);
		expect(snapshot.stat.isFile).toBe(true);
		expect(snapshot.stat.size).toBe(sampleContent.length);

		// Interior range: [start, start + length) exactly, not a prefix.
		const interiorStart = sampleLines[0].length + 1;
		const interior = file.readRangeSync(filePath, interiorStart, sampleLines[1].length);
		expect(Buffer.from(interior.bytes).toString("utf8")).toBe("beta");
	});

	it("sync and async reads agree with the memory backend (parity)", async () => {
		const dir = await makeTempDir("gjc-range-parity-");
		const filePath = path.join(dir, "transcript.jsonl");
		const file = new FileSessionStorage();
		file.writeTextSync(filePath, sampleContent);
		const memory = new MemorySessionStorage();
		memory.writeTextSync(filePath, sampleContent);

		const fileSync = file.readRangeSync(filePath, 0, sampleContent.length);
		const memorySync = memory.readRangeSync(filePath, 0, sampleContent.length);
		expect(Buffer.from(memorySync.bytes)).toEqual(Buffer.from(fileSync.bytes));
		expect(memorySync.stat.size).toBe(fileSync.stat.size);

		const fileAsync = await file.readRange!(filePath, 2, 8);
		const memoryAsync = await memory.readRange!(filePath, 2, 8);
		expect(Buffer.from(memoryAsync.bytes)).toEqual(Buffer.from(fileAsync.bytes));
	});

	it("rejects out-of-bounds ranges", async () => {
		const dir = await makeTempDir("gjc-range-bounds-");
		const filePath = path.join(dir, "transcript.jsonl");
		const file = new FileSessionStorage();
		file.writeTextSync(filePath, sampleContent);

		expect(() => file.readRangeSync(filePath, -1, 4)).toThrow(RangeError);
		expect(() => file.readRangeSync(filePath, 0, -1)).toThrow(RangeError);
		expect(() => file.readRangeSync(filePath, 0, SESSION_RANGE_READ_MAX_BYTES + 1)).toThrow(RangeError);
		// Present-empty range at EOF is legal; a single byte past EOF is not.
		expect(file.readRangeSync(filePath, sampleContent.length, 0).bytes.byteLength).toBe(0);
		expect(() => file.readRangeSync(filePath, sampleContent.length, 1)).toThrow("range_not_present");
		expect(() => file.readRangeSync(filePath, sampleContent.length - 1, 2)).toThrow("range_not_present");
	});

	it("rejects a swapped object: a second hard link (nlink > 1) is not a single-owned descriptor", async () => {
		const dir = await makeTempDir("gjc-range-nlink-");
		const filePath = path.join(dir, "transcript.jsonl");
		const linkPath = path.join(dir, "transcript.jsonl.hardlink");
		const file = new FileSessionStorage();
		file.writeTextSync(filePath, sampleContent);
		fs.linkSync(filePath, linkPath);

		expect(() => file.readRangeSync(filePath, 0, 4)).toThrow("source_changed");
		await expect(file.readRange!(filePath, 0, 4)).rejects.toThrow("source_changed");
	});

	it("never follows a symlink (no path-based Bun Blob reads for managed authority)", async () => {
		const dir = await makeTempDir("gjc-range-symlink-");
		const filePath = path.join(dir, "transcript.jsonl");
		const linkPath = path.join(dir, "transcript.jsonl.link");
		const file = new FileSessionStorage();
		file.writeTextSync(filePath, sampleContent);
		fs.symlinkSync(filePath, linkPath);

		expect(() => file.readRangeSync(linkPath, 0, 4)).toThrow();
		await expect(file.readRange!(linkPath, 0, 4)).rejects.toThrow();
	});
});

describe("buffered sidecar writers", () => {
	const serializedBytes = Buffer.from('{"type":"index","id":"é"}\n{"type":"tail","n":2}\n', "utf8");

	it("keeps exact bytes across file and memory backends and bounds pending bytes", async () => {
		const dir = await makeTempDir("gjc-buffered-parity-");
		const file = new FileSessionStorage();
		const memory = new MemorySessionStorage();
		const filePath = path.join(dir, "index.jsonl");
		const memoryPath = "/sessions/index.jsonl";
		const fileWriter = file.openBufferedWriter!(filePath, {
			flags: "w",
			bufferSize: SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES,
		});
		const memoryWriter = memory.openBufferedWriter!(memoryPath, {
			flags: "w",
			bufferSize: SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES,
		});
		for (let offset = 0; offset < serializedBytes.byteLength; offset += 3) {
			const chunk = serializedBytes.subarray(offset, Math.min(offset + 3, serializedBytes.byteLength));
			fileWriter.writeBytesSync(chunk);
			memoryWriter.writeBytesSync(chunk);
			expect(fileWriter.getInstrumentation().bufferedBytes).toBeLessThanOrEqual(
				SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES,
			);
			expect(memoryWriter.getInstrumentation().bufferedBytes).toBeLessThanOrEqual(
				SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES,
			);
		}
		fileWriter.fsyncSync();
		memoryWriter.fsyncSync();
		fileWriter.closeSync();
		memoryWriter.closeSync();

		expect(Buffer.from(file.readBytesSync(filePath))).toEqual(Buffer.from(memory.readBytesSync(memoryPath)));
		expect(fileWriter.getInstrumentation()).toMatchObject({
			bytesSubmitted: serializedBytes.byteLength,
			bytesWritten: serializedBytes.byteLength,
		});
		expect(memoryWriter.getInstrumentation()).toMatchObject({
			bytesSubmitted: serializedBytes.byteLength,
			bytesWritten: serializedBytes.byteLength,
		});
	});

	it("reuses memory backing capacity across buffered flushes", () => {
		const memory = new MemorySessionStorage();
		const memoryPath = "/sessions/reused-buffer.jsonl";
		const allocationSpy = vi.spyOn(Buffer, "allocUnsafe");
		const writer = memory.openBufferedWriter!(memoryPath, {
			flags: "w",
			bufferSize: SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES,
		});
		const chunk = Buffer.alloc(SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES, 0x61);
		const flushCount = 8;
		try {
			for (let index = 0; index < flushCount; index++) writer.writeBytesSync(chunk);
			writer.fsyncSync();
			writer.closeSync();
			const totalBytes = chunk.byteLength * flushCount;
			expect(memory.readBytesSync(memoryPath).byteLength).toBe(totalBytes);
			const allocations = allocationSpy.mock.calls
				.map(call => call[0])
				.filter((size): size is number => typeof size === "number");
			expect(Math.max(...allocations)).toBeLessThanOrEqual(totalBytes * 2);
		} finally {
			allocationSpy.mockRestore();
		}
	});

	it("flushes pending bytes before fsync and close", async () => {
		const dir = await makeTempDir("gjc-buffered-order-");
		const file = new FileSessionStorage();
		const filePath = path.join(dir, "order.jsonl");
		const events: string[] = [];
		let closeObservedBytes = -1;
		let writer!: SessionStorageBufferedWriter;

		writer = file.openBufferedWriter!(filePath, {
			flags: "w",
			bufferSize: SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES,
			closeAdapter: {
				close(fd) {
					closeObservedBytes = writer.getInstrumentation().bytesWritten;
					fs.closeSync(fd);
				},
			},
		});
		const realFsync = fs.fsyncSync;
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
			events.push("fsync");
			expect(writer.getInstrumentation().bytesWritten).toBe(serializedBytes.byteLength);
			return realFsync(fd);
		});
		try {
			writer.writeBytesSync(serializedBytes);
			expect(writer.getInstrumentation().bytesWritten).toBe(0);
			writer.fsyncSync();
			events.push("after_fsync");
			writer.writeBytesSync(Buffer.from("close\n", "utf8"));
			writer.closeSync();
		} finally {
			fsync.mockRestore();
		}
		expect(events).toEqual(["fsync", "after_fsync"]);
		expect(closeObservedBytes).toBe(serializedBytes.byteLength + 6);
		expect(writer.getCloseState()).toBe("closed");
	});

	it("reduces backend write calls while preserving ordinary writer behavior", async () => {
		const dir = await makeTempDir("gjc-buffered-calls-");
		const file = new FileSessionStorage();
		const ordinaryPath = path.join(dir, "ordinary.jsonl");
		const bufferedPath = path.join(dir, "buffered.jsonl");
		const ordinary = file.openWriter(ordinaryPath, { flags: "w" }) as unknown as SessionStorageBufferedWriter;
		const buffered = file.openBufferedWriter!(bufferedPath, {
			flags: "w",
			bufferSize: SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES,
		});
		for (let index = 0; index < 32; index++) {
			const bytes = Buffer.from(`record-${index}\n`, "utf8");
			ordinary.writeBytesSync(bytes);
			buffered.writeBytesSync(bytes);
		}
		ordinary.closeSync();
		buffered.closeSync();
		expect(buffered.getInstrumentation().writeCalls).toBeLessThan(ordinary.getInstrumentation().writeCalls);
		expect(file.readBytesSync(bufferedPath)).toEqual(file.readBytesSync(ordinaryPath));
	});

	it("records write failures and keeps subsequent operations deterministic", async () => {
		const dir = await makeTempDir("gjc-buffered-write-failure-");
		const file = new FileSessionStorage();
		const writer = file.openBufferedWriter!(path.join(dir, "write-failure.jsonl"), {
			flags: "w",
			bufferSize: SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES,
		});
		const write = vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
			throw new Error("injected_buffer_write_failure");
		});
		try {
			writer.writeBytesSync(Buffer.from("pending\n", "utf8"));
			expect(() => writer.flushSync()).toThrow("injected_buffer_write_failure");
			expect(() => writer.flushSync()).toThrow("injected_buffer_write_failure");
			expect(writer.getError()?.message).toBe("injected_buffer_write_failure");
			expect(writer.getInstrumentation().writeCalls).toBe(1);
		} finally {
			write.mockRestore();
		}
		writer.closeSync();
		expect(writer.getCloseState()).toBe("closed");
	});

	it("flushes before and preserves the first fsync failure", async () => {
		const dir = await makeTempDir("gjc-buffered-fsync-failure-");
		const file = new FileSessionStorage();
		const filePath = path.join(dir, "fsync-failure.jsonl");
		const writer = file.openBufferedWriter!(filePath, {
			flags: "w",
			bufferSize: SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES,
		});
		writer.writeBytesSync(serializedBytes);
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
			throw new Error("injected_buffer_fsync_failure");
		});
		try {
			expect(() => writer.fsyncSync()).toThrow("injected_buffer_fsync_failure");
			expect(writer.getInstrumentation().bytesWritten).toBe(serializedBytes.byteLength);
			expect(() => writer.fsyncSync()).toThrow("injected_buffer_fsync_failure");
		} finally {
			fsync.mockRestore();
		}
		writer.closeSync();
		expect(Buffer.from(file.readBytesSync(filePath))).toEqual(serializedBytes);
	});

	it("preserves retryable close state after flushing pending bytes", async () => {
		const dir = await makeTempDir("gjc-buffered-close-state-");
		const file = new FileSessionStorage();
		const filePath = path.join(dir, "close-state.jsonl");
		let failFirst = true;
		let closeCalls = 0;
		const writer = file.openBufferedWriter!(filePath, {
			flags: "w",
			bufferSize: SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES,
			closeAdapter: {
				close(fd) {
					closeCalls++;
					if (failFirst) {
						failFirst = false;
						throw new SessionStorageWriterRetryableCloseError("injected_retryable_close");
					}
					fs.closeSync(fd);
				},
			},
		});
		writer.writeBytesSync(serializedBytes);
		expect(() => writer.closeSync()).toThrow("injected_retryable_close");
		expect(writer.getInstrumentation().bytesWritten).toBe(serializedBytes.byteLength);
		expect(writer.getCloseState()).toBe("close_failed_retryable");
		writer.closeSync();
		expect(closeCalls).toBe(2);
		expect(writer.getCloseState()).toBe("closed");
	});

	it("rejects capacities outside the bounded range", async () => {
		const dir = await makeTempDir("gjc-buffered-capacity-");
		const file = new FileSessionStorage();
		expect(() =>
			file.openBufferedWriter!(path.join(dir, "too-small.jsonl"), {
				bufferSize: SESSION_STORAGE_BUFFERED_WRITER_MIN_BYTES - 1,
			}),
		).toThrow(RangeError);
		expect(() =>
			file.openBufferedWriter!(path.join(dir, "too-large.jsonl"), {
				bufferSize: SESSION_STORAGE_BUFFERED_WRITER_MAX_BYTES + 1,
			}),
		).toThrow(RangeError);
	});
});

describe("exclusive disposable build locks", () => {
	it("serializes file and memory owners and releases only the captured identity", async () => {
		const dir = await makeTempDir("gjc-exclusive-lock-");
		for (const [storage, lockPath] of [
			[new FileSessionStorage(), path.join(dir, "build.lock")],
			[new MemorySessionStorage(), "/sessions/build.lock"],
		] as const) {
			const first = storage.acquireExclusiveLockSync!(lockPath);
			expect(first).toBeDefined();
			expect(storage.acquireExclusiveLockSync!(lockPath)).toBeUndefined();
			first!.releaseSync();
			const next = storage.acquireExclusiveLockSync!(lockPath);
			expect(next).toBeDefined();
			next!.releaseSync();
			expect(storage.existsSync(lockPath)).toBe(false);
		}
	});

	it("reclaims a lock whose recorded owner process is absent", async () => {
		const dir = await makeTempDir("gjc-exclusive-lock-stale-");
		const storage = new FileSessionStorage();
		const lockPath = path.join(dir, "build.lock");
		storage.writeTextSync(
			lockPath,
			`${JSON.stringify({ pid: 2_147_483_647, incarnation: "absent:1", token: "stale" })}\n`,
		);
		const lock = storage.acquireExclusiveLockSync!(lockPath);
		expect(lock).toBeDefined();
		lock!.releaseSync();
		expect(storage.existsSync(lockPath)).toBe(false);
	});

	it("does not publish a lock before owner metadata is durable", async () => {
		const dir = await makeTempDir("gjc-exclusive-lock-owner-write-");
		const storage = new FileSessionStorage();
		const lockPath = path.join(dir, "build.lock");
		const write = vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
			throw new Error("injected_owner_write_failure");
		});
		try {
			expect(() => storage.acquireExclusiveLockSync!(lockPath)).toThrow("injected_owner_write_failure");
		} finally {
			write.mockRestore();
		}
		expect(storage.existsSync(lockPath)).toBe(false);
		expect(fs.readdirSync(dir).some(name => name === path.basename(lockPath) || name.endsWith(".owner.tmp"))).toBe(
			false,
		);
		const lock = storage.acquireExclusiveLockSync!(lockPath);
		expect(lock).toBeDefined();
		lock!.releaseSync();
	});

	it("uses the hard-link fallback without retaining the staged owner name", async () => {
		const dir = await makeTempDir("gjc-exclusive-lock-link-fallback-");
		const storage = new FileSessionStorage();
		const lockPath = path.join(dir, "build.lock");
		const rename = vi.spyOn(native, "renameNoReplacePath").mockReturnValue({
			ok: false,
			code: "atomic_unavailable",
			mutationState: "not_committed",
			durabilityState: "not_attempted",
			reason: "atomic_unavailable",
			primitive: "unsupported",
			phase: "rename",
			diagnostic: { schemaVersion: 1, collectionState: "complete" },
		});
		let lock: SessionStorageExclusiveLock | undefined;
		try {
			lock = storage.acquireExclusiveLockSync!(lockPath);
		} finally {
			rename.mockRestore();
		}
		expect(lock).toBeDefined();
		expect(fs.readdirSync(dir).some(name => name.endsWith(".owner.tmp"))).toBe(false);
		lock!.releaseSync();
	});

	it("reclaims a stale hard-link fallback crash after removing its staged name", async () => {
		const dir = await makeTempDir("gjc-exclusive-lock-stale-link-");
		const storage = new FileSessionStorage();
		const lockPath = path.join(dir, "build.lock");
		const token = "stale-link";
		storage.writeTextSync(lockPath, `${JSON.stringify({ pid: 2_147_483_647, incarnation: "absent:1", token })}\n`);
		const stagedPath = `${lockPath}.${token}.owner.tmp`;
		fs.linkSync(lockPath, stagedPath);
		const lock = storage.acquireExclusiveLockSync!(lockPath);
		expect(lock).toBeDefined();
		expect(fs.existsSync(stagedPath)).toBe(false);
		lock!.releaseSync();
	});

	it("allows release retry when exact cleanup transiently fails", async () => {
		const dir = await makeTempDir("gjc-exclusive-lock-release-retry-");
		const storage = new FileSessionStorage();
		const lockPath = path.join(dir, "build.lock");
		const lock = storage.acquireExclusiveLockSync!(lockPath)!;
		const realExactUnlink = native.exactUnlink;
		let failed = false;
		const exactUnlink = vi.spyOn(native, "exactUnlink").mockImplementation((target, identity) => {
			if (target === lockPath && !failed) {
				failed = true;
				return { ok: false, code: "identity_mismatch" };
			}
			return realExactUnlink(target, identity);
		});
		try {
			expect(() => lock.releaseSync()).toThrow("exclusive_lock_release_failed");
			expect(() => lock.releaseSync()).not.toThrow();
		} finally {
			exactUnlink.mockRestore();
		}
		expect(storage.existsSync(lockPath)).toBe(false);
	});

	it("does not reap a replacement installed during stale-lock cleanup", async () => {
		const dir = await makeTempDir("gjc-exclusive-lock-reap-race-");
		const storage = new FileSessionStorage();
		const lockPath = path.join(dir, "build.lock");
		storage.writeTextSync(
			lockPath,
			`${JSON.stringify({ pid: 2_147_483_647, incarnation: "absent:1", token: "stale-race" })}\n`,
		);
		const realExactUnlink = native.exactUnlink;
		const exactUnlink = vi.spyOn(native, "exactUnlink").mockImplementation((target, identity) => {
			if (target === lockPath) {
				fs.unlinkSync(lockPath);
				fs.writeFileSync(lockPath, "replacement\n");
			}
			return realExactUnlink(target, identity);
		});
		try {
			expect(storage.acquireExclusiveLockSync!(lockPath)).toBeUndefined();
		} finally {
			exactUnlink.mockRestore();
		}
		expect(storage.readTextSync(lockPath)).toBe("replacement\n");
	});

	it("does not unlink a replacement file when releasing the original file lock", async () => {
		const dir = await makeTempDir("gjc-exclusive-lock-replacement-");
		const storage = new FileSessionStorage();
		const lockPath = path.join(dir, "build.lock");
		const lock = storage.acquireExclusiveLockSync!(lockPath)!;
		storage.unlinkSync(lockPath);
		storage.writeTextSync(lockPath, "replacement\n");
		lock.releaseSync();
		expect(storage.readTextSync(lockPath)).toBe("replacement\n");
	});
});

describe("staged streaming writers (immutable destinations)", () => {
	it("file backend: stream, patch same-length in place, publish no-replace", async () => {
		const dir = await makeTempDir("gjc-staged-file-");
		const destination = path.join(dir, "fork.jsonl");
		const file = new FileSessionStorage();

		const writer = file.openStagedWriter!(destination);
		for (const line of sampleLines) writer.writeLine(Buffer.from(line, "utf8"));
		// Same-length patch applied in place without an overlay pass.
		writer.patchLine(0, Buffer.from("ALPHA", "utf8"));
		writer.seekToLine(3);
		writer.flush();
		writer.fsync();
		writer.closeSync();
		writer.publishNoReplace();

		expect(file.readTextSync(destination)).toBe("ALPHA\nbeta\ngamma-delta\nepsilon\n");
	});

	it("file backend: patches high ordinals without retaining per-line offsets", async () => {
		const dir = await makeTempDir("gjc-staged-many-lines-");
		const destination = path.join(dir, "fork.jsonl");
		const file = new FileSessionStorage();
		const writer = file.openStagedWriter!(destination);
		for (let ordinal = 0; ordinal < 20_000; ordinal++) writer.writeLine(Buffer.from("value", "utf8"));
		writer.patchLine(19_999, Buffer.from("VALUE", "utf8"));
		writer.closeSync();
		writer.publishNoReplace();
		const lines = file.readTextSync(destination).trimEnd().split("\n");
		expect(lines).toHaveLength(20_000);
		expect(lines.at(-1)).toBe("VALUE");
	});

	it("file backend: different-length patches are applied by the bounded publish-time overlay pass", async () => {
		const dir = await makeTempDir("gjc-staged-overlay-");
		const destination = path.join(dir, "fork.jsonl");
		const file = new FileSessionStorage();

		const writer = file.openStagedWriter!(destination);
		for (const line of sampleLines) writer.writeLine(Buffer.from(line, "utf8"));
		writer.patchLine(0, Buffer.from("longer replacement", "utf8"));
		writer.patchLine(2, Buffer.from("x", "utf8"));
		writer.closeSync();
		writer.publishNoReplace();

		expect(file.readTextSync(destination)).toBe("longer replacement\nbeta\nx\nepsilon\n");
	});

	it("no-replace never overwrites an existing destination", async () => {
		const dir = await makeTempDir("gjc-staged-conflict-");
		const destination = path.join(dir, "fork.jsonl");
		const file = new FileSessionStorage();
		file.writeTextSync(destination, "existing\n");
		const writer = file.openStagedWriter!(destination);
		writer.writeLine(Buffer.from("new", "utf8"));
		writer.closeSync();
		expect(() => writer.publishNoReplace()).toThrow("staged_publish_rejected");
		expect(file.readTextSync(destination)).toBe("existing\n");
	});

	it("requires close before publish and rejects unknown ordinals", async () => {
		const dir = await makeTempDir("gjc-staged-close-");
		const destination = path.join(dir, "fork.jsonl");
		const file = new FileSessionStorage();
		const writer = file.openStagedWriter!(destination);
		writer.writeLine(Buffer.from("one", "utf8"));
		expect(() => writer.publishNoReplace()).toThrow("must be closed");
		expect(() => writer.patchLine(5, Buffer.from("x", "utf8"))).toThrow(RangeError);
		expect(() => writer.seekToLine(9)).toThrow(RangeError);
		writer.closeSync();
		writer.publishNoReplace();
		expect(file.readTextSync(destination)).toBe("one\n");
	});

	it("memory backend mirrors the file contract (parity)", async () => {
		const memory = new MemorySessionStorage();
		const destination = "/sessions/fork.jsonl";
		const writer = memory.openStagedWriter!(destination);
		for (const line of sampleLines) writer.writeLine(Buffer.from(line, "utf8"));
		writer.patchLine(0, Buffer.from("ALPHA", "utf8"));
		writer.patchLine(1, Buffer.from("very different length", "utf8"));
		writer.closeSync();
		writer.publishNoReplace();
		expect(memory.readTextSync(destination)).toBe("ALPHA\nvery different length\ngamma-delta\nepsilon\n");

		const conflict = memory.openStagedWriter!(destination);
		conflict.writeLine(Buffer.from("late", "utf8"));
		conflict.closeSync();
		expect(() => conflict.publishNoReplace()).toThrow("destination_conflict");
		expect(memory.readTextSync(destination)).toBe("ALPHA\nvery different length\ngamma-delta\nepsilon\n");
	});

	it("bounded overlay: aggregated different-length patches cannot exceed the limit", async () => {
		const memory = new MemorySessionStorage();
		const destination = "/sessions/overflow.jsonl";
		const writer = memory.openStagedWriter!(destination);
		writer.writeLine(Buffer.from("seed", "utf8"));
		const oversized = Buffer.alloc(STAGED_WRITER_PATCH_LIMIT_BYTES + 1, 0x61);
		expect(() => writer.patchLine(0, oversized)).toThrow("staged_overlay_capacity_exceeded");
	});

	it("bounded overlay: zero-length patches cannot grow the patch map without limit", () => {
		const memory = new MemorySessionStorage();
		const writer = memory.openStagedWriter!("/sessions/patch-count.jsonl");
		for (let ordinal = 0; ordinal <= STAGED_WRITER_PATCH_MAX_COUNT; ordinal++)
			writer.writeLine(Buffer.from("x", "utf8"));
		for (let ordinal = 0; ordinal < STAGED_WRITER_PATCH_MAX_COUNT; ordinal++)
			writer.patchLine(ordinal, Buffer.alloc(0));
		expect(() => writer.patchLine(STAGED_WRITER_PATCH_MAX_COUNT, Buffer.alloc(0))).toThrow(
			"staged_overlay_capacity_exceeded",
		);
	});

	it("memory staging rejects retained line bytes beyond its fixed bound", () => {
		const memory = new MemorySessionStorage();
		const writer = memory.openStagedWriter!("/sessions/memory-cap.jsonl");
		writer.writeLine(Buffer.alloc(STAGED_MEMORY_WRITER_MAX_BYTES - 1));
		expect(() => writer.writeLine(Buffer.alloc(0))).toThrow("staged_memory_capacity_exceeded");
	});
});

describe("exact staged replacement", () => {
	it("rejects a destination changed after staging", async () => {
		const dir = await makeTempDir("gjc-staged-exact-");
		const destination = path.join(dir, "session.jsonl");
		const source = path.join(dir, "selection.tmp");
		const file = new FileSessionStorage();
		file.writeTextSync(destination, "old\n");
		file.writeTextSync(source, "new\n");
		const expected = {
			stat: file.statSync(destination),
			sha256: createHash("sha256").update("old\n").digest("hex"),
		};
		file.writeTextSync(destination, "foreign\n");
		expect(file.replaceExactSync(source, destination, expected)).toBe(false);
		expect(file.readTextSync(destination)).toBe("foreign\n");
		expect(file.readTextSync(source)).toBe("new\n");

		const current = {
			stat: file.statSync(destination),
			sha256: createHash("sha256").update("foreign\n").digest("hex"),
		};
		expect(file.replaceExactSync(source, destination, current)).toBe(true);
		expect(file.readTextSync(destination)).toBe("new\n");
	});
});

describe("commit-marker checked create/replace", () => {
	const markerBytes = (gen: number): Uint8Array => Buffer.from(`{"gen":${gen}}\n`, "utf8");
	const markerHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

	it("file backend: create only while missing; a second create aborts", async () => {
		const dir = await makeTempDir("gjc-marker-create-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();

		expect(readSessionCommitMarkerSync(file, markerPath)).toEqual({ kind: "missing" });
		createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0));
		const state = readSessionCommitMarkerSync(file, markerPath);
		expect(state.kind).toBe("present");
		if (state.kind === "present") expect(state.rawBytesSha256).toBe(markerHash(markerBytes(0)));

		expect(() => createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(1))).toThrow(
			"commit_marker_expected_missing",
		);
		// A failed create leaves the original marker untouched and no temp debris.
		const after = readSessionCommitMarkerSync(file, markerPath);
		expect(after.kind).toBe("present");
		if (after.kind === "present") expect(after.rawBytesSha256).toBe(markerHash(markerBytes(0)));
		expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("file backend: zero-byte marker writes fail closed", async () => {
		const dir = await makeTempDir("gjc-marker-short-write-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();
		const createWrite = vi.spyOn(fs, "writeSync").mockReturnValueOnce(0);
		try {
			expect(() => createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0))).toThrow("Short write");
		} finally {
			createWrite.mockRestore();
		}
		expect(readSessionCommitMarkerSync(file, markerPath)).toEqual({ kind: "missing" });
		createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0));
		const current = readSessionCommitMarkerSync(file, markerPath);
		if (current.kind !== "present") throw new Error("Expected a present marker");
		const replaceWrite = vi.spyOn(fs, "writeSync").mockReturnValueOnce(0);
		try {
			expect(() =>
				replaceSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(1), {
					rawBytesSha256: current.rawBytesSha256,
					descriptorIdentity: current.stat,
				}),
			).toThrow("Short write");
		} finally {
			replaceWrite.mockRestore();
		}
		const retained = readSessionCommitMarkerSync(file, markerPath);
		expect(retained.kind).toBe("present");
		if (retained.kind === "present") expect(retained.rawBytesSha256).toBe(current.rawBytesSha256);
	});

	it("file backend: temp fsync failure publishes no marker and leaves no temp debris", async () => {
		const dir = await makeTempDir("gjc-marker-temp-fsync-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
			throw new Error("injected_temp_fsync_failure");
		});
		try {
			expect(() => createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0))).toThrow(
				"injected_temp_fsync_failure",
			);
			expect(readSessionCommitMarkerSync(file, markerPath)).toEqual({ kind: "missing" });
			expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			fsync.mockRestore();
		}
		createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(1));
		const recovered = readSessionCommitMarkerSync(file, markerPath);
		expect(recovered.kind).toBe("present");
		if (recovered.kind === "present") expect(recovered.rawBytesSha256).toBe(markerHash(markerBytes(1)));
	});

	it("file backend: directory fsync failure leaves a valid published marker for exact recovery", async () => {
		if (process.platform === "win32") return;
		const dir = await makeTempDir("gjc-marker-directory-fsync-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();
		const realFsync = fs.fsyncSync;
		let calls = 0;
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
			calls++;
			if (calls === 2) throw new Error("injected_directory_fsync_failure");
			return realFsync(fd);
		});
		try {
			expect(() => createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0))).toThrow(
				"injected_directory_fsync_failure",
			);
		} finally {
			fsync.mockRestore();
		}
		const published = readSessionCommitMarkerSync(file, markerPath);
		expect(published.kind).toBe("present");
		if (published.kind === "present") expect(published.rawBytesSha256).toBe(markerHash(markerBytes(0)));
		expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});
	it("file backend: replacement temp fsync failure preserves the marker and leaves no debris", async () => {
		const dir = await makeTempDir("gjc-marker-replace-temp-fsync-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();
		createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0));
		const current = readSessionCommitMarkerSync(file, markerPath);
		if (current.kind !== "present") throw new Error("Expected a present marker");
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
			throw new Error("injected_replace_temp_fsync_failure");
		});
		try {
			expect(() =>
				replaceSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(1), {
					rawBytesSha256: current.rawBytesSha256,
					descriptorIdentity: current.stat,
				}),
			).toThrow("injected_replace_temp_fsync_failure");
		} finally {
			fsync.mockRestore();
		}
		const retained = readSessionCommitMarkerSync(file, markerPath);
		expect(retained.kind).toBe("present");
		if (retained.kind === "present") expect(retained.rawBytesSha256).toBe(current.rawBytesSha256);
		expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});
	it("file backend: replacement directory fsync failure leaves the exact new marker recoverable", async () => {
		if (process.platform === "win32") return;
		const dir = await makeTempDir("gjc-marker-replace-directory-fsync-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();
		createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0));
		const current = readSessionCommitMarkerSync(file, markerPath);
		if (current.kind !== "present") throw new Error("Expected a present marker");
		const realFsync = fs.fsyncSync;
		let calls = 0;
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
			calls++;
			if (calls === 2) throw new Error("injected_replace_directory_fsync_failure");
			return realFsync(fd);
		});
		try {
			expect(() =>
				replaceSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(1), {
					rawBytesSha256: current.rawBytesSha256,
					descriptorIdentity: current.stat,
				}),
			).toThrow("injected_replace_directory_fsync_failure");
		} finally {
			fsync.mockRestore();
		}
		const published = readSessionCommitMarkerSync(file, markerPath);
		expect(published.kind).toBe("present");
		if (published.kind === "present") expect(published.rawBytesSha256).toBe(markerHash(markerBytes(1)));
		expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});
	it("file backend: replace only on exact present raw/hash + descriptor identity match", async () => {
		const dir = await makeTempDir("gjc-marker-replace-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();
		createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0));
		const state = readSessionCommitMarkerSync(file, markerPath);
		expect(state.kind).toBe("present");
		if (state.kind !== "present") throw new Error("Expected a present marker");

		replaceSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(1), {
			rawBytesSha256: state.rawBytesSha256,
			descriptorIdentity: state.stat,
		});
		const replaced = readSessionCommitMarkerSync(file, markerPath);
		expect(replaced.kind).toBe("present");
		if (replaced.kind === "present") expect(replaced.rawBytesSha256).toBe(markerHash(markerBytes(1)));
	});

	it("file backend: wrong raw hash aborts and never touches the marker", async () => {
		const dir = await makeTempDir("gjc-marker-hash-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();
		createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0));
		const state = readSessionCommitMarkerSync(file, markerPath);
		if (state.kind !== "present") throw new Error("Expected a present marker");

		expect(() =>
			replaceSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(1), {
				rawBytesSha256: markerHash(markerBytes(99)),
				descriptorIdentity: state.stat,
			}),
		).toThrow("commit_marker_raw_hash_mismatch");
		const after = readSessionCommitMarkerSync(file, markerPath);
		if (after.kind !== "present") throw new Error("Expected a present marker");
		expect(after.rawBytesSha256).toBe(state.rawBytesSha256);
	});

	it("file backend: stale descriptor identity aborts", async () => {
		const dir = await makeTempDir("gjc-marker-stale-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();
		createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0));
		const state = readSessionCommitMarkerSync(file, markerPath);
		if (state.kind !== "present") throw new Error("Expected a present marker");

		// Mutate the marker object after capture (longer payload so size must differ).
		file.writeTextSync(markerPath, `${Buffer.from(markerBytes(5)).toString("utf8")}trailing\n`);
		expect(() =>
			replaceSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(1), {
				rawBytesSha256: state.rawBytesSha256,
				descriptorIdentity: state.stat,
			}),
		).toThrow("commit_marker_raw_hash_mismatch");
		expect(file.readTextSync(markerPath)).toBe(`${Buffer.from(markerBytes(5)).toString("utf8")}trailing\n`);
	});

	it("file backend: a stale concurrent publisher cannot overwrite the winning marker", async () => {
		const dir = await makeTempDir("gjc-marker-concurrent-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();
		createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0));
		const sharedExpectation = readSessionCommitMarkerSync(file, markerPath);
		if (sharedExpectation.kind !== "present") throw new Error("Expected a present marker");
		const expected = {
			rawBytesSha256: sharedExpectation.rawBytesSha256,
			descriptorIdentity: sharedExpectation.stat,
		};
		replaceSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(1), expected);
		expect(() => replaceSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(2), expected)).toThrow(
			"commit_marker_raw_hash_mismatch",
		);
		const winner = readSessionCommitMarkerSync(file, markerPath);
		expect(winner.kind).toBe("present");
		if (winner.kind === "present") expect(winner.rawBytesSha256).toBe(markerHash(markerBytes(1)));
	});
	it("file backend: simultaneous publishers admit exactly one checked replacement", async () => {
		const dir = await makeTempDir("gjc-marker-concurrent-process-");
		const markerPath = path.join(dir, "session.spill.commit");
		const file = new FileSessionStorage();
		createSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(0));
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-marker-race-worker.ts");
		const spawnPublisher = (publisher: string, generation: number) =>
			Bun.spawn({
				cmd: [process.execPath, worker],
				env: {
					...process.env,
					GJC_MARKER_RACE_ROOT: dir,
					GJC_MARKER_RACE_PUBLISHER: publisher,
					GJC_MARKER_RACE_GENERATION: String(generation),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
		const left = spawnPublisher("left", 1);
		const right = spawnPublisher("right", 2);
		for (let attempt = 0; attempt < 5_000; attempt++) {
			if (fs.existsSync(path.join(dir, "ready-left")) && fs.existsSync(path.join(dir, "ready-right"))) break;
			await Bun.sleep(1);
		}
		expect(fs.existsSync(path.join(dir, "ready-left"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "ready-right"))).toBe(true);
		fs.writeFileSync(path.join(dir, "go"), "go\n");
		const [leftExit, rightExit] = await Promise.all([left.exited, right.exited]);
		const [leftOutput, rightOutput, leftError, rightError] = await Promise.all([
			new Response(left.stdout).text(),
			new Response(right.stdout).text(),
			new Response(left.stderr).text(),
			new Response(right.stderr).text(),
		]);
		expect(leftExit, leftError).toBe(0);
		expect(rightExit, rightError).toBe(0);
		const results = [leftOutput, rightOutput].map(
			text => JSON.parse(text) as { outcome: "published" | "rejected"; generation: number; error?: string },
		);
		expect(
			results.filter(result => result.outcome === "published"),
			JSON.stringify(results),
		).toHaveLength(1);
		expect(results.filter(result => result.outcome === "rejected")).toHaveLength(1);
		expect(results.find(result => result.outcome === "rejected")?.error).toMatch(/commit_marker_/);
		const winner = results.find(result => result.outcome === "published")!;
		const state = readSessionCommitMarkerSync(file, markerPath);
		expect(state.kind).toBe("present");
		if (state.kind === "present") expect(state.rawBytesSha256).toBe(markerHash(markerBytes(winner.generation)));
		expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});
	it("file backend: corrupt-present is present, never missing, and replaceable by exact raw bytes", async () => {
		const dir = await makeTempDir("gjc-marker-corrupt-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();
		const corrupt = Buffer.from("not-json{{{{", "utf8");
		file.writeTextSync(markerPath, corrupt.toString("utf8"));

		const state = readSessionCommitMarkerSync(file, markerPath);
		expect(state.kind).toBe("present");
		if (state.kind !== "present") throw new Error("Expected a present marker");
		expect(state.rawBytesSha256).toBe(markerHash(corrupt));

		replaceSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(1), {
			rawBytesSha256: state.rawBytesSha256,
			descriptorIdentity: state.stat,
		});
		const after = readSessionCommitMarkerSync(file, markerPath);
		if (after.kind !== "present") throw new Error("Expected a present marker");
		expect(after.rawBytesSha256).toBe(markerHash(markerBytes(1)));
	});

	it("file backend: replace when the marker is missing aborts", async () => {
		const dir = await makeTempDir("gjc-marker-missing-");
		const markerPath = path.join(dir, "session.jsonl.spill.commit");
		const file = new FileSessionStorage();
		expect(() =>
			replaceSessionCommitMarkerCheckedSync(file, markerPath, markerBytes(1), {
				rawBytesSha256: markerHash(markerBytes(1)),
				descriptorIdentity: file.statSync(dir),
			}),
		).toThrow("commit_marker_expected_present");
	});

	it("memory backend mirrors create/replace parity (missing/present/hash/identity aborts)", async () => {
		const memory = new MemorySessionStorage();
		const markerPath = "/sessions/session.jsonl.spill.commit";

		expect(readSessionCommitMarkerSync(memory, markerPath)).toEqual({ kind: "missing" });
		createSessionCommitMarkerCheckedSync(memory, markerPath, markerBytes(0));
		expect(() => createSessionCommitMarkerCheckedSync(memory, markerPath, markerBytes(1))).toThrow(
			"commit_marker_expected_missing",
		);

		const state = readSessionCommitMarkerSync(memory, markerPath);
		if (state.kind !== "present") throw new Error("Expected a present marker");
		expect(state.rawBytesSha256).toBe(markerHash(markerBytes(0)));

		expect(() =>
			replaceSessionCommitMarkerCheckedSync(memory, markerPath, markerBytes(1), {
				rawBytesSha256: markerHash(markerBytes(99)),
				descriptorIdentity: state.stat,
			}),
		).toThrow("commit_marker_raw_hash_mismatch");

		// Stale identity: overwrite with a longer payload after capture.
		memory.writeTextSync(markerPath, `${Buffer.from(markerBytes(5)).toString("utf8")}trailing\n`);
		expect(() =>
			replaceSessionCommitMarkerCheckedSync(memory, markerPath, markerBytes(1), {
				rawBytesSha256: state.rawBytesSha256,
				descriptorIdentity: state.stat,
			}),
		).toThrow("commit_marker_raw_hash_mismatch");

		// Exact present match replaces successfully.
		const current = readSessionCommitMarkerSync(memory, markerPath);
		if (current.kind !== "present") throw new Error("Expected a present marker");
		replaceSessionCommitMarkerCheckedSync(memory, markerPath, markerBytes(1), {
			rawBytesSha256: current.rawBytesSha256,
			descriptorIdentity: current.stat,
		});
		const replaced = readSessionCommitMarkerSync(memory, markerPath);
		if (replaced.kind !== "present") throw new Error("Expected a present marker");
		expect(replaced.rawBytesSha256).toBe(markerHash(markerBytes(1)));

		// Corrupt-present parity on the memory backend.
		const corruptPath = "/sessions/other.jsonl.spill.commit";
		memory.writeTextSync(corruptPath, "corrupt{{");
		const corruptState = readSessionCommitMarkerSync(memory, corruptPath);
		expect(corruptState.kind).toBe("present");
		if (corruptState.kind !== "present") throw new Error("Expected a present marker");
		expect(corruptState.rawBytesSha256).toBe(markerHash(Buffer.from("corrupt{{", "utf8")));
	});
});

describe("derived sidecar lifecycle cleanup", () => {
	it("removes derived siblings for file and memory storage", async () => {
		const dir = await makeTempDir("gjc-sidecar-delete-");
		const sessionPath = path.join(dir, "session.jsonl");
		const file = new FileSessionStorage();
		file.writeTextSync(sessionPath, "{}\n");
		file.writeTextSync(`${sessionPath}.spill.idx`, "index\n");
		file.writeTextSync(`${sessionPath}.spill.tail`, "tail\n");
		await file.deleteSessionWithArtifacts(sessionPath);
		expect(file.existsSync(sessionPath)).toBe(false);
		expect(file.existsSync(`${sessionPath}.spill.idx`)).toBe(false);
		expect(file.existsSync(`${sessionPath}.spill.tail`)).toBe(false);

		const memory = new MemorySessionStorage();
		memory.writeTextSync(sessionPath, "{}\n");
		memory.writeTextSync(`${sessionPath}.spill.idx`, "index\n");
		memory.writeTextSync(`${sessionPath}.spill.commit`, "commit\n");
		const memoryArtifactDir = sessionPath.slice(0, -6);
		const memoryBuildLock = `${memoryArtifactDir}/.session-memory.spill.build-lock`;
		const memoryStagedOwner = `${memoryBuildLock}.owner.owner.tmp`;
		memory.writeTextSync(memoryBuildLock, "lock\n");
		memory.writeTextSync(memoryStagedOwner, "owner\n");
		await memory.deleteSessionWithArtifacts(sessionPath);
		expect(memory.existsSync(sessionPath)).toBe(false);
		expect(memory.existsSync(`${sessionPath}.spill.idx`)).toBe(false);
		expect(memory.existsSync(`${sessionPath}.spill.commit`)).toBe(false);
		expect(memory.existsSync(memoryBuildLock)).toBe(false);
		expect(memory.existsSync(memoryStagedOwner)).toBe(false);
	});

	it("leaves no spill debris across 100 create-delete cycles", async () => {
		const dir = await makeTempDir("gjc-sidecar-cycles-");
		const file = new FileSessionStorage();
		const memory = new MemorySessionStorage();
		for (let cycle = 0; cycle < 100; cycle++) {
			const fileSession = path.join(dir, `session-${cycle}.jsonl`);
			file.writeTextSync(fileSession, "{}\n");
			file.writeTextSync(`${fileSession}.spill.idx`, "index\n");
			file.writeTextSync(`${fileSession}.spill.buckets`, "buckets\n");
			await file.deleteSessionWithArtifacts(fileSession);

			const memorySession = `/sessions/session-${cycle}.jsonl`;
			memory.writeTextSync(memorySession, "{}\n");
			memory.writeTextSync(`${memorySession}.spill.tail`, "tail\n");
			memory.writeTextSync(`${memorySession}.spill.overlay-${cycle}.tmp`, "overlay\n");
			await memory.deleteSessionWithArtifacts(memorySession);
		}
		expect(file.listFilesSync(dir, "*.spill.*")).toEqual([]);
		expect(memory.listFilesSync("/sessions", "*.spill.*")).toEqual([]);
	});
});
