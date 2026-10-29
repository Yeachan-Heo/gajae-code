import { isEmbeddedCompiledModule } from "@gajae-code/utils/env";
import {
	PUBLICATION_LIVENESS_ACTIVE,
	PUBLICATION_LIVENESS_CLAIMING,
	PUBLICATION_LIVENESS_INDEX_ACTIVE,
	PUBLICATION_LIVENESS_INDEX_CADENCE,
	PUBLICATION_LIVENESS_INDEX_GRACE,
	PUBLICATION_LIVENESS_INDEX_LOOP,
	PUBLICATION_LIVENESS_INDEX_PUBLISHED,
	PUBLICATION_LIVENESS_SLOT_COUNT,
	PUBLICATION_LIVENESS_SLOT_STRIDE,
	publicationLivenessHardExitEnabled,
} from "./publication-liveness-deadline";

const slots = new WeakMap<object, number>();
let shared: SharedArrayBuffer | undefined;
let view: BigInt64Array | undefined;
let workerReady: Promise<void> | undefined;
let liveWorker: Worker | undefined;
let workerIsLive = false;
let workerGeneration = 0;
let failedWorkerGeneration = 0;
let workerStartFailureForTest: Error | undefined;
let slotExhaustedForTest = false;

/** Test-only. The next hard-exit arm rejects before it spawns a worker. */
export function setPublicationLivenessWorkerStartFailureForTest(error: Error | undefined): void {
	workerStartFailureForTest = error;
}

/** Test-only. The next hard-exit arm rejects as if every watchdog slot were taken. */
export function setPublicationLivenessSlotExhaustedForTest(exhausted: boolean): void {
	slotExhaustedForTest = exhausted;
}

function watchdogUnavailable(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`sdk broker: publication liveness watchdog unavailable: ${message}`, {
		cause: error,
	});
}

function noteLiveWatchdogLost(worker: Worker): void {
	if (!workerIsLive || liveWorker !== worker) return;
	workerIsLive = false;
	liveWorker = undefined;
	workerReady = undefined;
	failedWorkerGeneration = workerGeneration;
}

/**
 * The live worker has gone away. Armed brokers must leave through the liveness
 * path; a replacement `arm` may start a new worker and clear this.
 */
export function publicationLivenessWatchdogLost(): boolean {
	return publicationLivenessHardExitEnabled() && workerGeneration > 0 && failedWorkerGeneration === workerGeneration;
}

/** Test-only. Stops the live watchdog worker so its close/exit path records the loss. */
export function terminatePublicationLivenessWatchdogForTest(): void {
	liveWorker?.terminate();
}

function nowMs(): bigint {
	return BigInt(Math.floor(performance.now()));
}

function asMs(value: number): bigint {
	if (!Number.isFinite(value) || value <= 0) return 0n;
	return BigInt(Math.floor(value));
}

function sharedView(): BigInt64Array {
	if (!view || !shared) {
		shared = new SharedArrayBuffer(
			PUBLICATION_LIVENESS_SLOT_COUNT * PUBLICATION_LIVENESS_SLOT_STRIDE * BigInt64Array.BYTES_PER_ELEMENT,
		);
		view = new BigInt64Array(shared);
	}
	return view;
}

/** DOM `WorkerOptions` has no `workerData`; Bun still honors the Node field at runtime. */
interface PublicationLivenessWorkerOptions extends WorkerOptions {
	workerData: { buffer: SharedArrayBuffer };
}

function watchdogWorkerOptions(buffer: SharedArrayBuffer): PublicationLivenessWorkerOptions {
	return { type: "module", workerData: { buffer } };
}

function sharedBuffer(): SharedArrayBuffer {
	const buffer = sharedView().buffer;
	if (!(buffer instanceof SharedArrayBuffer)) {
		throw new Error("publication liveness watchdog buffer is not shared");
	}
	return buffer;
}

function ensureWorker(): Promise<void> {
	if (workerReady) return workerReady;
	const buffer = sharedBuffer();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	workerReady = promise;
	let worker: Worker;
	try {
		// Literal paths must match packages/coding-agent/scripts/compile-args.ts.
		// The relative literal is only for a module Bun embedded in the binary.
		// Source mode always uses this file's URL, never the project cwd.
		const options = watchdogWorkerOptions(buffer);
		worker = isEmbeddedCompiledModule()
			? new Worker("./packages/coding-agent/src/sdk/broker/publication-liveness-watchdog-worker.ts", options)
			: new Worker(new URL("./publication-liveness-watchdog-worker.ts", import.meta.url).href, options);
	} catch (error) {
		workerReady = undefined;
		reject(error instanceof Error ? error : new Error(String(error)));
		return promise;
	}
	(worker as Worker & { unref?: () => void }).unref?.();
	let settled = false;
	const finish = (error?: Error): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (error) {
			// A timed-out worker must not stay alive. The next arm would spawn
			// another one against the same slots, and this one could still SIGKILL.
			workerIsLive = false;
			workerReady = undefined;
			worker.terminate();
			reject(error);
			return;
		}
		workerGeneration += 1;
		workerIsLive = true;
		liveWorker = worker;
		resolve();
	};
	const timer = setTimeout(() => finish(new Error("publication liveness watchdog did not start")), 5_000);
	timer.unref?.();
	const failBeforeReady = (message: string): void => {
		finish(new Error(message));
	};
	worker.addEventListener("message", event => {
		const data = (event as MessageEvent<{ type?: string }>).data;
		if (data?.type === "ready") finish();
	});
	worker.addEventListener("error", event => {
		const message = "message" in event && typeof event.message === "string" ? event.message : "worker error";
		if (!settled) {
			failBeforeReady(`publication liveness watchdog failed: ${message}`);
			return;
		}
		noteLiveWatchdogLost(worker);
	});
	const onGone: EventListener = () => {
		if (!settled) {
			failBeforeReady("publication liveness watchdog closed before ready");
			return;
		}
		noteLiveWatchdogLost(worker);
	};
	worker.addEventListener("close", onGone);
	worker.addEventListener("exit", onGone);
	return promise;
}

