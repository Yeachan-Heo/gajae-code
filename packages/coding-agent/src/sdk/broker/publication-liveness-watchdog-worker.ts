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
		// Do not write diagnostics here: even a nonblocking descriptor can stall
		// on regular files or devices, preventing the liveness kill.
		process.kill(process.pid, "SIGKILL");
		return;
	}
}, 20);

port.postMessage({ type: "ready" });
