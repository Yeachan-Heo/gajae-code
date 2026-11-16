import { createHash, randomUUID } from "node:crypto";
import {
	buildStoredSessionEntries,
	isEntryPatchRecord,
	isHeaderPatchRecord,
	isSupportedSessionVersion,
	type StoredSessionPatchRecord,
	type StoredSessionRecord,
} from "../sdk/session-readonly/format";
import type { ResumeSessionIdentity, SessionStorageStat } from "../sdk/session-readonly/storage";
import type { PublicationDebtSnapshot, PublicationPreparedEntry } from "./publication-freeze";
import {
	isOwnerEnrollData,
	OWNER_ENROLL_CUSTOM_TYPE,
	projectResumeGraphRecord,
	type ResumeGraphReduction,
	reduceResumeTranscript,
} from "./resume-cursor";
import {
	classifyResumeOperation,
	type DurabilityProof,
	type PendingResumeOp,
	type ReconcileResult,
	type ResumeClosureEvidence,
	type ResumeCompletionRefusal,
	type ResumeFreshCapture,
	type ResumeInitialPublication,
	type ResumeManifestEntry,
	type ResumeOperationEvidence,
	type ResumePublicationSuccession,
	type ResumeReadFailure,
	type ResumeResidentEntry,
	type ResumeRouting,
	validatePublicationSuccessions,
} from "./resume-operation";
import { SessionManager, type StrictSessionOpenFailure } from "./session-manager";
import type { SessionStorage } from "./session-storage";

export function resumeCaptureByteLength(capture: ResumeFreshCapture): number {
	if (capture.bytes) return capture.bytes.byteLength;
	return capture.byteEvidence.byteLength;
}

