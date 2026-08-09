/**
 * Standalone sidecar primitives for bounded-memory cold-session offloading.
 *
 * This module is intentionally self-contained: it imports only Node built-ins and
 * defines the reusable P2/P3/P4 primitives agreed in the approved memory spec —
 * the retained-byte accountant, reducer disk-ref demotion guardrails, the
 * `isDerivedSessionMemoryFile` lifecycle predicate, the disposable sidecar v2
 * index schemas, the unsorted append-only bounded dictionary builder with
 * duplicate-ID sidecar-ineligibility detection, fixed-size cache accounting,
 * the anchored base digest + rolling tail checksum chain with commit validation
 * and the five-class reopen classifier, the `latestModelChange` / TTSR
 * latest-wins reducer semantics, and bounded parent→children / labels/pins
 * descriptors.
 *
 * Transcript v5 remains authoritative and every sidecar index is disposable /
 * rebuildable. No builder here requires the whole transcript resident in
 * memory; all builders consume records one at a time and enforce their peak
 * budgets as they go.
 */

import { createHash } from "node:crypto";

// ============================================================================
// Budgets and fixed-size bounds
// ============================================================================

/** Provider-context materialization acceptance peak (AC1). */
export const SESSION_MEMORY_ACCEPTANCE_BUDGET_BYTES = 64 * 1024 * 1024;
/** Steady-state retained-byte budget: 61.0625 MiB leaves the 64 MiB margin. */
export const SESSION_MEMORY_STEADY_STATE_BUDGET_BYTES = 61 * 1024 * 1024 + 64 * 1024;

/** Fixed 24 B resident disk-ref descriptor (ADR / A.1). */
export const DESCRIPTOR_BYTES = 24;
/** Conservative per-record object overhead (A.1). */
export const RECORD_OBJECT_OVERHEAD_BYTES = 48;
/** labels+pins steady-state budget (0.0625 MiB). */
export const LABELS_PINS_BUDGET_BYTES = 64 * 1024;

/** Reducer resident budget (4 MiB) — enforced by disk-ref demotion. */
export const REDUCER_BUDGET_BYTES = 4 * 1024 * 1024;
/** Guardrail: values over this are demoted to disk-ref descriptors. */
export const MAX_REDUCER_INLINE_BYTES = 4 * 1024;
/** Guardrail: max resident string length. */
export const MAX_REDUCER_STRING_BYTES = 4 * 1024;
/** Guardrail: max distinct roles. */
export const MAX_ROLES = 64;
/** Guardrail: max chain entries per role. */
export const MAX_CHAIN_ENTRIES = 32;
/** Guardrail: max TTSR rules. */
export const MAX_TTSR_RULES = 256;
/** Guardrail: max MCP names. */
export const MAX_MCP_NAMES = 4096;
/** Guardrail: max chars per MCP name. */
export const MAX_MCP_NAME_CHARS = 256;
/** Guardrail: modeData ≤ 64 KiB. */
export const MODE_DATA_MAX_BYTES = 64 * 1024;
/** Guardrail: compaction summary ≤ 64 KiB. */
export const COMPACTION_SUMMARY_MAX_BYTES = 64 * 1024;
/** preserveData.openaiRemoteCompaction ≤ 8 MiB (always a disk ref). */
export const OPENAI_REMOTE_COMPACTION_MAX_BYTES = 8 * 1024 * 1024;

/** Fixed-size index block cache (steady-state). */
export const BLOCK_CACHE_BUDGET_BYTES = 8 * 1024 * 1024;
/** Fixed-size resolved-entry cache (steady-state). */
export const ENTRY_CACHE_BUDGET_BYTES = 28 * 1024 * 1024;
/** Tail journal buffer/index (steady-state). */
export const TAIL_BUFFER_BUDGET_BYTES = 4 * 1024 * 1024;
/** Bounded forward-scan window for transcript-ahead recovery (R2.4). */
export const INDEX_TAIL_SCAN_MAX_BYTES = 4 * 1024 * 1024;
/** Maximum ordinal-index records retained transiently for one cold branch activation. */
export const COLD_BRANCH_PREFETCH_MAX_INDEX_ENTRIES = 16 * 1024;

/**
 * Decide the cold-branch ordinal-run fast path before allocating its Map or
 * transcript window. Large sparse/interleaved intervals fail closed to bounded
 * dictionary/index fallback; the transcript remains authoritative.
 */
export function coldBranchOrdinalRunWithinPrefetchBounds(input: {
	boundaryOrdinal: number;
	leafOrdinal: number;
	transcriptStart: number;
	transcriptEnd: number;
	maxTranscriptBytes: number;
}): boolean {
	const values = [
		input.boundaryOrdinal,
		input.leafOrdinal,
		input.transcriptStart,
		input.transcriptEnd,
		input.maxTranscriptBytes,
	];
	if (!values.every(value => Number.isSafeInteger(value))) return false;
	const intervalEntries = input.leafOrdinal - input.boundaryOrdinal + 1;
	const transcriptLength = input.transcriptEnd - input.transcriptStart;
	return (
		input.boundaryOrdinal >= 0 &&
		intervalEntries > 0 &&
		intervalEntries <= COLD_BRANCH_PREFETCH_MAX_INDEX_ENTRIES &&
		input.transcriptStart >= 0 &&
		transcriptLength > 0 &&
		transcriptLength <= input.maxTranscriptBytes
	);
}

/** Dictionary build acceptance cap; default buffers stay well below this 20 MiB maximum. */
export const DICTIONARY_BUILD_PEAK_BYTES = 20 * 1024 * 1024;
/** One dictionary partition buffer. */
export const DICTIONARY_PARTITION_BUFFER_BYTES = 128 * 1024;
/** Dictionary bucket journal flush buffer. */
export const DICTIONARY_BUCKET_JOURNAL_BYTES = 128 * 1024;

/** Bounded parent→children index bounds. */
export const PARENT_CHILDREN_MAX_PARENTS = 4096;
export const PARENT_CHILDREN_MAX_CHILDREN_PER_PARENT = 256;
export const PARENT_CHILDREN_BUDGET_BYTES = 4 * 1024 * 1024;
/** Deterministic hash-bucket count for the disposable on-disk parent artifact. */
export const PARENT_CHILDREN_BUCKET_COUNT = 64;

// ============================================================================
// Retained-byte formulas (A.1)
// ============================================================================

/** Resident string = `2 × charCount + 16 B`. */
export function residentStringBytes(value: string): number {
	return 2 * value.length + 16;
}

/** Resident array = `8 B/slot + Σ elements`. */
export function residentArrayBytes(slotCount: number, elementBytes: number): number {
	return 8 * slotCount + elementBytes;
}

/** Per-record object with `childBytes` of payload = 48 B overhead + payload. */
export function residentRecordBytes(childBytes: number): number {
	return RECORD_OBJECT_OVERHEAD_BYTES + childBytes;
}

/**
 * Authoritative measured retained-byte counter. Enforcement acts on the total,
 * never on field counts alone. `tryCharge`/`wouldExceed` let callers enforce a
 * budget without mutating state (used by the provider-context preflight which
 * must never retain an over-budget graph).
 */
export class SessionMemoryAccountant {
	private total = 0;
	private readonly budget: number;

	constructor(budgetBytes: number = SESSION_MEMORY_STEADY_STATE_BUDGET_BYTES) {
		this.budget = budgetBytes;
	}

	get totalBytes(): number {
		return this.total;
	}

	get budgetBytes(): number {
		return this.budget;
	}

	get remainingBytes(): number {
		return Math.max(0, this.budget - this.total);
	}

	/** Adds `bytes` to the running total and returns the new total. */
	charge(bytes: number): number {
		this.assertBytes(bytes);
		this.total += bytes;
		return this.total;
	}

	/** Charges one resident string via the `2 × charCount + 16` formula. */
	chargeString(value: string): number {
		return this.charge(residentStringBytes(value));
	}

	/** Charges one resident array via the `8 B/slot + Σ elements` formula. */
	chargeArray(slotCount: number, elementBytes: number): number {
		return this.charge(residentArrayBytes(slotCount, elementBytes));
	}

	/** Charges one fixed 24 B disk-ref descriptor. */
	chargeDescriptor(): number {
		return this.charge(DESCRIPTOR_BYTES);
	}

	/** Charges one per-record object (48 B overhead + payload). */
	chargeRecord(childBytes: number): number {
		return this.charge(residentRecordBytes(childBytes));
	}

	/**
	 * Adds `bytes` only if the running total stays within the budget.
	 * Returns `false` (and does not mutate) when the addition would exceed it.
	 */
	tryCharge(bytes: number): boolean {
		this.assertBytes(bytes);
		if (this.total + bytes > this.budget) return false;
		this.total += bytes;
		return true;
	}

	/** Returns `true` when charging `bytes` would exceed the budget. */
	wouldExceed(bytes: number): boolean {
		this.assertBytes(bytes);
		return this.total + bytes > this.budget;
	}

	isWithinBudget(): boolean {
		return this.total <= this.budget;
	}

	release(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("invalid_release_bytes");
		if (bytes > this.total) throw new RangeError("release_exceeds_charged");
		this.total -= bytes;
	}

	snapshot(): { totalBytes: number; budgetBytes: number; remainingBytes: number } {
		return { totalBytes: this.total, budgetBytes: this.budget, remainingBytes: this.remainingBytes };
	}

	private assertBytes(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("invalid_charge_bytes");
	}
}

// ============================================================================
// Reducer disk-ref demotion guardrails
// ============================================================================

/**
 * A 24 B resident descriptor that points at a value stored in the sidecar
 * metadata-delta section. Demoted values are never resident as full strings.
 */
export interface ReducerDemotionDescriptor {
	section: "metadata-delta";
	key: string;
	offset: number;
	length: number;
	sha256: string;
}

export interface ReducerValueSnapshot {
	key: string;
	kind: "inline" | "disk_ref";
	residentBytes: number;
	storedBytes: number;
}

