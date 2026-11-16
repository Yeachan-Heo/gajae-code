import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionNoReplacePublicationReceipt,
} from "../../src/session/session-storage";

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(process.platform === "win32")("descriptor-bound staged publication receipts", () => {
	let directory: string;
	let destination: string;
	const storage = new FileSessionStorage();
	beforeEach(async () => {
		directory = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-staged-receipt-"));
		destination = path.join(directory, "session.jsonl");
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(directory, { recursive: true, force: true });
	});
	const stagingPath = (): string => {
		const name = fs.readdirSync(directory).find(name => name.endsWith(".staged"));
		if (!name) throw new Error("Missing test staging file");
		return path.join(directory, name);
	};

	for (const patched of [false, true]) {
		it(`attests exact ${patched ? "patched" : "original"} bytes only after real file and directory sync`, async () => {
			const writer = storage.openStagedWriter(destination);
			writer.writeLine(Buffer.from("alpha"));
			writer.writeLine(Buffer.from("beta"));
			writer.patchLine(0, Buffer.from("ALPHA"));
			if (patched) writer.patchLine(1, Buffer.from("different length"));
			const original = fs.lstatSync(stagingPath(), { bigint: true });
			writer.closeSync();
			const events: string[] = [];
			const syncedFiles: Array<{ dev: bigint; ino: bigint }> = [];
			const realSync = fs.fsyncSync;
			vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
				const stat = fs.fstatSync(fd, { bigint: true });
				events.push(stat.isDirectory() ? "directory_sync" : "file_sync");
				if (stat.isFile()) syncedFiles.push({ dev: stat.dev, ino: stat.ino });
				realSync(fd);
			});
			const realPublish = native.renameNoReplacePath;
			vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, target) => {
				events.push("publish");
				return realPublish(source, target);
			});
			const cleanup = vi.spyOn(native, "exactUnlink");
			const receipt = writer.publishNoReplace();
			const expected = Buffer.from(patched ? "ALPHA\ndifferent length\n" : "ALPHA\nbeta\n");
			const snapshot = storage.readSnapshotSync(destination);
			expect(receipt.kind).toBe("fsync");
			expect(receipt.namespaceSynced).toBe(true);
			expect(receipt.publicationId).toMatch(/^[0-9a-f-]{36}$/);
			expect(receipt.sha256).toBe(hash(expected));
			expect(receipt.stat).toEqual(snapshot.stat);
			expect(snapshot.bytes).toEqual(expected);
			expect(syncedFiles).toContainEqual({ dev: receipt.stat.dev, ino: receipt.stat.ino });
			expect(events.indexOf("file_sync")).toBeLessThan(events.indexOf("publish"));
			expect(events.indexOf("publish")).toBeLessThan(events.lastIndexOf("directory_sync"));
			expect(receipt.stat.dev).toBe(original.dev);
			if (patched) expect(receipt.stat.ino).not.toBe(original.ino);
			else expect(receipt.stat.ino).toBe(original.ino);
			// Native POSIX unlink scrubs its exact detached descriptor and retains the
			// private entry; no unobserved or foreign residue is accepted here.
			const retained: string[] = [];
			for (const [, identity] of cleanup.mock.calls) {
				if (!identity.quarantineName) continue;
				const name = identity.quarantineName;
				const stat = await fsp.lstat(path.join(directory, name), { bigint: true }).catch((error: unknown) => {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
					throw error;
				});
				if (!stat) continue;
				expect(stat.isFile()).toBe(true);
				expect([stat.dev, stat.ino, stat.size]).toEqual([identity.dev, identity.ino, 0n]);
				expect(await Bun.file(path.join(directory, name)).bytes()).toHaveLength(0);
				retained.push(name);
			}
			expect((await fsp.readdir(directory)).sort()).toEqual(["session.jsonl", ...retained].sort());
			expect(() => writer.publishNoReplace()).toThrow("already published");
		});
	}

	for (const patched of [false, true]) {
		for (const beforeClose of [false, true]) {
			it(`rejects a byte-identical replaced ${patched ? "overlay source" : "stage"} ${beforeClose ? "before" : "after"} close before effects`, async () => {
				const writer = storage.openStagedWriter(destination);
				writer.writeLine(Buffer.from("original"));
				if (patched) writer.patchLine(0, Buffer.from("patched longer"));
				const stage = stagingPath();
				if (!beforeClose) writer.closeSync();
				await fsp.rename(stage, `${stage}.owned`);
				await Bun.write(stage, "original\n");
				await fsp.chmod(stage, 0o600);
				const successor = await fsp.lstat(stage, { bigint: true });
				if (beforeClose) writer.closeSync();
				const sync = vi.spyOn(fs, "fsyncSync");
				const write = vi.spyOn(fs, "writeSync");
				const rename = vi.spyOn(native, "renameNoReplacePath");
				const link = vi.spyOn(native, "linkNoReplacePath");
				expect(() => writer.publishNoReplace()).toThrow("staged_source_identity_changed");
				expect(sync).not.toHaveBeenCalled();
				expect(write).not.toHaveBeenCalled();
				expect(rename).not.toHaveBeenCalled();
				expect(link).not.toHaveBeenCalled();
				expect(await Bun.file(stage).text()).toBe("original\n");
				expect((await fsp.lstat(stage, { bigint: true })).ino).toBe(successor.ino);
				expect(await Bun.file(destination).exists()).toBe(false);
				expect((await fsp.readdir(directory)).some(name => name.endsWith(".staged-final"))).toBe(false);
			});
		}
	}

	it("rejects a patched-copy replacement using its created descriptor identity, not a later matching hash", async () => {
		const writer = storage.openStagedWriter(destination);
		writer.writeLine(Buffer.from("original"));
		writer.patchLine(0, Buffer.from("patched longer"));
		writer.closeSync();
		const replacement = path.join(directory, "replacement");
		await Bun.write(replacement, "patched longer\n");
		await fsp.chmod(replacement, 0o600);
		const realClose = fs.closeSync;
		let replacedPath: string | undefined;
		vi.spyOn(fs, "closeSync").mockImplementation(fd => {
			const opened = fs.fstatSync(fd, { bigint: true });
			const copy = fs.readdirSync(directory).find(name => name.endsWith(".staged-final"));
			const copyPath = copy === undefined ? undefined : path.join(directory, copy);
			const replace =
				!replacedPath && copyPath !== undefined && fs.lstatSync(copyPath, { bigint: true }).ino === opened.ino;
			realClose(fd);
			if (replace && copyPath) {
				replacedPath = copyPath;
				fs.renameSync(copyPath, `${copyPath}.owned`);
				fs.copyFileSync(replacement, copyPath);
			}
		});
		const sync = vi.spyOn(fs, "fsyncSync");
		const publish = vi.spyOn(native, "renameNoReplacePath");
		expect(() => writer.publishNoReplace()).toThrow("staged_source_identity_changed");
		expect(replacedPath).toBeDefined();
		expect(sync).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
		expect(await Bun.file(replacedPath!).text()).toBe("patched longer\n");
		expect(await Bun.file(destination).exists()).toBe(false);
	});

	it("a source swap at native dispatch cannot turn matching bytes on another inode into a receipt", async () => {
		const writer = storage.openStagedWriter(destination);
		writer.writeLine(Buffer.from("original"));
		writer.closeSync();
		const replacement = path.join(directory, "replacement");
		await Bun.write(replacement, "original\n");
		await fsp.chmod(replacement, 0o600);
		const realPublish = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, target) => {
			fs.renameSync(source, `${source}.owned`);
			fs.copyFileSync(replacement, source);
			return realPublish(source, target);
		});
		expect(() => writer.publishNoReplace()).toThrow("destination_identity_changed");
		expect(await Bun.file(destination).text()).toBe("original\n");
	});

	it("never attests a different destination inode even when its bytes match", async () => {
		const writer = storage.openStagedWriter(destination);
		writer.writeLine(Buffer.from("original"));
		writer.closeSync();
		const replacement = path.join(directory, "replacement");
		await Bun.write(replacement, "original\n");
		await fsp.chmod(replacement, 0o600);
		const realPublish = native.renameNoReplacePath;
		vi.spyOn(native, "renameNoReplacePath").mockImplementation((source, target) => {
			const outcome = realPublish(source, target);
			if (outcome.ok) {
				fs.renameSync(target, `${target}.owned`);
				fs.copyFileSync(replacement, target);
			}
			return outcome;
		});
		expect(() => writer.publishNoReplace()).toThrow("destination_identity_changed");
		expect(await Bun.file(destination).text()).toBe("original\n");
	});

	it("does not issue a receipt for an existing destination or overwrite its generation", async () => {
		await Bun.write(destination, "existing\n");
		const before = await fsp.lstat(destination, { bigint: true });
		const writer = storage.openStagedWriter(destination);
		writer.writeLine(Buffer.from("new"));
		writer.closeSync();
		expect(() => writer.publishNoReplace()).toThrow("staged_publish_rejected:destination_exists");
		expect(await Bun.file(destination).text()).toBe("existing\n");
		expect((await fsp.lstat(destination, { bigint: true })).ino).toBe(before.ino);
	});

	for (const directoryFailure of [false, true]) {
		it(`does not issue a receipt after ${directoryFailure ? "directory" : "file"} fsync failure`, async () => {
			const writer = storage.openStagedWriter(destination);
			writer.writeLine(Buffer.from("original"));
			writer.closeSync();
			const realSync = fs.fsyncSync;
			const failure = new Error("injected sync failure");
			let rejectedSync = false;
			vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
				if (fs.fstatSync(fd).isDirectory() === directoryFailure) {
					rejectedSync = true;
					throw failure;
				}
				realSync(fd);
			});
			const publish = vi.spyOn(native, "renameNoReplacePath");
			let receipt: SessionNoReplacePublicationReceipt | undefined;
			expect(() => {
				receipt = writer.publishNoReplace();
			}).toThrow(failure);
			expect(rejectedSync).toBe(true);
			expect(receipt).toBeUndefined();
			expect(publish.mock.calls).toHaveLength(directoryFailure ? 1 : 0);
			expect(await Bun.file(destination).exists()).toBe(directoryFailure);
			if (directoryFailure) expect(await Bun.file(destination).text()).toBe("original\n");
			expect(() => writer.publishNoReplace()).toThrow(failure);
		});
	}

	it("hashes and overlays a multi-chunk transcript without full-buffer reads or allocations", () => {
		const writer = storage.openStagedWriter(destination);
		const line = Buffer.from("a".repeat(63));
		for (let ordinal = 0; ordinal < 20_000; ordinal++) writer.writeLine(line);
		writer.patchLine(0, Buffer.from("patched"));
		writer.closeSync();
		const expectedHash = createHash("sha256").update("patched\n");
		for (let ordinal = 1; ordinal < 20_000; ordinal++) expectedHash.update(line).update("\n");
		const readFile = vi.spyOn(fs, "readFileSync");
		const snapshot = vi.spyOn(storage, "readSnapshotSync");
		const read = vi.spyOn(fs, "readSync");
		const alloc = vi.spyOn(Buffer, "alloc");
		const allocUnsafe = vi.spyOn(Buffer, "allocUnsafe");
		const receipt = writer.publishNoReplace();
		expect(receipt.sha256).toBe(expectedHash.digest("hex"));
		expect(receipt.stat.size).toBe(8 + 19_999 * 64);
		expect(readFile).not.toHaveBeenCalled();
		expect(snapshot).not.toHaveBeenCalled();
		const numericReads: unknown[][] = read.mock.calls;
		expect(numericReads.length).toBeGreaterThan(20);
		expect(numericReads.every(call => typeof call[3] === "number" && call[3] <= 64 * 1024)).toBe(true);
		expect(alloc.mock.calls.every(([size]) => size <= 64 * 1024)).toBe(true);
		expect(allocUnsafe.mock.calls.every(([size]) => size <= 64 * 1024)).toBe(true);
	});
});

