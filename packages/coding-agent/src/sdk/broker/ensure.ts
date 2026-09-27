import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import path from "node:path";
import packageJson from "../../../package.json" with { type: "json" };
import { acquireFileLock, type FileLockOptions, withFileLock } from "../../config/file-lock";
import { loadInstallationHostId, loadLegacyInstallationHostId } from "../../config/machine-identity";
import { SdkClient } from "../client/client";
import { type BrokerStartupExitRecord, clearBrokerStartupExitRecord, readBrokerStartupExitRecord } from "./broker-exit";
import {
	type BrokerDiscovery,
	brokerProcessIncarnation,
	isPidAlive,
	readBrokerDiscovery,
	readBrokerRestartIntent,
} from "./discovery";
import {
	isSdkInternalRuntimeImagePresent,
	resolveSdkInternalSpawnCommand,
	type SdkInternalSpawnCommand,
} from "./runtime";
import {
	BrokerStartupError,
	type BrokerStartupFailureMarker,
	brokerStartupFailureCleanupTargetsLock,
	clearBrokerStartupFailureMarker,
	readBrokerStartupFailureMarker,
} from "./startup-failure";

/**
 * Result of spawning a broker via hop (Windows) or direct (POSIX).
 * On Windows, the hop writes the real broker's pid to stdout as JSON.
 * On POSIX, the child process is the real broker.
 */
export interface BrokerSpawnResult {
	/** The hop or broker process. On Windows, this exits immediately; on POSIX, this is the broker. */
	process: ChildProcess;
	/** The real broker's pid (from hop stdout on Windows, or child.pid on POSIX). */
	realBrokerPid: number | undefined;
	/** On Windows only: the parsed hop response if available. */
	hopResponse?: { pid: number };
}

/**
 * Typed error returned when a Windows broker hop fails.
 * The hop is mandatory on Windows for broker detachment; failure is unrecoverable.
 */
export class BrokerHopError extends Error {
	readonly code = "broker_hop_failed";
	readonly hopExitCode: number | null;
	readonly hopStdout: string;
	readonly reason: string;

	constructor(fields: { exitCode: number | null; stdout: string; reason: string }) {
		super(`Windows broker hop failed: ${fields.reason}`);
		this.name = "BrokerHopError";
		this.hopExitCode = fields.exitCode;
		this.hopStdout = fields.stdout;
		this.reason = fields.reason;
	}
}

/**
 * On Windows, spawn a hop process that will spawn the real broker with detached:true.
 * On POSIX, spawn the broker directly with detached:true.
 *
 * The hop design allows the Windows broker to survive parent termination because the
 * hop exits immediately after spawning the broker, breaking the process tree chain.
 * Without the hop, a broker spawned with detached:true is still killed by taskkill /T /F
 * because it walks ParentProcessId even for detached processes.
 */
function resolveBrokerSpawnOptions(file: string, args: readonly string[]): { file: string; args: string[] } {
	return { file, args: Array.from(args) };
}

/**
 * Resolve the hop invocation command for the current runtime (source or compiled).
 * Returns the executable path and arguments to spawn the hop process.
 */
