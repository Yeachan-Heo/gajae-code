import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
type TestServer = {
	port: number | undefined;
	upgrade(request: Request): boolean;
	stop(closeActiveConnections?: boolean): void;
};

test("shipped MCP stdio advertises confirm and forwards confirmed destructive controls", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "gjc-sdk-mcp-stdio-"));
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
				socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true, cleared: true }));
			},
		},
	});

	try {
		const sessionId = "confirmed-control-session";
		await mkdir(path.join(repo, ".gjc", "state", "sdk"), { recursive: true });
		await writeFile(
			path.join(repo, ".gjc", "state", "sdk", `${sessionId}.json`),
			JSON.stringify({ url: `ws://127.0.0.1:${server.port!}`, token }),
		);
		const child = Bun.spawn(["bun", "run", path.join(packageRoot, "src", "cli.ts"), "mcp-serve", "sdk"], {
			cwd: repo,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
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
		await child.stdin.end();
		const stdout = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();
		const exitCode = await child.exited;
		expect(exitCode, stderr).toBe(0);

		const responses = stdout
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>);
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
		expect(received).toEqual([
			expect.objectContaining({ type: "control_request", operation: "context.clear", input: {}, confirm: true }),
		]);
	} finally {
		server.stop(true);
		await rm(repo, { recursive: true, force: true });
	}
}, 60_000);
