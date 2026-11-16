import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import { resolveResumeCheckpoint } from "../../src/session/resume-cursor";
import {
	classifyResumeOperation,
	type DurabilityProof,
	P_continue,
	P_latch,
	P_retire,
	type PendingResumeOp,
	type ResumeCapturedEntry,
	type ResumeClosureEvidence,
	type ResumeDescriptorByteEvidence,
	type ResumeFreshCapture,
	type ResumeInitialPublication,
	type ResumeManifestEntry,
	type ResumeOperationEvidence,
	type ResumePublicationSuccession,
	type ResumeResidentEntry,
	validateDurabilityProof,
	validatePublicationSuccessions,
	validateResumeCaptureBytes,
} from "../../src/session/resume-operation";
import type { FileEntry, SessionEntry } from "../../src/session/session-manager";

const timestamp = "2026-11-16T00:00:00.000Z";
const identity = { dev: "1", ino: "42" };

function sha(bytes: Uint8Array | string): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function message(id: string, parentId: string | null): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content: id, timestamp: 0 } };
}

function manifestEntry(entry: SessionEntry, order: number, kind: ResumeManifestEntry["kind"]): ResumeManifestEntry {
	return { id: entry.id, parentId: entry.parentId, payloadDigest: sha(JSON.stringify(entry)), order, kind };
}

interface FixtureOptions {
	headerId?: string;
	emptyBase?: boolean;
	foreignRoot?: boolean;
	cursors?: number;
	dependents?: number;
	enroll?: boolean;
	present?: number;
	suffix?: "none" | "published" | "held" | "unproven" | "lost";
	manifestD?: boolean;
	remainingConflict?: readonly string[];
}

/** Uses actual JSONL bytes and the real reducer, never a guessed checkpoint kind. */
function fixture(options: FixtureOptions = {}): ResumeOperationEvidence {
	const headerId = options.headerId ?? "header";
	const cursors = options.cursors ?? 2;
	const dependents = options.dependents ?? 1;
	const enroll = options.enroll ?? true;
	const suffix = options.suffix ?? "none";
	const base = options.emptyBase
		? []
		: cursors === 0
			? [message("a", null)]
			: [message("a", null), message("b", null), message("c", null)];
	const target = base[0]?.id ?? null;
	if (options.foreignRoot) base.push(message("foreign", null));
	const planned: SessionEntry[] = [];
	const manifest: ResumeManifestEntry[] = [];
	function add(entry: SessionEntry, kind: ResumeManifestEntry["kind"]): void {
		manifest.push(manifestEntry(entry, manifest.length, kind));
		planned.push(entry);
	}
	if (enroll)
		add(
			{
				type: "custom",
				id: "M",
				parentId: target,
				timestamp,
				customType: "gjc.owner_enroll",
				data: {
					v: 1,
					bind: headerId,
					member: "member",
					runtime: "sdk",
					pid: 42,
					processIncarnation: "incarnation",
					hostId: "host",
					epoch: "epoch",
				},
			},
			"enroll",
		);
	for (let index = 0; index < cursors; index++)
		add(
			{
				type: "custom",
				id: `C${index + 1}`,
				parentId: index === 0 ? target : `C${index}`,
				timestamp,
				customType: "gjc.resume_cursor",
				data: {
					v: 1,
					bind: headerId,
					op: "op",
					idx: index,
					member: "member",
					reason: "explicit",
					supersedes: index === 0 ? ["b"] : index === 1 ? ["c"] : [],
				},
			},
			"cursor",
		);
	for (let index = 0; index < dependents; index++)
		add(message(`D${index + 1}`, index ? `D${index}` : cursors ? `C${cursors}` : target), "dependent");
	const presentCount = options.present ?? planned.length;
	const present = planned.slice(0, presentCount);
	const local = message("L", present.at(-1)?.id ?? target);
	const files: FileEntry[] = [
		{ type: "session", id: headerId, version: 3, timestamp, cwd: "/project" },
		...base,
		...present,
	];
	if (suffix === "published" || suffix === "unproven") files.push(local);
	const encoder = new TextEncoder();
	const bytes = encoder.encode(files.map(entry => `${JSON.stringify(entry)}\n`).join(""));
	const snapshotDigest = sha(bytes);
	let offset = 0;
	const entries: ResumeCapturedEntry[] = [];
	files.forEach((entry, order) => {
		const line = encoder.encode(`${JSON.stringify(entry)}\n`);
		if (entry.type !== "session")
			entries.push({
				id: entry.id,
				parentId: entry.parentId,
				payloadDigest: sha(JSON.stringify(entry)),
				order,
				range: { id: entry.id, idx: order, start: offset, end: offset + line.byteLength, hash: sha(line) },
			});
		offset += line.byteLength;
	});
	const capture: ResumeFreshCapture = {
		kind: "captured",
		bytes,
		fileIdentity: identity,
		snapshotDigest,
		fresh: true,
		frozen: true,
		drained: true,
		entries,
		reducerView: resolveResumeCheckpoint(files, snapshotDigest),
	};
	const policy = {
		kind: "exclusive_native" as const,
		memberKind: "sdk",
		rev: 1,
		authorityKey: "authority",
		epoch: "epoch",
	};
	const pending: PendingResumeOp = {
		op: "op",
		plan: {
			enroll: enroll ? "M" : null,
			selectionRequested: true,
			cursorIds: Array.from({ length: cursors }, (_, index) => `C${index + 1}`),
			dependentIds: Array.from({ length: dependents }, (_, index) => `D${index + 1}`),
			target,
		},
		manifest,
		CB: cursors ? `C${cursors}` : target,
		g0: { fileEntriesIndex0: base.length, entryRevision0: base.length },
		memberToken: "token",
		authorityKey: "authority",
		epoch: "epoch",
		policy,
		durabilityDebt: {
			ids: manifest.map(entry => entry.id),
			fileIdentity: identity,
			snapshotByteLength: bytes.byteLength,
			attempts: 1,
		},
	};
	const proofIds = new Set([
		...(options.manifestD === false ? [] : present.map(entry => entry.id)),
		...(suffix === "published" ? ["L"] : []),
	]);
	const ranges = entries.filter(entry => proofIds.has(entry.id)).map(entry => entry.range);
	const proof: DurabilityProof = {
		kind: "sync_ok",
		fileIdentity: identity,
		namespaceSynced: true,
		publicationId: "publication",
		snapshotDigest,
		snapshotByteLength: bytes.byteLength,
		op: "op",
		idxs: ranges.map(range => range.idx),
		syncSeq: 1,
		ranges,
	};
	const residentSuffix: ResumeResidentEntry[] =
		suffix === "none"
			? []
			: [{ ...manifestEntry(local, manifest.length, "dependent"), residentKind: "retainedLocal" }];
	const closure: ResumeClosureEvidence = {
		authorization: {
			kind: "consented_teardown",
			registryIntentId: "intent",
			stopAdmitting: true,
			runtime: "stopped_joined",
		},
		finalCaptureDigest: snapshotDigest,
		preCloseSnapshotByteLength: bytes.byteLength,
		writerClosed: true,
		drained: true,
		writesRejected: true,
		residentReleased: true,
		publishedByFinalDrain: [],
	};
	return {
		pending,
		capture,
		proofs: ranges.length ? [proof] : [],
		durabilityState: "proven",
		manager:
			suffix === "lost"
				? { kind: "terminal", closeOutcome: "closed", residentAttempt: "discarded", closure }
				: { kind: "live", strictClosePending: false, residentAttempt: "discarded" },
		residentSuffix,
		residentTip: suffix === "none" ? (planned.at(-1)?.id ?? target) : "L",
		preOpCommittedTail: base.at(-1)?.id ?? null,
		preOpEntries: base.map((entry, index) => manifestEntry(entry, index, "dependent")),
		remainingConflict: options.remainingConflict ?? [],
		generation: { gFreeze: pending.g0, gPublish: pending.g0 },
		freezeId: "freeze",
		debt: { rewriteDebt: false, heldQueueIds: suffix === "held" ? ["L"] : [], deferredPublicationIds: [] },
		readiness: { writer: "usable", currentBinding: pending, localContextCurrent: true },
		context: suffix === "lost" ? "POST" : "PRE",
		routing: {
			contextFamily: "live",
			context: "owned_pre",
			closeOutcome: "none_started",
			invocation: "RECON",
			authorization: { tokenValid: true, terminationIntent: "none", intentValid: false },
			action: "RETAIN_LIVE",
			completionResult: "n/a",
			readiness: { prior: "fenced", current: "fenced" },
		},
		publishedAfterThaw: [],
	};
}

function captured(e: ResumeOperationEvidence): ResumeFreshCapture & { readonly bytes: Uint8Array } {
	if (e.capture.kind !== "captured" || e.capture.byteEvidence !== undefined)
		throw new Error("direct-byte fixture capture missing");
	return e.capture;
}

function descriptorCapture(
	e: ResumeOperationEvidence,
	prefixLengths: readonly number[] = [],
): ResumeFreshCapture & { readonly byteEvidence: ResumeDescriptorByteEvidence } {
	const { bytes, ...base } = captured(e);
	return {
		...base,
		byteEvidence: {
			kind: "descriptor_verified",
			byteLength: bytes.byteLength,
			fullDigest: sha(bytes),
			ranges: base.entries.map(entry => entry.range),
			prefixes: prefixLengths.map(byteLength => ({ byteLength, sha256: sha(bytes.subarray(0, byteLength)) })),
		},
	};
}

function closed(e: ResumeOperationEvidence): ResumeOperationEvidence {
	if (e.capture.kind !== "captured") throw new Error("fixture capture missing");
	const capture = e.capture;
	return {
		...e,
		context: "POST",
		manager: {
			kind: "terminal",
			closeOutcome: "closed",
			residentAttempt: "discarded",
			closure: {
				authorization: {
					kind: "coordinator_abort",
					registryIntentId: "intent",
					coordinatorOpenToken: "open",
					ownership: "owned_pre",
					runtimeHandoff: false,
				},
				finalCaptureDigest: capture.snapshotDigest,
				preCloseSnapshotByteLength:
					capture.byteEvidence === undefined ? capture.bytes.byteLength : capture.byteEvidence.byteLength,
				writerClosed: true,
				drained: true,
				writesRejected: true,
				residentReleased: true,
				publishedByFinalDrain: [],
			},
		},
	};
}

