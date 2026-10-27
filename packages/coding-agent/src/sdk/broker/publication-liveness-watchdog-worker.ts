import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as nodeWorkerThreads from "node:worker_threads";
import {
	PUBLICATION_LIVENESS_INDEX_ACTIVE,
	PUBLICATION_LIVENESS_INDEX_CADENCE,
	PUBLICATION_LIVENESS_INDEX_GRACE,
	PUBLICATION_LIVENESS_INDEX_LOOP,
	PUBLICATION_LIVENESS_INDEX_PUBLISHED,
	PUBLICATION_LIVENESS_SLOT_COUNT,
	PUBLICATION_LIVENESS_SLOT_STRIDE,
	type PublicationLivenessSample,
	publicationLivenessMustExit,
} from "./publication-liveness-deadline";

const { parentPort, workerData } = nodeWorkerThreads;
if (!parentPort) throw new Error("publication liveness watchdog: missing parentPort");

const buffer = workerData?.buffer;
if (!(buffer instanceof SharedArrayBuffer)) {
	throw new Error("publication liveness watchdog: missing shared buffer");
}

const view = new BigInt64Array(buffer);
const port = parentPort;
const DIAGNOSTIC = "sdk broker: publication-liveness-timeout\n";
const F_GETFL = 3;
const F_SETFL = 4;

interface FcntlBinding {
	fcntl(fd: number, command: number, flags: number): number;
}

let fcntlBinding: FcntlBinding | undefined;

function libcAndNonblockFlag(): { library: string; nonblock: number } | undefined {
	if (process.platform === "linux") return { library: "libc.so.6", nonblock: 0o4000 };
	if (process.platform === "darwin") return { library: "libSystem.B.dylib", nonblock: 0x4 };
	return undefined;
}

function fcntl(): FcntlBinding | undefined {
	if (fcntlBinding) return fcntlBinding;
	const target = libcAndNonblockFlag();
	if (!target) return undefined;
	const opened = dlopen(target.library, {
		fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	});
	fcntlBinding = opened.symbols;
	return fcntlBinding;
}

/**
 * Best-effort stderr line. A full pipe must not block this worker: the SIGKILL
 * below is the liveness contract, and a blocking `writeSync` on fd 2 would
 * postpone it indefinitely. Platforms without `O_NONBLOCK` skip the line.
 */
function writeDiagnosticWithoutBlocking(): void {
	const target = libcAndNonblockFlag();
	if (!target) return;
	let binding: FcntlBinding | undefined;
	let previous: number | undefined;
	try {
		binding = fcntl();
		if (!binding) return;
		const current = binding.fcntl(2, F_GETFL, 0);
		if (current < 0) return;
		if ((current & target.nonblock) === 0) {
			if (binding.fcntl(2, F_SETFL, current | target.nonblock) < 0) return;
			previous = current;
		}
		fs.writeSync(2, DIAGNOSTIC);
	} catch {
		// EAGAIN, a missing libc, or a short write. Drop the line.
	} finally {
		if (binding && previous !== undefined) {
			try {
				binding.fcntl(2, F_SETFL, previous);
			} catch {
				// The process is about to be killed.
			}
		}
	}
}

function readSlot(slot: number, nowMs: bigint): PublicationLivenessSample {
	const base = slot * PUBLICATION_LIVENESS_SLOT_STRIDE;
	return {
		nowMs,
		publishedMs: Atomics.load(view, base + PUBLICATION_LIVENESS_INDEX_PUBLISHED),
		loopMs: Atomics.load(view, base + PUBLICATION_LIVENESS_INDEX_LOOP),
		graceMs: Atomics.load(view, base + PUBLICATION_LIVENESS_INDEX_GRACE),
		cadenceMs: Atomics.load(view, base + PUBLICATION_LIVENESS_INDEX_CADENCE),
		active: Atomics.load(view, base + PUBLICATION_LIVENESS_INDEX_ACTIVE),
	};
}

// Poll independent of the broker's JS thread. A stalled fsync/rename on that
// thread cannot delay this timer, which is the whole point of the worker.
setInterval(() => {
	const nowMs = BigInt(Math.floor(performance.now()));
	for (let slot = 0; slot < PUBLICATION_LIVENESS_SLOT_COUNT; slot += 1) {
		if (!publicationLivenessMustExit(readSlot(slot, nowMs))) continue;
		const confirmed = readSlot(slot, BigInt(Math.floor(performance.now())));
		if (!publicationLivenessMustExit(confirmed)) continue;
		writeDiagnosticWithoutBlocking();
		// Disarm is synchronous at the start of shutdown. Re-check after the
		// diagnostic write so that teardown wins over a kill already in progress.
		const stillDue = readSlot(slot, BigInt(Math.floor(performance.now())));
		if (!publicationLivenessMustExit(stillDue)) continue;
		process.kill(process.pid, "SIGKILL");
		return;
	}
}, 20);

port.postMessage({ type: "ready" });
