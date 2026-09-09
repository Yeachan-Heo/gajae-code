import type { Stats } from "node:fs";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NativeExactFileIdentity } from "@gajae-code/natives";

export const DOCTOR_FILE_LIMIT = 1024 * 1024;

export interface DoctorFileIdentity {
	readonly device: number;
	readonly inode: number;
	readonly size: number;
	readonly modifiedMs: number;
	readonly changedMs: number;
	readonly mode: number;
	readonly owner: number;
	readonly links: number;
}

export type DoctorFileObservation =
	| {
			readonly status: "read";
			readonly text: string;
			readonly identity: DoctorFileIdentity;
			/** Private commit authority, never serialized into the public diagnostic report. */
			readonly exactIdentity: NativeExactFileIdentity;
	  }
	| {
			readonly status: "missing" | "unreadable" | "symlink" | "not_regular" | "limit_exceeded" | "changed";
			readonly errno?: string;
	  };

const SAFE_ERRNOS = new Set([
	"ENOENT",
	"EACCES",
	"EPERM",
	"EISDIR",
	"ENOTDIR",
	"ELOOP",
	"EMFILE",
	"ENFILE",
	"EIO",
	"ESTALE",
	"EINVAL",
	"ENOSPC",
	"EROFS",
	"EBUSY",
]);

export function doctorErrno(error: unknown): string {
	if (typeof error !== "object" || error === null || !("code" in error)) return "unknown_io_error";
	return typeof error.code === "string" && SAFE_ERRNOS.has(error.code) ? error.code : "unknown_io_error";
}

function identity(stat: Stats): DoctorFileIdentity {
	return {
		device: stat.dev,
		inode: stat.ino,
		size: stat.size,
		modifiedMs: stat.mtimeMs,
		changedMs: stat.ctimeMs,
		mode: stat.mode,
		owner: stat.uid,
		links: stat.nlink,
	};
}

export function sameDoctorFile(left: DoctorFileIdentity, right: DoctorFileIdentity): boolean {
	return (
		left.device === right.device &&
		left.inode === right.inode &&
		left.size === right.size &&
		left.modifiedMs === right.modifiedMs &&
		left.changedMs === right.changedMs &&
		left.mode === right.mode &&
		left.owner === right.owner &&
		left.links === right.links
	);
}

/** Read one bounded regular file; absence is never inferred from access failure. */
export async function readDoctorFile(filePath: string, limit = DOCTOR_FILE_LIMIT): Promise<DoctorFileObservation> {
	let handle: fs.FileHandle | undefined;
	try {
		const before = await fs.lstat(filePath);
		if (before.isSymbolicLink()) return { status: "symlink" };
		if (!before.isFile()) return { status: "not_regular" };
		if (before.size > limit) return { status: "limit_exceeded" };
		handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = await handle.stat();
		const openedExact = await handle.stat({ bigint: true });
		const parent = await fs.lstat(path.dirname(filePath), { bigint: true });
		if (parent.isSymbolicLink() || !parent.isDirectory()) return { status: "symlink" };
		if (!opened.isFile() || !sameDoctorFile(identity(before), identity(opened))) return { status: "changed" };
		// Read at most one byte past the bound, including when a concurrent writer grows the file.
		const bytes = new Uint8Array(limit + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await handle.read(bytes, length, bytes.length - length, length);
			if (result.bytesRead === 0) break;
			length += result.bytesRead;
		}
		if (length > limit) return { status: "limit_exceeded" };
		const after = await handle.stat();
		const afterExact = await handle.stat({ bigint: true });
		const lexical = await fs.lstat(filePath);
		const parentAfter = await fs.lstat(path.dirname(filePath), { bigint: true });
		if (
			lexical.isSymbolicLink() ||
			parentAfter.isSymbolicLink() ||
			parent.dev !== parentAfter.dev ||
			parent.ino !== parentAfter.ino ||
			openedExact.dev !== afterExact.dev ||
			openedExact.ino !== afterExact.ino ||
			openedExact.mtimeNs !== afterExact.mtimeNs ||
			openedExact.ctimeNs !== afterExact.ctimeNs ||
			!sameDoctorFile(identity(opened), identity(after)) ||
			!sameDoctorFile(identity(after), identity(lexical))
		)
			return { status: "changed" };
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
		return {
			status: "read",
			text,
			identity: identity(after),
			exactIdentity: {
				dev: afterExact.dev,
				ino: afterExact.ino,
				nlink: afterExact.nlink,
				size: afterExact.size,
				mtimeNs: afterExact.mtimeNs,
				parentDev: parent.dev,
				parentIno: parent.ino,
				sha256: new Bun.CryptoHasher("sha256").update(bytes.subarray(0, length)).digest("hex"),
			},
		};
	} catch (error) {
		const errno = doctorErrno(error);
		return { status: errno === "ENOENT" ? "missing" : "unreadable", errno };
	} finally {
		await handle?.close();
	}
}

export function doctorMapping(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
