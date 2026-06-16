/**
 * Shared runtime lifecycle foundation.
 *
 * Two minimal, deliberately small primitives that subsystem runtimes
 * (DAP/LSP/MCP stdio, eval workers, etc.) adopt so spawned children and
 * non-process resources cannot outlive their owner:
 *
 *   F1(a) `spawnOwnedProcess` — wraps `ptree.spawn` with explicit
 *         process-group ownership, escalating (SIGTERM -> grace -> SIGKILL)
 *         tree termination, bounded `awaitExit`, abort-listener cleanup on
 *         settle, idempotent `dispose`, and a single postmortem hook that
 *         reaps every still-live owned process group on fatal/normal shutdown.
 *
 *   F1(b) `registerResourceOwner` — a generic, idempotent postmortem adapter
 *         for non-process resources (Bun Workers, VM contexts, timers,
 *         sockets) built on the existing `postmortem.register` facility.
 *
 * Ownership is keyed to the *process group*, not the root process. A root that
 * exits after backgrounding descendants (`sh -c "worker & exit 0"`) keeps the
 * owner registered until the group is actually gone, so the descendant tree is
 * still reaped by `dispose()`/postmortem.
 *
 * This module intentionally owns only these primitives. It does not migrate
 * existing call sites; subsystem PRs adopt it incrementally.
 *
 * Note: `ptree.spawn` always pipes stdout/stderr. Adopters that expect output
 * (DAP/LSP/MCP protocol servers) must consume `owner.child.stdout`; F1 does not
 * drain it, so a chatty child whose stdout is never read can still block on a
 * full pipe. That draining is the adopter's responsibility.
 */
import { logger, postmortem, ptree } from "@gajae-code/utils";

const DEFAULT_GRACEFUL_MS = 2_000;
// Hard cap for how long `dispose()` waits after SIGKILL before giving up so a
// wedged, unkillable child can never block shutdown forever.
const SIGKILL_REAP_CAP_MS = 2_000;
// After the root process exits on its own, how long to wait for the process
// group to drain before deregistering. Clean servers drain immediately; a root
// that backgrounded descendants stays registered past this window.
const ROOT_EXIT_DRAIN_MS = 250;

const isPosix = process.platform !== "win32";

const delay = (ms: number): Promise<void> =>
	new Promise(resolve => {
		const timer = setTimeout(resolve, Math.max(0, ms));
		timer.unref?.();
	});

/** Poll `predicate` until it is true or `timeoutMs` elapses. Returns the final value. */
async function pollUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 20): Promise<boolean> {
	if (predicate()) return true;
	const deadline = Date.now() + Math.max(0, timeoutMs);
	while (Date.now() < deadline) {
		await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
		if (predicate()) return true;
	}
	return predicate();
}

/** Whether a POSIX process group still has any member (zombies count as alive). */
function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		// EPERM => the group exists but we cannot signal it; treat as alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Options for {@link spawnOwnedProcess}. */
export interface SpawnOwnedOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	/** stdin mode passed through to the child. Defaults to `"ignore"`. */
	stdin?: "pipe" | "ignore";
	/** When aborted, the owned process tree is disposed (escalating kill). */
	signal?: AbortSignal;
	/** Grace period (ms) between SIGTERM and SIGKILL on dispose. Default 2000. */
	gracefulMs?: number;
	/**
	 * Spawn the child as its own process-group leader so the whole descendant
	 * tree can be signalled on dispose. Defaults to `true` on POSIX. Has no
	 * effect on Windows, where teardown falls back to single-process kill.
	 */
	processGroup?: boolean;
	/** Label used in diagnostics. */
	name?: string;
}

/** Result of a bounded {@link OwnedProcess.awaitExit}. */
export interface AwaitExitResult {
	/** `true` when the process has exited; `false` when the timeout fired first. */
	exited: boolean;
	/** Exit code if known, else `null`. */
	code: number | null;
}

/** A spawned child process owned by the runtime with guaranteed teardown. */
export interface OwnedProcess {
	readonly child: ptree.ChildProcess;
	readonly pid: number | undefined;
	/** Resolves/rejects when the root child exits (mirrors ptree's `exited`). */
	readonly exited: Promise<number>;
	/** `true` once `dispose()` has started. */
	readonly disposed: boolean;
	/**
	 * Wait for the root child to exit, optionally bounded by `timeoutMs`. With no
	 * timeout it resolves only when the child exits. Never rejects.
	 */
	awaitExit(opts?: { timeoutMs?: number }): Promise<AwaitExitResult>;
	/**
	 * Idempotently terminate the owned process *group*: SIGTERM the group, wait
	 * `gracefulMs`, then SIGKILL, polling group liveness throughout. Removes the
	 * abort listener and deregisters from the live-owner set only after teardown
	 * has completed. Repeated/concurrent calls return the same in-flight promise.
	 */
	dispose(): Promise<void>;
}

