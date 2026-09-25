import * as fs from "node:fs/promises";
import * as path from "node:path";
import { grep, GrepOutputMode } from "../native/index.js";

const ITERATIONS = Number(Bun.env.GREP_BENCH_ITERATIONS ?? "50");
const CONCURRENCY = 8;

const packages = path.resolve(import.meta.dir, "../..");

interface BenchCase {
	id: string;
	name: string;
	path: string;
	pattern: string;
	glob?: string;
	mode?: GrepOutputMode;
	cache?: boolean;
	iterations?: number;
	concurrency?: number;
}

function parseCli(args: string[]): { json: boolean; strict: boolean; iterations: number } {
	let json = false;
	let strict = false;
	let iterations = ITERATIONS;
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
	return { json, strict, iterations };
}

const cases: BenchCase[] = [
	{ id: "G01", name: "Medium content uncached (50 files)", path: path.resolve(packages, "tui/src"), pattern: "export", glob: "*.ts" },
	{
		id: "G02",
		name: "Medium filesWithMatches uncached (50 files)",
		path: path.resolve(packages, "tui/src"),
		pattern: "export",
		glob: "*.ts",
		mode: GrepOutputMode.FilesWithMatches,
	},
	{
		id: "G03",
		name: "Medium content cached (50 files)",
		path: path.resolve(packages, "tui/src"),
		pattern: "export",
		glob: "*.ts",
		cache: true,
	},
	{
		id: "G04",
		name: "Large content uncached (200+ files)",
		path: path.resolve(packages, "coding-agent/src"),
		pattern: "import",
		glob: "*.ts",
	},
	{
		id: "G05",
		name: "Large filesWithMatches uncached (200+ files)",
		path: path.resolve(packages, "coding-agent/src"),
		pattern: "import",
		glob: "*.ts",
		mode: GrepOutputMode.FilesWithMatches,
	},
	{
		id: "G06",
		name: "Large count uncached (200+ files)",
		path: path.resolve(packages, "coding-agent/src"),
		pattern: "import",
		glob: "*.ts",
		mode: GrepOutputMode.Count,
	},
	{
		id: "G07",
		name: "Large content cached (200+ files)",
		path: path.resolve(packages, "coding-agent/src"),
		pattern: "import",
		glob: "*.ts",
		cache: true,
	},
];

