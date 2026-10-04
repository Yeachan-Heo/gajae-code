/**
 * JSONL control channel between the bench driver and an arm root process.
 *
 * Driver → root: commands on stdin. Root → driver: events on stdout. Diagnostics
 * never go to stdout, so every stdout line is a structured record.
 */
import { observeProcessIncarnation } from "../../src/sdk/broker/process-incarnation";
import { COHORT_MARKER_ENV } from "./cohort";
import { readJsonlStream } from "./jsonl";
import { benchNow } from "./types";

/** Root side: write one event record to stdout. */
export function emitToDriver(record: unknown): void {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

/**
 * Root side: iterate commands from the driver. The first command must be
 * `ack`; nothing else is delivered before it, so no workload (and no tool
 * process) can start before the driver has registered this root.
 */
export async function* driverCommands<T extends { type: string }>(): AsyncGenerator<T> {
	let acked = false;
	for await (const command of readJsonlStream<T>(Bun.stdin.stream(), "driver commands")) {
		if (!acked) {
			if (command.type !== "ack") throw new Error(`expected ack before ${command.type}`);
			acked = true;
			continue;
		}
		yield command;
	}
}

export interface RootRegistration {
	registerRoot(pid: number, incarnation: string): void;
}

export interface RootHandle<Event> {
	readonly pid: number;
	readonly incarnation: string;
	/** Monotonic time of the spawn call (cold-readiness start). */
	readonly spawnedAt: number;
	readonly events: AsyncGenerator<Event>;
	readonly exited: Promise<number>;
	send(command: unknown): void;
	kill(): void;
}

export interface SpawnRootOptions {
	cmd: string[];
	cwd: string;
	env: Record<string, string>;
	token: string;
	cohort: RootRegistration;
	stderrPath: string;
}

/**
 * Driver side: spawn a root blocked on its ack barrier, observe its
 * incarnation, register it with the cohort, and only then release it.
 */
export function spawnRoot<Event>(options: SpawnRootOptions): RootHandle<Event> {
	const spawnedAt = benchNow();
	const child = Bun.spawn({
		cmd: options.cmd,
		cwd: options.cwd,
		env: { ...options.env, [COHORT_MARKER_ENV]: options.token },
		stdin: "pipe",
		stdout: "pipe",
		stderr: Bun.file(options.stderrPath),
	});
	const observation = observeProcessIncarnation(child.pid);
	if (observation.status !== "present") {
		child.kill("SIGKILL");
		throw new Error(`root ${child.pid} incarnation unobservable: ${JSON.stringify(observation)}`);
	}
	options.cohort.registerRoot(child.pid, observation.incarnation);
	const send = (command: unknown): void => {
		child.stdin.write(`${JSON.stringify(command)}\n`);
		child.stdin.flush();
	};
	send({ type: "ack" });
	return {
		pid: child.pid,
		incarnation: observation.incarnation,
		spawnedAt,
		events: readJsonlStream<Event>(child.stdout, "root stdout"),
		exited: child.exited,
		send,
		kill: () => {
			// Kill by exact identity only: never signal a reused PID.
			const current = observeProcessIncarnation(child.pid);
			if (current.status === "present" && current.incarnation === observation.incarnation) child.kill("SIGKILL");
		},
	};
}

/** Environment for arm roots: the driver's env minus capabilities and Broker discovery. */
export function sanitizedRootEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (key === "GJC_MASTER_CAPABILITY" || key.startsWith("GJC_BROKER") || key.startsWith("GJC_SDK_")) continue;
		if (key === COHORT_MARKER_ENV) continue;
		env[key] = value;
	}
	return env;
}
