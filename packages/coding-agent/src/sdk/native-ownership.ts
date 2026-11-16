import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { captureNativeResumeTranscript } from "../session/native-resume";
import {
	captureLiveCooperativeOwnerProcessesSync,
	isLiveCooperativeOwnerProcessSync,
	type OwnerAsyncInspectors,
	type OwnerInspectors,
	type OwnerMarkerEvidence,
	type OwnerTarget,
	type OwnerVetoEvidence,
} from "../session/owner-group";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import { matchesIndexedEndpointFile } from "./broker/endpoint-authority";
import { LifecycleLedger } from "./broker/lifecycle-ledger";
import { isProcessIncarnation, observeProcessIncarnation } from "./broker/process-incarnation";
import { type ReadonlySessionIdentity, SessionIndex } from "./broker/session-index";
import { isSupportedSessionVersion } from "./session-readonly/format";
import { captureManagedFileNoFollowBounded, type ManagedFileSnapshot } from "./session-readonly/inspection";

const digest = (value: unknown): string =>
	createHash("sha256")
		.update(JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item)))
		.digest("hex");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

type LedgerEvidence =
	| { kind: "clear"; digest: string }
	| { kind: "legacy_lifecycle_ambiguous"; reason: string; digest?: string }
	| { kind: "unknown_ownership"; reason: string };
type IndexEvidence =
	| {
			kind: "resolved";
			indexSeq: number;
			roots: readonly string[];
			digest: string;
			identities: readonly ReadonlySessionIdentity[];
	  }
	| { kind: "authority_roots_unresolved"; reason: string; digest?: string }
	| { kind: "unknown_ownership"; reason: string };

/** Generation-zero direct CLI rows never published endpoints; they carry no endpoint-file binding. */
function cooperativeDirectRegistrationIdentity(
	cwd: string,
	agentDir: string,
	identity: ReadonlySessionIdentity,
): boolean {
	if (
		identity.endpointGeneration !== 0 ||
		identity.lifecycleRequestId !== undefined ||
		identity.endpointMtimeMs !== undefined ||
		identity.endpointFileId !== undefined ||
		!identity.processIncarnation ||
		identity.hostIncarnation !== identity.processIncarnation
	)
		return false;
	return (
		fs.realpathSync(identity.locator.stateRoot) === fs.realpathSync(agentDir) &&
		(path.resolve(identity.locator.cwd) === path.resolve(cwd) ||
			fs.realpathSync(identity.locator.cwd) === fs.realpathSync(cwd))
	);
}
function cooperativeDirectRegistration(
	target: OwnerTarget,
	cwd: string,
	agentDir: string,
	identity: ReadonlySessionIdentity,
): boolean {
	if (!cooperativeDirectRegistrationIdentity(cwd, agentDir, identity)) return false;
	const processObservation = observeProcessIncarnation(identity.pid);
	if (processObservation.status !== "present" || processObservation.incarnation !== identity.processIncarnation)
		return false;
	return (
		identity.pid === process.pid ||
		isLiveCooperativeOwnerProcessSync(target, identity.pid, processObservation.incarnation)
	);
}