const liveOwners = new Set<OwnedProcess>();
let ownedPostmortemRegistered = false;

function ensureOwnedPostmortem(): void {
	if (ownedPostmortemRegistered) return;
	ownedPostmortemRegistered = true;
	postmortem.register("runtime:owned-processes", async () => {
		await Promise.all([...liveOwners].map(owner => owner.dispose().catch(() => undefined)));
	});
}

/**
 * Spawn a child process owned by the runtime. The returned {@link OwnedProcess}
 * is registered for postmortem cleanup and tears down its whole process group
 * on dispose/abort.
 */
export function spawnOwnedProcess(cmd: string[], opts: SpawnOwnedOptions = {}): OwnedProcess {
	const gracefulMs = opts.gracefulMs ?? DEFAULT_GRACEFUL_MS;
	const useGroup = (opts.processGroup ?? true) && isPosix;

	ensureOwnedPostmortem();

	// We deliberately do NOT forward `opts.signal` to `ptree.spawn`: ptree's
	// `attachSignal` only kills the single process, whereas owned teardown must
	// signal the whole group. We wire our own abort listener below and remove it
	// on settle so long-lived signals never accumulate listeners.
	const child = ptree.spawn(cmd, {
		cwd: opts.cwd,
		env: opts.env,
		stdin: opts.stdin ?? "ignore",
		detached: useGroup,
	});

	// On POSIX with `detached`, the child is its own process-group leader, so the
	// group id equals its pid. `undefined` => single-process (Windows/opt-out).
	const pgid = useGroup ? child.pid : undefined;

	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	let deregistered = false;
	// Terminal once teardown/reconciliation has confirmed the group is gone. A
	// late dispose() must then be a true no-op and never re-probe a pgid the OS
	// may have recycled into an unrelated group.
	let terminated = false;
	let onAbort: (() => void) | undefined;

	const removeAbort = (): void => {
		if (onAbort && opts.signal) {
			opts.signal.removeEventListener("abort", onAbort);
			onAbort = undefined;
		}
	};

	const deregister = (): void => {
		if (deregistered) return;
		deregistered = true;
		terminated = true;
		liveOwners.delete(owner);
		removeAbort();
	};

	const signalTree = (signal: NodeJS.Signals): void => {
		const pid = child.pid;
		if (pid === undefined) return;
		if (pgid !== undefined) {
			try {
				// Negative pid signals the entire process group (child is leader).
				process.kill(-pgid, signal);
				return;
			} catch {
				// Group already gone; nothing to do.
			}
			return;
		}
		if (signal === "SIGKILL") {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		} else {
			// ptree's kill terminates the single process via the native handle.
			child.kill();
		}
	};

	const owner: OwnedProcess = {
		child,
		get pid() {
			return child.pid;
		},
		get exited() {
			return child.exited;
		},
		get disposed() {
			return disposed;
		},
		async awaitExit({ timeoutMs }: { timeoutMs?: number } = {}): Promise<AwaitExitResult> {
			const exitedResult = child.exited
				.then(code => ({ exited: true as const, code: code as number | null }))
				.catch(() => ({ exited: true as const, code: child.exitCode }));
			if (timeoutMs === undefined) return exitedResult;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<AwaitExitResult>(resolve => {
				timer = setTimeout(() => resolve({ exited: false, code: child.exitCode }), Math.max(0, timeoutMs));
				timer.unref?.();
			});
			try {
				return await Promise.race([exitedResult, timeout]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
		dispose(): Promise<void> {
			// Already terminal (e.g. clean drain reconciled and deregistered):
			// never re-probe the pgid; treat dispose as a settled no-op.
			if (terminated) {
				disposed = true;
				if (!disposePromise) disposePromise = Promise.resolve();
				return disposePromise;
			}
			if (disposePromise) return disposePromise;
			disposed = true;
			removeAbort();
			disposePromise = (async () => {
				try {
					if (pgid !== undefined) {
						// Group ownership: reap until the whole group is gone, even if
						// the root has already exited (it may have backgrounded children).
						if (!groupAlive(pgid)) return;
						signalTree("SIGTERM");
						if (await pollUntil(() => !groupAlive(pgid), gracefulMs)) return;
						signalTree("SIGKILL");
						if (!(await pollUntil(() => !groupAlive(pgid), SIGKILL_REAP_CAP_MS))) {
							logger.warn("owned process group still alive after SIGKILL", {
								name: opts.name,
								pgid,
							});
						}
						return;
					}
					// Single-process fallback (Windows / processGroup:false).
					if (child.exitCode !== null) return;
					signalTree("SIGTERM");
					if ((await owner.awaitExit({ timeoutMs: gracefulMs })).exited) return;
					signalTree("SIGKILL");
					await owner.awaitExit({ timeoutMs: SIGKILL_REAP_CAP_MS });
				} catch (err) {
					logger.warn("owned process dispose failed", {
						name: opts.name,
						error: err instanceof Error ? err.message : String(err),
					});
				} finally {
					// FIX: deregister only after teardown has completed so a postmortem
					// firing mid-grace still sees the owner and awaits this dispose.
					deregister();
				}
			})();
			return disposePromise;
		},
	};

	liveOwners.add(owner);

	// When the root exits on its own (not via dispose), reconcile ownership by
	// the *group*. After a short drain window: if the group is empty, deregister;
	// if descendants are still alive, reap the owned group (no child outlives its
	// owner). Either way the owner never lingers holding a stale pgid that the OS
	// could later recycle and a stray dispose could mis-signal.
	void child.exited
		.catch(() => undefined)
		.finally(() => {
			if (disposed) return; // dispose() owns deregistration
			if (pgid === undefined) {
				deregister();
				return;
			}
			void (async () => {
				const drained = await pollUntil(() => !groupAlive(pgid), ROOT_EXIT_DRAIN_MS);
				if (disposed) return;
				if (drained) {
					deregister();
					return;
				}
				// Root exited but the owned group still has descendants: reap them.
				// dispose() escalates SIGTERM->SIGKILL and deregisters in its finally.
				await owner.dispose();
			})();
		});

	if (opts.signal) {
		if (opts.signal.aborted) {
			void owner.dispose();
		} else {
			onAbort = () => void owner.dispose();
			opts.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	return owner;
}

/** Number of currently live owned processes. Exposed for leak assertions/tests. */
export function liveOwnedProcessCount(): number {
	return liveOwners.size;
}

/** Dispose every live owned process. For owner-scoped teardown and tests. */
export async function disposeAllOwnedProcesses(): Promise<void> {
	await Promise.all([...liveOwners].map(owner => owner.dispose().catch(() => undefined)));
}

// ── F1(b) generic resource owners ────────────────────────────────────────────

type ResourceDisposer = () => void | Promise<void>;

const resourceOwners = new Map<string, ResourceDisposer>();
let resourcePostmortemRegistered = false;

function ensureResourcePostmortem(): void {
	if (resourcePostmortemRegistered) return;
	resourcePostmortemRegistered = true;
	// Postmortem isolates per-callback failures; swallow the aggregate here so
	// shutdown continues, while direct callers of disposeAllResourceOwners still
	// observe the AggregateError.
	postmortem.register("runtime:resource-owners", () =>
		disposeAllResourceOwners().catch(err => {
			logger.warn("resource owner postmortem cleanup had failures", {
				error: err instanceof Error ? err.message : String(err),
			});
		}),
	);
}

/**
 * Register a non-process resource for postmortem/fatal-exit cleanup.
 *
 * Idempotent by `name`: re-registering the same name replaces the prior
 * disposer (last wins). Returns an unregister function that removes the owner
 * only while it is still the active registration for that name.
 */
export function registerResourceOwner(name: string, disposer: ResourceDisposer): () => void {
	resourceOwners.set(name, disposer);
	ensureResourcePostmortem();
	let unregistered = false;
	return () => {
		if (unregistered) return;
		unregistered = true;
		if (resourceOwners.get(name) === disposer) {
			resourceOwners.delete(name);
		}
	};
}

/** Number of registered resource owners. Exposed for leak assertions/tests. */
export function resourceOwnerCount(): number {
	return resourceOwners.size;
}

/**
 * Run and clear every registered resource disposer. Attempts all disposers even
 * if some throw, then surfaces the failures as an `AggregateError` so callers
 * can distinguish "all closed" from "a resource may still be alive".
 */
export async function disposeAllResourceOwners(): Promise<void> {
	const disposers = [...resourceOwners.values()];
	resourceOwners.clear();
	const errors: unknown[] = [];
	for (const disposer of disposers) {
		try {
			await disposer();
		} catch (err) {
			errors.push(err);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, `${errors.length} resource disposer(s) failed during teardown`);
	}
}