const cargoRegistry = path.join(Bun.env.HOME ?? "", ".cargo/registry/src");
let registryAvailable = false;
try {
	if ((await fs.stat(cargoRegistry)).isDirectory()) {
		registryAvailable = true;
		cases.push({
			id: "G08",
			name: "Cargo registry content uncached",
			path: cargoRegistry,
			pattern: "pub mod modal|pub mod dialog|pub mod drawer",
			iterations: 1,
			concurrency: 1,
		});
	}
} catch {
	registryAvailable = false;
}
let cli: ReturnType<typeof parseCli>;
try {
	cli = parseCli(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
}


// Warm per-root state before timing so the benchmark measures steady-state search.
for (const c of cases) {
	await grep({ pattern: c.pattern, path: c.path, glob: c.glob, mode: c.mode, cache: c.cache, gitignore: false });
}
if (cli.json) {
	const measured: Array<{ id: string; status: "measured" | "skipped" | "error"; samples: number[] }> = [];
	for (const c of cases) {
		const grepArgs = { pattern: c.pattern, path: c.path, glob: c.glob, mode: c.mode, cache: c.cache, gitignore: false };
		const samples: number[] = [];
		try {
			for (let index = 0; index < (c.iterations ?? cli.iterations); index++) {
				const start = Bun.nanoseconds();
				await grep(grepArgs);
				samples.push((Bun.nanoseconds() - start) / 1e6);
			}
			measured.push({ id: c.id, status: "measured", samples });
		} catch {
			measured.push({ id: c.id, status: "error", samples: [] });
		}
	}
	if (!registryAvailable) measured.push({ id: "G08", status: "skipped", samples: [] });
	console.log(JSON.stringify({ schema: "gjc.native-bench-ab/1", suite: "grep", cases: measured }));
	if (cli.strict && measured.some(item => item.status !== "measured")) process.exitCode = 2;
} else {
	console.log(`Benchmark: ${ITERATIONS} default iterations per case\n`);
}


if (cli.json) process.exit(process.exitCode ?? 0);

for (const c of cases) {
	const grepArgs = { pattern: c.pattern, path: c.path, glob: c.glob, mode: c.mode, cache: c.cache, gitignore: false };
	const caseIterations = c.iterations ?? ITERATIONS;
	const concurrency = c.concurrency ?? CONCURRENCY;
	const rgDefaultArgs = ["--hidden", "--no-ignore", "--no-ignore-vcs"];
	const modeArg = c.mode === GrepOutputMode.FilesWithMatches ? ["--files-with-matches"] : c.mode === GrepOutputMode.Count ? ["--count"] : ["--json"];
	const globArg = c.glob ? ["-g", c.glob] : [];
	const runNative = () => grep(grepArgs);

	const runRg = async (): Promise<string> => {
		const proc = Bun.spawn(["rg", ...modeArg, ...rgDefaultArgs, ...globArg, c.pattern, c.path], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		return stdout;
	};

	const countMatches = (result: string): number => {
		const lines = result.split("\n").filter((line) => line.trim());
		if (c.mode === GrepOutputMode.FilesWithMatches) {
			return lines.length;
		}
		if (c.mode === GrepOutputMode.Count) {
			return lines.reduce((sum, line) => {
				const rawCount = line.includes(":") ? line.slice(line.lastIndexOf(":") + 1) : line;
				const count = Number(rawCount);
				return Number.isFinite(count) ? sum + count : sum;
			}, 0);
		}

		let matches = 0;
		for (const line of lines) {
			try {
				if (JSON.parse(line).type === "match") matches++;
			} catch {
				/* ignore */
			}
		}
		return matches;
	};

	const nativeMetric = (await runNative());
	const nativeMatches = c.mode === GrepOutputMode.FilesWithMatches ? nativeMetric.filesWithMatches : nativeMetric.totalMatches;

	const rgMatches = countMatches(await runRg());

	let start = Bun.nanoseconds();
	for (let i = 0; i < caseIterations; i++) await runNative();
	const nativeMs = (Bun.nanoseconds() - start) / 1e6 / caseIterations;

	start = Bun.nanoseconds();
	for (let i = 0; i < caseIterations; i++) {
		await Promise.all(Array.from({ length: concurrency }, () => runNative()));
	}
	const nativeConcurrentMs = (Bun.nanoseconds() - start) / 1e6 / caseIterations;

	start = Bun.nanoseconds();
	for (let i = 0; i < caseIterations; i++) await runRg();
	const rgMs = (Bun.nanoseconds() - start) / 1e6 / caseIterations;

	start = Bun.nanoseconds();
	for (let i = 0; i < caseIterations; i++) {
		await Promise.all(Array.from({ length: concurrency }, () => runRg()));
	}
	const rgConcurrentMs = (Bun.nanoseconds() - start) / 1e6 / caseIterations;

	console.log(`${c.name}:`);
	console.log(`  Native grep:         ${nativeMs.toFixed(2)}ms (${nativeMatches} ${c.mode === GrepOutputMode.FilesWithMatches ? "files" : "matches"})`);
	console.log(`  Native grep ${concurrency}x:      ${nativeConcurrentMs.toFixed(2)}ms`);
	console.log(`  Subprocess rg:       ${rgMs.toFixed(2)}ms (${rgMatches} ${c.mode === GrepOutputMode.FilesWithMatches ? "files" : "matches"})`);
	console.log(`  Subprocess rg ${concurrency}x:    ${rgConcurrentMs.toFixed(2)}ms`);

	const nativeVsRg = rgMs / nativeMs;
	const nativeVsRgConcurrent = rgConcurrentMs / nativeConcurrentMs;
	console.log(
		`  => Native grep is ${nativeVsRg > 1 ? `${nativeVsRg.toFixed(1)}x faster` : `${(1 / nativeVsRg).toFixed(1)}x slower`} than rg (sequential)`,
	);
	console.log(
		`  => Native grep is ${nativeVsRgConcurrent > 1 ? `${nativeVsRgConcurrent.toFixed(1)}x faster` : `${(1 / nativeVsRgConcurrent).toFixed(1)}x slower`} than rg (${concurrency}x concurrent)\n`,
	);
}
