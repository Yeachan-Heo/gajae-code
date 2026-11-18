import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir, TempDir } from "@gajae-code/utils";
import { getDashboardStats } from "../src/aggregator";
import { closeDb, initDb, insertMessageStats } from "../src/db";
import type { MessageStats } from "../src/types";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync(path.join(os.homedir(), "pi-stats-db-range-inherited-"));
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
	// Freeze the clock so back-to-back getDashboardStats calls share one cutoff
	// and bucket alignment instead of racing Date.now() across an hour boundary.
	setSystemTime(new Date("2026-10-28T12:00:00.000Z"));
});

afterEach(() => {
	setSystemTime();
	closeDb();
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

function makeMessage(timestamp: number, entryId: string): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		agent: "default",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("getDashboardStats time range with inherited property names", () => {
	it("falls back to 24h for inherited Object property names", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		// "constructor" and "__proto__" survive trim().toLowerCase() unchanged, so a
		// plain-object lookup resolves them to inherited Object members instead of
		// the documented unknown-range fallback.
		for (const range of ["constructor", "__proto__", " CONSTRUCTOR ", "__Proto__"]) {
			const stats = await getDashboardStats(range);
			expect(stats.overall.totalRequests).toBe(1);
			expect(stats.timeSeries.length).toBeGreaterThan(0);
		}
	});

	it("returns the same result as the documented 24h fallback for inherited names", async () => {
		await initDb();

		const now = Date.now();
		insertMessageStats([makeMessage(now, "within-24h"), makeMessage(now - 48 * 60 * 60 * 1000, "outside-24h")]);

		const fallback = await getDashboardStats("24h");
		for (const range of ["constructor", "__proto__"]) {
			const stats = await getDashboardStats(range);
			expect(stats.overall).toEqual(fallback.overall);
			expect(stats.timeSeries.length).toBe(fallback.timeSeries.length);
		}
	});
});