/** Descriptor/OS facts only; an absent endpoint is not proof that its writer retired. */
function endpointVeto(
	target: OwnerTarget,
	cwd: string,
	identities: readonly ReadonlySessionIdentity[],
	cooperativeAgentDir?: string,
): OwnerVetoEvidence {
	const evidence: unknown[] = [];
	const paths = new Map<string, ReadonlySessionIdentity[]>();
	for (const identity of identities) {
		if (identity.terminalUncertain || identity.ambiguous)
			return { kind: "authority_roots_unresolved", digest: digest(identity), evidence: [identity] };
		if (!identity.terminal) {
			const file = path.join(identity.locator.stateRoot, "sdk", `${target.headerId}.json`);
			const claims = paths.get(file) ?? [];
			claims.push(identity);
			paths.set(file, claims);
		}
	}
	for (const directory of [path.join(cwd, ".gjc", "state", "sdk"), path.join(cwd, ".gjc", "state", "chat", "sdk")]) {
		const file = path.join(directory, `${target.headerId}.json`);
		if (!paths.has(file)) paths.set(file, []);
	}
	for (const [file, indexed] of paths) {
		let captured: ManagedFileSnapshot;
		try {
			captured = captureManagedFileNoFollowBounded(file, 4096);
		} catch (error) {
			if (!missing(error)) return { kind: "unknown_ownership", digest: digest([file, "unreadable"]), evidence };
			const liveClaims: { pid: number; processIncarnation: string }[] = [];
			for (const identity of indexed) {
				// Only a missing path gets the existing generation-zero direct-registration exception.
				if (cooperativeAgentDir && cooperativeDirectRegistration(target, cwd, cooperativeAgentDir, identity))
					continue;
				const process = observeProcessIncarnation(identity.pid);
				evidence.push({ file, absent: true, process });
				if (cooperativeAgentDir) {
					const incarnation = identity.processIncarnation ?? identity.hostIncarnation;
					if (
						!isProcessIncarnation(incarnation) ||
						(identity.hostIncarnation !== undefined && identity.hostIncarnation !== incarnation) ||
						process.status === "unknown"
					)
						return { kind: "unknown_ownership", digest: digest(evidence), evidence };
					if (process.status === "present") {
						if (process.incarnation !== incarnation)
							return { kind: "unknown_ownership", digest: digest(evidence), evidence };
						liveClaims.push({ pid: identity.pid, processIncarnation: incarnation });
					}
					continue;
				}
				if (
					process.status === "unknown" ||
					(process.status === "present" &&
						(!identity.processIncarnation || process.incarnation === identity.processIncarnation))
				)
					return { kind: "unknown_ownership", digest: digest(evidence), evidence };
			}
			if (liveClaims.length) {
				const group = captureLiveCooperativeOwnerProcessesSync(target, liveClaims);
				evidence.push({ file, absent: true, group });
				if (!group) return { kind: "unknown_ownership", digest: digest(evidence), evidence };
			}
			continue;
		}
		let record: unknown;
		try {
			record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(captured.bytes));
		} catch {
			return { kind: "unknown_ownership", digest: digest([file, "malformed"]), evidence };
		}
		if (!record || typeof record !== "object" || Array.isArray(record))
			return { kind: "unknown_ownership", digest: digest([file, "malformed"]), evidence };
		const endpoint = record as Record<string, unknown>;
		if (
			endpoint.sessionId !== target.headerId ||
			!Number.isSafeInteger(endpoint.pid) ||
			(endpoint.pid as number) <= 0 ||
			(endpoint.version !== undefined && endpoint.version !== 1)
		)
			return { kind: "unknown_ownership", digest: digest([file, "identity_mismatch"]), evidence };
		const process = observeProcessIncarnation(endpoint.pid as number);
		evidence.push({
			file,
			identity: {
				...captured.identity,
				dev: String(captured.identity.dev),
				ino: String(captured.identity.ino),
				nlink: String(captured.identity.nlink),
				mtimeNs: String(captured.identity.mtimeNs),
				ctimeNs: String(captured.identity.ctimeNs),
			},
			process,
		});
		if (process.status === "unknown") return { kind: "unknown_ownership", digest: digest(evidence), evidence };
		const endpointStat = {
			dev: BigInt(captured.identity.dev),
			ino: BigInt(captured.identity.ino),
			mtimeMs: Number(captured.identity.mtimeNs) / 1_000_000,
		};
		if (cooperativeAgentDir) {
			const claims: { pid: number; processIncarnation: string }[] = [];
			for (const identity of indexed) {
				const incarnation = identity.processIncarnation ?? identity.hostIncarnation;
				const observation = observeProcessIncarnation(identity.pid);
				evidence.push({ file, indexed: identity, process: observation });
				if (
					!isProcessIncarnation(incarnation) ||
					(identity.hostIncarnation !== undefined &&
						(!isProcessIncarnation(identity.hostIncarnation) || identity.hostIncarnation !== incarnation)) ||
					observation.status === "unknown"
				)
					return { kind: "unknown_ownership", digest: digest(evidence), evidence };
				if (observation.status === "absent") continue;
				if (observation.incarnation !== incarnation)
					return { kind: "unknown_ownership", digest: digest(evidence), evidence };
				claims.push({ pid: identity.pid, processIncarnation: incarnation });
			}
			if (process.status === "absent") {
				if (indexed.length) return { kind: "unknown_ownership", digest: digest(evidence), evidence };
				continue;
			}
			// The endpoint is evidence of an existing member, NEVER a membership grant or own-PID shortcut.
			const group = captureLiveCooperativeOwnerProcessesSync(target, [
				{ pid: endpoint.pid as number, processIncarnation: process.incarnation },
				...claims,
			]);
			evidence.push({ file, group });
			if (!group) return { kind: "unknown_ownership", digest: digest(evidence), evidence };
			// Distinct already-proven members may replace the shared endpoint before the index catches up.
			// A same-process file/mtime contradiction is not a group transition and remains a veto.
			if (
				indexed.some(
					identity =>
						identity.pid === endpoint.pid &&
						!cooperativeDirectRegistrationIdentity(cwd, cooperativeAgentDir, identity) &&
						!matchesIndexedEndpointFile(endpointStat, identity),
				)
			)
				return { kind: "unknown_ownership", digest: digest(evidence), evidence };
			continue;
		}
		if (process.status === "absent") continue;
		let verifiedEndpoint = false;
		for (const identity of indexed) {
			// A direct generation-zero row never claimed an endpoint file. It
			// cannot disprove another exact endpoint binding or supply one itself.
			if (
				identity.endpointGeneration === 0 &&
				identity.lifecycleRequestId === undefined &&
				identity.endpointFileId === undefined &&
				identity.endpointMtimeMs === undefined &&
				identity.pid === endpoint.pid &&
				identity.processIncarnation === process.incarnation &&
				identity.hostIncarnation === process.incarnation
			)
				continue;
			if (
				identity.pid !== endpoint.pid ||
				!identity.processIncarnation ||
				!matchesIndexedEndpointFile(endpointStat, identity)
			)
				return { kind: "unknown_ownership", digest: digest(evidence), evidence };
			if (process.incarnation === identity.processIncarnation) verifiedEndpoint = true;
		}
		if (!indexed.length || (!verifiedEndpoint && indexed.every(identity => identity.endpointGeneration === 0)))
			return { kind: "unknown_ownership", digest: digest(evidence), evidence };
		if (!verifiedEndpoint) continue;
		// stale=true or terminal projections never override a verified living process.
		return { kind: "owned_by_other", digest: digest(evidence), evidence };
	}
	return { kind: "clear", digest: digest(evidence), evidence };
}

