import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

interface ProbeNative {
	astGrep(options: Record<string, unknown>): Promise<unknown>;
	fuzzyFind(options: Record<string, unknown>): Promise<unknown>;
	glob(
		options: Record<string, unknown>,
		onMatch?: (error: Error | null, match: unknown) => void,
	): Promise<unknown>;
	grep(
		options: Record<string, unknown>,
		onMatch?: (error: Error | null, match: unknown) => void,
	): Promise<unknown>;
	invalidateFsScanCache(path: string): void;
}

const require = createRequire(import.meta.url);
const nativePath = process.env.PROBE_NATIVE ?? path.resolve(import.meta.dir, "../packages/natives/native/index.js");
const { astGrep, fuzzyFind, glob, grep, invalidateFsScanCache } = require(nativePath) as ProbeNative;
const nativeBinaryPath = process.env.PROBE_NATIVE_BINARY
	?? path.join(path.dirname(nativePath), `pi_natives.${process.platform}-${process.arch}.node`);

function resultCount(value: unknown): number {
	if (Array.isArray(value)) {
		return value.length;
	}
	if (value !== null && typeof value === "object") {
		for (const nested of Object.values(value)) {
			if (Array.isArray(nested)) {
				return nested.length;
			}
		}
	}
	return 0;
}

const mode = process.env.PROBE_MODE ?? "success";
const consumer = process.env.PROBE_CONSUMER ?? "all";
const fileCount = Number(process.env.PROBE_FILES ?? "2000");
const effectiveConfiguration = {
	FS_SCAN_MAX_ENTRIES: process.env.FS_SCAN_MAX_ENTRIES ?? "default:250000",
	FS_SCAN_MAX_BYTES: process.env.FS_SCAN_MAX_BYTES ?? "default:67108864",
	FS_SCAN_CACHE_MAX_ENTRIES: process.env.FS_SCAN_CACHE_MAX_ENTRIES ?? "default:16",
	FS_SCAN_CACHE_MAX_BYTES: process.env.FS_SCAN_CACHE_MAX_BYTES ?? "default:134217728",
	FS_SCAN_CACHE_TTL_MS: process.env.FS_SCAN_CACHE_TTL_MS ?? "default:1000",
};
const iterations = Number(process.env.PROBE_ITERATIONS ?? "20");
const pathPadding = "p".repeat(Number(process.env.PROBE_PATH_PADDING ?? "0"));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-3769-probe-"));

