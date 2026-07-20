import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type UsageStatistics } from "@gajae-code/coding-agent/session/session-manager";
import { logger } from "@gajae-code/utils";

const tempDirs: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close().catch(() => {});
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-malformed-usage-"));
	tempDirs.push(dir);
	return dir;
}

const NOW = "2026-07-21T00:00:00.000Z";

// `usage` fixtures intentionally carry invalid persisted shapes (missing fields, numeric strings,
// negatives, non-record cost, overflow), so they are typed `unknown` — the load/append paths must
// tolerate any parseable JSON.
function assistantEntry(id: string, parentId: string | null, usage: unknown) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: NOW,
		message: { role: "assistant", content: [{ type: "text", text: id }], usage, timestamp: Date.now() },
	};
}

// A `task` tool-result whose usage lives in `details.usage` (read via getTaskToolUsage).
function taskResultEntry(id: string, parentId: string | null, usage: unknown) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: NOW,
		message: {
			role: "toolResult",
			toolName: "task",
			toolCallId: id,
			content: [{ type: "text", text: id }],
			details: usage === undefined ? {} : { usage },
			timestamp: Date.now(),
		},
	};
}

async function writeAndOpen(dir: string, messageEntries: unknown[]): Promise<SessionManager> {
	const lines: unknown[] = [
		{ type: "session", version: 4, id: "resume-usage", timestamp: NOW, cwd: dir },
		{
			type: "message",
			id: "user0001",
			parentId: null,
			timestamp: NOW,
			message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
		},
		...messageEntries,
	];
	const sessionFile = path.join(dir, "2026-07-21T00-00-00-000Z_resume-usage.jsonl");
	await Bun.write(sessionFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	const manager = await SessionManager.open(sessionFile, dir);
	managers.push(manager);
	return manager;
}

function appendAssistant(sm: SessionManager, usage: unknown): void {
	const message = { role: "assistant", content: [{ type: "text", text: "x" }], usage, timestamp: Date.now() };
	sm.appendMessage(message as unknown as Parameters<SessionManager["appendMessage"]>[0]);
}

function expectFiniteNonNegative(usage: UsageStatistics): void {
	for (const [key, value] of Object.entries(usage)) {
		expect(typeof value, key).toBe("number");
		expect(Number.isFinite(value), key).toBe(true);
		expect(value, key).toBeGreaterThanOrEqual(0);
	}
}

const validUsage = {
	input: 10,
	output: 5,
	cacheRead: 1,
	cacheWrite: 2,
	premiumRequests: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
};

describe("SessionManager usage validation on resume and append", () => {
	it("resumes a transcript whose assistant entries omit usage or cost instead of crashing", async () => {
		const dir = makeTempDir();
		const manager = await writeAndOpen(dir, [
			assistantEntry("asst0001", "user0001", validUsage),
			assistantEntry("asst0002", "asst0001", undefined), // torn write: no usage at all
			assistantEntry("asst0003", "asst0002", { input: 20, output: 7, cacheRead: 0, cacheWrite: 0 }), // no cost
		]);
		expect(manager.getLeafId()).toBe("asst0003");
		expect(manager.getEntries().map(entry => entry.id)).toEqual(["user0001", "asst0001", "asst0002", "asst0003"]);
		const usage = manager.getUsageStatistics();
		expect(usage.input).toBe(30); // 10 + (skipped) + 20
		expect(usage.output).toBe(12); // 5 + (skipped) + 7
		expect(usage.cacheRead).toBe(1);
		expect(usage.cacheWrite).toBe(2);
		expect(usage.cost).toBe(0.5); // 0.5 + (missing cost -> 0)
	});

	it("skips valid-JSON but poisoned usage records (empty, string, negative, poisoned cost)", async () => {
		const dir = makeTempDir();
		const manager = await writeAndOpen(dir, [
			assistantEntry("asst0001", "user0001", validUsage),
			assistantEntry("asst0002", "asst0001", {}), // {} -> NaN buckets
			assistantEntry("asst0003", "asst0002", {
				input: "10",
				output: "5",
				cacheRead: "1",
				cacheWrite: "2",
				cost: { total: "0.5" },
			}), // numeric strings -> "010" coercion
			assistantEntry("asst0004", "asst0003", {
				input: -1,
				output: -2,
				cacheRead: -3,
				cacheWrite: -4,
				cost: { total: -5 },
			}), // negatives -> silent reduction
			assistantEntry("asst0005", "asst0004", {
				input: 1,
				output: 1,
				cacheRead: 1,
				cacheWrite: 1,
				cost: { total: "9" },
			}), // valid buckets, poisoned cost.total -> whole record rejected
		]);
		expect(manager.getEntries()).toHaveLength(6);
		expect(manager.getLeafId()).toBe("asst0005");
		const usage = manager.getUsageStatistics();
		expectFiniteNonNegative(usage);
		expect(usage.input).toBe(10);
		expect(usage.output).toBe(5);
		expect(usage.cacheRead).toBe(1);
		expect(usage.cacheWrite).toBe(2);
		expect(usage.premiumRequests).toBe(0);
		expect(usage.cost).toBe(0.5);
	});

	it("rejects a present but non-record cost container (array)", async () => {
		const dir = makeTempDir();
		const manager = await writeAndOpen(dir, [
			assistantEntry("asst0001", "user0001", validUsage),
			assistantEntry("asst0002", "asst0001", { input: 3, output: 3, cacheRead: 0, cacheWrite: 0, cost: [] }),
		]);
		const usage = manager.getUsageStatistics();
		expectFiniteNonNegative(usage);
		expect(usage.input).toBe(10); // array-cost record skipped
		expect(usage.cost).toBe(0.5);
	});

	it("rejects present-but-null or incomplete usage fields (null premiumRequests, null/empty cost)", async () => {
		const dir = makeTempDir();
		const manager = await writeAndOpen(dir, [
			assistantEntry("asst0001", "user0001", validUsage),
			// present-but-null premiumRequests must be rejected, not treated as 0
			assistantEntry("asst0002", "asst0001", {
				input: 2,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: null,
				cost: { total: 0 },
			}),
			// present-but-null cost must be rejected, not treated as absent
			assistantEntry("asst0003", "asst0002", { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: null }),
			// present cost without a `total` must be rejected, not treated as 0
			assistantEntry("asst0004", "asst0003", { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: {} }),
		]);
		const usage = manager.getUsageStatistics();
		expectFiniteNonNegative(usage);
		// Only the fully valid record counts; the incomplete records are skipped, not zero-defaulted.
		expect(usage.input).toBe(10);
		expect(usage.premiumRequests).toBe(0);
		expect(usage.cost).toBe(0.5);
	});

	it("rejects a record that would overflow cumulative totals to Infinity", async () => {
		const dir = makeTempDir();
		const big = Number.MAX_VALUE;
		const manager = await writeAndOpen(dir, [
			assistantEntry("asst0001", "user0001", {
				input: big,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			}),
			assistantEntry("asst0002", "asst0001", {
				input: big,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			}),
		]);
		const usage = manager.getUsageStatistics();
		expectFiniteNonNegative(usage); // no Infinity
		expect(usage.input).toBe(big); // second record rejected so cumulative stays finite
	});

	it("validates task tool-result usage through the same shared path", async () => {
		const dir = makeTempDir();
		const manager = await writeAndOpen(dir, [
			taskResultEntry("task0001", "user0001", {
				input: 4,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			}),
			taskResultEntry("task0002", "task0001", { input: "9", output: 1, cacheRead: 0, cacheWrite: 0 }), // string -> skipped
			taskResultEntry("task0003", "task0002", undefined), // no usage -> ignored
		]);
		const usage = manager.getUsageStatistics();
		expectFiniteNonNegative(usage);
		expect(usage.input).toBe(4);
		expect(usage.output).toBe(3);
		expect(usage.cost).toBe(0.25);
	});

	it("skips malformed usage on the runtime append path (#appendEntry) too", () => {
		const dir = makeTempDir();
		const sm = SessionManager.create(dir, path.join(dir, "sessions"));
		managers.push(sm);
		appendAssistant(sm, validUsage);
		appendAssistant(sm, {}); // NaN
		appendAssistant(sm, { input: "10", output: "5", cacheRead: "1", cacheWrite: "2", cost: { total: "0.5" } }); // strings
		appendAssistant(sm, { input: -1, output: -1, cacheRead: -1, cacheWrite: -1, cost: { total: -1 } }); // negatives
		appendAssistant(sm, {
			input: 3,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: null,
			cost: { total: 0 },
		}); // null premiumRequests
		appendAssistant(sm, { input: 3, output: 3, cacheRead: 0, cacheWrite: 0, cost: null }); // null cost
		appendAssistant(sm, { input: 3, output: 3, cacheRead: 0, cacheWrite: 0, cost: {} }); // empty cost (no total)
		const usage = sm.getUsageStatistics();
		expectFiniteNonNegative(usage);
		expect(usage.input).toBe(10);
		expect(usage.cost).toBe(0.5);
	});

	it("reports skipped records with a single bounded warning (sample capped)", async () => {
		const dir = makeTempDir();
		const warn = spyOn(logger, "warn");
		try {
			const malformed = Array.from({ length: 20 }, (_, index) =>
				assistantEntry(`bad${index}`, index === 0 ? "user0001" : `bad${index - 1}`, {}),
			);
			await writeAndOpen(dir, [assistantEntry("good", "user0001", validUsage), ...malformed]);
			const calls = warn.mock.calls.filter(call =>
				String(call[0]).includes("Skipped malformed or overflowing persisted usage records"),
			);
			expect(calls).toHaveLength(1); // one batched report for the whole resume
			const meta = calls[0][1] as { count: number; sampleEntryIds: string[] };
			expect(meta.count).toBe(20);
			expect(meta.sampleEntryIds.length).toBeLessThanOrEqual(8); // bounded sample
		} finally {
			warn.mockRestore();
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
		const usage = manager.getUsageStatistics();
		expect(usage.input).toBe(30);
		expect(usage.output).toBe(12);
		expect(usage.cacheRead).toBe(4);
		expect(usage.cacheWrite).toBe(6);
		expect(usage.premiumRequests).toBe(1);
		expect(usage.cost).toBe(2.0);
	});
});
