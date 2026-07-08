export const LIVE_RUNNER_SCHEMA_VERSION = 1;

export interface LiveRunnerOptions {
	beforeBinary: string;
	afterBinary: string;
	fixtureId: string;
	outputDir: string;
}

export interface LiveRunnerFixturePair {
	candidate: string;
	beforeFixtureId: string;
	afterFixtureId: string;
	successCriterion: string;
}

export const LIVE_DEFAULT_CANDIDATE_FIXTURE_PAIRS: readonly LiveRunnerFixturePair[] = [
	{
		candidate: "task.maxRecursionDepth.default.2-to-1",
		beforeFixtureId: "pr9.task-recursion.before",
		afterFixtureId: "pr9.task-recursion.after",
		successCriterion: "externally checked nested delegation outcome remains successful",
	},
	{
		candidate: "outputCaps.default.500000-to-lower",
		beforeFixtureId: "pr9.output-caps.before",
		afterFixtureId: "pr9.output-caps.after",
		successCriterion: "large output fact recovery succeeds through retained preview plus artifact reference",
	},
	{
		candidate: "tools.maxInlineResultBytes.default.0-to-candidate",
		beforeFixtureId: "pr9.max-inline-result-bytes.before",
		afterFixtureId: "pr9.max-inline-result-bytes.after",
		successCriterion: "inline tool text remains actionable and artifact recovery succeeds",
	},
	{
		candidate: "tools.readArtifactSpillThreshold.default.0-to-candidate",
		beforeFixtureId: "pr9.read-artifact-spill-threshold.before",
		afterFixtureId: "pr9.read-artifact-spill-threshold.after",
		successCriterion: "read workflow locates required facts through bounded output plus artifact reference",
	},
	{
		candidate: "compaction.maintenancePruningEnabled.default.false-to-true",
		beforeFixtureId: "pr9.maintenance-pruning.before",
		afterFixtureId: "pr9.maintenance-pruning.after",
		successCriterion: "stale-output pruning improves token/cache economics without task failure",
	},
	{
		candidate: "appendOnlyContext.providerExpansion.default-held",
		beforeFixtureId: "pr9.append-only-provider-expansion.before",
		afterFixtureId: "pr9.append-only-provider-expansion.after",
		successCriterion: "provider-specific prefix stability holds across candidate provider turns",
	},
	{
		candidate: "rpc.compactMessageUpdateDeltas.default.false-to-true",
		beforeFixtureId: "pr9.rpc-compact-deltas.before",
		afterFixtureId: "pr9.rpc-compact-deltas.after",
		successCriterion: "compact delta clients and legacy clients both receive equivalent message state",
	},
] as const;

export interface LiveRunTotals {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}

export interface LiveRunReport {
	schemaVersion: number;
	binaryPath: string;
	binaryId: string;
	fixtureId: string;
	totals: LiveRunTotals;
	cacheHitRate: number | null;
	receiptArtifactRatio: number | null;
	spawnDecisions: number | null;
	roi: number | null;
}

export interface LiveRunDelta {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cacheHitRate: number | null;
	receiptArtifactRatio: number | null;
	spawnDecisions: number | null;
	roi: number | null;
}

export interface LiveRunRegression {
	totalTokensIncreased: boolean;
	cacheHitRateDecreased: boolean | null;
}

export interface DeltaReport {
	schemaVersion: number;
	before: LiveRunReport;
	after: LiveRunReport;
	delta: LiveRunDelta;
	regression: LiveRunRegression | null;
}

export class LiveRunnerError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "LiveRunnerError";
		this.code = code;
	}
}

export interface RunOneBinaryOptions {
	args?: string[];
	timeoutMs?: number;
}

function boundedMessage(message: string): string {
	return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

async function assertExecutable(binaryPath: string): Promise<void> {
	const file = Bun.file(binaryPath);
	if (!(await file.exists())) {
		throw new LiveRunnerError("missing_binary", `Binary does not exist: ${binaryPath}`);
	}

	try {
		const proc = Bun.spawn([binaryPath, "--version"], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const exited = await proc.exited;
		if (exited === 126) {
			throw new LiveRunnerError("non_executable", `Binary is not executable: ${binaryPath}`);
		}
	} catch (error) {
		if (error instanceof LiveRunnerError) {
			throw error;
		}
		throw new LiveRunnerError("non_executable", `Binary is not executable: ${binaryPath}`);
	}
}

function assertNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new LiveRunnerError("malformed_report", `Report field ${field} must be a finite number`);
	}
	return value;
}

function assertNullableNumber(value: unknown, field: string): number | null {
	if (value === null) {
		return null;
	}
	return assertNumber(value, field);
}