function proofChanged(e: ResumeOperationEvidence, change: Partial<DurabilityProof>): ResumeOperationEvidence {
	return { ...e, proofs: e.proofs.map(proof => ({ ...proof, ...change })) };
}

describe("C5 manifest x suffix x durability truth table", () => {
	for (const full of [true, false])
		for (const suffix of ["none", "published", "held", "unproven", "lost"] as const) {
			for (const manifestD of [true, false])
				it(`${full ? "full" : "prefix"}; ${suffix}; manifest D=${manifestD}`, () => {
					const e = fixture({ present: full ? 4 : 2, suffix, manifestD });
					const result = classifyResumeOperation(e);
					const commitment = result.receipt.commitment;
					if (!manifestD) {
						expect(result.outcome.kind).toBe("unknown");
						expect(commitment.selectionCommitted).toBe(false);
						expect(commitment.operationComplete).toBe(false);
					} else {
						const incomplete = suffix === "held" || suffix === "unproven" || suffix === "lost";
						expect(result.outcome.kind).toBe(
							full ? (incomplete ? "suffix_incomplete" : "committed") : "partial_chain",
						);
						expect(commitment.selectionCommitted).toBe(full);
						expect(commitment.operationComplete).toBe(full && !incomplete);
						expect(commitment.suffixState).toBe(suffix);
					}
					expect(P_latch(e)).toBe(manifestD && full && (suffix === "none" || suffix === "published"));
					expect(P_continue(e)).toBe(P_latch(e));
					expect(P_retire(e)).toBe(manifestD && suffix === "lost");
				});
		}

	it("reports real durable cursor-prefix reduction, preserving CB separately from CF and RT", () => {
		const result = classifyResumeOperation(fixture({ present: 2, suffix: "held" }));
		expect(result.outcome.kind).toBe("partial_chain");
		expect(result.receipt.commitment.selectionEffect).toBe("cursor_prefix");
		expect(result.receipt.commitment.reducerView).toEqual({ kind: "ambiguous", candidates: ["c", "C1"], leaf: null });
		expect(result.receipt.frontier).toEqual({ CB: "C2", CF: "C1", RT: "L" });
		expect(result.receipt.selectionAppendBase).toBe("C2");
	});

	it("k>=1 marker-only is enrolled_only, but k=0 marker-only is a complete durable selection", () => {
		const markerPrefix = classifyResumeOperation(fixture({ present: 1 }));
		expect(markerPrefix.outcome.kind).toBe("enrolled_only");
		expect(markerPrefix.receipt.commitment.selectionEffect).toBe("marker_only");
		expect(markerPrefix.receipt.commitment.selectionCommitted).toBe(false);
		expect(markerPrefix.receipt.presence).toEqual({ present: ["M"], missing: ["C1", "C2", "D1"] });
		expect(markerPrefix.receipt.frontier.CF).toBe("c");
		expect(markerPrefix.receipt.finalPublishedTip).toBe("c");
		const k0PendingDependent = classifyResumeOperation(fixture({ cursors: 0, dependents: 1, present: 1 }));
		expect(k0PendingDependent.outcome.kind).toBe("dependents_absent");
		expect(k0PendingDependent.receipt.commitment.selectionCommitted).toBe(true);
		expect(k0PendingDependent.receipt.commitment.operationComplete).toBe(false);
		expect(k0PendingDependent.receipt.frontier.CF).toBe("a");
		expect(k0PendingDependent.receipt.finalPublishedTip).toBe("a");
		const k0 = classifyResumeOperation(fixture({ cursors: 0, dependents: 0 }));
		expect(k0.outcome.kind).toBe("committed");
		expect(k0.receipt.commitment.selectionCommitted).toBe(true);
		expect(k0.receipt.frontier.CF).toBe("a");
		expect(k0.receipt.finalPublishedTip).toBe("a");
		expect(classifyResumeOperation(fixture({ cursors: 0, dependents: 0, manifestD: false })).outcome.kind).toBe(
			"unknown",
		);
	});

	it("published enrollment suffix preserves the executable tip without dropping marker durability obligations", () => {
		for (const emptyBase of [false, true]) {
			for (const manifestD of [true, false]) {
				const e = fixture({ emptyBase, cursors: 0, dependents: 0, manifestD });
				const markerSuffix: ResumeOperationEvidence = {
					...e,
					residentSuffix: e.pending.manifest.map(entry => ({ ...entry, residentKind: "planned" })),
				};
				const result = classifyResumeOperation(markerSuffix);
				const tip = emptyBase ? null : "a";
				expect(result.receipt.commitment.reducerView?.candidates).toEqual(emptyBase ? [] : ["a"]);
				expect(result.receipt.presence).toEqual({ present: ["M"], missing: [] });
				expect(result.receipt.frontier.CF).toBe(tip);
				expect(result.receipt.finalPublishedTip).toBe(tip);
				expect(result.receipt.finalClassification.finalPublishedTip).toBe(tip);
				expect(result.receipt.residentSuffix).toMatchObject([
					{ id: "M", kind: "planned", state: manifestD ? "published_with_D" : "published_no_D" },
				]);
				expect(result.outcome.kind).toBe(manifestD ? "committed" : "unknown");
				expect(result.receipt.commitment.operationComplete).toBe(manifestD);
				expect(P_latch(markerSuffix)).toBe(manifestD);
				expect(P_continue(markerSuffix)).toBe(manifestD);
			}
		}
	});

	it("a durable enrollment-only resident suffix cannot replace a later executable manifest tip", () => {
		const e = fixture();
		const result = classifyResumeOperation({
			...e,
			residentSuffix: e.pending.manifest
				.filter(entry => entry.kind === "enroll")
				.map(entry => ({ ...entry, residentKind: "planned" })),
		});
		expect(result.outcome.kind).toBe("committed");
		expect(result.receipt.frontier.CF).toBe("D1");
		expect(result.receipt.finalPublishedTip).toBe("D1");
		expect(result.receipt.residentSuffix).toMatchObject([{ id: "M", state: "published_with_D" }]);
	});

	it("missing dependents do not undo an actually committed selection", () => {
		for (const [present, outcome] of [
			[3, "dependents_absent"],
			[4, "dependents_partial"],
		] as const) {
			const result = classifyResumeOperation(fixture({ dependents: 2, present }));
			expect(result.outcome.kind).toBe(outcome);
			expect(result.receipt.commitment.selectionCommitted).toBe(true);
			expect(result.receipt.commitment.operationComplete).toBe(false);
			expect(result.receipt.commitment.dependentsMissing).toEqual(present === 3 ? ["D1", "D2"] : ["D2"]);
		}
	});

	it("empty no-op is vacuously D-covered but cannot clear an existing error latch", () => {
		const e = fixture({ cursors: 0, dependents: 0, enroll: false });
		expect(classifyResumeOperation(e).outcome.kind).toBe("committed");
		expect(classifyResumeOperation(e).receipt.commitment.selectionEffect).toBe("committed");
		expect(P_latch(e)).toBe(true);
		const latched = {
			...e,
			readiness: { ...e.readiness, persistError: { errorRef: "original", repairedErrorRef: "original" } },
		};
		expect(P_latch(latched)).toBe(false);
		expect(P_continue(latched)).toBe(false);
	});
});

describe("null-base owned lineage", () => {
	it("recognizes the durable own dependent as a continuation of an empty transcript", () => {
		const e = fixture({ emptyBase: true, cursors: 0 });
		const result = classifyResumeOperation(e);
		expect(e.pending.CB).toBeNull();
		expect(e.pending.plan.target).toBeNull();
		expect(e.pending.manifest.map(entry => [entry.id, entry.parentId])).toEqual([
			["M", null],
			["D1", null],
		]);
		expect(result.receipt.commitment.reducerView).toEqual({
			kind: "tail_unambiguous",
			candidates: ["D1"],
			leaf: "D1",
		});
		expect(result.receipt.remainingConflict).toEqual([]);
		expect(result.outcome.kind).toBe("committed");
		expect(result.receipt.frontier).toEqual({ CB: null, CF: "D1", RT: "D1" });
		expect(result.receipt.finalPublishedTip).toBe("D1");
		expect(P_latch(e)).toBe(true);
		expect(P_continue(e)).toBe(true);
	});

	it("recognizes only matched own local suffix lineage through a dependent or enrollment marker", () => {
		for (const dependents of [0, 1]) {
			const e = fixture({ emptyBase: true, cursors: 0, dependents, suffix: "published" });
			const result = classifyResumeOperation(e);
			expect(result.receipt.commitment.reducerView).toEqual({
				kind: "tail_unambiguous",
				candidates: ["L"],
				leaf: "L",
			});
			expect(result.receipt.remainingConflict).toEqual([]);
			expect(result.outcome.kind).toBe("committed");
			expect(result.receipt.frontier.CF).toBe(dependents ? "D1" : null);
			expect(result.receipt.finalPublishedTip).toBe("L");
			expect(result.receipt.residentSuffix).toMatchObject([
				{ id: "L", kind: "retainedLocal", state: "published_with_D" },
			]);
			expect(P_latch(e)).toBe(true);
			expect(P_continue(e)).toBe(true);
		}
	});

	it("keeps an unrelated null-root candidate conflicting despite empty caller conflict evidence", () => {
		const e = fixture({ emptyBase: true, foreignRoot: true, cursors: 0 });
		const result = classifyResumeOperation(e);
		expect(result.receipt.commitment.reducerView?.candidates).toEqual(["foreign", "D1"]);
		expect(result.receipt.remainingConflict).toEqual(["foreign"]);
		expect(result.outcome.kind).toBe("committed_with_remaining_conflict");
		expect(P_latch(e)).toBe(true);
		expect(P_continue(e)).toBe(false);
	});

	it("rejects mismatched manifest or suffix payloads and parents along the own null-root path", () => {
		for (const suffix of ["none", "published"] as const) {
			const original = fixture({ emptyBase: true, cursors: 0, suffix });
			for (const change of [{ payloadDigest: "different" }, { parentId: "missing" }]) {
				const pending: PendingResumeOp = {
					...original.pending,
					manifest: original.pending.manifest.map(entry => (entry.id === "D1" ? { ...entry, ...change } : entry)),
				};
				const malformedManifest = { ...original, pending };
				const result = classifyResumeOperation(malformedManifest);
				expect(result.receipt.commitment.reducerView?.candidates).toEqual([suffix === "none" ? "D1" : "L"]);
				expect(result.receipt.remainingConflict).toEqual([suffix === "none" ? "D1" : "L"]);
				expect(result.outcome).toMatchObject({ kind: "unknown", reason: "gap" });
				expect(P_latch(malformedManifest)).toBe(false);
				expect(P_continue(malformedManifest)).toBe(false);
				if (suffix === "published") {
					const malformedSuffix: ResumeOperationEvidence = {
						...original,
						residentSuffix: original.residentSuffix.map(entry => ({ ...entry, ...change })),
					};
					const suffixResult = classifyResumeOperation(malformedSuffix);
					expect(suffixResult.receipt.remainingConflict).toEqual(["L"]);
					expect(suffixResult.outcome).toMatchObject({ kind: "unknown", reason: "unexplained_resident_branch" });
					expect(P_latch(malformedSuffix)).toBe(false);
					expect(P_continue(malformedSuffix)).toBe(false);
				}
			}
		}
	});

	it("does not explain an unowned suffix or a malformed captured range by its null root", () => {
		const original = fixture({ emptyBase: true, cursors: 0, suffix: "published" });
		const capture = captured(original);
		const unexplained: ResumeOperationEvidence = {
			...original,
			residentSuffix: original.residentSuffix.map(entry => ({ ...entry, residentKind: "unexplained" })),
		};
		const unowned: ResumeOperationEvidence = { ...original, residentSuffix: [] };
		const malformedRange: ResumeOperationEvidence = {
			...original,
			capture: {
				...capture,
				entries: capture.entries.map(entry =>
					entry.id === "D1" ? { ...entry, range: { ...entry.range, hash: "different" } } : entry,
				),
			},
		};
		for (const e of [unexplained, unowned, malformedRange]) {
			const result = classifyResumeOperation(e);
			expect(result.receipt.commitment.reducerView?.candidates).toEqual(["L"]);
			expect(result.receipt.remainingConflict).toEqual(["L"]);
			expect(result.outcome.kind).toBe("unknown");
			expect(P_latch(e)).toBe(false);
			expect(P_continue(e)).toBe(false);
		}
	});
});

