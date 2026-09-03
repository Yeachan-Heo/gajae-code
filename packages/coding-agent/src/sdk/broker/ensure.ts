import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import path from "node:path";
import packageJson from "../../../package.json" with { type: "json" };
import { SdkClient } from "../client/client";
import { acquireFileLock, type FileLockOptions, withFileLock } from "../../config/file-lock";
import { type BrokerDiscovery, brokerProcessIncarnation, readBrokerDiscovery } from "./discovery";
import { resolveSdkInternalSpawnCommand, type SdkInternalSpawnCommand } from "./runtime";
import { BrokerStartupError, clearBrokerStartupFailureMarker, readBrokerStartupFailureMarker } from "./startup-failure";

function resolveExpectedBrokerGeneration(): string {
	const v = (packageJson as { version?: unknown }).version;
	return typeof v === "string" && v.length > 0 ? v : "unknown";
}

function isBrokerGenerationCompatible(discovery: BrokerDiscovery | null): boolean {
	if (!discovery) return false;
	return discovery.packageGeneration === resolveExpectedBrokerGeneration();
}
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
/** A process that loses the spawn lock waits this long for the winner's discovery before giving up. */
const SPAWN_LOCK_WAIT_MS = DISCOVERY_TIMEOUT_MS + 5_000;
const SPAWN_LOCK_RETRY_DELAY_MS = 50;
const SPAWN_LOCK_TARGET_NAME = "broker.spawn";
const STARTUP_LOCK_WAIT_MS = DISCOVERY_TIMEOUT_MS - 1_000;
const STARTUP_LOCK_TARGET_NAME = "broker.startup";

type SpawnLockOptions = Pick<FileLockOptions, "retries" | "retryDelayMs" | "signal">;

/**
 * Cross-process single-flight for the detached broker spawn (#5198).
 *
 * `ensureInFlight` only dedupes within one process. Every CLI invocation is
 * its own process, so N concurrent invocations that all miss discovery each
 * spawn a broker; the losers of the runtime's ownership lock then leave
 * quarantine tombstones behind and the next start fails with
 * `quarantine_collision`. The spawn itself must be exclusive across process
 * death and PID reuse, so it uses the shared identity-bound file-lock protocol:
 * complete owner metadata is published atomically, stale removal is bound to
 * the exact directory generation, and ownership includes the OS incarnation.
 */
async function acquireSpawnLock(agentDir: string, options: SpawnLockOptions = {}): Promise<() => Promise<void>> {
	return acquireFileLock(path.join(agentDir, "sdk", SPAWN_LOCK_TARGET_NAME), {
		retries: Math.ceil(SPAWN_LOCK_WAIT_MS / SPAWN_LOCK_RETRY_DELAY_MS),
		retryDelayMs: SPAWN_LOCK_RETRY_DELAY_MS,
		...options,
	});
}

/**
 * Child-owned fence for the interval from bootstrap through discovery publication.
 * The parent-held spawn lock prevents ordinary stampedes; this second fence keeps
 * startup single-flight if that detached child's launcher dies and its lock is reclaimed.
 */
export function withBrokerStartupLock<T>(agentDir: string, operation: () => Promise<T>): Promise<T> {
	return withFileLock(path.join(agentDir, "sdk", STARTUP_LOCK_TARGET_NAME), operation, {
		retries: Math.ceil(STARTUP_LOCK_WAIT_MS / SPAWN_LOCK_RETRY_DELAY_MS),
		retryDelayMs: SPAWN_LOCK_RETRY_DELAY_MS,
	});
}
const FIXTURE_DISCOVERY_TIMEOUT_MS = 30_000;
// Bounded grace windows for reaping a spawned broker on failure, mirroring the
// owned-process teardown convention (SIGTERM -> grace -> SIGKILL -> hard cap).
const REAP_GRACEFUL_MS = 2_000;
const REAP_SIGKILL_CAP_MS = 2_000;

/**
 * Tail of the detached broker's stderr folded into a discovery failure.
 *
 * The broker used to spawn with `stdio: "ignore"`, so a broker that exited
 * cleanly told the caller nothing beyond `code=0` (#3963). Its stderr goes to a
 * file instead of a pipe because the child is detached and outlives this
 * process: a pipe would break under it the moment the parent exits.
 */
export const BROKER_SPAWN_LOG_TAIL_BYTES = 4_096;

