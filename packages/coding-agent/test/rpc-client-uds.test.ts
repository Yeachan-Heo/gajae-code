import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { defineRpcClientTool, RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
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

let workspace: string;
let agentDir: string;
let cliEnv: HarnessCliEnv;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "rpc-client-uds-"));
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

async function waitForSocket(socketPath: string, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			await stat(socketPath);
			return;
		} catch {
			await Bun.sleep(50);
		}
	}
	throw new Error(`socket ${socketPath} was not created`);
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

describe("RpcClient UDS transport", () => {
	test("connects to rpc-mode UDS, correlates requests, checks pending-gate replay API, and leaves server alive on close", async () => {
		const socketPath = path.join(workspace, "rpc.sock");
		const proc = spawnRpc(socketPath);
		try {
			await waitForSocket(socketPath);
			let toolCalls = 0;
			const hostEchoTool = defineRpcClientTool({
				name: "host_echo",
				label: "Host Echo",
				description: "Echoes a message from the host",
				parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
				async execute(args) {
					toolCalls++;
					return `echo:${String(args.message)}`;
				},
			});
			const client = new RpcClient({
				transport: "uds",
				socketPath,
				customTools: [hostEchoTool],
			});
			const extensionRequests: unknown[] = [];
			const gates: unknown[] = [];
			client.onExtensionUiRequest(req => extensionRequests.push(req));
			client.onWorkflowGate(gate => gates.push(gate));
			await client.start();

			const [state, tools] = await Promise.all([client.getState(), client.setCustomTools([hostEchoTool])]);
			expect(state.sessionId).toBeTruthy();
			expect(tools).toContain("host_echo");
			expect(Array.isArray(await client.getPendingWorkflowGates())).toBe(true);
			await expect(client.respondGate("wg_missing", "approve", "k1")).rejects.toThrow(
				/workflow gates are not available|no pending gate|not negotiated|not available/i,
			);
			client.respondExtensionUi({ type: "extension_ui_response", id: "unused", value: "ok" });
			expect(extensionRequests).toHaveLength(0);
			expect(gates).toHaveLength(0);
			expect(toolCalls).toBe(0);

			const pending = client.bash("printf pending-close; sleep 5");
			client.stop();
			await expect(pending).rejects.toThrow(/closed|stopped|Client not started|Socket closed/i);
			await Bun.sleep(300);
			expect(proc.killed).toBe(false);

			const reconnect = new RpcClient({ transport: "uds", socketPath });
			await reconnect.start();
			expect((await reconnect.getState()).sessionId).toBe(state.sessionId);
			reconnect.stop();
		} finally {
			proc.kill();
		}
	}, 60_000);

	test("dispatches real server UI, workflow gate, and host-tool frames over UDS", async () => {
		const socketPath = path.join(workspace, "frame-dispatch.sock");
		let serverSocket: net.Socket | undefined;
		let buffered = "";
		const hostToolResult = Promise.withResolvers<unknown>();
		const server = await new Promise<net.Server>((resolve, reject) => {
			const srv = net.createServer(socket => {
				serverSocket = socket;
				socket.unref();
				socket.write(`${JSON.stringify({ type: "ready" })}\n`);
				setTimeout(() => {
					socket.write(
						`${JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Confirm", message: "ok?" })}\n`,
					);
					socket.write(
						`${JSON.stringify({ type: "workflow_gate", gate_id: "wg_uds_ralplan_000001", stage: "ralplan", kind: "approval", schema: { type: "object" }, schema_hash: "hash", context: { title: "Approve?" }, created_at: "2026-06-16T00:00:00.000Z", required: true })}\n`,
					);
					socket.write(
						`${JSON.stringify({ type: "host_tool_call", id: "host-call-1", toolCallId: "tc-1", toolName: "host_echo", arguments: { message: "uds" } })}\n`,
					);
				}, 0);
				socket.on("data", data => {
					buffered += typeof data === "string" ? data : new TextDecoder().decode(data);
					let nl = buffered.indexOf("\n");
					while (nl >= 0) {
						const line = buffered.slice(0, nl).trim();
						buffered = buffered.slice(nl + 1);
						if (line) {
							const frame = JSON.parse(line) as { type?: string; id?: string; result?: unknown };
							if (frame.type === "host_tool_result" && frame.id === "host-call-1")
								hostToolResult.resolve(frame.result);
							if (frame.type === "set_host_tools") {
								socket.write(
									`${JSON.stringify({ id: frame.id, type: "response", command: "set_host_tools", success: true, data: { toolNames: ["host_echo"] } })}\n`,
								);
							}
						}
						nl = buffered.indexOf("\n");
					}
				});
			});
			srv.once("error", reject);
			srv.unref();
			srv.listen(socketPath, () => resolve(srv));
		});
		try {
			let toolCalls = 0;
			const client = new RpcClient({
				transport: "uds",
				socketPath,
				customTools: [
					defineRpcClientTool({
						name: "host_echo",
						label: "Host Echo",
						description: "Echoes a message from the host",
						parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
						async execute(args) {
							toolCalls++;
							return `echo:${String(args.message)}`;
						},
					}),
				],
			});
			const ui = Promise.withResolvers<unknown>();
			const gate = Promise.withResolvers<unknown>();
			client.onExtensionUiRequest(req => ui.resolve(req));
			client.onWorkflowGate(frame => gate.resolve(frame));
			await client.start();
			expect(
				await Promise.race([ui.promise, Bun.sleep(3000).then(() => ({ timeout: "ui", buffered }))]),
			).toMatchObject({
				id: "ui-1",
				method: "confirm",
			});
			expect(
				await Promise.race([gate.promise, Bun.sleep(3000).then(() => ({ timeout: "gate", buffered }))]),
			).toMatchObject({
				gate_id: "wg_uds_ralplan_000001",
			});
			expect(
				await Promise.race([hostToolResult.promise, Bun.sleep(3000).then(() => ({ timeout: "tool", buffered }))]),
			).toMatchObject({
				content: [{ type: "text", text: "echo:uds" }],
			});
			client.stop();
			expect(toolCalls).toBe(1);
		} finally {
			serverSocket?.end();
			server.close();
		}
	}, 30_000);

	test("stdio transport still starts and serves a basic correlated request", async () => {
		const client = new RpcClient({
			cliPath: cliEntry,
			cwd: workspace,
			provider: "rpc-test",
			model: "rpc-test-model",
			sessionDir: path.join(workspace, "stdio-sessions"),
			env: { ...cliEnv.env, GJC_HARNESS_STATE_ROOT: workspace, NO_COLOR: "1", PI_NOTIFICATIONS: "off" },
		});
		try {
			await client.start();
			const state = await client.getState();
			expect(state.sessionId).toBeTruthy();
		} finally {
			client.stop();
		}
	}, 30_000);
});
