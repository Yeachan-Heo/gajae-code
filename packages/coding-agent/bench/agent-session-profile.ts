/**
 * Profiler-backed evidence capture for the `memory-agent-session-lifecycle`
 * fixture (issue #5942).
 *
 * The base corpus runner attaches no profiler, so its agent-session RSS/heap
 * slopes cannot distinguish reachable retention from allocator high-water and
 * cannot promote any hotspot. This tool drives the same workload
 * (`createSessionWorkload`) in two phases of equal duration: a memory phase
 * with no profiler attached (memory samples before and after a forced GC, plus
 * V8 heap snapshots after warm-up and at the end), then a CPU phase under the
 * inspector profiler. It derives:
 *
 * - profiler self/total time per symbol (the `profiler-self-time` evidence class),
 * - a retention verdict that separates post-GC reachable heap from RSS,
 * - hotspot reclassifications anchored to captured profiler symbols.
 *
 * Run: `bun --smol packages/coding-agent/bench/agent-session-profile.ts [--out <dir>] [--duration-ms <n>]`
 */

import { heapStats } from "bun:jsc";
import * as fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import * as path from "node:path";
import * as url from "node:url";
import { createSessionWorkload } from "./memory-baseline-session-child";
import type { HotspotClassification, ProfilerSelfTime, ProfilerSelfTimeSample } from "./perf-corpus-schema";
import { validateHotspotClassification } from "./perf-corpus-schema";
import { resolveGitProvenance } from "./perf-corpus.bench";

export interface CpuProfileCallFrame {
	functionName: string;
	url: string;
	lineNumber: number;
}

export interface CpuProfileNode {
	id: number;
	callFrame: CpuProfileCallFrame;
	children?: number[];
}

export interface CpuProfile {
	nodes: CpuProfileNode[];
	samples: number[];
	timeDeltas: number[];
}

export interface GcSample {
	elapsedMs: number;
	iterations: number;
	preGcRssBytes: number;
	preGcHeapUsedBytes: number;
	rssBytes: number;
	heapUsedBytes: number;
	externalBytes: number;
	objectCount: number;
}

export interface ObjectTypeGrowth {
	type: string;
	earlyCount: number;
	lateCount: number;
	delta: number;
}

export type RetentionVerdict = "bounded-high-water" | "reachable-retention";

/** Reachable-heap census taken from one V8 heap snapshot. */
export interface HeapCensus {
	reachableBytes: number;
	objectTypeCounts: Readonly<Record<string, number>>;
}

export interface RetentionAnalysis {
	verdict: RetentionVerdict;
	steadyStateWindowMs: number;
	/** Growth of snapshot-reachable self size between the post-warm-up and final snapshots. */
	reachableBytesGrowth: number;
	/** `heapUsed` growth; can step up from heap-block accounting without new reachable objects. */
	postGcHeapGrowthBytes: number;
	postGcHeapSlopeBytesPerSecond: number;
	postGcObjectCountGrowth: number;
	peakRssBytes: number;
	finalRssBytes: number;
	rssSlopeBytesPerSecond: number;
	/** Object types whose post-GC count grew across the steady-state window; the retention sites when retained. */
	growingObjectTypes: ObjectTypeGrowth[];
}

/** Hotspot → profile symbol names that prove the fixture exercised its owning path. */
export const AGENT_SESSION_HOTSPOT_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
	M01: ["#appendEntry", "#appendEntryWithinPersistenceFence"],
	M02: ["getEntries", "#getMaterializedEntriesInternal"],
	M03: ["buildDisplaySessionContext"],
	M04: ["toMessages", "cloneJson"],
	M05: ["captureState", "restoreState"],
	H10: ["messagesChanged"],
};

/** Minimum inclusive share of profiled time before a symbol counts as a CPU hotspot. */
export const CONFIRMED_TOTAL_TIME_FRACTION = 0.05;
/** Reachable growth across the steady-state window tolerated as noise: max(1 MiB, 5% of the window start). */
const RETAINED_HEAP_ABSOLUTE_TOLERANCE_BYTES = 1024 * 1024;
const RETAINED_RELATIVE_TOLERANCE = 0.05;