describe("exact positive durability evidence", () => {
	it("rejects wrong op, namespace, identity, range hash, idx, range offsets, and publication binding", () => {
		const e = fixture();
		const proof = e.proofs[0];
		if (!proof) throw new Error("proof missing");
		const changes: Partial<DurabilityProof>[] = [
			{ op: "other" },
			{ namespaceSynced: false },
			{ fileIdentity: { ...identity, ino: "replaced" } },
			{ ranges: proof.ranges.map(range => ({ ...range, hash: "readable-is-not-durable" })) },
			{ idxs: [999] },
			{ ranges: proof.ranges.map(range => ({ ...range, start: range.start + 1 })) },
			{ publicationId: "" },
			{ snapshotDigest: "different" },
			{ syncSeq: 0 },
		];
		for (const change of changes) {
			const invalid = proofChanged(e, change);
			expect(validateDurabilityProof({ ...proof, ...change }, e.pending, captured(e))).toEqual([]);
			expect(classifyResumeOperation(invalid).outcome.kind).toBe("unknown");
			expect(P_latch(invalid)).toBe(false);
			expect(P_retire(closed(invalid))).toBe(false);
		}
	});

	it("recaptures revalidate hashes even when the id metadata and file identity are unchanged", () => {
		const e = fixture();
		const capture = captured(e);
		const bytes = capture.bytes.slice();
		const range = capture.entries.find(entry => entry.id === "C1")?.range;
		if (!range) throw new Error("cursor range missing");
		bytes[range.start + 5] = 88;
		const snapshotDigest = sha(bytes);
		const changedCapture = {
			...capture,
			bytes,
			snapshotDigest,
			reducerView: { ...capture.reducerView, snapshotDigest },
		};
		expect(validateDurabilityProof(e.proofs[0]!, e.pending, changedCapture)).toEqual([]);
		expect(classifyResumeOperation({ ...e, capture: changedCapture }).outcome.kind).toBe("unknown");
	});

	it("inherits proof only over unchanged ranges in an extended fresh snapshot", () => {
		const before = fixture();
		const after = fixture({ suffix: "unproven" });
		const result = classifyResumeOperation({ ...after, proofs: before.proofs });
		expect(result.outcome.kind).toBe("suffix_incomplete");
		expect(result.receipt.commitment.selectionCommitted).toBe(true);
		expect(result.receipt.commitment.unprovenIds).toEqual(["L"]);
		expect(result.receipt.commitment.operationComplete).toBe(false);
	});

	it("sync failure and failed repair are unknown, not readable committed data", () => {
		for (const durabilityState of ["sync_failed", "repair_failed", "repair_unavailable"] as const) {
			const e = { ...fixture(), durabilityState };
			expect(classifyResumeOperation(e).outcome.kind).toBe("unknown");
			expect(P_latch(e)).toBe(false);
		}
	});

	it("read failure and manifest gap dominate any suffix or proof", () => {
		const e = fixture({ suffix: "held" });
		const unread = classifyResumeOperation({ ...e, capture: { kind: "read_failed", error: "EIO" } });
		expect(unread.outcome).toMatchObject({ kind: "unknown", reason: "read_failed" });
		const c = captured(e);
		const gap = classifyResumeOperation({
			...e,
			capture: { ...c, entries: c.entries.filter(entry => entry.id !== "C1") },
		});
		expect(gap.outcome).toMatchObject({ kind: "unknown", reason: "gap" });
	});

	it("payload/parent mismatch and foreign progress cannot be authorized by matching ids", () => {
		const e = fixture();
		const c = captured(e);
		for (const changed of [{ parentId: "b" }, { payloadDigest: "different" }]) {
			const result = classifyResumeOperation({
				...e,
				capture: { ...c, entries: c.entries.map(entry => (entry.id === "C1" ? { ...entry, ...changed } : entry)) },
			});
			expect(result.outcome).toMatchObject({ kind: "unknown", reason: "gap" });
		}
		const foreign = fixture({ suffix: "published" });
		expect(classifyResumeOperation({ ...foreign, residentSuffix: [] }).outcome.kind).toBe("unknown");
	});
});

function replacement(chainLength = 2): ResumeOperationEvidence {
	const original = fixture({ present: 0 });
	const current = fixture();
	const capture = captured(current);
	const pending: PendingResumeOp = {
		...original.pending,
		durabilityDebt: {
			...original.pending.durabilityDebt,
			snapshotDigest: captured(original).snapshotDigest,
			snapshotByteLength: captured(original).bytes.byteLength,
		},
	};
	const publicationSuccessions: ResumePublicationSuccession[] = [];
	const intermediate = captured(fixture({ present: 2 }));
	let predecessor = {
		fileIdentity: identity,
		snapshotDigest: captured(original).snapshotDigest,
		snapshotByteLength: captured(original).bytes.byteLength,
	};
	for (let index = 0; index < chainLength; index++) {
		const successor = {
			fileIdentity: { dev: identity.dev, ino: `replacement-${index}` },
			snapshotDigest: index === chainLength - 1 ? capture.snapshotDigest : intermediate.snapshotDigest,
			snapshotByteLength: index === chainLength - 1 ? capture.bytes.byteLength : intermediate.bytes.byteLength,
		};
		publicationSuccessions.push({ publicationId: `checked-${index}`, predecessor, successor });
		predecessor = successor;
	}
	return {
		...current,
		pending,
		capture: { ...capture, fileIdentity: predecessor.fileIdentity },
		proofs: current.proofs.map(proof => ({
			...proof,
			fileIdentity: predecessor.fileIdentity,
			publicationId: `checked-${chainLength - 1}`,
		})),
		publicationSuccessions,
	};
}

