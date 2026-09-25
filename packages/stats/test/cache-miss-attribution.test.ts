import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getStatsDbPath, setAgentDir, TempDir } from "@gajae-code/utils";
import { closeDb, getCacheMissAttribution, initDb, insertMessageStats } from "../src/db";
import { parseSessionFile } from "../src/parser";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync(path.join(os.homedir(), "pi-stats-prefix-"));
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	closeDb();
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

let nextId = 0;
function assistant(usage: { input: number; cacheRead: number }, promptPrefix?: unknown): Record<string, unknown> {
	const id = `a${nextId++}`;
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			stopReason: "toolUse",
			timestamp: Date.now(),
			usage: {
				input: usage.input,
				output: 10,
				cacheRead: usage.cacheRead,
				cacheWrite: 0,
				totalTokens: usage.input + usage.cacheRead + 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			...(promptPrefix === undefined ? {} : { promptPrefix }),
		},
	};
}

const prefix = (change: string, divergedRole?: string) => ({
	hash: "0123456789abcdef",
	messages: 10,
	reusedMessages: 4,
	previousMessages: 9,
	change,
	...(divergedRole ? { divergedRole } : {}),
});
const MISS = { input: 60_000, cacheRead: 0 };
const HIT = { input: 500, cacheRead: 59_500 };

async function ingest(entries: Record<string, unknown>[]): Promise<void> {
	await initDb();
	const file = tempDir!.join("session.jsonl");
	await fs.writeFile(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	const parsed = await parseSessionFile(file);
	insertMessageStats(parsed.stats);
}

describe("cache prefix-miss attribution", () => {
	it("splits prefix misses into client-caused, provider-side, and model-switch causes", async () => {
		await ingest([
			// First request of an agent: always cold, never counted.
			assistant(MISS, prefix("initial")),
			// Healthy append turns.
			assistant(HIT, prefix("append")),
			assistant(HIT, prefix("append")),
			// Prefix intact but nothing cached: provider eviction/routing.
			assistant(MISS, prefix("append")),
			// Client rewrote an already-sent message twice, the system prompt once.
			assistant(MISS, prefix("messages", "developer")),
			assistant(MISS, prefix("messages", "developer")),
			assistant(MISS, prefix("system")),
			// A system change that still hit the cache (e.g. after the last breakpoint) is not a miss.
			assistant(HIT, prefix("system")),
			assistant(MISS, prefix("model")),
			// Small prompts are too cheap to count as a lost prefix.
			assistant({ input: 1_000, cacheRead: 0 }, prefix("tools")),
			// Pre-telemetry sessions and malformed payloads are excluded.
			assistant(MISS),
			assistant(MISS, { change: "bogus" }),
		]);

		const attribution = getCacheMissAttribution();
		expect(attribution).toEqual({
			trackedRequests: 9,
			prefixMisses: 5,
			clientCausedMisses: 3,
			providerSideMisses: 1,
			modelSwitchMisses: 1,
			clientCausedShare: 3 / 5,
			byCause: [
				{ change: "messages", divergedRole: "developer", misses: 2 },
				{ change: "system", divergedRole: null, misses: 1 },
			],
		});
	});

	it("reports an empty attribution when no request carries telemetry", async () => {
		await ingest([assistant(MISS), assistant(HIT)]);
		expect(getCacheMissAttribution()).toMatchObject({ trackedRequests: 0, prefixMisses: 0, clientCausedShare: 0 });
	});

	it("adds the prefix columns to an existing stats database without touching old rows", async () => {
		await initDb();
		closeDb();
		const database = new Database(getStatsDbPath());
		database.exec("ALTER TABLE messages DROP COLUMN prefix_change");
		database.exec("ALTER TABLE messages DROP COLUMN prefix_diverged_role");
		database.close();

		const migrated = await initDb();
		const columns = (migrated.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map(c => c.name);
		expect(columns).toContain("prefix_change");
		expect(columns).toContain("prefix_diverged_role");
	});
});
