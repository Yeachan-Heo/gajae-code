import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionIndex } from "../src/sdk/broker/session-index";

const packageRoot = path.resolve(import.meta.dir, "..");
type TestServer = {
	port: number | undefined;
	upgrade(request: Request): boolean;
	stop(closeActiveConnections?: boolean): void;
};

test("shipped MCP stdio advertises confirm and forwards confirmed destructive controls", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "gjc-sdk-mcp-stdio-"));
	const agentDir = await mkdtemp(path.join(tmpdir(), "gjc-sdk-mcp-stdio-agent-"));
	const token = "mcp-stdio-token";
	const received: Array<Record<string, unknown>> = [];
	let server!: TestServer;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "mcp-stdio" }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				received.push(frame);
				if (frame.type === "event_replay") {
					socket.send(
						JSON.stringify({
							type: "event_replay_result",
							id: frame.id,
							ok: true,
							events: [],
							generation: 1,
							lastSeq: 0,
						}),
					);
					return;
				}
				socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true, cleared: true }));
			},
		},
	});

	try {
		const sessionId = "confirmed-control-session";
		const stateRoot = path.join(repo, ".gjc", "state");
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		await mkdir(path.dirname(endpointPath), { recursive: true });
		await writeFile(
			endpointPath,
			JSON.stringify({ sessionId, url: `ws://127.0.0.1:${server.port!}`, token, pid: process.pid }),
		);
		// The MCP stdio server resolves sessions only through the broker's
		// session index (C10): registration plus a fresh heartbeat make the
		// fixture session read as live without waiting for a checkpoint pass.
		const endpointMtimeMs = (await stat(endpointPath)).mtimeMs;
		const index = await new SessionIndex(agentDir).open();
		await index.append({
			type: "host_registered",
			sessionId,
			locator: { cwd: repo, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs,
		});
		await index.append({
			type: "host_heartbeat",
			sessionId,
			locator: { cwd: repo, worktreeRoot: null, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs,
			activity: { state: "idle", at: Date.now() },
		});
		const child = Bun.spawn(["bun", "run", path.join(packageRoot, "src", "cli.ts"), "mcp-serve", "sdk"], {
			cwd: repo,
			env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let stdoutBuffer = "";
		const readResponse = async (): Promise<Record<string, unknown>> => {
			for (;;) {
				const newline = stdoutBuffer.indexOf("\n");
				if (newline >= 0) {
					const line = stdoutBuffer.slice(0, newline);
					stdoutBuffer = stdoutBuffer.slice(newline + 1);
					return JSON.parse(line) as Record<string, unknown>;
				}
				const chunk = await reader.read();
				if (chunk.done) throw new Error("MCP stdio closed before returning a response");
				stdoutBuffer += decoder.decode(chunk.value, { stream: true });
			}
		};
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
		const toolListResponse = await readResponse();
		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "gjc_session_control",
					arguments: { sessionId, operation: "context.clear", input: {}, confirm: true },
				},
			})}\n`,
		);
		const controlResponse = await readResponse();
		await child.stdin.end();
		const stderr = await new Response(child.stderr).text();
		const exitCode = await child.exited;
		expect(exitCode, stderr).toBe(0);

		const responses = [toolListResponse, controlResponse];
		const toolList = responses.find(response => response.id === 1)?.result as {
			tools?: Array<Record<string, unknown>>;
		};
		const control = toolList.tools?.find(tool => tool.name === "gjc_session_control");
		expect(control).toMatchObject({
			inputSchema: {
				additionalProperties: false,
				properties: { confirm: { type: "boolean" } },
			},
		});
		const controlPayload = responses.find(response => response.id === 2)?.result as {
			content?: Array<{ text?: string }>;
		};
		expect(JSON.parse(controlPayload.content?.[0]?.text ?? "{}")).toMatchObject({ ok: true, cleared: true });
		expect(received.filter(notification => notification.type === "control_request")).toEqual([
			expect.objectContaining({ type: "control_request", operation: "context.clear", input: {}, confirm: true }),
		]);
	} finally {
		server.stop(true);
		await rm(repo, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	}
}, 60_000);
