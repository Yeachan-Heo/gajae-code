/**
 * Driver-side arm launchers (S3). Both arms expose the same surface so the
 * run protocol, churn loop, and preflight treat isolation as the only variable.
 *
 * - standalone: one OS process (`runner-process.ts`) per session.
 * - worker: one resident OS process (`worker-host.ts`) with one Worker per session.
 *
 * Every timestamp (runner events and driver records) uses `benchNow()`, a
 * clock comparable across processes and Worker isolates.
 */
import * as path from "node:path";
import { type RootHandle, type RootRegistration, sanitizedRootEnv, spawnRoot } from "./channel";
import type { WorkloadVariant } from "./workload";
import { type ArmKind, benchNow, type RunnerEvent } from "./types";
import type { HostEvent } from "./worker-host";

const BENCH_DIR = import.meta.dir;

export interface ArmOptions {
	kind: ArmKind;
	rootDir: string;
	idleMs: number;
	variant: WorkloadVariant;
	token: string;
	cohort: RootRegistration;
}

export interface SessionTiming {
	/** Driver clock at the cold-start reference (spawn of the process that hosts this session). */
	coldStart: number;
	/** Driver clock when the create was issued (equals coldStart unless the host already existed). */
	createdAt: number;
	/** True when this session reused an already-running host (warm admission). */
	warm: boolean;
	readyAt?: number;
	disposedAt?: number;
	closedAt?: number;
	evidenceDir?: string;
	error?: string;
}

export interface Arm {
	readonly kind: ArmKind;
	readonly events: RunnerEvent[];
	readonly sessions: Map<number, SessionTiming>;
	/** Live root handles (standalone: one per open session; worker: the host). */
	roots(): Array<RootHandle<HostEvent>>;
	createSessions(indices: number[]): void;
	closeSession(sessionIndex: number): Promise<void>;
	/** Resolves when every listed session published `done` after persisting its evidence (or failed). */
	waitDisposed(indices: number[], timeoutMs: number): Promise<void>;
	/** Resolves when the predicate holds over received events. */
	waitFor(predicate: () => boolean, timeoutMs: number): Promise<void>;
	shutdown(): Promise<void>;
	/** Kill every live root by exact identity. */
	abort(): void;
}