function combine(
	target: OwnerTarget,
	cwd: string,
	ledger: LedgerEvidence,
	index: IndexEvidence,
	cooperativeAgentDir?: string,
): OwnerVetoEvidence {
	const evidence: unknown[] = [ledger, index];
	if (ledger.kind !== "clear") return { kind: ledger.kind, digest: digest(evidence), evidence };
	if (index.kind !== "resolved") return { kind: index.kind, digest: digest(evidence), evidence };
	const endpoint = endpointVeto(target, cwd, index.identities, cooperativeAgentDir);
	evidence.push(endpoint);
	return { kind: endpoint.kind, digest: digest(evidence), evidence };
}

/** The real metadata parser is shared with cold checkpoint resolution. */
function readMarkers(target: OwnerTarget): OwnerMarkerEvidence {
	const observed = captureNativeResumeTranscript(target.transcriptPath, new FileSessionStorage());
	if (observed.capture.kind !== "captured") {
		if (!target.transcriptExists && observed.failure?.reason === "missing")
			return { kind: "absent", digest: digest([]), snapshotDigest: target.snapshotDigest, members: [] };
		return { kind: "unknown", digest: digest(observed.failure), snapshotDigest: target.snapshotDigest, members: [] };
	}
	if (
		observed.capture.snapshotDigest !== target.snapshotDigest ||
		observed.capture.reducerView.kind === "invalid" ||
		observed.invalidOwnerMarkers ||
		!observed.markers
	)
		return {
			kind: "unknown",
			digest: digest([target.snapshotDigest, "marker_read_failed"]),
			snapshotDigest: target.snapshotDigest,
			members: [],
		};
	const markers = observed.markers;
	return {
		kind: markers.length ? "present" : "absent",
		digest: digest(markers),
		snapshotDigest: target.snapshotDigest,
		members: markers.map(({ data }) => ({
			memberId: data.member,
			runtime: data.runtime,
			pid: data.pid,
			processIncarnation: data.processIncarnation,
			hostId: data.hostId,
			capabilities: [],
		})),
	};
}

