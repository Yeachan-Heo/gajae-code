import type * as childProcess from "node:child_process";
import { FileLockAcquireError } from "../../config/file-lock";
import {
	type BrokerDiscovery,
	type BrokerRestartIntentWithIdentity,
	brokerProcessIncarnation,
	readBrokerDiscovery,
	readBrokerRestartIntent,
} from "./discovery";
import {
	type BrokerLaunchHandoff,
	type BrokerLaunchResult,
	launchBrokerViaHop,
	launchBrokerViaPosixTrampoline,
	reapFailedBrokerLaunch,
	resolveBrokerLaunchMode,
	withBrokerStartupLock,
} from "./ensure";
import { observeProcessIncarnation } from "./process-incarnation";
import { resolveSdkInternalSpawnCommand } from "./runtime";

export interface AuthorizedBrokerSuccessorOptions {
	agentDir: string;
	requestId: string;
	deadlineAt: number;
	packageGeneration: string;
}

/** Typed outcome of a successor-launch attempt; never an opaque thrown message. */
export type AuthorizedBrokerSuccessorResult =
	| { kind: "adopted"; discovery: BrokerDiscovery }
	| {
			kind: "spawned";
			child: childProcess.ChildProcess;
			realBrokerPid: number | undefined;
			realBrokerIncarnation: string | undefined;
			handoff: BrokerLaunchHandoff | undefined;
			discovery: BrokerDiscovery;
	  }
	| {
			kind: "refused";
			reason:
				| "deadline_elapsed"
				| "intent_not_committed"
				| "spawn_failed"
				| "spawn_exited_before_publication"
				| "publication_timeout"
				| "startup_lock_unavailable";
			detail?: string;
	  };

type BrokerSuccessorSpawnOutcome =
	| Exclude<AuthorizedBrokerSuccessorResult, { kind: "spawned" }>
	| { kind: "retry" }
	| {
			kind: "spawned";
			child: childProcess.ChildProcess;
			realBrokerPid: number | undefined;
			realBrokerIncarnation: string | undefined;
			handoff: BrokerLaunchHandoff | undefined;
	  };

const SUCCESSOR_SPAWN_POLL_MS = 25;

class BrokerSuccessorDeadlineError extends Error {}

