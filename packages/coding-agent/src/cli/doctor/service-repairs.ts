import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	exactRestore,
	exactUnlink,
	type NativeExactFileIdentity,
	verifyOwnerOnlyFdSecurity,
	verifyOwnerOnlyPathSecurityExpected,
} from "@gajae-code/natives";
import { withBrokerStartupLock } from "../../sdk/broker/ensure";
import { isProcessIncarnation, observeProcessIncarnation } from "../../sdk/broker/process-incarnation";
import { SDK_STATE_VERSION } from "../../sdk/broker/state-version";
import { agentDirDigest } from "../../sdk/bus/daemon-paths";
import { withDaemonStartupExclusion } from "../../sdk/bus/daemon-startup-exclusion";
import { validMarker } from "../../sdk/bus/telegram-daemon-owner-registry";
import { canonicalServiceRootDigest } from "../../sdk/service-artifact-paths";
import type { DoctorContext, DoctorServiceTarget } from "./context";
import { readDoctorFile } from "./files";
import { DoctorJournal, DoctorJournalCreateError } from "./journal";
import {
	type DoctorArtifactObservation,
	type DoctorServiceObservation,
	parseServiceRecord,
	readDoctorService,
	serviceArtifactObservation,
} from "./service-targets";
import type { DoctorCheck, DoctorRepair } from "./types";

interface OwnerProof {
	readonly ownerId: string;
	readonly pid: number;
	readonly incarnation: string;
}
export interface DoctorStaleArtifactResult {
	readonly repair: DoctorRepair;
	readonly afterChecks?: readonly DoctorCheck[];
}

function ownerTuple(value: Record<string, unknown> | undefined): OwnerProof | undefined {
	if (
		!value ||
		typeof value.ownerId !== "string" ||
		value.ownerId.length === 0 ||
		value.ownerId.length > 256 ||
		typeof value.pid !== "number" ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0 ||
		value.pid > 0x7fff_ffff ||
		!isProcessIncarnation(value.incarnation)
	)
		return undefined;
	return { ownerId: value.ownerId, pid: value.pid, incarnation: value.incarnation };
}
function sameOwner(left: OwnerProof, right: OwnerProof | undefined): boolean {
	return !!right && left.ownerId === right.ownerId && left.pid === right.pid && left.incarnation === right.incarnation;
}
function sameIdentity(a: NativeExactFileIdentity, b: NativeExactFileIdentity): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.nlink === b.nlink &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.parentDev === b.parentDev &&
		a.parentIno === b.parentIno &&
		a.sha256 === b.sha256
	);
}
function sameObservation(a: DoctorArtifactObservation | undefined, b: DoctorArtifactObservation | undefined): boolean {
	if (!a || !b) return a === b;
	if (a.status !== b.status) return false;
	if ((a.status === "read" || a.status === "directory") && (b.status === "read" || b.status === "directory"))
		return sameIdentity(a.exactIdentity, b.exactIdentity);
	return a.status === "missing" && b.status === "missing";
}
function samePublication(
	a: DoctorServiceObservation,
	b: DoctorServiceObservation,
	detachedSlot?: DoctorServiceTarget["slot"],
): boolean {
	if (!sameObservation(a.restartIntent, b.restartIntent)) return false;
	if (detachedSlot !== "discovery" && !sameObservation(a.state, b.state)) return false;
	if (
		detachedSlot !== "owner-lock" &&
		(!sameObservation(a.owner, b.owner) || !sameObservation(a.directoryOwner, b.directoryOwner))
	)
		return false;
	if (detachedSlot !== "startup-marker" && !sameObservation(a.startupMarker, b.startupMarker)) return false;
	return (
		a.ownerMarker?.path === b.ownerMarker?.path &&
		sameObservation(a.ownerMarker?.observation, b.ownerMarker?.observation)
	);
}

