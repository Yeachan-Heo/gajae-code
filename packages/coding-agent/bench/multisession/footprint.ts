import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { observeProcessIncarnation, type ProcessIncarnationObservation } from "../../src/sdk/broker/process-incarnation";
import type { FootprintRead } from "./types";

const RUSAGE_INFO_V4_BYTES = 296;
const RUSAGE_INFO_V4_RSS_OFFSET = 64;
const RUSAGE_INFO_V4_PHYS_FOOTPRINT_OFFSET = 72;
const PROC_PIDRUSAGE_INFO_V4 = 4;

type ProcPointer = NodeJS.TypedArray | Pointer | bigint | null;
type ProcLibrary = {
	symbols: { proc_pid_rusage: (pid: number, flavor: number, buffer: ProcPointer) => number };
	close(): void;
};
type ProcessObservation = ProcessIncarnationObservation;

export interface FootprintDeps {
	observeProcessIncarnation?: (pid: number) => ProcessObservation;
	readRusage?: (pid: number) => RusageRead;
}

export interface RusageRead {
	rc: number;
	rss?: number;
	physFootprint?: number;
}

let procLibrary: ProcLibrary | undefined;
let procLibraryUnavailable = false;

function getProcLibrary(): ProcLibrary | undefined {
	if (procLibrary) return procLibrary;
	if (procLibraryUnavailable || process.platform !== "darwin") return undefined;
	try {
		procLibrary = dlopen("/usr/lib/libproc.dylib", {
			proc_pid_rusage: {
				args: [FFIType.i32, FFIType.i32, FFIType.ptr],
				returns: FFIType.i32,
			},
		});
		return procLibrary;
	} catch {
		procLibraryUnavailable = true;
		return undefined;
	}
}

function checkedNumber(value: bigint): number | undefined {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || BigInt(number) !== value) return undefined;
	return number;
}

/** Decode the stable rusage_info_v4 offsets (uuid plus 35 little-endian u64s). */
export function decodeRusageV4(view: DataView): { rss: bigint; physFootprint: bigint } {
	if (view.byteLength < RUSAGE_INFO_V4_BYTES) {
		throw new RangeError(`rusage_info_v4 must contain ${RUSAGE_INFO_V4_BYTES} bytes`);
	}
	return {
		rss: view.getBigUint64(RUSAGE_INFO_V4_RSS_OFFSET, true),
		physFootprint: view.getBigUint64(RUSAGE_INFO_V4_PHYS_FOOTPRINT_OFFSET, true),
	};
}

/** Read one proc_pid_rusage flavor-4 record. Nonzero rc values carry no measurements. */
export function readRusage(pid: number): RusageRead {
	const library = getProcLibrary();
	if (!library) return { rc: -1 };
	const bytes = new Uint8Array(RUSAGE_INFO_V4_BYTES);
	try {
		const rc = library.symbols.proc_pid_rusage(pid, PROC_PIDRUSAGE_INFO_V4, ptr(bytes));
		if (rc !== 0) return { rc };
		const decoded = decodeRusageV4(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
		const rss = checkedNumber(decoded.rss);
		const physFootprint = checkedNumber(decoded.physFootprint);
		if (rss === undefined || physFootprint === undefined) return { rc: -1 };
		return { rc: 0, rss, physFootprint };
	} catch {
		return { rc: -1 };
	}
}

/** Read process memory only when the same kernel incarnation brackets the native read. */
export function sampleProcess(pid: number, deps: FootprintDeps = {}): FootprintRead {
	const observe = deps.observeProcessIncarnation ?? observeProcessIncarnation;
	const read = deps.readRusage ?? readRusage;
	const before = observe(pid);
	if (before.status === "absent") return { status: "absent", pid };
	if (before.status === "unknown") {
		return { status: "unresolved", pid, reason: `incarnation-before-read:${before.reasonCode}` };
	}

	let usage: RusageRead;
	try {
		usage = read(pid);
	} catch {
		usage = { rc: -1 };
	}
	const after = observe(pid);
	if (after.status === "absent") return { status: "raced", pid, reason: "process-exited-during-read" };
	if (after.status === "unknown") {
		return { status: "unresolved", pid, reason: `incarnation-after-read:${after.reasonCode}` };
	}
	if (before.incarnation !== after.incarnation) {
		return { status: "raced", pid, reason: "process-incarnation-changed-during-read" };
	}
	if (
		usage.rc !== 0 ||
		usage.rss === undefined ||
		usage.physFootprint === undefined ||
		!Number.isSafeInteger(usage.rss) ||
		!Number.isSafeInteger(usage.physFootprint) ||
		usage.rss < 0 ||
		usage.physFootprint < 0
	) {
		return { status: "unresolved", pid, reason: `proc_pid_rusage-failed:${usage.rc}` };
	}
	return {
		status: "ok",
		pid,
		incarnation: before.incarnation,
		physFootprint: usage.physFootprint,
		rss: usage.rss,
	};
}

/** Release the module's retained libproc handle at collector teardown. */
export function closeFootprintSampler(): void {
	procLibrary?.close();
	procLibrary = undefined;
	procLibraryUnavailable = false;
}