function symbolOf(frame: CpuProfileCallFrame, repositoryRoot: string): string {
	const name = frame.functionName || "(anonymous)";
	if (!frame.url) return name;
	const location = frame.url.startsWith("file://") ? url.fileURLToPath(frame.url) : frame.url;
	const file = location.startsWith(repositoryRoot) ? path.relative(repositoryRoot, location) : location;
	return `${name} (${file}:${frame.lineNumber + 1})`;
}

/**
 * Attribute sampled time to symbols. Self time goes to the sampled leaf; total
 * time goes once to every distinct symbol on the sampled stack, so recursion is
 * not double-counted.
 */
export function summarizeCpuProfile(profile: CpuProfile, repositoryRoot: string): ProfilerSelfTimeSample[] {
	const nodes = new Map<number, CpuProfileNode>();
	const parents = new Map<number, number>();
	for (const node of profile.nodes) {
		nodes.set(node.id, node);
		for (const child of node.children ?? []) parents.set(child, node.id);
	}
	const selfMicros = new Map<string, number>();
	const totalMicros = new Map<string, number>();
	for (let index = 0; index < profile.samples.length; index++) {
		const delta = profile.timeDeltas[index] ?? 0;
		let id: number | undefined = profile.samples[index];
		const leaf = id === undefined ? undefined : nodes.get(id);
		if (!leaf) continue;
		const leafSymbol = symbolOf(leaf.callFrame, repositoryRoot);
		selfMicros.set(leafSymbol, (selfMicros.get(leafSymbol) ?? 0) + delta);
		const onStack = new Set<string>();
		while (id !== undefined) {
			const node = nodes.get(id);
			if (!node) break;
			const symbol = symbolOf(node.callFrame, repositoryRoot);
			if (!onStack.has(symbol)) {
				onStack.add(symbol);
				totalMicros.set(symbol, (totalMicros.get(symbol) ?? 0) + delta);
			}
			id = parents.get(id);
		}
	}
	return [...totalMicros.entries()]
		.filter(([symbol]) => !symbol.startsWith("(root)") && !symbol.startsWith("(program)") && !symbol.startsWith("(idle)"))
		.map(([symbol, total]) => ({
			symbol,
			selfTimeMs: (selfMicros.get(symbol) ?? 0) / 1_000,
			totalTimeMs: total / 1_000,
		}))
		.sort((a, b) => b.totalTimeMs - a.totalTimeMs || a.symbol.localeCompare(b.symbol));
}

function slopePerSecond(first: GcSample, last: GcSample, key: "heapUsedBytes" | "rssBytes"): number {
	const seconds = (last.elapsedMs - first.elapsedMs) / 1_000;
	return seconds > 0 ? (last[key] - first[key]) / seconds : 0;
}

/** Sum node self sizes of a V8-format heap snapshot (everything in it is reachable). */
export function heapSnapshotReachableBytes(snapshotJson: string): number {
	const snapshot = JSON.parse(snapshotJson) as { snapshot: { meta: { node_fields: string[] } }; nodes: number[] };
	const fields = snapshot.snapshot.meta.node_fields;
	const sizeOffset = fields.indexOf("self_size");
	if (sizeOffset < 0 || fields.length === 0) throw new Error("heap snapshot has no self_size node field");
	let total = 0;
	for (let index = sizeOffset; index < snapshot.nodes.length; index += fields.length) total += snapshot.nodes[index] ?? 0;
	return total;
}

/**
 * Separate reachable retention from allocator high-water. Warm-up (the first
 * quarter of the run) is excluded. Retention is judged from snapshot-reachable
 * bytes and live object counts: never from RSS, which keeps allocator pages the
 * process already released, and never from `heapUsed` alone, which counts
 * retained heap blocks rather than reachable objects.
 */
