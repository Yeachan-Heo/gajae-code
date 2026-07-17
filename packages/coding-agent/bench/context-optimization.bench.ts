/**
 * Context-optimization effectiveness benchmark.
 *
 * Measures whether the merged context-optimization work (#508 pruning
 * cache-epoch gate + staleness-aware selection, #509 phase-rollup receipts +
 * receipt-ingestion fast path, #510/#511 advisory ROI reconciliation) actually
 * moves the needle, using deterministic fixtures and the REAL shipped code
 * paths. No provider, network, or live-model calls.
 *
 * Run: bun run packages/coding-agent/bench/context-optimization.bench.ts
 *
 * The same scenario builders back the CI effectiveness test
 * (test/bench/context-optimization-effectiveness.test.ts), which asserts the
 * improvement invariants so regressions are provable.
 */

import { estimateMessageTokensHeuristic } from "@gajae-code/agent-core/compaction/compaction";
import type { SessionEntry } from "@gajae-code/agent-core/compaction/entries";
import {
	DEFAULT_PRUNE_CONFIG,
	type PruneConfig,
	pruneToolOutputs,
} from "@gajae-code/agent-core/compaction/pruning";
import type { AgentMessage } from "@gajae-code/agent-core/types";
import { buildPhaseRollupReceipt } from "../src/harness-control-plane/phase-rollup";
import { ingestReceipts, RECEIPT_DIGEST_MAX_CHARS } from "../src/harness-control-plane/receipt-ingest";
import {
	buildReceipt,
	type CompletionEvidence,
	type ReceiptEnvelope,
	type ReceiptSubject,
	validateReceipt,
} from "../src/harness-control-plane/receipts";
import type { HarnessLifecycle, SessionState } from "../src/harness-control-plane/types";
import type { TaskResultReceipt } from "../src/task/receipt";

// ---------------------------------------------------------------------------
// Session fixture: a realistic mixed editing session
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so fixtures are identical on every run. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface SessionBuilder {
	entries: SessionEntry[];
	counter: number;
}

function newSession(): SessionBuilder {
	return { entries: [], counter: 0 };
}

function pushCallAndResult(
	session: SessionBuilder,
	toolName: string,
	args: Record<string, unknown>,
	resultChars: number,
): void {
	session.counter++;
	const callId = `call-${session.counter}`;
	session.entries.push({
		type: "message",
		id: `a-${session.counter}`,
		parentId: null,
		timestamp: new Date(session.counter).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "bench",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: session.counter,
		} as AgentMessage,
	} as SessionEntry);
	session.entries.push({
		type: "message",
		id: `r-${session.counter}`,
		parentId: null,
		timestamp: new Date(session.counter).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: `out-${session.counter} ${"x ".repeat(Math.floor(resultChars / 2))}` }],
			isError: false,
			timestamp: session.counter,
		} as AgentMessage,
	} as SessionEntry);
}

/**
 * A long "investigate then edit" session: files get read, re-read after
 * context grows, edited (which invalidates earlier reads), searches get
 * re-run, and bash output accumulates. This is the shape staleness-aware
 * pruning targets: lots of protected `read` results whose content has been
 * superseded.
 */
export function buildMixedEditingSession(options?: { files?: number; rounds?: number }): SessionEntry[] {
	const files = options?.files ?? 12;
	const rounds = options?.rounds ?? 4;
	const random = mulberry32(0xc0ffee);
	const session = newSession();

	for (let round = 0; round < rounds; round++) {
		for (let f = 0; f < files; f++) {
			const filePath = `src/module-${f}.ts`;
			// Read the file (large output: source content).
			pushCallAndResult(session, "read", { path: filePath }, 6000 + Math.floor(random() * 2000));
			// Half the files get searched too.
			if (f % 2 === 0) {
				pushCallAndResult(session, "search", { pattern: `symbol${f}`, paths: ["src"] }, 1500);
			}
			// A third of reads are followed by an edit (invalidating the read).
			if (f % 3 === 0) {
				pushCallAndResult(session, "edit", { path: filePath }, 300);
			}
			// Interleaved bash noise (build/test output).
			if (f % 4 === 0) {
				pushCallAndResult(session, "bash", { command: `bun test module-${f}` }, 3000);
			}
		}
	}
	return session.entries;
}

function totalToolResultTokens(entries: SessionEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as AgentMessage;
		if (message.role !== "toolResult") continue;
		total += estimateMessageTokensHeuristic(message);
	}
	return total;
}

