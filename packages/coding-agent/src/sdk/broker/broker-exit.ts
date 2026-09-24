import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { isCompiledBinary } from "@gajae-code/utils/env";
import type {
	BrokerExitWriterTestBarrier,
	BrokerExitWriterWorkerRequest,
	BrokerExitWriterWorkerResponse,
} from "./broker-exit-writer-worker";

export type { BrokerExitWriterTestBarrier } from "./broker-exit-writer-worker";

let writerBarrierForTest: BrokerExitWriterTestBarrier | undefined;

/** Install a worker-only deterministic commit barrier for publication-fence tests. */
export function setBrokerExitWriterBarrierForTest(barrier?: BrokerExitWriterTestBarrier): void {
	writerBarrierForTest = barrier;
}

export type BrokerExitMode = "owned-root" | "lost-root";
export type BrokerFenceReason = "suspect-unpublished" | "observation-ambiguous" | "heartbeat-ambiguous";
export type BrokerExitReason =
	| "ownership-fence-expired"
	| "publication-liveness-timeout"
	| "restart-committed"
	| "shutdown-request"
	| "startup-failure"
	| "signal";

export type BrokerStopRequest =
	| { kind: "shutdown-request" }
	| { kind: "startup-failure" }
	| { kind: "signal"; signal: "SIGINT" | "SIGTERM" };

export interface BrokerExitRecord {
	version: 1;
	mode: BrokerExitMode;
	reason: BrokerExitReason;
	fenceReason: BrokerFenceReason | null;
	fencedForMs: number;
	uptimeMs: number;
	pid: number;
	signal: "SIGINT" | "SIGTERM" | null;
	writtenAt: number;
}

export interface BrokerStartupExitRecord {
	version: 1;
	mode: "startup";
	reason: "startup-deadline" | "startup-signal";
	fenceReason: null;
	fencedForMs: 0;
	uptimeMs: number;
	pid: number;
	signal: "SIGINT" | "SIGTERM" | null;
	exitCode: 1 | 130 | 143;
	timeoutMs: number | null;
	writtenAt: number;
}

export type BrokerStartupExitWriteStatus =
	| { kind: "written" }
	| { kind: "failed"; code?: string }
	| { kind: "timed_out" };

const BROKER_EXIT_FILE = "broker.exit.json";
const BROKER_STARTUP_EXIT_FILE = "broker.startup-exit.json";
const MAX_BROKER_EXIT_RECORD_BYTES = 1_024;
// `writtenAt` is the persisted generation; sequence same-path writes even within one clock tick.
const lastWriteGenerationByPath = new Map<string, number>();
const EXIT_REASONS = new Set<BrokerExitReason>([
	"ownership-fence-expired",
	"publication-liveness-timeout",
	"restart-committed",
	"shutdown-request",
	"startup-failure",
	"signal",
]);

export function brokerExitRecordPath(agentDir: string): string {
	return path.join(agentDir, "sdk", BROKER_EXIT_FILE);
}

export function brokerStartupExitRecordPath(agentDir: string): string {
	return path.join(agentDir, "sdk", BROKER_STARTUP_EXIT_FILE);
}

/** Remove a stale bootstrap-exit record before a supervisor spawns a new child. */
export async function clearBrokerStartupExitRecord(agentDir: string): Promise<void> {
	await fs.rm(brokerStartupExitRecordPath(agentDir), { force: true }).catch(() => {});
}

function isBrokerExitRecord(value: unknown): value is BrokerExitRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<BrokerExitRecord>;
	const keys = Object.keys(record).sort();
	return (
		keys.join(",") ===
			["fenceReason", "fencedForMs", "mode", "pid", "reason", "signal", "uptimeMs", "version", "writtenAt"]
				.sort()
				.join(",") &&
		record.version === 1 &&
		(record.mode === "owned-root" || record.mode === "lost-root") &&
		typeof record.reason === "string" &&
		EXIT_REASONS.has(record.reason as BrokerExitReason) &&
		(record.fenceReason === null ||
			record.fenceReason === "suspect-unpublished" ||
			record.fenceReason === "observation-ambiguous" ||
			record.fenceReason === "heartbeat-ambiguous") &&
		Number.isSafeInteger(record.fencedForMs) &&
		(record.fencedForMs as number) >= 0 &&
		Number.isSafeInteger(record.uptimeMs) &&
		(record.uptimeMs as number) >= 0 &&
		Number.isSafeInteger(record.pid) &&
		(record.pid as number) > 0 &&
		(record.signal === null || record.signal === "SIGINT" || record.signal === "SIGTERM") &&
		(record.reason === "signal") === (record.signal !== null) &&
		Number.isSafeInteger(record.writtenAt) &&
		(record.writtenAt as number) > 0
	);
}

