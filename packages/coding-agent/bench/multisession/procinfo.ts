import { dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";
import type { ProcessEnvRead } from "./types";

const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;
const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_BYTES = 136;
const PROC_BSDINFO_PPID_OFFSET = 16;
const PROC_BSDINFO_UID_OFFSET = 20;
const PROC_BSDINFO_START_SECONDS_OFFSET = 120;
const PROC_BSDINFO_START_MICROSECONDS_OFFSET = 128;
const MAX_PID_LIST_RETRIES = 3;

type ProcPointer = NodeJS.TypedArray | Pointer | bigint | null;

type ProcLibrary = {
	symbols: {
		proc_listallpids: (buffer: ProcPointer, bufferBytes: number) => number;
		proc_pidinfo: (pid: number, flavor: number, arg: number | bigint, buffer: ProcPointer, bufferBytes: number) => number;
	};
	close(): void;
};

type SystemLibrary = {
	symbols: {
		sysctl: (
			name: ProcPointer,
			nameLength: number,
			oldValue: ProcPointer,
			oldLength: ProcPointer,
			newValue: ProcPointer,
			newLength: number | bigint,
		) => number;
		__error: () => Pointer | bigint | null;
	};
	close(): void;
};

let procLibrary: ProcLibrary | undefined;
let systemLibrary: SystemLibrary | undefined;
let cachedArgmax: number | undefined;
let procArgsBuffer: Uint8Array | undefined;
let procArgsLength: BigUint64Array | undefined;
const bsdInfoBuffer = new Uint8Array(PROC_BSDINFO_BYTES);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function getProcLibrary(): ProcLibrary | undefined {
	if (procLibrary) return procLibrary;
	if (process.platform !== "darwin") return undefined;
	try {
		procLibrary = dlopen("/usr/lib/libproc.dylib", {
			proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			proc_pidinfo: {
				args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
		});
		return procLibrary;
	} catch {
		return undefined;
	}
}

function getSystemLibrary(): SystemLibrary | undefined {
	if (systemLibrary) return systemLibrary;
	if (process.platform !== "darwin") return undefined;
	try {
		systemLibrary = dlopen("/usr/lib/libSystem.B.dylib", {
			sysctl: {
				args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
				returns: FFIType.i32,
			},
			__error: { args: [], returns: FFIType.ptr },
		});
		return systemLibrary;
	} catch {
		return undefined;
	}
}

function currentErrno(library: SystemLibrary): number {
	try {
		const errnoPointer = library.symbols.__error();
		return errnoPointer ? read.i32(errnoPointer) : -1;
	} catch {
		return -1;
	}
}

function readBsdInfo(pid: number): Uint8Array | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return undefined;
	const library = getProcLibrary();
	if (!library) return undefined;
	try {
		const bytes = library.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(bsdInfoBuffer), bsdInfoBuffer.byteLength);
		return bytes === PROC_BSDINFO_BYTES ? bsdInfoBuffer : undefined;
	} catch {
		return undefined;
	}
}

/** List the current process table. A failed native query throws rather than looking like an empty host. */
export function listAllPids(): number[] {
	const library = getProcLibrary();
	if (!library) throw new Error("libproc is unavailable for process enumeration");
	let count = 0;
	try {
		count = library.symbols.proc_listallpids(null, 0);
	} catch {
		throw new Error("proc_listallpids failed to size the process table");
	}
	if (count <= 0) throw new Error("proc_listallpids returned no process-table capacity");

	for (let attempt = 0; attempt < MAX_PID_LIST_RETRIES; attempt++) {
		const pids = new Int32Array(Math.max(64, count + 32));
		let listed: number;
		try {
			listed = library.symbols.proc_listallpids(ptr(pids), pids.byteLength);
		} catch {
			throw new Error("proc_listallpids failed to read the process table");
		}
		if (listed <= 0) throw new Error("proc_listallpids returned an empty process table");
		if (listed > pids.length) {
			count = listed;
			continue;
		}
		return Array.from(pids.subarray(0, listed)).filter(pid => pid > 0);
	}
	throw new Error("proc_listallpids process table changed during every bounded read");
}

function decodeUtf8(bytes: Uint8Array, start: number, end: number): string | undefined {
	try {
		return utf8Decoder.decode(bytes.subarray(start, end));
	} catch {
		return undefined;
	}
}

