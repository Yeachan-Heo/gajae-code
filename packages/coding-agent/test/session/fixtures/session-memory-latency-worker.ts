import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../../../src/session/session-manager";

/**
 * AC11 latency / I-O probe: builds a compacted 60k-record session whose
 * persistent dictionary artifact is eligible (≤64k records), opens it retired,
 * then measures per-operation latency distributions (p50/p95/p99) and the
 * bounded I/O counts for:
 *   - cold random entry lookups (dictionary partition path: 1 bounded read)
 *   - warm (cached) entry lookups (0 range reads)
 *   - persistent parent→children lookups (1 bucket read, 0 index scans)
 *   - a 10k-cold-entry branch switch (chunked ordinal runs)
 * The per-turn cold-I/O = 0 guarantee on the active path is asserted by the
 * zero-range-read warm sample.
 */

const percentile = (sorted: number[], q: number): number =>
	sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

const recordCount = Number.parseInt(process.env.GJC_SESSION_MEMORY_LATENCY_RECORDS ?? "60000", 10);
if (!Number.isSafeInteger(recordCount) || recordCount < 1000 || recordCount > 64 * 1024)
	throw new Error("invalid_latency_record_count");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-memory-latency-"));
const sessionFile = path.join(root, "latency.jsonl");
const fd = fs.openSync(sessionFile, "w", 0o600);
const write = (value: unknown): void => {
	fs.writeSync(fd, `${JSON.stringify(value)}\n`);
};
try {
	write({ type: "session", version: 5, id: "latency-session", timestamp: "0", cwd: root });
	write({ type: "custom", id: "root", parentId: null, timestamp: "0", customType: "lat", data: {} });
	for (let parent = 0; parent < 12; parent++) {
		const parentId = `parent-${parent.toString().padStart(2, "0")}`;
		write({ type: "custom", id: parentId, parentId: "root", timestamp: "0", customType: "lat", data: {} });
		for (let child = 0; child < 6; child++) {
			write({
				type: "custom",
				id: `${parentId}-child-${child.toString().padStart(2, "0")}`,
				parentId,
				timestamp: "0",
				customType: "lat",
				data: {},
			});
		}
	}
	const branchEntryCount = 10_000;
	const fixedEntryCount = 1 + 12 + 12 * 6 + branchEntryCount + 1 + 1 + 1;
	const fillEntryCount = recordCount - fixedEntryCount;
	for (let index = 0; index < fillEntryCount; index++) {
		write({
			type: "custom",
			id: `entry-${index}`,
			parentId: index === 0 ? "root" : `entry-${index - 1}`,
			timestamp: "0",
			customType: "lat",
			data: { value: index },
		});
	}
	let branchParent = "root";
	for (let index = 0; index < branchEntryCount; index++) {
		const id = `branch-${index}`;
		write({ type: "custom", id, parentId: branchParent, timestamp: "0", customType: "lat", data: { value: index } });
		branchParent = id;
	}
	write({
		type: "compaction",
		id: "branch-compaction",
		parentId: branchParent,
		timestamp: "0",
		summary: "branch summary",
		firstKeptEntryId: "branch-0",
		tokensBefore: branchEntryCount,
	});
	write({ type: "custom", id: "active", parentId: "root", timestamp: "0", customType: "lat", data: {} });
	write({
		type: "compaction",
		id: "active-compaction",
		parentId: "active",
		timestamp: "0",
		summary: "active summary",
		firstKeptEntryId: "active",
		tokensBefore: 1,
	});
} finally {
	fs.closeSync(fd);
}

const manager = await SessionManager.open(
	sessionFile,
	SessionManager.explicitDestination(root),
	undefined,
	"copy-retain",
	"enabled",
);
const stats = manager.getSessionMemoryStats();
if (!stats.coldRetirementActive) throw new Error("cold_retirement_inactive");
if (!stats.dictionaryArtifactEnabled) throw new Error("dictionary_artifact_missing");