describe("checked publication succession evidence", () => {
	function invalidSuccession(e: ResumeOperationEvidence): void {
		expect(validatePublicationSuccessions(e.pending, captured(e), e.publicationSuccessions)).toBe(false);
		for (const proof of e.proofs)
			expect(validateDurabilityProof(proof, e.pending, captured(e), e.publicationSuccessions)).toEqual([]);
		expect(classifyResumeOperation(e).outcome).toMatchObject({ kind: "unknown", reason: "stale_snapshot" });
		expect(P_latch(e)).toBe(false);
		expect(P_continue(e)).toBe(false);
		expect(P_retire(closed(e))).toBe(false);
	}

	for (const length of [1, 2, 256])
		it(`accepts an exact ordered ${length}-receipt chain without mutating pending`, () => {
			const e = replacement(length);
			const pending = JSON.stringify(e.pending);
			Object.freeze(e.pending.durabilityDebt.fileIdentity);
			Object.freeze(e.pending.durabilityDebt);
			Object.freeze(e.pending);
			expect(validatePublicationSuccessions(e.pending, captured(e), e.publicationSuccessions)).toBe(true);
			expect(classifyResumeOperation(e).outcome.kind).toBe("committed");
			expect(P_latch(e)).toBe(true);
			expect(P_continue(e)).toBe(true);
			expect(P_retire(closed(e))).toBe(true);
			expect(JSON.stringify(e.pending)).toBe(pending);
			expect(e.pending.durabilityDebt.fileIdentity).toEqual(identity);
		});

	it("does not infer succession from identical readable bytes or an unanchored replacement receipt", () => {
		const e = replacement();
		invalidSuccession({ ...e, publicationSuccessions: undefined });
		invalidSuccession({ ...e, publicationSuccessions: [] });
		const sameBytes = fixture();
		const replacedIdentity = { ...identity, ino: "arbitrary-same-bytes" };
		invalidSuccession({
			...proofChanged(sameBytes, { fileIdentity: replacedIdentity }),
			pending: {
				...sameBytes.pending,
				durabilityDebt: { ...sameBytes.pending.durabilityDebt, snapshotDigest: captured(sameBytes).snapshotDigest },
			},
			capture: { ...captured(sameBytes), fileIdentity: replacedIdentity },
		});
		invalidSuccession({
			...e,
			pending: { ...e.pending, durabilityDebt: { ...e.pending.durabilityDebt, snapshotDigest: undefined } },
		});
	});

	it("rejects incorrect original pending identity or captured digest anchors", () => {
		const e = replacement();
		for (const change of [
			{ fileIdentity: { ...identity, ino: "other" } },
			{ snapshotDigest: sha("other") },
			{ snapshotByteLength: undefined },
			{ snapshotByteLength: -1 },
			{ snapshotByteLength: Number.NaN },
			{ snapshotByteLength: 1.5 },
			{ snapshotByteLength: Number.MAX_SAFE_INTEGER + 1 },
			{ snapshotByteLength: captured(e).bytes.byteLength },
		])
			invalidSuccession({
				...e,
				pending: { ...e.pending, durabilityDebt: { ...e.pending.durabilityDebt, ...change } },
			});
	});

	it("rejects wrong predecessor identity/hash and stale terminal identity/hash", () => {
		const e = replacement();
		const [first, last] = e.publicationSuccessions ?? [];
		if (!first || !last) throw new Error("two receipts expected");
		for (const change of [
			{ fileIdentity: { ...identity, ino: "other" } },
			{ snapshotDigest: sha("other") },
			{ snapshotByteLength: 0 },
			{ snapshotByteLength: Number.NaN },
			{ snapshotByteLength: Number.MAX_SAFE_INTEGER + 1 },
		]) {
			invalidSuccession({
				...e,
				publicationSuccessions: [{ ...first, predecessor: { ...first.predecessor, ...change } }, last],
			});
			invalidSuccession({
				...e,
				publicationSuccessions: [first, { ...last, predecessor: { ...last.predecessor, ...change } }],
			});
			invalidSuccession({
				...e,
				publicationSuccessions: [first, { ...last, successor: { ...last.successor, ...change } }],
			});
		}
	});

	it("rejects forks, cycles, reordered or missing edges, and duplicate/empty publication ids", () => {
		const e = replacement();
		const [first, last] = e.publicationSuccessions ?? [];
		if (!first || !last) throw new Error("two receipts expected");
		const cycle: ResumePublicationSuccession = {
			publicationId: "cycle",
			predecessor: last.successor,
			successor: first.predecessor,
		};
		for (const publicationSuccessions of [
			[last, first],
			[last],
			[first],
			[first, { ...last, predecessor: first.predecessor }],
			[first, last, cycle],
			[first, { ...last, publicationId: first.publicationId }],
			[first, { ...last, publicationId: "" }],
		])
			invalidSuccession({ ...e, publicationSuccessions });
		// Even an otherwise exact terminal capture cannot turn an identity cycle into authority.
		invalidSuccession({
			...e,
			capture: { ...captured(e), fileIdentity: first.predecessor.fileIdentity },
			publicationSuccessions: [
				first,
				last,
				{ ...cycle, successor: { ...first.predecessor, snapshotDigest: captured(e).snapshotDigest } },
			],
		});
	});

	it("rejects a 257-receipt chain", () => {
		invalidSuccession(replacement(257));
	});

	it("binds current D to the terminal checked publication, full snapshot, and freshly hashed ranges", () => {
		const e = replacement();
		const proof = e.proofs[0];
		const before = fixture({ present: 2 }).proofs[0];
		if (!proof || !before) throw new Error("proof missing");
		for (const change of [
			{ publicationId: "unrelated-publication" },
			{ publicationId: "checked-0" },
			{ fileIdentity: { ...identity, ino: "unrelated-inode" } },
			{ snapshotDigest: before.snapshotDigest, snapshotByteLength: before.snapshotByteLength },
			{ ranges: proof.ranges.map(range => ({ ...range, hash: sha("different") })) },
		]) {
			const invalid = proofChanged(e, change);
			expect(validateDurabilityProof(invalid.proofs[0]!, e.pending, captured(e), e.publicationSuccessions)).toEqual(
				[],
			);
			expect(classifyResumeOperation(invalid).outcome).toMatchObject({ kind: "unknown", reason: "durability" });
			expect(P_latch(invalid)).toBe(false);
		}
	});

	it("carries earlier D only from an exact authenticated node with unchanged fresh prefix and ranges", () => {
		const e = replacement();
		const prior = fixture({ present: 2 }).proofs[0];
		const [first, last] = e.publicationSuccessions ?? [];
		if (!prior || !first || !last) throw new Error("receipts and proof missing");
		const priorD: DurabilityProof = {
			...prior,
			fileIdentity: first.successor.fileIdentity,
			publicationId: first.publicationId,
		};
		expect(validateDurabilityProof(priorD, e.pending, captured(e), e.publicationSuccessions)).toEqual(["M", "C1"]);
		const currentProof = e.proofs[0];
		if (!currentProof) throw new Error("current proof missing");
		const ranges = currentProof.ranges.filter(range => !["M", "C1"].includes(range.id));
		const combined = { ...e, proofs: [priorD, { ...currentProof, ranges, idxs: ranges.map(range => range.idx) }] };
		expect(classifyResumeOperation(combined).outcome.kind).toBe("committed");
		for (const change of [
			{ publicationId: "unrelated" },
			{ snapshotDigest: sha("other") },
			{ fileIdentity: identity },
		])
			expect(
				validateDurabilityProof({ ...priorD, ...change }, e.pending, captured(e), e.publicationSuccessions),
			).toEqual([]);
		const bytes = captured(e).bytes.slice();
		bytes[prior.ranges[0]!.start + 5] = 88;
		const snapshotDigest = sha(bytes);
		const changed = { ...captured(e), bytes, snapshotDigest };
		const changedChain = [first, { ...last, successor: { ...last.successor, snapshotDigest } }];
		expect(validatePublicationSuccessions(e.pending, changed, changedChain)).toBe(true);
		expect(validateDurabilityProof(priorD, e.pending, changed, changedChain)).toEqual([]);
	});

	it("leaves same-inode earlier prefix proof semantics unchanged even with an original digest anchor", () => {
		const original = fixture();
		const extended = fixture({ suffix: "unproven" });
		const e: ResumeOperationEvidence = {
			...extended,
			pending: {
				...original.pending,
				durabilityDebt: {
					...original.pending.durabilityDebt,
					snapshotDigest: captured(original).snapshotDigest,
					snapshotByteLength: captured(original).bytes.byteLength,
				},
			},
			proofs: original.proofs,
		};
		expect(classifyResumeOperation(e).outcome.kind).toBe("suffix_incomplete");
		expect(classifyResumeOperation(e).receipt.commitment.selectionCommitted).toBe(true);
		expect(classifyResumeOperation(e).receipt.commitment.unprovenIds).toEqual(["L"]);
	});

	it("preserves D from the original anchored capture without rebinding its publication id", () => {
		const e = replacement(1);
		const original = fixture({ present: 2 });
		const first = e.publicationSuccessions?.[0];
		if (!first) throw new Error("receipt missing");
		const snapshotDigest = captured(original).snapshotDigest;
		const snapshotByteLength = captured(original).bytes.byteLength;
		const pending = {
			...e.pending,
			durabilityDebt: { ...e.pending.durabilityDebt, snapshotDigest, snapshotByteLength },
		};
		const chain = [{ ...first, predecessor: { ...first.predecessor, snapshotDigest, snapshotByteLength } }];
		expect(validateDurabilityProof(original.proofs[0]!, pending, captured(e), chain)).toEqual(["M", "C1"]);
	});
});

