import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AutoresearchExperimentConfig,
	AutoresearchRunsStore,
	autoresearchRunsPaths,
	buildAutoresearchExperimentState,
	computeConfidence,
	createAutoresearchExperimentConfig,
	findBaselineMetric,
	findBestKeptMetric,
} from "../../src/autoresearch/runs";
import { sessionAutoresearchDir } from "../../src/gjc-runtime/session-layout";

const TEST_SESSION_ID = "runs-test-session";
const tempRoots: string[] = [];
let previousGjcSessionId: string | undefined;

beforeAll(() => {
	previousGjcSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (previousGjcSessionId === undefined) {
		delete process.env.GJC_SESSION_ID;
	} else {
		process.env.GJC_SESSION_ID = previousGjcSessionId;
	}
});

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-autoresearch-runs-"));
	tempRoots.push(dir);
	return dir;
}

function baseConfig(overrides: Partial<AutoresearchExperimentConfig> = {}) {
	return createAutoresearchExperimentConfig({
		name: "tokenizer",
		goal: "Optimize the tokenizer hot path",
		primaryMetric: "latency_ms",
		metricUnit: "ms",
		direction: "lower",
		...overrides,
	});
}

async function seedRun(
	store: AutoresearchRunsStore,
	input: {
		status: "keep" | "discard" | "crash" | "checks_failed";
		metric: number;
		description?: string;
		metrics?: Record<string, number>;
		flag?: boolean;
	},
): Promise<number> {
	const started = await store.startRun({ command: "bash autoresearch.sh" });
	await store.completeRun(started.runId, { exitCode: 0, timedOut: false, durationMs: 1000 });
	const logged = await store.logRun(started.runId, {
		status: input.status,
		description: input.description ?? input.status,
		metric: input.metric,
		metrics: input.metrics ?? {},
	});
	if (input.flag) {
		await store.flagRun(logged.runId, "suspect");
	}
	return logged.runNumber;
}