function parseReport(stdout: string, binaryPath: string, fixtureId: string): LiveRunReport {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new LiveRunnerError("malformed_report", "Binary stdout was not valid JSON");
	}

	if (typeof parsed !== "object" || parsed === null) {
		throw new LiveRunnerError("malformed_report", "Binary stdout JSON must be an object");
	}

	const record = parsed as Record<string, unknown>;
	const schemaVersion = assertNumber(record.schemaVersion, "schemaVersion");
	if (schemaVersion !== LIVE_RUNNER_SCHEMA_VERSION) {
		throw new LiveRunnerError(
			"schema_version_mismatch",
			`Expected schemaVersion ${LIVE_RUNNER_SCHEMA_VERSION}, got ${schemaVersion}`,
		);
	}

	if (typeof record.binaryId !== "string" || record.binaryId.length === 0) {
		throw new LiveRunnerError("malformed_report", "Report field binaryId must be a non-empty string");
	}

	if (record.fixtureId !== fixtureId) {
		throw new LiveRunnerError("malformed_report", `Report fixtureId must match requested fixture: ${fixtureId}`);
	}

	if (typeof record.totals !== "object" || record.totals === null) {
		throw new LiveRunnerError("malformed_report", "Report field totals must be an object");
	}
	const totals = record.totals as Record<string, unknown>;

	return {
		schemaVersion,
		binaryPath,
		binaryId: record.binaryId,
		fixtureId,
		totals: {
			turns: assertNumber(totals.turns, "totals.turns"),
			inputTokens: assertNumber(totals.inputTokens, "totals.inputTokens"),
			outputTokens: assertNumber(totals.outputTokens, "totals.outputTokens"),
			cacheReadTokens: assertNumber(totals.cacheReadTokens, "totals.cacheReadTokens"),
			cacheWriteTokens: assertNumber(totals.cacheWriteTokens, "totals.cacheWriteTokens"),
			totalTokens: assertNumber(totals.totalTokens, "totals.totalTokens"),
		},
		cacheHitRate: assertNullableNumber(record.cacheHitRate, "cacheHitRate"),
		receiptArtifactRatio: assertNullableNumber(record.receiptArtifactRatio, "receiptArtifactRatio"),
		spawnDecisions: assertNullableNumber(record.spawnDecisions, "spawnDecisions"),
		roi: assertNullableNumber(record.roi, "roi"),
	};
}

function resolveFixturePair(fixtureId: string): { beforeFixtureId: string; afterFixtureId: string } {
	const pair = LIVE_DEFAULT_CANDIDATE_FIXTURE_PAIRS.find(candidate => candidate.candidate === fixtureId);
	if (!pair) return { beforeFixtureId: fixtureId, afterFixtureId: fixtureId };
	return { beforeFixtureId: pair.beforeFixtureId, afterFixtureId: pair.afterFixtureId };
}