function findNull(bytes: Uint8Array, start: number): number {
	for (let index = start; index < bytes.byteLength; index++) {
		if (bytes[index] === 0) return index;
	}
	return -1;
}


/** Decode the KERN_PROCARGS2 byte layout without treating a truncated result as complete. */
export function decodeProcArgs2(bytes: Uint8Array, argmax: number): ProcessEnvRead {
	if (!Number.isSafeInteger(argmax) || argmax < 4) return { status: "malformed", reason: "invalid-argmax" };
	if (bytes.byteLength >= argmax) return { status: "truncated", reason: "returned-length-reached-argmax" };
	if (bytes.byteLength < 4) return { status: "truncated", reason: "missing-argc" };

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const argc = view.getInt32(0, true);
	if (argc < 1 || argc > 100_000) return { status: "malformed", reason: "invalid-argc" };

	const pathEnd = findNull(bytes, 4);
	if (pathEnd < 0) return { status: "truncated", reason: "unterminated-executable-path" };
	if (pathEnd === 4) return { status: "malformed", reason: "empty-executable-path" };
	if (decodeUtf8(bytes, 4, pathEnd) === undefined) return { status: "malformed", reason: "invalid-executable-path-utf8" };

	let cursor = pathEnd + 1;
	while (cursor < bytes.byteLength && bytes[cursor] === 0) cursor++;
	if (cursor === bytes.byteLength) return { status: "truncated", reason: "missing-argv" };

	const argv: string[] = [];
	for (let index = 0; index < argc; index++) {
		const end = findNull(bytes, cursor);
		if (end < 0) return { status: "truncated", reason: `unterminated-argv-${index}` };
		const value = decodeUtf8(bytes, cursor, end);
		if (value === undefined) return { status: "malformed", reason: `invalid-argv-${index}-utf8` };
		argv.push(value);
		cursor = end + 1;
	}

	while (cursor < bytes.byteLength && bytes[cursor] === 0) cursor++;
	if (cursor === bytes.byteLength) return { status: "argv-only", argv };

	const env: Record<string, string> = Object.create(null) as Record<string, string>;
	let envCount = 0;
	while (cursor < bytes.byteLength) {
		const end = findNull(bytes, cursor);
		if (end < 0) return { status: "truncated", reason: "unterminated-environment-entry" };
		if (end === cursor) {
			if (envCount === 0) return { status: "argv-only", argv };
			return { status: "complete", argv, env };
		}
		const entry = decodeUtf8(bytes, cursor, end);
		if (entry === undefined) return { status: "malformed", reason: "invalid-environment-utf8" };
		const equals = entry.indexOf("=");
		if (equals <= 0) return { status: "malformed", reason: "invalid-environment-entry" };
		env[entry.slice(0, equals)] = entry.slice(equals + 1);
		envCount++;
		cursor = end + 1;
	}
	return envCount > 0 ? { status: "complete", argv, env } : { status: "argv-only", argv };
}

function readKernelInteger(mibKey: number): { value?: number; errno?: number } {
	const library = getSystemLibrary();
	if (!library) return { errno: -1 };
	const mib = new Int32Array([CTL_KERN, mibKey]);
	const buffer = new Uint8Array(4);
	const oldLength = new BigUint64Array([4n]);
	try {
		const result = library.symbols.sysctl(ptr(mib), mib.length, ptr(buffer), ptr(oldLength), null, 0);
		if (result !== 0) return { errno: currentErrno(library) };
		if (oldLength[0] !== 4n) return { errno: -1 };
		return { value: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getInt32(0, true) };
	} catch {
		return { errno: currentErrno(library) };
	}
}

