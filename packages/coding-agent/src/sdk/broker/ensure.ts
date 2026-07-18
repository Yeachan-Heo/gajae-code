import { type ChildProcess, spawn } from "node:child_process";
import { type BrokerDiscovery, brokerProcessIncarnation, readBrokerDiscovery } from "./discovery";
import { resolveSdkInternalSpawnCommand, type SdkInternalSpawnCommand } from "./runtime";
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
const FIXTURE_DISCOVERY_TIMEOUT_MS = 30_000;
// Bounded grace windows for reaping a spawned broker on failure, mirroring the
// owned-process teardown convention (SIGTERM -> grace -> SIGKILL -> hard cap).
const REAP_GRACEFUL_MS = 2_000;
const REAP_SIGKILL_CAP_MS = 2_000;
export interface FixtureBrokerLease {
	close(): Promise<void>;
}

export interface StartedFixtureBroker {
	discovery: BrokerDiscovery;
	lease: FixtureBrokerLease;
}

interface BrokerOwner {
	stop(): Promise<void>;
	canReuse(discovery: BrokerDiscovery | null): boolean;
	markReady(discovery: BrokerDiscovery): boolean;
}
type EnsureInitiator = "discovery" | "fixture-lease";
type EnsureOutcome =
	| { kind: "external-discovery"; discovery: BrokerDiscovery }
	| { kind: "prior-local-owner"; discovery: BrokerDiscovery; owner: BrokerOwner }
	| { kind: "local-started-discovery"; discovery: BrokerDiscovery }
	| { kind: "local-started-fixture"; discovery: BrokerDiscovery; owner: BrokerOwner };
interface EnsureInFlight {
	initiator: EnsureInitiator;
	promise: Promise<EnsureOutcome>;
	discovery: Promise<BrokerDiscovery>;
}
const owners = new Map<string, BrokerOwner>();
const ensureInFlight = new Map<string, EnsureInFlight>();
const reapErrorGuards = new WeakSet<ChildProcess>();
interface ReapTiming {
	gracefulMs: number;
	killVerifyMs: number;
}
const DEFAULT_REAP_TIMING: ReapTiming = {
	gracefulMs: REAP_GRACEFUL_MS,
	killVerifyMs: REAP_SIGKILL_CAP_MS,
};
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
async function reapSpawnedBroker(child: ChildProcess, timing: ReapTiming = DEFAULT_REAP_TIMING): Promise<void> {
	// A spawn failure (e.g. ENOENT) never created a kernel process: pid is
	// undefined and there is nothing to signal or await. The `error` event is the
	// only signal and is diagnostic here — termination trivially holds, so do not
	// run out the TERM/KILL windows or report a stuck child that never existed.
	if (child.pid === undefined) return;
	// Reaping owns repeated teardown diagnostics too. Keep exactly one error
	// listener for the retained child so a later signal-delivery error cannot
	// become an unhandled EventEmitter error after the spawn listener is consumed.
	if (!reapErrorGuards.has(child)) {
		child.on("error", () => {});
		reapErrorGuards.add(child);
	}

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
	// Observed exit is authoritative: only non-null exit/signal codes prove the
	// child is gone, regardless of which event (if any) resolved the wait.
	const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
	const signal = (sig: NodeJS.Signals): void => {
		if (hasExited()) return;
		try {
			child.kill(sig);
		} catch {
			// already exited between the liveness check and the kill
		}
	};
	if (hasExited()) return;
	signal("SIGTERM");
	await Promise.race([awaitVerifiedExit(), sleep(timing.gracefulMs)]);
	if (hasExited()) return;
	signal("SIGKILL");
	await Promise.race([awaitVerifiedExit(), sleep(timing.killVerifyMs)]);
	if (hasExited()) return;
	// SIGKILL is uninterruptible; a child still alive past this bounded wait is a
	// kernel-level stuck state. Surface it rather than silently orphaning the spawn.
	throw new Error(`Detached SDK broker (pid ${child.pid}) did not exit after SIGKILL during reap.`);
}

function registerBrokerOwner(
	agentDir: string,
	child: ChildProcess,
	timing: ReapTiming = DEFAULT_REAP_TIMING,
): BrokerOwner {
	const incarnation = child.pid === undefined ? undefined : brokerProcessIncarnation(child.pid);
	let state: "starting" | "ready" | "cleanup-unverified" = "starting";
	const matches = (discovery: BrokerDiscovery | null): boolean =>
		Boolean(
			discovery &&
				child.pid !== undefined &&
				incarnation &&
				discovery.pid === child.pid &&
				discovery.incarnation === incarnation,
		);
	const owner: BrokerOwner = {
		async stop(): Promise<void> {
			try {
				await reapSpawnedBroker(child, timing);
			} catch (error) {
				state = "cleanup-unverified";
				throw error;
			}
			if (owners.get(agentDir) === owner) owners.delete(agentDir);
		},
		canReuse(discovery): boolean {
			return state === "ready" && matches(discovery);
		},
		markReady(discovery): boolean {
			if (!matches(discovery)) return false;
			state = "ready";
			return true;
		},
	};
	owners.set(agentDir, owner);
	return owner;
}
function brokerSpawnEnvironment(command: SdkInternalSpawnCommand, override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment = { ...(override ?? command.env) };
	delete environment.BUN_OPTIONS;
	if (command.kind === "bun-source") {
		delete environment.PI_COMPILED;
		delete environment.GJC_COMPILED;
	}
	return environment;
}