export type ReducerBudgetResult =
	| { kind: "ok"; totalBytes: number }
	| { kind: "over_budget_irreducible"; totalBytes: number };

interface TrackedReducerValue {
	key: string;
	kind: "inline" | "disk_ref";
	residentBytes: number;
	storedBytes: number;
	sha256: string;
	metadataBytes: number;
	offset: number;
}

/**
 * Tracks the reducer's resident bytes against the 4 MiB budget. Values over
 * `MAX_REDUCER_INLINE_BYTES` are immediately stored as 24 B disk-ref
 * descriptors. When the total would exceed the budget, the largest resident
 * inline value is demoted, repeating until the total fits or only
 * descriptors/scalars remain (impossible by arithmetic — checked anyway).
 */
export class ReducerBudget {
	private readonly values = new Map<string, TrackedReducerValue>();
	private total = 0;
	private nextOffset = 0;
	private readonly budgetBytesValue: number;
	private readonly maxInlineBytes: number;

	constructor(budgetBytes: number = REDUCER_BUDGET_BYTES, maxInlineBytes: number = MAX_REDUCER_INLINE_BYTES) {
		this.budgetBytesValue = budgetBytes;
		this.maxInlineBytes = maxInlineBytes;
	}

	get totalBytes(): number {
		return this.total;
	}

	get budgetBytes(): number {
		return this.budgetBytesValue;
	}

	get(key: string): ReducerValueSnapshot | undefined {
		const value = this.values.get(key);
		if (value === undefined) return undefined;
		return { key: value.key, kind: value.kind, residentBytes: value.residentBytes, storedBytes: value.storedBytes };
	}

	/** Returns the resident 24 B descriptor for a demoted key, if any. */
	getDescriptor(key: string): ReducerDemotionDescriptor | undefined {
		const value = this.values.get(key);
		if (value === undefined || value.kind !== "disk_ref") return undefined;
		return {
			section: "metadata-delta",
			key: value.key,
			offset: value.offset,
			length: value.storedBytes,
			sha256: value.sha256,
		};
	}

	/**
	 * Records a reducer value of `storedBytes` bytes (optionally with its content
	 * digest) and enforces the budget by demoting the largest resident inline
	 * value until the total fits.
	 */
	setInline(key: string, storedBytes: number, sha256 = ""): ReducerBudgetResult {
		if (!Number.isSafeInteger(storedBytes) || storedBytes < 0) throw new RangeError("invalid_reducer_value_bytes");
		const previous = this.values.get(key);
		if (previous !== undefined) {
			this.total -= previous.residentBytes + previous.metadataBytes;
			this.values.delete(key);
		}
		const metadataBytes = residentStringBytes(key) + residentStringBytes(sha256) + RECORD_OBJECT_OVERHEAD_BYTES;
		if (storedBytes > this.maxInlineBytes) {
			this.values.set(key, {
				key,
				kind: "disk_ref",
				residentBytes: DESCRIPTOR_BYTES,
				metadataBytes,
				storedBytes,
				sha256,
				offset: this.nextOffset++,
			});
			this.total += DESCRIPTOR_BYTES + metadataBytes;
		} else {
			this.values.set(key, {
				key,
				kind: "inline",
				residentBytes: storedBytes,
				metadataBytes,
				storedBytes,
				sha256,
				offset: this.nextOffset++,
			});
			this.total += storedBytes + metadataBytes;
		}
		return this.enforceBudget();
	}

	/** Demotes every currently resident inline value to a disk-ref descriptor. */
	demoteAll(): void {
		for (const value of this.values.values()) {
			if (value.kind === "inline" && value.residentBytes > DESCRIPTOR_BYTES) this.demote(value);
		}
	}

	private enforceBudget(): ReducerBudgetResult {
		while (this.total > this.budgetBytesValue) {
			const largest = this.largestDemotableInline();
			if (largest === undefined) {
				// Only descriptors/scalars remain but still over budget — impossible
				// by arithmetic; the caller keeps the record hot and raises the
				// token-compaction trigger. Never unbounded resident state.
				return { kind: "over_budget_irreducible", totalBytes: this.total };
			}
			this.demote(largest);
		}
		return { kind: "ok", totalBytes: this.total };
	}

	private largestDemotableInline(): TrackedReducerValue | undefined {
		let best: TrackedReducerValue | undefined;
		for (const value of this.values.values()) {
			if (
				value.kind === "inline" &&
				value.residentBytes > DESCRIPTOR_BYTES &&
				(best === undefined || value.residentBytes > best.residentBytes)
			) {
				best = value;
			}
		}
		return best;
	}

	private demote(value: TrackedReducerValue): void {
		const delta = value.residentBytes - DESCRIPTOR_BYTES;
		value.residentBytes = DESCRIPTOR_BYTES;
		value.kind = "disk_ref";
		this.total -= delta;
	}
}

// ============================================================================
// Derived-file lifecycle predicate (MEM-C-014/024)
// ============================================================================

const SPILL_SEGMENT = ".spill.";
const DERIVED_SUFFIXES = new Set(["idx", "tail", "commit", "buckets"]);
const DERIVED_PREFIXES = ["dict-", "capture-", "fork-", "overlay-", "parent-", "metadata-"];

/**
 * Single source of truth for every sidecar artifact and temp: `*.spill.idx`,
 * `*.spill.tail`, `*.spill.commit`, `*.spill.buckets`, `*.spill.dict-*`,
 * `*.spill.capture-*`, `*.spill.fork-*`, `*.spill.overlay-*`,
 * `*.spill.parent-*` (persistent parent→children buckets),
 * `*.spill.metadata-*` (persistent metadata-delta section), and any
 * `*.spill.*.tmp`. Used at every fork/delete/sweep/Memory-parity callsite so
 * ad-hoc filters cannot drift.
 */
export function isDerivedSessionMemoryFile(pathname: string): boolean {
	const base = pathname.slice(Math.max(pathname.lastIndexOf("/"), pathname.lastIndexOf("\\")) + 1);
	const idx = base.indexOf(SPILL_SEGMENT);
	if (idx === -1) return false;
	const rest = base.slice(idx + SPILL_SEGMENT.length);
	if (rest.length === 0) return false;
	if (DERIVED_SUFFIXES.has(rest)) return true;
	for (const prefix of DERIVED_PREFIXES) {
		if (rest.startsWith(prefix) && rest.length > prefix.length) return true;
	}
	if (rest.endsWith(".tmp") && rest.length > ".tmp".length) return true;
	return false;
}

// ============================================================================
// Sidecar v2 disposable index schemas
// ============================================================================

/** Common header for every sidecar v2 index file. */
export interface SidecarIndexHeaderV2 {
	version: 2;
	sessionId: string;
	/** Set when duplicate record IDs were detected; session is eager-ineligible. */
	sidecarIneligible: boolean;
}

/** Unsorted append-only variable-width dictionary (term → id). */
export interface SidecarDictionaryV2 {
	header: SidecarIndexHeaderV2;
	/** Insertion-ordered unique terms (append-only; deterministic). */
	terms: readonly string[];
	/** term → dictionary id, assigned by first-insertion order. */
	idByTerm: ReadonlyMap<string, number>;
	/** Combined serialized term bytes. */
	totalBytes: number;
}

/** Rolling tail checksum index (anchored base + terminal chain). */
export interface SidecarTailIndexV2 {
	header: SidecarIndexHeaderV2;
	base: BaseAnchor;
	records: readonly TailRecord[];
	terminalChecksum: string;
	terminalSeq: number;
	transcriptSize: number;
}

/** Metadata-delta section: demoted reducer values + deltas. */
export interface SidecarMetadataIndexV2 {
	header: SidecarIndexHeaderV2;
	/** key → { offset, length, sha256 } for demoted values. */
	entries: Record<string, { offset: number; length: number; sha256: string }>;
}

/** Bounded parent→children index. */
export interface SidecarParentIndexV2 {
	header: SidecarIndexHeaderV2;
	entries: readonly ParentChildrenIndexEntry[];
}

/** Bounded labels/pins descriptor. */
export interface SidecarLabelsPinsIndexV2 {
	header: SidecarIndexHeaderV2;
	labels: ReadonlyMap<string, string>;
	pins: ReadonlyMap<string, string>;
	totalBytes: number;
}

// ============================================================================
// Bounded dictionary builder (20 MiB peak, duplicate-ID detection)
// ============================================================================

export interface DictionaryRecordInput {
	ordinal: number;
	id: string;
	bytes: Uint8Array;
}

export interface DictionaryBuildOptions {
	peakBudgetBytes?: number;
	partitionBufferBytes?: number;
	bucketJournalBytes?: number;
}

export type DictionaryAddResult = { kind: "ok" } | { kind: "budget_exceeded"; peakBytes: number; budgetBytes: number };

export type DictionaryBuildResult =
	| { kind: "ok"; dictionary: SidecarDictionaryV2; stats: DictionaryBuildStats }
	| { kind: "budget_exceeded"; peakBytes: number; budgetBytes: number };

export interface DictionaryBuildStats {
	totalRecords: number;
	uniqueTerms: number;
	totalBytes: number;
	peakBytes: number;
	duplicateIds: readonly string[];
	sidecarIneligible: boolean;
}

const utf8Decoder = new TextDecoder("utf-8");

/**
 * Unsorted append-only variable-width dictionary builder. Consumes records one
 * at a time (no whole transcript resident) and tracks the 20 MiB build peak as
 * `Σ term bytes + 4 × partition buffer + bucket journal`. Duplicate record IDs
 * mark the session sidecar-ineligible (eager fallback) while the build still
 * completes deterministically.
 */
export class BoundedDictionaryBuilder {
	private readonly terms: string[] = [];
	private readonly idByTerm = new Map<string, number>();
	private readonly seenRecordIds = new Map<string, number>();
	private readonly duplicateIds: string[] = [];
	private totalTermBytes = 0;
	private recordIdBytes = 0;
	private duplicateIdBytes = 0;
	private peakBytes = 0;
	private sidecarIneligible = false;
	private recordCount = 0;
	private finished = false;
	private readonly peakBudget: number;
	private readonly partitionBase: number;