export function createArm(options: ArmOptions): Arm {
	const events: RunnerEvent[] = [];
	const sessions = new Map<number, SessionTiming>();
	const waiters = new Set<() => void>();
	const notify = (): void => {
		for (const waiter of waiters) waiter();
	};

	const handle = (record: HostEvent): void => {
		const now = benchNow();
		switch (record.type) {
			case "created":
			case "host-snapshot":
				break;
			case "closed": {
				const timing = sessions.get(record.sessionIndex);
				if (timing) timing.closedAt = now;
				break;
			}
			default: {
				const event: RunnerEvent = record;
				events.push(event);
				const timing = sessions.get(event.sessionIndex);
				if (timing) {
					if (event.type === "phase" && event.phase === "ready") timing.readyAt = event.t;
					if (event.type === "phase" && event.phase === "disposed") timing.disposedAt = event.t;
					if (event.type === "done") timing.evidenceDir = event.evidenceDir;
					if (event.type === "error") timing.error = event.message;
				}
			}
		}
		notify();
	};

	/**
	 * Relay a root's events; when its stdout ends (root exited or crashed), every
	 * session it hosted that never published `done` is marked failed so waits
	 * settle immediately instead of hanging until their timeout.
	 */
	const pump = async (root: RootHandle<HostEvent>, hosted: () => number[]): Promise<void> => {
		let failure: string | undefined;
		try {
			for await (const record of root.events) handle(record);
		} catch (error) {
			failure = `root ${root.pid} event stream failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		const code = await root.exited;
		const exitedAt = benchNow();
		for (const index of hosted()) {
			const timing = sessions.get(index);
			if (!timing) continue;
			if (timing.evidenceDir === undefined && timing.error === undefined) {
				timing.error = failure ?? `root ${root.pid} exited with code ${code} before session ${index} completed`;
			}
			// A session cannot outlive its hosting process.
			timing.closedAt ??= exitedAt;
		}
		notify();
	};

	const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
		if (predicate()) return;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = (): void => {
			if (predicate()) resolve();
		};
		const timer = setTimeout(() => reject(new Error(`arm ${options.kind}: wait timed out after ${timeoutMs}ms`)), timeoutMs);
		waiters.add(check);
		try {
			await promise;
		} finally {
			clearTimeout(timer);
			waiters.delete(check);
		}
	};

	const settled = (index: number): boolean => {
		const timing = sessions.get(index);
		// `done` (which carries the evidence directory) is published only after the
		// evidence is on disk; a session is settled once it arrives, or it failed.
		return timing !== undefined && (timing.evidenceDir !== undefined || timing.error !== undefined);
	};

	const spawn = (cmd: string[], label: string): RootHandle<HostEvent> =>
		spawnRoot<HostEvent>({
			cmd,
			cwd: options.rootDir,
			env: sanitizedRootEnv(),
			token: options.token,
			cohort: options.cohort,
			stderrPath: path.join(options.rootDir, `${label}.stderr.log`),
		});

	if (options.kind === "standalone") {
		const roots = new Map<number, RootHandle<HostEvent>>();
		return {
			kind: "standalone",
			events,
			sessions,
			roots: () => [...roots.values()],
			createSessions(indices) {
				for (const index of indices) {
					const root = spawn(
						[
							process.execPath,
							path.join(BENCH_DIR, "runner-process.ts"),
							String(index),
							options.rootDir,
							String(options.idleMs),
							options.variant,
						],
						`session-${index}`,
					);
					roots.set(index, root);
					sessions.set(index, { coldStart: root.spawnedAt, createdAt: root.spawnedAt, warm: false });
					void pump(root, () => [index]);
					root.send({ type: "start" });
				}
			},
			async closeSession(index) {
				const root = roots.get(index);
				if (!root) return;
				// A standalone session closes by disposing and exiting its process.
				await root.exited;
				roots.delete(index);
				const timing = sessions.get(index);
				if (timing) timing.closedAt = benchNow();
			},
			waitDisposed: (indices, timeoutMs) => waitFor(() => indices.every(settled), timeoutMs),
			waitFor,
			async shutdown() {
				await Promise.all([...roots.keys()].map(index => this.closeSession(index)));
			},
			abort() {
				for (const root of roots.values()) root.kill();
			},
		};
	}

	let host: RootHandle<HostEvent> | undefined;
	return {
		kind: "worker",
		events,
		sessions,
		roots: () => (host ? [host] : []),
		createSessions(indices) {
			let warm = true;
			if (!host) {
				host = spawn(
					[process.execPath, path.join(BENCH_DIR, "worker-host.ts"), options.rootDir, String(options.idleMs), options.variant],
					"worker-host",
				);
				void pump(host, () => [...sessions.keys()]);
				warm = false;
			}
			for (const index of indices) {
				const createdAt = benchNow();
				sessions.set(index, { coldStart: warm ? createdAt : host.spawnedAt, createdAt, warm });
				host.send({ type: "create", sessionIndex: index });
			}
		},
		async closeSession(index) {
			if (!host) return;
			host.send({ type: "close", sessionIndex: index });
			await waitFor(() => sessions.get(index)?.closedAt !== undefined, 30_000);
		},
		waitDisposed: (indices, timeoutMs) => waitFor(() => indices.every(settled), timeoutMs),
		waitFor,
		async shutdown() {
			if (!host) return;
			host.send({ type: "shutdown" });
			await host.exited;
			host = undefined;
		},
		abort() {
			host?.kill();
		},
	};
}