export async function runOneBinary(
	binaryPath: string,
	fixtureId: string,
	opts: RunOneBinaryOptions = {},
): Promise<LiveRunReport> {
	await assertExecutable(binaryPath);

	const proc = Bun.spawn([binaryPath, "--fixture", fixtureId, ...(opts.args ?? [])], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const timeoutMs = opts.timeoutMs ?? 120_000;
	const timeout = new Promise<never>((_, reject) => {
		setTimeout(() => {
			proc.kill();
			reject(new LiveRunnerError("binary_timeout", `Binary exceeded ${timeoutMs}ms timeout: ${binaryPath}`));
		}, timeoutMs).unref?.();
	});

	const stdoutPromise = new Response(proc.stdout).text();
	const stderrPromise = new Response(proc.stderr).text();
	const exited = await Promise.race([proc.exited, timeout]);
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

	if (exited !== 0) {
		throw new LiveRunnerError("binary_failed", boundedMessage(`Binary exited ${exited}: ${stderr}`));
	}

	return parseReport(stdout, binaryPath, fixtureId);
}

function deltaNumber(after: number, before: number): number {
	return after - before;
}

function deltaNullableNumber(after: number | null, before: number | null): number | null {
	if (after === null || before === null) {
		return null;
	}
	return after - before;
}

function computeDelta(before: LiveRunReport, after: LiveRunReport): LiveRunDelta {
	return {
		turns: deltaNumber(after.totals.turns, before.totals.turns),
		inputTokens: deltaNumber(after.totals.inputTokens, before.totals.inputTokens),
		outputTokens: deltaNumber(after.totals.outputTokens, before.totals.outputTokens),
		cacheReadTokens: deltaNumber(after.totals.cacheReadTokens, before.totals.cacheReadTokens),
		cacheWriteTokens: deltaNumber(after.totals.cacheWriteTokens, before.totals.cacheWriteTokens),
		totalTokens: deltaNumber(after.totals.totalTokens, before.totals.totalTokens),
		cacheHitRate: deltaNullableNumber(after.cacheHitRate, before.cacheHitRate),
		receiptArtifactRatio: deltaNullableNumber(after.receiptArtifactRatio, before.receiptArtifactRatio),
		spawnDecisions: deltaNullableNumber(after.spawnDecisions, before.spawnDecisions),
		roi: deltaNullableNumber(after.roi, before.roi),
	};
}

function computeRegression(delta: LiveRunDelta): LiveRunRegression | null {
	const regression = {
		totalTokensIncreased: delta.totalTokens > 0,
		cacheHitRateDecreased: delta.cacheHitRate === null ? null : delta.cacheHitRate < 0,
	};

	if (!regression.totalTokensIncreased && regression.cacheHitRateDecreased !== true) {
		return null;
	}
	return regression;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await Bun.write(path, `${JSON.stringify(value, null, "\t")}\n`);
}

export async function runLiveComparison(options: LiveRunnerOptions): Promise<DeltaReport> {
	const fixturePair = resolveFixturePair(options.fixtureId);
	const before = await runOneBinary(options.beforeBinary, fixturePair.beforeFixtureId);
	const after = await runOneBinary(options.afterBinary, fixturePair.afterFixtureId);
	const delta = computeDelta(before, after);
	const report: DeltaReport = {
		schemaVersion: LIVE_RUNNER_SCHEMA_VERSION,
		before,
		after,
		delta,
		regression: computeRegression(delta),
	};

	await Bun.$`mkdir -p ${options.outputDir}`;
	await writeJson(`${options.outputDir}/before.json`, before);
	await writeJson(`${options.outputDir}/after.json`, after);
	await writeJson(`${options.outputDir}/delta.json`, report);
	await Bun.write(`${options.outputDir}/report.md`, renderMarkdownReport(report));

	return report;
}

function formatNullable(value: number | null): string {
	return value === null ? "null" : String(value);
}

export function renderMarkdownReport(delta: DeltaReport): string {
	return `# Live Orchestration Token Benchmark (ADVISORY)

This manual report is NON-CI and makes NO LIVE ASSERTIONS. It compares two explicit pre-built binaries only.

## Fixture

- Fixture: ${delta.before.fixtureId}
- Before: ${delta.before.binaryPath} (${delta.before.binaryId})
- After: ${delta.after.binaryPath} (${delta.after.binaryId})

## Delta

| Metric | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Total tokens | ${delta.before.totals.totalTokens} | ${delta.after.totals.totalTokens} | ${delta.delta.totalTokens} |
| Input tokens | ${delta.before.totals.inputTokens} | ${delta.after.totals.inputTokens} | ${delta.delta.inputTokens} |
| Output tokens | ${delta.before.totals.outputTokens} | ${delta.after.totals.outputTokens} | ${delta.delta.outputTokens} |
| Cache read tokens | ${delta.before.totals.cacheReadTokens} | ${delta.after.totals.cacheReadTokens} | ${delta.delta.cacheReadTokens} |
| Cache write tokens | ${delta.before.totals.cacheWriteTokens} | ${delta.after.totals.cacheWriteTokens} | ${delta.delta.cacheWriteTokens} |
| Cache hit rate | ${formatNullable(delta.before.cacheHitRate)} | ${formatNullable(delta.after.cacheHitRate)} | ${formatNullable(delta.delta.cacheHitRate)} |
| Receipt artifact ratio | ${formatNullable(delta.before.receiptArtifactRatio)} | ${formatNullable(delta.after.receiptArtifactRatio)} | ${formatNullable(delta.delta.receiptArtifactRatio)} |
| Spawn decisions | ${formatNullable(delta.before.spawnDecisions)} | ${formatNullable(delta.after.spawnDecisions)} | ${formatNullable(delta.delta.spawnDecisions)} |
| ROI | ${formatNullable(delta.before.roi)} | ${formatNullable(delta.after.roi)} | ${formatNullable(delta.delta.roi)} |

Regression: ${delta.regression === null ? "none" : JSON.stringify(delta.regression)}
`;
}

function parseCliArgs(args: string[]): LiveRunnerOptions {
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i];
		const value = args[i + 1];
		if (!key?.startsWith("--") || value === undefined) {
			throw new LiveRunnerError(
				"invalid_args",
				"Usage: bun run src/live-runner.ts --before <path> --after <path> --fixture <id> --out <dir>",
			);
		}
		values.set(key, value);
	}

	const beforeBinary = values.get("--before");
	const afterBinary = values.get("--after");
	const fixtureId = values.get("--fixture");
	const outputDir = values.get("--out");
	if (!beforeBinary || !afterBinary || !fixtureId || !outputDir) {
		throw new LiveRunnerError(
			"invalid_args",
			"Usage: bun run src/live-runner.ts --before <path> --after <path> --fixture <id> --out <dir>",
		);
	}

	return { beforeBinary, afterBinary, fixtureId, outputDir };
}

if (import.meta.main) {
	try {
		const report = await runLiveComparison(parseCliArgs(Bun.argv.slice(2)));
		console.log(JSON.stringify(report, null, "\t"));
	} catch (error) {
		if (error instanceof LiveRunnerError) {
			console.error(JSON.stringify({ code: error.code, message: error.message }));
			process.exit(1);
		}
		throw error;
	}
}