async function proveOwner(context: DoctorContext, target: DoctorServiceTarget): Promise<OwnerProof | undefined> {
	const observation = target.observation;
	const rootDigest = await canonicalServiceRootDigest(context.agentRoot.locator);
	const state = parseServiceRecord(observation.state);
	const owner = parseServiceRecord(observation.owner);
	if (target.slot === "startup-marker") {
		const marker = observation.startupMarker && parseServiceRecord(observation.startupMarker);
		if (
			target.service !== "telegram" ||
			!marker ||
			marker.version !== 1 ||
			marker.rootDigest !== rootDigest ||
			typeof marker.token !== "string" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(marker.token)
		)
			return undefined;
		return ownerTuple({ ...marker, ownerId: marker.token });
	}
	if (target.service === "broker") {
		if (observation.owner.status === "missing" && target.slot === "discovery") {
			return state?.version === SDK_STATE_VERSION && state.protocolVersion === 3 && state.rootDigest === rootDigest
				? ownerTuple(state)
				: undefined;
		}
		const proof = ownerTuple(owner);
		if (!proof || owner?.version !== 1 || owner.rootDigest !== rootDigest) return undefined;
		if (
			observation.state.status !== "missing" &&
			(!state ||
				state.version !== SDK_STATE_VERSION ||
				state.protocolVersion !== 3 ||
				!sameOwner(proof, ownerTuple(state)))
		)
			return undefined;
		return proof;
	}
	if (target.service === "telegram") {
		const marker = observation.ownerMarker && parseServiceRecord(observation.ownerMarker.observation);
		if (!validMarker(marker) || marker.agentDirDigest !== agentDirDigest(marker.agentDir)) return undefined;
		const normalized = (value: string): string =>
			process.platform === "win32" ? path.resolve(value).replaceAll("\\", "/").toLowerCase() : path.resolve(value);
		if (normalized(marker.agentDir) !== normalized(context.agentRoot.locator)) return undefined;
		const proof = ownerTuple({ ...marker });
		if (!proof) return undefined;
		for (const [raw, record] of [
			[observation.state, state],
			[observation.owner, owner],
		] as const) {
			if (raw.status === "missing") continue;
			if (!record || !sameOwner(proof, ownerTuple(record)) || record.acquisitionId !== marker.acquisitionId)
				return undefined;
		}
		return proof;
	}
	if (observation.owner.status === "missing" && target.slot === "discovery") {
		return state?.version === 1 && state.kind === target.service && state.rootDigest === rootDigest
			? ownerTuple(state)
			: undefined;
	}
	const proof = ownerTuple(owner);
	if (!proof || owner?.version !== 1 || owner.rootDigest !== rootDigest) return undefined;
	if (
		observation.state.status !== "missing" &&
		(state?.version !== 1 || state.kind !== target.service || !sameOwner(proof, ownerTuple(state)))
	)
		return undefined;
	return proof;
}

async function secureObserved(file: string, observation: DoctorArtifactObservation): Promise<boolean> {
	if (observation.status !== "read" && observation.status !== "directory") return false;
	const kind = observation.status === "directory" ? "directory" : "file";
	const expected = observation.exactIdentity;
	if (kind === "file" && expected.nlink !== 1n) return false;
	if (process.platform === "win32")
		return verifyOwnerOnlyPathSecurityExpected(file, kind, expected.dev, expected.ino).ok;
	const handle = await fs.open(
		file,
		constants.O_RDONLY |
			constants.O_NOFOLLOW |
			constants.O_NONBLOCK |
			(kind === "directory" ? constants.O_DIRECTORY : 0),
	);
	try {
		const stat = await handle.stat({ bigint: true });
		return (
			stat.dev === expected.dev && stat.ino === expected.ino && verifyOwnerOnlyFdSecurity(file, kind, handle.fd).ok
		);
	} finally {
		await handle.close();
	}
}

function evidence(identity: NativeExactFileIdentity, quarantineName: string): Record<string, unknown> {
	return {
		exists: true,
		dev: identity.dev.toString(),
		ino: identity.ino.toString(),
		nlink: identity.nlink?.toString(),
		size: identity.size.toString(),
		mtimeNs: identity.mtimeNs.toString(),
		parentDev: identity.parentDev?.toString(),
		parentIno: identity.parentIno?.toString(),
		quarantineName,
	};
}