	constructor(options: DictionaryBuildOptions = {}) {
		this.peakBudget = options.peakBudgetBytes ?? DICTIONARY_BUILD_PEAK_BYTES;
		const partition = options.partitionBufferBytes ?? DICTIONARY_PARTITION_BUFFER_BYTES;
		const journal = options.bucketJournalBytes ?? DICTIONARY_BUCKET_JOURNAL_BYTES;
		this.partitionBase = 4 * partition + journal;
	}

	add(record: DictionaryRecordInput): DictionaryAddResult {
		if (this.finished) throw new Error("dictionary_builder_finished");
		this.recordCount += 1;
		const priorOrdinal = this.seenRecordIds.get(record.id);
		if (priorOrdinal !== undefined) {
			this.sidecarIneligible = true;
			if (!this.duplicateIds.includes(record.id)) {
				this.duplicateIdBytes += residentStringBytes(record.id) + RECORD_OBJECT_OVERHEAD_BYTES;
				this.duplicateIds.push(record.id);
			}
		} else {
			this.recordIdBytes += residentStringBytes(record.id) + RECORD_OBJECT_OVERHEAD_BYTES;
			this.seenRecordIds.set(record.id, record.ordinal);
		}
		this.updatePeak();
		if (this.peakBytes > this.peakBudget) {
			return { kind: "budget_exceeded", peakBytes: this.peakBytes, budgetBytes: this.peakBudget };
		}
		const term = utf8Decoder.decode(record.bytes);
		if (!this.idByTerm.has(term)) {
			this.idByTerm.set(term, this.idByTerm.size);
			this.terms.push(term);
			this.totalTermBytes += residentStringBytes(term) + RECORD_OBJECT_OVERHEAD_BYTES;
			this.updatePeak();
		}
		if (this.peakBytes > this.peakBudget) {
			return { kind: "budget_exceeded", peakBytes: this.peakBytes, budgetBytes: this.peakBudget };
		}
		return { kind: "ok" };
	}

	finish(): DictionaryBuildResult {
		if (this.finished) throw new Error("dictionary_builder_already_finished");
		this.finished = true;
		return {
			kind: "ok",
			dictionary: {
				header: { version: 2, sessionId: "", sidecarIneligible: this.sidecarIneligible },
				terms: this.terms,
				idByTerm: this.idByTerm,
				totalBytes: this.totalTermBytes,
			},
			stats: {
				totalRecords: this.recordCount,
				uniqueTerms: this.terms.length,
				totalBytes: this.totalTermBytes,
				peakBytes: this.peakBytes,
				duplicateIds: this.duplicateIds,
				sidecarIneligible: this.sidecarIneligible,
			},
		};
	}

	private updatePeak(): void {
		const current = Math.max(this.partitionBase, this.totalTermBytes + this.recordIdBytes + this.duplicateIdBytes);
		if (current > this.peakBytes) this.peakBytes = current;
	}
}

// ============================================================================
// Fixed-size cache accounting (block / entry / tail)
// ============================================================================

/**
 * Tracks a fixed-size cache budget (8 MiB block, 28 MiB entry, 4 MiB tail).
 * `tryAllocate` rejects allocations that would exceed the budget without
 * mutating state.
 */
export class FixedCacheAccount {
	private allocated = 0;
	private readonly budget: number;

	constructor(budgetBytes: number) {
		this.budget = budgetBytes;
	}

	get allocatedBytes(): number {
		return this.allocated;
	}

	get budgetBytes(): number {
		return this.budget;
	}

	get remainingBytes(): number {
		return Math.max(0, this.budget - this.allocated);
	}

	tryAllocate(bytes: number): boolean {
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("invalid_cache_allocation");
		if (this.allocated + bytes > this.budget) return false;
		this.allocated += bytes;
		return true;
	}

	release(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("invalid_cache_release");
		if (bytes > this.allocated) throw new RangeError("cache_release_exceeds_allocated");
		this.allocated -= bytes;
	}
}

// ============================================================================
// Anchored base digest + rolling tail checksum chain (C.1)
// ============================================================================

/** Anchors the base range `[0, baseEndOffset)` with a content digest. */
export interface BaseAnchor {
	baseDigest: string;
	baseEndOffset: number;
}

export type TailRecordKind = "user" | "assistant" | "tool" | "model_change" | "ttsr_injection" | "internal" | "other";

/** One committed rolling tail record. */
export interface TailRecord {
	gen: number;
	seq: number;
	kind: TailRecordKind;
	ordinal: number;
	id: string;
	parentId: string | null;
	type: string;
	byteOffset: number;
	byteLength: number;
	recordDigest: string;
	checksum: string;
}

/** Input for appending to a rolling tail chain (checksum is computed). */
export interface TailRecordInput {
	gen?: number;
	seq: number;
	kind: TailRecordKind;
	ordinal: number;
	id: string;
	parentId: string | null;
	type: string;
	byteOffset: number;
	byteLength: number;
	recordDigest: string;
}

/** Effective base+tail identity (no per-append whole-file hash). */
export interface CommittedTail {
	base: BaseAnchor;
	records: readonly TailRecord[];
	terminalChecksum: string;
	terminalSeq: number;
	transcriptSize: number;
}

/** SHA-256 of one record line's bytes. */
export function computeLineDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Canonical length-prefixed chain hash. Each part is hashed as its UTF-8 /
 * raw bytes prefixed by a 4-byte big-endian length, so concatenations are
 * unambiguous.
 */
export function hashChain(parts: ReadonlyArray<bigint | number | string | Uint8Array>): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		const bytes =
			typeof part === "string"
				? Buffer.from(part, "utf8")
				: typeof part === "number"
					? Buffer.from(String(part), "utf8")
					: typeof part === "bigint"
						? Buffer.from(part.toString(), "utf8")
						: Buffer.from(part);
		const length = Buffer.allocUnsafe(4);
		length.writeUInt32BE(bytes.byteLength, 0);
		hash.update(length).update(bytes);
	}
	return hash.digest("hex");
}

/** First tail checksum: `C0 = H(baseDigest ‖ baseEndOffset ‖ seq0 ‖ lineDigest0)`. */
export function computeC0(base: BaseAnchor, seq0: number, lineDigest0: string): string {
	return hashChain([base.baseDigest, base.baseEndOffset, seq0, lineDigest0]);
}

/** Checksum one complete tail record, including every field used for ordering or lookup. */
export function computeTailRecordChecksum(
	base: BaseAnchor,
	previousChecksum: string | undefined,
	record: TailRecordInput & { gen?: number },
): string {
	const fields: Array<string | number> = [
		record.gen ?? 0,
		record.seq,
		record.kind,
		record.ordinal,
		record.id,
		record.parentId === null ? "<null>" : record.parentId,
		record.type,
		record.byteOffset,
		record.byteLength,
		record.recordDigest,
	];
	return previousChecksum === undefined
		? hashChain([base.baseDigest, base.baseEndOffset, ...fields])
		: hashChain([previousChecksum, ...fields]);
}

/** Resident bytes for every retained tail string plus the record object. */
export function tailRecordResidentBytes(record: TailRecordInput, checksumChars = 64): number {
	return residentRecordBytes(
		residentStringBytes(record.id) +
			(record.parentId === null ? 0 : residentStringBytes(record.parentId)) +
			residentStringBytes(record.type) +
			residentStringBytes(record.kind) +
			residentStringBytes(record.recordDigest) +
			(2 * checksumChars + 16),
	);
}

/** Terminal checksum for a committed tail (empty chain → base only). */
export function computeTerminalChecksum(base: BaseAnchor, records: readonly TailRecord[]): string {
	if (records.length === 0) return hashChain([base.baseDigest, base.baseEndOffset]);
	return records[records.length - 1].checksum;
}

export interface TailValidationResult {
	valid: boolean;
	firstInvalidSeq?: number;
	reason?: string;
}

/**
 * Validates a committed tail chain: contiguous seq from 0, contiguous absolute
 * offsets from `baseEndOffset`, and checksum continuity
 * `checksum_i = H(checksum_{i-1} ‖ seq_i ‖ offset_i ‖ length_i ‖ lineDigest_i)`.
 */
export function validateTailChain(base: BaseAnchor, records: readonly TailRecord[]): TailValidationResult {
	let expectedSeq = 0;
	let expectedOffset = base.baseEndOffset;
	let previousChecksum: string | undefined;
	for (const record of records) {
		if (record.seq !== expectedSeq) {
			return { valid: false, firstInvalidSeq: record.seq, reason: "seq_discontinuity" };
		}
		if (record.byteOffset !== expectedOffset) {
			return { valid: false, firstInvalidSeq: record.seq, reason: "offset_discontinuity" };
		}
		const expectedChecksum = computeTailRecordChecksum(base, previousChecksum, record);
		if (record.checksum !== expectedChecksum) {
			return { valid: false, firstInvalidSeq: record.seq, reason: "checksum_mismatch" };
		}
		previousChecksum = expectedChecksum;
		expectedSeq += 1;
		expectedOffset = record.byteOffset + record.byteLength;
	}
	return { valid: true };
}

/**
 * Streams tail records, computing the rolling checksum chain incrementally and
 * enforcing the 4 MiB tail buffer budget. Never buffers the whole transcript.
 */
export class RollingTailChainBuilder {
	private readonly records: TailRecord[] = [];
	private readonly base: BaseAnchor;
	private lastChecksum: string | undefined;
	private lastSeq = -1;
	private lastEndOffset: number;
	private remainingTailBytes: number;

	constructor(base: BaseAnchor, options: { tailBufferBytes?: number } = {}) {
		this.base = base;
		this.lastEndOffset = base.baseEndOffset;
		this.remainingTailBytes = options.tailBufferBytes ?? TAIL_BUFFER_BUDGET_BYTES;
	}

