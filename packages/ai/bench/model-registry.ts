import { spawnSync } from "node:child_process";
import { benchRunMetadata } from "./_meta";
import { getBundledModel, getBundledModels, getBundledProviders } from "../src/models";

const CHILD_WARMUP_ITERATIONS = 3;
const CHILD_MEASURE_ITERATIONS = 10;
const IN_PROCESS_WARMUP_ITERATIONS = 10;
const IN_PROCESS_MEASURE_ITERATIONS = 200;

interface BenchSample {
	fixture: string;
	fixtureDimensions: Record<string, number | string | boolean>;
	warmupIterations: number;
	measureIterations: number;
	samples: number[];
	medianMs: number;
	p95Ms: number;
	p99Ms: number;
	rssBeforeBytes: number;
	rssAfterBytes: number;
	heapBeforeBytes: number;
	heapAfterBytes: number;
	notes: string[];
}

interface ChildResult {
	elapsedMs: number;
	rssBytes: number;
	heapBytes: number;
	providerCount: number;
	modelCount: number;
	firstProvider: string;
	firstModel: string;
}

function forceGc(): void {
	Bun.gc?.(true);
}

function memory() {
	forceGc();
	return process.memoryUsage();
}

function percentile(samples: number[], p: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[index] ?? 0;
}

function commonIterationCount(results: BenchSample[], key: "warmupIterations" | "measureIterations"): number | null {
	const counts = new Set(results.map(result => result[key]));
	return counts.size === 1 ? results[0]?.[key] ?? null : null;
}

function childScript(): string {
	return `
const start = performance.now();
const mod = await import("${new URL("../src/models.ts", import.meta.url).href}");
const providers = mod.getBundledProviders();
const firstProvider = providers[0];
const models = mod.getBundledModels(firstProvider);
const firstModel = models[0];
if (!mod.getBundledModel(firstProvider, firstModel.id)) throw new Error("lookup failed");
const elapsedMs = performance.now() - start;
const mem = process.memoryUsage();
console.log(JSON.stringify({ elapsedMs, rssBytes: mem.rss, heapBytes: mem.heapUsed, providerCount: providers.length, modelCount: models.length, firstProvider, firstModel: firstModel.id }));
`;
}

function runColdChild(): ChildResult {
	const result = spawnSync(process.execPath, ["-e", childScript()], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`cold child failed: ${result.stderr || result.stdout}`);
	}
	const line = result.stdout.trim().split("\n").at(-1);
	if (!line) throw new Error("cold child produced no JSON");
	return JSON.parse(line) as ChildResult;
}

function benchColdImport(): BenchSample {
	for (let i = 0; i < CHILD_WARMUP_ITERATIONS; i++) runColdChild();
	const samples: number[] = [];
	const childResults: ChildResult[] = [];
	for (let i = 0; i < CHILD_MEASURE_ITERATIONS; i++) {
		const result = runColdChild();
		childResults.push(result);
		samples.push(result.elapsedMs);
	}
	console.error(`model-registry cold import: median ${percentile(samples, 50).toFixed(3)}ms`);
	return {
		fixture: "cold-import-child-process",
		fixtureDimensions: {
			childProcess: true,
			providers: childResults[0]?.providerCount ?? 0,
			firstProviderModels: childResults[0]?.modelCount ?? 0,
			firstProvider: childResults[0]?.firstProvider ?? "",
			firstModel: childResults[0]?.firstModel ?? "",
		},
		warmupIterations: CHILD_WARMUP_ITERATIONS,
		measureIterations: CHILD_MEASURE_ITERATIONS,
		samples,
		medianMs: percentile(samples, 50),
		p95Ms: percentile(samples, 95),
		p99Ms: percentile(samples, 99),
		rssBeforeBytes: childResults[0]?.rssBytes ?? 0,
		rssAfterBytes: childResults.at(-1)?.rssBytes ?? 0,
		heapBeforeBytes: childResults[0]?.heapBytes ?? 0,
		heapAfterBytes: childResults.at(-1)?.heapBytes ?? 0,
		notes: ["Uses 3 discarded warmup child spawns and 10 measured child spawns instead of 50 to keep runtime bounded."],
	};
}

const providers = getBundledProviders();
const firstProvider = providers[0];
if (!firstProvider) throw new Error("No bundled providers");
const models = getBundledModels(firstProvider as never);
const firstModel = models[0];
if (!firstModel) throw new Error(`No bundled models for ${firstProvider}`);

