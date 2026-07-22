import { isCompiledBinary } from "@gajae-code/utils/env";
import type { WorkerInbound, WorkerOutbound } from "./tab-protocol";

interface SmokeWorkerHandle {
	postMessage(message: WorkerInbound): void;
	addEventListener(type: string, listener: EventListener): void;
	removeEventListener(type: string, listener: EventListener): void;
	terminate(): void;
}

const SMOKE_TIMEOUT_MS = 5_000;
const TAB_WORKER_MODE = "native-free";

function smokeStartupError(stage: string): Error {
	return new Error(
		`Tab worker startup failed (stage=${stage}, mode=${TAB_WORKER_MODE}, platform=${process.platform}).`,
	);
}

/**
 * Starts the real tab worker entry without connecting to a browser, then proves
 * its bootstrap and shutdown protocol. The compiled branch deliberately keeps
 * a static literal for Bun's --compile worker discovery.
 */
export async function smokeTestTabWorker(timeoutMs = SMOKE_TIMEOUT_MS): Promise<void> {
	const worker = isCompiledBinary()
		? new Worker("./packages/coding-agent/src/tools/browser/tab-worker-entry.ts", { type: "module" })
		: new Worker(new URL("./tab-worker-entry.ts", import.meta.url).href, { type: "module" });
	await smokeTestTabWorkerWithWorkerForTest(worker, timeoutMs);
}

/** Test-only: verify the smoke handshake against a controlled worker transport. */
export async function smokeTestTabWorkerWithWorkerForTest(worker: SmokeWorkerHandle, timeoutMs: number): Promise<void> {
	type SmokePhase = "await-bootstrap" | "await-closed";
	let phase: SmokePhase = "await-bootstrap";
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	let timeout: NodeJS.Timeout | undefined;

	const cleanup = (): void => {
		if (timeout) clearTimeout(timeout);
		worker.removeEventListener("message", onMessage);
		worker.removeEventListener("error", onError);
		worker.removeEventListener("messageerror", onMessageError);
	};
	const succeed = (): void => {
		if (settled) return;
		settled = true;
		resolve();
	};
	const fail = (stage: string): void => {
		if (settled) return;
		settled = true;
		reject(smokeStartupError(stage));
	};
	const onMessage: EventListener = event => {
		const message = (event as MessageEvent<WorkerOutbound>).data;
		if (message.type === "log") return;
		if (phase === "await-bootstrap") {
			if (message.type === "bootstrap-ready" && message.version === 1 && message.mode === TAB_WORKER_MODE) {
				phase = "await-closed";
				worker.postMessage({ type: "close" } satisfies WorkerInbound);
			} else if (message.type === "bootstrap-failed") {
				fail("bootstrap");
			} else {
				fail("protocol-phase");
			}
			return;
		}
		if (message.type === "closed") succeed();
		else fail("protocol-phase");
	};
	const onError: EventListener = () => fail("error");
	const onMessageError: EventListener = () => fail("messageerror");

	worker.addEventListener("message", onMessage);
	worker.addEventListener("error", onError);
	worker.addEventListener("messageerror", onMessageError);
	timeout = setTimeout(() => fail("smoke-timeout"), timeoutMs);
	try {
		worker.postMessage({ type: "bootstrap", version: 1, mode: TAB_WORKER_MODE } satisfies WorkerInbound);
		await promise;
	} finally {
		cleanup();
		worker.terminate();
	}
}
