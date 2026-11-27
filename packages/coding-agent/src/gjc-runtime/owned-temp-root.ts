import { createHash } from "node:crypto";
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
 * Each root is therefore named `<prefix><owner pid>[.<scope>]-<random>` where:
 * - On Linux, `scope` is the producer's host-and-PID-namespace identity (see
 *   {@link currentOwnerScope}); `gjc gc` only probes the pid when it matches the collector's own
 *   scope and keeps every other Linux root, including ones without a scope part.
 * - Elsewhere the part is omitted and the pid is probed directly.
 * The pid is what lets `gjc gc` prove a leftover root is abandoned.
 */

/**
 * Host-and-PID-namespace identity of this process on Linux, or `undefined` elsewhere or when
 * it cannot be read: the first 16 hex chars of sha256(kernel boot id, PID-namespace inode).
 * The boot id is unique per running kernel, so it separates hosts sharing a temp directory
 * (the initial PID-namespace inode is the same constant on every host); the namespace inode
 * separates containers on one host. Producers stamp it into root names and the collector only
 * probes a pid whose root carries its own scope, so a pid is never probed outside its kernel
 * and namespace.
 */
export function currentOwnerScope(): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		if (!bootId) return undefined;
		return ownerScopeOf(bootId, fs.statSync("/proc/self/ns/pid").ino);
	} catch {
		return undefined;
	}
}

/** Owner scope for a kernel boot id and PID-namespace inode (see {@link currentOwnerScope}). */
export function ownerScopeOf(bootId: string, pidNamespace: number): string {
	return createHash("sha256").update(`${bootId}\0${pidNamespace}`).digest("hex").slice(0, 16);
}

/** `mkdtemp` template for a root of `kind` owned by this process. */
export function ownedTempRootTemplate(tempRoot: string, kind: OwnedTempRootKind): string {
	const scope = currentOwnerScope();
	const pidPart = scope !== undefined ? `${process.pid}.${scope}` : String(process.pid);
	return path.join(tempRoot, `${OWNED_TEMP_ROOT_PREFIXES[kind]}${pidPart}-`);
}

/** Owner identity parsed from a root name: the owner pid and, on Linux, its owner scope. */
export interface OwnerIdentity {
	pid: number;
	scope?: string;
}

/** Owner identity encoded in a root name of `kind`, or `undefined` for any name that carries none. */
export function parseOwnedTempRootOwner(kind: OwnedTempRootKind, name: string): OwnerIdentity | undefined {
	const prefix = OWNED_TEMP_ROOT_PREFIXES[kind];
	if (!name.startsWith(prefix)) return undefined;
	const match = /^([1-9][0-9]*)(?:\.([0-9a-f]{16}))?-[^-]+$/.exec(name.slice(prefix.length));
	if (!match) return undefined;
	const pid = Number(match[1]);
	if (!Number.isSafeInteger(pid)) return undefined;
	return match[2] === undefined ? { pid } : { pid, scope: match[2] };
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
