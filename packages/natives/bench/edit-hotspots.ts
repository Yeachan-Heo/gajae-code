// Edit hotspot benchmark over public coding-agent entrypoints.
//
// The A/B runner (scripts/native-bench-ab.ts) installs this file into the base
// worktree too, so both sides time the same fixtures through the same public
// functions and only the implementation behind them differs. Every call is
// awaited, which keeps the adapter valid whether a side exposes the entrypoint
// synchronously (pre-native TS) or asynchronously (native first-use load).
import { generateDiffString } from "../../coding-agent/src/edit/diff";
import { findMatch, seekSequence } from "../../coding-agent/src/edit/modes/replace";
import { formatHashLines } from "../../coding-agent/src/hashline/hash";

const DEFAULT_ITERATIONS = Number(Bun.env.EDIT_HOTSPOTS_BENCH_ITERATIONS ?? "200");
const WARMUP = Number(Bun.env.EDIT_HOTSPOTS_BENCH_WARMUP ?? "100");
const SCHEMA = "gjc.native-bench-ab/1";

type CandidateId = "H01" | "H02" | "H03" | "H06";
type BenchFn = () => unknown;

interface Candidate {
	id: CandidateId;
	name: string;
	fixture: string;
	dimensions: Record<string, number | string>;
	run: BenchFn;
}

const longLine = `${"x".repeat(2048)} needle ${"y".repeat(2048)}`;
const editLines = Array.from({ length: 1400 }, (_, index) => {
	if (index === 740) return "    return alphaBetaGamma(value, options);";
	if (index === 1180) return longLine;
	return `line ${index.toString().padStart(4, "0")} :: ${index % 17 === 0 ? "unicode – café 👩‍💻" : "plain text"}`;
});
const editContent = editLines.join("\n");
const h01Target = "    return alphaBetaGamme(value, options);";
const editedContent = editLines
	.map((line, index) => (index % 53 === 0 ? `${line} // edited ${index}` : line))
	.filter((_, index) => index % 211 !== 7)
	.join("\n");
const hashText = Array.from({ length: 2500 }, (_, index) => {
	if (index % 97 === 0) return "";
	if (index % 89 === 0) return `tabs\tand unicode “quotes” ${index}`;
	if (index % 83 === 0) return `${"z".repeat(1024)} ${index}`;
	return `hash line ${index} trailing   `;
}).join("\n");

const candidates: Candidate[] = [
	{
		id: "H01",
		name: "findMatch fuzzy hotspot",
		fixture: "multi-line edit corpus",
		dimensions: { lines: editLines.length, bytes: Buffer.byteLength(editContent), targetBytes: Buffer.byteLength(h01Target) },
		run: () => findMatch(editContent, h01Target, { allowFuzzy: true, threshold: 0.9 }),
	},
	{
		id: "H02",
		name: "seekSequence fuzzy matcher hotspot",
		fixture: "patch/replace corpus",
		dimensions: { lines: editLines.length, bytes: Buffer.byteLength(editContent), patternLines: 1 },
		run: () => seekSequence(editLines, [h01Target], 0, false, { allowFuzzy: true }),
	},
	{
		id: "H03",
		name: "generateDiffString line diff hotspot",
		fixture: "edit preview corpus",
		dimensions: { lines: editLines.length, bytes: Buffer.byteLength(editContent), editedBytes: Buffer.byteLength(editedContent) },
		run: () => generateDiffString(editContent, editedContent),
	},
	{
		id: "H06",
		name: "formatHashLines hotspot",
		fixture: "hashline display corpus",
		dimensions: { lines: hashText.split("\n").length, bytes: Buffer.byteLength(hashText), startLine: 37 },
		run: () => formatHashLines(hashText, 37),
	},
];

function stats(samples: number[]): { median: number; p95: number } {
	const sorted = [...samples].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
	const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? median;
	return { median, p95 };
}

async function timeSamples(fn: BenchFn, iterations: number): Promise<number[]> {
	const samples: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const start = Bun.nanoseconds();
		await fn();
		samples.push((Bun.nanoseconds() - start) / 1e6);
	}
	return samples;
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
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	}
	const cases: Array<{ id: CandidateId; status: "measured" | "error"; samples: number[] }> = [];
	for (const candidate of candidates) {
		try {
			for (let i = 0; i < WARMUP; i++) await candidate.run();
			cases.push({ id: candidate.id, status: "measured", samples: await timeSamples(candidate.run, cli.iterations) });
		} catch {
			cases.push({ id: candidate.id, status: "error", samples: [] });
		}
	}
	if (cli.json) {
		process.stdout.write(`${JSON.stringify({ schema: SCHEMA, suite: "edit-hotspots", cases })}\n`);
	} else {
		process.stdout.write(`Benchmark: edit hotspots (${cli.iterations} iterations, ${WARMUP} warmup)\n\n`);
		process.stdout.write("id\tstatus\tmedian\tp95\tfixture\n");
		for (const candidate of candidates) {
			const measured = cases.find(item => item.id === candidate.id);
			const dims = Object.entries(candidate.dimensions).map(([key, value]) => `${key}=${value}`).join(",");
			if (!measured || measured.status !== "measured") {
				process.stdout.write(`${candidate.id}\tERROR\t-\t-\t${candidate.fixture} (${dims})\n`);
				continue;
			}
			const timing = stats(measured.samples);
			process.stdout.write(`${candidate.id}\tOK\t${timing.median.toFixed(3)}ms/op\t${timing.p95.toFixed(3)}ms/op\t${candidate.fixture} (${dims})\n`);
		}
	}
	if (cli.strict && cases.some(item => item.status !== "measured")) process.exitCode = 2;
}

if (import.meta.main) await main();