describe("memory staged publication acknowledgments", () => {
	afterEach(() => vi.restoreAllMocks());
	it("returns a real memory snapshot without claiming or dispatching filesystem sync", () => {
		const storage = new MemorySessionStorage();
		const file = "/sessions/memory.jsonl";
		const writer = storage.openStagedWriter(file);
		writer.writeLine(Buffer.from("alpha"));
		writer.writeLine(Buffer.from("beta"));
		writer.patchLine(0, Buffer.from("ALPHA"));
		writer.patchLine(1, Buffer.from("different length"));
		writer.fsync();
		writer.closeSync();
		const sync = vi.spyOn(fs, "fsyncSync");
		const publish = vi.spyOn(native, "renameNoReplacePath");
		try {
			const receipt = writer.publishNoReplace();
			const snapshot = storage.readSnapshotSync(file);
			expect(receipt.kind).toBe("backend_ack");
			expect(receipt.namespaceSynced).toBe(false);
			expect(receipt.stat).toEqual(snapshot.stat);
			expect(Buffer.from(snapshot.bytes).toString()).toBe("ALPHA\ndifferent length\n");
			expect(receipt.sha256).toBe(hash(snapshot.bytes));
			expect(receipt.publicationId).toMatch(/^[0-9a-f-]{36}$/);
			expect(sync).not.toHaveBeenCalled();
			expect(publish).not.toHaveBeenCalled();
			const another = storage.openStagedWriter("/sessions/another.jsonl");
			another.writeLine(Buffer.from("alpha"));
			another.closeSync();
			expect(another.publishNoReplace().publicationId).not.toBe(receipt.publicationId);
			const conflict = storage.openStagedWriter(file);
			conflict.writeLine(Buffer.from("replacement"));
			conflict.closeSync();
			expect(() => conflict.publishNoReplace()).toThrow("destination_conflict");
			expect(storage.readSnapshotSync(file)).toEqual(snapshot);
		} finally {
			sync.mockRestore();
			publish.mockRestore();
		}
	});
});
