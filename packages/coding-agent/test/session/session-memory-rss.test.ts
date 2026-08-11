import { describe, expect, it } from "bun:test";
import * as path from "node:path";

interface RssWorkerResult {
	recordCount: number;
	cycleCount: number;
	cycleRecords: number;
	root: string;
	sessionFile: string;
	cycleSamples: Array<{ rss: number; heapUsed: number; external: number }>;
	selectionSamples: Array<{ rss: number; heapUsed: number; external: number }>;
	forkSamples: Array<{ rss: number; heapUsed: number; external: number }>;
	forkStats?: { coldRetirementActive: boolean; totalAccountedBytes: number };
	capturedForkSamples: Array<{ rss: number; heapUsed: number; external: number }>;
	capturedForkStats?: { coldRetirementActive: boolean; totalAccountedBytes: number };
	eagerRssDeltaBytes: number;
	branchSamples: Array<{ rss: number; heapUsed: number; external: number }>;
	stats: {
		coldRetirementActive: boolean;
		totalAccountedBytes: number;
	};
}

interface GibForkWorkerResult {
	capturedMode: boolean;
	sourceBytes: number;
	elapsedMs: number;
	rssGrowthBytes: number;
	stats: {
		coldRetirementActive: boolean;
		totalAccountedBytes: number;
	};
}

const enabled = process.env.GJC_SESSION_MEMORY_RSS === "1";
const RSS_ALLOCATOR_ENVELOPE_BYTES = 128 * 1024 * 1024;