export interface BrokerSpawnLog {
	path: string;
	handle: FileHandle;
}

function brokerSpawnLogPath(agentDir: string): string {
	return path.join(agentDir, "sdk", `broker-spawn.${randomUUID()}.log`);
}

/** Opens an isolated, bounded-lifetime diagnostic sink for one broker spawn. */
export async function openBrokerSpawnLog(agentDir: string): Promise<BrokerSpawnLog | undefined> {
	try {
		await fs.mkdir(path.join(agentDir, "sdk"), { recursive: true, mode: 0o700 });
		const spawnLogPath = brokerSpawnLogPath(agentDir);
		return { path: spawnLogPath, handle: await fs.open(spawnLogPath, "w", 0o600) };
	} catch {
		// Diagnostics are never allowed to block a broker spawn.
		return undefined;
	}
}

export async function readBrokerSpawnLogTail(spawnLogPath: string): Promise<string> {
	try {
		const file = Bun.file(spawnLogPath);
		const size = file.size;
		if (!Number.isFinite(size) || size <= 0) return "";
		const tail = size > BROKER_SPAWN_LOG_TAIL_BYTES ? file.slice(size - BROKER_SPAWN_LOG_TAIL_BYTES) : file;
		return (await tail.text()).trim();
	} catch {
		return "";
	}
}

async function removeBrokerSpawnLog(spawnLogPath: string): Promise<void> {
	try {
		await fs.unlink(spawnLogPath);
	} catch {
		// Diagnostics are best-effort and must not affect broker ownership.
	}
}
export interface FixtureBrokerLease {
	/** Backward-compatible fixture cleanup alias for exact child termination. */
	close(): Promise<void>;
}

export interface ExactFixtureBrokerLease extends FixtureBrokerLease {
	/** Observes the retained child only; it never signals a process. */
	waitForExit(timeoutMs: number): Promise<boolean>;
	/** Signals only the retained ChildProcess, never a discovery-derived PID. */
	terminateExactChild(): Promise<void>;
}

export interface FixtureBrokerCommand {
	file: string;
	args: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface StartedFixtureBrokerCommand {
	lease: ExactFixtureBrokerLease;
	control: NodeJS.WritableStream;
}

export interface StartedFixtureBroker {
	discovery: BrokerDiscovery;
	lease: ExactFixtureBrokerLease;
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
	| { kind: "local-started-fixture"; discovery: BrokerDiscovery; owner: BrokerOwner; child: ChildProcess };
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
	// The master capability is a transient in-memory dispatch input. A broker
	// cold-started from the master's own Bash environment would otherwise inherit
	// it and pass it on to every substrate child it later launches, so it is
	// stripped at the lifecycle boundary exactly as lifecycle children strip it.
	delete environment.GJC_MASTER_CAPABILITY;
	if (command.kind === "bun-source") {
		delete environment.PI_COMPILED;
		delete environment.GJC_COMPILED;
	}
	return environment;
}

function fixtureLeaseUnavailable(): Error {
	return new Error("fixture_broker_lease_unavailable");
}

const STALE_BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;
const STALE_BROKER_POLL_MS = 50;

type BrokerOwnerIdentity = Pick<BrokerDiscovery, "ownerId" | "pid" | "incarnation">;

function sameBrokerOwner(left: BrokerOwnerIdentity | null, right: BrokerOwnerIdentity): boolean {
	return Boolean(
		left && left.ownerId === right.ownerId && left.pid === right.pid && left.incarnation === right.incarnation,
	);
}

async function retireStaleBrokerGeneration(stale: BrokerDiscovery, settings: EnsureBrokerSettings): Promise<void> {
	let shutdownSucceeded = false;
	try {
		const current = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
		if (!current || !sameBrokerOwner(current, stale)) return;
		const client = await SdkClient.connect(current.url, current.token, { timeoutMs: 2_000 });
		try {
			await client.global("broker.shutdown", {});
			shutdownSucceeded = true;
		} finally {
			await client.close().catch(() => {});
		}
	} catch {}
	if (!shutdownSucceeded) {
		try {
			if (brokerProcessIncarnation(stale.pid) === stale.incarnation) {
				try {
					process.kill(stale.pid, "SIGTERM");
				} catch {}
			}
		} catch {}
	}
	// Wait for the stale identity to disappear (owner-fenced: pid+incarnation).
	const deadline = Date.now() + STALE_BROKER_SHUTDOWN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const current = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
		if (!sameBrokerOwner(current, stale)) break;
		await sleep(STALE_BROKER_POLL_MS);
	}
}
function createFixtureLeaseFromChild(child: ChildProcess, terminate: () => Promise<void>): ExactFixtureBrokerLease {
	let termination: Promise<void> | undefined;
	const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
	const waitForExit = (timeoutMs: number): Promise<boolean> => {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
			return Promise.reject(new Error("Invalid fixture broker exit timeout."));
		if (hasExited()) return Promise.resolve(true);
		return new Promise(resolve => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onExit = (): void => finish(true);
			const finish = (exited: boolean): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				child.off("exit", onExit);
				child.off("close", onExit);
				resolve(exited && hasExited());
			};
			timer = setTimeout(() => finish(false), timeoutMs);
			child.once("exit", onExit);
			child.once("close", onExit);
			if (hasExited()) finish(true);
		});
	};
	return {
		waitForExit,
		terminateExactChild(): Promise<void> {
			if (!termination) termination = terminate();
			return termination;
		},
		close(): Promise<void> {
			if (!termination) termination = terminate();
			return termination;
		},
	};
}

