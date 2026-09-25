import { generateDiffString, replaceText } from "../../coding-agent/src/edit/diff";
import { findMatch, seekSequence } from "../../coding-agent/src/edit/modes/replace";
import { formatHashLine, formatHashLines } from "../../coding-agent/src/hashline/hash";

const DEFAULT_ITERATIONS = Number(Bun.env.EDIT_HOTSPOTS_BENCH_ITERATIONS ?? "200");
const WARMUP = Number(Bun.env.EDIT_HOTSPOTS_BENCH_WARMUP ?? "100");
const PASS_SPEEDUP = 2;
const SCHEMA = "gjc.native-bench-ab/1";

type CandidateId = "H01" | "H02" | "H06";
type BenchValue = unknown;
type BenchFn = () => BenchValue;

interface Candidate {
	id: CandidateId;
	name: string;
	fixture: string;
	dimensions: Record<string, number | string>;
	baselineFn: BenchFn;
	nativeExportNames: string[];
	nativeArgs: unknown[];
}

interface Timing {
	median: number;
	p95: number;
}

const longLine = `${"x".repeat(2048)} needle ${"y".repeat(2048)}`;
const editLines = Array.from({ length: 1400 }, (_, index) => {
	if (index === 740) return "    return alphaBetaGamma(value, options);";
	if (index === 1180) return longLine;
	return `line ${index.toString().padStart(4, "0")} :: ${index % 17 === 0 ? "unicode – café 👩‍💻" : "plain text"}`;
});
const editContent = editLines.join("\n");
const h01Target = "    return alphaBetaGamme(value, options);";
const h02Replacement = "    return nativeCandidate(value, options);";
const hashText = Array.from({ length: 2500 }, (_, index) => {
	if (index % 97 === 0) return "";
	if (index % 89 === 0) return `tabs\tand unicode “quotes” ${index}`;
	if (index % 83 === 0) return `${"z".repeat(1024)} ${index}`;
	return `hash line ${index} trailing   `;
}).join("\n");

function formatHashLinesTsBaseline(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines.map((line, i) => formatHashLine(startLine + i, line)).join("\n");
}

const candidates: Candidate[] = [
	{
		id: "H01",
		name: "findMatch fuzzy hotspot",
		fixture: "multi-line edit corpus",
		dimensions: { lines: editLines.length, bytes: Buffer.byteLength(editContent), targetBytes: Buffer.byteLength(h01Target) },
		baselineFn: () => findMatch(editContent, h01Target, { allowFuzzy: true, threshold: 0.9 }),
		nativeExportNames: ["h01FindBestFuzzyMatch"],
		nativeArgs: [editContent, h01Target, 0.9],
	},
	{
		id: "H02",
		name: "replaceText + seekSequence hotspot",
		fixture: "patch/replace corpus",
		dimensions: { lines: editLines.length, bytes: Buffer.byteLength(editContent), patternLines: 1 },
		baselineFn: () => {
			const replaced = replaceText(editContent, "    return alphaBetaGamma(value, options);", h02Replacement, { fuzzy: true, all: false });
			const sequence = seekSequence(editLines, ["    return alphaBetaGamme(value, options);"], 0, false, { allowFuzzy: true });
			return { replaced, sequence };
		},
		nativeExportNames: ["h02ScoreSequenceFuzzy"],
		nativeArgs: [editLines, [h01Target], 0, false],
	},
	{
		id: "H06",
		name: "formatHashLines hotspot",
		fixture: "hashline display corpus",
		dimensions: { lines: hashText.split("\n").length, bytes: Buffer.byteLength(hashText), startLine: 37 },
		baselineFn: () => formatHashLinesTsBaseline(hashText, 37),
		nativeExportNames: ["h06FormatHashLines", "formatHashLinesNative", "formatHashLines"],
		nativeArgs: [hashText, 37],
	},
];

function stats(samples: number[]): Timing {
	const sorted = [...samples].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
	const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? median;
	return { median, p95 };
}