async function readBeforeBrokerDeadline<T>(read: Promise<T>, deadlineAt: number, message: string): Promise<T> {
	const remainingMs = deadlineAt - Date.now();
	if (remainingMs <= 0) throw new BrokerSuccessorDeadlineError(message);
	const timeout = Promise.withResolvers<T>();
	const timer = setTimeout(() => timeout.reject(new BrokerSuccessorDeadlineError(message)), remainingMs);
	try {
		return await Promise.race([read, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function refuseFailedBrokerLaunch(
	launched: BrokerLaunchResult,
): Promise<Extract<AuthorizedBrokerSuccessorResult, { kind: "refused" }>> {
	const child: childProcess.ChildProcess = launched.process;
	if (!launched.handoff) child.unref();
	let detail = launched.error?.message ?? "Broker launch failed.";
	try {
		await reapFailedBrokerLaunch(launched);
	} catch (error) {
		const cleanupDetail = error instanceof Error ? error.message : String(error);
		detail = `${detail}; retry cleanup failed: ${cleanupDetail}`;
	}
	return { kind: "refused", reason: "spawn_failed", detail };
}

async function refuseUnpublishedBrokerSuccessor(
	child: childProcess.ChildProcess,
	realBrokerPid: number | undefined,
	realBrokerIncarnation: string | undefined,
	handoff: BrokerLaunchResult["handoff"],
	reason: "spawn_exited_before_publication" | "publication_timeout",
): Promise<Extract<AuthorizedBrokerSuccessorResult, { kind: "refused" }>> {
	let detail: string | undefined;
	try {
		await reapFailedBrokerLaunch({
			process: child,
			realBrokerPid,
			realBrokerIncarnation,
			handoff,
		});
	} catch (error) {
		detail = `Broker successor cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	return { kind: "refused", reason, ...(detail === undefined ? {} : { detail }) };
}

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
	let spawnOutcome: BrokerSuccessorSpawnOutcome;
	let successorDeadlineAt = options.deadlineAt;
	let startupLockFailure: FileLockAcquireError | undefined;
	for (;;) {
		if (Date.now() >= successorDeadlineAt)
			return startupLockFailure
				? { kind: "refused", reason: "startup_lock_unavailable", detail: startupLockFailure.message }
				: { kind: "refused", reason: "deadline_elapsed" };
		try {
			spawnOutcome = await withBrokerStartupLock(
				options.agentDir,
				async deadline => {
					const operationDeadlineAt = Math.min(deadline, successorDeadlineAt);
					const deadlineOutcome = (): BrokerSuccessorSpawnOutcome =>
						operationDeadlineAt < successorDeadlineAt && Date.now() < successorDeadlineAt
							? { kind: "retry" }
							: { kind: "refused", reason: "deadline_elapsed" };
					if (Date.now() >= operationDeadlineAt) return deadlineOutcome();
					// A matching published owner proves this request already succeeded; the
					// broker may have cleared its committed intent after publication.
					let existing: BrokerDiscovery | null;
					try {
						existing = await readBeforeBrokerDeadline(
							readBrokerDiscovery(options.agentDir),
							operationDeadlineAt,
							"Timed out reading broker discovery before successor expiry.",
						);
					} catch (error) {
						if (error instanceof BrokerSuccessorDeadlineError) return deadlineOutcome();
						throw error;
					}
					if (Date.now() >= operationDeadlineAt) return deadlineOutcome();
					if (
						existing &&
						existing.packageGeneration === options.packageGeneration &&
						existing.restartRequestId === options.requestId
					)
						return { kind: "adopted" as const, discovery: existing };
					// Only a durably COMMITTED intent for this exact requestId authorizes a
					// new spawn. Re-read it on every lock attempt so a retry cannot use stale
					// authorization or launch a duplicate successor.
					let intent: BrokerRestartIntentWithIdentity | null;
					try {
						intent = await readBeforeBrokerDeadline(
							readBrokerRestartIntent(options.agentDir),
							operationDeadlineAt,
							"Timed out validating the successor restart intent.",
						);
					} catch (error) {
						if (error instanceof BrokerSuccessorDeadlineError) return deadlineOutcome();
						throw error;
					}
					if (Date.now() >= operationDeadlineAt) return deadlineOutcome();
					if (intent?.phase !== "committed" || intent.requestId !== options.requestId)
						return { kind: "refused" as const, reason: "intent_not_committed" as const };
					if (intent.expiresAt <= Date.now())
						return { kind: "refused" as const, reason: "deadline_elapsed" as const };
					successorDeadlineAt = Math.min(successorDeadlineAt, intent.expiresAt);
					if (Date.now() >= successorDeadlineAt)
						return { kind: "refused" as const, reason: "deadline_elapsed" as const };
					const command = resolveSdkInternalSpawnCommand("broker-internal");
					try {
						const env = {
							...command.env,
							GJC_BROKER_RESTART_REQUEST: options.requestId,
							GJC_BROKER_RESTART_DEADLINE: String(intent.expiresAt),
						};
						const launchMode = resolveBrokerLaunchMode(process.platform, "discovery");
						if (launchMode === "direct") throw new Error("Broker successor launch cannot use a fixture child.");
						const timeoutMs = Math.max(0, Math.min(deadline, successorDeadlineAt) - Date.now());
						const launched =
							launchMode === "windows-hop"
								? await launchBrokerViaHop(
										{
											command: {
												file: command.file,
												args: [...command.args, "--agent-dir", options.agentDir],
											},
											...(command.kind === "bun-source" ? { cwd: command.cwd } : {}),
										},
										{
											env,
											cwd: command.kind === "bun-source" ? command.cwd : undefined,
											timeoutMs,
										},
									)
								: await launchBrokerViaPosixTrampoline(options.agentDir, {
										env,
										...(command.kind === "bun-source" ? { cwd: command.cwd } : {}),
										timeoutMs,
										retainChildUntilPublication: launchMode === "darwin-trampoline",
									});
						if (launched.error) return await refuseFailedBrokerLaunch(launched);
						if (launched.realBrokerPid === undefined || launched.realBrokerIncarnation === undefined)
							return await refuseFailedBrokerLaunch({
								...launched,
								error: new Error("Broker launcher returned no verified process identity."),
							});
						const child: childProcess.ChildProcess = launched.process;
						if (!launched.handoff) child.unref();
						return {
							kind: "spawned" as const,
							child,
							realBrokerPid: launched.realBrokerPid,
							realBrokerIncarnation: launched.realBrokerIncarnation,
							handoff: launched.handoff,
						};
					} catch (spawnError) {
						return {
							kind: "refused" as const,
							reason: "spawn_failed" as const,
							detail: spawnError instanceof Error ? spawnError.message : String(spawnError),
						};
					}
				},
				{ deadlineAt: options.deadlineAt },
			);
			startupLockFailure = undefined;
			if (spawnOutcome.kind === "retry") {
				// The validation read exhausted this short lock operation, not the
				// committed lease. The lock has been released; revalidate under a fresh
				// operation window while the request is still authorized.
				const remainingMs = successorDeadlineAt - Date.now();
				if (remainingMs > 0) await Bun.sleep(Math.min(SUCCESSOR_SPAWN_POLL_MS, remainingMs));
				continue;
			}
			break;
		} catch (lockError) {
			if (!(lockError instanceof FileLockAcquireError)) throw lockError;
			startupLockFailure = lockError;
			if (Date.now() >= successorDeadlineAt)
				return { kind: "refused", reason: "startup_lock_unavailable", detail: lockError.message };
			await Bun.sleep(Math.min(50, options.deadlineAt - Date.now()));
		}
	}
	if (spawnOutcome.kind !== "spawned") return spawnOutcome;
	const { child } = spawnOutcome;
	const realBrokerPid = spawnOutcome.realBrokerPid ?? child.pid;
	let expectedBrokerIncarnation =
		spawnOutcome.realBrokerIncarnation ??
		(realBrokerPid !== undefined && realBrokerPid === child.pid
			? brokerProcessIncarnation(realBrokerPid)
			: undefined);
	const until = Math.min(Date.now() + Math.max(1, successorDeadlineAt - Date.now()), successorDeadlineAt);
	for (;;) {
		if (Date.now() >= until)
			return await refuseUnpublishedBrokerSuccessor(
				child,
				realBrokerPid,
				expectedBrokerIncarnation,
				spawnOutcome.handoff,
				"publication_timeout",
			);
		// On Darwin the trampoline remains alive until publication; elsewhere the
		// launcher exits after handoff. The broker identity remains authoritative.
		const failedSpawn = child.signalCode !== null || (child.exitCode !== null && child.exitCode !== 0);
		if (failedSpawn)
			return await refuseUnpublishedBrokerSuccessor(
				child,
				realBrokerPid,
				expectedBrokerIncarnation,
				spawnOutcome.handoff,
				"spawn_exited_before_publication",
			);
		if (realBrokerPid !== undefined) {
			const observation = observeProcessIncarnation(realBrokerPid);
			if (
				observation.status === "absent" ||
				(observation.status === "present" &&
					expectedBrokerIncarnation !== undefined &&
					observation.incarnation !== expectedBrokerIncarnation)
			)
				return await refuseUnpublishedBrokerSuccessor(
					child,
					realBrokerPid,
					expectedBrokerIncarnation,
					spawnOutcome.handoff,
					"spawn_exited_before_publication",
				);
			if (
				observation.status === "present" &&
				expectedBrokerIncarnation === undefined &&
				realBrokerPid === child.pid
			) {
				expectedBrokerIncarnation = observation.incarnation;
			}
		}
		let discovered: BrokerDiscovery | null;
		try {
			discovered = await readBeforeBrokerDeadline(
				readBrokerDiscovery(options.agentDir),
				until,
				"Timed out waiting for broker discovery before successor expiry.",
			);
		} catch (error) {
			if (!(error instanceof BrokerSuccessorDeadlineError)) throw error;
			return await refuseUnpublishedBrokerSuccessor(
				child,
				realBrokerPid,
				expectedBrokerIncarnation,
				spawnOutcome.handoff,
				"publication_timeout",
			);
		}
		if (
			discovered &&
			discovered.pid === realBrokerPid &&
			discovered.incarnation === expectedBrokerIncarnation &&
			discovered.packageGeneration === options.packageGeneration &&
			discovered.restartRequestId === options.requestId
		) {
			if (Date.now() >= until)
				return await refuseUnpublishedBrokerSuccessor(
					child,
					realBrokerPid,
					expectedBrokerIncarnation,
					spawnOutcome.handoff,
					"publication_timeout",
				);
			try {
				await spawnOutcome.handoff?.release();
			} catch (error) {
				const refusal = await refuseUnpublishedBrokerSuccessor(
					child,
					realBrokerPid,
					expectedBrokerIncarnation,
					spawnOutcome.handoff,
					"spawn_exited_before_publication",
				);
				return {
					...refusal,
					detail: `Broker successor release failed: ${error instanceof Error ? error.message : String(error)}${
						refusal.detail ? `; ${refusal.detail}` : ""
					}`,
				};
			}
			return {
				kind: "spawned" as const,
				child,
				realBrokerPid,
				realBrokerIncarnation: expectedBrokerIncarnation,
				handoff: spawnOutcome.handoff,
				discovery: discovered,
			};
		}
		if (Date.now() >= until)
			return await refuseUnpublishedBrokerSuccessor(
				child,
				realBrokerPid,
				expectedBrokerIncarnation,
				spawnOutcome.handoff,
				"publication_timeout",
			);
		await Bun.sleep(SUCCESSOR_SPAWN_POLL_MS);
	}
}

/** Test hook: retries exact cleanup before mapping a launch error to refusal. */
export function refuseFailedBrokerLaunchForTest(
	launched: BrokerLaunchResult,
): Promise<Extract<AuthorizedBrokerSuccessorResult, { kind: "refused" }>> {
	return refuseFailedBrokerLaunch(launched);
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
