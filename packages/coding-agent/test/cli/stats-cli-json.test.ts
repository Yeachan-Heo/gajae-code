import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeDb } from "@gajae-code/stats";
import { getAgentDir, getSessionsDir, setAgentDir, TempDir } from "@gajae-code/utils";
import { runStatsCommand } from "../../src/cli/stats-cli";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync(path.join(os.homedir(), "gjc-stats-cli-json-"));
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

describe("gjc stats --json", () => {
	it("writes only the JSON document to stdout and the sync summary to stderr", async () => {
		// Given one session with an assistant turn to sync.
		const file = path.join(getSessionsDir(), "--tmp--json", "session.jsonl");
		await fs.mkdir(path.dirname(file), { recursive: true });
		const entry = {
			type: "message",
			id: "reply",
			parentId: null,
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
		await fs.writeFile(file, `${JSON.stringify(entry)}\n`, "utf-8");

		// When `gjc stats --json` runs.
		const stdout: string[] = [];
		let stderr = "";
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			stdout.push(args.map(String).join(" "));
		});
		const errorWrite = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr += String(chunk);
			return true;
		});
		try {
			await runStatsCommand({ port: 3847, json: true, summary: false });
		} finally {
			log.mockRestore();
			errorWrite.mockRestore();
		}

		// Then stdout parses as one JSON document and the sync line is on stderr.
		const parsed = JSON.parse(stdout.join("\n")) as { overall: { totalRequests: number } };
		expect(parsed.overall.totalRequests).toBe(1);
		expect(stderr).toMatch(/Synced 1 new entries from 1 files \(1 total\)/);
	});
});