function cloneEntries(entries: SessionEntry[]): SessionEntry[] {
	return structuredClone(entries);
}

// ---------------------------------------------------------------------------
// 1. Staleness-aware pruning gain (vs classic pre-#508 selection)
// ---------------------------------------------------------------------------

export interface PruningGainReport {
	fixtureToolResultTokens: number;
	classic: { prunedCount: number; tokensSaved: number };
	stalenessAware: { prunedCount: number; tokensSaved: number };
	/** Additional tokens recovered purely by staleness awareness. */
	additionalTokensSaved: number;
	/** Relative gain over classic (0 when classic saved nothing). */
	relativeGain: number;
	/** Superseded reads recovered (classic can never prune protected reads). */
	staleReadsPruned: number;
}

export function measurePruningGain(entries: SessionEntry[]): PruningGainReport {
	const classicConfig: PruneConfig = {
		protectTokens: DEFAULT_PRUNE_CONFIG.protectTokens,
		minimumSavings: DEFAULT_PRUNE_CONFIG.minimumSavings,
		protectedTools: DEFAULT_PRUNE_CONFIG.protectedTools,
		// Pre-#508: no staleness override; protected reads are immune forever.
		staleOverridableTools: [],
	};
	const classicEntries = cloneEntries(entries);
	const stalenessEntries = cloneEntries(entries);

	const classic = pruneToolOutputs(classicEntries, classicConfig);
	const stalenessAware = pruneToolOutputs(stalenessEntries, DEFAULT_PRUNE_CONFIG);

	const staleReadsPruned = stalenessAware.prunedEntries.filter(entry => {
		const message = entry.message as AgentMessage;
		return message.role === "toolResult" && message.toolName === "read";
	}).length;

	const additionalTokensSaved = stalenessAware.tokensSaved - classic.tokensSaved;
	return {
		fixtureToolResultTokens: totalToolResultTokens(entries),
		classic: { prunedCount: classic.prunedCount, tokensSaved: classic.tokensSaved },
		stalenessAware: { prunedCount: stalenessAware.prunedCount, tokensSaved: stalenessAware.tokensSaved },
		additionalTokensSaved,
		relativeGain: classic.tokensSaved > 0 ? additionalTokensSaved / classic.tokensSaved : Number.POSITIVE_INFINITY,
		staleReadsPruned,
	};
}

// ---------------------------------------------------------------------------
// 2. Cache-epoch discipline (per-turn pruning vs threshold-gated pruning)
// ---------------------------------------------------------------------------

export interface CacheEpochReport {
	turns: number;
	/** History rewrites under the old per-turn policy (each breaks the prompt-cache prefix). */
	perTurnRewrites: number;
	/** History rewrites under the shipped threshold-gated policy. */
	thresholdRewrites: number;
	/**
	 * Estimated cache re-write tokens: every mid-epoch history rewrite forces
	 * the provider to re-cache the full context on the next call. Sum of the
	 * context size at each rewrite point.
	 */
	perTurnRecacheTokens: number;
	thresholdRecacheTokens: number;
	recacheTokensSaved: number;
}

/**
 * Replays the fixture turn-by-turn (one tool call+result pair per turn) and
 * applies the two pruning policies the way agent-session did before and after
 * the fix:
 *   - per-turn (old): prune after every successful turn.
 *   - threshold-gated (shipped): prune only once accumulated context crosses
 *     the compaction-threshold proxy.
 * Counts history rewrites (prunedCount > 0 events) and estimates the cache
 * re-write cost each rewrite incurs.
 */
