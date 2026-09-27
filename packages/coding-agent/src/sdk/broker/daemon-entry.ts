import { type ChildProcess, spawn } from "node:child_process";
import { type BrokerDiscovery, readBrokerDiscovery, readBrokerRestartIntent } from "./discovery";
import {
	BrokerHopError,
	type BrokerSpawnResult,
	resolveBrokerSpawnOptionsForProduction,
	withBrokerStartupLock,
} from "./ensure";
import { observeProcessIncarnation } from "./process-incarnation";
import { resolveSdkInternalSpawnCommand } from "./runtime";

/**
 * Resolve the hop invocation command for the current runtime (source or compiled).
 * Returns the executable path and arguments to spawn the hop process.
 */
function resolveHopInvocationForDaemonEntry(hopMessage: string): { file: string; args: string[] } {
	const brokerCmd = resolveSdkInternalSpawnCommand("broker-internal");
	if (brokerCmd.kind === "bun-source") {
		// Source mode: args are ["--no-env-file", "--config=...", cli.ts, "sdk", "broker-internal"]
		// Replace the last two with ["internal", "broker-hop", hopMessage]
		const args = [...brokerCmd.args.slice(0, -2), "internal", "broker-hop", hopMessage];
		return { file: brokerCmd.file, args };
	} else {
		// Compiled mode: file is gjc executable
		return { file: brokerCmd.file, args: ["internal", "broker-hop", hopMessage] };
	}
}

/**
 * Spawn the broker using a hop on Windows or direct spawn on POSIX.
 * Shared logic between ensure.ts and daemon-entry.ts.
 */
function spawnBrokerWithHopForDaemonEntry(
	brokerFile: string,
	brokerArgs: readonly string[],
	options: {
		env: NodeJS.ProcessEnv;
		cwd?: string;
	},
): BrokerSpawnResult {
	if (process.platform === "win32") {
		// On Windows, spawn the hop process which will spawn the real broker.
		const hopMessage = {
			command: {
				file: brokerFile,
				args: Array.from(brokerArgs),
			},
			env: options.env,
			stdio: "ignore",
		};

		const hopCmd = resolveHopInvocationForDaemonEntry(JSON.stringify(hopMessage));
		const child = spawn(hopCmd.file, hopCmd.args, {
			detached: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
			env: process.env,
		});

		return {
			process: child,
			realBrokerPid: undefined, // Will be read from hop stdout
		};
	} else {
		// On POSIX, spawn the broker directly with detached:true.
		const child = spawn(brokerFile, Array.from(brokerArgs), {
			detached: true,
			stdio: "ignore",
			env: options.env,
			...(options.cwd ? { cwd: options.cwd } : {}),
		});

		return {
			process: child,
			realBrokerPid: child.pid,
		};
	}
}

export interface AuthorizedBrokerSuccessorOptions {
	agentDir: string;
	requestId: string;
	deadlineAt: number;
	packageGeneration: string;
}

/** Typed outcome of a successor-launch attempt; never an opaque thrown message. */
export type AuthorizedBrokerSuccessorResult =
	| { kind: "adopted"; discovery: BrokerDiscovery }
	| { kind: "spawned"; discovery: BrokerDiscovery }
	| {
			kind: "refused";
			reason:
				| "deadline_elapsed"
				| "intent_not_committed"
				| "spawn_failed"
				| "spawn_exited_before_publication"
				| "publication_timeout";
			detail?: string;
	  };

const SUCCESSOR_SPAWN_POLL_MS = 25;

/**
 * Launches (or adopts) exactly one authorized successor for `requestId`.
 *
 * Holds `withBrokerStartupLock` only around the decision to spawn and the
 * detached `spawn()` call itself -- never across the successor's own
 * publication wait. The successor process (`commands/sdk.ts`'s
 * `broker-internal` branch) acquires that SAME lock during its own startup to
 * serialize against ordinary concurrent starts; holding it here while
 * blocking on that child's publication would deadlock the parent against its
 * own child. The unguarded polling loop below runs strictly after the lock
 * has been released.
 */
