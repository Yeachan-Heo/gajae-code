import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHarnessCliEnv, type HarnessCliEnv } from "./harness-control-plane/cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const fixtureModelsYaml = `providers:\n  rpc-test:\n    auth: none\n    api: openai-responses\n    baseUrl: http://127.0.0.1:9/v1\n    models:\n      - id: rpc-test-model\n        contextWindow: 100000\n        maxTokens: 4096\n        cost:\n          input: 0\n          output: 0\n          cacheRead: 0\n          cacheWrite: 0\n`;
let workspace: string;
let agentDir: string;
let cliEnv: HarnessCliEnv;
beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "rpc-steal-"));
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
interface Frame {
	type?: string;
	id?: string;
	success?: boolean;
	data?: Record<string, unknown>;
}
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
async function connect(socketPath: string) {
	const queue: Frame[] = [];
	const waiters: Array<(f: Frame) => void> = [];
	let buf = "";
	const decoder = new TextDecoder();
	const socket = await Bun.connect({
		unix: socketPath,
		socket: {
			data(_s, bytes) {
				buf += decoder.decode(bytes);
				for (;;) {
					const nl = buf.indexOf("\n");
					if (nl < 0) break;
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					const frame = JSON.parse(line) as Frame;
					const waiter = waiters.shift();
					if (waiter) waiter(frame);
					else queue.push(frame);
				}
			},
		},
	});
	return {
		send(obj: object) {
			socket.write(`${JSON.stringify(obj)}\n`);
		},
		nextFrame(timeoutMs = 3000) {
			const queued = queue.shift();
			if (queued) return Promise.resolve(queued);
			return new Promise<Frame>((resolve, reject) => {
				const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
				waiters.push(f => {
					clearTimeout(t);
					resolve(f);
				});
			});
		},
		close() {
			socket.end();
		},
	};
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

describe("UDS controller stealing", () => {
	test("last connected client controls the session and old socket commands are ignored", async () => {
		const socketPath = path.join(workspace, "rpc.sock");
		const proc = spawnRpc(socketPath);
		try {
			await waitForSocket(socketPath);
			const first = await connect(socketPath);
			expect(await first.nextFrame()).toEqual({ type: "ready" });
			first.send({ id: "before", type: "get_state" });
			expect((await first.nextFrame()).id).toBe("before");
			const second = await connect(socketPath);
			expect(await second.nextFrame()).toEqual({ type: "ready" });
			first.send({ id: "old", type: "set_session_name", name: "old-client" });
			await expect(first.nextFrame(600)).rejects.toThrow("timeout");
			second.send({ id: "new", type: "set_session_name", name: "new-client" });
			const newResp = await second.nextFrame();
			expect(newResp).toMatchObject({ id: "new", success: true });
			second.send({ id: "state", type: "get_state" });
			const state = await second.nextFrame();
			expect(state.data?.sessionName).toBe("new-client");
			first.close();
			second.close();
		} finally {
			proc.kill();
		}
	}, 45_000);
});
