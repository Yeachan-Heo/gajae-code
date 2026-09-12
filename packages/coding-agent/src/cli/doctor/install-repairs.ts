/**
 * `install.restore-binary` (D4) domain logic: read-only descriptor plus the
 * bounded standalone-binary restore transaction.
 *
 * All mutation flows through the shared `install-activation.ts` authority so
 * `gjc doctor` and `gjc update` never maintain competing activation state:
 * this module never calls the native `exactReplaceRetained` primitive
 * directly, it only builds/writes the v1 record and then delegates the
 * actual promotion (and every retry of an interrupted one) to
 * `reconcileActivationRecord`.
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isCompiledBinary, VERSION } from "@gajae-code/utils";
import { isUpdateChannel } from "../../config/update-channel";
import {
	activationRecordPath,
	type DirectoryIdentity,
	type FileIdentity,
	readActivationRecord,
	sameDirectoryIdentity,
	sameFileIdentity,
	snapshotDirectory,
	snapshotRegularFile,
} from "../install-activation";
import {
	acquireBinaryUpdateLock,
	fetchAndVerifyOfficialPinnedCandidate,
	isProtectedSourcePathForInstall,
	replaceBinaryForUpdate,
	smokeTestPinnedCandidate,
} from "../update-cli";

export type InstallSourceKind = "standalone" | "source" | "npm-wrapper" | "unknown";

/**
 * The trust anchor for "this target is the exact binary the current process
 * was dispatched from": a real ELF/PE/Mach-O header on disk proves nothing
 * about ownership by itself. Only the currently-running compiled image's own
 * resolved path counts. Injectable so tests can simulate a compiled dispatch
 * without spawning a real binary.
 */
export interface InstallDispatchAuthority {
	readonly compiled: boolean;
	/** Realpath of the currently dispatched compiled image (process.execPath). */
	readonly selfPath: string;
	readonly version: string;
}

export function currentInstallDispatchAuthority(): InstallDispatchAuthority {
	let selfPath: string;
	try {
		selfPath = realpathSync(process.execPath);
	} catch {
		selfPath = path.resolve(process.execPath);
	}
	return { compiled: isCompiledBinary(), selfPath, version: VERSION };
}

export interface InstallRestoreDescriptorV1 {
	readonly schemaVersion: 1;
	readonly kind: "install.restore-binary";
	readonly targetPath: string;
	readonly channel: string;
	readonly version: string;
	readonly ref?: string;
	readonly owned: boolean;
	readonly sourceKind: InstallSourceKind;
	readonly targetIdentity?: FileIdentity;
	readonly parentIdentity?: DirectoryIdentity;
	readonly targetDigest?: string;
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly writes: false;
	readonly fetch: false;
	readonly execute: false;
}

export interface RestoreCandidate {
	readonly ref: string;
	readonly channel: string;
	readonly sha256: string;
	readonly version: string;
	readonly os: NodeJS.Platform;
	readonly arch: string;
}

export interface InstallRepairDependencies {
	readonly fetchCandidate: (candidate: RestoreCandidate, stagingPath: string) => Promise<void>;
	readonly verifyCandidate: (stagingPath: string, candidate: RestoreCandidate) => Promise<void>;
	readonly smokeCandidate: (stagingPath: string, candidate: RestoreCandidate) => Promise<void>;
}

const DEFAULT_INSTALL_REPAIR_DEPENDENCIES: InstallRepairDependencies = {
	fetchCandidate: fetchAndVerifyOfficialPinnedCandidate,
	verifyCandidate: async (stagingPath, candidate) => {
		const snapshot = await snapshotRegularFile(stagingPath);
		if (!snapshot || snapshot.identity.sha256.toLowerCase() !== candidate.sha256.toLowerCase())
			throw new Error("candidate_digest_mismatch");
	},
	smokeCandidate: (stagingPath, candidate) => smokeTestPinnedCandidate(candidate, stagingPath),
};

export type InstallRepairState = "verified" | "not_needed" | "pending_activation" | "blocked" | "conflict" | "failed";

export interface InstallRepairResult {
	readonly state: InstallRepairState;
	readonly reason?: string;
	readonly recordPath?: string;
	readonly sideEffectStarted: boolean;
	/** Present only for a pre-mutation Windows sharing violation (nothing was renamed). */
	readonly windowsErrorCode?: string;
	readonly before?: { readonly identity?: FileIdentity; readonly digest?: string };
	readonly after?: { readonly identity?: FileIdentity; readonly digest?: string; readonly version?: string };
}

