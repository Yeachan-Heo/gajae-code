// Shared driver for native A/B bench adapters (`gjc.native-bench-ab/1`).
//
// scripts/native-bench-ab.ts installs the head copy of an adapter (and this
// module) into the base worktree, so both sides time identical fixtures
// through the same public entrypoints. Every call is awaited, which keeps an
// adapter valid whether a side exposes the entrypoint synchronously (pre-native
// TypeScript) or asynchronously (native first-use load).

export const AB_SCHEMA = "gjc.native-bench-ab/1";

export interface AbCase {
	id: string;
	run: () => unknown;
	/** Warmup calls before sampling; defaults to 25. */
	warmup?: number;
}

interface CliOptions {
	json: boolean;
	strict: boolean;
	iterations: number;
}

function parseCli(args: readonly string[], defaultIterations: number): CliOptions {
	let json = false;
	let strict = false;
	let iterations = defaultIterations;
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

function median(samples: readonly number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Time every case and print one adapter report; exit 2 in strict mode on any failed case. */
export async function runAbSuite(suite: string, cases: readonly AbCase[], defaultIterations = 200): Promise<void> {
	let cli: CliOptions;
	try {
		cli = parseCli(process.argv.slice(2), defaultIterations);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	}
	const results: Array<{ id: string; status: "measured" | "error"; samples: number[] }> = [];
	for (const item of cases) {
		try {
			for (let i = 0; i < (item.warmup ?? 25); i++) await item.run();
			const samples: number[] = [];
			for (let i = 0; i < cli.iterations; i++) {
				const start = Bun.nanoseconds();
				await item.run();
				samples.push((Bun.nanoseconds() - start) / 1e6);
			}
			results.push({ id: item.id, status: "measured", samples });
		} catch (error) {
			process.stderr.write(`${item.id}: ${error instanceof Error ? error.message : String(error)}\n`);
			results.push({ id: item.id, status: "error", samples: [] });
		}
	}
	if (cli.json) {
		process.stdout.write(`${JSON.stringify({ schema: AB_SCHEMA, suite, cases: results })}\n`);
	} else {
		for (const result of results) {
			const value = result.status === "measured" ? `${median(result.samples).toFixed(3)}ms/op` : "ERROR";
			process.stdout.write(`${result.id}\t${value}\n`);
		}
	}
	if (cli.strict && results.some(result => result.status !== "measured")) process.exitCode = 2;
}
