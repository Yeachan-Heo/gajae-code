import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../../../src/session/session-manager";

const collect = (): { rss: number; heapUsed: number; external: number } => {
	Bun.gc(true);
	const usage = process.memoryUsage();
	return { rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external };
};

if (process.env.GJC_SESSION_MEMORY_RSS_CONTEXT === "1") {
	const manager = SessionManager.inMemory();
	const payload = `context-rss-${"x".repeat(24 * 1024 * 1024)}`;
	manager.appendMessage({ role: "user", content: payload, timestamp: 0 });
	const baseline = collect();
	const context = manager.buildSessionContext();
	const retained = collect();
	process.stdout.write(
		`${JSON.stringify({
			baseline,
			retained,
			rssGrowthBytes: retained.rss - baseline.rss,
			messageBytes: Buffer.byteLength((context.messages[0] as { content: string }).content),
		})}\n`,
	);
	await manager.close();
	process.exit(0);
}

const recordCount = Number.parseInt(process.env.GJC_SESSION_MEMORY_RSS_RECORDS ?? "120000", 10);
if (!Number.isSafeInteger(recordCount) || recordCount < 10) throw new Error("invalid_record_count");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-memory-rss-"));
const sessionFile = path.join(root, "rss.jsonl");
const fd = fs.openSync(sessionFile, "w", 0o600);
const write = (value: unknown): void => {
	fs.writeSync(fd, `${JSON.stringify(value)}\n`);
};
try {
	write({ type: "session", version: 5, id: "rss-session", timestamp: "0", cwd: root });
	for (let index = 0; index < recordCount - 2; index++) {
		write({
			type: "custom",
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: "0",
			customType: "rss",
			data: { value: index },
		});
	}
	write({
		type: "compaction",
		id: "rss-compaction",
		parentId: `entry-${recordCount - 3}`,
		timestamp: "0",
		summary: "summary",
		firstKeptEntryId: `entry-${recordCount - 3}`,
		tokensBefore: recordCount,
	});
} finally {
	fs.closeSync(fd);
}