	get recordCount(): number {
		return this.records.length;
	}

	/** Appends one tail record; returns `undefined` when the buffer budget is hit. */
	append(input: TailRecordInput): TailRecord | undefined {
		const expectedSeq = this.lastSeq + 1;
		if (input.seq !== expectedSeq) throw new Error("tail_seq_discontinuity");
		if (input.byteOffset !== this.lastEndOffset) throw new Error("tail_offset_discontinuity");
		const checksum = computeTailRecordChecksum(this.base, this.lastChecksum, input);
		const residentBytes = tailRecordResidentBytes(input, checksum.length);
		if (residentBytes > this.remainingTailBytes) return undefined;
		this.remainingTailBytes -= residentBytes;
		const record: TailRecord = { ...input, gen: input.gen ?? 0, checksum };
		this.records.push(record);
		this.lastSeq = input.seq;
		this.lastEndOffset = input.byteOffset + input.byteLength;
		this.lastChecksum = checksum;
		return record;
	}

	build(): CommittedTail {
		return {
			base: this.base,
			records: this.records,
			terminalChecksum: computeTerminalChecksum(this.base, this.records),
			terminalSeq: this.lastSeq,
			transcriptSize: this.lastEndOffset,
		};
	}
}

// ============================================================================
// Commit validation + five-class reopen classifier (R2.4)
// ============================================================================

/** Descriptor snapshot captured post-fsync from the authoritative open handle. */
export interface DescriptorSnapshot {
	dev: bigint;
	ino: bigint;
	nlink?: bigint;
	size: number;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

/** Exact enum-order descriptor comparison (dev/ino/nlink/size/mtimeNs/ctimeNs). */
export function sameDescriptor(left: DescriptorSnapshot, right: DescriptorSnapshot): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		(left.nlink ?? 0n) === (right.nlink ?? 0n) &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

/** Contents of the mutable `.spill.commit` marker (R2). */
export interface CommitMarkerContents {
	gen: number;
	descriptor: DescriptorSnapshot;
	base: BaseAnchor;
	terminalChecksum: string;
	terminalSeq: number;
	transcriptSize: number;
}

export type CommitInvalidReason =
	| "missing_fields"
	| "base_invalid"
	| "chain_invalid"
	| "terminal_checksum_mismatch"
	| "terminal_seq_mismatch"
	| "transcript_size_mismatch"
	| "descriptor_mismatch"
	| "terminal_marker_mismatch";

export type CommitValidationResult = { kind: "valid" } | { kind: "invalid"; reason: CommitInvalidReason };

/**
 * Validates a commit marker's internal consistency plus its descriptor against
 * the currently opened transcript. `baseValid`/`tailValid`/`terminalMarkerValid`
 * are the externally-observed proof results.
 */
export function validateCommit(
	commit: Partial<CommitMarkerContents> | CommitMarkerContents,
	records: readonly TailRecord[],
	observed: { descriptor: DescriptorSnapshot; baseValid: boolean; tailValid: boolean; terminalMarkerValid: boolean },
): CommitValidationResult {
	if (commit === null || typeof commit !== "object") return { kind: "invalid", reason: "missing_fields" };
	if (
		typeof commit.gen !== "number" ||
		commit.descriptor === undefined ||
		commit.base === undefined ||
		typeof commit.terminalChecksum !== "string" ||
		typeof commit.terminalSeq !== "number" ||
		typeof commit.transcriptSize !== "number"
	) {
		return { kind: "invalid", reason: "missing_fields" };
	}
	if (!observed.baseValid) return { kind: "invalid", reason: "base_invalid" };
	const chain = validateTailChain(commit.base, records);
	if (!chain.valid) return { kind: "invalid", reason: "chain_invalid" };
	const computedTerminal = computeTerminalChecksum(commit.base, records);
	if (commit.terminalChecksum !== computedTerminal) return { kind: "invalid", reason: "terminal_checksum_mismatch" };
	const expectedTerminalSeq = records.length === 0 ? -1 : records[records.length - 1].seq;
	if (commit.terminalSeq !== expectedTerminalSeq) return { kind: "invalid", reason: "terminal_seq_mismatch" };
	const expectedSize =
		records.length === 0
			? commit.base.baseEndOffset
			: records[records.length - 1].byteOffset + records[records.length - 1].byteLength;
	if (commit.transcriptSize !== expectedSize) return { kind: "invalid", reason: "transcript_size_mismatch" };
	if (!sameDescriptor(commit.descriptor, observed.descriptor))
		return { kind: "invalid", reason: "descriptor_mismatch" };
	if (!observed.terminalMarkerValid) return { kind: "invalid", reason: "terminal_marker_mismatch" };
	return { kind: "valid" };
}

export type ReopenClassKind = "exact" | "transcript_ahead" | "tail_ahead" | "rebuild" | "stale_commit";

/** Physical evidence the reopen classifier consumes. */
export interface ReopenEvidence {
	markerPresent: boolean;
	descriptorExact: boolean;
	sameObject: boolean;
	sameSize: boolean;
	sizeGrew: boolean;
	sizeShrank: boolean;
	withinScanWindow: boolean;
	timesAdvanced: boolean;
	timesChanged: boolean;
	baseValid: boolean;
	tailValid: boolean;
	terminalMarkerValid: boolean;
}

export interface ReopenClassification {
	kind: ReopenClassKind;
	reason: string;
}

/**
 * Five-class reopen classification (R2.4). Deterministic over the supplied
 * evidence; a stale commit is never accepted as current on any path.
 */
export function classifyReopen(evidence: ReopenEvidence): ReopenClassification {
	if (!evidence.markerPresent) return { kind: "stale_commit", reason: "no_commit_marker" };
	if (evidence.descriptorExact) {
		if (evidence.baseValid && evidence.tailValid && evidence.terminalMarkerValid) {
			return { kind: "exact", reason: "descriptor_and_proof_match" };
		}
		return { kind: "rebuild", reason: "descriptor_exact_proof_invalid" };
	}
	if (evidence.sameObject && evidence.sameSize && evidence.timesChanged) {
		return { kind: "rebuild", reason: "same_size_mutation" };
	}
	if (evidence.sameObject && evidence.sameSize) {
		if (evidence.baseValid && !evidence.tailValid)
			return { kind: "tail_ahead", reason: "committed_tail_record_invalid" };
		if (evidence.baseValid && evidence.tailValid && evidence.terminalMarkerValid) {
			return { kind: "exact", reason: "descriptor_equivalent" };
		}
		return { kind: "rebuild", reason: "proof_invalid" };
	}
	if (evidence.sameObject && evidence.sizeGrew) {
		if (evidence.withinScanWindow && evidence.timesAdvanced && evidence.baseValid && evidence.tailValid) {
			return { kind: "transcript_ahead", reason: "object_grew_within_window" };
		}
		return { kind: "rebuild", reason: "over_window_or_invalid_base" };
	}
	if (evidence.sameObject && evidence.sizeShrank) {
		return { kind: "rebuild", reason: "shrink_outside_tail_state" };
	}
	return { kind: "stale_commit", reason: "object_identity_mismatch" };
}

// ============================================================================
// Reducer deltas: nearest model-change role (R1) + TTSR latest-wins
// ============================================================================

export interface LatestModelChangeDelta {
	kind: "latest_model_change";
	ordinal: number;
	role?: string;
}

export interface TtsrDelta {
	kind: "ttsr_injection";
	ordinal: number;
	rulesCount: number;
	recordsCount: number;
	count: number;
}

export type ReducerDelta = LatestModelChangeDelta | TtsrDelta;

export interface ModelChangeReducerState {
	latest: { ordinal: number; role: string | undefined } | undefined;
}

export interface TtsrReducerState {
	count: number;
	rulesCount: number;
	recordsCount: number;
	largestOrdinal: number;
}

export interface ReducerState {
	modelChange: ModelChangeReducerState;
	ttsr: TtsrReducerState;
}

export function createReducerState(): ReducerState {
	return {
		modelChange: { latest: undefined },
		ttsr: { count: 0, rulesCount: 0, recordsCount: 0, largestOrdinal: -1 },
	};
}

/**
 * Applies one reducer delta. `latest_model_change` overwrites the nearest
 * event's `{ordinal, role}`; `ttsr_injection.count` replaces the prior value
 * (authoritative `buildSessionContext`, latest-wins).
 */
export function applyReducerDelta(state: ReducerState, delta: ReducerDelta): ReducerState {
	switch (delta.kind) {
		case "latest_model_change":
			return { ...state, modelChange: { latest: { ordinal: delta.ordinal, role: delta.role } } };
		case "ttsr_injection":
			return {
				...state,
				ttsr: {
					count: delta.count,
					rulesCount: delta.rulesCount,
					recordsCount: delta.recordsCount,
					largestOrdinal: Math.max(state.ttsr.largestOrdinal, delta.ordinal),
				},
			};
	}
}

/**
 * R1 consumer: returns `latestModelChange.role ?? "default"` when a
 * `model_change` exists on the path, else `undefined`. `hasExplicitDefaultModel`
 * only gates legacy assistant inference into `models.default`; it never feeds
 * this getter.
 */
export function getLastModelChangeRole(state: ReducerState): string | undefined {
	const latest = state.modelChange.latest;
	if (latest === undefined) return undefined;
	return latest.role ?? "default";
}

/**
 * Compaction fold: keeps the max-ordinal `model_change` (nearest wins) and the
 * latest-ordinal TTSR state, matching the eager leaf→root first-hit semantics.
 */
export function foldReducerStates(left: ReducerState, right: ReducerState): ReducerState {
	const modelChange = foldModelChange(left.modelChange.latest, right.modelChange.latest);
	const ttsr = left.ttsr.largestOrdinal >= right.ttsr.largestOrdinal ? left.ttsr : right.ttsr;
	return { modelChange: { latest: modelChange }, ttsr };
}

function foldModelChange(
	left: ModelChangeReducerState["latest"],
	right: ModelChangeReducerState["latest"],
): ModelChangeReducerState["latest"] {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return left.ordinal >= right.ordinal ? left : right;
}

// ============================================================================
// Bounded parent→children and labels/pins descriptors
// ============================================================================

export interface ParentChildrenIndexEntry {
	parentId: string;
	children: readonly string[];
}

/** Bounded parent→children index (rejects when either bound is exceeded). */
export class BoundedParentChildrenIndex {
	private readonly childrenByParent = new Map<string, string[]>();
	private readonly maxParents: number;
	private readonly maxChildrenPerParent: number;
	private readonly budgetBytesValue: number;
	private total = 0;

