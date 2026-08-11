import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../../../src/session/session-manager";

/**
 * RSS probe for the persistent parent→children artifact: builds a compacted
 * tree transcript whose parent set fits the fixed bounds, reopens it, then
 * performs many distinct-parent lookups and samples process RSS. The artifact
 * path serves every lookup with one bounded bucket read, so RSS must stay flat.
 */

const collect = (): { rss: number; heapUsed: number; external: number } => {
	const usage = process.memoryUsage();
	return { rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external };
};

const parentCount = 200;
const childrenPerParent = 12;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-memory-parent-rss-"));
const sessionFile = path.join(root, "parent-rss.jsonl");
const fd = fs.openSync(sessionFile, "w", 0o600);
const write = (value: unknown): void => {
	fs.writeSync(fd, `${JSON.stringify(value)}\n`);
};
try {
	write({ type: "session", version: 5, id: "parent-rss", timestamp: "0", cwd: root });
	write({ type: "custom", id: "root", parentId: null, timestamp: "0", customType: "node", data: {} });
	const parents: string[] = [];
	for (let index = 0; index < parentCount; index++) {
		const parent = `parent-${index.toString().padStart(3, "0")}`;
		parents.push(parent);
		write({ type: "custom", id: parent, parentId: "root", timestamp: "0", customType: "node", data: {} });
	}
	for (const parent of parents) {
		for (let index = 0; index < childrenPerParent; index++) {
			write({
				type: "custom",
				id: `${parent}-child-${index.toString().padStart(2, "0")}`,
				parentId: parent,
				timestamp: "0",
				customType: "node",
				data: {},
			});
		}
	}
	write({ type: "custom", id: "active", parentId: "root", timestamp: "0", customType: "node", data: {} });
	write({
		type: "compaction",
		id: "active-compaction",
		parentId: "active",
		timestamp: "0",
		summary: "summary",
		firstKeptEntryId: "active",
		tokensBefore: 1,
	});
} finally {
	fs.closeSync(fd);
}

const baselineRss = collect();
const manager = await SessionManager.open(
	sessionFile,
	SessionManager.explicitDestination(root),
	undefined,
	"copy-retain",
	"enabled",
);
const openRss = collect();
const parentIds = Array.from({ length: parentCount }, (_, index) => `parent-${index.toString().padStart(3, "0")}`);
const samples: Array<{ rss: number; heapUsed: number; external: number }> = [openRss];
let sampled = 0;
for (const parent of parentIds) {
	const children = manager.getChildren(parent);
	if (children.length !== childrenPerParent) throw new Error(`lookup_mismatch:${parent}`);
	sampled++;
	if (sampled % 50 === 0) samples.push(collect());
}
const finalSample = collect();
samples.push(finalSample);
const stats = manager.getSessionMemoryStats();
await manager.close();
fs.rmSync(root, { recursive: true, force: true });

process.stdout.write(
	`${JSON.stringify({
		parentCount,
		childrenPerParent,
		baselineRss,
		samples,
		stats: {
			coldRetirementActive: stats.coldRetirementActive,
			totalAccountedBytes: stats.totalAccountedBytes,
		},
	})}\n`,
);
