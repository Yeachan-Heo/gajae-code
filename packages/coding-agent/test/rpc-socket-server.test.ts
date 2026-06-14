import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHarnessCliEnv, type HarnessCliEnv } from "./harness-control-plane/cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const fixtureModelsYaml = `providers:
  rpc-test:
    auth: none
    api: openai-responses
    baseUrl: http://127.0.0.1:9/v1
    models:
      - id: rpc-test-model
        contextWindow: 100000
        maxTokens: 4096
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`;

interface Frame {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	data?: { sessionId?: string; output?: string } & Record<string, unknown>;
}

let workspace: string;
let agentDir: string;
let cliEnv: HarnessCliEnv;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "rpc-sock-ws-"));
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
	} catch {
		// best-effort
	}
	await rm(workspace, { recursive: true, force: true });
});

interface SocketConn {
	send(obj: object): void;
	nextResponse(id: string, timeoutMs?: number): Promise<Frame>;
	nextFrame(timeoutMs?: number): Promise<Frame>;
	close(): void;
}

async function connect(socketPath: string): Promise<SocketConn> {
	const queue: Frame[] = [];
	const waiters: Array<(frame: Frame) => void> = [];
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let buf = "";
	const socket = await Bun.connect({
		unix: socketPath,
		socket: {
			data(_sock, bytes) {
				buf += decoder.decode(bytes);
				while (true) {
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
	const nextFrame = (timeoutMs = 12_000): Promise<Frame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		return new Promise<Frame>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for socket frame")), timeoutMs);
			waiters.push(frame => {
				clearTimeout(timer);
				resolve(frame);
			});
		});
	};
	return {
		send(obj: object) {
			socket.write(`${JSON.stringify(obj)}\n`);
		},
		nextFrame,
		async nextResponse(id: string, timeoutMs = 15_000): Promise<Frame> {
			const start = Date.now();
			while (Date.now() - start < timeoutMs) {
				const frame = await nextFrame(timeoutMs);
				if (frame.type === "response" && frame.id === id) return frame;
			}
			throw new Error(`no response for ${id}`);
		},
		close() {
			socket.end();
		},
	};
}

async function waitForSocket(socketPath: string, timeoutMs = 15_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			await stat(socketPath);
			return;
		} catch {
			await Bun.sleep(100);
		}
	}
	throw new Error(`socket ${socketPath} was not created`);
}

describe("gjc --mode rpc --listen (UDS persistent server, issue 09)", () => {
	it("keeps the AgentSession alive across client reconnects", async () => {
		const socketPath = path.join(workspace, "rpc.sock");
		const proc = Bun.spawn(
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
		try {
			await waitForSocket(socketPath);

			const first = await connect(socketPath);
			expect(await first.nextFrame()).toEqual({ type: "ready" });
			first.send({ id: "s1", type: "get_state" });
			const state1 = await first.nextResponse("s1");
			expect(state1.success).toBe(true);
			const sessionId = state1.data?.sessionId;
			expect(sessionId).toBeTruthy();
			first.close();

			// The server must remain alive after the client disconnects.
			await Bun.sleep(400);
			expect(proc.killed).toBe(false);

			const second = await connect(socketPath);
			expect(await second.nextFrame()).toEqual({ type: "ready" });
			second.send({ id: "s2", type: "get_state" });
			const state2 = await second.nextResponse("s2");
			// Same session survived the reconnect.
			expect(state2.data?.sessionId).toBe(sessionId);

			// Still functional after reconnect.
			second.send({ id: "b1", type: "bash", command: "echo persisted-across-reconnect" });
			const bash = await second.nextResponse("b1");
			expect(bash.success).toBe(true);
			expect(bash.data?.output).toContain("persisted-across-reconnect");
			second.close();
		} finally {
			proc.kill();
		}
	}, 45_000);

	it("registers a discoverable socket record while listening", async () => {
		const socketPath = path.join(workspace, "rpc2.sock");
		const proc = Bun.spawn(
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
				path.join(workspace, "sessions2"),
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
		try {
			await waitForSocket(socketPath);
			const { listRpcSessions } = await import("@gajae-code/coding-agent/modes/shared/agent-wire/session-registry");
			const sessions = await listRpcSessions(agentDir);
			const socketRecord = sessions.find(s => s.transport === "socket");
			expect(socketRecord).toBeDefined();
			expect(socketRecord?.endpoint).toBe(socketPath);
		} finally {
			proc.kill();
		}
	}, 45_000);
});