function createFixtureLease(owner: BrokerOwner, child: ChildProcess): ExactFixtureBrokerLease {
	return createFixtureLeaseFromChild(child, () => owner.stop());
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
		if (discoveredAfterCleanup && isBrokerGenerationCompatible(discoveredAfterCleanup))
			return { kind: "external-discovery", discovery: discoveredAfterCleanup };
		// A stale-generation discovery after cleanup must not be reused — fall through to replacement.
		if (!discoveredAfterCleanup) {
			// no discovery left after cleanup — fall through to spawn
		} else {
			await retireStaleBrokerGeneration(discoveredAfterCleanup, settings);
			const afterRetire = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
			if (afterRetire && isBrokerGenerationCompatible(afterRetire))
				return { kind: "external-discovery", discovery: afterRetire };
		}
	} else if (existing) {
		if (isBrokerGenerationCompatible(existing)) return { kind: "external-discovery", discovery: existing };
		await retireStaleBrokerGeneration(existing, settings);
		const afterRetire = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
		if (afterRetire && isBrokerGenerationCompatible(afterRetire))
			return { kind: "external-discovery", discovery: afterRetire };
	}

	// Only one process may spawn for this agent dir at a time; everyone else
	// waits for the exact lock generation to release, then rechecks discovery.
	// Fixture leases always spawn their own.
	let spawnLog: BrokerSpawnLog | undefined;
	const releaseSpawnLock = initiator === "fixture-lease" ? async () => {} : await acquireSpawnLock(settings.agentDir);
	try {
		// The lock winner may still find a discovery published by an earlier winner
		// that finished between our first read and the lock acquisition.
		const discoveredUnderLock = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
		if (discoveredUnderLock) return { kind: "external-discovery", discovery: discoveredUnderLock };
		const command = resolveSdkInternalSpawnCommand("broker-internal");
		spawnLog = await openBrokerSpawnLog(settings.agentDir);
		// A stale marker must never be misattributed to this spawn; clear it first.
		await clearBrokerStartupFailureMarker(settings.agentDir);
		const child = spawn(command.file, [...command.args, "--agent-dir", settings.agentDir], {
			detached: true,
			stdio: ["ignore", "ignore", spawnLog ? spawnLog.handle.fd : "ignore"],
			env: brokerSpawnEnvironment(command, settings.env),
			...(command.kind === "bun-source" ? { cwd: command.cwd } : {}),
		});
		let spawnError: Error | undefined;
		child.once("error", error => {
			spawnError = error;
		});
		const owner = registerBrokerOwner(settings.agentDir, child);
		child.unref();
		// The child holds its own duplicate of the descriptor. Failure to close the
		// parent's diagnostic handle must not discard exact ownership of a live child.
		await spawnLog?.handle.close().catch(() => undefined);
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
							? { kind: "local-started-fixture", discovery: discovered, owner, child }
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
		if (exitedBeforeDiscovery && child.exitCode === 0) {
			// A clean exit means another broker won the ownership lock (two ACP
			// processes racing a cold broker state, e.g. a provider probe and an
			// agent launch). The winner may publish its discovery right after our
			// last poll; reuse it instead of failing the caller. Transient discovery
			// read failures fall through to the common cleanup + failure path below.
			try {
				for (let retry = 0; retry < 20; retry++) {
					const winner = await readBrokerDiscovery(settings.agentDir, settings.heartbeatTtlMs);
					if (winner) {
						await owner.stop();
						return { kind: "external-discovery", discovery: winner };
					}
					await sleep(50);
				}
			} catch {
				// fall through to cleanup + failure
			}
		}
		const spawnLogTail = exitedBeforeDiscovery && spawnLog ? await readBrokerSpawnLogTail(spawnLog.path) : "";
		const marker = await readBrokerStartupFailureMarker(settings.agentDir);
		// A marker only wins over the generic fallback when it was written by the
		// exact child this call just spawned and reaped. The pre-spawn clear
		// already prevents an old marker from surviving to this point, but a
		// concurrent broker (a foreign process racing the same agent dir) could
		// still write a marker between the clear and this read; the pid binding
		// rejects that marker instead of misattributing a foreign failure to this
		// spawn's caller.
		const trustedMarker = marker && child.pid !== undefined && marker.pid === child.pid ? marker : undefined;
		const failure = spawnError
			? new Error(`Failed to spawn detached SDK broker: ${spawnError.message}`)
			: exitedBeforeDiscovery
				? new BrokerStartupError({
						exitCode: child.exitCode,
						signal: child.signalCode,
						reason: trustedMarker?.reason ?? "Detached SDK broker exited before publishing discovery.",
						stderrExcerpt: spawnLogTail.length > 0 ? spawnLogTail : undefined,
					})
				: discoveryError
					? discoveryError
					: new Error("Timed out waiting for detached SDK broker discovery.");
		try {
			await owner.stop();
		} catch (cleanupError) {
			throw new AggregateError(
				[failure, cleanupError],
				"SDK broker discovery and spawned broker cleanup both failed.",
			);
		}
		throw failure;
	} finally {
		if (spawnLog) await removeBrokerSpawnLog(spawnLog.path);
		await releaseSpawnLock();
	}
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
		return { discovery: outcome.discovery, lease: createFixtureLease(outcome.owner, outcome.child) };
	});
}