	constructor(options: { maxParents?: number; maxChildrenPerParent?: number; budgetBytes?: number } = {}) {
		this.maxParents = options.maxParents ?? PARENT_CHILDREN_MAX_PARENTS;
		this.maxChildrenPerParent = options.maxChildrenPerParent ?? PARENT_CHILDREN_MAX_CHILDREN_PER_PARENT;
		this.budgetBytesValue = options.budgetBytes ?? PARENT_CHILDREN_BUDGET_BYTES;
	}

	get size(): number {
		return this.childrenByParent.size;
	}

	get totalBytes(): number {
		return this.total;
	}

	get budgetBytes(): number {
		return this.budgetBytesValue;
	}

	add(parentId: string, childId: string): boolean {
		if (parentId.length === 0 || childId.length === 0) throw new Error("parent_children_empty_id");
		let children = this.childrenByParent.get(parentId);
		if (children?.includes(childId)) return true;
		const parentBytes = children === undefined ? residentStringBytes(parentId) + RECORD_OBJECT_OVERHEAD_BYTES : 0;
		const childBytes = residentStringBytes(childId) + 8;
		if (this.total + parentBytes + childBytes > this.budgetBytesValue) return false;
		if (children === undefined) {
			if (this.childrenByParent.size >= this.maxParents) return false;
			children = [];
			this.childrenByParent.set(parentId, children);
		}
		if (children.length >= this.maxChildrenPerParent) return false;
		children.push(childId);
		this.total += parentBytes + childBytes;
		return true;
	}

	get(parentId: string): readonly string[] | undefined {
		const children = this.childrenByParent.get(parentId);
		return children ? [...children] : undefined;
	}

	entries(): ParentChildrenIndexEntry[] {
		const out: ParentChildrenIndexEntry[] = [];
		for (const [parentId, children] of this.childrenByParent) out.push({ parentId, children: [...children] });
		return out;
	}
}

/**
 * Bounded labels/pins store. Accounting uses `stored bytes + map overhead`
 * (resident string formulas + per-entry overhead), rejected when the labels+pins
 * budget would be exceeded.
 */
export class BoundedLabelsPinsStore {
	private readonly labels = new Map<string, string>();
	private readonly pins = new Map<string, string>();
	private total = 0;
	private readonly budget: number;

	constructor(budgetBytes: number = LABELS_PINS_BUDGET_BYTES) {
		this.budget = budgetBytes;
	}

	get totalBytes(): number {
		return this.total;
	}

	get budgetBytes(): number {
		return this.budget;
	}

	setLabel(key: string, value: string): boolean {
		return this.setIn(this.labels, key, value);
	}

	deleteLabel(key: string): void {
		const existing = this.labels.get(key);
		if (existing === undefined) return;
		this.total -= residentStringBytes(key) + residentStringBytes(existing) + RECORD_OBJECT_OVERHEAD_BYTES;
		this.labels.delete(key);
	}

	setPin(key: string, value: string): boolean {
		return this.setIn(this.pins, key, value);
	}

	getLabel(key: string): string | undefined {
		return this.labels.get(key);
	}

	getPin(key: string): string | undefined {
		return this.pins.get(key);
	}

	labelsEntries(): ReadonlyMap<string, string> {
		return this.labels;
	}

	pinsEntries(): ReadonlyMap<string, string> {
		return this.pins;
	}

	clear(): void {
		this.labels.clear();
		this.pins.clear();
		this.total = 0;
	}

	private setIn(map: Map<string, string>, key: string, value: string): boolean {
		const cost = residentStringBytes(key) + residentStringBytes(value) + RECORD_OBJECT_OVERHEAD_BYTES;
		const existing = map.get(key);
		if (existing !== undefined) {
			const existingCost = residentStringBytes(key) + residentStringBytes(existing) + RECORD_OBJECT_OVERHEAD_BYTES;
			const delta = cost - existingCost;
			if (this.total + delta > this.budget) return false;
			this.total += delta;
			map.set(key, value);
			return true;
		}
		if (this.total + cost > this.budget) return false;
		this.total += cost;
		map.set(key, value);
		return true;
	}
}

// ============================================================================
// Persistent bounded parent→children artifact (disposable v2 parent index)
// ============================================================================

/**
 * One parent→child edge plus the child's authoritative cold index fields. The
 * artifact is disposable derived proof; the `.spill.idx` remains authoritative
 * for entry offsets and the transcript remains authoritative for entry bytes.
 */
export interface ParentBucketRecordInput {
	parentId: string;
	childId: string;
	ordinal: number;
	seq: number;
	byteOffset: number;
	byteLength: number;
	recordDigest: string;
	entryType?: string;
}

/** Committed on-disk state of one parent bucket (exact bytes). */
export interface ParentBucketCommit {
	size: number;
	digest: string;
	complete: boolean;
}

/**
 * Commit-marker binding for the disposable parent artifact. The artifact
 * covers exactly the entry set of the `.spill.idx` whose digest is bound here;
 * a binding mismatch fails closed to the authoritative cold scan.
 */
export interface ParentArtifactCommit {
	bucketCount: number;
	indexDigest: string;
	buckets: ParentBucketCommit[];
}

/**
 * Deterministic hash-partition assignment for a parent id. Bucket files are
 * append-only journals; a lookup reads exactly one bucket (bounded range read)
 * and verifies each record's `parentId` to filter hash collisions.
 */
export function parentBucketForId(parentId: string, bucketCount = PARENT_CHILDREN_BUCKET_COUNT): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < parentId.length; index++) {
		const code = parentId.charCodeAt(index);
		hash ^= code & 0xff;
		hash = Math.imul(hash, 0x01000193);
		hash ^= code >>> 8;
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % bucketCount;
}

/** Serialize one parent→child edge as a compact JSON journal line (trailing newline). */
export function serializeParentBucketRecord(input: ParentBucketRecordInput): string {
	return `${JSON.stringify({
		p: input.parentId,
		c: input.childId,
		o: input.ordinal,
		s: input.seq,
		b: input.byteOffset,
		l: input.byteLength,
		d: input.recordDigest,
		...(input.entryType !== undefined ? { t: input.entryType } : {}),
	})}\n`;
}

/** Strictly parse one parent bucket journal line; `undefined` marks the bucket corrupt. */
export function parseParentBucketRecord(line: string): ParentBucketRecordInput | undefined {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { p, c, o, s, b, l, d, t } = value;
	if (typeof p !== "string" || p.length === 0) return undefined;
	if (typeof c !== "string" || c.length === 0) return undefined;
	if (typeof o !== "number" || typeof s !== "number" || typeof b !== "number" || typeof l !== "number")
		return undefined;
	if (!Number.isSafeInteger(o) || !Number.isSafeInteger(s) || !Number.isSafeInteger(b) || !Number.isSafeInteger(l))
		return undefined;
	if (typeof d !== "string" || d.length !== 64) return undefined;
	if (t !== undefined && typeof t !== "string") return undefined;
	return {
		parentId: p,
		childId: c,
		ordinal: o,
		seq: s,
		byteOffset: b,
		byteLength: l,
		recordDigest: d,
		...(t !== undefined ? { entryType: t } : {}),
	};
}

export interface ParentArtifactBuildResult {
	metadata: ParentArtifactCommit;
	/** Per-bucket records in physical (transcript) order. */
	buckets: string[][];
	/** Parents excluded because a bound (children/budget/parents) was exceeded. */
	excludedParents: readonly string[];
}

/**
 * Bounded builder for the persistent parent artifact. Parents are indexed
 * fully or not at all: a parent whose children would exceed
 * `PARENT_CHILDREN_MAX_CHILDREN_PER_PARENT`, whose first record would exceed
 * `PARENT_CHILDREN_BUDGET_BYTES`, or that would exceed
 * `PARENT_CHILDREN_MAX_PARENTS` is excluded (lookups for it fail closed), and
 * its buffered records are dropped so a truncated "complete" result can never
 * be published. Per-parent child order is preserved (insertion order).
 */
export class BoundedParentArtifactBuilder {
	private readonly parents = new Map<string, { records: string[]; bytes: number }>();
	private readonly excluded = new Set<string>();
	private readonly incompleteBuckets = new Set<number>();
	private totalBytesValue = 0;
	private readonly maxParents: number;
	private readonly maxChildrenPerParent: number;
	private readonly budgetBytesValue: number;
	private readonly bucketCount: number;
	private finished = false;
	private capacityExhausted = false;

	constructor(
		options: {
			maxParents?: number;
			maxChildrenPerParent?: number;
			budgetBytes?: number;
			bucketCount?: number;
		} = {},
	) {
		this.maxParents = options.maxParents ?? PARENT_CHILDREN_MAX_PARENTS;
		this.maxChildrenPerParent = options.maxChildrenPerParent ?? PARENT_CHILDREN_MAX_CHILDREN_PER_PARENT;
		this.budgetBytesValue = options.budgetBytes ?? PARENT_CHILDREN_BUDGET_BYTES;
		this.bucketCount = options.bucketCount ?? PARENT_CHILDREN_BUCKET_COUNT;
	}

	get distinctParents(): number {
		return this.parents.size;
	}

	get totalBytes(): number {
		return this.totalBytesValue;
	}

