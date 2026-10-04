/**
 * Worker-arm root: one OS process hosting N sessions, one Bun Worker each.
 *
 * argv: <rootDir> <idleMs> <variant>
 * Commands (stdin JSONL, after ack): create(i), close(i), snapshot, shutdown.
 * Events (stdout JSONL): every RunnerEvent relayed from Workers plus
 * host-level `created` / `closed` / `host-snapshot` records.
 *
 * Policy exception (RFC #6247 Phase A, decision C5): this bench-only Worker
 * uses the AGENTS.md hybrid constructor but is intentionally NOT registered
 * as a compile entrypoint, so benchmark code never ships in the gjc binary.
 */
import { isCompiledBinary } from "@gajae-code/utils";
import { driverCommands, emitToDriver } from "./channel";
import type { WorkloadVariant } from "./workload";
import { benchNow, type RunnerEvent } from "./types";

export type HostCommand =
	| { type: "create"; sessionIndex: number }
	| { type: "close"; sessionIndex: number }
	| { type: "snapshot" }
	| { type: "shutdown" };

export type HostEvent =
	| RunnerEvent
	| { type: "created"; sessionIndex: number; t: number }
	| { type: "closed"; sessionIndex: number; t: number }
	| { type: "host-snapshot"; t: number; rss: number; heapUsed: number; external: number; workers: number };

/** Message from the host to a Worker. */
export interface WorkerStart {
	type: "start";
	sessionIndex: number;
	rootDir: string;
	idleMs: number;
	variant: WorkloadVariant;
}

function createWorker(): Worker {
	return isCompiledBinary()
		? new Worker("./packages/coding-agent/bench/multisession/worker-entry.ts", { type: "module" })
		: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
}

async function main(): Promise<void> {
	const [rootDir, idleArg, variantArg] = process.argv.slice(2);
	const idleMs = Number(idleArg);
	if (!rootDir || !Number.isFinite(idleMs)) throw new Error("usage: worker-host.ts <rootDir> <idleMs> <full|preflight>");
	const variant = (variantArg ?? "full") as WorkloadVariant;
	const workers = new Map<number, Worker>();

	const close = async (sessionIndex: number): Promise<void> => {
		const worker = workers.get(sessionIndex);
		if (!worker) return;
		workers.delete(sessionIndex);
		const { promise, resolve } = Promise.withResolvers<void>();
		worker.addEventListener("close", () => resolve(), { once: true });
		worker.terminate();
		await promise;
		emitToDriver({ type: "closed", sessionIndex, t: benchNow() } satisfies HostEvent);
	};

	for await (const command of driverCommands<HostCommand>()) {
		switch (command.type) {
			case "create": {
				const worker = createWorker();
				workers.set(command.sessionIndex, worker);
				worker.addEventListener("message", event => emitToDriver(event.data as RunnerEvent));
				worker.addEventListener("error", event => {
					emitToDriver({
						type: "error",
						sessionIndex: command.sessionIndex,
						message: `worker error: ${event.message}`,
					} satisfies HostEvent);
				});
				worker.postMessage({ type: "start", sessionIndex: command.sessionIndex, rootDir, idleMs, variant } satisfies WorkerStart);
				emitToDriver({ type: "created", sessionIndex: command.sessionIndex, t: benchNow() } satisfies HostEvent);
				break;
			}
			case "close":
				await close(command.sessionIndex);
				break;
			case "snapshot": {
				const usage = process.memoryUsage();
				emitToDriver({
					type: "host-snapshot",
					t: benchNow(),
					rss: usage.rss,
					heapUsed: usage.heapUsed,
					external: usage.external,
					workers: workers.size,
				} satisfies HostEvent);
				break;
			}
			case "shutdown":
				for (const sessionIndex of [...workers.keys()]) await close(sessionIndex);
				return;
		}
	}
}

await main();
process.exit();
