import { isEmbeddedCompiledModule } from "@gajae-code/utils/env";
import { PUBLICATION_LIVENESS_SLOT_COUNT, PUBLICATION_LIVENESS_SLOT_STRIDE } from "./publication-liveness-deadline";

/** DOM `WorkerOptions` has no `workerData`; Bun still honors the Node field at runtime. */
interface PublicationLivenessWorkerOptions extends WorkerOptions {
	workerData: { buffer: SharedArrayBuffer };
}

const SMOKE_TIMEOUT_MS = 5_000;

export interface PublicationLivenessWatchdogSmokeOptions {
	timeoutMs?: number;
	/**
	 * Force the compiled-binary worker literal. `gjc --smoke-test` leaves this
	 * unset and follows the embedded module URL, not `PI_COMPILED`.
	 */
	compiled?: boolean;
}

/**
 * Starts the publication-liveness watchdog worker and waits until it reports
 * ready. Slots stay inactive, so the worker must not SIGKILL the process.
 * The compiled branch keeps a static literal for Bun's `--compile` discovery.
 */
export async function smokeTestPublicationLivenessWatchdog(
	options: PublicationLivenessWatchdogSmokeOptions = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? SMOKE_TIMEOUT_MS;
	const compiled = options.compiled ?? isEmbeddedCompiledModule();
	const buffer = new SharedArrayBuffer(
		PUBLICATION_LIVENESS_SLOT_COUNT * PUBLICATION_LIVENESS_SLOT_STRIDE * BigInt64Array.BYTES_PER_ELEMENT,
	);
	const workerOptions: PublicationLivenessWorkerOptions = { type: "module", workerData: { buffer } };
	// Literal paths must match packages/coding-agent/scripts/compile-args.ts.
	const worker = compiled
		? new Worker("./packages/coding-agent/src/sdk/broker/publication-liveness-watchdog-worker.ts", workerOptions)
		: new Worker(new URL("./publication-liveness-watchdog-worker.ts", import.meta.url).href, workerOptions);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	const finish = (error?: Error): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (error) reject(error);
		else resolve();
	};
	const timer = setTimeout(
		() => finish(new Error("publication liveness watchdog smoke did not become ready")),
		timeoutMs,
	);
	worker.addEventListener("message", event => {
		const data = (event as MessageEvent<{ type?: string }>).data;
		if (data?.type === "ready") finish();
	});
	worker.addEventListener("error", event => {
		const message = "message" in event && typeof event.message === "string" ? event.message : "worker error";
		finish(new Error(`publication liveness watchdog smoke failed: ${message}`));
	});
	try {
		await promise;
	} finally {
		clearTimeout(timer);
		worker.terminate();
	}
}
