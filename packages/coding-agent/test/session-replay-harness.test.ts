import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { PerfCorpusReport } from "../bench/perf-corpus-schema";
import { validatePerfCorpusReport } from "../bench/perf-corpus-schema";
import type { CorpusEntry, CorpusManifest } from "../bench/session-replay/corpus";
import {
	aggregateSelfTime,
	assertCorpusProvenance,
	buildSessionReplayProfileReport,
	CorpusProvenanceInsufficient,
	type CpuProfile,
	compareTopFunctions,
	type HarnessMark,
	type ReplayFidelity,
	resolveProfileOutputPath,
	selectFunctionsAtOrAboveShare,
	sliceProfileByWindows,
} from "../bench/session-replay/profile-report";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const digest = "a".repeat(64);

let perfCorpusBaseline: Promise<PerfCorpusReport> | undefined;

async function canonicalPerfCorpusReport(): Promise<PerfCorpusReport> {
	perfCorpusBaseline ??= (async () => {
		const benchmarkPath = path.join(repositoryRoot, "packages", "coding-agent", "bench", "perf-corpus.bench.ts");
		const child = Bun.spawn([process.execPath, benchmarkPath], {
			cwd: repositoryRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) throw new Error(`Perf-corpus fixture capture failed: ${stderr.trim()}`);
		return JSON.parse(stdout) as PerfCorpusReport;
	})();
	return await perfCorpusBaseline;
}

function profile(): CpuProfile {
	return {
		nodes: [
			{
				id: 1,
				callFrame: {
					functionName: "hotFunction",
					url: "file:///workspace/packages/coding-agent/src/hot.ts",
					lineNumber: 4,
				},
			},
			{
				id: 2,
				callFrame: {
					functionName: "otherFunction",
					url: "file:///workspace/packages/tui/src/other.ts",
					lineNumber: 8,
				},
			},
		],
		samples: [1, 1, 2],
		timeDeltas: [100, 300, 600],
		samplingInterval: 100,
	};
}

function realEntry(id: string, overrides: Partial<CorpusEntry> = {}): CorpusEntry {
	return {
		id,
		sourceClass: "sanitized-real",
		sourceSha256: digest,
		sanitizerVersion: "test-sanitizer/1",
		redactionNotes: "Test-only fixture with no transcript text.",
		file: `${id}.jsonl`,
		assistantTurns: 4,
		toolCalls: 2,
		toolKinds: ["bash", "edit", "read", "search"],
		hasCompaction: false,
		bytes: 1024,
		toolCallSeqSha256: digest,
		...overrides,
	};
}

function validManifest(): CorpusManifest {
	return {
		schema: "gjc.session-replay-corpus/1",
		sanitizerVersion: "test-sanitizer/1",
		entries: [
			realEntry("long", { assistantTurns: 50 }),
			realEntry("tools", { toolCalls: 20 }),
			realEntry("compact", { hasCompaction: true }),
		],
	};
}

function fidelity(turns = 4): ReplayFidelity {
	return {
		recordedAssistantTurns: turns,
		replayedAssistantTurns: turns,
		recordedToolCallSeqSha256: digest,
		replayedToolCallSeqSha256: digest,
		finalFrameNonEmpty: true,
	};
}

function validFidelity(): Record<string, ReplayFidelity> {
	return { long: fidelity(50), tools: fidelity(), compact: fidelity() };
}

describe("session replay profile report", () => {
	it("aggregates V8 self time by function symbol using per-sample time deltas", () => {
		const result = aggregateSelfTime(profile());
		expect(result.map(item => [item.functionName, item.selfTimeMs, item.share])).toEqual([
			["otherFunction", 0.6, 0.6],
			["hotFunction", 0.4, 0.4],
		]);
		expect(result[0]?.symbol).toBe("otherFunction@file:///workspace/packages/tui/src/other.ts:9");
	});

	it("slices sample durations by marked window boundaries", () => {
		const mark: HarnessMark = {
			scenario: "replay",
			name: "token-1",
			kind: "token-delta",
			startMs: 0.15,
			endMs: 0.75,
		};
		const result = sliceProfileByWindows(profile(), [mark]);
		expect(result[0]?.totalSelfTimeMs).toBeCloseTo(0.6);
		expect(result[0]?.functions.map(item => [item.functionName, item.selfTimeMs])).toEqual([
			["otherFunction", 0.35],
			["hotFunction", 0.25],
		]);
	});

	it("selects every function at or above the five-percent threshold", () => {
		const functions = aggregateSelfTime(profile());
		expect(selectFunctionsAtOrAboveShare(functions, 0.4).map(item => item.functionName)).toEqual([
			"otherFunction",
			"hotFunction",
		]);
		expect(selectFunctionsAtOrAboveShare(functions, 0.401).map(item => item.functionName)).toEqual(["otherFunction"]);
	});

	it("rejects synthetic-only corpora and corpora without a real compaction", () => {
		const synthetic: CorpusManifest = {
			...validManifest(),
			entries: validManifest().entries.map(entry => ({ ...entry, sourceClass: "synthetic" })),
		};
		expect(() => assertCorpusProvenance(synthetic, {})).toThrow(CorpusProvenanceInsufficient);
		const noCompaction = validManifest();
		noCompaction.entries = noCompaction.entries.map(entry => ({ ...entry, hasCompaction: false }));
		expect(() => assertCorpusProvenance(noCompaction, validFidelity())).toThrow(CorpusProvenanceInsufficient);
	});

	it("rejects a real-session replay fidelity mismatch", () => {
		const mismatched = validFidelity();
		mismatched.long = { ...fidelity(50), replayedAssistantTurns: 49 };
		expect(() => assertCorpusProvenance(validManifest(), mismatched)).toThrow(CorpusProvenanceInsufficient);
	});

	it("builds a report whose fixture projection passes the perf-corpus validator", async () => {
		const manifest = validManifest();
		const replayFidelity = validFidelity();
		const marks: HarnessMark[] = manifest.entries.map(entry => ({
			scenario: "replay",
			name: `session:${entry.id}`,
			kind: "scenario",
			sessionId: entry.id,
			startMs: 0,
			endMs: 1,
		}));
		const measurements = Object.fromEntries(
			manifest.entries.map(entry => [
				entry.id,
				{
					elapsedMs: 1,
					userMicros: 500,
					systemMicros: 100,
					rssBeforeBytes: 1_000,
					rssAfterBytes: 1_100,
				},
			]),
		);
		const report = await buildSessionReplayProfileReport({
			repositoryRoot,
			outputDirectory: path.join(repositoryRoot, ".gjc", "profiles", "test-run"),
			manifest,
			manifestSha256: digest,
			profiles: { replay: profile() },
			marks,
			replayFidelity,
			measurements,
			perfCorpusReport: await canonicalPerfCorpusReport(),
		});
		expect(validatePerfCorpusReport(report.perfCorpusReport)).toEqual({ ok: true, errors: [] });
		expect(
			report.perfCorpusReport.fixtures
				.filter(fixture => fixture.fixtureId.startsWith("replay-"))
				.map(fixture => fixture.sourceClass),
		).toEqual(manifest.entries.map(entry => entry.sourceClass));
		expect(report.scenarios.replay?.typescriptFunctionsAtFivePercent.length).toBe(2);
	});

	it("rejects output paths that escape .gjc/profiles", () => {
		expect(resolveProfileOutputPath(repositoryRoot, ".gjc/profiles/run-1", digest)).toBe(
			path.join(repositoryRoot, ".gjc", "profiles", "run-1"),
		);
		expect(() => resolveProfileOutputPath(repositoryRoot, "../outside", digest)).toThrow(/under \.gjc\/profiles/);
		expect(() => resolveProfileOutputPath(repositoryRoot, "/tmp/profile", digest)).toThrow(/under \.gjc\/profiles/);
	});

	it("compares top-function overlap independently for every scenario", () => {
		const left = {
			replay: Array.from({ length: 10 }, (_, index) => ({ symbol: `fn-${index}` })),
			tools: [{ symbol: "tools-only" }],
		};
		const right = {
			replay: Array.from({ length: 10 }, (_, index) => ({ symbol: `fn-${index + 1}` })),
			tools: [{ symbol: "other" }],
		};
		expect(compareTopFunctions(left, right)).toEqual({ replay: 9, tools: 0 });
	});
});
