import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { CodexHandoffRegistrationV1, CodexWakeEventV1 } from "../src/coordinator-mcp/codex-handoff";
import {
	assertSafeCodexEndpoint,
	buildCodexWakePrompt,
	type CodexAppServerTransport,
	createDefaultCodexTransportFactory,
	publishCodexWake,
	readCodexTokenFile,
} from "../src/coordinator-mcp/codex-wake-publisher";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-publisher-"));
	tempDirs.push(root);
	return root;
}

function handoff(tokenFile: string | null = null): CodexHandoffRegistrationV1 {
	return {
		schema_version: 1,
		work_unit: "session-1",
		thread_id: "thread-1",
		endpoint: { kind: "unix", path: "/tmp/codex.sock" },
		token_file: tokenFile,
		registered_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	};
}

function event(): CodexWakeEventV1 {
	return {
		schema_version: 1,
		key: "session-1:7",
		work_unit: "session-1",
		event_seq: 7,
		event_kind: "turn.completed",
		turn_id: "turn-1",
		question_id: null,
		summary: "Delegate work completed.",
		status: "pending",
		attempts: 0,
		client_user_message_id: "gjc-wake-session-1:7",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		last_error: null,
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Codex wake publisher", () => {
	it("starts an idle Codex turn with the deterministic message id", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const factory = async (): Promise<CodexAppServerTransport> => ({
			request: async (method, params) => {
				calls.push({ method, params });
				return method === "thread/status" ? { status: "idle" } : {};
			},
			close: async () => {},
		});
		const wake = event();
		const result = await publishCodexWake({ handoff: handoff(), event: wake, transportFactory: factory });

		expect(result).toEqual({ published: true, reason: null });
		expect(calls[2]).toEqual({
			method: "turn/start",
			params: expect.objectContaining({ clientUserMessageId: wake.client_user_message_id }),
		});
		const finalResponseFixture = "DO_NOT_INCLUDE_FINAL_RESPONSE";
		expect(buildCodexWakePrompt(wake)).toContain(wake.event_kind);
		expect(buildCodexWakePrompt(wake)).toContain(wake.key);
		expect(buildCodexWakePrompt(wake)).not.toContain(finalResponseFixture);
	});

	it("leaves the wake pending when the Codex thread is active", async () => {
		const calls: string[] = [];
		const factory = async (): Promise<CodexAppServerTransport> => ({
			request: async method => {
				calls.push(method);
				return method === "thread/status" ? { status: "running" } : {};
			},
			close: async () => {},
		});

		expect(await publishCodexWake({ handoff: handoff(), event: event(), transportFactory: factory })).toEqual({
			published: false,
			reason: "thread_active_pending",
		});
		expect(calls).toEqual(["thread/resume", "thread/status"]);
	});

	it("only permits loopback TCP endpoints and absolute unix sockets", () => {
		for (const host of ["10.0.0.5", "example.com", "0.0.0.0"])
			expect(() => assertSafeCodexEndpoint({ kind: "tcp", host, port: 1234 })).toThrow(
				"codex_endpoint_not_loopback",
			);
		expect(assertSafeCodexEndpoint({ kind: "tcp", host: "127.0.0.1", port: 1234 })).toEqual({
			kind: "tcp",
			host: "127.0.0.1",
			port: 1234,
		});
		expect(assertSafeCodexEndpoint({ kind: "tcp", host: "::1", port: 1234 })).toEqual({
			kind: "tcp",
			host: "::1",
			port: 1234,
		});
		expect(assertSafeCodexEndpoint({ kind: "tcp", host: "local" + "host", port: 1234 })).toEqual({
			kind: "tcp",
			host: "local" + "host",
			port: 1234,
		});
		expect(assertSafeCodexEndpoint({ kind: "unix", path: "/tmp/codex.sock" })).toEqual({
			kind: "unix",
			path: "/tmp/codex.sock",
		});
	});

	it("passes file token content to the transport and hides unreadable-file details", async () => {
		const root = await tempRoot();
		const tokenFile = path.join(root, "token.txt");
		await fs.writeFile(tokenFile, "token-value\n");
		let suppliedToken: string | null = null;
		const factory = async (_endpoint: unknown, token: string | null): Promise<CodexAppServerTransport> => {
			suppliedToken = token;
			return {
				request: async method => (method === "thread/status" ? { status: "running" } : {}),
				close: async () => {},
			};
		};
		await publishCodexWake({ handoff: handoff(tokenFile), event: event(), transportFactory: factory });
		expect(suppliedToken as string | null).toBe("token-value");
		await fs.rm(tokenFile);
		await expect(readCodexTokenFile(tokenFile)).rejects.toThrow("codex_token_file_unreadable");
		await expect(readCodexTokenFile(tokenFile)).rejects.not.toThrow("token-value");
	});

	it("publishes over the default unix JSON-RPC transport", async () => {
		const root = await tempRoot();
		const socketPath = path.join(root, "codex.sock");
		const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
		const server = net.createServer(socket => {
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString();
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) return;
					const request = JSON.parse(buffer.slice(0, newline)) as {
						id: number;
						method: string;
						params: Record<string, unknown>;
					};
					buffer = buffer.slice(newline + 1);
					requests.push({ method: request.method, params: request.params });
					socket.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "thread/status" ? { status: "idle" } : {} })}\n`,
					);
				}
			});
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(socketPath, () => listening.resolve());
		await listening.promise;
		try {
			const result = await publishCodexWake({
				handoff: { ...handoff(), endpoint: { kind: "unix", path: socketPath } },
				event: event(),
				transportFactory: createDefaultCodexTransportFactory(),
			});
			expect(result).toEqual({ published: true, reason: null });
			expect(requests[2]?.params.clientUserMessageId).toBe("gjc-wake-session-1:7");
		} finally {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		}
	});
});