function timeSamples(fn: BenchFn, iterations: number): number[] {
	const samples: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const start = Bun.nanoseconds();
		void fn();
		samples.push((Bun.nanoseconds() - start) / 1e6);
	}
	return samples;
}

function time(fn: BenchFn, iterations: number): Timing {
	return stats(timeSamples(fn, iterations));
}

async function resolveNative(candidate: Candidate): Promise<BenchFn | undefined> {
	let nativeModule: Record<string, unknown>;
	try {
		nativeModule = await import("../native/index.js");
	} catch {
		return undefined;
	}
	for (const exportName of candidate.nativeExportNames) {
		const nativeFn = nativeModule[exportName];
		if (typeof nativeFn === "function") return () => nativeFn(...candidate.nativeArgs);
	}
	return undefined;
}

function parseCli(args: string[]): { json: boolean; strict: boolean; iterations: number } {
	let json = false;
	let strict = false;
	let iterations = DEFAULT_ITERATIONS;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--json") json = true;
		else if (arg === "--strict") strict = true;
		else if (arg === "--iterations") {
			const count = Number(args[index + 1]);
			if (!Number.isInteger(count) || count < 1) throw new Error("--iterations must be a positive integer");
			iterations = count;
			index++;
		} else throw new Error(`unknown option ${arg}`);
	}
	if (!Number.isInteger(iterations) || iterations < 1) throw new Error("EDIT_HOTSPOTS_BENCH_ITERATIONS must be a positive integer");
	return { json, strict, iterations };
}

async function main(): Promise<void> {
	let cli: ReturnType<typeof parseCli>;
	try {
		cli = parseCli(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}
	if (cli.json) {
		const cases: Array<{ id: CandidateId; status: "measured" | "skipped" | "error"; samples: number[] }> = [];
		let failed = false;
		for (const candidate of candidates) {
			const nativeFn = await resolveNative(candidate);
			if (!nativeFn) {
				cases.push({ id: candidate.id, status: "skipped", samples: [] });
				failed = true;
				continue;
			}
			try {
				for (let i = 0; i < WARMUP; i++) nativeFn();
				cases.push({ id: candidate.id, status: "measured", samples: timeSamples(nativeFn, cli.iterations) });
			} catch {
				cases.push({ id: candidate.id, status: "error", samples: [] });
				failed = true;
			}
		}
		console.log(JSON.stringify({ schema: SCHEMA, suite: "edit-hotspots", cases }));
		if (cli.strict && failed) process.exitCode = 2;
		return;
	}

	console.log(`Benchmark: edit hotspots (${cli.iterations} iterations, ${WARMUP} warmup)\n`);
	console.log("id\tstatus\tbaseline median\tbaseline p95\tnative median\tnative p95\tspeedup\tgate\tfixture");
	for (const candidate of candidates) {
		for (let i = 0; i < WARMUP; i++) candidate.baselineFn();
		const baseline = time(candidate.baselineFn, cli.iterations);
		const nativeFn = await resolveNative(candidate);
		const dims = Object.entries(candidate.dimensions).map(([key, value]) => `${key}=${value}`).join(",");
		if (!nativeFn) {
			console.log(`${candidate.id}\tSKIPPED\t${baseline.median.toFixed(3)}ms/op\t${baseline.p95.toFixed(3)}ms/op\t-\t-\t-\tSKIP\t${candidate.fixture} (${dims})`);
			continue;
		}
		for (let i = 0; i < WARMUP; i++) nativeFn();
		const nativeTiming = time(nativeFn, cli.iterations);
		const speedup = baseline.median / nativeTiming.median;
		const pass = speedup >= PASS_SPEEDUP;
		console.log(`${candidate.id}\t${pass ? "PASS" : "FAIL"}\t${baseline.median.toFixed(3)}ms/op\t${baseline.p95.toFixed(3)}ms/op\t${nativeTiming.median.toFixed(3)}ms/op\t${nativeTiming.p95.toFixed(3)}ms/op\t${speedup.toFixed(2)}x\t>=${PASS_SPEEDUP}x\t${candidate.fixture} (${dims})`);
	}
	void generateDiffString("a\n", "b\n");
}

if (import.meta.main) await main();
