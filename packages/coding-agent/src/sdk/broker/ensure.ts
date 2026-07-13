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
 */
async function reapSpawnedBroker(child: ChildProcess): Promise<void> {
	const awaitExit = (): Promise<boolean> => {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		if (child.exitCode !== null || child.signalCode !== null) resolve(true);
		else {
			child.once("exit", () => resolve(true));
			child.once("error", () => resolve(true));
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
	signal("SIGTERM");
	if (await Promise.race([awaitExit(), sleep(REAP_GRACEFUL_MS).then(() => false)])) return;
	signal("SIGKILL");
	if (await Promise.race([awaitExit(), sleep(REAP_SIGKILL_CAP_MS).then(() => false)])) return;
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
		await reapSpawnedBroker(child);
		owners.delete(settings.agentDir);
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
	await stop();
	if (spawnError) throw new Error(`Failed to spawn detached SDK broker: ${spawnError.message}`);
	if (exitedBeforeDiscovery)
		throw new Error(
			`Detached SDK broker exited before discovery (code=${child.exitCode}, signal=${child.signalCode}).`,
		);
	if (discoveryError) throw discoveryError;
	throw new Error("Timed out waiting for detached SDK broker discovery.");
}
/** Test hook: returns a stop handle for the detached broker this process spawned. */
export function brokerOwnerForTest(agentDir: string): { stop: () => Promise<void> } | undefined {
	return owners.get(agentDir);
}
