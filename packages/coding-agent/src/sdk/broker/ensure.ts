import { type ChildProcess, spawn } from "node:child_process";
import { type BrokerDiscovery, readBrokerDiscovery } from "./discovery";
import { resolveSdkInternalSpawnCommand } from "./runtime";
export interface EnsureBrokerSettings {
	agentDir: string;
	heartbeatTtlMs?: number;
	/**
	 * Environment for the spawned detached broker. Defaults to `process.env`; tests
	 * that pre-start an isolated broker pass the same sanitized child env so the
	 * broker and the child that attaches to it share one owned root.
	 */
	env?: NodeJS.ProcessEnv;
}

const DISCOVERY_TIMEOUT_MS = 10_000;
// Bounded grace windows for reaping a spawned broker on failure, mirroring the
// owned-process teardown convention (SIGTERM -> grace -> SIGKILL -> hard cap).
const REAP_GRACEFUL_MS = 2_000;
const REAP_SIGKILL_CAP_MS = 2_000;
const owners = new Map<string, { stop: () => Promise<void> }>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Terminate and reap a detached broker this process spawned, targeting the exact
 * owned {@link ChildProcess} (never by name). SIGTERM escalates to SIGKILL after
 * a bounded grace window; a child still alive after SIGKILL is surfaced rather
 * than silently orphaned. Reaping is idempotent once the child has exited.
 *
 * Termination is proven only by an observed exit — an `exit`/`close` event or a
 * non-null `exitCode`/`signalCode`. A still-live child can emit `error` during
 * teardown (e.g. a transient signal-delivery failure); that is diagnostic only
 * and never counts as exit, so the escalation cannot be skipped mid-shutdown.
 */
async function reapSpawnedBroker(child: ChildProcess): Promise<void> {
	// A spawn failure (e.g. ENOENT) never created a kernel process: pid is
	// undefined and there is nothing to signal or await. The `error` event is the
	// only signal and is diagnostic here — termination trivially holds, so do not
	// run out the TERM/KILL windows or report a stuck child that never existed.
	if (child.pid === undefined) return;

	// Awaits an authoritative exit signal, never a transient `error`. Resolves on
	// an `exit`/`close` event or when the codes are already set; the caller
	// re-checks the codes after the race, so resolution alone is never proof.
	const awaitVerifiedExit = (): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else {
			child.once("exit", () => resolve());
			child.once("close", () => resolve());
		}
		return promise;
	};
	const signal = (sig: NodeJS.Signals): void => {
		try {
			child.kill(sig);
		} catch {
			// already exited between the liveness check and the kill
		}
	};
	// Observed exit is authoritative: only non-null exit/signal codes prove the
	// child is gone, regardless of which event (if any) resolved the wait.
	const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
	signal("SIGTERM");
	await Promise.race([awaitVerifiedExit(), sleep(REAP_GRACEFUL_MS)]);
	if (hasExited()) return;
	signal("SIGKILL");
	await Promise.race([awaitVerifiedExit(), sleep(REAP_SIGKILL_CAP_MS)]);
	if (hasExited()) return;
	// SIGKILL is uninterruptible; a child still alive past this bounded wait is a
	// kernel-level stuck state. Surface it rather than silently orphaning the spawn.
	throw new Error(`Detached SDK broker (pid ${child.pid}) did not exit after SIGKILL during reap.`);
}

/** Starts the detached broker entrypoint when discovery has no live owner. */
export async function ensureBroker(settings: EnsureBrokerSettings): Promise<BrokerDiscovery> {
	const existing = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
	if (existing) return existing;
	const command = resolveSdkInternalSpawnCommand("broker-internal");
	const child = spawn(command.file, [...command.args, "--agent-dir", settings.agentDir], {
		detached: true,
		stdio: "ignore",
		env: settings.env ?? process.env,
	});
	child.unref();
	let spawnError: Error | undefined;
	child.once("error", error => {
		spawnError = error;
	});
	const stop = async (): Promise<void> => {
		try {
			await reapSpawnedBroker(child);
		} finally {
			owners.delete(settings.agentDir);
		}
	};
	owners.set(settings.agentDir, { stop });
	const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
	let discoveryError: unknown;
	while (Date.now() < deadline) {
		// Fail fast: if the spawn failed or the child already exited, discovery can
		// never succeed — stop (a no-op once dead) and surface the failure instead
		// of running out the discovery timeout with an orphaned child.
		if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
		try {
			const discovered = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
			if (discovered) return discovered;
		} catch (error) {
			// A transient read failure (e.g. a half-written record) must not orphan the
			// child; remember it and keep polling. It is surfaced if discovery fails.
			discoveryError = error;
		}
		await sleep(50);
	}
	// Discovery failed (timeout, early child exit, spawn error, or unreadable
	// discovery): the spawned broker never became reachable. Terminate and reap it
	// so the failure cannot leave a detached orphan behind, then surface why.
	const exitedBeforeDiscovery = child.exitCode !== null || child.signalCode !== null;
	const failure = spawnError
		? new Error(`Failed to spawn detached SDK broker: ${spawnError.message}`)
		: exitedBeforeDiscovery
			? new Error(
					`Detached SDK broker exited before discovery (code=${child.exitCode}, signal=${child.signalCode}).`,
				)
			: discoveryError
				? discoveryError
				: new Error("Timed out waiting for detached SDK broker discovery.");
	try {
		await stop();
	} catch (cleanupError) {
		throw new AggregateError([failure, cleanupError], "SDK broker discovery and spawned broker cleanup both failed.");
	}
	throw failure;
}
/** Test hook: returns a stop handle for the detached broker this process spawned. */
export function brokerOwnerForTest(agentDir: string): { stop: () => Promise<void> } | undefined {
	return owners.get(agentDir);
}
/** Test hook: drives the detached-broker reap on a controllable child surface. */
export function reapSpawnedBrokerForTest(child: ChildProcess): Promise<void> {
	return reapSpawnedBroker(child);
}