describe("autoresearch run storage", () => {
	it("persists runs as JSONL under the session autoresearch dir (no SQLite)", async () => {
		const root = await tempDir();
		const store = await AutoresearchRunsStore.open(root, TEST_SESSION_ID);
		const paths = autoresearchRunsPaths(root, TEST_SESSION_ID);
		expect(paths.dir).toBe(sessionAutoresearchDir(root, TEST_SESSION_ID));
		expect(path.basename(paths.runsPath)).toBe("runs.jsonl");
		expect(path.basename(paths.configPath)).toBe("experiment.json");
		// The store must never resolve a global-store path outside the session dir.
		expect(paths.runsPath.startsWith(sessionAutoresearchDir(root, TEST_SESSION_ID))).toBe(true);

		await store.saveConfig(baseConfig());
		const run = await store.startRun({ command: "bash autoresearch.sh" });
		await store.completeRun(run.runId, { exitCode: 0, timedOut: false, durationMs: 500 });
		await store.logRun(run.runId, { status: "keep", description: "baseline", metric: 42 });

		const raw = await Bun.file(paths.runsPath).text();
		const lines = raw.trim().split(/\r?\n/);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!) as { runId: string; status: string; metric: number };
		expect(parsed.runId).toBe(run.runId);
		expect(parsed.status).toBe("keep");
		expect(parsed.metric).toBe(42);

		// Re-open from disk round-trips the full record.
		const reopened = await AutoresearchRunsStore.open(root, TEST_SESSION_ID);
		expect(reopened.config?.primaryMetric).toBe("latency_ms");
		expect(reopened.listLoggedRuns()).toHaveLength(1);
		expect(reopened.listLoggedRuns()[0]!.description).toBe("baseline");
	});

	it("baseline is the first kept, unflagged run", async () => {
		const root = await tempDir();
		const store = await AutoresearchRunsStore.open(root, TEST_SESSION_ID);
		await store.saveConfig(baseConfig());
		await seedRun(store, { status: "discard", metric: 10 });
		await seedRun(store, { status: "keep", metric: 5 });
		await seedRun(store, { status: "keep", metric: 3 });

		const state = buildAutoresearchExperimentState(store.config!, store.listLoggedRuns());
		expect(state.bestMetric).toBe(5); // first kept, not the best
		expect(findBaselineMetric(store.listLoggedRuns(), 0)).toBe(5);
	});

	it("flagged runs are excluded from baseline and best-metric math", async () => {
		const root = await tempDir();
		const store = await AutoresearchRunsStore.open(root, TEST_SESSION_ID);
		await store.saveConfig(baseConfig());
		// Run #1 is the first kept run but gets flagged as reward-hacked.
		await seedRun(store, { status: "keep", metric: 1, flag: true });
		await seedRun(store, { status: "keep", metric: 4 });
		await seedRun(store, { status: "keep", metric: 7 });

		const logged = store.listLoggedRuns();
		expect(findBaselineMetric(logged, 0)).toBe(4); // skipped the flagged run
		expect(findBestKeptMetric(logged, 0, "lower")).toBe(4); // flagged 1 must not win
		expect(findBestKeptMetric(logged, 0, "higher")).toBe(7);

		const state = buildAutoresearchExperimentState(store.config!, logged);
		expect(state.results[0]!.flagged).toBe(true);
		expect(state.bestMetric).toBe(4);
	});

	it("respects metric direction (lower vs higher is better)", async () => {
		const root = await tempDir();
		const store = await AutoresearchRunsStore.open(root, TEST_SESSION_ID);
		await store.saveConfig(baseConfig({ direction: "lower" }));
		await seedRun(store, { status: "keep", metric: 100 });
		await seedRun(store, { status: "keep", metric: 30 });
		await seedRun(store, { status: "keep", metric: 80 });
		expect(findBestKeptMetric(store.listLoggedRuns(), 0, "lower")).toBe(30);

		const hRoot = await tempDir();
		const higher = await AutoresearchRunsStore.open(hRoot, TEST_SESSION_ID);
		await higher.saveConfig(baseConfig({ direction: "higher" }));
		await seedRun(higher, { status: "keep", metric: 100 });
		await seedRun(higher, { status: "keep", metric: 300 });
		await seedRun(higher, { status: "keep", metric: 200 });
		expect(findBestKeptMetric(higher.listLoggedRuns(), 0, "higher")).toBe(300);
		expect(findBaselineMetric(higher.listLoggedRuns(), 0)).toBe(100);
	});

	it("flags a run persistently and excludes it on reload", async () => {
		const root = await tempDir();
		const store = await AutoresearchRunsStore.open(root, TEST_SESSION_ID);
		await store.saveConfig(baseConfig());
		await seedRun(store, { status: "keep", metric: 2 });
		await seedRun(store, { status: "keep", metric: 8 });

		const flagged = await store.flagRun(store.listRuns()[0]!.runId, "overfit to fixture");
		expect(flagged.flagged).toBe(true);
		expect(flagged.flaggedReason).toBe("overfit to fixture");

		const reopened = await AutoresearchRunsStore.open(root, TEST_SESSION_ID);
		expect(reopened.listLoggedRuns()[0]!.flagged).toBe(true);
		expect(findBaselineMetric(reopened.listLoggedRuns(), 0)).toBe(8);
	});

	it("pending run lifecycle: started/unlogged runs are pending until logged or abandoned", async () => {
		const root = await tempDir();
		const store = await AutoresearchRunsStore.open(root, TEST_SESSION_ID);
		await store.saveConfig(baseConfig());
		await seedRun(store, { status: "keep", metric: 5 });
		const pending = await store.startRun({ command: "bash autoresearch.sh" });
		await store.completeRun(pending.runId, { exitCode: 1, timedOut: false, durationMs: 900 });

		expect(store.getPendingRun()?.runId).toBe(pending.runId);
		expect(store.listLoggedRuns()).toHaveLength(1);

		const abandoned = await store.abandonPendingRuns();
		expect(abandoned).toBe(1);
		expect(store.getPendingRun()).toBeNull();
	});

	it("computes a confidence score from the noise floor and baseline", () => {
		const runs = [10, 9, 11, 8, 12, 7].map((metric, index) => ({
			runId: `r${index}`,
			runNumber: index + 1,
			segment: 0,
			command: "bash autoresearch.sh",
			startedAt: 0,
			completedAt: 1,
			durationMs: 1,
			exitCode: 0,
			timedOut: false,
			status: index === 0 ? ("keep" as const) : index === 5 ? ("keep" as const) : ("discard" as const),
			description: "run",
			metric,
			metrics: {},
			asi: null,
			commitHash: null,
			confidence: null,
			preRunDirtyPaths: [],
			modifiedPaths: [],
			scopeDeviations: [],
			justification: null,
			flagged: false,
			flaggedReason: null,
			loggedAt: 1,
			abandonedAt: null,
		}));
		// Baseline 10, best kept 7, MAD of the discard spread — a real positive score.
		const confidence = computeConfidence(runs, 0, "lower");
		expect(confidence).not.toBeNull();
		expect(confidence!).toBeGreaterThan(0);
	});
});
