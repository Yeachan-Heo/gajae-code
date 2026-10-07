import { type ChildProcess, spawn } from "node:child_process";
import { type BrokerDiscovery, readBrokerDiscovery, readBrokerRestartIntent } from "./discovery";
import { withBrokerStartupLock } from "./ensure";
import { isProcessIncarnation, observeProcessIncarnation } from "./process-incarnation";
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
		const command = resolveSdkInternalSpawnCommand(
			process.platform === "win32" ? "broker-internal" : "broker-trampoline-internal",
		);
		let child: ChildProcess;
		const isTrampoline = process.platform !== "win32";
		try {
			child = spawn(command.file, [...command.args, "--agent-dir", options.agentDir], {
				detached: true,
				stdio: isTrampoline ? ["ignore", "pipe", "ignore"] : "ignore",
				env: { ...command.env, GJC_BROKER_RESTART_REQUEST: options.requestId },
				...(command.kind === "bun-source" ? { cwd: command.cwd } : {}),
			});
		} catch (spawnError) {
			return {
				kind: "refused" as const,
				reason: "spawn_failed" as const,
				detail: spawnError instanceof Error ? spawnError.message : String(spawnError),
			};
		}
		let spawnError: Error | undefined;
		let trampolineOutput = "";
		let trampolineOutputEnded = !isTrampoline;
		if (child.stdout)
			child.stdout
				.setEncoding("utf8")
				.on("data", chunk => (trampolineOutput += chunk))
				.once("end", () => (trampolineOutputEnded = true));
		child.once("error", childError => {
			spawnError = childError;
		});
		child.unref();
		return {
			kind: "spawned" as const,
			child,
			isTrampoline,
			trampolineOutput: () => trampolineOutput,
			trampolineOutputEnded: () => trampolineOutputEnded,
			spawnError: () => spawnError,
		};
	});
	if (spawnOutcome.kind !== "spawned") return spawnOutcome;
	const { child } = spawnOutcome;
	let successorPid: number | undefined;
	let successorIncarnation: string | undefined;
	let trampolineExited = !spawnOutcome.isTrampoline;
	let trampolineExitCode: number | null = null;
	let trampolineSignal: NodeJS.Signals | null = null;
	if (spawnOutcome.isTrampoline)
		child.once("exit", (code, signal) => {
			trampolineExitCode = code;
			trampolineSignal = signal;
			trampolineExited = true;
		});
	if (spawnOutcome.isTrampoline && (child.exitCode !== null || child.signalCode !== null)) {
		trampolineExitCode = child.exitCode;
		trampolineSignal = child.signalCode;
		trampolineExited = true;
	}
	const until = Math.min(Date.now() + Math.max(1, options.deadlineAt - Date.now()), options.deadlineAt);
	for (;;) {
		if (spawnOutcome.spawnError())
			return {
				kind: "refused",
				reason: "spawn_failed",
				detail: spawnOutcome.spawnError()?.message,
			};
		if (!spawnOutcome.isTrampoline && (child.exitCode !== null || child.signalCode !== null))
			return { kind: "refused", reason: "spawn_exited_before_publication" };
		if (spawnOutcome.isTrampoline && !successorPid) {
			const report = spawnOutcome.trampolineOutput().trim();
			const match = /^(\d+)\t([^\r\n]+)$/.exec(report);
			if (match) {
				const pid = Number(match[1]);
				const incarnation = match[2];
				if (Number.isSafeInteger(pid) && pid > 0 && isProcessIncarnation(incarnation)) {
					const observed = observeProcessIncarnation(pid);
					if (observed.status === "present" && observed.incarnation === incarnation) {
						successorPid = pid;
						successorIncarnation = incarnation;
					}
				}
			}
		}
		if (successorPid) {
			const observed = observeProcessIncarnation(successorPid);
			if (
				observed.status === "absent" ||
				(observed.status === "present" && observed.incarnation !== successorIncarnation)
			)
				return { kind: "refused", reason: "spawn_exited_before_publication" };
		}
		if (spawnOutcome.isTrampoline && trampolineExited && spawnOutcome.trampolineOutputEnded() && !successorPid)
			return { kind: "refused", reason: "spawn_exited_before_publication" };
		if (spawnOutcome.isTrampoline && trampolineExited && (trampolineSignal !== null || trampolineExitCode !== 0))
			return { kind: "refused", reason: "spawn_exited_before_publication" };
		const discovered = await readBrokerDiscovery(options.agentDir);
		if (
			discovered &&
			discovered.packageGeneration === options.packageGeneration &&
			discovered.restartRequestId === options.requestId
		)
			if (!spawnOutcome.isTrampoline || (trampolineExited && spawnOutcome.trampolineOutputEnded()))
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