export async function launchAuthorizedBrokerSuccessor(
	options: AuthorizedBrokerSuccessorOptions,
): Promise<AuthorizedBrokerSuccessorResult> {
	const spawnOutcome = await withBrokerStartupLock(options.agentDir, async deadline => {
		if (Date.now() >= Math.min(deadline, options.deadlineAt))
			return { kind: "refused" as const, reason: "deadline_elapsed" as const };
		// Only a durably COMMITTED intent for this exact requestId authorizes a
		// spawn. A prepared-but-not-committed or absent intent means the owner
		// side of the protocol never reached its commit boundary, so no successor
		// may exist yet -- spawning here would double-launch a broker the owner
		// might still be about to retire cleanly on its own.
		const intent = await readBrokerRestartIntent(options.agentDir);
		if (intent?.phase !== "committed" || intent.requestId !== options.requestId)
			return { kind: "refused" as const, reason: "intent_not_committed" as const };
		const existing = await readBrokerDiscovery(options.agentDir);
		if (
			existing &&
			existing.packageGeneration === options.packageGeneration &&
			existing.restartRequestId === options.requestId
		)
			return { kind: "adopted" as const, discovery: existing };
		const command = resolveSdkInternalSpawnCommand("broker-internal");
		let child: ChildProcess;
		try {
			const brokerSpawnOpts = resolveBrokerSpawnOptionsForProduction(command.file, [
				...command.args,
				"--agent-dir",
				options.agentDir,
			]);
			const env = { ...command.env, GJC_BROKER_RESTART_REQUEST: options.requestId };

			let spawnResult: BrokerSpawnResult;
			let spawnError: Error | undefined;

			if (process.platform === "win32") {
				// On Windows, spawn the hop which will spawn the real broker.
				spawnResult = spawnBrokerWithHopForDaemonEntry(brokerSpawnOpts.file, brokerSpawnOpts.args, { env });

				const hopProcess = spawnResult.process;
				hopProcess.once("error", error => {
					spawnError ??= error;
				});

				// Read the real broker pid from the hop's stdout.
				if (hopProcess.stdout) {
					let hopStdout = "";
					hopProcess.stdout.on("data", chunk => {
						hopStdout += chunk.toString();
					});

					// Wait for the hop process to exit and parse the response.
					await new Promise<void>((resolve, reject) => {
						hopProcess.on("exit", code => {
							if (code !== 0) {
								spawnError ??= new BrokerHopError({
									exitCode: code,
									stdout: hopStdout,
									reason: `hop process exited with non-zero code ${code}`,
								});
							} else if (hopStdout.trim()) {
								try {
									const hopResponse = JSON.parse(hopStdout.trim());
									if (typeof hopResponse.pid !== "number") {
										spawnError ??= new BrokerHopError({
											exitCode: code,
											stdout: hopStdout,
											reason: `hop response missing or invalid pid: ${String(hopResponse.pid)}`,
										});
									} else {
										spawnResult.realBrokerPid = hopResponse.pid;
									}
								} catch (error) {
									spawnError ??= new BrokerHopError({
										exitCode: code,
										stdout: hopStdout,
										reason: `failed to parse hop JSON response: ${error instanceof Error ? error.message : String(error)}`,
									});
								}
							} else {
								spawnError ??= new BrokerHopError({
									exitCode: code,
									stdout: hopStdout,
									reason: "hop exited with code 0 but no response on stdout",
								});
							}
							resolve();
						});
						hopProcess.on("error", reject);
					});
				}
			} else {
				// On POSIX, spawn the broker directly.
				spawnResult = spawnBrokerWithHopForDaemonEntry(brokerSpawnOpts.file, brokerSpawnOpts.args, {
					env,
					cwd: command.kind === "bun-source" ? command.cwd : undefined,
				});

				spawnResult.process.once("error", error => {
					spawnError = error;
				});
			}

			child = spawnResult.process;
			child.unref();
			return { kind: "spawned" as const, child, spawnError: () => spawnError };
		} catch (spawnError) {
			return {
				kind: "refused" as const,
				reason: "spawn_failed" as const,
				detail: spawnError instanceof Error ? spawnError.message : String(spawnError),
			};
		}
	});
	if (spawnOutcome.kind !== "spawned") return spawnOutcome;
	const { child } = spawnOutcome;
	const until = Math.min(Date.now() + Math.max(1, options.deadlineAt - Date.now()), options.deadlineAt);
	for (;;) {
		if (spawnOutcome.spawnError())
			return {
				kind: "refused",
				reason: "spawn_failed",
				detail: spawnOutcome.spawnError()?.message,
			};
		// Break the poll loop only on spawn error or actual failure (signal or non-zero exit).
		// The detached broker runs independently after spawn.
		const failedSpawn =
			spawnOutcome.spawnError() || child.signalCode !== null || (child.exitCode !== null && child.exitCode !== 0);
		if (failedSpawn) return { kind: "refused", reason: "spawn_exited_before_publication" };
		const discovered = await readBrokerDiscovery(options.agentDir);
		if (
			discovered &&
			discovered.packageGeneration === options.packageGeneration &&
			discovered.restartRequestId === options.requestId
		)
			return { kind: "spawned", discovery: discovered };
		if (Date.now() >= until) return { kind: "refused", reason: "publication_timeout" };
		await Bun.sleep(SUCCESSOR_SPAWN_POLL_MS);
	}
}

/**
 * Positive OS-confirmed absence of the exact prior owner, distinguished from
 * every merely-inconclusive outcome (permission denial, PID reuse ambiguity,
 * missing native addon). Never treats a null/changed incarnation read alone as
 * death proof; only `observeProcessIncarnation`'s `"absent"` status counts.
 */
export function oldOwnerConfirmedExited(pid: number): boolean {
	return observeProcessIncarnation(pid).status === "absent";
}