const baselineRss = collect();
const boundedFirstOpen = process.env.GJC_SESSION_MEMORY_RSS_FIRST_OPEN === "1";
const manager = await SessionManager.open(
	sessionFile,
	SessionManager.explicitDestination(root),
	undefined,
	"copy-retain",
	boundedFirstOpen ? "enabled" : "shadow",
);
const eagerRss = collect();
if (!boundedFirstOpen) manager.setSessionMemoryMode("enabled");
const retiredRss = collect();
const cycleCount = Number.parseInt(process.env.GJC_SESSION_MEMORY_RSS_CYCLES ?? "0", 10);
const cycleRecords = Number.parseInt(process.env.GJC_SESSION_MEMORY_RSS_CYCLE_RECORDS ?? "5000", 10);
const cycleSamples: Array<{ rss: number; heapUsed: number; external: number }> = [];
for (let cycle = 0; cycle < cycleCount; cycle++) {
	let firstKeptEntryId = "";
	for (let index = 0; index < cycleRecords; index++) {
		firstKeptEntryId = manager.appendCustomEntry("rss-cycle", { cycle, index });
	}
	manager.appendCompaction(`cycle ${cycle}`, undefined, firstKeptEntryId, cycleRecords);
	cycleSamples.push(collect());
}
let selectionSamples: Array<{ rss: number; heapUsed: number; external: number }> = [];
if (process.env.GJC_SESSION_MEMORY_RSS_SELECTION === "1") {
	selectionSamples = [collect()];
	const stage = await manager.stageDefaultModelSelection("provider/model", "high", { appendThinkingLevel: true });
	selectionSamples.push(collect());
	const promotion = manager.promoteDefaultModelSelection(stage);
	if (promotion.kind !== "promoted") throw new Error(`selection_${promotion.kind}`);
	selectionSamples.push(collect());
}
let managerClosed = false;
let branchSamples: Array<{ rss: number; heapUsed: number; external: number }> = [];
let branchStats: { coldRetirementActive: boolean; totalAccountedBytes: number } | undefined;
if (process.env.GJC_SESSION_MEMORY_RSS_BRANCH === "1") {
	await manager.close();
	managerClosed = true;
	const branchFile = path.join(root, "branch-rss.jsonl");
	const branchFd = fs.openSync(branchFile, "w", 0o600);
	const writeBranch = (value: unknown): void => {
		fs.writeSync(branchFd, `${JSON.stringify(value)}\n`);
	};
	try {
		writeBranch({ type: "session", version: 5, id: "branch-rss", timestamp: "0", cwd: root });
		writeBranch({ type: "custom", id: "branch-root", parentId: null, timestamp: "0", customType: "rss", data: {} });
		writeBranch({
			type: "custom",
			id: "branch-target-kept",
			parentId: "branch-root",
			timestamp: "0",
			customType: "rss",
			data: {},
		});
		writeBranch({
			type: "custom",
			id: "branch-target-tail",
			parentId: "branch-target-kept",
			timestamp: "0",
			customType: "rss",
			data: {},
		});
		writeBranch({
			type: "compaction",
			id: "branch-target-compaction",
			parentId: "branch-target-tail",
			timestamp: "0",
			summary: "target",
			firstKeptEntryId: "branch-target-kept",
			tokensBefore: recordCount,
		});
		for (let index = 0; index < recordCount; index++) {
			writeBranch({
				type: "custom",
				id: `abandoned-${index}`,
				parentId: "branch-root",
				timestamp: "0",
				customType: "rss",
				data: { value: index },
			});
		}
		writeBranch({
			type: "custom",
			id: "branch-active-kept",
			parentId: "branch-root",
			timestamp: "0",
			customType: "rss",
			data: {},
		});
		writeBranch({
			type: "custom",
			id: "branch-active-tail",
			parentId: "branch-active-kept",
			timestamp: "0",
			customType: "rss",
			data: {},
		});
		writeBranch({
			type: "compaction",
			id: "branch-active-compaction",
			parentId: "branch-active-tail",
			timestamp: "0",
			summary: "active",
			firstKeptEntryId: "branch-active-kept",
			tokensBefore: recordCount,
		});
	} finally {
		fs.closeSync(branchFd);
	}
	const branchManager = await SessionManager.open(
		branchFile,
		SessionManager.explicitDestination(root),
		undefined,
		"copy-retain",
		"enabled",
	);
	branchSamples = [collect()];
	branchManager.branch("branch-target-compaction");
	await Bun.sleep(0);
	branchSamples.push(collect());
	branchStats = branchManager.getSessionMemoryStats();
	await branchManager.close();
}
const stats = branchStats ?? manager.getSessionMemoryStats();
let forkSamples: Array<{ rss: number; heapUsed: number; external: number }> = [];
let forkStats: { coldRetirementActive: boolean; totalAccountedBytes: number } | undefined;
if (process.env.GJC_SESSION_MEMORY_RSS_FORK === "1") {
	await manager.close();
	managerClosed = true;
	const warmSource = path.join(root, "fork-warm.jsonl");
	fs.writeFileSync(
		warmSource,
		`${[
			{ type: "session", version: 5, id: "fork-warm", timestamp: "0", cwd: root },
			{ type: "custom", id: "warm", parentId: null, timestamp: "0", customType: "rss", data: {} },
			{
				type: "compaction",
				id: "warm-compaction",
				parentId: "warm",
				timestamp: "0",
				summary: "warm",
				firstKeptEntryId: "warm",
				tokensBefore: 1,
			},
		]
			.map(value => JSON.stringify(value))
			.join("\n")}\n`,
	);
	const warmed = await SessionManager.forkFrom(
		warmSource,
		root,
		SessionManager.explicitDestination(path.join(root, "fork-warm-output")),
		undefined,
		"copy-retain",
		"enabled",
	);
	await warmed.close();
	forkSamples = [collect()];
	const forked = await SessionManager.forkFrom(
		sessionFile,
		root,
		SessionManager.explicitDestination(path.join(root, "forks")),
		undefined,
		"copy-retain",
		"enabled",
	);
	await Bun.sleep(0);
	forkSamples.push(collect());
	forkStats = forked.getSessionMemoryStats();
	await forked.close();
}
let capturedForkSamples: Array<{ rss: number; heapUsed: number; external: number }> = [];
let capturedForkStats: { coldRetirementActive: boolean; totalAccountedBytes: number } | undefined;
if (process.env.GJC_SESSION_MEMORY_RSS_CAPTURED_FORK === "1") {
	if (!managerClosed) {
		await manager.close();
		managerClosed = true;
	}
	const captured = SessionManager.captureTranscriptStrict(sessionFile);
	if (captured.kind !== "captured") throw new Error(`capture_${captured.reason}`);
	const forkDirectory = path.join(root, "captured-forks");
	fs.mkdirSync(forkDirectory, { recursive: true });
	capturedForkSamples = [collect()];
	const forked = await SessionManager.forkFromCaptured(
		captured.snapshot,
		root,
		SessionManager.explicitDestination(forkDirectory),
		"copy-retain",
		"enabled",
	);
	if (forked.kind !== "forked") throw new Error(`captured_fork_${forked.reason}`);
	await Bun.sleep(0);
	capturedForkSamples.push(collect());
	capturedForkStats = forked.manager.getSessionMemoryStats();
	await forked.manager.close();
	captured.snapshot.close();
}
if (!managerClosed) await manager.close();
if (process.env.GJC_SESSION_MEMORY_RSS_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });

process.stdout.write(
	`${JSON.stringify({
		recordCount,
		root,
		sessionFile,
		baseline: baselineRss,
		eager: eagerRss,
		retired: retiredRss,
		eagerRssDeltaBytes: eagerRss.rss - baselineRss.rss,
		retiredRssDeltaBytes: retiredRss.rss - baselineRss.rss,
		retiredHeapDeltaBytes: retiredRss.heapUsed - baselineRss.heapUsed,
		cycleCount,
		cycleRecords,
		cycleSamples,
		selectionSamples,
		forkSamples,
		forkStats,
		capturedForkSamples,
		capturedForkStats,
		branchSamples,
		stats,
	})}\n`,
);