export function analyzeRetention(samples: readonly GcSample[], early: HeapCensus, late: HeapCensus): RetentionAnalysis {
	const first = samples[0];
	const last = samples.at(-1);
	if (!first || !last || samples.length < 3) throw new Error("retention analysis needs at least three GC samples");
	const warmupCutoffMs = first.elapsedMs + (last.elapsedMs - first.elapsedMs) / 4;
	const steady = samples.filter(sample => sample.elapsedMs >= warmupCutoffMs);
	const steadyFirst = steady[0] ?? first;
	const reachableGrowth = late.reachableBytes - early.reachableBytes;
	const objectGrowth = last.objectCount - steadyFirst.objectCount;
	const reachableTolerance = Math.max(RETAINED_HEAP_ABSOLUTE_TOLERANCE_BYTES, early.reachableBytes * RETAINED_RELATIVE_TOLERANCE);
	const objectTolerance = steadyFirst.objectCount * RETAINED_RELATIVE_TOLERANCE;
	const growingObjectTypes = Object.entries(late.objectTypeCounts)
		.map(([type, lateCount]) => {
			const earlyCount = early.objectTypeCounts[type] ?? 0;
			return { type, earlyCount, lateCount, delta: lateCount - earlyCount };
		})
		.filter(growth => growth.delta > 0)
		.sort((a, b) => b.delta - a.delta || a.type.localeCompare(b.type))
		.slice(0, 10);
	return {
		verdict:
			reachableGrowth > reachableTolerance || objectGrowth > objectTolerance ? "reachable-retention" : "bounded-high-water",
		steadyStateWindowMs: last.elapsedMs - steadyFirst.elapsedMs,
		reachableBytesGrowth: reachableGrowth,
		postGcHeapGrowthBytes: last.heapUsedBytes - steadyFirst.heapUsedBytes,
		postGcHeapSlopeBytesPerSecond: slopePerSecond(steadyFirst, last, "heapUsedBytes"),
		postGcObjectCountGrowth: objectGrowth,
		peakRssBytes: Math.max(...samples.map(sample => Math.max(sample.rssBytes, sample.preGcRssBytes))),
		finalRssBytes: last.rssBytes,
		rssSlopeBytesPerSecond: slopePerSecond(steadyFirst, last, "rssBytes"),
		growingObjectTypes,
	};
}

function hotspotSample(hotspotId: string, samples: readonly ProfilerSelfTimeSample[]): ProfilerSelfTimeSample | undefined {
	const names = AGENT_SESSION_HOTSPOT_SYMBOLS[hotspotId] ?? [];
	return samples
		.filter(sample => names.some(name => sample.symbol === name || sample.symbol.startsWith(`${name} (`)))
		.sort((a, b) => (b.totalTimeMs ?? 0) - (a.totalTimeMs ?? 0))[0];
}

/**
 * Reclassify the agent-session hotspots from captured evidence. A hotspot whose
 * owning symbol carries at least {@link CONFIRMED_TOTAL_TIME_FRACTION} of the
 * profiled time is `CPU-self-time confirmed` and references that exact sample
 * symbol; an exercised hotspot below the threshold is `not-visible`; a hotspot
 * whose symbols never appear was not exercised and `needs-trace-coverage`.
 */
export function reclassifyAgentSessionHotspots(
	samples: readonly ProfilerSelfTimeSample[],
	profiledMs: number,
	retention: RetentionAnalysis,
	cpuProfileRef: string,
): HotspotClassification[] {
	const retentionNote =
		retention.verdict === "bounded-high-water"
			? `reachable heap bounded (${formatBytes(retention.reachableBytesGrowth)} over ${Math.round(retention.steadyStateWindowMs)} ms steady state); RSS growth is allocator high-water`
			: `reachable heap retained ${formatBytes(retention.reachableBytesGrowth)}; growing types: ${retention.growingObjectTypes
					.slice(0, 3)
					.map(growth => growth.type)
					.join(", ")}`;
	return Object.keys(AGENT_SESSION_HOTSPOT_SYMBOLS).map(hotspotId => {
		const sample = hotspotSample(hotspotId, samples);
		if (!sample) {
			return {
				hotspotId,
				status: "needs-trace-coverage",
				evidenceClass: "profiler-self-time",
				artifactRefs: [cpuProfileRef],
				notes: "owning symbols absent from the agent-session-lifecycle CPU profile; this fixture does not exercise the path",
			};
		}
		const share = (sample.totalTimeMs ?? 0) / Math.max(profiledMs, 1e-6);
		const measured = `${(share * 100).toFixed(1)}% total / ${sample.selfTimeMs.toFixed(1)} ms self`;
		if (share < CONFIRMED_TOTAL_TIME_FRACTION) {
			return {
				hotspotId,
				status: "not-visible",
				evidenceClass: "profiler-self-time",
				artifactRefs: [sample.symbol, cpuProfileRef],
				notes: `profiled below the ${CONFIRMED_TOTAL_TIME_FRACTION * 100}% threshold (${measured}); ${retentionNote}`,
			};
		}
		return {
			hotspotId,
			status: "CPU-self-time confirmed",
			evidenceClass: "profiler-self-time",
			artifactRefs: [sample.symbol, cpuProfileRef],
			notes: `${measured} of agent-session-lifecycle CPU; ${retentionNote}`,
		};
	});
}

function formatBytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export interface AgentSessionProfileReport {
	schema: "gjc.agent-session-profile/1";
	fixtureId: "memory-agent-session-lifecycle";
	generatedAt: string;
	gitSha: string;
	gitDirty: boolean;
	platform: NodeJS.Platform;
	arch: string;
	bunVersion: string;
	command: string;
	durationMs: number;
	iterations: number;
	profiledMs: number;
	artifacts: { cpuProfile: string; earlyHeapSnapshot: string; lateHeapSnapshot: string };
	gcSamples: GcSample[];
	retention: RetentionAnalysis;
	/** Drop-in `profilerSelfTime` for the corpus fixture; its samples cover every classification ref. */
	profilerSelfTime: ProfilerSelfTime;
	hotspotClassifications: HotspotClassification[];
}

/** Top symbols by total time, plus any symbol a classification references. */
const REPORTED_SYMBOL_COUNT = 40;

interface CaptureOptions {
	outDir: string;
	durationMs: number;
	sampleIntervalMs: number;
}

function gcSample(startedAt: number, iterations: number): GcSample {
	const before = process.memoryUsage();
	Bun.gc(true);
	const after = process.memoryUsage();
	return {
		elapsedMs: performance.now() - startedAt,
		iterations,
		preGcRssBytes: before.rss,
		preGcHeapUsedBytes: before.heapUsed,
		rssBytes: after.rss,
		heapUsedBytes: after.heapUsed,
		externalBytes: after.external,
		objectCount: heapStats().objectCount,
	};
}

async function writeHeapCensus(snapshotPath: string): Promise<HeapCensus> {
	const objectTypeCounts = { ...heapStats().objectTypeCounts };
	const snapshot = Bun.generateHeapSnapshot("v8");
	await Bun.write(snapshotPath, snapshot);
	return { reachableBytes: heapSnapshotReachableBytes(snapshot), objectTypeCounts };
}