	add(record: ParentBucketRecordInput): void {
		if (this.finished) throw new Error("parent_artifact_builder_finished");
		if (record.parentId.length === 0 || record.childId.length === 0) throw new Error("parent_artifact_empty_id");
		if (this.excluded.has(record.parentId)) return;
		if (this.capacityExhausted && !this.parents.has(record.parentId)) {
			this.incompleteBuckets.add(parentBucketForId(record.parentId, this.bucketCount));
			return;
		}
		const line = serializeParentBucketRecord(record);
		const bytes = Buffer.byteLength(line, "utf8");
		let parent = this.parents.get(record.parentId);
		if (parent === undefined) {
			if (this.parents.size >= this.maxParents || this.totalBytesValue + bytes > this.budgetBytesValue) {
				this.capacityExhausted = true;
				this.incompleteBuckets.add(parentBucketForId(record.parentId, this.bucketCount));
				return;
			}
			parent = { records: [], bytes: 0 };
			this.parents.set(record.parentId, parent);
		}
		if (parent.records.length >= this.maxChildrenPerParent || this.totalBytesValue + bytes > this.budgetBytesValue) {
			this.exclude(record.parentId);
			return;
		}
		parent.records.push(line);
		parent.bytes += bytes;
		this.totalBytesValue += bytes;
	}

	private exclude(parentId: string): void {
		const parent = this.parents.get(parentId);
		if (parent) {
			this.totalBytesValue -= parent.bytes;
			this.parents.delete(parentId);
		}
		this.incompleteBuckets.add(parentBucketForId(parentId, this.bucketCount));
		this.excluded.add(parentId);
	}

	finish(indexDigest: string): ParentArtifactBuildResult {
		if (this.finished) throw new Error("parent_artifact_builder_already_finished");
		this.finished = true;
		const byBucket: Array<{ records: string[]; bytes: number }> = Array.from({ length: this.bucketCount }, () => ({
			records: [],
			bytes: 0,
		}));
		for (const [parentId, parent] of this.parents) {
			const bucket = parentBucketForId(parentId, this.bucketCount);
			for (const line of parent.records) {
				byBucket[bucket].records.push(line);
				byBucket[bucket].bytes += Buffer.byteLength(line, "utf8");
			}
		}
		const buckets = byBucket.map((bucket, bucketIndex) => {
			const hash = createHash("sha256");
			for (const line of bucket.records) hash.update(line, "utf8");
			return {
				size: bucket.bytes,
				digest: hash.digest("hex"),
				complete: !this.incompleteBuckets.has(bucketIndex),
			};
		});
		const result: ParentArtifactBuildResult = {
			metadata: { bucketCount: this.bucketCount, indexDigest, buckets },
			buckets: byBucket.map(bucket => bucket.records),
			excludedParents: [...this.excluded],
		};
		this.parents.clear();
		this.excluded.clear();
		this.incompleteBuckets.clear();
		this.totalBytesValue = 0;
		return result;
	}
}

/** Fixed in-memory cost of the retained parent-artifact runtime state (block-cache charged). */
export function parentArtifactRuntimeBytes(bucketCount = PARENT_CHILDREN_BUCKET_COUNT): number {
	return bucketCount * 96 + 128;
}

// ============================================================================
// Persistent bounded dictionary artifact (deterministic hash partitions)
// ============================================================================

/** Fixed partition count for the on-disk dictionary artifact (4 × 4 MiB buffers). */
export const DICTIONARY_PARTITION_COUNT = 4;
/** Maximum unique duplicate record ids retained as diagnostics in the meta. */
export const DICTIONARY_DUPLICATE_DIAGNOSTIC_MAX = 64;
/** Fixed capacity of the bounded duplicate-id detector (open addressing). */
export const DICTIONARY_ID_SET_CAPACITY = 1_125_001;
/** Maximum records the bounded duplicate-id detector can prove unique. */
export const DICTIONARY_ID_SET_MAX_RECORDS = 1_000_000;

/**
 * One partition journal record. `term` is the lossless record id (never
 * truncated or hash-substituted); the remaining fields are the same exact
 * index fields the covered `.spill.idx` records, so a partition is a
 * self-sufficient hash-partitioned flat index for one id.
 */
export interface DictionaryPartitionRecord {
	term: string;
	dictId: number;
	ordinal: number;
	seq: number;
	byteOffset: number;
	byteLength: number;
	recordDigest: string;
	parentId: string | null;
	entryType: string;
}

/** Serialize one dictionary partition record as a compact JSON journal line (trailing newline). */
export function serializeDictionaryPartitionRecord(input: DictionaryPartitionRecord): string {
	return `${JSON.stringify({
		t: input.term,
		i: input.dictId,
		o: input.ordinal,
		s: input.seq,
		b: input.byteOffset,
		l: input.byteLength,
		d: input.recordDigest,
		p: input.parentId,
		e: input.entryType,
	})}\n`;
}

/** Strictly parse one dictionary partition journal line; `undefined` marks the partition corrupt. */
export function parseDictionaryPartitionRecord(line: string): DictionaryPartitionRecord | undefined {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { t, i, o, s, b, l, d, p, e } = value;
	if (typeof t !== "string" || t.length === 0) return undefined;
	if (typeof i !== "number" || !Number.isSafeInteger(i) || i < 0) return undefined;
	if (
		typeof o !== "number" ||
		typeof s !== "number" ||
		typeof b !== "number" ||
		typeof l !== "number" ||
		!Number.isSafeInteger(o) ||
		!Number.isSafeInteger(s) ||
		!Number.isSafeInteger(b) ||
		!Number.isSafeInteger(l) ||
		o < 0 ||
		s < 0 ||
		b < 0 ||
		l <= 0
	)
		return undefined;
	if (typeof d !== "string" || !/^[0-9a-f]{64}$/.test(d)) return undefined;
	if (p !== null && typeof p !== "string") return undefined;
	if (typeof e !== "string" || e.length === 0) return undefined;
	return {
		term: t,
		dictId: i,
		ordinal: o,
		seq: s,
		byteOffset: b,
		byteLength: l,
		recordDigest: d,
		parentId: p,
		entryType: e,
	};
}

/**
 * Deterministic hash-partition assignment for a record id (same FNV-1a family
 * as `parentBucketForId`). The same id always lands in the same partition, so
 * every occurrence of a duplicate id is confined to one journal.
 */
export function dictionaryPartitionForId(id: string, partitionCount = DICTIONARY_PARTITION_COUNT): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < id.length; index++) {
		const code = id.charCodeAt(index);
		hash ^= code & 0xff;
		hash = Math.imul(hash, 0x01000193);
		hash ^= code >>> 8;
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % partitionCount;
}

/** Committed exact bytes of one on-disk dictionary partition. */
export interface DictionaryPartitionCommit {
	size: number;
	digest: string;
	records: number;
	complete: boolean;
}

/**
 * Commit-marker binding for the disposable dictionary artifact. Every partition
 * and the meta file are bound by exact size + SHA-256, and the artifact covers
 * exactly the entry set of the `.spill.idx` whose digest is bound here; a
 * binding mismatch fails closed to the authoritative cold scan.
 */
export interface DictionaryArtifactCommit {
	header: SidecarIndexHeaderV2;
	/** Exact `.spill.idx` digest the artifact covers. */
	indexDigest: string;
	/** Per-partition exact-byte commits, one per partition file. */
	partitions: DictionaryPartitionCommit[];
	/** Exact bytes of the `.spill.dict-meta` file (self-referential fields omitted from the payload). */
	metaSize: number;
	metaDigest: string;
	recordCount: number;
	uniqueTerms: number;
	/** Combined serialized term bytes (lossless ids). */
	totalBytes: number;
	/** Bounded duplicate-id diagnostics; non-empty ⇒ the artifact must never be adopted. */
	duplicateIds: readonly string[];
	sidecarIneligible: boolean;
}

/**
 * Exact serialized bytes of the meta file. `metaSize`/`metaDigest` are omitted
 * from the payload (they authenticate the bytes that omit them), so
 * serialization is deterministic and self-referentiality is impossible.
 */
export function dictionaryArtifactMetaBytes(commit: Omit<DictionaryArtifactCommit, "metaSize" | "metaDigest">): string {
	return `${JSON.stringify({
		header: {
			version: commit.header.version,
			sessionId: commit.header.sessionId,
			sidecarIneligible: commit.header.sidecarIneligible,
		},
		indexDigest: commit.indexDigest,
		partitions: commit.partitions.map(partition => ({
			size: partition.size,
			digest: partition.digest,
			records: partition.records,
			complete: partition.complete,
		})),
		recordCount: commit.recordCount,
		uniqueTerms: commit.uniqueTerms,
		totalBytes: commit.totalBytes,
		duplicateIds: [...commit.duplicateIds],
		sidecarIneligible: commit.sidecarIneligible,
	})}\n`;
}

/** Compute the exact meta bytes and the resulting self-authenticating commit. */
export function finalizeDictionaryArtifactCommit(commit: Omit<DictionaryArtifactCommit, "metaSize" | "metaDigest">): {
	bytes: string;
	commit: DictionaryArtifactCommit;
} {
	const bytes = dictionaryArtifactMetaBytes(commit);
	const metaDigest = computeLineDigest(Buffer.from(bytes, "utf8"));
	return { bytes, commit: { ...commit, metaSize: bytes.length, metaDigest } };
}

/**
 * Strictly parse the exact meta bytes. The digest and size are recomputed over
 * the supplied exact bytes; any structural, bound, or digest mismatch returns
 * `undefined` (the artifact is then never trusted).
 */