function claimSlot(table: BigInt64Array): number | undefined {
	for (let slot = 0; slot < PUBLICATION_LIVENESS_SLOT_COUNT; slot += 1) {
		const activeIndex = slot * PUBLICATION_LIVENESS_SLOT_STRIDE + PUBLICATION_LIVENESS_INDEX_ACTIVE;
		if (Atomics.compareExchange(table, activeIndex, 0n, PUBLICATION_LIVENESS_CLAIMING) === 0n) return slot;
	}
	return undefined;
}

function publishSlot(
	table: BigInt64Array,
	slot: number,
	publishedMs: bigint,
	loopMs: bigint,
	graceMs: bigint,
	cadenceMs: bigint,
): void {
	const base = slot * PUBLICATION_LIVENESS_SLOT_STRIDE;
	Atomics.store(table, base + PUBLICATION_LIVENESS_INDEX_PUBLISHED, publishedMs);
	Atomics.store(table, base + PUBLICATION_LIVENESS_INDEX_LOOP, loopMs);
	Atomics.store(table, base + PUBLICATION_LIVENESS_INDEX_GRACE, graceMs);
	Atomics.store(table, base + PUBLICATION_LIVENESS_INDEX_CADENCE, cadenceMs);
	Atomics.store(table, base + PUBLICATION_LIVENESS_INDEX_ACTIVE, PUBLICATION_LIVENESS_ACTIVE);
}

function slotOf(owner: object): number | undefined {
	if (!publicationLivenessHardExitEnabled() || !view) return undefined;
	return slots.get(owner);
}

/**
 * Arm one broker's off-thread liveness deadline.
 * Returns false when hard-exit protection is disabled (the test runner, or
 * `GJC_BROKER_LIVENESS_HARD_EXIT=0`); that path never spawns a worker.
 * When protection is enabled, a full slot table or a worker that does not
 * become ready rejects. Callers must not report startup success in that case.
 */
export async function armPublicationLivenessWatchdog(
	owner: object,
	graceMs: number,
	cadenceMs: number,
): Promise<boolean> {
	if (!publicationLivenessHardExitEnabled()) return false;
	const table = sharedView();
	let slot = slots.get(owner);
	if (slot === undefined) {
		slot = slotExhaustedForTest ? undefined : claimSlot(table);
		if (slot === undefined) throw new Error("sdk broker: publication liveness watchdog slot table is full");
		slots.set(owner, slot);
	}
	const now = nowMs();
	publishSlot(table, slot, now, now, asMs(graceMs), asMs(cadenceMs));
	try {
		if (workerStartFailureForTest) throw workerStartFailureForTest;
		await ensureWorker();
	} catch (error) {
		Atomics.store(table, slot * PUBLICATION_LIVENESS_SLOT_STRIDE + PUBLICATION_LIVENESS_INDEX_ACTIVE, 0n);
		slots.delete(owner);
		throw watchdogUnavailable(error);
	}
	return true;
}

/** Record that the JS publication interval ran, and refresh the grace it enforces. */
export function notePublicationLivenessLoop(owner: object, graceMs: number): void {
	const slot = slotOf(owner);
	if (slot === undefined || !view) return;
	const base = slot * PUBLICATION_LIVENESS_SLOT_STRIDE;
	Atomics.store(view, base + PUBLICATION_LIVENESS_INDEX_LOOP, nowMs());
	Atomics.store(view, base + PUBLICATION_LIVENESS_INDEX_GRACE, asMs(graceMs));
}

/** A discovery publication landed. The deadline is measured from this instant. */
export function notePublicationLivenessProven(owner: object): void {
	const slot = slotOf(owner);
	if (slot === undefined || !view) return;
	Atomics.store(view, slot * PUBLICATION_LIVENESS_SLOT_STRIDE + PUBLICATION_LIVENESS_INDEX_PUBLISHED, nowMs());
}

/** Apply a grace change without waiting for the next interval tick. */
export function syncPublicationLivenessGrace(owner: object, graceMs: number): void {
	const slot = slotOf(owner);
	if (slot === undefined || !view) return;
	Atomics.store(view, slot * PUBLICATION_LIVENESS_SLOT_STRIDE + PUBLICATION_LIVENESS_INDEX_GRACE, asMs(graceMs));
}

/** Drop the slot before shutdown work. A later blocked syscall must not kill a broker that is already exiting. */
export function disarmPublicationLivenessWatchdog(owner: object): void {
	const slot = slots.get(owner);
	if (slot === undefined) return;
	slots.delete(owner);
	if (!view) return;
	Atomics.store(view, slot * PUBLICATION_LIVENESS_SLOT_STRIDE + PUBLICATION_LIVENESS_INDEX_ACTIVE, 0n);
}