function isNpmWrapper(targetPath: string): boolean {
	return (
		/\.(cmd|ps1)$/i.test(targetPath) &&
		path
			.basename(targetPath)
			.replace(/\.(cmd|ps1)$/i, "")
			.toLowerCase() === "gjc"
	);
}

async function classifySource(
	targetPath: string,
	authority: InstallDispatchAuthority,
	targetSnapshotOk: boolean,
): Promise<InstallSourceKind> {
	if (isNpmWrapper(targetPath)) return "npm-wrapper";
	if (isProtectedSourcePathForInstall(targetPath)) return "source";
	if (!authority.compiled || !targetSnapshotOk) return "unknown";
	try {
		const real = await fs.realpath(path.resolve(targetPath));
		return real === authority.selfPath ? "standalone" : "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * Read-only restore preview. Never writes, fetches, or executes anything.
 * Tolerant of any on-disk state: a missing/symlinked/foreign target reports
 * `sourceKind: "unknown"` with `owned: false` rather than throwing, since a
 * dry-run/diagnostic descriptor must never fail on account of the very
 * conditions it exists to report.
 */
export async function describeInstallRestore(
	targetPath: string,
	authority: InstallDispatchAuthority = currentInstallDispatchAuthority(),
	channel = "stable",
	ref?: string,
): Promise<InstallRestoreDescriptorV1> {
	const resolvedTarget = path.resolve(targetPath);
	let targetSnapshot: { readonly header: Uint8Array; readonly identity: FileIdentity } | undefined;
	try {
		targetSnapshot = await snapshotRegularFile(resolvedTarget);
	} catch {
		targetSnapshot = undefined;
	}
	let parentIdentity: DirectoryIdentity | undefined;
	try {
		parentIdentity = await snapshotDirectory(path.dirname(resolvedTarget));
	} catch {
		parentIdentity = undefined;
	}
	const sourceKind = await classifySource(resolvedTarget, authority, targetSnapshot !== undefined);
	return {
		schemaVersion: 1,
		kind: "install.restore-binary",
		targetPath: resolvedTarget,
		channel,
		version: authority.version,
		...(ref ? { ref } : {}),
		owned: sourceKind === "standalone",
		sourceKind,
		targetIdentity: targetSnapshot?.identity,
		parentIdentity,
		targetDigest: targetSnapshot?.identity.sha256,
		platform: process.platform,
		arch: process.arch,
		writes: false,
		fetch: false,
		execute: false,
	};
}

/**
 * Repair a proven-standalone target by staging, verifying, and promoting a
 * pinned candidate through the shared activation authority.
 *
 * An unresolved transaction is resumed only for the identical explicit pin.
 * Both fresh and resumed publication use the normal updater's mandatory
 * installed verification and identity-bound compensation; no second candidate
 * is activated implicitly.
 */
export async function repairStandaloneBinary(
	targetPath: string,
	descriptor: InstallRestoreDescriptorV1,
	candidate: RestoreCandidate,
	authorizations: readonly string[],
	deps: InstallRepairDependencies = DEFAULT_INSTALL_REPAIR_DEPENDENCIES,
): Promise<InstallRepairResult> {
	const before = { identity: descriptor.targetIdentity, digest: descriptor.targetDigest };
	const recordPath = activationRecordPath(targetPath);
	const blocked = (reason: string): InstallRepairResult => ({
		state: "blocked",
		reason,
		sideEffectStarted: false,
		before,
		recordPath,
	});
	if (
		!authorizations.includes("install-replace") ||
		!authorizations.includes("network") ||
		!authorizations.includes("external-execution")
	)
		return blocked("authorization_missing");
	if (!isUpdateChannel(candidate.channel) || candidate.os !== process.platform || candidate.arch !== process.arch)
		return blocked("candidate_platform_or_channel_mismatch");
	if (!/^[a-f0-9]{64}$/i.test(candidate.sha256)) return blocked("candidate_digest_invalid");
	if (
		!descriptor.owned ||
		descriptor.sourceKind !== "standalone" ||
		descriptor.targetPath !== path.resolve(targetPath)
	)
		return blocked("source_not_owned_standalone");
	if (
		candidate.version !== descriptor.version ||
		candidate.channel !== descriptor.channel ||
		(descriptor.ref && candidate.ref !== descriptor.ref)
	)
		return blocked("candidate_provenance_mismatch");
	if (!descriptor.targetIdentity || !descriptor.parentIdentity || !descriptor.targetDigest)
		return blocked("original_snapshot_incomplete");
	const current = await snapshotRegularFile(targetPath);
	const parent = await snapshotDirectory(path.dirname(path.resolve(targetPath)));
	if (
		!current ||
		!sameFileIdentity(current.identity, descriptor.targetIdentity) ||
		!sameDirectoryIdentity(parent, descriptor.parentIdentity)
	)
		return { ...blocked("target_or_parent_changed"), state: "conflict" };
	const observedRecord = await readActivationRecord(targetPath);
	if (observedRecord.status === "malformed" || observedRecord.status === "foreign")
		return blocked("activation_record_untrusted");
	const pending =
		observedRecord.status === "valid" &&
		observedRecord.record.phase !== "verified" &&
		observedRecord.record.phase !== "rolled_back";
	if (!pending && descriptor.targetDigest === candidate.sha256.toLowerCase())
		return {
			state: "not_needed",
			sideEffectStarted: false,
			before,
			after: { identity: current.identity, digest: current.identity.sha256, version: candidate.version },
			recordPath,
		};
	if (
		pending &&
		observedRecord.status === "valid" &&
		(observedRecord.record.candidate.digest !== candidate.sha256.toLowerCase() ||
			observedRecord.record.candidate.version !== candidate.version ||
			observedRecord.record.candidate.ref !== candidate.ref ||
			observedRecord.record.candidate.channel !== candidate.channel)
	)
		return blocked("candidate_provenance_mismatch");
	const release = await acquireBinaryUpdateLock(targetPath);
	let started = false;
	try {
		const rechecked = await snapshotRegularFile(targetPath);
		const parentNow = await snapshotDirectory(path.dirname(path.resolve(targetPath)));
		if (
			!rechecked ||
			!sameFileIdentity(rechecked.identity, descriptor.targetIdentity) ||
			!sameDirectoryIdentity(parentNow, descriptor.parentIdentity)
		)
			return { ...blocked("target_or_parent_changed"), state: "conflict" };
		const stagingPath =
			pending && observedRecord.status === "valid"
				? observedRecord.record.stagingPath
				: `${path.resolve(targetPath)}.restore.${randomUUID()}`;
		started = true;
		if (!pending) await deps.fetchCandidate(candidate, stagingPath);
		const verification = await replaceBinaryForUpdate({
			targetPath,
			tempPath: stagingPath,
			backupPath: `${path.resolve(targetPath)}.restore-backup.${randomUUID()}`,
			expectedVersion: candidate.version,
			originalTarget: descriptor.targetIdentity,
			originalParent: descriptor.parentIdentity,
			candidate: { channel: candidate.channel, ref: candidate.ref, sha256: candidate.sha256.toLowerCase() },
			verifyStagedVersion: async file => {
				await deps.verifyCandidate(file, candidate);
				await deps.smokeCandidate(file, candidate);
			},
			verifyInstalledVersion: async version => {
				await deps.verifyCandidate(targetPath, candidate);
				await deps.smokeCandidate(targetPath, candidate);
				return { ok: true, actual: version, path: targetPath };
			},
		});
		const after = await snapshotRegularFile(targetPath);
		if (!verification.ok || !after || after.identity.sha256 !== candidate.sha256.toLowerCase())
			return { state: "failed", reason: "postcheck_failed", sideEffectStarted: true, before, recordPath };
		return {
			state: "verified",
			sideEffectStarted: true,
			before,
			after: { identity: after.identity, digest: after.identity.sha256, version: candidate.version },
			recordPath,
		};
	} catch (error) {
		const pendingActivation = error instanceof Error && error.message === "installation_pending_activation";
		const reason = pendingActivation
			? "sharing_violation"
			: error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message)
				? error.message
				: "installation_execution_unverified";
		return {
			state: pendingActivation ? "pending_activation" : started ? "failed" : "blocked",
			reason,
			sideEffectStarted: started,
			before,
			recordPath,
		};
	} finally {
		await release();
	}
}