describe("strict descriptor byte evidence", () => {
	it("classifies current D without transcript bytes and permits omitted header ranges", () => {
		const original = fixture();
		const capture = descriptorCapture(original);
		const e = { ...original, capture };
		expect(capture.bytes).toBeUndefined();
		expect(capture.byteEvidence.ranges[0]!.idx).toBe(1);
		expect(capture.byteEvidence.ranges[0]!.start).toBeGreaterThan(0);
		expect(validateResumeCaptureBytes(capture)).toBe(true);
		expect(validateDurabilityProof(original.proofs[0]!, e.pending, capture)).toEqual(["M", "C1", "C2", "D1"]);
		expect(classifyResumeOperation(e).outcome.kind).toBe("committed");
		expect(P_latch(e)).toBe(true);
		expect(P_continue(e)).toBe(true);
		const terminal = closed(original);
		expect(P_retire({ ...terminal, capture })).toBe(true);
		if (terminal.manager.kind !== "terminal" || !terminal.manager.closure) throw new Error("closure missing");
		expect(
			P_retire({
				...terminal,
				capture,
				manager: {
					...terminal.manager,
					closure: {
						...terminal.manager.closure,
						preCloseSnapshotByteLength: capture.byteEvidence.byteLength + 1,
					},
				},
			}),
		).toBe(false);
		const first = capture.entries.find(entry => entry.id === "M");
		if (!first) throw new Error("manifest range missing");
		const finalDrain: ResumeOperationEvidence = {
			...terminal,
			capture,
			proofs: original.proofs.map(proof => ({ ...proof, kind: "final_drain_sync" })),
			manager: {
				...terminal.manager,
				closure: { ...terminal.manager.closure, preCloseSnapshotByteLength: first.range.start },
			},
		};
		expect(P_retire(finalDrain)).toBe(true);
		expect(P_retire({ ...finalDrain, proofs: original.proofs })).toBe(false);
	});

	it("allows real header receipts and physical index gaps while rejecting missing referenced ranges", () => {
		const original = fixture();
		const direct = captured(original);
		const capture = descriptorCapture(original);
		const first = capture.byteEvidence.ranges[0];
		if (!first) throw new Error("range missing");
		const withHeader = {
			...capture,
			byteEvidence: {
				...capture.byteEvidence,
				ranges: [
					{ id: "header", idx: 0, start: 0, end: first.start, hash: sha(direct.bytes.subarray(0, first.start)) },
					...capture.byteEvidence.ranges,
				],
			},
		};
		expect(validateResumeCaptureBytes(withHeader)).toBe(true);
		const omitted = capture.entries[1];
		if (!omitted) throw new Error("entry missing");
		const unreferencedGap = {
			...capture,
			entries: capture.entries.filter(entry => entry.id !== omitted.id),
			byteEvidence: {
				...capture.byteEvidence,
				ranges: capture.byteEvidence.ranges.filter(range => range.id !== omitted.id),
			},
		};
		expect(original.proofs[0]!.ranges.some(range => range.id === omitted.id)).toBe(false);
		expect(validateResumeCaptureBytes(unreferencedGap)).toBe(true);
		expect(validateDurabilityProof(original.proofs[0]!, original.pending, unreferencedGap)).toEqual([
			"M",
			"C1",
			"C2",
			"D1",
		]);
		const referencedId = original.proofs[0]!.ranges[0]!.id;
		const missingReferenced = {
			...capture,
			entries: capture.entries.filter(entry => entry.id !== referencedId),
			byteEvidence: {
				...capture.byteEvidence,
				ranges: capture.byteEvidence.ranges.filter(range => range.id !== referencedId),
			},
		};
		expect(validateResumeCaptureBytes(missingReferenced)).toBe(true);
		expect(validateDurabilityProof(original.proofs[0]!, original.pending, missingReferenced)).toEqual([]);
	});

	it("requires an exact streamed prefix hash before carrying earlier D into an extended snapshot", () => {
		const original = fixture();
		const extended = fixture({ suffix: "unproven" });
		const prior = original.proofs[0]!;
		const capture = descriptorCapture(extended, [prior.snapshotByteLength]);
		const e = { ...extended, capture, proofs: original.proofs };
		expect(validateDurabilityProof(prior, e.pending, capture)).toEqual(["M", "C1", "C2", "D1"]);
		expect(classifyResumeOperation(e).outcome.kind).toBe("suffix_incomplete");
		expect(classifyResumeOperation(e).receipt.commitment.selectionCommitted).toBe(true);
		for (const prefixes of [
			[],
			[{ byteLength: prior.snapshotByteLength, sha256: sha("forged-prefix") }],
			[{ byteLength: prior.snapshotByteLength - 1, sha256: prior.snapshotDigest }],
		]) {
			const invalid = { ...capture, byteEvidence: { ...capture.byteEvidence, prefixes } };
			expect(validateDurabilityProof(prior, e.pending, invalid)).toEqual([]);
			expect(classifyResumeOperation({ ...e, capture: invalid }).outcome.kind).toBe("unknown");
		}
	});

	it("rejects forged full digest, invalid lengths, duplicate prefixes, and malformed range receipts", () => {
		const original = fixture();
		const capture = descriptorCapture(original);
		const evidence = capture.byteEvidence;
		const [first, second, ...rest] = evidence.ranges;
		if (!first || !second) throw new Error("ranges missing");
		const prefix = { byteLength: 1, sha256: sha(captured(original).bytes.subarray(0, 1)) };
		const changes: Partial<ResumeDescriptorByteEvidence>[] = [
			{ fullDigest: sha("forged-full-digest") },
			{ fullDigest: "not-a-sha256" },
			{ byteLength: -1 },
			{ byteLength: Number.NaN },
			{ byteLength: 1.5 },
			{ byteLength: Number.MAX_SAFE_INTEGER + 1 },
			{ byteLength: first.end - 1 },
			{ ranges: [{ ...first, hash: sha("forged-range") }, second, ...rest] },
			{ ranges: [{ ...first, idx: first.idx + 1 }, second, ...rest] },
			{ ranges: [{ ...first, id: "forged-id" }, second, ...rest] },
			{ ranges: [{ ...first, start: first.start + 1 }, second, ...rest] },
			{ ranges: [{ ...first, end: first.end - 1 }, second, ...rest] },
			{ ranges: [first, first, second, ...rest] },
			{ ranges: [first, { ...second, idx: first.idx }, ...rest] },
			{ ranges: [first, { ...second, start: first.end - 1 }, ...rest] },
			{ ranges: [second, first, ...rest] },
			{ ranges: [second, ...rest] },
			{ prefixes: [prefix, prefix] },
			{ prefixes: [{ ...prefix, byteLength: -1 }] },
			{ prefixes: [{ ...prefix, byteLength: evidence.byteLength + 1 }] },
			{ prefixes: [{ ...prefix, byteLength: 0 }] },
			{ prefixes: [{ byteLength: evidence.byteLength, sha256: sha("forged-full-prefix") }] },
		];
		for (const change of changes) {
			const invalid = { ...capture, byteEvidence: { ...evidence, ...change } };
			expect(validateResumeCaptureBytes(invalid)).toBe(false);
			expect(validateDurabilityProof(original.proofs[0]!, original.pending, invalid)).toEqual([]);
			expect(classifyResumeOperation({ ...original, capture: invalid }).outcome).toMatchObject({
				kind: "unknown",
				reason: "stale_snapshot",
			});
		}
	});

	for (const descriptor of [false, true])
		it(`authenticates an immutable anchor before same-inode append and checked replacement (${descriptor ? "descriptor" : "bytes"})`, () => {
			const original = fixture({ present: 0 });
			const current = fixture();
			const anchor = captured(original);
			const beforeReplacement = captured(current);
			const fileIdentity = { ...identity, ino: "append-then-replacement" };
			const receipt: ResumePublicationSuccession = {
				publicationId: "append-then-cas",
				predecessor: {
					fileIdentity: identity,
					snapshotDigest: beforeReplacement.snapshotDigest,
					snapshotByteLength: beforeReplacement.bytes.byteLength,
				},
				successor: {
					fileIdentity,
					snapshotDigest: beforeReplacement.snapshotDigest,
					snapshotByteLength: beforeReplacement.bytes.byteLength,
				},
			};
			const capture = descriptor ? descriptorCapture(current, [anchor.bytes.byteLength]) : beforeReplacement;
			const e: ResumeOperationEvidence = {
				...current,
				pending: {
					...current.pending,
					durabilityDebt: {
						...current.pending.durabilityDebt,
						snapshotDigest: anchor.snapshotDigest,
						snapshotByteLength: anchor.bytes.byteLength,
					},
				},
				capture: { ...capture, fileIdentity },
				publicationSuccessions: [receipt],
				proofs: current.proofs.map(proof => ({ ...proof, fileIdentity, publicationId: receipt.publicationId })),
			};
			expect(classifyResumeOperation(e).outcome.kind).toBe("committed");
			expect(
				classifyResumeOperation({
					...e,
					pending: {
						...e.pending,
						durabilityDebt: { ...e.pending.durabilityDebt, snapshotDigest: sha("foreign anchor") },
					},
				}).outcome.kind,
			).toBe("unknown");
			expect(
				classifyResumeOperation({
					...e,
					publicationSuccessions: [
						{ ...receipt, predecessor: { ...receipt.predecessor, snapshotDigest: sha("foreign predecessor") } },
					],
				}).outcome.kind,
			).toBe("unknown");
		});

	it("keeps checked succession anchored and bounded when fresh bytes are descriptor receipts", () => {
		const original = fixture({ present: 0 });
		const current = fixture();
		const fileIdentity = { ...identity, ino: "descriptor-successor" };
		const capture = { ...descriptorCapture(current), fileIdentity };
		const pending = {
			...original.pending,
			durabilityDebt: {
				...original.pending.durabilityDebt,
				snapshotDigest: captured(original).snapshotDigest,
				snapshotByteLength: captured(original).bytes.byteLength,
			},
		};
		const receipt: ResumePublicationSuccession = {
			publicationId: "descriptor-publication",
			predecessor: {
				fileIdentity: identity,
				snapshotDigest: captured(original).snapshotDigest,
				snapshotByteLength: captured(original).bytes.byteLength,
			},
			successor: {
				fileIdentity,
				snapshotDigest: capture.snapshotDigest,
				snapshotByteLength: captured(current).bytes.byteLength,
			},
		};
		const e: ResumeOperationEvidence = {
			...current,
			pending,
			capture,
			proofs: current.proofs.map(proof => ({ ...proof, fileIdentity, publicationId: receipt.publicationId })),
			publicationSuccessions: [receipt],
		};
		expect(classifyResumeOperation(e).outcome.kind).toBe("committed");
		expect(classifyResumeOperation({ ...e, publicationSuccessions: [] }).outcome.kind).toBe("unknown");
		expect(
			classifyResumeOperation({ ...e, publicationSuccessions: Array.from({ length: 257 }, () => receipt) }).outcome
				.kind,
		).toBe("unknown");
	});
});

function initiallyAbsent(): ResumeOperationEvidence & { readonly initialPublication: ResumeInitialPublication } {
	const current = fixture({ emptyBase: true, cursors: 0 });
	const capture = captured(current);
	const intent = {
		canonicalPath: "/project/new-session.jsonl",
		headerId: "header",
		authorityKey: current.pending.authorityKey,
		epoch: current.pending.epoch,
		memberToken: current.pending.memberToken,
	};
	const initialPublication: ResumeInitialPublication = {
		...intent,
		kind: "no_replace",
		publicationId: "initial-no-replace",
		predecessor: "absent",
		successor: {
			fileIdentity: capture.fileIdentity,
			snapshotDigest: capture.snapshotDigest,
			snapshotByteLength: capture.bytes.byteLength,
		},
	};
	return {
		...current,
		pending: {
			...current.pending,
			durabilityDebt: {
				...current.pending.durabilityDebt,
				fileIdentity: null,
				snapshotDigest: sha(new Uint8Array()),
				snapshotByteLength: 0,
				initialPublication: intent,
			},
		},
		initialPublication,
		proofs: current.proofs.map(proof => ({ ...proof, publicationId: initialPublication.publicationId })),
	};
}

