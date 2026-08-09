import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../../../src/session/session-manager";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-memory-gib-fork-"));
const sourceFile = path.join(root, "source.jsonl");
const destinationDirectory = path.join(root, "forks");
fs.mkdirSync(destinationDirectory);
const fd = fs.openSync(sourceFile, "w", 0o600);
const payload = "x".repeat(1024 * 1024);
const write = (value: unknown): void => {
	fs.writeSync(fd, `${JSON.stringify(value)}\n`);
};
try {
	write({ type: "session", version: 5, id: "gib-fork-source", timestamp: "0", cwd: root });
	for (let index = 0; index < 1020; index++) {
		write({
			type: "custom",
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: "0",
			customType: "gib-fork",
			data: { payload },
		});
	}
	write({
		type: "compaction",
		id: "gib-fork-compaction",
		parentId: "entry-1019",
		timestamp: "0",
		summary: "summary",
		firstKeptEntryId: "entry-1019",
		tokensBefore: 1020,
	});
	fs.fsyncSync(fd);
} finally {
	fs.closeSync(fd);
}
const capturedMode = process.env.GJC_SESSION_MEMORY_GIB_CAPTURED === "1";
const captured = capturedMode ? SessionManager.captureTranscriptStrict(sourceFile) : undefined;
if (captured?.kind === "error") throw new Error(`capture_${captured.reason}`);

Bun.gc(true);
const sourceBytes = fs.statSync(sourceFile).size;
const baselineRss = process.memoryUsage().rss;
const startedAt = performance.now();
let manager: SessionManager;
if (captured?.kind === "captured") {
	const forked = await SessionManager.forkFromCaptured(
		captured.snapshot,
		root,
		SessionManager.explicitDestination(destinationDirectory),
		"copy-retain",
		"enabled",
	);
	if (forked.kind !== "forked") throw new Error(`captured_fork_${forked.reason}`);
	manager = forked.manager;
} else {
	manager = await SessionManager.forkFrom(
		sourceFile,
		root,
		SessionManager.explicitDestination(destinationDirectory),
		undefined,
		"copy-retain",
		"enabled",
	);
}
const elapsedMs = performance.now() - startedAt;
await Bun.sleep(0);
Bun.gc(true);
const rssGrowthBytes = process.memoryUsage().rss - baselineRss;
const stats = manager.getSessionMemoryStats();
await manager.close();
if (captured?.kind === "captured") captured.snapshot.close();
fs.rmSync(root, { recursive: true, force: true });

process.stdout.write(`${JSON.stringify({ capturedMode, sourceBytes, elapsedMs, rssGrowthBytes, stats })}\n`);
