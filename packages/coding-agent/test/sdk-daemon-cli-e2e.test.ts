import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeSync, openSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
import { scanRetainedTranscriptTail } from "../src/sdk/cli/session-cli";
import { SessionManager } from "../src/session/session-manager";

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");

type CliResult = { exitCode: number; stdout: string; stderr: string };

// Capture through files rather than pipes: a piped child that outlives the
// parent's read teardown can be killed by SIGPIPE (exit 141) under CI load,
// which masks the CLI's real exit contract.
function closeCaptureFd(fd: number): void {
	// Bun.spawn may close inherited capture FDs when a short-lived child exits,
	// especially on fail-closed CLI paths. Ignore EBADF so teardown does not
	// mask the CLI exit contract under CI load (see shard-6 post-#3076 red).
	try {
		closeSync(fd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code !== "EBADF") throw error;
	}
}

function publicSessionArgs(args: string[]): string[] {
	const action = args[0];
	return action === "control" || action === "query" || action === "global"
		? ["sdk", "session", "raw", ...args]
		: ["sdk", "session", ...args];
}

async function runCli(repo: string, agentDir: string, args: string[]): Promise<CliResult> {
	const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-cli-capture-"));
	const stdoutPath = path.join(captureDir, "stdout");
	const stderrPath = path.join(captureDir, "stderr");
	const stdoutFd = openSync(stdoutPath, "w");
	const stderrFd = openSync(stderrPath, "w");
	try {
		const child = Bun.spawn([process.execPath, "run", cliEntrypoint, ...publicSessionArgs(args)], {
			cwd: repo,
			env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir },
			stdout: stdoutFd,
			stderr: stderrFd,
		});
		const exitCode = await child.exited;
		// Close before reading so file contents are durable even if Bun still
		// held a write handle; tolerate already-closed FDs from the child.
		closeCaptureFd(stdoutFd);
		closeCaptureFd(stderrFd);
		// Re-open read-only and fsync parent side so CI load cannot observe a
		// truncated capture of a finished child (exit code alone is not enough).
		const stdout = await fs.readFile(stdoutPath, "utf8");
		const stderr = await fs.readFile(stderrPath, "utf8");
		return { exitCode, stdout, stderr };
	} finally {
		closeCaptureFd(stdoutFd);
		closeCaptureFd(stderrFd);
		await fs.rm(captureDir, { recursive: true, force: true });
	}
}