describe("actual absent-path initial publication", () => {
	function rejected(e: ResumeOperationEvidence): void {
		const capture = captured(e);
		expect(validatePublicationSuccessions(e.pending, capture, e.publicationSuccessions, e.initialPublication)).toBe(
			false,
		);
		for (const proof of e.proofs)
			expect(
				validateDurabilityProof(proof, e.pending, capture, e.publicationSuccessions, e.initialPublication),
			).toEqual([]);
		expect(classifyResumeOperation(e).outcome).toMatchObject({ kind: "unknown", reason: "stale_snapshot" });
		expect(P_latch(e)).toBe(false);
		expect(P_continue(e)).toBe(false);
		expect(P_retire(closed(e))).toBe(false);
	}

	it("accepts only the bound actual no-replace publication without mutating the absent pending anchor", () => {
		const e = initiallyAbsent();
		const pending = JSON.stringify(e.pending);
		Object.freeze(e.pending.durabilityDebt.initialPublication);
		Object.freeze(e.pending.durabilityDebt);
		Object.freeze(e.pending);
		expect(validatePublicationSuccessions(e.pending, captured(e), [], e.initialPublication)).toBe(true);
		expect(validateDurabilityProof(e.proofs[0]!, e.pending, captured(e), [], e.initialPublication)).toEqual([
			"M",
			"D1",
		]);
		expect(classifyResumeOperation(e).outcome.kind).toBe("committed");
		expect(P_latch(e)).toBe(true);
		expect(P_continue(e)).toBe(true);
		expect(P_retire(closed(e))).toBe(true);
		expect(JSON.stringify(e.pending)).toBe(pending);
		expect(e.pending.durabilityDebt.fileIdentity).toBeNull();
	});

	it("accepts an actual receipt carried by D without a separate evidence copy", () => {
		const e = initiallyAbsent();
		const proofOnly = {
			...e,
			initialPublication: undefined,
			proofs: e.proofs.map(proof => ({ ...proof, initialPublication: e.initialPublication })),
		};
		expect(validateDurabilityProof(proofOnly.proofs[0]!, e.pending, captured(e))).toEqual(["M", "D1"]);
		expect(classifyResumeOperation(proofOnly).outcome.kind).toBe("committed");
		expect(P_retire(closed(proofOnly))).toBe(true);
		const terminal = closed(proofOnly);
		if (terminal.manager.kind !== "terminal" || !terminal.manager.closure) throw new Error("closure missing");
		const finalDrain: ResumeOperationEvidence = {
			...terminal,
			proofs: [...proofOnly.proofs, ...e.proofs.map(proof => ({ ...proof, kind: "final_drain_sync" as const }))],
			manager: {
				...terminal.manager,
				closure: { ...terminal.manager.closure, preCloseSnapshotByteLength: 0 },
			},
		};
		expect(P_retire(finalDrain)).toBe(true);
	});

	it("keeps the actual unpublished path read_failed and its staged attempts held", () => {
		const e = initiallyAbsent();
		const before: ResumeOperationEvidence = {
			...e,
			capture: { kind: "read_failed", error: "ENOENT" },
			initialPublication: undefined,
			proofs: [],
			manager: { kind: "live", strictClosePending: false, residentAttempt: "retained" },
		};
		const result = classifyResumeOperation(before);
		expect(result.outcome).toMatchObject({ kind: "unknown", reason: "read_failed" });
		expect(result.receipt.commitment.heldIds).toEqual(["M", "D1"]);
		expect(P_latch(before)).toBe(false);
		expect(P_continue(before)).toBe(false);
	});

	it("rejects missing receipts, missing intent, nonempty original digest, and fake identity anchors", () => {
		const e = initiallyAbsent();
		rejected({ ...e, initialPublication: undefined });
		for (const change of [
			{ initialPublication: undefined },
			{ snapshotDigest: undefined },
			{ snapshotDigest: sha("not-absent") },
			{ snapshotByteLength: undefined },
			{ snapshotByteLength: 1 },
			{ fileIdentity: { dev: "0", ino: "0" } },
			{ fileIdentity: identity },
		])
			rejected({ ...e, pending: { ...e.pending, durabilityDebt: { ...e.pending.durabilityDebt, ...change } } });
		const fake = { dev: "0", ino: "0" };
		rejected({
			...e,
			initialPublication: undefined,
			pending: { ...e.pending, durabilityDebt: { ...e.pending.durabilityDebt, fileIdentity: fake } },
			capture: { ...captured(e), fileIdentity: fake },
			proofs: e.proofs.map(proof => ({ ...proof, fileIdentity: fake })),
		});
	});

	it("rejects receipts for another owner, header, canonical path, successor, or publication mode", () => {
		const e = initiallyAbsent();
		const receipt = e.initialPublication;
		const changes: Partial<ResumeInitialPublication>[] = [
			{ canonicalPath: "/project/other-session.jsonl" },
			{ headerId: "other-header" },
			{ authorityKey: "other-authority" },
			{ epoch: "other-epoch" },
			{ memberToken: "other-member" },
			{ publicationId: "" },
			{ successor: { ...receipt.successor, fileIdentity: { ...identity, ino: "wrong-successor" } } },
			{ successor: { ...receipt.successor, snapshotDigest: sha("wrong-successor") } },
			{ successor: { ...receipt.successor, snapshotDigest: "not-a-sha256" } },
			{ kind: "checked_replace" } as unknown as Partial<ResumeInitialPublication>,
			{ predecessor: "present" } as unknown as Partial<ResumeInitialPublication>,
		];
		for (const change of changes) rejected({ ...e, initialPublication: { ...receipt, ...change } });
		// Rebinding the pending intent cannot reuse a receipt from another manager incarnation.
		const intent = e.pending.durabilityDebt.initialPublication;
		if (!intent) throw new Error("initial intent missing");
		for (const change of [
			{ authorityKey: "other-authority" },
			{ epoch: "other-epoch" },
			{ memberToken: "other-member" },
		])
			rejected({
				...e,
				initialPublication: { ...receipt, ...change },
				pending: {
					...e.pending,
					durabilityDebt: { ...e.pending.durabilityDebt, initialPublication: { ...intent, ...change } },
				},
			});
	});

	it("requires legitimate D and rejects conflicting or reused publication receipts", () => {
		const e = initiallyAbsent();
		for (const change of [
			{ publicationId: "unrelated-publication" },
			{ namespaceSynced: false },
			{ snapshotDigest: sha("wrong") },
			{ snapshotByteLength: captured(e).bytes.byteLength - 1 },
			{ initialPublication: { ...e.initialPublication, publicationId: "conflicting-receipt" } },
			{
				initialPublication: {
					...e.initialPublication,
					successor: { ...e.initialPublication.successor, snapshotByteLength: captured(e).bytes.byteLength - 1 },
				},
			},
		]) {
			const invalid = proofChanged(e, change);
			expect(validateDurabilityProof(invalid.proofs[0]!, e.pending, captured(e), [], e.initialPublication)).toEqual(
				[],
			);
			expect(classifyResumeOperation(invalid).outcome.kind).toBe("unknown");
		}
	});

	it("anchors a subsequent checked replacement chain to the exact initial successor and publication id", () => {
		const e = initiallyAbsent();
		const fileIdentity = { ...identity, ino: "after-initial" };
		const succession: ResumePublicationSuccession = {
			publicationId: "checked-after-initial",
			predecessor: e.initialPublication.successor,
			successor: {
				fileIdentity,
				snapshotDigest: captured(e).snapshotDigest,
				snapshotByteLength: captured(e).bytes.byteLength,
			},
		};
		const replaced: ResumeOperationEvidence = {
			...e,
			capture: { ...captured(e), fileIdentity },
			publicationSuccessions: [succession],
			proofs: e.proofs.map(proof => ({ ...proof, fileIdentity, publicationId: succession.publicationId })),
		};
		expect(classifyResumeOperation(replaced).outcome.kind).toBe("committed");
		const prior = { ...replaced, proofs: e.proofs };
		expect(classifyResumeOperation(prior).outcome.kind).toBe("committed");
		for (const publicationSuccessions of [
			[],
			[{ ...succession, publicationId: e.initialPublication.publicationId }],
			[{ ...succession, predecessor: { ...succession.predecessor, snapshotDigest: sha("wrong-anchor") } }],
			[{ ...succession, predecessor: { ...succession.predecessor, fileIdentity } }],
			Array.from({ length: 257 }, () => succession),
		])
			rejected({ ...replaced, publicationSuccessions });
	});

	it("supports descriptor-verified publication bytes without materializing an absent snapshot", () => {
		const e = initiallyAbsent();
		const { bytes, ...base } = captured(e);
		const capture: ResumeFreshCapture = {
			...base,
			byteEvidence: {
				kind: "descriptor_verified",
				byteLength: bytes.byteLength,
				fullDigest: sha(bytes),
				ranges: base.entries.map(entry => entry.range),
				prefixes: [],
			},
		};
		expect(classifyResumeOperation({ ...e, capture }).outcome.kind).toBe("committed");
	});
});