export async function captureAgentSessionProfile(options: CaptureOptions): Promise<AgentSessionProfileReport> {
	const repositoryRoot = path.resolve(import.meta.dir, "../../..");
	const git = resolveGitProvenance();
	await fs.mkdir(options.outDir, { recursive: true });
	const artifacts = {
		cpuProfile: path.join(options.outDir, "agent-session-lifecycle.cpuprofile"),
		earlyHeapSnapshot: path.join(options.outDir, "agent-session-lifecycle.early.heapsnapshot"),
		lateHeapSnapshot: path.join(options.outDir, "agent-session-lifecycle.late.heapsnapshot"),
	};
	// Memory phase runs without the CPU profiler: the inspector's sample buffer
	// lives on the JS heap and would otherwise read as post-GC growth.
	const memoryWorkload = createSessionWorkload();
	const startedAt = performance.now();
	const earlySnapshotAtMs = options.durationMs / 4;
	const samples: GcSample[] = [gcSample(startedAt, 0)];
	let early: HeapCensus | undefined;
	let iterations = 0;
	let nextSampleAtMs = options.sampleIntervalMs;
	while (performance.now() - startedAt < options.durationMs) {
		memoryWorkload.run(1);
		iterations++;
		const elapsedMs = performance.now() - startedAt;
		if (elapsedMs < nextSampleAtMs) continue;
		nextSampleAtMs = elapsedMs + options.sampleIntervalMs;
		samples.push(gcSample(startedAt, iterations));
		if (!early && elapsedMs >= earlySnapshotAtMs) early = await writeHeapCensus(artifacts.earlyHeapSnapshot);
	}
	samples.push(gcSample(startedAt, iterations));
	const late = await writeHeapCensus(artifacts.lateHeapSnapshot);
	memoryWorkload.teardown();
	if (!early) throw new Error("run ended before the post-warm-up heap snapshot; raise --duration-ms");

	const cpuWorkload = createSessionWorkload();
	const session = new Session();
	session.connect();
	await session.post("Profiler.enable");
	await session.post("Profiler.setSamplingInterval", { interval: 500 });
	await session.post("Profiler.start");
	const cpuStartedAt = performance.now();
	while (performance.now() - cpuStartedAt < options.durationMs) cpuWorkload.run(1);
	const stopped = await session.post("Profiler.stop");
	await session.post("Profiler.disable");
	session.disconnect();
	cpuWorkload.teardown();
	const profile = stopped.profile as unknown as CpuProfile;
	await Bun.write(artifacts.cpuProfile, JSON.stringify(profile));

	const symbols = summarizeCpuProfile(profile, repositoryRoot);
	const profiledMs = profile.timeDeltas.reduce((sum, delta) => sum + delta, 0) / 1_000;
	const retention = analyzeRetention(samples, early, late);
	const cpuProfileRef = path.relative(repositoryRoot, artifacts.cpuProfile);
	const hotspotClassifications = reclassifyAgentSessionHotspots(symbols, profiledMs, retention, cpuProfileRef);
	const classificationErrors = hotspotClassifications.flatMap(validateHotspotClassification);
	if (classificationErrors.length > 0) throw new Error(classificationErrors.join("\n"));
	return {
		schema: "gjc.agent-session-profile/1",
		fixtureId: "memory-agent-session-lifecycle",
		generatedAt: new Date().toISOString(),
		gitSha: git.sha,
		gitDirty: git.dirty,
		platform: process.platform,
		arch: process.arch,
		bunVersion: Bun.version,
		command: `bun --smol packages/coding-agent/bench/agent-session-profile.ts --duration-ms ${options.durationMs}`,
		durationMs: options.durationMs,
		iterations,
		profiledMs,
		artifacts: {
			cpuProfile: cpuProfileRef,
			earlyHeapSnapshot: path.relative(repositoryRoot, artifacts.earlyHeapSnapshot),
			lateHeapSnapshot: path.relative(repositoryRoot, artifacts.lateHeapSnapshot),
		},
		gcSamples: samples,
		retention,
		profilerSelfTime: {
			profiler: "bun",
			artifactPath: cpuProfileRef,
			samples: symbols.filter(
				(sample, index) =>
					index < REPORTED_SYMBOL_COUNT || hotspotClassifications.some(c => c.artifactRefs.includes(sample.symbol)),
			),
		},
		hotspotClassifications,
	};
}

function parseArgs(argv: readonly string[]): CaptureOptions {
	const repositoryRoot = path.resolve(import.meta.dir, "../../..");
	const options: CaptureOptions = {
		outDir: path.join(repositoryRoot, "artifacts", "perf", "agent-session-profile"),
		durationMs: 30_000,
		sampleIntervalMs: 1_000,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = argv[index + 1];
		if (arg === "--out" && value) {
			options.outDir = path.resolve(value);
		} else if (arg === "--duration-ms" && value && Number.isSafeInteger(Number(value)) && Number(value) >= 2_000) {
			options.durationMs = Number(value);
		} else if (arg === "--sample-interval-ms" && value && Number.isSafeInteger(Number(value)) && Number(value) >= 50) {
			options.sampleIntervalMs = Number(value);
		} else {
			throw new Error(`invalid argument ${arg}${value === undefined ? "" : ` ${value}`}; expected --out <dir>, --duration-ms <>=2000>, --sample-interval-ms <>=50>`);
		}
		index++;
	}
	return options;
}

if (import.meta.main) {
	const report = await captureAgentSessionProfile(parseArgs(Bun.argv.slice(2)));
	const reportPath = path.join(path.resolve(import.meta.dir, "../../.."), path.dirname(report.artifacts.cpuProfile), "agent-session-profile.json");
	await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ report: reportPath, retention: report.retention, hotspotClassifications: report.hotspotClassifications }, null, 2)}\n`);
}