/** Read argv and environment visibility via CTL_KERN/KERN_PROCARGS2. */
export function readProcessEnv(pid: number): ProcessEnvRead {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return { status: "failed", errno: 22 };
	const system = getSystemLibrary();
	if (!system) return { status: "failed", errno: -1 };
	const argmaxResult = cachedArgmax === undefined ? readKernelInteger(KERN_ARGMAX) : { value: cachedArgmax };
	if (argmaxResult.value === undefined) return { status: "failed", errno: argmaxResult.errno ?? -1 };
	const argmax = argmaxResult.value;
	if (!Number.isSafeInteger(argmax) || argmax < 4) return { status: "failed", errno: -1 };
	cachedArgmax = argmax;

	let bytes = procArgsBuffer;
	if (!bytes || bytes.byteLength !== argmax) bytes = new Uint8Array(argmax);
	procArgsBuffer = bytes;
	const oldLength = procArgsLength ?? new BigUint64Array(1);
	procArgsLength = oldLength;
	oldLength[0] = BigInt(argmax);
	const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
	let result: number;
	try {
		result = system.symbols.sysctl(ptr(mib), mib.length, ptr(bytes), ptr(oldLength), null, 0);
	} catch {
		return { status: "failed", errno: currentErrno(system) };
	}
	if (result !== 0) return { status: "failed", errno: currentErrno(system) };
	const returnedLength = Number(oldLength[0]);
	if (!Number.isSafeInteger(returnedLength) || returnedLength < 0 || returnedLength > bytes.byteLength) {
		return { status: "truncated", reason: "invalid-sysctl-returned-length" };
	}
	return decodeProcArgs2(bytes.subarray(0, returnedLength), argmax);
}

/** Process start wall time from the SDK proc_bsdinfo layout (136 bytes). */
export function processStartTimeMs(pid: number): number | null {
	const info = readBsdInfo(pid);
	if (!info) return null;
	try {
		const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
		const seconds = view.getBigUint64(PROC_BSDINFO_START_SECONDS_OFFSET, true);
		const microseconds = view.getBigUint64(PROC_BSDINFO_START_MICROSECONDS_OFFSET, true);
		if (seconds === 0n || microseconds >= 1_000_000n) return null;
		const millis = seconds * 1_000n + microseconds / 1_000n;
		const number = Number(millis);
		return Number.isSafeInteger(number) && BigInt(number) === millis ? number : null;
	} catch {
		return null;
	}
}

/** Parent PID from pbi_ppid; null means the kernel record could not be read. */
export function parentPid(pid: number): number | null {
	const info = readBsdInfo(pid);
	if (!info) return null;
	const parent = new DataView(info.buffer, info.byteOffset, info.byteLength).getUint32(PROC_BSDINFO_PPID_OFFSET, true);
	return parent;
}

/** PROC_PIDUNIQIDENTIFIERINFO: struct proc_uniqidentifierinfo (uuid[16], p_uniqueid, p_puniqueid, reserved[4]). */
const PROC_PIDUNIQIDENTIFIERINFO = 17;
const PROC_UNIQIDENTIFIERINFO_BYTES = 56;
const uniqueIdentityBuffer = new Uint8Array(PROC_UNIQIDENTIFIERINFO_BYTES);

/**
 * Kernel unique ids for `pid` and its ORIGINAL parent. `p_puniqueid` is fixed
 * at fork and survives reparenting, so it identifies who spawned a process
 * even after that parent exited. Null when the record cannot be read.
 */
export function processUniqueIdentity(pid: number): { uniqueId: bigint; parentUniqueId: bigint } | null {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return null;
	const library = getProcLibrary();
	if (!library) return null;
	try {
		const bytes = library.symbols.proc_pidinfo(
			pid,
			PROC_PIDUNIQIDENTIFIERINFO,
			0,
			ptr(uniqueIdentityBuffer),
			uniqueIdentityBuffer.byteLength,
		);
		if (bytes !== PROC_UNIQIDENTIFIERINFO_BYTES) return null;
		const view = new DataView(uniqueIdentityBuffer.buffer, uniqueIdentityBuffer.byteOffset, uniqueIdentityBuffer.byteLength);
		return { uniqueId: view.getBigUint64(16, true), parentUniqueId: view.getBigUint64(24, true) };
	} catch {
		return null;
	}
}

/** Effective uid from pbi_uid, used to scope process-table ownership scans. */
export function processUid(pid: number): number | null {
	const info = readBsdInfo(pid);
	if (!info) return null;
	return new DataView(info.buffer, info.byteOffset, info.byteLength).getUint32(PROC_BSDINFO_UID_OFFSET, true);
}

/** Release the retained libproc/libSystem handles when the cohort collector closes. */
export function closeProcessInfo(): void {
	const proc = procLibrary;
	const system = systemLibrary;
	procLibrary = undefined;
	systemLibrary = undefined;
	cachedArgmax = undefined;
	procArgsBuffer = undefined;
	procArgsLength = undefined;
	proc?.close();
	system?.close();
}