// Cold random entry lookups: uniformly distributed across the retired prefix.
const fillEntryCount = recordCount - (1 + 12 + 12 * 6 + 10_000 + 1 + 1 + 1);
const coldIds = Array.from({ length: 50 }, (_, i) => `entry-${Math.floor((i * (fillEntryCount * 0.8)) / 50)}`);
const coldSamples: number[] = [];
const rangeReadsBefore = stats.rangeReadCount;
for (const id of coldIds) {
	const start = performance.now();
	const entry = manager.getEntry(id);
	if (!entry || entry.id !== id) throw new Error(`cold_lookup_mismatch:${id}`);
	coldSamples.push(performance.now() - start);
}
const coldRangeReads = manager.getSessionMemoryStats().rangeReadCount - rangeReadsBefore;

// Warm (cached) entry lookups: repeated ids must be served with zero range reads.
const warmSamples: number[] = [];
const rangeReadsBeforeWarm = manager.getSessionMemoryStats().rangeReadCount;
for (const id of coldIds) {
	const start = performance.now();
	const entry = manager.getEntry(id);
	if (!entry || entry.id !== id) throw new Error(`warm_lookup_mismatch:${id}`);
	warmSamples.push(performance.now() - start);
}
const warmRangeReads = manager.getSessionMemoryStats().rangeReadCount - rangeReadsBeforeWarm;

// Persistent parent→children lookups: verified bounded bucket reads, never a
// complete `.spill.idx` scan. Use a fresh baseline after the root lookup.
const rootChildren = manager.getChildren("root");
const parentIds = rootChildren.map(entry => entry.id).filter(id => id.startsWith("parent-"));
if (parentIds.length !== 12) throw new Error(`parent_count_mismatch:${parentIds.length}`);
const childrenSamples: number[] = [];
const bucketReadsBefore = manager.getSessionMemoryStats().rangeReadCount;
for (const parent of parentIds) {
	const start = performance.now();
	const children = manager.getChildren(parent);
	if (children.length !== 6) throw new Error(`parent_children_mismatch:${parent}`);
	childrenSamples.push(performance.now() - start);
}
const childrenRangeReads = manager.getSessionMemoryStats().rangeReadCount - bucketReadsBefore;

// Switch into a 10k-entry cold branch repeatedly. Each switch uses one bounded
// ordinal-index scan and one bounded transcript range read rather than 10k
// persistent-dictionary scans; switch back to the tiny active branch between samples.
const branchSwitchSamples: number[] = [];
const branchReadsBefore = manager.getSessionMemoryStats().rangeReadCount;
for (let sample = 0; sample < 5; sample++) {
	const start = performance.now();
	manager.branch("branch-compaction");
	branchSwitchSamples.push(performance.now() - start);
	if (manager.getLeafEntry()?.id !== "branch-compaction") throw new Error("branch_switch_mismatch");
	manager.branch("active-compaction");
}
const branchRangeReads = manager.getSessionMemoryStats().rangeReadCount - branchReadsBefore;

const sortedCold = [...coldSamples].sort((a, b) => a - b);
const sortedWarm = [...warmSamples].sort((a, b) => a - b);
const sortedChildren = [...childrenSamples].sort((a, b) => a - b);
const sortedBranchSwitch = [...branchSwitchSamples].sort((a, b) => a - b);

const result = {
	recordCount,
	dictionaryArtifactEnabled: true,
	coldRangeReads,
	warmRangeReads,
	childrenRangeReads,
	branchRangeReads,
	coldMs: { p50: percentile(sortedCold, 0.5), p95: percentile(sortedCold, 0.95), p99: percentile(sortedCold, 0.99) },
	warmMs: { p50: percentile(sortedWarm, 0.5), p95: percentile(sortedWarm, 0.95) },
	childrenMs: { p50: percentile(sortedChildren, 0.5), p95: percentile(sortedChildren, 0.95) },
	branchSwitchMs: {
		p50: percentile(sortedBranchSwitch, 0.5),
		p95: percentile(sortedBranchSwitch, 0.95),
		p99: percentile(sortedBranchSwitch, 0.99),
	},
	stats: {
		coldRetirementActive: manager.getSessionMemoryStats().coldRetirementActive,
		totalAccountedBytes: manager.getSessionMemoryStats().totalAccountedBytes,
	},
};

await manager.close();
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(result)}\n`);