function isBrokerStartupExitRecord(value: unknown): value is BrokerStartupExitRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<BrokerStartupExitRecord>;
	const signalExitCode = record.signal === "SIGINT" ? 130 : record.signal === "SIGTERM" ? 143 : null;
	const keys = Object.keys(record).sort();
	return (
		keys.join(",") ===
			[
				"exitCode",
				"fenceReason",
				"fencedForMs",
				"mode",
				"pid",
				"reason",
				"signal",
				"timeoutMs",
				"uptimeMs",
				"version",
				"writtenAt",
			]
				.sort()
				.join(",") &&
		record.version === 1 &&
		record.mode === "startup" &&
		(record.reason === "startup-deadline" || record.reason === "startup-signal") &&
		record.fenceReason === null &&
		record.fencedForMs === 0 &&
		Number.isSafeInteger(record.uptimeMs) &&
		(record.uptimeMs as number) >= 0 &&
		Number.isSafeInteger(record.pid) &&
		(record.pid as number) > 0 &&
		(record.signal === null || record.signal === "SIGINT" || record.signal === "SIGTERM") &&
		(record.exitCode === 1 || record.exitCode === 130 || record.exitCode === 143) &&
		(record.timeoutMs === null || (Number.isSafeInteger(record.timeoutMs) && (record.timeoutMs as number) > 0)) &&
		(record.reason === "startup-deadline"
			? record.exitCode === 1 && record.signal === null && record.timeoutMs !== null
			: record.exitCode === signalExitCode && signalExitCode !== null && record.timeoutMs === null) &&
		Number.isSafeInteger(record.writtenAt) &&
		(record.writtenAt as number) > 0
	);
}

/** Return only the generation of a currently supported structured exit record. */
export function brokerExitRecordGeneration(value: unknown): number | undefined {
	if (isBrokerExitRecord(value)) return value.writtenAt;
	if (isBrokerStartupExitRecord(value)) return value.writtenAt;
	return undefined;
}

async function runBrokerExitWriterWorker(
	request: Omit<BrokerExitWriterWorkerRequest, "cancellation" | "testBarrier">,
	signal: AbortSignal | undefined,
	onDispatched: () => void,
): Promise<void> {
	if (signal?.aborted) throw new Error("SDK broker exit record write was aborted.");
	const worker = isCompiledBinary()
		? new Worker("./packages/coding-agent/src/sdk/broker/broker-exit-writer-worker.ts", { type: "module" })
		: new Worker(new URL("./broker-exit-writer-worker.ts", import.meta.url).href, { type: "module" });
	const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
	const cancellationView = new Int32Array(cancellation);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	let workerFinished = false;
	const removeListeners = (): void => {
		worker.removeEventListener("message", onMessage);
		worker.removeEventListener("error", onError);
		worker.removeEventListener("messageerror", onMessageError);
		worker.removeEventListener("close", onClose);
		worker.removeEventListener("exit", onExit);
		signal?.removeEventListener("abort", onAbort);
	};
	const sendCancellation = (): void => {
		Atomics.store(cancellationView, 0, 1);
		(worker as Worker & { unref?: () => void }).unref?.();
		try {
			worker.postMessage({ type: "decision", decision: "cancel" });
		} catch {
			// The shared cancellation flag remains observable when the worker returns
			// from a synchronous native commit, even if its message loop is blocked.
		}
	};
	const fail = (error: Error): void => {
		if (settled) return;
		settled = true;
		sendCancellation();
		reject(error);
	};
	const abortError = (): Error => new Error("SDK broker exit record write was aborted.");
	const onAbort = (): void => fail(abortError());
	const onMessage: EventListener = event => {
		const response = (event as MessageEvent<BrokerExitWriterWorkerResponse>).data;
		if (response?.type === "publication-ready") {
			if (settled || signal?.aborted) {
				sendCancellation();
				return;
			}
			try {
				worker.postMessage({ type: "decision", decision: "accept" });
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				resolve();
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
			return;
		}
		if (response?.type === "result") {
			workerFinished = true;
			if (response.result === "superseded")
				fail(new Error("SDK broker exit record was superseded by a newer record."));
			else if (response.result === "cancelled" && !settled) fail(abortError());
			removeListeners();
			return;
		}
		if (response?.type === "error") {
			workerFinished = true;
			const failure = new Error(response.message);
			if (response.name) failure.name = response.name;
			if (response.stack) failure.stack = response.stack;
			fail(failure);
			removeListeners();
			return;
		}
		fail(new Error("SDK broker exit writer worker returned an invalid response."));
	};
	const onError: EventListener = () => {
		workerFinished = true;
		fail(new Error("SDK broker exit writer worker failed."));
		removeListeners();
	};
	const onMessageError: EventListener = () => {
		workerFinished = true;
		fail(new Error("SDK broker exit writer worker message failed."));
		removeListeners();
	};
	const onClose: EventListener = () => {
		workerFinished = true;
		if (!settled) fail(new Error("SDK broker exit writer worker closed before responding."));
		removeListeners();
	};
	const onExit: EventListener = () => {
		workerFinished = true;
		if (!settled) fail(new Error("SDK broker exit writer worker exited before responding."));
		removeListeners();
	};
	worker.addEventListener("message", onMessage);
	worker.addEventListener("error", onError);
	worker.addEventListener("messageerror", onMessageError);
	worker.addEventListener("close", onClose);
	worker.addEventListener("exit", onExit);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		if (signal?.aborted) {
			worker.terminate();
			onAbort();
		} else {
			worker.postMessage({ ...request, cancellation, testBarrier: writerBarrierForTest });
			onDispatched();
		}
	} catch (error) {
		worker.terminate();
		fail(error instanceof Error ? error : new Error(String(error)));
		removeListeners();
	}
	try {
		await promise;
	} finally {
		if (workerFinished) removeListeners();
	}
}

