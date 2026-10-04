/**
 * Worker-arm session entry: runs the shared session runner inside one Bun
 * Worker and relays every RunnerEvent to the host via postMessage.
 */
import { runSession } from "./session-runner";
import type { RunnerEvent } from "./types";
import type { WorkerStart } from "./worker-host";

declare const self: Worker;

self.addEventListener(
	"message",
	async (event: MessageEvent<WorkerStart>) => {
		const start = event.data;
		const emit = (record: RunnerEvent): void => self.postMessage(record);
		try {
			const { evidenceDir } = await runSession({
				sessionIndex: start.sessionIndex,
				rootDir: start.rootDir,
				idleMs: start.idleMs,
				emit,
				workloadVariant: start.variant,
			});
			emit({ type: "done", sessionIndex: start.sessionIndex, evidenceDir });
		} catch (error) {
			emit({
				type: "error",
				sessionIndex: start.sessionIndex,
				message: error instanceof Error ? (error.stack ?? error.message) : String(error),
			});
		}
	},
	{ once: true },
);