function resolveHopInvocation(hopMessage: string): { file: string; args: string[] } {
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
 * Spawn the broker, using a hop on Windows or direct spawn on POSIX.
 * Returns the spawned process and the real broker's pid.
 */
function spawnBrokerWithHop(
	brokerFile: string,
	brokerArgs: readonly string[],
	options: {
		stdioFd?: number;
		env: NodeJS.ProcessEnv;
		cwd?: string;
	},
): BrokerSpawnResult {
	// POSIX: spawn the broker directly with detached:true.
	const child = spawn(brokerFile, Array.from(brokerArgs), {
		detached: true,
		stdio: ["ignore", "ignore", options.stdioFd ?? "ignore"],
		env: options.env,
		...(options.cwd ? { cwd: options.cwd } : {}),
	});
	return { process: child, realBrokerPid: child.pid };
}

/** What the parent sends the Windows hop. The broker environment is never serialized here. */
export interface BrokerHopMessage {
	command: { file: string; args: string[] };
	cwd?: string;
	/** Path (never an inherited fd number) the hop opens for the broker's stderr. */
	stderrLogPath?: string;
}

export interface BrokerHopLaunch {
	process: ChildProcess;
	realBrokerPid: number | undefined;
	error: Error | undefined;
}

/**
 * Windows only: launch the broker through the internal hop and await its reply.
 *
 * `taskkill /T /F` walks ParentProcessId, so a broker spawned directly by the client
 * dies with it even when detached. The hop spawns the broker and exits at once,
 * leaving the broker without a live parent in the client's tree. The broker
 * environment reaches the hop as its own process environment (the broker inherits
 * it), never on the command line, and stderr is passed as a path because a parent
 * fd number does not exist inside the hop.
 */
export async function launchBrokerViaHop(
	message: BrokerHopMessage,
	options: { env: NodeJS.ProcessEnv; cwd?: string },
): Promise<BrokerHopLaunch> {
	const hopCmd = resolveHopInvocation(JSON.stringify(message));
	const hop = spawn(hopCmd.file, hopCmd.args, {
		detached: false,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: options.env,
		...(options.cwd ? { cwd: options.cwd } : {}),
	});
	let stdout = "";
	hop.stdout?.on("data", chunk => {
		stdout += chunk.toString();
	});
	hop.stderr?.resume();
	const outcome = await new Promise<{ code: number | null; spawnError?: Error }>(resolve => {
		hop.once("error", spawnError => resolve({ code: null, spawnError }));
		hop.once("close", code => resolve({ code }));
	});
	return { process: hop, ...parseBrokerHopReply(outcome.code, stdout, outcome.spawnError) };
}

/** Parses the hop's single-line `{"pid":N}` reply into a broker pid or a typed error. */
export function parseBrokerHopReply(
	code: number | null,
	stdout: string,
	spawnError?: Error,
): { realBrokerPid: number | undefined; error: Error | undefined } {
	const fail = (reason: string) => ({
		realBrokerPid: undefined,
		error: new BrokerHopError({ exitCode: code, stdout, reason }),
	});
	if (spawnError) return fail(`hop could not be spawned: ${spawnError.message}`);
	if (code !== 0) return fail(`hop process exited with non-zero code ${code}`);
	const line = stdout.trim();
	if (!line) return fail("hop exited with code 0 but no response on stdout");
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch (error) {
		return fail(`failed to parse hop JSON response: ${error instanceof Error ? error.message : String(error)}`);
	}
	const pid = (reply as { pid?: unknown } | null)?.pid;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
		return fail(`hop response missing or invalid pid: ${String(pid)}`);
	return { realBrokerPid: pid, error: undefined };
}

function resolveExpectedBrokerGeneration(): string {
	const v = (packageJson as { version?: unknown }).version;
	return typeof v === "string" && v.length > 0 ? v : "unknown";
}

function brokerStartupFailureReason(marker: BrokerStartupFailureMarker | undefined): string {
	if (!marker) return "Detached SDK broker exited before publishing discovery.";
	if (marker.cleanupCommand && marker.reason.endsWith(": ")) return `${marker.reason}${marker.cleanupCommand}`;
	return marker.reason;
}

function brokerStartupExitReason(record: BrokerStartupExitRecord | undefined): string | undefined {
	if (!record) return undefined;
	if (record.reason === "startup-deadline")
		return `SDK broker startup exceeded its ${record.timeoutMs}ms fence deadline.`;
	return `SDK broker startup interrupted by ${record.signal} before readiness.`;
}

export function isBrokerGenerationCompatible(discovery: BrokerDiscovery | null): boolean {
	if (!discovery) return false;
	return discovery.packageGeneration === resolveExpectedBrokerGeneration();
}

/**
 * A live incumbent stops being reusable once the runtime image it launches
 * internal processes with is provably gone. A broker outlives its own executable
 * (a package manager replacing the interpreter it was started from, an install
 * directory swapped underneath it): it keeps heartbeating and answering
 * requests, but every `session.create` it accepts is refused at spawn time.
 * Retiring it here repairs the endpoint before a caller reaches session
 * creation. Absent runtime evidence -- a record predating the field, or a
 * publisher that could not classify its own runtime at all -- and evidence this
 * caller merely cannot inspect both keep the incumbent reusable.
 */
export async function isBrokerReusable(discovery: BrokerDiscovery | null): Promise<boolean> {
	if (!isBrokerGenerationCompatible(discovery)) return false;
	const runtime = discovery?.runtime;
	return runtime === undefined || (await isSdkInternalRuntimeImagePresent(runtime));
}
export interface EnsureBrokerSettings {
	agentDir: string;
	/** Only an authorized doctor successor may consume a restart-intent publication. */
	restartRequestId?: string;
	heartbeatTtlMs?: number;
	/**
	 * Environment for the spawned detached broker. Defaults to `process.env`; tests
	 * that pre-start an isolated broker pass the same sanitized child env so the
	 * broker and the child that attaches to it share one owned root.
	 */
	env?: NodeJS.ProcessEnv;
}

const BROKER_PUBLICATION_TIMEOUT_MS = 15_000;
const STARTUP_LOCK_WAIT_MS = 9_000;
const STALE_BROKER_RETIREMENT_TIMEOUT_MS = 5_000;
/** Parent budget covers stale retirement, a full child-fence wait, and one publication attempt. */
const DISCOVERY_TIMEOUT_MS = STALE_BROKER_RETIREMENT_TIMEOUT_MS + STARTUP_LOCK_WAIT_MS + BROKER_PUBLICATION_TIMEOUT_MS;
/** A process that loses the spawn lock waits this long for the winner's discovery before giving up. */
const SPAWN_LOCK_WAIT_MS = STALE_BROKER_RETIREMENT_TIMEOUT_MS + DISCOVERY_TIMEOUT_MS + 5_000;
const SPAWN_LOCK_RETRY_DELAY_MS = 50;
const SPAWN_LOCK_TARGET_NAME = "broker.spawn";
const STARTUP_LOCK_TARGET_NAME = "broker.startup";
const BROKER_SESSION_ENV_NAMES = new Set([
	"GJC_SESSION_FILE",
	"GJC_SESSION_ID",
	"GJC_SESSION_CWD",
	"GJC_SESSION_PROMPT_ACCEPTED_JSON",
	"GJC_SESSION_WORKTREE_BASELINE_DIRTY",
	"GJC_TMUX_ACTIVE_SESSION",
	"GJC_TMUX_LAUNCHED",
	"TMUX",
	"TMUX_PANE",
	"GJC_LIFECYCLE_REQUEST_ID",
	"GJC_SDK_LIFECYCLE_REQUEST",
	"GJC_STATE_ROOT",
	"GJC_MASTER_CAPABILITY",
	"GJC_MASTER_OWNER_SESSION_ID",
]);
const BROKER_SESSION_ENV_PRESERVED_NAMES = new Set([
	"GJC_SESSION_CONTEXT_BUDGET_BYTES",
	"GJC_SESSION_MEMORY_GC_STRATEGY",
	"GJC_SESSION_MEMORY_SECONDARY_ARTIFACT_MODE",
]);
const BROKER_SESSION_ENV_PREFIXES = [
	"GJC_SESSION_",
	"GJC_COORDINATOR_SESSION_",
	"GJC_COORDINATOR_SIDECAR_",
	"GJC_TMUX_OWNER_",
	"GJC_MANAGED_OWNER_",
] as const;

export interface BrokerStartupLockTestHooks {
	onAcquired?: () => void;
	onContended?: () => void;
}

/**
 * Test-only phase observation for detached broker startup regressions. The
 * signal is opt-in through the child environment and never affects broker
 * ownership or error handling when the test seam is absent.
 */
export async function emitBrokerStartupTestSignal(signal: string): Promise<void> {
	const directory = process.env.GJC_SDK_TEST_BROKER_SIGNAL_DIR;
	if (!directory || !/^[a-z0-9-]+$/.test(signal)) return;
	try {
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(directory, signal), `${process.pid}\n`);
	} catch {
		// Test observability must never change broker startup semantics.
	}
}

