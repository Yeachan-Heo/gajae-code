import crypto from "node:crypto";

/** This private feasibility harness never shares a tmux server with normal launch. */
export const GATE0_LIFECYCLE_TIMEOUT_MS = 14_000;
export type Gate0LifecycleMarker = "preflight" | "tmux_created" | "attached" | "detached" | "reattached" | "cleaned";

export interface Gate0TmuxChild {
	exited: Promise<number>;
	stdin: { write(value: string): void; end(): Promise<void> };
	kill(signal?: number | NodeJS.Signals): void;
}

export interface Gate0TmuxLifecycleOptions {
	phase: "A1" | "A2";
	tmuxCommand: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	signal?: AbortSignal;
	spawn?: (
		argv: string[],
		options: { cwd: string; env: NodeJS.ProcessEnv; stdin: "pipe"; stdout: "pipe"; stderr: "pipe" },
	) => Gate0TmuxChild;
	now?: () => number;
	randomBytes?: (size: number) => { toString(encoding: "hex"): string };
}

function failure(code: "GATE0_TIMEOUT" | "GATE0_CLEANUP_FAILURE" | "GATE0_TMUX_FAILURE"): Error {
	return new Error(code);
}

export function gate0TmuxEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (
			key === "TMUX" ||
			key === "TMUX_PANE" ||
			key === "TMUX_TMPDIR" ||
			key === "TERM_PROGRAM" ||
			key === "TERM_PROGRAM_VERSION" ||
			key.startsWith("CMUX_") ||
			key.startsWith("GHOSTTY_") ||
			key.startsWith("GJC_TMUX_") ||
			key.startsWith("GJC_SESSION_") ||
			key.startsWith("GJC_COORDINATOR_")
		)
			continue;
		env[key] = value;
	}
	return env;
}

function waitFor<T>(promise: Promise<T>, ms: number): Promise<T> {
	const deferred = Promise.withResolvers<T>();
	const timer = setTimeout(() => deferred.reject(failure("GATE0_TIMEOUT")), Math.max(1, ms));
	void promise.then(
		value => {
			clearTimeout(timer);
			deferred.resolve(value);
		},
		error => {
			clearTimeout(timer);
			deferred.reject(error);
		},
	);
	return deferred.promise;
}

async function stopChild(child: Gate0TmuxChild, deadline: number, now: () => number): Promise<boolean> {
	const waitForExit = async (until: number): Promise<boolean> => {
		const remaining = until - now();
		if (remaining <= 0) return false;
		try {
			await waitFor(child.exited, remaining);
			return true;
		} catch {
			return false;
		}
	};
	if (await waitForExit(Math.min(deadline, now() + 1))) return true;
	try {
		child.kill("SIGTERM");
	} catch {}
	const termDeadline = Math.min(deadline, now() + Math.max(1, Math.floor((deadline - now()) / 2)));
	if (await waitForExit(termDeadline)) return true;
	try {
		child.kill("SIGKILL");
	} catch {}
	return waitForExit(deadline);
}

/** Runs one client command and bounds both its execution and its termination. */
async function commandStatus(
	spawn: NonNullable<Gate0TmuxLifecycleOptions["spawn"]>,
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
	now: () => number,
	cleanupDeadline = deadline,
	onSpawn?: () => void,
): Promise<number> {
	if (now() >= deadline) throw failure("GATE0_TIMEOUT");
	const child = spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	onSpawn?.();
	const remaining = Math.max(1, deadline - now());
	try {
		return await waitFor(child.exited, remaining);
	} catch (error) {
		if (!(await stopChild(child, cleanupDeadline, now))) throw failure("GATE0_CLEANUP_FAILURE");
		throw error;
	}
}

async function controlAttach(
	spawn: NonNullable<Gate0TmuxLifecycleOptions["spawn"]>,
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	deadline: number,
	now: () => number,
	cleanupDeadline = deadline,
): Promise<void> {
	if (now() >= deadline) throw failure("GATE0_TIMEOUT");
	const child = spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	try {
		child.stdin.write("detach-client\n");
		await waitFor(Promise.resolve(child.stdin.end()), Math.max(1, deadline - now()));
	} catch {
		if (!(await stopChild(child, cleanupDeadline, now))) throw failure("GATE0_CLEANUP_FAILURE");
		throw failure("GATE0_TMUX_FAILURE");
	}
	try {
		if ((await waitFor(child.exited, Math.max(1, deadline - now()))) !== 0) throw failure("GATE0_TMUX_FAILURE");
	} catch (error) {
		if (!(await stopChild(child, cleanupDeadline, now))) throw failure("GATE0_CLEANUP_FAILURE");
		throw error;
	}
}