export function createNativeOwnerInspectors(input: {
	readonly agentDir: string;
	readonly cwd: string;
}): OwnerAsyncInspectors {
	const { agentDir, cwd } = input;
	return {
		inspectVetoes: async target => {
			const ledger = await LifecycleLedger.inspectOwnershipReadOnly(agentDir, {
				sessionId: target.headerId,
				transcriptPath: target.transcriptPath,
				cwd,
			});
			const index = await SessionIndex.readAuthorityRootsReadOnly(agentDir, target.headerId);
			return combine(target, cwd, ledger, index);
		},
		readMarkers: async target => readMarkers(target),
	};
}

/** Old linear transcripts have no graph IDs yet; only the ordinary loader may migrate them. */
function readCooperativeMarkers(target: OwnerTarget): OwnerMarkerEvidence {
	const observed = readMarkers(target);
	if (observed.kind !== "unknown") return observed;
	const opened = SessionManager.captureTranscriptStrict(target.transcriptPath);
	if (opened.kind !== "captured") return observed;
	const snapshot = opened.snapshot;
	try {
		if (snapshot.identity.sha256 !== target.snapshotDigest) return observed;
		let headerSeen = false;
		snapshot.forEachLine(line => {
			const record: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
			if (!record || typeof record !== "object" || Array.isArray(record) || !("type" in record))
				throw new Error("invalid_legacy_owner_source");
			if (!headerSeen) {
				if (record.type !== "session" || !("id" in record) || record.id !== target.headerId)
					throw new Error("invalid_legacy_owner_header");
				const version = "version" in record ? record.version : undefined;
				if (!isSupportedSessionVersion(version) || (typeof version === "number" && version >= 4))
					throw new Error("not_legacy_linear_format");
				headerSeen = true;
			} else if (
				record.type === "session" ||
				record.type === "entry_patch" ||
				record.type === "header_patch" ||
				(record.type === "custom" && "customType" in record && record.customType === "gjc.owner_enroll")
			) {
				// No graph/patch or reserved metadata may be hidden by the legacy boundary.
				throw new Error("legacy_owner_evidence_requires_interpretation");
			}
		});
		if (!headerSeen || snapshot.revalidate().kind !== "valid") return observed;
		return {
			kind: "absent",
			digest: digest(["legacy_linear_no_owner", snapshot.identity.sha256]),
			snapshotDigest: target.snapshotDigest,
			members: [],
		};
	} catch {
		return observed;
	} finally {
		snapshot.close();
	}
}

const COOPERATIVE_INDEX_CHANGED_REASON = "Index changed during authority observation.";

function inspectCooperativeVetoes(target: OwnerTarget, cwd: string, agentDir: string): OwnerVetoEvidence {
	for (let attempt = 1; ; attempt++) {
		const ledger = LifecycleLedger.inspectOwnershipReadOnlySync(agentDir, {
			sessionId: target.headerId,
			transcriptPath: target.transcriptPath,
			cwd,
		});
		const index = SessionIndex.readAuthorityRootsReadOnlySync(agentDir, target.headerId);
		// A concurrent append invalidates this observation, not ownership. Recapture both
		// independent sources, at most three times total; never reuse the earlier ledger.
		if (
			attempt < 3 &&
			ledger.kind === "clear" &&
			index.kind === "unknown_ownership" &&
			index.reason === COOPERATIVE_INDEX_CHANGED_REASON
		)
			continue;
		return combine(target, cwd, ledger, index, agentDir);
	}
}

export function createCooperativeOwnerInspectors(input: {
	readonly agentDir: string;
	readonly cwd: string;
}): OwnerInspectors {
	const { agentDir, cwd } = input;
	return {
		inspectVetoes: target => inspectCooperativeVetoes(target, cwd, agentDir),
		readMarkers: readCooperativeMarkers,
	};
}
