import { createHash } from "node:crypto";
import {
	acquireManagedLock,
	type ManagedDirectoryRoot,
	type ManagedSessionSecurityPolicy,
	type ManagedStorageLock,
} from "./managed-session-storage";

/**
 * One short cross-process transaction per managed session.
 *
 * Two processes may open the same session and keep independent branches, so no
 * process receives a lifetime writer lease. What must be serialized is the
 * persistence step itself: read the committed transcript, validate the parent and
 * the new records against it, publish, and report a definitive outcome.
 *
 * The lease name is derived from the logical session identity, never from the
 * transcript path. Managed publication replaces the transcript file on some
 * platforms, so a lock keyed to the file would be lost exactly when two writers
 * race. Deriving the name by digest also keeps an arbitrary session id from
 * becoming a path component.
 *
 * Caller obligations:
 * - Pass the session's own managed lock directory, never a cwd-derived one. The
 *   exclusion token is the pair (directory, session id), so two different
 *   directories silently stop excluding each other.
 * - Do not nest the same session's transaction: the nested acquire contends with
 *   this process's own lease and reports busy after the whole wait budget.
 * - Hold the lease only for the persistence step. The lease is heartbeated, so a
 *   body that stalls on network or user input keeps every other writer waiting;
 *   a process that dies mid-body leaves the session busy until its lease expires.
 */
export const MANAGED_SESSION_TRANSACTION_LOCK_PREFIX = "session-transaction-v1-";

/** Raised when the session transaction could not be acquired inside its bound. */
export class ManagedSessionBusyError extends Error {
	readonly code = "managed_session_transaction_busy";
	readonly sessionId: string;

	constructor(sessionId: string) {
		super("managed_session_transaction_busy");
		this.name = "ManagedSessionBusyError";
		this.sessionId = sessionId;
	}
}

/** Raised inside the body once this process no longer provably holds the lease. */
export class ManagedSessionOwnershipLostError extends Error {
	readonly code = "managed_session_ownership_lost";
	readonly sessionId: string;

	constructor(sessionId: string, cause: unknown) {
		super("managed_session_ownership_lost", {
			cause: cause instanceof Error ? cause : new Error(String(cause)),
		});
		this.name = "ManagedSessionOwnershipLostError";
		this.sessionId = sessionId;
	}
}

/**
 * Raised when a finished body could not prove it released its lease.
 *
 * A caller that sees this does not know whether its own publication landed, so it
 * must reconcile against canonical state instead of retrying the persistence step
 * blindly. `outcome` carries the body's return value when the body completed;
 * `bodyError` carries its failure when it threw.
 */
export class ManagedSessionReleaseError extends Error {
	readonly code = "managed_session_release_failed";
	readonly sessionId: string;
	readonly outcome: unknown;
	readonly bodyError: unknown;

	constructor(sessionId: string, releaseError: unknown, detail: { outcome?: unknown; bodyError?: unknown } = {}) {
		super("managed_session_release_failed", {
			cause: releaseError instanceof Error ? releaseError : new Error(String(releaseError)),
		});
		this.name = "ManagedSessionReleaseError";
		this.sessionId = sessionId;
		this.outcome = detail.outcome;
		this.bodyError = detail.bodyError;
	}
}

/** Stable lease file name for one logical session. */
export function managedSessionTransactionLockName(sessionId: string): string {
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 200)
		throw new Error("invalid_session_id");
	const digest = createHash("sha256")
		.update(`${MANAGED_SESSION_TRANSACTION_LOCK_PREFIX}${sessionId}`, "utf8")
		.digest("hex");
	return `${MANAGED_SESSION_TRANSACTION_LOCK_PREFIX}${digest}`;
}

/** Authority a caller may use to fence its own publication inside the transaction. */
export interface ManagedSessionTransactionScope {
	readonly sessionId: string;
	readonly lockPath: string;
	/**
	 * Throws {@link ManagedSessionOwnershipLostError} once this process no longer
	 * provably holds the lease, so a fenced publication can be refused instead of
	 * writing under stale ownership.
	 */
	assertOwned(): void;
}

export interface ManagedSessionTransactionOptions {
	/** The session's managed lock directory; must be owner-only and cwd-independent. */
	locksDirectory: string;
	sessionId: string;
	root?: ManagedDirectoryRoot;
	policy?: ManagedSessionSecurityPolicy;
	/** Bound on acquiring the lease. Defaults to the shared managed lock budget. */
	waitMs?: number;
}

/**
 * Run `run` while this process holds the session transaction, then release it.
 *
 * The lease never spans model calls, tool execution or user input; callers pass
 * only the persistence step. A release failure is never reported as success: a
 * caller that could not prove it released may still hold the lease, so it learns
 * about it instead of leaving another process waiting until the lease expires.
 */
export async function withManagedSessionTransaction<T>(
	options: ManagedSessionTransactionOptions,
	run: (scope: ManagedSessionTransactionScope) => T | Promise<T>,
): Promise<T> {
	const { sessionId, locksDirectory } = options;
	let lock: ManagedStorageLock;
	try {
		lock = await acquireManagedLock(
			locksDirectory,
			managedSessionTransactionLockName(sessionId),
			options.root,
			options.policy,
			{ waitMs: options.waitMs },
		);
	} catch (error) {
		if (error instanceof Error && error.message === "migration_busy") throw new ManagedSessionBusyError(sessionId);
		throw error;
	}
	const scope: ManagedSessionTransactionScope = {
		sessionId,
		lockPath: lock.path,
		assertOwned: () => {
			try {
				lock.assertOwned();
			} catch (error) {
				throw new ManagedSessionOwnershipLostError(sessionId, error);
			}
		},
	};
	let result: T | undefined;
	let bodyFailed = false;
	let bodyError: unknown;
	try {
		result = await run(scope);
	} catch (error) {
		bodyFailed = true;
		bodyError = error;
	}
	// Release outside `finally`: a release failure is a real outcome the caller
	// must see, not a control-flow side effect of an unrelated throw.
	let releaseFailed = false;
	let releaseError: unknown;
	try {
		await lock.release();
	} catch (error) {
		releaseFailed = true;
		releaseError = error;
	}
	if (bodyFailed) {
		if (releaseFailed) throw new ManagedSessionReleaseError(sessionId, releaseError, { bodyError });
		throw bodyError;
	}
	if (releaseFailed) throw new ManagedSessionReleaseError(sessionId, releaseError, { outcome: result });
	return result as T;
}