export function measureCacheEpochDiscipline(
	entries: SessionEntry[],
	thresholdTokens: number,
): CacheEpochReport {
	const perTurn = cloneEntries(entries);
	const threshold = cloneEntries(entries);

	let perTurnRewrites = 0;
	let perTurnRecacheTokens = 0;
	let thresholdRewrites = 0;
	let thresholdRecacheTokens = 0;
	let turns = 0;

	// Entries are call/result pairs: replay in increments of 2.
	for (let upto = 2; upto <= entries.length; upto += 2) {
		turns++;

		// Old policy: prune every turn (mutates the live array slice in place).
		const perTurnSlice = perTurn.slice(0, upto);
		const perTurnContextTokens = totalToolResultTokens(perTurnSlice);
		const perTurnResult = pruneToolOutputs(perTurnSlice, DEFAULT_PRUNE_CONFIG);
		if (perTurnResult.prunedCount > 0) {
			perTurnRewrites++;
			perTurnRecacheTokens += perTurnContextTokens;
		}

		// Shipped policy: prune only at the sanctioned maintenance boundary.
		const thresholdContextTokens = totalToolResultTokens(threshold.slice(0, upto));
		if (thresholdContextTokens > thresholdTokens) {
			const thresholdSlice = threshold.slice(0, upto);
			const thresholdResult = pruneToolOutputs(thresholdSlice, DEFAULT_PRUNE_CONFIG);
			if (thresholdResult.prunedCount > 0) {
				thresholdRewrites++;
				thresholdRecacheTokens += totalToolResultTokens(threshold.slice(0, upto));
			}
		}
	}

	return {
		turns,
		perTurnRewrites,
		thresholdRewrites,
		perTurnRecacheTokens,
		thresholdRecacheTokens,
		recacheTokensSaved: perTurnRecacheTokens - thresholdRecacheTokens,
	};
}

// ---------------------------------------------------------------------------
// 3. Phase-rollup receipt compression
// ---------------------------------------------------------------------------

export interface RollupCompressionReport {
	childCount: number;
	inlineChildBytes: number;
	rollupBytes: number;
	/** rollup bytes / inline bytes — lower is better. */
	compressionRatio: number;
	rollupValid: boolean;
}

export function buildChildReceiptFixture(index: number): TaskResultReceipt {
	return {
		index,
		id: `${index}-BenchChild`,
		agent: "executor",
		agentSource: "bundled" as TaskResultReceipt["agentSource"],
		task: `Implement bounded slice ${index} of the refactor with acceptance criteria and verification notes.`,
		assignment: `# Target\nfiles for slice ${index}\n# Change\nsteps...\n# Acceptance\ntargeted tests green`.repeat(3),
		description: `Bench child ${index}`,
		status: index % 5 === 4 ? "failed" : "completed",
		exitCode: index % 5 === 4 ? 1 : 0,
		truncated: false,
		durationMs: 60_000 + index * 1000,
		tokens: 50_000 + index * 1000,
		contextTokens: 80_000,
		contextWindow: 200_000,
		preview: `Task completed; output stored in agent://${index}-BenchChild (240 lines, 18000 bytes).`,
		previewTruncated: false,
		outputRef: {
			uri: `agent://${index}-BenchChild`,
			sizeBytes: 18_000,
			lineCount: 240,
			sha256: `${index}`.padStart(64, "0").slice(0, 64),
		},
		review: {
			overallCorrectness: "correct",
			findingCount: 2,
			findings: [
				{ severity: "low", summary: `Finding A for child ${index}: minor naming drift in helper.` },
				{ severity: "info", summary: `Finding B for child ${index}: consider extracting fixture builder.` },
			],
		},
		roi: {
			tokens: 50_000 + index * 1000,
			costTotal: 0.42,
			producedChanges: index % 5 !== 4,
			materialContribution: true,
			lowRoi: false,
		},
	};
}