try {
	for (let start = 0; start < fileCount; start += 200) {
		await Promise.all(
			Array.from({ length: Math.min(200, fileCount - start) }, (_, offset) => {
				const index = start + offset;
				const name = `file-${index.toString().padStart(5, "0")}-${pathPadding}.ts`;
				return fs.writeFile(path.join(root, name), `const value${index} = "needle";\n`);
			}),
		);
	}
	const allMatches = mode === "consumer";

	const operations = {
		glob: () => glob({ pattern: "**/*.ts", path: root, hidden: true, gitignore: false, cache: true }),
		fuzzyFind: () => fuzzyFind({ query: "file", path: root, hidden: true, gitignore: false, cache: true, maxResults: allMatches ? fileCount : 20 }),
		astGrep: () => astGrep({ patterns: ["const $A = $B"], path: root, glob: "**/*.ts", limit: allMatches ? fileCount : 20 }),
		grep: () => grep({ pattern: "needle", path: root, glob: "**/*.ts", hidden: true, gitignore: false, cache: true, maxCount: allMatches ? fileCount : 20 }),
	};
	const selected = consumer === "all"
		? Object.entries(operations)
		: [[consumer, operations[consumer as keyof typeof operations]]] as const;
	if (selected.some(([, operation]) => operation === undefined)) {
		throw new Error(`unknown PROBE_CONSUMER: ${consumer}`);
	}

	Bun.gc(true);
	const baselineRss = process.memoryUsage.rss();
	const rss: number[] = [];
	const durationsMs: number[] = [];
	const errors: string[] = [];
	const consumerSamples: Array<{ consumer: string; retainedResults: number; rssBefore: number; rssWithResult: number; rssAfterDrain: number }> = [];
	const callbackSamples: Array<{
		callbacks: number;
		callbackErrors: number;
		expectedCallbacks: number;
		rssBefore: number;
		rssWithResult: number;
		rssAfterDrain: number;
	}> = [];

	if (mode === "concurrent") {
		const started = performance.now();
		await Promise.all(Array.from({ length: 4 }, () => glob({ pattern: "**/*.ts", path: root, hidden: true, gitignore: false, cache: false })));
		durationsMs.push(performance.now() - started);
		Bun.gc(true);
		rss.push(process.memoryUsage.rss());
	} else if (mode === "callback") {
		Bun.gc(true);
		const rssBefore = process.memoryUsage.rss();
		let callbacks = 0;
		let callbackErrors = 0;
		let result = await glob(
			{ pattern: "**/*.ts", path: root, hidden: true, gitignore: false, cache: true },
			(error) => {
				if (error) {
					callbackErrors += 1;
				} else {
					callbacks += 1;
				}
			},
		);
		const expectedCallbacks = resultCount(result);
		const callbackDeadline = performance.now() + 5_000;
		while (callbacks + callbackErrors < expectedCallbacks && performance.now() < callbackDeadline) {
			await Bun.sleep(1);
		}
		const rssWithResult = process.memoryUsage.rss();
		result = undefined;
		invalidateFsScanCache(root);
		Bun.gc(true);
		const rssAfterDrain = process.memoryUsage.rss();
		callbackSamples.push({
			callbacks,
			callbackErrors,
			expectedCallbacks,
			rssBefore,
			rssWithResult,
			rssAfterDrain,
		});
		rss.push(rssWithResult, rssAfterDrain);
	} else if (mode === "consumer") {
		for (const [name, operation] of selected) {
			invalidateFsScanCache(root);
			Bun.gc(true);
			const rssBefore = process.memoryUsage.rss();
			let result: unknown;
			try {
				result = await operation!();
			} catch (error) {
				errors.push(String(error));
			}
			const rssWithResult = process.memoryUsage.rss();
			const retainedResults = resultCount(result);
			result = undefined;
			invalidateFsScanCache(root);
			Bun.gc(true);
			const rssAfterDrain = process.memoryUsage.rss();
			consumerSamples.push({ consumer: name, retainedResults, rssBefore, rssWithResult, rssAfterDrain });
			rss.push(rssWithResult, rssAfterDrain);
		}
	} else {
		for (const [, operation] of selected) {
			try {
				await operation!();
			} catch (error) {
				errors.push(String(error));
			}
			if (mode !== "warm") {
				invalidateFsScanCache(root);
			}
		}
		for (let iteration = 0; iteration < iterations; iteration++) {
			const started = performance.now();
			try {
				await glob({ pattern: "**/*.ts", path: root, hidden: true, gitignore: false, cache: true });
			} catch (error) {
				errors.push(String(error));
			}
			durationsMs.push(performance.now() - started);
			if (mode !== "warm") {
				invalidateFsScanCache(root);
			}
			Bun.gc(true);
			rss.push(process.memoryUsage.rss());
		}
	}

	const firstFive = rss.slice(0, 5).sort((a, b) => a - b);
	const lastFive = rss.slice(-5).sort((a, b) => a - b);
	const median = (values: number[]) => values.length === 0 ? 0 : values[Math.floor(values.length / 2)]!;
	const n = rss.length;
	const meanX = n === 0 ? 0 : (n - 1) / 2;
	const meanY = n === 0 ? 0 : rss.reduce((sum, value) => sum + value, 0) / n;
	let numerator = 0;
	let denominator = 0;
	for (let index = 0; index < n; index++) {
		numerator += (index - meanX) * (rss[index]! - meanY);
		denominator += (index - meanX) ** 2;
	}
	const slopeBytesPerIteration = denominator === 0 ? 0 : numerator / denominator;
	const nativeBinaryHash =
		`sha256:${createHash("sha256").update(await fs.readFile(nativeBinaryPath)).digest("hex")}`;
	console.log(JSON.stringify({
		mode,
		nativePath,
		nativeBinaryPath,
		nativeBinaryHash,
		effectiveConfiguration,
		consumer,
		fileCount,
		pathPadding: pathPadding.length,
		iterations,
		baselineRss,
		peakRss: Math.max(baselineRss, ...rss),
		peakDeltaBytes: Math.max(0, Math.max(baselineRss, ...rss) - baselineRss),
		slopeBytesPerIteration,
		lastFiveMinusFirstFiveMedianBytes: median(lastFive) - median(firstFive),
		durationsMs,
		consumerSamples,
		callbackSamples,
		errorCount: errors.length,
		errorSamples: [...new Set(errors)].slice(0, 5),
	}));
} finally {
	await fs.rm(root, { recursive: true, force: true });
}
