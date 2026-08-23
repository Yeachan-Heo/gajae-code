/**
 * Cross-process mutation lock for `gjc setup paseo` install/remove.
 *
 * `setup paseo` and `setup paseo --remove` mutate the same intent record,
 * provenance ledger, Paseo config targets, symlink bridge, and GJC settings.
 * Without serialization a concurrent remove can clear the ledger while an
 * install is still creating links and registering the bridge: the live links
 * end up with no provenance, and a later `--remove` reports
 * `nothing-to-remove`. One lock per agent directory covers recovery, target
 * updates, bridge operations, settings registration, and the final provenance
 * write for both commands.
 *
 * The lock file lives inside the same `paseo/` directory as the provenance
 * ledger, so the agent-directory root already scopes it. `withFileLock`
 * serializes contenders across processes (and async contenders inside one
 * process); a crashed holder's lock is reclaimed after its stale window.
 */

import { withFileLock } from "../../config/file-lock";
import type { PaseoSetupDependencies } from "./setup-deps";

/**
 * Stale window for a crashed holder. A healthy install/remove is never
 * displaced by elapsed time alone: the lock records its owner pid and
 * process start-time identity, and a LIVE owner is never reaped (#652 rule
 * in the shared file lock) — the stale window only bounds the
 * liveness-indeterminate fallback (a pid whose liveness cannot be proven
 * from this host). A holder that is provably alive keeps the lock for as
 * long as its operation runs, so the lease cannot expire under a healthy
 * operation, and ACQUIRE_TIMEOUT_MS below still waits out a contender
 * instead of displacing it.
 */
const STALE_MS = 60_000;

/** Total wait before giving up: a contending run is awaited, never displaced. */
const ACQUIRE_TIMEOUT_MS = 120_000;

const RETRY_DELAY_MS = 100;

export function paseoMutationLockPath(deps: PaseoSetupDependencies): string {
	return `${deps.paths.provenanceLedger}.mutation.lock`;
}

/** Run `operation` holding the per-agent-directory Paseo mutation lock. */
export async function withPaseoMutationLock<T>(deps: PaseoSetupDependencies, operation: () => Promise<T>): Promise<T> {
	const retries = Math.max(1, Math.ceil(ACQUIRE_TIMEOUT_MS / RETRY_DELAY_MS));
	return await withFileLock(paseoMutationLockPath(deps), operation, {
		staleMs: STALE_MS,
		retries,
		retryDelayMs: RETRY_DELAY_MS,
	});
}
