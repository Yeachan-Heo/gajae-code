import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-malformed-usage-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * Concurrent multi-writer / NFS corruption (torn appends) can leave a session
 * transcript with an assistant entry that parses as JSON but is missing `usage`
 * (or a `usage` without `cost`). parseSessionEntries already tolerates fully
 * unparseable lines; resume must likewise not crash on one parseable-but-malformed
 * entry while aggregating usage in #buildIndex.
 */
async function writeCorruptedSession(dir: string): Promise<string> {
	const now = new Date().toISOString();
	const wellFormedUsage = {
		input: 10,
		output: 5,
		cacheRead: 1,
		cacheWrite: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
	};
	const lines = [
		{ type: "session", version: 4, id: "resume-corrupt", timestamp: now, cwd: dir },
		{
			type: "message",
			id: "user0001",
			parentId: null,
			timestamp: now,
			message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
		},
		{
			type: "message",
			id: "asst0001",
			parentId: "user0001",
			timestamp: now,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				usage: wellFormedUsage,
				timestamp: Date.now(),
			},
		},
		// Torn write: assistant entry with no `usage` at all (the medusa-aea crash).
		{
			type: "message",
			id: "asst0002",
			parentId: "asst0001",
			timestamp: now,
			message: { role: "assistant", content: [{ type: "text", text: "torn" }], timestamp: Date.now() },
		},
		// Torn write: `usage` present but missing the `cost` object.
		{
			type: "message",
			id: "asst0003",
			parentId: "asst0002",
			timestamp: now,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "torn-cost" }],
				usage: { input: 20, output: 7, cacheRead: 0, cacheWrite: 0 },
				timestamp: Date.now(),
			},
		},
	];
	const sessionFile = path.join(dir, "2026-07-06T08-51-54-093Z_resume-corrupt.jsonl");
	await Bun.write(sessionFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return sessionFile;
}

describe("SessionManager resume with malformed persisted usage", () => {
	it("loads a transcript whose assistant entries are missing usage/cost instead of crashing", async () => {
		const dir = makeTempDir();
		const sessionFile = await writeCorruptedSession(dir);

		const manager = await SessionManager.open(sessionFile, dir);
		try {
			// The malformed tail entry is indexed and becomes the resumed leaf.
			expect(manager.getLeafId()).toBe("asst0003");
			expect(manager.getEntries().map(entry => entry.id)).toEqual(["user0001", "asst0001", "asst0002", "asst0003"]);

			// Usage aggregation skips the entry with no usage and treats the missing
			// cost object as zero, while still counting every well-formed field.
			const usage = manager.getUsageStatistics();
			expect(usage.input).toBe(30); // 10 + (skipped) + 20
			expect(usage.output).toBe(12); // 5 + (skipped) + 7
			expect(usage.cacheRead).toBe(1);
			expect(usage.cacheWrite).toBe(2);
			expect(usage.cost).toBe(0.5); // 0.5 + (skipped) + (missing cost -> 0)
		} finally {
			await manager.close();
		}
	});
});