export function parseDictionaryArtifactCommit(bytes: string | Uint8Array): DictionaryArtifactCommit | undefined {
	const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8").decode(bytes);
	const exactLength = typeof bytes === "string" ? Buffer.byteLength(bytes, "utf8") : bytes.byteLength;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const header = record.header;
	if (header === null || typeof header !== "object" || Array.isArray(header)) return undefined;
	const headerRecord = header as Record<string, unknown>;
	if (headerRecord.version !== 2) return undefined;
	if (typeof headerRecord.sessionId !== "string") return undefined;
	if (typeof headerRecord.sidecarIneligible !== "boolean") return undefined;
	if (typeof record.indexDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.indexDigest)) return undefined;
	if (!Array.isArray(record.partitions) || record.partitions.length !== DICTIONARY_PARTITION_COUNT) return undefined;
	const partitions: DictionaryPartitionCommit[] = [];
	for (const candidate of record.partitions) {
		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
		const partition = candidate as Record<string, unknown>;
		if (!Number.isSafeInteger(partition.size) || (partition.size as number) < 0) return undefined;
		if (typeof partition.digest !== "string" || !/^[0-9a-f]{64}$/.test(partition.digest)) return undefined;
		if (!Number.isSafeInteger(partition.records) || (partition.records as number) < 0) return undefined;
		if (typeof partition.complete !== "boolean") return undefined;
		partitions.push({
			size: partition.size as number,
			digest: partition.digest,
			records: partition.records as number,
			complete: partition.complete,
		});
	}
	if (!Number.isSafeInteger(record.recordCount) || (record.recordCount as number) < 0) return undefined;
	if (!Number.isSafeInteger(record.uniqueTerms) || (record.uniqueTerms as number) < 0) return undefined;
	if (!Number.isSafeInteger(record.totalBytes) || (record.totalBytes as number) < 0) return undefined;
	if (!Array.isArray(record.duplicateIds) || record.duplicateIds.some(candidate => typeof candidate !== "string"))
		return undefined;
	if (typeof record.sidecarIneligible !== "boolean") return undefined;
	const expectedDigest = computeLineDigest(
		typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes),
	);
	return {
		header: {
			version: 2,
			sessionId: headerRecord.sessionId,
			sidecarIneligible: headerRecord.sidecarIneligible,
		},
		indexDigest: record.indexDigest,
		partitions,
		metaSize: exactLength,
		metaDigest: expectedDigest,
		recordCount: record.recordCount as number,
		uniqueTerms: record.uniqueTerms as number,
		totalBytes: record.totalBytes as number,
		duplicateIds: record.duplicateIds as string[],
		sidecarIneligible: record.sidecarIneligible,
	};
}

/** Bounded duplicate-id oracle for the streaming dictionary build. */
export interface DictionaryIdDetector {
	add(id: string): "added" | "duplicate" | "full";
}

/**
 * Bounded duplicate-id oracle. Small transcripts stay in a tiny exact set;
 * larger transcripts promote once to the fixed-capacity 48-bit hash table.
 * A hash collision can only produce a spurious duplicate (fail closed), never
 * miss a true duplicate.
 */
export class BoundedDictionaryIdSet implements DictionaryIdDetector {
	#small: Set<string> | undefined = new Set();
	#high: Uint16Array | undefined;
	#low: Uint32Array | undefined;
	#size = 0;

