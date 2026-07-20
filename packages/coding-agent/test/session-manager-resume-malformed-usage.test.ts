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

const NOW = "2026-07-21T00:00:00.000Z";

// biome-ignore lint/suspicious/noExplicitAny: fixtures intentionally carry invalid persisted shapes
type AnyUsage = any;

function assistantEntry(id: string, parentId: string | null, usage: AnyUsage) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: NOW,
		message: { role: "assistant", content: [{ type: "text", text: id }], usage, timestamp: Date.now() },
	};
}

/**
 * Write a real JSONL transcript (header + user root + given assistant records)
 * and resume it through the actual SessionManager.open load path (not a mock).
 */
async function writeAndOpen(dir: string, assistants: Array<ReturnType<typeof assistantEntry>>): Promise<SessionManager> {
	const lines: unknown[] = [
		{ type: "session", version: 4, id: "resume-usage", timestamp: NOW, cwd: dir },
		{
			type: "message",
			id: "user0001",
			parentId: null,
			timestamp: NOW,
			message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
		},
		...assistants,
	];
	const sessionFile = path.join(dir, "2026-07-21T00-00-00-000Z_resume-usage.jsonl");
	await Bun.write(sessionFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return SessionManager.open(sessionFile, dir);
}

const validUsage = {
	input: 10,
	output: 5,
	cacheRead: 1,
	cacheWrite: 2,
	premiumRequests: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
};

describe("SessionManager resume with malformed persisted usage", () => {
	it("resumes a transcript whose assistant entries omit usage or cost instead of crashing", async () => {
		const dir = makeTempDir();
		const manager = await writeAndOpen(dir, [
			assistantEntry("asst0001", "user0001", validUsage),
			assistantEntry("asst0002", "asst0001", undefined), // torn write: no usage at all
			assistantEntry("asst0003", "asst0002", { input: 20, output: 7, cacheRead: 0, cacheWrite: 0 }), // no cost
		]);
		try {
			expect(manager.getLeafId()).toBe("asst0003");
			expect(manager.getEntries().map(e => e.id)).toEqual(["user0001", "asst0001", "asst0002", "asst0003"]);
			const usage = manager.getUsageStatistics();
			// Missing-usage record is skipped; missing-cost record still aggregates its
			// (valid) buckets with cost treated as 0.
			expect(usage.input).toBe(30); // 10 + (skipped) + 20
			expect(usage.output).toBe(12); // 5 + (skipped) + 7
			expect(usage.cacheRead).toBe(1);
			expect(usage.cacheWrite).toBe(2);
			expect(usage.cost).toBe(0.5); // 0.5 + (missing cost -> 0)
		} finally {
			await manager.close();
		}
	});

	it("skips valid-JSON but poisoned usage records (empty, string, negative) without corrupting totals", async () => {
		const dir = makeTempDir();
		const manager = await writeAndOpen(dir, [
			assistantEntry("asst0001", "user0001", validUsage),
			assistantEntry("asst0002", "asst0001", {}), // {} -> would make every bucket NaN
			assistantEntry("asst0003", "asst0002", {
				input: "10",
				output: "5",
				cacheRead: "1",
				cacheWrite: "2",
				cost: { total: "0.5" },
			}), // numeric strings -> would coerce sums into strings ("010")
			assistantEntry("asst0004", "asst0003", {
				input: -1,
				output: -2,
				cacheRead: -3,
				cacheWrite: -4,
				cost: { total: -5 },
			}), // negatives -> would silently reduce totals
			assistantEntry("asst0005", "asst0004", {
				input: 1,
				output: 1,
				cacheRead: 1,
				cacheWrite: 1,
				cost: { total: "9" },
			}), // valid buckets but poisoned cost.total -> whole record rejected
		]);
		try {
			// Every record is still indexed (loaded), only usage aggregation skips the bad ones.
			expect(manager.getEntries()).toHaveLength(6);
			expect(manager.getLeafId()).toBe("asst0005");

			const usage = manager.getUsageStatistics();
			for (const [key, value] of Object.entries(usage)) {
				expect(typeof value, key).toBe("number");
				expect(Number.isFinite(value), key).toBe(true);
				expect(value, key).toBeGreaterThanOrEqual(0);
			}
			// Totals are exactly the single valid record — no NaN, no "010" string, no reduction.
			expect(usage.input).toBe(10);
			expect(usage.output).toBe(5);
			expect(usage.cacheRead).toBe(1);
			expect(usage.cacheWrite).toBe(2);
			expect(usage.premiumRequests).toBe(0);
			expect(usage.cost).toBe(0.5);
		} finally {
			await manager.close();
		}
	});

	it("aggregates a fully valid transcript exactly (compatibility)", async () => {
		const dir = makeTempDir();
		const manager = await writeAndOpen(dir, [
			assistantEntry("asst0001", "user0001", validUsage),
			assistantEntry("asst0002", "asst0001", {
				input: 20,
				output: 7,
				cacheRead: 3,
				cacheWrite: 4,
				premiumRequests: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.5 },
			}),
		]);
		try {
			const usage = manager.getUsageStatistics();
			expect(usage.input).toBe(30);
			expect(usage.output).toBe(12);
			expect(usage.cacheRead).toBe(4);
			expect(usage.cacheWrite).toBe(6);
			expect(usage.premiumRequests).toBe(1);
			expect(usage.cost).toBe(2.0);
		} finally {
			await manager.close();
		}
	});
});
