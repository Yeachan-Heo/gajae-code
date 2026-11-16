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
	type ResumeFreshCapture,
	type ResumeManifestEntry,
	type ResumeOperationEvidence,
	type ResumeResidentEntry,
	validateDurabilityProof,
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
					bind: "header",
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
					bind: "header",
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
		{ type: "session", id: "header", version: 3, timestamp, cwd: "/project" },
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
		durabilityDebt: { ids: manifest.map(entry => entry.id), fileIdentity: identity, attempts: 1 },
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

function captured(e: ResumeOperationEvidence): ResumeFreshCapture {
	if (e.capture.kind !== "captured") throw new Error("fixture capture missing");
	return e.capture;
}

function closed(e: ResumeOperationEvidence): ResumeOperationEvidence {
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
				finalCaptureDigest: captured(e).snapshotDigest,
				preCloseSnapshotByteLength: captured(e).bytes.byteLength,
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
