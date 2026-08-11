import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "../../../src/session/session-manager";

const sessionFile = process.env.GJC_SESSION_MEMORY_RSS_SESSION;
if (!sessionFile) throw new Error("missing_session_file");

const collect = (): { rss: number; heapUsed: number; external: number } => {
	Bun.gc(true);
	const usage = process.memoryUsage();
	return { rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external };
};

const baseline = collect();
const manager = await SessionManager.open(
	sessionFile,
	SessionManager.explicitDestination(path.dirname(sessionFile)),
	undefined,
	"copy-retain",
	"enabled",
);
const opened = collect();
const stats = manager.getSessionMemoryStats();
const contextMessages = manager.buildSessionContext().messages.length;
await manager.close();
if (process.env.GJC_SESSION_MEMORY_RSS_REMOVE === "1")
	fs.rmSync(path.dirname(sessionFile), { recursive: true, force: true });

process.stdout.write(
	`${JSON.stringify({ baseline, opened, rssDeltaBytes: opened.rss - baseline.rss, stats, contextMessages })}\n`,
);
