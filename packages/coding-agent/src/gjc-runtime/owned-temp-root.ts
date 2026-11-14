import * as os from "node:os";
import * as path from "node:path";

/**
 * Per-process temp roots that are removed only by a postmortem exit hook.
 *
 * That hook never runs when the process is killed or crashes, or inside a bun
 * test isolate, so the root would be left in the OS temp directory forever.
 * Each root is therefore named `<prefix><owner pid>-<random>`; the pid is what
 * lets `gjc gc` prove a leftover root is abandoned.
 */
export const OWNED_TEMP_ROOT_PREFIXES = {
	shell_snapshots: "gjc-shell-snapshots-",
	sdk_snapshots: "gjc-sdk-snapshots-",
	python_runners: "gjc-python-runner-",
} as const;

export type OwnedTempRootKind = keyof typeof OWNED_TEMP_ROOT_PREFIXES;

/** `mkdtemp` template for a root of `kind` owned by this process. */
export function ownedTempRootTemplate(tempRoot: string, kind: OwnedTempRootKind): string {
	return path.join(tempRoot, `${OWNED_TEMP_ROOT_PREFIXES[kind]}${process.pid}-`);
}

/** Owner pid encoded in a root name of `kind`, or `undefined` for any other name. */
export function ownedTempRootOwnerPid(kind: OwnedTempRootKind, name: string): number | undefined {
	const prefix = OWNED_TEMP_ROOT_PREFIXES[kind];
	if (!name.startsWith(prefix)) return undefined;
	const match = /^([1-9][0-9]*)-[^-]+$/.exec(name.slice(prefix.length));
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) ? pid : undefined;
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
