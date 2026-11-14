import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
export const OWNED_TEMP_ROOT_PREFIXES = {
	shell_snapshots: "gjc-shell-snapshots-",
	sdk_snapshots: "gjc-sdk-snapshots-",
	python_runners: "gjc-python-runner-",
} as const;

export type OwnedTempRootKind = keyof typeof OWNED_TEMP_ROOT_PREFIXES;

/**
 * Per-process temp roots that are removed only by a postmortem exit hook.
 *
 * That hook never runs when the process is killed or crashes, or inside a bun
 * test isolate, so the root would be left in the OS temp directory forever.
 * Each root is therefore named `<prefix><owner pid>[.<ns-inode>]-<random>` where:
 * - On Linux, `.ns-inode` is the inode of /proc/self/ns/pid (PID namespace identity),
 *   used by `gjc gc` to prove the root belongs to this namespace before probing the pid.
 *   Roots without a namespace part (created before this change) are kept to prevent
 *   cross-namespace pruning; roots in different namespaces are also kept.
 * - On non-Linux, `ns-inode` is omitted (no PID namespaces); pid-only probing is used.
 * The pid is what lets `gjc gc` prove a leftover root is abandoned within the same namespace.
 */

/**
 * Cached PID namespace inode (Linux only).
 * Once set to null (failure), remains null for the process lifetime.
 * Note: A transient /proc read failure at startup leaves the producer unable to
 * emit namespace-protected roots for its entire lifetime. Collectors downgrade
 * these to PID-only behavior, which is retained even if /proc becomes readable later.
 */
let cachedPidNamespaceIno: number | null | undefined;

/**
 * Parse the PID namespace inode from /proc/self/ns/pid on Linux.
 * Returns the inode number, or `undefined` if it cannot be determined or on non-Linux.
 * Result is cached for the process lifetime: successful reads return the inode on
 * every call; failed reads (transient or permanent) always return undefined.
 */
function getPidNamespaceIno(): number | undefined {
	if (cachedPidNamespaceIno !== undefined) return cachedPidNamespaceIno ?? undefined;
	if (process.platform !== "linux") {
		cachedPidNamespaceIno = null;
		return undefined;
	}
	try {
		const stat = fs.statSync("/proc/self/ns/pid");
		cachedPidNamespaceIno = stat.ino;
		return stat.ino;
	} catch {
		cachedPidNamespaceIno = null;
		return undefined;
	}
}

/** `mkdtemp` template for a root of `kind` owned by this process. */
export function ownedTempRootTemplate(tempRoot: string, kind: OwnedTempRootKind): string {
	const nsIno = getPidNamespaceIno();
	const pidPart = nsIno !== undefined ? `${process.pid}.${nsIno}` : String(process.pid);
	return path.join(tempRoot, `${OWNED_TEMP_ROOT_PREFIXES[kind]}${pidPart}-`);
}

/**
 * Owner identity parsed from a root name of `kind`.
 * - `pid`: the owner process ID (always present if the name is valid)
 * - `pidNamespace`: the inode of the owner's PID namespace on Linux (undefined on non-Linux or if absent)
 * Returns `undefined` if the name does not carry a valid owner identity.
 */
export interface OwnerIdentity {
	pid: number;
	pidNamespace?: number;
}

/**
 * Parse owner identity from a root name of `kind`.
 * Returns `undefined` for any name that does not carry a valid owner.
 */
export function parseOwnedTempRootOwner(kind: OwnedTempRootKind, name: string): OwnerIdentity | undefined {
	const prefix = OWNED_TEMP_ROOT_PREFIXES[kind];
	if (!name.startsWith(prefix)) return undefined;
	// Match either "<pid>-<random>" or "<pid>.<nsIno>-<random>"
	const match = /^([1-9][0-9]*)(?:\.([1-9][0-9]*))?-[^-]+$/.exec(name.slice(prefix.length));
	if (!match) return undefined;
	const pid = Number(match[1]);
	if (!Number.isSafeInteger(pid)) return undefined;
	let pidNamespace: number | undefined;
	if (match[2]) {
		const ns = Number(match[2]);
		if (!Number.isSafeInteger(ns)) return undefined; // Reject unsafe namespace values
		pidNamespace = ns;
	}
	return { pid, pidNamespace };
}

/**
 * Owner pid encoded in a root name of `kind`, or `undefined` for any other name.
 * Deprecated: use parseOwnedTempRootOwner instead.
 */
export function ownedTempRootOwnerPid(kind: OwnedTempRootKind, name: string): number | undefined {
	const identity = parseOwnedTempRootOwner(kind, name);
	return identity?.pid;
}

/**
 * Temp directory owned roots live under, with the same env precedence as `os.tmpdir()`:
 * TEMP, then TMP on Windows; TMPDIR elsewhere. Producers and the `gjc gc` collector share it
 * so the collector scans exactly where roots are created.
 */
export function resolveTempRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") {
		return env.TEMP || env.TMP || os.tmpdir();
	}
	return env.TMPDIR || os.tmpdir();
}
