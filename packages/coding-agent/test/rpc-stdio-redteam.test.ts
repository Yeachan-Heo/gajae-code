import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseSessionEntries } from "@gajae-code/coding-agent";
import { readLines } from "@gajae-code/utils";
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
	data?: unknown;
	error?: unknown;
}

interface RpcHarness {
	proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	stderrText: Promise<string>;
	nextFrame(timeoutMs?: number): Promise<Frame>;
	send(command: object | string): void;
	closeStdin(): Promise<void>;
	kill(): void;
}

let workspace: string;
let agentDir: string;
let cliEnv: HarnessCliEnv;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "rpc-redteam-ws-"));
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
		// Best-effort temp cleanup; tolerate env-specific node_modules layout.
	}
	await rm(workspace, { recursive: true, force: true });
});

function frameData<T extends object>(frame: Frame): T {
	if (!frame.data || typeof frame.data !== "object") {
		throw new Error(`Expected object data on frame ${JSON.stringify(frame)}`);
	}
	return frame.data as T;
}

function parseFrames(raw: string): Frame[] {
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Frame);
}

function findResponse(frames: Frame[], id: string): Frame {
	const frame = frames.find(candidate => candidate.type === "response" && candidate.id === id);
	if (!frame) {
		throw new Error(`Missing response ${id}. Frames: ${JSON.stringify(frames)}`);
	}
	return frame;
}