describe("issued publication prefixes after same-inode extension", () => {
	function extended(
		issued: ResumeOperationEvidence,
		mode: "direct" | "descriptor",
	): ResumeOperationEvidence & { readonly capture: ResumeFreshCapture } {
		const current = fixture({
			...(issued.initialPublication ? { emptyBase: true, cursors: 0 } : {}),
			suffix: "published",
		});
		const original = captured(issued);
		const suffix = current.proofs[0]!;
		const ranges = suffix.ranges.filter(range => range.id === "L");
		const direct = { ...captured(current), fileIdentity: original.fileIdentity };
		const capture =
			mode === "direct" ? direct : descriptorCapture({ ...current, capture: direct }, [original.bytes.byteLength]);
		return {
			...current,
			pending: issued.pending,
			initialPublication: issued.initialPublication,
			publicationSuccessions: issued.publicationSuccessions,
			capture,
			proofs: [
				...issued.proofs,
				{
					...suffix,
					fileIdentity: original.fileIdentity,
					publicationId: issued.proofs[0]!.publicationId,
					idxs: ranges.map(range => range.idx),
					ranges,
				},
			],
		};
	}

	for (const publication of ["initial", "replacement"] as const)
		for (const mode of ["direct", "descriptor"] as const) {
			const create = () => (publication === "initial" ? initiallyAbsent() : replacement(1));

			it(`retains immutable ${publication} authority and earlier D after a ${mode} owned append`, () => {
				const issued = create();
				const immutable = JSON.stringify([
					issued.pending,
					issued.initialPublication,
					issued.publicationSuccessions,
					issued.proofs,
				]);
				Object.freeze(issued.pending.durabilityDebt);
				Object.freeze(issued.pending);
				const e = extended(issued, mode);
				expect(
					validatePublicationSuccessions(e.pending, e.capture, e.publicationSuccessions, e.initialPublication),
				).toBe(true);
				expect(
					validateDurabilityProof(
						issued.proofs[0]!,
						e.pending,
						e.capture,
						e.publicationSuccessions,
						e.initialPublication,
					),
				).toEqual(issued.pending.manifest.map(entry => entry.id));
				expect(classifyResumeOperation(e).outcome.kind).toBe("committed");
				expect(P_latch(e)).toBe(true);
				expect(P_continue(e)).toBe(true);
				expect(P_retire(closed(e))).toBe(true);
				expect(
					JSON.stringify([
						issued.pending,
						issued.initialPublication,
						issued.publicationSuccessions,
						issued.proofs,
					]),
				).toBe(immutable);
				expect(e.pending).toBe(issued.pending);
				expect(e.initialPublication).toBe(issued.initialPublication);
				expect(e.publicationSuccessions).toBe(issued.publicationSuccessions);
			});

			it(`does not treat readable ${mode} suffix bytes as D after ${publication}`, () => {
				const issued = create();
				const e = { ...extended(issued, mode), proofs: issued.proofs };
				expect(classifyResumeOperation(e).outcome.kind).toBe("suffix_incomplete");
				expect(classifyResumeOperation(e).receipt.commitment.selectionCommitted).toBe(true);
				expect(classifyResumeOperation(e).receipt.commitment.unprovenIds).toEqual(["L"]);
				expect(P_latch(e)).toBe(false);
				expect(P_continue(e)).toBe(false);
				expect(P_retire(closed(e))).toBe(false);
				const unrelated = { dev: identity.dev, ino: "equal-bytes-other-inode" };
				const foreign = {
					...e,
					capture: { ...e.capture, fileIdentity: unrelated },
					proofs: e.proofs.map(proof => ({ ...proof, fileIdentity: unrelated })),
				};
				expect(
					validatePublicationSuccessions(
						foreign.pending,
						foreign.capture,
						foreign.publicationSuccessions,
						foreign.initialPublication,
					),
				).toBe(false);
				expect(P_latch(foreign)).toBe(false);
			});

			it(`requires independent final-drain D for ${mode} extension after ${publication}`, () => {
				const issued = create();
				const e = extended(issued, mode);
				const terminal = closed(e);
				if (terminal.manager.kind !== "terminal" || !terminal.manager.closure) throw new Error("closure missing");
				const final = {
					...terminal,
					manager: {
						...terminal.manager,
						closure: {
							...terminal.manager.closure,
							preCloseSnapshotByteLength: captured(issued).bytes.byteLength,
							publishedByFinalDrain: ["L"],
						},
					},
				};
				expect(P_retire(final)).toBe(false);
				const suffixProof = e.proofs.at(-1)!;
				const drained = {
					...final,
					proofs: [...issued.proofs, { ...suffixProof, kind: "final_drain_sync" as const }],
				};
				expect(P_retire(drained)).toBe(true);
				expect(classifyResumeOperation(drained).outcome.kind).toBe("committed");
				expect(P_retire({ ...drained, proofs: issued.proofs })).toBe(false);
			});

			it(`rejects a modified ${mode} issued prefix after ${publication}`, () => {
				const issued = create();
				const e = extended(issued, "direct");
				const bytes = captured(e).bytes.slice();
				bytes[e.capture.entries[0]!.range.start + 5] = 88;
				const direct = { ...captured(e), bytes, snapshotDigest: sha(bytes) };
				const capture =
					mode === "direct"
						? direct
						: descriptorCapture({ ...e, capture: direct }, [captured(issued).bytes.byteLength]);
				expect(
					validatePublicationSuccessions(e.pending, capture, e.publicationSuccessions, e.initialPublication),
				).toBe(false);
				expect(
					validateDurabilityProof(
						issued.proofs[0]!,
						e.pending,
						capture,
						e.publicationSuccessions,
						e.initialPublication,
					),
				).toEqual([]);
				expect(classifyResumeOperation({ ...e, capture }).outcome).toMatchObject({
					kind: "unknown",
					reason: "stale_snapshot",
				});
				expect(P_latch({ ...e, capture })).toBe(false);
			});

			it(`rejects unsupported or inconsistent ${publication} issued lengths with ${mode} evidence`, () => {
				const issued = create();
				const e = extended(issued, mode);
				const length = captured(issued).bytes.byteLength;
				for (const snapshotByteLength of [
					undefined,
					-1,
					0,
					Number.NaN,
					1.5,
					Number.MAX_SAFE_INTEGER + 1,
					length - 1,
					length + 1,
				]) {
					const invalid =
						publication === "initial"
							? {
									...e,
									initialPublication: {
										...e.initialPublication!,
										successor: {
											...e.initialPublication!.successor,
											snapshotByteLength: snapshotByteLength as number,
										},
									},
								}
							: {
									...e,
									publicationSuccessions: e.publicationSuccessions!.map(receipt => ({
										...receipt,
										successor: { ...receipt.successor, snapshotByteLength: snapshotByteLength as number },
									})),
								};
					expect(
						validatePublicationSuccessions(
							invalid.pending,
							invalid.capture,
							invalid.publicationSuccessions,
							invalid.initialPublication,
						),
					).toBe(false);
					expect(P_latch(invalid)).toBe(false);
				}
			});
		}

	for (const publication of ["initial", "replacement"] as const)
		it(`requires the exact descriptor-issued ${publication} prefix, not an unsupported hash assertion`, () => {
			const issued = publication === "initial" ? initiallyAbsent() : replacement(1);
			const e = extended(issued, "descriptor");
			if (!e.capture.byteEvidence) throw new Error("descriptor evidence missing");
			const byteLength = captured(issued).bytes.byteLength;
			for (const prefixes of [
				[],
				[{ byteLength, sha256: sha("other") }],
				[{ byteLength: byteLength - 1, sha256: captured(issued).snapshotDigest }],
			]) {
				const capture = { ...e.capture, byteEvidence: { ...e.capture.byteEvidence, prefixes } };
				expect(
					validatePublicationSuccessions(e.pending, capture, e.publicationSuccessions, e.initialPublication),
				).toBe(false);
				expect(
					validateDurabilityProof(
						issued.proofs[0]!,
						e.pending,
						capture,
						e.publicationSuccessions,
						e.initialPublication,
					),
				).toEqual([]);
				expect(P_latch({ ...e, capture })).toBe(false);
			}
		});
});

describe("initial publication logical header binding", () => {
	for (const mode of ["direct", "descriptor"] as const) {
		it(`rejects mutually consistent intent/receipt header A with captured header B (${mode})`, () => {
			const issued = initiallyAbsent();
			const intent = { ...issued.pending.durabilityDebt.initialPublication!, headerId: "header-A" };
			const e = {
				...issued,
				pending: {
					...issued.pending,
					durabilityDebt: { ...issued.pending.durabilityDebt, initialPublication: intent },
				},
				initialPublication: { ...issued.initialPublication, headerId: intent.headerId },
				capture: mode === "direct" ? captured(issued) : descriptorCapture(issued),
			};
			expect(e.capture.reducerView.headerId).toBe("header");
			expect(validatePublicationSuccessions(e.pending, e.capture, [], e.initialPublication)).toBe(false);
			expect(validateDurabilityProof(e.proofs[0]!, e.pending, e.capture, [], e.initialPublication)).toEqual([]);
			expect(classifyResumeOperation(e).outcome).toMatchObject({ kind: "unknown", reason: "stale_snapshot" });
			expect(P_latch(e)).toBe(false);
			expect(P_continue(e)).toBe(false);
			expect(P_retire(closed(e))).toBe(false);
		});

		for (const headerId of ["header", "replacement-header"])
			it(`${headerId === "header" ? "accepts matching" : "rejects changed"} initial header after checked replacement (${mode})`, () => {
				const issued = initiallyAbsent();
				const current = fixture({ emptyBase: true, cursors: 0, headerId });
				const fileIdentity = { dev: identity.dev, ino: "header-replacement" };
				const capture = { ...(mode === "direct" ? captured(current) : descriptorCapture(current)), fileIdentity };
				const succession: ResumePublicationSuccession = {
					publicationId: "header-checked-replacement",
					predecessor: issued.initialPublication.successor,
					successor: {
						fileIdentity,
						snapshotDigest: capture.snapshotDigest,
						snapshotByteLength: captured(current).bytes.byteLength,
					},
				};
				const e = {
					...current,
					pending: { ...current.pending, durabilityDebt: issued.pending.durabilityDebt },
					initialPublication: issued.initialPublication,
					capture,
					publicationSuccessions: [succession],
					proofs: current.proofs.map(proof => ({
						...proof,
						fileIdentity,
						publicationId: succession.publicationId,
					})),
				};
				const matches = headerId === "header";
				expect(
					validatePublicationSuccessions(e.pending, capture, e.publicationSuccessions, e.initialPublication),
				).toBe(matches);
				expect(
					validateDurabilityProof(
						e.proofs[0]!,
						e.pending,
						capture,
						e.publicationSuccessions,
						e.initialPublication,
					),
				).toEqual(matches ? ["M", "D1"] : []);
				expect(classifyResumeOperation(e).outcome.kind).toBe(matches ? "committed" : "unknown");
				expect(P_latch(e)).toBe(matches);
				expect(P_continue(e)).toBe(matches);
				expect(P_retire(closed(e))).toBe(matches);
			});
	}
});