describe.skipIf(!enabled)("session memory RSS plateau", () => {
	it("captures a 128 MiB managed descriptor without reading the transcript into memory", () => {
		const worker = path.join(import.meta.dir, "fixtures", "managed-descriptor-rss-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as {
			sourceBytes: number;
			rssGrowthBytes: number;
			externalGrowthBytes: number;
		};
		expect(measured.sourceBytes).toBe(128 * 1024 * 1024);
		expect(measured.rssGrowthBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
		expect(measured.externalGrowthBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
	}, 60_000);
	it("materializes a 24 MiB public provider context within the 64 MiB RSS budget", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-rss-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: { ...process.env, GJC_SESSION_MEMORY_RSS_CONTEXT: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as {
			rssGrowthBytes: number;
			messageBytes: number;
		};
		expect(measured.messageBytes).toBeGreaterThanOrEqual(24 * 1024 * 1024);
		expect(measured.rssGrowthBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	}, 60_000);
	it("keeps post-compaction RSS growth bounded across a 120k-record session", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-rss-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: {
				...process.env,
				GJC_SESSION_MEMORY_RSS_RECORDS: "120000",
				GJC_SESSION_MEMORY_RSS_CYCLES: "3",
				GJC_SESSION_MEMORY_RSS_CYCLE_RECORDS: "5000",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as RssWorkerResult;
		expect(measured.recordCount).toBe(120000);
		expect(measured.cycleSamples).toHaveLength(3);
		expect(measured.stats.coldRetirementActive).toBe(true);
		expect(measured.stats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		const rssSamples = measured.cycleSamples.map(sample => sample.rss);
		expect(Math.max(...rssSamples) - Math.min(...rssSamples)).toBeLessThanOrEqual(64 * 1024 * 1024);
	}, 60_000);
	it("streams a 120k-record HTML export within the 64 MiB RSS budget", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-export-rss-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as {
			recordCount: number;
			samples: Array<{ rss: number; heapUsed: number; external: number }>;
			stats: { coldRetirementActive: boolean };
		};
		expect(measured.recordCount).toBe(120_000);
		expect(measured.samples).toHaveLength(2);
		expect(measured.samples[1]!.rss - measured.samples[0]!.rss).toBeLessThanOrEqual(64 * 1024 * 1024);
		expect(measured.stats.coldRetirementActive).toBe(true);
	}, 60_000);

	it("activates a retired compacted branch within the 64 MiB process budget", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-rss-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: {
				...process.env,
				GJC_SESSION_MEMORY_RSS_RECORDS: "120000",
				GJC_SESSION_MEMORY_RSS_CYCLES: "1",
				GJC_SESSION_MEMORY_RSS_CYCLE_RECORDS: "5000",
				GJC_SESSION_MEMORY_RSS_BRANCH: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as RssWorkerResult;
		expect(measured.branchSamples).toHaveLength(2);
		expect(measured.stats.coldRetirementActive).toBe(true);
		expect(measured.stats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		expect(measured.branchSamples[1]!.rss - measured.branchSamples[0]!.rss).toBeLessThanOrEqual(64 * 1024 * 1024);
	}, 60_000);

	it("reopens the authenticated 120k-record sidecar within the 64 MiB RSS budget", () => {
		const prepareWorker = path.join(import.meta.dir, "fixtures", "session-memory-rss-worker.ts");
		const prepared = Bun.spawnSync({
			cmd: [process.execPath, prepareWorker],
			env: {
				...process.env,
				GJC_SESSION_MEMORY_RSS_RECORDS: "120000",
				GJC_SESSION_MEMORY_RSS_CYCLES: "0",
				GJC_SESSION_MEMORY_RSS_KEEP: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(prepared.exitCode, prepared.stderr.toString()).toBe(0);
		const fixture = JSON.parse(prepared.stdout.toString()) as RssWorkerResult;
		const lazyWorker = path.join(import.meta.dir, "fixtures", "session-memory-lazy-rss-worker.ts");
		const lazy = Bun.spawnSync({
			cmd: [process.execPath, lazyWorker],
			env: {
				...process.env,
				GJC_SESSION_MEMORY_RSS_SESSION: fixture.sessionFile,
				GJC_SESSION_MEMORY_RSS_REMOVE: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(lazy.exitCode, lazy.stderr.toString()).toBe(0);
		const measured = JSON.parse(lazy.stdout.toString()) as {
			rssDeltaBytes: number;
			stats: { coldRetirementActive: boolean; totalAccountedBytes: number };
		};
		expect(measured.stats.coldRetirementActive).toBe(true);
		expect(measured.stats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		expect(measured.rssDeltaBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	}, 60_000);

	it("builds a first 60k-record enabled sidecar within the 64 MiB RSS budget", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-rss-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: {
				...process.env,
				GJC_SESSION_MEMORY_RSS_RECORDS: "60000",
				GJC_SESSION_MEMORY_RSS_CYCLES: "0",
				GJC_SESSION_MEMORY_RSS_FIRST_OPEN: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as RssWorkerResult;
		expect(measured.recordCount).toBe(60000);
		expect(measured.stats.coldRetirementActive).toBe(true);
		expect(measured.stats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		expect(measured.eagerRssDeltaBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	}, 60_000);
	it("stages and promotes a cold 120k-record model selection within the bounded allocator envelope", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-rss-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: {
				...process.env,
				GJC_SESSION_MEMORY_RSS_RECORDS: "120000",
				GJC_SESSION_MEMORY_RSS_CYCLES: "0",
				GJC_SESSION_MEMORY_RSS_FIRST_OPEN: "1",
				GJC_SESSION_MEMORY_RSS_SELECTION: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as RssWorkerResult;
		expect(measured.selectionSamples).toHaveLength(3);
		expect(measured.stats.coldRetirementActive).toBe(true);
		expect(measured.stats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		const rss = measured.selectionSamples.map(sample => sample.rss);
		expect(Math.max(...rss) - Math.min(...rss)).toBeLessThanOrEqual(RSS_ALLOCATOR_ENVELOPE_BYTES);
	}, 60_000);

	it("forks an enabled 120k-record cold transcript within the 64 MiB RSS budget", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-rss-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: {
				...process.env,
				GJC_SESSION_MEMORY_RSS_RECORDS: "120000",
				GJC_SESSION_MEMORY_RSS_CYCLES: "0",
				GJC_SESSION_MEMORY_RSS_FIRST_OPEN: "1",
				GJC_SESSION_MEMORY_RSS_FORK: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as RssWorkerResult;
		expect(measured.forkSamples).toHaveLength(2);
		expect(measured.forkStats?.coldRetirementActive).toBe(true);
		expect(measured.forkStats?.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		const rss = measured.forkSamples.map(sample => sample.rss);
		expect(Math.max(...rss) - Math.min(...rss)).toBeLessThanOrEqual(64 * 1024 * 1024);
	}, 60_000);

	it("forks a captured 120k-record cold transcript within the 64 MiB RSS budget", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-rss-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: {
				...process.env,
				GJC_SESSION_MEMORY_RSS_RECORDS: "120000",
				GJC_SESSION_MEMORY_RSS_CYCLES: "0",
				GJC_SESSION_MEMORY_RSS_FIRST_OPEN: "1",
				GJC_SESSION_MEMORY_RSS_CAPTURED_FORK: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as RssWorkerResult;
		expect(measured.capturedForkSamples).toHaveLength(2);
		expect(measured.capturedForkStats?.coldRetirementActive).toBe(true);
		expect(measured.capturedForkStats?.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		const rss = measured.capturedForkSamples.map(sample => sample.rss);
		expect(Math.max(...rss) - Math.min(...rss)).toBeLessThanOrEqual(64 * 1024 * 1024);
	}, 60_000);

	it("builds and reopens one million records within the bounded allocator envelope", () => {
		const prepareWorker = path.join(import.meta.dir, "fixtures", "session-memory-rss-worker.ts");
		const slopeBaseRun = Bun.spawnSync({
			cmd: [process.execPath, prepareWorker],
			env: {
				...process.env,
				GJC_SESSION_MEMORY_RSS_RECORDS: "120000",
				GJC_SESSION_MEMORY_RSS_CYCLES: "0",
				GJC_SESSION_MEMORY_RSS_FIRST_OPEN: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(slopeBaseRun.exitCode, slopeBaseRun.stderr.toString()).toBe(0);
		const slopeBase = JSON.parse(slopeBaseRun.stdout.toString()) as RssWorkerResult;
		expect(slopeBase.recordCount).toBe(120000);
		expect(slopeBase.eagerRssDeltaBytes).toBeLessThanOrEqual(RSS_ALLOCATOR_ENVELOPE_BYTES);
		const prepared = Bun.spawnSync({
			cmd: [process.execPath, prepareWorker],
			env: {
				...process.env,
				GJC_SESSION_MEMORY_RSS_RECORDS: "1000000",
				GJC_SESSION_MEMORY_RSS_CYCLES: "0",
				GJC_SESSION_MEMORY_RSS_FIRST_OPEN: "1",
				GJC_SESSION_MEMORY_RSS_KEEP: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(prepared.exitCode, prepared.stderr.toString()).toBe(0);
		const fixture = JSON.parse(prepared.stdout.toString()) as RssWorkerResult;
		expect(fixture.eagerRssDeltaBytes).toBeLessThanOrEqual(RSS_ALLOCATOR_ENVELOPE_BYTES);
		expect(fixture.stats.coldRetirementActive).toBe(true);
		expect(fixture.stats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		expect(fixture.eagerRssDeltaBytes - slopeBase.eagerRssDeltaBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		const lazyWorker = path.join(import.meta.dir, "fixtures", "session-memory-lazy-rss-worker.ts");
		const lazy = Bun.spawnSync({
			cmd: [process.execPath, lazyWorker],
			env: {
				...process.env,
				GJC_SESSION_MEMORY_RSS_SESSION: fixture.sessionFile,
				GJC_SESSION_MEMORY_RSS_REMOVE: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(lazy.exitCode, lazy.stderr.toString()).toBe(0);
		const reopened = JSON.parse(lazy.stdout.toString()) as {
			rssDeltaBytes: number;
			stats: { coldRetirementActive: boolean; totalAccountedBytes: number };
		};
		expect(reopened.rssDeltaBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		expect(reopened.stats.coldRetirementActive).toBe(true);
		expect(reopened.stats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	}, 180_000);

	it("forks a one-GiB compacted transcript within the latency and allocator budgets", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-gib-fork-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as GibForkWorkerResult;
		expect(measured.capturedMode).toBe(false);
		expect(measured.sourceBytes).toBeGreaterThanOrEqual(1_000_000_000);
		expect(measured.elapsedMs).toBeLessThanOrEqual(4_000);
		expect(measured.rssGrowthBytes).toBeLessThanOrEqual(RSS_ALLOCATOR_ENVELOPE_BYTES);
		expect(measured.stats.coldRetirementActive).toBe(true);
		expect(measured.stats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	}, 30_000);

	it("forks a captured one-GiB transcript within the latency and allocator budgets", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-gib-fork-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: { ...process.env, GJC_SESSION_MEMORY_GIB_CAPTURED: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as GibForkWorkerResult;
		expect(measured.capturedMode).toBe(true);
		expect(measured.sourceBytes).toBeGreaterThanOrEqual(1_000_000_000);
		expect(measured.elapsedMs).toBeLessThanOrEqual(4_000);
		expect(measured.rssGrowthBytes).toBeLessThanOrEqual(RSS_ALLOCATOR_ENVELOPE_BYTES);
		expect(measured.stats.coldRetirementActive).toBe(true);
		expect(measured.stats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	}, 30_000);

	it("keeps RSS flat across many distinct parent lookups served from the persistent artifact", () => {
		const worker = path.join(import.meta.dir, "fixtures", "session-memory-parent-rss-worker.ts");
		const result = Bun.spawnSync({
			cmd: [process.execPath, worker],
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		const measured = JSON.parse(result.stdout.toString()) as {
			parentCount: number;
			samples: Array<{ rss: number; heapUsed: number; external: number }>;
			stats: { coldRetirementActive: boolean; totalAccountedBytes: number };
		};
		expect(measured.parentCount).toBe(200);
		expect(measured.samples.length).toBeGreaterThanOrEqual(5);
		expect(measured.stats.coldRetirementActive).toBe(true);
		expect(measured.stats.totalAccountedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		const rss = measured.samples.map(sample => sample.rss);
		expect(Math.max(...rss) - Math.min(...rss)).toBeLessThanOrEqual(64 * 1024 * 1024);
	}, 60_000);
});