/**
 * Test-only launch surface for topology fixtures. It accepts an already-resolved
 * command and retains the exact spawned child; no production selection path
 * reaches this function.
 */
export function startFixtureBrokerCommandWithLeaseForTest(command: FixtureBrokerCommand): StartedFixtureBrokerCommand {
	if (!command.file || !Array.isArray(command.args)) throw new Error("Invalid fixture broker command.");
	const child = spawn(command.file, [...command.args], {
		cwd: command.cwd,
		detached: true,
		stdio: ["ignore", "ignore", "ignore", "pipe"],
		env: command.env,
	});
	child.unref();
	let spawnError: Error | undefined;
	child.once("error", error => {
		spawnError = error;
	});
	const control = child.stdio[3];
	if (!control || typeof (control as NodeJS.WritableStream).write !== "function") {
		try {
			if (!child.kill("SIGKILL"))
				throw new Error(
					"Fixture broker fd 3 is unavailable and the exact child could not be synchronously terminated.",
				);
		} catch (reapError) {
			throw new AggregateError(
				[reapError],
				"Fixture broker fd 3 is unavailable and the exact child could not be synchronously terminated.",
			);
		}
		if (spawnError) throw new Error(`Failed to spawn fixture broker: ${spawnError.message}`);
		throw new Error("Fixture broker fd 3 is unavailable.");
	}
	return {
		lease: createFixtureLeaseFromChild(child, async () => {
			await reapSpawnedBroker(child);
			if (spawnError) throw new Error(`Failed to spawn fixture broker: ${spawnError.message}`);
		}),
		control: control as NodeJS.WritableStream,
	};
}

/** Test hook: returns a stop handle for the detached broker this process spawned. */
export const acquireSpawnLockForTest = acquireSpawnLock;

export function brokerOwnerForTest(agentDir: string): BrokerOwner | undefined {
	return owners.get(agentDir);
}
/** Test hook: verifies the complete broker owner identity used during stale retirement. */
export function brokerOwnerIdentityMatchesForTest(
	left: BrokerOwnerIdentity | null,
	right: BrokerOwnerIdentity,
): boolean {
	return sameBrokerOwner(left, right);
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
