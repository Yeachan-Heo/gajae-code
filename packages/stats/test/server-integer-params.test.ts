import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir, TempDir } from "@gajae-code/utils";
import { closeDb, initDb, insertMessageStats } from "../src/db";
import { startServer } from "../src/server";
import type { MessageStats } from "../src/types";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;
let server: { port: number; stop(): void } | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync(path.join(os.homedir(), "pi-stats-integer-params-"));
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	server?.stop();
	server = null;
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

function message(sessionFile: string, entryId: string, timestamp: number): MessageStats {
	return {
		sessionFile,
		entryId,
		folder: "/tmp/project",
		agent: "default",
		model: "gpt-5.4",
		provider: "openai",
		api: "openai-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function get(pathname: string): Promise<Response> {
	if (!server) throw new Error("server not started");
	return fetch(`http://127.0.0.1:${server.port}${pathname}`, { headers: { Host: `localhost:${server.port}` } });
}

describe("stats server integer parameters", () => {
	it("rejects malformed limit and request ids instead of failing or widening the query", async () => {
		// Given three stored requests backed by a session file, and a running dashboard server.
		const sessionFile = tempDir!.join("session.jsonl");
		const entries = ["a", "b", "c"].map(id => ({
			type: "message",
			id,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: id }] },
		}));
		await fs.writeFile(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		await initDb();
		const now = Date.now();
		insertMessageStats([
			message(sessionFile, "a", now - 2),
			message(sessionFile, "b", now - 1),
			message(sessionFile, "c", now),
		]);
		server = await startServer(0);

		// When the limit and request id parameters are well-formed, they still work.
		const limited = await get("/api/stats/recent?limit=2");
		expect(limited.status).toBe(200);
		const rows = (await limited.json()) as { id: number }[];
		expect(rows).toHaveLength(2);
		expect((await get(`/api/request/${rows[0]!.id}`)).status).toBe(200);
		expect((await get("/api/stats/recent")).status).toBe(200);

		// Then malformed values are a 400, not a SQLite 500, an unbounded LIMIT, or a lenient parse.
		for (const pathname of [
			"/api/stats/recent?limit=abc",
			"/api/stats/recent?limit=-1",
			"/api/stats/recent?limit=2.5",
			"/api/stats/errors?limit=abc",
			"/api/stats/errors?limit=-1",
			`/api/request/${rows[0]!.id}abc`,
			"/api/request/-1",
			"/api/request/",
		]) {
			expect({ pathname, status: (await get(pathname)).status }).toEqual({ pathname, status: 400 });
		}
		expect((await get("/api/request/999999")).status).toBe(404);
	});
});
