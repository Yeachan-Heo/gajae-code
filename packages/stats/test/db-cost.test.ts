import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { getAgentDir, getStatsDbPath, setAgentDir, TempDir } from "@gajae-code/utils";
import { closeDb, getOverallStats, getRecentRequests, getStatsByAgent, initDb, insertMessageStats } from "../src/db";
import { parseSessionFile } from "../src/parser";
import type { MessageStats, ParsedMessageStats } from "../src/types";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync(path.join(os.homedir(), "pi-stats-db-"));
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

function createCodexGptStats(entryId: string): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		agent: "default",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp: Date.now(),
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

function expectedCodexGptCost() {
	const cost = getBundledModel("openai-codex", "gpt-5.4").cost;
	const input = (cost.input / 1_000_000) * 1000;
	const output = (cost.output / 1_000_000) * 500;
	const cacheRead = (cost.cacheRead / 1_000_000) * 200;
	return {
		input,
		output,
		cacheRead,
		total: input + output + cacheRead,
	};
}

describe("stats GPT cost correction", () => {
	it.each([
		undefined,
		null,
		{},
		"invalid",
		{ input: null, output: "1", cacheRead: NaN, total: Infinity },
	])("repairs malformed cost %j using catalog pricing without losing tokens", async cost => {
		await initDb();
		const stats: ParsedMessageStats = createCodexGptStats("malformed");
		stats.usage = { ...stats.usage, cost };
		expect(insertMessageStats([stats])).toBe(1);
		const request = getRecentRequests(1)[0];
		expect(request.usage.cost).toEqual({ ...expectedCodexGptCost(), cacheWrite: 0 });
		expect(request.usage.totalTokens).toBe(1700);
	});

	it.each([
		{ input: 0, output: 0, cacheRead: 0, total: 0 },
		{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 15 },
		{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 0 },
	])("preserves recorded finite costs %j", async cost => {
		await initDb();
		const stats: ParsedMessageStats = createCodexGptStats("recorded");
		stats.usage = { ...stats.usage, cost };
		expect(insertMessageStats([stats])).toBe(1);
		expect(getRecentRequests(1)[0].usage.cost).toEqual({ cacheWrite: 0, ...cost });
	});

	it("preserves recorded components with a zero total across database reopen", async () => {
		await initDb();
		const stats = createCodexGptStats("zero-total-recorded");
		stats.usage.cost = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 0 };
		insertMessageStats([stats]);
		const before = getOverallStats();
		closeDb();
		await initDb();
		expect(getRecentRequests(1)[0].usage.cost).toEqual(stats.usage.cost);
		expect(getOverallStats()).toEqual(before);
		expect(getOverallStats().totalCost).toBe(0);
	});

	it("does not reprice a priced model's partial explicit zeros between parsing and insertion", async () => {
		await initDb();
		const stats = createCodexGptStats("partial-zero");
		const file = tempDir!.join("partial-zero.jsonl");
		await fs.writeFile(
			file,
			`${JSON.stringify({
				type: "message",
				id: stats.entryId,
				message: {
					role: "assistant",
					model: stats.model,
					provider: stats.provider,
					api: stats.api,
					timestamp: stats.timestamp,
					usage: { ...stats.usage, cost: { input: 0, output: 0, cacheRead: 0, total: 0 } },
				},
			})}\n`,
		);
		const parsed = await parseSessionFile(file);
		expect(parsed.stats).toHaveLength(1);
		expect(insertMessageStats(parsed.stats)).toBe(1);
		expect(getRecentRequests(1)[0].usage.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		});
	});

	it("fills only invalid components and derives a missing total", async () => {
		await initDb();
		const stats: ParsedMessageStats = createCodexGptStats("partial");
		stats.usage = { ...stats.usage, cost: { input: 0, output: 0.25, cacheRead: -Infinity } };
		insertMessageStats([stats]);
		const cacheRead = expectedCodexGptCost().cacheRead;
		expect(getRecentRequests(1)[0].usage.cost).toEqual({
			input: 0,
			output: 0.25,
			cacheRead,
			cacheWrite: 0,
			total: 0.25 + cacheRead,
		});
	});

	it("retains partial historical usage through parsing and insertion without catalog pricing", async () => {
		await initDb();
		const stats = createCodexGptStats("historical");
		const file = tempDir!.join("historical.jsonl");
		await fs.writeFile(
			file,
			`${JSON.stringify({
				type: "message",
				id: stats.entryId,
				timestamp: new Date(stats.timestamp).toISOString(),
				message: {
					role: "assistant",
					model: "unpriced-model",
					provider: "unpriced-provider",
					api: stats.api,
					timestamp: stats.timestamp,
					usage: { ...stats.usage, premiumRequests: 2, cost: { output: 0.5, total: 0.75 } },
				},
			})}\n`,
		);
		const parsed = await parseSessionFile(file);
		expect(parsed.stats).toHaveLength(1);
		expect(insertMessageStats(parsed.stats)).toBe(1);
		const request = getRecentRequests(1)[0];
		expect(request.stopReason).toBe("unknown");
		expect(request.usage).toEqual({
			...stats.usage,
			premiumRequests: 2,
			cost: { input: 0, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 0.75 },
		});
	});
	it("stores catalog-derived cost when OpenAI Codex session usage has zero cost", async () => {
		await initDb();

		insertMessageStats([createCodexGptStats("inserted")]);

		const expected = expectedCodexGptCost();
		const request = getRecentRequests(1)[0];
		expect(expected.total).toBeGreaterThan(0);
		expect(request?.usage.cost.input).toBeCloseTo(expected.input, 8);
		expect(request?.usage.cost.output).toBeCloseTo(expected.output, 8);
		expect(request?.usage.cost.cacheRead).toBeCloseTo(expected.cacheRead, 8);
		expect(request?.usage.cost.total).toBeCloseTo(expected.total, 8);
	});

	it("backfills existing zero-cost OpenAI Codex GPT rows on database init", async () => {
		await initDb();
		closeDb();

		const database = new Database(getStatsDbPath());
		database
			.prepare(`
				INSERT INTO messages (
					session_file, entry_id, folder, model, provider, api, timestamp,
					duration, ttft, stop_reason, error_message,
					input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
					cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				"/tmp/session.jsonl",
				"backfilled",
				"/tmp/project",
				"gpt-5.4",
				"openai-codex",
				"openai-codex-responses",
				Date.now(),
				1000,
				100,
				"stop",
				null,
				1000,
				500,
				200,
				0,
				1700,
				0,
				0,
				0,
				0,
				0,
				0,
			);
		database.close();

		await initDb();

		const request = getRecentRequests(1)[0];
		expect(request?.usage.cost.total).toBeCloseTo(expectedCodexGptCost().total, 8);
	});

	it("updates existing rows when role attribution is recovered", async () => {
		await initDb();
		const unclassified = createCodexGptStats("role-backfill");
		unclassified.agent = "unknown";
		expect(insertMessageStats([unclassified])).toBe(1);

		expect(insertMessageStats([{ ...unclassified, agent: "executor" }])).toBe(1);
		expect(getRecentRequests(1)[0]?.agent).toBe("executor");
		expect(getStatsByAgent()).toMatchObject([{ agent: "executor", totalRequests: 1 }]);
	});

	it("adds the agent column and resets offsets for existing stats databases", async () => {
		await fs.mkdir(path.dirname(getStatsDbPath()), { recursive: true });
		const legacy = new Database(getStatsDbPath());
		legacy.exec(`
			CREATE TABLE messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				model TEXT NOT NULL,
				provider TEXT NOT NULL,
				api TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				duration INTEGER,
				ttft INTEGER,
				stop_reason TEXT NOT NULL,
				error_message TEXT,
				input_tokens INTEGER NOT NULL,
				output_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL,
				cache_write_tokens INTEGER NOT NULL,
				total_tokens INTEGER NOT NULL,
				cost_input REAL NOT NULL,
				cost_output REAL NOT NULL,
				cost_cache_read REAL NOT NULL,
				cost_cache_write REAL NOT NULL,
				cost_total REAL NOT NULL,
				UNIQUE(session_file, entry_id)
			);
			CREATE TABLE file_offsets (
				session_file TEXT PRIMARY KEY,
				offset INTEGER NOT NULL,
				last_modified INTEGER NOT NULL
			);
			INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
			) VALUES ('/tmp/legacy.jsonl', 'old', '/tmp', 'old-model', 'old-provider', 'old-api', 1,
				NULL, NULL, 'stop', NULL, 1, 1, 0, 0, 2, 0, 0, 0, 0, 0);
			INSERT INTO file_offsets (session_file, offset, last_modified)
			VALUES ('/tmp/legacy.jsonl', 10, 1);
		`);
		legacy.close();

		const migrated = await initDb();
		const columns = migrated.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
		const row = migrated.prepare("SELECT agent FROM messages WHERE entry_id = 'old'").get() as { agent: string };
		const offsets = migrated.prepare("SELECT COUNT(*) as count FROM file_offsets").get() as { count: number };
		const indexes = migrated.prepare("PRAGMA index_list(messages)").all() as { name: string }[];

		expect(columns.some(column => column.name === "agent")).toBe(true);
		expect(row.agent).toBe("unknown");
		expect(offsets.count).toBe(0);
		expect(indexes.some(index => index.name === "idx_messages_agent")).toBe(true);
	});
});