export function measureRollupCompression(childCount: number): RollupCompressionReport {
	const children = Array.from({ length: childCount }, (_, index) => buildChildReceiptFixture(index));
	const subject: ReceiptSubject = { workspace: "/ws", branch: "feat/bench", head: "abc", commit: "abc" };
	const rollup = buildPhaseRollupReceipt({
		receiptId: "bench-rollup",
		sessionId: "bench-session",
		source: "bench",
		subject,
		phase: "implementation",
		children,
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	const inlineChildBytes = Buffer.byteLength(JSON.stringify(children), "utf8");
	const rollupBytes = Buffer.byteLength(JSON.stringify(rollup), "utf8");
	return {
		childCount,
		inlineChildBytes,
		rollupBytes,
		compressionRatio: rollupBytes / inlineChildBytes,
		rollupValid: validateReceipt(rollup).valid,
	};
}

// ---------------------------------------------------------------------------
// 4. Receipt-ingest digest compression + fail-closed behavior
// ---------------------------------------------------------------------------

export interface IngestDigestReport {
	batchSize: number;
	batchBytes: number;
	digestBytes: number;
	/** digest bytes / batch bytes — lower is better. */
	digestRatio: number;
	digestCapRespected: boolean;
	tamperedRejected: number;
	finalLifecycle: HarnessLifecycle;
}

function benchSessionState(): SessionState {
	return {
		schemaVersion: 1,
		sessionId: "bench-session",
		lifecycle: "finalizing",
		harness: "gajae-code",
		handle: {
			sessionId: "bench-session",
			harness: "gajae-code",
			mode: "implement",
			repo: "/repo",
			workspace: "/ws",
			branch: "feat/bench",
			base: "main",
			issueOrPr: null,
			processHandle: { kind: "runtime-owner", ownerId: null, pid: null },
			sdkHandle: { kind: "sdk-session-endpoint", sessionId: "bench-session" },
			ownerHandle: { leasePath: "/tmp/bench/lease", endpoint: null, heartbeatAt: null },
			routerHandle: { kind: "default-in-owner", policy: "default", eventsPath: "/tmp/bench/events.jsonl" },
			viewportHandle: { kind: "event-monitor", tmuxSessionName: null, viewOnly: true },
			startedAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		retries: {},
		blockers: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function benchCompletionReceipt(receiptId: string, tampered: boolean): ReceiptEnvelope<CompletionEvidence> {
	const receipt = buildReceipt<CompletionEvidence>({
		receiptId,
		sessionId: "bench-session",
		family: "completion",
		source: "bench",
		subject: { workspace: "/ws", branch: "feat/bench", head: "abc", commit: "abc" },
		createdAt: "2026-01-01T00:00:00.000Z",
		evidence: {
			finalCommit: "abc",
			branch: "feat/bench",
			prUrl: "https://example.test/pr/1",
			issueArtifact: null,
			requiredValidationReceiptIds: ["v-1"],
			finalLifecycle: "completed",
			finalizedAt: "2026-01-01T00:00:00.000Z",
			blockers: [],
		},
	});
	return tampered ? { ...receipt, sha256: "0".repeat(64) } : receipt;
}

export function measureIngestDigest(batchSize: number): IngestDigestReport {
	// One legitimate completion; the rest are tampered (worst case for digest size).
	const receipts = [
		benchCompletionReceipt("bench-real", false),
		...Array.from({ length: batchSize - 1 }, (_, index) =>
			benchCompletionReceipt(`bench-tampered-${index}-${"x".repeat(24)}`, true),
		),
	];
	const result = ingestReceipts(benchSessionState(), receipts);
	const batchBytes = Buffer.byteLength(JSON.stringify(receipts), "utf8");
	const digestBytes = Buffer.byteLength(result.digest, "utf8");
	return {
		batchSize,
		batchBytes,
		digestBytes,
		digestRatio: digestBytes / batchBytes,
		digestCapRespected: result.digest.length <= RECEIPT_DIGEST_MAX_CHARS,
		tamperedRejected: result.rejected.length,
		finalLifecycle: result.finalLifecycle,
	};
}

// ---------------------------------------------------------------------------
// 5. Perf sanity (the optimizations must not be slow)
// ---------------------------------------------------------------------------

export interface PerfReport {
	pruneLargeSessionMsPerOp: number;
	pruneLargeSessionEntries: number;
	ingestBatchMsPerOp: number;
	ingestBatchSize: number;
	rollupBuildMsPerOp: number;
	rollupChildCount: number;
}

function timePerOp(iterations: number, fn: () => void): number {
	// Warmup.
	fn();
	const start = Bun.nanoseconds();
	for (let i = 0; i < iterations; i++) fn();
	return (Bun.nanoseconds() - start) / 1e6 / iterations;
}

export function measurePerf(): PerfReport {
	const largeSession = buildMixedEditingSession({ files: 40, rounds: 10 });
	const ingestBatch = [
		benchCompletionReceipt("perf-real", false),
		...Array.from({ length: 99 }, (_, index) => benchCompletionReceipt(`perf-${index}`, true)),
	];
	const rollupChildren = Array.from({ length: 32 }, (_, index) => buildChildReceiptFixture(index));
	const subject: ReceiptSubject = { workspace: "/ws", branch: "feat/bench", head: "abc", commit: "abc" };

	return {
		pruneLargeSessionEntries: largeSession.length,
		pruneLargeSessionMsPerOp: timePerOp(10, () => {
			pruneToolOutputs(cloneEntries(largeSession), DEFAULT_PRUNE_CONFIG);
		}),
		ingestBatchSize: ingestBatch.length,
		ingestBatchMsPerOp: timePerOp(50, () => {
			ingestReceipts(benchSessionState(), ingestBatch);
		}),
		rollupChildCount: rollupChildren.length,
		rollupBuildMsPerOp: timePerOp(50, () => {
			buildPhaseRollupReceipt({
				receiptId: "perf-rollup",
				sessionId: "bench-session",
				source: "bench",
				subject,
				phase: "implementation",
				children: rollupChildren,
				createdAt: "2026-01-01T00:00:00.000Z",
			});
		}),
	};
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface ContextOptimizationBenchReport {
	pruningGain: PruningGainReport;
	cacheEpoch: CacheEpochReport;
	rollupCompression: RollupCompressionReport;
	ingestDigest: IngestDigestReport;
	perf: PerfReport;
}

export function runContextOptimizationBenchmark(): ContextOptimizationBenchReport {
	const session = buildMixedEditingSession();
	return {
		pruningGain: measurePruningGain(session),
		cacheEpoch: measureCacheEpochDiscipline(session, 120_000),
		rollupCompression: measureRollupCompression(8),
		ingestDigest: measureIngestDigest(50),
		perf: measurePerf(),
	};
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

if (import.meta.main) {
	const report = runContextOptimizationBenchmark();
	const { pruningGain, cacheEpoch, rollupCompression, ingestDigest, perf } = report;

	console.log("# Context-optimization effectiveness benchmark\n");

	console.log("## 1. Staleness-aware pruning (#508) — tokens recovered vs classic");
	console.log(`   fixture toolResult tokens : ${pruningGain.fixtureToolResultTokens}`);
	console.log(
		`   classic                  : ${pruningGain.classic.prunedCount} pruned, ${pruningGain.classic.tokensSaved} tokens saved`,
	);
	console.log(
		`   staleness-aware          : ${pruningGain.stalenessAware.prunedCount} pruned, ${pruningGain.stalenessAware.tokensSaved} tokens saved`,
	);
	console.log(
		`   additional savings       : +${pruningGain.additionalTokensSaved} tokens (${pct(
			pruningGain.additionalTokensSaved / Math.max(1, pruningGain.fixtureToolResultTokens),
		)} of fixture), ${pruningGain.staleReadsPruned} superseded reads recovered\n`,
	);

	console.log("## 2. Cache-epoch discipline (#508) — history rewrites & re-cache cost");
	console.log(`   turns simulated          : ${cacheEpoch.turns}`);
	console.log(
		`   per-turn policy (old)    : ${cacheEpoch.perTurnRewrites} rewrites, ~${cacheEpoch.perTurnRecacheTokens} re-cache tokens`,
	);
	console.log(
		`   threshold policy (new)   : ${cacheEpoch.thresholdRewrites} rewrites, ~${cacheEpoch.thresholdRecacheTokens} re-cache tokens`,
	);
	console.log(`   re-cache tokens saved    : ~${cacheEpoch.recacheTokensSaved}\n`);

	console.log("## 3. Phase-rollup compression (#509) — receipt-of-receipts");
	console.log(`   ${rollupCompression.childCount} child receipts inline : ${rollupCompression.inlineChildBytes} bytes`);
	console.log(`   phase-rollup receipt     : ${rollupCompression.rollupBytes} bytes`);
	console.log(
		`   compression ratio        : ${pct(rollupCompression.compressionRatio)} (valid: ${rollupCompression.rollupValid})\n`,
	);

	console.log("## 4. Receipt-ingest digest (#509) — model-facing bytes");
	console.log(`   batch of ${ingestDigest.batchSize} receipts    : ${ingestDigest.batchBytes} bytes`);
	console.log(
		`   digest                   : ${ingestDigest.digestBytes} bytes (${pct(ingestDigest.digestRatio)}), cap respected: ${ingestDigest.digestCapRespected}`,
	);
	console.log(
		`   fail-closed              : ${ingestDigest.tamperedRejected} tampered rejected, lifecycle ${ingestDigest.finalLifecycle}\n`,
	);

	console.log("## 5. Perf sanity");
	console.log(
		`   prune ${perf.pruneLargeSessionEntries} entries     : ${perf.pruneLargeSessionMsPerOp.toFixed(2)} ms/op`,
	);
	console.log(`   ingest ${perf.ingestBatchSize} receipts      : ${perf.ingestBatchMsPerOp.toFixed(3)} ms/op`);
	console.log(`   rollup ${perf.rollupChildCount} children       : ${perf.rollupBuildMsPerOp.toFixed(3)} ms/op\n`);

	console.log("Raw JSON:\n");
	console.log(JSON.stringify(report, null, 2));
}