/**
 * The parent discovery budget published as a composition rather than a number.
 * A test that stages a fence contention has to time itself against these legs,
 * and retyping the sum makes it win or lose on scheduler noise while letting a
 * change to any single leg silently re-tune it (#5604). This is the one source
 * of truth for how the budget is built; nothing may restate the arithmetic.
 */
export const BROKER_DISCOVERY_BUDGET = {
	staleRetirementMs: STALE_BROKER_RETIREMENT_TIMEOUT_MS,
	startupLockWaitMs: STARTUP_LOCK_WAIT_MS,
	publicationMs: BROKER_PUBLICATION_TIMEOUT_MS,
	/** What the startup fence grants its holder: retirement plus one publication attempt. */
	fenceOperationMs: STALE_BROKER_RETIREMENT_TIMEOUT_MS + BROKER_PUBLICATION_TIMEOUT_MS,
	/**
	 * When a child spawned under the parent's spawn lock gives up on the fence,
	 * measured from that lock acquisition: the parent retires the stale incumbent
	 * first, then the child exhausts its own fence wait. Not a production
	 * constant -- an emergent property of the two legs that precede publication.
	 */
	childFenceWaitMs: STALE_BROKER_RETIREMENT_TIMEOUT_MS + STARTUP_LOCK_WAIT_MS,
	discoveryMs: DISCOVERY_TIMEOUT_MS,
} as const;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Clock the discovery budget is measured on. The default is the real one; a test
 * installs a virtual clock to assert the composition order -- stale retirement,
 * then the child fence, then startup and publication -- in-process instead of
 * racing three wall clocks against each other (#5604). Reaping keeps its own
 * {@link ReapTiming} seam and is deliberately not driven from here.
 */
export interface EnsureBrokerTiming {
	now(): number;
	sleep(ms: number): Promise<void>;
}

const REAL_ENSURE_BROKER_TIMING: EnsureBrokerTiming = { now: Date.now, sleep };
let ensureBrokerTiming: EnsureBrokerTiming = REAL_ENSURE_BROKER_TIMING;

/** Test hook: drives the discovery budget on a controllable clock. */
export function setEnsureBrokerTimingForTest(timing: EnsureBrokerTiming | undefined): void {
	ensureBrokerTiming = timing ?? REAL_ENSURE_BROKER_TIMING;
}

type SpawnLockOptions = Pick<FileLockOptions, "retries" | "retryDelayMs" | "signal">;

interface BrokerLockHostIdentity {
	ownerHostId: string;
	previousOwnerHostIds: readonly string[];
}

const brokerLockHostIdentityPromises = new Map<string, Promise<BrokerLockHostIdentity>>();

async function brokerLockHostIdentity(agentDir: string): Promise<BrokerLockHostIdentity> {
	const coordinationRoot = path.resolve(agentDir, "sdk");
	const pending =
		brokerLockHostIdentityPromises.get(coordinationRoot) ??
		Promise.all([loadInstallationHostId({ configRootDir: coordinationRoot }), loadLegacyInstallationHostId()]).then(
			([ownerHostId, legacyHostId]) => ({
				ownerHostId,
				previousOwnerHostIds: legacyHostId === ownerHostId ? [] : [legacyHostId],
			}),
		);
	brokerLockHostIdentityPromises.set(coordinationRoot, pending);
	try {
		return await pending;
	} catch (error) {
		if (brokerLockHostIdentityPromises.get(coordinationRoot) === pending)
			brokerLockHostIdentityPromises.delete(coordinationRoot);
		throw error;
	}
}

async function readBrokerDiscoveryBeforeDeadline(
	agentDir: string,
	heartbeatTtlMs: number | undefined,
	deadline: number,
): Promise<BrokerDiscovery | null> {
	const remainingMs = deadline - ensureBrokerTiming.now();
	if (!Number.isFinite(remainingMs)) return await readBrokerDiscovery(agentDir, heartbeatTtlMs);
	if (remainingMs <= 0) throw new Error("Timed out reading SDK broker discovery.");
	const read = readBrokerDiscovery(agentDir, heartbeatTtlMs);
	void read.catch(() => undefined);
	const timeout = Promise.withResolvers<BrokerDiscovery | null>();
	const timer: NodeJS.Timeout = setTimeout(
		() => timeout.reject(new Error("Timed out reading SDK broker discovery.")),
		remainingMs,
	);
	try {
		return await Promise.race([read, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

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
	const hostIdentity = await brokerLockHostIdentity(agentDir);
	return acquireFileLock(path.join(agentDir, "sdk", SPAWN_LOCK_TARGET_NAME), {
		retries: Math.ceil(SPAWN_LOCK_WAIT_MS / SPAWN_LOCK_RETRY_DELAY_MS),
		retryDelayMs: SPAWN_LOCK_RETRY_DELAY_MS,
		...hostIdentity,
		...options,
	});
}

/**
 * Child-owned fence for the interval from bootstrap through discovery publication.
 * The parent-held spawn lock prevents ordinary stampedes; this second fence keeps
 * startup single-flight if that detached child's launcher dies and its lock is reclaimed.
 */
export async function withBrokerStartupLock<T>(
	agentDir: string,
	operation: (deadline: number) => Promise<T>,
	testHooks: BrokerStartupLockTestHooks = {},
): Promise<T> {
	const hostIdentity = await brokerLockHostIdentity(agentDir);
	return withFileLock(
		path.join(agentDir, "sdk", STARTUP_LOCK_TARGET_NAME),
		() => operation(ensureBrokerTiming.now() + BROKER_DISCOVERY_BUDGET.fenceOperationMs),
		{
			retries: Math.ceil(STARTUP_LOCK_WAIT_MS / SPAWN_LOCK_RETRY_DELAY_MS),
			retryDelayMs: SPAWN_LOCK_RETRY_DELAY_MS,
			onAcquired: testHooks.onAcquired,
			onContended: testHooks.onContended,
			...hostIdentity,
		},
	);
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
async function reapSpawnedBroker(
	child: ChildProcess,
	realBrokerPid?: number,
	timing: ReapTiming = DEFAULT_REAP_TIMING,
): Promise<void> {
	// On Windows with hop, realBrokerPid is the actual broker process to reap.
	// On POSIX or when realBrokerPid is undefined, child is the actual broker to reap.
	const pidToReap = realBrokerPid ?? child.pid;
	// A spawn failure (e.g. ENOENT) never created a kernel process: pid is
	// undefined and there is nothing to signal or await. The `error` event is the
	// only signal and is diagnostic here — termination trivially holds, so do not
	// run out the TERM/KILL windows or report a stuck child that never existed.
	if (pidToReap === undefined) return;
	if (pidToReap !== child.pid) {
		await reapDetachedBrokerPid(pidToReap, timing);
		return;
	}
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
	throw new Error(`Detached SDK broker (pid ${pidToReap}) did not exit after SIGKILL during reap.`);
}

/**
 * Reap a broker this process launched through the Windows hop. The hop has already
 * exited, so its ChildProcess carries no signal to await: the real broker is targeted
 * by the pid the hop reported, and exit is proven by the pid no longer existing.
 */
async function reapDetachedBrokerPid(pid: number, timing: ReapTiming): Promise<void> {
	const awaitGone = async (windowMs: number): Promise<boolean> => {
		const deadline = Date.now() + windowMs;
		while (isPidAlive(pid)) {
			if (Date.now() >= deadline) return false;
			await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
		}
		return true;
	};
	const signal = (sig: NodeJS.Signals): void => {
		try {
			process.kill(pid, sig);
		} catch {
			// already exited between the liveness check and the kill
		}
	};
	if (!isPidAlive(pid)) return;
	signal("SIGTERM");
	if (await awaitGone(timing.gracefulMs)) return;
	signal("SIGKILL");
	if (await awaitGone(timing.killVerifyMs)) return;
	throw new Error(`Detached SDK broker (pid ${pid}) did not exit after SIGKILL during reap.`);
}

function registerBrokerOwner(
	agentDir: string,
	child: ChildProcess,
	realBrokerPid: number | undefined,
	brokerIncarnation: string | undefined,
	timing: ReapTiming = DEFAULT_REAP_TIMING,
): BrokerOwner {
	// On Windows, child is the hop process which exits immediately after spawning the real broker.
	// The real broker publishes its own pid in the discovery (realBrokerPid from hop stdout).
	// On other platforms, child is the actual broker, and its pid is the real broker pid.
	const expectedBrokerPid = realBrokerPid ?? child.pid;
	const expectedBrokerIncarnation = brokerIncarnation;
	let state: "starting" | "ready" | "cleanup-unverified" = "starting";
	const matches = (discovery: BrokerDiscovery | null): boolean => {
		if (!discovery) return false;
		// On Windows, verify the discovery matches the real broker pid from the hop.
		// On other platforms, verify the discovery comes from the child we spawned.
		return Boolean(
			expectedBrokerPid !== undefined &&
				expectedBrokerIncarnation &&
				discovery.pid === expectedBrokerPid &&
				discovery.incarnation === expectedBrokerIncarnation,
		);
	};
	const owner: BrokerOwner = {
		async stop(): Promise<void> {
			try {
				await reapSpawnedBroker(child, expectedBrokerPid, timing);
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
	// Master capability and owner-session markers are matched by the normalized
	// identity-name set below, including differently-cased Windows environment keys.
	// The broker outlives the TUI session that happened to start it. Never let
	// that session's identity or coordinator/tmux ownership markers flow through
	// the broker's process.env into unrelated session hosts. Keep user tmux
	// configuration (for example GJC_TMUX_SESSION, GJC_TMUX_COMMAND, GJC_MOUSE,
	// and GJC_TMUX_PROFILE) intact. Windows environment names are case-insensitive.
	for (const name of Object.keys(environment)) {
		const normalizedName = name.toUpperCase();
		if (BROKER_SESSION_ENV_PRESERVED_NAMES.has(normalizedName)) continue;
		if (
			BROKER_SESSION_ENV_NAMES.has(normalizedName) ||
			BROKER_SESSION_ENV_PREFIXES.some(prefix => normalizedName.startsWith(prefix))
		)
			delete environment[name];
	}
	if (command.kind === "bun-source") {
		delete environment.PI_COMPILED;
		delete environment.GJC_COMPILED;
	}
	return environment;
}

function fixtureLeaseUnavailable(): Error {
	return new Error("fixture_broker_lease_unavailable");
}

const STALE_BROKER_POLL_MS = 50;

type BrokerOwnerIdentity = Pick<BrokerDiscovery, "ownerId" | "pid" | "incarnation">;

function sameBrokerOwner(left: BrokerOwnerIdentity | null, right: BrokerOwnerIdentity): boolean {
	return Boolean(
		left && left.ownerId === right.ownerId && left.pid === right.pid && left.incarnation === right.incarnation,
	);
}

/** Start client teardown, but never await it past the retirement operation's absolute deadline. */
export async function closeBrokerClientBeforeDeadline(
	client: { close(): Promise<void> },
	deadline: number,
): Promise<void> {
	const close = client.close();
	void close.catch(() => undefined);
	const remainingMs = deadline - ensureBrokerTiming.now();
	if (remainingMs <= 0) return;
	await Promise.race([close, ensureBrokerTiming.sleep(remainingMs)]);
}

async function retireUnusableBroker(
	stale: BrokerDiscovery,
	settings: EnsureBrokerSettings,
	outerDeadline = Number.POSITIVE_INFINITY,
): Promise<void> {
	const deadline = Math.min(outerDeadline, ensureBrokerTiming.now() + BROKER_DISCOVERY_BUDGET.staleRetirementMs);
	let shutdownSucceeded = false;
	try {
		const current = await readBrokerDiscoveryBeforeDeadline(settings.agentDir, settings.heartbeatTtlMs, deadline);
		if (!current || !sameBrokerOwner(current, stale)) return;
		const client = await SdkClient.connect(current.url, current.token, { timeoutMs: 2_000, deadline });
		try {
			await client.global("broker.shutdown", {});
			shutdownSucceeded = true;
		} finally {
			await closeBrokerClientBeforeDeadline(client, deadline).catch(() => undefined);
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
	while (ensureBrokerTiming.now() < deadline) {
		const current = await readBrokerDiscoveryBeforeDeadline(settings.agentDir, settings.heartbeatTtlMs, deadline);
		if (!sameBrokerOwner(current, stale)) break;
		await ensureBrokerTiming.sleep(STALE_BROKER_POLL_MS);
	}
}

/** Reconcile an observed broker generation before entering a startup critical section. */
export async function reconcileBrokerGenerationForStartup(
	settings: EnsureBrokerSettings,
	deadline = Number.POSITIVE_INFINITY,
): Promise<BrokerDiscovery | undefined> {
	const current = await readBrokerDiscoveryBeforeDeadline(settings.agentDir, settings.heartbeatTtlMs, deadline);
	if (!current) return undefined;
	if (await isBrokerReusable(current)) return current;
	await retireUnusableBroker(current, settings, deadline);
	await emitBrokerStartupTestSignal("retirement-finished");
	const replacement = await readBrokerDiscoveryBeforeDeadline(settings.agentDir, settings.heartbeatTtlMs, deadline);
	return replacement && (await isBrokerReusable(replacement)) ? replacement : undefined;
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
	const initialDiscoveryDeadline =
		ensureBrokerTiming.now() + (initiator === "fixture-lease" ? FIXTURE_DISCOVERY_TIMEOUT_MS : DISCOVERY_TIMEOUT_MS);
	const priorOwner = owners.get(settings.agentDir);
	const existing = await readBrokerDiscoveryBeforeDeadline(
		settings.agentDir,
		settings.heartbeatTtlMs,
		initialDiscoveryDeadline,
	);
	const restartIntent = await readBrokerRestartIntent(settings.agentDir);
	if (
		restartIntent &&
		restartIntent.expiresAt > ensureBrokerTiming.now() &&
		restartIntent.requestId !== settings.restartRequestId
	)
		throw new Error("broker_restart_in_progress");
	if (initiator === "fixture-lease" && (priorOwner || existing)) throw fixtureLeaseUnavailable();
	if (priorOwner) {
		// A retained cleanup failure fences every discovery record. Only a ready
		// record bound to this exact child incarnation may be reused.
		if (priorOwner.canReuse(existing) && (await isBrokerReusable(existing)))
			return { kind: "prior-local-owner", discovery: existing!, owner: priorOwner };
		await priorOwner.stop();
		const discoveredAfterCleanup = await readBrokerDiscoveryBeforeDeadline(
			settings.agentDir,
			settings.heartbeatTtlMs,
			initialDiscoveryDeadline,
		);
		if (discoveredAfterCleanup && (await isBrokerReusable(discoveredAfterCleanup)))
			return { kind: "external-discovery", discovery: discoveredAfterCleanup };
		// Unusable-incumbent retirement is serialized under the spawn lock below.
	} else if (existing) {
		if (await isBrokerReusable(existing)) return { kind: "external-discovery", discovery: existing };
		// Unusable-incumbent retirement is serialized under the spawn lock below.
	}

	// Only one process may spawn for this agent dir at a time; everyone else
	// waits for the exact lock generation to release, then rechecks discovery.
	// Fixture leases always spawn their own.
	let spawnLog: BrokerSpawnLog | undefined;
	const releaseSpawnLock = initiator === "fixture-lease" ? async () => {} : await acquireSpawnLock(settings.agentDir);
	try {
		const deadline =
			ensureBrokerTiming.now() +
			(initiator === "fixture-lease" ? FIXTURE_DISCOVERY_TIMEOUT_MS : DISCOVERY_TIMEOUT_MS);
		const lockedIntent = await readBrokerRestartIntent(settings.agentDir);
		if (
			lockedIntent &&
			lockedIntent.expiresAt > ensureBrokerTiming.now() &&
			lockedIntent.requestId !== settings.restartRequestId
		)
			throw new Error("broker_restart_in_progress");
		// The lock winner may still find a discovery published by an earlier winner
		// that finished between our first read and the lock acquisition.
		const discoveredUnderLock = await reconcileBrokerGenerationForStartup(settings, deadline);
		if (discoveredUnderLock) return { kind: "external-discovery", discovery: discoveredUnderLock };
		const command = resolveSdkInternalSpawnCommand("broker-internal");
		spawnLog = await openBrokerSpawnLog(settings.agentDir);
		// A stale marker must never be misattributed to this spawn; clear it first.
		await clearBrokerStartupExitRecord(settings.agentDir);
		await clearBrokerStartupFailureMarker(settings.agentDir);
		const childSpawnedAt = Date.now();
		const brokerSpawnOpts = resolveBrokerSpawnOptions(command.file, [
			...command.args,
			"--agent-dir",
			settings.agentDir,
		]);
		const env = brokerSpawnEnvironment(command, settings.env);
		let spawnResult: BrokerSpawnResult;
		let spawnError: Error | undefined;

		if (process.platform === "win32") {
			const launched = await launchBrokerViaHop(
				{
					command: { file: brokerSpawnOpts.file, args: brokerSpawnOpts.args },
					...(command.kind === "bun-source" ? { cwd: command.cwd } : {}),
					...(spawnLog ? { stderrLogPath: spawnLog.path } : {}),
				},
				{ env, cwd: command.kind === "bun-source" ? command.cwd : undefined },
			);
			spawnResult = { process: launched.process, realBrokerPid: launched.realBrokerPid };
			spawnError = launched.error;
		} else {
			spawnResult = spawnBrokerWithHop(brokerSpawnOpts.file, brokerSpawnOpts.args, {
				stdioFd: spawnLog?.handle.fd,
				env,
				cwd: command.kind === "bun-source" ? command.cwd : undefined,
			});
			spawnResult.process.once("error", error => {
				spawnError = error;
			});
		}

		const child = spawnResult.process;
		const realBrokerPid = spawnResult.realBrokerPid;
		const childIncarnation = realBrokerPid === undefined ? undefined : brokerProcessIncarnation(realBrokerPid);
		const owner = registerBrokerOwner(settings.agentDir, child, realBrokerPid, childIncarnation);
		child.unref();
		// The child holds its own duplicate of the descriptor. Failure to close the
		// parent's diagnostic handle must not discard exact ownership of a live child.
		await spawnLog?.handle.close().catch(() => undefined);
		let discoveryError: unknown;
		while (ensureBrokerTiming.now() < deadline) {
			// On Windows, child is the hop process which exits immediately with code 0 after
			// spawning the real broker with detached:true. Do not break the poll loop on a
			// clean exit (code 0); break only on spawn error or actual failure (signal
			// or non-zero exit). This allows discovery polling to continue through the
			// normal deadline while the real broker starts and publishes.
			const failedSpawn =
				spawnError || child.signalCode !== null || (child.exitCode !== null && child.exitCode !== 0);
			if (failedSpawn) break;
			try {
				const discovered = await readBrokerDiscoveryBeforeDeadline(
					settings.agentDir,
					settings.heartbeatTtlMs,
					deadline,
				);
				if (discovered) {
					if (!(await isBrokerReusable(discovered))) {
						await ensureBrokerTiming.sleep(50);
						continue;
					}
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
			await ensureBrokerTiming.sleep(50);
		}
		const exitedBeforeDiscovery = child.exitCode !== null || child.signalCode !== null;
		const marker = await readBrokerStartupFailureMarker(settings.agentDir);
		const startupExitRecord = await readBrokerStartupExitRecord(settings.agentDir);
		// On Windows with hop: child is the hop process which exits immediately,
		// and realBrokerPid is read from hop stdout. The real broker writes the marker/exit
		// record with its own pid.
		// On POSIX: child is the real broker, and child.pid is used for validation.
		const trustedMarker =
			marker &&
			childIncarnation !== undefined &&
			realBrokerPid !== undefined &&
			marker.pid === realBrokerPid &&
			marker.incarnation === childIncarnation &&
			marker.writtenAt >= childSpawnedAt
				? marker
				: undefined;
		const trustedStartupExitRecord =
			startupExitRecord &&
			realBrokerPid !== undefined &&
			startupExitRecord.pid === realBrokerPid &&
			startupExitRecord.writtenAt >= childSpawnedAt
				? startupExitRecord
				: undefined;
		const startupLockPath = path.join(settings.agentDir, "sdk", STARTUP_LOCK_TARGET_NAME);
		let startupFenceContention =
			exitedBeforeDiscovery &&
			(trustedMarker?.reason.startsWith(`Failed to acquire lock for ${startupLockPath} after `) === true ||
				brokerStartupFailureCleanupTargetsLock(trustedMarker, `${startupLockPath}.lock`));
		if (!startupFenceContention && exitedBeforeDiscovery && child.exitCode !== 0) {
			try {
				startupFenceContention = (await fs.stat(`${startupLockPath}.lock`)).isDirectory();
			} catch {
				// The marker is best-effort and the fence may have been released
				// between the child exit and this observation.
			}
		}
		if (startupFenceContention) {
			// A launcher can die after its detached child acquires the startup fence.
			// The replacement child may exhaust its own fence wait before the incumbent
			// reaches the end of its publication allowance, so keep the parent attached
			// to the exact agent dir and give that incumbent one final bounded chance to
			// publish before treating the replacement failure as terminal.
			const recoveryDeadline = Math.min(deadline, ensureBrokerTiming.now() + BROKER_DISCOVERY_BUDGET.publicationMs);
			while (ensureBrokerTiming.now() < recoveryDeadline) {
				try {
					const incumbent = await readBrokerDiscoveryBeforeDeadline(
						settings.agentDir,
						settings.heartbeatTtlMs,
						recoveryDeadline,
					);
					if (incumbent && (await isBrokerReusable(incumbent))) {
						await owner.stop();
						return { kind: "external-discovery", discovery: incumbent };
					}
				} catch {
					// Keep the bounded retry alive; a transient read failure is not
					// authority to classify the incumbent as failed.
				}
				await ensureBrokerTiming.sleep(50);
			}
		}
		const spawnLogTail = exitedBeforeDiscovery && spawnLog ? await readBrokerSpawnLogTail(spawnLog.path) : "";
		// A marker only wins over the generic fallback when it was written by the
		// exact child this call just spawned and reaped. The pre-spawn clear
		// already prevents an old marker from surviving to this point, but a
		// concurrent broker (a foreign process racing the same agent dir) could
		// still write a marker between the clear and this read; the pid binding
		// rejects that marker instead of misattributing a foreign failure to this
		// spawn's caller.
		const failure = spawnError
			? new Error(`Failed to spawn detached SDK broker: ${spawnError.message}`)
			: exitedBeforeDiscovery
				? new BrokerStartupError({
						exitCode: child.exitCode ?? trustedStartupExitRecord?.exitCode ?? null,
						signal: child.signalCode ?? trustedStartupExitRecord?.signal ?? null,
						reason:
							brokerStartupExitReason(trustedStartupExitRecord) ?? brokerStartupFailureReason(trustedMarker),
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
	const resolvedSettings = { ...settings, agentDir: path.resolve(settings.agentDir) };
	const inFlight = ensureInFlight.get(resolvedSettings.agentDir) ?? startEnsure(resolvedSettings, "discovery");
	return inFlight.discovery;
}

/** Starts one fresh fixture broker and returns its sole exact-child close lease. */
export function startFixtureBrokerWithLeaseForTest(settings: EnsureBrokerSettings): Promise<StartedFixtureBroker> {
	const resolvedSettings = { ...settings, agentDir: path.resolve(settings.agentDir) };
	if (ensureInFlight.has(resolvedSettings.agentDir)) return Promise.reject(fixtureLeaseUnavailable());
	const inFlight = startEnsure(resolvedSettings, "fixture-lease");
	return inFlight.promise.then(outcome => {
		if (outcome.kind !== "local-started-fixture") throw fixtureLeaseUnavailable();
		return { discovery: outcome.discovery, lease: createFixtureLease(outcome.owner, outcome.child) };
	});
}

/**
 * Test-only launch surface for topology fixtures. It accepts an already-resolved
 * command and retains the exact spawned child; no production selection path
 * reaches this function.
 *
 * Note: This function does NOT use the Windows broker hop. Fixtures are test-only
 * and do not require Windows process-tree detachment; the fixture needs to retain
 * exact ownership of the actual broker process to control its stdio[3] control pipe.
 */
export function startFixtureBrokerCommandWithLeaseForTest(command: FixtureBrokerCommand): StartedFixtureBrokerCommand {
	if (!command.file || !Array.isArray(command.args)) throw new Error("Invalid fixture broker command.");
	const child = spawn(command.file, command.args, {
		cwd: command.cwd,
		detached: process.platform !== "win32",
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
/** Test hook: proves discovery reads honor their enclosing absolute deadline. */
export const readBrokerDiscoveryBeforeDeadlineForTest = readBrokerDiscoveryBeforeDeadline;

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
export function reapSpawnedBrokerForTest(
	child: ChildProcess,
	realBrokerPid?: number,
	timing: ReapTiming = DEFAULT_REAP_TIMING,
): Promise<void> {
	return reapSpawnedBroker(child, realBrokerPid, timing);
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
	realBrokerPid?: number,
	brokerIncarnation?: string,
	timing: ReapTiming = DEFAULT_REAP_TIMING,
): BrokerOwner {
	return registerBrokerOwner(agentDir, child, realBrokerPid, brokerIncarnation, timing);
}

/** Test hook: exercises the same trusted-marker reason reconstruction used by ensureBroker. */
export function brokerStartupFailureReasonForTest(marker: BrokerStartupFailureMarker | undefined): string {
	return brokerStartupFailureReason(marker);
}
/**
 * Resolves broker spawn options. Always returns the command unchanged,
 * using direct spawning on all platforms.
 */
export function resolveBrokerSpawnOptionsForProduction(
	file: string,
	args: readonly string[],
): { file: string; args: string[] } {
	return resolveBrokerSpawnOptions(file, args);
}
