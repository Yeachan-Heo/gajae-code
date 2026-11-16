import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage, type SessionDurabilityRepairRange } from "../../src/session/session-storage";

const hash = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");

describe("fresh-handle byte-identical durability repair", () => {
	let directory: string;
	let file: string;
	let bytes: Buffer<ArrayBuffer>;
	const storage = new FileSessionStorage();
	beforeEach(async () => {
		directory = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-durability-repair-"));
		file = path.join(directory, "session.jsonl");
		bytes = Buffer.from(`${"a".repeat(100_000)}\n${"b".repeat(100_000)}\n`);
		await Bun.write(file, bytes);
		await fsp.chmod(file, 0o600);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(directory, { recursive: true, force: true });
	});
	const ranges = (data: Uint8Array): SessionDurabilityRepairRange[] => [
		{ offset: 0, length: 100_001, sha256: hash(data.subarray(0, 100_001)) },
		{ offset: 100_001, length: 100_001, sha256: hash(data.subarray(100_001)) },
	];

	it("re-dirties recorded offsets with a fresh non-append descriptor, then syncs file and namespace", async () => {
		const expected = storage.readSnapshotSync(file);
		const open = vi.spyOn(fs, "openSync");
		const write = vi.spyOn(fs, "writeSync");
		const numericWriteCalls: unknown[][] = write.mock.calls;
		const sync = vi.spyOn(fs, "fsyncSync");
		const receipt = storage.repairDurabilitySync(file, { stat: expected.stat, sha256: hash(bytes) }, ranges(bytes));
		expect(open.mock.calls[0]?.[1]).toBe(
			fs.constants.O_RDWR | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
		);
		expect(numericWriteCalls.map(call => call[4])).toEqual([0, 65_536, 100_001, 165_537]);
		expect(sync).toHaveBeenCalledTimes(2);
		expect(receipt.namespaceSynced).toBe(true);
		expect(receipt.stat.ino).toBe(expected.stat.ino);
		expect(receipt.stat.dev).toBe(expected.stat.dev);
		expect(receipt.stat.size).toBe(bytes.length);
		expect(receipt.sha256).toBe(hash(bytes));
		expect(receipt.ranges).toEqual(ranges(bytes));
		expect(Buffer.from(await Bun.file(file).arrayBuffer())).toEqual(bytes);
	});

	it("readable bytes after a failed sync are not a receipt; a new handle re-dirties them before retry", async () => {
		const expected = storage.readSnapshotSync(file);
		const expectation = { stat: expected.stat, sha256: hash(bytes) };
		const open = vi.spyOn(fs, "openSync");
		const write = vi.spyOn(fs, "writeSync");
		const numericWriteCalls: unknown[][] = write.mock.calls;
		const sync = vi.spyOn(fs, "fsyncSync");
		sync.mockImplementationOnce(() => {
			throw new Error("injected sync failure");
		});
		expect(() => storage.repairDurabilitySync(file, expectation, ranges(bytes))).toThrow("injected sync failure");
		expect(Buffer.from(await Bun.file(file).arrayBuffer())).toEqual(bytes);
		const receipt = storage.repairDurabilitySync(file, expectation, ranges(bytes));
		expect(open.mock.calls.filter(call => call[0] === file)).toHaveLength(2);
		expect(numericWriteCalls.map(call => call[4])).toEqual([
			0, 65_536, 100_001, 165_537, 0, 65_536, 100_001, 165_537,
		]);
		expect(receipt.stat.ino).toBe(expected.stat.ino);
		expect(receipt.sha256).toBe(expectation.sha256);
		expect(Buffer.from(await Bun.file(file).arrayBuffer())).toEqual(bytes);
	});

	it("validates every range and the full snapshot before any write", () => {
		const expected = { stat: storage.statSync(file), sha256: hash(bytes) };
		const write = vi.spyOn(fs, "writeSync");
		const invalid = ranges(bytes);
		invalid[1] = { ...invalid[1]!, sha256: "0".repeat(64) };
		expect(() => storage.repairDurabilitySync(file, expected, invalid)).toThrow("source_changed");
		expect(() => storage.repairDurabilitySync(file, { ...expected, sha256: "0".repeat(64) }, ranges(bytes))).toThrow(
			"source_changed",
		);
		expect(() => storage.repairDurabilitySync(file, expected, [ranges(bytes)[1]!, ranges(bytes)[0]!])).toThrow(
			"durability_repair_invalid_range",
		);
		expect(write).not.toHaveBeenCalled();
	});

	it("refuses a replaced inode, a hard link, and a no-follow symlink without writes", async () => {
		const expected = { stat: storage.statSync(file), sha256: hash(bytes) };
		const old = path.join(directory, "old.jsonl");
		await fsp.rename(file, old);
		await Bun.write(file, bytes);
		await fsp.chmod(file, 0o600);
		const write = vi.spyOn(fs, "writeSync");
		expect(() => storage.repairDurabilitySync(file, expected, ranges(bytes))).toThrow("source_changed");
		const current = { stat: storage.statSync(file), sha256: hash(bytes) };
		await fsp.link(file, path.join(directory, "link.jsonl"));
		expect(() => storage.repairDurabilitySync(file, current, ranges(bytes))).toThrow("source_changed");
		const symlink = path.join(directory, "symlink.jsonl");
		await fsp.symlink(old, symlink);
		expect(() => storage.repairDurabilitySync(symlink, expected, ranges(bytes))).toThrow();
		expect(write).not.toHaveBeenCalled();
	});

	it("a namespace-sync failure never produces a positive receipt", () => {
		const expected = { stat: storage.statSync(file), sha256: hash(bytes) };
		const sync = fs.fsyncSync;
		let calls = 0;
		vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
			if (++calls === 2) throw new Error("injected namespace sync failure");
			sync(fd);
		});
		expect(() => storage.repairDurabilitySync(file, expected, ranges(bytes))).toThrow(
			"injected namespace sync failure",
		);
		expect(calls).toBe(2);
		expect(storage.readBytesSync(file)).toEqual(bytes);
	});
});