	#hash(value: string, seed: number): number {
		let hash = seed >>> 0;
		for (let index = 0; index < value.length; index++) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash;
	}

	#hashPair(value: string): [number, number] {
		let high = this.#hash(value, 0x811c9dc5) & 0xffff;
		const low = this.#hash(value, 0x9e3779b9);
		if (high === 0 && low === 0) high = 1;
		return [high, low];
	}

	#insertHash(high: number, low: number): "added" | "duplicate" | "full" {
		const highs = this.#high!;
		const lows = this.#low!;
		let slot = low % DICTIONARY_ID_SET_CAPACITY;
		for (let probes = 0; probes < DICTIONARY_ID_SET_CAPACITY; probes++) {
			const existingHigh = highs[slot];
			const existingLow = lows[slot];
			if (existingHigh === high && existingLow === low) return "duplicate";
			if (existingHigh === 0 && existingLow === 0) {
				highs[slot] = high;
				lows[slot] = low;
				return "added";
			}
			slot++;
			if (slot === DICTIONARY_ID_SET_CAPACITY) slot = 0;
		}
		return "full";
	}

	#promote(): void {
		this.#high = new Uint16Array(DICTIONARY_ID_SET_CAPACITY);
		this.#low = new Uint32Array(DICTIONARY_ID_SET_CAPACITY);
		for (const value of this.#small!) {
			const [high, low] = this.#hashPair(value);
			this.#insertHash(high, low);
		}
		this.#small = undefined;
	}

	has(value: string): boolean {
		if (this.#small) return this.#small.has(value);
		const [high, low] = this.#hashPair(value);
		const highs = this.#high!;
		const lows = this.#low!;
		let slot = low % DICTIONARY_ID_SET_CAPACITY;
		for (let probes = 0; probes < DICTIONARY_ID_SET_CAPACITY; probes++) {
			const existingHigh = highs[slot];
			const existingLow = lows[slot];
			if (existingHigh === 0 && existingLow === 0) return false;
			if (existingHigh === high && existingLow === low) return true;
			slot++;
			if (slot === DICTIONARY_ID_SET_CAPACITY) slot = 0;
		}
		return true;
	}

	add(value: string): "added" | "duplicate" | "full" {
		if (this.#size >= DICTIONARY_ID_SET_MAX_RECORDS) return "full";
		if (this.#small) {
			if (this.#small.has(value)) return "duplicate";
			if (this.#small.size < 4096) {
				this.#small.add(value);
				this.#size++;
				return "added";
			}
			this.#promote();
		}
		const [high, low] = this.#hashPair(value);
		const result = this.#insertHash(high, low);
		if (result === "added") this.#size++;
		return result;
	}
}

/** One record consumed by the streaming dictionary artifact builder. */
export interface DictionaryArtifactRecordInput {
	id: string;
	ordinal: number;
	seq: number;
	byteOffset: number;
	byteLength: number;
	recordDigest: string;
	parentId: string | null;
	entryType: string;
}

/**
 * Persistence target for flushed partition lines. The target owns the exact
 * bytes on disk and their running digests (it must keep per-partition hashes
 * for append-time rebinding); the builder never retains flushed lines.
 */
export interface DictionaryArtifactFlushTarget {
	/** Append `lines` to `partition`'s journal, fsyncing before returning false on failure. */
	writePartitionLines(partition: number, lines: readonly string[]): boolean;
	/** Exact-byte commit of one partition as currently persisted. */
	getPartitionCommit(partition: number): DictionaryPartitionCommit;
}

export type DictionaryArtifactAddResult =
	| { kind: "ok" }
	| { kind: "budget_exceeded"; peakBytes: number; budgetBytes: number }
	| { kind: "flush_failed" };

export type DictionaryArtifactBuildResult =
	| { kind: "ok"; commit: DictionaryArtifactCommit; stats: DictionaryBuildStats }
	| { kind: "budget_exceeded"; peakBytes: number; budgetBytes: number }
	| { kind: "flush_failed" };

export interface DictionaryArtifactBuildOptions {
	peakBudgetBytes?: number;
	partitionBufferBytes?: number;
	journalBytes?: number;
	partitionCount?: number;
	detector?: DictionaryIdDetector;
	/** Persistence target for flushed partition lines; required for `add`/`finish`. */
	target?: DictionaryArtifactFlushTarget;
}

/**
 * Streaming dictionary artifact builder with a deterministic 20 MiB build peak
 * (4 × `partitionBufferBytes` partition buffers + one `journalBytes` flush
 * buffer). Consumes records one at a time, flushes full partition buffers
 * through the journal to the flush target, and never retains the complete
 * dictionary object/JSON graph. Record ids are stored losslessly as terms.
 * Duplicate record ids mark the artifact `sidecarIneligible` (never adopted;
 * the session falls back to eager) while the build still completes
 * deterministically.
 */
export class BoundedDictionaryArtifactBuilder {
	private readonly buffers: string[][] = [];
	private readonly bufferBytes: number[] = [];
	private journal: string[] = [];
	private journalBytes = 0;
	private journalPartition: number | undefined;
	private readonly partitionCountValue: number;
	private readonly partitionBufferBytesValue: number;
	private readonly journalBytesValue: number;
	private readonly peakBudgetValue: number;
	private readonly detector: DictionaryIdDetector;
	private readonly target: DictionaryArtifactFlushTarget | undefined;
	private readonly duplicateIds: string[] = [];
	private duplicateIdBytes = 0;
	private uniqueTerms = 0;
	private totalTermBytes = 0;
	private recordCount = 0;
	private peakBytesValue = 0;
	private sidecarIneligible = false;
	private flushFailed = false;
	private finished = false;

	constructor(options: DictionaryArtifactBuildOptions = {}) {
		this.peakBudgetValue = options.peakBudgetBytes ?? DICTIONARY_BUILD_PEAK_BYTES;
		this.partitionCountValue = options.partitionCount ?? DICTIONARY_PARTITION_COUNT;
		this.partitionBufferBytesValue = options.partitionBufferBytes ?? DICTIONARY_PARTITION_BUFFER_BYTES;
		this.journalBytesValue = options.journalBytes ?? DICTIONARY_BUCKET_JOURNAL_BYTES;
		this.detector = options.detector ?? new BoundedDictionaryIdSet();
		this.target = options.target;
		for (let partition = 0; partition < this.partitionCountValue; partition++) {
			this.buffers.push([]);
			this.bufferBytes.push(0);
		}
	}

	get peakBytes(): number {
		return this.peakBytesValue;
	}

	/** Consumes one record. The build peak stays within the 20 MiB buffer model. */
	add(record: DictionaryArtifactRecordInput): DictionaryArtifactAddResult {
		if (this.finished) throw new Error("dictionary_artifact_builder_finished");
		this.recordCount += 1;
		const partition = dictionaryPartitionForId(record.id, this.partitionCountValue);
		const detection = this.detector.add(record.id);
		if (detection === "duplicate") {
			this.sidecarIneligible = true;
			if (this.duplicateIds.length < DICTIONARY_DUPLICATE_DIAGNOSTIC_MAX && !this.duplicateIds.includes(record.id)) {
				this.duplicateIdBytes += residentStringBytes(record.id) + RECORD_OBJECT_OVERHEAD_BYTES;
				this.duplicateIds.push(record.id);
			}
		} else if (detection === "full") {
			// Uniqueness can no longer be proven with bounded memory; fail closed.
			this.sidecarIneligible = true;
		}
		if (detection === "added") {
			this.uniqueTerms += 1;
			this.totalTermBytes += Buffer.byteLength(record.id, "utf8");
		}
		const line = serializeDictionaryPartitionRecord({
			term: record.id,
			dictId: detection === "added" ? this.uniqueTerms - 1 : -1,
			ordinal: record.ordinal,
			seq: record.seq,
			byteOffset: record.byteOffset,
			byteLength: record.byteLength,
			recordDigest: record.recordDigest,
			parentId: record.parentId,
			entryType: record.entryType,
		});
		const lineBytes = Buffer.byteLength(line, "utf8");
		this.buffers[partition]!.push(line);
		this.bufferBytes[partition]! += lineBytes;
		this.updatePeak();
		if (this.peakBytesValue > this.peakBudgetValue) {
			return { kind: "budget_exceeded", peakBytes: this.peakBytesValue, budgetBytes: this.peakBudgetValue };
		}
		if (this.bufferBytes[partition]! > this.partitionBufferBytesValue) {
			if (!this.flushPartition(partition)) return { kind: "flush_failed" };
		}
		return { kind: "ok" };
	}

	/** Flush every buffer, read the exact partition commits from the target, and finalize. */
	finish(sessionId: string, indexDigest: string): DictionaryArtifactBuildResult {
		if (this.finished) throw new Error("dictionary_artifact_builder_already_finished");
		this.finished = true;
		for (let partition = 0; partition < this.partitionCountValue; partition++) {
			if (this.bufferBytes[partition]! > 0) {
				if (!this.flushPartition(partition)) return { kind: "flush_failed" };
			}
		}
		if (this.flushFailed) return { kind: "flush_failed" };
		if (this.peakBytesValue > this.peakBudgetValue) {
			return { kind: "budget_exceeded", peakBytes: this.peakBytesValue, budgetBytes: this.peakBudgetValue };
		}
		if (!this.target) return { kind: "flush_failed" };
		const partitions: DictionaryPartitionCommit[] = [];
		for (let partition = 0; partition < this.partitionCountValue; partition++) {
			partitions.push(this.target.getPartitionCommit(partition));
		}
		const commit = {
			header: { version: 2 as const, sessionId, sidecarIneligible: this.sidecarIneligible },
			indexDigest,
			partitions,
			metaSize: 0,
			metaDigest: "",
			recordCount: this.recordCount,
			uniqueTerms: this.uniqueTerms,
			totalBytes: this.totalTermBytes,
			duplicateIds: [...this.duplicateIds],
			sidecarIneligible: this.sidecarIneligible,
		};
		const stats: DictionaryBuildStats = {
			totalRecords: this.recordCount,
			uniqueTerms: this.uniqueTerms,
			totalBytes: this.totalTermBytes,
			peakBytes: this.peakBytesValue,
			duplicateIds: [...this.duplicateIds],
			sidecarIneligible: this.sidecarIneligible,
		};
		this.journal = [];
		this.journalBytes = 0;
		this.journalPartition = undefined;
		for (let partition = 0; partition < this.partitionCountValue; partition++) {
			this.buffers[partition] = [];
			this.bufferBytes[partition] = 0;
		}
		return { kind: "ok", commit, stats };
	}

	/** Moves one partition's buffer into the journal (≤ 4 MiB) and flushes it to the target. */
	private flushPartition(partition: number): boolean {
		const buffer = this.buffers[partition]!;
		if (buffer.length === 0) return true;
		if (this.journalPartition !== undefined) {
			// The previous journal flush failed or was never drained; fail closed.
			this.flushFailed = true;
			return false;
		}
		// Take as many leading lines as fit the journal cap (≤ 4 MiB); the rest
		// stays buffered so a flush batch never exceeds the fixed journal bound.
		let take = 0;
		let takeBytes = 0;
		while (take < buffer.length) {
			const lineBytes = Buffer.byteLength(buffer[take]!, "utf8");
			if (takeBytes + lineBytes > this.journalBytesValue) break;
			takeBytes += lineBytes;
			take++;
		}
		if (take === 0) {
			// A single line exceeds the journal cap; fail closed.
			this.flushFailed = true;
			return false;
		}
		const lines = take === buffer.length ? buffer : buffer.slice(0, take);
		this.buffers[partition] = take === buffer.length ? [] : buffer.slice(take);
		this.bufferBytes[partition]! -= takeBytes;
		this.journal = lines;
		this.journalBytes = takeBytes;
		this.journalPartition = partition;
		this.updatePeak();
		const ok = this.flushJournal();
		this.updatePeak();
		return ok;
	}

	private flushJournal(): boolean {
		if (this.journal.length === 0) return true;
		const partition = this.journalPartition;
		if (partition === undefined) return true;
		const lines = this.journal;
		const bytes = this.journalBytes;
		this.journal = [];
		this.journalBytes = 0;
		this.journalPartition = undefined;
		const target = this.target;
		if (!target) {
			this.flushFailed = true;
			return false;
		}
		const ok = target.writePartitionLines(partition, lines);
		if (!ok) this.flushFailed = true;
		if (bytes > this.peakBytesValue) this.peakBytesValue = bytes;
		return ok;
	}

	private updatePeak(): void {
		// Actual buffered content only: at most one partition buffer is being
		// filled (~4 MiB), the others hold flush remainders, and the journal is
		// capped at its fixed size — so the peak never exceeds the 20 MiB model
		// (4 × 4 MiB partition buffers + 4 MiB bucket flush).
		const current =
			this.bufferBytes.reduce((total, bytes) => total + bytes, 0) + this.journalBytes + this.duplicateIdBytes;
		if (current > this.peakBytesValue) this.peakBytesValue = current;
	}
}

/** Fixed in-memory cost of the retained dictionary-artifact runtime state (block-cache charged). */
export function dictionaryArtifactRuntimeBytes(partitionCount = DICTIONARY_PARTITION_COUNT): number {
	return partitionCount * 96 + 128;
}

// ============================================================================
// Persistent metadata-delta artifact (demoted reducer/provider values)
// ============================================================================

/**
 * One demoted provider-state value descriptor: exact ordinal, kind, byte
 * location, and digest inside the `.spill.metadata-delta` section. The value
 * bytes are persisted before demotion, so a descriptor always points at
 * durable authenticated bytes.
 */
export interface MetadataDeltaValue {
	/** Provider-state key (`providerStateEntryKey` semantics: type or `type:role`). */
	key: string;
	/** Entry type of the demoted value. */
	kind: string;
	/** Exact transcript ordinal of the demoted entry. */
	ordinal: number;
	/** Position in the build's ordered provider list (reopen merge slot). */
	position: number;
	offset: number;
	length: number;
	sha256: string;
}

/** Commit-marker binding for the disposable metadata-delta section. */
export interface MetadataDeltaArtifactCommit {
	/** Exact `.spill.idx` digest the sidecar set was built with. */
	indexDigest: string;
	/** Exact bytes of the `.spill.metadata-delta` file. */
	size: number;
	sha256: string;
	values: readonly MetadataDeltaValue[];
}

/** Strict descriptor validation (any ambiguity fails closed). */
export function isValidMetadataDeltaValue(value: unknown): value is MetadataDeltaValue {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.key === "string" &&
		record.key.length > 0 &&
		typeof record.kind === "string" &&
		record.kind.length > 0 &&
		Number.isSafeInteger(record.ordinal) &&
		(record.ordinal as number) >= 0 &&
		Number.isSafeInteger(record.position) &&
		(record.position as number) >= 0 &&
		Number.isSafeInteger(record.offset) &&
		(record.offset as number) >= 0 &&
		Number.isSafeInteger(record.length) &&
		(record.length as number) > 0 &&
		typeof record.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(record.sha256)
	);
}

/** Strict commit-binding validation: bounded values, unique keys/positions, in-range offsets. */
export function isValidMetadataDeltaCommit(value: unknown): value is MetadataDeltaArtifactCommit {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.indexDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.indexDigest)) return false;
	if (!Number.isSafeInteger(record.size) || (record.size as number) < 0) return false;
	if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) return false;
	if (!Array.isArray(record.values) || record.values.length > 256) return false;
	if (!record.values.every(isValidMetadataDeltaValue)) return false;
	const keys = new Set<string>();
	const positions = new Set<number>();
	for (const value of record.values) {
		// Each value is independently authenticated by its exact byte digest; the
		// marker may legitimately reorder re-demoted values relative to their
		// byte offsets, so only uniqueness and range bounds are enforced here.
		if (keys.has(value.key)) return false;
		if (positions.has(value.position)) return false;
		keys.add(value.key);
		positions.add(value.position);
		if (value.offset + value.length > (record.size as number)) return false;
	}
	return true;
}

/** Compute the descriptor for one value whose exact line bytes are about to be persisted. */
export function metadataDeltaValueDescriptor(input: {
	key: string;
	kind: string;
	ordinal: number;
	position: number;
	offset: number;
	lineBytes: Uint8Array;
}): MetadataDeltaValue {
	return {
		key: input.key,
		kind: input.kind,
		ordinal: input.ordinal,
		position: input.position,
		offset: input.offset,
		length: input.lineBytes.byteLength,
		sha256: computeLineDigest(input.lineBytes),
	};
}

/** Resident bytes of one retained metadata-delta descriptor (key + 24 B descriptor + object). */
export function metadataDeltaDescriptorResidentBytes(key: string): number {
	return residentStringBytes(key) + DESCRIPTOR_BYTES + RECORD_OBJECT_OVERHEAD_BYTES;
}