/** One canonical stale slot, retained in quarantine; never starts or signals a service. */
export async function applyDoctorStaleArtifact(
	context: DoctorContext,
	runId: string,
	target: DoctorServiceTarget,
	collectAfterChecks: () => Promise<readonly DoctorCheck[]>,
): Promise<DoctorStaleArtifactResult> {
	const base: DoctorRepair = {
		id: "service.detach-owned-stale-artifact",
		targetId: target.targetId,
		riskClasses: ["artifact-detach"],
		authorization: context.options.allowRisks,
		readiness: [],
		candidates: [],
		preconditions: [
			"canonical slot",
			"original owner and file identity",
			"positive owner death",
			"shared startup exclusion",
		],
		state: "preparing",
		sideEffectStarted: false,
		beforeCheckIds: [],
		afterCheckIds: [],
		restartRequired: false,
		nonrollbackableEffects: [],
	};
	const blocked = (reasonCode: string): DoctorStaleArtifactResult => ({
		repair: { ...base, state: "blocked", reasonCode },
	});
	if (!context.options.allowRisks.includes("artifact-detach")) return blocked("authorization_missing");
	if (
		context.options.mode !== "fix" ||
		target.kind !== "artifact" ||
		!target.slot ||
		target.targetId !== context.options.targetId
	)
		return blocked("invalid_artifact_request");
	const original = serviceArtifactObservation(target.observation, target.slot);
	if (!original) return blocked("unsupported_slot");
	if (target.observation.restartIntent.status !== "missing") return blocked("restart_reservation_present_or_unknown");
	if (original.status !== "read" && original.status !== "directory") return blocked("artifact_authority_unavailable");
	let proof: OwnerProof | undefined;
	try {
		proof = await proveOwner(context, target);
	} catch {
		return blocked("owner_observation_unavailable");
	}
	if (!proof) return blocked("owner_receipt_untrusted");
	if (observeProcessIncarnation(proof.pid).status !== "absent") return blocked("owner_death_unproven");
	const slot = target.slot;
	const file =
		slot === "discovery"
			? target.observation.paths.state
			: slot === "owner-lock"
				? (target.observation.paths.directoryOwner ?? target.observation.paths.owner)
				: target.observation.paths.startupMarker!;
	const quarantineName = `.${path.basename(file)}.doctor-${runId}`;
	const quarantine = path.join(path.dirname(file), quarantineName);
	const expected: NativeExactFileIdentity = { ...original.exactIdentity, detachOnly: true, quarantineName };
	let started = false;
	const operation = async (): Promise<DoctorStaleArtifactResult> => {
		if (context.options.signal?.aborted || performance.now() >= context.deadline)
			return blocked("cancelled_or_expired");
		const current = await readDoctorService(context.agentRoot.locator, target.service);
		if (!samePublication(target.observation, current)) return blocked("publication_changed");
		if (observeProcessIncarnation(proof!.pid).status !== "absent") return blocked("owner_death_unproven");
		if (!(await secureObserved(file, original))) return blocked("artifact_security_unproven");
		for (const [recordPath, record] of [
			[current.paths.owner, current.owner],
			[current.paths.state, current.state],
			[current.ownerMarker?.path, current.ownerMarker?.observation],
		] as const) {
			if (recordPath && record?.status === "read" && !(await secureObserved(recordPath, record)))
				return blocked("owner_receipt_security_unproven");
		}
		if (original.status === "directory") {
			const directory = await fs.opendir(file, { bufferSize: 4 });
			for await (const entry of directory)
				if (entry.name !== "owner.json" || !entry.isFile()) return blocked("unknown_linked_artifact");
		}
		let journal: DoctorJournal;
		try {
			journal = await DoctorJournal.create(context.agentRoot.locator, runId);
			started = true;
		} catch (error) {
			started = error instanceof DoctorJournalCreateError ? error.sideEffectStarted : true;
			return {
				repair: {
					...base,
					state: started ? "uncertain" : "blocked",
					sideEffectStarted: started,
					reasonCode: "journal_unavailable",
				},
			};
		}
		try {
			await journal.append({
				repairId: base.id,
				targetId: target.targetId,
				phase: "before",
				before: evidence(expected, quarantineName),
			});
			await journal.append({ repairId: base.id, targetId: target.targetId, phase: "applying" });
			if (context.options.signal?.aborted || performance.now() >= context.deadline)
				throw new Error("cancelled_or_expired");
			const detached = exactUnlink(file, expected);
			const retainedCleanup =
				detached.code === "cleanup_pending" &&
				detached.detachedPath === quarantine &&
				!detached.retainedUnknownPath &&
				!detached.retainedSuccessorPath;
			if (!detached.ok && !retainedCleanup)
				throw new Error(
					`detach_${detached.code && /^[a-z_]{1,48}$/.test(detached.code) ? detached.code : "unverified"}`,
				);
			if (detached.detachedPath !== quarantine) throw new Error("quarantine_path_mismatch");
			const after = await readDoctorService(context.agentRoot.locator, target.service);
			if (
				serviceArtifactObservation(after, slot)?.status !== "missing" ||
				!samePublication(target.observation, after, slot)
			)
				throw new Error("publication_changed");
			if (original.status === "read") {
				const retained = await readDoctorFile(quarantine);
				if (retained.status !== "read" || !sameIdentity(original.exactIdentity, retained.exactIdentity))
					throw new Error("quarantine_identity_changed");
			} else {
				const retained = await fs.lstat(quarantine, { bigint: true });
				const parent = await fs.lstat(path.dirname(quarantine), { bigint: true });
				if (
					!retained.isDirectory() ||
					retained.isSymbolicLink() ||
					retained.dev !== expected.dev ||
					retained.ino !== expected.ino ||
					retained.nlink !== expected.nlink ||
					retained.size !== expected.size ||
					retained.mtimeNs !== expected.mtimeNs ||
					parent.isSymbolicLink() ||
					parent.dev !== expected.parentDev ||
					parent.ino !== expected.parentIno
				)
					throw new Error("quarantine_identity_changed");
			}
			if (retainedCleanup) {
				const parent = await fs.open(
					path.dirname(file),
					constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				try {
					const identity = await parent.stat({ bigint: true });
					if (identity.dev !== expected.parentDev || identity.ino !== expected.parentIno)
						throw new Error("quarantine_identity_changed");
					await parent.sync();
				} finally {
					await parent.close();
				}
			}
			const afterChecks = await collectAfterChecks();
			if (
				!afterChecks.some(
					check =>
						check.targetId === target.targetId &&
						check.execution === "completed" &&
						check.evidence.present === false,
				)
			)
				throw new Error("artifact_postcheck_missing");
			await journal.append({
				repairId: base.id,
				targetId: target.targetId,
				phase: "verified",
				after: { exists: false, quarantineName },
				outcome: "verified",
			});
			return {
				repair: {
					...base,
					state: "verified",
					sideEffectStarted: true,
					outcome: { mutationVerified: true },
					nonrollbackableEffects: ["artifact_retained_in_quarantine"],
				},
				afterChecks,
			};
		} catch (error) {
			const known = new Set([
				"cancelled_or_expired",
				"quarantine_path_mismatch",
				"publication_changed",
				"quarantine_identity_changed",
				"artifact_postcheck_missing",
			]);
			const reasonCode =
				error instanceof Error && (known.has(error.message) || /^detach_[a-z_]{1,48}$/.test(error.message))
					? error.message
					: "artifact_detach_unverified";
			let state: DoctorRepair["state"] = "uncertain";
			try {
				const current = await readDoctorService(context.agentRoot.locator, target.service);
				if (
					serviceArtifactObservation(current, slot)?.status === "missing" &&
					samePublication(target.observation, current, slot) &&
					observeProcessIncarnation(proof!.pid).status === "absent"
				) {
					const restored = exactRestore(quarantine, file, {
						...original.exactIdentity,
						detachOnly: false,
						quarantineName: undefined,
					});
					const restoredState = await readDoctorService(context.agentRoot.locator, target.service);
					if (restored.ok && sameObservation(original, serviceArtifactObservation(restoredState, slot)))
						state = "rolled_back";
				} else if (!samePublication(target.observation, current, slot)) state = "rollback_conflict";
			} catch {
				state = "uncertain";
			}
			try {
				await journal.append({
					repairId: base.id,
					targetId: target.targetId,
					phase: state === "rolled_back" ? "failed" : "uncertain",
					outcome: state,
				});
			} catch {
				state = "uncertain";
			}
			return { repair: { ...base, state, sideEffectStarted: true, reasonCode } };
		} finally {
			journal.close();
		}
	};
	try {
		return target.service === "broker"
			? await withBrokerStartupLock(context.agentRoot.locator, operation)
			: await withDaemonStartupExclusion(context.agentRoot.locator, target.service, operation, {
					signal: context.options.signal,
					timeoutMs: Math.max(1, context.deadline - performance.now()),
				});
	} catch {
		return {
			repair: {
				...base,
				state: started ? "uncertain" : "blocked",
				sideEffectStarted: started,
				reasonCode: "startup_exclusion_unavailable",
			},
		};
	}
}
