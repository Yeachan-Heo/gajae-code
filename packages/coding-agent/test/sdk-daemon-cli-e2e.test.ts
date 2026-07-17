import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");

type CliResult = { exitCode: number; stdout: string; stderr: string };

async function runCli(repo: string, agentDir: string, args: string[]): Promise<CliResult> {
	const child = Bun.spawn([process.execPath, "run", cliEntrypoint, "daemon", "session", ...args], {
		cwd: repo,
		env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: await child.exited,
		stdout: await new Response(child.stdout).text(),
		stderr: await new Response(child.stderr).text(),
	};
}

describe("SDK daemon session CLI", () => {
	let root: string;
	let agentDir: string;
	let stateRoot: string;
	let endpointServer: ReturnType<typeof Bun.serve>;
	let broker: Broker;
	let receivedControl: Record<string, unknown> | undefined;
	let endpointConnections = 0;

	beforeEach(async () => {
		endpointConnections = 0;
		receivedControl = undefined;
		root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-cli-"));
		agentDir = path.join(root, "agent");
		stateRoot = path.join(root, ".gjc", "state");
		const token = "session-token";
		endpointServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (new URL(request.url).searchParams.get("token") !== token)
					return new Response("Unauthorized", { status: 401 });
				endpointConnections++;
				if (server.upgrade(request, { data: undefined })) return undefined;
				return new Response("Upgrade Required", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "test-conn" }));
				},
				message(socket, message) {
					const frame = JSON.parse(String(message)) as Record<string, unknown>;
					if (frame.type === "control_request") receivedControl = frame;
					if (frame.type === "query_request" && frame.query === "session.metadata") {
						socket.send(
							JSON.stringify({ type: "query_response", id: frame.id, ok: true, result: { sessionId: "live" } }),
						);
						return;
					}
					socket.send(
						JSON.stringify({
							type: frame.type === "control_request" ? "control_response" : "query_response",
							id: frame.id,
							ok: false,
							error: { code: "unknown_operation", message: "unknown operation" },
						}),
					);
				},
			},
		});
		const endpointPath = path.join(stateRoot, "sdk", "live.json");
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId: "live", pid: process.pid, url: `ws://127.0.0.1:${endpointServer.port}`, token }),
		);
		const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
		broker = new Broker({ agentDir, packageGeneration: "test" });
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId: "live",
			locator: { repo: root, stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs,
		});
	});

	afterEach(async () => {
		await broker.stop();
		await endpointServer.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	});

	it("AD-L-G02: uses the broker and per-session WebSocket endpoints without leaking ordinary credentials", async () => {
		const list = await runCli(root, agentDir, ["list"]);
		expect(list.exitCode).toBe(0);
		expect(JSON.parse(list.stdout)).toMatchObject({ result: { sessions: [{ sessionId: "live" }] } });

		const control = await runCli(root, agentDir, [
			"control",
			"live",
			"--op",
			"not.real",
			"--json-input",
			"{}",
			"--confirm",
		]);
		expect(control.exitCode).toBe(1);
		expect(receivedControl).toBeUndefined();
		expect(endpointConnections).toBe(0);
		expect(JSON.parse(control.stdout)).toMatchObject({ error: { code: "unknown_operation" } });
		expect(control.stderr).not.toContain("session-token");

		const query = await runCli(root, agentDir, [
			"query",
			"live",
			"--query",
			"session.metadata",
			"--json-input",
			"{}",
		]);
		expect(query.exitCode).toBe(0);
		expect(JSON.parse(query.stdout)).toMatchObject({ ok: true, result: { sessionId: "live" } });

		const refused = await runCli(root, agentDir, [
			"global",
			"--op",
			"session.get_endpoint",
			"--json-input",
			'{"sessionId":"live"}',
		]);
		expect(refused.exitCode).toBe(1);
		expect(JSON.parse(refused.stdout)).toMatchObject({ error: { code: "endpoint_credential_forbidden" } });

		const disclosed = await runCli(root, agentDir, [
			"global",
			"--op",
			"session.get_endpoint",
			"--json-input",
			'{"sessionId":"live"}',
			"--show-endpoint-credential",
			"--yes",
		]);
		expect(disclosed.exitCode).toBe(0);
		expect(disclosed.stdout.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(disclosed.stdout)).toMatchObject({ ok: true, result: { token: "session-token" } });
		expect(disclosed.stderr).not.toContain("session-token");
	});

	it("selects the broker specified by --agent-dir over the ambient agent directory", async () => {
		const alternateAgentDir = path.join(root, "alternate-agent");
		const alternateBroker = new Broker({ agentDir: alternateAgentDir, packageGeneration: "test" });
		await alternateBroker.start();
		try {
			await alternateBroker.index.append({
				type: "host_registered",
				sessionId: "alternate",
				locator: { repo: root, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(path.join(stateRoot, "sdk", "live.json"))).mtimeMs,
			});

			const result = await runCli(root, agentDir, ["list", "--agent-dir", alternateAgentDir]);
			expect(result.exitCode).toBe(0);
			expect(
				(JSON.parse(result.stdout).result.sessions as Array<{ sessionId: string }>).map(
					session => session.sessionId,
				),
			).toEqual(["alternate"]);
		} finally {
			await alternateBroker.stop();
		}
	});

	it("requires a caller lifecycle idempotency key before broker connection", async () => {
		const result = await runCli(root, agentDir, [
			"global",
			"--op",
			"session.create",
			"--json-input",
			`{"cwd":${JSON.stringify(root)}}`,
		]);
		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "invalid_input" } });
	});

	it("preserves corrupt endpoint discovery errors without connecting", async () => {
		await fs.writeFile(path.join(stateRoot, "sdk", "live.json"), "not-json");
		const result = await runCli(root, agentDir, ["query", "live", "--query", "session.metadata"]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "discovery_error" } });
		expect(endpointConnections).toBe(0);
	});

	it("preserves unreadable endpoint discovery errors without connecting", async () => {
		if (process.platform === "win32") return;
		const endpoint = path.join(stateRoot, "sdk", "live.json");
		await fs.chmod(endpoint, 0o000);
		try {
			const result = await runCli(root, agentDir, ["query", "live", "--query", "session.metadata"]);
			expect(result.exitCode).toBe(1);
			expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "discovery_error" } });
			expect(endpointConnections).toBe(0);
		} finally {
			await fs.chmod(endpoint, 0o600);
		}
	});
});
