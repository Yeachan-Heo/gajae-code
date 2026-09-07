import * as fs from "node:fs/promises";
import path from "node:path";
import {
	type FixtureBrokerCommand,
	type FixtureBrokerLease,
	type StartedFixtureBrokerCommand,
	startFixtureBrokerCommandWithLeaseForTest as startFixtureBrokerCommand,
} from "../../src/sdk/broker/ensure";

export type FixtureRuntimeOwner = "runtime" | "runtime-and-broker";
type State = "pending" | "verified";
type RuntimePhase = "shutdown" | "dispose";
type RootPhase = "leaseClose" | "rootRemove" | "rootAbsent";

export interface FixtureRuntimeRegistration {
	key: string;
	requiredOwner: FixtureRuntimeOwner;
	shutdown?: () => Promise<void>;
	dispose?: () => Promise<void>;
}

interface FixtureRuntimeEntry extends FixtureRuntimeRegistration {
	phases: Record<RuntimePhase, State>;
	failures: Partial<Record<RuntimePhase, unknown>>;
}

export interface FixtureRootCleanup {
	rootKey: string;
	root: string;
	agentDir: string;
	lease: FixtureBrokerLease;
	entries: Map<string, FixtureRuntimeEntry>;
	phases: Record<RootPhase, State>;
	failures: Partial<Record<RootPhase, unknown>>;
	recreation?: { observedAt: string; detail: string };
}

export interface FixtureRootCleanupOptions {
	removeRoot?: (root: string) => Promise<void>;
	rootExists?: (root: string) => Promise<boolean>;
	absenceObservationMs?: number;
	absencePollMs?: number;
}

const roots = new Map<string, FixtureRootCleanup>();
const cleanupAttempts = new WeakMap<FixtureRootCleanup, Promise<void>>();
const canonicalRoot = (root: string) => path.resolve(root);

/**
 * Abort-safe reap for fixture broker leases.
 *
 * `cleanupFixtureRoot` only runs on the success path. When a test throws,
 * times out, or the runner kills the file early, the detached broker child
 * this process spawned is reparented and keeps its port and memory forever
 * (fixture roots under /tmp with a live `broker-internal --agent-dir` child
 * are the signature). This registry targets exactly the leases created in
 * this process — never a discovery-derived PID, never by name — and reaps
 * them when the process exits abnormally. Normal cleanup unregisters first,
 * so the exit hook is a no-op on the success path.
 */
interface TrackedFixtureLease {
	cleanup: FixtureRootCleanup;
}
const trackedLeases = new Set<TrackedFixtureLease>();
let reapHookInstalled = false;

function installAbortReapHook(): void {
	if (reapHookInstalled) return;
	reapHookInstalled = true;
	const reapTrackedLeases = (): void => {
		// Synchronous only: the process is already exiting, so hand each
		// retained child the same exact-child termination `close()` performs.
		// Exact children only — a fixture lease never touches a foreign PID.
		// The lease is dereferenced live: one caller reassigns `cleanup.lease`
		// after construction when the real broker starts, and the hook must own
		// the live lease, not the construction-time placeholder.
		for (const tracked of [...trackedLeases]) {
			trackedLeases.delete(tracked);
			try {
				const result = tracked.cleanup.lease.close();
				if (result && typeof (result as Promise<void>).catch === "function")
					(result as Promise<void>).catch(() => undefined);
			} catch {
				// Best-effort: teardown diagnostics must never throw from an exit hook.
			}
		}
	};
	process.once("beforeExit", reapTrackedLeases);
	process.once("exit", reapTrackedLeases);
}

function trackFixtureLease(cleanup: FixtureRootCleanup): void {
	installAbortReapHook();
	trackedLeases.add({ cleanup });
}

function untrackFixtureLease(cleanup: FixtureRootCleanup): void {
	for (const tracked of [...trackedLeases]) {
		if (tracked.cleanup === cleanup) trackedLeases.delete(tracked);
	}
}

