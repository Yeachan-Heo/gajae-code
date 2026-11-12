import * as fs from "node:fs";
import { isEnoent, peekFile } from "@gajae-code/utils";

const utf8Decoder = new TextDecoder("utf-8");

export interface SessionStorageStat {
	dev: bigint;
	ino: bigint;
	nlink?: bigint;
	size: number;
	mtimeMs: number;
	mtimeNs: bigint;
	ctimeNs: bigint;
	mtime: Date;
	isFile: boolean;
}

/** Exact bytes and identity captured from one opened regular-file descriptor. */
export interface SessionStorageSnapshot {
	bytes: Uint8Array;
	stat: SessionStorageStat;
}

/** Upper bound for one descriptor-validated recorded range read. */
export const SESSION_RANGE_READ_MAX_BYTES = 64 * 1024 * 1024;

/**
 * One bounded recorded-length read validated against a single opened descriptor.
 * `bytes` is exactly `length` bytes from `[start, start + length)` of the same
 * regular-file object; `stat` is the fresh post-read descriptor snapshot so the
 * caller can compare dev/ino/nlink against the pathname before committing an index.
 */
export interface SessionStorageRangeSnapshot {
	stat: SessionStorageStat;
	bytes: Uint8Array;
}

export function validateRangeReadBounds(start: number, length: number): void {
	if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0)
		throw new RangeError("Invalid session range read bounds");
	if (start > Number.MAX_SAFE_INTEGER - length) throw new RangeError("Session range read start overflows");
	if (length > SESSION_RANGE_READ_MAX_BYTES) throw new RangeError("Session range read exceeds the bounded maximum");
}

export function statFromNode(stats: fs.BigIntStats): SessionStorageStat {
	return {
		dev: stats.dev,
		ino: stats.ino,
		nlink: stats.nlink,
		size: Number(stats.size),
		mtimeMs: Number(stats.mtimeMs),
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
		mtime: stats.mtime,
		isFile: stats.isFile(),
	};
}

/** Read capabilities shared by metadata readers and Native storage backends. */
export interface SessionStorageReader {
	existsSync(path: string): boolean;
	readTextSync(path: string): string;
	/** Exact on-disk bytes for strict read-only session inspection. */
	readBytesSync?(path: string): Uint8Array;
	/** Exact bytes and descriptor-bound identity captured from one opened regular file. */
	readSnapshotSync?(path: string): SessionStorageSnapshot;
	statSync(path: string): SessionStorageStat;
	exists(path: string): Promise<boolean>;
	readText(path: string): Promise<string>;
	readTextPrefix(path: string, maxBytes: number): Promise<string>;
	/** Bounded recorded-length read with descriptor identity validation. */
	readRangeSync?(path: string, start: number, length: number): SessionStorageRangeSnapshot;
	/** Async bounded recorded-length read with descriptor identity validation. */
	readRange?(path: string, start: number, length: number): Promise<SessionStorageRangeSnapshot>;
}

/** Filesystem reader with no writer, lock, repair, publication or deletion capability. */
export class FileSessionReader implements SessionStorageReader {
	existsSync(path: string): boolean {
		return fs.existsSync(path);
	}

	readTextSync(fpath: string): string {
		return fs.readFileSync(fpath, "utf-8");
	}

	readBytesSync(fpath: string): Uint8Array {
		return this.readSnapshotSync(fpath).bytes;
	}

	readSnapshotSync(fpath: string): SessionStorageSnapshot {
		const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);
		const fd = fs.openSync(fpath, flags);
		try {
			const stat = statFromNode(fs.fstatSync(fd, { bigint: true }));
			if (!stat.isFile) throw new Error(`Not a regular file: ${fpath}`);
			return { bytes: fs.readFileSync(fd), stat };
		} finally {
			fs.closeSync(fd);
		}
	}

	/**
	 * Bounded recorded-length read with descriptor identity validation: opens one
	 * no-follow descriptor, verifies the requested range is fully present, reads
	 * exactly `length` bytes, and revalidates dev/ino/nlink on the same descriptor
	 * plus the pathname (append-only size growth is tolerated; an object swap is
	 * rejected). No path-based Bun Blob reads for managed authority.
	 */
	readRangeSync(fpath: string, start: number, length: number): SessionStorageRangeSnapshot {
		validateRangeReadBounds(start, length);
		const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);
		const fd = fs.openSync(fpath, flags);
		try {
			const before = fs.fstatSync(fd, { bigint: true });
			if (!before.isFile() || before.nlink > 1) throw new Error("source_changed");
			if (Number(before.size) < start + length) throw new Error("range_not_present");
			const bytes = Buffer.alloc(length);
			let offset = 0;
			while (offset < length) {
				const count = fs.readSync(fd, bytes, offset, length - offset, start + offset);
				if (count === 0) throw new Error("range_not_present");
				offset += count;
			}
			const after = fs.fstatSync(fd, { bigint: true });
			if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink)
				throw new Error("source_changed");
			const named = fs.lstatSync(fpath, { bigint: true });
			if (!named.isFile() || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino)
				throw new Error("source_changed");
			return { bytes, stat: statFromNode(after) };
		} finally {
			fs.closeSync(fd);
		}
	}

	async readRange(fpath: string, start: number, length: number): Promise<SessionStorageRangeSnapshot> {
		validateRangeReadBounds(start, length);
		const handle = await fs.promises.open(fpath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		try {
			const before = await handle.stat({ bigint: true });
			if (!before.isFile() || before.nlink > 1) throw new Error("source_changed");
			if (Number(before.size) < start + length) throw new Error("range_not_present");
			const bytes = Buffer.alloc(length);
			let offset = 0;
			while (offset < length) {
				const { bytesRead } = await handle.read(bytes, offset, length - offset, start + offset);
				if (bytesRead === 0) throw new Error("range_not_present");
				offset += bytesRead;
			}
			const after = await handle.stat({ bigint: true });
			if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink)
				throw new Error("source_changed");
			const named = fs.lstatSync(fpath, { bigint: true });
			if (!named.isFile() || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino)
				throw new Error("source_changed");
			return { bytes, stat: statFromNode(after) };
		} finally {
			await handle.close();
		}
	}

	statSync(path: string): SessionStorageStat {
		return statFromNode(fs.statSync(path, { bigint: true }));
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fs.promises.access(path);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	readText(path: string): Promise<string> {
		return Bun.file(path).text();
	}

	async readTextPrefix(path: string, maxBytes: number): Promise<string> {
		return peekFile(path, maxBytes, header => utf8Decoder.decode(header));
	}
}
