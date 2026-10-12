import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getSessionsDir, setAgentDir, TempDir } from "@gajae-code/utils";
import { closeDb } from "../src/db";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

const hostileModel = "alpha\nFORGED-LINE\u001b]52;c;aTI5\u0007\u202e";
const hostileFolder = "fold\nFORGED-FOLDER\u001b]52;c;aTI5\u0007";

beforeEach(() => {
	tempDir = TempDir.createSync(path.join(os.homedir(), "gjc-stats-console-"));
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

function assistant(id: string, model: string): Record<string, unknown> {
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
			model,
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

function summary(): string {
	const agentDir = getAgentDir();
	expect(agentDir.includes("gjc-stats-console")).toBe(true);
	closeDb();
	const result = spawnSync(process.execPath, [path.join(import.meta.dir, "../src/index.ts"), "--sync"], {
		cwd: path.join(import.meta.dir, ".."),
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir },
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.error?.message || "stats summary exited non-zero");
	}
	return result.stdout ?? "";
}

describe("stats console summary", () => {
	it("prints a session model and folder on one row without a terminal escape", async () => {
		const folder = process.platform === "win32" ? "--kept--folder" : hostileFolder;
		await writeSession(folder, "hostile.jsonl", [assistant("hostile", hostileModel)]);
		await writeSession("--work--app", "legit.jsonl", [assistant("legit", "gpt-4.1")]);

		const text = summary();
		expect(text.includes("\u001b")).toBe(false);
		expect(text.includes("\u0007")).toBe(false);
		expect(text.includes("\u202e")).toBe(false);
		expect(text.split("\n").some(line => /^\s*FORGED-/.test(line))).toBe(false);
		expect(text).toContain("  alpha FORGED-LINE:");
		expect(text).toContain("  gpt-4.1:");
		if (process.platform !== "win32") expect(text).toContain("  fold FORGED-FOLDER:");
	});

	it("keeps an ordinary model, folder, and agent label", async () => {
		await writeSession("--work--app", "root.jsonl", [assistant("root", "gpt-4.1")]);
		await writeSession("--work--app/root-session", "executor.jsonl", [
			{
				type: "configured_model_chain",
				id: "executor-chain",
				parentId: null,
				timestamp: new Date().toISOString(),
				role: "default",
				entries: ["openai/gpt-4.1"],
				origin: "subagent",
				identity: "executor",
				explicitHead: true,
			},
			assistant("executor", "gpt-4.1"),
		]);

		const text = summary();
		expect(text).toContain("  gpt-4.1:");
		expect(text).toContain("  /work/app:");
		expect(text).toContain("  default:");
		expect(text).toContain("  executor:");
	});
});
