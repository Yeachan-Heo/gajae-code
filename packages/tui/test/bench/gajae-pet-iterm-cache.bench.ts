import type { GajaeGifTimeline, PetSkinId } from "@gajae-code/tui";
import {
	burstTimeline,
	encodeGajaePetGif,
	getGajaePetGifCached,
	getGajaePetGifCacheStats,
	idleTimeline,
	previewTimeline,
	resetGajaePetGifCache,
	workingTimeline,
} from "@gajae-code/tui";

const MAX_ENTRIES = 32;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const iterations = Number(process.env.GAJAE_BENCH_ITERATIONS ?? 100);
if (!Number.isInteger(iterations) || iterations < 1) throw new Error("iterations must be a positive integer");

const modes: Array<readonly [string, (skin?: PetSkinId) => GajaeGifTimeline]> = [
	["idle", idleTimeline],
	["working", workingTimeline],
	["burst", burstTimeline],
	["preview", previewTimeline],
];
const metrics = [
	["default", 9, 18, 2],
	["enlarged", 12, 24, 3],
] as const;
const matrix: Array<Record<string, unknown>> = [];
const cases: Array<{ options: Parameters<typeof getGajaePetGifCached>[0] }> = [];
resetGajaePetGifCache();

for (const skin of ["red", "blue"] as const) {
	for (const [mode, timeline] of modes) {
		for (const [metric, cellWidthPx, cellHeightPx, targetRows] of metrics) {
			const options = {
				skin,
				timeline: timeline(skin),
				cellWidthPx,
				cellHeightPx,
				targetRows,
			};
			const direct = encodeGajaePetGif(options);
			const first = getGajaePetGifCached(options);
			const second = getGajaePetGifCached(options);
			if (first.base64 !== second.base64 || first.bytes.byteLength !== second.bytes.byteLength) {
				throw new Error(`nondeterministic output: ${skin}/${mode}/${metric}`);
			}
			const directMultipartBytes = direct.multipart.reduce((sum, record) => sum + Buffer.byteLength(record), 0);
			const directTmuxDcsBytes = direct.tmuxDcs.reduce((sum, record) => sum + Buffer.byteLength(record), 0);
			matrix.push({
				skin,
				mode,
				metric,
				direct: {
					gifBytes: direct.bytes.byteLength,
					multipartBytes: directMultipartBytes,
					tmuxDcsBytes: directTmuxDcsBytes,
					combinedBytes: direct.bytes.byteLength + directMultipartBytes + directTmuxDcsBytes,
				},
				managed: {
					gifBytes: first.bytes.byteLength,
					multipartBytes: first.multipart.reduce((sum, record) => sum + Buffer.byteLength(record), 0),
					tmuxDcsBytes: first.tmuxDcs.reduce((sum, record) => sum + Buffer.byteLength(record), 0),
					combinedBytes:
						first.bytes.byteLength +
						first.multipart.reduce((sum, record) => sum + Buffer.byteLength(record), 0) +
						first.tmuxDcs.reduce((sum, record) => sum + Buffer.byteLength(record), 0),
				},
			});
			cases.push({ options });
		}
	}
}

const percentile = (samples: number[], rank: number): number => {
	const sorted = [...samples].sort((a, b) => a - b);
	const position = (sorted.length - 1) * rank;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};
const coldSamples: number[] = [];
resetGajaePetGifCache();
for (const { options } of cases) {
	const started = performance.now();
	getGajaePetGifCached(options);
	coldSamples.push(performance.now() - started);
}
const warmSamples: number[] = [];
for (let i = 0; i < iterations; i++) {
	const started = performance.now();
	getGajaePetGifCached(cases[i % cases.length].options);
	warmSamples.push(performance.now() - started);
}
const evictionCases = Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => ({
	...cases[index % cases.length].options,
	cellWidthPx: 9 + index,
}));
resetGajaePetGifCache();
for (const options of evictionCases) getGajaePetGifCached(options);
const stats = getGajaePetGifCacheStats();
const evictedArtifact = getGajaePetGifCached(evictionCases[0]);
const reusedArtifact = getGajaePetGifCached(evictionCases[0]);
if (evictedArtifact !== reusedArtifact) throw new Error("cache reuse was not deterministic");
const componentBytes = stats.gifBytes + stats.multipartBytes + stats.tmuxDcsBytes;
if (
	stats.size !== MAX_ENTRIES ||
	stats.bytes !== componentBytes ||
	stats.bytes > MAX_RETAINED_BYTES ||
	stats.evictions < 1
)
	throw new Error("cache capacity, combined retained bytes, or eviction was not exercised");
const p50BuildMs = percentile(coldSamples, 0.5);
const p95BuildMs = percentile(coldSamples, 0.95);
const warmHitP50Ms = percentile(warmSamples, 0.5);
if (![p50BuildMs, p95BuildMs, warmHitP50Ms].every(value => Number.isFinite(value) && value > 0))
	throw new Error("invalid timing metrics");
console.log(
	JSON.stringify({
		matrix,
		cache: {
			combinedRetainedBytes: stats.bytes,
			gifBytes: stats.gifBytes,
			multipartBytes: stats.multipartBytes,
			tmuxDcsBytes: stats.tmuxDcsBytes,
			evictionCount: stats.evictions,
			size: stats.size,
		},
		p50BuildMs,
		p95BuildMs,
		coldBuildP50Ms: p50BuildMs,
		coldBuildP95Ms: p95BuildMs,
		warmHitP50Ms,
		artifactBytes: matrix.reduce((n, m) => n + Number((m.direct as { combinedBytes: number }).combinedBytes), 0),
		retainedBytes: stats.bytes,
		evictionCount: stats.evictions,
		maxEntries: MAX_ENTRIES,
		maxRetainedBytes: MAX_RETAINED_BYTES,
	}),
);