export function resumeDigest(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Kept independently of the manager, including after close releases resident stores. */
export interface NativeResumeBinding {
	readonly path: string;
	readonly storage: SessionStorage;
	readonly preOpEntries: readonly ResumeManifestEntry[];
	readonly preOpCommittedTail: string | null;
	readonly prepared: readonly PublicationPreparedEntry[];
	readonly ledger: Map<string, ResumeResidentEntry>;
	proofs: DurabilityProof[];
	publicationSuccessions: ResumePublicationSuccession[];
	initialPublication?: ResumeInitialPublication;
	durabilityState: ResumeOperationEvidence["durabilityState"];
	attempts: number;
	lastError?: string;
	error?: Error;
	residentTip: string | null;
	lastEvidence?: ResumeOperationEvidence;
	preClose?: { readonly byteLength: number; readonly ids: readonly string[] };
}
const bindings = new WeakMap<PendingResumeOp, NativeResumeBinding>();

export function bindNativeResumeOperation(pending: PendingResumeOp, binding: NativeResumeBinding): void {
	if (bindings.has(pending)) throw new Error("resume_operation_already_bound");
	bindings.set(pending, binding);
}
export function nativeResumeBinding(pending: PendingResumeOp): NativeResumeBinding {
	const binding = bindings.get(pending);
	if (!binding) throw new Error("resume_operation_context_mismatch");
	return binding;
}
export function nativeResumePrefixLengths(pending: PendingResumeOp): number[] {
	const state = nativeResumeBinding(pending);
	const lengths = [
		pending.durabilityDebt.snapshotByteLength,
		state.initialPublication?.successor.snapshotByteLength,
		...state.publicationSuccessions.flatMap(receipt => [
			receipt.predecessor.snapshotByteLength,
			receipt.successor.snapshotByteLength,
		]),
		...state.proofs.map(proof => proof.snapshotByteLength),
	];
	return [...new Set(lengths.filter((length): length is number => length !== undefined))];
}
export function resumeManifestEntry(
	entry: PublicationPreparedEntry,
	order: number,
	kind: ResumeManifestEntry["kind"],
): ResumeManifestEntry {
	if (entry.entry.type === "session") throw new Error("resume_manifest_header");
	return Object.freeze({
		id: entry.entry.id,
		parentId: entry.entry.parentId,
		payloadDigest: entry.sha256,
		order,
		kind,
	});
}

export interface NativeResumeCapture {
	readonly capture: ResumeFreshCapture | ResumeReadFailure;
	readonly stat?: SessionStorageStat;
	readonly executionTail?: string | null;
	readonly identity?: ResumeSessionIdentity;
	readonly markers?: readonly ResumeGraphReduction["markerEvidence"][number][];
	readonly invalidOwnerMarkers?: boolean;
	readonly failure?: StrictSessionOpenFailure;
}

/** Strict descriptor capture is consumed line-by-line, never through materialize(). */
export function captureNativeResumeTranscript(
	path: string,
	storage: SessionStorage,
	prefixByteLengths: readonly number[] = [],
): NativeResumeCapture {
	const opened = SessionManager.captureTranscriptStrict(path, storage);
	if (opened.kind !== "captured") return { failure: opened, capture: { kind: "read_failed", error: opened.reason } };
	const snapshot = opened.snapshot;
	try {
		const records: Array<StoredSessionRecord | StoredSessionPatchRecord> = [];
		const entries: ResumeFreshCapture["entries"][number][] = [];
		const fingerprint = createHash("sha256");
		const requested = [...new Set([0, snapshot.identity.size, ...prefixByteLengths])].sort((a, b) => a - b);
		if (requested.some(length => !Number.isSafeInteger(length) || length < 0 || length > snapshot.identity.size))
			throw new Error("resume_capture_invalid_prefix");
		const prefixes: Array<{ byteLength: number; sha256: string }> = [];
		let prefixIndex = 0;
		let offset = 0;
		const absorb = (bytes: Uint8Array): void => {
			let consumed = 0;
			while (prefixIndex < requested.length && requested[prefixIndex]! <= offset + bytes.length) {
				const end = requested[prefixIndex]! - offset;
				fingerprint.update(bytes.subarray(consumed, end));
				consumed = end;
				prefixes.push({ byteLength: requested[prefixIndex]!, sha256: fingerprint.copy().digest("hex") });
				prefixIndex++;
			}
			fingerprint.update(bytes.subarray(consumed));
			offset += bytes.length;
		};
		const readGap = (end: number): void => {
			if (!Number.isSafeInteger(end) || end < offset || end > snapshot.identity.size)
				throw new Error("resume_capture_changed");
			while (offset < end) {
				const length = Math.min(64 * 1024, end - offset);
				const bytes = snapshot.storage.readRangeSync?.(snapshot.identity.canonicalPath, offset, length).bytes;
				if (!bytes || bytes.length !== length || bytes.some(byte => byte !== 0x0a))
					throw new Error("resume_capture_changed");
				absorb(bytes);
			}
		};
		snapshot.forEachLine((line, physicalLine) => {
			readGap(physicalLine.offset);
			const raw = Buffer.from(line);
			const lineStart = offset;
			const idx = physicalLine.idx;
			if (physicalLine.byteLength !== raw.length && physicalLine.byteLength !== raw.length + 1)
				throw new Error("resume_capture_changed");
			const physical = physicalLine.byteLength === raw.length + 1 ? Buffer.concat([raw, Buffer.from("\n")]) : raw;
			absorb(physical);
			const parsed: unknown = JSON.parse(raw.toString("utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				throw new Error("unsupported_entry_shape");
			const entry = parsed as StoredSessionRecord | StoredSessionPatchRecord;
			if (entry.type === "header_patch") {
				// Header title/star metadata and entry replay replacements do not affect
				// the graph. Validate through the shared parser gates, then retain only
				// graph-relevant patch fields rather than entire conversational payloads.
				if (isHeaderPatchRecord(entry))
					records.push({
						type: "header_patch",
						patch: entry.patch.cwd === undefined ? {} : { cwd: entry.patch.cwd },
					});
			} else if (entry.type === "entry_patch") {
				if (isEntryPatchRecord(entry)) records.push({ type: "entry_patch", entryId: entry.entryId, patch: {} });
			} else {
				const graph = projectResumeGraphRecord(entry);
				if (graph.type === "session") {
					if (!isSupportedSessionVersion(graph.version)) throw new Error("unsupported_session_version");
					const version = graph.version;
					if (version !== undefined && typeof version !== "number") throw new Error("unsupported_session_version");
					records.push({ ...graph, version });
				} else {
					records.push(graph);
					entries.push({
						id: graph.id,
						parentId: graph.parentId,
						payloadDigest: resumeDigest(raw),
						order: idx,
						range: { id: graph.id, idx, start: lineStart, end: offset, hash: resumeDigest(physical) },
					});
				}
			}
			return undefined;
		});
		readGap(snapshot.identity.size);
		const fullDigest = fingerprint.digest("hex");
		if (
			offset !== snapshot.identity.size ||
			fullDigest !== snapshot.identity.sha256 ||
			prefixIndex !== requested.length
		)
			throw new Error("resume_capture_changed");
		const stat = snapshot.getLastReadStat() ?? storage.statSync(path);
		const graph = buildStoredSessionEntries(records).map(projectResumeGraphRecord);
		const reduction = reduceResumeTranscript(graph, snapshot.identity.sha256);
		const foreignMarkers = new Set(
			graph.flatMap(entry => {
				if (
					entry.type === "session" ||
					entry.type !== "custom" ||
					entry.customType !== OWNER_ENROLL_CUSTOM_TYPE ||
					typeof entry.data !== "object" ||
					entry.data === null ||
					Array.isArray(entry.data) ||
					!("bind" in entry.data) ||
					typeof entry.data.bind !== "string" ||
					entry.data.bind === reduction.checkpoint.headerId ||
					!isOwnerEnrollData(entry.data, entry.data.bind)
				)
					return [];
				return [entry.id];
			}),
		);
		const rechecked = snapshot.revalidate();
		if (rechecked.kind !== "valid")
			return { failure: rechecked, capture: { kind: "read_failed", error: rechecked.reason } };
		return {
			stat,
			identity: Object.freeze({ ...snapshot.identity }),
			markers: Object.freeze(
				reduction.markerEvidence.map(marker =>
					Object.freeze({ entryId: marker.entryId, data: Object.freeze({ ...marker.data }) }),
				),
			),
			invalidOwnerMarkers: reduction.diagnostics.some(
				diagnostic => diagnostic.reason === "invalid_owner_enroll" && !foreignMarkers.has(diagnostic.entryId),
			),
			executionTail: reduction.executableEntries.at(-1)?.id ?? null,
			capture: {
				kind: "captured",
				byteEvidence: {
					kind: "descriptor_verified",
					byteLength: offset,
					fullDigest,
					ranges: entries.map(entry => entry.range),
					prefixes,
				},
				fileIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
				snapshotDigest: snapshot.identity.sha256,
				fresh: true,
				frozen: true,
				drained: true,
				entries,
				reducerView: reduction.checkpoint,
			},
		};
	} catch (error) {
		const reason =
			error instanceof Error &&
			[
				"resume_capture_invalid_prefix",
				"resume_capture_changed",
				"unsupported_entry_shape",
				"invalid_header",
				"unsupported_session_version",
			].includes(error.message)
				? error.message
				: "malformed";
		return { failure: { kind: "error", reason: "malformed" }, capture: { kind: "read_failed", error: reason } };
	} finally {
		snapshot.close();
	}
}

export function validateNativeResumeCapture(
	pending: PendingResumeOp,
	observed: NativeResumeCapture,
): ResumeCompletionRefusal | undefined {
	const state = nativeResumeBinding(pending);
	if (observed.capture.kind !== "captured") return "stale_snapshot";
	const capture = observed.capture;
	if (!validatePublicationSuccessions(pending, capture, state.publicationSuccessions, state.initialPublication))
		return "stale_snapshot";
	const expected = [...state.preOpEntries, ...state.ledger.values()];
	if (capture.entries.length > expected.length) return "foreign_progress";
	for (let index = 0; index < capture.entries.length; index++) {
		const actual = capture.entries[index]!;
		const entry = expected[index];
		if (
			!entry ||
			actual.id !== entry.id ||
			actual.parentId !== entry.parentId ||
			actual.payloadDigest !== entry.payloadDigest
		)
			return "foreign_progress";
	}
	return undefined;
}

/** Fresh-handle byte-equal repair is the only source of a repair proof. */
export function repairNativeResumeDurability(
	pending: PendingResumeOp,
	observed: NativeResumeCapture,
): NativeResumeCapture {
	const binding = nativeResumeBinding(pending);
	binding.attempts++;
	if (!binding.storage.repairDurabilitySync) {
		binding.durabilityState = "repair_unavailable";
		binding.lastError = "durability_repair_unavailable";
		return observed;
	}
	if (observed.capture.kind !== "captured" || !observed.stat) return observed;
	const before = observed.capture;
	const refusal = validateNativeResumeCapture(pending, observed);
	if (refusal) {
		binding.durabilityState = "repair_failed";
		binding.lastError = refusal;
		return observed;
	}
	const own = new Set([...pending.manifest, ...binding.ledger.values()].map(entry => entry.id));
	const ranges = before.entries.filter(entry => own.has(entry.id)).map(entry => entry.range);
	try {
		const receipt = binding.storage.repairDurabilitySync(
			binding.path,
			{ stat: observed.stat, sha256: before.snapshotDigest },
			ranges.map(range => ({ offset: range.start, length: range.end - range.start, sha256: range.hash })),
		);
		const after = captureNativeResumeTranscript(binding.path, binding.storage, nativeResumePrefixLengths(pending));
		if (
			after.capture.kind !== "captured" ||
			after.capture.snapshotDigest !== before.snapshotDigest ||
			after.capture.fileIdentity.dev !== before.fileIdentity.dev ||
			after.capture.fileIdentity.ino !== before.fileIdentity.ino ||
			receipt.namespaceSynced !== true ||
			receipt.sha256 !== before.snapshotDigest ||
			String(receipt.stat.dev) !== before.fileIdentity.dev ||
			String(receipt.stat.ino) !== before.fileIdentity.ino ||
			receipt.ranges.length !== ranges.length ||
			receipt.ranges.some(
				(range, i) =>
					range.offset !== ranges[i]!.start ||
					range.length !== ranges[i]!.end - ranges[i]!.start ||
					range.sha256 !== ranges[i]!.hash,
			)
		)
			throw new Error("resume_repair_recapture_changed");
		binding.proofs.push(
			Object.freeze({
				kind: "sync_ok",
				fileIdentity: before.fileIdentity,
				namespaceSynced: true,
				publicationId:
					binding.publicationSuccessions.at(-1)?.publicationId ??
					binding.initialPublication?.publicationId ??
					randomUUID(),
				snapshotDigest: before.snapshotDigest,
				initialPublication: binding.initialPublication,
				snapshotByteLength: resumeCaptureByteLength(before),
				op: pending.op,
				idxs: ranges.map(range => range.idx),
				syncSeq: binding.attempts,
				ranges,
			}),
		);
		binding.durabilityState = "proven";
		binding.lastError = undefined;
		return after;
	} catch (error) {
		binding.durabilityState = "repair_failed";
		binding.lastError = String(error);
		return captureNativeResumeTranscript(binding.path, binding.storage, nativeResumePrefixLengths(pending));
	}
}

export function nativeResumeSuffix(pending: PendingResumeOp, debt: PublicationDebtSnapshot): ResumeResidentEntry[] {
	const binding = nativeResumeBinding(pending);
	const prefix = new Map(binding.preOpEntries.map(entry => [entry.id, entry]));
	const result: ResumeResidentEntry[] = [];
	for (const prepared of debt.preparedEntries) {
		if (prepared.entry.type === "session") continue;
		const base = prefix.get(prepared.entry.id);
		if (base && base.payloadDigest === prepared.sha256 && base.parentId === prepared.entry.parentId) continue;
		const recorded = binding.ledger.get(prepared.entry.id);
		const actual = resumeManifestEntry(prepared, result.length, recorded?.kind ?? "dependent");
		result.push({
			...actual,
			order: recorded?.order ?? result.length,
			residentKind:
				recorded && recorded.payloadDigest === actual.payloadDigest && recorded.parentId === actual.parentId
					? recorded.residentKind
					: "unexplained",
		});
	}
	return result;
}

/** No manager closure is captured here: survives actual resident release and restart-style POST. */
export async function captureResumeOperationAfterClose(
	pending: PendingResumeOp,
	routing: ResumeRouting,
	closure?: ResumeClosureEvidence,
): Promise<ReconcileResult> {
	const binding = nativeResumeBinding(pending);
	const capture = captureNativeResumeTranscript(
		binding.path,
		binding.storage,
		nativeResumePrefixLengths(pending),
	).capture;
	const previous = binding.lastEvidence;
	const generation = previous?.generation ?? { gFreeze: pending.g0, gPublish: pending.g0 };
	const evidence: ResumeOperationEvidence = {
		pending,
		capture,
		proofs: binding.proofs,
		publicationSuccessions: binding.publicationSuccessions,
		initialPublication: binding.initialPublication,
		durabilityState: binding.durabilityState,
		lastError: binding.lastError,
		manager: {
			kind: "terminal",
			closeOutcome: routing.closeOutcome === "none_started" ? "no_manager" : routing.closeOutcome,
			residentAttempt: closure?.residentReleased ? "discarded" : "retained",
			closure,
		},
		residentSuffix: [...binding.ledger.values()],
		residentTip: binding.residentTip,
		preOpEntries: binding.preOpEntries,
		preOpCommittedTail: binding.preOpCommittedTail,
		remainingConflict: [],
		generation,
		debt: { rewriteDebt: !closure?.residentReleased, heldQueueIds: [], deferredPublicationIds: [] },
		readiness: { writer: "unusable", currentBinding: null, localContextCurrent: false },
		context: "POST",
		routing,
		publishedAfterThaw: [],
		completionRefusal: routing.invocation === "RECON" ? "manager_closed" : undefined,
	};
	binding.lastEvidence = evidence;
	return classifyResumeOperation(evidence);
}
