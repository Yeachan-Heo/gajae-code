import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
	tempDir = TempDir.createSync(path.join(os.homedir(), "pi-stats-failure-report-"));
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
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

interface Row {
	session?: string;
	at: number;
	stop: MessageStats["stopReason"];
	input?: number;
	cacheRead?: number;
	duration?: number;
}

let entryCounter = 0;
function message(row: Row): MessageStats {
	const input = row.input ?? 0;
	const cacheRead = row.cacheRead ?? 0;
	return {
		sessionFile: row.session ?? "/tmp/a.jsonl",
		entryId: `e${++entryCounter}`,
		folder: "/tmp/project",
		agent: "default",
		model: "gpt-5.4",
		provider: "openai",
		api: "openai-responses",
		timestamp: row.at,
		duration: row.duration ?? 1000,
		ttft: 100,
		stopReason: row.stop,
		errorMessage: row.stop === "error" ? "503 upstream" : null,
		usage: {
			input,
			output: 10,
			cacheRead,
			cacheWrite: 0,
			totalTokens: input + cacheRead + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("dashboard failure report", () => {
	it("reports error+abort share and full-prefix misses on the request after a failure", async () => {
		await initDb();
		const now = Date.now();
		insertMessageStats([
			// Session A: warm, then error + abort, then a full miss re-paying 50k tokens.
			message({ at: now - 60_000, stop: "stop", input: 500, cacheRead: 40_000 }),
			message({ at: now - 50_000, stop: "error", duration: 30_000 }),
			message({ at: now - 40_000, stop: "aborted", duration: 5_000 }),
			message({ at: now - 30_000, stop: "toolUse", input: 50_000, cacheRead: 0 }),
			message({ at: now - 20_000, stop: "stop", input: 300, cacheRead: 50_000 }),
			// Session B: an error followed by a cache hit is not a miss.
			message({ session: "/tmp/b.jsonl", at: now - 55_000, stop: "error", duration: 1_000 }),
			message({ session: "/tmp/b.jsonl", at: now - 45_000, stop: "stop", input: 400, cacheRead: 30_000 }),
			// Session C: an uncacheable short prompt after an error is not a miss, and a
			// cold first request with no preceding failure is never counted.
			message({ session: "/tmp/c.jsonl", at: now - 58_000, stop: "stop", input: 80_000, cacheRead: 0 }),
			message({ session: "/tmp/c.jsonl", at: now - 57_000, stop: "error", duration: 2_000 }),
			message({ session: "/tmp/c.jsonl", at: now - 56_000, stop: "stop", input: 1_000, cacheRead: 0 }),
		]);

		const { failures } = await getDashboardStats("24h");

		expect(failures).toEqual({
			totalRequests: 10,
			erroredRequests: 3,
			abortedRequests: 1,
			failureShare: 0.4,
			failedDurationMs: 38_000,
			postFailureRequests: 3,
			postFailureFullMissRequests: 1,
			postFailureFullMissTokens: 50_000,
		});
	});

	it("only counts rows inside the selected window", async () => {
		await initDb();
		const now = Date.now();
		const twoDaysAgo = now - 48 * 60 * 60 * 1000;
		insertMessageStats([
			message({ at: twoDaysAgo, stop: "error" }),
			message({ at: twoDaysAgo + 1_000, stop: "stop", input: 60_000, cacheRead: 0 }),
			message({ at: now - 1_000, stop: "stop", input: 200, cacheRead: 60_000 }),
		]);

		expect((await getDashboardStats("24h")).failures).toMatchObject({
			totalRequests: 1,
			erroredRequests: 0,
			failureShare: 0,
			postFailureFullMissTokens: 0,
		});
		expect((await getDashboardStats("7d")).failures).toMatchObject({
			totalRequests: 3,
			erroredRequests: 1,
			postFailureFullMissRequests: 1,
			postFailureFullMissTokens: 60_000,
		});
	});
});
