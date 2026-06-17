import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import { createHarnessCliEnv, type HarnessCliEnv } from "./harness-control-plane/cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const fixtureModelsYaml = `providers:\n  rpc-test:\n    auth: none\n    api: openai-responses\n    baseUrl: http://127.0.0.1:9/v1\n    models:\n      - id: rpc-test-model\n        contextWindow: 100000\n        maxTokens: 4096\n        cost:\n          input: 0\n          output: 0\n          cacheRead: 0\n          cacheWrite: 0\n`;
let workspace: string;
let agentDir: string;
let cliEnv: HarnessCliEnv;
beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "rpc-disconnect-"));
	agentDir = path.join(workspace, ".gjc", "agent");
	cliEnv = createHarnessCliEnv(repoRoot);
	await mkdir(agentDir, { recursive: true });
	await writeFile(path.join(agentDir, "models.yml"), fixtureModelsYaml);
	cliEnv.env.GJC_CODING_AGENT_DIR = agentDir;
	cliEnv.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(async () => {
	try {
		cliEnv.cleanup();
	} catch {}
	await rm(workspace, { recursive: true, force: true });
});
async function waitForSocket(socketPath: string) {
	const start = Date.now();
	while (Date.now() - start < 15_000) {
		try {
			await stat(socketPath);
			return;
		} catch {
			await Bun.sleep(50);
		}
	}
	throw new Error("socket not created");
}
function spawnRpc(socketPath: string) {
	return Bun.spawn(
		[
			"bun",
			cliEntry,
			"--mode",
			"rpc",
			"--provider",
			"rpc-test",
			"--model",
			"rpc-test-model",
			"--session-dir",
			path.join(workspace, "sessions"),
			"--listen",
			socketPath,
		],
		{
			cwd: workspace,
			env: { ...cliEnv.env, GJC_HARNESS_STATE_ROOT: workspace, NO_COLOR: "1", PI_NOTIFICATIONS: "off" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

describe("UDS disconnect after turn completion", () => {
	test("reconnect can recover final assistant messages via get_messages", async () => {
		const socketPath = path.join(workspace, "rpc.sock");
		const proc = spawnRpc(socketPath);
		try {
			await waitForSocket(socketPath);
			const first = new RpcClient({ transport: "uds", socketPath });
			await first.start();
			const initial = await first.getMessages();
			expect(Array.isArray(initial)).toBe(true);
			first.stop();

			const second = new RpcClient({ transport: "uds", socketPath });
			await second.start();
			const messages = await second.getMessages();
			expect(Array.isArray(messages)).toBe(true);
			const state = await second.getState();
			expect(state.sessionId).toBeTruthy();
			second.stop();
		} finally {
			proc.kill();
		}
	}, 45_000);
});
