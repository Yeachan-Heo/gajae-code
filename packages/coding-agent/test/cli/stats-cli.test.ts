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
	tempDir = TempDir.createSync(path.join(os.homedir(), "gjc-stats-cli-"));
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

function assistantEntry(id: string): Record<string, unknown> {
	return {
		type: "message",
		id,
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
				cacheRead: 1,
				cacheWrite: 0,
				totalTokens: 16,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

async function writeSession(folder: string, name: string, entries: Record<string, unknown>[]): Promise<void> {
	const file = path.join(getSessionsDir(), folder, name);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}

describe("gjc stats role summary", () => {
	it("prints default and persisted subagent usage groups", async () => {
		await writeSession("--tmp--cli", "root.jsonl", [assistantEntry("root")]);
		await writeSession("--tmp--cli/root-session", "executor.jsonl", [
			{
				type: "configured_model_chain",
				id: "executor-chain",
				parentId: null,
				timestamp: new Date().toISOString(),
				role: "default",
				entries: ["openai/gpt-5.4"],
				origin: "subagent",
				identity: "executor",
				explicitHead: true,
			},
			assistantEntry("executor"),
		]);

		const output: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			output.push(args.map(String).join(" "));
		});
		try {
			await runStatsCommand({ port: 3847, json: false, summary: true });
		} finally {
			log.mockRestore();
		}

		const summary = output.join("\n");
		expect(summary).toContain("By Agent Role:");
		expect(summary).toMatch(/default: 1 reqs, 10 input \/ 5 output/);
		expect(summary).toMatch(/executor: 1 reqs, 10 input \/ 5 output/);
	});
});
