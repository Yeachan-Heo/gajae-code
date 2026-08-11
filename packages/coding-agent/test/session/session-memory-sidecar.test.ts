/**
 * Contract tests for the standalone sidecar primitives: accountant arithmetic
 * and disk-ref demotion, the six nearest-model cases, TTSR latest-wins,
 * duplicate-ID sidecar ineligibility, deterministic dictionary output,
 * anchored base + rolling tail checksum tamper detection, the five reopen
 * classes, the derived-file predicate (incl. `.spill.buckets`), and cache
 * budget rejection.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	applyReducerDelta,
	type BaseAnchor,
	BLOCK_CACHE_BUDGET_BYTES,
	BoundedDictionaryArtifactBuilder,
	BoundedDictionaryBuilder,
	BoundedDictionaryIdSet,
	BoundedLabelsPinsStore,
	BoundedParentArtifactBuilder,
	BoundedParentChildrenIndex,
	type CommitMarkerContents,
	type CommittedTail,
	classifyReopen,
	coldBranchOrdinalRunWithinPrefetchBounds,
	computeLineDigest,
	computeTerminalChecksum,
	createReducerState,
	DESCRIPTOR_BYTES,
	type DescriptorSnapshot,
	DICTIONARY_BUILD_PEAK_BYTES,
	DICTIONARY_PARTITION_COUNT,
	type DictionaryArtifactFlushTarget,
	type DictionaryArtifactRecordInput,
	type DictionaryIdDetector,
	type DictionaryPartitionCommit,
	dictionaryPartitionForId,
	ENTRY_CACHE_BUDGET_BYTES,
	FixedCacheAccount,
	finalizeDictionaryArtifactCommit,
	foldReducerStates,
	getLastModelChangeRole,
	isDerivedSessionMemoryFile,
	isValidMetadataDeltaCommit,
	isValidMetadataDeltaValue,
	LABELS_PINS_BUDGET_BYTES,
	MAX_REDUCER_INLINE_BYTES,
	type MetadataDeltaArtifactCommit,
	metadataDeltaValueDescriptor,
	type ParentBucketRecordInput,
	parentBucketForId,
	parseDictionaryArtifactCommit,
	parseDictionaryPartitionRecord,
	parseParentBucketRecord,
	ReducerBudget,
	type ReopenEvidence,
	RollingTailChainBuilder,
	residentArrayBytes,
	residentStringBytes,
	SESSION_MEMORY_ACCEPTANCE_BUDGET_BYTES,
	SESSION_MEMORY_STEADY_STATE_BUDGET_BYTES,
	SessionMemoryAccountant,
	serializeDictionaryPartitionRecord,
	serializeParentBucketRecord,
	TAIL_BUFFER_BUDGET_BYTES,
	type TailRecordInput,
	validateCommit,
	validateTailChain,
} from "../../src/session/internal/session-memory-sidecar";

const enc = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("cold branch ordinal prefetch bounds", () => {
	it("admits the 10k latency run and rejects million-entry or oversized sparse intervals before allocation", () => {
		expect(
			coldBranchOrdinalRunWithinPrefetchBounds({
				boundaryOrdinal: 10,
				leafOrdinal: 10_010,
				transcriptStart: 1_000,
				transcriptEnd: 2 * 1024 * 1024,
				maxTranscriptBytes: 64 * 1024 * 1024,
			}),
		).toBe(true);
		expect(
			coldBranchOrdinalRunWithinPrefetchBounds({
				boundaryOrdinal: 10,
				leafOrdinal: 1_000_010,
				transcriptStart: 1_000,
				transcriptEnd: 2 * 1024 * 1024,
				maxTranscriptBytes: 64 * 1024 * 1024,
			}),
		).toBe(false);
		expect(
			coldBranchOrdinalRunWithinPrefetchBounds({
				boundaryOrdinal: 10,
				leafOrdinal: 20,
				transcriptStart: 1_000,
				transcriptEnd: 64 * 1024 * 1024 + 1_001,
				maxTranscriptBytes: 64 * 1024 * 1024,
			}),
		).toBe(false);
	});
});

describe("SessionMemoryAccountant arithmetic", () => {
	it("charges the resident formulas exactly", () => {
		const accountant = new SessionMemoryAccountant();
		expect(residentStringBytes("hello")).toBe(2 * 5 + 16);
		expect(residentArrayBytes(3, 100)).toBe(8 * 3 + 100);
		accountant.chargeString("hello");
		expect(accountant.totalBytes).toBe(26);
		accountant.chargeArray(3, 100);
		expect(accountant.totalBytes).toBe(26 + 124);
		accountant.chargeDescriptor();
		expect(accountant.totalBytes).toBe(26 + 124 + DESCRIPTOR_BYTES);
		accountant.release(26);
		expect(accountant.totalBytes).toBe(124 + DESCRIPTOR_BYTES);
		expect(accountant.isWithinBudget()).toBe(true);
	});

	it("tryCharge rejects over-budget additions without mutating", () => {
		const accountant = new SessionMemoryAccountant(100);
		expect(accountant.tryCharge(60)).toBe(true);
		expect(accountant.tryCharge(50)).toBe(false);
		expect(accountant.totalBytes).toBe(60);
		expect(accountant.wouldExceed(50)).toBe(true);
		expect(accountant.wouldExceed(40)).toBe(false);
	});

	it("defines the 64 MiB acceptance and 61.0625 MiB steady-state budgets", () => {
		expect(SESSION_MEMORY_ACCEPTANCE_BUDGET_BYTES).toBe(64 * 1024 * 1024);
		expect(SESSION_MEMORY_STEADY_STATE_BUDGET_BYTES).toBe(61 * 1024 * 1024 + 64 * 1024);
	});
});

describe("ReducerBudget disk-ref demotion", () => {
	it("stores values over MAX_REDUCER_INLINE_BYTES as disk-ref descriptors", () => {
		const budget = new ReducerBudget();
		const result = budget.setInline("big", MAX_REDUCER_INLINE_BYTES + 1);
		expect(result.kind).toBe("ok");
		const entry = budget.get("big");
		expect(entry?.kind).toBe("disk_ref");
		expect(entry?.residentBytes).toBe(DESCRIPTOR_BYTES);
		const descriptor = budget.getDescriptor("big");
		expect(descriptor?.section).toBe("metadata-delta");
		expect(descriptor?.length).toBe(MAX_REDUCER_INLINE_BYTES + 1);
	});

	it("keeps small values inline (cheaper than a descriptor)", () => {
		const budget = new ReducerBudget();
		budget.setInline("small", 10);
		expect(budget.get("small")?.kind).toBe("inline");
		expect(budget.totalBytes).toBeGreaterThan(10);
	});

	it("demotes the largest resident value before the cap is crossed", () => {
		const budget = new ReducerBudget(1024);
		budget.setInline("a", 500);
		budget.setInline("b", 700);
		// Payload plus retained key/digest/object metadata crosses the cap, so the
		// largest payload is demoted while its metadata remains charged.
		expect(budget.totalBytes).toBeLessThanOrEqual(1024);
		expect(budget.totalBytes).toBeGreaterThan(500 + DESCRIPTOR_BYTES);
		expect(budget.get("b")?.kind).toBe("disk_ref");
		expect(budget.get("a")?.kind).toBe("inline");
	});

	it("reports over_budget_irreducible when only descriptors remain over budget", () => {
		const budget = new ReducerBudget(40);
		budget.setInline("a", 100);
		const result = budget.setInline("b", 100);
		// Descriptor payloads and their retained key/digest/object metadata remain
		// over the tiny budget once no inline value can be demoted further.
		expect(result.kind).toBe("over_budget_irreducible");
		expect(budget.totalBytes).toBeGreaterThan(2 * DESCRIPTOR_BYTES);
	});
});

describe("nearest model-change role (R1)", () => {
	it("reviewer-only resolves to reviewer", () => {
		let state = createReducerState();
		state = applyReducerDelta(state, { kind: "latest_model_change", ordinal: 1, role: "reviewer" });
		expect(getLastModelChangeRole(state)).toBe("reviewer");
	});

	it("temporary-only resolves to temporary", () => {
		let state = createReducerState();
		state = applyReducerDelta(state, { kind: "latest_model_change", ordinal: 2, role: "temporary" });
		expect(getLastModelChangeRole(state)).toBe("temporary");
	});

	it("interleaved default→reviewer→temporary resolves to the nearest (temporary)", () => {
		let state = createReducerState();
		state = applyReducerDelta(state, { kind: "latest_model_change", ordinal: 1, role: "default" });
		state = applyReducerDelta(state, { kind: "latest_model_change", ordinal: 2, role: "reviewer" });
		state = applyReducerDelta(state, { kind: "latest_model_change", ordinal: 3, role: "temporary" });
		expect(getLastModelChangeRole(state)).toBe("temporary");
	});

	it("no model_change resolves to undefined", () => {
		expect(getLastModelChangeRole(createReducerState())).toBeUndefined();
	});

	it("legacy-only (no model_change) resolves to undefined while models.default is inferred", () => {
		// The reducer carries no model_change; the legacy assistant-inference into
		// models.default is a separate SessionManager mechanism (hasExplicitDefaultModel).
		expect(getLastModelChangeRole(createReducerState())).toBeUndefined();
	});

	it("explicit default then legacy inference resolves to default", () => {
		let state = createReducerState();
		state = applyReducerDelta(state, { kind: "latest_model_change", ordinal: 1, role: "default" });
		expect(getLastModelChangeRole(state)).toBe("default");
	});

	it("role-less model_change defaults to default", () => {
		let state = createReducerState();
		state = applyReducerDelta(state, { kind: "latest_model_change", ordinal: 1 });
		expect(getLastModelChangeRole(state)).toBe("default");
	});

	it("compaction fold keeps the max-ordinal value (nearest wins)", () => {
		const left = applyReducerDelta(createReducerState(), {
			kind: "latest_model_change",
			ordinal: 2,
			role: "default",
		});
		const right = applyReducerDelta(createReducerState(), {
			kind: "latest_model_change",
			ordinal: 5,
			role: "reviewer",
		});
		expect(getLastModelChangeRole(foldReducerStates(left, right))).toBe("reviewer");
	});
});

describe("TTSR latest-wins", () => {
	it("count replaces the prior value (authoritative buildSessionContext)", () => {
		let state = createReducerState();
		state = applyReducerDelta(state, {
			kind: "ttsr_injection",
			ordinal: 1,
			rulesCount: 2,
			recordsCount: 3,
			count: 10,
		});
		state = applyReducerDelta(state, {
			kind: "ttsr_injection",
			ordinal: 2,
			rulesCount: 4,
			recordsCount: 5,
			count: 30,
		});
		expect(state.ttsr.count).toBe(30);
		expect(state.ttsr.rulesCount).toBe(4);
		expect(state.ttsr.recordsCount).toBe(5);
	});

	it("fold keeps the latest ordinal's count", () => {
		const left = applyReducerDelta(createReducerState(), {
			kind: "ttsr_injection",
			ordinal: 1,
			rulesCount: 1,
			recordsCount: 1,
			count: 5,
		});
		const right = applyReducerDelta(createReducerState(), {
			kind: "ttsr_injection",
			ordinal: 3,
			rulesCount: 2,
			recordsCount: 2,
			count: 9,
		});
		expect(foldReducerStates(left, right).ttsr.count).toBe(9);
	});
});

describe("BoundedDictionaryBuilder", () => {
	it("produces deterministic append-only output", () => {
		const records = [
			{ ordinal: 0, id: "a", bytes: enc("hello") },
			{ ordinal: 1, id: "b", bytes: enc("world") },
			{ ordinal: 2, id: "c", bytes: enc("hello") }, // duplicate term → reused id
		];
		const buildOnce = new BoundedDictionaryBuilder();
		for (const record of records) buildOnce.add(record);
		const first = buildOnce.finish();
		const buildAgain = new BoundedDictionaryBuilder();
		for (const record of records) buildAgain.add(record);
		const second = buildAgain.finish();
		expect(first.kind).toBe("ok");
		expect(second.kind).toBe("ok");
		if (first.kind !== "ok" || second.kind !== "ok") throw new Error("expected ok build");
		expect(first.dictionary.terms).toEqual(second.dictionary.terms);
		expect(first.dictionary.terms).toEqual(["hello", "world"]);
		expect(first.dictionary.idByTerm.get("hello")).toBe(0);
		expect(first.dictionary.idByTerm.get("world")).toBe(1);
		expect(first.stats.uniqueTerms).toBe(2);
		expect(first.stats.totalRecords).toBe(3);
		expect(first.stats.sidecarIneligible).toBe(false);
	});

	it("marks the session sidecar-ineligible on duplicate record IDs", () => {
		const builder = new BoundedDictionaryBuilder();
		builder.add({ ordinal: 0, id: "dup", bytes: enc("x") });
		builder.add({ ordinal: 1, id: "dup", bytes: enc("y") });
		const result = builder.finish();
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") throw new Error("expected ok build");
		expect(result.stats.sidecarIneligible).toBe(true);
		expect(result.stats.duplicateIds).toEqual(["dup"]);
		expect(result.dictionary.header.sidecarIneligible).toBe(true);
	});

	it("uses a 20 MiB default build peak and enforces a custom budget", () => {
		expect(DICTIONARY_BUILD_PEAK_BYTES).toBe(20 * 1024 * 1024);
		const builder = new BoundedDictionaryBuilder({
			peakBudgetBytes: 100,
			partitionBufferBytes: 10,
			bucketJournalBytes: 10,
		});
		const result = builder.add({ ordinal: 0, id: "big", bytes: enc("x".repeat(200)) });
		expect(result.kind).toBe("budget_exceeded");
		if (result.kind === "budget_exceeded") {
			expect(result.peakBytes).toBeGreaterThan(result.budgetBytes);
		}
	});

	it("charges retained record IDs and duplicate diagnostics", () => {
		const builder = new BoundedDictionaryBuilder({
			peakBudgetBytes: 350,
			partitionBufferBytes: 1,
			bucketJournalBytes: 1,
		});
		expect(builder.add({ ordinal: 0, id: "a".repeat(80), bytes: enc("x") }).kind).toBe("ok");
		expect(builder.add({ ordinal: 1, id: "b".repeat(80), bytes: enc("x") }).kind).toBe("budget_exceeded");
	});
});

describe("anchored base digest + rolling tail chain tamper detection", () => {
	const base: BaseAnchor = { baseDigest: "abc123", baseEndOffset: 100 };

	function couple(): { records: TailRecordInput[]; tail: CommittedTail } {
		const records: TailRecordInput[] = [
			{
				seq: 0,
				kind: "user",
				ordinal: 0,
				id: "m0",
				parentId: null,
				type: "user",
				byteOffset: 100,
				byteLength: 5,
				recordDigest: computeLineDigest(enc("line0")),
			},
			{
				seq: 1,
				kind: "assistant",
				ordinal: 1,
				id: "m1",
				parentId: "m0",
				type: "assistant",
				byteOffset: 105,
				byteLength: 7,
				recordDigest: computeLineDigest(enc("line111")),
			},
		];
		const builder = new RollingTailChainBuilder(base);
		for (const record of records) builder.append(record);
		return { records, tail: builder.build() };
	}

	it("computes a deterministic chain and validates it", () => {
		const { tail } = couple();
		expect(tail.records.length).toBe(2);
		expect(validateTailChain(base, tail.records).valid).toBe(true);
		expect(tail.terminalChecksum).toBe(computeTerminalChecksum(base, tail.records));
		expect(tail.transcriptSize).toBe(112);
		// Determinism: same input → same checksums.
		const { tail: again } = couple();
		expect(again.terminalChecksum).toBe(tail.terminalChecksum);
	});

	it("detects tampering in payload and ordering metadata", () => {
		const { records, tail } = couple();
		// Tamper byteLength on record 0 → record 1's offset becomes discontinuous.
		const tamperedLength = validateTailChain(base, [{ ...tail.records[0], byteLength: 9 }, tail.records[1]]);
		expect(tamperedLength.valid).toBe(false);
		expect(tamperedLength.reason).toBe("checksum_mismatch");
		// Tamper recordDigest on record 0 → C0 mismatch.
		const tamperedDigest = validateTailChain(base, [
			{ ...tail.records[0], recordDigest: computeLineDigest(enc("evil")) },
			tail.records[1],
		]);
		expect(tamperedDigest.valid).toBe(false);
		expect(tamperedDigest.reason).toBe("checksum_mismatch");
		for (const tampered of [
			{ ...tail.records[0], id: "other" },
			{ ...tail.records[0], parentId: "other-parent" },
			{ ...tail.records[0], ordinal: 99 },
			{ ...tail.records[0], kind: "tool" as const },
			{ ...tail.records[0], type: "other" },
			{ ...tail.records[0], gen: 99 },
		]) {
			expect(validateTailChain(base, [tampered, tail.records[1]])).toMatchObject({
				valid: false,
				reason: "checksum_mismatch",
			});
		}
		// Tamper the base digest → C0 mismatch.
		const tamperedBase = validateTailChain({ baseDigest: "deadbeef", baseEndOffset: 100 }, tail.records);
		expect(tamperedBase.valid).toBe(false);
		expect(tamperedBase.reason).toBe("checksum_mismatch");
		// Sanity: the untouched records still validate.
		expect(
			validateTailChain(
				base,
				records.map((r, i) => ({ ...r, gen: 0, checksum: tail.records[i].checksum })),
			).valid,
		).toBe(true);
	});
});

describe("commit validation", () => {
	const descriptor: DescriptorSnapshot = { dev: 1n, ino: 2n, nlink: 1n, size: 112, mtimeNs: 100n, ctimeNs: 100n };
	const base: BaseAnchor = { baseDigest: "base", baseEndOffset: 100 };

	function consistentCommit(): {
		commit: CommitMarkerContents;
		records: CommittedTail["records"];
	} {
		const builder = new RollingTailChainBuilder(base);
		builder.append({
			seq: 0,
			kind: "user",
			ordinal: 0,
			id: "m0",
			parentId: null,
			type: "user",
			byteOffset: 100,
			byteLength: 5,
			recordDigest: computeLineDigest(enc("line0")),
		});
		builder.append({
			seq: 1,
			kind: "assistant",
			ordinal: 1,
			id: "m1",
			parentId: "m0",
			type: "assistant",
			byteOffset: 105,
			byteLength: 7,
			recordDigest: computeLineDigest(enc("line111")),
		});
		const tail = builder.build();
		return {
			records: tail.records,
			commit: {
				gen: 1,
				descriptor,
				base,
				terminalChecksum: tail.terminalChecksum,
				terminalSeq: tail.terminalSeq,
				transcriptSize: tail.transcriptSize,
			},
		};
	}

	it("validates a consistent commit", () => {
		const { commit, records } = consistentCommit();
		const result = validateCommit(commit, records, {
			descriptor,
			baseValid: true,
			tailValid: true,
			terminalMarkerValid: true,
		});
		expect(result.kind).toBe("valid");
	});
	it("rejects a transcript-ahead prefix marker even when its descriptor is rewritten", () => {
		const { commit, records } = consistentCommit();
		const aheadDescriptor: DescriptorSnapshot = { ...descriptor, size: descriptor.size + 64 };
		const result = validateCommit({ ...commit, descriptor: aheadDescriptor }, records, {
			descriptor: aheadDescriptor,
			baseValid: true,
			tailValid: true,
			terminalMarkerValid: true,
		});
		expect(result).toMatchObject({ kind: "invalid", reason: "transcript_size_mismatch" });
	});

	it("flags a descriptor identity mismatch", () => {
		const { commit, records } = consistentCommit();
		const result = validateCommit(commit, records, {
			descriptor: { ...descriptor, ino: 999n },
			baseValid: true,
			tailValid: true,
			terminalMarkerValid: true,
		});
		expect(result).toMatchObject({ kind: "invalid", reason: "descriptor_mismatch" });
	});

	it("flags a tampered terminal checksum", () => {
		const { commit, records } = consistentCommit();
		const result = validateCommit({ ...commit, terminalChecksum: "nope" }, records, {
			descriptor,
			baseValid: true,
			tailValid: true,
			terminalMarkerValid: true,
		});
		expect(result).toMatchObject({ kind: "invalid", reason: "terminal_checksum_mismatch" });
	});

	it("flags missing fields", () => {
		const { records } = consistentCommit();
		const result = validateCommit({}, records, {
			descriptor,
			baseValid: true,
			tailValid: true,
			terminalMarkerValid: true,
		});
		expect(result).toMatchObject({ kind: "invalid", reason: "missing_fields" });
	});
});

describe("five-class reopen classification", () => {
	const exactEvidence: ReopenEvidence = {
		markerPresent: true,
		descriptorExact: true,
		sameObject: true,
		sameSize: true,
		sizeGrew: false,
		sizeShrank: false,
		withinScanWindow: true,
		timesAdvanced: true,
		timesChanged: false,
		baseValid: true,
		tailValid: true,
		terminalMarkerValid: true,
	};

	it("classifies exact", () => {
		expect(classifyReopen(exactEvidence).kind).toBe("exact");
	});

	it("classifies transcript_ahead on in-window growth with valid proof", () => {
		const evidence: ReopenEvidence = {
			...exactEvidence,
			descriptorExact: false,
			sameSize: false,
			sizeGrew: true,
			baseValid: true,
			tailValid: true,
		};
		expect(classifyReopen(evidence).kind).toBe("transcript_ahead");
	});

	it("classifies tail_ahead when a committed tail record fails at matching size", () => {
		const evidence: ReopenEvidence = {
			...exactEvidence,
			descriptorExact: false,
			baseValid: true,
			tailValid: false,
		};
		expect(classifyReopen(evidence).kind).toBe("tail_ahead");
	});

	it("classifies rebuild on same-size mutation, shrink, and over-window growth", () => {
		expect(classifyReopen({ ...exactEvidence, descriptorExact: false, timesChanged: true }).kind).toBe("rebuild");
		expect(
			classifyReopen({
				...exactEvidence,
				descriptorExact: false,
				sameSize: false,
				sizeGrew: false,
				sizeShrank: true,
			}).kind,
		).toBe("rebuild");
		expect(
			classifyReopen({
				...exactEvidence,
				descriptorExact: false,
				sameSize: false,
				sizeGrew: true,
				withinScanWindow: false,
			}).kind,
		).toBe("rebuild");
	});

	it("classifies stale_commit on a missing marker or object identity mismatch", () => {
		expect(classifyReopen({ ...exactEvidence, markerPresent: false }).kind).toBe("stale_commit");
		expect(classifyReopen({ ...exactEvidence, descriptorExact: false, sameObject: false }).kind).toBe("stale_commit");
	});

	it("never accepts a stale commit as current on any path", () => {
		for (const evidence of [
			{ ...exactEvidence, markerPresent: false },
			{ ...exactEvidence, descriptorExact: false, sameObject: false },
		]) {
			expect(classifyReopen(evidence).kind).not.toBe("exact");
		}
	});
});

describe("isDerivedSessionMemoryFile", () => {
	it("matches every sidecar artifact suffix and prefix", () => {
		const names = [
			"session.spill.idx",
			"session.spill.tail",
			"session.spill.commit",
			"session.spill.buckets",
			"session.spill.dict-0",
			"session.spill.dict-meta",
			"session.spill.dict-part-0003",
			"session.spill.metadata-delta",
			"session.spill.parent-0000",
			"session.spill.parent-0063",
			"session.spill.capture-abc.tmp",
			"session.spill.fork-def.tmp",
			"session.spill.overlay-ghi.tmp",
		];
		for (const name of names) {
			expect(isDerivedSessionMemoryFile(`/sessions/mysession/${name}`)).toBe(true);
		}
	});

	it("matches any .spill.*.tmp temp", () => {
		expect(isDerivedSessionMemoryFile("/s/session.spill.whatever.xyz.tmp")).toBe(true);
	});

	it("rejects the transcript and unrelated files", () => {
		expect(isDerivedSessionMemoryFile("/s/session.jsonl")).toBe(false);
		expect(isDerivedSessionMemoryFile("/s/session.spill")).toBe(false);
		expect(isDerivedSessionMemoryFile("/s/spill.index")).toBe(false);
		expect(isDerivedSessionMemoryFile("/s/session.spill.")).toBe(false);
	});
});

describe("fixed-size cache accounting", () => {
	it("defines the block/entry/tail budgets", () => {
		expect(BLOCK_CACHE_BUDGET_BYTES).toBe(8 * 1024 * 1024);
		expect(ENTRY_CACHE_BUDGET_BYTES).toBe(28 * 1024 * 1024);
		expect(TAIL_BUFFER_BUDGET_BYTES).toBe(4 * 1024 * 1024);
		expect(LABELS_PINS_BUDGET_BYTES).toBe(64 * 1024);
	});

	it("rejects allocations beyond the budget", () => {
		const cache = new FixedCacheAccount(100);
		expect(cache.tryAllocate(60)).toBe(true);
		expect(cache.tryAllocate(40)).toBe(true);
		expect(cache.tryAllocate(1)).toBe(false);
		expect(cache.allocatedBytes).toBe(100);
		cache.release(50);
		expect(cache.tryAllocate(50)).toBe(true);
		expect(cache.tryAllocate(1)).toBe(false);
	});
});

describe("bounded parent→children and labels/pins descriptors", () => {
	it("indexes parents to children within both bounds", () => {
		const index = new BoundedParentChildrenIndex({ maxParents: 2, maxChildrenPerParent: 2 });
		expect(index.add("root", "a")).toBe(true);
		expect(index.add("root", "b")).toBe(true);
		expect(index.add("root", "c")).toBe(false); // children bound
		expect(index.add("a", "x")).toBe(true);
		expect(index.add("a", "y")).toBe(true);
		expect(index.add("a", "z")).toBe(false); // children bound
		expect(index.add("b", "w")).toBe(false); // parents bound (root, a)
		expect(index.get("root")).toEqual(["a", "b"]);
		expect(index.size).toBe(2);
		const exposed = index.get("root") as string[];
		exposed.push("escape");
		expect(index.get("root")).toEqual(["a", "b"]);
		const entry = index.entries()[0].children as string[];
		entry.push("escape");
		expect(index.get("root")).toEqual(["a", "b"]);
	});

	it("byte-accounts parent and child identifiers", () => {
		const index = new BoundedParentChildrenIndex({ maxParents: 10, maxChildrenPerParent: 10, budgetBytes: 250 });
		expect(index.add("root", "a")).toBe(true);
		expect(index.totalBytes).toBeGreaterThan(0);
		expect(index.add("root", "b".repeat(100))).toBe(false);
		expect(index.get("root")).toEqual(["a"]);
	});

	it("byte-accounts labels/pins and rejects over-budget additions", () => {
		const store = new BoundedLabelsPinsStore(300);
		expect(store.setLabel("k1", "v1")).toBe(true);
		expect(store.setLabel("k2", "v2")).toBe(true);
		expect(store.setPin("p1", "v1")).toBe(true);
		expect(store.totalBytes).toBeGreaterThan(0);
		expect(store.getLabel("k1")).toBe("v1");
		expect(store.getPin("p1")).toBe("v1");
		// Replacing a value re-accounts the delta.
		expect(store.setLabel("k1", "longer-value")).toBe(true);
		// A value that does not fit the budget is rejected and not stored.
		const tight = new BoundedLabelsPinsStore(10);
		expect(tight.setLabel("kkkkkk", "vvvvvv")).toBe(false);
		expect(tight.getLabel("kkkkkk")).toBeUndefined();
		expect(tight.totalBytes).toBe(0);
	});

	it("deterministically buckets parent ids and round-trips bucket records", () => {
		expect(parentBucketForId("root", 64)).toBe(parentBucketForId("root", 64));
		expect(parentBucketForId("a", 64)).toBeGreaterThanOrEqual(0);
		expect(parentBucketForId("a", 64)).toBeLessThan(64);
		const record: ParentBucketRecordInput = {
			parentId: "root",
			childId: "child-1",
			ordinal: 2,
			seq: 2,
			byteOffset: 4096,
			byteLength: 123,
			recordDigest: "0".repeat(64),
			entryType: "custom",
		};
		const line = serializeParentBucketRecord(record);
		expect(line.endsWith("\n")).toBe(true);
		const parsed = parseParentBucketRecord(line);
		expect(parsed).toEqual(record);
		expect(parseParentBucketRecord("{corrupt\n")).toBeUndefined();
		expect(parseParentBucketRecord(JSON.stringify({ p: "root", c: "x", o: 1, s: 1, b: 1, l: 1 }))).toBeUndefined();
	});

	it("indexes parents fully or not at all under every bound", () => {
		const builder = new BoundedParentArtifactBuilder({
			maxParents: 3,
			maxChildrenPerParent: 2,
			budgetBytes: 10_000,
			bucketCount: 4,
		});
		builder.add(record("root", "a", 0));
		builder.add(record("root", "b", 1));
		builder.add(record("root", "c", 2)); // third child → root excluded entirely
		expect(builder.distinctParents).toBe(0);
		builder.add(record("p1", "x", 3));
		builder.add(record("p1", "y", 4));
		builder.add(record("p2", "z", 5));
		builder.add(record("p3", "w", 6));
		builder.add(record("p4", "v", 7)); // global parent capacity exhausted; missing lookup falls back eagerly
		expect(builder.distinctParents).toBe(3);
		const result = builder.finish("index-digest");
		expect(result.metadata.indexDigest).toBe("index-digest");
		expect(result.excludedParents).toContain("root");
		expect(result.excludedParents).not.toContain("p4");
		expect(result.metadata.buckets[parentBucketForId("root", 4)].complete).toBe(false);
		expect(result.metadata.buckets[parentBucketForId("p4", 4)].complete).toBe(false);
		// Physical order preserved per parent (bucket grouping may mix parents).
		const p1 = result.buckets[parentBucketForId("p1", 4)]
			.map(line => parseParentBucketRecord(line.trimEnd()))
			.filter(entry => entry?.parentId === "p1");
		expect(p1.map(entry => entry?.childId)).toEqual(["x", "y"]);
		const total = result.metadata.buckets.reduce((sum, bucket) => sum + bucket.size, 0);
		expect(total).toBeGreaterThan(0);
	});

	it("publishes no record when the first parent exceeds the byte budget", () => {
		const builder = new BoundedParentArtifactBuilder({
			maxParents: 10,
			maxChildrenPerParent: 10,
			budgetBytes: 1,
			bucketCount: 4,
		});
		builder.add(record("root", "a", 0));
		expect(builder.distinctParents).toBe(0);
		expect(builder.totalBytes).toBe(0);
		const result = builder.finish("d");
		expect(result.excludedParents).toEqual([]);
		expect(result.metadata.buckets[parentBucketForId("root", 4)].complete).toBe(false);
		expect(result.metadata.buckets.every(bucket => bucket.size === 0)).toBe(true);
	});

	it("digests every non-empty bucket over its exact serialized bytes", () => {
		const builder = new BoundedParentArtifactBuilder({
			maxParents: 10,
			maxChildrenPerParent: 10,
			budgetBytes: 100_000,
			bucketCount: 4,
		});
		builder.add(record("root", "a", 0));
		builder.add(record("root", "b", 1));
		const result = builder.finish("d");
		const bucket = parentBucketForId("root", 4);
		const hash = createHash("sha256");
		for (const line of result.buckets[bucket]) hash.update(line, "utf8");
		const expectedBytes = result.buckets[bucket].reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
		expect(result.metadata.buckets[bucket].size).toBe(expectedBytes);
		expect(result.metadata.buckets[bucket].complete).toBe(true);
		expect(result.metadata.buckets[bucket].digest).toBe(hash.digest("hex"));
	});
});

function record(parentId: string, childId: string, ordinal: number): ParentBucketRecordInput {
	return {
		parentId,
		childId,
		ordinal,
		seq: ordinal,
		byteOffset: ordinal * 100,
		byteLength: 40,
		recordDigest: "0".repeat(64),
		entryType: "custom",
	};
}

describe("boundary: accountant enforces the 64 MiB provider peak without retention", () => {
	it("releases scratch on overflow and leaves later builds possible", () => {
		const accountant = new SessionMemoryAccountant(SESSION_MEMORY_ACCEPTANCE_BUDGET_BYTES);
		// A charge just under the budget fits; a further charge is rejected.
		expect(accountant.tryCharge(SESSION_MEMORY_ACCEPTANCE_BUDGET_BYTES - 1)).toBe(true);
		expect(accountant.tryCharge(2)).toBe(false);
		expect(accountant.totalBytes).toBe(SESSION_MEMORY_ACCEPTANCE_BUDGET_BYTES - 1);
		// Releasing the scratch restores the budget for a later build.
		accountant.release(SESSION_MEMORY_ACCEPTANCE_BUDGET_BYTES - 1);
		expect(accountant.totalBytes).toBe(0);
		expect(accountant.tryCharge(1024)).toBe(true);
	});
});

describe("dictionary partition record serialization", () => {
	it("round-trips a partition record deterministically", () => {
		const input = {
			term: "entry-0001",
			dictId: 7,
			ordinal: 12,
			seq: 5,
			byteOffset: 1024,
			byteLength: 96,
			recordDigest: "a".repeat(64),
			parentId: "entry-0000",
			entryType: "message",
		};
		const line = serializeDictionaryPartitionRecord(input);
		expect(line.endsWith("\n")).toBe(true);
		const parsed = parseDictionaryPartitionRecord(line);
		expect(parsed).toEqual(input);
	});

	it("rejects malformed, empty, or out-of-bounds partition records", () => {
		const validTail = (): string => `"d":"${"a".repeat(64)}","p":null,"e":"message"}`;
		expect(parseDictionaryPartitionRecord("not-json\n")).toBeUndefined();
		expect(parseDictionaryPartitionRecord(`{"t":"","i":0,"o":0,"s":0,"b":0,"l":1,${validTail()}\n`)).toBeUndefined();
		expect(
			parseDictionaryPartitionRecord(`{"t":"id","i":0,"o":-1,"s":0,"b":0,"l":1,${validTail()}\n`),
		).toBeUndefined();
		expect(
			parseDictionaryPartitionRecord(`{"t":"id","i":0,"o":0,"s":0,"b":0,"l":0,${validTail()}\n`),
		).toBeUndefined();
		expect(
			parseDictionaryPartitionRecord(
				`{"t":"id","i":0,"o":0,"s":0,"b":0,"l":1,"d":"short","p":null,"e":"message"}\n`,
			),
		).toBeUndefined();
		expect(
			parseDictionaryPartitionRecord(`{"t":"id","i":0,"o":0,"s":0,"b":0,"l":1,${validTail()}"p":42}\n`),
		).toBeUndefined();
		expect(
			parseDictionaryPartitionRecord(`{"t":"id","i":-1,"o":0,"s":0,"b":0,"l":1,${validTail()}\n`),
		).toBeUndefined();
	});

	it("assigns the same id to the same partition deterministically", () => {
		const first = dictionaryPartitionForId("entry-0001");
		expect(dictionaryPartitionForId("entry-0001")).toBe(first);
		expect(first).toBeGreaterThanOrEqual(0);
		expect(first).toBeLessThan(DICTIONARY_PARTITION_COUNT);
		expect(dictionaryPartitionForId("entry-0002")).toBeGreaterThanOrEqual(0);
	});
});

describe("dictionary artifact meta binding", () => {
	const indexDigest = "f".repeat(64);
	const partition = (size: number, digest: string, records: number): DictionaryPartitionCommit => ({
		size,
		digest,
		records,
		complete: true,
	});

	it("finalizes self-authenticating deterministic meta bytes", () => {
		const commit = {
			header: { version: 2 as const, sessionId: "sess", sidecarIneligible: false },
			indexDigest,
			partitions: [0, 1, 2, 3].map(item => partition(100 + item, `${item}`.repeat(64), 2)),
			recordCount: 8,
			uniqueTerms: 8,
			totalBytes: 400,
			duplicateIds: [],
			sidecarIneligible: false,
		};
		const first = finalizeDictionaryArtifactCommit(commit);
		const second = finalizeDictionaryArtifactCommit(commit);
		expect(first.bytes).toBe(second.bytes);
		expect(first.commit.metaSize).toBe(first.bytes.length);
		expect(first.commit.metaDigest).toBe(createHash("sha256").update(first.bytes).digest("hex"));
		const payload = JSON.parse(first.bytes) as Record<string, unknown>;
		expect("metaSize" in payload).toBe(false);
		expect("metaDigest" in payload).toBe(false);
	});

	it("parses exact meta bytes and recomputes the digest over the exact bytes", () => {
		const commit = {
			header: { version: 2 as const, sessionId: "sess", sidecarIneligible: false },
			indexDigest,
			partitions: [0, 1, 2, 3].map(item => partition(10 + item, `${item + 10}`.repeat(32), 1)),
			recordCount: 4,
			uniqueTerms: 4,
			totalBytes: 100,
			duplicateIds: [],
			sidecarIneligible: false,
		};
		const { bytes, commit: finalized } = finalizeDictionaryArtifactCommit(commit);
		const parsed = parseDictionaryArtifactCommit(bytes);
		expect(parsed).toEqual(finalized);
		expect(parsed?.metaSize).toBe(Buffer.byteLength(bytes, "utf8"));
		expect(parsed?.metaDigest).toBe(createHash("sha256").update(bytes).digest("hex"));
	});

	it("rejects structurally invalid or tampered meta bytes", () => {
		expect(parseDictionaryArtifactCommit("garbage")).toBeUndefined();
		expect(parseDictionaryArtifactCommit("")).toBeUndefined();
		const commit = {
			header: { version: 2 as const, sessionId: "sess", sidecarIneligible: false },
			indexDigest,
			partitions: [0, 1, 2, 3].map(item => partition(10 + item, `${item + 10}`.repeat(32), 1)),
			recordCount: 4,
			uniqueTerms: 4,
			totalBytes: 100,
			duplicateIds: [],
			sidecarIneligible: false,
		};
		const { bytes } = finalizeDictionaryArtifactCommit(commit);
		const flipped = bytes.slice(0, 4) + (bytes[4] === "0" ? "1" : "0") + bytes.slice(5);
		expect(parseDictionaryArtifactCommit(flipped)).toBeUndefined();
		expect(parseDictionaryArtifactCommit(`${bytes}extra`)).toBeUndefined();
	});
});

describe("BoundedDictionaryArtifactBuilder", () => {
	class InMemoryFlushTarget implements DictionaryArtifactFlushTarget {
		readonly partitions: string[][] = Array.from({ length: DICTIONARY_PARTITION_COUNT }, () => []);
		writePartitionLines(partition: number, lines: readonly string[]): boolean {
			this.partitions[partition]!.push(...lines);
			return true;
		}
		getPartitionCommit(partition: number): DictionaryPartitionCommit {
			const lines = this.partitions[partition]!;
			const hash = createHash("sha256");
			let size = 0;
			for (const line of lines) {
				hash.update(line, "utf8");
				size += Buffer.byteLength(line, "utf8");
			}
			return { size, digest: hash.digest("hex"), records: lines.length, complete: true };
		}
	}

	const record = (id: string, ordinal: number): DictionaryArtifactRecordInput => ({
		id,
		ordinal,
		seq: ordinal,
		byteOffset: ordinal * 100,
		byteLength: 80,
		recordDigest: "d".repeat(64),
		parentId: ordinal === 0 ? null : `p-${ordinal}`,
		entryType: "message",
	});

	it("uses fixed-size hashes from the first record", () => {
		const detector = new BoundedDictionaryIdSet();
		for (let index = 0; index < 5_000; index++) {
			if (detector.add(`entry-${index}`) !== "added") throw new Error(`unexpected duplicate at ${index}`);
		}
		expect(detector.has("entry-4999")).toBe(true);
		expect(detector.add("entry-4999")).toBe("duplicate");
		expect(detector.has("missing")).toBe(false);
	});
	it("does not retain a hostile long id in the duplicate detector", () => {
		const detector = new BoundedDictionaryIdSet();
		const hostileId = "x".repeat(1024 * 1024);
		expect(detector.add(hostileId)).toBe("added");
		expect(detector.has(hostileId)).toBe(true);
		expect(detector.add(hostileId)).toBe("duplicate");
		expect(detector.add("after-hostile")).toBe("added");
		expect(detector.has("missing")).toBe(false);
	});
	it("builds deterministic partitions within the 20 MiB build peak", () => {
		const target = new InMemoryFlushTarget();
		const builder = new BoundedDictionaryArtifactBuilder({ target });
		const count = 20_000;
		for (let index = 0; index < count; index++) {
			expect(builder.add(record(`entry-${index}`, index)).kind).toBe("ok");
		}
		const built = builder.finish("sess", "a".repeat(64));
		expect(built.kind).toBe("ok");
		if (built.kind !== "ok") throw new Error("expected ok build");
		expect(built.stats.totalRecords).toBe(count);
		expect(built.stats.uniqueTerms).toBe(count);
		expect(built.stats.peakBytes).toBeLessThanOrEqual(DICTIONARY_BUILD_PEAK_BYTES);
		expect(built.stats.sidecarIneligible).toBe(false);
		expect(built.commit.partitions).toHaveLength(DICTIONARY_PARTITION_COUNT);
		const totalRecords = built.commit.partitions.reduce((sum, partition) => sum + partition.records, 0);
		expect(totalRecords).toBe(count);
		const allTerms = target.partitions.flat().map(line => parseDictionaryPartitionRecord(line)?.term);
		expect(allTerms).toHaveLength(count);
		expect(allTerms).toContain("entry-0");
		expect(allTerms).toContain(`entry-${count - 1}`);
	});

	it("marks the artifact sidecar-ineligible on duplicate record ids", () => {
		const target = new InMemoryFlushTarget();
		const builder = new BoundedDictionaryArtifactBuilder({ target });
		builder.add(record("dup", 0));
		builder.add(record("dup", 1));
		const built = builder.finish("sess", "a".repeat(64));
		expect(built.kind).toBe("ok");
		if (built.kind !== "ok") throw new Error("expected ok build");
		expect(built.stats.sidecarIneligible).toBe(true);
		expect(built.stats.duplicateIds).toEqual(["dup"]);
		expect(built.commit.header.sidecarIneligible).toBe(true);
	});

	it("reports budget_exceeded when a single record overflows the fixed peak", () => {
		const builder = new BoundedDictionaryArtifactBuilder({
			peakBudgetBytes: 64,
			partitionBufferBytes: 128,
			journalBytes: 256,
			target: new InMemoryFlushTarget(),
		});
		const result = builder.add(record("x".repeat(300), 0));
		expect(result.kind).toBe("budget_exceeded");
		if (result.kind === "budget_exceeded") {
			expect(result.peakBytes).toBeGreaterThan(result.budgetBytes);
		}
	});

	it("fails closed when the flush target rejects writes", () => {
		const failing: DictionaryArtifactFlushTarget = {
			writePartitionLines: () => false,
			getPartitionCommit: _partition => ({ size: 0, digest: "0".repeat(64), records: 0, complete: false }),
		};
		const builder = new BoundedDictionaryArtifactBuilder({
			partitionBufferBytes: 64,
			journalBytes: 256,
			target: failing,
		});
		expect(builder.add(record("id-1", 0)).kind).toBe("flush_failed");
		expect(builder.finish("sess", "a".repeat(64)).kind).toBe("flush_failed");
	});

	it("fails closed when the duplicate oracle cannot prove uniqueness", () => {
		const full: DictionaryIdDetector = { add: () => "full" };
		const builder = new BoundedDictionaryArtifactBuilder({ target: new InMemoryFlushTarget(), detector: full });
		builder.add(record("id", 0));
		const built = builder.finish("sess", "a".repeat(64));
		expect(built.kind).toBe("ok");
		if (built.kind !== "ok") throw new Error("expected ok build");
		expect(built.stats.sidecarIneligible).toBe(true);
	});

	it("keeps the buffered peak within the fixed partition/journal model", () => {
		const builder = new BoundedDictionaryArtifactBuilder({
			partitionBufferBytes: 128,
			journalBytes: 256,
			target: new InMemoryFlushTarget(),
		});
		for (let index = 0; index < 500; index++) {
			expect(builder.add(record(`entry-${index}`, index)).kind).toBe("ok");
		}
		const built = builder.finish("sess", "a".repeat(64));
		expect(built.kind).toBe("ok");
		if (built.kind !== "ok") throw new Error("expected ok build");
		// The actual buffered content never exceeds the fixed buffer model even
		// though hundreds of lines streamed through the journal.
		expect(built.stats.peakBytes).toBeGreaterThan(0);
		expect(built.stats.peakBytes).toBeLessThanOrEqual(4 * 128 + 256 + 512);
	});
});

describe("metadata-delta binding", () => {
	it("computes exact value descriptors over exact bytes", () => {
		const lineBytes = new TextEncoder().encode('{"type":"mode_change","id":"m"}\n');
		const descriptor = metadataDeltaValueDescriptor({
			key: "mode_change",
			kind: "mode_change",
			ordinal: 3,
			position: 0,
			offset: 12,
			lineBytes,
		});
		expect(descriptor.length).toBe(lineBytes.byteLength);
		expect(descriptor.sha256).toBe(createHash("sha256").update(lineBytes).digest("hex"));
		expect(isValidMetadataDeltaValue(descriptor)).toBe(true);
	});

	it("accepts a self-consistent commit binding", () => {
		const commit: MetadataDeltaArtifactCommit = {
			indexDigest: "0".repeat(64),
			size: 200,
			sha256: "1".repeat(64),
			values: [
				{ key: "a", kind: "mode_change", ordinal: 1, position: 0, offset: 0, length: 100, sha256: "2".repeat(64) },
				{
					key: "b",
					kind: "model_change",
					ordinal: 2,
					position: 1,
					offset: 100,
					length: 100,
					sha256: "3".repeat(64),
				},
			],
		};
		expect(isValidMetadataDeltaCommit(commit)).toBe(true);
	});

	it("rejects duplicate keys/positions, out-of-range values, and over-budget counts", () => {
		const base = {
			indexDigest: "0".repeat(64),
			size: 100,
			sha256: "1".repeat(64),
			values: [
				{ key: "a", kind: "mode_change", ordinal: 1, position: 0, offset: 0, length: 100, sha256: "2".repeat(64) },
			],
		};
		expect(isValidMetadataDeltaCommit(base)).toBe(true);
		expect(
			isValidMetadataDeltaCommit({
				...base,
				values: [base.values[0], { ...base.values[0]!, key: "a" }],
			}),
		).toBe(false);
		expect(
			isValidMetadataDeltaCommit({
				...base,
				values: [base.values[0], { ...base.values[0]!, key: "b", position: 0 }],
			}),
		).toBe(false);
		expect(
			isValidMetadataDeltaCommit({
				...base,
				values: [{ ...base.values[0]!, offset: 50, length: 60 }],
			}),
		).toBe(false);
		expect(
			isValidMetadataDeltaCommit({
				...base,
				values: [{ ...base.values[0]!, sha256: "zz" }],
			}),
		).toBe(false);
		expect(
			isValidMetadataDeltaCommit({
				...base,
				values: Array.from({ length: 257 }, (_, index) => ({
					key: `k${index}`,
					kind: "mode_change",
					ordinal: index,
					position: index,
					offset: 0,
					length: 1,
					sha256: "2".repeat(64),
				})),
			}),
		).toBe(false);
	});
});
