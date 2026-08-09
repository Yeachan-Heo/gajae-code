import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exportSessionToHtml } from "../../../src/export/html";
import { SessionManager } from "../../../src/session/session-manager";

const recordCount = 120_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-memory-export-rss-"));
const sessionFile = path.join(root, "rss.jsonl");
const fd = fs.openSync(sessionFile, "w", 0o600);
const write = (value: unknown): void => {
	fs.writeSync(fd, `${JSON.stringify(value)}\n`);
};
try {
	write({ type: "session", version: 5, id: "rss-export-session", timestamp: "0", cwd: root });
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
	fs.fsyncSync(fd);
} finally {
	fs.closeSync(fd);
}

const collect = (): { rss: number; heapUsed: number; external: number } => {
	Bun.gc(true);
	const usage = process.memoryUsage();
	return { rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external };
};

const manager = await SessionManager.open(
	sessionFile,
	SessionManager.explicitDestination(root),
	undefined,
	"copy-retain",
	"shadow",
);
manager.setSessionMemoryMode("enabled");
const before = collect();
await exportSessionToHtml(manager, undefined, { outputPath: path.join(root, "rss-export.html") });
const after = collect();
const stats = manager.getSessionMemoryStats();
await manager.close();
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ recordCount, samples: [before, after], stats })}\n`);