describe("SDK session CLI", () => {
	let root: string;
	let agentDir: string;
	let stateRoot: string;
	let endpointServer: Bun.Server<undefined>;
	let broker: Broker;
	let receivedControl: Record<string, unknown> | undefined;
	let endpointConnections = 0;
	let promptStatuses = new Map<string, { status: string }>();
	let replayEvents: Record<string, unknown>[] = [];

	beforeEach(async () => {
		endpointConnections = 0;
		receivedControl = undefined;
		promptStatuses = new Map();
		replayEvents = [];
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
					// Defer hello one tick so the client open handler can enter the
					// hello phase before the first frame is delivered (pairs with the
					// SdkClient early-hello buffer under load).
					queueMicrotask(() => {
						try {
							socket.send(
								JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "test-conn" }),
							);
						} catch {
							// connection already closed
						}
					});
				},
				message(socket, message) {
					const frame = JSON.parse(String(message)) as Record<string, unknown>;
					if (frame.type === "event_replay") {
						socket.send(
							JSON.stringify({ type: "event_replay_result", id: frame.id, ok: true, events: replayEvents }),
						);
						return;
					}
					if (frame.type === "control_request") {
						receivedControl = frame;
						if (frame.operation === "turn.prompt") {
							const input = frame.input as Record<string, unknown> | undefined;
							const clientRef = typeof input?.clientRef === "string" ? input.clientRef : undefined;
							socket.send(
								JSON.stringify({
									type: "control_response",
									id: frame.id,
									ok: true,
									result: { accepted: true, ...(clientRef === undefined ? {} : { clientRef }) },
								}),
							);
							return;
						}
					}
					if (frame.type === "query_request") {
						if (frame.query === "session.metadata") {
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: true,
									result: { sessionId: "live" },
								}),
							);
							return;
						}
						if (frame.query === "turn.result") {
							const input = frame.input as Record<string, unknown> | undefined;
							const clientRef = typeof input?.clientRef === "string" ? input.clientRef : undefined;
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: true,
									result:
										clientRef === undefined
											? { status: "unknown" }
											: (promptStatuses.get(clientRef) ?? { status: "unknown" }),
								}),
							);
							return;
						}
						if (frame.query === "session.checkpoint") {
							socket.send(
								JSON.stringify({
									type: "query_response",
									id: frame.id,
									ok: true,
									result: { checkpoint: { revision: 1, generation: 1, seq: 0 } },
								}),
							);
							return;
						}
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

	type OfflineSession = { id: string; path: string };

	async function createStoppedSavedSession(): Promise<OfflineSession> {
		const session = SessionManager.create(root, SessionManager.managedDestination(root, agentDir));
		await session.ensureOnDisk();
		const id = session.getSessionId();
		const savedPath = session.getSessionFile();
		if (!savedPath) throw new Error("Expected a retained managed session path.");
		const registration = {
			type: "host_registered" as const,
			sessionId: id,
			locator: { repo: root, stateRoot },
			endpointGeneration: 2,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(path.join(stateRoot, "sdk", "live.json"))).mtimeMs,
		};
		await broker.index.append(registration);
		await broker.index.append({ ...registration, type: "host_unregistered" as const });
		return { id, path: savedPath };
	}

	async function tailAfterBrokerSelectsOfflineSession(
		mutate: (session: OfflineSession) => Promise<void>,
		prepare?: (session: OfflineSession) => Promise<void>,
	): Promise<{ result: CliResult; selections: number }> {
		const session = await createStoppedSavedSession();
		if (prepare) await prepare(session);
		const originalHandleRequest = broker.handleRequest.bind(broker);
		let selections = 0;
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			const response = await originalHandleRequest(operation, input, idempotencyKey);
			if (operation === "session.list" && input.resolveSessionId === session.id && selections === 0) {
				selections++;
				await mutate(session);
			}
			return response;
		};
		try {
			return { result: await runCli(root, agentDir, ["tail", session.id]), selections };
		} finally {
			broker.handleRequest = originalHandleRequest;
		}
	}

	it("uses the broker and Router-owned session attachments without leaking credentials", async () => {
		const list = await runCli(root, agentDir, ["list"]);
		expect(list.exitCode).toBe(0);
		expect(JSON.parse(list.stdout)).toMatchObject({ result: { sessions: [{ sessionId: "live" }] } });
		const connectionsAfterList = endpointConnections;

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
		expect(endpointConnections).toBe(connectionsAfterList);
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
		expect(query.exitCode, `query stdout=${query.stdout}\nstderr=${query.stderr}`).toBe(0);
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

		const credentialFlag = await runCli(root, agentDir, [
			"global",
			"--op",
			"session.get_endpoint",
			"--json-input",
			'{"sessionId":"live"}',
			"--show-endpoint-credential",
		]);
		expect(credentialFlag.exitCode).toBe(2);
		expect(`${credentialFlag.stdout}\n${credentialFlag.stderr}`).not.toContain("session-token");
	}, 60_000);

	it("routes semantic inspect, send, status, and tail through Router-owned attachments", async () => {
		const inspect = await runCli(root, agentDir, ["inspect", "live"]);
		expect(inspect.exitCode, inspect.stderr).toBe(0);
		expect(JSON.parse(inspect.stdout)).toMatchObject({
			ok: true,
			result: { source: "broker", session: { sessionId: "live" } },
		});

		const send = await runCli(root, agentDir, ["send", "live", "--text", "hello", "--op-ref", "semantic-ref"]);
		expect(send.exitCode, `send stdout=${send.stdout}\nstderr=${send.stderr}`).toBe(0);
		expect(JSON.parse(send.stdout)).toMatchObject({
			ok: true,
			result: {
				operationRef: "semantic-ref",
				status: "accepted",
				receipt: { accepted: true, clientRef: "semantic-ref" },
			},
		});
		expect(receivedControl).toMatchObject({
			operation: "turn.prompt",
			input: { clientRef: "semantic-ref", text: "hello" },
		});

		promptStatuses.set("semantic-ref", { status: "terminal_ok" });
		const status = await runCli(root, agentDir, ["status", "live", "semantic-ref"]);
		expect(status.exitCode, `status stdout=${status.stdout}\nstderr=${status.stderr}`).toBe(0);
		expect(JSON.parse(status.stdout)).toMatchObject({
			ok: true,
			result: { operationRef: "semantic-ref", status: { status: "terminal_ok" }, summary: { completed: true } },
		});

		replayEvents = [
			{
				type: "event",
				generation: 1,
				seq: 1,
				kind: "turn_end",
				payload: { type: "turn_end", sessionId: "live" },
			},
		];
		const tail = await runCli(root, agentDir, ["tail", "live", "--until-idle", "--timeout-ms", "1000"]);
		expect(tail.exitCode, `tail stdout=${tail.stdout}\nstderr=${tail.stderr}`).toBe(0);
		expect(JSON.parse(tail.stdout)).toMatchObject({
			ok: true,
			result: { source: "session", terminal: true, items: [expect.objectContaining({ kind: "turn_end", seq: 1 })] },
		});
	}, 60_000);

	it("bounds offline retained-transcript tail reads for a synthetic 300 MiB history", async () => {
		const encoder = new TextEncoder();
		const retainedTail = encoder.encode(
			`${Array.from({ length: 240 }, (_, index) =>
				JSON.stringify({ id: `tail-${index}`, payload: "x".repeat(32) }),
			).join("\n")}\n`,
		);
		const prefixBytes = 300 * 1024 * 1024;
		const size = prefixBytes + retainedTail.byteLength;
		const reads: Array<{ start: number; end: number }> = [];
		const entries = await scanRetainedTranscriptTail({
			size,
			readRange: async (start, end) => {
				reads.push({ start, end });
				const result = new Uint8Array(end - start);
				const overlapStart = Math.max(start, prefixBytes);
				const overlapEnd = Math.min(end, size);
				if (overlapStart < overlapEnd)
					result.set(
						retainedTail.subarray(overlapStart - prefixBytes, overlapEnd - prefixBytes),
						overlapStart - start,
					);
				return result;
			},
		});
		expect(entries).toHaveLength(200);
		expect(entries[0]).toMatchObject({ id: "tail-40" });
		expect(entries.at(-1)).toMatchObject({ id: "tail-239" });
		expect(reads.reduce((total, read) => total + read.end - read.start, 0)).toBeLessThan(1024 * 1024);
		expect(reads.every(read => read.start >= prefixBytes - 1024 * 1024)).toBe(true);

		const corrupt = encoder.encode('{"id":"valid"}\nnot-json\n');
		await expect(
			scanRetainedTranscriptTail({
				size: corrupt.byteLength,
				readRange: async (start, end) => corrupt.slice(start, end),
			}),
		).rejects.toThrow("Retained transcript history contains unparseable entries");
	});

	it("replays an unchanged Broker-identified offline transcript", async () => {
		const session = await createStoppedSavedSession();
		const result = await runCli(root, agentDir, ["tail", session.id]);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			result: { source: "offline", session: { sessionId: session.id }, terminal: true },
		});
	}, 60_000);
	it("fails closed when the Broker-selected offline transcript is rewritten in place with restored metadata", async () => {
		const retainedTimestamp = 1_700_000_000;
		const { result, selections } = await tailAfterBrokerSelectsOfflineSession(
			async session => {
				const before = await fs.stat(session.path, { bigint: true });
				const original = await Bun.file(session.path).text();
				const rewrittenId = `${session.id.slice(0, -1)}${session.id.endsWith("x") ? "y" : "x"}`;
				const rewritten = original.replace(session.id, rewrittenId);
				expect(rewritten).not.toBe(original);
				await fs.writeFile(session.path, rewritten);
				await fs.utimes(session.path, retainedTimestamp, retainedTimestamp);
				const after = await fs.stat(session.path, { bigint: true });
				expect(after.dev).toBe(before.dev);
				expect(after.ino).toBe(before.ino);
				expect(after.nlink).toBe(before.nlink);
				expect(after.size).toBe(before.size);
				expect(after.mtimeMs).toBe(before.mtimeMs);
				expect(after.mtimeNs).toBe(before.mtimeNs);
				expect(after.ctimeNs).not.toBe(before.ctimeNs);
			},
			async session => {
				await fs.utimes(session.path, retainedTimestamp, retainedTimestamp);
			},
		);
		expect(selections).toBe(1);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			error: { code: "retention_gap", details: { code: "retention_gap", reason: "changed" } },
		});
	}, 60_000);

	it("fails closed when the Broker-selected offline transcript is replaced before open", async () => {
		const { result, selections } = await tailAfterBrokerSelectsOfflineSession(async session => {
			const replacement = path.join(root, "attacker-replacement.jsonl");
			await fs.writeFile(replacement, '{"type":"session","id":"attacker"}\n{"marker":"attacker"}\n');
			await fs.rename(replacement, session.path);
		});
		expect(selections).toBe(1);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			error: { code: "retention_gap", details: { code: "retention_gap", reason: "changed" } },
		});
		expect(result.stdout).not.toContain("attacker");
	}, 60_000);

	it("rejects a symlink substituted for the Broker-selected offline transcript", async () => {
		if (process.platform === "win32") return;
		const { result, selections } = await tailAfterBrokerSelectsOfflineSession(async session => {
			const target = path.join(root, "attacker-symlink-target.jsonl");
			await fs.writeFile(target, '{"type":"session","id":"attacker"}\n{"marker":"attacker"}\n');
			await fs.unlink(session.path);
			await fs.symlink(target, session.path);
		});
		expect(selections).toBe(1);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "retention_gap" } });
		expect(result.stdout).not.toContain("attacker");
	}, 60_000);

	it("rejects a FIFO substituted for the Broker-selected offline transcript without blocking", async () => {
		if (process.platform === "win32") return;
		const startedAt = Date.now();
		const { result, selections } = await tailAfterBrokerSelectsOfflineSession(async session => {
			await fs.unlink(session.path);
			const fifo = Bun.spawn(["mkfifo", session.path], { stdout: "ignore", stderr: "ignore" });
			expect(await fifo.exited).toBe(0);
		});
		expect(selections).toBe(1);
		expect(Date.now() - startedAt).toBeLessThan(10_000);
		expect(result.exitCode, `tail stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "retention_gap" } });
	}, 60_000);

	it("drains SDK session CLI session.list continuation pages before returning sessions", async () => {
		const originalHandleRequest = broker.handleRequest.bind(broker);
		const requests: Array<Record<string, unknown>> = [];
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.list") {
				requests.push(input);
				return input.cursor === undefined
					? { ok: true, result: { sessions: [{ sessionId: "page-one" }], continuationCursor: "page-2" } }
					: { ok: true, result: { sessions: [{ sessionId: "page-two" }] } };
			}
			return await originalHandleRequest(operation, input, idempotencyKey);
		};

		const result = await runCli(root, agentDir, ["list"]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			result: { sessions: [{ sessionId: "page-one" }, { sessionId: "page-two" }] },
		});
		expect(requests).toEqual([{}, { cursor: "page-2" }]);
	}, 60_000);

	it("rejects a failed SDK session CLI session.list continuation without returning page one", async () => {
		const originalHandleRequest = broker.handleRequest.bind(broker);
		const requests: Array<Record<string, unknown>> = [];
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.list") {
				requests.push(input);
				return input.cursor === undefined
					? { ok: true, result: { sessions: [{ sessionId: "page-one" }], continuationCursor: "page-2" } }
					: { ok: false, error: { code: "continuation_failed", message: "page two failed" } };
			}
			return await originalHandleRequest(operation, input, idempotencyKey);
		};

		const result = await runCli(root, agentDir, ["list"]);
		expect(result.exitCode).toBe(1);
		const output = JSON.parse(result.stdout);
		expect(output).toMatchObject({ ok: false, error: { code: "continuation_failed", message: "page two failed" } });
		expect(output).not.toHaveProperty("result");
		expect(requests).toEqual([{}, { cursor: "page-2" }]);
	}, 60_000);

	it("rejects repeated SDK session CLI session.list cursors without partial output", async () => {
		const originalHandleRequest = broker.handleRequest.bind(broker);
		const requests: Array<Record<string, unknown>> = [];
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.list") {
				requests.push(input);
				return {
					ok: true,
					result: { sessions: [{ sessionId: "page" }], continuationCursor: "repeat" },
				};
			}
			return await originalHandleRequest(operation, input, idempotencyKey);
		};

		const result = await runCli(root, agentDir, ["list"]);

		expect(result.exitCode).toBe(1);
		const output = JSON.parse(result.stdout);
		expect(output).toMatchObject({
			ok: false,
			error: { code: "protocol_error", message: "session.list returned a repeated continuation cursor." },
		});
		expect(output).not.toHaveProperty("result");
		expect(requests).toEqual([{}, { cursor: "repeat" }]);
	}, 60_000);

	it("rejects malformed SDK session CLI session.list continuation pages without partial output", async () => {
		const originalHandleRequest = broker.handleRequest.bind(broker);
		const requests: Array<Record<string, unknown>> = [];
		broker.handleRequest = async (operation, input, idempotencyKey) => {
			if (operation === "session.list") {
				requests.push(input);
				return input.cursor === undefined
					? { ok: true, result: { sessions: [{ sessionId: "page-one" }], continuationCursor: "page-2" } }
					: { ok: true, result: { sessions: "not-an-array" } };
			}
			return await originalHandleRequest(operation, input, idempotencyKey);
		};

		const result = await runCli(root, agentDir, ["list"]);

		expect(result.exitCode).toBe(1);
		const output = JSON.parse(result.stdout);
		expect(output).toMatchObject({
			ok: false,
			error: { code: "protocol_error", message: "session.list returned a malformed page." },
		});
		expect(output).not.toHaveProperty("result");
		expect(requests).toEqual([{}, { cursor: "page-2" }]);
	}, 60_000);

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
	}, 60_000);

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
	}, 60_000);

	it("fails closed on corrupt endpoint records without exposing discovery details", async () => {
		await fs.writeFile(path.join(stateRoot, "sdk", "live.json"), "not-json");
		const result = await runCli(root, agentDir, ["query", "live", "--query", "session.metadata"]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "session_unavailable" } });
		expect(endpointConnections).toBe(0);
	}, 60_000);

	it("fails closed on unreadable endpoint records without exposing discovery details", async () => {
		if (process.platform === "win32") return;
		const endpoint = path.join(stateRoot, "sdk", "live.json");
		await fs.chmod(endpoint, 0o000);
		try {
			const result = await runCli(root, agentDir, ["query", "live", "--query", "session.metadata"]);
			expect(result.exitCode).toBe(1);
			expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "session_unavailable" } });
			expect(endpointConnections).toBe(0);
		} finally {
			await fs.chmod(endpoint, 0o600);
		}
	}, 60_000);
});
