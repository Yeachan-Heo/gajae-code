import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OutputSink } from "../src/session/streaming-output";

type FixtureKind = "long-lines" | "ansi-control-sixel-adjacent";

type BenchCase = {
	name: string;
	sizeBytes: number;
	kind: FixtureKind;
	warmup: number;
	iterations: number;
};

type BenchResult = BenchCase & {
	bytesProcessed: number;
	seconds: number;
	bytesPerSecond: number;
	peakHeapBytes: number;
	transientPeakHeapBytes: number;
	outputBytes: number;
	totalBytes: number;
	truncated: boolean;
	artifactBytes: number;
};

const outArg = Bun.argv.find(arg => arg.startsWith("--out="));
const outPath = outArg?.slice("--out=".length) ?? "/tmp/ug-evidence/g007/streaming-output.json";
const artifactDir = mkdtempSync("/tmp/ug-evidence/g007/streaming-bench-artifacts-");

const cases: BenchCase[] = [
	{ name: "1mb-long-lines", sizeBytes: 1 * 1024 * 1024, kind: "long-lines", warmup: 10, iterations: 10 },
	{ name: "10mb-mixed", sizeBytes: 10 * 1024 * 1024, kind: "ansi-control-sixel-adjacent", warmup: 10, iterations: 100 },
	{ name: "100mb-mixed", sizeBytes: 100 * 1024 * 1024, kind: "ansi-control-sixel-adjacent", warmup: 10, iterations: 10 },
];

function makeFixture(sizeBytes: number, kind: FixtureKind): string {
	const line =
		kind === "long-lines"
			? `${"L".repeat(4096)}\n`
			: `\x1b[31mred\x1b[0m\tcontrol\x00\x07 ${"M".repeat(2048)} \x1bP-not-sixel-q payload \x1b\\ end\n`;
	const chunks: string[] = [];
	let bytes = 0;
	const lineBytes = Buffer.byteLength(line);
	while (bytes + lineBytes <= sizeBytes) {
		chunks.push(line);
		bytes += lineBytes;
	}
	if (bytes < sizeBytes) {
		const remaining = sizeBytes - bytes;
		chunks.push("x".repeat(remaining));
	}
	return chunks.join("");
}

function samplePeak(retainedPeak: { value: number }, transientPeak: { value: number }): void {
	const transientHeap = process.memoryUsage().heapUsed;
	if (transientHeap > transientPeak.value) transientPeak.value = transientHeap;
	Bun.gc(true);
	const retainedHeap = process.memoryUsage().heapUsed;
	if (retainedHeap > retainedPeak.value) retainedPeak.value = retainedHeap;
}

async function runOnce(fixture: string): Promise<{ summaryBytes: number; totalBytes: number; truncated: boolean; artifactBytes: number }> {
	const artifactPath = join(artifactDir, `artifact-${process.pid}-${Bun.nanoseconds()}.log`);
	const sink = new OutputSink({
		artifactPath,
		artifactId: "bench-artifact",
		spillThreshold: 50 * 1024,
		headBytes: 25 * 1024,
		maxColumns: 1024,
	});
	const chunkSize = 64 * 1024;
	for (let offset = 0; offset < fixture.length; offset += chunkSize) {
		sink.push(fixture.slice(offset, offset + chunkSize));
	}
	const summary = await sink.dump();
	const summaryBytes = summary.outputBytes;
	const totalBytes = summary.totalBytes;
	const truncated = summary.truncated;
	summary.output = "";
	const artifactBytes = Bun.file(artifactPath).size;
	rmSync(artifactPath, { force: true });
	return { summaryBytes, totalBytes, truncated, artifactBytes };
}


async function benchCase(testCase: BenchCase): Promise<BenchResult> {
	const fixture = makeFixture(testCase.sizeBytes, testCase.kind);
	for (let i = 0; i < testCase.warmup; i++) await runOnce(fixture);
	Bun.gc(true);
	const retainedPeak = { value: process.memoryUsage().heapUsed };
	const transientPeak = { value: retainedPeak.value };
	const start = Bun.nanoseconds();
	let last = { summaryBytes: 0, totalBytes: 0, truncated: false, artifactBytes: 0 };
	for (let i = 0; i < testCase.iterations; i++) {
		last = await runOnce(fixture);
		samplePeak(retainedPeak, transientPeak);
	}
	const seconds = Number(Bun.nanoseconds() - start) / 1e9;
	const transientHeap = process.memoryUsage().heapUsed;
	if (transientHeap > transientPeak.value) transientPeak.value = transientHeap;
	Bun.gc(true);
	retainedPeak.value = Math.max(retainedPeak.value, process.memoryUsage().heapUsed);
	return {
		...testCase,
		bytesProcessed: testCase.sizeBytes * testCase.iterations,
		seconds,
		bytesPerSecond: (testCase.sizeBytes * testCase.iterations) / seconds,
		peakHeapBytes: retainedPeak.value,
		transientPeakHeapBytes: transientPeak.value,
		outputBytes: last.summaryBytes,
		totalBytes: last.totalBytes,
		truncated: last.truncated,
		artifactBytes: last.artifactBytes,
	};
}

const results: BenchResult[] = [];
for (const testCase of cases) {
	const result = await benchCase(testCase);
	results.push(result);
	console.log(`${result.name}: ${(result.bytesPerSecond / 1024 / 1024).toFixed(1)} MiB/s, retained peak ${(result.peakHeapBytes / 1024 / 1024).toFixed(1)} MiB, transient peak ${(result.transientPeakHeapBytes / 1024 / 1024).toFixed(1)} MiB`);
}

const payload = { createdAt: new Date().toISOString(), results };
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
rmSync(artifactDir, { recursive: true, force: true });