function spawnRpcServer(options: { cwd?: string; sessionDir?: string } = {}): RpcHarness {
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
			options.sessionDir ?? path.join(workspace, "sessions"),
		],
		{
			cwd: options.cwd ?? workspace,
			env: { ...cliEnv.env, GJC_HARNESS_STATE_ROOT: workspace, NO_COLOR: "1", PI_NOTIFICATIONS: "off" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrText = new Response(proc.stderr).text();
	const lines = readLines(proc.stdout)[Symbol.asyncIterator]();
	const decoder = new TextDecoder("utf-8", { fatal: false });

	return {
		proc,
		stderrText,
		async nextFrame(timeoutMs = 10_000): Promise<Frame> {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Timed out waiting for RPC frame")), timeoutMs);
			});
			try {
				const next = await Promise.race([lines.next(), timeout]);
				if (next.done) {
					throw new Error("RPC stdout ended before next frame");
				}
				return JSON.parse(decoder.decode(next.value)) as Frame;
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
		send(command: object | string): void {
			const line = typeof command === "string" ? command : JSON.stringify(command);
			proc.stdin.write(`${line}\n`);
		},
		async closeStdin(): Promise<void> {
			await proc.stdin.end();
		},
		kill(): void {
			try {
				proc.kill();
			} catch {
				// Process may already be gone.
			}
		},
	};
}

async function driveRpcServer(commands: Array<object | string>, options: { cwd?: string; sessionDir?: string } = {}) {
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
			options.sessionDir ?? path.join(workspace, "sessions"),
		],
		{
			cwd: options.cwd ?? workspace,
			env: { ...cliEnv.env, GJC_HARNESS_STATE_ROOT: workspace, NO_COLOR: "1", PI_NOTIFICATIONS: "off" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	for (const command of commands) {
		proc.stdin.write(`${typeof command === "string" ? command : JSON.stringify(command)}\n`);
	}
	await proc.stdin.end();
	const [raw, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { frames: parseFrames(raw), raw, stderr, exitCode };
}

describe("gjc --mode rpc red-team stdio lifecycle", () => {
	it("is an attached persistent server until stdin closes", async () => {
		const harness = spawnRpcServer();
		try {
			expect(await harness.nextFrame()).toEqual({ type: "ready" });

			harness.send({ id: "state-1", type: "get_state" });
			const firstState = await harness.nextFrame();
			expect(firstState).toMatchObject({ id: "state-1", type: "response", command: "get_state", success: true });

			const beforeEof = await Promise.race([
				harness.proc.exited.then(() => "exited" as const),
				Bun.sleep(100).then(() => "running" as const),
			]);
			expect(beforeEof).toBe("running");

			harness.send({ id: "state-2", type: "get_state" });
			const secondState = await harness.nextFrame();
			expect(secondState).toMatchObject({ id: "state-2", type: "response", command: "get_state", success: true });
			expect(frameData<{ sessionId: string }>(secondState).sessionId).toBe(
				frameData<{ sessionId: string }>(firstState).sessionId,
			);

			await harness.closeStdin();
			expect(await harness.proc.exited).toBe(0);
			expect((await harness.stderrText).trim()).toBe("");
		} finally {
			harness.kill();
		}
	}, 30_000);

	it("flushes durable session state on EOF and reloads it in a new RPC process", async () => {
		const marker = "RPC_PERSISTENCE_MARKER";
		const firstRun = await driveRpcServer([
			{ id: "name", type: "set_session_name", name: "persisted-redteam" },
			{ id: "bash", type: "bash", command: `printf ${marker}` },
			{ id: "state", type: "get_state" },
		]);
		expect(firstRun.exitCode, firstRun.stderr).toBe(0);
		expect(firstRun.frames.some(frame => frame.type === "ready")).toBe(true);
		expect(findResponse(firstRun.frames, "bash")).toMatchObject({ success: true });
		const firstState = frameData<{ sessionFile: string; sessionId: string; messageCount: number }>(
			findResponse(firstRun.frames, "state"),
		);
		expect(firstState.messageCount).toBe(1);

		const sessionContent = await readFile(firstState.sessionFile, "utf8");
		const persistedMessages = parseSessionEntries(sessionContent).filter(entry => entry.type === "message");
		expect(
			persistedMessages.some(
				entry => entry.message.role === "bashExecution" && JSON.stringify(entry.message).includes(marker),
			),
		).toBe(true);

		const secondRun = await driveRpcServer([
			{ id: "switch", type: "switch_session", sessionPath: firstState.sessionFile },
			{ id: "messages", type: "get_messages" },
		]);
		expect(secondRun.exitCode, secondRun.stderr).toBe(0);
		expect(findResponse(secondRun.frames, "switch")).toMatchObject({ success: true, data: { cancelled: false } });
		const messagesData = frameData<{ messages: Array<{ role?: string; output?: string }> }>(
			findResponse(secondRun.frames, "messages"),
		);
		expect(messagesData.messages.some(message => message.role === "bashExecution" && message.output === marker)).toBe(
			true,
		);
	}, 30_000);

	it("survives a malformed JSONL frame and accepts the next command", async () => {
		const result = await driveRpcServer([
			"{ definitely not json",
			{ id: "state-after-bad-frame", type: "get_state" },
		]);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.frames.some(frame => frame.type === "ready")).toBe(true);
		const parseFailure = result.frames.find(
			frame => frame.type === "response" && frame.command === "parse" && frame.success === false,
		);
		expect(parseFailure, `No parse failure frame. Raw:\n${result.raw}`).toBeDefined();
		expect(JSON.stringify(parseFailure?.error)).toContain("Failed to parse command");
		expect(findResponse(result.frames, "state-after-bad-frame")).toMatchObject({
			success: true,
			command: "get_state",
		});
		expect(result.stderr.trim()).toBe("");
	}, 30_000);

	it("runs independent child sessions concurrently without state bleed", async () => {
		const alphaCwd = path.join(workspace, "alpha");
		const betaCwd = path.join(workspace, "beta");
		await Promise.all([mkdir(alphaCwd, { recursive: true }), mkdir(betaCwd, { recursive: true })]);

		const [alpha, beta] = await Promise.all([
			driveRpcServer(
				[
					{ id: "name", type: "set_session_name", name: "orchestrated-alpha" },
					{ id: "state", type: "get_state" },
					{
						id: "bash",
						type: "bash",
						command: "bun --print 'JSON.stringify({lane:\"alpha\",cwd:process.cwd()})'",
					},
				],
				{ cwd: alphaCwd, sessionDir: path.join(workspace, "sessions-alpha") },
			),
			driveRpcServer(
				[
					{ id: "name", type: "set_session_name", name: "orchestrated-beta" },
					{ id: "state", type: "get_state" },
					{ id: "bash", type: "bash", command: "bun --print 'JSON.stringify({lane:\"beta\",cwd:process.cwd()})'" },
				],
				{ cwd: betaCwd, sessionDir: path.join(workspace, "sessions-beta") },
			),
		]);

		expect(alpha.exitCode, alpha.stderr).toBe(0);
		expect(beta.exitCode, beta.stderr).toBe(0);
		const alphaState = frameData<{ sessionId: string; sessionName?: string }>(findResponse(alpha.frames, "state"));
		const betaState = frameData<{ sessionId: string; sessionName?: string }>(findResponse(beta.frames, "state"));
		expect(alphaState.sessionName).toBe("orchestrated-alpha");
		expect(betaState.sessionName).toBe("orchestrated-beta");
		expect(alphaState.sessionId).not.toBe(betaState.sessionId);

		const alphaOutput = frameData<{ output: string }>(findResponse(alpha.frames, "bash")).output.trim();
		const betaOutput = frameData<{ output: string }>(findResponse(beta.frames, "bash")).output.trim();
		expect(JSON.parse(alphaOutput)).toEqual({ lane: "alpha", cwd: alphaCwd });
		expect(JSON.parse(betaOutput)).toEqual({ lane: "beta", cwd: betaCwd });
	}, 30_000);
});