describe("C23 suffix, no-effect, readiness, and independent retirement", () => {
	it("live missing is held, actual final closed missing is lost, terminal-in-flight is never held", () => {
		const e = fixture({ suffix: "held" });
		expect(classifyResumeOperation(e).receipt.commitment.heldIds).toEqual(["L"]);
		expect(classifyResumeOperation(e).receipt.commitment.lostResidentIds).toEqual([]);
		const final = closed({ ...e, debt: { ...e.debt, heldQueueIds: [] } });
		expect(classifyResumeOperation(final).receipt.commitment.lostResidentIds).toEqual(["L"]);
		expect(classifyResumeOperation(final).receipt.commitment.heldIds).toEqual([]);
		const inflight: ResumeOperationEvidence = {
			...e,
			manager: { kind: "terminal", closeOutcome: "in_flight", residentAttempt: "retained" },
		};
		expect(classifyResumeOperation(inflight).receipt.commitment.suffixState).toBe("unproven");
		expect(P_retire(inflight)).toBe(false);
	});

	it("suffix precedence is unproven before held, and held before any success", () => {
		const e = fixture({ suffix: "unproven" });
		const missing: ResumeResidentEntry = {
			id: "later",
			kind: "dependent",
			residentKind: "retainedLocal",
			parentId: "L",
			payloadDigest: "fixed",
			order: 5,
		};
		const result = classifyResumeOperation({ ...e, residentSuffix: [...e.residentSuffix, missing] });
		expect(result.receipt.commitment.suffixState).toBe("unproven");
		expect(result.receipt.commitment.heldIds).toEqual(["later"]);
		expect(result.receipt.commitment.unprovenIds).toEqual(["L"]);
	});

	it("reports no selection effect for a discarded dependent-only attempt, independently of vacuous selection commitment", () => {
		const e = closed({ ...fixture({ cursors: 0, dependents: 1, enroll: false, present: 0 }), residentTip: "a" });
		const result = classifyResumeOperation(e);
		expect(result.outcome.kind).toBe("not_committed");
		expect(result.receipt.commitment.selectionCommitted).toBe(true);
		expect(result.receipt.commitment.selectionEffect).toBe("none");
		expect(result.receipt.commitment.operationComplete).toBe(false);
		expect(result.receipt.commitment.dependentsMissing).toEqual(["D1"]);
	});

	it("not_committed requires discarded/no-future-debt facts without authorizing a live close", () => {
		const e = fixture({ present: 0 });
		const nonterminal = classifyResumeOperation(e);
		expect(nonterminal.outcome).toMatchObject({ kind: "not_committed", reason: "discarded_after_nonterminal_drain" });
		expect(nonterminal.receipt.routing.action).toBe("RETAIN_LIVE");
		expect(nonterminal.receipt.terminalDisposition.kind).toBe("retained_live");
		expect(P_retire(e)).toBe(false);
		const retained: ResumeOperationEvidence = {
			...e,
			manager: { kind: "live", strictClosePending: false, residentAttempt: "retained" },
		};
		expect(classifyResumeOperation(retained).outcome).toMatchObject({
			kind: "unknown",
			reason: "resident_attempt_retained",
		});
		const final = closed(e);
		expect(classifyResumeOperation(final).outcome.kind).toBe("not_committed");
		expect(P_retire(final)).toBe(true);
		for (const debt of [
			{ ...final.debt, rewriteDebt: true },
			{ ...final.debt, heldQueueIds: ["M"] },
			{ ...final.debt, deferredPublicationIds: ["M"] },
		])
			expect(classifyResumeOperation({ ...final, debt }).outcome.kind).toBe("unknown");
		if (final.manager.kind !== "terminal") throw new Error("terminal fixture expected");
		expect(
			classifyResumeOperation({ ...final, manager: { ...final.manager, residentAttempt: "retained" } }).outcome.kind,
		).toBe("unknown");
	});

	it("unreported missing resident manifest attempts are held debt, not no-effect", () => {
		const e = fixture({ present: 1 });
		const retained: ResumeOperationEvidence = {
			...e,
			manager: { kind: "live", strictClosePending: false, residentAttempt: "retained" },
		};
		const result = classifyResumeOperation(retained);
		expect(result.outcome.kind).toBe("enrolled_only");
		expect(result.receipt.commitment.heldIds).toEqual(["C1", "C2", "D1"]);
		expect(P_latch(retained)).toBe(false);
	});

	it("remaining conflict fences native Continue but not cooperative writer readiness", () => {
		const original = fixture({ suffix: "published", remainingConflict: ["cold-peer"] });
		const cooperative = {
			...original.pending,
			policy: { ...original.pending.policy, kind: "cooperative_tui" as const },
		};
		const e = {
			...original,
			pending: cooperative,
			readiness: { ...original.readiness, currentBinding: cooperative },
		};
		const result = classifyResumeOperation(e);
		expect(result.outcome.kind).toBe("committed_with_remaining_conflict");
		expect(P_latch(e)).toBe(true);
		expect(P_continue(e)).toBe(false);
		expect(result.receipt.routing.readiness.current).toBe("ready");
		expect(result.receipt.commitment.continueEligible).toBe(false);
	});

	it("fresh reducer candidates cannot be suppressed by a caller's empty remainingConflict", () => {
		const e = fixture({ cursors: 1, dependents: 0 });
		const result = classifyResumeOperation(e);
		expect(result.receipt.commitment.reducerView?.kind).toBe("ambiguous");
		expect(result.receipt.remainingConflict).toEqual(["c"]);
		expect(result.outcome.kind).toBe("committed_with_remaining_conflict");
		expect(P_latch(e)).toBe(true);
		expect(P_continue(e)).toBe(false);
	});

	it("readiness validates membership, policy, local context, writer, and exact repaired error reference", () => {
		const e = fixture();
		for (const readiness of [
			{ ...e.readiness, writer: "unusable" as const },
			{ ...e.readiness, localContextCurrent: false },
			{ ...e.readiness, currentBinding: null },
			{ ...e.readiness, currentBinding: { ...e.pending, epoch: "other" } },
			{ ...e.readiness, currentBinding: { ...e.pending, policy: { ...e.pending.policy, rev: 2 } } },
			{ ...e.readiness, persistError: { errorRef: "original", repairedErrorRef: "other" } },
		])
			expect(P_latch({ ...e, readiness })).toBe(false);
		expect(
			P_latch({
				...e,
				readiness: { ...e.readiness, persistError: { errorRef: "original", repairedErrorRef: "original" } },
			}),
		).toBe(true);
	});

	it("live TERM and OPEN refusals preserve prior readiness for healthy and fenced members", () => {
		for (const prior of ["ready", "fenced"] as const) {
			for (const refusal of ["termination_not_authorized", "context_mismatch"] as const) {
				const e = fixture({ suffix: prior === "ready" ? "held" : "published" });
				const result = classifyResumeOperation({
					...e,
					completionRefusal: refusal,
					routing: {
						...e.routing,
						invocation: refusal === "context_mismatch" ? "OPEN" : "TERM",
						authorization: { ...e.routing.authorization, refusal },
						readiness: { prior, current: prior },
					},
				});
				expect(result.receipt.routing.readiness).toEqual({ prior, current: prior });
				expect(result.refusal).toBe(refusal);
				expect(result.receipt.terminalDisposition.kind).toBe("retained_live");
				expect(result.receipt.routing.action).toBe("RETAIN_LIVE");
			}
		}
	});

	it("routing cannot authorize retirement, readiness, or closure effects", () => {
		const e = fixture({ suffix: "held" });
		const misleading: ResumeOperationEvidence = {
			...e,
			routing: {
				...e.routing,
				action: "TERMINATE",
				closeOutcome: "closed",
				authorization: { tokenValid: true, terminationIntent: "consented_teardown", intentValid: true },
				readiness: { prior: "ready", current: "ready" },
			},
		};
		expect(P_retire(misleading)).toBe(false);
		expect(P_latch(misleading)).toBe(false);
		expect(classifyResumeOperation(misleading).receipt.terminalDisposition.kind).toBe("retained_live");
	});

	it("authorized actual closure retires durable prefixes and lost suffix independently of success", () => {
		for (const present of [1, 2, 3, 4]) {
			const e = fixture({ suffix: "lost", present });
			const result = classifyResumeOperation(e);
			expect(P_retire(e)).toBe(true);
			expect(result.receipt.commitment.operationComplete).toBe(false);
			expect(result.receipt.terminalDisposition.kind).toBe("retained_after_close");
			expect(result.receipt.terminalDisposition.reason).toBe("retirement_permitted_not_applied");
			const applied = classifyResumeOperation({
				...e,
				retirement: {
					kind: "member_retired",
					registryIntentId: "intent",
					memberToken: e.pending.memberToken,
					authorityKey: e.pending.authorityKey,
					epoch: e.pending.epoch,
					op: e.pending.op,
					finalCaptureDigest: captured(e).snapshotDigest,
				},
			});
			expect(applied.receipt.terminalDisposition.kind).toBe("retired");
			expect(result.receipt.commitment.lostResidentIds).toEqual(["L"]);
			expect(P_continue(e)).toBe(false);
		}
	});

	it("closure unknown, no actual authorization, surviving unproven bytes, or future debt retain after close", () => {
		const e = closed(fixture());
		if (e.manager.kind !== "terminal" || !e.manager.closure) throw new Error("closure missing");
		const closure = e.manager.closure;
		const candidates: ResumeOperationEvidence[] = [
			{ ...e, manager: { ...e.manager, closeOutcome: "close_unknown" } },
			{ ...e, manager: { ...e.manager, closure: undefined } },
			{
				...e,
				manager: {
					...e.manager,
					closure: {
						...closure,
						authorization: {
							kind: "consented_teardown",
							registryIntentId: "",
							stopAdmitting: true,
							runtime: "stopped_joined",
						},
					},
				},
			},
			{ ...e, manager: { ...e.manager, closure: { ...closure, writerClosed: false } } },
			{ ...e, manager: { ...e.manager, closure: { ...closure, residentReleased: false } } },
			{ ...e, manager: { ...e.manager, closure: { ...closure, finalCaptureDigest: "stale" } } },
			{ ...e, debt: { ...e.debt, deferredPublicationIds: ["D1"] } },
			closed(fixture({ suffix: "unproven" })),
		];
		for (const candidate of candidates) {
			expect(P_retire(candidate)).toBe(false);
			expect(classifyResumeOperation(candidate).receipt.terminalDisposition.kind).toBe("retained_after_close");
		}
	});

	it("bytes extended by final drain require final_drain_sync rather than an old flush", () => {
		const e = closed(fixture({ suffix: "published" }));
		if (e.manager.kind !== "terminal" || !e.manager.closure) throw new Error("closure missing");
		const preCloseSnapshotByteLength = captured(e).entries.find(entry => entry.id === "L")?.range.start;
		if (preCloseSnapshotByteLength === undefined) throw new Error("final drain range missing");
		const final = {
			...e,
			manager: {
				...e.manager,
				closure: { ...e.manager.closure, preCloseSnapshotByteLength, publishedByFinalDrain: ["L"] },
			},
		};
		expect(P_retire(final)).toBe(false);
		// Omitting the advisory drain-id list cannot hide bytes extended by closeStrict.
		expect(
			P_retire({
				...final,
				manager: { ...final.manager, closure: { ...final.manager.closure, publishedByFinalDrain: [] } },
			}),
		).toBe(false);
		expect(P_retire(proofChanged(final, { kind: "final_drain_sync" }))).toBe(true);
	});
});
