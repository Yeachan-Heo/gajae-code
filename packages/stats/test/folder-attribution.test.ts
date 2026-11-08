import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getSessionsDir, getStatsDbPath, setAgentDir, TempDir } from "@gajae-code/utils";
import { syncAllSessions } from "../src/aggregator";
import { closeDb, getStatsByFolder, initDb } from "../src/db";
import { parseSessionFile } from "../src/parser";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync(path.join(os.homedir(), "pi-stats-folder-"));
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

/** Directory name shape written by the current v2 managed session storage. */
const V2_DIR = "v2-aaaqmfrgcytdmnrrgazdcmbshe4dsnbtgi2damzygq3tmnjvhe";

function sessionHeader(cwd: string, id = "s1"): Record<string, unknown> {
	return { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd };
}

function userEntry(id: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "hello there" },
	};
}

function assistantEntry(id: string, parentId: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

async function writeSession(dir: string, lines: Array<Record<string, unknown>>): Promise<string> {
	const folder = path.join(getSessionsDir(), dir);
	await fs.mkdir(folder, { recursive: true });
	const filePath = path.join(folder, "session.jsonl");
	await fs.writeFile(filePath, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return filePath;
}

describe("folder attribution", () => {
	it("attributes v2 managed sessions to the header cwd instead of the digest directory", async () => {
		await writeSession(V2_DIR, [sessionHeader("/tmp/my-project"), userEntry("u1"), assistantEntry("a1", "u1")]);
		await syncAllSessions({ workers: 1 });
		const folders = getStatsByFolder().map(row => row.folder);
		expect(folders).toEqual(["/tmp/my-project"]);
	});

	it("keeps legacy directory decoding for headerless session files", async () => {
		await writeSession("--tmp--legacy--project", [userEntry("u1"), assistantEntry("a1", "u1")]);
		await syncAllSessions({ workers: 1 });
		const folders = getStatsByFolder().map(row => row.folder);
		expect(folders).toEqual(["/tmp/legacy/project"]);
	});

	it("keeps header attribution when a v2 session is parsed incrementally", async () => {
		const file = await writeSession(V2_DIR, [
			sessionHeader("/tmp/my-project"),
			userEntry("u1"),
			assistantEntry("a1", "u1"),
		]);
		const first = await parseSessionFile(file);
		expect(first.stats.map(row => row.folder)).toEqual(["/tmp/my-project"]);

		await fs.appendFile(file, `${JSON.stringify(assistantEntry("a2", "u1"))}\n`);
		const second = await parseSessionFile(file, first.newOffset);
		expect(second.stats.map(row => row.entryId)).toEqual(["a2"]);
		expect(second.stats.map(row => row.folder)).toEqual(["/tmp/my-project"]);
	});

	it("repairs digest folder rows ingested before the parser read the header", async () => {
		const sessionFile = await writeSession(V2_DIR, [
			sessionHeader("/tmp/my-project"),
			userEntry("u1"),
			assistantEntry("a1", "u1"),
		]);

		// Bootstrap the schema through a real sync first: every shipped backfill
		// (agent role, user messages, links, premium requests, folder) runs once
		// and leaves its sentinel pending, so the fixture below starts from the
		// same sentinel state as a real pre-fix install.
		await syncAllSessions({ workers: 1 });
		closeDb();

		const sessionStats = await fs.stat(sessionFile);
		const raw = new Database(getStatsDbPath());
		// Simulate the pre-fix database: the row carries the opaque directory
		// name and file_offsets say the file is fully synced. Only the folder
		// backfill sentinel is removed, so the re-parse below can come from the
		// new backfill alone - the prior sentinels stay pending and their wipes
		// cannot fire.
		raw.exec("DELETE FROM messages");
		raw.exec("DELETE FROM file_offsets");
		raw.exec("DELETE FROM meta WHERE key = 'folder_attribution_v1'");
		raw.prepare(
			`INSERT INTO messages (
					session_file, entry_id, agent, folder, model, provider, api, timestamp,
					duration, ttft, stop_reason, error_message,
					input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
					premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionFile,
			"a1",
			"unknown",
			V2_DIR,
			"gpt-5.4",
			"openai",
			"openai-responses",
			Date.now(),
			1000,
			100,
			"stop",
			null,
			10,
			5,
			0,
			0,
			15,
			0,
			0,
			0,
			0,
			0,
			0,
		);
		raw.prepare("INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(
			sessionFile,
			sessionStats.size,
			sessionStats.mtimeMs,
		);
		raw.close();

		// The next sync runs the folder-attribution backfill: file_offsets are
		// cleared, the file re-parses, and the UPSERT repairs the stale row.
		await syncAllSessions({ workers: 1 });

		const rows = getStatsByFolder();
		expect(rows.map(row => row.folder)).toEqual(["/tmp/my-project"]);
		expect(rows[0]?.totalRequests).toBe(1);
	});

	it("does not re-wipe offsets once the backfill sentinel is pending", async () => {
		await writeSession(V2_DIR, [sessionHeader("/tmp/my-project"), userEntry("u1"), assistantEntry("a1", "u1")]);
		await initDb();
		await syncAllSessions({ workers: 1 });
		expect(getStatsByFolder().map(row => row.folder)).toEqual(["/tmp/my-project"]);
		// A second init must not reset the sentinel or offsets again.
		closeDb();
		await initDb();
		const second = await syncAllSessions({ workers: 1 });
		expect(second.processed).toBe(0);
		expect(getStatsByFolder().map(row => row.folder)).toEqual(["/tmp/my-project"]);
	});
});