/** Test hook: number of fixture broker leases still owned by this process. */
export function trackedFixtureLeaseCountForTest(): number {
	return trackedLeases.size;
}
async function exists(root: string): Promise<boolean> {
	try {
		await fs.stat(root);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

const ROOT_REMOVE_RETRY_ATTEMPTS = 10;
const ROOT_REMOVE_RETRY_MS = 100;

function isTransientRootRemoveError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	return error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTEMPTY";
}

async function removeFixtureRoot(removeRoot: (root: string) => Promise<void>, root: string): Promise<void> {
	for (let attempt = 1; attempt <= ROOT_REMOVE_RETRY_ATTEMPTS; attempt++) {
		try {
			await removeRoot(root);
			return;
		} catch (error) {
			if (!isTransientRootRemoveError(error) || attempt === ROOT_REMOVE_RETRY_ATTEMPTS) throw error;
			await Bun.sleep(ROOT_REMOVE_RETRY_MS);
		}
	}
}

export function createFixtureBrokerEnvironment(root: string, agentDir: string): NodeJS.ProcessEnv {
	const windowsRoot = path.win32.normalize(root);
	const windowsRootParts = path.win32.parse(windowsRoot);
	const homeDrive = /^[A-Za-z]:/.exec(windowsRoot)?.[0] ?? windowsRootParts.root;
	const homePath = windowsRoot.slice(homeDrive.length) || "\\";
	const tmpDir = path.join(root, "tmp");
	const environment: NodeJS.ProcessEnv = {
		HOME: root,
		USERPROFILE: root,
		APPDATA: path.join(root, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(root, "AppData", "Local"),
		HOMEDRIVE: homeDrive,
		HOMEPATH: homePath,
		XDG_CONFIG_HOME: path.join(root, "config"),
		GJC_AGENT_DIR: agentDir,
		GJC_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		// Pin the child temp root inside the owned fixture root so os.tmpdir() writes
		// stay under the root and are removed by fixture cleanup. Never forward the
		// runner's TEMP/TMP/TMPDIR, or child temp files escape and survive teardown.
		TMPDIR: tmpDir,
		TMP: tmpDir,
		TEMP: tmpDir,
	};
	for (const key of [
		"PATH",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TZ",
		"SYSTEMROOT",
		"COMSPEC",
		"PATHEXT",
		"WINDIR",
	] as const) {
		if (process.env[key] !== undefined) environment[key] = process.env[key];
	}
	return environment;
}

/** Test-only retained-child launch boundary for SDK broker topology fixtures. */
export function startFixtureBrokerCommandWithLeaseForTest(command: FixtureBrokerCommand): StartedFixtureBrokerCommand {
	return startFixtureBrokerCommand(command);
}
const describeError = (error: unknown): string =>
	error instanceof Error
		? error.message.replaceAll(/(?:token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]")
		: "[redacted failure]";

export function createFixtureRootCleanup(
	root: string,
	agentDir: string,
	lease: FixtureBrokerLease,
): FixtureRootCleanup {
	const canonical = canonicalRoot(root);
	if (roots.has(canonical)) throw new Error(`Fixture broker root already registered: ${canonical}`);
	const cleanup: FixtureRootCleanup = {
		rootKey: canonical,
		root: canonical,
		agentDir,
		lease,
		entries: new Map(),
		phases: { leaseClose: "pending", rootRemove: "pending", rootAbsent: "pending" },
		failures: {},
	};
	roots.set(canonical, cleanup);
	trackFixtureLease(cleanup);
	return cleanup;
}

export function registerFixtureRuntime(root: FixtureRootCleanup, registration: FixtureRuntimeRegistration): void {
	if (roots.get(root.rootKey) !== root) throw new Error("Fixture broker root is not registered.");
	if (root.entries.has(registration.key))
		throw new Error(`Fixture broker runtime already registered: ${registration.key}`);
	root.entries.set(registration.key, {
		...registration,
		phases: {
			shutdown: registration.shutdown ? "pending" : "verified",
			dispose: registration.dispose ? "pending" : "verified",
		},
		failures: {},
	});
}

async function runRuntimePhase(root: FixtureRootCleanup, phase: RuntimePhase): Promise<void> {
	const failures: unknown[] = [];
	const entries = [...root.entries.values()];
	// Shutdown is phase-major in registration order. Disposal unwinds ownership in
	// reverse order so dependencies registered first (databases/config stores) stay
	// alive until every runtime that consumes them has released its handles.
	if (phase === "dispose") entries.reverse();
	for (const entry of entries) {
		if (entry.phases[phase] === "verified") continue;
		try {
			await entry[phase]?.();
			entry.phases[phase] = "verified";
			delete entry.failures[phase];
		} catch (error) {
			entry.failures[phase] = error;
			failures.push(new Error(`${entry.key} (${entry.requiredOwner}) ${phase}: ${describeError(error)}`));
		}
	}
	if (failures.length) throw new AggregateError(failures, `Fixture broker ${phase} failed.`);
}

async function cleanupFixtureRootOnce(
	root: FixtureRootCleanup,
	options: FixtureRootCleanupOptions = {},
): Promise<void> {
	if (roots.get(root.rootKey) !== root) {
		const complete =
			root.phases.leaseClose === "verified" &&
			root.phases.rootRemove === "verified" &&
			root.phases.rootAbsent === "verified";
		if (complete) return;
		throw new Error("Fixture broker root is not registered.");
	}
	const failures: unknown[] = [];
	for (const phase of ["shutdown", "dispose"] as const) {
		try {
			await runRuntimePhase(root, phase);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Fixture broker runtime cleanup failed.");
	if (root.phases.leaseClose === "pending") {
		try {
			await root.lease.close();
			root.phases.leaseClose = "verified";
			delete root.failures.leaseClose;
		} catch (error) {
			root.failures.leaseClose = error;
			throw new AggregateError([error], `Fixture broker lease close failed: ${describeError(error)}`);
		}
	}
	if (process.platform === "win32") {
		// Bun can retain native directory/database handles until a collection after
		// their owning test runtimes are disposed. Force that finalizer boundary
		// before asserting fixture-root removal on Windows.
		Bun.gc(true);
		await Bun.sleep(50);
	}
	const removeRoot = options.removeRoot ?? (async value => fs.rm(value, { recursive: true, force: true }));
	const rootExists = options.rootExists ?? exists;
	if (root.phases.rootRemove === "pending") {
		try {
			await removeFixtureRoot(removeRoot, root.root);
			root.phases.rootRemove = "verified";
			delete root.failures.rootRemove;
		} catch (error) {
			root.failures.rootRemove = error;
			throw new AggregateError([error], `Fixture broker root removal failed: ${describeError(error)}`);
		}
	}
	try {
		const observationMs = options.absenceObservationMs ?? 100;
		const pollMs = options.absencePollMs ?? 20;
		const deadline = Date.now() + observationMs;
		let observing = true;
		while (observing) {
			if (await rootExists(root.root)) {
				root.recreation = { observedAt: new Date().toISOString(), detail: "fixture root reappeared" };
				root.phases.rootRemove = "pending";
				root.phases.rootAbsent = "pending";
				throw new Error("Fixture broker root was recreated after removal.");
			}
			observing = Date.now() < deadline;
			if (observing) await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
		}
		root.phases.rootAbsent = "verified";
		delete root.failures.rootAbsent;
	} catch (error) {
		if (root.phases.rootAbsent !== "verified") root.failures.rootAbsent = error;
		throw error;
	}
	roots.delete(root.rootKey);
	untrackFixtureLease(root);
}

export function cleanupFixtureRoot(root: FixtureRootCleanup, options: FixtureRootCleanupOptions = {}): Promise<void> {
	const existing = cleanupAttempts.get(root);
	if (existing) return existing;
	const attempt = cleanupFixtureRootOnce(root, options).finally(() => {
		if (cleanupAttempts.get(root) === attempt) cleanupAttempts.delete(root);
	});
	cleanupAttempts.set(root, attempt);
	return attempt;
}
/** Clears fixture-local broker opt-out state for an async setup and restores it exactly. */
export async function withFixtureBrokerEnvironment<T>(run: () => Promise<T>): Promise<T> {
	const prior = process.env.GJC_SDK_DISABLE;
	delete process.env.GJC_SDK_DISABLE;
	try {
		return await run();
	} finally {
		if (prior === undefined) delete process.env.GJC_SDK_DISABLE;
		else process.env.GJC_SDK_DISABLE = prior;
	}
}

export async function cleanupFixtureRoots(cleanups: FixtureRootCleanup[]): Promise<void> {
	const failures: unknown[] = [];
	for (let index = cleanups.length - 1; index >= 0; index--) {
		const cleanup = cleanups[index]!;
		try {
			await cleanupFixtureRoot(cleanup);
			cleanups.splice(index, 1);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "Fixture broker root cleanup failed.");
}

export function fixtureRootForTest(root: string): FixtureRootCleanup | undefined {
	return roots.get(canonicalRoot(root));
}