function fixtureLeaseUnavailable(): Error {
	return new Error("fixture_broker_lease_unavailable");
}

function createFixtureLease(owner: BrokerOwner): FixtureBrokerLease {
	let closeAttempt: Promise<void> | undefined;
	let closed = false;
	return {
		close(): Promise<void> {
			if (closed) return Promise.resolve();
			if (closeAttempt) return closeAttempt;
			closeAttempt = owner.stop().then(
				() => {
					closed = true;
				},
				(error: unknown) => {
					closeAttempt = undefined;
					throw error;
				},
			);
			return closeAttempt;
		},
	};
}

async function ensureBrokerOnce(settings: EnsureBrokerSettings, initiator: EnsureInitiator): Promise<EnsureOutcome> {
	const priorOwner = owners.get(settings.agentDir);
	const existing = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
	if (initiator === "fixture-lease" && (priorOwner || existing)) throw fixtureLeaseUnavailable();
	if (priorOwner) {
		// A retained cleanup failure fences every discovery record. Only a ready
		// record bound to this exact child incarnation may be reused.
		if (priorOwner.canReuse(existing)) return { kind: "prior-local-owner", discovery: existing!, owner: priorOwner };
		await priorOwner.stop();
		const discoveredAfterCleanup = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
		if (discoveredAfterCleanup) return { kind: "external-discovery", discovery: discoveredAfterCleanup };
	} else if (existing) {
		return { kind: "external-discovery", discovery: existing };
	}

	const command = resolveSdkInternalSpawnCommand("broker-internal");
	const child = spawn(command.file, [...command.args, "--agent-dir", settings.agentDir], {
		detached: true,
		stdio: "ignore",
		env: brokerSpawnEnvironment(command, settings.env),
		...(command.kind === "bun-source" ? { cwd: command.cwd } : {}),
	});
	child.unref();
	let spawnError: Error | undefined;
	child.once("error", error => {
		spawnError = error;
	});
	const owner = registerBrokerOwner(settings.agentDir, child);
	const discoveryTimeoutMs = initiator === "fixture-lease" ? FIXTURE_DISCOVERY_TIMEOUT_MS : DISCOVERY_TIMEOUT_MS;
	const deadline = Date.now() + discoveryTimeoutMs;
	let discoveryError: unknown;
	while (Date.now() < deadline) {
		if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
		try {
			const discovered = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
			if (discovered) {
				if (owner.markReady(discovered)) {
					return initiator === "fixture-lease"
						? { kind: "local-started-fixture", discovery: discovered, owner }
						: { kind: "local-started-discovery", discovery: discovered };
				}
				await owner.stop();
				return { kind: "external-discovery", discovery: discovered };
			}
		} catch (error) {
			discoveryError = error;
		}
		await sleep(50);
	}
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
		await owner.stop();
	} catch (cleanupError) {
		throw new AggregateError([failure, cleanupError], "SDK broker discovery and spawned broker cleanup both failed.");
	}
	throw failure;
}

function startEnsure(settings: EnsureBrokerSettings, initiator: EnsureInitiator): EnsureInFlight {
	const promise = ensureBrokerOnce(settings, initiator);
	const discovery = promise.then(outcome => outcome.discovery);
	void discovery.catch(() => {});
	const entry = { initiator, promise, discovery };
	ensureInFlight.set(settings.agentDir, entry);
	const clear = (): void => {
		if (ensureInFlight.get(settings.agentDir) === entry) ensureInFlight.delete(settings.agentDir);
	};
	void promise.then(clear, clear);
	return entry;
}

/** Starts the detached broker entrypoint when discovery has no live owner. */
export function ensureBroker(settings: EnsureBrokerSettings): Promise<BrokerDiscovery> {
	const inFlight = ensureInFlight.get(settings.agentDir) ?? startEnsure(settings, "discovery");
	return inFlight.discovery;
}

/** Starts one fresh fixture broker and returns its sole exact-child close lease. */
export function startFixtureBrokerWithLeaseForTest(settings: EnsureBrokerSettings): Promise<StartedFixtureBroker> {
	if (ensureInFlight.has(settings.agentDir)) return Promise.reject(fixtureLeaseUnavailable());
	const inFlight = startEnsure(settings, "fixture-lease");
	return inFlight.promise.then(outcome => {
		if (outcome.kind !== "local-started-fixture") throw fixtureLeaseUnavailable();
		return { discovery: outcome.discovery, lease: createFixtureLease(outcome.owner) };
	});
}

/** Test hook: returns a stop handle for the detached broker this process spawned. */
export function brokerOwnerForTest(agentDir: string): BrokerOwner | undefined {
	return owners.get(agentDir);
}
/** Test hook: drives the detached-broker reap on a controllable child surface. */
export function reapSpawnedBrokerForTest(child: ChildProcess, timing: ReapTiming = DEFAULT_REAP_TIMING): Promise<void> {
	return reapSpawnedBroker(child, timing);
}
/** Test hook: resolves the complete broker environment without spawning. */
export function brokerSpawnEnvironmentForTest(
	command: SdkInternalSpawnCommand,
	override?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return brokerSpawnEnvironment(command, override);
}
/** Test hook: installs an exact controllable owner to exercise replacement fencing. */
export function registerBrokerOwnerForTest(
	agentDir: string,
	child: ChildProcess,
	timing: ReapTiming = DEFAULT_REAP_TIMING,
): BrokerOwner {
	return registerBrokerOwner(agentDir, child, timing);
}