/**
 * Runs an isolated, random-server tmux experiment. Cleanup is part of the
 * result: an unverifiable kill-server is an internal failure, never success.
 */
export async function runGate0TmuxLifecycle(options: Gate0TmuxLifecycleOptions): Promise<Gate0LifecycleMarker[]> {
	const timeoutMs = Math.min(Math.max(options.timeoutMs ?? GATE0_LIFECYCLE_TIMEOUT_MS, 1), GATE0_LIFECYCLE_TIMEOUT_MS);
	const now = options.now ?? Date.now;
	const deadline = now() + timeoutMs;
	const cleanupReserveMs = Math.min(3_000, Math.max(1, Math.floor(timeoutMs / 3)), Math.max(0, timeoutMs - 1));
	const namespaceCleanupReserveMs = Math.min(Math.max(1, Math.floor(cleanupReserveMs / 2)), cleanupReserveMs);
	const clientCleanupDeadline = deadline - namespaceCleanupReserveMs;
	const workDeadline = deadline - cleanupReserveMs;
	const cwd = options.cwd ?? process.cwd();
	const env = gate0TmuxEnvironment(options.env ?? process.env);
	const spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn(argv, spawnOptions) as unknown as Gate0TmuxChild);
	const server = `gjc-gate0-${(options.randomBytes ?? crypto.randomBytes)(12).toString("hex")}`;
	const session = "gate0";
	const args = (...command: string[]) => [options.tmuxCommand, "-f", "/dev/null", "-L", server, ...command];
	const markers: Gate0LifecycleMarker[] = ["preflight"];
	let createClientSpawned = false;
	let mainFailure: unknown;
	try {
		if (options.signal?.aborted) throw failure("GATE0_TIMEOUT");
		if (
			(await commandStatus(
				spawn,
				args("new-session", "-d", "-s", session, "--", "/bin/sleep", "15"),
				cwd,
				env,
				workDeadline,
				now,
				clientCleanupDeadline,
				() => {
					createClientSpawned = true;
				},
			)) !== 0
		)
			throw failure("GATE0_TMUX_FAILURE");
		markers.push("tmux_created");
		if (
			(await commandStatus(
				spawn,
				args("has-session", "-t", session),
				cwd,
				env,
				workDeadline,
				now,
				clientCleanupDeadline,
			)) !== 0
		)
			throw failure("GATE0_TMUX_FAILURE");
		await controlAttach(
			spawn,
			args("-C", "attach-session", "-t", session),
			cwd,
			env,
			workDeadline,
			now,
			clientCleanupDeadline,
		);
		markers.push("attached", "detached");
		if (
			(await commandStatus(
				spawn,
				args("has-session", "-t", session),
				cwd,
				env,
				workDeadline,
				now,
				clientCleanupDeadline,
			)) !== 0
		)
			throw failure("GATE0_TMUX_FAILURE");
		await controlAttach(
			spawn,
			args("-C", "attach-session", "-t", session),
			cwd,
			env,
			workDeadline,
			now,
			clientCleanupDeadline,
		);
		markers.push("reattached");
	} catch (error) {
		mainFailure = error;
	} finally {
		if (createClientSpawned) {
			let cleanupFailed = false;
			try {
				await commandStatus(spawn, args("kill-server"), cwd, env, deadline, now);
			} catch (error) {
				cleanupFailed = error instanceof Error && error.message === "GATE0_CLEANUP_FAILURE";
			}
			try {
				if ((await commandStatus(spawn, args("has-session", "-t", session), cwd, env, deadline, now)) === 0)
					cleanupFailed = true;
			} catch {
				cleanupFailed = true;
			}
			if (cleanupFailed) mainFailure = failure("GATE0_CLEANUP_FAILURE");
			else markers.push("cleaned");
		}
	}
	if (mainFailure) throw mainFailure;
	return markers;
}
