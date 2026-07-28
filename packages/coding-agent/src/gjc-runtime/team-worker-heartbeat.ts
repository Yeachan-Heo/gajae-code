/**
 * Runtime-owned `gjc team` worker heartbeat.
 *
 * Worker liveness used to be published only when the model remembered to call
 * `gjc team api update-worker-heartbeat` between turns. A worker inside a
 * single tool call longer than `GJC_TEAM_HEARTBEAT_STALE_MS` (default 120s) was
 * therefore reported as stale and had its task claim requeued mid-flight — even
 * though the claim lease it invalidated is 30 minutes long. This module makes
 * the worker process itself publish liveness while a turn is in flight, so the
 * heartbeat records what the process is doing instead of what the model
 * remembered to report.
 *
 * The published record carries the writer's real pid, so leader-side diagnostics
 * name the process that is actually working rather than a placeholder.
 */
import { logger } from "@gajae-code/utils";
import { parseHeartbeatStaleMs, refreshGjcWorkerHeartbeat, type WorkerHeartbeatFile } from "./team-runtime";

/** Publish several times per stale window so one missed tick cannot cross it. */
const HEARTBEAT_INTERVAL_DIVISOR = 3;
const MIN_HEARTBEAT_INTERVAL_MS = 1;
const MAX_HEARTBEAT_INTERVAL_MS = 30_000;

export interface GjcTeamWorkerIdentity {
	teamName: string;
	workerId: string;
}

/** Resolves the team identity injected into a worker pane by `gjc team` startup. */
export function resolveGjcTeamWorkerIdentity(env: NodeJS.ProcessEnv = process.env): GjcTeamWorkerIdentity | undefined {
	const teamName = env.GJC_TEAM_NAME?.trim();
	const workerId = env.GJC_TEAM_WORKER_ID?.trim() || env.GJC_TEAM_INTERNAL_WORKER?.split("/").pop()?.trim();
	return teamName && workerId ? { teamName, workerId } : undefined;
}

/** Refresh cadence derived from the leader's stale window; `0` disables publishing. */
export function resolveGjcTeamWorkerHeartbeatIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
	const staleMs = parseHeartbeatStaleMs(env);
	if (staleMs <= 0) return 0;
	return Math.min(
		MAX_HEARTBEAT_INTERVAL_MS,
		Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(staleMs / HEARTBEAT_INTERVAL_DIVISOR)),
	);
}

/**
 * Publish one runtime-owned heartbeat for the worker this process is running as.
 * Returns `undefined` when the process is not a team worker.
 *
 * `turn_count` and process-incarnation metadata are merged under the same
 * mutation fence used by CLI heartbeat updates.
 */
export async function writeGjcTeamWorkerRuntimeHeartbeat(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerHeartbeatFile | undefined> {
	const identity = resolveGjcTeamWorkerIdentity(env);
	if (!identity) return undefined;
	return refreshGjcWorkerHeartbeat(identity.teamName, identity.workerId, process.pid, cwd, env);
}

export interface GjcTeamWorkerHeartbeatReporterOptions {
	write: () => Promise<void>;
	intervalMs: number;
}

/**
 * Publishes a worker heartbeat while a turn is in flight.
 *
 * Writes never overlap; a slow or failing write is logged and skipped rather
 * than queued, because only the most recent record matters. The timer is
 * unreferenced so it can never hold the process open.
 */
export class GjcTeamWorkerHeartbeatReporter {
	readonly #write: () => Promise<void>;
	readonly #intervalMs: number;
	#timer: NodeJS.Timeout | undefined;
	#inFlight: Promise<void> | undefined;
	#disposed = false;

	constructor(options: GjcTeamWorkerHeartbeatReporterOptions) {
		this.#write = options.write;
		this.#intervalMs = options.intervalMs;
	}

	/** Reporter for the current process, or `undefined` when it is not a team worker. */
	static forProcess(
		cwd: () => string,
		env: NodeJS.ProcessEnv = process.env,
	): GjcTeamWorkerHeartbeatReporter | undefined {
		if (!resolveGjcTeamWorkerIdentity(env)) return undefined;
		const intervalMs = resolveGjcTeamWorkerHeartbeatIntervalMs(env);
		if (intervalMs <= 0) return undefined;
		return new GjcTeamWorkerHeartbeatReporter({
			intervalMs,
			write: async () => {
				await writeGjcTeamWorkerRuntimeHeartbeat(cwd(), env);
			},
		});
	}

	get isRunning(): boolean {
		return this.#timer !== undefined;
	}

	/** Publish immediately, then keep publishing until {@link stop} or {@link dispose}. */
	start(): void {
		if (this.#disposed || this.#timer) return;
		this.#publish();
		this.#timer = setInterval(() => this.#publish(), this.#intervalMs);
		this.#timer.unref?.();
	}

	/** Stop periodic publishing after one final record, so the idle stamp is fresh. */
	stop(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#publish();
	}

	/** Await the write in flight, if any. */
	async flush(): Promise<void> {
		while (this.#inFlight) {
			await this.#inFlight;
		}
	}

	/** Permanently stop publishing. Idempotent. */
	dispose(): void {
		this.#disposed = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	#publish(): void {
		if (this.#disposed || this.#inFlight) return;
		const run = this.#write()
			.catch((error: unknown) => {
				logger.warn("GJC team worker heartbeat publish failed", { error: String(error) });
			})
			.finally(() => {
				if (this.#inFlight === run) this.#inFlight = undefined;
			});
		this.#inFlight = run;
	}
}