async function writeAtomicExitRecord(destination: string, record: object, signal?: AbortSignal): Promise<void> {
	const requestedGeneration = (record as { writtenAt?: unknown }).writtenAt;
	if (!Number.isSafeInteger(requestedGeneration) || (requestedGeneration as number) <= 0)
		throw new Error("SDK broker exit record generation is invalid.");
	const previousGeneration = lastWriteGenerationByPath.get(destination);
	if (previousGeneration === Number.MAX_SAFE_INTEGER)
		throw new Error("SDK broker exit record generation is exhausted.");
	const generation = Math.max(requestedGeneration as number, (previousGeneration ?? 0) + 1);
	const serialized = JSON.stringify(
		generation === requestedGeneration ? record : { ...record, writtenAt: generation },
	);
	if (typeof serialized !== "string") throw new Error("SDK broker exit record could not be serialized.");
	if (Buffer.byteLength(serialized, "utf8") > MAX_BROKER_EXIT_RECORD_BYTES)
		throw new Error("SDK broker exit record exceeds its size bound.");
	lastWriteGenerationByPath.set(destination, generation);
	const throwIfAborted = (): void => {
		if (signal?.aborted) throw new Error("SDK broker exit record write was aborted.");
	};

	const directory = path.dirname(destination);
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	throwIfAborted();
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	let workerDispatched = false;
	try {
		throwIfAborted();
		const handle = await fs.open(temporary, "wx", 0o600);
		try {
			throwIfAborted();
			await handle.writeFile(serialized, "utf8");
			throwIfAborted();
			await handle.sync();
		} finally {
			await handle.close();
		}
		throwIfAborted();
		await runBrokerExitWriterWorker(
			{ destinationPath: destination, temporaryPath: temporary, generation: generation as number },
			signal,
			() => {
				workerDispatched = true;
			},
		);
	} finally {
		if (!workerDispatched) await fs.rm(temporary, { force: true }).catch(() => {});
	}
}

/** Atomically persist the latest bounded graceful-exit reason for supervisors. */
export async function writeBrokerExitRecord(
	agentDir: string,
	record: BrokerExitRecord,
	signal?: AbortSignal,
): Promise<void> {
	await writeAtomicExitRecord(brokerExitRecordPath(agentDir), record, signal);
}
/** Read the bounded previous-exit record; malformed or absent files are ignored. */
export async function readBrokerExitRecord(agentDir: string): Promise<BrokerExitRecord | undefined> {
	try {
		const file = Bun.file(brokerExitRecordPath(agentDir));
		if (!(await file.exists()) || file.size > MAX_BROKER_EXIT_RECORD_BYTES) return undefined;
		const value: unknown = JSON.parse(await file.text());
		return isBrokerExitRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Atomically persist a pre-readiness exit without replacing the active broker's last-exit record. */
export async function writeBrokerStartupExitRecordBounded(
	agentDir: string,
	record: BrokerStartupExitRecord,
	timeoutMs = 1_000,
	beforeWriteForTest?: () => Promise<void>,
): Promise<BrokerStartupExitWriteStatus> {
	const settled = Promise.withResolvers<BrokerStartupExitWriteStatus>();
	const abortController = new AbortController();
	const timer = setTimeout(() => {
		abortController.abort();
		settled.resolve({ kind: "timed_out" });
	}, timeoutMs);
	void (async () => {
		await beforeWriteForTest?.();
		await writeAtomicExitRecord(brokerStartupExitRecordPath(agentDir), record, abortController.signal);
	})().then(
		() => settled.resolve({ kind: "written" }),
		error => {
			const code =
				typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
					? error.code
					: undefined;
			settled.resolve({ kind: "failed", ...(code === undefined ? {} : { code }) });
		},
	);
	const written = await settled.promise;
	clearTimeout(timer);
	return written;
}

/** Read the latest bounded pre-readiness exit record; malformed or absent files are ignored. */
export async function readBrokerStartupExitRecord(agentDir: string): Promise<BrokerStartupExitRecord | undefined> {
	try {
		const file = Bun.file(brokerStartupExitRecordPath(agentDir));
		if (!(await file.exists()) || file.size > MAX_BROKER_EXIT_RECORD_BYTES) return undefined;
		const value: unknown = JSON.parse(await file.text());
		return isBrokerStartupExitRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