function time(fn: () => unknown): number {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

function benchInProcess(fixture: string, fn: () => unknown, dimensions: Record<string, number | string | boolean>): BenchSample {
	for (let i = 0; i < IN_PROCESS_WARMUP_ITERATIONS; i++) fn();
	const before = memory();
	const samples: number[] = [];
	for (let i = 0; i < IN_PROCESS_MEASURE_ITERATIONS; i++) samples.push(time(fn));
	const after = memory();
	console.error(`model-registry ${fixture}: median ${percentile(samples, 50).toFixed(6)}ms`);
	return {
		fixture,
		fixtureDimensions: dimensions,
		warmupIterations: IN_PROCESS_WARMUP_ITERATIONS,
		measureIterations: IN_PROCESS_MEASURE_ITERATIONS,
		samples,
		medianMs: percentile(samples, 50),
		p95Ms: percentile(samples, 95),
		p99Ms: percentile(samples, 99),
		rssBeforeBytes: before.rss,
		rssAfterBytes: after.rss,
		heapBeforeBytes: before.heapUsed,
		heapAfterBytes: after.heapUsed,
		notes: [],
	};
}

const cold = benchColdImport();
const firstProviderLookup = benchInProcess(
	"first-provider-lookup",
	() => getBundledModels(firstProvider as never),
	{ provider: firstProvider, modelCount: models.length },
);
const allProviderEnumeration = benchInProcess(
	"all-provider-enumeration",
	() => {
		let count = 0;
		for (const provider of getBundledProviders()) count += getBundledModels(provider as never).length;
		return count;
	},
	{ providerCount: providers.length },
);
const singleModelLookup = benchInProcess(
	"single-model-lookup",
	() => getBundledModel(firstProvider as never, firstModel.id),
	{ provider: firstProvider, model: firstModel.id },
);
const repeatedLookups = benchInProcess(
	"1000-repeated-lookups",
	() => {
		let found = 0;
		for (let i = 0; i < 1_000; i++) {
			if (getBundledModel(firstProvider as never, firstModel.id)) found++;
		}
		if (found !== 1_000) throw new Error(`Expected 1000 found models, got ${found}`);
	},
	{ provider: firstProvider, model: firstModel.id, lookupsPerSample: 1_000 },
);

const results = [cold, firstProviderLookup, allProviderEnumeration, singleModelLookup, repeatedLookups];
const aggregateSamples = results.length === 1 ? (results[0]?.samples ?? []) : null;
const aggregateWarmupIterations = commonIterationCount(results, "warmupIterations");
const aggregateMeasureIterations = commonIterationCount(results, "measureIterations");
const aggregateIterationNotes = [
	aggregateWarmupIterations === null ? "warmupIterations is null because cold child and in-process rows use heterogeneous warmup counts; see results[].warmupIterations." : undefined,
	aggregateMeasureIterations === null ? "measureIterations is null because cold child and in-process rows use heterogeneous measure counts; see results[].measureIterations." : undefined,
	aggregateSamples === null ? "samples is null because top-level output aggregates heterogeneous scenario rows; per-row results[].samples are authoritative." : undefined,
].filter((note): note is string => note !== undefined);

console.log(
	JSON.stringify(
		{
			schemaVersion: 1,
			command: "bun packages/ai/bench/model-registry.ts",
			package: "@gajae-code/ai",
			bench: "model-registry",
			fixture: "cold-import-and-registry-lookup-scenarios",
			fixtureDimensions: { providerCount: providers.length, firstProvider, firstModel: firstModel.id },
			warmupIterations: aggregateWarmupIterations,
			measureIterations: aggregateMeasureIterations,
			samples: aggregateSamples,
			medianMs: aggregateSamples === null ? null : percentile(aggregateSamples, 50),
			p95Ms: aggregateSamples === null ? null : percentile(aggregateSamples, 95),
			p99Ms: aggregateSamples === null ? null : percentile(aggregateSamples, 99),
			rssBeforeBytes: results[0]?.rssBeforeBytes ?? 0,
			rssAfterBytes: results.at(-1)?.rssAfterBytes ?? 0,
			heapBeforeBytes: results[0]?.heapBeforeBytes ?? 0,
			heapAfterBytes: results.at(-1)?.heapAfterBytes ?? 0,
			notes: ["Cold import is measured in fresh bun -e child processes because module cache prevents true in-process cold measurement.", ...aggregateIterationNotes],
			metadata: await benchRunMetadata(),
			results,
		},
		null,
		2,
	),
);
